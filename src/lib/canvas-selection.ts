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
 * A Group is the default selection boundary. Repeated presses intentionally
 * bypass that boundary, matching Figma's double-click drill-down behavior.
 */
export function resolveGroupSelectionTarget(nodes: readonly CanvasNode[], hitId: string, drillDown: boolean): CanvasNode | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hit = byId.get(hitId);
  if (!hit || drillDown || hit.kind === "group") return hit;

  const visited = new Set<string>([hit.id]);
  let parentId = hit.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.kind === "group" && parent.visible !== false && !parent.locked) return parent;
    parentId = parent.parentId;
  }
  return hit;
}
import type { CanvasNode } from "./editor-protocol";
