import { describe, expect, it } from "vitest";
import { parseZoomPerformanceRun, summarizeZoomPerformanceRuns } from "./write-zoom-performance-summary.mjs";

const run = ({ frameP95Ms = 16, dpr = 2 } = {}) => ({
  worker: { samples: 90, p50Ms: 2, p95Ms: 8, maxMs: 9, cullingP95Ms: 1, gpuUploadBytesP95: 32, rendersPerInputFrameMax: 1 },
  frames: { samples: 90, p50Ms: 8, p95Ms: frameP95Ms, maxMs: 18 },
  longTasks: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
  inputBacklog: { samples: 90, p50Ms: 8, p95Ms: 16, maxMs: 18 },
  dynamicDpr: { interactiveSurface: { css: [100, 80], backing: [150, 120] }, settledSurface: { css: [100, 80], backing: [100 * dpr, 80 * dpr] } },
});

describe("zoom performance evidence summary", () => {
  it("parses CLI-framed result JSON and evaluates all final gates", () => {
    const encoded = `### Result\n${JSON.stringify(JSON.stringify(run()))}\n### Ran Playwright code`;
    expect(parseZoomPerformanceRun(encoded)).toMatchObject({ worker: { p95Ms: 8 } });
    const summary = summarizeZoomPerformanceRuns([1, 2, 3].map(() => ({ file: "run.json", metrics: run() })), { dpr: 2, webgpuActive: true });
    expect(summary.checks).toMatchObject({ workerP95Under12Ms: true, frameP95Under20Ms: true, inputBacklogP95Under32Ms: true, noMainThreadLongTasks: true, oneRenderPerInputFrame: true, cameraUniformUploadAtMost256Bytes: true, dynamicDprReduced: true, dynamicDprRestored: true });
  });

  it("reports a failed frame gate rather than hiding the slowest median", () => {
    const summary = summarizeZoomPerformanceRuns([16, 26, 30].map((frameP95Ms) => ({ file: "run.json", metrics: run({ frameP95Ms }) })), { dpr: 2, webgpuActive: false });
    expect(summary.median.frameP95Ms).toBe(26);
    expect(summary.checks.frameP95Under20Ms).toBe(false);
  });
});
