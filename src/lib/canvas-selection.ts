import type { CanvasNode } from "./editor-protocol";
import { isEffectivelyLocked } from "./hierarchy-lock";
import { sortNodesByLayerOrder } from "./layer-order";

/**
 * Resolves a click on a canvas object without unexpectedly collapsing an
 * existing multi-selection. This allows dragging any selected object to move
 * the complete selection, matching Figma's direct-manipulation behavior.
 */
export function resolveCanvasObjectSelection(selectedIds: readonly string[], targetId: string, additive: boolean): string[] {
  if (additive) return [...new Set([...selectedIds, targetId])];
  return selectedIds.includes(targetId) ? [...selectedIds] : [targetId];
}

/** Frames, Groups and TransformGroups are Figma canvas selection boundaries.
 * Repeated presses advance through exactly one boundary; Command/Ctrl-click
 * bypasses them and selects the painted descendant directly. */
export function resolveNestedSelectionTarget(
  nodes: readonly CanvasNode[],
  hitId: string,
  drillDown: boolean,
  selectedIds: readonly string[] = [],
  deepSelect = false,
): CanvasNode | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hit = byId.get(hitId);
  if (!hit || hit.kind === "group" || selectedIds.includes(hit.id)) return hit;

  if (deepSelect) return hit;

  const visited = new Set<string>([hit.id]);
  const containers: CanvasNode[] = [];
  let parentId = hit.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if ((parent.kind === "frame" || parent.kind === "group" || parent.kind === "transformGroup") && parent.visible !== false && !isEffectivelyLocked(byId, parent.id)) containers.push(parent);
    parentId = parent.parentId;
  }
  containers.reverse();
  if (!containers.length) return hit;

  // Preserve a selected boundary during the press that precedes the browser's
  // double-click event. The subsequent drill-down reaches its direct nested
  // Frame/Group (or the painted leaf) without skipping hierarchy levels.
  const selectedContainerIndex = containers.reduce(
    (selectedIndex, container, index) => selectedIds.includes(container.id) ? index : selectedIndex,
    -1,
  );
  if (drillDown) return selectedContainerIndex >= 0 ? containers[selectedContainerIndex + 1] ?? hit : hit;
  return selectedContainerIndex >= 0 ? containers[selectedContainerIndex] : containers[0];
}

/** Keyboard nesting follows the same visibility and lock rules as canvas
 * clicks. Enter moves into the topmost direct child; Shift+Enter returns to
 * the immediate parent. */
export function resolveNestedKeyboardTarget(
  nodes: readonly CanvasNode[],
  selectedIds: readonly string[],
  direction: "child" | "parent",
): CanvasNode | undefined {
  if (selectedIds.length !== 1) return undefined;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = byId.get(selectedIds[0]);
  if (!selected || isEffectivelyLocked(byId, selected.id)) return undefined;
  if (direction === "parent") {
    const parent = selected.parentId ? byId.get(selected.parentId) : undefined;
    return parent && parent.visible !== false && !isEffectivelyLocked(byId, parent.id) ? parent : undefined;
  }
  if (selected.kind !== "frame" && selected.kind !== "group" && selected.kind !== "transformGroup") return undefined;
  const children = nodes.filter((node) => node.parentId === selected.id && node.visible !== false && !isEffectivelyLocked(byId, node.id));
  return sortNodesByLayerOrder(children).at(-1);
}

/** Backwards-compatible name retained while callers migrate to the Frame and
 * Group selection model. */
export const resolveGroupSelectionTarget = resolveNestedSelectionTarget;
