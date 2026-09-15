import { describe, expect, it } from "vitest";
import type { DocumentTextProperties } from "../lib/editor-protocol";
import { isRuntimeError } from "./runtime-errors";
import { runtimeStyledTextSegments } from "./runtime-styled-text-segments";

const defaults = { fontSize: 31, fontWeight: 400, italic: false, letterSpacing: 0, lineHeight: 20 } as const;
const fallbackFills = [{
  type: "SOLID" as const,
  color: { r: 0, g: 0, b: 0 },
  visible: true,
  opacity: 1,
  blendMode: "NORMAL" as const,
}];

const properties: DocumentTextProperties = {
  runs: [
    { start: 0, end: 6, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, textDecoration: "underline" },
    { start: 6, end: 8, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1, textCase: "upper" },
  ],
  paragraph: {
    alignment: "left",
    lineHeightUnit: "auto",
    paragraphSpacing: 3,
    paragraphIndent: 2,
    textWrapStyle: "balance",
    listType: "ordered",
    listSpacing: 4,
  },
  paragraphStyleRuns: [{
    start: 6,
    listType: "none",
    listSpacing: 0,
    indentation: 0,
    paragraphSpacing: 9,
    paragraphIndent: 0,
    lineHeight: 150,
    lineHeightUnit: "percent",
    textWrapStyle: "auto",
  }],
  autoSize: "fixed",
};

describe("runtimeStyledTextSegments", () => {
  it("merges character and paragraph runs while returning UTF-16 indexes", () => {
    expect(runtimeStyledTextSegments(
      "A😀\nBC",
      properties,
      ["fontSize", "fontWeight", "fontStyle", "textDecoration", "lineHeight", "listOptions", "listSpacing", "indentation", "paragraphIndent", "paragraphSpacing", "textWrapStyle", "textCase"],
      fallbackFills,
      defaults,
    )).toEqual([
      {
        characters: "A😀\n",
        start: 0,
        end: 4,
        fontSize: 12,
        fontWeight: 400,
        fontStyle: "REGULAR",
        textDecoration: "UNDERLINE",
        lineHeight: { unit: "AUTO" },
        listOptions: { type: "ORDERED" },
        listSpacing: 4,
        indentation: 1,
        paragraphIndent: 2,
        paragraphSpacing: 3,
        textWrapStyle: "BALANCE",
        textCase: "ORIGINAL",
      },
      {
        characters: "BC",
        start: 4,
        end: 6,
        fontSize: 20,
        fontWeight: 700,
        fontStyle: "ITALIC",
        textDecoration: "NONE",
        lineHeight: { value: 150, unit: "PERCENT" },
        listOptions: { type: "NONE" },
        listSpacing: 0,
        indentation: 0,
        paragraphIndent: 0,
        paragraphSpacing: 9,
        textWrapStyle: "AUTO",
        textCase: "UPPER",
      },
    ]);
  });

  it("splits and merges using only requested fields and clips the requested range", () => {
    expect(runtimeStyledTextSegments("A😀\nBC", properties, ["listOptions"], fallbackFills, defaults)).toEqual([
      { characters: "A😀\n", start: 0, end: 4, listOptions: { type: "ORDERED" } },
      { characters: "BC", start: 4, end: 6, listOptions: { type: "NONE" } },
    ]);
    expect(runtimeStyledTextSegments("A😀\nBC", properties, ["fontSize"], fallbackFills, defaults, 1, 4)).toEqual([
      { characters: "😀\n", start: 1, end: 4, fontSize: 12 },
    ]);
  });

  it("returns deterministic empty style and binding fields", () => {
    expect(runtimeStyledTextSegments(
      "A😀\nBC",
      properties,
      ["textStyleId", "fillStyleId", "openTypeFeatures", "boundVariables", "textStyleOverrides"],
      fallbackFills,
      defaults,
    )).toEqual([{
      characters: "A😀\nBC",
      start: 0,
      end: 6,
      textStyleId: "",
      fillStyleId: "",
      openTypeFeatures: {},
      boundVariables: undefined,
      textStyleOverrides: [],
    }]);
  });

  it("projects the supported character values without exposing Canonical objects", () => {
    const [segment] = runtimeStyledTextSegments(
      "A😀\nBC",
      properties,
      ["fontName", "letterSpacing", "fills", "hyperlink", "textDecorationStyle", "textDecorationOffset", "textDecorationThickness", "textDecorationColor", "textDecorationSkipInk"],
      fallbackFills,
      defaults,
      0,
      1,
    );
    expect(segment).toEqual({
      characters: "A",
      start: 0,
      end: 1,
      fontName: { family: "Inter", style: "Regular" },
      letterSpacing: { value: 0, unit: "PIXELS" },
      fills: fallbackFills,
      hyperlink: null,
      textDecorationStyle: "SOLID",
      textDecorationOffset: { unit: "AUTO" },
      textDecorationThickness: { unit: "AUTO" },
      textDecorationColor: { value: "AUTO" },
      textDecorationSkipInk: false,
    });
    ((segment!.fills as unknown) as Array<{ opacity: number }>)[0]!.opacity = .25;
    expect(runtimeStyledTextSegments("A😀\nBC", properties, ["fills"], fallbackFills, defaults, 0, 1)[0]!.fills[0]!.opacity).toBe(1);
  });

  it("keeps a large alternating run query ordered without recursive or per-segment rescans", () => {
    const length = 4_096;
    const text = "a".repeat(length);
    const manyRuns: DocumentTextProperties = {
      runs: Array.from({ length }, (_, index) => ({
        start: index,
        end: index + 1,
        fontSize: index % 2 ? 12 : 13,
        fontWeight: 400,
        italic: false,
        letterSpacing: 0,
      })),
      paragraph: { alignment: "left", paragraphSpacing: 0 },
      autoSize: "fixed",
    };
    const segments = runtimeStyledTextSegments(text, manyRuns, ["fontSize"], fallbackFills, defaults);
    expect(segments).toHaveLength(length);
    expect(segments[0]).toEqual({ characters: "a", start: 0, end: 1, fontSize: 13 });
    expect(segments[length - 1]).toEqual({ characters: "a", start: length - 1, end: length, fontSize: 12 });
  });

  it("rejects partial optional ranges, surrogate splits, and unknown fields", () => {
    const capture = (callback: () => unknown) => {
      try { callback(); } catch (error) { return error; }
      return undefined;
    };
    expect(isRuntimeError(capture(() => runtimeStyledTextSegments("A😀", undefined, ["fontSize"], fallbackFills, defaults, 1)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => runtimeStyledTextSegments("A😀", undefined, ["fontSize"], fallbackFills, defaults, 2, 3)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => runtimeStyledTextSegments("A", undefined, ["bogus" as never], fallbackFills, defaults)), "INVALID_ARGUMENT")).toBe(true);
    expect(runtimeStyledTextSegments("", undefined, ["fontSize"], fallbackFills, defaults)).toEqual([]);
  });
});
