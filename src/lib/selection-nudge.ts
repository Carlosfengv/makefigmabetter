import type { CanvasNode } from "./editor-protocol";
import { movableSelectionIds } from "./selection-move-roots";
import { translateNodeWorldPatch } from "./scene-transform";

export type SelectionNudgePatch = Pick<CanvasNode, "x" | "y" | "rotation" | "relativeTransform">;

/** Resolves a keyboard movement in world space before it reaches Core. It uses
 * the same transform rule as pointer dragging, so a Relative-v1 node stays
 * correct below a rotated or mirrored parent. */
export function resolveSelectionNudge(
  nodes: readonly CanvasNode[],
  selection: readonly string[],
  delta: Readonly<{ x: number; y: number }>,
) {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return undefined;
  const movable = movableSelectionIds(nodes, selection);
  const patches = [...movable].flatMap((id) => {
    const patch = translateNodeWorldPatch(nodes, id, delta.x, delta.y);
    return patch ? [{ id, patch }] : [];
  });
  return { movable, patches };
}
