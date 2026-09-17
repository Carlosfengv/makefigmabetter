import { DEFAULT_TEXT_LINE_HEIGHT } from "./editor-protocol";

export interface TextLayoutOptions {
  text: string;
  maxWidth: number;
  /** Reduces only the first visual line of every hard-break paragraph. */
  firstLineIndent?: number | ((paragraphIndex: number, paragraphStart: number) => number);
  /** Additional inset applied to every visual line of one authored paragraph. */
  paragraphIndent?: (paragraphIndex: number, paragraphStart: number) => number;
  /** Figma paragraph wrapping. Omission/AUTO keeps the legacy greedy layout. */
  wrapStyle?: "auto" | "balance" | "pretty" | ((paragraphIndex: number, paragraphStart: number) => "auto" | "balance" | "pretty");
  /** Allows one opening/closing punctuation grapheme to occupy the visual
   * margin instead of reducing the authored line width. */
  hangingPunctuation?: boolean;
  measure: (value: string) => number;
  /** Measures a source range when presentation can change glyphs or style.
   * Offsets remain UTF-8 bytes into `text`; the fallback keeps the legacy
   * single-style callback for callers that do not need range awareness. */
  measureRange?: (start: number, end: number, value: string) => number;
}

export type TextListType = "ordered" | "unordered";
type ParagraphListProperties = {
  paragraph: { listType?: TextListType; paragraphIndent?: number };
  paragraphStyleRuns?: ReadonlyArray<{
    start: number;
    indentation?: number;
    listType?: "none" | TextListType;
    listSpacing?: number;
    paragraphSpacing?: number;
    paragraphIndent?: number;
    lineHeight?: number;
    lineHeightUnit?: "percent" | "auto";
    textWrapStyle?: "auto" | "balance" | "pretty";
  }>;
};

export function textParagraphIndentAt(properties: ParagraphListProperties | undefined, paragraphStart: number): number {
  if (!properties) return 0;
  return paragraphStyleRunAt(properties.paragraphStyleRuns, paragraphStart)?.paragraphIndent
    ?? properties.paragraph.paragraphIndent
    ?? 0;
}

export function textParagraphWrapStyleAt(
  properties: ParagraphListProperties & { paragraph: { textWrapStyle?: "balance" | "pretty" } } | undefined,
  paragraphStart: number,
): "auto" | "balance" | "pretty" {
  return paragraphStyleRunAt(properties?.paragraphStyleRuns, paragraphStart)?.textWrapStyle
    ?? properties?.paragraph.textWrapStyle
    ?? "auto";
}

export function textParagraphGap(properties: {
  paragraph: {
    paragraphSpacing: number;
    listType?: TextListType;
    listSpacing?: number;
  };
  paragraphStyleRuns?: ParagraphListProperties["paragraphStyleRuns"];
} | undefined, paragraphStart = 0, nextParagraphStart = paragraphStart): number {
  if (!properties) return 0;
  return textParagraphSpacingAt(properties, paragraphStart)
    + (textParagraphListTypeAt(properties, paragraphStart)
      && textParagraphListTypeAt(properties, nextParagraphStart)
      ? textParagraphListSpacingAt(properties, paragraphStart)
      : 0);
}

export function textParagraphSpacingAt(
  properties: { paragraph: { paragraphSpacing: number }; paragraphStyleRuns?: ParagraphListProperties["paragraphStyleRuns"] },
  paragraphStart: number,
): number {
  return paragraphStyleRunAt(properties.paragraphStyleRuns, paragraphStart)?.paragraphSpacing
    ?? properties.paragraph.paragraphSpacing;
}

export function textParagraphListSpacingAt(
  properties: ParagraphListProperties & { paragraph: { listSpacing?: number } },
  paragraphStart: number,
): number {
  return paragraphStyleRunAt(properties.paragraphStyleRuns, paragraphStart)?.listSpacing
    ?? properties.paragraph.listSpacing
    ?? 0;
}

export function textListMarker(type: TextListType, paragraphIndex: number): string {
  return type === "ordered" ? `${Math.max(0, paragraphIndex) + 1}.` : "•";
}

/** Identifies the first visual line of each authored hard-break paragraph.
 * The explicit line index matters when the document starts with an empty
 * paragraph: both its zero-length line and the following paragraph start at
 * byte offset zero. */
export function textLineStartsParagraph(lineIndex: number, skippedSource: string): boolean {
  return lineIndex === 0 || PARAGRAPH_SEPARATOR_SINGLE.test(skippedSource);
}

/** Reserves one stable marker column for every paragraph in the block. The
 * marker is painted separately, so Canonical source offsets stay unchanged. */
export function textListMarkerGutter(
  text: string,
  type: TextListType | undefined,
  measure: (value: string) => number,
): number {
  if (!type) return 0;
  const gap = Math.max(0, measure(" "));
  if (type === "unordered") return Math.max(0, measure("•")) + gap;
  const digits = String(textParagraphRanges(text).length).length;
  return Math.max(0, measure(`${"8".repeat(digits)}.`)) + gap;
}

/** Stable marker column shared by paragraphs even when their list types differ. */
export function textListMarkerGutterForProperties(
  text: string,
  properties: ParagraphListProperties | undefined,
  measure: (value: string) => number,
): number {
  if (!properties) return 0;
  const types = textParagraphRanges(text).map((paragraph) =>
    textParagraphListTypeAt(properties, paragraph.start));
  return Math.max(
    0,
    types.includes("ordered") ? textListMarkerGutter(text, "ordered", measure) : 0,
    types.includes("unordered") ? textListMarkerGutter(text, "unordered", measure) : 0,
  );
}

export function textParagraphListTypeAt(
  properties: ParagraphListProperties | undefined,
  paragraphStart: number,
): TextListType | undefined {
  if (!properties) return undefined;
  const override = paragraphStyleRunAt(properties.paragraphStyleRuns, paragraphStart)?.listType;
  return override === "none" ? undefined : override ?? properties.paragraph.listType;
}

/** Width reserved inside the text box for the first list marker column. */
export function textListMarkerBaseIndent(
  properties: ParagraphListProperties & { paragraph: { listType?: TextListType; hangingList?: boolean } } | undefined,
  gutter: number,
  paragraphStart = 0,
): number {
  if (!textParagraphListTypeAt(properties, paragraphStart) || properties?.paragraph.hangingList) return 0;
  return Number.isFinite(gutter) ? Math.max(0, gutter) : 0;
}

export function textListIndentationOffset(
  text: string,
  properties: ParagraphListProperties | undefined,
  byteOffset: number,
  step: number,
): number {
  if (!properties || !Number.isFinite(step) || step <= 0) return 0;
  const paragraphStart = textParagraphStartAtOffset(text, byteOffset);
  if (!textParagraphListTypeAt(properties, paragraphStart)) return 0;
  const level = paragraphStyleRunAt(properties.paragraphStyleRuns, paragraphStart)?.indentation ?? 1;
  return Math.max(0, Math.min(100, level) - 1) * step;
}

function paragraphStyleRunAt(
  runs: ParagraphListProperties["paragraphStyleRuns"],
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

export function textParagraphStartAtOffset(text: string, byteOffset: number): number {
  let start = 0;
  for (const paragraph of textParagraphRanges(text)) {
    if (paragraph.start > byteOffset) break;
    start = paragraph.start;
  }
  return start;
}

export type TextDirection = "ltr" | "rtl";

/** Places a logical-start indent on the physical side selected by the
 * paragraph direction. Width fitting only needs the indent amount; every
 * renderer and interaction projection uses this helper to recover the same
 * physical line box afterwards. */
export function textIndentedLineBox(
  boxStart: number,
  boxWidth: number,
  indent: number,
  direction: TextDirection,
): { start: number; width: number } {
  const safeIndent = Number.isFinite(indent) ? Math.max(0, indent) : 0;
  const width = Math.max(0, boxWidth - safeIndent);
  return {
    start: direction === "rtl" ? boxStart : boxStart + safeIndent,
    width,
  };
}

/** Positions a presentation-only list marker at the visual start edge of the
 * measured content. Marker glyphs stay LTR so ordered-list punctuation does
 * not reorder, while RTL paragraphs reserve and paint their column on the
 * right. */
export function textListMarkerPlacement(
  contentStart: number,
  contentWidth: number,
  gap: number,
  direction: TextDirection,
): { x: number; align: "left" | "right"; anchor: "start" | "end" } {
  if (direction === "rtl") return {
    x: contentStart + contentWidth + Math.max(0, gap),
    align: "left",
    anchor: "start",
  };
  return {
    x: contentStart - Math.max(0, gap),
    align: "right",
    anchor: "end",
  };
}

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
export function layoutTextLines(options: TextLayoutOptions): string[] {
  return layoutText(options).map((line) => line.text);
}

/**
 * Establishes an explicit paragraph base direction before handing logical text to
 * Canvas. Browser text shaping still renders individual bidi runs; this function
 * only avoids drawing an RTL paragraph from the incorrect edge of its text box.
 */
export function layoutText(options: TextLayoutOptions): TextLayoutLine[] {
  return layoutTextRanges(options).map(({ text: line, direction }) => ({ text: line, direction }));
}

/** Retains Canonical UTF-8 offsets so presentation can apply Style Runs without
 * inventing a second character-index coordinate system. */
export function layoutTextRanges({ text, maxWidth, firstLineIndent, paragraphIndent, wrapStyle = "auto", hangingPunctuation = false, measure, measureRange }: TextLayoutOptions): TextLayoutRange[] {
  const safeWidth = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Number.POSITIVE_INFINITY;
  const safeFirstLineIndent = (paragraphIndex: number, paragraphStart: number) => {
    const raw = typeof firstLineIndent === "function"
      ? firstLineIndent(paragraphIndex, paragraphStart)
      : firstLineIndent ?? 0;
    return Number.isFinite(raw) && raw > 0
      ? Math.min(raw, Number.isFinite(safeWidth) ? Math.max(0, safeWidth - Number.EPSILON) : raw)
      : 0;
  };
  const ranges: TextLayoutRange[] = [];
  let cursor = 0;
  let paragraphIndex = 0;
  for (const separator of text.matchAll(PARAGRAPH_SEPARATOR)) {
    const end = separator.index ?? cursor;
    const baseByte = byteLength(text.slice(0, cursor));
    const blockIndent = Math.max(0, paragraphIndent?.(paragraphIndex, baseByte) ?? 0);
    const paragraphWrapStyle = typeof wrapStyle === "function" ? wrapStyle(paragraphIndex, baseByte) : wrapStyle;
    ranges.push(...wrapParagraphRanges(text.slice(cursor, end), baseByte, safeWidth, safeFirstLineIndent(paragraphIndex, baseByte) + blockIndent, blockIndent, paragraphWrapStyle, hangingPunctuation, measure, measureRange));
    cursor = end + separator[0].length;
    paragraphIndex += 1;
  }
  const baseByte = byteLength(text.slice(0, cursor));
  const blockIndent = Math.max(0, paragraphIndent?.(paragraphIndex, baseByte) ?? 0);
  const paragraphWrapStyle = typeof wrapStyle === "function" ? wrapStyle(paragraphIndex, baseByte) : wrapStyle;
  ranges.push(...wrapParagraphRanges(text.slice(cursor), baseByte, safeWidth, safeFirstLineIndent(paragraphIndex, baseByte) + blockIndent, blockIndent, paragraphWrapStyle, hangingPunctuation, measure, measureRange));
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

function wrapParagraphRanges(
  paragraph: string,
  baseByte: number,
  maxWidth: number,
  firstLineIndent: number,
  continuationIndent: number,
  wrapStyle: "auto" | "balance" | "pretty",
  hangingPunctuation: boolean,
  measure: (value: string) => number,
  measureRange?: (start: number, end: number, value: string) => number,
): TextLayoutRange[] {
  const automatic = wrapParagraphRangesAtWidth(paragraph, baseByte, maxWidth, firstLineIndent, continuationIndent, hangingPunctuation, measure, measureRange);
  if (wrapStyle === "auto" || automatic.length <= 1 || !Number.isFinite(maxWidth)) return automatic;
  if (wrapStyle === "pretty" && !hasOrphanedLastWord(automatic)) return automatic;
  if (automatic.length > MAX_BALANCED_LINES || segmentGraphemes(paragraph).length > MAX_BALANCED_GRAPHEMES) return automatic;

  // Preserve AUTO's line count while lowering the greedy width ceiling. The
  // smallest ceiling that still fits the same number of lines equalizes line
  // lengths; PRETTY invokes it only when AUTO leaves a one-word final line.
  let lower = Math.max(0, Math.min(firstLineIndent, maxWidth));
  let upper = maxWidth;
  let balanced = automatic;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const candidateWidth = (lower + upper) / 2;
    const candidate = wrapParagraphRangesAtWidth(
      paragraph,
      baseByte,
      candidateWidth,
      Math.min(firstLineIndent, Math.max(0, candidateWidth - Number.EPSILON)),
      Math.min(continuationIndent, Math.max(0, candidateWidth - Number.EPSILON)),
      hangingPunctuation,
      measure,
      measureRange,
    );
    if (candidate.length <= automatic.length) {
      upper = candidateWidth;
      balanced = candidate;
    } else {
      lower = candidateWidth;
    }
  }
  return balanced;
}

function wrapParagraphRangesAtWidth(
  paragraph: string,
  baseByte: number,
  maxWidth: number,
  firstLineIndent: number,
  continuationIndent: number,
  hangingPunctuation: boolean,
  measure: (value: string) => number,
  measureRange?: (start: number, end: number, value: string) => number,
): TextLayoutRange[] {
  const clusters = graphemeRanges(paragraph, baseByte);
  const direction = resolveTextDirection(paragraph);
  if (!clusters.length) return [{ text: "", direction, start: baseByte, end: baseByte }];
  const lines: TextLayoutRange[] = [];
  let line: GraphemeRange[] = [];
  for (const cluster of clusters) {
    const candidate = [...line, cluster].map((item) => item.text).join("");
    const candidateStart = line[0]?.start ?? cluster.start;
    const availableWidth = lines.length === 0 ? maxWidth - firstLineIndent : maxWidth - continuationIndent;
    const measured = measureRange?.(candidateStart, cluster.end, candidate) ?? measure(candidate);
    const hangingWidth = hangingPunctuation
      ? boundaryHangingWidth([...line, cluster], measure, measureRange)
      : 0;
    if (line.length && measured - hangingWidth > availableWidth) {
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

const HANGING_START = /^["'“‘«‹「『《〈【〔〖〘〚（［｛]$/u;
const HANGING_END = /^["',.!?:;”’»›」』》〉】〕〗〙〛）］｝、。，．！？：；…]$/u;

function boundaryHangingWidth(
  clusters: readonly GraphemeRange[],
  measure: (value: string) => number,
  measureRange?: (start: number, end: number, value: string) => number,
): number {
  const first = clusters[0];
  const last = clusters.at(-1);
  if (!first || !last) return 0;
  let width = 0;
  if (HANGING_START.test(first.text)) width += measureRange?.(first.start, first.end, first.text) ?? measure(first.text);
  if (last !== first && HANGING_END.test(last.text)) width += measureRange?.(last.start, last.end, last.text) ?? measure(last.text);
  else if (last === first && HANGING_END.test(last.text) && !HANGING_START.test(last.text)) width += measureRange?.(last.start, last.end, last.text) ?? measure(last.text);
  return Math.max(0, width);
}

export function textHangingPunctuationEdges(value: string, direction: TextDirection): { left?: string; right?: string } {
  const clusters = segmentGraphemes(value);
  const first = clusters[0];
  const last = clusters.at(-1);
  const start = first && HANGING_START.test(first) ? first : undefined;
  const end = last && HANGING_END.test(last) ? last : undefined;
  return direction === "rtl" ? { left: end, right: start } : { left: start, right: end };
}

export function textHangingPunctuationOffsets(
  value: string,
  direction: TextDirection,
  measure: (value: string) => number,
): { left: number; right: number } {
  const edges = textHangingPunctuationEdges(value, direction);
  return {
    left: Math.max(0, edges.left ? measure(edges.left) : 0),
    right: Math.max(0, edges.right ? measure(edges.right) : 0),
  };
}

export function textAlignedLineLeft(
  boxStart: number,
  boxWidth: number,
  measuredWidth: number,
  alignment: "left" | "center" | "right" | "justify",
  direction: TextDirection,
  hanging: { left: number; right: number } = { left: 0, right: 0 },
): number {
  const effectiveWidth = Math.max(0, measuredWidth - hanging.left - hanging.right);
  if (alignment === "center") return boxStart + (boxWidth - effectiveWidth) / 2 - hanging.left;
  if (alignment === "right" || direction === "rtl") return boxStart + boxWidth - measuredWidth + hanging.right;
  return boxStart - hanging.left;
}

function hasOrphanedLastWord(lines: readonly TextLayoutRange[]): boolean {
  if (lines.length < 2) return false;
  const lastWords = lines[lines.length - 1].text.trim().split(/\s+/u).filter(Boolean);
  const previousWords = lines[lines.length - 2].text.trim().split(/\s+/u).filter(Boolean);
  return lastWords.length === 1 && previousWords.length > 1;
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
const PARAGRAPH_SEPARATOR_SINGLE = /\r\n|[\n\r\u2028\u2029]/u;
const MAX_BALANCED_LINES = 32;
const MAX_BALANCED_GRAPHEMES = 512;
const nativeGraphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
