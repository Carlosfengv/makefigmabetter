import { describe, expect, it } from "vitest";
import { emptyMainThreadLongTaskSummary, recordMainThreadLongTask } from "./main-thread-health";

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
});
