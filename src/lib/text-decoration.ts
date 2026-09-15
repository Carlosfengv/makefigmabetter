import type { DocumentPaintLayer, DocumentTextDecoration, DocumentTextDecorationColor, DocumentTextDecorationOffset, DocumentTextDecorationStyle, DocumentTextDecorationThickness } from "./editor-protocol";
import { colorToSrgbCss } from "./color-rendering";

export type BasicTextDecorationRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type TextDecorationInkInterval = Readonly<{ start: number; end: number }>;
export type BasicTextDecorationPattern =
  | Readonly<{ kind: "solid" }>
  | Readonly<{ kind: "dotted"; radius: number; spacing: number }>
  | Readonly<{ kind: "wavy"; amplitude: number; wavelength: number; strokeWidth: number }>;

/** Resolves the exact paint list used for a decoration. AUTO follows the glyph
 * layers; an explicit underline color replaces them with one dedicated layer. */
export function textDecorationPaintLayers(
  decoration: DocumentTextDecoration | undefined,
  color: DocumentTextDecorationColor | undefined,
  glyphLayers: readonly DocumentPaintLayer[],
): readonly DocumentPaintLayer[] {
  if (!decoration) return [];
  if (decoration !== "underline" || !color) return glyphLayers;
  if (!color.visible || color.opacity <= 0) return [];
  return [{
    visible: true,
    opacity: color.opacity,
    blendMode: color.blendMode,
    paint: { css: colorToSrgbCss(color.color), color: color.color },
  }];
}

export function basicTextDecorationPattern(
  style: DocumentTextDecorationStyle | undefined,
  thickness: number,
): BasicTextDecorationPattern | undefined {
  if (!Number.isFinite(thickness) || thickness <= 0) return undefined;
  if (style === "dotted") return { kind: "dotted", radius: thickness / 2, spacing: thickness * 2.5 };
  if (style === "wavy") return { kind: "wavy", amplitude: thickness, wavelength: Math.max(4, thickness * 4), strokeWidth: Math.max(1, thickness * .75) };
  return { kind: "solid" };
}

/** Resolves the deterministic solid AUTO decoration used by Canvas. Keeping
 * geometry pure makes alignment, zoom and baseline behavior independently
 * testable while richer Figma decoration controls remain version-gated. */
export function basicTextDecorationRect(input: Readonly<{
  decoration: DocumentTextDecoration;
  fontSize: number;
  zoom: number;
  textWidth: number;
  textAlign: CanvasTextAlign;
  anchorX: number;
  baseline: number;
  actualBoundingBoxDescent: number;
  offset?: DocumentTextDecorationOffset;
  thickness?: DocumentTextDecorationThickness;
}>): BasicTextDecorationRect | undefined {
  if (![input.fontSize, input.zoom, input.textWidth, input.anchorX, input.baseline, input.actualBoundingBoxDescent].every(Number.isFinite)
    || input.fontSize <= 0 || input.zoom <= 0 || input.textWidth <= 0 || input.actualBoundingBoxDescent < 0) return undefined;
  const x = input.textAlign === "center"
    ? input.anchorX - input.textWidth / 2
    : input.textAlign === "right" || input.textAlign === "end"
      ? input.anchorX - input.textWidth
      : input.anchorX;
  const autoHeight = Math.max(1, input.fontSize * input.zoom * .06);
  const height = input.decoration === "underline" && input.thickness?.unit === "pixels"
    ? input.thickness.value * input.zoom
    : input.decoration === "underline" && input.thickness?.unit === "percent"
      ? input.fontSize * input.zoom * input.thickness.value / 100
      : autoHeight;
  if (!Number.isFinite(height) || height < 0) return undefined;
  const autoUnderlineCenter = input.baseline + Math.max(autoHeight, (input.actualBoundingBoxDescent || input.fontSize * input.zoom * .2) * .45);
  const offset = input.offset?.unit === "pixels"
    ? input.offset.value * input.zoom
    : input.offset?.unit === "percent"
      ? input.fontSize * input.zoom * input.offset.value / 100
      : 0;
  if (!Number.isFinite(offset)) return undefined;
  const centerY = input.decoration === "underline"
    ? autoUnderlineCenter + offset
    : input.baseline - input.fontSize * input.zoom * .3;
  return { x, y: centerY - height / 2, width: input.textWidth, height };
}

/** Subtracts measured descender intervals from a decoration line. Inputs are
 * clipped, sorted and merged so malformed or overlapping glyph metrics cannot
 * create negative-width Canvas operations. */
export function textDecorationVisibleSegments(
  rect: BasicTextDecorationRect,
  exclusions: readonly TextDecorationInkInterval[],
): readonly BasicTextDecorationRect[] {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return [];
  const left = rect.x;
  const right = rect.x + rect.width;
  const normalized = exclusions
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .map(({ start, end }) => ({ start: Math.max(left, start), end: Math.min(right, end) }))
    .filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of normalized) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const segments: BasicTextDecorationRect[] = [];
  let cursor = left;
  for (const interval of merged) {
    if (interval.start > cursor) segments.push({ ...rect, x: cursor, width: interval.start - cursor });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < right) segments.push({ ...rect, x: cursor, width: right - cursor });
  return segments;
}
