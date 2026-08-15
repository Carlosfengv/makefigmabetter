import type { DocumentTextProperties } from "./editor-protocol";

type TextRun = DocumentTextProperties["runs"][number];
export type TextRunStylePatch = Partial<Omit<TextRun, "start" | "end">>;

/**
 * JavaScript strings can contain isolated UTF-16 surrogates, while Canonical
 * text offsets are defined over Unicode scalar values encoded as UTF-8. Replace
 * malformed code units at every browser-input boundary so UTF-8 byte offsets,
 * clipboard runs and the Core always describe the same text.
 */
export function unicodeScalarText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else result += "\ufffd";
    } else if (unit >= 0xdc00 && unit <= 0xdfff) result += "\ufffd";
    else result += value[index];
  }
  return result;
}

/**
 * Rebases canonical UTF-8 style runs after one text replacement.  The caller
 * supplies complete before/after strings rather than DOM offsets so every
 * editor surface (textarea, contenteditable and future clipboard paste) gets
 * the same deterministic result.  Untouched ranges retain their styles;
 * inserted bytes inherit the run at the replacement start, falling back to the
 * preceding run at a run boundary.
 */
export function rebaseTextStyleRuns(
  before: string,
  after: string,
  properties: DocumentTextProperties,
): DocumentTextProperties {
  const afterBytes = new TextEncoder().encode(after);
  if (!properties.runs.length || !hasCompleteValidRunCoverage(before, properties.runs)) return { ...properties, runs: [] };

  const { beforeStart, beforeEnd, afterEnd } = replacementByteRange(before, after);
  if (beforeStart === beforeEnd && beforeStart === afterEnd) return properties;
  const inherited = inheritedRun(properties.runs, beforeStart);
  const delta = afterEnd - beforeEnd;
  const rebased: TextRun[] = [];
  for (const run of properties.runs) {
    if (run.start < beforeStart) rebased.push({ ...run, end: Math.min(run.end, beforeStart) });
  }
  if (afterEnd > beforeStart && inherited) rebased.push({ ...inherited, start: beforeStart, end: afterEnd });
  for (const run of properties.runs) {
    if (run.end > beforeEnd) rebased.push({ ...run, start: Math.max(run.start, beforeEnd) + delta, end: run.end + delta });
  }
  const runs = mergeAdjacentRuns(rebased.filter((run) => run.start < run.end));
  // The only valid empty run set describes unstyled source. Rebased content
  // with styled input must remain fully covered for Core validation.
  return hasCompleteValidRunCoverage(after, runs) || afterBytes.length === 0
    ? { ...properties, runs }
    : { ...properties, runs: [] };
}

export function replacementByteRange(before: string, after: string): Readonly<{ beforeStart: number; beforeEnd: number; afterEnd: number }> {
  const oldScalars = [...before];
  const newScalars = [...after];
  let prefix = 0;
  while (prefix < oldScalars.length && prefix < newScalars.length && oldScalars[prefix] === newScalars[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldScalars.length - prefix
    && suffix < newScalars.length - prefix
    && oldScalars[oldScalars.length - 1 - suffix] === newScalars[newScalars.length - 1 - suffix]
  ) suffix += 1;
  const byteLength = (scalars: readonly string[]) => new TextEncoder().encode(scalars.join("")).byteLength;
  const beforeStart = byteLength(oldScalars.slice(0, prefix));
  const beforeEnd = new TextEncoder().encode(before).byteLength - byteLength(oldScalars.slice(oldScalars.length - suffix));
  const afterEnd = new TextEncoder().encode(after).byteLength - byteLength(newScalars.slice(newScalars.length - suffix));
  return { beforeStart, beforeEnd, afterEnd };
}

/** Applies a style change to a UTF-8 byte range without altering adjacent
 * canonical runs. Callers must pass scalar-aligned offsets (the DOM editor
 * obtains them through `utf8OffsetAtUtf16Index`). */
export function patchTextStyleRuns(
  text: string,
  properties: DocumentTextProperties,
  start: number,
  end: number,
  patch: TextRunStylePatch,
): DocumentTextProperties {
  if (!hasCompleteValidRunCoverage(text, properties.runs)) return properties;
  const byteLength = new TextEncoder().encode(text).byteLength;
  const from = Math.max(0, Math.min(byteLength, Math.floor(Math.min(start, end))));
  const to = Math.max(from, Math.min(byteLength, Math.floor(Math.max(start, end))));
  if (from === to) return properties;
  const runs: TextRun[] = [];
  for (const run of properties.runs) {
    if (run.start < from) runs.push({ ...run, end: Math.min(run.end, from) });
    const overlapStart = Math.max(run.start, from);
    const overlapEnd = Math.min(run.end, to);
    if (overlapStart < overlapEnd) runs.push({ ...run, ...patch, start: overlapStart, end: overlapEnd });
    if (run.end > to) runs.push({ ...run, start: Math.max(run.start, to) });
  }
  return { ...properties, runs: mergeAdjacentRuns(runs.filter((run) => run.start < run.end)) };
}

function inheritedRun(runs: readonly TextRun[], offset: number): TextRun | undefined {
  const containing = runs.find((run) => run.start <= offset && offset < run.end);
  if (containing) return containing;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index].end === offset) return runs[index];
  }
  return runs[0];
}

function hasCompleteValidRunCoverage(text: string, runs: readonly TextRun[]) {
  const bytes = new TextEncoder().encode(text);
  const boundaries = new Set<number>();
  let byteOffset = 0;
  boundaries.add(byteOffset);
  for (const scalar of text) {
    byteOffset += new TextEncoder().encode(scalar).byteLength;
    boundaries.add(byteOffset);
  }
  let expectedStart = 0;
  return runs.every((run) => {
    const valid = run.start === expectedStart && run.start < run.end && run.end <= bytes.byteLength && boundaries.has(run.start) && boundaries.has(run.end);
    expectedStart = run.end;
    return valid;
  }) && expectedStart === bytes.byteLength;
}

function mergeAdjacentRuns(runs: readonly TextRun[]) {
  const merged: TextRun[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (previous && previous.end === run.start && sameStyle(previous, run)) previous.end = run.end;
    else merged.push({ ...run });
  }
  return merged;
}

function sameStyle(left: TextRun, right: TextRun) {
  return left.fontSize === right.fontSize
    && left.fontWeight === right.fontWeight
    && left.italic === right.italic
    && left.letterSpacing === right.letterSpacing
    && JSON.stringify(left.font) === JSON.stringify(right.font)
    && JSON.stringify(left.color) === JSON.stringify(right.color);
}
