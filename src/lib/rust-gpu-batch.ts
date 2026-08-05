import { GPU_INSTANCE_FLOATS } from "./webgpu-scene";

export type RustGpuSceneBatch = {
  instances: Float32Array;
  renderedNodeIds: ReadonlySet<string>;
};

/** Parses the handle-free batch exported by the Canonical Rust scene projection.
 * Invalid derived data is ignored so the Worker can safely use its local fallback. */
export function parseRustGpuSceneBatch(value: string): RustGpuSceneBatch | undefined {
  try {
    const payload = JSON.parse(value) as { instanceFloats?: unknown; renderedNodeIds?: unknown };
    if (!Array.isArray(payload.instanceFloats) || !Array.isArray(payload.renderedNodeIds)) return undefined;
    if (payload.instanceFloats.length % GPU_INSTANCE_FLOATS !== 0) return undefined;
    if (payload.instanceFloats.some((item) => typeof item !== "number" || !Number.isFinite(item))) return undefined;
    if (payload.renderedNodeIds.length !== payload.instanceFloats.length / GPU_INSTANCE_FLOATS) return undefined;
    if (payload.renderedNodeIds.some((item) => typeof item !== "string")) return undefined;
    return {
      instances: Float32Array.from(payload.instanceFloats),
      renderedNodeIds: new Set(payload.renderedNodeIds),
    };
  } catch {
    return undefined;
  }
}
