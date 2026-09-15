import type { CanvasNode, DocumentTextPathMetadata, DocumentVectorPath } from "./editor-protocol";

export type TextPathGlyph = Readonly<{ text: string; x: number; y: number; angle: number }>;
export type TextPathSegment = Readonly<{ start: Point; end: Point; length: number; angle: number }>;
export type TextPathGeometry = Readonly<{
  segments: readonly TextPathSegment[];
  length: number;
}>;
export type TextPathPlacement = Readonly<{ start: number; gap: number; vertical: number }>;

export function textPathPlacement(
  metadata: DocumentTextPathMetadata,
  pathLength: number,
  occupied: number,
  itemCount: number,
  verticalUnit: number,
): TextPathPlacement | undefined {
  if (![pathLength, occupied, verticalUnit].every(Number.isFinite) || pathLength <= 0 || occupied < 0 || verticalUnit <= 0 || !Number.isSafeInteger(itemCount) || itemCount < 0) return undefined;
  const baseStart = pathLength * metadata.startPosition;
  const available = Math.max(0, pathLength - baseStart);
  const gap = metadata.textAlignHorizontal === "JUSTIFIED" && itemCount > 1 && occupied < available
    ? (available - occupied) / (itemCount - 1)
    : 0;
  const alignedWidth = occupied + gap * Math.max(0, itemCount - 1);
  const alignmentOffset = metadata.textAlignHorizontal === "CENTER"
    ? (available - alignedWidth) / 2
    : metadata.textAlignHorizontal === "RIGHT"
      ? available - alignedWidth
      : 0;
  const vertical = metadata.textAlignVertical === "TOP" ? verticalUnit * .4 : metadata.textAlignVertical === "BOTTOM" ? -verticalUnit * .4 : 0;
  return { start: Math.max(0, Math.min(pathLength, baseStart + alignmentOffset)), gap, vertical };
}

/**
 * M6's bounded text-on-path layout. It flattens each Canonical cubic with
 * a fixed geometric tolerance, then uses a caller-provided fixed advance so
 * Canvas and SVG receive identical glyph poses when document-owned font bytes
 * are unavailable. Explicit fonts use the Rust glyph projection instead.
 */
export function layoutTextPath(node: Pick<CanvasNode, "kind" | "text" | "vectorPath" | "textPathMetadata">, advance: number): readonly TextPathGlyph[] | undefined {
  if (node.kind !== "textPath" || !Number.isFinite(advance) || advance <= 0) return undefined;
  const text = node.text ?? "";
  if (!text) return [];
  const geometry = textPathGeometry(node.vectorPath, node.textPathMetadata);
  if (!geometry) return undefined;
  const { segments, length } = geometry;
  const metadata = node.textPathMetadata!;
  const glyphs = [...text];
  const placement = textPathPlacement(metadata, length, glyphs.length * advance, glyphs.length, advance);
  if (!placement) return undefined;
  return glyphs.flatMap((text, index) => {
    const pose = textPathPoseAt(segments, placement.start + index * (advance + placement.gap) + advance / 2);
    if (!pose) return [];
    const normal = { x: -Math.sin(pose.angle), y: Math.cos(pose.angle) };
    return [{ text, x: pose.x + normal.x * placement.vertical, y: pose.y + normal.y * placement.vertical, angle: pose.angle }];
  });
}

/** Resolves the bounded path traversal shared by Canvas, WebGPU and SVG. */
export function textPathGeometry(path: DocumentVectorPath | undefined, metadata: DocumentTextPathMetadata | undefined): TextPathGeometry | undefined {
  if (!path || !metadata || !Number.isSafeInteger(metadata.startSegment) || metadata.startSegment < 0 || !Number.isFinite(metadata.startPosition) || metadata.startPosition < 0 || metadata.startPosition > 1 || !["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(metadata.textAlignHorizontal) || !["TOP", "CENTER", "BOTTOM"].includes(metadata.textAlignVertical)) return undefined;
  const subpath = path.subpaths.find((candidate) => candidate.points.length >= 2);
  if (!subpath) return undefined;
  const segmentCount = subpath.closed ? subpath.points.length : subpath.points.length - 1;
  if (metadata.startSegment >= segmentCount) return undefined;
  const points: Point[] = [];
  const traversalCount = subpath.closed ? segmentCount : segmentCount - metadata.startSegment;
  for (let offset = 0; offset < traversalCount; offset += 1) {
    const index = (metadata.startSegment + offset) % subpath.points.length;
    const from = subpath.points[index]!;
    const to = subpath.points[(index + 1) % subpath.points.length]!;
    if (!points.length) points.push({ x: from.x, y: from.y });
    const control1 = from.handleOut ? { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y } : from;
    const control2 = to.handleIn ? { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y } : to;
    if (!from.handleOut && !to.handleIn) points.push({ x: to.x, y: to.y });
    else if (!flattenCubic(points, from, control1, control2, to)) return undefined;
  }
  const segments = segmentsFor(points);
  const length = segments.reduce((sum, segment) => sum + segment.length, 0);
  return length > 0 ? { segments, length } : undefined;
}

/** Keeps authored cubic handles while rotating/slicing the selected traversal
 * so native SVG textPath starts at the same Canonical segment as Canvas. */
export function textPathTraversalVectorPath(path: DocumentVectorPath | undefined, metadata: DocumentTextPathMetadata | undefined): DocumentVectorPath | undefined {
  if (!path || !metadata || !Number.isSafeInteger(metadata.startSegment) || metadata.startSegment < 0) return undefined;
  const subpath = path.subpaths.find((candidate) => candidate.points.length >= 2);
  if (!subpath) return undefined;
  const segmentCount = subpath.closed ? subpath.points.length : subpath.points.length - 1;
  if (metadata.startSegment >= segmentCount) return undefined;
  const points = subpath.closed
    ? [...subpath.points.slice(metadata.startSegment), ...subpath.points.slice(0, metadata.startSegment)]
    : subpath.points.slice(metadata.startSegment);
  return {
    fillRule: path.fillRule,
    subpaths: [{ closed: subpath.closed, points: structuredClone(points) }],
  };
}
type Point = Readonly<{ x: number; y: number }>;
function segmentsFor(points: readonly Point[]): readonly TextPathSegment[] {
  return points.slice(1).flatMap((end, index) => {
    const start = points[index]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    return length > 1e-9 ? [{ start, end, length, angle: Math.atan2(end.y - start.y, end.x - start.x) }] : [];
  });
}
export function textPathPoseAt(segments: readonly TextPathSegment[], distance: number): Readonly<{ x: number; y: number; angle: number }> | undefined {
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
