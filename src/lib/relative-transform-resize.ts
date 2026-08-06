import { invertAffine, multiplyAffine, transformPoint, type AffineMatrix } from "./scene-transform";
import { resizeGeometryFromCenter, resizeGeometryFromCorner, type CanvasResizeHandle, type ResizePoint } from "./canvas-resize";

export type RelativeTransformResizeNode = Readonly<{
  width: number;
  height: number;
  relativeTransform: AffineMatrix;
}>;

/**
 * Resizes a Relative-v1 node in its own local axes. `worldTransform` maps the
 * node's local coordinates into canvas/world coordinates. Moving a leading
 * handle updates the relative transform by a local translation, preserving the
 * opposite visual anchor even under parent rotation, skew, or reflection.
 */
export function resizeRelativeTransformFromWorldGesture(
  node: RelativeTransformResizeNode,
  worldTransform: AffineMatrix,
  handle: CanvasResizeHandle,
  startWorld: ResizePoint,
  currentWorld: ResizePoint,
  preserveAspectRatio = false,
  fromCenter = false,
): Readonly<{ width: number; height: number; relativeTransform: AffineMatrix }> | undefined {
  const inverse = invertAffine(worldTransform);
  if (!inverse) return undefined;
  const start = transformPoint(inverse, startWorld);
  const current = transformPoint(inverse, currentWorld);
  const resized = (fromCenter ? resizeGeometryFromCenter : resizeGeometryFromCorner)(
    { x: 0, y: 0, width: node.width, height: node.height },
    handle,
    { x: current.x - start.x, y: current.y - start.y },
    undefined,
    preserveAspectRatio,
  );
  const relativeTransform = multiplyAffine(node.relativeTransform, { a: 1, b: 0, c: 0, d: 1, e: resized.x, f: resized.y });
  return { width: resized.width, height: resized.height, relativeTransform };
}
