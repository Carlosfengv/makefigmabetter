import { describe, expect, it } from "vitest";
import { parsePerformanceRun, summarizePerformanceRuns } from "./write-phase0-performance-summary.mjs";

describe("Phase 0 performance evidence", () => {
  it("parses the JSON string returned by the Playwright CLI", () => {
    expect(parsePerformanceRun('### Result\n"{\\"samples\\":240,\\"p50Ms\\":0.4,\\"p95Ms\\":0.8,\\"maxMs\\":1.2}"')).toEqual({
      samples: 240, p50Ms: 0.4, p95Ms: 0.8, maxMs: 1.2,
    });
  });

  it("requires three equal-size runs and reports median metrics", () => {
    const metrics = [
      { samples: 240, p50Ms: 0.4, p95Ms: 0.8, maxMs: 1.3 },
      { samples: 240, p50Ms: 0.5, p95Ms: 0.9, maxMs: 1.1 },
      { samples: 240, p50Ms: 0.3, p95Ms: 0.7, maxMs: 1.4 },
    ];
    expect(summarizePerformanceRuns(metrics.map((value, index) => ({ file: `performance-run-0${index + 1}.txt`, metrics: value })), 30)).toMatchObject({
      status: "pass", warmupSeconds: 30, samplesPerRun: 240, median: { p50Ms: 0.4, p95Ms: 0.8, maxMs: 1.3 },
    });
  });
});
