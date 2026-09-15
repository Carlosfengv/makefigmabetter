import { describe, expect, it } from "vitest";
import { createNode, FIGMA_REST_SHAPE_WITH_TEXT_TYPES, SHAPE_WITH_TEXT_TYPES } from "./editor-protocol";
import { nodeContainsWorldPoint } from "./hit-test";
import { specialNodeFallback } from "./special-node-fallback";
import { shapeWithTextContains, shapeWithTextDecorationPathD, shapeWithTextDecorations, shapeWithTextPath, shapeWithTextPathD, traceShapeWithTextDecorations } from "./shape-with-text-path";
import { exportPageToSvg } from "./svg-export";

const pageId = "00000000-0000-4000-8000-00000000d001";

describe("M6 ShapeWithText geometry", () => {
  it("shares a native hexagon contour across Canvas hit testing and SVG", () => {
    const node = {
      ...createNode("shapeWithText", 20, 30),
      id: "00000000-0000-4000-8000-00000000d002",
      pageId,
      width: 200,
      height: 120,
      shapeWithTextType: "HEXAGON" as const,
      text: "Decision",
      textProperties: {
        runs: [{ start: 0, end: 8, fontSize: 18, fontWeight: 650, italic: true, letterSpacing: 1.5 }],
        paragraph: { alignment: "center" as const, lineHeight: 24, paragraphSpacing: 4 },
        autoSize: "fixed" as const,
      },
    };
    const path = shapeWithTextPath(node.shapeWithTextType, node.width, node.height)!;
    expect(shapeWithTextPathD(path, (value) => String(value))).toBe("M 36 0 L 164 0 L 200 60 L 164 120 L 36 120 L 0 60 Z");
    expect(shapeWithTextContains(node.shapeWithTextType, node.width, node.height, { x: 100, y: 60 })).toBe(true);
    expect(shapeWithTextContains(node.shapeWithTextType, node.width, node.height, { x: 5, y: 5 })).toBe(false);
    expect(nodeContainsWorldPoint(node, { x: 120, y: 90 })).toBe(true);
    expect(nodeContainsWorldPoint(node, { x: 25, y: 35 })).toBe(false);
    expect(specialNodeFallback(node, "canvas")).toBeUndefined();

    const exported = exportPageToSvg([node], { pageId, defaultPageId: pageId, padding: 0 });
    expect(exported.svg).toContain('d="M 36 0 L 164 0 L 200 60 L 164 120 L 36 120 L 0 60 Z"');
    expect(exported.svg).toContain('font-size="18" font-weight="650" font-style="italic" letter-spacing="1.5"');
    expect(exported.svg).toContain('text-anchor="middle"');
  });

  it("covers every Canonical ShapeWithText silhouette through the shared geometry boundary", () => {
    expect(SHAPE_WITH_TEXT_TYPES).toHaveLength(30);
    expect(FIGMA_REST_SHAPE_WITH_TEXT_TYPES).toHaveLength(29);
    expect(FIGMA_REST_SHAPE_WITH_TEXT_TYPES).not.toContain("TRIANGLE_UP");
    expect(shapeWithTextContains("PLUS", 100, 100, { x: 50, y: 50 })).toBe(true);
    expect(shapeWithTextContains("PLUS", 100, 100, { x: 5, y: 5 })).toBe(false);
    expect(shapeWithTextPath("ARROW_RIGHT", 160, 80)?.kind).toBe("polygon");
    expect(shapeWithTextPath("STAR", 160, 80)?.kind).toBe("polygon");
    expect(shapeWithTextContains("SPEECH_BUBBLE", 160, 80, { x: 80, y: 30 })).toBe(true);
    expect(shapeWithTextContains("SPEECH_BUBBLE", 160, 80, { x: 150, y: 76 })).toBe(false);
    SHAPE_WITH_TEXT_TYPES.forEach((type) => expect(specialNodeFallback({ ...createNode("shapeWithText", 0, 0), shapeWithTextType: type }, "canvas")).toBeUndefined());
    expect(specialNodeFallback({ ...createNode("shapeWithText", 0, 0), shapeWithTextType: "STAR" }, "canvas")).toBeUndefined();
  });

  it("keeps leading whitespace aligned with UTF-8 TextSublayer style runs in SVG", () => {
    const node = {
      ...createNode("shapeWithText", 0, 0),
      id: "00000000-0000-4000-8000-00000000d004",
      pageId,
      width: 160,
      height: 80,
      text: " A中",
      textProperties: {
        runs: [
          { start: 0, end: 1, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0 },
          { start: 1, end: 2, fontSize: 14, fontWeight: 500, italic: false, letterSpacing: 0 },
          { start: 2, end: 5, fontSize: 20, fontWeight: 700, italic: false, letterSpacing: 1 },
        ],
        paragraph: { alignment: "center" as const, lineHeight: 24, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };

    const exported = exportPageToSvg([node], { pageId, defaultPageId: pageId, padding: 0 });
    expect(exported.svg).toContain('font-size="10" font-weight="400" font-style="normal" letter-spacing="0"> </tspan>');
    expect(exported.svg).toContain('font-size="20" font-weight="700" font-style="normal" letter-spacing="1">中</tspan>');
  });

  it("shares standard process and engineering interior marks between Canvas geometry and SVG", () => {
    const processMarks = shapeWithTextDecorations("PREDEFINED_PROCESS", 200, 120);
    expect(processMarks).toHaveLength(2);
    expect(shapeWithTextDecorationPathD(processMarks[0]!, String)).toBe("M 24 0 L 24 120");
    const databaseMarks = shapeWithTextDecorations("ENG_DATABASE", 200, 120);
    expect(databaseMarks).toHaveLength(2);
    expect(shapeWithTextDecorationPathD(databaseMarks[0]!, String)).toContain("C");

    const node = { ...createNode("shapeWithText", 0, 0), id: "00000000-0000-4000-8000-00000000d003", pageId, width: 200, height: 120, shapeWithTextType: "PREDEFINED_PROCESS" as const };
    const exported = exportPageToSvg([node], { pageId, defaultPageId: pageId, padding: 0 });
    expect(exported.svg).toContain('d="M 24 0 L 24 120"');
    expect(exported.svg).toContain('d="M 176 0 L 176 120"');
  });

  it("traces the same interior geometry for Canvas without changing the hit contour", () => {
    const calls: string[] = [];
    const context = {
      beginPath: () => calls.push("begin"),
      moveTo: (x: number, y: number) => calls.push(`M ${x} ${y}`),
      lineTo: (x: number, y: number) => calls.push(`L ${x} ${y}`),
      bezierCurveTo: (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => calls.push(`C ${x1} ${y1} ${x2} ${y2} ${x} ${y}`),
    };
    expect(traceShapeWithTextDecorations(context, "INTERNAL_STORAGE", 200, 120)).toBe(true);
    expect(calls).toEqual(["begin", "M 28.000000000000004 0", "L 28.000000000000004 120", "M 0 24", "L 200 24"]);
    expect(shapeWithTextContains("INTERNAL_STORAGE", 200, 120, { x: 4, y: 4 })).toBe(true);
  });
});
