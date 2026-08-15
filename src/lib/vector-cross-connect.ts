import type { CanvasNode, DocumentVectorPath } from "./editor-protocol";
import { invertAffine, transformPoint, worldTransformForNode } from "./scene-transform";

export type VectorEndpoint = Readonly<{ subpathIndex: number; pointId: string }>;
export type CrossVectorJoin = Readonly<{ targetPath: DocumentVectorPath; sourcePath?: DocumentVectorPath }>;

function clonePath(path: DocumentVectorPath): DocumentVectorPath {
  return {
    ...path,
    subpaths: path.subpaths.map((subpath) => ({
      ...subpath,
      points: subpath.points.map((point) => ({
        ...point,
        ...(point.handleIn ? { handleIn: { ...point.handleIn } } : {}),
        ...(point.handleOut ? { handleOut: { ...point.handleOut } } : {}),
      })),
    })),
  };
}

function endpointAt(subpath: DocumentVectorPath["subpaths"][number], pointId: string) {
  if (subpath.closed || !subpath.points.length) return undefined;
  if (subpath.points[0]?.id === pointId) return "start" as const;
  if (subpath.points.at(-1)?.id === pointId) return "end" as const;
  return undefined;
}

function reverseSubpath(subpath: DocumentVectorPath["subpaths"][number]) {
  subpath.points.reverse();
  subpath.points.forEach((point) => {
    const handleIn = point.handleIn;
    point.handleIn = point.handleOut;
    point.handleOut = handleIn;
  });
}

function samePoint(left: { x: number; y: number }, right: { x: number; y: number }) {
  return Math.abs(left.x - right.x) <= 1e-8 && Math.abs(left.y - right.y) <= 1e-8;
}

/**
 * Returns replacement paths for one bounded Phase-2 cross Vector connection.
 * The consumed source subpath moves into the target; if the source has other
 * subpaths they remain in place, otherwise the caller can delete its node in
 * the same transaction. Source anchors and relative handles are mapped through
 * world space, so legacy and Relative-v1 nodes join consistently.
 */
export function joinCrossVectorEndpoints(
  nodes: readonly CanvasNode[],
  target: CanvasNode,
  targetEndpoint: VectorEndpoint,
  source: CanvasNode,
  sourceEndpoint: VectorEndpoint,
): CrossVectorJoin | undefined {
  if (target.id === source.id || target.kind !== "vector" || source.kind !== "vector" || !target.vectorPath || !source.vectorPath) return undefined;
  if (target.pageId !== source.pageId || target.parentId !== source.parentId) return undefined;
  const targetPath = clonePath(target.vectorPath);
  const targetSubpath = targetPath.subpaths[targetEndpoint.subpathIndex];
  const sourceSubpath = source.vectorPath.subpaths[sourceEndpoint.subpathIndex];
  const targetSide = targetSubpath && endpointAt(targetSubpath, targetEndpoint.pointId);
  const sourceSide = sourceSubpath && endpointAt(sourceSubpath, sourceEndpoint.pointId);
  if (!targetSubpath || !sourceSubpath || !targetSide || !sourceSide) return undefined;

  const targetWorld = worldTransformForNode(nodes, target.id);
  const sourceWorld = worldTransformForNode(nodes, source.id);
  const targetInverse = targetWorld && invertAffine(targetWorld);
  if (!targetWorld || !sourceWorld || !targetInverse) return undefined;
  const sourceOrigin = transformPoint(sourceWorld, { x: 0, y: 0 });
  const targetOrigin = transformPoint(targetInverse, sourceOrigin);
  const mapPoint = (point: { x: number; y: number }) => transformPoint(targetInverse, transformPoint(sourceWorld, point));
  const mapVector = (vector: { x: number; y: number }) => {
    const end = transformPoint(targetInverse, transformPoint(sourceWorld, vector));
    return { x: end.x - targetOrigin.x, y: end.y - targetOrigin.y };
  };
  const sourceInTarget = {
    ...sourceSubpath,
    points: sourceSubpath.points.map((point) => ({
      ...point,
      ...mapPoint(point),
      ...(point.handleIn ? { handleIn: mapVector(point.handleIn) } : {}),
      ...(point.handleOut ? { handleOut: mapVector(point.handleOut) } : {}),
    })),
  };
  const targetIds = new Set(targetPath.subpaths.flatMap((subpath) => subpath.points.map((point) => point.id)));
  if (sourceInTarget.points.some((point) => targetIds.has(point.id))) return undefined;

  if (targetSide === "start") reverseSubpath(targetSubpath);
  if (sourceSide === "end") reverseSubpath(sourceInTarget);
  const targetLast = targetSubpath.points.at(-1);
  const sourceFirst = sourceInTarget.points[0];
  if (!targetLast || !sourceFirst) return undefined;
  if (samePoint(targetLast, sourceFirst)) {
    const joined = sourceInTarget.points.shift()!;
    targetLast.handleOut = joined.handleOut;
    targetLast.pointType = targetLast.handleIn || targetLast.handleOut ? "asymmetric" : "corner";
  }
  targetSubpath.points.push(...sourceInTarget.points);
  const sourcePath = clonePath(source.vectorPath);
  sourcePath.subpaths.splice(sourceEndpoint.subpathIndex, 1);
  return { targetPath, ...(sourcePath.subpaths.length ? { sourcePath } : {}) };
}
