import { decorativeCapMesh, decorativeCapSize, type DecorativeCapKind, type MeshPoint, type MeshTriangle } from "./decorative-cap-mesh";
import type { CanvasNode } from "./editor-protocol";
import { connectorPathEndpointPose, connectorPathLocalBounds, type ConnectorPath, type ConnectorPoint } from "./connector-path";

export type ConnectorErdCapKind = "erdZeroOrOne" | "erdExactlyOne" | "erdZeroOrMore" | "erdOneOrMore" | "erdOne" | "erdMany";
export type ConnectorDecorativeCapKind = DecorativeCapKind | ConnectorErdCapKind;

export type ConnectorEndpointDecoration = Readonly<{
  cap: ConnectorDecorativeCapKind;
  endpoint: "start" | "end";
  point: ConnectorPoint;
  direction: ConnectorPoint;
}>;

export type ConnectorLabelLayout = Readonly<{
  text: string;
  lines: readonly string[];
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** Maps Figma Connector's dedicated endpoint enum onto the one shared
 * decoration mesh used by Canvas, SVG, hit testing and bounds. */
export function connectorDecorativeCap(value: string | undefined): ConnectorDecorativeCapKind | undefined {
  switch (value) {
    case "ARROW_LINES": case "arrowLines": return "arrowLines";
    case "ARROW_EQUILATERAL": case "arrowEquilateral": return "arrowEquilateral";
    case "TRIANGLE_FILLED": case "triangleFilled": return "triangleFilled";
    case "DIAMOND_FILLED": case "diamondFilled": return "diamondFilled";
    case "CIRCLE_FILLED": case "circleFilled": return "circleFilled";
    case "ERD_ZERO_OR_ONE": return "erdZeroOrOne";
    case "ERD_EXACTLY_ONE": return "erdExactlyOne";
    case "ERD_ZERO_OR_MORE": return "erdZeroOrMore";
    case "ERD_ONE_OR_MORE": return "erdOneOrMore";
    case "ERD_ONE": return "erdOne";
    case "ERD_MANY": return "erdMany";
    default: return undefined;
  }
}

export function connectorEndpointDecorations(node: CanvasNode, path: ConnectorPath): readonly ConnectorEndpointDecoration[] {
  if (node.kind !== "connector") return [];
  return (["start", "end"] as const).flatMap((endpoint) => {
    const cap = connectorDecorativeCap(endpoint === "start" ? node.connectorMetadata?.startStrokeCap : node.connectorMetadata?.endStrokeCap);
    const pose = connectorPathEndpointPose(path, endpoint);
    return cap && pose ? [{ cap, endpoint, ...pose }] : [];
  });
}

/** A deterministic, non-shaping connector label card. Rich text and Figma's
 * full label typography are not represented by the Canonical connector yet;
 * this preserves its plain text rather than hiding it behind a fallback. */
export function connectorLabelLayout(node: CanvasNode, path: ConnectorPath): ConnectorLabelLayout | undefined {
  if (node.kind !== "connector") return undefined;
  const text = node.connectorMetadata?.text.trim();
  if (!text) return undefined;
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const midpoint = connectorPathEndpointPose(path, "middle");
  if (!midpoint) return undefined;
  const lineHeight = 16;
  const height = Math.max(20, lines.length * lineHeight + 4);
  return {
    text,
    lines,
    x: midpoint.point.x,
    y: midpoint.point.y - Math.max(10, node.strokeWidth / 2 + 4),
    width: Math.max(28, Math.min(320, Math.max(...lines.map((line) => Array.from(line).length)) * 7.2 + 12)),
    height,
  };
}

export function connectorLabelContains(node: CanvasNode, path: ConnectorPath, point: ConnectorPoint): boolean {
  const label = connectorLabelLayout(node, path);
  return Boolean(label && point.x >= label.x - label.width / 2 && point.x <= label.x + label.width / 2 && point.y >= label.y - label.height / 2 && point.y <= label.y + label.height / 2);
}

/** Transforms a shared cap mesh from tangent-local space into connector-local
 * space. The generated points can be painted, serialized or hit-tested
 * without every target reimplementing endpoint orientation. */
export function connectorDecorationTriangles(decoration: ConnectorEndpointDecoration, strokeWidth: number): readonly (readonly [MeshPoint, MeshPoint, MeshPoint])[] {
  const direction = decoration.endpoint === "start" ? -1 : 1;
  const triangles = isConnectorErdCap(decoration.cap)
    ? connectorErdCapTriangles(decoration.cap, direction, strokeWidth)
    : decorativeCapMesh(decoration.cap, 0, direction, strokeWidth).triangles;
  return triangles.map((triangle) => triangle.map((point) => transformTangentPoint(point, decoration.point, decoration.direction)) as [MeshPoint, MeshPoint, MeshPoint]);
}

/** Produces device-scale triangle coordinates after endpoint orientation has
 * already been applied exactly once by connectorDecorationTriangles(). */
export function scaledConnectorDecorationTriangles(decoration: ConnectorEndpointDecoration, strokeWidth: number, scale: number): readonly MeshTriangle[] {
  const scaled = (point: MeshPoint): MeshPoint => ({ x: point.x * scale, y: point.y * scale });
  return connectorDecorationTriangles(decoration, strokeWidth).map(([a, b, c]) => [scaled(a), scaled(b), scaled(c)]);
}

export function connectorDecorationContains(node: CanvasNode, path: ConnectorPath, point: ConnectorPoint): boolean {
  return connectorEndpointDecorations(node, path).some((decoration) => connectorDecorationTriangles(decoration, node.strokeWidth).some((triangle) => pointInTriangle(point, triangle)));
}

export function connectorPresentationBounds(node: CanvasNode, path: ConnectorPath, minimumHalfExtent = 0): Readonly<{ left: number; top: number; right: number; bottom: number }> {
  const line = connectorPathLocalBounds(path, node.strokeWidth, minimumHalfExtent);
  const points = connectorEndpointDecorations(node, path).flatMap((decoration) => connectorDecorationTriangles(decoration, node.strokeWidth).flat());
  const label = connectorLabelLayout(node, path);
  if (!points.length && !label) return line;
  return {
    left: Math.min(line.left, ...points.map((point) => point.x), ...(label ? [label.x - label.width / 2] : [])),
    top: Math.min(line.top, ...points.map((point) => point.y), ...(label ? [label.y - label.height / 2] : [])),
    right: Math.max(line.right, ...points.map((point) => point.x), ...(label ? [label.x + label.width / 2] : [])),
    bottom: Math.max(line.bottom, ...points.map((point) => point.y), ...(label ? [label.y + label.height / 2] : [])),
  };
}

function transformTangentPoint(point: MeshPoint, origin: ConnectorPoint, direction: ConnectorPoint): MeshPoint {
  return { x: origin.x + point.x * direction.x - point.y * direction.y, y: origin.y + point.x * direction.y + point.y * direction.x };
}

function isConnectorErdCap(cap: ConnectorDecorativeCapKind): cap is ConnectorErdCapKind {
  return cap.startsWith("erd");
}

/** Deterministic crow's-foot primitives. A ring means zero, a perpendicular
 * bar means one, and three thick rays mean many. The same filled triangle mesh
 * drives Canvas, SVG, bounds and hit testing. */
function connectorErdCapTriangles(cap: ConnectorErdCapKind, direction: -1 | 1, strokeWidth: number): readonly MeshTriangle[] {
  const size = decorativeCapSize(strokeWidth);
  const half = Math.max(.5, strokeWidth / 2);
  const triangles: MeshTriangle[] = [];
  const nearX = direction * size * .24;
  const farX = direction * size * .72;
  const zero = () => appendRing(triangles, { x: nearX, y: 0 }, size * .17, half);
  const one = (x: number) => appendThickSegment(triangles, { x, y: -size * .3 }, { x, y: size * .3 }, half);
  const many = () => {
    const root = { x: direction * size * .42, y: 0 };
    appendThickSegment(triangles, root, { x: direction * size * .9, y: -size * .34 }, half);
    appendThickSegment(triangles, root, { x: direction * size * .9, y: 0 }, half);
    appendThickSegment(triangles, root, { x: direction * size * .9, y: size * .34 }, half);
  };
  if (cap === "erdZeroOrOne" || cap === "erdZeroOrMore") zero();
  if (cap === "erdExactlyOne") { one(nearX); one(farX); }
  if (cap === "erdZeroOrOne") one(farX);
  if (cap === "erdOneOrMore") { one(nearX); many(); }
  if (cap === "erdOne") one(nearX);
  if (cap === "erdZeroOrMore" || cap === "erdMany") many();
  return triangles;
}

function appendRing(triangles: MeshTriangle[], center: MeshPoint, radius: number, thickness: number) {
  const innerRadius = Math.max(radius * .35, radius - thickness);
  const segments = 16;
  for (let index = 0; index < segments; index += 1) {
    const from = Math.PI * 2 * index / segments;
    const to = Math.PI * 2 * (index + 1) / segments;
    const outerFrom = { x: center.x + radius * Math.cos(from), y: center.y + radius * Math.sin(from) };
    const outerTo = { x: center.x + radius * Math.cos(to), y: center.y + radius * Math.sin(to) };
    const innerFrom = { x: center.x + innerRadius * Math.cos(from), y: center.y + innerRadius * Math.sin(from) };
    const innerTo = { x: center.x + innerRadius * Math.cos(to), y: center.y + innerRadius * Math.sin(to) };
    triangles.push([outerFrom, outerTo, innerTo], [outerFrom, innerTo, innerFrom]);
  }
}

function appendThickSegment(triangles: MeshTriangle[], from: MeshPoint, to: MeshPoint, half: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 1e-12 || half <= 0) return;
  const nx = -dy / length * half;
  const ny = dx / length * half;
  const a = { x: from.x + nx, y: from.y + ny };
  const b = { x: to.x + nx, y: to.y + ny };
  const c = { x: to.x - nx, y: to.y - ny };
  const d = { x: from.x - nx, y: from.y - ny };
  triangles.push([a, b, c], [a, c, d]);
}

function pointInTriangle(point: ConnectorPoint, [a, b, c]: readonly [MeshPoint, MeshPoint, MeshPoint]): boolean {
  const sign = (p: ConnectorPoint, left: MeshPoint, right: MeshPoint) => (p.x - right.x) * (left.y - right.y) - (left.x - right.x) * (p.y - right.y);
  const first = sign(point, a, b); const second = sign(point, b, c); const third = sign(point, c, a);
  return !(first < 0 || second < 0 || third < 0) || !(first > 0 || second > 0 || third > 0);
}
