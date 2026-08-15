import type { CanvasNode, DocumentParametricShape } from "./editor-protocol";

export type ParametricPoint = Readonly<{ x: number; y: number }>;

/**
 * The single browser-side outline definition for ADR 0026 regular shapes.
 * Points begin at 12 o'clock and progress clockwise in local node space.
 */
export function parametricShapePoints(width: number, height: number, shape: DocumentParametricShape): ParametricPoint[] {
  const count = shape.pointCount;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isInteger(count) || count < 3) return [];
  const centerX = width / 2;
  const centerY = height / 2;
  const outerX = Math.abs(width) / 2;
  const outerY = Math.abs(height) / 2;
  const vertices = shape.kind === "star" ? count * 2 : count;
  return Array.from({ length: vertices }, (_, index) => {
    const scale = shape.kind === "star" && index % 2 === 1 ? shape.innerRatio : 1;
    const angle = -Math.PI / 2 + index * Math.PI * 2 / vertices;
    return { x: centerX + Math.cos(angle) * outerX * scale, y: centerY + Math.sin(angle) * outerY * scale };
  });
}

export function nodeParametricShape(node: Pick<CanvasNode, "kind" | "parametricShape">): DocumentParametricShape | undefined {
  return (node.kind === "polygon" || node.kind === "star") ? node.parametricShape : undefined;
}

export function parametricShapePath(points: readonly ParametricPoint[], number: (value: number) => string = String): string {
  if (!points.length) return "";
  return `M ${number(points[0].x)} ${number(points[0].y)}${points.slice(1).map((point) => ` L ${number(point.x)} ${number(point.y)}`).join("")} Z`;
}

export function pointInPolygon(point: ParametricPoint, polygon: readonly ParametricPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
