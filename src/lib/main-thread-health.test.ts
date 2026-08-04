import { describe, expect, it } from "vitest";
import { createFrameIntervalSampler, emptyMainThreadLongTaskSummary, recordMainThreadLongTask } from "./main-thread-health";

describe("main thread long task evidence", () => {
  it("starts empty and only records browser-long-task durations", () => {
    const empty = emptyMainThreadLongTaskSummary();
    expect(recordMainThreadLongTask(empty, 49.9)).toBe(empty);
    expect(recordMainThreadLongTask(empty, Number.NaN)).toBe(empty);
    expect(recordMainThreadLongTask(empty, 51)).toEqual({ count: 1, totalDurationMs: 51, maxDurationMs: 51 });
  });

  it("retains aggregate count, total, and worst task", () => {
    const first = recordMainThreadLongTask(emptyMainThreadLongTaskSummary(), 60);
    expect(recordMainThreadLongTask(first, 75)).toEqual({ count: 2, totalDurationMs: 135, maxDurationMs: 75 });
  });

  it("reports bounded animation-frame interval percentiles", () => {
    const sampler = createFrameIntervalSampler(3);
    [0, 16, 34, 51, 91].forEach((time) => sampler.record(time));
    expect(sampler.summary()).toEqual({ samples: 3, p50Ms: 18, p95Ms: 40, maxMs: 40 });
  });
});
