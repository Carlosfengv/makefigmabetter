import type { DocumentFontReference, DocumentTextProperties } from "../lib/editor-protocol";
import { utf8OffsetAtUtf16Index } from "../lib/rust-text-caret";
import { patchTextStyleRuns, rebaseTextStyleRuns, unicodeScalarText, type TextRunStylePatch } from "../lib/text-style-run-edit";
import { runtimeError } from "./runtime-errors";

export type RuntimeTextStylePatch = TextRunStylePatch;

/** M2's text adapter keeps the public string API in UTF-16 while all durable
 * Core ranges remain Unicode-scalar-aligned UTF-8 byte offsets. */
export function updateRuntimeText(
  before: string,
  next: string,
  properties: DocumentTextProperties | undefined,
): Readonly<{ characters: string; textProperties: DocumentTextProperties }> {
  const characters = unicodeScalarText(next);
  return { characters, textProperties: rebaseTextStyleRuns(before, characters, normalizedTextProperties(before, properties)) };
}

export function patchRuntimeTextRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16: number,
  endUtf16: number,
  patch: RuntimeTextStylePatch,
): DocumentTextProperties {
  const range = runtimeTextRange(text, startUtf16, endUtf16);
  return patchTextStyleRuns(text, normalizedTextProperties(text, properties), range.start, range.end, patch);
}

export function replaceRuntimeTextRange(text: string, startUtf16: number, endUtf16: number, replacement: string): string {
  runtimeTextRange(text, startUtf16, endUtf16);
  return unicodeScalarText(`${text.slice(0, startUtf16)}${replacement}${text.slice(endUtf16)}`);
}

export function fontsForRuntimeTextRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  startUtf16 = 0,
  endUtf16 = text.length,
): readonly DocumentFontReference[] {
  if (!properties) return [];
  const range = runtimeTextRange(text, startUtf16, endUtf16);
  const fonts = properties.runs
    .filter((run) => run.font && run.start < range.end && run.end > range.start)
    .flatMap((run) => run.font ? [run.font] : []);
  return uniqueFonts(fonts);
}

export function runtimeTextRange(text: string, startUtf16: number, endUtf16: number): Readonly<{ start: number; end: number }> {
  if (!Number.isInteger(startUtf16) || !Number.isInteger(endUtf16) || startUtf16 < 0 || endUtf16 < startUtf16 || endUtf16 > text.length) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  return { start: utf8OffsetAtUtf16Index(text, startUtf16), end: utf8OffsetAtUtf16Index(text, endUtf16) };
}

function normalizedTextProperties(text: string, properties: DocumentTextProperties | undefined): DocumentTextProperties {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (properties?.runs.length) return structuredClone(properties);
  return {
    runs: byteLength ? [{ start: 0, end: byteLength, fontSize: 31, fontWeight: 400, italic: false, letterSpacing: 0 }] : [],
    paragraph: { alignment: "left", lineHeight: 20, paragraphSpacing: 0 },
    autoSize: "fixed",
    ...(properties?.fallbackFonts ? { fallbackFonts: structuredClone(properties.fallbackFonts) } : {}),
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
