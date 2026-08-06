import type { CanvasNode } from "./editor-protocol";
import { closedShapeStrokeLocalBounds } from "./closed-shape-stroke-bounds";
import { worldLineVisualBounds } from "./line-world-bounds";
import { transformPoint, worldBoundsForNode, worldTransformForNode, type TransformBounds } from "./scene-transform";

/**
 * The selection/culling/export envelope for common shapes. Line already owns
 * a precise cap/marker envelope; full Ellipse, Frame and Rectangle expand when
 * their visible Stroke is Center or Outside. The affine rectangle is
 * conservative for rotated shapes, which is desirable here: it must never
 * clip rendered paint.
 */
export function worldVisualBoundsForNode(nodes: readonly CanvasNode[], node: CanvasNode): TransformBounds | undefined {
  if (node.kind === "line") return worldLineVisualBounds(nodes, node);
  const localBounds = closedShapeStrokeLocalBounds(node);
  if (!localBounds) return worldBoundsForNode(nodes, node);
  const transform = worldTransformForNode(nodes, node.id);
  if (!transform) return undefined;
  const corners = [
    { x: localBounds.x, y: localBounds.y }, { x: localBounds.x + localBounds.width, y: localBounds.y },
    { x: localBounds.x + localBounds.width, y: localBounds.y + localBounds.height }, { x: localBounds.x, y: localBounds.y + localBounds.height },
  ].map((point) => transformPoint(transform, point));
  return {
    left: Math.min(...corners.map((point) => point.x)), top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)), bottom: Math.max(...corners.map((point) => point.y)),
  };
}
