import { describe, expect, it } from "vitest";
import { createViewportCheckpointSampler } from "./viewport-checkpoint-performance";

describe("viewport checkpoint performance evidence", () => {
  it("keeps only bounded valid write samples", () => {
    const sampler = createViewportCheckpointSampler(3);
    [2, -1, Number.NaN, 8, 4, 16].forEach((duration) => sampler.record(duration));
    expect(sampler.summary()).toEqual({ samples: 3, p50Ms: 8, p95Ms: 16, maxMs: 16 });
  });
});
