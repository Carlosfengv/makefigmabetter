import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import type { RustTextLayout } from "./rust-text-layout";
import { shapedTextLineMetrics } from "./shaped-text-line-metrics";

const layout: RustTextLayout = { unitsPerEm: 1_000, lines: [
  { start: 0, end: 1, direction: "ltr", advance: 500, visualRuns: [], glyphs: [] },
  { start: 2, end: 3, direction: "ltr", advance: 500, visualRuns: [], glyphs: [] },
] };

describe("shaped text line metrics", () => {
  it("combines paragraph spacing and per-paragraph line height", () => {
    const node = {
      ...createNode("text", 0, 0), text: "A\nB",
      textProperties: {
        runs: [{ start: 0, end: 3, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left" as const, lineHeight: 12, paragraphSpacing: 5 },
        paragraphStyleRuns: [{ start: 2, lineHeight: 20 }],
        autoSize: "fixed" as const,
      },
    };
    expect(shapedTextLineMetrics(node, layout, 10, 12)).toEqual({ tops: [0, 17], heights: [12, 20], totalHeight: 37 });
  });

  it("rejects shaped ranges outside the source", () => {
    const node = { ...createNode("text", 0, 0), text: "A" };
    expect(shapedTextLineMetrics(node, { ...layout, lines: [{ ...layout.lines[0]!, end: 2 }] }, 10, 12)).toBeUndefined();
  });
});
