import type { CanvasNode } from "./editor-protocol";

export interface MarqueePoint { x: number; y: number }
export interface MarqueeRect { x: number; y: number; width: number; height: number }

export const MARQUEE_DRAG_THRESHOLD_PX = 3;

/** Keeps an ordinary click (and small pointer jitter) out of marquee selection. */
export function exceedsMarqueeDragThreshold(start: MarqueePoint, end: MarqueePoint, threshold = MARQUEE_DRAG_THRESHOLD_PX): boolean {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  return deltaX * deltaX + deltaY * deltaY >= threshold * threshold;
}

export function marqueeRect(start: MarqueePoint, end: MarqueePoint): MarqueeRect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function rotatedNodeBounds(node: Pick<CanvasNode, "kind" | "x" | "y" | "width" | "height" | "rotation" | "strokeWidth" | "strokeCapStart" | "strokeCapEnd" | "strokeDashPattern">): MarqueeRect {
  if (node.kind === "line") return rotatedLineBounds(node);
  const radians = node.rotation * Math.PI / 180;
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  const extentX = Math.abs(Math.cos(radians)) * halfWidth + Math.abs(Math.sin(radians)) * halfHeight;
  const extentY = Math.abs(Math.sin(radians)) * halfWidth + Math.abs(Math.cos(radians)) * halfHeight;
  return { x: node.x + halfWidth - extentX, y: node.y + halfHeight - extentY, width: extentX * 2, height: extentY * 2 };
}

/**
 * A Line has zero document height, but its visual and selectable footprint
 * does not. Keeping this local rectangle centred on y=0 lets drawing, hover,
 * selection, marquee and culling agree on the same geometry.
 */
export function lineLocalBounds(
  node: Pick<CanvasNode, "width" | "strokeWidth" | "strokeCapStart" | "strokeCapEnd" | "strokeDashPattern">,
  minimumHalfHeight = 0,
): MarqueeRect {
  const strokeHalf = Math.max(0, Number.isFinite(node.strokeWidth) ? node.strokeWidth / 2 : 0);
  const hasMarker = [node.strokeCapStart, node.strokeCapEnd].some((cap) => cap === "arrowLines" || cap === "arrowEquilateral" || cap === "diamondFilled" || cap === "triangleFilled" || cap === "circleFilled");
  const markerHalfHeight = hasMarker
    ? Math.max(8, node.strokeWidth * 4) / 2
    : 0;
  const [drawsAtStart, drawsAtEnd] = dashedLineEndpointPaint(node.width, node.strokeDashPattern);
  const startExtension = lineCapExtension(effectiveLineCap(node, node.strokeCapStart), strokeHalf, markerHalfHeight, drawsAtStart);
  const endExtension = lineCapExtension(effectiveLineCap(node, node.strokeCapEnd), strokeHalf, markerHalfHeight, drawsAtEnd);
  const halfHeight = Math.max(minimumHalfHeight, strokeHalf, markerHalfHeight);
  return { x: startExtension ? -startExtension : 0, y: -halfHeight, width: Math.max(0, node.width) + startExtension + endExtension, height: halfHeight * 2 };
}

/**
 * Figma reports a Line's height as zero in its dimensions, but its blue
 * selection frame surrounds the painted stroke. Use the visual local bounds
 * here so that the top and bottom edges stay equidistant from the path at all
 * rotations, and endpoint caps/decorations cannot stick out of the highlight.
 * The inspector still reads the zero-height document geometry from the node.
 */
export function lineSelectionBounds(
  node: Pick<CanvasNode, "width" | "strokeWidth" | "strokeCapStart" | "strokeCapEnd" | "strokeDashPattern">,
): MarqueeRect {
  return lineLocalBounds(node);
}

/** Canvas uses Butt for a dashed Line with independent round/square endpoint
 * settings; there is no single native `lineCap` that preserves both ends. */
export function hasAsymmetricDashedCaps(node: Pick<CanvasNode, "strokeDashPattern" | "strokeCapStart" | "strokeCapEnd">) {
  return Boolean(node.strokeDashPattern?.length) && node.strokeCapStart !== node.strokeCapEnd;
}

export function effectiveLineCap(node: Pick<CanvasNode, "strokeDashPattern" | "strokeCapStart" | "strokeCapEnd">, cap: CanvasNode["strokeCapStart"]) {
  return hasAsymmetricDashedCaps(node) && (cap === "round" || cap === "square") ? "none" : cap;
}

function lineCapExtension(cap: CanvasNode["strokeCapStart"], strokeHalf: number, markerHalfHeight: number, dashPaintedAtEndpoint: boolean) {
  return cap === "round" || cap === "square" ? (dashPaintedAtEndpoint ? strokeHalf : 0) : cap === "circleFilled" ? markerHalfHeight : 0;
}

/** Returns whether the first and last document endpoints contain a painted
 * dash. Solid and invalid/empty patterns are treated as one visible run. */
export function dashedLineEndpointPaint(width: number, pattern: CanvasNode["strokeDashPattern"]): [boolean, boolean] {
  if (!pattern?.length || !Number.isFinite(width) || width <= 0 || !pattern.every((segment) => Number.isFinite(segment) && segment >= 0) || !pattern.some((segment) => segment > 0)) return [true, true];
  let cursor = 0;
  let index = 0;
  let draw = true;
  let start = false;
  let end = false;
  const limit = pattern.length * 2 + Math.ceil(width / Math.max(...pattern)) * pattern.length;
  for (let step = 0; cursor < width && step < limit; step += 1) {
    const length = pattern[index % pattern.length];
    index += 1;
    if (length === 0) { draw = !draw; continue; }
    const next = Math.min(width, cursor + length);
    if (draw) {
      if (cursor === 0) start = true;
      if (next === width) end = true;
    }
    cursor = next;
    draw = !draw;
  }
  return [start, end];
}

function rotatedLineBounds(node: Pick<CanvasNode, "kind" | "x" | "y" | "width" | "rotation" | "strokeWidth" | "strokeCapStart" | "strokeCapEnd" | "strokeDashPattern">): MarqueeRect {
  const local = lineLocalBounds(node, Math.max(4, node.strokeWidth / 2));
  const radians = node.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    [local.x, local.y], [local.x + local.width, local.y],
    [local.x, local.y + local.height], [local.x + local.width, local.y + local.height],
  ].map(([x, y]) => ({ x: node.x + cos * x - sin * y, y: node.y + sin * x + cos * y }));
  const left = Math.min(...corners.map((point) => point.x));
  const top = Math.min(...corners.map((point) => point.y));
  const right = Math.max(...corners.map((point) => point.x));
  const bottom = Math.max(...corners.map((point) => point.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function overlaps(first: MarqueeRect, second: MarqueeRect): boolean {
  return first.x < second.x + second.width && first.x + first.width > second.x && first.y < second.y + second.height && first.y + first.height > second.y;
}

/** Returns visible layers touched by a world-space marquee, in document order. */
export function selectNodesInMarquee(nodes: readonly CanvasNode[], start: MarqueePoint, end: MarqueePoint): string[] {
  const selection = marqueeRect(start, end);
  if (selection.width === 0 && selection.height === 0) return [];
  return nodes.filter((node) => node.visible !== false && overlaps(selection, rotatedNodeBounds(node))).map((node) => node.id);
}

/** Shift-marquee appends layers; an ordinary marquee replaces the selection. */
export function resolveMarqueeSelection(initialIds: readonly string[], marqueeIds: readonly string[], additive: boolean): string[] {
  return additive ? [...new Set([...initialIds, ...marqueeIds])] : [...marqueeIds];
}
