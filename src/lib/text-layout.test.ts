import { describe, expect, it } from "vitest";
import { layoutText, layoutTextLines, layoutTextRanges, resolveTextDirection, resolveTextRenderMetrics, segmentGraphemes, textParagraphRanges } from "./text-layout";

const monoMeasure = (value: string) => segmentGraphemes(value).length * 10;

describe("basic text layout", () => {
  it("wraps at whitespace before falling back to a grapheme boundary", () => {
    expect(layoutTextLines({ text: "Hello world", maxWidth: 60, measure: monoMeasure })).toEqual(["Hello", "world"]);
    expect(layoutTextLines({ text: "你好世界", maxWidth: 20, measure: monoMeasure })).toEqual(["你好", "世界"]);
  });

  it("preserves combining characters and a ZWJ emoji as indivisible layout clusters", () => {
    expect(segmentGraphemes("e\u0301🙂‍↔️")).toEqual(["e\u0301", "🙂‍↔️"]);
    expect(layoutTextLines({ text: "e\u0301🙂‍↔️", maxWidth: 10, measure: monoMeasure })).toEqual(["e\u0301", "🙂‍↔️"]);
  });

  it("preserves native Unicode grapheme clusters beyond the fallback subset", () => {
    expect(segmentGraphemes("\u1100\u1161#️⃣🇨🇳")).toEqual(["\u1100\u1161", "#️⃣", "🇨🇳"]);
  });

  it("preserves explicit empty lines independently of width wrapping", () => {
    expect(layoutTextLines({ text: "first\n\nlast", maxWidth: 100, measure: monoMeasure })).toEqual(["first", "", "last"]);
  });

  it("normalizes platform and Unicode paragraph separators without retaining a carriage return", () => {
    expect(layoutTextLines({ text: "first\r\nsecond\rthird\u2028fourth\u2029last", maxWidth: 100, measure: monoMeasure }))
      .toEqual(["first", "second", "third", "fourth", "last"]);
  });

  it("keeps logical text order while assigning a stable paragraph direction for Canvas", () => {
    expect(resolveTextDirection("123 — مرحبا")).toBe("rtl");
    expect(resolveTextDirection("123 — hello")).toBe("ltr");
    expect(resolveTextDirection("🙂 123")).toBe("ltr");
    expect(layoutText({ text: "مرحبا بالعالم\nHello 世界", maxWidth: 70, measure: monoMeasure })).toEqual([
      { text: "مرحبا", direction: "rtl" },
      { text: "بالعالم", direction: "rtl" },
      { text: "Hello", direction: "ltr" },
      { text: "世界", direction: "ltr" },
    ]);
  });

  it("retains UTF-8 byte ranges across emoji, whitespace wrapping, and paragraphs", () => {
    expect(layoutTextRanges({ text: "A😀 B\n中", maxWidth: 25, measure: monoMeasure })).toEqual([
      { text: "A😀", direction: "ltr", start: 0, end: 5 },
      { text: "B", direction: "ltr", start: 6, end: 7 },
      { text: "中", direction: "ltr", start: 8, end: 11 },
    ]);
  });

  it("retains hard-break paragraph ranges for DOM paragraph spacing", () => {
    expect(textParagraphRanges("مرحبا\n中")).toEqual([
      { text: "مرحبا", direction: "rtl", start: 0, end: 10 },
      { text: "中", direction: "ltr", start: 11, end: 14 },
    ]);
  });

  it("keeps text width, glyph size, and clipping height in the same zoom scale", () => {
    const full = resolveTextRenderMetrics(370, 64, 1);
    const small = resolveTextRenderMetrics(370, 64, 0.2);

    expect(small).toEqual({ width: 74, height: 12.8, fontSize: 6.2, lineHeight: 4 });
    expect(small.width / full.width).toBeCloseTo(0.2);
    expect(small.fontSize / full.fontSize).toBeCloseTo(0.2);
    expect(small.lineHeight / full.lineHeight).toBeCloseTo(0.2);
  });

  it("does not change wrapping when the view applies a uniform scale", () => {
    const text = "Design, with intent.";
    const full = resolveTextRenderMetrics(170, 64, 1);
    const small = resolveTextRenderMetrics(170, 64, 0.2);
    const measureAt = (fontSize: number) => (value: string) => value.length * fontSize * 0.55;

    expect(layoutTextLines({ text, maxWidth: full.width, measure: measureAt(full.fontSize) }))
      .toEqual(layoutTextLines({ text, maxWidth: small.width, measure: measureAt(small.fontSize) }));
  });
});
