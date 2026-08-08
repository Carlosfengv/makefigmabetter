import type { CanvasNode } from "./editor-protocol";
import { isEffectivelyLocked } from "./hierarchy-lock";

/**
 * Resolves a click on a canvas object without unexpectedly collapsing an
 * existing multi-selection. This allows dragging any selected object to move
 * the complete selection, matching Figma's direct-manipulation behavior.
 */
export function resolveCanvasObjectSelection(selectedIds: readonly string[], targetId: string, additive: boolean): string[] {
  if (additive) return [...new Set([...selectedIds, targetId])];
  return selectedIds.includes(targetId) ? [...selectedIds] : [targetId];
}

/**
 * A Group is the default selection boundary. Repeated presses advance through
 * one ancestor boundary at a time, matching Figma's double-click drill-down
 * behavior for nested Groups.
 */
export function resolveGroupSelectionTarget(
  nodes: readonly CanvasNode[],
  hitId: string,
  drillDown: boolean,
  selectedIds: readonly string[] = [],
): CanvasNode | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hit = byId.get(hitId);
  if (!hit || hit.kind === "group" || selectedIds.includes(hit.id)) return hit;

  const visited = new Set<string>([hit.id]);
  const groups: CanvasNode[] = [];
  let parentId = hit.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.kind === "group" && parent.visible !== false && !isEffectivelyLocked(byId, parent.id)) groups.push(parent);
    parentId = parent.parentId;
  }
  groups.reverse();
  if (!groups.length) return hit;

  // Preserve a selected Group boundary during the press that precedes the
  // browser's double-click event; the subsequent drill-down then moves from
  // that exact boundary to its immediate child Group (or the leaf).
  const selectedGroupIndex = groups.reduce(
    (selectedIndex, group, index) => selectedIds.includes(group.id) ? index : selectedIndex,
    -1,
  );
  if (drillDown) return selectedGroupIndex >= 0 ? groups[selectedGroupIndex + 1] ?? hit : hit;
  return selectedGroupIndex >= 0 ? groups[selectedGroupIndex] : groups[0];
}
