import type { AutoLayoutPaddingSide, DocumentAutoLayout } from "./editor-protocol";

export type ScreenPoint = Readonly<{ x: number; y: number }>;

/** Padding scrubbing follows the requested inverse direction: left/up add,
 * right/down subtract. The dominant pointer axis lets the same badge respond
 * naturally to either a horizontal or vertical drag. */
export function autoLayoutPaddingDragDelta(start: ScreenPoint, current: ScreenPoint): number {
  const horizontal = start.x - current.x;
  const vertical = start.y - current.y;
  return Math.round(Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical);
}

export function autoLayoutWithDraggedPadding(
  layout: DocumentAutoLayout,
  side: AutoLayoutPaddingSide,
  delta: number,
): DocumentAutoLayout {
  const index = ({ top: 0, right: 1, bottom: 2, left: 3 } as const)[side];
  const padding = [...layout.padding] as DocumentAutoLayout["padding"];
  padding[index] = Math.max(0, layout.padding[index] + delta);
  return { ...layout, padding };
}
