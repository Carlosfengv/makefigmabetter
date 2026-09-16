import type { CanvasNode } from "./editor-protocol";
import { shapeWithTextContains } from "./shape-with-text-path";
import { hangingTextLocalBounds } from "./world-visual-bounds";

export type CanvasTextEditableNode = CanvasNode & {
  kind: "text" | "shapeWithText";
};

export type CanvasTextEditBox = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  verticallyCentered: boolean;
}>;

export function isCanvasTextEditableNode(
  node: CanvasNode,
): node is CanvasTextEditableNode {
  return node.kind === "text" || node.kind === "shapeWithText";
}

export function canvasTextEditBox(node: CanvasTextEditableNode): CanvasTextEditBox {
  if (node.kind === "shapeWithText") {
    const inset = 10;
    return {
      x: inset,
      y: inset,
      width: Math.max(1, node.width - inset * 2),
      height: Math.max(1, node.height - inset * 2),
      verticallyCentered: true,
    };
  }
  return {
    x: 0,
    y: 0,
    width: Math.max(1, node.width),
    height: Math.max(1, node.height),
    verticallyCentered: false,
  };
}

export function canvasTextEditLocalPoint(
  node: CanvasTextEditableNode,
  point: Readonly<{ x: number; y: number }>,
) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const radians = (-node.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  return {
    x: dx * cosine - dy * sine + node.width / 2,
    y: dx * sine + dy * cosine + node.height / 2,
  };
}

export function canvasTextEditContainsPoint(
  node: CanvasNode,
  point: Readonly<{ x: number; y: number }>,
) {
  if (!isCanvasTextEditableNode(node) || node.visible === false) return false;
  const local = canvasTextEditLocalPoint(node, point);
  const hangingBounds = hangingTextLocalBounds(node);
  if (hangingBounds && pointInBounds(local, hangingBounds)) return true;
  if (node.kind === "shapeWithText") {
    return shapeWithTextContains(
      node.shapeWithTextType,
      node.width,
      node.height,
      local,
    ) ?? pointInBounds(local, { x: 0, y: 0, width: node.width, height: node.height });
  }
  return pointInBounds(local, { x: 0, y: 0, width: node.width, height: node.height });
}

export function canvasTextEditFallbackFontSize(node: CanvasTextEditableNode) {
  return node.kind === "shapeWithText" ? 14 : 31;
}

/** Ordinary Text is fully replaced by the DOM editing host. ShapeWithText
 * keeps its Canvas-owned geometry and suppresses only its text sublayer. */
export function canvasTextEditingHidesWholeNode(
  node: CanvasNode,
  editingNodeId: string | undefined,
) {
  return node.id === editingNodeId && node.kind === "text";
}

function pointInBounds(
  point: Readonly<{ x: number; y: number }>,
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
) {
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}
