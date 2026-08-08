import type { CanvasNode } from "./editor-protocol";

/** Returns whether a node or any of its ancestors is locked. Malformed cycles
 * are treated as locked so an invalid hierarchy never becomes editable. */
export function isEffectivelyLocked(
  nodesById: ReadonlyMap<string, CanvasNode>,
  id: string,
): boolean {
  const visited = new Set<string>();
  let currentId: string | undefined = id;
  while (currentId) {
    if (visited.has(currentId)) return true;
    visited.add(currentId);
    const node = nodesById.get(currentId);
    if (!node) return false;
    if (node.locked) return true;
    currentId = node.parentId;
  }
  return false;
}
