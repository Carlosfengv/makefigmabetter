import type { DocumentVectorPath } from "./editor-protocol";

type Point = Readonly<{ x: number; y: number }>;

/** Draws ADR 0027's relative-handle cubic segments into an existing Canvas path. */
export function traceVectorPath(ctx: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "bezierCurveTo" | "closePath">, path: DocumentVectorPath, scale = 1) {
  for (const subpath of path.subpaths) {
    const first = subpath.points[0];
    if (!first) continue;
    ctx.moveTo(first.x * scale, first.y * scale);
    for (let index = 1; index < subpath.points.length; index += 1) traceSegment(ctx, subpath.points[index - 1], subpath.points[index], scale);
    if (subpath.closed && subpath.points.length > 1) {
      traceSegment(ctx, subpath.points[subpath.points.length - 1], first, scale);
      ctx.closePath();
    }
  }
}

/** Serializes the same segment construction for SVG. */
export function vectorPathSvgD(path: DocumentVectorPath, number: (value: number) => string = String): string {
  return path.subpaths.flatMap((subpath) => {
    const first = subpath.points[0];
    if (!first) return [];
    const commands = [`M ${number(first.x)} ${number(first.y)}`];
    for (let index = 1; index < subpath.points.length; index += 1) commands.push(svgSegment(subpath.points[index - 1], subpath.points[index], number));
    if (subpath.closed && subpath.points.length > 1) {
      commands.push(svgSegment(subpath.points[subpath.points.length - 1], first, number), "Z");
    }
    return commands;
  }).join(" ");
}

/** Deterministic fill hit testing using cubic flattening shared by all path types. */
export function vectorPathContains(path: DocumentVectorPath, point: Point): boolean {
  const contours: Point[][] = [];
  let remainingPoints = MAX_HIT_FLATTENED_POINTS;
  for (const subpath of path.subpaths) {
    if (!subpath.closed || subpath.points.length < 3) continue;
    const contour = flattenSubpath(subpath, remainingPoints);
    // Match the Core geometry safety contract: a path whose derived hit
    // geometry exceeds its fixed budget is not selectable through this
    // fallback rather than allocating without bound on the UI thread.
    if (!contour) return false;
    remainingPoints -= contour.length;
    contours.push(contour);
  }
  // Canvas fills include their contour boundary. Preserve that selection
  // contract before applying either fill-rule: a point exactly on an outer
  // edge or a hole edge is still a hit, rather than depending on a ray's
  // browser-specific vertex tie-break.
  if (contours.some((contour) => pointOnPolygonEdge(point, contour))) return true;
  if (path.fillRule === "evenOdd") return contours.reduce((inside, contour) => pointInPolygon(point, contour) ? !inside : inside, false);
  return contours.reduce((winding, contour) => winding + windingNumber(point, contour), 0) !== 0;
}

function traceSegment(ctx: Pick<CanvasRenderingContext2D, "lineTo" | "bezierCurveTo">, from: DocumentVectorPath["subpaths"][number]["points"][number], to: DocumentVectorPath["subpaths"][number]["points"][number], scale: number) {
  const control1 = from.handleOut && { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y };
  const control2 = to.handleIn && { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y };
  if (control1 || control2) ctx.bezierCurveTo((control1?.x ?? from.x) * scale, (control1?.y ?? from.y) * scale, (control2?.x ?? to.x) * scale, (control2?.y ?? to.y) * scale, to.x * scale, to.y * scale);
  else ctx.lineTo(to.x * scale, to.y * scale);
}

function svgSegment(from: DocumentVectorPath["subpaths"][number]["points"][number], to: DocumentVectorPath["subpaths"][number]["points"][number], number: (value: number) => string) {
  const control1 = from.handleOut && { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y };
  const control2 = to.handleIn && { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y };
  return control1 || control2
    ? `C ${number(control1?.x ?? from.x)} ${number(control1?.y ?? from.y)} ${number(control2?.x ?? to.x)} ${number(control2?.y ?? to.y)} ${number(to.x)} ${number(to.y)}`
    : `L ${number(to.x)} ${number(to.y)}`;
}

function flattenSubpath(subpath: DocumentVectorPath["subpaths"][number], maximumPoints: number): Point[] | undefined {
  const result: Point[] = [];
  for (let index = 0; index < subpath.points.length; index += 1) {
    if (result.length >= maximumPoints) return undefined;
    const from = subpath.points[index];
    const to = subpath.points[(index + 1) % subpath.points.length];
    result.push({ x: from.x, y: from.y });
    const control1 = from.handleOut && { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y };
    const control2 = to.handleIn && { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y };
    if (control1 || control2) {
      if (!flattenCubic(result, from, control1 ?? from, control2 ?? to, to, maximumPoints)) return undefined;
    }
  }
  return result;
}

const HIT_FLATTENING_TOLERANCE = .25;
const MAX_HIT_FLATTENING_DEPTH = 24;
const MAX_HIT_FLATTENED_POINTS = 262_144;

/** Fixed samples can move a steep cubic by hundreds of document units. Use a
 * bounded adaptive approximation for the shared fallback hit-test path. */
function flattenCubic(result: Point[], from: Point, control1: Point, control2: Point, to: Point, maximumPoints: number, depth = 0): boolean {
  if (depth >= MAX_HIT_FLATTENING_DEPTH || cubicFlatEnough(from, control1, control2, to)) return true;
  const fromControl1 = midpoint(from, control1);
  const control1Control2 = midpoint(control1, control2);
  const control2To = midpoint(control2, to);
  const leftRight = midpoint(fromControl1, control1Control2);
  const rightLeft = midpoint(control1Control2, control2To);
  const middle = midpoint(leftRight, rightLeft);
  if (!flattenCubic(result, from, fromControl1, leftRight, middle, maximumPoints, depth + 1)) return false;
  if (result.length >= maximumPoints) return false;
  result.push(middle);
  return flattenCubic(result, middle, rightLeft, control2To, to, maximumPoints, depth + 1);
}

function midpoint(left: Point, right: Point): Point { return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }; }

function cubicFlatEnough(from: Point, control1: Point, control2: Point, to: Point) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chordLength = Math.hypot(dx, dy);
  if (chordLength <= 1e-9) return Math.max(Math.hypot(control1.x - from.x, control1.y - from.y), Math.hypot(control2.x - from.x, control2.y - from.y)) <= HIT_FLATTENING_TOLERANCE;
  const distance = (point: Point) => Math.abs(dy * point.x - dx * point.y + to.x * from.y - to.y * from.x) / chordLength;
  return Math.max(distance(control1), distance(control2)) <= HIT_FLATTENING_TOLERANCE;
}

function pointInPolygon(point: Point, polygon: readonly Point[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]; const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function pointOnPolygonEdge(point: Point, polygon: readonly Point[]) {
  // Coordinates originate in Canonical document units, not screen pixels.
  // This tolerance covers normal floating-point interpolation while remaining
  // far below an intentional 1/1000 document-unit hit target.
  const epsilon = 1e-6;
  const toleranceSquared = epsilon * epsilon;
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index];
    const to = polygon[(index + 1) % polygon.length];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)) : 0;
    const nearestX = from.x + dx * ratio;
    const nearestY = from.y + dy * ratio;
    const distanceX = point.x - nearestX;
    const distanceY = point.y - nearestY;
    if (distanceX * distanceX + distanceY * distanceY <= toleranceSquared) return true;
  }
  return false;
}

function windingNumber(point: Point, polygon: readonly Point[]) {
  let winding = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]; const b = polygon[(index + 1) % polygon.length];
    if (a.y <= point.y && b.y > point.y && isLeft(a, b, point) > 0) winding += 1;
    else if (a.y > point.y && b.y <= point.y && isLeft(a, b, point) < 0) winding -= 1;
  }
  return winding;
}

function isLeft(a: Point, b: Point, point: Point) { return (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y); }
