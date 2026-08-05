import { AckResult, ErrorCode, OperationAck, ProtocolError } from "@makefigma/protocol-types";
import { describe, expect, it, vi } from "vitest";
import type { PendingRemoteOperation } from "./editor-protocol";
import { DocumentApiTransport } from "./document-api-transport";

const operation: PendingRemoteOperation = { format: "pending-operation-v1", operationId: "op", transactionId: "transaction", documentId: "00000000-0000-0000-0000-000000000001", baseRevision: 0, envelope: new Uint8Array([8, 1]), payloadHash: "payload", localDocumentHash: "local", createdAtMs: 1, attempts: 0 };
const principal = { tenantId: "00000000000000000000000000000002", actorId: "00000000000000000000000000000007" };

describe("DocumentApiTransport", () => {
  it("forwards the opaque envelope and decodes the generated accepted ack", async () => {
    const body = OperationAck.encode({ schemaVersion: 1, documentId: new Uint8Array(16), operationId: new Uint8Array(16), result: AckResult.ACK_RESULT_ACCEPTED, acceptedRevision: "4", documentHash: Uint8Array.from([0xaa, 0xbb]), canonicalOperation: undefined, error: undefined }).finish();
    const fetch = vi.fn(async () => new Response(body, { status: 200 }));
    const transport = new DocumentApiTransport({ baseUrl: "http://127.0.0.1:8788/", ...principal, fetch });
    await expect(transport.submit(operation)).resolves.toEqual({ operationId: "op", result: AckResult.ACK_RESULT_ACCEPTED, acceptedRevision: 4, documentHash: "aabb", safeMessage: undefined });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8788/v1/documents/00000000-0000-0000-0000-000000000001/operations", expect.objectContaining({ method: "POST", body: expect.any(ArrayBuffer), headers: expect.objectContaining({ "x-makefigma-dev-actor-id": principal.actorId }) }));
  });

  it("turns a structured stale-revision error into a reconcileable conflict", async () => {
    const body = ProtocolError.encode({ code: ErrorCode.ERROR_CODE_BASE_REVISION_CONFLICT, safeMessage: "Document revision is no longer current.", supportedProtocolVersions: undefined, minimumEngineSemanticsVersion: undefined, details: {} }).finish();
    const transport = new DocumentApiTransport({ baseUrl: "http://127.0.0.1:8788", ...principal, fetch: async () => new Response(body, { status: 409 }) });
    await expect(transport.submit(operation)).resolves.toEqual({ operationId: "op", result: AckResult.ACK_RESULT_REJECTED_CONFLICT, safeMessage: "Document revision is no longer current." });
  });

  it("keeps an operation retryable while the remote document root is unavailable", async () => {
    const transport = new DocumentApiTransport({ baseUrl: "http://127.0.0.1:8788", ...principal, fetch: async () => new Response(new Uint8Array(), { status: 404 }) });
    await expect(transport.submit(operation)).rejects.toThrow("TRANSIENT_DOCUMENT_SERVICE");
  });

  it("creates a canonical document root and treats a matching retry as existing", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(), { status: 201 }));
    const transport = new DocumentApiTransport({ baseUrl: "http://127.0.0.1:8788", ...principal, fetch });
    await expect(transport.createDocument(operation.documentId, new Uint8Array([1, 2]))).resolves.toBe("created");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`/v1/documents/${operation.documentId}`), expect.objectContaining({ method: "POST", body: expect.any(ArrayBuffer) }));
  });

  it("clones and permanently deletes through explicit document lifecycle endpoints", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = new DocumentApiTransport({ baseUrl: "http://127.0.0.1:8788", ...principal, fetch });
    await transport.cloneDocument(operation.documentId, "00000000-0000-0000-0000-000000000003");
    await transport.deleteDocument(operation.documentId);
    expect(fetch.mock.calls[0][0]).toContain(`/v1/documents/${operation.documentId}/copies/00000000-0000-0000-0000-000000000003`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { "x-makefigma-dev-tenant-id": principal.tenantId } });
    expect(fetch.mock.calls[1][0]).toContain(`/v1/documents/${operation.documentId}`);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "DELETE" });
  });

  it("loads the server snapshot without attempting to decode it in TypeScript", async () => {
    const fetch = vi.fn(async () => new Response(Uint8Array.from([8, 1, 2]), { status: 200 }));
    const transport = new DocumentApiTransport({ baseUrl: "http://127.0.0.1:8788", ...principal, fetch });
    await expect(transport.loadSnapshot(operation.documentId)).resolves.toEqual(Uint8Array.from([8, 1, 2]));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`/v1/documents/${operation.documentId}/snapshot`), expect.objectContaining({ headers: expect.objectContaining({ "x-makefigma-dev-tenant-id": principal.tenantId }) }));
  });

  it("reads validated service revision and hash metadata while keeping Snapshot bytes opaque", async () => {
    const headers = new Headers({ "x-makefigma-document-revision": "7", "x-makefigma-document-hash": "ab".repeat(32) });
    const transport = new DocumentApiTransport({ baseUrl: "http://127.0.0.1:8788", ...principal, fetch: async () => new Response(Uint8Array.from([8, 1, 2]), { status: 200, headers }) });
    await expect(transport.loadSnapshotWithMetadata(operation.documentId)).resolves.toEqual({ snapshot: Uint8Array.from([8, 1, 2]), revision: 7, documentHash: "ab".repeat(32) });
  });
});
