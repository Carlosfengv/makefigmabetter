import type { DocumentTextProperties } from "./editor-protocol";

export type RenderTextStyle = {
  font?: DocumentTextProperties["runs"][number]["font"];
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  letterSpacing: number;
  color?: DocumentTextProperties["runs"][number]["color"];
};

export type StyledTextSpan = { text: string; start: number; end: number; style: RenderTextStyle };
export type TextVisualRun = { start: number; end: number; direction: "ltr" | "rtl" };
/** A style span split at the UAX #9 run boundary and ordered left-to-right for painting. */
export type VisualStyledTextSpan = StyledTextSpan & { direction: TextVisualRun["direction"] };

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
        color: run.color,
      } : defaultStyle,
    };
  }).filter((span) => span.text.length > 0);
}

/**
 * Intersects Canonical style runs with already-validated UAX #9 visual runs.
 * Canvas paints independently positioned chunks from physical left to right,
 * so RTL runs reverse their logical style pieces while retaining each piece's
 * source range and shaping direction. This lets complex-script lines keep
 * colour, weight and font changes instead of drawing the entire line using
 * its first style.
 */
export function styledTextVisualSpans(text: string, start: number, end: number, properties: DocumentTextProperties | undefined, visualRuns: readonly TextVisualRun[]): VisualStyledTextSpan[] {
  const bytes = new TextEncoder().encode(text);
  const logical = styledTextSpans(text, start, end, properties);
  const visual: VisualStyledTextSpan[] = [];
  for (const run of visualRuns) {
    const runStart = Math.max(start, run.start);
    const runEnd = Math.min(end, run.end);
    if (runStart >= runEnd) continue;
    const pieces = logical.flatMap((span) => {
      const pieceStart = Math.max(runStart, span.start);
      const pieceEnd = Math.min(runEnd, span.end);
      if (pieceStart >= pieceEnd) return [];
      const piece = new TextDecoder().decode(bytes.slice(pieceStart, pieceEnd));
      return piece ? [{ text: piece, start: pieceStart, end: pieceEnd, style: span.style, direction: run.direction }] : [];
    });
    if (run.direction === "rtl") pieces.reverse();
    visual.push(...pieces);
  }
  return visual;
}
