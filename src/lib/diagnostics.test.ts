import { describe, expect, it } from "vitest";
import { createDiagnosticRecorder } from "./diagnostics";

describe("diagnostic recorder", () => {
  it("keeps a bounded, sanitized structured event trail", () => {
    const recorder = createDiagnosticRecorder(2, () => 12.5);
    recorder.record({ category: "lifecycle", code: "worker ready" });
    recorder.record({ category: "transaction", code: "accepted", documentRevision: 4, transactionId: "a".repeat(80), details: { visibleNodes: 4, secret: "never log user content", "bad key": true, nan: Number.NaN } });
    recorder.record({ category: "renderer", code: "render.complete" });

    expect(recorder.summary()).toEqual({
      total: 3,
      recent: [
        expect.objectContaining({ sequence: 2, code: "ACCEPTED", documentRevision: 4, transactionId: "a".repeat(64), details: { visibleNodes: 4 } }),
        expect.objectContaining({ sequence: 3, code: "RENDER_COMPLETE" }),
      ],
    });
  });

  it("retains bounded atlas lifecycle measurements without accepting arbitrary details", () => {
    const recorder = createDiagnosticRecorder();
    recorder.record({ category: "renderer", code: "text atlas stats", details: { pages: 4, entries: 1_024, bytes: 4_194_304, cacheHits: 900, uploads: 12, evictions: 1, rejectedNodes: 0, documentText: "must not be retained" } });
    expect(recorder.summary().recent[0]).toMatchObject({
      code: "TEXT_ATLAS_STATS",
      details: { pages: 4, entries: 1_024, bytes: 4_194_304, cacheHits: 900, uploads: 12, evictions: 1, rejectedNodes: 0 },
    });
  });

  it("retains only the fixed renderer failure kind, never a browser error message", () => {
    const recorder = createDiagnosticRecorder();
    recorder.record({ category: "renderer", code: "webgpu upload failed", details: { errorKind: "WEBGPU_UPLOAD_FAILED", browserMessage: "untrusted browser detail" } });
    expect(recorder.summary().recent[0]).toMatchObject({
      code: "WEBGPU_UPLOAD_FAILED",
      details: { errorKind: "WEBGPU_UPLOAD_FAILED" },
    });
  });
});
