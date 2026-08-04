import type { CanvasNode } from "./editor-protocol";
import type { Bounds } from "./scene-visibility";

const DEFAULT_CELL_SIZE = 1_024;
const MAX_CELLS_PER_NODE = 256;

/**
 * A Worker-only uniform grid. It stores document indexes (not node copies), keeps
 * large objects in a side list, and returns indexes in original z-order.
 */
export function createSpatialGridIndex(
  nodes: readonly CanvasNode[],
  boundsFor: (node: CanvasNode) => Bounds,
  cellSize = DEFAULT_CELL_SIZE,
) {
  const size = Math.max(1, Math.floor(cellSize));
  const cells = new Map<string, number[]>();
  const largeIndexes: number[] = [];
  nodes.forEach((node, index) => {
    const bounds = boundsFor(node);
    const minX = Math.floor(bounds.x / size);
    const minY = Math.floor(bounds.y / size);
    const maxX = Math.floor((bounds.x + bounds.width) / size);
    const maxY = Math.floor((bounds.y + bounds.height) / size);
    const cellCount = (maxX - minX + 1) * (maxY - minY + 1);
    if (!Number.isSafeInteger(cellCount) || cellCount > MAX_CELLS_PER_NODE) { largeIndexes.push(index); return; }
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      const key = `${x}:${y}`;
      const members = cells.get(key);
      if (members) members.push(index);
      else cells.set(key, [index]);
    }
  });

  return {
    query(bounds: Bounds): CanvasNode[] {
      const indexes = new Set<number>(largeIndexes);
      const minX = Math.floor(bounds.x / size);
      const minY = Math.floor(bounds.y / size);
      const maxX = Math.floor((bounds.x + bounds.width) / size);
      const maxY = Math.floor((bounds.y + bounds.height) / size);
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
        cells.get(`${x}:${y}`)?.forEach((index) => indexes.add(index));
      }
      return [...indexes].sort((left, right) => left - right).map((index) => nodes[index]).filter((node): node is CanvasNode => Boolean(node));
    },
    cellCount: cells.size,
    largeNodeCount: largeIndexes.length,
  };
}
