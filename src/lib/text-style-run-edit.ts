import type { DocumentTextProperties } from "./editor-protocol";

type TextRun = DocumentTextProperties["runs"][number];
type TextStyle = NonNullable<DocumentTextProperties["baseStyle"]>;
export type TextRunStylePatch = Partial<Omit<TextRun, "start" | "end">>;
export type TextInsertionStyle = "BEFORE" | "AFTER";

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
  const { beforeStart, beforeEnd, afterEnd } = replacementByteRange(before, after);
  return rebaseTextStyleRunsAtByteRange(before, after, properties, beforeStart, beforeEnd, afterEnd);
}

/** Rebases style runs from an explicit editor replacement range. Repeated
 * source text can make the same before/after pair compatible with several
 * insertion points, so Runtime range APIs must not infer this position. */
export function rebaseTextStyleRunsAtByteRange(
  before: string,
  after: string,
  properties: DocumentTextProperties,
  beforeStart: number,
  beforeEnd: number,
  afterEnd: number,
  insertionStyle?: TextInsertionStyle,
): DocumentTextProperties {
  const afterBytes = new TextEncoder().encode(after);
  const paragraphStyleRuns = rebaseParagraphStyleRunsAtByteRange(
    before,
    after,
    properties,
    beforeStart,
    beforeEnd,
    afterEnd,
  );
  if (!properties.runs.length) {
    if (before.length === 0 && afterBytes.length > 0 && properties.baseStyle) {
      return {
        ...properties,
        runs: [{ ...structuredClone(properties.baseStyle), start: 0, end: afterBytes.length }],
        ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }),
      };
    }
    return { ...properties, runs: [], ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }) };
  }
  if (!hasCompleteValidRunCoverage(before, properties.runs)) return { ...properties, runs: [] };
  if (beforeStart === beforeEnd && beforeStart === afterEnd) return properties;
  const inherited = beforeStart === beforeEnd && afterEnd > beforeStart && insertionStyle
    ? insertionRun(properties.runs, beforeStart, insertionStyle)
    : replacementRun(properties.runs, beforeStart);
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
  const baseStyle = afterBytes.length === 0 && inherited
    ? textStyleFromRun(inherited)
    : properties.baseStyle;
  // The only valid empty run set describes unstyled source. Rebased content
  // with styled input must remain fully covered for Core validation.
  return hasCompleteValidRunCoverage(after, runs) || afterBytes.length === 0
    ? { ...properties, runs, ...(baseStyle ? { baseStyle } : {}), ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }) }
    : { ...properties, runs: [], ...(paragraphStyleRuns.length ? { paragraphStyleRuns } : { paragraphStyleRuns: undefined }) };
}

function rebaseParagraphStyleRunsAtByteRange(
  before: string,
  after: string,
  properties: DocumentTextProperties,
  beforeStart: number,
  beforeEnd: number,
  afterEnd: number,
) {
  if (!properties.paragraphStyleRuns?.length) return [];
  const delta = afterEnd - beforeEnd;
  return paragraphStartByteOffsets(after).flatMap((start) => {
    const oldOffset = start < beforeStart
      ? start
      : start >= afterEnd
        ? Math.max(beforeStart, start - delta)
        : beforeStart;
    const listType = paragraphListTypeAtByteOffset(before, properties, oldOffset);
    const indentation = paragraphIndentationAtByteOffset(before, properties, oldOffset);
    const listSpacing = paragraphListSpacingAtByteOffset(before, properties, oldOffset);
    const inheritedListSpacing = properties.paragraph.listSpacing ?? 0;
    const paragraphSpacing = paragraphSpacingAtByteOffset(before, properties, oldOffset);
    const paragraphIndent = paragraphIndentAtByteOffset(before, properties, oldOffset);
    const inheritedParagraphIndent = properties.paragraph.paragraphIndent ?? 0;
    const lineHeight = paragraphLineHeightAtByteOffset(before, properties, oldOffset);
    const inheritedLineHeight = {
      lineHeight: properties.paragraph.lineHeight,
      lineHeightUnit: properties.paragraph.lineHeightUnit,
    };
    const textWrapStyle = paragraphTextWrapStyleAtByteOffset(before, properties, oldOffset);
    const inheritedTextWrapStyle = properties.paragraph.textWrapStyle ?? "auto";
    const run = {
      start,
      ...(listType !== properties.paragraph.listType ? { listType: listType ?? "none" as const } : {}),
      ...(indentation !== (listType ? 1 : 0) ? { indentation } : {}),
      ...(listSpacing !== inheritedListSpacing ? { listSpacing } : {}),
      ...(paragraphSpacing !== properties.paragraph.paragraphSpacing ? { paragraphSpacing } : {}),
      ...(paragraphIndent !== inheritedParagraphIndent ? { paragraphIndent } : {}),
      ...(!sameParagraphLineHeight(lineHeight, inheritedLineHeight) ? lineHeight : {}),
      ...(textWrapStyle !== inheritedTextWrapStyle ? { textWrapStyle } : {}),
    };
    return run.listType === undefined && run.indentation === undefined && run.listSpacing === undefined && run.paragraphSpacing === undefined && run.paragraphIndent === undefined && run.lineHeight === undefined && run.lineHeightUnit === undefined && run.textWrapStyle === undefined ? [] : [run];
  });
}

function paragraphTextWrapStyleAtByteOffset(text: string, properties: DocumentTextProperties, offset: number) {
  const starts = paragraphStartByteOffsets(text);
  let paragraphStart = 0;
  for (const start of starts) {
    if (start > offset) break;
    paragraphStart = start;
  }
  return properties.paragraphStyleRuns?.find((run) => run.start === paragraphStart)?.textWrapStyle
    ?? properties.paragraph.textWrapStyle
    ?? "auto";
}

function paragraphLineHeightAtByteOffset(text: string, properties: DocumentTextProperties, offset: number) {
  const starts = paragraphStartByteOffsets(text);
  let paragraphStart = 0;
  for (const start of starts) {
    if (start > offset) break;
    paragraphStart = start;
  }
  const run = properties.paragraphStyleRuns?.find((value) => value.start === paragraphStart);
  if (run?.lineHeight !== undefined || run?.lineHeightUnit !== undefined) {
    return { lineHeight: run.lineHeight, lineHeightUnit: run.lineHeightUnit };
  }
  return {
    lineHeight: properties.paragraph.lineHeight,
    lineHeightUnit: properties.paragraph.lineHeightUnit,
  };
}

function sameParagraphLineHeight(
  left: Readonly<{ lineHeight?: number; lineHeightUnit?: "percent" | "auto" }>,
  right: Readonly<{ lineHeight?: number; lineHeightUnit?: "percent" | "auto" }>,
): boolean {
  return left.lineHeight === right.lineHeight && left.lineHeightUnit === right.lineHeightUnit;
}

function paragraphIndentAtByteOffset(text: string, properties: DocumentTextProperties, offset: number) {
  const starts = paragraphStartByteOffsets(text);
  let paragraphStart = 0;
  for (const start of starts) {
    if (start > offset) break;
    paragraphStart = start;
  }
  return properties.paragraphStyleRuns?.find((run) => run.start === paragraphStart)?.paragraphIndent
    ?? properties.paragraph.paragraphIndent
    ?? 0;
}

function paragraphSpacingAtByteOffset(text: string, properties: DocumentTextProperties, offset: number) {
  const starts = paragraphStartByteOffsets(text);
  let paragraphStart = 0;
  for (const start of starts) {
    if (start > offset) break;
    paragraphStart = start;
  }
  return properties.paragraphStyleRuns?.find((run) => run.start === paragraphStart)?.paragraphSpacing
    ?? properties.paragraph.paragraphSpacing;
}

function paragraphListSpacingAtByteOffset(text: string, properties: DocumentTextProperties, offset: number) {
  const starts = paragraphStartByteOffsets(text);
  let paragraphStart = 0;
  for (const start of starts) {
    if (start > offset) break;
    paragraphStart = start;
  }
  return properties.paragraphStyleRuns?.find((run) => run.start === paragraphStart)?.listSpacing
    ?? properties.paragraph.listSpacing
    ?? 0;
}

function paragraphIndentationAtByteOffset(text: string, properties: DocumentTextProperties, offset: number) {
  const starts = paragraphStartByteOffsets(text);
  let paragraphStart = 0;
  for (const start of starts) {
    if (start > offset) break;
    paragraphStart = start;
  }
  return properties.paragraphStyleRuns?.find((run) => run.start === paragraphStart)?.indentation
    ?? (paragraphListTypeAtByteOffset(text, properties, offset) ? 1 : 0);
}

function paragraphListTypeAtByteOffset(text: string, properties: DocumentTextProperties, offset: number) {
  const starts = paragraphStartByteOffsets(text);
  let paragraphStart = 0;
  for (const start of starts) {
    if (start > offset) break;
    paragraphStart = start;
  }
  const override = properties.paragraphStyleRuns?.find((run) => run.start === paragraphStart)?.listType;
  return override === "none" ? undefined : override ?? properties.paragraph.listType;
}

function paragraphStartByteOffsets(text: string): number[] {
  const starts = [0];
  for (const separator of text.matchAll(/\r\n|[\n\r\u2028\u2029]/gu)) {
    const end = (separator.index ?? 0) + separator[0].length;
    starts.push(new TextEncoder().encode(text.slice(0, end)).byteLength);
  }
  return starts;
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

function replacementRun(runs: readonly TextRun[], offset: number): TextRun | undefined {
  const containing = runs.find((run) => run.start <= offset && offset < run.end);
  if (containing) return containing;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index].end === offset) return runs[index];
  }
  return runs[0];
}

/** Figma insertCharacters copies from the preceding character for BEFORE and
 * the following character for AFTER. At either string edge it falls back to
 * the closest existing character. */
function insertionRun(runs: readonly TextRun[], offset: number, useStyle: TextInsertionStyle): TextRun | undefined {
  const preceding = [...runs].reverse().find((run) => run.start < offset && offset <= run.end);
  const following = runs.find((run) => run.start <= offset && offset < run.end);
  return useStyle === "AFTER"
    ? following ?? preceding ?? runs[0]
    : preceding ?? following ?? runs[0];
}

function textStyleFromRun(run: TextRun): TextStyle {
  const style = structuredClone(run) as Partial<TextRun>;
  delete style.start;
  delete style.end;
  return style as TextStyle;
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
    && JSON.stringify(left.color) === JSON.stringify(right.color)
    && JSON.stringify(left.fillStack) === JSON.stringify(right.fillStack)
    && left.textCase === right.textCase
    && JSON.stringify(left.hyperlink) === JSON.stringify(right.hyperlink)
    && left.textDecoration === right.textDecoration
    && left.textDecorationStyle === right.textDecorationStyle
    && JSON.stringify(left.textDecorationOffset) === JSON.stringify(right.textDecorationOffset)
    && JSON.stringify(left.textDecorationThickness) === JSON.stringify(right.textDecorationThickness)
    && JSON.stringify(left.textDecorationColor) === JSON.stringify(right.textDecorationColor)
    && left.textDecorationSkipInk === right.textDecorationSkipInk
    && left.leadingTrim === right.leadingTrim;
}
