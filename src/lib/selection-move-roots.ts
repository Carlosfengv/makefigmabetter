import type { CanvasNode } from "./editor-protocol";

/**
 * Returns exactly the nodes that need an explicit world-translation patch for
 * a selection drag. Relative-v1 descendants inherit their selected ancestor's
 * matrix and therefore must not receive the delta a second time; legacy
 * descendants retain world coordinates and still need an explicit patch.
 *
 * This deliberately reads Canonical document nodes. Render projections flatten
 * `relativeTransform`, which made a dragged Group move its modern children
 * twice even though the canvas visually showed them as ordinary shapes.
 */
export function movableSelectionIds(nodes: readonly CanvasNode[], selection: readonly string[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, CanvasNode[]>();
  nodes.forEach((node) => {
    if (!node.parentId) return;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  });
  const movable = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, parentMoves: boolean) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return;
    if (!(parentMoves && node.relativeTransform)) movable.add(id);
    children.get(id)?.forEach((child) => visit(child.id, true));
  };
  selection.forEach((id) => visit(id, false));
  return movable;
}
