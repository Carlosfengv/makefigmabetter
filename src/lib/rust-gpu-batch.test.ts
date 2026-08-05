import { describe, expect, it } from "vitest";
import { GPU_INSTANCE_FLOATS } from "./webgpu-scene";
import { parseRustGpuSceneBatch } from "./rust-gpu-batch";

describe("Rust GPU scene batch boundary", () => {
  it("accepts a complete finite WGSL instance batch", () => {
    const result = parseRustGpuSceneBatch(JSON.stringify({
      instanceFloats: Array.from({ length: GPU_INSTANCE_FLOATS }, (_, index) => index),
      renderedNodeIds: ["00000000-0000-0000-0000-000000000001"],
    }));
    expect(result?.instances).toHaveLength(GPU_INSTANCE_FLOATS);
    expect(result?.renderedNodeIds).toEqual(new Set(["00000000-0000-0000-0000-000000000001"]));
  });

  it("rejects malformed or incomplete derived data and leaves fallback available", () => {
    expect(parseRustGpuSceneBatch("not json")).toBeUndefined();
    expect(parseRustGpuSceneBatch(JSON.stringify({ instanceFloats: [0], renderedNodeIds: [] }))).toBeUndefined();
    expect(parseRustGpuSceneBatch(JSON.stringify({
      instanceFloats: Array.from({ length: GPU_INSTANCE_FLOATS }, () => Number.NaN),
      renderedNodeIds: ["node"],
    }))).toBeUndefined();
  });
});
