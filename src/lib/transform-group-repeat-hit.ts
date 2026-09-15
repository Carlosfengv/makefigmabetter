import type { CanvasNode } from "./editor-protocol";
import { invertAffine, transformPoint, worldTransformsForNodes, type AffineMatrix } from "./scene-transform";
import { indexTransformGroupRepeatChildren, transformGroupRepeatDerivedPaintInstances, transformGroupRepeatSubtree } from "./transform-group-repeat";

export type TransformGroupRepeatHit = Readonly<{
  /** Canonical source identity selected for both source and derived paint. */
  node: CanvasNode;
  groupId: string;
  matrix: AffineMatrix;
  /** Index after which Canvas paints every derived instance in this group. */
  paintAfterIndex: number;
}>;

/** Finds the topmost Canvas-materialized Repeat copy at a world point.
 *
 * Canvas paints a TransformGroup's source leaves first, then every derived
 * matrix, before continuing with the next sibling. `paintAfterIndex` lets the
 * Worker compare this conceptual paint position with the ordinary Scene hit;
 * a later sibling still wins even though derived copies have no Canonical ID.
 */
export function findTopmostTransformGroupRepeatHit(options: Readonly<{
  documentNodes: readonly CanvasNode[];
  paintOrderNodes: readonly CanvasNode[];
  point: Readonly<{ x: number; y: number }>;
  worldTransformByNodeId?: ReadonlyMap<string, AffineMatrix>;
  containsSourcePoint: (node: CanvasNode, sourcePoint: Readonly<{ x: number; y: number }>) => boolean;
  isSourcePointVisible?: (node: CanvasNode, sourcePoint: Readonly<{ x: number; y: number }>, groupId: string) => boolean;
  isDerivedPointVisible?: (node: CanvasNode, derivedPoint: Readonly<{ x: number; y: number }>, groupId: string) => boolean;
}>): TransformGroupRepeatHit | undefined {
  const documentById = new Map(options.documentNodes.map((node) => [node.id, node]));
  const paintIndexById = new Map(options.paintOrderNodes.map((node, index) => [node.id, index]));
  const childrenByParentId = indexTransformGroupRepeatChildren(options.paintOrderNodes);
  const worldTransformByNodeId = options.worldTransformByNodeId ?? worldTransformsForNodes(options.documentNodes);
  const groups = options.paintOrderNodes.flatMap((paintGroup) => {
    if (paintGroup.kind !== "transformGroup") return [];
    const group = documentById.get(paintGroup.id);
    const subtree = group ? transformGroupRepeatSubtree(options.paintOrderNodes, group, childrenByParentId) : undefined;
    const instances = group && subtree
      ? transformGroupRepeatDerivedPaintInstances(options.documentNodes, options.paintOrderNodes, group, {
          worldTransformByNodeId,
          childrenByParentId,
        })
      : undefined;
    if (!group || !subtree || !instances?.length) return [];
    const paintAfterIndex = Math.max(
      paintIndexById.get(group.id) ?? -1,
      ...subtree.nodes.map((source) => paintIndexById.get(source.id) ?? -1),
    );
    return [{ group, instances, paintAfterIndex }];
  }).sort((left, right) => right.paintAfterIndex - left.paintAfterIndex);

  for (const candidate of groups) {
    // Canvas emits every recursively composed occurrence back-to-front. Search
    // in reverse so overlapping outer and nested copies resolve to the final
    // source identity actually painted at the point.
    for (let instanceIndex = candidate.instances.length - 1; instanceIndex >= 0; instanceIndex -= 1) {
      const { node: source, matrix } = candidate.instances[instanceIndex]!;
      const inverse = invertAffine(matrix);
      if (!inverse) continue;
      const sourcePoint = transformPoint(inverse, options.point);
      if (options.containsSourcePoint(source, sourcePoint)
        && (options.isSourcePointVisible?.(source, sourcePoint, candidate.group.id) ?? true)
        && (options.isDerivedPointVisible?.(source, options.point, candidate.group.id) ?? true)) {
        return { node: source, groupId: candidate.group.id, matrix, paintAfterIndex: candidate.paintAfterIndex };
      }
    }
  }
  return undefined;
}
