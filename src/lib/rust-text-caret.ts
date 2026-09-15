/** A presentation-safe projection of the Rust text layout boundary. Offsets
 * are UTF-8 bytes so DOM selections can never split a grapheme by accident. */
export interface RustTextCaretLayout {
  /** Present when the caret map comes from explicit font bytes. */
  unitsPerEm?: number;
  carets: Array<{ byteOffset: number; lineIndex: number }>;
  lines?: Array<{
    start: number;
    end: number;
    direction: "ltr" | "rtl";
    /** Shaped line width in explicit-font units. */
    advance?: number;
    /** UAX #9 runs in physical left-to-right display order. A logical byte
     * boundary can occur more than once and each occurrence is a distinct
     * transient caret affinity. */
    visualRuns?: Array<{
      start: number;
      end: number;
      direction: "ltr" | "rtl";
    }>;
    /** Legal stops in physical left-to-right order. */
    visualCarets?: Array<{ byteOffset: number; xAdvance: number }>;
  }>;
}

export interface RustTextCaretPosition {
  utf16Index: number;
  /** Opaque index into the line's physical caret sequence. It is transient UI
   * state and must never enter Canonical text or a persisted selection. */
  visualIndex: number;
}

const encoder = new TextEncoder();

export function parseRustTextCaretLayout(value: unknown): RustTextCaretLayout | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as { carets?: unknown }).carets)) return undefined;
  const rawLines = (value as { lines?: unknown }).lines;
  let lines: RustTextCaretLayout["lines"];
  if (rawLines !== undefined) {
    if (!Array.isArray(rawLines)) return undefined;
    lines = rawLines.flatMap((line) => {
        if (!line || typeof line !== "object") return [];
        const { start, end, direction, advance, visualRuns: rawVisualRuns, visualCarets: rawVisualCarets } = line as {
          start?: unknown;
          end?: unknown;
          direction?: unknown;
          advance?: unknown;
          visualRuns?: unknown;
          visualCarets?: unknown;
        };
        if (
          !Number.isSafeInteger(start) || (start as number) < 0 ||
          !Number.isSafeInteger(end) || (end as number) < (start as number) ||
          (direction !== "ltr" && direction !== "rtl")
        ) return [];
        let visualRuns: NonNullable<NonNullable<RustTextCaretLayout["lines"]>[number]["visualRuns"]> | undefined;
        if (rawVisualRuns !== undefined) {
          if (!Array.isArray(rawVisualRuns)) return [];
          visualRuns = rawVisualRuns.flatMap((run) => {
            if (!run || typeof run !== "object") return [];
            const candidate = run as { start?: unknown; end?: unknown; direction?: unknown };
            return Number.isSafeInteger(candidate.start) && (candidate.start as number) >= (start as number)
              && Number.isSafeInteger(candidate.end) && (candidate.end as number) > (candidate.start as number)
              && (candidate.end as number) <= (end as number)
              && (candidate.direction === "ltr" || candidate.direction === "rtl")
              ? [{
                  start: candidate.start as number,
                  end: candidate.end as number,
                  direction: candidate.direction as "ltr" | "rtl",
                }]
              : [];
          });
          if (visualRuns.length !== rawVisualRuns.length) return [];
          const logical = [...visualRuns].sort((left, right) => left.start - right.start || left.end - right.end);
          if (
            (start as number) === (end as number)
              ? logical.length !== 0
              : !logical.length || logical[0]!.start !== start || logical.at(-1)!.end !== end
                || logical.some((run, index) => index > 0 && logical[index - 1]!.end !== run.start)
          ) return [];
        }
        let visualCarets: NonNullable<NonNullable<RustTextCaretLayout["lines"]>[number]["visualCarets"]> | undefined;
        if (rawVisualCarets !== undefined) {
          if (!Array.isArray(rawVisualCarets) || !rawVisualCarets.length
            || typeof advance !== "number" || !Number.isInteger(advance) || advance < 0) return [];
          let previousX = -1;
          visualCarets = rawVisualCarets.flatMap((caret) => {
            if (!caret || typeof caret !== "object") return [];
            const candidate = caret as { byteOffset?: unknown; xAdvance?: unknown };
            if (!Number.isSafeInteger(candidate.byteOffset)
              || (candidate.byteOffset as number) < (start as number)
              || (candidate.byteOffset as number) > (end as number)
              || typeof candidate.xAdvance !== "number"
              || !Number.isInteger(candidate.xAdvance)
              || candidate.xAdvance < previousX
              || candidate.xAdvance < 0
              || candidate.xAdvance > advance) return [];
            previousX = candidate.xAdvance;
            return [{ byteOffset: candidate.byteOffset as number, xAdvance: candidate.xAdvance }];
          });
          if (visualCarets.length !== rawVisualCarets.length
            || visualCarets[0]?.xAdvance !== 0
            || visualCarets.at(-1)?.xAdvance !== advance) return [];
        }
        return [{
          start: start as number,
          end: end as number,
          direction: direction as "ltr" | "rtl",
          ...(typeof advance === "number" && Number.isInteger(advance) && advance >= 0 ? { advance } : {}),
          ...(visualRuns ? { visualRuns } : {}),
          ...(visualCarets ? { visualCarets } : {}),
        }];
      });
    if (!lines.length || lines.length !== rawLines.length) return undefined;
  }
  const carets = (value as { carets: unknown[] }).carets.flatMap((caret) => {
    if (!caret || typeof caret !== "object") return [];
    const { byteOffset, lineIndex } = caret as { byteOffset?: unknown; lineIndex?: unknown };
    return Number.isSafeInteger(byteOffset) && (byteOffset as number) >= 0 && Number.isSafeInteger(lineIndex) && (lineIndex as number) >= 0
      ? [{ byteOffset: byteOffset as number, lineIndex: lineIndex as number }]
      : [];
  });
  if (!carets.length) return undefined;
  if (lines && carets.some((caret) => !lines[caret.lineIndex] || caret.byteOffset < lines[caret.lineIndex]!.start || caret.byteOffset > lines[caret.lineIndex]!.end)) return undefined;
  if (lines?.some((line, lineIndex) => line.visualCarets?.some(
    (visualCaret) => !carets.some(
      (caret) => caret.lineIndex === lineIndex && caret.byteOffset === visualCaret.byteOffset,
    ),
  ))) return undefined;
  const rawUnitsPerEm = (value as { unitsPerEm?: unknown }).unitsPerEm;
  const unitsPerEm = typeof rawUnitsPerEm === "number" && Number.isInteger(rawUnitsPerEm) && rawUnitsPerEm > 0
    ? rawUnitsPerEm
    : undefined;
  if (lines?.some((line) => line.visualCarets) && !unitsPerEm) return undefined;
  return { ...(unitsPerEm ? { unitsPerEm } : {}), carets, ...(lines ? { lines } : {}) };
}

export type RustTextCaretPointMetrics = {
  x: number;
  y: number;
  width: number;
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  alignment: "left" | "center" | "right" | "justify";
};

/** Maps a Canvas-local pointer to the nearest explicit-font caret coordinate.
 * Returns undefined for fallback layouts that contain legal offsets only. */
export function rustTextCaretPositionAtPoint(
  text: string,
  layout: RustTextCaretLayout,
  metrics: RustTextCaretPointMetrics,
): RustTextCaretPosition | undefined {
  if (!layout.unitsPerEm || !layout.lines?.length || !Number.isFinite(metrics.x)
    || !Number.isFinite(metrics.y) || !Number.isFinite(metrics.width)
    || !Number.isFinite(metrics.fontSize) || metrics.fontSize <= 0
    || !Number.isFinite(metrics.lineHeight) || metrics.lineHeight <= 0) return undefined;
  const bytes = encoder.encode(text);
  let lineTop = 0;
  let previousEnd = 0;
  let visualBase = 0;
  for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex += 1) {
    const line = layout.lines[lineIndex]!;
    const positioned = line.visualCarets;
    if (!positioned?.length || line.advance === undefined) return undefined;
    const skipped = new TextDecoder().decode(bytes.slice(previousEnd, line.start));
    if (/\r\n|[\n\r\u2028\u2029]/u.test(skipped)) lineTop += metrics.paragraphSpacing;
    const isLast = lineIndex === layout.lines.length - 1;
    if (metrics.y <= lineTop + metrics.lineHeight || isLast) {
      const scale = metrics.fontSize / layout.unitsPerEm;
      const lineWidth = line.advance * scale;
      const originX = metrics.alignment === "center"
        ? (metrics.width - lineWidth) / 2
        : metrics.alignment === "right" || line.direction === "rtl"
          ? metrics.width - lineWidth
          : 0;
      const targetAdvance = Math.max(0, Math.min(line.advance, (metrics.x - originX) / scale));
      let nearestIndex = 0;
      for (let index = 1; index < positioned.length; index += 1) {
        const nearestDistance = Math.abs(positioned[nearestIndex]!.xAdvance - targetAdvance);
        const candidateDistance = Math.abs(positioned[index]!.xAdvance - targetAdvance);
        if (candidateDistance < nearestDistance) nearestIndex = index;
      }
      return {
        utf16Index: utf16IndexAtUtf8Offset(text, positioned[nearestIndex]!.byteOffset),
        visualIndex: visualBase + nearestIndex,
      };
    }
    visualBase += positioned.length;
    lineTop += metrics.lineHeight;
    previousEnd = line.end;
  }
  return undefined;
}

export function utf8OffsetAtUtf16Index(text: string, targetIndex: number) {
  const bounded = Math.max(0, Math.min(text.length, Math.floor(targetIndex)));
  let utf16Index = 0;
  let utf8Offset = 0;
  for (const character of text) {
    if (utf16Index + character.length > bounded) break;
    utf16Index += character.length;
    utf8Offset += encoder.encode(character).byteLength;
  }
  return utf8Offset;
}

export function utf16IndexAtUtf8Offset(text: string, targetOffset: number) {
  const bounded = Math.max(0, Math.min(encoder.encode(text).byteLength, Math.floor(targetOffset)));
  let utf8Offset = 0;
  let utf16Index = 0;
  for (const character of text) {
    const bytes = encoder.encode(character).byteLength;
    if (utf8Offset + bytes > bounded) break;
    utf8Offset += bytes;
    utf16Index += character.length;
  }
  return utf16Index;
}

/** Matches the Core's stable nearest-caret rule: ties choose the earlier byte. */
export function snapUtf16CaretToRustLayout(text: string, targetIndex: number, layout: RustTextCaretLayout) {
  const targetOffset = utf8OffsetAtUtf16Index(text, targetIndex);
  const maxOffset = encoder.encode(text).byteLength;
  const candidate = layout.carets
    .map((caret) => caret.byteOffset)
    .filter((offset) => offset <= maxOffset)
    .sort((left, right) => Math.abs(left - targetOffset) - Math.abs(right - targetOffset) || left - right)[0];
  return candidate === undefined ? Math.max(0, Math.min(text.length, targetIndex)) : utf16IndexAtUtf8Offset(text, candidate);
}

/** Resolves a logical DOM offset to one physical caret occurrence. The visual
 * index disambiguates bidi run boundaries where the same byte offset is valid
 * at two different display positions. */
export function rustTextCaretPositionAtUtf16Index(
  text: string,
  targetIndex: number,
  layout: RustTextCaretLayout,
  preferredVisualIndex?: number,
): RustTextCaretPosition {
  const offsets = visualCaretOffsets(layout, encoder.encode(text).byteLength);
  const utf16Index = snapUtf16CaretToRustLayout(text, targetIndex, layout);
  const byteOffset = utf8OffsetAtUtf16Index(text, utf16Index);
  if (
    preferredVisualIndex !== undefined &&
    Number.isSafeInteger(preferredVisualIndex) &&
    offsets[preferredVisualIndex] === byteOffset
  ) return { utf16Index, visualIndex: preferredVisualIndex };
  const visualIndex = offsets.indexOf(byteOffset);
  return { utf16Index, visualIndex: Math.max(0, visualIndex) };
}

/** Moves through the Core-provided legal stops in physical line order while
 * retaining a run-boundary affinity even when the logical UTF-16 offset does
 * not change. */
export function moveUtf16CaretPositionInRustLayout(
  text: string,
  targetIndex: number,
  direction: -1 | 1,
  layout: RustTextCaretLayout,
  currentVisualIndex?: number,
): RustTextCaretPosition {
  const maxOffset = encoder.encode(text).byteLength;
  const legalOffsets = visualCaretOffsets(layout, maxOffset);
  if (!legalOffsets.length) return {
    utf16Index: Math.max(0, Math.min(text.length, targetIndex)),
    visualIndex: 0,
  };
  const current = rustTextCaretPositionAtUtf16Index(
    text,
    targetIndex,
    layout,
    currentVisualIndex,
  );
  const currentIndex = current.visualIndex;
  const nextIndex = Math.max(0, Math.min(legalOffsets.length - 1, currentIndex + direction));
  return {
    utf16Index: utf16IndexAtUtf8Offset(text, legalOffsets[nextIndex]!),
    visualIndex: nextIndex,
  };
}

export function moveUtf16CaretInRustLayout(
  text: string,
  targetIndex: number,
  direction: -1 | 1,
  layout: RustTextCaretLayout,
  currentVisualIndex?: number,
) {
  return moveUtf16CaretPositionInRustLayout(
    text,
    targetIndex,
    direction,
    layout,
    currentVisualIndex,
  ).utf16Index;
}

/** Collapses a non-empty DOM selection at the physical left/right edge of its
 * Rust-owned line. This avoids mapping ArrowLeft to the smaller logical byte
 * offset in a pure RTL paragraph, where that offset is visually on the right. */
export function collapseUtf16SelectionInRustLayout(
  text: string,
  anchor: number,
  focus: number,
  direction: -1 | 1,
  layout: RustTextCaretLayout,
) {
  return collapseUtf16SelectionPositionInRustLayout(
    text,
    anchor,
    focus,
    direction,
    layout,
  ).utf16Index;
}

export function collapseUtf16SelectionPositionInRustLayout(
  text: string,
  anchor: number,
  focus: number,
  direction: -1 | 1,
  layout: RustTextCaretLayout,
): RustTextCaretPosition {
  const snappedAnchor = snapUtf16CaretToRustLayout(text, anchor, layout);
  const snappedFocus = snapUtf16CaretToRustLayout(text, focus, layout);
  const offsets = visualCaretOffsets(layout, encoder.encode(text).byteLength);
  if (snappedAnchor === snappedFocus)
    return rustTextCaretPositionAtUtf16Index(text, snappedFocus, layout);
  const anchorOffset = utf8OffsetAtUtf16Index(text, snappedAnchor);
  const focusOffset = utf8OffsetAtUtf16Index(text, snappedFocus);
  const indices = offsets.flatMap((offset, index) =>
    offset === anchorOffset || offset === focusOffset ? [index] : [],
  );
  if (!indices.length) {
    const utf16Index = direction < 0
      ? Math.min(snappedAnchor, snappedFocus)
      : Math.max(snappedAnchor, snappedFocus);
    return rustTextCaretPositionAtUtf16Index(text, utf16Index, layout);
  }
  const visualIndex = direction < 0 ? Math.min(...indices) : Math.max(...indices);
  return {
    utf16Index: utf16IndexAtUtf8Offset(text, offsets[visualIndex]!),
    visualIndex,
  };
}

/** Accepts a browser-native physical move only when it is an adjacent Rust
 * visual stop. This keeps Chromium's hidden bidi affinity for caret painting
 * while rejecting surrogate/grapheme splits or browser-specific jumps. */
export function reconcileNativeUtf16CaretMove(
  text: string,
  currentIndex: number,
  nativeTargetIndex: number,
  direction: -1 | 1,
  layout: RustTextCaretLayout,
  currentVisualIndex?: number,
): RustTextCaretPosition & { nativeAccepted: boolean } {
  const nativeSnapped = snapUtf16CaretToRustLayout(
    text,
    nativeTargetIndex,
    layout,
  );
  const fallback = moveUtf16CaretPositionInRustLayout(
    text,
    currentIndex,
    direction,
    layout,
    currentVisualIndex,
  );
  if (nativeSnapped !== nativeTargetIndex)
    return { ...fallback, nativeAccepted: false };
  const offsets = visualCaretOffsets(layout, encoder.encode(text).byteLength);
  const currentOffset = utf8OffsetAtUtf16Index(
    text,
    snapUtf16CaretToRustLayout(text, currentIndex, layout),
  );
  const nativeOffset = utf8OffsetAtUtf16Index(text, nativeTargetIndex);
  let candidates = offsets.flatMap((offset, index) =>
    offset === currentOffset ? [index] : [],
  );
  if (
    currentVisualIndex !== undefined &&
    offsets[currentVisualIndex] === currentOffset
  ) {
    candidates = [currentVisualIndex];
  }
  for (const candidate of candidates) {
    const nextIndex = Math.max(
      0,
      Math.min(offsets.length - 1, candidate + direction),
    );
    if (offsets[nextIndex] === nativeOffset)
      return {
        utf16Index: nativeTargetIndex,
        visualIndex: nextIndex,
        nativeAccepted: true,
      };
  }
  return { ...fallback, nativeAccepted: false };
}

function visualCaretOffsets(layout: RustTextCaretLayout, maxOffset: number) {
  if (!layout.lines?.length) return logicalCaretOffsets(layout, maxOffset);
  if (layout.lines.every((line) => line.visualCarets?.length))
    return layout.lines.flatMap((line) => line.visualCarets!
      .filter((caret) => caret.byteOffset <= maxOffset)
      .map((caret) => caret.byteOffset));
  const result: number[] = [];
  layout.lines.forEach((line, lineIndex) => {
    const lineOffsets = [...new Set(layout.carets
      .filter((caret) => caret.lineIndex === lineIndex && caret.byteOffset <= maxOffset)
      .map((caret) => caret.byteOffset))]
      .sort((left, right) => left - right);
    if (line.visualRuns?.length) {
      line.visualRuns.forEach((run) => {
        const offsets = lineOffsets.filter(
          (offset) => offset >= run.start && offset <= run.end,
        );
        if (run.direction === "rtl") offsets.reverse();
        result.push(...offsets);
      });
    } else {
      if (line.direction === "rtl") lineOffsets.reverse();
      result.push(...lineOffsets);
    }
  });
  return result;
}

function logicalCaretOffsets(layout: RustTextCaretLayout, maxOffset: number) {
  return [...new Set(layout.carets.map((caret) => caret.byteOffset).filter((offset) => offset <= maxOffset))].sort((left, right) => left - right);
}

function moveUtf16CaretLogically(text: string, targetIndex: number, direction: -1 | 1, layout: RustTextCaretLayout) {
  const legalOffsets = logicalCaretOffsets(layout, encoder.encode(text).byteLength);
  if (!legalOffsets.length) return Math.max(0, Math.min(text.length, targetIndex));
  const snappedOffset = utf8OffsetAtUtf16Index(text, snapUtf16CaretToRustLayout(text, targetIndex, layout));
  const currentIndex = legalOffsets.indexOf(snappedOffset);
  const nextIndex = Math.max(0, Math.min(legalOffsets.length - 1, currentIndex + direction));
  return utf16IndexAtUtf8Offset(text, legalOffsets[nextIndex]);
}

/** Replaces a DOM selection only after both ends have been snapped to Rust's
 * legal grapheme boundaries. The returned caret stays in UTF-16 solely for the
 * contentEditable host; Canonical text is updated only on the later commit. */
export function replaceUtf16SelectionInRustLayout(
  text: string,
  anchor: number,
  focus: number,
  replacement: string,
  layout: RustTextCaretLayout,
) {
  const start = snapUtf16CaretToRustLayout(text, Math.min(anchor, focus), layout);
  const end = snapUtf16CaretToRustLayout(text, Math.max(anchor, focus), layout);
  const draft = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  const caret = start + replacement.length;
  return { draft, caret, selectionAnchor: caret, replacedStart: start, replacedEnd: end };
}

/** Deletes a selected range, or one complete Rust-owned caret step when the
 * selection is collapsed. This makes Backspace/Delete unable to split an Emoji
 * surrogate pair, ligature boundary or other grapheme cluster. */
export function deleteUtf16SelectionInRustLayout(
  text: string,
  anchor: number,
  focus: number,
  direction: -1 | 1,
  layout: RustTextCaretLayout,
) {
  let start = snapUtf16CaretToRustLayout(text, Math.min(anchor, focus), layout);
  let end = snapUtf16CaretToRustLayout(text, Math.max(anchor, focus), layout);
  if (start === end) {
    if (direction < 0) start = moveUtf16CaretLogically(text, start, -1, layout);
    else end = moveUtf16CaretLogically(text, end, 1, layout);
  }
  return replaceUtf16SelectionInRustLayout(text, start, end, "", layout);
}
