import type { CanvasNode } from "./editor-protocol";
import { sortNodesByLayerOrder } from "./layer-order";

export type SelectionClipBounds = Readonly<{ x: number; y: number; width: number; height: number }>;

const defaultPageId = "00000000-0000-0000-0000-000000000001";

function overlaps(left: SelectionClipBounds, right: SelectionClipBounds) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function intersection(left: SelectionClipBounds, right: SelectionClipBounds): SelectionClipBounds | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  return rightEdge > x && bottomEdge > y ? { x, y, width: rightEdge - x, height: bottomEdge - y } : undefined;
}

/**
 * Conservative structural visibility gate for marquee selection. It returns
 * true only when an entire layer is definitely outside an ancestor Frame clip
 * or its active alpha-mask run. Partial overlaps deliberately remain
 * selectable: exact alpha/rounded-contour sampling belongs to the renderer,
 * while this gate must never make a visible sliver impossible to select.
 */
export function isFullyClippedForSelection(
  nodes: readonly CanvasNode[],
  nodeId: string,
  boundsFor: (node: CanvasNode) => SelectionClipBounds,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const target = byId.get(nodeId);
  if (!target) return true;
  const targetBounds = boundsFor(target);
  if (![targetBounds.x, targetBounds.y, targetBounds.width, targetBounds.height].every(Number.isFinite)) return true;
  let visibleBounds = targetBounds;
  const visited = new Set<string>();
  let current: CanvasNode | undefined = target;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const pageId = current.pageId ?? defaultPageId;
    const unorderedSiblings = nodes.filter((candidate) => (candidate.pageId ?? defaultPageId) === pageId && candidate.parentId === current!.parentId);
    // Legacy in-memory projections can precede PositionId migration. Their
    // stored array order remains deterministic enough for this conservative
    // visibility gate; do not turn a marquee gesture into an exception.
    let siblings: CanvasNode[];
    try { siblings = sortNodesByLayerOrder(unorderedSiblings); }
    catch { siblings = [...unorderedSiblings]; }
    const index = siblings.findIndex((candidate) => candidate.id === current!.id);
    if (index < 0) return true;
    const mask = [...siblings.slice(0, index)].reverse().find((candidate) => candidate.isMask);
    if (!current.isMask && mask) {
      if (mask.visible === false) return true;
      const maskedBounds = boundsFor(mask);
      if (!overlaps(visibleBounds, maskedBounds)) return true;
      const overlap = intersection(visibleBounds, maskedBounds);
      if (!overlap) return true;
      visibleBounds = overlap;
    }
    if (!current.parentId) return false;
    const parent = byId.get(current.parentId);
    if (!parent) return true;
    if (parent.kind === "frame" && parent.clipsContent !== false) {
      const clipBounds = boundsFor(parent);
      if (!overlaps(visibleBounds, clipBounds)) return true;
      const overlap = intersection(visibleBounds, clipBounds);
      if (!overlap) return true;
      visibleBounds = overlap;
    }
    current = parent;
  }
  return Boolean(current);
}
