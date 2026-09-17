import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import type { RustTextLayout } from "./rust-text-layout";
import { shapedTextContinuationLineIndents, shapedTextFirstLineIndents, shapedTextLineBoxes, shapedTextParagraphWrapStyles } from "./shaped-text-line-boxes";

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
        paragraphStyleRuns: [{ start: 4, paragraphIndent: 20, textWrapStyle: "auto" as const }],
        autoSize: "fixed" as const,
      },
    };
    expect(shapedTextFirstLineIndents(node)).toEqual([10, 20]);
    expect(shapedTextParagraphWrapStyles({
      ...node,
      textProperties: {
        ...node.textProperties,
        paragraph: { ...node.textProperties.paragraph, textWrapStyle: "balance" as const },
      },
    })).toEqual(["balance", "auto"]);
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

  it("reserves marker and nesting columns while retaining continuation indents", () => {
    const node = {
      ...createNode("text", 0, 0), text: "ABC\nD",
      textProperties: {
        runs: [{ start: 0, end: 5, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left" as const, lineHeight: 12, paragraphSpacing: 0, paragraphIndent: 5, listType: "ordered" as const },
        paragraphStyleRuns: [{ start: 4, indentation: 2 }],
        autoSize: "fixed" as const,
      },
    };
    expect(shapedTextFirstLineIndents(node, node.text, 20)).toEqual([25, 45]);
    expect(shapedTextContinuationLineIndents(node, node.text, 20)).toEqual([0, 20]);
    expect(shapedTextLineBoxes(node, layout, 100, 20)).toEqual({
      xOffsets: [25, 0, 45],
      widths: [75, 100, 55],
    });
    const rtlLayout = { ...layout, lines: layout.lines.map((line) => ({ ...line, direction: "rtl" as const })) };
    expect(shapedTextLineBoxes(node, rtlLayout, 100, 20)).toEqual({
      xOffsets: [0, 0, 0],
      widths: [75, 100, 55],
    });
    expect(shapedTextFirstLineIndents({
      ...node,
      textProperties: { ...node.textProperties, paragraph: { ...node.textProperties.paragraph, hangingList: true } },
    }, node.text, 20)).toEqual([5, 25]);
  });
});
