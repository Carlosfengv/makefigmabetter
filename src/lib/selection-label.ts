import type { CanvasNode } from "./editor-protocol";

function formatDimension(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Text placed at the top-left of a Figma-style canvas selection. */
export function selectionTitle(nodes: readonly CanvasNode[]): string | undefined {
  if (nodes.length !== 1) return undefined;
  const [node] = nodes;
  return node.name;
}

/** Text placed in the highlighted measurement pill at the selection's bottom centre. */
export function selectionDimensions(width: number, height: number): string {
  return `${formatDimension(width)} × ${formatDimension(height)}`;
}
