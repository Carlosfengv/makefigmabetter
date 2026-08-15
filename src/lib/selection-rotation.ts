import type { CanvasNode } from "./editor-protocol";
import { multiplyAffine, nodePropsForWorldTransform, transformPoint, worldTransformForNode, type AffineMatrix } from "./scene-transform";

export type SelectionRotationPatch = Pick<CanvasNode, "x" | "y" | "rotation" | "relativeTransform">;

/** Resolves a world-space rotation gesture into Canonical patches. The same
 * affine operation is used for single nodes, multi-selection and legacy
 * descendants, so a parent transform never makes an old world-space child
 * visually drift. The returned patches are calculated against the immutable
 * pre-gesture scene and are suitable for one Core transaction on pointer-up. */
export function rotateSelectionAroundWorldPoint(
  nodes: readonly CanvasNode[],
  selectedIds: readonly string[],
  pivot: { x: number; y: number },
  start: { x: number; y: number },
  current: { x: number; y: number },
  snapToIncrements = false,
): Map<string, SelectionRotationPatch> | undefined {
  if (!Number.isFinite(pivot.x) || !Number.isFinite(pivot.y) || !Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(current.x) || !Number.isFinite(current.y)) return undefined;
  const selected = uniqueSelectionRoots(nodes, selectedIds);
  if (!selected.length) return undefined;
  const delta = rotationDeltaDegrees(pivot, start, current, snapToIncrements);
  if (delta === undefined) return undefined;
  const rotation = rotationAround(pivot, delta);
  const patches = new Map<string, SelectionRotationPatch>();
  const visit = (node: CanvasNode, isRoot: boolean) => {
    // Relative-v1 descendants inherit a transformed selected ancestor. Legacy
    // descendants deliberately do not inherit parent transforms, so they need
    // their own world-space patch. Roots always receive a direct patch.
    if (isRoot || !node.relativeTransform) {
      const patch = rotateNode(nodes, node, rotation);
      if (!patch) return false;
      patches.set(node.id, patch);
    }
    for (const child of nodes) if (child.parentId === node.id && !visit(child, false)) return false;
    return true;
  };
  for (const root of selected) if (!visit(root, true)) return undefined;
  return patches;
}

export function rotationDeltaDegrees(
  pivot: { x: number; y: number },
  start: { x: number; y: number },
  current: { x: number; y: number },
  snapToIncrements = false,
): number | undefined {
  const startDx = start.x - pivot.x;
  const startDy = start.y - pivot.y;
  const currentDx = current.x - pivot.x;
  const currentDy = current.y - pivot.y;
  if (Math.hypot(startDx, startDy) <= 1e-9 || Math.hypot(currentDx, currentDy) <= 1e-9) return undefined;
  let degrees = (Math.atan2(currentDy, currentDx) - Math.atan2(startDy, startDx)) * 180 / Math.PI;
  while (degrees <= -180) degrees += 360;
  while (degrees > 180) degrees -= 360;
  if (snapToIncrements) degrees = Math.round(degrees / 15) * 15;
  return Object.is(degrees, -0) ? 0 : degrees;
}

function uniqueSelectionRoots(nodes: readonly CanvasNode[], selectedIds: readonly string[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = new Set(selectedIds);
  if (!selected.size || [...selected].some((id) => !byId.has(id))) return [];
  return [...selected].map((id) => byId.get(id)!).filter((node) => {
    const visited = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (selected.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId;
    }
    return true;
  });
}

function rotateNode(nodes: readonly CanvasNode[], node: CanvasNode, rotation: AffineMatrix): SelectionRotationPatch | undefined {
  const world = worldTransformForNode(nodes, node.id);
  if (!world) return undefined;
  const nextWorld = multiplyAffine(rotation, world);
  if (!node.relativeTransform) {
    const legacy = nodePropsForWorldTransform(nextWorld, undefined, node.width, node.height);
    return legacy && { x: normalizeTiny(legacy.x), y: normalizeTiny(legacy.y), rotation: normalizeTiny(legacy.rotation), relativeTransform: undefined };
  }
  const parentWorld = node.parentId ? worldTransformForNode(nodes, node.parentId) : undefined;
  if (node.parentId && !parentWorld) return undefined;
  const relative = nodePropsForWorldTransform(nextWorld, parentWorld, node.width, node.height);
  return relative && {
    x: normalizeTiny(relative.x),
    y: normalizeTiny(relative.y),
    rotation: normalizeTiny(relative.rotation),
    relativeTransform: relative.relativeTransform && {
      a: normalizeTiny(relative.relativeTransform.a), b: normalizeTiny(relative.relativeTransform.b), c: normalizeTiny(relative.relativeTransform.c),
      d: normalizeTiny(relative.relativeTransform.d), e: normalizeTiny(relative.relativeTransform.e), f: normalizeTiny(relative.relativeTransform.f),
    },
  };
}

function rotationAround(pivot: { x: number; y: number }, degrees: number): AffineMatrix {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: pivot.x - cosine * pivot.x + sine * pivot.y,
    f: pivot.y - sine * pivot.x - cosine * pivot.y,
  };
}

/** Exported for tests and Canvas overlays that need the same pivot invariant. */
export function rotateWorldPoint(point: { x: number; y: number }, pivot: { x: number; y: number }, degrees: number) {
  return transformPoint(rotationAround(pivot, degrees), point);
}

function normalizeTiny(value: number) { return Math.abs(value) < 1e-12 ? 0 : Math.abs(value - Math.round(value)) < 1e-12 ? Math.round(value) : value; }
