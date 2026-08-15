import type { StrokeCap } from "./editor-protocol";

export type DecorativeCapKind = "arrowLines" | "arrowEquilateral" | "triangleFilled" | "diamondFilled" | "circleFilled";

export type MeshPoint = Readonly<{ x: number; y: number }>;
export type MeshTriangle = readonly [MeshPoint, MeshPoint, MeshPoint];
export type MeshBounds = Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;

export type DecorativeCapMesh = Readonly<{ triangles: readonly MeshTriangle[]; bounds: MeshBounds | undefined }>;

/** The five Line endpoint markers whose geometry lives outside the shaft. */
export function isDecorativeCap(cap: StrokeCap | undefined): cap is DecorativeCapKind {
  return cap === "arrowLines" || cap === "arrowEquilateral" || cap === "triangleFilled" || cap === "diamondFilled" || cap === "circleFilled";
}

/** Canvas/Figma marker size rule; the single definition every consumer shares. */
export function decorativeCapSize(strokeWidth: number): number {
  return Math.max(8, (Number.isFinite(strokeWidth) ? strokeWidth : 0) * 4);
}

const ROUND_SEGMENTS = 16;

/**
 * Deterministic triangle mesh for a Line endpoint marker, in the Line's local
 * space where the shaft runs along +x. This mirrors the Rust
 * `editor_core::geometry::decorative_cap_mesh` exactly so Canvas rendering, hit
 * testing and SVG export share one outline instead of each re-deriving the
 * arrowhead. `endpoint` is the marker origin (`0` at the start, `width` at the
 * end); `direction` is `-1` at the start and `1` at the end. Triangles may
 * overlap on purpose — a single non-zero fill preserves their union.
 */
export function decorativeCapMesh(cap: DecorativeCapKind, endpoint: number, direction: -1 | 1, strokeWidth: number): DecorativeCapMesh {
  const size = decorativeCapSize(strokeWidth);
  const tip: MeshPoint = { x: endpoint, y: 0 };
  const backX = endpoint + direction * size;
  const triangles: MeshTriangle[] = [];
  if (cap === "arrowEquilateral" || cap === "triangleFilled") {
    const half = cap === "arrowEquilateral" ? size * Math.sqrt(3) / 4 : size * 0.42;
    triangles.push([tip, { x: backX, y: half }, { x: backX, y: -half }]);
  } else if (cap === "diamondFilled") {
    const half = size / 2;
    const middleX = endpoint + direction * half;
    triangles.push([tip, { x: middleX, y: half }, { x: backX, y: 0 }]);
    triangles.push([tip, { x: backX, y: 0 }, { x: middleX, y: -half }]);
  } else if (cap === "circleFilled") {
    const radius = size / 2;
    for (let index = 0; index < ROUND_SEGMENTS; index += 1) {
      const from = Math.PI * 2 * index / ROUND_SEGMENTS;
      const to = Math.PI * 2 * (index + 1) / ROUND_SEGMENTS;
      triangles.push([tip, { x: tip.x + radius * Math.cos(from), y: tip.y + radius * Math.sin(from) }, { x: tip.x + radius * Math.cos(to), y: tip.y + radius * Math.sin(to) }]);
    }
  } else {
    // arrowLines: two open barbs spread ±π/6, each a thin quad of the stroke
    // width so the union mesh reproduces the stroked barbs Canvas draws.
    const spread = Math.PI / 6;
    const half = Math.max(0.5, strokeWidth / 2);
    for (const sign of [1, -1] as const) {
      const angle = spread * sign;
      const barb: MeshPoint = { x: tip.x - direction * Math.cos(angle) * size, y: -Math.sin(angle) * size };
      appendThickSegment(triangles, tip, barb, half);
    }
  }
  return { triangles, bounds: boundsOf(triangles) };
}

/** True when `point` (Line-local) lies inside the marker's filled area. */
export function decorativeCapContains(cap: DecorativeCapKind, endpoint: number, direction: -1 | 1, strokeWidth: number, point: MeshPoint): boolean {
  return decorativeCapMesh(cap, endpoint, direction, strokeWidth).triangles.some((triangle) => pointInTriangle(point, triangle));
}

/**
 * Serializes the decorative cap mesh as an SVG path `d` string in the Line's
 * local space, so SVG export fills the exact same triangles the Canvas renderer
 * draws instead of relying on an independently sized `<marker>` element.
 */
export function decorativeCapMeshPath(cap: DecorativeCapKind, endpoint: number, direction: -1 | 1, strokeWidth: number, format: (value: number) => string): string {
  return decorativeCapMesh(cap, endpoint, direction, strokeWidth).triangles
    .map(([a, b, c]) => `M ${format(a.x)} ${format(a.y)} L ${format(b.x)} ${format(b.y)} L ${format(c.x)} ${format(c.y)} Z`)
    .join(" ");
}

function appendThickSegment(triangles: MeshTriangle[], from: MeshPoint, to: MeshPoint, half: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 1e-12 || half <= 0) return;
  const nx = -dy / length;
  const ny = dx / length;
  const a: MeshPoint = { x: from.x + nx * half, y: from.y + ny * half };
  const b: MeshPoint = { x: to.x + nx * half, y: to.y + ny * half };
  const c: MeshPoint = { x: to.x - nx * half, y: to.y - ny * half };
  const d: MeshPoint = { x: from.x - nx * half, y: from.y - ny * half };
  triangles.push([a, b, c]);
  triangles.push([a, c, d]);
}

function boundsOf(triangles: readonly MeshTriangle[]): MeshBounds | undefined {
  if (triangles.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  triangles.forEach((triangle) => triangle.forEach((point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }));
  return { minX, minY, maxX, maxY };
}

function pointInTriangle(point: MeshPoint, [a, b, c]: MeshTriangle): boolean {
  const d1 = sign(point, a, b);
  const d2 = sign(point, b, c);
  const d3 = sign(point, c, a);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function sign(p: MeshPoint, a: MeshPoint, b: MeshPoint): number {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}
