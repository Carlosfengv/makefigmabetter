import type { CanvasNode, DocumentTransformModifier } from "./editor-protocol";
import { sortNodesByLayerOrder } from "./layer-order";
import { isLinearBlendMode } from "./linear-blend-composite";
import { extensionsForNodeBlendMode } from "./node-blend-semantics";
import { IDENTITY_AFFINE, invertAffine, multiplyAffine, worldBoundsForTransform, worldTransformForNode, type AffineMatrix, type TransformBounds } from "./scene-transform";
import { activeNodeEffects, requiresSubtreeComposition } from "./subtree-compositing";
import { worldVisualBoundsForNode } from "./world-visual-bounds";

const MAX_REPEAT_DERIVED_INSTANCES = 64;

/** Materialization accepts a bounded stack of Figma Repeat modifiers. Each
 * later entry repeats the complete result of the entries before it; the
 * source is excluded from the derived-instance budget. */
export function canMaterializeTransformGroupRepeat(node: CanvasNode): boolean {
  const modifiers = node.kind === "transformGroup" ? node.transformModifiers : undefined;
  return isBoundedTransformModifierStack(modifiers);
}

const REPEAT_SAFE_CONTAINER_KINDS = new Set<CanvasNode["kind"]>([
  "frame",
  "group",
  "section",
  "component",
  "instance",
  "slot",
  "componentSet",
  "booleanOperation",
]);

const REPEAT_PREPARED_CONTAINER_KINDS = new Set<CanvasNode["kind"]>([
  "frame",
  "group",
  "section",
  "component",
  "instance",
  "slot",
  "componentSet",
]);

export type TransformGroupRepeatSubtree = Readonly<{
  /** Direct TransformGroup children passed to the recursive renderer. */
  sources: readonly CanvasNode[];
  /** Every retained node, including structural containers, for culling. */
  nodes: readonly CanvasNode[];
  /** Nodes with visible own geometry, in recursive paint order, for bounds/hit. */
  hitNodes: readonly CanvasNode[];
}>;

export type TransformGroupRepeatPaintInstance = Readonly<{
  /** Canonical source identity retained by selection and mutation. */
  node: CanvasNode;
  /** World-space transform applied to this derived paint occurrence. */
  matrix: AffineMatrix;
}>;

type TransformGroupRepeatTreeNode = Readonly<{
  id: string;
  parentId?: string;
  kind?: string;
  type?: string;
  transformModifiers?: unknown;
}>;

/** Validates the repeat multiplier of a complete projected forest. Repeat
 * groups may be nested through ordinary containers, so each root-to-leaf path
 * shares the same 64-derived-instance cap used by the materializer. */
export function isBoundedTransformGroupRepeatForest(nodes: readonly TransformGroupRepeatTreeNode[]): boolean {
  const byId = new Map<string, TransformGroupRepeatTreeNode>();
  const childrenByParentId = new Map<string, TransformGroupRepeatTreeNode[]>();
  for (const node of nodes) {
    if (byId.has(node.id)) return false;
    byId.set(node.id, node);
    if (node.parentId) {
      const children = childrenByParentId.get(node.parentId) ?? [];
      children.push(node);
      childrenByParentId.set(node.parentId, children);
    }
  }
  const isRepeat = (node: TransformGroupRepeatTreeNode) =>
    (node.kind === "transformGroup" || node.type === "TRANSFORM_GROUP")
    && Array.isArray(node.transformModifiers)
    && node.transformModifiers.length > 0;
  const hasRepeatAncestor = (node: TransformGroupRepeatTreeNode) => {
    const visited = new Set<string>();
    let foundRepeat = false;
    let parentId = node.parentId;
    while (parentId) {
      if (visited.has(parentId)) return undefined;
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return foundRepeat;
      if (isRepeat(parent)) foundRepeat = true;
      parentId = parent.parentId;
    }
    return foundRepeat;
  };
  const visit = (node: TransformGroupRepeatTreeNode, inheritedInstanceCount: number, path: Set<string>): boolean => {
    if (path.has(node.id)) return false;
    const nextPath = new Set(path).add(node.id);
    let instanceCount = inheritedInstanceCount;
    if (isRepeat(node)) {
      const ownCount = transformModifierStackInstanceCount(node.transformModifiers);
      if (ownCount === undefined || ownCount * inheritedInstanceCount > MAX_REPEAT_DERIVED_INSTANCES + 1) return false;
      instanceCount *= ownCount;
    }
    return (childrenByParentId.get(node.id) ?? []).every((child) => visit(child, instanceCount, nextPath));
  };
  for (const node of nodes) {
    if (!isRepeat(node)) continue;
    const ancestor = hasRepeatAncestor(node);
    if (ancestor === undefined) return false;
    if (!ancestor && !visit(node, 1, new Set())) return false;
  }
  return true;
}

export function indexTransformGroupRepeatChildren(paintNodes: readonly CanvasNode[]): ReadonlyMap<string, readonly CanvasNode[]> {
  const childrenByParentId = new Map<string, CanvasNode[]>();
  paintNodes.forEach((node) => {
    if (!node.parentId) return;
    const children = childrenByParentId.get(node.parentId) ?? [];
    children.push(node);
    childrenByParentId.set(node.parentId, children);
  });
  return childrenByParentId;
}

/** Returns the exact recursively materializable source subtree. The same gate
 * drives Canvas, culling and hit testing, so derived interaction cannot expose
 * pixels that the renderer intentionally leaves at the authored source. */
export function transformGroupRepeatSubtree(
  paintNodes: readonly CanvasNode[],
  group: Pick<CanvasNode, "id" | "kind" | "transformModifiers">,
  precomputedChildren?: ReadonlyMap<string, readonly CanvasNode[]>,
): TransformGroupRepeatSubtree | undefined {
  const rootInstanceCount = transformModifierStackInstanceCount(group.transformModifiers);
  if (group.kind !== "transformGroup" || rootInstanceCount === undefined) return undefined;
  const childrenByParentId = precomputedChildren ?? indexTransformGroupRepeatChildren(paintNodes);
  const visited = new Set<string>();
  const nodes: CanvasNode[] = [];
  const hitNodes: CanvasNode[] = [];
  const visit = (
    siblings: readonly CanvasNode[],
    inheritedInstanceCount: number,
    includeHitGeometry = true,
    externalBackdropAvailable = true,
    maskAlphaOnly = false,
  ): boolean => {
    let ordered: CanvasNode[];
    try { ordered = sortNodesByLayerOrder(siblings); }
    catch { return false; }
    for (let index = 0; index < ordered.length; index += 1) {
      const node = ordered[index]!;
      if (visited.has(node.id)) return false;
      visited.add(node.id);
      const descendants = childrenByParentId.get(node.id) ?? [];
      if (node.isMask) {
        // Repeat masks use the same bounded sibling-run contract as the
        // structural Canvas/SVG renderers. Paint-owning containers may include
        // a recursively rendered child subtree. A nested TransformGroup mask
        // contributes its bounded source plus derived occurrences to the same
        // alpha surface; empty structural masks and empty sibling runs fail closed.
        if ((node.kind === "group" && descendants.length === 0)
          || (node.kind === "transformGroup" && descendants.length === 0)
          || node.kind === "slice"
          || index + 1 >= ordered.length
          || ordered[index + 1]!.isMask) return false;
        let targetEnd = index + 1;
        while (targetEnd < ordered.length && !ordered[targetEnd]!.isMask) targetEnd += 1;
      }
      let descendantInstanceCount = inheritedInstanceCount;
      if (node.kind === "transformGroup") {
        const nestedInstanceCount = transformModifierStackInstanceCount(node.transformModifiers);
        if (!descendants.length
          || nestedInstanceCount === undefined
          || inheritedInstanceCount * nestedInstanceCount > MAX_REPEAT_DERIVED_INSTANCES + 1) return false;
        descendantInstanceCount *= nestedInstanceCount;
      } else if (descendants.length > 0 && !REPEAT_SAFE_CONTAINER_KINDS.has(node.kind)) return false;
      const isBoolean = node.kind === "booleanOperation";
      if (isBoolean && (
        descendants.length < 2
        || descendants.some((operand) => operand.kind !== "vector" || !operand.vectorPath || (childrenByParentId.get(operand.id)?.length ?? 0) > 0)
      )) return false;
      const effects = activeNodeEffects(node);
      // Foreground effects and isolated containers reuse their bounded surfaces
      // at each occurrence; the final composite retains the active Repeat
      // matrix. A container mask similarly reuses its bounded source-alpha
      // surface, and owner opacity scales that complete alpha before the final
      // occurrence composite.
      // Explicit NORMAL isolation and owner blend are already bounded by that
      // private alpha surface: source-over blend modes preserve the resulting
      // alpha that the mask consumes. Background Blur stacks are admitted only
      // while this visit retains access to the real external backdrop. A
      // prepared non-mask ancestor carries that backing through its bounded
      // surface. Mask targets seed their bounded target surface from that same
      // backing before applying the source alpha. A mask source consumes alpha
      // only, so Background Blur is retained in Canonical state but omitted by
      // the alpha-surface executor instead of requiring an external backdrop.
      const hasDescendants = descendants.length > 0;
      const hasBackgroundBlur = effects.some((effect) => Boolean(effect.backgroundBlur));
      // A Background Blur stack transitions from canonical to occurrence space
      // at its first backdrop effect, then executes the remaining ordered
      // effects in that screen-space window. Admitted prepared non-mask
      // ancestors keep a chain to the real destination, so a descendant also
      // sees earlier siblings already painted into each private surface.
      const admittedBackgroundBlur = hasBackgroundBlur
        && (maskAlphaOnly || node.isMask || externalBackdropAvailable);
      const admittedLinearNodeBlend = isLinearBlendMode(node.blendMode);
      const admittedContainerMask = node.isMask && hasDescendants;
      // A paint-owning container is rendered into one bounded private surface
      // before its owner opacity, isolation and blend are applied once. When a
      // descendant Background Blur forces a Repeat occurrence to materialize
      // in screen space, the same surface keeps its chain to the real external
      // backdrop; the owner presentation still runs only at the exit edge.
      const admittedPreparedContainer = hasDescendants
        && REPEAT_PREPARED_CONTAINER_KINDS.has(node.kind);
      const withoutAdmittedPresentation = effects.length > 0
        || admittedContainerMask
        || admittedLinearNodeBlend
        || admittedPreparedContainer
        ? {
            ...node,
            ...(effects.length > 0 ? { dropShadow: undefined, effectStack: undefined } : {}),
            ...(admittedContainerMask || admittedLinearNodeBlend || admittedPreparedContainer
              ? {
                  opacity: 1,
                  blendMode: "normal" as const,
                  extensions: extensionsForNodeBlendMode(node.extensions, "pass-through"),
                }
              : {}),
          }
        : node;
      if ((hasBackgroundBlur && !admittedBackgroundBlur)
        || requiresSubtreeComposition(withoutAdmittedPresentation, hasDescendants)) return false;
      nodes.push(node);
      if (includeHitGeometry && !node.isMask && node.kind !== "group" && node.kind !== "transformGroup") hitNodes.push(node);
      // A valid Boolean is painted and hit as one derived outline. Its Vector
      // operands remain retained for path construction and admission checks,
      // but the structural renderer does not expose them as independent paint.
      if (descendants.length > 0 && !visit(
        descendants,
        descendantInstanceCount,
        includeHitGeometry && !isBoolean && !node.isMask,
        externalBackdropAvailable && !node.isMask,
        maskAlphaOnly || Boolean(node.isMask),
      )) return false;
    }
    return true;
  };
  let sources: CanvasNode[];
  try { sources = sortNodesByLayerOrder(childrenByParentId.get(group.id) ?? []); }
  catch { return undefined; }
  if (!sources.length || !visit(sources, rootInstanceCount) || !hitNodes.length) return undefined;
  return { sources, nodes, hitNodes };
}

/** Returns the direct roots supported by the recursive Canvas materializer. */
export function transformGroupRepeatSourceNodes(
  paintNodes: readonly CanvasNode[],
  group: Pick<CanvasNode, "id" | "kind" | "transformModifiers">,
  precomputedChildren?: ReadonlyMap<string, readonly CanvasNode[]>,
): readonly CanvasNode[] | undefined {
  return transformGroupRepeatSubtree(paintNodes, group, precomputedChildren)?.sources;
}

/** Shared admission contract for Runtime mutation and renderer materialization.
 * Keeping the Cartesian budget here prevents an accepted API write from later
 * becoming an unbounded render fallback. */
export function isBoundedTransformModifierStack(value: unknown): value is DocumentTransformModifier[] {
  return transformModifierStackInstanceCount(value) !== undefined;
}

function transformModifierStackInstanceCount(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  let totalInstances = 1;
  for (const entry of value) {
    const modifier = entry as DocumentTransformModifier | undefined;
    if (!modifier) return undefined;
    if (modifier.type !== "REPEAT"
      || (modifier.repeatType !== "RADIAL"
        && (modifier.repeatType !== "LINEAR" || (modifier.axis !== "HORIZONTAL" && modifier.axis !== "VERTICAL")))
      || (modifier.unitType !== "RELATIVE" && modifier.unitType !== "PIXELS")
      || !Number.isSafeInteger(modifier.count)
      || modifier.count < 1
      || !Number.isFinite(modifier.offset)) return undefined;
    totalInstances *= modifier.count + 1;
    if (!Number.isSafeInteger(totalInstances) || totalInstances - 1 > MAX_REPEAT_DERIVED_INSTANCES) return undefined;
  }
  return totalInstances;
}

/** Enumerates the exact derived paint occurrences emitted by the recursive
 * Canvas/SVG walker. Nested Repeat matrices compose in paint order, while the
 * outer and every nested modifier stack share one Cartesian depth budget. */
export function transformGroupRepeatDerivedPaintInstances(
  documentNodes: readonly CanvasNode[],
  paintNodes: readonly CanvasNode[],
  group: CanvasNode,
  precomputed?: Readonly<{
    worldTransformByNodeId?: ReadonlyMap<string, AffineMatrix>;
    childrenByParentId?: ReadonlyMap<string, readonly CanvasNode[]>;
  }>,
): readonly TransformGroupRepeatPaintInstance[] | undefined {
  const childrenByParentId = precomputed?.childrenByParentId ?? indexTransformGroupRepeatChildren(paintNodes);
  const subtree = transformGroupRepeatSubtree(paintNodes, group, childrenByParentId);
  const matrices = subtree && transformGroupRepeatMatrices(documentNodes, group, precomputed?.worldTransformByNodeId?.get(group.id));
  if (!subtree || !matrices?.length) return undefined;
  const documentById = new Map(documentNodes.map((node) => [node.id, node]));
  const hitNodeIds = new Set(subtree.hitNodes.map((node) => node.id));
  const instances: TransformGroupRepeatPaintInstance[] = [];
  const append = (siblings: readonly CanvasNode[], inheritedMatrix: AffineMatrix) => {
    const ordered = sortNodesByLayerOrder(siblings);
    for (const node of ordered) {
      const descendants = childrenByParentId.get(node.id) ?? [];
      if (hitNodeIds.has(node.id)) instances.push({ node, matrix: inheritedMatrix });
      if (node.kind === "booleanOperation") continue;
      if (node.kind === "transformGroup") {
        append(descendants, inheritedMatrix);
        const canonical = documentById.get(node.id) ?? node;
        const nestedMatrices = transformGroupRepeatMatrices(
          documentNodes,
          canonical,
          precomputed?.worldTransformByNodeId?.get(node.id),
        );
        nestedMatrices?.forEach((matrix) => append(descendants, multiplyAffine(inheritedMatrix, matrix)));
        continue;
      }
      if (descendants.length) append(descendants, inheritedMatrix);
    }
  };
  matrices.forEach((matrix) => append(subtree.sources, matrix));
  return instances;
}

/** Returns the world-space affine transform for every repeat-derived copy.
 * The original source children stay at identity; callers draw them once, then
 * wrap each complete source subtree in these matrices. */
export function transformGroupRepeatMatrices(
  nodes: readonly CanvasNode[],
  group: CanvasNode,
  precomputedGroupWorld?: AffineMatrix,
): readonly AffineMatrix[] | undefined {
  if (!canMaterializeTransformGroupRepeat(group)) return undefined;
  const groupWorld = precomputedGroupWorld ?? worldTransformForNode(nodes, group.id);
  const inverse = groupWorld && invertAffine(groupWorld);
  if (!groupWorld || !inverse) return undefined;
  let localInstances: readonly AffineMatrix[] = [IDENTITY_AFFINE];
  for (const modifier of group.transformModifiers!) {
    const modifierInstances = localRepeatMatrices(group, modifier);
    // Later modifiers repeat the complete earlier pattern. This ordering is
    // observable when instances overlap and therefore remains deterministic.
    localInstances = modifierInstances.flatMap((modifierMatrix) =>
      localInstances.map((existingMatrix) => multiplyAffine(modifierMatrix, existingMatrix)));
  }
  return localInstances.slice(1).map((local) => multiplyAffine(multiplyAffine(groupWorld, local), inverse));
}

/** World envelope of the derived Canvas paint. Each occurrence composes the
 * Repeat matrix with the source's world transform before resolving visual
 * bounds. Transforming an already axis-aligned world AABB would inflate a
 * rotated source again under RADIAL Repeat and produce imprecise selection,
 * culling and surface windows. */
export function transformGroupRepeatDerivedBounds(
  nodes: readonly CanvasNode[],
  group: CanvasNode,
  sources: readonly CanvasNode[],
  precomputed?: Readonly<{
    groupWorld?: AffineMatrix;
    worldTransformByNodeId?: ReadonlyMap<string, AffineMatrix>;
    canonicalNodeById?: ReadonlyMap<string, CanvasNode>;
    paintNodes?: readonly CanvasNode[];
    childrenByParentId?: ReadonlyMap<string, readonly CanvasNode[]>;
  }>,
): TransformBounds | undefined {
  const canonicalById = precomputed?.canonicalNodeById ?? new Map(nodes.map((node) => [node.id, node]));
  const paintNodes = precomputed?.paintNodes ?? nodes;
  const childrenByParentId = precomputed?.childrenByParentId ?? indexTransformGroupRepeatChildren(paintNodes);
  const worldTransformByNodeId = precomputed?.worldTransformByNodeId ?? (precomputed?.groupWorld
    ? new Map([[group.id, precomputed.groupWorld]])
    : undefined);
  const sourceIds = new Set(sources.map((source) => source.id));
  const instances = transformGroupRepeatDerivedPaintInstances(nodes, paintNodes, group, {
    worldTransformByNodeId,
    childrenByParentId,
  })?.filter((instance) => sourceIds.has(instance.node.id) || sources.some((source) => isDescendantOf(instance.node, source.id, canonicalById)));
  if (!instances?.length || !sources.length) return undefined;
  let result: TransformBounds | undefined;
  for (const instance of instances) {
    const canonical = canonicalById.get(instance.node.id) ?? instance.node;
    const sourceWorld = precomputed?.worldTransformByNodeId?.get(instance.node.id)
      ?? worldTransformForNode(nodes, instance.node.id);
    const derivedWorld = sourceWorld
      ? multiplyAffine(instance.matrix, sourceWorld)
      : undefined;
    const derived = worldVisualBoundsForNode(nodes, canonical, derivedWorld ? {
      transform: derivedWorld,
      bounds: worldBoundsForTransform(canonical, derivedWorld),
    } : undefined);
    if (!derived) continue;
    result = result ? {
      left: Math.min(result.left, derived.left),
      top: Math.min(result.top, derived.top),
      right: Math.max(result.right, derived.right),
      bottom: Math.max(result.bottom, derived.bottom),
    } : derived;
  }
  return result;
}

/** Exact world envelope of one materializable Repeat TransformGroup. The
 * canonical wrapper owns mutation and selection identity, while its envelope
 * includes both the authored source and every derived paint occurrence. */
export function transformGroupRepeatWorldBounds(
  nodes: readonly CanvasNode[],
  group: CanvasNode,
  precomputed?: Readonly<{
    subtree?: TransformGroupRepeatSubtree;
    sourceBounds?: TransformBounds;
    groupWorld?: AffineMatrix;
    worldTransformByNodeId?: ReadonlyMap<string, AffineMatrix>;
    canonicalNodeById?: ReadonlyMap<string, CanvasNode>;
    paintNodes?: readonly CanvasNode[];
    childrenByParentId?: ReadonlyMap<string, readonly CanvasNode[]>;
  }>,
): TransformBounds | undefined {
  const paintNodes = precomputed?.paintNodes ?? nodes;
  const subtree = precomputed?.subtree
    ?? transformGroupRepeatSubtree(paintNodes, group, precomputed?.childrenByParentId);
  const source = subtree && (precomputed?.sourceBounds ?? worldVisualBoundsForNode(nodes, group));
  const derived = subtree && transformGroupRepeatDerivedBounds(nodes, group, subtree.sources, precomputed);
  if (!source || !derived) return undefined;
  return {
    left: Math.min(source.left, derived.left),
    top: Math.min(source.top, derived.top),
    right: Math.max(source.right, derived.right),
    bottom: Math.max(source.bottom, derived.bottom),
  };
}

function isDescendantOf(node: CanvasNode, ancestorId: string, byId: ReadonlyMap<string, CanvasNode>): boolean {
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}


function localRepeatMatrices(group: CanvasNode, modifier: NonNullable<CanvasNode["transformModifiers"]>[number]): readonly AffineMatrix[] {
  if (modifier.repeatType === "RADIAL") {
    // Figma stores the editable source subtree at its authored radius. Repeat
    // instances rotate that complete source around the TransformGroup's local
    // centre; count is the number of derived copies, so source + count divides
    // the full circle into count + 1 equal sectors. `offset` describes the
    // authored source radius and must not be applied again to derived copies.
    const centerX = group.width / 2;
    const centerY = group.height / 2;
    const angleStep = Math.PI * 2 / (modifier.count + 1);
    return [IDENTITY_AFFINE, ...Array.from({ length: modifier.count }, (_, index) => {
      const angle = angleStep * (index + 1);
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const local: AffineMatrix = {
        a: cosine,
        b: sine,
        c: -sine,
        d: cosine,
        e: centerX - cosine * centerX + sine * centerY,
        f: centerY - sine * centerX - cosine * centerY,
      };
      return local;
    })];
  }
  const unit = modifier.unitType === "RELATIVE"
    ? (modifier.axis === "HORIZONTAL" ? group.width : group.height)
    : 1;
  const delta = modifier.offset * unit;
  if (!Number.isFinite(delta)) return [];
  return [IDENTITY_AFFINE, ...Array.from({ length: modifier.count }, (_, index) => {
    const scalar = index + 1;
    const local: AffineMatrix = modifier.axis === "HORIZONTAL"
      ? { ...IDENTITY_AFFINE, e: delta * scalar }
      : { ...IDENTITY_AFFINE, f: delta * scalar };
    return local;
  })];
}

export function affineSvgMatrix(matrix: AffineMatrix, number: (value: number) => string): string {
  return `matrix(${number(matrix.a)} ${number(matrix.b)} ${number(matrix.c)} ${number(matrix.d)} ${number(matrix.e)} ${number(matrix.f)})`;
}

/** Conjugates a world affine through the current viewport transform. Canvas
 * receives CSS-pixel coordinates after `toScreen`, so merely scaling its
 * translation would rotate around the wrong point whenever the viewport pans. */
export function affineScreenMatrix(matrix: AffineMatrix, origin: Readonly<{ x: number; y: number }>, zoom: number): AffineMatrix {
  return {
    a: matrix.a,
    b: matrix.b,
    c: matrix.c,
    d: matrix.d,
    e: matrix.e * zoom + origin.x - matrix.a * origin.x - matrix.c * origin.y,
    f: matrix.f * zoom + origin.y - matrix.b * origin.x - matrix.d * origin.y,
  };
}
