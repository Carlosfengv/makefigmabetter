import { describe, expect, it } from "vitest";
import { createRenderPerformanceSampler } from "./performance-sampling";

describe("render performance sampler", () => {
  it("reports a bounded rolling P50/P95/max summary", () => {
    const sampler = createRenderPerformanceSampler(4);
    sampler.record(99);
    sampler.start();
    [1, 2, 3, 4, Number.NaN, -1, 5].forEach((sample) => sampler.record(sample));

    expect(sampler.summary()).toEqual({ samples: 4, p50Ms: 3, p95Ms: 5, maxMs: 5 });
  });

  it("excludes startup and rebuild frames until a new steady-state window starts", () => {
    const sampler = createRenderPerformanceSampler();
    sampler.record(200);
    expect(sampler.summary()).toEqual({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
    sampler.start();
    sampler.record(3);
    sampler.reset();
    sampler.record(100);
    expect(sampler.summary()).toEqual({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
    sampler.start();
    sampler.record(4);
    expect(sampler.summary()).toEqual({ samples: 1, p50Ms: 4, p95Ms: 4, maxMs: 4 });
  });
});
