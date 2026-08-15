import { describe, expect, it, vi } from "vitest";
import { AssetApiTransport } from "./asset-api-transport";

const principal = { tenantId: "00000000000000000000000000000002", actorId: "00000000000000000000000000000007" };
const sessionId = "00000000000000000000000000000001";

describe("AssetApiTransport", () => {
  it("resumes at the server-confirmed offset and sends the remaining bytes only", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(undefined, { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId, acceptedByteLength: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId, acceptedByteLength: 5 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ assetId: "asset", contentHash: "hash", kind: "raster-image", mediaType: "image/png", byteLength: 5, deduplicated: false }), { status: 200 }));
    const transport = new AssetApiTransport({ baseUrl: "http://127.0.0.1:8789", ...principal, fetch });

    await expect(transport.upload({ sessionId, kind: "raster-image", mediaType: "image/png", bytes: Uint8Array.from([1, 2, 3, 4, 5]) })).resolves.toMatchObject({ assetId: "asset", byteLength: 5 });

    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[1][0]).toContain(`/uploads/${sessionId}`);
    expect(fetch.mock.calls[2][0]).toContain(`/chunks/2`);
    expect(new Uint8Array(fetch.mock.calls[2][1].body)).toEqual(Uint8Array.from([3, 4, 5]));
    expect(fetch.mock.calls[2][1].headers.get("x-makefigma-dev-actor-id")).toBe(principal.actorId);
  });

  it("creates a missing session and attaches only after the upload is complete", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId, acceptedByteLength: 0 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId, acceptedByteLength: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ assetId: "asset", contentHash: "hash", kind: "raster-image", mediaType: "image/png", byteLength: 2, deduplicated: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }));
    const transport = new AssetApiTransport({ baseUrl: "http://127.0.0.1:8789", ...principal, fetch });

    await transport.upload({ sessionId, kind: "raster-image", mediaType: "image/png", bytes: Uint8Array.from([1, 2]) });
    await transport.attachToDocument("document", "asset");

    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[3][0]).toContain("/documents/document/assets/asset");
  });

  it("uses the document-scoped writer bootstrap before an attachment", async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 201 }));
    const transport = new AssetApiTransport({ baseUrl: "http://127.0.0.1:8789", ...principal, fetch });
    await transport.grantDocumentWriter("document");
    await transport.attachToDocument("document", "asset");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8789/v1/documents/document/writers",
      "http://127.0.0.1:8789/v1/documents/document/assets/asset",
    ]);
  });

  it("asks the Asset Service to authorize a source-to-target document transfer", async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 201 }));
    const transport = new AssetApiTransport({ baseUrl: "http://127.0.0.1:8789", ...principal, fetch });

    await expect(transport.attachFromDocument("source-document", "target-document", "asset")).resolves.toBe("created");

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8789/v1/documents/target-document/assets/asset/attach-from-document",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ sourceDocumentId: "source-document" }) }),
    );
  });

  it("reverts only a newly created clipboard attachment", async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 204 }));
    const transport = new AssetApiTransport({ baseUrl: "http://127.0.0.1:8789", ...principal, fetch });

    await transport.detachClipboardAttachment("target-document", "asset");

    expect(fetch.mock.calls[0][0]).toContain("/documents/target-document/assets/asset/clipboard-attachment");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });

  it("finalizes a successful clipboard attachment without detaching it", async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 204 }));
    const transport = new AssetApiTransport({ baseUrl: "http://127.0.0.1:8789", ...principal, fetch });

    await transport.finalizeClipboardAttachment("target-document", "asset");

    expect(fetch.mock.calls[0][0]).toContain("/documents/target-document/assets/asset/clipboard-attachment/commit");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("downloads bytes through a short-lived document-scoped grant", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "grant", expiresAtSeconds: 300 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), { status: 200 }));
    const transport = new AssetApiTransport({ baseUrl: "http://127.0.0.1:8789", ...principal, fetch });

    await expect(transport.download("document", "asset")).resolves.toEqual(Uint8Array.from([1, 2, 3]).buffer);

    expect(fetch.mock.calls[0][0]).toContain("/documents/document/assets/asset/download-grants");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ lifetimeSeconds: 300 });
    expect(fetch.mock.calls[1][0]).toContain("/assets/downloads/grant");
    expect(fetch.mock.calls[1][1].headers.get("x-makefigma-dev-actor-id")).toBe(principal.actorId);
  });

  it("stops before completion when the caller cancels an import", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      return new Response(JSON.stringify({ sessionId, acceptedByteLength: 0 }), { status: 201 });
    });
    const transport = new AssetApiTransport({ baseUrl: "http://127.0.0.1:8789", ...principal, fetch });

    await expect(transport.upload({ sessionId, kind: "raster-image", mediaType: "image/png", bytes: Uint8Array.from([1, 2]), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
