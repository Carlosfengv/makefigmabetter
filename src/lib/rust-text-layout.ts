import { displayBoundaryToSource, displayClusterToSource, type TextCaseProjection } from "./text-case";
import { segmentGraphemes } from "./text-layout";

export type RustTextLayoutLine = {
  start: number;
  end: number;
  direction: "ltr" | "rtl";
  advance: number;
  /** Physical boundary advances excluded from line fitting, in font units. */
  hangingLeftAdvance?: number;
  hangingRightAdvance?: number;
  visualRuns: RustTextVisualRun[];
  visualCarets?: RustTextVisualCaret[];
  glyphs: RustTextGlyph[];
};

export type RustTextVisualCaret = {
  byteOffset: number;
  /** Physical distance from the line origin in explicit-font units. */
  xAdvance: number;
};

/** UAX #9 level runs, already ordered for display while retaining source bytes. */
export type RustTextVisualRun = {
  start: number;
  end: number;
  direction: "ltr" | "rtl";
};

export type RustTextGlyph = {
  glyphId: number;
  /** Index of the metric Style Run that owns this transient glyph. */
  runIndex: number;
  cluster: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
};

export type RustTextLayout = {
  unitsPerEm: number;
  lines: RustTextLayoutLine[];
  carets?: Array<{ byteOffset: number; lineIndex: number }>;
};

/** A zero glyph ID means the explicitly selected font cannot draw at least one
 * source cluster. The browser may resolve that cluster through a fallback font,
 * whose advance is not safe to combine with a single-font Rust line range. */
export function hasMissingRustTextGlyph(layout: RustTextLayout): boolean {
  return layout.lines.some((line) => line.glyphs.some((glyph) => glyph.glyphId === 0));
}

/**
 * Converts a layout shaped from presentation TextCase back into Canonical
 * source coordinates. Structural boundaries (lines and bidi runs) must map
 * exactly. Glyph clusters inside a generated expansion map to the owning
 * source scalar, while generated internal caret stops are discarded.
 *
 * The final grapheme-set equality check prevents a case transform from
 * silently losing or inventing an editable source stop. Any unsafe projection
 * returns undefined and the renderer retains its Canvas fallback.
 */
export function remapRustTextLayoutToSource(
  layout: RustTextLayout,
  projection: TextCaseProjection,
): RustTextLayout | undefined {
  const lines: RustTextLayoutLine[] = [];
  for (const line of layout.lines) {
    const start = displayBoundaryToSource(projection, line.start);
    const end = displayBoundaryToSource(projection, line.end);
    if (start === undefined || end === undefined) return undefined;
    const visualRuns = line.visualRuns.map((run) => {
      const runStart = displayBoundaryToSource(projection, run.start);
      const runEnd = displayBoundaryToSource(projection, run.end);
      return runStart === undefined || runEnd === undefined
        ? undefined
        : { ...run, start: runStart, end: runEnd };
    });
    if (visualRuns.some((run) => !run)) return undefined;
    const visualCarets = line.visualCarets?.flatMap((caret) => {
      const byteOffset = displayBoundaryToSource(projection, caret.byteOffset);
      return byteOffset === undefined ? [] : [{ ...caret, byteOffset }];
    });
    const glyphs = line.glyphs.map((glyph) => {
      const cluster = displayClusterToSource(projection, glyph.cluster);
      return cluster === undefined ? undefined : { ...glyph, cluster };
    });
    if (glyphs.some((glyph) => !glyph)) return undefined;
    lines.push({
      ...line,
      start,
      end,
      visualRuns: visualRuns as RustTextVisualRun[],
      ...(visualCarets ? { visualCarets } : {}),
      glyphs: glyphs as RustTextGlyph[],
    });
  }
  const carets = layout.carets?.flatMap((caret) => {
    const byteOffset = displayBoundaryToSource(projection, caret.byteOffset);
    return byteOffset === undefined ? [] : [{ ...caret, byteOffset }];
  });
  const remapped = parseRustTextLayout(JSON.stringify({
    unitsPerEm: layout.unitsPerEm,
    lines,
    ...(carets ? { carets } : {}),
  }), projection.source);
  if (!remapped || !hasCompleteSourceGraphemeCarets(remapped, projection.source)) return undefined;
  return remapped;
}

function hasCompleteSourceGraphemeCarets(layout: RustTextLayout, source: string): boolean {
  if (!layout.carets) return true;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(source);
  const carets = layout.carets;
  return layout.lines.every((line, lineIndex) => {
    const text = new TextDecoder().decode(bytes.slice(line.start, line.end));
    let cursor = line.start;
    const expected = new Set<number>([cursor]);
    for (const grapheme of segmentGraphemes(text)) {
      cursor += encoder.encode(grapheme).byteLength;
      expected.add(cursor);
    }
    const actual = new Set(carets
      .filter((caret) => caret.lineIndex === lineIndex)
      .map((caret) => caret.byteOffset));
    return actual.size === expected.size && [...expected].every((offset) => actual.has(offset));
  });
}

/** Validates the derived ICU4X/Rustybuzz layout before presentation consumes it.
 * Any malformed worker/WASM value returns undefined so Canvas can retain its
 * explicit browser fallback without allowing an invalid byte range to rewrite text. */
export function parseRustTextLayout(value: string, source: string): RustTextLayout | undefined {
  try {
    const sourceByteLength = new TextEncoder().encode(source).byteLength;
    const boundaries = utf8ScalarBoundaries(source);
    const payload = JSON.parse(value) as { unitsPerEm?: unknown; lines?: unknown; carets?: unknown };
    if (typeof payload.unitsPerEm !== "number" || !Number.isInteger(payload.unitsPerEm) || payload.unitsPerEm <= 0) return undefined;
    if (!Array.isArray(payload.lines)) return undefined;
    let previousEnd = 0;
    const lines: RustTextLayoutLine[] = [];
    for (const item of payload.lines) {
      if (!item || typeof item !== "object") return undefined;
      const line = item as Record<string, unknown>;
      if (!isByteOffset(line.start) || !isByteOffset(line.end) || !boundaries.has(line.start) || !boundaries.has(line.end) || line.end < line.start || line.end > sourceByteLength) return undefined;
      if (line.start < previousEnd || (line.direction !== "ltr" && line.direction !== "rtl")) return undefined;
      if (typeof line.advance !== "number" || !Number.isFinite(line.advance) || line.advance < 0 || !Array.isArray(line.glyphs)) return undefined;
      const hasHangingLeft = line.hangingLeftAdvance !== undefined;
      const hasHangingRight = line.hangingRightAdvance !== undefined;
      if (hasHangingLeft !== hasHangingRight) return undefined;
      const hangingLeftAdvance = hasHangingLeft ? line.hangingLeftAdvance : 0;
      const hangingRightAdvance = hasHangingRight ? line.hangingRightAdvance : 0;
      if (typeof hangingLeftAdvance !== "number" || !Number.isFinite(hangingLeftAdvance) || hangingLeftAdvance < 0
        || typeof hangingRightAdvance !== "number" || !Number.isFinite(hangingRightAdvance) || hangingRightAdvance < 0
        || hangingLeftAdvance > line.advance || hangingRightAdvance > line.advance) return undefined;
      const visualRuns = parseVisualRuns(line.visualRuns, line.start, line.end, line.direction, boundaries);
      if (!visualRuns) return undefined;
      const visualCarets = parseVisualCarets(line.visualCarets, line.start, line.end, line.advance, boundaries);
      if (line.visualCarets !== undefined && !visualCarets) return undefined;
      const glyphs: RustTextGlyph[] = [];
      for (const item of line.glyphs) {
        if (!item || typeof item !== "object") return undefined;
        const glyph = item as Record<string, unknown>;
        const runIndex = glyph.runIndex === undefined ? 0 : glyph.runIndex;
        if (!isGlyphInteger(glyph.glyphId) || !isRunIndex(runIndex) || !isByteOffset(glyph.cluster) || glyph.cluster < line.start || glyph.cluster > line.end || !isFiniteGlyphMetric(glyph.xAdvance) || !isFiniteGlyphMetric(glyph.yAdvance) || !isFiniteGlyphMetric(glyph.xOffset) || !isFiniteGlyphMetric(glyph.yOffset)) return undefined;
        glyphs.push({ glyphId: glyph.glyphId, runIndex, cluster: glyph.cluster, xAdvance: glyph.xAdvance, yAdvance: glyph.yAdvance, xOffset: glyph.xOffset, yOffset: glyph.yOffset });
      }
      lines.push({
        start: line.start,
        end: line.end,
        direction: line.direction,
        advance: line.advance,
        ...(hasHangingLeft ? { hangingLeftAdvance, hangingRightAdvance } : {}),
        visualRuns,
        ...(visualCarets ? { visualCarets } : {}),
        glyphs,
      });
      previousEnd = line.end;
    }
    let carets: RustTextLayout["carets"];
    if (payload.carets !== undefined) {
      if (!Array.isArray(payload.carets) || !payload.carets.length) return undefined;
      carets = [];
      for (const item of payload.carets) {
        if (!item || typeof item !== "object") return undefined;
        const caret = item as Record<string, unknown>;
        if (!isByteOffset(caret.byteOffset) || !boundaries.has(caret.byteOffset)
          || !isByteOffset(caret.lineIndex) || !lines[caret.lineIndex]
          || caret.byteOffset < lines[caret.lineIndex].start
          || caret.byteOffset > lines[caret.lineIndex].end) return undefined;
        carets.push({ byteOffset: caret.byteOffset, lineIndex: caret.lineIndex });
      }
    }
    return { unitsPerEm: payload.unitsPerEm, lines, ...(carets ? { carets } : {}) };
  } catch {
    return undefined;
  }
}

function parseVisualCarets(value: unknown, lineStart: number, lineEnd: number, lineAdvance: number, boundaries: ReadonlySet<number>): RustTextVisualCaret[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) return undefined;
  const carets: RustTextVisualCaret[] = [];
  let previousX = -1;
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const caret = item as Record<string, unknown>;
    if (!isByteOffset(caret.byteOffset) || !boundaries.has(caret.byteOffset)
      || caret.byteOffset < lineStart || caret.byteOffset > lineEnd
      || typeof caret.xAdvance !== "number" || !Number.isInteger(caret.xAdvance)
      || caret.xAdvance < previousX || caret.xAdvance < 0 || caret.xAdvance > lineAdvance) return undefined;
    carets.push({ byteOffset: caret.byteOffset, xAdvance: caret.xAdvance });
    previousX = caret.xAdvance;
  }
  if (carets[0]?.xAdvance !== 0 || carets.at(-1)?.xAdvance !== lineAdvance) return undefined;
  return carets;
}

function parseVisualRuns(value: unknown, lineStart: number, lineEnd: number, lineDirection: "ltr" | "rtl", boundaries: ReadonlySet<number>): RustTextVisualRun[] | undefined {
  // Older generated WASM can still drive Canvas's line-level fallback while a
  // fresh bridge always sends validated UAX #9 runs.
  if (value === undefined) return [{ start: lineStart, end: lineEnd, direction: lineDirection }];
  if (!Array.isArray(value)) return undefined;
  const visualRuns: RustTextVisualRun[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const run = item as Record<string, unknown>;
    if (!isByteOffset(run.start) || !isByteOffset(run.end) || !boundaries.has(run.start) || !boundaries.has(run.end) || run.start < lineStart || run.end > lineEnd || run.end <= run.start || (run.direction !== "ltr" && run.direction !== "rtl")) return undefined;
    visualRuns.push({ start: run.start, end: run.end, direction: run.direction });
  }
  if (lineStart !== lineEnd && !visualRuns.length) return undefined;
  const logical = [...visualRuns].sort((left, right) => left.start - right.start);
  if (logical.some((run, index) => (index > 0 && run.start < logical[index - 1]!.end)) || logical.reduce((total, run) => total + run.end - run.start, 0) !== lineEnd - lineStart) return undefined;
  return visualRuns;
}

function isByteOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isGlyphInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 65_535;
}

function isRunIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 4_096;
}

function isFiniteGlyphMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function utf8ScalarBoundaries(value: string): Set<number> {
  const boundaries = new Set([0]);
  let offset = 0;
  for (const character of value) {
    offset += new TextEncoder().encode(character).byteLength;
    boundaries.add(offset);
  }
  return boundaries;
}
