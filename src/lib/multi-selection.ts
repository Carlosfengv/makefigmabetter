import type { CanvasNode } from "./editor-protocol";
import type { ResizeGeometry } from "./canvas-resize";
import { worldVisualBoundsForNode } from "./world-visual-bounds";

export type MultiResizeSelection = Readonly<{
  nodes: CanvasNode[];
  bounds: ResizeGeometry;
  ids: string[];
  requiresAffine: boolean;
}>;

/**
 * Resolves the exact selection that receives a collective resize. A selected
 * Group expands to its editable subtree and parent IDs precede descendants, so
 * both canvas handles and Inspector geometry use one transaction model.
 */
export function resolveMultiResizeSelection(nodes: readonly CanvasNode[], selectedIds: readonly string[]): MultiResizeSelection | undefined {
  if (selectedIds.length === 0) return undefined;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = selectedIds.map((id) => byId.get(id)).filter((node): node is CanvasNode => Boolean(node));
  const selectedIdSet = new Set(selectedIds);
  if (selected.length !== selectedIds.length) return undefined;
  const roots = selected.filter((node) => {
    let parentId = node.parentId;
    const visited = new Set<string>([node.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (selectedIdSet.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId;
    }
    return true;
  });
  const editableKinds = new Set<CanvasNode["kind"]>(["rectangle", "ellipse", "text", "image", "line"]);
  const containerKinds = new Set<CanvasNode["kind"]>(["frame", "section"]);
  const transformNodes: CanvasNode[] = [];
  const visitedContainers = new Set<string>();
  const visitGroupSubtree = (container: CanvasNode): boolean => {
    if (container.locked || container.visible === false || visitedContainers.has(container.id)) return false;
    visitedContainers.add(container.id);
    const children = nodes.filter((node) => node.parentId === container.id);
    if (container.kind === "group" && !children.length) return false;
    return children.every((child) => {
      if (child.locked || child.visible === false) return false;
      if (child.kind === "group") return visitGroupSubtree(child);
      if (containerKinds.has(child.kind)) {
        transformNodes.push(child);
        return visitGroupSubtree(child);
      }
      if (!editableKinds.has(child.kind)) return false;
      transformNodes.push(child);
      return true;
    });
  };
  for (const root of roots) {
    if (root.locked || root.visible === false) return undefined;
    if (root.kind === "group") {
      if (!visitGroupSubtree(root)) return undefined;
      continue;
    }
    if (!containerKinds.has(root.kind) && !editableKinds.has(root.kind)) return undefined;
    transformNodes.push(root);
  }
  if (!transformNodes.length || (roots.length < 2 && roots[0]?.kind !== "group")) return undefined;
  const depth = (node: CanvasNode) => {
    let value = 0;
    let parentId = node.parentId;
    const visited = new Set<string>([node.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      value += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    return value;
  };
  const ids = [...new Set(transformNodes.map((node) => node.id))].sort((left, right) => depth(byId.get(left)!) - depth(byId.get(right)!));
  const bounds = transformNodes.map((node) => worldVisualBoundsForNode(nodes, node));
  if (bounds.some((value) => !value)) return undefined;
  const resolved = bounds as NonNullable<(typeof bounds)[number]>[];
  const left = Math.min(...resolved.map((bound) => bound.left));
  const top = Math.min(...resolved.map((bound) => bound.top));
  const right = Math.max(...resolved.map((bound) => bound.right));
  const bottom = Math.max(...resolved.map((bound) => bound.bottom));
  if (right <= left || bottom <= top) return undefined;
  return {
    nodes: roots,
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    ids,
    requiresAffine: roots.some((node) => node.kind === "group" || node.relativeTransform || node.rotation !== 0)
      || transformNodes.some((node) => node.relativeTransform || node.rotation !== 0),
  };
}
