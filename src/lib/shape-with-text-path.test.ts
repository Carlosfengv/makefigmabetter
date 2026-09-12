import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { nodeContainsWorldPoint } from "./hit-test";
import { specialNodeFallback } from "./special-node-fallback";
import { shapeWithTextContains, shapeWithTextDecorationPathD, shapeWithTextDecorations, shapeWithTextPath, shapeWithTextPathD, traceShapeWithTextDecorations } from "./shape-with-text-path";
import { exportPageToSvg } from "./svg-export";

const pageId = "00000000-0000-4000-8000-00000000d001";

describe("M6 ShapeWithText geometry", () => {
  it("shares a native hexagon contour across Canvas hit testing and SVG", () => {
    const node = { ...createNode("shapeWithText", 20, 30), id: "00000000-0000-4000-8000-00000000d002", pageId, width: 200, height: 120, shapeWithTextType: "HEXAGON" as const, text: "Decision" };
    const path = shapeWithTextPath(node.shapeWithTextType, node.width, node.height)!;
    expect(shapeWithTextPathD(path, (value) => String(value))).toBe("M 36 0 L 164 0 L 200 60 L 164 120 L 36 120 L 0 60 Z");
    expect(shapeWithTextContains(node.shapeWithTextType, node.width, node.height, { x: 100, y: 60 })).toBe(true);
    expect(shapeWithTextContains(node.shapeWithTextType, node.width, node.height, { x: 5, y: 5 })).toBe(false);
    expect(nodeContainsWorldPoint(node, { x: 120, y: 90 })).toBe(true);
    expect(nodeContainsWorldPoint(node, { x: 25, y: 35 })).toBe(false);
    expect(specialNodeFallback(node, "canvas")).toBeUndefined();

    const exported = exportPageToSvg([node], { pageId, defaultPageId: pageId, padding: 0 });
    expect(exported.svg).toContain('d="M 36 0 L 164 0 L 200 60 L 164 120 L 36 120 L 0 60 Z"');
  });

  it("covers every Canonical ShapeWithText silhouette through the shared geometry boundary", () => {
    expect(shapeWithTextContains("PLUS", 100, 100, { x: 50, y: 50 })).toBe(true);
    expect(shapeWithTextContains("PLUS", 100, 100, { x: 5, y: 5 })).toBe(false);
    expect(shapeWithTextPath("ARROW_RIGHT", 160, 80)?.kind).toBe("polygon");
    expect(shapeWithTextPath("STAR", 160, 80)?.kind).toBe("polygon");
    expect(shapeWithTextContains("SPEECH_BUBBLE", 160, 80, { x: 80, y: 30 })).toBe(true);
    expect(shapeWithTextContains("SPEECH_BUBBLE", 160, 80, { x: 150, y: 76 })).toBe(false);
    const allTypes = ["SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE"] as const;
    allTypes.forEach((type) => expect(specialNodeFallback({ ...createNode("shapeWithText", 0, 0), shapeWithTextType: type }, "canvas")).toBeUndefined());
    expect(specialNodeFallback({ ...createNode("shapeWithText", 0, 0), shapeWithTextType: "STAR" }, "canvas")).toBeUndefined();
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
