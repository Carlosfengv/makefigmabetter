import { describe, expect, it } from "vitest";
import { patchTextStyleRuns, rebaseTextStyleRuns, replacementByteRange, unicodeScalarText } from "./text-style-run-edit";

const properties = {
  runs: [
    { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
    { start: 1, end: 5, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
    { start: 5, end: 6, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
  ],
  paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
  autoSize: "fixed" as const,
};

describe("text style run replacement", () => {
  it("normalizes isolated UTF-16 surrogate code units before they reach Canonical text", () => {
    expect(unicodeScalarText("A\ud83dB\udc00C😀")).toBe("A�B�C😀");
  });

  it("retains untouched UTF-8 runs and inherits the selection-start style for inserted text", () => {
    expect(rebaseTextStyleRuns("A😀B", "A中B", properties).runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 4, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
      { start: 4, end: 5, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
    ]);
  });

  it("uses the selection-start style for an insertion at a run boundary", () => {
    const next = rebaseTextStyleRuns("AB", "A!B", {
      ...properties,
      runs: [
        { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 1, end: 2, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
      ],
    });
    expect(next.runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 3, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
    ]);
  });

  it("finds replacement ranges without splitting surrogate pairs", () => {
    expect(replacementByteRange("A😀B", "A中B")).toEqual({ beforeStart: 1, beforeEnd: 5, afterEnd: 4 });
  });

  it("patches only the selected UTF-8 run interval", () => {
    expect(patchTextStyleRuns("A😀B", properties, 1, 5, { fontSize: 28, italic: false }).runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 5, fontSize: 28, fontWeight: 700, italic: false, letterSpacing: 1 },
      { start: 5, end: 6, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
    ]);
  });

  it("does not merge adjacent runs with different colors", () => {
    const color = { space: "srgb" as const, components: [1, 0, 0] as [number, number, number], alpha: 1 };
    const result = rebaseTextStyleRuns("AB", "A!B", {
      ...properties,
      runs: [
        { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, color },
        { start: 1, end: 2, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      ],
    });
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].color).toEqual(color);
    expect(result.runs[1].color).toBeUndefined();
  });

  it("keeps hyperlink boundaries and inherits the adjacent target on insertion", () => {
    const result = rebaseTextStyleRuns("AB", "A!B", {
      ...properties,
      runs: [
        { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: { type: "URL", value: "https://a.example" } as const },
        { start: 1, end: 2, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: { type: "NODE", value: "1:2" } as const },
      ],
    });
    expect(result.runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: { type: "URL", value: "https://a.example" } },
      { start: 1, end: 3, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: { type: "NODE", value: "1:2" } },
    ]);
  });

  it("keeps text-decoration boundaries and inherits the adjacent decoration", () => {
    const result = rebaseTextStyleRuns("AB", "A!B", {
      ...properties,
      runs: [
        { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, textDecoration: "underline", textDecorationStyle: "wavy", textDecorationOffset: { value: 2, unit: "pixels" }, textDecorationThickness: { value: 2, unit: "pixels" } },
        { start: 1, end: 2, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, textDecoration: "strikethrough", textDecorationStyle: "dotted", textDecorationOffset: { value: -20, unit: "percent" }, textDecorationThickness: { value: 10, unit: "percent" } },
      ],
    });
    expect(result.runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, textDecoration: "underline", textDecorationStyle: "wavy", textDecorationOffset: { value: 2, unit: "pixels" }, textDecorationThickness: { value: 2, unit: "pixels" } },
      { start: 1, end: 3, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, textDecoration: "strikethrough", textDecorationStyle: "dotted", textDecorationOffset: { value: -20, unit: "percent" }, textDecorationThickness: { value: 10, unit: "percent" } },
    ]);
  });

  it("rebases sparse paragraph indentation when list paragraphs split and merge", () => {
    const listProperties = {
      runs: [{ start: 0, end: 7, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType: "ordered" as const },
      paragraphStyleRuns: [{ start: 4, indentation: 2 }],
      autoSize: "fixed" as const,
    };
    expect(rebaseTextStyleRuns("One\nTwo", "One\nT\nwo", listProperties).paragraphStyleRuns).toEqual([
      { start: 4, indentation: 2 },
      { start: 6, indentation: 2 },
    ]);
    expect(rebaseTextStyleRuns("One\nTwo", "OneTwo", listProperties).paragraphStyleRuns).toBeUndefined();
  });

  it("rebases an explicit per-paragraph list override at its UTF-8 paragraph boundary", () => {
    const listProperties = {
      runs: [{ start: 0, end: 7, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType: "ordered" as const },
      paragraphStyleRuns: [{ start: 4, listType: "none" as const }],
      autoSize: "fixed" as const,
    };
    expect(rebaseTextStyleRuns("One\nTwo", "One!\nTwo", listProperties).paragraphStyleRuns).toEqual([
      { start: 5, listType: "none" },
    ]);
  });

  it("rebases explicit per-paragraph list spacing when paragraphs split and merge", () => {
    const listProperties = {
      runs: [{ start: 0, end: 7, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType: "ordered" as const, listSpacing: 8 },
      paragraphStyleRuns: [{ start: 4, listSpacing: 0 }],
      autoSize: "fixed" as const,
    };
    expect(rebaseTextStyleRuns("One\nTwo", "One\nT\nwo", listProperties).paragraphStyleRuns).toEqual([
      { start: 4, listSpacing: 0 },
      { start: 6, listSpacing: 0 },
    ]);
    expect(rebaseTextStyleRuns("One\nTwo", "OneTwo", listProperties).paragraphStyleRuns).toBeUndefined();
  });

  it("rebases explicit per-paragraph paragraph spacing when paragraphs split and merge", () => {
    const properties = {
      runs: [{ start: 0, end: 7, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 8 },
      paragraphStyleRuns: [{ start: 4, paragraphSpacing: 0 }],
      autoSize: "fixed" as const,
    };
    expect(rebaseTextStyleRuns("One\nTwo", "One\nT\nwo", properties).paragraphStyleRuns).toEqual([
      { start: 4, paragraphSpacing: 0 },
      { start: 6, paragraphSpacing: 0 },
    ]);
    expect(rebaseTextStyleRuns("One\nTwo", "OneTwo", properties).paragraphStyleRuns).toBeUndefined();
  });

  it("rebases explicit per-paragraph first-line indentation when paragraphs split and merge", () => {
    const properties = {
      runs: [{ start: 0, end: 7, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, paragraphIndent: 8 },
      paragraphStyleRuns: [{ start: 4, paragraphIndent: 0 }],
      autoSize: "fixed" as const,
    };
    expect(rebaseTextStyleRuns("One\nTwo", "One\nT\nwo", properties).paragraphStyleRuns).toEqual([
      { start: 4, paragraphIndent: 0 },
      { start: 6, paragraphIndent: 0 },
    ]);
    expect(rebaseTextStyleRuns("One\nTwo", "OneTwo", properties).paragraphStyleRuns).toBeUndefined();
  });

  it("rebases explicit per-paragraph line-height units when paragraphs split and merge", () => {
    const properties = {
      runs: [{ start: 0, end: 7, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, lineHeight: 20, paragraphSpacing: 0 },
      paragraphStyleRuns: [{ start: 4, lineHeightUnit: "auto" as const }],
      autoSize: "fixed" as const,
    };
    expect(rebaseTextStyleRuns("One\nTwo", "One\nT\nwo", properties).paragraphStyleRuns).toEqual([
      { start: 4, lineHeightUnit: "auto" },
      { start: 6, lineHeightUnit: "auto" },
    ]);
    expect(rebaseTextStyleRuns("One\nTwo", "OneTwo", properties).paragraphStyleRuns).toBeUndefined();
  });

  it("rebases explicit per-paragraph wrap styles when paragraphs split and merge", () => {
    const properties = {
      runs: [{ start: 0, end: 7, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, textWrapStyle: "balance" as const },
      paragraphStyleRuns: [{ start: 4, textWrapStyle: "auto" as const }],
      autoSize: "fixed" as const,
    };
    expect(rebaseTextStyleRuns("One\nTwo", "One\nT\nwo", properties).paragraphStyleRuns).toEqual([
      { start: 4, textWrapStyle: "auto" },
      { start: 6, textWrapStyle: "auto" },
    ]);
    expect(rebaseTextStyleRuns("One\nTwo", "OneTwo", properties).paragraphStyleRuns).toBeUndefined();
  });
});
