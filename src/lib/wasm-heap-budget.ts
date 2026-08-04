/**
 * A Phase 0 soft limit for the actual linear memory allocated by the WASM
 * instance. It is intentionally observational: the browser owns memory growth,
 * and a warning must never mutate the Canonical Document.
 */
export const MAX_WASM_HEAP_BYTES = 256 * 1024 * 1024;

export type WasmHeapAssessment =
  | { withinBudget: true; bytes: number }
  | { withinBudget: false; bytes: number; reason: "INVALID_SIZE" | "RESOURCE_LIMIT" };

export function assessWasmHeap(byteLength: number, budgetBytes = MAX_WASM_HEAP_BYTES): WasmHeapAssessment {
  if (!Number.isSafeInteger(byteLength) || !Number.isSafeInteger(budgetBytes) || byteLength < 0 || budgetBytes < 0) {
    return { withinBudget: false, bytes: 0, reason: "INVALID_SIZE" };
  }
  if (byteLength > budgetBytes) return { withinBudget: false, bytes: byteLength, reason: "RESOURCE_LIMIT" };
  return { withinBudget: true, bytes: byteLength };
}
