import { DEFAULT_TEXT_LINE_HEIGHT, type DocumentTextProperties } from "./editor-protocol";

/** Resolve a durable Figma-shaped line height to the shared pixel line box. */
export function resolvedTextLineHeight(
  properties: DocumentTextProperties | undefined,
  fallbackFontSize = 31,
  fallbackLineHeight = DEFAULT_TEXT_LINE_HEIGHT,
): number {
  const paragraph = properties?.paragraph;
  if (!paragraph) return fallbackLineHeight;
  const sizes = properties.runs.length
    ? properties.runs.map((run) => run.fontSize)
    : properties.baseStyle
      ? [properties.baseStyle.fontSize]
      : [];
  const fontSize = sizes.length ? Math.max(...sizes) : fallbackFontSize;
  if (paragraph.lineHeightUnit === "auto") return fontSize * 1.2;
  if (paragraph.lineHeightUnit === "percent") {
    return fontSize * (paragraph.lineHeight ?? 100) / 100;
  }
  return paragraph.lineHeight ?? fallbackLineHeight;
}

/** Resolve the effective line box for one authored hard-break paragraph. */
export function resolvedTextLineHeightAt(
  properties: DocumentTextProperties | undefined,
  paragraphStart: number,
  fallbackFontSize = 31,
  fallbackLineHeight = DEFAULT_TEXT_LINE_HEIGHT,
): number {
  const run = paragraphStyleRunAt(properties?.paragraphStyleRuns, paragraphStart);
  if (run?.lineHeightUnit === "auto") {
    return textBlockFontSize(properties, fallbackFontSize) * 1.2;
  }
  if (run?.lineHeightUnit === "percent") {
    return textBlockFontSize(properties, fallbackFontSize) * (run.lineHeight ?? 100) / 100;
  }
  if (run?.lineHeight !== undefined) return run.lineHeight;
  return resolvedTextLineHeight(properties, fallbackFontSize, fallbackLineHeight);
}

function textBlockFontSize(properties: DocumentTextProperties | undefined, fallbackFontSize: number): number {
  const sizes = properties?.runs.length
    ? properties.runs.map((run) => run.fontSize)
    : properties?.baseStyle
      ? [properties.baseStyle.fontSize]
      : [];
  return sizes.length ? Math.max(...sizes) : fallbackFontSize;
}

function paragraphStyleRunAt(
  runs: DocumentTextProperties["paragraphStyleRuns"],
  paragraphStart: number,
) {
  let low = 0;
  let high = (runs?.length ?? 0) - 1;
  while (runs && low <= high) {
    const middle = (low + high) >>> 1;
    const run = runs[middle]!;
    if (run.start === paragraphStart) return run;
    if (run.start < paragraphStart) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}
