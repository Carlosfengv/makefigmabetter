import { admitEffectSurfacePool } from "./effect-surface-budget";

export const MAX_SUBTREE_COMPOSITE_NESTING = 4;
export const SUBTREE_COMPOSITE_SURFACES_PER_DEPTH = 3;

export type SubtreeCompositeAdmission =
  | { accepted: true; bytesPerSurface: number; totalBytes: number }
  | { accepted: false; reason: "nesting" | "invalidDimensions" | "surfaceLimit" | "frameLimit" };

/**
 * A live isolated subtree retains a source plus two effect scratch surfaces at
 * every nesting depth. Charge the full active stack before allocating so a
 * nested Group cannot make each local pool independently spend the frame cap.
 */
export function admitSubtreeCompositeSurfacePool(
  pixelWidth: number,
  pixelHeight: number,
  depth: number,
): SubtreeCompositeAdmission {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth >= MAX_SUBTREE_COMPOSITE_NESTING)
    return { accepted: false, reason: "nesting" };
  return admitEffectSurfacePool(
    pixelWidth,
    pixelHeight,
    SUBTREE_COMPOSITE_SURFACES_PER_DEPTH * (depth + 1),
  );
}
