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
});
