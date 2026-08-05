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
