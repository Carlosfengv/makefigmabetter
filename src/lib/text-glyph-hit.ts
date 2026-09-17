import { invertAffine, transformPoint } from "./scene-transform";
import type { WebGpuTextGlyph } from "./webgpu-scene";

export type TextGlyphHitPoint = Readonly<{ x: number; y: number }>;

/** Resolves the topmost shaped glyph at a point to its canonical Style Run.
 * The glyph list is paint ordered, so overlapping path glyphs use the last
 * painted quad. Raster alpha is intentionally not sampled: hyperlink hit
 * regions follow the glyph's shaped ink box, including interior counters. */
export function textGlyphPaintRunAtPoint(
  glyphs: readonly WebGpuTextGlyph[],
  point: TextGlyphHitPoint,
): number | undefined {
  for (let index = glyphs.length - 1; index >= 0; index -= 1) {
    const glyph = glyphs[index]!;
    if (glyph.paintRunIndex !== undefined && textGlyphContainsPoint(glyph, point))
      return glyph.paintRunIndex;
  }
  return undefined;
}

export function textGlyphContainsPoint(
  glyph: Pick<WebGpuTextGlyph, "x" | "y" | "width" | "height" | "rotation" | "quadTransform">,
  point: TextGlyphHitPoint,
): boolean {
  if (![point.x, point.y, glyph.x, glyph.y, glyph.width, glyph.height, glyph.rotation]
    .every(Number.isFinite) || glyph.width <= 0 || glyph.height <= 0) return false;
  if (glyph.quadTransform) {
    const inverse = invertAffine(glyph.quadTransform);
    if (!inverse) return false;
    const normalized = transformPoint(inverse, point);
    return normalized.x >= 0 && normalized.x <= 1 && normalized.y >= 0 && normalized.y <= 1;
  }
  const centerX = glyph.x + glyph.width / 2;
  const centerY = glyph.y + glyph.height / 2;
  const radians = -glyph.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const deltaX = point.x - centerX;
  const deltaY = point.y - centerY;
  const localX = deltaX * cosine - deltaY * sine;
  const localY = deltaX * sine + deltaY * cosine;
  return Math.abs(localX) <= glyph.width / 2 && Math.abs(localY) <= glyph.height / 2;
}
