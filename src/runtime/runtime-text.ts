import type { DocumentFontReference, DocumentTextProperties, DocumentTextStyle } from "../lib/editor-protocol";
import { utf8OffsetAtUtf16Index } from "../lib/rust-text-caret";
import { patchTextStyleRuns, rebaseTextStyleRuns, rebaseTextStyleRunsAtByteRange, unicodeScalarText, type TextInsertionStyle, type TextRunStylePatch } from "../lib/text-style-run-edit";
import { runtimeError } from "./runtime-errors";

export type RuntimeTextStylePatch = TextRunStylePatch;
export type RuntimeTextInsertionStyle = TextInsertionStyle;
export type RuntimeParagraphLineHeight =
  | Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }>
  | Readonly<{ unit: "AUTO" }>;
export type RuntimeTextDefaults = Readonly<{
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  letterSpacing: number;
  lineHeight: number;
}>;

const DEFAULT_RUNTIME_TEXT: RuntimeTextDefaults = {
  fontSize: 31,
  fontWeight: 400,
  italic: false,
  letterSpacing: 0,
  lineHeight: 20,
};

/** M2's text adapter keeps the public string API in UTF-16 while all durable
 * Core ranges remain Unicode-scalar-aligned UTF-8 byte offsets. */
export function updateRuntimeText(
  before: string,
  next: string,
  properties: DocumentTextProperties | undefined,
  defaults: RuntimeTextDefaults = DEFAULT_RUNTIME_TEXT,
): Readonly<{ characters: string; textProperties: DocumentTextProperties }> {
  const characters = unicodeScalarText(next);
  return { characters, textProperties: rebaseTextStyleRuns(before, characters, normalizedTextProperties(before, properties, defaults)) };
}

export function patchRuntimeTextRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  patch: RuntimeTextStylePatch,
  defaults: RuntimeTextDefaults = DEFAULT_RUNTIME_TEXT,
): DocumentTextProperties {
  const range = runtimeTextRange(text, startUtf16, endUtf16);
  const normalized = normalizedTextProperties(text, properties, defaults);
  if (text.length === 0 && range.start === 0 && range.end === 0) {
    return {
      ...normalized,
      baseStyle: { ...defaultTextStyle(defaults), ...structuredClone(normalized.baseStyle ?? {}), ...structuredClone(patch) },
    };
  }
  return patchTextStyleRuns(text, normalized, range.start, range.end, patch);
}

export function replaceRuntimeTextRange(text: string, startUtf16: number, endUtf16: number, replacement: string): string {
  runtimeTextRange(text, startUtf16, endUtf16);
  return unicodeScalarText(`${text.slice(0, startUtf16)}${replacement}${text.slice(endUtf16)}`);
}

export function replaceRuntimeTextRangeWithStyles(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  replacement: string,
  options: Readonly<{
    defaults?: RuntimeTextDefaults;
    insertionStyle?: RuntimeTextInsertionStyle;
  }> = {},
): Readonly<{ characters: string; textProperties: DocumentTextProperties }> {
  const range = runtimeTextRange(text, startUtf16, endUtf16);
  const inserted = unicodeScalarText(replacement);
  const characters = `${text.slice(0, startUtf16)}${inserted}${text.slice(endUtf16)}`;
  const afterEnd = range.start + new TextEncoder().encode(inserted).byteLength;
  return {
    characters,
    textProperties: rebaseTextStyleRunsAtByteRange(
      text,
      characters,
      normalizedTextProperties(text, properties, options.defaults ?? DEFAULT_RUNTIME_TEXT),
      range.start,
      range.end,
      afterEnd,
      options.insertionStyle,
    ),
  };
}

export function fontsForRuntimeTextRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16 = 0,
  endUtf16 = text.length,
  insertionStyle: RuntimeTextInsertionStyle = "BEFORE",
): readonly DocumentFontReference[] {
  const styles = runtimeTextStylesForRange(text, properties, startUtf16, endUtf16, insertionStyle);
  const fonts = styles
    .filter((run) => run.font)
    .flatMap((run) => run.font ? [run.font] : []);
  return uniqueFonts(fonts);
}

/** Returns the effective Canonical styles intersecting a Figma UTF-16 range.
 * An empty text node exposes its persistent insertion style; an unstyled node
 * returns no entries so callers can apply the Runtime default font. */
export function runtimeTextStylesForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16 = 0,
  endUtf16 = text.length,
  insertionStyle: RuntimeTextInsertionStyle = "BEFORE",
): readonly DocumentTextStyle[] {
  const range = runtimeTextRange(text, startUtf16, endUtf16);
  if (!properties) return [];
  const runs = range.start === range.end
    ? insertionRunsAtOffset(properties.runs, range.start, insertionStyle)
    : properties.runs.filter((run) => run.start < range.end && run.end > range.start);
  if (runs.length) return runs;
  return text.length === 0 && properties.baseStyle ? [properties.baseStyle] : [];
}

export function runtimeTextRange(text: string, startUtf16: number, endUtf16: number): Readonly<{ start: number; end: number }> {
  if (!Number.isInteger(startUtf16) || !Number.isInteger(endUtf16) || startUtf16 < 0 || endUtf16 < startUtf16 || endUtf16 > text.length) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  if (!isUtf16ScalarBoundary(text, startUtf16) || !isUtf16ScalarBoundary(text, endUtf16)) throw runtimeError("INVALID_ARGUMENT");
  return { start: utf8OffsetAtUtf16Index(text, startUtf16), end: utf8OffsetAtUtf16Index(text, endUtf16) };
}

export function runtimeParagraphIndentationsForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
): readonly number[] {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const selected = runtimeParagraphStartsForRange(text, startUtf16, endUtf16);
  const runs = paragraphRunMap(normalized);
  return selected.map((start) => {
    const fallback = paragraphListTypeAt(normalized, start) ? 1 : 0;
    return runs.get(start)?.indentation ?? fallback;
  });
}

export function runtimeParagraphListTypesForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
): readonly DocumentTextProperties["paragraph"]["listType"][] {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  return runtimeParagraphStartsForRange(text, startUtf16, endUtf16)
    .map((start) => paragraphListTypeAt(normalized, start));
}

export function runtimeParagraphListSpacingsForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
): readonly number[] {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const runs = paragraphRunMap(normalized);
  const fallback = normalized.paragraph.listSpacing ?? 0;
  return runtimeParagraphStartsForRange(text, startUtf16, endUtf16)
    .map((start) => runs.get(start)?.listSpacing ?? fallback);
}

export function runtimeParagraphSpacingsForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
): readonly number[] {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const runs = paragraphRunMap(normalized);
  return runtimeParagraphStartsForRange(text, startUtf16, endUtf16)
    .map((start) => runs.get(start)?.paragraphSpacing ?? normalized.paragraph.paragraphSpacing);
}

export function runtimeParagraphIndentsForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
): readonly number[] {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const runs = paragraphRunMap(normalized);
  const fallback = normalized.paragraph.paragraphIndent ?? 0;
  return runtimeParagraphStartsForRange(text, startUtf16, endUtf16)
    .map((start) => runs.get(start)?.paragraphIndent ?? fallback);
}

export function runtimeParagraphLineHeightsForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
): readonly RuntimeParagraphLineHeight[] {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const runs = paragraphRunMap(normalized);
  return runtimeParagraphStartsForRange(text, startUtf16, endUtf16)
    .map((start) => {
      const run = runs.get(start);
      const overrides = run?.lineHeight !== undefined || run?.lineHeightUnit !== undefined;
      return runtimeLineHeightFromFields(
        overrides ? run?.lineHeight : normalized.paragraph.lineHeight,
        overrides ? run?.lineHeightUnit : normalized.paragraph.lineHeightUnit,
        DEFAULT_RUNTIME_TEXT.lineHeight,
      );
    });
}

export function runtimeParagraphTextWrapStylesForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
): readonly ("auto" | "balance" | "pretty")[] {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const runs = paragraphRunMap(normalized);
  const fallback = normalized.paragraph.textWrapStyle ?? "auto";
  return runtimeParagraphStartsForRange(text, startUtf16, endUtf16)
    .map((start) => runs.get(start)?.textWrapStyle ?? fallback);
}

export function patchRuntimeParagraphTextWrapStyle(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  textWrapStyle: "auto" | "balance" | "pretty",
): DocumentTextProperties {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const allStarts = runtimeParagraphStartsForRange(text, 0, text.length);
  const selected = new Set(runtimeParagraphStartsForRange(text, startUtf16, endUtf16));
  const writesWholeText = selected.size === allStarts.length && allStarts.every((start) => selected.has(start));
  const paragraph = writesWholeText
    ? { ...normalized.paragraph, textWrapStyle: textWrapStyle === "auto" ? undefined : textWrapStyle }
    : normalized.paragraph;
  const inherited = normalized.paragraph.textWrapStyle ?? "auto";
  const overrides = paragraphRunMap(normalized);
  for (const start of allStarts) {
    const run = { ...(overrides.get(start) ?? { start }) };
    if (selected.has(start)) {
      if (writesWholeText || textWrapStyle === inherited) delete run.textWrapStyle;
      else run.textWrapStyle = textWrapStyle;
    }
    if (emptyParagraphRun(run)) overrides.delete(start);
    else overrides.set(start, run);
  }
  const paragraphStyleRuns = [...overrides.values()].sort((left, right) => left.start - right.start);
  return {
    ...normalized,
    paragraph,
    ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }),
  };
}

export function patchRuntimeParagraphLineHeight(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  lineHeight: RuntimeParagraphLineHeight,
): DocumentTextProperties {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const allStarts = runtimeParagraphStartsForRange(text, 0, text.length);
  const selected = new Set(runtimeParagraphStartsForRange(text, startUtf16, endUtf16));
  const writesWholeText = selected.size === allStarts.length && allStarts.every((start) => selected.has(start));
  const fields = documentLineHeightFields(lineHeight);
  const paragraph = writesWholeText
    ? { ...normalized.paragraph, lineHeight: fields.lineHeight, lineHeightUnit: fields.lineHeightUnit }
    : normalized.paragraph;
  const inherited = runtimeLineHeightFromFields(
    normalized.paragraph.lineHeight,
    normalized.paragraph.lineHeightUnit,
    DEFAULT_RUNTIME_TEXT.lineHeight,
  );
  const overrides = paragraphRunMap(normalized);
  for (const start of allStarts) {
    const run = { ...(overrides.get(start) ?? { start }) };
    if (selected.has(start)) {
      if (writesWholeText || sameRuntimeLineHeight(lineHeight, inherited)) {
        delete run.lineHeight;
        delete run.lineHeightUnit;
      } else {
        run.lineHeight = fields.lineHeight;
        run.lineHeightUnit = fields.lineHeightUnit;
      }
    }
    if (emptyParagraphRun(run)) overrides.delete(start);
    else overrides.set(start, run);
  }
  const paragraphStyleRuns = [...overrides.values()].sort((left, right) => left.start - right.start);
  return {
    ...normalized,
    paragraph,
    ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }),
  };
}

export function sameRuntimeLineHeight(left: RuntimeParagraphLineHeight, right: RuntimeParagraphLineHeight): boolean {
  return left.unit === right.unit && (left.unit === "AUTO" || (right.unit !== "AUTO" && left.value === right.value));
}

function runtimeLineHeightFromFields(
  value: number | undefined,
  unit: "percent" | "auto" | undefined,
  fallback: number,
): RuntimeParagraphLineHeight {
  if (unit === "auto") return { unit: "AUTO" };
  if (unit === "percent") return { value: value ?? 100, unit: "PERCENT" };
  return { value: value ?? fallback, unit: "PIXELS" };
}

function documentLineHeightFields(value: RuntimeParagraphLineHeight): Pick<DocumentTextProperties["paragraph"], "lineHeight" | "lineHeightUnit"> {
  if (value.unit === "AUTO") return { lineHeight: undefined, lineHeightUnit: "auto" };
  return { lineHeight: value.value, lineHeightUnit: value.unit === "PERCENT" ? "percent" : undefined };
}

export function patchRuntimeParagraphIndentation(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  indentation: number,
): DocumentTextProperties {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const selected = new Set(runtimeParagraphStartsForRange(text, startUtf16, endUtf16));
  const overrides = paragraphRunMap(normalized);
  for (const start of selected) {
    const run = { ...(overrides.get(start) ?? { start }) };
    const fallback = paragraphListTypeAt(normalized, start) ? 1 : 0;
    if (indentation === fallback) delete run.indentation;
    else run.indentation = indentation;
    if (emptyParagraphRun(run)) overrides.delete(start);
    else overrides.set(start, run);
  }
  const paragraphStyleRuns = [...overrides.values()].sort((left, right) => left.start - right.start);
  return { ...normalized, ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }) };
}

export function patchRuntimeParagraphListType(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  listType: DocumentTextProperties["paragraph"]["listType"],
): DocumentTextProperties {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const allStarts = runtimeParagraphStartsForRange(text, 0, text.length);
  const selected = new Set(runtimeParagraphStartsForRange(text, startUtf16, endUtf16));
  const writesWholeText = selected.size === allStarts.length && allStarts.every((start) => selected.has(start));
  const paragraph = writesWholeText ? { ...normalized.paragraph, listType } : normalized.paragraph;
  const overrides = paragraphRunMap(normalized);
  for (const start of allStarts) {
    const run = { ...(overrides.get(start) ?? { start }) };
    if (selected.has(start)) {
      if (writesWholeText || listType === normalized.paragraph.listType) delete run.listType;
      else run.listType = listType ?? "none";
    }
    const effectiveListType = writesWholeText
      ? listType
      : selected.has(start)
        ? listType
        : paragraphListTypeAt(normalized, start);
    if (run.indentation === (effectiveListType ? 1 : 0)) delete run.indentation;
    if (emptyParagraphRun(run)) overrides.delete(start);
    else overrides.set(start, run);
  }
  const paragraphStyleRuns = [...overrides.values()].sort((left, right) => left.start - right.start);
  return {
    ...normalized,
    paragraph,
    ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }),
  };
}

export function patchRuntimeParagraphListSpacing(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  listSpacing: number,
): DocumentTextProperties {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const allStarts = runtimeParagraphStartsForRange(text, 0, text.length);
  const selected = new Set(runtimeParagraphStartsForRange(text, startUtf16, endUtf16));
  const writesWholeText = selected.size === allStarts.length && allStarts.every((start) => selected.has(start));
  const paragraph = writesWholeText
    ? { ...normalized.paragraph, listSpacing: listSpacing === 0 ? undefined : listSpacing }
    : normalized.paragraph;
  const inherited = normalized.paragraph.listSpacing ?? 0;
  const overrides = paragraphRunMap(normalized);
  for (const start of allStarts) {
    const run = { ...(overrides.get(start) ?? { start }) };
    if (selected.has(start)) {
      if (writesWholeText || listSpacing === inherited) delete run.listSpacing;
      else run.listSpacing = listSpacing;
    }
    if (emptyParagraphRun(run)) overrides.delete(start);
    else overrides.set(start, run);
  }
  const paragraphStyleRuns = [...overrides.values()].sort((left, right) => left.start - right.start);
  return {
    ...normalized,
    paragraph,
    ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }),
  };
}

export function patchRuntimeParagraphSpacing(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  paragraphSpacing: number,
): DocumentTextProperties {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const allStarts = runtimeParagraphStartsForRange(text, 0, text.length);
  const selected = new Set(runtimeParagraphStartsForRange(text, startUtf16, endUtf16));
  const writesWholeText = selected.size === allStarts.length && allStarts.every((start) => selected.has(start));
  const paragraph = writesWholeText
    ? { ...normalized.paragraph, paragraphSpacing }
    : normalized.paragraph;
  const inherited = normalized.paragraph.paragraphSpacing;
  const overrides = paragraphRunMap(normalized);
  for (const start of allStarts) {
    const run = { ...(overrides.get(start) ?? { start }) };
    if (selected.has(start)) {
      if (writesWholeText || paragraphSpacing === inherited) delete run.paragraphSpacing;
      else run.paragraphSpacing = paragraphSpacing;
    }
    if (emptyParagraphRun(run)) overrides.delete(start);
    else overrides.set(start, run);
  }
  const paragraphStyleRuns = [...overrides.values()].sort((left, right) => left.start - right.start);
  return {
    ...normalized,
    paragraph,
    ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }),
  };
}

export function patchRuntimeParagraphIndent(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  paragraphIndent: number,
): DocumentTextProperties {
  const normalized = normalizedTextProperties(text, properties, DEFAULT_RUNTIME_TEXT);
  const allStarts = runtimeParagraphStartsForRange(text, 0, text.length);
  const selected = new Set(runtimeParagraphStartsForRange(text, startUtf16, endUtf16));
  const writesWholeText = selected.size === allStarts.length && allStarts.every((start) => selected.has(start));
  const paragraph = writesWholeText
    ? { ...normalized.paragraph, paragraphIndent: paragraphIndent === 0 ? undefined : paragraphIndent }
    : normalized.paragraph;
  const inherited = normalized.paragraph.paragraphIndent ?? 0;
  const overrides = paragraphRunMap(normalized);
  for (const start of allStarts) {
    const run = { ...(overrides.get(start) ?? { start }) };
    if (selected.has(start)) {
      if (writesWholeText || paragraphIndent === inherited) delete run.paragraphIndent;
      else run.paragraphIndent = paragraphIndent;
    }
    if (emptyParagraphRun(run)) overrides.delete(start);
    else overrides.set(start, run);
  }
  const paragraphStyleRuns = [...overrides.values()].sort((left, right) => left.start - right.start);
  return {
    ...normalized,
    paragraph,
    ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }),
  };
}

function paragraphRunMap(properties: DocumentTextProperties) {
  return new Map((properties.paragraphStyleRuns ?? []).map((run) => [run.start, { ...run }] as const));
}

function emptyParagraphRun(run: NonNullable<DocumentTextProperties["paragraphStyleRuns"]>[number]): boolean {
  return run.indentation === undefined
    && run.listType === undefined
    && run.listSpacing === undefined
    && run.paragraphSpacing === undefined
    && run.paragraphIndent === undefined
    && run.lineHeight === undefined
    && run.lineHeightUnit === undefined
    && run.textWrapStyle === undefined;
}

function paragraphListTypeAt(
  properties: DocumentTextProperties,
  paragraphStart: number,
): DocumentTextProperties["paragraph"]["listType"] {
  const runs = properties.paragraphStyleRuns;
  let low = 0;
  let high = (runs?.length ?? 0) - 1;
  let override: "none" | "ordered" | "unordered" | undefined;
  while (runs && low <= high) {
    const middle = (low + high) >>> 1;
    const run = runs[middle]!;
    if (run.start === paragraphStart) {
      override = run.listType;
      break;
    }
    if (run.start < paragraphStart) low = middle + 1;
    else high = middle - 1;
  }
  if (override === "none") return undefined;
  return override ?? properties.paragraph.listType;
}

function runtimeParagraphStartsForRange(text: string, startUtf16: number, endUtf16: number): number[] {
  const range = runtimeTextRange(text, startUtf16, endUtf16);
  const encodedLength = new TextEncoder().encode(text).byteLength;
  const starts = [0];
  for (const separator of text.matchAll(/\r\n|[\n\r\u2028\u2029]/gu)) {
    const end = (separator.index ?? 0) + separator[0].length;
    starts.push(new TextEncoder().encode(text.slice(0, end)).byteLength);
  }
  if (range.start === range.end) {
    return [[...starts].reverse().find((start) => start <= range.start) ?? 0];
  }
  return starts.filter((start, index) => {
    const paragraphEnd = starts[index + 1] ?? encodedLength;
    return (start < range.end && paragraphEnd > range.start)
      || (start === encodedLength && range.end === encodedLength);
  });
}

function isUtf16ScalarBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function insertionRunsAtOffset(
  runs: DocumentTextProperties["runs"],
  offset: number,
  useStyle: RuntimeTextInsertionStyle,
): DocumentTextProperties["runs"] {
  const preceding = [...runs].reverse().find((run) => run.start < offset && offset <= run.end);
  const following = runs.find((run) => run.start <= offset && offset < run.end);
  const inherited = useStyle === "AFTER" ? following ?? preceding : preceding ?? following;
  return inherited ? [inherited] : runs.length ? [runs[0]!] : [];
}

function normalizedTextProperties(text: string, properties: DocumentTextProperties | undefined, defaults: RuntimeTextDefaults): DocumentTextProperties {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (properties?.runs.length) return structuredClone(properties);
  return {
    ...structuredClone(properties ?? {}),
    runs: byteLength ? [{ start: 0, end: byteLength, fontSize: defaults.fontSize, fontWeight: defaults.fontWeight, italic: defaults.italic, letterSpacing: defaults.letterSpacing }] : [],
    paragraph: properties?.paragraph ?? { alignment: "left", lineHeight: defaults.lineHeight, paragraphSpacing: 0 },
    autoSize: properties?.autoSize ?? "fixed",
    ...(properties?.fallbackFonts ? { fallbackFonts: structuredClone(properties.fallbackFonts) } : {}),
  };
}

function defaultTextStyle(defaults: RuntimeTextDefaults): NonNullable<DocumentTextProperties["baseStyle"]> {
  return {
    fontSize: defaults.fontSize,
    fontWeight: defaults.fontWeight,
    italic: defaults.italic,
    letterSpacing: defaults.letterSpacing,
  };
}

function uniqueFonts(fonts: readonly DocumentFontReference[]): readonly DocumentFontReference[] {
  const seen = new Set<string>();
  return fonts.filter((font) => {
    const key = JSON.stringify(font);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
