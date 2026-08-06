import type { CanvasNode } from "./editor-protocol";

/** Constraints affect a drawable layer only when it is a direct Frame child or
 * is nested below that Frame exclusively through Groups. Section is a canvas
 * organizer rather than a layout container, so it ends the supported scope. */
export function hasFrameConstraintScope(nodes: readonly CanvasNode[], node: CanvasNode): boolean {
  if (node.kind === "group" || node.kind === "section") return false;
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false;
    if (parent.kind === "frame") return true;
    if (parent.kind !== "group") return false;
    parentId = parent.parentId;
  }
  return false;
}
