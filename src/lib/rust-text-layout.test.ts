import { describe, expect, it } from "vitest";
import { hasMissingRustTextGlyph, parseRustTextLayout } from "./rust-text-layout";

describe("Rust text layout boundary", () => {
  it("keeps UTF-8 line ranges and advances ready for presentation", () => {
    expect(parseRustTextLayout(JSON.stringify({
      unitsPerEm: 1000,
      lines: [
        { start: 0, end: 5, direction: "ltr", advance: 800, visualRuns: [{ start: 0, end: 1, direction: "ltr" }, { start: 1, end: 5, direction: "rtl" }], glyphs: [{ glyphId: 11, cluster: 0, xAdvance: 800, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
        { start: 5, end: 8, direction: "rtl", advance: 520, visualRuns: [{ start: 5, end: 8, direction: "rtl" }], glyphs: [{ glyphId: 12, cluster: 5, xAdvance: 520, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
      ],
    }), "A😀中")).toEqual({
      unitsPerEm: 1000,
      lines: [
        { start: 0, end: 5, direction: "ltr", advance: 800, visualRuns: [{ start: 0, end: 1, direction: "ltr" }, { start: 1, end: 5, direction: "rtl" }], glyphs: [{ glyphId: 11, cluster: 0, xAdvance: 800, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
        { start: 5, end: 8, direction: "rtl", advance: 520, visualRuns: [{ start: 5, end: 8, direction: "rtl" }], glyphs: [{ glyphId: 12, cluster: 5, xAdvance: 520, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
      ],
    });
  });

  it("rejects out-of-order ranges and invalid metrics", () => {
    expect(parseRustTextLayout(JSON.stringify({ unitsPerEm: 0, lines: [] }), "")).toBeUndefined();
    expect(parseRustTextLayout(JSON.stringify({
      unitsPerEm: 1000,
      lines: [{ start: 2, end: 1, direction: "ltr", advance: 0, glyphs: [] }],
    }), "hello")).toBeUndefined();
    expect(parseRustTextLayout(JSON.stringify({
      unitsPerEm: 1000,
      lines: [{ start: 0, end: 5, direction: "sideways", advance: Number.NaN, glyphs: [] }],
    }), "hello")).toBeUndefined();
    expect(parseRustTextLayout(JSON.stringify({
      unitsPerEm: 1000,
      lines: [{ start: 0, end: 2, direction: "ltr", advance: 20, glyphs: [] }],
    }), "😀")).toBeUndefined();
  });

  it("requires supplied visual runs to cover each UTF-8 line exactly once", () => {
    const source = "A😀";
    const line = { start: 0, end: 5, direction: "ltr", advance: 20, glyphs: [] };
    expect(parseRustTextLayout(JSON.stringify({ unitsPerEm: 1000, lines: [{ ...line, visualRuns: [{ start: 0, end: 1, direction: "ltr" }] }] }), source)).toBeUndefined();
    expect(parseRustTextLayout(JSON.stringify({ unitsPerEm: 1000, lines: [{ ...line, visualRuns: [{ start: 0, end: 5, direction: "invalid" }] }] }), source)).toBeUndefined();
    expect(parseRustTextLayout(JSON.stringify({ unitsPerEm: 1000, lines: [{ ...line, visualRuns: [{ start: 0, end: 5, direction: "ltr" }] }] }), source)?.lines[0]?.visualRuns).toEqual([{ start: 0, end: 5, direction: "ltr" }]);
  });

  it("identifies incomplete explicit-font layouts before a fallback font changes advances", () => {
    const complete = parseRustTextLayout(JSON.stringify({
      unitsPerEm: 1000,
      lines: [{ start: 0, end: 1, direction: "ltr", advance: 500, glyphs: [{ glyphId: 42, cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 }] }],
    }), "A");
    const missing = parseRustTextLayout(JSON.stringify({
      unitsPerEm: 1000,
      lines: [{ start: 0, end: 3, direction: "ltr", advance: 500, glyphs: [{ glyphId: 0, cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 }] }],
    }), "中");

    expect(complete && hasMissingRustTextGlyph(complete)).toBe(false);
    expect(missing && hasMissingRustTextGlyph(missing)).toBe(true);
  });
});
