import type { CanvasNode, DocumentVectorPath, NodeKind } from "./editor-protocol";
import { parametricShapePoints } from "./parametric-shape";

type ConvertibleNode = Pick<CanvasNode, "kind" | "width" | "height" | "radius" | "cornerRadii" | "arcData" | "parametricShape" | "vectorPath">;
type VectorPoint = DocumentVectorPath["subpaths"][number]["points"][number];

export const TEXT_PATH_SOURCE_KINDS: readonly NodeKind[] = ["vector", "rectangle", "ellipse", "polygon", "star", "line"];

/** Resolves every Figma-supported vector-like source into the immutable path
 * stored by TextPath. Point IDs are allocated once at the intent boundary so
 * Core and remote replicas never repeat floating-point shape derivation. */
export function resolveTextPathVectorPath(node: ConvertibleNode, createPointId: () => string): DocumentVectorPath | undefined {
  if (node.kind === "vector") return node.vectorPath ? structuredClone(node.vectorPath) : undefined;
  if (node.kind === "line") return pathFromPoints([{ x: 0, y: 0 }, { x: node.width, y: 0 }], false, createPointId);
  if ((node.kind === "polygon" || node.kind === "star") && node.parametricShape) {
    const points = parametricShapePoints(node.width, node.height, node.parametricShape);
    return points.length >= 3 ? pathFromPoints(points, true, createPointId) : undefined;
  }
  if (node.kind === "rectangle") return roundedRectanglePath(node, createPointId);
  if (node.kind === "ellipse") return ellipsePath(node, createPointId);
  return undefined;
}

function pathFromPoints(points: readonly { x: number; y: number }[], closed: boolean, createPointId: () => string): DocumentVectorPath {
  return { fillRule: "nonZero", subpaths: [{ closed, points: points.map((point) => ({ id: createPointId(), ...point, pointType: "corner" })) }] };
}

function roundedRectanglePath(node: ConvertibleNode, createPointId: () => string): DocumentVectorPath {
  const half = Math.min(node.width, node.height) / 2;
  const source = node.cornerRadii?.length === 4 ? node.cornerRadii : [node.radius, node.radius, node.radius, node.radius];
  const [topLeft, topRight, bottomRight, bottomLeft] = source.map((radius) => Math.max(0, Math.min(half, radius ?? 0)));
  if (![topLeft, topRight, bottomRight, bottomLeft].some(Boolean)) {
    return pathFromPoints([{ x: 0, y: 0 }, { x: node.width, y: 0 }, { x: node.width, y: node.height }, { x: 0, y: node.height }], true, createPointId);
  }
  const kappa = 0.5522847498307936;
  const points: Omit<VectorPoint, "id">[] = [
    { x: topLeft, y: 0, handleIn: { x: -kappa * topLeft, y: 0 }, pointType: "asymmetric" },
    { x: node.width - topRight, y: 0, handleOut: { x: kappa * topRight, y: 0 }, pointType: "asymmetric" },
    { x: node.width, y: topRight, handleIn: { x: 0, y: -kappa * topRight }, pointType: "asymmetric" },
    { x: node.width, y: node.height - bottomRight, handleOut: { x: 0, y: kappa * bottomRight }, pointType: "asymmetric" },
    { x: node.width - bottomRight, y: node.height, handleIn: { x: kappa * bottomRight, y: 0 }, pointType: "asymmetric" },
    { x: bottomLeft, y: node.height, handleOut: { x: -kappa * bottomLeft, y: 0 }, pointType: "asymmetric" },
    { x: 0, y: node.height - bottomLeft, handleIn: { x: 0, y: kappa * bottomLeft }, pointType: "asymmetric" },
    { x: 0, y: topLeft, handleOut: { x: 0, y: -kappa * topLeft }, pointType: "asymmetric" },
  ];
  const distinct = dedupeClosed(points).map((point) => ({ id: createPointId(), ...point }));
  return { fillRule: "nonZero", subpaths: [{ closed: true, points: distinct }] };
}

function ellipsePath(node: ConvertibleNode, createPointId: () => string): DocumentVectorPath {
  const centerX = node.width / 2;
  const centerY = node.height / 2;
  const radiusX = node.width / 2;
  const radiusY = node.height / 2;
  const arc = node.arcData;
  if (!arc || Math.abs(arc.endingAngle - arc.startingAngle) >= 360 - 1e-8) {
    const outer = ellipseArcPoints(centerX, centerY, radiusX, radiusY, 0, Math.PI * 2, true, createPointId);
    if (!arc || arc.innerRadius <= 0) return { fillRule: "nonZero", subpaths: [{ closed: true, points: outer }] };
    const inner = ellipseArcPoints(centerX, centerY, radiusX * arc.innerRadius, radiusY * arc.innerRadius, Math.PI * 2, 0, true, createPointId);
    return { fillRule: "evenOdd", subpaths: [{ closed: true, points: outer }, { closed: true, points: inner }] };
  }
  const start = arc.startingAngle * Math.PI / 180;
  const end = arc.endingAngle * Math.PI / 180;
  const outer = ellipseArcPoints(centerX, centerY, radiusX, radiusY, start, end, false, createPointId);
  if (arc.innerRadius <= 0) {
    outer.push({ id: createPointId(), x: centerX, y: centerY, pointType: "corner" });
  } else {
    outer.push(...ellipseArcPoints(centerX, centerY, radiusX * arc.innerRadius, radiusY * arc.innerRadius, end, start, false, createPointId));
  }
  return { fillRule: "evenOdd", subpaths: [{ closed: true, points: dedupeClosed(outer) as VectorPoint[] }] };
}

function ellipseArcPoints(centerX: number, centerY: number, radiusX: number, radiusY: number, start: number, end: number, closed: boolean, createPointId: () => string): VectorPoint[] {
  const span = end - start;
  const segments = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2)));
  const delta = span / segments;
  const points: VectorPoint[] = [];
  for (let index = 0; index <= segments; index += 1) {
    if (closed && index === segments) break;
    const angle = start + delta * index;
    const point: VectorPoint = {
      id: createPointId(),
      x: centerX + radiusX * Math.cos(angle),
      y: centerY + radiusY * Math.sin(angle),
      pointType: "mirrored",
    };
    const alpha = 4 / 3 * Math.tan(Math.abs(delta) / 4) * Math.sign(delta || 1);
    point.handleOut = { x: -alpha * radiusX * Math.sin(angle), y: alpha * radiusY * Math.cos(angle) };
    point.handleIn = { x: alpha * radiusX * Math.sin(angle), y: -alpha * radiusY * Math.cos(angle) };
    points.push(point);
  }
  if (!closed) {
    delete points[0]!.handleIn;
    delete points[points.length - 1]!.handleOut;
    points[0]!.pointType = "asymmetric";
    points[points.length - 1]!.pointType = "asymmetric";
  }
  return points;
}

function dedupeClosed<T extends { x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number }; pointType: VectorPoint["pointType"] }>(points: readonly T[]): T[] {
  const result: T[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) {
      previous.handleOut = point.handleOut;
      previous.pointType = previous.handleIn || previous.handleOut ? "asymmetric" : "corner";
    } else result.push(structuredClone(point));
  }
  if (result.length > 1 && result[0]!.x === result[result.length - 1]!.x && result[0]!.y === result[result.length - 1]!.y) {
    const last = result.pop()!;
    result[0]!.handleIn = last.handleIn;
    result[0]!.pointType = result[0]!.handleIn || result[0]!.handleOut ? "asymmetric" : "corner";
  }
  return result;
}
