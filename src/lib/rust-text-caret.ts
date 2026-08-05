/** A presentation-safe projection of the Rust text layout boundary. Offsets
 * are UTF-8 bytes so DOM selections can never split a grapheme by accident. */
export interface RustTextCaretLayout {
  carets: Array<{ byteOffset: number; lineIndex: number }>;
}

const encoder = new TextEncoder();

export function parseRustTextCaretLayout(value: unknown): RustTextCaretLayout | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as { carets?: unknown }).carets)) return undefined;
  const carets = (value as { carets: unknown[] }).carets.flatMap((caret) => {
    if (!caret || typeof caret !== "object") return [];
    const { byteOffset, lineIndex } = caret as { byteOffset?: unknown; lineIndex?: unknown };
    return Number.isSafeInteger(byteOffset) && (byteOffset as number) >= 0 && Number.isSafeInteger(lineIndex) && (lineIndex as number) >= 0
      ? [{ byteOffset: byteOffset as number, lineIndex: lineIndex as number }]
      : [];
  });
  return carets.length ? { carets } : undefined;
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

/** Moves through the Core-provided legal stops in logical text order. Visual
 * bidi navigation remains a renderer concern until the Rust line layout also
 * exposes visual caret affinity. */
export function moveUtf16CaretInRustLayout(text: string, targetIndex: number, direction: -1 | 1, layout: RustTextCaretLayout) {
  const maxOffset = encoder.encode(text).byteLength;
  const legalOffsets = [...new Set(layout.carets.map((caret) => caret.byteOffset).filter((offset) => offset <= maxOffset))].sort((left, right) => left - right);
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
    if (direction < 0) start = moveUtf16CaretInRustLayout(text, start, -1, layout);
    else end = moveUtf16CaretInRustLayout(text, end, 1, layout);
  }
  return replaceUtf16SelectionInRustLayout(text, start, end, "", layout);
}
