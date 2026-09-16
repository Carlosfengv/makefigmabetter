import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import {
  canvasTextEditBox,
  canvasTextEditContainsPoint,
  canvasTextEditFallbackFontSize,
  canvasTextEditLocalPoint,
  canvasTextEditingHidesWholeNode,
  isCanvasTextEditableNode,
} from "./canvas-text-edit";

describe("canvas text edit geometry", () => {
  it("admits Text and ShapeWithText while keeping unrelated text-bearing nodes staged", () => {
    expect(isCanvasTextEditableNode(createNode("text", 0, 0))).toBe(true);
    expect(isCanvasTextEditableNode(createNode("shapeWithText", 0, 0))).toBe(true);
    expect(isCanvasTextEditableNode(createNode("textPath", 0, 0))).toBe(false);
    expect(isCanvasTextEditableNode(createNode("sticky", 0, 0))).toBe(false);
  });

  it("uses the canonical ten-pixel ShapeWithText content inset", () => {
    const shape = {
      ...createNode("shapeWithText", 5, 7),
      kind: "shapeWithText" as const,
      width: 120,
      height: 80,
    };
    expect(canvasTextEditBox(shape)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 60,
      verticallyCentered: true,
    });
    expect(canvasTextEditFallbackFontSize(shape)).toBe(14);
  });

  it("hit-tests the actual rotated ShapeWithText silhouette", () => {
    const diamond = {
      ...createNode("shapeWithText", 10, 20),
      kind: "shapeWithText" as const,
      width: 100,
      height: 100,
      rotation: 90,
      shapeWithTextType: "DIAMOND" as const,
    };
    expect(canvasTextEditContainsPoint(diamond, { x: 60, y: 70 })).toBe(true);
    expect(canvasTextEditContainsPoint(diamond, { x: 12, y: 22 })).toBe(false);
    expect(canvasTextEditLocalPoint(diamond, { x: 60, y: 20 })).toEqual({ x: 0, y: 50 });
  });

  it("rejects hidden nodes and preserves ordinary Text bounds", () => {
    const text = { ...createNode("text", 10, 20), width: 50, height: 30 };
    expect(canvasTextEditContainsPoint(text, { x: 35, y: 35 })).toBe(true);
    expect(canvasTextEditContainsPoint(text, { x: 9, y: 35 })).toBe(false);
    expect(canvasTextEditContainsPoint({ ...text, visible: false }, { x: 35, y: 35 })).toBe(false);
  });

  it("keeps ShapeWithText geometry visible while its DOM text editor is open", () => {
    const text = createNode("text", 0, 0);
    const shape = createNode("shapeWithText", 0, 0);
    expect(canvasTextEditingHidesWholeNode(text, text.id)).toBe(true);
    expect(canvasTextEditingHidesWholeNode(shape, shape.id)).toBe(false);
    expect(canvasTextEditingHidesWholeNode(text, undefined)).toBe(false);
  });
});
