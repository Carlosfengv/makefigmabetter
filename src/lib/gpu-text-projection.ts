import type { RustGlyphRaster } from "./rust-glyph-raster";
import type { RustTextLayout } from "./rust-text-layout";
import type { WebGpuTextGlyph } from "./webgpu-scene";

export type GpuTextProjectionInput = {
  nodeId: string;
  fontAssetId: string;
  faceIndex: number;
  fontSize: number;
  pixelSize: number;
  x: number;
  y: number;
  rotation: number;
  fill: string;
  opacity: number;
  lineHeight: number;
  layout: RustTextLayout;
  rasters: ReadonlyMap<number, RustGlyphRaster | undefined>;
};

/** Converts a validated Rust line layout and immutable alpha masks into world
 * quads. It owns no Canvas, texture, font byte or Canonical state. */
export function projectGpuTextGlyphs(input: GpuTextProjectionInput): WebGpuTextGlyph[] | undefined {
  if (!Number.isFinite(input.fontSize) || input.fontSize <= 0 || !Number.isFinite(input.lineHeight) || input.lineHeight <= 0 || input.layout.unitsPerEm <= 0) return undefined;
  const scale = input.fontSize / input.layout.unitsPerEm;
  const glyphs: WebGpuTextGlyph[] = [];
  let lineY = 0;
  for (const line of input.layout.lines) {
    let penX = 0;
    let ascent: number | undefined;
    for (const glyph of line.glyphs) {
      if (glyph.glyphId === 0) return undefined;
      const raster = input.rasters.get(glyph.glyphId);
      if (!raster) return undefined;
      ascent ??= raster.ascent;
      glyphs.push({
        textureKey: `${input.fontAssetId}:${input.faceIndex}:${glyph.glyphId}:${input.pixelSize}`,
        nodeId: input.nodeId,
        x: input.x + penX + glyph.xOffset * scale + raster.bearingX,
        y: input.y + lineY + ascent - raster.bearingY - glyph.yOffset * scale,
        width: raster.width,
        height: raster.height,
        rotation: input.rotation,
        fill: input.fill,
        opacity: input.opacity,
        maskWidth: raster.width,
        maskHeight: raster.height,
        alphaMask: raster.alphaMask,
      });
      penX += glyph.xAdvance * scale;
    }
    lineY += input.lineHeight;
  }
  return glyphs;
}
