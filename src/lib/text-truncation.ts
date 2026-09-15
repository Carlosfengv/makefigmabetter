import type { DocumentTextProperties } from "./editor-protocol";
import { textParagraphStartAtOffset } from "./text-layout";

export type TextDisplayLine<T extends { start: number; end: number; text: string }> = T & {
  lineTop: number;
  lineHeight: number;
  truncateEnding: boolean;
};

/** Resolves the persisted truncation contract against already-frozen line
 * ranges. Canvas and SVG call this after their shared line breaker so the
 * property never creates a second wrapping model. */
export function textDisplayLines<T extends { start: number; end: number; text: string }>(
  source: string,
  lines: readonly T[],
  properties: DocumentTextProperties | undefined,
  height: number,
  lineHeight: number | ((paragraphStart: number) => number),
  paragraphSpacing: number | ((previousParagraphStart: number, nextParagraphStart: number) => number),
): TextDisplayLine<T>[] {
  const ending = properties?.textTruncation === "ending";
  const maxLines = ending ? properties?.maxLines ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
  const sourceBytes = new TextEncoder().encode(source);
  const decoder = new TextDecoder();
  const visible: TextDisplayLine<T>[] = [];
  let lineTop = 0;
  let previousEnd = 0;
  let previousParagraphStart = 0;
  for (const line of lines) {
    const skipped = decoder.decode(sourceBytes.slice(previousEnd, line.start));
    if (/\r\n|[\n\r\u2028\u2029]/u.test(skipped)) {
      const nextParagraphStart = textParagraphStartAtOffset(source, line.start);
      lineTop += typeof paragraphSpacing === "function"
        ? paragraphSpacing(previousParagraphStart, nextParagraphStart)
        : paragraphSpacing;
      previousParagraphStart = nextParagraphStart;
    }
    if (visible.length >= maxLines || (ending && lineTop >= height)) break;
    const effectiveLineHeight = typeof lineHeight === "function"
      ? lineHeight(previousParagraphStart)
      : lineHeight;
    visible.push({ ...line, lineTop, lineHeight: effectiveLineHeight, truncateEnding: false });
    lineTop += effectiveLineHeight;
    previousEnd = line.end;
  }
  if (ending && visible.length && visible.length < lines.length) {
    visible[visible.length - 1] = { ...visible[visible.length - 1]!, truncateEnding: true };
  }
  return visible;
}

/** Fits one logical line plus a single ellipsis. retainedUtf8Bytes lets the
 * renderer reuse the original Canonical style runs and style the ellipsis from
 * the last retained run without mutating source text. */
export function endingEllipsis(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
  measureCandidate?: (retainedText: string, retainedUtf8Bytes: number) => number,
): { text: string; retainedUtf8Bytes: number } {
  const ellipsis = "…";
  const candidateWidth = (retained: string) => {
    const retainedUtf8Bytes = new TextEncoder().encode(retained).byteLength;
    return measureCandidate?.(retained, retainedUtf8Bytes) ?? measure(`${retained}${ellipsis}`);
  };
  if (candidateWidth("") > maxWidth) return { text: "", retainedUtf8Bytes: 0 };
  const scalars = Array.from(text.replace(/\s+$/u, ""));
  let low = 0;
  let high = scalars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (candidateWidth(scalars.slice(0, middle).join("")) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  const retained = scalars.slice(0, low).join("");
  return {
    text: `${retained}${ellipsis}`,
    retainedUtf8Bytes: new TextEncoder().encode(retained).byteLength,
  };
}
