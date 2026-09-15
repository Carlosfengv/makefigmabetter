import type { DocumentTextCase } from "./editor-protocol";

export type RuntimeTextCase = "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";

export type TextCaseSourceRange = Readonly<{
  start: number;
  end: number;
  textCase?: DocumentTextCase;
}>;

export type TextCaseBoundary = Readonly<{
  /** UTF-8 byte offset in the unchanged Canonical string. */
  source: number;
  /** UTF-8 byte offset in the presentation string sent to shaping. */
  display: number;
}>;

/** Ephemeral projection used only at the renderer/shaper boundary. */
export type TextCaseProjection = Readonly<{
  source: string;
  display: string;
  boundaries: readonly TextCaseBoundary[];
}>;

export function runtimeTextCase(value: DocumentTextCase | undefined): RuntimeTextCase {
  switch (value) {
    case "upper": return "UPPER";
    case "lower": return "LOWER";
    case "title": return "TITLE";
    case "smallCaps": return "SMALL_CAPS";
    case "smallCapsForced": return "SMALL_CAPS_FORCED";
    default: return "ORIGINAL";
  }
}

export function documentTextCase(value: RuntimeTextCase): DocumentTextCase | undefined {
  switch (value) {
    case "ORIGINAL": return undefined;
    case "UPPER": return "upper";
    case "LOWER": return "lower";
    case "TITLE": return "title";
    case "SMALL_CAPS": return "smallCaps";
    case "SMALL_CAPS_FORCED": return "smallCapsForced";
  }
}

export function isRuntimeTextCase(value: unknown): value is RuntimeTextCase {
  return value === "ORIGINAL" || value === "UPPER" || value === "LOWER" || value === "TITLE"
    || value === "SMALL_CAPS" || value === "SMALL_CAPS_FORCED";
}

/** Presentation-only Unicode transform. Canonical characters and range offsets
 * always remain untouched. CSS/Canvas small-caps supplies the glyph variant. */
export function applyDocumentTextCase(text: string, value: DocumentTextCase | undefined): string {
  switch (value) {
    case "upper": return text.toUpperCase();
    case "lower": return text.toLowerCase();
    case "title": return titleCase(text);
    case "smallCapsForced": return text.toLowerCase();
    default: return text;
  }
}

export function usesSmallCaps(value: DocumentTextCase | undefined): boolean {
  return value === "smallCaps" || value === "smallCapsForced";
}

/**
 * Builds a total, monotonic UTF-8 boundary map without modifying Canonical
 * characters or Style Run offsets. Each range is transformed independently,
 * matching the way Canvas/SVG presentation spans apply TextCase today.
 *
 * The map records every source Unicode-scalar boundary. One source scalar may
 * expand to several display scalars (`İ` -> `i` + combining dot), so display
 * offsets inside that expansion deliberately have no editable source boundary.
 * Small-cap transforms can use this map for Canvas/SVG slicing; Rust shaping
 * applies a separate admission check because it does not yet request the
 * OpenType smcp/c2sc features used by `font-variant-caps`.
 */
export function projectDocumentTextCaseRanges(
  source: string,
  ranges: readonly TextCaseSourceRange[],
): TextCaseProjection | undefined {
  const sourceBytes = encoder.encode(source);
  if (!ranges.length) return sourceBytes.byteLength === 0
    ? { source, display: "", boundaries: [{ source: 0, display: 0 }] }
    : undefined;

  const sourceBoundaries = utf8ScalarBoundaries(source);
  const boundaries: TextCaseBoundary[] = [{ source: 0, display: 0 }];
  const displayParts: string[] = [];
  let expectedSourceStart = 0;
  let displayOffset = 0;

  for (const range of ranges) {
    if (range.start !== expectedSourceStart || range.end <= range.start
      || range.end > sourceBytes.byteLength || !sourceBoundaries.has(range.start)
      || !sourceBoundaries.has(range.end)) return undefined;
    const part = decoder.decode(sourceBytes.slice(range.start, range.end));
    const display = applyDocumentTextCase(part, range.textCase);
    const sourceScalars = Array.from(part);
    const displayScalars = Array.from(display);
    const displayScalarCounts = mappedScalarCounts(sourceScalars, range.textCase);
    if (displayScalarCounts.some((count) => count < 1)
      || displayScalarCounts.reduce((total, count) => total + count, 0) !== displayScalars.length) return undefined;

    let sourceOffset = range.start;
    let displayScalarCursor = 0;
    for (let index = 0; index < sourceScalars.length; index += 1) {
      sourceOffset += encoder.encode(sourceScalars[index]).byteLength;
      const nextDisplayScalarCursor = displayScalarCursor + displayScalarCounts[index];
      displayOffset += encoder.encode(displayScalars.slice(displayScalarCursor, nextDisplayScalarCursor).join("")).byteLength;
      boundaries.push({ source: sourceOffset, display: displayOffset });
      displayScalarCursor = nextDisplayScalarCursor;
    }
    if (sourceOffset !== range.end || displayScalarCursor !== displayScalars.length) return undefined;
    displayParts.push(display);
    expectedSourceStart = range.end;
  }
  if (expectedSourceStart !== sourceBytes.byteLength) return undefined;
  const display = displayParts.join("");
  if (displayOffset !== encoder.encode(display).byteLength) return undefined;
  return { source, display, boundaries };
}

export function sourceBoundaryToDisplay(
  projection: TextCaseProjection,
  sourceOffset: number,
): number | undefined {
  return exactBoundary(projection.boundaries, sourceOffset, "source")?.display;
}

export function displayBoundaryToSource(
  projection: TextCaseProjection,
  displayOffset: number,
): number | undefined {
  return exactBoundary(projection.boundaries, displayOffset, "display")?.source;
}

/** Maps a shaped glyph cluster to the owning source scalar. Generated display
 * scalars inside an expansion share the source scalar's start offset. */
export function displayClusterToSource(
  projection: TextCaseProjection,
  displayOffset: number,
): number | undefined {
  if (!Number.isInteger(displayOffset) || displayOffset < 0
    || displayOffset > (projection.boundaries.at(-1)?.display ?? 0)) return undefined;
  let low = 0;
  let high = projection.boundaries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (projection.boundaries[middle].display <= displayOffset) low = middle + 1;
    else high = middle;
  }
  return projection.boundaries[Math.max(0, low - 1)]?.source;
}

function exactBoundary(
  boundaries: readonly TextCaseBoundary[],
  offset: number,
  key: keyof TextCaseBoundary,
): TextCaseBoundary | undefined {
  if (!Number.isInteger(offset) || offset < 0) return undefined;
  let low = 0;
  let high = boundaries.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = boundaries[middle][key];
    if (value === offset) return boundaries[middle];
    if (value < offset) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

function utf8ScalarBoundaries(value: string): Set<number> {
  const boundaries = new Set([0]);
  let offset = 0;
  for (const character of value) {
    offset += encoder.encode(character).byteLength;
    boundaries.add(offset);
  }
  return boundaries;
}

function mappedScalarCounts(
  sourceScalars: readonly string[],
  value: DocumentTextCase | undefined,
): number[] {
  if (value !== "title") {
    return sourceScalars.map((character) =>
      Array.from(applyDocumentTextCase(character, value)).length);
  }
  let startsWord = true;
  return sourceScalars.map((character) => {
    let display = character;
    if (/\p{L}|\p{N}/u.test(character)) {
      if (startsWord) display = character.toUpperCase();
      startsWord = false;
    } else if (!/\p{M}/u.test(character)) {
      startsWord = true;
    }
    return Array.from(display).length;
  });
}

function titleCase(text: string): string {
  let startsWord = true;
  return Array.from(text, (character) => {
    if (/\p{L}|\p{N}/u.test(character)) {
      const result = startsWord ? character.toUpperCase() : character;
      startsWord = false;
      return result;
    }
    if (/\p{M}/u.test(character)) return character;
    startsWord = true;
    return character;
  }).join("");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
