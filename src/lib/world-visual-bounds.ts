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
  if (node.kind === "line") return withDropShadow(nodes, node, worldLineVisualBounds(nodes, node));
  const localBounds = closedShapeStrokeLocalBounds(node);
  if (!localBounds) return withDropShadow(nodes, node, worldBoundsForNode(nodes, node));
  const transform = worldTransformForNode(nodes, node.id);
  if (!transform) return undefined;
  const corners = [
    { x: localBounds.x, y: localBounds.y }, { x: localBounds.x + localBounds.width, y: localBounds.y },
    { x: localBounds.x + localBounds.width, y: localBounds.y + localBounds.height }, { x: localBounds.x, y: localBounds.y + localBounds.height },
  ].map((point) => transformPoint(transform, point));
  return withDropShadow(nodes, node, {
    left: Math.min(...corners.map((point) => point.x)), top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)), bottom: Math.max(...corners.map((point) => point.y)),
  });
}

/** Canvas has no spread property, but its shadow footprint and our export
 * envelope use the same conservative approximation: blur plus positive spread.
 * Offset follows the node's affine axes, so rotated nodes cannot clip a shadow. */
function withDropShadow(nodes: readonly CanvasNode[], node: CanvasNode, bounds: TransformBounds | undefined): TransformBounds | undefined {
  const shadows = (node.effectStack?.map((effect) => effect.dropShadow).filter((shadow): shadow is NonNullable<CanvasNode["dropShadow"]> => Boolean(shadow)) ?? (node.dropShadow ? [node.dropShadow] : []))
    .filter((shadow) => shadow.visible && shadow.color.alpha > 0);
  if (!bounds || !shadows.length) return bounds;
  const transform = worldTransformForNode(nodes, node.id);
  if (!transform) return bounds;
  const scale = Math.max(Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d));
  return shadows.reduce((result, shadow) => {
    const offsetX = transform.a * shadow.offsetX + transform.c * shadow.offsetY;
    const offsetY = transform.b * shadow.offsetX + transform.d * shadow.offsetY;
    const extent = (Math.max(0, shadow.blurRadius) + Math.max(0, shadow.spread)) * scale;
    return {
      left: Math.min(result.left, bounds.left + offsetX - extent),
      top: Math.min(result.top, bounds.top + offsetY - extent),
      right: Math.max(result.right, bounds.right + offsetX + extent),
      bottom: Math.max(result.bottom, bounds.bottom + offsetY + extent),
    };
  }, bounds);
}
