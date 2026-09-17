import type { CanvasNode } from "./editor-protocol";
import { normalizedNodeTransform } from "./normalized-node-view";

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
export function nodeRelativeTransform(node: Pick<CanvasNode, "kind" | "x" | "y" | "width" | "height" | "rotation" | "relativeTransform">): AffineMatrix | undefined {
  const normalized = normalizedNodeTransform(node);
  if (normalized.source === "relative-v1") return isInvertibleAffine(normalized.value) ? normalized.value : undefined;
  if (![node.x, node.y, node.width, node.height, node.rotation].every(Number.isFinite) || node.width < 0 || node.height < 0) return undefined;
  const radians = node.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  if (node.kind === "line" || node.kind === "connector") return normalizeAffine({ a: cosine, b: sine, c: -sine, d: cosine, e: node.x, f: node.y });
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
function createWorldTransformResolver(nodes: readonly CanvasNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const resolved = new Map<string, AffineMatrix>();
  const resolving = new Set<string>();
  const invalid = new Set<string>();
  const ancestryState = new Map<string, "resolving" | "valid" | "invalid">();
  const hasValidAncestry = (id: string): boolean => {
    const state = ancestryState.get(id);
    if (state === "valid") return true;
    if (state === "invalid" || state === "resolving") return false;
    const node = byId.get(id);
    if (!node) return true;
    ancestryState.set(id, "resolving");
    const valid = !node.parentId || !byId.has(node.parentId) || hasValidAncestry(node.parentId);
    ancestryState.set(id, valid ? "valid" : "invalid");
    return valid;
  };
  const resolve = (node: CanvasNode): AffineMatrix | undefined => {
    const cached = resolved.get(node.id);
    if (cached) return cached;
    if (invalid.has(node.id) || resolving.has(node.id) || !hasValidAncestry(node.id)) {
      invalid.add(node.id);
      return undefined;
    }
    resolving.add(node.id);
    const local = nodeRelativeTransform(node);
    if (!local) {
      resolving.delete(node.id);
      invalid.add(node.id);
      return undefined;
    }
    if (!node.relativeTransform) {
      resolving.delete(node.id);
      resolved.set(node.id, local);
      return local;
    }
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const parentWorld = parent ? resolve(parent) : undefined;
    const result = parent && !parentWorld
      ? undefined
      : parent
        ? multiplyAffine(parentWorld!, local)
        : local;
    resolving.delete(node.id);
    if (result) resolved.set(node.id, result);
    else invalid.add(node.id);
    return result;
  };

  return (id: string) => {
    const node = byId.get(id);
    return node ? resolve(node) : undefined;
  };
}

export function worldTransformForNode(nodes: readonly CanvasNode[], id: string): AffineMatrix | undefined {
  return createWorldTransformResolver(nodes)(id);
}

export function worldTransformsForNodes(nodes: readonly CanvasNode[]): ReadonlyMap<string, AffineMatrix> {
  const resolveWorld = createWorldTransformResolver(nodes);
  const transforms = new Map<string, AffineMatrix>();
  nodes.forEach((node) => {
    const transform = resolveWorld(node.id);
    if (transform) transforms.set(node.id, transform);
  });
  return transforms;
}

export function worldBoundsForTransform(node: CanvasNode, transform: AffineMatrix): TransformBounds {
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

export function worldBoundsForNode(nodes: readonly CanvasNode[], node: CanvasNode): TransformBounds | undefined {
  const transform = worldTransformForNode(nodes, node.id);
  if (!transform) return undefined;
  return worldBoundsForTransform(node, transform);
}

/**
 * Produces the existing Canvas projection fields for the common transform
 * subset (translation, rotation and positive non-skew scale). During
 * Dual-read, an arbitrary affine deliberately falls back to its retained
 * legacy projection instead of being approximated incorrectly. Full skew and
 * reflection painting will move to the matrix-native Canvas pass.
 */
function worldSpaceProjectionForTransform(node: CanvasNode, world: AffineMatrix): CanvasNode | undefined {
  const scaleX = Math.hypot(world.a, world.b);
  const scaleY = Math.hypot(world.c, world.d);
  const determinant = world.a * world.d - world.b * world.c;
  const perpendicular = Math.abs(world.a * world.c + world.b * world.d);
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 1e-12 || scaleY <= 1e-12
    || determinant <= 1e-12 || perpendicular > 1e-9 * Math.max(1, scaleX * scaleY)) return undefined;
  const rotation = Math.atan2(world.b, world.a) * 180 / Math.PI;
  const width = node.width * scaleX;
  const height = node.height * scaleY;
  if (node.kind === "line" || node.kind === "connector") {
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

export function worldSpaceProjectionNode(nodes: readonly CanvasNode[], node: CanvasNode): CanvasNode | undefined {
  const world = worldTransformForNode(nodes, node.id);
  return world ? worldSpaceProjectionForTransform(node, world) : undefined;
}

/** Projects an entire document with one shared ancestry cache. This is the
 * switch-page/render-index path; resolving every node independently would
 * rebuild the same id map and parent chain thousands of times. */
export function worldSpaceProjectionNodes(nodes: readonly CanvasNode[]): CanvasNode[] {
  const resolveWorld = createWorldTransformResolver(nodes);
  return nodes.map((node) => {
    const world = resolveWorld(node.id);
    return world ? worldSpaceProjectionForTransform(node, world) ?? node : node;
  });
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

/**
 * Translates a node by a world-space delta and returns the geometry patch that
 * realizes it. The two transform models move differently and must not be
 * conflated:
 *
 * - a legacy node (no `relativeTransform`) has world x/y, so it moves by adding
 *   the delta to x/y — exactly the historical behaviour;
 * - a Relative-v1 node derives its world position from `relativeTransform`
 *   (x/y are only a display fallback), so a plain x/y patch is silently ignored
 *   by {@link worldSpaceProjectionNode}. Its world transform is translated and
 *   reprojected against the resolved parent world, yielding a fresh
 *   `relativeTransform`. This is the single defect behind grouped children and
 *   ungrouped nodes appearing frozen: both carry a `relativeTransform`.
 *
 * `snap` receives the resulting world origin so grid snapping stays uniform
 * across both models. Callers must pass the *pre-drag* document so a live drag
 * applies the total delta once instead of compounding each frame. A
 * non-invertible parent yields nothing, leaving the node untouched. */
export function translateNodeWorldPatch(
  nodes: readonly CanvasNode[],
  id: string,
  dx: number,
  dy: number,
  snap: (point: TransformPoint) => TransformPoint = (point) => point,
): Pick<CanvasNode, "x" | "y" | "rotation" | "relativeTransform"> | undefined {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return undefined;
  if (!node.relativeTransform) {
    const snapped = snap({ x: node.x + dx, y: node.y + dy });
    return { x: snapped.x, y: snapped.y, rotation: node.rotation, relativeTransform: undefined };
  }
  const world = worldTransformForNode(nodes, id);
  if (!world) return undefined;
  const parentWorld = node.parentId ? worldTransformForNode(nodes, node.parentId) : undefined;
  const snapped = snap({ x: world.e + dx, y: world.f + dy });
  const translated = { ...world, e: snapped.x, f: snapped.y };
  return nodePropsForWorldTransform(translated, parentWorld, node.width, node.height);
}

/**
 * Recomputes structural-container rectangles from their direct children without
 * changing any child's world transform. This is the matrix-native counterpart
 * to Figma's content-fitting Group bounds. BooleanOperation currently uses the
 * operand union as its conservative bound until the shared clipping engine
 * supplies the exact derived outline:
 *
 *   group' = group × translate(left, top)
 *   child' = translate(-left, -top) × child
 *
 * Work from the deepest Group out so a nested Group is already normalized when
 * it contributes to its parent's local bounds. Legacy direct children are
 * materialized first; mixing their world x/y with local matrices would make a
 * Group jump as soon as the first Relative-v1 sibling appears.
 */
export function normalizeGroupBounds(
  nodes: readonly CanvasNode[],
  options: Readonly<{ excludeGroupIds?: ReadonlySet<string> }> = {},
): CanvasNode[] | undefined {
  // Clone a mutable array: `structuredClone(nodes)` preserves the readonly
  // array type even though this normalization intentionally rewrites nodes.
  const next = structuredClone([...nodes]);
  const depth = (id: string) => {
    const byId = new Map(next.map((node) => [node.id, node]));
    const visited = new Set<string>();
    let value = 0;
    let parentId = byId.get(id)?.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      value += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    return value;
  };
  const groupIds = next
    .filter((node) => (node.kind === "group" || node.kind === "booleanOperation") && !options.excludeGroupIds?.has(node.id))
    .sort((left, right) => depth(right.id) - depth(left.id))
    .map((node) => node.id);

  for (const groupId of groupIds) {
    const groupIndex = next.findIndex((node) => node.id === groupId);
    const group = next[groupIndex];
    if (!group) return undefined;
    const parentWorld = group.parentId ? worldTransformForNode(next, group.parentId) : undefined;
    if (group.parentId && !parentWorld) return undefined;
    const groupWorld = worldTransformForNode(next, group.id);
    if (!groupWorld) return undefined;
    const children = next.filter((node) => node.parentId === group.id);
    if (!children.length) return undefined;

    // Materialize all direct children in Group-local coordinates first.
    for (const child of children) {
      const world = worldTransformForNode(next, child.id);
      const local = world && nodePropsForWorldTransform(world, groupWorld, child.width, child.height);
      if (!local) return undefined;
      const index = next.findIndex((node) => node.id === child.id);
      // Auto Layout Frames use the legacy local x/y/rotation projection in
      // Core; a Relative-v1 matrix on the container is intentionally rejected.
      // They can still be children of a Group, so retain the equivalent local
      // scalar geometry without writing the matrix back during normalization.
      next[index] = {
        ...next[index],
        ...local,
        ...(isAutoLayoutFrame(next[index]) ? { relativeTransform: undefined } : {}),
      };
    }

    const localChildren = next.filter((node) => node.parentId === group.id);
    const localBounds = localChildren.flatMap((child) => {
      const local = child.relativeTransform
        ?? nodePropsForWorldTransform(worldTransformForNode(next, child.id)!, groupWorld, child.width, child.height)?.relativeTransform;
      if (!local) return [];
      return [
        transformPoint(local, { x: 0, y: 0 }),
        transformPoint(local, { x: child.width, y: 0 }),
        transformPoint(local, { x: child.width, y: child.height }),
        transformPoint(local, { x: 0, y: child.height }),
      ];
    });
    if (localBounds.length !== localChildren.length * 4) return undefined;
    const left = Math.min(...localBounds.map((point) => point.x));
    const top = Math.min(...localBounds.map((point) => point.y));
    const right = Math.max(...localBounds.map((point) => point.x));
    const bottom = Math.max(...localBounds.map((point) => point.y));
    const width = right - left;
    const height = bottom - top;
    if (![left, top, right, bottom, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;

    const shift = { ...IDENTITY_AFFINE, e: left, f: top };
    const groupLocal = nodePropsForWorldTransform(groupWorld, parentWorld, group.width, group.height)?.relativeTransform;
    if (!groupLocal) return undefined;
    const movedGroupWorld = multiplyAffine(groupWorld, shift);
    const groupPatch = nodePropsForWorldTransform(movedGroupWorld, parentWorld, width, height);
    if (!groupPatch) return undefined;
    const flowChild = isAutoLayoutFlowChild(next, group);
    const publishedGroupPatch = flowChild
      ? nodePropsForWorldTransform(movedGroupWorld, undefined, width, height)
      : groupPatch;
    if (!publishedGroupPatch) return undefined;
    next[groupIndex] = {
      ...group,
      ...publishedGroupPatch,
      width,
      height,
      // An active Auto Layout parent owns a flow child's placement. Structural
      // containers still fit their contents, but must publish that geometry
      // through legacy x/y instead of a Relative-v1 matrix or Core will reject
      // the parent's deterministic reflow.
      ...(flowChild ? { relativeTransform: undefined } : {}),
    };

    const inverseShift = { ...IDENTITY_AFFINE, e: -left, f: -top };
    for (const child of localChildren) {
      const childIndex = next.findIndex((node) => node.id === child.id);
      const childLocal = child.relativeTransform
        ?? nodePropsForWorldTransform(worldTransformForNode(next, child.id)!, groupWorld, child.width, child.height)?.relativeTransform;
      const relativeTransform = childLocal && multiplyAffine(inverseShift, childLocal);
      if (!relativeTransform) return undefined;
      const patch = nodePropsForWorldTransform(
        multiplyAffine(movedGroupWorld, relativeTransform),
        movedGroupWorld,
        child.width,
        child.height,
      );
      if (!patch) return undefined;
      next[childIndex] = {
        ...next[childIndex],
        ...patch,
        ...(isAutoLayoutFrame(next[childIndex]) ? { relativeTransform: undefined } : {}),
      };
    }
  }
  return next;
}

function isAutoLayoutFrame(node: CanvasNode | undefined) {
  return (node?.kind === "frame" || node?.kind === "component" || node?.kind === "instance" || node?.kind === "slot" || node?.kind === "componentSet") && node.autoLayout?.mode !== undefined && node.autoLayout.mode !== "none";
}

function isAutoLayoutFlowChild(nodes: readonly CanvasNode[], node: CanvasNode) {
  if (!node.parentId || node.autoLayout?.absolute === true) return false;
  const parent = nodes.find((candidate) => candidate.id === node.parentId);
  return Boolean(parent && isAutoLayoutFrame(parent));
}

function isInvertibleAffine(matrix: AffineMatrix) {
  return Object.values(matrix).every(Number.isFinite) && Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) > 1e-12;
}

function normalizeAffine(matrix: AffineMatrix): AffineMatrix {
  if (!Object.values(matrix).every(Number.isFinite)) return { ...IDENTITY_AFFINE, e: Number.NaN, f: Number.NaN };
  return { a: normalizeZero(matrix.a), b: normalizeZero(matrix.b), c: normalizeZero(matrix.c), d: normalizeZero(matrix.d), e: normalizeZero(matrix.e), f: normalizeZero(matrix.f) };
}

function normalizeZero(value: number) { return Object.is(value, -0) ? 0 : value; }
