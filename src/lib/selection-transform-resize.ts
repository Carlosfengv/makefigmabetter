import type { CanvasNode } from "./editor-protocol";
import type { ResizeGeometry } from "./canvas-resize";
import type { SelectionResizeGeometry } from "./selection-resize";
import { multiplyAffine, nodePropsForWorldTransform, worldTransformForNode } from "./scene-transform";

export type SelectionTransformPatch = Pick<CanvasNode, "x" | "y" | "width" | "height" | "rotation" | "relativeTransform">;

/** Applies an axis-aligned selection-bounds scale in world space, then writes
 * each child back through its immediate parent transform. This retains exact
 * geometry for rotated, skewed and reflected leaf nodes instead of treating
 * their world AABB as if it were an unrotated rectangle. */
export function scaleSelectionTransforms(
  nodes: readonly CanvasNode[],
  ids: readonly string[],
  before: ResizeGeometry,
  after: SelectionResizeGeometry,
): ReadonlyMap<string, SelectionTransformPatch> | undefined {
  if (before.width <= 0 || before.height <= 0 || after.width <= 0 || after.height <= 0) return undefined;
  const scaleX = (after.flipX ? -1 : 1) * after.width / before.width;
  const scaleY = (after.flipY ? -1 : 1) * after.height / before.height;
  if (![scaleX, scaleY].every(Number.isFinite)) return undefined;
  const selectionTransform = {
    a: scaleX, b: 0, c: 0, d: scaleY,
    e: (after.flipX ? after.x + after.width : after.x) - before.x * scaleX,
    f: (after.flipY ? after.y + after.height : after.y) - before.y * scaleY,
  };
  const unchanged = scaleX === 1 && scaleY === 1 && after.x === before.x && after.y === before.y && !after.flipX && !after.flipY;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = (node: CanvasNode) => {
    let value = 0;
    let parentId = node.parentId;
    const visited = new Set<string>([node.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      value += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    return value;
  };
  // Parents must be written first. A Frame's new geometry may require a
  // compensated matrix, and selected descendants must use that *new* matrix
  // when being mapped back into their own parent-local coordinates.
  const orderedIds = [...new Set(ids)].sort((left, right) => {
    const leftNode = byId.get(left);
    const rightNode = byId.get(right);
    return (leftNode ? depth(leftNode) : Number.MAX_SAFE_INTEGER) - (rightNode ? depth(rightNode) : Number.MAX_SAFE_INTEGER);
  });
  const patches = new Map<string, SelectionTransformPatch>();
  const nextWorlds = new Map<string, ReturnType<typeof worldTransformForNode>>();
  for (const id of orderedIds) {
    const node = byId.get(id);
    const world = node && worldTransformForNode(nodes, id);
    const parentWorld = node?.parentId
      ? nextWorlds.get(node.parentId) ?? worldTransformForNode(nodes, node.parentId)
      : undefined;
    if (!node || !world || (node.parentId && !parentWorld)) return undefined;
    // Avoid turning a no-op Legacy selection into Relative-v1 records.
    if (unchanged) {
      patches.set(id, { x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation, relativeTransform: node.relativeTransform });
      nextWorlds.set(id, world);
      continue;
    }
    // Containers must expose their resized local geometry to Core so Frame
    // constraints run. Compensate that geometry change in the transform so the
    // visual result remains exactly the world-space selection scale.
    const resizesContainerGeometry = node.kind === "frame" || node.kind === "section";
    const width = resizesContainerGeometry ? node.width * Math.abs(scaleX) : node.width;
    const height = resizesContainerGeometry ? node.height * Math.abs(scaleY) : node.height;
    const geometryInverseScale = resizesContainerGeometry
      ? { a: 1 / Math.abs(scaleX), b: 0, c: 0, d: 1 / Math.abs(scaleY), e: 0, f: 0 }
      : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const desiredWorld = multiplyAffine(multiplyAffine(selectionTransform, world), geometryInverseScale);
    const props = nodePropsForWorldTransform(desiredWorld, parentWorld, width, height);
    if (!props) return undefined;
    patches.set(id, { ...props, width, height });
    nextWorlds.set(id, desiredWorld);
  }
  return patches;
}

export function hasCommittedSelectionTransform(
  nodes: readonly CanvasNode[],
  patches: ReadonlyMap<string, SelectionTransformPatch>,
): boolean {
  return [...patches].some(([id, patch]) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return Boolean(node && (node.x !== patch.x || node.y !== patch.y || node.width !== patch.width || node.height !== patch.height || node.rotation !== patch.rotation || JSON.stringify(node.relativeTransform) !== JSON.stringify(patch.relativeTransform)));
  });
}
