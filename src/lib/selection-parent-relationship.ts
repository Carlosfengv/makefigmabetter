import type { CanvasNode } from "./editor-protocol";
import { normalizeAutoLayout } from "./auto-layout-normalization";
import { invertAffine, multiplyAffine, transformPoint, worldBoundsForTransform, worldTransformsForNodes, type AffineMatrix, type TransformPoint } from "./scene-transform";

export type ParentDistance = {
  side: "left" | "right" | "top" | "bottom";
  start: TransformPoint;
  end: TransformPoint;
  value: number;
};

export type SelectionParentRelationship = {
  parentId: string;
  autoLayout: boolean;
  outline: TransformPoint[];
  distances: ParentDistance[];
};

/** Measure canonical bounds in the parent's coordinate system, then project
 * the guides into world space. Legacy x/y are already world coordinates;
 * Relative-v1 children must compose with their ancestors exactly once. */
export function selectionParentRelationship(
  nodes: readonly CanvasNode[],
  selectedIds: readonly string[],
  transforms?: ReadonlyMap<string, AffineMatrix>,
): SelectionParentRelationship | undefined {
  if (selectedIds.length !== 1) return undefined;
  const child = nodes.find((node) => node.id === selectedIds[0]);
  const parent = child?.parentId ? nodes.find((node) => node.id === child.parentId) : undefined;
  if (!child || !parent || child.visible === false || parent.visible === false || parent.contentsHidden
    || (child.pageId && parent.pageId && child.pageId !== parent.pageId)
    || parent.width <= 0 || parent.height <= 0) return undefined;
  const world = transforms ?? worldTransformsForNodes(nodes);
  const parentWorld = world.get(parent.id);
  const childWorld = world.get(child.id);
  const inverseParent = parentWorld && invertAffine(parentWorld);
  if (!parentWorld || !childWorld || !inverseParent) return undefined;
  const parentLayout = normalizeAutoLayout(parent.autoLayout);
  const childLayout = normalizeAutoLayout(child.autoLayout);
  const autoLayout = parentLayout?.mode === "horizontal" || parentLayout?.mode === "vertical";
  const outline = [
    { x: 0, y: 0 }, { x: parent.width, y: 0 },
    { x: parent.width, y: parent.height }, { x: 0, y: parent.height },
  ].map((point) => transformPoint(parentWorld, point));
  const distances: ParentDistance[] = [];
  if (!autoLayout || childLayout?.absolute) {
    const bounds = worldBoundsForTransform(child, multiplyAffine(inverseParent, childWorld));
    const centerX = Math.max(0, Math.min(parent.width, (bounds.left + bounds.right) / 2));
    const centerY = Math.max(0, Math.min(parent.height, (bounds.top + bounds.bottom) / 2));
    const add = (side: ParentDistance["side"], start: TransformPoint, end: TransformPoint, value: number) => {
      // A flush edge has no measurable span. Keep fractional document pixels;
      // rounding belongs to label presentation, never to the geometry.
      if (!Number.isFinite(value) || Math.abs(value) < 1e-6) return;
      distances.push({ side, start: transformPoint(parentWorld, start), end: transformPoint(parentWorld, end), value });
    };
    add("left", { x: 0, y: centerY }, { x: bounds.left, y: centerY }, bounds.left);
    add("right", { x: bounds.right, y: centerY }, { x: parent.width, y: centerY }, parent.width - bounds.right);
    add("top", { x: centerX, y: 0 }, { x: centerX, y: bounds.top }, bounds.top);
    add("bottom", { x: centerX, y: bounds.bottom }, { x: centerX, y: parent.height }, parent.height - bounds.bottom);
  }
  return { parentId: parent.id, autoLayout, outline, distances };
}
