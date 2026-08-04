import type { CanvasNode } from "./editor-protocol";

export type WorldPoint = Readonly<{ x: number; y: number }>;

/**
 * Exact primitive hit testing for the Canvas 2D projection. Points are first
 * transformed into a node's local space, so rotation never falls back to the
 * axis-aligned bounds used as the broad phase.
 */
export function nodeContainsWorldPoint(node: CanvasNode, point: WorldPoint): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.width) || !Number.isFinite(node.height) || node.width <= 0 || node.height <= 0) return false;
  const local = toLocalPoint(node, point);
  if (node.kind === "ellipse") return ellipseContains(local, node.width, node.height);
  if (node.kind === "frame" || node.kind === "rectangle") return roundedRectContains(local, node.width, node.height, node.radius);
  return local.x >= 0 && local.x <= node.width && local.y >= 0 && local.y <= node.height;
}

export function findTopmostHit(nodes: readonly CanvasNode[], point: WorldPoint): CanvasNode | undefined {
  return [...nodes].reverse().find((node) => node.visible !== false && !node.locked && nodeContainsWorldPoint(node, point));
}

function toLocalPoint(node: CanvasNode, point: WorldPoint): WorldPoint {
  const radians = (Number.isFinite(node.rotation) ? node.rotation : 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - (node.x + node.width / 2);
  const dy = point.y - (node.y + node.height / 2);
  return { x: cos * dx + sin * dy + node.width / 2, y: -sin * dx + cos * dy + node.height / 2 };
}

function ellipseContains(point: WorldPoint, width: number, height: number): boolean {
  const radiusX = width / 2;
  const radiusY = height / 2;
  const x = (point.x - radiusX) / radiusX;
  const y = (point.y - radiusY) / radiusY;
  return x * x + y * y <= 1;
}

function roundedRectContains(point: WorldPoint, width: number, height: number, radius: number): boolean {
  if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) return false;
  const cornerRadius = Math.max(0, Math.min(Number.isFinite(radius) ? radius : 0, width / 2, height / 2));
  if (cornerRadius === 0) return true;
  const cornerX = point.x < cornerRadius ? cornerRadius : point.x > width - cornerRadius ? width - cornerRadius : point.x;
  const cornerY = point.y < cornerRadius ? cornerRadius : point.y > height - cornerRadius ? height - cornerRadius : point.y;
  const dx = point.x - cornerX;
  const dy = point.y - cornerY;
  return dx * dx + dy * dy <= cornerRadius * cornerRadius;
}
