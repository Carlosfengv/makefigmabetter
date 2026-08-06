import type { CanvasNode } from "./editor-protocol";

/** Canonical 2D affine matrix, using the Canvas/Figma convention:
 * x' = ax + cy + e, y' = bx + dy + f. The module intentionally has no DOM
 * dependency, so rendering, hit testing and hierarchy mutation can share it. */
export type AffineMatrix = Readonly<{ a: number; b: number; c: number; d: number; e: number; f: number }>;
export type TransformPoint = Readonly<{ x: number; y: number }>;
export type TransformBounds = Readonly<{ left: number; top: number; right: number; bottom: number }>;

export const IDENTITY_AFFINE: AffineMatrix = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** Returns `parent × child`: applying `child` first, then `parent`. */
export function multiplyAffine(parent: AffineMatrix, child: AffineMatrix): AffineMatrix {
  return normalizeAffine({
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    e: parent.a * child.e + parent.c * child.f + parent.e,
    f: parent.b * child.e + parent.d * child.f + parent.f,
  });
}

export function invertAffine(matrix: AffineMatrix): AffineMatrix | undefined {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) return undefined;
  return normalizeAffine({
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  });
}

export function transformPoint(matrix: AffineMatrix, point: TransformPoint): TransformPoint {
  return { x: normalizeZero(matrix.a * point.x + matrix.c * point.y + matrix.e), y: normalizeZero(matrix.b * point.x + matrix.d * point.y + matrix.f) };
}

/** Builds a node's parent-relative transform from its familiar x/y/size/rotation
 * properties. Closed nodes rotate around their visual centre. A Line instead
 * uses its first endpoint as local origin, matching Canvas line painting and
 * Figma's endpoint-editing semantics. */
export function nodeRelativeTransform(node: Pick<CanvasNode, "kind" | "x" | "y" | "width" | "height" | "rotation">): AffineMatrix | undefined {
  const explicit = (node as Pick<CanvasNode, "relativeTransform">).relativeTransform;
  if (explicit) return isInvertibleAffine(explicit) ? explicit : undefined;
  if (![node.x, node.y, node.width, node.height, node.rotation].every(Number.isFinite) || node.width < 0 || node.height < 0) return undefined;
  const radians = node.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  if (node.kind === "line") return normalizeAffine({ a: cosine, b: sine, c: -sine, d: cosine, e: node.x, f: node.y });
  const centerX = node.width / 2;
  const centerY = node.height / 2;
  return normalizeAffine({
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: node.x + centerX - cosine * centerX + sine * centerY,
    f: node.y + centerY - sine * centerX - cosine * centerY,
  });
}

/**
 * Resolves a node into world space during the migration:
 *
 * - a legacy node has no `relativeTransform`, so its x/y/rotation already are
 *   world coordinates and its parent is structural only;
 * - a node with `relativeTransform` is local to the resolved parent world
 *   transform (or Page world when it is a root).
 *
 * This keeps the existing Group data stable while allowing a Relative-v1
 * subtree to coexist in the same snapshot. Cycles and invalid transforms are
 * rejected rather than guessed.
 */
export function worldTransformForNode(nodes: readonly CanvasNode[], id: string): AffineMatrix | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let cursor = byId.get(id);
  while (cursor) {
    if (visited.has(cursor.id)) return undefined;
    visited.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  const resolved = new Map<string, AffineMatrix>();
  const resolve = (node: CanvasNode): AffineMatrix | undefined => {
    const cached = resolved.get(node.id);
    if (cached) return cached;
    const local = nodeRelativeTransform(node);
    if (!local) return undefined;
    if (!node.relativeTransform) {
      resolved.set(node.id, local);
      return local;
    }
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const world = parent ? resolve(parent) : local;
    const result = parent ? multiplyAffine(world!, local) : world;
    if (result) resolved.set(node.id, result);
    return result;
  };
  const node = byId.get(id);
  if (!node) return undefined;
  return resolve(node);
}

export function worldBoundsForNode(nodes: readonly CanvasNode[], node: CanvasNode): TransformBounds | undefined {
  const transform = worldTransformForNode(nodes, node.id);
  if (!transform) return undefined;
  const points = [
    transformPoint(transform, { x: 0, y: 0 }),
    transformPoint(transform, { x: node.width, y: 0 }),
    transformPoint(transform, { x: node.width, y: node.height }),
    transformPoint(transform, { x: 0, y: node.height }),
  ];
  return {
    left: Math.min(...points.map((point) => point.x)), top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)), bottom: Math.max(...points.map((point) => point.y)),
  };
}

/**
 * Produces the existing Canvas projection fields for the common transform
 * subset (translation, rotation and positive non-skew scale). During
 * Dual-read, an arbitrary affine deliberately falls back to its retained
 * legacy projection instead of being approximated incorrectly. Full skew and
 * reflection painting will move to the matrix-native Canvas pass.
 */
export function worldSpaceProjectionNode(nodes: readonly CanvasNode[], node: CanvasNode): CanvasNode | undefined {
  const world = worldTransformForNode(nodes, node.id);
  if (!world) return undefined;
  const scaleX = Math.hypot(world.a, world.b);
  const scaleY = Math.hypot(world.c, world.d);
  const determinant = world.a * world.d - world.b * world.c;
  const perpendicular = Math.abs(world.a * world.c + world.b * world.d);
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 1e-12 || scaleY <= 1e-12
    || determinant <= 1e-12 || perpendicular > 1e-9 * Math.max(1, scaleX * scaleY)) return undefined;
  const rotation = Math.atan2(world.b, world.a) * 180 / Math.PI;
  const width = node.width * scaleX;
  const height = node.height * scaleY;
  if (node.kind === "line") {
    return {
      ...node,
      x: normalizeZero(world.e),
      y: normalizeZero(world.f),
      width: normalizeZero(width),
      height: 0,
      rotation: normalizeZero(rotation),
      relativeTransform: undefined,
    };
  }
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    ...node,
    x: normalizeZero(world.e - width / 2 + cosine * width / 2 - sine * height / 2),
    y: normalizeZero(world.f - height / 2 + sine * width / 2 + cosine * height / 2),
    width: normalizeZero(width),
    height: normalizeZero(height),
    rotation: normalizeZero(rotation),
    relativeTransform: undefined,
  };
}

/** Converts a desired world transform into the node properties required below
 * `parentWorld`. This is the exact operation needed when reparenting while
 * preserving visual position; non-invertible parents are explicitly rejected.
 * The exact local affine is returned for the durable migration while x/y/rotation
 * remain populated as a legacy display fallback. */
export function nodePropsForWorldTransform(world: AffineMatrix, parentWorld: AffineMatrix | undefined, width: number, height: number): Pick<CanvasNode, "x" | "y" | "rotation" | "relativeTransform"> | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) return undefined;
  const parentInverse = parentWorld ? invertAffine(parentWorld) : IDENTITY_AFFINE;
  if (!parentInverse) return undefined;
  const relative = multiplyAffine(parentInverse, world);
  if (!isInvertibleAffine(relative)) return undefined;
  const rotation = Math.atan2(relative.b, relative.a) * 180 / Math.PI;
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = width / 2;
  const centerY = height / 2;
  return {
    x: normalizeZero(relative.e - centerX + cosine * centerX - sine * centerY),
    y: normalizeZero(relative.f - centerY + sine * centerX + cosine * centerY),
    rotation: normalizeZero(rotation),
    relativeTransform: relative,
  };
}

function isInvertibleAffine(matrix: AffineMatrix) {
  return Object.values(matrix).every(Number.isFinite) && Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) > 1e-12;
}

function normalizeAffine(matrix: AffineMatrix): AffineMatrix {
  if (!Object.values(matrix).every(Number.isFinite)) return { ...IDENTITY_AFFINE, e: Number.NaN, f: Number.NaN };
  return { a: normalizeZero(matrix.a), b: normalizeZero(matrix.b), c: normalizeZero(matrix.c), d: normalizeZero(matrix.d), e: normalizeZero(matrix.e), f: normalizeZero(matrix.f) };
}

function normalizeZero(value: number) { return Object.is(value, -0) ? 0 : value; }
