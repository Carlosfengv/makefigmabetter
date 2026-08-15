import type { CanvasNode } from "./editor-protocol";

/**
 * Figma-style selection is owned by a Page, not by a document or a container.
 * It contains only directly selected SceneNodes: a selected ancestor owns any
 * selected descendant, and IDs from other Pages are never admitted.
 */
export function normalizePageSelection(
  nodes: readonly CanvasNode[],
  pageId: string,
  ids: readonly string[],
  defaultPageId: string,
): string[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const requested = new Set(ids.filter((id) => (nodesById.get(id)?.pageId ?? defaultPageId) === pageId));
  const result: string[] = [];
  for (const id of ids) {
    const node = nodesById.get(id);
    if (!node || !requested.has(id)) continue;
    let parentId = node.parentId;
    const visited = new Set<string>([id]);
    let hasSelectedAncestor = false;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (requested.has(parentId)) { hasSelectedAncestor = true; break; }
      parentId = nodesById.get(parentId)?.parentId;
    }
    if (!hasSelectedAncestor && !result.includes(id)) result.push(id);
  }
  return result;
}
