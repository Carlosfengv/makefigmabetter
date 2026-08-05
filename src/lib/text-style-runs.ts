import type { DocumentTextProperties } from "./editor-protocol";

export type RenderTextStyle = {
  font?: DocumentTextProperties["runs"][number]["font"];
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  letterSpacing: number;
};

export type StyledTextSpan = { text: string; start: number; end: number; style: RenderTextStyle };

const defaultStyle: RenderTextStyle = {
  fontSize: 31,
  fontWeight: 500,
  italic: false,
  letterSpacing: 0,
};

/** Projects Canonical UTF-8 Style Runs onto one already-wrapped text range.
 * Invalid or incomplete presentation input never changes the source text: gaps
 * simply use the stable system fallback style. */
export function styledTextSpans(text: string, start: number, end: number, properties: DocumentTextProperties | undefined): StyledTextSpan[] {
  const bytes = new TextEncoder().encode(text);
  const safeStart = Math.max(0, Math.min(bytes.byteLength, start));
  const safeEnd = Math.max(safeStart, Math.min(bytes.byteLength, end));
  if (safeStart === safeEnd) return [];
  const runs = properties?.runs ?? [];
  const boundaries = new Set<number>([safeStart, safeEnd]);
  for (const run of runs) {
    if (run.end <= safeStart || run.start >= safeEnd) continue;
    boundaries.add(Math.max(safeStart, run.start));
    boundaries.add(Math.min(safeEnd, run.end));
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  return ordered.slice(0, -1).map((spanStart, index) => {
    const spanEnd = ordered[index + 1];
    const run = runs.find((candidate) => candidate.start <= spanStart && candidate.end >= spanEnd);
    return {
      text: new TextDecoder().decode(bytes.slice(spanStart, spanEnd)),
      start: spanStart,
      end: spanEnd,
      style: run ? {
        font: run.font,
        fontSize: run.fontSize,
        fontWeight: run.fontWeight,
        italic: run.italic,
        letterSpacing: run.letterSpacing,
      } : defaultStyle,
    };
  }).filter((span) => span.text.length > 0);
}
