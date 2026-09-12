import type { CanvasNode } from "./editor-protocol";
import { lineSelectionBounds } from "./marquee-selection";
import { transformPoint, worldTransformForNode, type AffineMatrix, type TransformBounds } from "./scene-transform";
import { connectorPathForNode } from "./connector-path";
import { connectorPresentationBounds } from "./connector-presentation";

/** World render bounds for a Line include its stroke/cap/marker envelope, not
 * only its zero-height path geometry. Canvas culling and selection must use
 * this exact envelope for Legacy and Relative-v1 transforms alike. */
export function worldLineVisualBounds(nodes: readonly CanvasNode[], node: CanvasNode, precomputedTransform?: AffineMatrix): TransformBounds | undefined {
  if (node.kind !== "line" && node.kind !== "connector") return undefined;
  const transform = precomputedTransform ?? worldTransformForNode(nodes, node.id);
  if (!transform) return undefined;
  const path = node.kind === "connector" ? connectorPathForNode(node) : undefined;
  const local = path
    ? (() => { const bounds = connectorPresentationBounds(node, path, Math.max(4, node.strokeWidth / 2)); return { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }; })()
    : lineSelectionBounds(node);
  const corners = [
    { x: local.x, y: local.y }, { x: local.x + local.width, y: local.y },
    { x: local.x + local.width, y: local.y + local.height }, { x: local.x, y: local.y + local.height },
  ].map((point) => transformPoint(transform, point));
  return {
    left: Math.min(...corners.map((point) => point.x)), top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)), bottom: Math.max(...corners.map((point) => point.y)),
  };
}
