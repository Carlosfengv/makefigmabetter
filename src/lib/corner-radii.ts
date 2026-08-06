export type CornerRadii = readonly [number, number, number, number];

/** Top-left, top-right, bottom-right, bottom-left. `undefined` retains the
 * historical uniform radius; explicit values are normalized as one shape so
 * neighbouring corners never overlap after a resize. */
export function resolveCornerRadii(width: number, height: number, radius: number, cornerRadii?: readonly number[]): CornerRadii {
  const safeWidth = finitePositive(width);
  const safeHeight = finitePositive(height);
  const fallback = finiteNonNegative(radius);
  const source: CornerRadii = cornerRadii?.length === 4
    ? [finiteNonNegative(cornerRadii[0]), finiteNonNegative(cornerRadii[1]), finiteNonNegative(cornerRadii[2]), finiteNonNegative(cornerRadii[3])]
    : [fallback, fallback, fallback, fallback];
  if (!safeWidth || !safeHeight) return [0, 0, 0, 0];
  const scale = Math.min(
    1,
    safeWidth / Math.max(1e-12, source[0] + source[1]),
    safeWidth / Math.max(1e-12, source[3] + source[2]),
    safeHeight / Math.max(1e-12, source[0] + source[3]),
    safeHeight / Math.max(1e-12, source[1] + source[2]),
  );
  return [source[0] * scale, source[1] * scale, source[2] * scale, source[3] * scale];
}

function finitePositive(value: number) { return Number.isFinite(value) && value > 0 ? value : 0; }
function finiteNonNegative(value: number | undefined) { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0; }
