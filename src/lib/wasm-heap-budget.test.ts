import { describe, expect, it } from "vitest";
import { assessWasmHeap } from "./wasm-heap-budget";

describe("WASM heap budget", () => {
  it("accepts measured linear memory at or below the soft limit", () => {
    expect(assessWasmHeap(64 * 1024 * 1024, 64 * 1024 * 1024)).toEqual({ withinBudget: true, bytes: 64 * 1024 * 1024 });
  });

  it("reports over-budget and invalid browser measurements without allocation", () => {
    expect(assessWasmHeap(65 * 1024 * 1024, 64 * 1024 * 1024)).toEqual({ withinBudget: false, bytes: 65 * 1024 * 1024, reason: "RESOURCE_LIMIT" });
    expect(assessWasmHeap(Number.POSITIVE_INFINITY)).toEqual({ withinBudget: false, bytes: 0, reason: "INVALID_SIZE" });
  });
});
