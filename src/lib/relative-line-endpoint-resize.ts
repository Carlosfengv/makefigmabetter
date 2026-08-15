import { invertAffine, multiplyAffine, transformPoint, type AffineMatrix } from "./scene-transform";
import type { LineEndpoint, LinePoint } from "./line-endpoint-resize";

export type RelativeLineResizeNode = Readonly<{ width: number; relativeTransform: AffineMatrix }>;

/** Updates a matrix-backed Line by changing its local origin and basis. The
 * move is expressed as `relative × translate(origin) × rotate(direction)`,
 * which pins the opposite endpoint under arbitrary parent transforms. */
export function resizeRelativeLineEndpointFromWorldGesture(
  node: RelativeLineResizeNode,
  worldTransform: AffineMatrix,
  endpoint: LineEndpoint,
  currentWorld: LinePoint,
  minLength = 4,
): Readonly<{ width: number; relativeTransform: AffineMatrix }> | undefined {
  const inverse = invertAffine(worldTransform);
  if (!inverse) return undefined;
  const current = transformPoint(inverse, currentWorld);
  const fixed = endpoint === "start" ? { x: node.width, y: 0 } : { x: 0, y: 0 };
  const dx = endpoint === "start" ? fixed.x - current.x : current.x - fixed.x;
  const dy = endpoint === "start" ? fixed.y - current.y : current.y - fixed.y;
  const distance = Math.hypot(dx, dy);
  const radians = distance > 1e-9 ? Math.atan2(dy, dx) : 0;
  const length = Math.max(minLength, distance);
  const requestedOrigin = endpoint === "start"
    ? { x: fixed.x - Math.cos(radians) * length, y: fixed.y - Math.sin(radians) * length }
    : fixed;
  const origin = {
    x: Math.abs(requestedOrigin.x) < 1e-12 ? 0 : requestedOrigin.x,
    y: Math.abs(requestedOrigin.y) < 1e-12 ? 0 : requestedOrigin.y,
  };
  const rotation = { a: Math.cos(radians), b: Math.sin(radians), c: -Math.sin(radians), d: Math.cos(radians), e: 0, f: 0 };
  const translation = { a: 1, b: 0, c: 0, d: 1, e: origin.x, f: origin.y };
  return { width: length, relativeTransform: multiplyAffine(multiplyAffine(node.relativeTransform, translation), rotation) };
}
