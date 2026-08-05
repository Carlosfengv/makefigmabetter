/**
 * Bounds transient JSON/serde allocations while a legacy browser projection is
 * migrated into the Rust Canonical document. The Core seed API is history-free,
 * so splitting only changes peak memory—not the resulting document state.
 */
export const WASM_HYDRATION_BATCH_NODES = 1_024;

export function* wasmHydrationBatches<T>(nodes: readonly T[], batchSize = WASM_HYDRATION_BATCH_NODES): Generator<readonly T[]> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new RangeError("INVALID_WASM_HYDRATION_BATCH_SIZE");
  for (let start = 0; start < nodes.length; start += batchSize) {
    yield nodes.slice(start, Math.min(nodes.length, start + batchSize));
  }
}
