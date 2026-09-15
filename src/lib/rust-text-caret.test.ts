import { describe, expect, it } from "vitest";
import { collapseUtf16SelectionInRustLayout, deleteUtf16SelectionInRustLayout, moveUtf16CaretInRustLayout, moveUtf16CaretPositionInRustLayout, parseRustTextCaretLayout, reconcileNativeUtf16CaretMove, replaceUtf16SelectionInRustLayout, rustTextCaretPositionAtPoint, snapUtf16CaretToRustLayout, utf16IndexAtUtf8Offset, utf8OffsetAtUtf16Index } from "./rust-text-caret";

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
    expect(parseRustTextCaretLayout({ lines: [{ start: 0, end: 1, direction: "sideways" }], carets: [{ byteOffset: 0, lineIndex: 0 }] })).toBeUndefined();
    expect(parseRustTextCaretLayout({ lines: [{ start: 0, end: 1, direction: "ltr" }], carets: [{ byteOffset: 2, lineIndex: 0 }] })).toBeUndefined();
    expect(parseRustTextCaretLayout({ lines: [{ start: 0, end: 3, direction: "ltr", visualRuns: [{ start: 0, end: 2, direction: "ltr" }, { start: 1, end: 3, direction: "rtl" }] }], carets: [{ byteOffset: 0, lineIndex: 0 }] })).toBeUndefined();
    expect(parseRustTextCaretLayout({ unitsPerEm: 1000, lines: [{ start: 0, end: 1, direction: "ltr", advance: 500, visualCarets: [{ byteOffset: 0, xAdvance: 20 }] }], carets: [{ byteOffset: 0, lineIndex: 0 }] })).toBeUndefined();
  });

  it("maps Canvas-local pointer coordinates through shaped line advances", () => {
    const layout = parseRustTextCaretLayout({
      unitsPerEm: 1000,
      lines: [{
        start: 0,
        end: 3,
        direction: "ltr",
        advance: 900,
        visualRuns: [{ start: 0, end: 3, direction: "ltr" }],
        visualCarets: [
          { byteOffset: 0, xAdvance: 0 },
          { byteOffset: 1, xAdvance: 200 },
          { byteOffset: 2, xAdvance: 500 },
          { byteOffset: 3, xAdvance: 900 },
        ],
      }],
      carets: [0, 1, 2, 3].map((byteOffset) => ({ byteOffset, lineIndex: 0 })),
    });
    expect(layout).toBeDefined();
    const metrics = { y: 5, width: 100, fontSize: 20, lineHeight: 24, paragraphSpacing: 0, alignment: "center" as const };
    expect(rustTextCaretPositionAtPoint("abc", layout!, { ...metrics, x: 44 })).toEqual({ utf16Index: 1, visualIndex: 1 });
    expect(rustTextCaretPositionAtPoint("abc", layout!, { ...metrics, x: 55 })).toEqual({ utf16Index: 2, visualIndex: 2 });
  });

  it("uses the physical caret order and right edge for an RTL shaped line", () => {
    const layout = parseRustTextCaretLayout({
      unitsPerEm: 1000,
      lines: [{
        start: 0,
        end: 4,
        direction: "rtl",
        advance: 1000,
        visualRuns: [{ start: 0, end: 4, direction: "rtl" }],
        visualCarets: [
          { byteOffset: 4, xAdvance: 0 },
          { byteOffset: 2, xAdvance: 500 },
          { byteOffset: 0, xAdvance: 1000 },
        ],
      }],
      carets: [0, 2, 4].map((byteOffset) => ({ byteOffset, lineIndex: 0 })),
    });
    expect(rustTextCaretPositionAtPoint("אב", layout!, {
      x: 99,
      y: 4,
      width: 100,
      fontSize: 20,
      lineHeight: 24,
      paragraphSpacing: 0,
      alignment: "left",
    })).toEqual({ utf16Index: 0, visualIndex: 2 });
    expect(rustTextCaretPositionAtPoint("אב", layout!, {
      x: 40,
      y: 4,
      width: 100,
      fontSize: 20,
      lineHeight: 24,
      paragraphSpacing: 0,
      alignment: "center",
    })).toEqual({ utf16Index: 2, visualIndex: 0 });
  });

  it("moves only between Rust-owned caret stops", () => {
    const layout = parseRustTextCaretLayout({ carets: [{ byteOffset: 0, lineIndex: 0 }, { byteOffset: 1, lineIndex: 0 }, { byteOffset: 5, lineIndex: 0 }, { byteOffset: 8, lineIndex: 0 }] });
    expect(moveUtf16CaretInRustLayout("A😀中", 1, 1, layout!)).toBe(3);
    expect(moveUtf16CaretInRustLayout("A😀中", 3, -1, layout!)).toBe(1);
  });

  it("moves and collapses selections in physical order for a pure RTL line", () => {
    const layout = parseRustTextCaretLayout({
      lines: [{ start: 0, end: 6, direction: "rtl" }],
      carets: [
        { byteOffset: 0, lineIndex: 0 },
        { byteOffset: 2, lineIndex: 0 },
        { byteOffset: 4, lineIndex: 0 },
        { byteOffset: 6, lineIndex: 0 },
      ],
    });
    expect(layout).toBeDefined();
    expect(moveUtf16CaretInRustLayout("אבג", 1, -1, layout!)).toBe(2);
    expect(moveUtf16CaretInRustLayout("אבג", 1, 1, layout!)).toBe(0);
    expect(collapseUtf16SelectionInRustLayout("אבג", 0, 2, -1, layout!)).toBe(2);
    expect(collapseUtf16SelectionInRustLayout("אבג", 0, 2, 1, layout!)).toBe(0);
    expect(deleteUtf16SelectionInRustLayout("אבג", 1, 1, -1, layout!)).toEqual({ draft: "בג", caret: 0, selectionAnchor: 0, replacedStart: 0, replacedEnd: 1 });
  });

  it("retains distinct visual affinities at mixed-direction run boundaries", () => {
    const layout = parseRustTextCaretLayout({
      lines: [{
        start: 0,
        end: 6,
        direction: "ltr",
        visualRuns: [
          { start: 0, end: 1, direction: "ltr" },
          { start: 1, end: 5, direction: "rtl" },
          { start: 5, end: 6, direction: "ltr" },
        ],
      }],
      carets: [0, 1, 3, 5, 6].map((byteOffset) => ({ byteOffset, lineIndex: 0 })),
    });
    expect(layout).toBeDefined();
    const firstBoundary = moveUtf16CaretPositionInRustLayout("AאבB", 1, 1, layout!, 1);
    expect(firstBoundary).toEqual({ utf16Index: 3, visualIndex: 2 });
    const insideRtl = moveUtf16CaretPositionInRustLayout("AאבB", firstBoundary.utf16Index, 1, layout!, firstBoundary.visualIndex);
    expect(insideRtl).toEqual({ utf16Index: 2, visualIndex: 3 });
    const secondAffinity = moveUtf16CaretPositionInRustLayout("AאבB", insideRtl.utf16Index, 1, layout!, insideRtl.visualIndex);
    expect(secondAffinity).toEqual({ utf16Index: 1, visualIndex: 4 });
    expect(reconcileNativeUtf16CaretMove("AאבB", 1, 3, 1, layout!)).toEqual({
      utf16Index: 3,
      visualIndex: 2,
      nativeAccepted: true,
    });
    expect(reconcileNativeUtf16CaretMove("AאבB", 1, 2, 1, layout!)).toEqual({
      utf16Index: 3,
      visualIndex: 2,
      nativeAccepted: false,
    });
    expect(reconcileNativeUtf16CaretMove("AאבB", 3, 4, 1, layout!, 2)).toEqual({
      utf16Index: 2,
      visualIndex: 3,
      nativeAccepted: false,
    });
  });

  it("deletes and replaces only complete Rust-owned caret ranges", () => {
    const layout = parseRustTextCaretLayout({ carets: [{ byteOffset: 0, lineIndex: 0 }, { byteOffset: 1, lineIndex: 0 }, { byteOffset: 5, lineIndex: 0 }, { byteOffset: 8, lineIndex: 0 }] });
    expect(deleteUtf16SelectionInRustLayout("A😀中", 3, 3, -1, layout!)).toEqual({ draft: "A中", caret: 1, selectionAnchor: 1, replacedStart: 1, replacedEnd: 3 });
    expect(deleteUtf16SelectionInRustLayout("A😀中", 1, 1, 1, layout!)).toEqual({ draft: "A中", caret: 1, selectionAnchor: 1, replacedStart: 1, replacedEnd: 3 });
    expect(replaceUtf16SelectionInRustLayout("A😀中", 1, 3, "B", layout!)).toEqual({ draft: "AB中", caret: 2, selectionAnchor: 2, replacedStart: 1, replacedEnd: 3 });
  });
});
