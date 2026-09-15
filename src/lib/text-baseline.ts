/**
 * The CSS inline formatting rule used by the DOM editor: center the font
 * bounding box within its declared line box, then place the alphabetic
 * baseline. Keeping this calculation independent of a rendering context lets
 * Canvas consume exactly the same rule as the editable text layer.
 */
export function cssLineBoxBaseline(
  lineTop: number,
  lineHeight: number,
  metrics: Pick<TextMetrics, "fontBoundingBoxAscent" | "fontBoundingBoxDescent">,
  fallbackFontSize: number,
): number {
  const ascent = metrics.fontBoundingBoxAscent || fallbackFontSize * 0.8;
  const descent = metrics.fontBoundingBoxDescent || fallbackFontSize * 0.2;
  return lineTop + (lineHeight - ascent - descent) / 2 + ascent;
}

export type LeadingTrimLineBox = Readonly<{
  baseline: number;
  trimStart: number;
  trimEnd: number;
}>;

/** Deterministic CAP_HEIGHT projection for Canvas/SVG layout. The cap edge is
 * measured from an uppercase H. The lower outer edge is the alphabetic
 * baseline, matching Figma's documented removal of space below glyphs while
 * allowing descenders to paint outside the trimmed logical box. */
export function leadingTrimLineBox(
  lineTop: number,
  lineHeight: number,
  fontMetrics: Pick<TextMetrics, "fontBoundingBoxAscent" | "fontBoundingBoxDescent">,
  capMetrics: Pick<TextMetrics, "actualBoundingBoxAscent">,
  fallbackFontSize: number,
  leadingTrim: "capHeight" | undefined,
): LeadingTrimLineBox {
  const cssBaseline = cssLineBoxBaseline(lineTop, lineHeight, fontMetrics, fallbackFontSize);
  if (leadingTrim !== "capHeight") return { baseline: cssBaseline, trimStart: 0, trimEnd: 0 };
  const capAscent = capMetrics.actualBoundingBoxAscent || fallbackFontSize * 0.7;
  const baseline = lineTop + capAscent;
  return {
    baseline,
    trimStart: Math.max(0, cssBaseline - baseline),
    trimEnd: Math.max(0, lineTop + lineHeight - cssBaseline),
  };
}
