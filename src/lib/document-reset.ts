import type { CanvasNode, Viewport } from "./editor-protocol";

export interface ResetDocumentProjection {
  nodes: CanvasNode[];
  selectedIds: string[];
  viewport: Viewport;
  revision: number;
}

/** Produces the non-persistable projection used while a replacement Core boots. */
export function resetDocumentProjection(starterNodes: readonly CanvasNode[]): ResetDocumentProjection {
  const nodes = Array.from(starterNodes, (node) => structuredClone(node));
  return { nodes, selectedIds: nodes[0] ? [nodes[0].id] : [], viewport: { x: 0, y: 0, zoom: 1 }, revision: 0 };
}
