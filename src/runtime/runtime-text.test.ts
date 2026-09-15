import { describe, expect, it } from "vitest";
import { fontsForRuntimeTextRange, patchRuntimeParagraphLineHeight, patchRuntimeParagraphTextWrapStyle, patchRuntimeTextRange, replaceRuntimeTextRange, replaceRuntimeTextRangeWithStyles, runtimeParagraphLineHeightsForRange, runtimeParagraphTextWrapStylesForRange, runtimeTextRange, updateRuntimeText } from "./runtime-text";
import { isRuntimeError } from "./runtime-errors";

describe("M2 Runtime text adapter", () => {
  const font = { assetId: "font-1", faceIndex: 0 };
  const properties = {
    runs: [
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 8, font, fontSize: 14, fontWeight: 500, italic: false, letterSpacing: 0 },
    ],
    paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
    autoSize: "fixed" as const,
  };

  it("converts UTF-16 public ranges to scalar-aligned UTF-8 style ranges", () => {
    const patched = patchRuntimeTextRange("A😀中", properties, 1, 3, { fontSize: 20 });
    expect(patched.runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 5, font, fontSize: 20, fontWeight: 500, italic: false, letterSpacing: 0 },
      { start: 5, end: 8, font, fontSize: 14, fontWeight: 500, italic: false, letterSpacing: 0 },
    ]);
    expect(fontsForRuntimeTextRange("A😀中", properties, 1, 3)).toEqual([font]);
  });

  it("rebases complete style coverage when characters change", () => {
    const updated = updateRuntimeText("A😀中", "A界中", properties);
    expect(updated.characters).toBe("A界中");
    expect(updated.textProperties.runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 7, font, fontSize: 14, fontWeight: 500, italic: false, letterSpacing: 0 },
    ]);
  });

  it("replaces UTF-16 text ranges without splitting a surrogate pair", () => {
    expect(replaceRuntimeTextRange("A😀中", 1, 3, "界")).toBe("A界中");
    try {
      runtimeTextRange("A😀中", 2, 2);
      throw new Error("Expected an invalid UTF-16 boundary to reject");
    } catch (error) {
      expect(isRuntimeError(error, "INVALID_ARGUMENT")).toBe(true);
    }
  });

  it("uses the explicit range when repeated text makes diff inference ambiguous", () => {
    const repeated = {
      runs: [
        { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 1, end: 3, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 3, end: 4, fontSize: 30, fontWeight: 400, italic: false, letterSpacing: 0 },
      ],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
      autoSize: "fixed" as const,
    };
    const updated = replaceRuntimeTextRangeWithStyles("aaaa", repeated, 2, 2, "a");
    expect(updated.characters).toBe("aaaaa");
    expect(updated.textProperties.runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 4, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 4, end: 5, fontSize: 30, fontWeight: 400, italic: false, letterSpacing: 0 },
    ]);
  });

  it("selects the adjacent style requested by Figma insertCharacters at a run boundary", () => {
    const boundary = {
      runs: [
        { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 1, end: 2, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
      ],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
      autoSize: "fixed" as const,
    };

    expect(replaceRuntimeTextRangeWithStyles("AB", boundary, 1, 1, "x", { insertionStyle: "BEFORE" }).textProperties.runs).toEqual([
      { start: 0, end: 2, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 2, end: 3, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
    ]);
    expect(replaceRuntimeTextRangeWithStyles("AB", boundary, 1, 1, "x", { insertionStyle: "AFTER" }).textProperties.runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 3, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
    ]);
    for (const insertionStyle of ["BEFORE", "AFTER"] as const) {
      expect(replaceRuntimeTextRangeWithStyles("AB", boundary, 0, 0, "x", { insertionStyle }).textProperties.runs).toEqual([
        { start: 0, end: 2, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 2, end: 3, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
      ]);
      expect(replaceRuntimeTextRangeWithStyles("AB", boundary, 2, 2, "x", { insertionStyle }).textProperties.runs).toEqual([
        { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 1, end: 3, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
      ]);
    }
  });

  it("requires the BEFORE or AFTER adjacent font selected for a collapsed insertion", () => {
    const firstFont = { assetId: "font-0", faceIndex: 0 };
    const secondFont = { assetId: "font-2", faceIndex: 0 };
    const styled = {
      ...properties,
      runs: [
        { ...properties.runs[0]!, start: 0, end: 1, font: firstFont },
        { ...properties.runs[1]!, start: 1, end: 5, font: secondFont },
        { ...properties.runs[1]!, start: 5, end: 8, font: secondFont },
      ],
    };
    expect(fontsForRuntimeTextRange("A😀中", styled, 1, 1, "BEFORE")).toEqual([firstFont]);
    expect(fontsForRuntimeTextRange("A😀中", styled, 1, 1, "AFTER")).toEqual([secondFont]);
  });

  it("persists an empty-text base style and materializes it on insertion", () => {
    const styledEmpty = patchRuntimeTextRange("", undefined, 0, 0, {
      font,
      fontSize: 22,
      letterSpacing: 1.25,
      fillStack: { layers: [] },
    });
    expect(styledEmpty).toMatchObject({
      runs: [],
      baseStyle: { font, fontSize: 22, fontWeight: 400, italic: false, letterSpacing: 1.25, fillStack: { layers: [] } },
    });
    expect(fontsForRuntimeTextRange("", styledEmpty, 0, 0)).toEqual([font]);

    const inserted = replaceRuntimeTextRangeWithStyles("", styledEmpty, 0, 0, "Hi");
    expect(inserted.textProperties.runs).toEqual([{
      start: 0,
      end: 2,
      font,
      fontSize: 22,
      fontWeight: 400,
      italic: false,
      letterSpacing: 1.25,
      fillStack: { layers: [] },
    }]);

    const emptied = replaceRuntimeTextRangeWithStyles("Hi", inserted.textProperties, 0, 2, "");
    expect(emptied.textProperties.runs).toEqual([]);
    expect(emptied.textProperties.baseStyle).toEqual(styledEmpty.baseStyle);
  });

  it("stores paragraph line-height overrides atomically and collapses whole-text writes", () => {
    const source = "One\nTwo";
    const initial = { ...properties, runs: [{ ...properties.runs[0]!, start: 0, end: 7 }], paragraph: { ...properties.paragraph, lineHeight: 20 } };
    const mixed = patchRuntimeParagraphLineHeight(source, initial, 4, 7, { value: 150, unit: "PERCENT" });
    expect(mixed.paragraphStyleRuns).toEqual([{ start: 4, lineHeight: 150, lineHeightUnit: "percent" }]);
    expect(runtimeParagraphLineHeightsForRange(source, mixed, 0, 7)).toEqual([
      { value: 20, unit: "PIXELS" },
      { value: 150, unit: "PERCENT" },
    ]);
    const unified = patchRuntimeParagraphLineHeight(source, mixed, 0, 7, { unit: "AUTO" });
    expect(unified.paragraph).toMatchObject({ lineHeight: undefined, lineHeightUnit: "auto" });
    expect(unified.paragraphStyleRuns).toBeUndefined();
  });

  it("stores explicit paragraph wrap overrides and collapses whole-text writes", () => {
    const source = "One\nTwo";
    const initial = {
      ...properties,
      runs: [{ ...properties.runs[0]!, start: 0, end: 7 }],
      paragraph: { ...properties.paragraph, textWrapStyle: "balance" as const },
    };
    const mixed = patchRuntimeParagraphTextWrapStyle(source, initial, 4, 7, "auto");
    expect(mixed.paragraphStyleRuns).toEqual([{ start: 4, textWrapStyle: "auto" }]);
    expect(runtimeParagraphTextWrapStylesForRange(source, mixed, 0, 7)).toEqual(["balance", "auto"]);

    const unified = patchRuntimeParagraphTextWrapStyle(source, mixed, 0, 7, "pretty");
    expect(unified.paragraph.textWrapStyle).toBe("pretty");
    expect(unified.paragraphStyleRuns).toBeUndefined();
  });
});
