import type { CanvasNode } from "./editor-protocol";
import { resolveCornerRadii } from "./corner-radii";
import { cornerSmoothingExponent, resolveCornerSmoothing } from "./corner-smoothing";
import { dashedLineEndpointPaint, effectiveLineCap, lineLocalBounds } from "./marquee-selection";
import { decorativeCapContains, isDecorativeCap } from "./decorative-cap-mesh";
import { outsetRoundedRectRadii } from "./aligned-rounded-rect";
import { isEffectivelyLocked } from "./hierarchy-lock";

export type WorldPoint = Readonly<{ x: number; y: number }>;

/**
 * Exact primitive hit testing for the Canvas 2D projection. Points are first
 * transformed into a node's local space, so rotation never falls back to the
 * axis-aligned bounds used as the broad phase.
 */
export function nodeContainsWorldPoint(node: CanvasNode, point: WorldPoint): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.width) || !Number.isFinite(node.height) || node.width <= 0) return false;
  const local = toLocalPoint(node, point);
  if (node.kind === "line") {
    const startDecoration = isDecorativeCap(node.strokeCapStart) ? node.strokeCapStart : undefined;
    const endDecoration = isDecorativeCap(node.strokeCapEnd) ? node.strokeCapEnd : undefined;
    const hasEndpointDecoration = Boolean(startDecoration || endDecoration);
    const visualBounds = lineLocalBounds(node, Math.max(4, node.strokeWidth / 2));
    const [drawsAtStart, drawsAtEnd] = dashedLineEndpointPaint(node.width, node.strokeDashPattern);
    // The vertical broad-phase must clear the tallest marker (all five span at
    // most ±size/2) so a point over an arrowhead barb is not rejected early.
    const markerHalfExtent = hasEndpointDecoration ? Math.max(8, node.strokeWidth * 4) / 2 : 0;
    const verticalHitHalfExtent = hasEndpointDecoration
      ? Math.max(Math.abs(visualBounds.y), Math.abs(visualBounds.y + visualBounds.height), Math.max(4, node.strokeWidth / 2) + markerHalfExtent)
      : Math.max(Math.abs(visualBounds.y), Math.abs(visualBounds.y + visualBounds.height));
    if (Math.abs(local.y) > verticalHitHalfExtent) return false;
    // Decorative markers hit-test against the exact same triangle mesh the
    // Canvas renderer fills, so selection and paint never disagree on an
    // arrowhead's, diamond's or dot's extent.
    if (local.x < 0) {
      if (lineCapContains(effectiveLineCap(node, node.strokeCapStart), local, 0, -1, node.strokeWidth / 2, drawsAtStart)) return true;
      return startDecoration ? decorativeCapContains(startDecoration, 0, -1, node.strokeWidth, local) : false;
    }
    if (local.x > node.width) {
      if (lineCapContains(effectiveLineCap(node, node.strokeCapEnd), local, node.width, 1, node.strokeWidth / 2, drawsAtEnd)) return true;
      return endDecoration ? decorativeCapContains(endDecoration, node.width, 1, node.strokeWidth, local) : false;
    }
    // A marker may also overhang back onto the shaft span (e.g. an arrowhead
    // base or a dot). Test it before falling back to the dash occupancy.
    if (startDecoration && decorativeCapContains(startDecoration, 0, -1, node.strokeWidth, local)) return true;
    if (endDecoration && decorativeCapContains(endDecoration, node.width, 1, node.strokeWidth, local)) return true;
    return strokeDashContains(local.x, node.strokeDashPattern);
  }
  if (node.height <= 0) return false;
  const strokeAlign = node.strokeAlign ?? "inside";
  if ((node.kind === "frame" || node.kind === "rectangle") && strokeAlign !== "inside" && node.strokeWidth > 0) {
    const weights = node.strokeWeights ?? [node.strokeWidth, node.strokeWidth, node.strokeWidth, node.strokeWidth];
    const multiplier = strokeAlign === "outside" ? 1 : .5;
    const [top, right, bottom, left] = weights.map((weight) => Math.max(0, weight) * multiplier);
    // A uniform aligned Stroke grows both the outer bounds and each explicit
    // corner radius. Derive the grown corners from the shared aligned-rounded
    // -rect source so hit testing selects the exact same outer contour Canvas
    // paints and SVG exports, instead of an independently expanded radius.
    const outerCornerRadii = !node.strokeWeights?.length
      ? outsetRoundedRectRadii(node.width, node.height, node.radius, node.cornerRadii, top)
      : node.cornerRadii;
    if (roundedRectContains({ x: local.x + left, y: local.y + top }, node.width + left + right, node.height + top + bottom, node.radius + Math.max(top, right, bottom, left), outerCornerRadii, node.cornerSmoothing)) return true;
  }
  if (node.kind === "ellipse") {
    if (node.arcData) return ellipseArcContains(local, node.width, node.height, node.arcData);
    const extent = node.strokeAlign === "outside" ? node.strokeWidth : node.strokeAlign === "center" ? node.strokeWidth / 2 : 0;
    return ellipseContains(local, node.width, node.height, extent);
  }
  if (node.kind === "frame" || node.kind === "rectangle" || node.kind === "section") return roundedRectContains(local, node.width, node.height, node.radius, node.cornerRadii, node.cornerSmoothing);
  return local.x >= 0 && local.x <= node.width && local.y >= 0 && local.y <= node.height;
}

function lineCapContains(cap: CanvasNode["strokeCapStart"], point: WorldPoint, endpoint: number, direction: -1 | 1, half: number, dashPaintedAtEndpoint: boolean) {
  if (half <= 0) return false;
  if ((cap === "square" || cap === "round") && !dashPaintedAtEndpoint) return false;
  if (cap === "square") return direction < 0
    ? point.x >= endpoint - half && point.x <= endpoint && Math.abs(point.y) <= half
    : point.x >= endpoint && point.x <= endpoint + half && Math.abs(point.y) <= half;
  if (cap === "round") return Math.hypot(point.x - endpoint, point.y) <= half;
  return false;
}

/** Mirrors Canvas/Figma's odd-array expansion, so a dash gap cannot select a
 * line through the exact-hit path. Invalid data falls back to a solid stroke;
 * the durable Core rejects such input before it can be persisted. */
export function strokeDashContains(distance: number, pattern: readonly number[] | undefined): boolean {
  if (!pattern?.length) return true;
  if (!pattern.every((segment) => Number.isFinite(segment) && segment >= 0) || !pattern.some((segment) => segment > 0)) return true;
  const cycle = pattern.length % 2 === 0 ? pattern : [...pattern, ...pattern];
  const total = cycle.reduce((sum, segment) => sum + segment, 0);
  if (total <= 0) return true;
  let offset = ((distance % total) + total) % total;
  for (let index = 0; index < cycle.length; index += 1) {
    const segment = cycle[index];
    if (offset < segment) return index % 2 === 0;
    offset -= segment;
  }
  return true;
}

export function findTopmostHit(nodes: readonly CanvasNode[], point: WorldPoint): CanvasNode | undefined {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const hits = [...nodes].reverse().filter((node) => node.visible !== false && !isEffectivelyLocked(nodesById, node.id) && nodeContainsWorldPoint(node, point));
  // Group has no paint of its own. When its derived bounds overlap a child,
  // target the visible child first; the Group remains directly selectable in
  // blank parts of its bounds and from the Layers panel.
  return hits.find((node) => node.kind !== "group") ?? hits[0];
}

function toLocalPoint(node: CanvasNode, point: WorldPoint): WorldPoint {
  const radians = (Number.isFinite(node.rotation) ? node.rotation : 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  if (node.kind === "line") {
    const dx = point.x - node.x;
    const dy = point.y - node.y;
    return { x: cos * dx + sin * dy, y: -sin * dx + cos * dy };
  }
  const dx = point.x - (node.x + node.width / 2);
  const dy = point.y - (node.y + node.height / 2);
  return { x: cos * dx + sin * dy + node.width / 2, y: -sin * dx + cos * dy + node.height / 2 };
}

function ellipseContains(point: WorldPoint, width: number, height: number, strokeExtent = 0): boolean {
  const radiusX = width / 2 + Math.max(0, strokeExtent);
  const radiusY = height / 2 + Math.max(0, strokeExtent);
  const x = (point.x - width / 2) / radiusX;
  const y = (point.y - height / 2) / radiusY;
  return x * x + y * y <= 1;
}

function ellipseArcContains(point: WorldPoint, width: number, height: number, arc: NonNullable<CanvasNode["arcData"]>): boolean {
  const radiusX = width / 2;
  const radiusY = height / 2;
  const x = (point.x - radiusX) / radiusX;
  const y = (point.y - radiusY) / radiusY;
  const radius = Math.hypot(x, y);
  if (radius > 1 || radius < arc.innerRadius) return false;
  const fullTurn = Math.PI * 2;
  const rawSweep = (arc.endingAngle - arc.startingAngle) * Math.PI / 180;
  if (Math.abs(rawSweep) >= fullTurn - 1e-9) return true;
  const normalize = (value: number) => ((value % fullTurn) + fullTurn) % fullTurn;
  const sweep = normalize(rawSweep);
  if (sweep <= 1e-9) return false;
  const angle = normalize(Math.atan2(y, x));
  const start = normalize(arc.startingAngle * Math.PI / 180);
  return normalize(angle - start) <= sweep + 1e-9;
}

function roundedRectContains(point: WorldPoint, width: number, height: number, radius: number, cornerRadii?: CanvasNode["cornerRadii"], cornerSmoothing?: number): boolean {
  if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) return false;
  const [topLeft, topRight, bottomRight, bottomLeft] = resolveCornerRadii(width, height, radius, cornerRadii);
  const topLeftCorner = point.x < topLeft && point.y < topLeft;
  const topRightCorner = point.x > width - topRight && point.y < topRight;
  const bottomRightCorner = point.x > width - bottomRight && point.y > height - bottomRight;
  const bottomLeftCorner = point.x < bottomLeft && point.y > height - bottomLeft;
  const cornerRadius = topLeftCorner ? topLeft : topRightCorner ? topRight : bottomRightCorner ? bottomRight : bottomLeftCorner ? bottomLeft : 0;
  if (cornerRadius === 0) return true;
  const cornerX = topLeftCorner || bottomLeftCorner ? cornerRadius : width - cornerRadius;
  const cornerY = topLeftCorner || topRightCorner ? cornerRadius : height - cornerRadius;
  const dx = point.x - cornerX;
  const dy = point.y - cornerY;
  const smoothing = resolveCornerSmoothing(cornerSmoothing);
  if (smoothing > 0) {
    const exponent = cornerSmoothingExponent(smoothing);
    return (Math.abs(dx) / cornerRadius) ** exponent + (Math.abs(dy) / cornerRadius) ** exponent <= 1;
  }
  return dx * dx + dy * dy <= cornerRadius * cornerRadius;
}
