import type { CanvasNode } from "./editor-protocol";

export type LocalShapeBounds = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * The visual local envelope for a closed shape whose aligned Stroke extends
 * beyond GeometryProps. Canvas selection/hover/handles, world culling and
 * export all consume this exact result before applying a transform.
 */
export function closedShapeStrokeLocalBounds(node: CanvasNode): LocalShapeBounds | undefined {
  const isFullEllipse = node.kind === "ellipse" && !node.arcData;
  const isRectangular = node.kind === "frame" || node.kind === "rectangle";
  const align = node.strokeAlign ?? "inside";
  if ((!isFullEllipse && !isRectangular) || node.strokeWidth <= 0 || align === "inside") return undefined;
  const multiplier = align === "outside" ? 1 : .5;
  const weights = isRectangular && node.strokeWeights?.length === 4
    ? node.strokeWeights
    : [node.strokeWidth, node.strokeWidth, node.strokeWidth, node.strokeWidth];
  const [top, right, bottom, left] = weights.map((weight) => Math.max(0, weight) * multiplier);
  return { x: -left, y: -top, width: node.width + left + right, height: node.height + top + bottom };
}
