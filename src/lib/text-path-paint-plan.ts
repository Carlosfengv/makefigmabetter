import { colorToSrgbCss } from "./color-rendering";
import type { CanvasNode, DocumentPaintLayer } from "./editor-protocol";
import type { WebGpuTextGlyph } from "./webgpu-scene";

export type TextPathPaintBatch = Readonly<{
  layer: DocumentPaintLayer;
  glyphIndexes: readonly number[];
}>;

export type TextPathGlyphBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** Resolves the same run → node fallback chain as ordinary Text painting, then
 * groups glyphs by Paint Stack layer without losing layer order. */
export function textPathPaintBatches(
  node: Pick<CanvasNode, "textProperties">,
  glyphs: readonly WebGpuTextGlyph[],
  fallbackLayers: readonly DocumentPaintLayer[],
): readonly TextPathPaintBatch[] {
  const groups = new Map<string, { firstGlyph: number; layers: readonly DocumentPaintLayer[]; glyphIndexes: number[] }>();
  glyphs.forEach((glyph, glyphIndex) => {
    const runIndex = glyph.paintRunIndex;
    const style = runIndex === undefined ? undefined : node.textProperties?.runs[runIndex];
    const key = style?.fillStack !== undefined || style?.color ? `run:${runIndex}` : "fallback";
    let group = groups.get(key);
    if (!group) {
      const layers = style?.fillStack !== undefined
        ? style.fillStack.layers
        : style?.color
          ? [{ visible: true, opacity: 1, blendMode: "normal" as const, paint: { css: colorToSrgbCss(style.color), color: style.color } }]
          : fallbackLayers;
      group = { firstGlyph: glyphIndex, layers, glyphIndexes: [] };
      groups.set(key, group);
    }
    group.glyphIndexes.push(glyphIndex);
  });
  const orderedGroups = [...groups.values()].sort((left, right) => left.firstGlyph - right.firstGlyph);
  const layerCount = Math.max(0, ...orderedGroups.map((group) => group.layers.length));
  return Array.from({ length: layerCount }, (_, layerIndex) => orderedGroups.flatMap((group) => {
    const layer = group.layers[layerIndex];
    return layer?.visible && layer.opacity > 0 ? [{ layer, glyphIndexes: group.glyphIndexes }] : [];
  })).flat();
}

/** Axis-aligned local-screen bounds for arbitrarily rotated path glyph quads. */
export function textPathGlyphBounds(
  glyphs: readonly Pick<WebGpuTextGlyph, "x" | "y" | "width" | "height" | "rotation">[],
  zoom: number,
): TextPathGlyphBounds | undefined {
  if (!Number.isFinite(zoom) || zoom <= 0 || glyphs.length === 0) return undefined;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const glyph of glyphs) {
    if (![glyph.x, glyph.y, glyph.width, glyph.height, glyph.rotation].every(Number.isFinite)
      || glyph.width <= 0 || glyph.height <= 0) return undefined;
    const radians = glyph.rotation * Math.PI / 180;
    const halfWidth = glyph.width * zoom / 2;
    const halfHeight = glyph.height * zoom / 2;
    const extentX = Math.abs(Math.cos(radians)) * halfWidth + Math.abs(Math.sin(radians)) * halfHeight;
    const extentY = Math.abs(Math.sin(radians)) * halfWidth + Math.abs(Math.cos(radians)) * halfHeight;
    const centerX = (glyph.x + glyph.width / 2) * zoom;
    const centerY = (glyph.y + glyph.height / 2) * zoom;
    left = Math.min(left, centerX - extentX);
    top = Math.min(top, centerY - extentY);
    right = Math.max(right, centerX + extentX);
    bottom = Math.max(bottom, centerY + extentY);
  }
  const x = Math.floor(left) - 1;
  const y = Math.floor(top) - 1;
  return { x, y, width: Math.max(1, Math.ceil(right) + 1 - x), height: Math.max(1, Math.ceil(bottom) + 1 - y) };
}
