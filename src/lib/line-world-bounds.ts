import type { CanvasNode } from "./editor-protocol";
import { lineSelectionBounds } from "./marquee-selection";
import { transformPoint, worldTransformForNode, type TransformBounds } from "./scene-transform";

/** World render bounds for a Line include its stroke/cap/marker envelope, not
 * only its zero-height path geometry. Canvas culling and selection must use
 * this exact envelope for Legacy and Relative-v1 transforms alike. */
export function worldLineVisualBounds(nodes: readonly CanvasNode[], node: CanvasNode): TransformBounds | undefined {
  if (node.kind !== "line") return undefined;
  const transform = worldTransformForNode(nodes, node.id);
  if (!transform) return undefined;
  const local = lineSelectionBounds(node);
  const corners = [
    { x: local.x, y: local.y }, { x: local.x + local.width, y: local.y },
    { x: local.x + local.width, y: local.y + local.height }, { x: local.x, y: local.y + local.height },
  ].map((point) => transformPoint(transform, point));
  return {
    left: Math.min(...corners.map((point) => point.x)), top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)), bottom: Math.max(...corners.map((point) => point.y)),
  };
}
