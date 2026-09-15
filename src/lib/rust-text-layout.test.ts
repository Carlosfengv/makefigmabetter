import { describe, expect, it } from "vitest";
import { projectDocumentTextCaseRanges } from "./text-case";
import { hasMissingRustTextGlyph, parseRustTextLayout, remapRustTextLayoutToSource } from "./rust-text-layout";

describe("Rust text layout boundary", () => {
  it("keeps UTF-8 line ranges and advances ready for presentation", () => {
    expect(parseRustTextLayout(JSON.stringify({
      unitsPerEm: 1000,
      lines: [
        { start: 0, end: 5, direction: "ltr", advance: 800, visualRuns: [{ start: 0, end: 1, direction: "ltr" }, { start: 1, end: 5, direction: "rtl" }], glyphs: [{ glyphId: 11, runIndex: 0, cluster: 0, xAdvance: 800, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
        { start: 5, end: 8, direction: "rtl", advance: 520, visualRuns: [{ start: 5, end: 8, direction: "rtl" }], glyphs: [{ glyphId: 12, runIndex: 0, cluster: 5, xAdvance: 520, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
      ],
    }), "A😀中")).toEqual({
      unitsPerEm: 1000,
      lines: [
        { start: 0, end: 5, direction: "ltr", advance: 800, visualRuns: [{ start: 0, end: 1, direction: "ltr" }, { start: 1, end: 5, direction: "rtl" }], glyphs: [{ glyphId: 11, runIndex: 0, cluster: 0, xAdvance: 800, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
        { start: 5, end: 8, direction: "rtl", advance: 520, visualRuns: [{ start: 5, end: 8, direction: "rtl" }], glyphs: [{ glyphId: 12, runIndex: 0, cluster: 5, xAdvance: 520, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
      ],
    });
  });

  it("preserves bounded glyph run ownership and defaults older payloads to run zero", () => {
    const line = (runIndex?: number) => ({
      unitsPerEm: 1000,
      lines: [{
        start: 0,
        end: 1,
        direction: "ltr",
        advance: 500,
        glyphs: [{ glyphId: 42, ...(runIndex === undefined ? {} : { runIndex }), cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 }],
      }],
    });
    expect(parseRustTextLayout(JSON.stringify(line()), "A")?.lines[0]?.glyphs[0]?.runIndex).toBe(0);
    expect(parseRustTextLayout(JSON.stringify(line(3)), "A")?.lines[0]?.glyphs[0]?.runIndex).toBe(3);
    expect(parseRustTextLayout(JSON.stringify(line(4_096)), "A")).toBeUndefined();
    expect(parseRustTextLayout(JSON.stringify(line(-1)), "A")).toBeUndefined();
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

  it("accepts only bounded physical caret coordinates", () => {
    const source = "ab";
    const base = {
      unitsPerEm: 1000,
      lines: [{
        start: 0,
        end: 2,
        direction: "ltr",
        advance: 900,
        visualRuns: [{ start: 0, end: 2, direction: "ltr" }],
        visualCarets: [
          { byteOffset: 0, xAdvance: 0 },
          { byteOffset: 1, xAdvance: 400 },
          { byteOffset: 2, xAdvance: 900 },
        ],
        glyphs: [],
      }],
    };
    expect(parseRustTextLayout(JSON.stringify(base), source)?.lines[0]?.visualCarets).toEqual(base.lines[0].visualCarets);
    expect(parseRustTextLayout(JSON.stringify({
      ...base,
      lines: [{ ...base.lines[0], visualCarets: [{ byteOffset: 0, xAdvance: 1 }] }],
    }), source)).toBeUndefined();
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

  it("remaps shaped display offsets and removes carets inside a case expansion", () => {
    const projection = projectDocumentTextCaseRanges("İx", [{ start: 0, end: 3, textCase: "lower" }]);
    const displayLayout = parseRustTextLayout(JSON.stringify({
      unitsPerEm: 1000,
      lines: [{
        start: 0,
        end: 4,
        direction: "ltr",
        advance: 900,
        visualRuns: [{ start: 0, end: 4, direction: "ltr" }],
        visualCarets: [
          { byteOffset: 0, xAdvance: 0 },
          { byteOffset: 1, xAdvance: 200 },
          { byteOffset: 3, xAdvance: 500 },
          { byteOffset: 4, xAdvance: 900 },
        ],
        glyphs: [
          { glyphId: 11, cluster: 0, xAdvance: 300, yAdvance: 0, xOffset: 0, yOffset: 0 },
          { glyphId: 12, cluster: 1, xAdvance: 200, yAdvance: 0, xOffset: 0, yOffset: 0 },
          { glyphId: 13, cluster: 3, xAdvance: 400, yAdvance: 0, xOffset: 0, yOffset: 0 },
        ],
      }],
      carets: [
        { byteOffset: 0, lineIndex: 0 },
        { byteOffset: 1, lineIndex: 0 },
        { byteOffset: 3, lineIndex: 0 },
        { byteOffset: 4, lineIndex: 0 },
      ],
    }), "i\u0307x");
    if (!projection || !displayLayout) throw new Error("missing display projection fixture");

    const sourceLayout = remapRustTextLayoutToSource(displayLayout, projection);
    expect(sourceLayout?.lines[0]).toMatchObject({
      start: 0,
      end: 3,
      visualRuns: [{ start: 0, end: 3, direction: "ltr" }],
      visualCarets: [
        { byteOffset: 0, xAdvance: 0 },
        { byteOffset: 2, xAdvance: 500 },
        { byteOffset: 3, xAdvance: 900 },
      ],
    });
    expect(sourceLayout?.lines[0]?.glyphs.map((glyph) => glyph.cluster)).toEqual([0, 0, 2]);
    expect(sourceLayout?.carets?.map((caret) => caret.byteOffset)).toEqual([0, 2, 3]);
  });

  it("rejects a display line break that lands inside a generated source scalar", () => {
    const projection = projectDocumentTextCaseRanges("İx", [{ start: 0, end: 3, textCase: "lower" }]);
    const displayLayout = parseRustTextLayout(JSON.stringify({
      unitsPerEm: 1000,
      lines: [{
        start: 0,
        end: 1,
        direction: "ltr",
        advance: 200,
        visualRuns: [{ start: 0, end: 1, direction: "ltr" }],
        visualCarets: [{ byteOffset: 0, xAdvance: 0 }, { byteOffset: 1, xAdvance: 200 }],
        glyphs: [{ glyphId: 11, cluster: 0, xAdvance: 200, yAdvance: 0, xOffset: 0, yOffset: 0 }],
      }],
      carets: [{ byteOffset: 0, lineIndex: 0 }, { byteOffset: 1, lineIndex: 0 }],
    }), "i\u0307x");
    if (!projection || !displayLayout) throw new Error("missing display projection fixture");
    expect(remapRustTextLayoutToSource(displayLayout, projection)).toBeUndefined();
  });
});
