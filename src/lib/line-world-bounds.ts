import type { CanvasNode } from "./editor-protocol";
import { lineSelectionBounds } from "./marquee-selection";
import { transformPoint, worldTransformForNode, type AffineMatrix, type TransformBounds } from "./scene-transform";
import { connectorPathForNode } from "./connector-path";
import { connectorPresentationBounds } from "./connector-presentation";

export type WorldLineVisualBoundsContext = Readonly<{
  transform?: AffineMatrix;
  defaultPageId?: string;
  nodeById?: ReadonlyMap<string, CanvasNode>;
  worldTransformByNodeId?: ReadonlyMap<string, AffineMatrix>;
}>;

/** World render bounds for a Line include its stroke/cap/marker envelope, not
 * only its zero-height path geometry. Canvas culling and selection must use
 * this exact envelope for Legacy and Relative-v1 transforms alike. */
export function worldLineVisualBounds(nodes: readonly CanvasNode[], node: CanvasNode, precomputed?: WorldLineVisualBoundsContext): TransformBounds | undefined {
  if (node.kind !== "line" && node.kind !== "connector") return undefined;
  const transform = precomputed?.transform ?? worldTransformForNode(nodes, node.id);
  if (!transform) return undefined;
  const path = node.kind === "connector" ? connectorPathForNode(node, {
    nodes,
    defaultPageId: precomputed?.defaultPageId,
    nodeById: precomputed?.nodeById,
    worldTransformByNodeId: precomputed?.worldTransformByNodeId,
  }) : undefined;
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
