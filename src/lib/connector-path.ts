import type { CanvasNode } from "./editor-protocol";
import { invertAffine, transformPoint, worldTransformForNode, type AffineMatrix } from "./scene-transform";

export type ConnectorPoint = Readonly<{ x: number; y: number }>;
export type ConnectorPath =
  | Readonly<{ kind: "polyline"; points: readonly ConnectorPoint[] }>
  | Readonly<{ kind: "rounded-polyline"; start: ConnectorPoint; segments: readonly ConnectorPathSegment[] }>
  | Readonly<{ kind: "cubic"; start: ConnectorPoint; control1: ConnectorPoint; control2: ConnectorPoint; end: ConnectorPoint }>;
type ConnectorPathSegment = Readonly<{ kind: "line"; end: ConnectorPoint }> | Readonly<{ kind: "quadratic"; control: ConnectorPoint; end: ConnectorPoint }>;
export type ConnectorPathContext = Readonly<{
  nodes: readonly CanvasNode[];
  defaultPageId?: string;
  nodeById?: ReadonlyMap<string, CanvasNode>;
  worldTransformByNodeId?: ReadonlyMap<string, AffineMatrix>;
}>;

/**
 * Deterministic local Connector geometry. This deliberately covers only the
 * portions represented in Canonical metadata. When scene context is available,
 * explicit magnets follow the referenced node through affine transforms; the
 * deterministic AUTO heuristic still does not claim Figma obstacle routing.
 */
export function connectorPathForNode(node: CanvasNode, context?: ConnectorPathContext): ConnectorPath | undefined {
  if (node.kind !== "connector") return undefined;
  const authoredStart = connectorPoint(node.connectorMetadata?.start, { x: 0, y: 0 });
  const authoredEnd = connectorPoint(node.connectorMetadata?.end, { x: node.width, y: 0 });
  const { start, end } = resolveAttachedEndpoints(node, authoredStart, authoredEnd, context);
  const lineType = node.connectorMetadata?.lineType ?? "STRAIGHT";
  if (lineType === "STRAIGHT") return { kind: "polyline", points: [start, end] };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (lineType === "CURVED") {
    return Math.abs(dx) >= Math.abs(dy)
      ? { kind: "cubic", start, control1: { x: start.x + dx / 2, y: start.y }, control2: { x: end.x - dx / 2, y: end.y }, end }
      : { kind: "cubic", start, control1: { x: start.x, y: start.y + dy / 2 }, control2: { x: end.x, y: end.y - dy / 2 }, end };
  }
  const points = Math.abs(dx) >= Math.abs(dy)
    ? compactPoints([start, { x: start.x + dx / 2, y: start.y }, { x: start.x + dx / 2, y: end.y }, end])
    : compactPoints([start, { x: start.x, y: start.y + dy / 2 }, { x: end.x, y: start.y + dy / 2 }, end]);
  const radius = Math.max(0, node.connectorMetadata?.cornerRadius ?? 0);
  return radius > 0 && points.length > 2 ? roundedPolyline(points, radius) : { kind: "polyline", points };
}

/** Resolves magnet endpoints as a derived view. Canonical retains the last
 * local point for deterministic fallback; target motion changes presentation
 * without rewriting history or connector metadata. */
function resolveAttachedEndpoints(
  node: CanvasNode,
  authoredStart: ConnectorPoint,
  authoredEnd: ConnectorPoint,
  context: ConnectorPathContext | undefined,
): Readonly<{ start: ConnectorPoint; end: ConnectorPoint }> {
  if (!context || !node.connectorMetadata) return { start: authoredStart, end: authoredEnd };
  const byId = context.nodeById ?? new Map(context.nodes.map((candidate) => [candidate.id, candidate]));
  const world = context.worldTransformByNodeId?.get(node.id) ?? worldTransformForNode(context.nodes, node.id);
  const inverse = world && invertAffine(world);
  if (!world || !inverse) return { start: authoredStart, end: authoredEnd };
  const authoredStartWorld = transformPoint(world, authoredStart);
  const authoredEndWorld = transformPoint(world, authoredEnd);
  return {
    start: resolveAttachedEndpoint(node, node.connectorMetadata.start, authoredStart, authoredEndWorld, byId, inverse, context),
    end: resolveAttachedEndpoint(node, node.connectorMetadata.end, authoredEnd, authoredStartWorld, byId, inverse, context),
  };
}

function resolveAttachedEndpoint(
  connector: CanvasNode,
  endpoint: NonNullable<CanvasNode["connectorMetadata"]>["start"],
  fallback: ConnectorPoint,
  oppositeWorld: ConnectorPoint,
  byId: ReadonlyMap<string, CanvasNode>,
  connectorWorldInverse: AffineMatrix,
  context: ConnectorPathContext,
): ConnectorPoint {
  if (!endpoint.endpointNodeId || !endpoint.magnet || endpoint.magnet === "NONE") return fallback;
  const target = byId.get(endpoint.endpointNodeId);
  const connectorPageId = connector.pageId ?? context.defaultPageId;
  const targetPageId = target?.pageId ?? context.defaultPageId;
  if (!target || target.id === connector.id || connectorPageId !== targetPageId) return fallback;
  const targetWorld = context.worldTransformByNodeId?.get(target.id) ?? worldTransformForNode(context.nodes, target.id);
  if (!targetWorld || !Number.isFinite(target.width) || !Number.isFinite(target.height) || target.width < 0 || target.height < 0) return fallback;
  const anchors = {
    TOP: { x: target.width / 2, y: 0 },
    RIGHT: { x: target.width, y: target.height / 2 },
    BOTTOM: { x: target.width / 2, y: target.height },
    LEFT: { x: 0, y: target.height / 2 },
    CENTER: { x: target.width / 2, y: target.height / 2 },
  } as const;
  const localAnchor = endpoint.magnet === "AUTO"
    ? (["TOP", "RIGHT", "BOTTOM", "LEFT"] as const)
      .map((side) => anchors[side])
      .map((anchor) => ({ anchor, world: transformPoint(targetWorld, anchor) }))
      .reduce((best, candidate) => distanceSquared(candidate.world, oppositeWorld) < distanceSquared(best.world, oppositeWorld) ? candidate : best).anchor
    : anchors[endpoint.magnet];
  return transformPoint(connectorWorldInverse, transformPoint(targetWorld, localAnchor));
}

function distanceSquared(left: ConnectorPoint, right: ConnectorPoint): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

export function connectorPathSvgD(path: ConnectorPath, number: (value: number) => string): string {
  if (path.kind === "cubic") return `M ${number(path.start.x)} ${number(path.start.y)} C ${number(path.control1.x)} ${number(path.control1.y)} ${number(path.control2.x)} ${number(path.control2.y)} ${number(path.end.x)} ${number(path.end.y)}`;
  if (path.kind === "rounded-polyline") return `M ${number(path.start.x)} ${number(path.start.y)}${path.segments.map((segment) => segment.kind === "line" ? ` L ${number(segment.end.x)} ${number(segment.end.y)}` : ` Q ${number(segment.control.x)} ${number(segment.control.y)} ${number(segment.end.x)} ${number(segment.end.y)}`).join("")}`;
  return path.points.map((point, index) => `${index ? "L" : "M"} ${number(point.x)} ${number(point.y)}`).join(" ");
}

/** Shared Canvas trace with caller-controlled device scaling. */
export function traceConnectorPath(context: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "quadraticCurveTo" | "bezierCurveTo">, path: ConnectorPath, scale = 1): void {
  if (path.kind === "cubic") {
    context.moveTo(path.start.x * scale, path.start.y * scale);
    context.bezierCurveTo(path.control1.x * scale, path.control1.y * scale, path.control2.x * scale, path.control2.y * scale, path.end.x * scale, path.end.y * scale);
    return;
  }
  if (path.kind === "rounded-polyline") {
    context.moveTo(path.start.x * scale, path.start.y * scale);
    path.segments.forEach((segment) => segment.kind === "line"
      ? context.lineTo(segment.end.x * scale, segment.end.y * scale)
      : context.quadraticCurveTo(segment.control.x * scale, segment.control.y * scale, segment.end.x * scale, segment.end.y * scale));
    return;
  }
  const [first, ...rest] = path.points;
  if (!first) return;
  context.moveTo(first.x * scale, first.y * scale);
  rest.forEach((point) => context.lineTo(point.x * scale, point.y * scale));
}

/** Conservative local envelope used by Scene/selection culling. Cubics are
 * sampled because their fixed deterministic control points have no hidden
 * geometry; the stroke envelope is then applied once. */
export function connectorPathLocalBounds(path: ConnectorPath, strokeWidth: number, minimumHalfExtent = 0): Readonly<{ left: number; top: number; right: number; bottom: number }> {
  const points = sampledConnectorPoints(path);
  const half = Math.max(minimumHalfExtent, Math.max(0, strokeWidth) / 2);
  return {
    left: Math.min(...points.map((point) => point.x)) - half,
    top: Math.min(...points.map((point) => point.y)) - half,
    right: Math.max(...points.map((point) => point.x)) + half,
    bottom: Math.max(...points.map((point) => point.y)) + half,
  };
}

export function connectorPathContains(path: ConnectorPath, point: ConnectorPoint, halfStrokeWidth: number): boolean {
  const points = sampledConnectorPoints(path);
  const tolerance = Math.max(0, halfStrokeWidth);
  return points.slice(1).some((end, index) => distanceToSegment(point, points[index]!, end) <= tolerance);
}

/** Returns a stable unit tangent and position at either end, or at the
 * arclength midpoint. Presentation consumers use this instead of assuming an
 * x-axis path, which keeps curved and elbowed decorations aligned. */
export function connectorPathEndpointPose(path: ConnectorPath, endpoint: "start" | "end" | "middle"): Readonly<{ point: ConnectorPoint; direction: ConnectorPoint }> | undefined {
  const points = sampledConnectorPoints(path);
  if (points.length < 2) return undefined;
  if (endpoint === "start") return poseAt(points, 0, 1);
  if (endpoint === "end") return poseAt(points, points.length - 1, -1);
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= 1e-9) return poseAt(points, 0, 1);
  let travelled = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (travelled + length >= total / 2 && length > 1e-9) {
      const start = points[index]!; const end = points[index + 1]!;
      const t = (total / 2 - travelled) / length;
      return { point: { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }, direction: { x: (end.x - start.x) / length, y: (end.y - start.y) / length } };
    }
    travelled += length;
  }
  return poseAt(points, points.length - 1, -1);
}

function connectorPoint(value: unknown, fallback: ConnectorPoint): ConnectorPoint {
  if (!value || typeof value !== "object") return fallback;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)
    ? { x: point.x, y: point.y }
    : fallback;
}
function compactPoints(points: readonly ConnectorPoint[]): readonly ConnectorPoint[] {
  return points.filter((point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y);
}
function sampledConnectorPoints(path: ConnectorPath): readonly ConnectorPoint[] {
  if (path.kind === "polyline") return path.points;
  if (path.kind === "cubic") return Array.from({ length: 25 }, (_, index) => cubicPoint(path, index / 24));
  const points: ConnectorPoint[] = [path.start];
  let current = path.start;
  path.segments.forEach((segment) => {
    if (segment.kind === "line") points.push(segment.end);
    else {
      for (let index = 1; index <= 8; index += 1) points.push(quadraticPoint(current, segment.control, segment.end, index / 8));
    }
    current = segment.end;
  });
  return points;
}
function poseAt(points: readonly ConnectorPoint[], index: number, step: -1 | 1): Readonly<{ point: ConnectorPoint; direction: ConnectorPoint }> | undefined {
  const point = points[index];
  if (!point) return undefined;
  for (let cursor = index + step; cursor >= 0 && cursor < points.length; cursor += step) {
    const other = points[cursor]!;
    const dx = step > 0 ? other.x - point.x : point.x - other.x;
    const dy = step > 0 ? other.y - point.y : point.y - other.y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-9) return { point, direction: { x: dx / length, y: dy / length } };
  }
  return undefined;
}
function cubicPoint(path: Extract<ConnectorPath, { kind: "cubic" }>, t: number): ConnectorPoint {
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * path.start.x + 3 * inverse ** 2 * t * path.control1.x + 3 * inverse * t ** 2 * path.control2.x + t ** 3 * path.end.x,
    y: inverse ** 3 * path.start.y + 3 * inverse ** 2 * t * path.control1.y + 3 * inverse * t ** 2 * path.control2.y + t ** 3 * path.end.y,
  };
}
function quadraticPoint(start: ConnectorPoint, control: ConnectorPoint, end: ConnectorPoint, t: number): ConnectorPoint {
  const inverse = 1 - t;
  return { x: inverse ** 2 * start.x + 2 * inverse * t * control.x + t ** 2 * end.x, y: inverse ** 2 * start.y + 2 * inverse * t * control.y + t ** 2 * end.y };
}
function roundedPolyline(points: readonly ConnectorPoint[], radius: number): ConnectorPath {
  const segments: ConnectorPathSegment[] = [];
  let current = points[0]!;
  for (let index = 1; index < points.length - 1; index += 1) {
    const corner = points[index]!;
    const next = points[index + 1]!;
    const incoming = unitVector(corner, current);
    const outgoing = unitVector(corner, next);
    const distance = Math.min(radius, Math.hypot(corner.x - current.x, corner.y - current.y) / 2, Math.hypot(next.x - corner.x, next.y - corner.y) / 2);
    if (!incoming || !outgoing || !distance) { segments.push({ kind: "line", end: corner }); current = corner; continue; }
    const enter = { x: corner.x + incoming.x * distance, y: corner.y + incoming.y * distance };
    const exit = { x: corner.x + outgoing.x * distance, y: corner.y + outgoing.y * distance };
    segments.push({ kind: "line", end: enter }, { kind: "quadratic", control: corner, end: exit });
    current = exit;
  }
  segments.push({ kind: "line", end: points[points.length - 1]! });
  return { kind: "rounded-polyline", start: points[0]!, segments };
}
function unitVector(from: ConnectorPoint, to: ConnectorPoint): ConnectorPoint | undefined {
  const dx = to.x - from.x; const dy = to.y - from.y; const length = Math.hypot(dx, dy);
  return length > 1e-9 ? { x: dx / length, y: dy / length } : undefined;
}
function distanceToSegment(point: ConnectorPoint, start: ConnectorPoint, end: ConnectorPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}
