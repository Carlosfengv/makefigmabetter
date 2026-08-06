import type { CanvasNode } from "./editor-protocol";

export type LayerTreeRow = Readonly<{
  node: CanvasNode;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}>;

/** Builds a stable, inspectable layer tree. Historical cycles remain visible at
 * the root rather than making the Layers panel unusable; new cycles are still
 * rejected by the canonical mutation boundary. */
export function layerTreeRows(nodes: readonly CanvasNode[], collapsedIds: ReadonlySet<string> = new Set()): LayerTreeRow[] {
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string | undefined, CanvasNode[]>();
  nodes.forEach((node) => {
    const parentId = node.parentId && ids.has(node.parentId) ? node.parentId : undefined;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node);
    children.set(parentId, siblings);
  });
  const rows: LayerTreeRow[] = [];
  const visited = new Set<string>();
  const markHiddenDescendants = (node: CanvasNode) => {
    (children.get(node.id) ?? []).forEach((child) => {
      if (visited.has(child.id)) return;
      visited.add(child.id);
      markHiddenDescendants(child);
    });
  };
  const visit = (node: CanvasNode, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const descendants = children.get(node.id) ?? [];
    const hasChildren = descendants.length > 0;
    const collapsed = hasChildren && collapsedIds.has(node.id);
    rows.push({ node, depth, hasChildren, collapsed });
    if (collapsed) markHiddenDescendants(node);
    else descendants.forEach((child) => visit(child, depth + 1));
  };
  (children.get(undefined) ?? []).forEach((node) => visit(node, 0));
  nodes.forEach((node) => visit(node, 0));
  return rows;
}
