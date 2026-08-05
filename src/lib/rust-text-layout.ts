export type RustTextLayoutLine = {
  start: number;
  end: number;
  direction: "ltr" | "rtl";
  advance: number;
  visualRuns: RustTextVisualRun[];
  glyphs: RustTextGlyph[];
};

/** UAX #9 level runs, already ordered for display while retaining source bytes. */
export type RustTextVisualRun = {
  start: number;
  end: number;
  direction: "ltr" | "rtl";
};

export type RustTextGlyph = {
  glyphId: number;
  cluster: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
};

export type RustTextLayout = {
  unitsPerEm: number;
  lines: RustTextLayoutLine[];
};

/** Validates the derived ICU4X/Rustybuzz layout before presentation consumes it.
 * Any malformed worker/WASM value returns undefined so Canvas can retain its
 * explicit browser fallback without allowing an invalid byte range to rewrite text. */
export function parseRustTextLayout(value: string, source: string): RustTextLayout | undefined {
  try {
    const sourceByteLength = new TextEncoder().encode(source).byteLength;
    const boundaries = utf8ScalarBoundaries(source);
    const payload = JSON.parse(value) as { unitsPerEm?: unknown; lines?: unknown };
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
      const visualRuns = parseVisualRuns(line.visualRuns, line.start, line.end, line.direction, boundaries);
      if (!visualRuns) return undefined;
      const glyphs: RustTextGlyph[] = [];
      for (const item of line.glyphs) {
        if (!item || typeof item !== "object") return undefined;
        const glyph = item as Record<string, unknown>;
        if (!isGlyphInteger(glyph.glyphId) || !isByteOffset(glyph.cluster) || glyph.cluster < line.start || glyph.cluster > line.end || !isFiniteGlyphMetric(glyph.xAdvance) || !isFiniteGlyphMetric(glyph.yAdvance) || !isFiniteGlyphMetric(glyph.xOffset) || !isFiniteGlyphMetric(glyph.yOffset)) return undefined;
        glyphs.push({ glyphId: glyph.glyphId, cluster: glyph.cluster, xAdvance: glyph.xAdvance, yAdvance: glyph.yAdvance, xOffset: glyph.xOffset, yOffset: glyph.yOffset });
      }
      lines.push({ start: line.start, end: line.end, direction: line.direction, advance: line.advance, visualRuns, glyphs });
      previousEnd = line.end;
    }
    return { unitsPerEm: payload.unitsPerEm, lines };
  } catch {
    return undefined;
  }
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
