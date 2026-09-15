import type { AutoLayoutPaddingSide, CanvasNode } from "./editor-protocol";
import { normalizeAutoLayout } from "./auto-layout-normalization";
import { invertAffine, transformPoint, worldTransformsForNodes, type AffineMatrix, type TransformPoint } from "./scene-transform";

export type AutoLayoutPaddingOverlay = Readonly<{
  frameId: string;
  side: AutoLayoutPaddingSide;
  value: number;
  polygon: readonly TransformPoint[];
}>;

function targetFrame(nodes: readonly CanvasNode[], selectedIds: readonly string[]) {
  if (selectedIds.length !== 1) return undefined;
  const selected = nodes.find((node) => node.id === selectedIds[0]);
  if (!selected) return undefined;
  const ownLayout = normalizeAutoLayout(selected.autoLayout);
  if (selected.kind === "frame" && (ownLayout?.mode === "horizontal" || ownLayout?.mode === "vertical")) {
    return { frame: selected, layout: ownLayout };
  }
  const parent = selected.parentId ? nodes.find((node) => node.id === selected.parentId) : undefined;
  const parentLayout = normalizeAutoLayout(parent?.autoLayout);
  return parent?.kind === "frame" && (parentLayout?.mode === "horizontal" || parentLayout?.mode === "vertical")
    ? { frame: parent, layout: parentLayout }
    : undefined;
}

export function autoLayoutPaddingSideAtWorldPoint(
  nodes: readonly CanvasNode[],
  selectedIds: readonly string[],
  point: TransformPoint,
  zoom: number,
  transforms?: ReadonlyMap<string, AffineMatrix>,
): { frameId: string; side: AutoLayoutPaddingSide } | undefined {
  const target = targetFrame(nodes, selectedIds);
  if (!target) return undefined;
  const world = transforms ?? worldTransformsForNodes(nodes);
  const matrix = world.get(target.frame.id);
  const inverse = matrix && invertAffine(matrix);
  if (!matrix || !inverse) return undefined;
  const local = transformPoint(inverse, point);
  if (local.x < 0 || local.y < 0 || local.x > target.frame.width || local.y > target.frame.height) return undefined;
  const [top, right, bottom, left] = target.layout.padding;
  const scaleX = Math.max(1e-6, Math.hypot(matrix.a, matrix.b));
  const scaleY = Math.max(1e-6, Math.hypot(matrix.c, matrix.d));
  const minX = 12 / Math.max(1e-6, zoom * scaleX);
  const minY = 12 / Math.max(1e-6, zoom * scaleY);
  const candidates: Array<{ side: AutoLayoutPaddingSide; distance: number }> = [];
  if (local.y <= Math.max(top, minY)) candidates.push({ side: "top", distance: local.y * scaleY });
  if (target.frame.width - local.x <= Math.max(right, minX)) candidates.push({ side: "right", distance: (target.frame.width - local.x) * scaleX });
  if (target.frame.height - local.y <= Math.max(bottom, minY)) candidates.push({ side: "bottom", distance: (target.frame.height - local.y) * scaleY });
  if (local.x <= Math.max(left, minX)) candidates.push({ side: "left", distance: local.x * scaleX });
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0] ? { frameId: target.frame.id, side: candidates[0].side } : undefined;
}

export function autoLayoutPaddingOverlay(
  nodes: readonly CanvasNode[],
  selectedIds: readonly string[],
  hover: { frameId: string; side: AutoLayoutPaddingSide } | undefined,
  transforms?: ReadonlyMap<string, AffineMatrix>,
): AutoLayoutPaddingOverlay | undefined {
  if (!hover) return undefined;
  const target = targetFrame(nodes, selectedIds);
  if (!target || target.frame.id !== hover.frameId) return undefined;
  const world = transforms ?? worldTransformsForNodes(nodes);
  const matrix = world.get(target.frame.id);
  if (!matrix) return undefined;
  const [top, right, bottom, left] = target.layout.padding;
  const regions: Record<AutoLayoutPaddingSide, { value: number; points: TransformPoint[] }> = {
    top: { value: top, points: [{ x: 0, y: 0 }, { x: target.frame.width, y: 0 }, { x: target.frame.width, y: top }, { x: 0, y: top }] },
    right: { value: right, points: [{ x: target.frame.width - right, y: 0 }, { x: target.frame.width, y: 0 }, { x: target.frame.width, y: target.frame.height }, { x: target.frame.width - right, y: target.frame.height }] },
    bottom: { value: bottom, points: [{ x: 0, y: target.frame.height - bottom }, { x: target.frame.width, y: target.frame.height - bottom }, { x: target.frame.width, y: target.frame.height }, { x: 0, y: target.frame.height }] },
    left: { value: left, points: [{ x: 0, y: 0 }, { x: left, y: 0 }, { x: left, y: target.frame.height }, { x: 0, y: target.frame.height }] },
  };
  const region = regions[hover.side];
  return { frameId: target.frame.id, side: hover.side, value: region.value, polygon: region.points.map((point) => transformPoint(matrix, point)) };
}
