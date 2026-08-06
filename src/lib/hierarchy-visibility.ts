import type { CanvasNode } from "./editor-protocol";

/** Returns nodes which are visible on a page after inherited visibility and
 * Section content hiding have been applied. Cyclic legacy data is contained
 * rather than traversed forever; the Core rejects new cycles at mutation time. */
export function visibleNodesOnPage(nodes: readonly CanvasNode[], pageId: string, defaultPageId: string): CanvasNode[] {
  const pageNodes = nodes.filter((node) => (node.pageId ?? defaultPageId) === pageId);
  const byId = new Map(pageNodes.map((node) => [node.id, node]));
  return pageNodes.filter((node) => {
    if (node.visible === false) return false;
    const visited = new Set<string>();
    let parentId = node.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || parent.visible === false || (parent.kind === "section" && parent.contentsHidden)) return false;
      parentId = parent.parentId;
    }
    return true;
  });
}
