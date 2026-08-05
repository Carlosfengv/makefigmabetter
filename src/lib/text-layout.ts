import { DEFAULT_TEXT_LINE_HEIGHT } from "./editor-protocol";

export interface TextLayoutOptions {
  text: string;
  maxWidth: number;
  measure: (value: string) => number;
}

export type TextDirection = "ltr" | "rtl";

export interface TextLayoutLine {
  text: string;
  /** Paragraph base direction; the Canvas text engine applies glyph-level bidi. */
  direction: TextDirection;
}

export interface TextLayoutRange extends TextLayoutLine {
  /** UTF-8 byte offsets into the original, unmodified source string. */
  start: number;
  end: number;
}

/** A hard-break paragraph before width wrapping. The DOM editing layer uses
 * these ranges to apply Figma paragraph spacing without inventing a second
 * UTF-16 based style-run coordinate system. */
export interface TextParagraphRange extends TextLayoutLine {
  start: number;
  end: number;
}

export interface TextRenderMetrics {
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number;
}

/**
 * Keep the text box, glyph metrics, and clipping region in one coordinate
 * system. A canvas zoom is a visual transform only: it must not introduce a
 * minimum screen font size that changes a paragraph's line breaks.
 */
export function resolveTextRenderMetrics(width: number, height: number, zoom: number): TextRenderMetrics {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const scaledWidth = Math.max(0, width * safeZoom);
  const scaledHeight = Math.max(0, height * safeZoom);
  const fontSize = 31 * safeZoom;
  return { width: scaledWidth, height: scaledHeight, fontSize, lineHeight: DEFAULT_TEXT_LINE_HEIGHT * safeZoom };
}

/**
 * Presentation-only line breaking. It preserves Unicode grapheme-like clusters
 * before asking a renderer for width, so wrapping cannot split surrogate pairs,
 * combining marks, variation selectors, or common ZWJ emoji sequences. This is
 * deliberately not a substitute for HarfBuzz shaping or ICU line breaking.
 */
export function layoutTextLines({ text, maxWidth, measure }: TextLayoutOptions): string[] {
  return layoutText({ text, maxWidth, measure }).map((line) => line.text);
}

/**
 * Establishes an explicit paragraph base direction before handing logical text to
 * Canvas. Browser text shaping still renders individual bidi runs; this function
 * only avoids drawing an RTL paragraph from the incorrect edge of its text box.
 */
export function layoutText({ text, maxWidth, measure }: TextLayoutOptions): TextLayoutLine[] {
  return layoutTextRanges({ text, maxWidth, measure }).map(({ text: line, direction }) => ({ text: line, direction }));
}

/** Retains Canonical UTF-8 offsets so presentation can apply Style Runs without
 * inventing a second character-index coordinate system. */
export function layoutTextRanges({ text, maxWidth, measure }: TextLayoutOptions): TextLayoutRange[] {
  const safeWidth = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Number.POSITIVE_INFINITY;
  const ranges: TextLayoutRange[] = [];
  let cursor = 0;
  for (const separator of text.matchAll(PARAGRAPH_SEPARATOR)) {
    const end = separator.index ?? cursor;
    ranges.push(...wrapParagraphRanges(text.slice(cursor, end), byteLength(text.slice(0, cursor)), safeWidth, measure));
    cursor = end + separator[0].length;
  }
  ranges.push(...wrapParagraphRanges(text.slice(cursor), byteLength(text.slice(0, cursor)), safeWidth, measure));
  return ranges;
}

export function textParagraphRanges(text: string): TextParagraphRange[] {
  const ranges: TextParagraphRange[] = [];
  let cursor = 0;
  for (const separator of text.matchAll(PARAGRAPH_SEPARATOR)) {
    const end = separator.index ?? cursor;
    const paragraph = text.slice(cursor, end);
    ranges.push({ text: paragraph, direction: resolveTextDirection(paragraph), start: byteLength(text.slice(0, cursor)), end: byteLength(text.slice(0, end)) });
    cursor = end + separator[0].length;
  }
  const paragraph = text.slice(cursor);
  ranges.push({ text: paragraph, direction: resolveTextDirection(paragraph), start: byteLength(text.slice(0, cursor)), end: byteLength(text) });
  return ranges;
}

/** Uses the first Unicode strong character, falling back to LTR for neutral text. */
export function resolveTextDirection(value: string): TextDirection {
  for (const character of value) {
    if (RTL_STRONG.test(character)) return "rtl";
    if (LTR_STRONG.test(character)) return "ltr";
  }
  return "ltr";
}

export function segmentGraphemes(value: string): string[] {
  if (nativeGraphemeSegmenter) {
    return Array.from(nativeGraphemeSegmenter.segment(value), ({ segment }) => segment);
  }
  return segmentGraphemesFallback(value);
}

/**
 * Used only in runtimes without Intl.Segmenter. The native segmenter follows
 * the platform Unicode grapheme rules and covers scripts such as Hangul Jamo
 * that the small fallback deliberately does not try to reproduce in full.
 */
function segmentGraphemesFallback(value: string): string[] {
  const clusters: string[] = [];
  let current = "";
  let previousWasJoiner = false;
  let regionalIndicators = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const extendsCurrent = isExtend(character, codePoint)
      || previousWasJoiner
      || (isRegionalIndicator(codePoint) && regionalIndicators % 2 === 1);
    if (!current || extendsCurrent || character === "\u200d") {
      current += character;
      if (isRegionalIndicator(codePoint)) regionalIndicators += 1;
    } else {
      clusters.push(current);
      current = character;
      regionalIndicators = isRegionalIndicator(codePoint) ? 1 : 0;
    }
    previousWasJoiner = character === "\u200d";
  }
  if (current) clusters.push(current);
  return clusters;
}

function wrapParagraphRanges(paragraph: string, baseByte: number, maxWidth: number, measure: (value: string) => number): TextLayoutRange[] {
  const clusters = graphemeRanges(paragraph, baseByte);
  const direction = resolveTextDirection(paragraph);
  if (!clusters.length) return [{ text: "", direction, start: baseByte, end: baseByte }];
  const lines: TextLayoutRange[] = [];
  let line: GraphemeRange[] = [];
  for (const cluster of clusters) {
    const candidate = [...line, cluster].map((item) => item.text).join("");
    if (line.length && measure(candidate) > maxWidth) {
      const breakIndex = lastWhitespaceRange(line);
      if (breakIndex >= 0) {
        const completed = line.slice(0, breakIndex);
        if (completed.length) lines.push(lineRange(completed, direction));
        line = trimLeadingWhitespaceRanges(line.slice(breakIndex + 1));
      } else {
        lines.push(lineRange(line, direction));
        line = [];
      }
      if (isWhitespace(cluster.text) && line.length === 0) continue;
    }
    line.push(cluster);
  }
  if (line.length) lines.push(lineRange(line, direction));
  return lines.length ? lines : [{ text: "", direction, start: baseByte, end: baseByte }];
}

type GraphemeRange = { text: string; start: number; end: number };

function graphemeRanges(value: string, baseByte: number): GraphemeRange[] {
  let cursor = baseByte;
  return segmentGraphemes(value).map((text) => {
    const start = cursor;
    cursor += byteLength(text);
    return { text, start, end: cursor };
  });
}

function lineRange(clusters: GraphemeRange[], direction: TextDirection): TextLayoutRange {
  return {
    text: clusters.map((cluster) => cluster.text).join(""),
    direction,
    start: clusters[0].start,
    end: clusters[clusters.length - 1].end,
  };
}

function lastWhitespaceRange(clusters: GraphemeRange[]): number {
  for (let index = clusters.length - 1; index >= 0; index -= 1) if (isWhitespace(clusters[index].text)) return index;
  return -1;
}

function trimLeadingWhitespaceRanges(clusters: GraphemeRange[]): GraphemeRange[] {
  const firstContent = clusters.findIndex((cluster) => !isWhitespace(cluster.text));
  return firstContent < 0 ? [] : clusters.slice(firstContent);
}

function isWhitespace(value: string): boolean { return /^\s+$/u.test(value); }
function isRegionalIndicator(codePoint: number): boolean { return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff; }
function isExtend(character: string, codePoint: number): boolean {
  return /\p{Mark}/u.test(character)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff);
}

const RTL_STRONG = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LTR_STRONG = /\p{L}/u;
const PARAGRAPH_SEPARATOR = /\r\n|[\n\r\u2028\u2029]/gu;
const nativeGraphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
