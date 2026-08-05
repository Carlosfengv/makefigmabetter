import { describe, expect, it } from "vitest";
import { wasmHydrationBatches } from "./wasm-hydration-batches";

describe("WASM hydration batches", () => {
  it("preserves every projection node in bounded order", () => {
    expect([...wasmHydrationBatches(Array.from({ length: 2_050 }, (_, index) => index), 1_024)]).toEqual([
      Array.from({ length: 1_024 }, (_, index) => index),
      Array.from({ length: 1_024 }, (_, index) => index + 1_024),
      [2_048, 2_049],
    ]);
  });

  it("rejects invalid batch sizes rather than silently spinning", () => {
    expect(() => [...wasmHydrationBatches([1], 0)]).toThrow("INVALID_WASM_HYDRATION_BATCH_SIZE");
  });
});
