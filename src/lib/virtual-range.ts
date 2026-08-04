export const LAYER_ROW_HEIGHT = 31;
export const LAYER_LIST_OVERSCAN = 8;

export interface VirtualRange {
  start: number;
  end: number;
}

/** Returns the half-open range that should be mounted for a fixed-height list. */
export function virtualRange(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = LAYER_ROW_HEIGHT,
  overscan = LAYER_LIST_OVERSCAN,
): VirtualRange {
  const count = Math.max(0, Math.floor(itemCount));
  const height = Math.max(1, rowHeight);
  const padding = Math.max(0, Math.floor(overscan));
  const top = Math.max(0, scrollTop);
  const visibleHeight = Math.max(0, viewportHeight);
  return {
    start: Math.max(0, Math.floor(top / height) - padding),
    end: Math.min(count, Math.ceil((top + visibleHeight) / height) + padding),
  };
}

/** The layers UI is reversed without copying or reversing the document array. */
export function reversedIndex(nodeCount: number, virtualIndex: number) {
  return nodeCount - 1 - virtualIndex;
}
