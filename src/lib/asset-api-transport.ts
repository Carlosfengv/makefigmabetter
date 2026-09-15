import { sha256Hex } from "./sha256";

export type AssetUploadKind = "raster-image" | "font";

export type AssetApiTransportConfig = {
  baseUrl: string;
  /** Development-only principal headers for the loopback Rust API. */
  tenantId: string;
  actorId: string;
  fetch?: typeof globalThis.fetch;
};

export type AssetUploadInput = {
  sessionId: string;
  kind: AssetUploadKind;
  mediaType: string;
  bytes: Uint8Array;
  /** Cancels the current resumable attempt without completing or attaching an asset. */
  signal?: AbortSignal;
};

export type UploadedAsset = {
  assetId: string;
  contentHash: string;
  kind: AssetUploadKind;
  mediaType: string;
  byteLength: number;
  deduplicated: boolean;
  fontFaces: readonly { faceIndex: number; family: string; style: string }[];
};

type UploadProgress = { sessionId: string; acceptedByteLength: number };

/** Browser-side companion to the Asset API's server-confirmed upload offset.
 * It never accepts a browser MIME declaration without also sending the complete
 * bytes for the Rust service to validate by magic number and SHA-256. */
export class AssetApiTransport {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly config: AssetApiTransportConfig) {
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async upload(input: AssetUploadInput): Promise<UploadedAsset> {
    throwIfAborted(input.signal);
    const hash = await sha256Hex(input.bytes);
    throwIfAborted(input.signal);
    let accepted = await this.startOrResume(input, hash);
    if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted > input.bytes.byteLength) {
      throw new TypeError("ASSET_UPLOAD_OFFSET_INVALID");
    }

    while (accepted < input.bytes.byteLength) {
      throwIfAborted(input.signal);
      const chunk = input.bytes.slice(accepted, Math.min(input.bytes.byteLength, accepted + CHUNK_BYTES));
      const response = await this.request(`/v1/assets/uploads/${encodeURIComponent(input.sessionId)}/chunks/${accepted}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: chunk.buffer,
        signal: input.signal,
      });
      if (response.status === 409) {
        accepted = await this.progress(input.sessionId, input.signal);
        continue;
      }
      if (!response.ok) throw new Error("ASSET_UPLOAD_CHUNK_FAILED");
      accepted = (await response.json() as UploadProgress).acceptedByteLength;
      if (!Number.isSafeInteger(accepted) || accepted < chunk.byteLength) throw new TypeError("ASSET_UPLOAD_OFFSET_INVALID");
    }

    throwIfAborted(input.signal);
    const complete = await this.request(`/v1/assets/uploads/${encodeURIComponent(input.sessionId)}/complete`, { method: "POST", signal: input.signal });
    if (!complete.ok) throw new Error("ASSET_UPLOAD_COMPLETE_FAILED");
    return uploadedAsset(await complete.json());
  }

  async attachToDocument(documentId: string, assetId: string): Promise<void> {
    const response = await this.request(`/v1/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(assetId)}`, { method: "PUT" });
    if (!response.ok) throw new Error("ASSET_DOCUMENT_ATTACHMENT_FAILED");
  }

  /** Transfers an existing resource only after the Asset Service confirms that
   * this principal can read the source document and write the destination. */
  async attachFromDocument(sourceDocumentId: string, targetDocumentId: string, assetId: string): Promise<"created" | "existing"> {
    const response = await this.request(
      `/v1/documents/${encodeURIComponent(targetDocumentId)}/assets/${encodeURIComponent(assetId)}/attach-from-document`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceDocumentId }) },
    );
    if (!response.ok) throw new Error("ASSET_DOCUMENT_TRANSFER_AUTHORIZATION_FAILED");
    return response.status === 201 ? "created" : "existing";
  }

  async detachClipboardAttachment(documentId: string, assetId: string): Promise<void> {
    const response = await this.request(
      `/v1/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(assetId)}/clipboard-attachment`,
      { method: "DELETE" },
    );
    if (!response.ok) throw new Error("ASSET_CLIPBOARD_ATTACHMENT_REVERT_FAILED");
  }

  async finalizeClipboardAttachment(documentId: string, assetId: string): Promise<void> {
    const response = await this.request(
      `/v1/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(assetId)}/clipboard-attachment/commit`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error("ASSET_CLIPBOARD_ATTACHMENT_FINALIZE_FAILED");
  }

  /** Local-only bootstrap for the single-user Phase 1 environment. Production
   * authorization must be projected from the authenticated Document service. */
  async grantDocumentWriter(documentId: string): Promise<void> {
    const response = await this.request(`/v1/documents/${encodeURIComponent(documentId)}/writers`, { method: "PUT" });
    if (!response.ok) throw new Error("ASSET_DOCUMENT_WRITER_GRANT_FAILED");
  }

  async downloadGrant(documentId: string, assetId: string, lifetimeSeconds = 300): Promise<{ token: string; expiresAtSeconds: number }> {
    const response = await this.request(`/v1/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(assetId)}/download-grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifetimeSeconds }),
    });
    if (!response.ok) throw new Error("ASSET_DOWNLOAD_GRANT_FAILED");
    return response.json() as Promise<{ token: string; expiresAtSeconds: number }>;
  }

  /** Fetches attached asset bytes through a short-lived document-scoped grant.
   * Keeping this in the transport prevents the DOM text editor and Canvas
   * Worker from drifting onto different ad-hoc download paths. */
  async download(documentId: string, assetId: string): Promise<ArrayBuffer> {
    const grant = await this.downloadGrant(documentId, assetId);
    const response = await this.request(`/v1/assets/downloads/${encodeURIComponent(grant.token)}`);
    if (!response.ok) throw new Error("ASSET_DOWNLOAD_FAILED");
    return response.arrayBuffer();
  }

  private async startOrResume(input: AssetUploadInput, contentHash: string): Promise<number> {
    const response = await this.request(`/v1/assets/uploads/${encodeURIComponent(input.sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: input.kind, contentHash, mediaType: input.mediaType, byteLength: input.bytes.byteLength }),
      signal: input.signal,
    });
    if (response.ok) return (await response.json() as UploadProgress).acceptedByteLength;
    // A retry can race another tab that created the stable session first. Start
    // optimistically so a normal new import does not intentionally emit a 404 in
    // browser DevTools just to discover that no resumable session exists yet.
    if (response.status === 400) return this.progress(input.sessionId, input.signal);
    throw new Error("ASSET_UPLOAD_BEGIN_FAILED");
  }

  private async progress(sessionId: string, signal?: AbortSignal): Promise<number> {
    const response = await this.request(`/v1/assets/uploads/${encodeURIComponent(sessionId)}`, { signal });
    if (response.status === 404) throw new Error("ASSET_UPLOAD_MISSING");
    if (!response.ok) throw new Error("ASSET_UPLOAD_PROGRESS_FAILED");
    return (await response.json() as UploadProgress).acceptedByteLength;
  }

  private request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-makefigma-dev-tenant-id", this.config.tenantId);
    headers.set("x-makefigma-dev-actor-id", this.config.actorId);
    return this.fetch(`${this.config.baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers });
  }
}

function uploadedAsset(value: unknown): UploadedAsset {
  if (!value || typeof value !== "object") throw new TypeError("ASSET_UPLOAD_RESPONSE_INVALID");
  const candidate = value as Partial<UploadedAsset> & { fontFaces?: unknown };
  const rawFaces = candidate.fontFaces ?? [];
  if (!Array.isArray(rawFaces) || rawFaces.length > 16) throw new TypeError("ASSET_UPLOAD_RESPONSE_INVALID");
  const fontFaces = rawFaces.map((value, index) => {
    if (!value || typeof value !== "object") throw new TypeError("ASSET_UPLOAD_RESPONSE_INVALID");
    const face = value as { faceIndex?: unknown; family?: unknown; style?: unknown };
    if (face.faceIndex !== index || !validFontNamePart(face.family) || !validFontNamePart(face.style)) {
      throw new TypeError("ASSET_UPLOAD_RESPONSE_INVALID");
    }
    return { faceIndex: index, family: face.family, style: face.style };
  });
  return { ...(candidate as UploadedAsset), fontFaces };
}

function validFontNamePart(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && new TextEncoder().encode(value).byteLength <= 256
    && value.trim() === value
    && !/\p{Cc}/u.test(value);
}

const CHUNK_BYTES = 1024 * 1024;


function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("The asset import was cancelled.", "AbortError");
}
