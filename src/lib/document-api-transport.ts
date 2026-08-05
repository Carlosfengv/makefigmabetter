import { AckResult, ErrorCode, OperationAck, ProtocolError } from "@makefigma/protocol-types";
import type { PendingRemoteOperation } from "./editor-protocol";
import type { PendingOperationTransport } from "./pending-operation-sync";
import type { ServerOperationAck } from "./pending-operation-queue";

export type DocumentApiTransportConfig = {
  baseUrl: string;
  /** Development-only principal headers for the loopback Rust API. */
  tenantId: string;
  actorId: string;
  fetch?: typeof globalThis.fetch;
};

/** The browser-facing transport deliberately forwards the pending envelope bytes
 * unchanged. It only decodes the service's response, preserving the unknown-field
 * forwarding rule for all outbound operations. */
export class DocumentApiTransport implements PendingOperationTransport {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly config: DocumentApiTransportConfig) {
    // Native fetch requires the Window/Worker receiver. Test doubles are
    // already ordinary functions, while the bound native implementation works
    // identically from the React main thread and an eventual Worker caller.
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async submit(operation: PendingRemoteOperation): Promise<ServerOperationAck> {
    const response = await this.fetch(`${this.config.baseUrl.replace(/\/$/, "")}/v1/documents/${encodeURIComponent(operation.documentId)}/operations`, {
      method: "POST",
      headers: {
        "content-type": "application/x-protobuf",
        "x-makefigma-dev-tenant-id": this.config.tenantId,
        "x-makefigma-dev-actor-id": this.config.actorId,
      },
      // Fetch's DOM type accepts an owned ArrayBuffer, not a potentially shared
      // typed-array backing store received from IndexedDB/Worker transfer.
      body: new Uint8Array(operation.envelope).buffer,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.ok) return ackFromProto(operation.operationId, OperationAck.decode(bytes));
    // A root document can be created by another locally queued task, or the
    // loopback service can be restarting. Neither condition is a permanent
    // operation rejection: retain the opaque envelope and retry in order.
    if (response.status === 404 || response.status >= 500) throw new TypeError("TRANSIENT_DOCUMENT_SERVICE");
    return errorAck(operation.operationId, ProtocolError.decode(bytes));
  }

  /** Establishes the service-side root from an already self-validating Core
   * snapshot. Repeating the exact request is safe; divergent state is surfaced
   * as a conflict for the caller to reconcile. */
  async createDocument(documentId: string, snapshot: Uint8Array): Promise<"created" | "existing"> {
    const response = await this.fetch(`${this.config.baseUrl.replace(/\/$/, "")}/v1/documents/${encodeURIComponent(documentId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-protobuf",
        "x-makefigma-dev-tenant-id": this.config.tenantId,
        "x-makefigma-dev-actor-id": this.config.actorId,
      },
      body: new Uint8Array(snapshot).buffer,
    });
    if (response.status === 201) return "created";
    if (response.ok) return "existing";
    throw new Error(response.status === 409 ? "REMOTE_DOCUMENT_CONFLICT" : "REMOTE_DOCUMENT_CREATE_FAILED");
  }

  /** Retrieves the canonical server snapshot verbatim. Validation happens in
   * Rust/WASM before it can replace the locally projected document. */
  async loadSnapshot(documentId: string): Promise<Uint8Array> {
    const response = await this.fetch(`${this.config.baseUrl.replace(/\/$/, "")}/v1/documents/${encodeURIComponent(documentId)}/snapshot`, {
      headers: {
        "x-makefigma-dev-tenant-id": this.config.tenantId,
        "x-makefigma-dev-actor-id": this.config.actorId,
      },
    });
    if (!response.ok) throw new Error(response.status === 404 ? "REMOTE_DOCUMENT_MISSING" : "REMOTE_SNAPSHOT_UNAVAILABLE");
    return new Uint8Array(await response.arrayBuffer());
  }
}

function ackFromProto(operationId: string, ack: ReturnType<typeof OperationAck.decode>): ServerOperationAck {
  return {
    operationId,
    result: ack.result,
    acceptedRevision: numericRevision(ack.acceptedRevision),
    documentHash: ack.documentHash ? hex(ack.documentHash) : undefined,
    safeMessage: ack.error?.safeMessage,
  };
}

function errorAck(operationId: string, error: ReturnType<typeof ProtocolError.decode>): ServerOperationAck {
  return {
    operationId,
    result: error.code === ErrorCode.ERROR_CODE_BASE_REVISION_CONFLICT ? AckResult.ACK_RESULT_REJECTED_CONFLICT : AckResult.ACK_RESULT_REJECTED_PERMANENT,
    safeMessage: error.safeMessage || "The document service rejected the operation.",
  };
}

function numericRevision(revision: string | undefined) {
  if (revision === undefined) return undefined;
  const number = Number(revision);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function hex(value: Uint8Array) { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
