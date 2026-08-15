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
});
