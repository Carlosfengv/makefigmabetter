import { describe, expect, it } from "vitest";
import { parsePhase2BrowserMemoryRun, summarizePhase2BrowserMemory } from "./write-phase2-browser-memory-summary.mjs";

const sample = (usedJSHeapSize, capturedAt) => ({ capturedAt, memory: { usedJSHeapSize, totalJSHeapSize: usedJSHeapSize + 100, jsHeapSizeLimit: 4_000 } });

describe("Phase 2 browser memory evidence", () => {
  it("extracts Playwright-wrapped browser heap samples", () => {
    expect(parsePhase2BrowserMemoryRun(`### Result\n"{\\"capturedAt\\":\\"2026-08-10T00:00:00.000Z\\",\\"memory\\":{\\"usedJSHeapSize\\":100,\\"totalJSHeapSize\\":200,\\"jsHeapSizeLimit\\":4000}}"`)).toMatchObject({ memory: { usedJSHeapSize: 100 } });
  });

  it("keeps the full observed curve and its first-to-last deltas", () => {
    const result = summarizePhase2BrowserMemory([
      { file: "memory-run-0001.txt", sample: sample(100, "2026-08-10T00:00:00.000Z") },
      { file: "memory-run-0002.txt", sample: sample(130, "2026-08-10T00:00:15.000Z") },
      { file: "memory-run-0003.txt", sample: sample(120, "2026-08-10T00:00:30.000Z") },
    ]);
    expect(result).toMatchObject({ status: "local-candidate", samples: expect.arrayContaining([expect.objectContaining({ file: "memory-run-0001.txt" })]), usedJSHeapSize: { first: 100, last: 120, min: 100, max: 130, delta: 20 } });
  });

  it("rejects an unsupported or incomplete memory curve", () => {
    expect(() => summarizePhase2BrowserMemory([{ file: "memory-run-0001.txt", sample: undefined }, { file: "memory-run-0002.txt", sample: undefined }, { file: "memory-run-0003.txt", sample: undefined }])).toThrow("missing or unsupported");
  });
});
