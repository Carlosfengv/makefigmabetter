import type { DocumentTextProperties } from "./editor-protocol";
import { styledTextSpans } from "./text-style-runs";
import { utf8OffsetAtUtf16Index } from "./rust-text-caret";

const styleKeys = ["fontSize", "fontWeight", "italic", "letterSpacing", "color", "font"] as const;

/** Describes an Inspector selection without guessing at a representative run. */
export function textSelectionStyleSummary(text: string, properties: DocumentTextProperties, startUtf16: number, endUtf16: number) {
  const start = utf8OffsetAtUtf16Index(text, Math.min(startUtf16, endUtf16));
  const end = utf8OffsetAtUtf16Index(text, Math.max(startUtf16, endUtf16));
  const styles = styledTextSpans(text, start, end, properties).map((span) => span.style);
  const first = styles[0];
  const mixed = styles.length > 1 && styles.slice(1).some((style) => styleKeys.some((key) => JSON.stringify(style[key] ?? null) !== JSON.stringify(first?.[key] ?? null)));
  return { characterCount: Math.abs(endUtf16 - startUtf16), mixed };
}
