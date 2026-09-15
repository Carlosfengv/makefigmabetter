import type { DocumentTextProperties, DocumentTextStyle } from "../lib/editor-protocol";
import { runtimeTextCase, type RuntimeTextCase } from "../lib/text-case";
import { DEFAULT_RUNTIME_FONT_NAME, runtimeFontNameForReference, type RuntimeFontName } from "./runtime-font-name";
import {
  runtimeFillsFromDocumentTextColor,
  runtimePaintsFromDocumentStack,
  runtimeTextDecorationColorFromDocument,
  type RuntimePaint,
  type RuntimeTextDecorationColor,
} from "./runtime-paint";
import { runtimeTextRange, updateRuntimeText, type RuntimeTextDefaults } from "./runtime-text";
import { runtimeError } from "./runtime-errors";

export type RuntimeStyledTextSegmentField =
  | "fontSize"
  | "fontName"
  | "fontWeight"
  | "fontStyle"
  | "textDecoration"
  | "textDecorationStyle"
  | "textDecorationOffset"
  | "textDecorationThickness"
  | "textDecorationColor"
  | "textDecorationSkipInk"
  | "textCase"
  | "lineHeight"
  | "letterSpacing"
  | "fills"
  | "textStyleId"
  | "fillStyleId"
  | "listOptions"
  | "listSpacing"
  | "indentation"
  | "paragraphIndent"
  | "paragraphSpacing"
  | "textWrapStyle"
  | "hyperlink"
  | "openTypeFeatures"
  | "boundVariables"
  | "textStyleOverrides";

export type RuntimeStyledTextSegmentValues = Readonly<{
  fontSize: number;
  fontName: RuntimeFontName;
  fontWeight: number;
  fontStyle: "REGULAR" | "ITALIC";
  textDecoration: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  textDecorationStyle: "SOLID" | "WAVY" | "DOTTED" | null;
  textDecorationOffset: Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }> | Readonly<{ unit: "AUTO" }> | null;
  textDecorationThickness: Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }> | Readonly<{ unit: "AUTO" }> | null;
  textDecorationColor: RuntimeTextDecorationColor | null;
  textDecorationSkipInk: boolean | null;
  textCase: RuntimeTextCase;
  lineHeight: Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }> | Readonly<{ unit: "AUTO" }>;
  letterSpacing: Readonly<{ value: number; unit: "PIXELS" }>;
  fills: readonly RuntimePaint[];
  textStyleId: string;
  fillStyleId: string;
  listOptions: Readonly<{ type: "ORDERED" | "UNORDERED" | "NONE" }>;
  listSpacing: number;
  indentation: number;
  paragraphIndent: number;
  paragraphSpacing: number;
  textWrapStyle: "AUTO" | "BALANCE" | "PRETTY";
  hyperlink: Readonly<{ type: "URL" | "NODE"; value: string }> | null;
  openTypeFeatures: Readonly<Record<string, boolean>>;
  boundVariables: undefined;
  textStyleOverrides: readonly never[];
}>;

export type RuntimeStyledTextSegment<Fields extends readonly RuntimeStyledTextSegmentField[]> =
  Readonly<{ characters: string; start: number; end: number }>
  & Pick<RuntimeStyledTextSegmentValues, Fields[number]>;

const ALL_FIELDS = new Set<RuntimeStyledTextSegmentField>([
  "fontSize", "fontName", "fontWeight", "fontStyle", "textDecoration", "textDecorationStyle",
  "textDecorationOffset", "textDecorationThickness", "textDecorationColor", "textDecorationSkipInk",
  "textCase", "lineHeight", "letterSpacing", "fills", "textStyleId", "fillStyleId", "listOptions",
  "listSpacing", "indentation", "paragraphIndent", "paragraphSpacing", "textWrapStyle", "hyperlink",
  "openTypeFeatures", "boundVariables", "textStyleOverrides",
]);

type ParagraphRun = NonNullable<DocumentTextProperties["paragraphStyleRuns"]>[number];

/**
 * Produces Figma-compatible styled segments from Canonical's character runs and
 * sparse paragraph runs. Candidate boundaries and UTF offset conversion are
 * both linear; adjacent candidates are merged when all requested values match.
 */
export function runtimeStyledTextSegments<Fields extends readonly RuntimeStyledTextSegmentField[]>(
  text: string,
  properties: DocumentTextProperties | undefined,
  fields: Fields,
  fallbackFills: readonly RuntimePaint[],
  defaults: RuntimeTextDefaults,
  startUtf16?: number,
  endUtf16?: number,
  fontNameForReference: (font: NonNullable<DocumentTextStyle["font"]>) => RuntimeFontName = runtimeFontNameForReference,
): Array<RuntimeStyledTextSegment<Fields>> {
  if (!Array.isArray(fields) || fields.some((field) => !ALL_FIELDS.has(field))) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  if ((startUtf16 === undefined) !== (endUtf16 === undefined)) throw runtimeError("INVALID_ARGUMENT");
  const start = startUtf16 ?? 0;
  const end = endUtf16 ?? text.length;
  const range = runtimeTextRange(text, start, end);
  if (range.start === range.end) return [];

  const normalized = updateRuntimeText(text, text, properties, defaults).textProperties;
  const paragraphStarts = paragraphByteStarts(text);
  const boundaries = new Set<number>([range.start, range.end]);
  for (const run of normalized.runs) {
    if (run.start > range.start && run.start < range.end) boundaries.add(run.start);
    if (run.end > range.start && run.end < range.end) boundaries.add(run.end);
  }
  for (const paragraphStart of paragraphStarts) {
    if (paragraphStart > range.start && paragraphStart < range.end) boundaries.add(paragraphStart);
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const utf16ByByte = utf16IndexesAtByteOffsets(text, ordered);
  const paragraphRuns = new Map((normalized.paragraphStyleRuns ?? []).map((run) => [run.start, run] as const));
  const segments: Array<Record<string, unknown>> = [];
  let styleIndex = 0;
  let paragraphIndex = 0;

  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const byteStart = ordered[index]!;
    const byteEnd = ordered[index + 1]!;
    while (normalized.runs[styleIndex] && normalized.runs[styleIndex]!.end <= byteStart) styleIndex += 1;
    while (paragraphStarts[paragraphIndex + 1] !== undefined && paragraphStarts[paragraphIndex + 1]! <= byteStart) paragraphIndex += 1;
    const style = normalized.runs[styleIndex] ?? normalized.baseStyle ?? defaultStyle(defaults);
    const paragraphStart = paragraphStarts[paragraphIndex] ?? 0;
    const paragraphRun = paragraphRuns.get(paragraphStart);
    const utf16Start = utf16ByByte.get(byteStart)!;
    const utf16End = utf16ByByte.get(byteEnd)!;
    const candidate: Record<string, unknown> = {
      characters: text.slice(utf16Start, utf16End),
      start: utf16Start,
      end: utf16End,
    };
    for (const field of fields) {
      candidate[field] = segmentFieldValue(field, style, normalized, paragraphRun, fallbackFills, fontNameForReference);
    }
    const previous = segments[segments.length - 1];
    if (previous && fields.every((field) => equalValue(previous[field], candidate[field]))) {
      previous.characters = `${previous.characters as string}${candidate.characters as string}`;
      previous.end = utf16End;
    } else {
      segments.push(candidate);
    }
  }
  return segments as Array<RuntimeStyledTextSegment<Fields>>;
}

function segmentFieldValue(
  field: RuntimeStyledTextSegmentField,
  style: DocumentTextStyle,
  properties: DocumentTextProperties,
  paragraphRun: ParagraphRun | undefined,
  fallbackFills: readonly RuntimePaint[],
  fontNameForReference: (font: NonNullable<DocumentTextStyle["font"]>) => RuntimeFontName,
): unknown {
  const listType = paragraphRun?.listType === "none"
    ? undefined
    : paragraphRun?.listType ?? properties.paragraph.listType;
  switch (field) {
    case "fontSize": return style.fontSize;
    case "fontName": return style.font ? fontNameForReference(style.font) : DEFAULT_RUNTIME_FONT_NAME;
    case "fontWeight": return style.fontWeight;
    case "fontStyle": return style.italic ? "ITALIC" : "REGULAR";
    case "textDecoration": return style.textDecoration === "underline" ? "UNDERLINE" : style.textDecoration === "strikethrough" ? "STRIKETHROUGH" : "NONE";
    case "textDecorationStyle": return style.textDecoration !== "underline" ? null : style.textDecorationStyle === "wavy" ? "WAVY" : style.textDecorationStyle === "dotted" ? "DOTTED" : "SOLID";
    case "textDecorationOffset": return style.textDecoration !== "underline" ? null : style.textDecorationOffset ? { value: style.textDecorationOffset.value, unit: style.textDecorationOffset.unit === "pixels" ? "PIXELS" : "PERCENT" } : { unit: "AUTO" };
    case "textDecorationThickness": return style.textDecoration !== "underline" ? null : style.textDecorationThickness ? { value: style.textDecorationThickness.value, unit: style.textDecorationThickness.unit === "pixels" ? "PIXELS" : "PERCENT" } : { unit: "AUTO" };
    case "textDecorationColor": return style.textDecoration !== "underline" ? null : runtimeDecorationColor(style);
    case "textDecorationSkipInk": return style.textDecoration !== "underline" ? null : style.textDecorationSkipInk === true;
    case "textCase": return runtimeTextCase(style.textCase);
    case "lineHeight": return lineHeight(properties, paragraphRun);
    case "letterSpacing": return { value: style.letterSpacing, unit: "PIXELS" };
    case "fills": return style.fillStack !== undefined
      ? runtimePaintsFromDocumentStack(style.fillStack)
      : style.color ? runtimeFillsFromDocumentTextColor(style.color) : structuredClone(fallbackFills);
    case "textStyleId": return style.textStyleId ?? "";
    case "fillStyleId": return "";
    case "listOptions": return { type: listType === "ordered" ? "ORDERED" : listType === "unordered" ? "UNORDERED" : "NONE" };
    case "listSpacing": return paragraphRun?.listSpacing ?? properties.paragraph.listSpacing ?? 0;
    case "indentation": return paragraphRun?.indentation ?? (listType ? 1 : 0);
    case "paragraphIndent": return paragraphRun?.paragraphIndent ?? properties.paragraph.paragraphIndent ?? 0;
    case "paragraphSpacing": return paragraphRun?.paragraphSpacing ?? properties.paragraph.paragraphSpacing;
    case "textWrapStyle": return wrapStyle(paragraphRun?.textWrapStyle ?? properties.paragraph.textWrapStyle ?? "auto");
    case "hyperlink": return style.hyperlink ? structuredClone(style.hyperlink) : null;
    case "openTypeFeatures": return { ...(style.openTypeFeatures ?? {}) };
    case "boundVariables": return undefined;
    case "textStyleOverrides": return [];
  }
}

function lineHeight(properties: DocumentTextProperties, paragraphRun: ParagraphRun | undefined): RuntimeStyledTextSegmentValues["lineHeight"] {
  const overridden = paragraphRun?.lineHeight !== undefined || paragraphRun?.lineHeightUnit !== undefined;
  const unit = overridden ? paragraphRun?.lineHeightUnit : properties.paragraph.lineHeightUnit;
  const value = overridden ? paragraphRun?.lineHeight : properties.paragraph.lineHeight;
  if (unit === "auto") return { unit: "AUTO" };
  if (unit === "percent") return { value: value ?? 100, unit: "PERCENT" };
  return { value: value ?? 20, unit: "PIXELS" };
}

function runtimeDecorationColor(style: DocumentTextStyle): RuntimeTextDecorationColor {
  return runtimeTextDecorationColorFromDocument(style.textDecorationColor);
}

function wrapStyle(value: "auto" | "balance" | "pretty"): RuntimeStyledTextSegmentValues["textWrapStyle"] {
  return value === "balance" ? "BALANCE" : value === "pretty" ? "PRETTY" : "AUTO";
}

function defaultStyle(defaults: RuntimeTextDefaults): DocumentTextStyle {
  return { fontSize: defaults.fontSize, fontWeight: defaults.fontWeight, italic: defaults.italic, letterSpacing: defaults.letterSpacing };
}

function paragraphByteStarts(text: string): number[] {
  const starts = [0];
  const encoder = new TextEncoder();
  let byteOffset = 0;
  for (let index = 0; index < text.length;) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      byteOffset += 2;
      index += 2;
      starts.push(byteOffset);
      continue;
    }
    const character = String.fromCodePoint(text.codePointAt(index)!);
    byteOffset += encoder.encode(character).byteLength;
    index += character.length;
    if (character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029") starts.push(byteOffset);
  }
  return starts;
}

function utf16IndexesAtByteOffsets(text: string, offsets: readonly number[]): Map<number, number> {
  const result = new Map<number, number>();
  const wanted = new Set(offsets);
  const encoder = new TextEncoder();
  let byteOffset = 0;
  let utf16Index = 0;
  if (wanted.has(0)) result.set(0, 0);
  for (const character of text) {
    byteOffset += encoder.encode(character).byteLength;
    utf16Index += character.length;
    if (wanted.has(byteOffset)) result.set(byteOffset, utf16Index);
  }
  return result;
}

function equalValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
