import type { DocumentTextProperties } from "./editor-protocol";
import { styledTextSpans } from "./text-style-runs";
import { utf8OffsetAtUtf16Index } from "./rust-text-caret";
import { rebaseTextStyleRuns, unicodeScalarText } from "./text-style-run-edit";

export const TEXT_CLIPBOARD_FORMAT = "makefigma-text-clipboard-v1" as const;
export const MAX_TEXT_CLIPBOARD_BYTES = 1_048_576;

export type TextClipboardPayload = Readonly<{ format: typeof TEXT_CLIPBOARD_FORMAT; schemaVersion: 1; text: string; runs: DocumentTextProperties["runs"] }>;

/** Captures only the selected scalars and rebases every retained Style Run to
 * byte zero. This makes rich paste independent of its source Text node. */
export function captureTextClipboard(text: string, properties: DocumentTextProperties, startUtf16: number, endUtf16: number): TextClipboardPayload | undefined {
  const start = utf8OffsetAtUtf16Index(text, Math.min(startUtf16, endUtf16));
  const end = utf8OffsetAtUtf16Index(text, Math.max(startUtf16, endUtf16));
  if (start === end) return undefined;
  const selected = new TextDecoder().decode(new TextEncoder().encode(text).slice(start, end));
  const runs = styledTextSpans(text, start, end, properties).map((span) => ({ ...span.style, start: span.start - start, end: span.end - start }));
  const payload: TextClipboardPayload = { format: TEXT_CLIPBOARD_FORMAT, schemaVersion: 1, text: selected, runs };
  return byteLength(JSON.stringify(payload)) <= MAX_TEXT_CLIPBOARD_BYTES && valid(payload) ? payload : undefined;
}

export function encodeTextClipboard(payload: TextClipboardPayload): string | undefined {
  return valid(payload) ? JSON.stringify(payload) : undefined;
}

/** Untrusted browser text is never parsed as HTML. Invalid/malformed rich
 * payloads return undefined so callers can safely fall back to text/plain. */
export function decodeTextClipboard(value: string): TextClipboardPayload | undefined {
  if (typeof value !== "string" || byteLength(value) > MAX_TEXT_CLIPBOARD_BYTES) return undefined;
  try { const payload = JSON.parse(value) as TextClipboardPayload; return valid(payload) ? payload : undefined; } catch { return undefined; }
}

/** Replaces a DOM selection with a trusted private payload. Existing runs are
 * first rebased by the same replacement algorithm used by typing, then the
 * temporary inherited insertion run is replaced by the payload's own styles. */
export function pasteTextClipboard(before: string, properties: DocumentTextProperties, startUtf16: number, endUtf16: number, payload: TextClipboardPayload) {
  if (!valid(payload)) return undefined;
  const start = utf8OffsetAtUtf16Index(before, Math.min(startUtf16, endUtf16));
  const after = `${before.slice(0, Math.min(startUtf16, endUtf16))}${payload.text}${before.slice(Math.max(startUtf16, endUtf16))}`;
  const rebased = rebaseTextStyleRuns(before, after, properties);
  if (!rebased.runs.length || !payload.runs.length) return { text: after, properties: rebased };
  const insertedEnd = start + new TextEncoder().encode(payload.text).byteLength;
  const runs = [
    ...rebased.runs.flatMap((run) => run.start < start ? [{ ...run, end: Math.min(run.end, start) }] : []),
    ...payload.runs.map((run) => ({ ...run, start: run.start + start, end: run.end + start })),
    ...rebased.runs.flatMap((run) => run.end > insertedEnd ? [{ ...run, start: Math.max(run.start, insertedEnd) }] : []),
  ].filter((run) => run.start < run.end);
  return { text: after, properties: { ...rebased, runs } };
}

function valid(value: TextClipboardPayload): boolean {
  if (!value || value.format !== TEXT_CLIPBOARD_FORMAT || value.schemaVersion !== 1 || typeof value.text !== "string" || !Array.isArray(value.runs)) return false;
  if (unicodeScalarText(value.text) !== value.text) return false;
  const bytes = new TextEncoder().encode(value.text);
  let expected = 0;
  return value.runs.every((run) => Number.isSafeInteger(run.start) && Number.isSafeInteger(run.end) && run.start === expected && run.start < run.end && run.end <= bytes.byteLength && scalarBoundary(value.text, run.start) && scalarBoundary(value.text, run.end) && (expected = run.end, true)) && expected === bytes.byteLength;
}
function scalarBoundary(text: string, offset: number) { let cursor = 0; if (offset === 0) return true; for (const scalar of text) { cursor += new TextEncoder().encode(scalar).byteLength; if (cursor === offset) return true; if (cursor > offset) return false; } return offset === cursor; }
function byteLength(value: string) { return new TextEncoder().encode(value).byteLength; }
