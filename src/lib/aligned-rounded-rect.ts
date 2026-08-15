import { resolveCornerRadii } from "./corner-radii";

type MutableCornerRadii = [number, number, number, number];

/**
 * The single source for the corner radii of an aligned (Inside/Outside) Stroke's
 * paint ring on a rounded rectangle. Both the Canvas renderer and the SVG
 * exporter derive the inner/outer contour from here so their per-corner rounding
 * cannot drift: each radius is resolved against the original box, shifted by the
 * stroke offset, then re-resolved against the offset box so neighbouring corners
 * never overlap after the inset/outset. Returns `undefined` when the node has no
 * explicit per-corner array — callers then fall back to the scalar radius
 * (`radius - inset` / `radius + outset`), matching the historical uniform shape.
 */
export function insetRoundedRectRadii(
  width: number,
  height: number,
  radius: number,
  cornerRadii: readonly number[] | undefined,
  inset: number,
): MutableCornerRadii | undefined {
  if (!cornerRadii) return undefined;
  const shifted = resolveCornerRadii(width, height, radius, cornerRadii).map((value) => Math.max(0, value - inset));
  return [...resolveCornerRadii(Math.max(0, width - inset * 2), Math.max(0, height - inset * 2), Math.max(0, radius - inset), shifted)];
}

/** Outset counterpart of {@link insetRoundedRectRadii}; see its contract. */
export function outsetRoundedRectRadii(
  width: number,
  height: number,
  radius: number,
  cornerRadii: readonly number[] | undefined,
  outset: number,
): MutableCornerRadii | undefined {
  if (!cornerRadii) return undefined;
  const shifted = resolveCornerRadii(width, height, radius, cornerRadii).map((value) => value + outset);
  return [...resolveCornerRadii(width + outset * 2, height + outset * 2, radius + outset, shifted)];
}
