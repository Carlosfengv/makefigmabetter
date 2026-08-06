/**
 * Canonicalizes Figma's unitless corner-smoothing control. Values outside the
 * durable Core contract are treated as the legacy circular-corner default by
 * read-only rendering helpers; write paths reject them before persistence.
 */
export function resolveCornerSmoothing(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : 0;
}

/** A superellipse exponent gives a continuous, monotonic approximation of
 * Figma's rounded-to-continuous corner transition. `0` is exactly circular. */
export function cornerSmoothingExponent(value: number | undefined): number {
  return 2 + resolveCornerSmoothing(value) * 6;
}
