import type { CanvasNode, DocumentTextPathMetadata, DocumentVectorPath } from "./editor-protocol";

export type TextPathGlyph = Readonly<{ text: string; x: number; y: number; angle: number }>;

/**
 * M6's bounded text-on-path layout. It flattens each open Canonical cubic with
 * a fixed geometric tolerance, then uses a caller-provided fixed advance so
 * Canvas and SVG receive identical glyph poses. Shaping, bidi and rich runs
 * remain explicit fallbacks until frozen Core advances are available to both
 * backends.
 */
export function layoutTextPath(node: Pick<CanvasNode, "kind" | "text" | "vectorPath" | "textPathMetadata">, advance: number): readonly TextPathGlyph[] | undefined {
  if (node.kind !== "textPath" || !Number.isFinite(advance) || advance <= 0) return undefined;
  const text = node.text ?? "";
  if (!text) return [];
  const segments = textPathSegments(node.vectorPath, node.textPathMetadata);
  if (!segments) return undefined;
  const metadata = node.textPathMetadata!;
  const length = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (!length) return undefined;
  const glyphs = [...text];
  const glyphSpan = glyphs.length * advance;
  const justifyAdvance = metadata.textAlignHorizontal === "JUSTIFIED" && glyphs.length > 1 && glyphSpan < length
    ? (length - advance) / (glyphs.length - 1)
    : advance;
  const occupied = glyphs.length * justifyAdvance;
  const alignmentOffset = metadata.textAlignHorizontal === "CENTER" ? (length - occupied) / 2 : metadata.textAlignHorizontal === "RIGHT" ? length - occupied : 0;
  const start = Math.max(0, Math.min(length, length * metadata.startPosition + alignmentOffset));
  const vertical = metadata.textAlignVertical === "TOP" ? advance * .4 : metadata.textAlignVertical === "BOTTOM" ? -advance * .4 : 0;
  return glyphs.flatMap((text, index) => {
    const pose = poseAt(segments, start + (index + .5) * justifyAdvance);
    if (!pose) return [];
    const normal = { x: -Math.sin(pose.angle), y: Math.cos(pose.angle) };
    return [{ text, x: pose.x + normal.x * vertical, y: pose.y + normal.y * vertical, angle: pose.angle }];
  });
}

function textPathSegments(path: DocumentVectorPath | undefined, metadata: DocumentTextPathMetadata | undefined): readonly Segment[] | undefined {
  if (!path || !metadata || !Number.isSafeInteger(metadata.startSegment) || metadata.startSegment < 0 || !Number.isFinite(metadata.startPosition) || metadata.startPosition < 0 || metadata.startPosition > 1 || !["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(metadata.textAlignHorizontal) || !["TOP", "CENTER", "BOTTOM"].includes(metadata.textAlignVertical)) return undefined;
  const subpath = path.subpaths.find((candidate) => !candidate.closed && candidate.points.length >= 2);
  if (!subpath || metadata.startSegment >= subpath.points.length - 1) return undefined;
  const points: Point[] = [];
  for (let index = metadata.startSegment; index < subpath.points.length - 1; index += 1) {
    const from = subpath.points[index]!;
    const to = subpath.points[index + 1]!;
    if (!points.length) points.push({ x: from.x, y: from.y });
    const control1 = from.handleOut ? { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y } : from;
    const control2 = to.handleIn ? { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y } : to;
    if (!from.handleOut && !to.handleIn) points.push({ x: to.x, y: to.y });
    else if (!flattenCubic(points, from, control1, control2, to)) return undefined;
  }
  return segmentsFor(points);
}
type Point = Readonly<{ x: number; y: number }>;
type Segment = Readonly<{ start: Point; end: Point; length: number; angle: number }>;
function segmentsFor(points: readonly Point[]): readonly Segment[] {
  return points.slice(1).flatMap((end, index) => {
    const start = points[index]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    return length > 1e-9 ? [{ start, end, length, angle: Math.atan2(end.y - start.y, end.x - start.x) }] : [];
  });
}
function poseAt(segments: readonly Segment[], distance: number): Readonly<{ x: number; y: number; angle: number }> | undefined {
  let remaining = Math.max(0, distance);
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const t = remaining / segment.length;
      return { x: segment.start.x + (segment.end.x - segment.start.x) * t, y: segment.start.y + (segment.end.y - segment.start.y) * t, angle: segment.angle };
    }
    remaining -= segment.length;
  }
  return undefined;
}

const FLATTEN_TOLERANCE = .25;
const MAX_FLATTENED_POINTS = 4_096;
const MAX_FLATTEN_DEPTH = 20;
function flattenCubic(result: Point[], from: Point, control1: Point, control2: Point, to: Point, depth = 0): boolean {
  if (result.length >= MAX_FLATTENED_POINTS) return false;
  if (depth >= MAX_FLATTEN_DEPTH || cubicFlatEnough(from, control1, control2, to)) {
    result.push({ x: to.x, y: to.y });
    return true;
  }
  const first = midpoint(from, control1);
  const middle = midpoint(control1, control2);
  const last = midpoint(control2, to);
  const leftEnd = midpoint(first, middle);
  const rightStart = midpoint(middle, last);
  const center = midpoint(leftEnd, rightStart);
  return flattenCubic(result, from, first, leftEnd, center, depth + 1)
    && flattenCubic(result, center, rightStart, last, to, depth + 1);
}
function midpoint(left: Point, right: Point): Point { return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }; }
function cubicFlatEnough(from: Point, control1: Point, control2: Point, to: Point): boolean {
  const dx = to.x - from.x; const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  if (chord <= 1e-9) return Math.max(Math.hypot(control1.x - from.x, control1.y - from.y), Math.hypot(control2.x - from.x, control2.y - from.y)) <= FLATTEN_TOLERANCE;
  const distance = (point: Point) => Math.abs(dy * point.x - dx * point.y + to.x * from.y - to.y * from.x) / chord;
  return Math.max(distance(control1), distance(control2)) <= FLATTEN_TOLERANCE;
}
