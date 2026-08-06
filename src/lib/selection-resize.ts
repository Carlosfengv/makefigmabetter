import type { ResizeGeometry } from "./canvas-resize";

export type SelectionResizeGeometry = ResizeGeometry & Readonly<{ flipX?: boolean; flipY?: boolean }>;

/** Scales axis-aligned Legacy geometry from one selection bounds to another.
 * The result deliberately contains only Geometry fields, making it safe to
 * resolve into one Core batch rather than minting one transaction per layer. */
export function scaleLegacySelectionGeometry(
  nodes: readonly Readonly<{ id: string; x: number; y: number; width: number; height: number }>[],
  before: ResizeGeometry,
  after: SelectionResizeGeometry,
): ReadonlyMap<string, ResizeGeometry> | undefined {
  if (before.width <= 0 || before.height <= 0 || after.width <= 0 || after.height <= 0) return undefined;
  const scaleX = after.width / before.width;
  const scaleY = after.height / before.height;
  if (![scaleX, scaleY].every(Number.isFinite)) return undefined;
  const mapX = (value: number) => after.flipX
    ? after.x + after.width - (value - before.x) * scaleX
    : after.x + (value - before.x) * scaleX;
  const mapY = (value: number) => after.flipY
    ? after.y + after.height - (value - before.y) * scaleY
    : after.y + (value - before.y) * scaleY;
  return new Map(nodes.map((node) => [node.id, {
    // Persist each node with positive geometry. A crossed selection is a
    // reflection of the selection coordinate space, not a negative child size.
    x: mapX(after.flipX ? node.x + node.width : node.x),
    y: mapY(after.flipY ? node.y + node.height : node.y),
    width: node.width * scaleX,
    height: node.height * scaleY,
  }]));
}

export function hasCommittedSelectionResize(
  before: ReadonlyMap<string, ResizeGeometry>,
  after: ReadonlyMap<string, ResizeGeometry>,
): boolean {
  return [...before].some(([id, geometry]) => {
    const next = after.get(id);
    return Boolean(next && (geometry.x !== next.x || geometry.y !== next.y || geometry.width !== next.width || geometry.height !== next.height));
  });
}
