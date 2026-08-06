import { describe, expect, it } from "vitest";
import { parsePhase2CommonNodesPerformanceRun, summarizePhase2CommonNodesPerformance } from "./write-phase2-common-nodes-performance-summary.mjs";

const metrics = (inputToRenderP95Ms) => ({
  render: { samples: 64, p50Ms: .6, p95Ms: .9, maxMs: 1.5, inputToRenderSamples: 64, inputToRenderP95Ms },
  input: { samples: 63, p50Ms: 16, p95Ms: 18, maxMs: 19 },
});

describe("Phase 2 common-nodes performance summary", () => {
  it("parses wrapped Playwright evidence and applies the Phase 2 latency gate", () => {
    expect(parsePhase2CommonNodesPerformanceRun(`### Result\n"${JSON.stringify(metrics(19)).replaceAll('"', '\\"')}"`)).toMatchObject(metrics(19));
    expect(summarizePhase2CommonNodesPerformance([
      { file: "performance-run-01.txt", metrics: metrics(18) },
      { file: "performance-run-02.txt", metrics: metrics(19) },
      { file: "performance-run-03.txt", metrics: metrics(20) },
    ], 5)).toMatchObject({ status: "local-candidate", median: { inputToRenderP95Ms: 19 }, gates: { inputToRenderP95Under50Ms: true } });
  });
});
