import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import type { RustTextLayout } from "./rust-text-layout";
import { shapedTextFirstLineIndents, shapedTextLineBoxes } from "./shaped-text-line-boxes";

const layout: RustTextLayout = { unitsPerEm: 1_000, lines: [
  { start: 0, end: 1, direction: "ltr", advance: 500, visualRuns: [], glyphs: [] },
  { start: 1, end: 3, direction: "ltr", advance: 500, visualRuns: [], glyphs: [] },
  { start: 4, end: 5, direction: "ltr", advance: 500, visualRuns: [], glyphs: [] },
] };

describe("shaped text line boxes", () => {
  it("uses effective paragraph indents only on first visual lines", () => {
    const node = {
      ...createNode("text", 0, 0), text: "ABC\nD",
      textProperties: {
        runs: [{ start: 0, end: 5, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left" as const, lineHeight: 12, paragraphSpacing: 0, paragraphIndent: 10 },
        paragraphStyleRuns: [{ start: 4, paragraphIndent: 20 }],
        autoSize: "fixed" as const,
      },
    };
    expect(shapedTextFirstLineIndents(node)).toEqual([10, 20]);
    expect(shapedTextLineBoxes(node, layout, 100)).toEqual({
      xOffsets: [10, 0, 20],
      widths: [90, 100, 80],
    });
  });

  it("fails closed for malformed shaped ranges and widths", () => {
    const node = { ...createNode("text", 0, 0), text: "A" };
    expect(shapedTextLineBoxes(node, { ...layout, lines: [{ ...layout.lines[0]!, end: 2 }] }, 100)).toBeUndefined();
    expect(shapedTextLineBoxes(node, { ...layout, lines: [] }, 0)).toBeUndefined();
  });
});
