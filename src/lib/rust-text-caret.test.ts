import { describe, expect, it } from "vitest";
import { deleteUtf16SelectionInRustLayout, moveUtf16CaretInRustLayout, parseRustTextCaretLayout, replaceUtf16SelectionInRustLayout, snapUtf16CaretToRustLayout, utf16IndexAtUtf8Offset, utf8OffsetAtUtf16Index } from "./rust-text-caret";

describe("Rust text caret projection", () => {
  it("round-trips legal UTF-8 boundaries while preserving surrogate pairs", () => {
    expect(utf8OffsetAtUtf16Index("A😀中", 3)).toBe(5);
    expect(utf16IndexAtUtf8Offset("A😀中", 5)).toBe(3);
  });

  it("snaps a DOM offset inside an emoji to the earlier Rust caret on ties", () => {
    const layout = parseRustTextCaretLayout({ carets: [{ byteOffset: 0, lineIndex: 0 }, { byteOffset: 1, lineIndex: 0 }, { byteOffset: 5, lineIndex: 0 }, { byteOffset: 8, lineIndex: 0 }] });
    expect(layout).toBeDefined();
    expect(snapUtf16CaretToRustLayout("A😀中", 2, layout!)).toBe(1);
  });

  it("rejects malformed worker payloads", () => {
    expect(parseRustTextCaretLayout({ carets: [{ byteOffset: -1, lineIndex: 0 }] })).toBeUndefined();
    expect(parseRustTextCaretLayout({ carets: [] })).toBeUndefined();
  });

  it("moves only between Rust-owned caret stops", () => {
    const layout = parseRustTextCaretLayout({ carets: [{ byteOffset: 0, lineIndex: 0 }, { byteOffset: 1, lineIndex: 0 }, { byteOffset: 5, lineIndex: 0 }, { byteOffset: 8, lineIndex: 0 }] });
    expect(moveUtf16CaretInRustLayout("A😀中", 1, 1, layout!)).toBe(3);
    expect(moveUtf16CaretInRustLayout("A😀中", 3, -1, layout!)).toBe(1);
  });

  it("deletes and replaces only complete Rust-owned caret ranges", () => {
    const layout = parseRustTextCaretLayout({ carets: [{ byteOffset: 0, lineIndex: 0 }, { byteOffset: 1, lineIndex: 0 }, { byteOffset: 5, lineIndex: 0 }, { byteOffset: 8, lineIndex: 0 }] });
    expect(deleteUtf16SelectionInRustLayout("A😀中", 3, 3, -1, layout!)).toEqual({ draft: "A中", caret: 1, selectionAnchor: 1, replacedStart: 1, replacedEnd: 3 });
    expect(deleteUtf16SelectionInRustLayout("A😀中", 1, 1, 1, layout!)).toEqual({ draft: "A中", caret: 1, selectionAnchor: 1, replacedStart: 1, replacedEnd: 3 });
    expect(replaceUtf16SelectionInRustLayout("A😀中", 1, 3, "B", layout!)).toEqual({ draft: "AB中", caret: 2, selectionAnchor: 2, replacedStart: 1, replacedEnd: 3 });
  });
});
