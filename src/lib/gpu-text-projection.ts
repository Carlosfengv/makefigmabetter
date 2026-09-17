import type { RustGlyphRaster } from "./rust-glyph-raster";
import type { RustTextLayout } from "./rust-text-layout";
import type { WebGpuTextGlyph } from "./webgpu-scene";

export type GpuTextProjectionRun = Readonly<{
  fontAssetId: string;
  faceIndex: number;
  /** Stable, sorted JSON identity of the FontReference variation axes. */
  variationAxesKey: string;
  /** Stable identity for deterministic synthetic weight and italic rasterization. */
  syntheticStyleKey: string;
  fontSize: number;
  /** Pixel size used to create this run's immutable alpha masks. */
  pixelSize: number;
  rasters: ReadonlyMap<number, RustGlyphRaster | undefined>;
}>;

export type GpuTextFontMetrics = Readonly<{
  ascent: number;
  descent: number;
  capHeight: number;
}>;

/** Resolves the explicit primary face metrics carried by every immutable
 * raster. Older cached payloads retain the established 0.8/0.2/0.7em rule. */
export function gpuTextFontMetrics(run: GpuTextProjectionRun | undefined): GpuTextFontMetrics | undefined {
  if (!run || !validRun(run)) return undefined;
  const raster = firstRaster(run.rasters);
  if (!raster) return undefined;
  const scale = run.fontSize / run.pixelSize;
  const ascent = raster.ascent * scale;
  const descent = (raster.descent ?? run.pixelSize * 0.2) * scale;
  const capHeight = (raster.capHeight ?? run.pixelSize * 0.7) * scale;
  return [ascent, descent, capHeight].every(Number.isFinite)
      && ascent >= 0 && descent >= 0 && capHeight > 0
    ? { ascent, descent, capHeight }
    : undefined;
}

export type GpuTextProjectionInput = {
  nodeId: string;
  /** One raster resource set per metric Style Run in the Rust request. */
  runs: readonly GpuTextProjectionRun[];
  x: number;
  y: number;
  /** Canonical text box width used to right-anchor RTL line advances. */
  width: number;
  rotation: number;
  alignment?: "left" | "center" | "right" | "justify";
  fill: string;
  opacity: number;
  lineHeight: number;
  lineXOffsets?: readonly number[];
  lineWidths?: readonly number[];
  lineYOffsets?: readonly number[];
  layout: RustTextLayout;
};

/** Converts a validated Rust line layout and immutable per-run alpha masks into
 * world quads. Rust metrics stay in the primary run's font-unit system while
 * each outline is scaled from its own raster pixel size. */
export function projectGpuTextGlyphs(input: GpuTextProjectionInput): WebGpuTextGlyph[] | undefined {
  const primary = input.runs[0];
  if (!primary || input.runs.length > 4_096 || !validRun(primary)
    || input.runs.some((run) => !validRun(run))
    || !Number.isFinite(input.width) || input.width <= 0
    || !Number.isFinite(input.lineHeight) || input.lineHeight <= 0
    || Boolean(input.lineXOffsets) !== Boolean(input.lineWidths)
    || input.lineXOffsets && (input.lineXOffsets.length !== input.layout.lines.length || input.lineXOffsets.some((offset) => !Number.isFinite(offset)))
    || input.lineWidths && (input.lineWidths.length !== input.layout.lines.length || input.lineWidths.some((width) => !Number.isFinite(width) || width < 0))
    || input.lineYOffsets && (input.lineYOffsets.length !== input.layout.lines.length || input.lineYOffsets.some((offset) => !Number.isFinite(offset)))
    || input.layout.unitsPerEm <= 0) return undefined;
  const primaryRaster = firstRaster(primary.rasters);
  if (!primaryRaster) return undefined;
  const metricScale = primary.fontSize / input.layout.unitsPerEm;
  const baselineAscent = primaryRaster.ascent * primary.fontSize / primary.pixelSize;
  const glyphs: WebGpuTextGlyph[] = [];
  let lineY = 0;
  for (const [lineIndex, line] of input.layout.lines.entries()) {
    if (input.lineYOffsets) lineY = input.lineYOffsets[lineIndex]!;
    const advance = line.advance * metricScale;
    const hangingLeft = (line.hangingLeftAdvance ?? 0) * metricScale;
    const hangingRight = (line.hangingRightAdvance ?? 0) * metricScale;
    const effectiveAdvance = Math.max(0, advance - hangingLeft - hangingRight);
    const lineX = input.lineXOffsets?.[lineIndex] ?? 0;
    const lineWidth = input.lineWidths?.[lineIndex] ?? input.width;
    let penX = input.alignment === "center"
      ? lineX + (lineWidth - effectiveAdvance) / 2 - hangingLeft
      : input.alignment === "right" || line.direction === "rtl"
        ? lineX + lineWidth - advance + hangingRight
        : lineX - hangingLeft;
    for (const glyph of line.glyphs) {
      if (glyph.glyphId === 0 || !Number.isInteger(glyph.runIndex)) return undefined;
      const run = input.runs[glyph.runIndex];
      const raster = run?.rasters.get(glyph.glyphId);
      if (!run || !raster) return undefined;
      const rasterScale = run.fontSize / run.pixelSize;
      glyphs.push({
        textureKey: `${run.fontAssetId}:${run.faceIndex}:${run.variationAxesKey}:${run.syntheticStyleKey}:${glyph.glyphId}:${run.pixelSize}`,
        nodeId: input.nodeId,
        x: input.x + penX + glyph.xOffset * metricScale + raster.bearingX * rasterScale,
        y: input.y + lineY + baselineAscent - raster.bearingY * rasterScale - glyph.yOffset * metricScale,
        width: raster.width * rasterScale,
        height: raster.height * rasterScale,
        rotation: input.rotation,
        paintRunIndex: glyph.runIndex,
        fill: input.fill,
        opacity: input.opacity,
        maskWidth: raster.width,
        maskHeight: raster.height,
        alphaMask: raster.alphaMask,
      });
      penX += glyph.xAdvance * metricScale;
    }
    if (!input.lineYOffsets) lineY += input.lineHeight;
  }
  return glyphs;
}

function validRun(run: GpuTextProjectionRun) {
  return Boolean(run.fontAssetId)
    && Number.isInteger(run.faceIndex) && run.faceIndex >= 0
    && Number.isFinite(run.fontSize) && run.fontSize > 0
    && Number.isInteger(run.pixelSize) && run.pixelSize > 0 && run.pixelSize <= 512;
}

function firstRaster(rasters: ReadonlyMap<number, RustGlyphRaster | undefined>) {
  for (const raster of rasters.values()) if (raster) return raster;
  return undefined;
}
