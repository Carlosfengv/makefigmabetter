import { describe, expect, it } from "vitest";
import { layoutText, layoutTextLines, layoutTextRanges, resolveTextDirection, resolveTextRenderMetrics, segmentGraphemes, textAlignedLineLeft, textHangingPunctuationOffsets, textIndentedLineBox, textLineStartsParagraph, textListIndentationOffset, textListMarker, textListMarkerBaseIndent, textListMarkerGutter, textListMarkerGutterForProperties, textListMarkerPlacement, textParagraphGap, textParagraphIndentAt, textParagraphListTypeAt, textParagraphRanges, textParagraphWrapStyleAt } from "./text-layout";

const monoMeasure = (value: string) => segmentGraphemes(value).length * 10;

describe("basic text layout", () => {
  it("wraps at whitespace before falling back to a grapheme boundary", () => {
    expect(layoutTextLines({ text: "Hello world", maxWidth: 60, measure: monoMeasure })).toEqual(["Hello", "world"]);
    expect(layoutTextLines({ text: "你好世界", maxWidth: 20, measure: monoMeasure })).toEqual(["你好", "世界"]);
  });

  it("hangs one boundary punctuation grapheme without changing source ranges", () => {
    expect(layoutTextLines({ text: "abcd.", maxWidth: 40, measure: monoMeasure })).toEqual(["abcd", "."]);
    expect(layoutTextRanges({ text: "abcd.", maxWidth: 40, hangingPunctuation: true, measure: monoMeasure })).toEqual([
      { text: "abcd.", direction: "ltr", start: 0, end: 5 },
    ]);
    expect(layoutTextLines({ text: "“abcd", maxWidth: 40, hangingPunctuation: true, measure: monoMeasure })).toEqual(["“abcd"]);
    expect(textHangingPunctuationOffsets("“abcd。", "ltr", monoMeasure)).toEqual({ left: 10, right: 10 });
    expect(textAlignedLineLeft(0, 40, 50, "left", "ltr", { left: 10, right: 0 })).toBe(-10);
    expect(textAlignedLineLeft(0, 40, 50, "right", "ltr", { left: 0, right: 10 })).toBe(0);
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

  it("applies first-line indentation independently to every hard paragraph", () => {
    expect(layoutTextLines({ text: "abcd\nefgh", maxWidth: 40, firstLineIndent: 20, measure: monoMeasure })).toEqual([
      "ab", "cd", "ef", "gh",
    ]);
    expect(layoutTextLines({ text: "abcd", maxWidth: 40, firstLineIndent: 0, measure: monoMeasure })).toEqual(["abcd"]);
  });

  it("balances line lengths without changing AUTO's line count", () => {
    expect(layoutTextLines({ text: "aa bb cc dd", maxWidth: 90, measure: monoMeasure })).toEqual([
      "aa bb cc", "dd",
    ]);
    expect(layoutTextLines({ text: "aa bb cc dd", maxWidth: 90, wrapStyle: "balance", measure: monoMeasure })).toEqual([
      "aa bb", "cc dd",
    ]);
    expect(layoutTextRanges({ text: "aa bb cc dd", maxWidth: 90, wrapStyle: "balance", measure: monoMeasure })).toEqual([
      { text: "aa bb", direction: "ltr", start: 0, end: 5 },
      { text: "cc dd", direction: "ltr", start: 6, end: 11 },
    ]);
  });

  it("resolves wrap style independently at UTF-8 paragraph boundaries", () => {
    const text = "aa bb cc dd\n😀 aa bb cc dd";
    const secondStart = new TextEncoder().encode("aa bb cc dd\n").length;
    const properties = {
      paragraph: { paragraphSpacing: 0, textWrapStyle: "balance" as const },
      paragraphStyleRuns: [{ start: secondStart, textWrapStyle: "auto" as const }],
    };
    expect(textParagraphWrapStyleAt(properties, 0)).toBe("balance");
    expect(textParagraphWrapStyleAt(properties, secondStart)).toBe("auto");
    expect(layoutTextRanges({
      text,
      maxWidth: 90,
      wrapStyle: (_index, start) => textParagraphWrapStyleAt(properties, start),
      measure: monoMeasure,
    }).map((line) => line.text)).toEqual(["aa bb", "cc dd", "😀 aa bb", "cc dd"]);
  });

  it("uses PRETTY only to remove an avoidable one-word final line", () => {
    expect(layoutTextLines({ text: "aa bb cc dd", maxWidth: 90, wrapStyle: "pretty", measure: monoMeasure })).toEqual([
      "aa bb", "cc dd",
    ]);
    expect(layoutTextLines({ text: "aa bb cc dd", maxWidth: 60, wrapStyle: "pretty", measure: monoMeasure })).toEqual([
      "aa bb", "cc dd",
    ]);
  });

  it("falls back to AUTO before rebalancing over-budget paragraphs", () => {
    for (const [text, maxWidth] of [
      ["aa ".repeat(65).trim(), 50],
      ["a".repeat(513), 3_000],
    ] as const) {
      let autoMeasures = 0;
      const automatic = layoutTextLines({
        text,
        maxWidth,
        measure: (value) => {
          autoMeasures += 1;
          return monoMeasure(value);
        },
      });
      let balanceMeasures = 0;
      const balanced = layoutTextLines({
        text,
        maxWidth,
        wrapStyle: "balance",
        measure: (value) => {
          balanceMeasures += 1;
          return monoMeasure(value);
        },
      });
      expect(balanced).toEqual(automatic);
      expect(balanceMeasures).toBe(autoMeasures);
    }
  });

  it("uses source-range measurement when presentation expands the rendered text", () => {
    const seen: Array<[number, number, string]> = [];
    expect(layoutTextRanges({
      text: "aßb",
      maxWidth: 20,
      measure: monoMeasure,
      measureRange: (start, end, value) => {
        seen.push([start, end, value]);
        return value.toLocaleUpperCase("und").length * 10;
      },
    })).toEqual([
      { text: "a", direction: "ltr", start: 0, end: 1 },
      { text: "ß", direction: "ltr", start: 1, end: 3 },
      { text: "b", direction: "ltr", start: 3, end: 4 },
    ]);
    expect(seen).toContainEqual([0, 3, "aß"]);
  });

  it("retains hard-break paragraph ranges for DOM paragraph spacing", () => {
    expect(textParagraphRanges("مرحبا\n中")).toEqual([
      { text: "مرحبا", direction: "rtl", start: 0, end: 10 },
      { text: "中", direction: "ltr", start: 11, end: 14 },
    ]);
  });

  it("derives list markers without inserting them into source text ranges", () => {
    expect(textListMarker("ordered", 0)).toBe("1.");
    expect(textListMarker("ordered", 9)).toBe("10.");
    expect(textListMarker("unordered", 99)).toBe("•");
    expect(textListMarkerGutter("One\nTwo", undefined, monoMeasure)).toBe(0);
    expect(textListMarkerGutter("One\nTwo", "unordered", monoMeasure)).toBe(20);
    expect(textListMarkerGutter(Array.from({ length: 10 }, (_, index) => String(index)).join("\n"), "ordered", monoMeasure)).toBe(40);
    expect(layoutTextRanges({ text: "One\nTwo", maxWidth: 100, firstLineIndent: 30, measure: monoMeasure })).toEqual([
      { text: "One", direction: "ltr", start: 0, end: 3 },
      { text: "Two", direction: "ltr", start: 4, end: 7 },
    ]);
  });

  it("places indents and list markers on the paragraph's visual start side", () => {
    expect(textIndentedLineBox(10, 100, 20, "ltr")).toEqual({ start: 30, width: 80 });
    expect(textIndentedLineBox(10, 100, 20, "rtl")).toEqual({ start: 10, width: 80 });
    expect(textListMarkerPlacement(30, 40, 5, "ltr")).toEqual({ x: 25, align: "right", anchor: "end" });
    expect(textListMarkerPlacement(30, 40, 5, "rtl")).toEqual({ x: 75, align: "left", anchor: "start" });
  });

  it("removes only the first marker column from layout for a hanging list", () => {
    expect(textListMarkerBaseIndent({ paragraph: { listType: "ordered" } }, 30)).toBe(30);
    expect(textListMarkerBaseIndent({ paragraph: { listType: "ordered", hangingList: true } }, 30)).toBe(0);
    expect(textListMarkerBaseIndent({ paragraph: {} }, 30)).toBe(0);
  });

  it("adds list spacing only to list paragraph gaps", () => {
    expect(textParagraphGap(undefined)).toBe(0);
    expect(textParagraphGap({ paragraph: { paragraphSpacing: 4, listSpacing: 7 } })).toBe(4);
    expect(textParagraphGap({ paragraph: { paragraphSpacing: 4, listType: "ordered", listSpacing: 7 } })).toBe(11);
    expect(textParagraphGap({ paragraph: { paragraphSpacing: 4, listType: "unordered" } })).toBe(4);
    const mixed = {
      paragraph: { paragraphSpacing: 4, listType: "ordered" as const, listSpacing: 7 },
      paragraphStyleRuns: [{ start: 4, listSpacing: 0 }, { start: 8, listSpacing: 12 }],
    };
    expect(textParagraphGap(mixed, 0, 4)).toBe(11);
    expect(textParagraphGap(mixed, 4, 8)).toBe(4);
    expect(textParagraphGap(mixed, 8, 12)).toBe(16);
  });

  it("uses the preceding paragraph's sparse paragraph spacing at hard-break boundaries", () => {
    const properties = {
      paragraph: { paragraphSpacing: 6 },
      paragraphStyleRuns: [{ start: 0, paragraphSpacing: 0 }, { start: 4, paragraphSpacing: 12 }],
    };
    expect(textParagraphGap(properties, 0, 4)).toBe(0);
    expect(textParagraphGap(properties, 4, 8)).toBe(12);
    expect(textParagraphGap(properties, 8, 12)).toBe(6);
  });

  it("uses sparse paragraph indentation only for the matching paragraph's first line", () => {
    const properties = {
      paragraph: { paragraphIndent: 10 },
      paragraphStyleRuns: [{ start: 4, paragraphIndent: 0 }, { start: 11, paragraphIndent: 20 }],
    };
    expect(textParagraphIndentAt(properties, 0)).toBe(10);
    expect(textParagraphIndentAt(properties, 4)).toBe(0);
    expect(textParagraphIndentAt(properties, 11)).toBe(20);
    expect(layoutTextRanges({
      text: "One\n123456\nEnd",
      maxWidth: 50,
      firstLineIndent: (_index, start) => textParagraphIndentAt(properties, start),
      measure: monoMeasure,
    }).map((line) => line.text)).toEqual(["One", "12345", "6", "End"]);
  });

  it("applies sparse list indentation to the matching paragraph and every wrapped line", () => {
    const text = "One\n123456";
    const properties = {
      paragraph: { listType: "ordered" as const },
      paragraphStyleRuns: [{ start: 4, indentation: 2 }],
    };
    expect(textListIndentationOffset(text, properties, 0, 20)).toBe(0);
    expect(textListIndentationOffset(text, properties, 4, 20)).toBe(20);
    expect(layoutTextRanges({
      text,
      maxWidth: 50,
      paragraphIndent: (_index, start) => textListIndentationOffset(text, properties, start, 20),
      measure: monoMeasure,
    }).map((line) => line.text)).toEqual(["One", "123", "456"]);
  });

  it("resolves mixed per-paragraph list types, marker gutters, and explicit NONE overrides", () => {
    const text = "One\nTwo\nThree";
    const properties = {
      paragraph: { paragraphSpacing: 4, listType: "ordered" as const, listSpacing: 7 },
      paragraphStyleRuns: [
        { start: 4, listType: "none" as const },
        { start: 8, indentation: 2, listType: "unordered" as const },
      ],
    };
    const gutter = textListMarkerGutterForProperties(text, properties, monoMeasure);

    expect(gutter).toBe(30);
    expect(textParagraphListTypeAt(properties, 0)).toBe("ordered");
    expect(textParagraphListTypeAt(properties, 4)).toBeUndefined();
    expect(textParagraphListTypeAt(properties, 8)).toBe("unordered");
    expect(textListMarkerBaseIndent(properties, gutter, 0)).toBe(30);
    expect(textListMarkerBaseIndent(properties, gutter, 4)).toBe(0);
    expect(textListIndentationOffset(text, properties, 8, gutter)).toBe(30);
    expect(textParagraphGap(properties, 0, 4)).toBe(4);
    expect(textParagraphGap(properties, 4, 8)).toBe(4);
  });

  it("recognizes a paragraph after an empty first paragraph by line order", () => {
    const lines = layoutTextRanges({ text: "\nSecond", maxWidth: 100, measure: monoMeasure });
    expect(lines.map((line, index) => textLineStartsParagraph(index, new TextDecoder().decode(
      new TextEncoder().encode("\nSecond").slice(lines[index - 1]?.end ?? 0, line.start),
    )))).toEqual([true, true]);
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
