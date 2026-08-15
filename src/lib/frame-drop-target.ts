import type { CanvasNode } from "./editor-protocol";
import { invertAffine, transformPoint, worldTransformForNode } from "./scene-transform";

export type FrameDropTarget = Readonly<{
  frame: CanvasNode;
  isAutoLayout: boolean;
}>;

export type FrameExitTarget = Readonly<{
  /** The Frame being left. Kept for drag feedback and testable semantics. */
  frame: CanvasNode;
  /** The closest legal container after leaving that Frame. */
  parentId?: string;
}>;

function frameContainsPoint(nodes: readonly CanvasNode[], frame: CanvasNode, point: Readonly<{ x: number; y: number }>) {
  const world = worldTransformForNode(nodes, frame.id);
  const inverse = world && invertAffine(world);
  if (!inverse || frame.width <= 0 || frame.height <= 0) return false;
  const local = transformPoint(inverse, point);
  return local.x >= 0 && local.x <= frame.width && local.y >= 0 && local.y <= frame.height;
}

/**
 * Finds the deepest eligible Frame under a canvas drag. This deliberately
 * reads Canonical nodes instead of render projections: Relative-v1 children
 * may be painted in world space, but a drop must always respect their durable
 * hierarchy and affine transforms.
 */
export function frameDropTargetAtPoint(
  nodes: readonly CanvasNode[],
  movingIds: readonly string[],
  point: Readonly<{ x: number; y: number }>,
): FrameDropTarget | undefined {
  if (!movingIds.length || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const excluded = new Set<string>();

  // A Frame cannot become a child of itself or one of its descendants. Exclude
  // the full moved subtree so a Group/Frame drag never advertises an invalid
  // drop target below its own root.
  const visit = (id: string) => {
    if (excluded.has(id)) return;
    excluded.add(id);
    nodes.filter((node) => node.parentId === id).forEach((node) => visit(node.id));
  };
  movingIds.forEach(visit);

  const depth = (node: CanvasNode) => {
    let value = 0;
    const visited = new Set<string>();
    let cursor = node.parentId ? byId.get(node.parentId) : undefined;
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      value += 1;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return value;
  };
  const candidates = nodes
    .filter((node) => node.kind === "frame" && node.visible !== false && !node.locked && !excluded.has(node.id))
    .filter((frame) => frameContainsPoint(nodes, frame, point))
    // Re-dropping a layer into its existing parent has no placement effect.
    .filter((frame) => movingIds.some((id) => byId.get(id)?.parentId !== frame.id))
    .sort((left, right) => {
      const depthDelta = depth(right) - depth(left);
      if (depthDelta) return depthDelta;
      const areaDelta = left.width * left.height - right.width * right.height;
      if (areaDelta) return areaDelta;
      return left.id.localeCompare(right.id);
    });
  const frame = candidates[0];
  return frame ? { frame, isAutoLayout: frame.autoLayout?.mode === "horizontal" || frame.autoLayout?.mode === "vertical" } : undefined;
}

/**
 * Resolves the deliberate inverse of a Frame drop. When the moving roots all
 * belong to one Frame and the pointer leaves its bounds, reparent them to that
 * Frame's parent (or the page root) while the transaction preserves their
 * world transform. Returning nothing means the gesture should remain in its
 * current parent.
 */
export function frameExitTargetAtPoint(
  nodes: readonly CanvasNode[],
  movingIds: readonly string[],
  point: Readonly<{ x: number; y: number }>,
): FrameExitTarget | undefined {
  if (!movingIds.length || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const moving = new Set(movingIds);
  const roots = movingIds
    .map((id) => byId.get(id))
    .filter((node): node is CanvasNode => Boolean(node))
    .filter((node) => {
      let ancestor = node.parentId;
      const visited = new Set<string>();
      while (ancestor && !visited.has(ancestor)) {
        if (moving.has(ancestor)) return false;
        visited.add(ancestor);
        ancestor = byId.get(ancestor)?.parentId;
      }
      return true;
    });
  if (!roots.length) return undefined;
  const parentIds = new Set(roots.map((node) => node.parentId));
  if (parentIds.size !== 1) return undefined;
  const parentId = roots[0].parentId;
  const frame = parentId ? byId.get(parentId) : undefined;
  if (!frame || frame.kind !== "frame" || frameContainsPoint(nodes, frame, point)) return undefined;
  return { frame, parentId: frame.parentId };
}
