import { describe, expect, it } from "vitest";
import { createRenderPerformanceSampler } from "./performance-sampling";

describe("render performance sampler", () => {
  it("reports a bounded rolling P50/P95/max summary", () => {
    const sampler = createRenderPerformanceSampler(4);
    sampler.record(99);
    sampler.start();
    [1, 2, 3, 4, Number.NaN, -1, 5].forEach((sample) => sampler.record(sample));

    expect(sampler.summary()).toMatchObject({ samples: 4, p50Ms: 3, p95Ms: 5, maxMs: 5, cullingP95Ms: 0, rendersPerInputFrameMax: 0 });
  });

  it("excludes startup and rebuild frames until a new steady-state window starts", () => {
    const sampler = createRenderPerformanceSampler();
    sampler.record(200);
    expect(sampler.summary()).toMatchObject({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, cullingP95Ms: 0 });
    sampler.start();
    sampler.record(3);
    sampler.reset();
    sampler.record(100);
    expect(sampler.summary()).toMatchObject({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, cullingP95Ms: 0 });
    sampler.start();
    sampler.record(4);
    expect(sampler.summary()).toMatchObject({ samples: 1, p50Ms: 4, p95Ms: 4, maxMs: 4, cullingP95Ms: 0 });
  });

  it("retains the maximum render count observed in an input frame", () => {
    const sampler = createRenderPerformanceSampler();
    sampler.start();
    sampler.record({ totalMs: 2, rendersPerInputFrame: 1 });
    sampler.record({ totalMs: 3, rendersPerInputFrame: 1 });
    expect(sampler.summary().rendersPerInputFrameMax).toBe(1);
  });

  it("reports a bounded input-to-render latency percentile independently of render samples", () => {
    const sampler = createRenderPerformanceSampler(3);
    sampler.start();
    sampler.record(1);
    [4, 8, 12, 16].forEach((duration) => sampler.recordInputToRender(duration));
    expect(sampler.summary()).toMatchObject({ inputToRenderSamples: 4, inputToRenderP95Ms: 16 });
  });

  it("reports backend work, coverage, readback and effect-surface peaks independently", () => {
    const sampler = createRenderPerformanceSampler(3);
    sampler.start();
    sampler.record({ totalMs: 4, gpuIslandMs: 1, canvasIslandMs: 2, gpuCoverageUpperBoundPixels: 100, canvasFallbackCoverageUpperBoundPixels: 50, gpuUploadBytes: 32, canvasReadbackBytes: 0, compositeSurfaceBytes: 4_096 });
    sampler.record({ totalMs: 5, gpuIslandMs: 2, canvasIslandMs: 3, gpuCoverageUpperBoundPixels: 120, canvasFallbackCoverageUpperBoundPixels: 60, gpuUploadBytes: 64, canvasReadbackBytes: 2_048, compositeSurfaceBytes: 8_192 });

    expect(sampler.summary()).toMatchObject({
      gpuIslandP95Ms: 2,
      canvasIslandP95Ms: 3,
      gpuCoverageUpperBoundPixelsP95: 120,
      canvasFallbackCoverageUpperBoundPixelsP95: 60,
      gpuUploadBytesP95: 64,
      canvasReadbackBytesP95: 2_048,
      compositeSurfaceBytesP95: 8_192,
    });
  });
});
