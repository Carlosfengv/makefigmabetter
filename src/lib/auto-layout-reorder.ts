import type { CanvasNode } from "./editor-protocol";
import { resolveLayerDrop, resolveLayerOrder, sortNodesByLayerOrder, type LayerOrderResult } from "./layer-order";

export type AutoLayoutReorder = Readonly<{
  /** The Auto layout Frame that owns the flow order. */
  frame: CanvasNode;
  /** Direct flow children whose relative order is being changed. */
  rootIds: string[];
  /** Undefined when the gesture/keystroke remains in the same slot. */
  result?: LayerOrderResult;
}>;

function flowScope(nodes: readonly CanvasNode[], movingIds: readonly string[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const moving = new Set(movingIds);
  const roots = movingIds
    .map((id) => byId.get(id))
    .filter((node): node is CanvasNode => Boolean(node))
    .filter((node) => {
      let parentId = node.parentId;
      const visited = new Set<string>();
      while (parentId && !visited.has(parentId)) {
        if (moving.has(parentId)) return false;
        visited.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
      return true;
    });
  if (!roots.length || roots.some((node) => node.locked || node.autoLayout?.absolute)) return undefined;
  const parentIds = new Set(roots.map((node) => node.parentId));
  if (parentIds.size !== 1) return undefined;
  const frame = roots[0].parentId ? byId.get(roots[0].parentId) : undefined;
  if (!frame || frame.kind !== "frame" || frame.locked || !["horizontal", "vertical"].includes(frame.autoLayout?.mode ?? "none")) return undefined;
  const flowChildren = sortNodesByLayerOrder(nodes.filter((node) => node.parentId === frame.id && !node.autoLayout?.absolute));
  const rootIds = roots.map((node) => node.id);
  if (!rootIds.every((id) => flowChildren.some((node) => node.id === id))) return undefined;
  return { frame, flowChildren, rootIds };
}

/**
 * Figma treats arrow keys on a selected Auto layout child as a request to move
 * that child along the container's flow, rather than a one-pixel geometry
 * nudge. `handled` remains true at an edge or on the cross axis so callers do
 * not fall back to manual positioning inside the layout.
 */
export function autoLayoutArrowReorder(
  nodes: readonly CanvasNode[],
  selectedIds: readonly string[],
  key: string,
): { handled: boolean; reorder?: AutoLayoutReorder } {
  const scope = flowScope(nodes, selectedIds);
  if (!scope) return { handled: false };
  const action = scope.frame.autoLayout!.mode === "horizontal"
    ? key === "ArrowLeft" ? "backward" : key === "ArrowRight" ? "forward" : undefined
    : key === "ArrowUp" ? "backward" : key === "ArrowDown" ? "forward" : undefined;
  return {
    handled: true,
    reorder: {
      frame: scope.frame,
      rootIds: scope.rootIds,
      ...(action ? { result: resolveLayerOrder(scope.flowChildren, scope.rootIds, action) } : {}),
    },
  };
}

/**
 * Finds the insertion slot for an on-canvas drag that remains in its current
 * Auto layout Frame. Pointer position is compared with siblings' primary-axis
 * midpoints, producing Figma's familiar before/between/after reordering.
 */
export function autoLayoutDropReorder(
  nodes: readonly CanvasNode[],
  movingIds: readonly string[],
  point: Readonly<{ x: number; y: number }>,
): AutoLayoutReorder | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  const scope = flowScope(nodes, movingIds);
  if (!scope) return undefined;
  const horizontal = scope.frame.autoLayout!.mode === "horizontal";
  const coordinate = horizontal ? point.x : point.y;
  const moving = new Set(scope.rootIds);
  const before = scope.flowChildren.find((node) => !moving.has(node.id) && coordinate < (horizontal ? node.x + node.width / 2 : node.y + node.height / 2));
  return {
    frame: scope.frame,
    rootIds: scope.rootIds,
    result: resolveLayerDrop(scope.flowChildren, scope.rootIds, before?.id),
  };
}
