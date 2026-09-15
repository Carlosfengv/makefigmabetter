import { documentColorFromCssHex, type CanvasNode, type DocumentPaint } from "../lib/editor-protocol";
import { roundedRectContains } from "../lib/hit-test";
import { sortNodesByLayerOrder } from "../lib/layer-order";
import { invertAffine, transformPoint, worldBoundsForTransform, worldTransformsForNodes, type AffineMatrix, type TransformBounds } from "../lib/scene-transform";
import { worldVisualBoundsForNode } from "../lib/world-visual-bounds";
import { specialNodeFallback } from "../lib/special-node-fallback";
import { clipsChildren, nodeCapabilities } from "../lib/node-capabilities";
import { activeNodeEffects } from "../lib/subtree-compositing";
import { normalizedFillPaints, normalizedNodeEffects, normalizedStrokePaints } from "../lib/normalized-node-view";
import { connectorPathForNode, type ConnectorPath } from "../lib/connector-path";
import type { ClipGeometryRef, ClipState, CompositingGroup, OrderedRenderScene, RenderItem, RenderPrimitiveKind, SceneSemanticNode } from "./ordered-render-ir";

export type SceneCompilerDiagnostic = Readonly<{
  nodeId: string;
  capability: "invalid-transform" | "unsupported-node" | "special-node";
  reason: string;
}>;

export type SceneDirtyRegion = Readonly<{
  kind: "region" | "full-scene";
  reason: "initial" | "node-added" | "node-removed" | "node-changed" | "presentation-changed" | "dependency-changed" | "resource-changed" | "too-many-changes";
  bounds?: TransformBounds;
}>;

export type CompiledScene = Readonly<{
  scene: OrderedRenderScene;
  diagnostics: readonly SceneCompilerDiagnostic[];
  dirtyRegions: readonly SceneDirtyRegion[];
}>;

export type SceneCompilerOptions = Readonly<{
  revision: number;
  nodes: readonly CanvasNode[];
  pageId: string;
  /** Old pre-Page records have a deterministic implicit page. */
  defaultPageId?: string;
  /** Changes when image/font readiness changes within the same revision. */
  resourceGeneration?: string | number;
  previousScene?: OrderedRenderScene;
}>;

type Scope = Readonly<{ visible: boolean; clipState: ClipState; maskNodeId?: string }>;

const UNBOUNDED_CLIP: ClipState = Object.freeze({ kind: "unbounded" });
const EMPTY_CLIP: ClipState = Object.freeze({ kind: "empty" });

/**
 * Compiles one immutable Canvas projection into the shared, backend-neutral
 * scene representation. The compiler deliberately owns ordering, transforms,
 * clipping, mask scope and dirty evidence; Canvas/WebGPU/Hit Test/Export must
 * consume this result instead of independently reconstructing those rules.
 */
export function compileScene(options: SceneCompilerOptions): CompiledScene {
  if (!Number.isSafeInteger(options.revision) || options.revision < 0 || !options.pageId) throw new Error("Invalid scene compiler input.");
  const defaultPageId = options.defaultPageId ?? "00000000-0000-0000-0000-000000000001";
  const nodes = options.nodes.filter((node) => (node.pageId ?? defaultPageId) === options.pageId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const worldTransforms = worldTransformsForNodes(nodes);
  const children = new Map<string | undefined, CanvasNode[]>();
  for (const node of nodes) {
    const parentId = node.parentId && byId.has(node.parentId) ? node.parentId : undefined;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node); children.set(parentId, siblings);
  }
  const diagnostics: SceneCompilerDiagnostic[] = [];
  const semanticNodes: SceneSemanticNode[] = [];
  const maskSources: Array<{ node: CanvasNode; worldTransform?: AffineMatrix }> = [];
  const seen = new Set<string>();
  let zIndex = 0;

  const maskSubtreeInfoCache = new Map<string, Readonly<{ bounds?: TransformBounds; canProduceAlpha: boolean }>>();
  const maskSubtreeInfo = (node: CanvasNode, lineage: ReadonlySet<string> = new Set()): Readonly<{ bounds?: TransformBounds; canProduceAlpha: boolean }> => {
    const cached = maskSubtreeInfoCache.get(node.id);
    if (cached) return cached;
    if (lineage.has(node.id) || node.visible === false || node.opacity <= 0) return { canProduceAlpha: false };
    const nextLineage = new Set(lineage).add(node.id);
    const transform = worldTransforms.get(node.id);
    const visualBounds = transform
      ? worldVisualBoundsForNode(nodes, node, { transform, bounds: worldBoundsForTransform(node, transform), defaultPageId, nodeById: byId, worldTransformByNodeId: worldTransforms })
      : undefined;
    let bounds = maskCanProduceSourceAlpha(node) ? effectBoundsFor(node, visualBounds, transform) : undefined;
    let canProduceAlpha = Boolean(bounds);
    if (!(node.kind === "section" && node.contentsHidden === true)) {
      const ownerBounds = transform ? worldBoundsForTransform(node, transform) : undefined;
      for (const child of stableOrder(children.get(node.id) ?? [])) {
        const childInfo = maskSubtreeInfo(child, nextLineage);
        let childBounds = childInfo.bounds;
        if (childBounds && ownerBounds && clipsChildren(node.kind) && node.clipsContent !== false)
          childBounds = intersectBounds(childBounds, ownerBounds);
        bounds = unionBounds(bounds, childBounds);
        canProduceAlpha ||= Boolean(childBounds && childInfo.canProduceAlpha);
      }
    }
    const result = bounds && canProduceAlpha ? { bounds, canProduceAlpha: true } : { canProduceAlpha: false };
    maskSubtreeInfoCache.set(node.id, result);
    return result;
  };

  const compileSiblings = (siblings: readonly CanvasNode[], scope: Scope): RenderItem[] => {
    const items: RenderItem[] = [];
    const ordered = stableOrder(siblings);
    for (let index = 0; index < ordered.length; index += 1) {
      const node = ordered[index];
      if (!node.isMask) {
        items.push(...compileNode(node, scope));
        continue;
      }

      // Compile the source for semantic/hit/invalidation evidence, but never
      // emit it as an ordinary visible draw. A mask owns every following
      // sibling up to the next mask and is applied once to their combined
      // source alpha.
      compileNode(node, scope);
      const runItems: RenderItem[] = [];
      let end = index + 1;
      while (end < ordered.length && !ordered[end].isMask) {
        runItems.push(...compileNode(ordered[end], { ...scope, maskNodeId: node.id }));
        end += 1;
      }
      if (runItems.length) {
        items.push({ type: "group", group: {
          id: `mask:${node.id}`,
          ownerNodeId: node.id,
          requiresBackdrop: false,
          hasEffects: false,
          maskNodeIds: [node.id],
          items: runItems,
        } });
      }
      index = end - 1;
    }
    return items;
  };

  const compileNode = (node: CanvasNode, scope: Scope): RenderItem[] => {
    if (seen.has(node.id)) {
      diagnostics.push({ nodeId: node.id, capability: "invalid-transform", reason: "Cycle or duplicate node identity prevented Scene compilation." });
      return [];
    }
    seen.add(node.id);
    const worldTransform = worldTransforms.get(node.id);
    const worldBounds = worldTransform ? worldBoundsForTransform(node, worldTransform) : undefined;
    const visualBounds = worldTransform && worldBounds
      ? worldVisualBoundsForNode(nodes, node, { transform: worldTransform, bounds: worldBounds, defaultPageId, nodeById: byId, worldTransformByNodeId: worldTransforms })
      : undefined;
    if (!worldTransform || !worldBounds) diagnostics.push({ nodeId: node.id, capability: "invalid-transform", reason: "Node has no finite, acyclic world transform." });
    if (node.isMask) {
      maskSources.push({
        node: structuredClone(node),
        ...(worldTransform ? { worldTransform: { ...worldTransform } } : {}),
      });
    }
    const mask = scope.maskNodeId ? byId.get(scope.maskNodeId) : undefined;
    const maskTransform = mask && scope.maskNodeId ? worldTransforms.get(scope.maskNodeId) : undefined;
    const maskDescendants = mask ? children.get(mask.id) ?? [] : [];
    const maskInfo = mask ? maskSubtreeInfo(mask) : undefined;
    const maskBounds = maskInfo?.canProduceAlpha ? maskInfo.bounds : undefined;
    const maskGeometry = mask && maskTransform && maskDescendants.length === 0 && !activeNodeEffects(mask).length
      ? maskClipGeometryRef(mask, maskTransform)
      : undefined;
    const clipState = scope.maskNodeId
      ? maskBounds ? intersectClipState(scope.clipState, maskBounds, maskGeometry) : EMPTY_CLIP
      : scope.clipState;
    const clipBounds = boundsForClipState(clipState);
    const visible = scope.visible && node.visible !== false && Boolean(worldTransform && worldBounds) && clipState.kind !== "empty";
    const primitive = primitiveFor(node, diagnostics);
    const paintable = visible && !node.isMask && Boolean(primitive);
    const effectBounds = effectBoundsFor(node, visualBounds, worldTransform);
    const semanticStart = semanticNodes.length;
    semanticNodes.push({
      nodeId: node.id,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      presentationFingerprint: presentationFingerprintFor(
        node,
        node.kind === "connector" ? connectorPathForNode(node, { nodes, defaultPageId, nodeById: byId, worldTransformByNodeId: worldTransforms }) : undefined,
      ),
      zIndex: zIndex++,
      visible,
      prototypeInteractive: visible && Boolean(node.reactions?.length),
      paintable,
      ...(worldTransform ? { worldTransform } : {}),
      ...(worldBounds ? { worldBounds } : {}),
      clipState,
      ...(clipBounds ? { clipBounds } : {}),
      ...(effectBounds ? { effectBounds } : {}),
      maskNodeIds: scope.maskNodeId ? [scope.maskNodeId] : [],
    });

    const ownItems: RenderItem[] = [];
    if (paintable && primitive) ownItems.push({ type: "draw", primitive: { nodeId: node.id, kind: primitive, materialKey: materialKeyFor(primitive) } });
    const childClipState = clipsChildren(node.kind) && node.clipsContent !== false
      ? worldBounds && worldTransform
        ? intersectClipState(clipState, worldBounds, clipGeometryRef(node, worldTransform))
        : EMPTY_CLIP
      : clipState;
    const childClipBounds = boundsForClipState(childClipState);
    ownItems.push(...compileSiblings(children.get(node.id) ?? [], {
      visible: visible && !(node.kind === "section" && node.contentsHidden === true),
      clipState: childClipState,
    }));

    if (!ownItems.length || !visible) return [];
    const effects = activeNodeEffects(node).map((effect) => deepFreeze(structuredClone(effect)));
    const hasEffects = effects.length > 0;
    const needsContext = clipsChildren(node.kind) && node.clipsContent !== false
      || node.opacity < 1 || (node.blendMode !== undefined && node.blendMode !== "normal") || hasEffects;
    if (!needsContext) return ownItems;
    const sourceBounds = unionBounds(
      paintable ? visualBounds : undefined,
      sourceBoundsFor(semanticNodes.slice(semanticStart + 1)),
    );
    const group: CompositingGroup = {
      id: `context:${node.id}`,
      ownerNodeId: node.id,
      requiresBackdrop: hasBackgroundBlur(node),
      hasEffects,
      ...(effects.length ? { effects } : {}),
      ...(sourceBounds ? { sourceBounds } : {}),
      ...(node.opacity < 1 ? { opacity: node.opacity } : {}),
      ...(node.blendMode && node.blendMode !== "normal" ? { blendMode: node.blendMode } : {}),
      clipState: childClipState,
      ...(childClipBounds ? { clipBounds: childClipBounds } : {}),
      items: ownItems,
    };
    return [{ type: "group", group }];
  };

  const root: CompositingGroup = {
    id: `page:${options.pageId}`,
    ownerNodeId: options.pageId,
    requiresBackdrop: false,
    hasEffects: false,
    clipState: UNBOUNDED_CLIP,
    items: compileSiblings(children.get(undefined) ?? [], { visible: true, clipState: UNBOUNDED_CLIP }),
  };
  const scene: OrderedRenderScene = deepFreeze({
    revision: options.revision,
    ...(options.resourceGeneration === undefined ? {} : { resourceGeneration: options.resourceGeneration }),
    root,
    dependencyFingerprint: dependencyFingerprintFor(root),
    semanticNodes,
    ...(maskSources.length ? { maskSources } : {}),
  });
  return { scene, diagnostics, dirtyRegions: dirtyRegionsFor(scene, options.previousScene) };

}

/** The shared reverse-order broad phase. A renderer supplies its exact local
 * geometry predicate, keeping curve/mask precision out of this common IR. */
export function findTopmostSceneHit(
  scene: OrderedRenderScene,
  point: Readonly<{ x: number; y: number }>,
  preciseContains?: (nodeId: string) => boolean,
): SceneSemanticNode | undefined {
  return [...scene.semanticNodes]
    .sort((left, right) => right.zIndex - left.zIndex)
    .find((node) => node.visible && node.paintable && contains(node.effectBounds ?? node.worldBounds, point) && clipStateContainsPoint(node.clipState, point) && (preciseContains?.(node.nodeId) ?? true));
}

export function clipStateContainsPoint(clipState: ClipState, point: Readonly<{ x: number; y: number }>): boolean {
  if (clipState.kind === "empty") return false;
  if (clipState.kind === "unbounded") return true;
  if (!contains(clipState.bounds, point)) return false;
  return clipState.chain.every((geometry) => clipGeometryContainsPoint(geometry, point));
}

/**
 * Projects an already culled backend subset into the Scene compiler's canonical
 * paint order. Unknown or not-yet-compiled records remain in their supplied
 * order at the end, which makes a stale compiler result a safe fallback rather
 * than a way to hide a layer during recovery.
 */
export function sceneNodesInPaintOrder<T extends Readonly<{ id: string }>>(scene: OrderedRenderScene | undefined, nodes: readonly T[]): T[] {
  if (!scene) return [...nodes];
  const available = new Map(nodes.map((node) => [node.id, node]));
  const ordered: T[] = [];
  const emitted = new Set<string>();
  [...scene.semanticNodes].sort((left, right) => left.zIndex - right.zIndex).forEach((semantic) => {
    const node = available.get(semantic.nodeId);
    if (node) { ordered.push(node); emitted.add(node.id); }
  });
  nodes.forEach((node) => { if (!emitted.has(node.id)) ordered.push(node); });
  return ordered;
}

function stableOrder(nodes: readonly CanvasNode[]): CanvasNode[] {
  try { return sortNodesByLayerOrder(nodes); }
  catch { return [...nodes]; }
}

function primitiveFor(node: CanvasNode, diagnostics: SceneCompilerDiagnostic[]): RenderPrimitiveKind | undefined {
  const fallback = specialNodeFallback(node, "canvas");
  if (fallback) diagnostics.push({ nodeId: node.id, capability: "special-node", reason: fallback.reason });
  return nodeCapabilities(node.kind).renderPrimitive;
}

function materialKeyFor(kind: RenderPrimitiveKind): string { return kind; }
function hasBackgroundBlur(node: CanvasNode): boolean { return activeNodeEffects(node).some((effect) => Boolean(effect.backgroundBlur)); }

function sourceBoundsFor(nodes: readonly SceneSemanticNode[]): TransformBounds | undefined {
  return nodes.reduce<TransformBounds | undefined>((bounds, node) => {
    if (!node.visible) return bounds;
    const visual = node.effectBounds ?? node.worldBounds;
    const clipped = visual && node.clipState.kind === "bounded"
      ? intersectBounds(visual, node.clipState.bounds)
      : visual;
    return unionBounds(bounds, clipped);
  }, undefined);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}

function effectBoundsFor(node: CanvasNode, visualBounds: TransformBounds | undefined, transform: SceneSemanticNode["worldTransform"]): TransformBounds | undefined {
  if (!visualBounds || !transform) return visualBounds;
  const scale = Math.max(Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d));
  // Canvas blur kernels retain a visible alpha tail beyond their nominal
  // radius. This mirrors the Canvas compositor's three-radius envelope. Drop
  // shadow visual bounds already include one radius, so only its remaining two
  // radii are added here. Inner shadows cannot expand source alpha.
  const outset = activeNodeEffects(node).reduce((sum, effect) => {
    if (effect.layerBlur?.visible) return sum + Math.max(0, effect.layerBlur.radius) * 3 * scale;
    if (effect.backgroundBlur?.visible) return sum + Math.max(0, effect.backgroundBlur.radius) * 3 * scale;
    if (effect.dropShadow?.visible && effect.dropShadow.color.alpha > 0) return sum + Math.max(0, effect.dropShadow.blurRadius) * 2 * scale;
    return sum;
  }, 0);
  if (!outset) return visualBounds;
  return { left: visualBounds.left - outset, top: visualBounds.top - outset, right: visualBounds.right + outset, bottom: visualBounds.bottom + outset };
}

function intersectClipState(state: ClipState, bounds: TransformBounds, geometry?: ClipGeometryRef): ClipState {
  if (state.kind === "empty") return state;
  const result = state.kind === "unbounded" ? bounds : intersectBounds(state.bounds, bounds);
  if (!result) return EMPTY_CLIP;
  return {
    kind: "bounded",
    bounds: result,
    chain: [...(state.kind === "bounded" ? state.chain : []), ...(geometry ? [geometry] : [])],
  };
}

function intersectBounds(left: TransformBounds, right: TransformBounds): TransformBounds | undefined {
  const result = { left: Math.max(left.left, right.left), top: Math.max(left.top, right.top), right: Math.min(left.right, right.right), bottom: Math.min(left.bottom, right.bottom) };
  return result.left < result.right && result.top < result.bottom ? result : undefined;
}

function boundsForClipState(state: ClipState): TransformBounds | undefined {
  return state.kind === "bounded" ? state.bounds : undefined;
}

function clipGeometryRef(node: CanvasNode, worldTransform: AffineMatrix): ClipGeometryRef {
  return {
    nodeId: node.id,
    geometry: "rounded-rect",
    worldTransform: { ...worldTransform },
    width: node.width,
    height: node.height,
    radius: node.radius,
    ...(node.cornerRadii ? { cornerRadii: [...node.cornerRadii] as [number, number, number, number] } : {}),
    ...(node.cornerSmoothing === undefined ? {} : { cornerSmoothing: node.cornerSmoothing }),
  };
}

function maskClipGeometryRef(node: CanvasNode, worldTransform: AffineMatrix): ClipGeometryRef | undefined {
  if (maskStrokeExtendsOutsideGeometry(node)) return undefined;
  if (node.kind === "ellipse" && !node.arcData) {
    return {
      nodeId: node.id,
      geometry: "ellipse",
      worldTransform: { ...worldTransform },
      width: node.width,
      height: node.height,
      radius: 0,
    };
  }
  if (node.kind === "rectangle" || clipsChildren(node.kind)) return clipGeometryRef(node, worldTransform);
  return undefined;
}

function paintCanProduceAlpha(paint: DocumentPaint): boolean {
  if ((paint.layerOpacity ?? 1) <= 0) return false;
  if (paint.gradient) return paint.gradient.stops.some((stop) => stop.color.alpha > 0);
  if (paint.gradientPaint) return paint.gradientPaint.stops.some((stop) => stop.color.alpha > 0);
  return ((paint.color ?? documentColorFromCssHex(paint.css))?.alpha ?? 0) > 0;
}

function stackHasImageAlpha(stack: CanvasNode["fillStack"]): boolean {
  return Boolean(stack?.layers.some((layer) => layer.visible && layer.opacity > 0 && Boolean(layer.image)));
}

function maskCanProduceSourceAlpha(node: CanvasNode): boolean {
  if (node.opacity <= 0) return false;
  // These structural nodes never paint their own geometry in Canvas or SVG;
  // only their admitted descendants may contribute mask alpha.
  if (node.kind === "group" || node.kind === "slice" || node.kind === "transformGroup" || node.kind === "slideGrid" || node.kind === "slideRow") return false;
  if (node.assetId || stackHasImageAlpha(node.fillStack)) return true;
  if (normalizedFillPaints(node).some(paintCanProduceAlpha)) return true;
  if (node.strokeWidth <= 0) return false;
  return stackHasImageAlpha(node.strokeStack) || normalizedStrokePaints(node).some(paintCanProduceAlpha);
}

function maskStrokeExtendsOutsideGeometry(node: CanvasNode): boolean {
  if (node.strokeWidth <= 0 || (node.strokeAlign ?? "inside") === "inside") return false;
  return stackHasImageAlpha(node.strokeStack) || normalizedStrokePaints(node).some(paintCanProduceAlpha);
}

function clipGeometryContainsPoint(geometry: ClipGeometryRef, point: Readonly<{ x: number; y: number }>): boolean {
  const inverse = invertAffine(geometry.worldTransform);
  if (!inverse) return false;
  const local = transformPoint(inverse, point);
  if (geometry.geometry === "ellipse") {
    if (geometry.width <= 0 || geometry.height <= 0) return false;
    const normalizedX = (local.x - geometry.width / 2) / (geometry.width / 2);
    const normalizedY = (local.y - geometry.height / 2) / (geometry.height / 2);
    return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
  }
  return roundedRectContains(local, geometry.width, geometry.height, geometry.radius, geometry.cornerRadii, geometry.cornerSmoothing);
}
function contains(bounds: TransformBounds | undefined, point: Readonly<{ x: number; y: number }>) { return Boolean(bounds && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom); }

function dirtyRegionsFor(scene: OrderedRenderScene, previous: OrderedRenderScene | undefined): readonly SceneDirtyRegion[] {
  if (!previous) return [{ kind: "full-scene", reason: "initial" }];
  if (scene.resourceGeneration !== previous.resourceGeneration) {
    return [{ kind: "full-scene", reason: "resource-changed" }];
  }
  const before = new Map(previous.semanticNodes.map((node) => [node.nodeId, node]));
  const after = new Map(scene.semanticNodes.map((node) => [node.nodeId, node]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldNode = before.get(id); const newNode = after.get(id);
    if (oldNode && newNode && oldNode.presentationFingerprint !== newNode.presentationFingerprint) {
      // Paint, text, mask alpha and owner compositing can affect descendants or
      // backdrop readers outside the node's own geometry. Until dependency-aware
      // partial replay is enabled, full-scene invalidation is the safe contract.
      return [{ kind: "full-scene", reason: "presentation-changed" }];
    }
  }
  if (scene.dependencyFingerprint !== previous.dependencyFingerprint) {
    return [{ kind: "full-scene", reason: "dependency-changed" }];
  }
  const regions: SceneDirtyRegion[] = [];
  const hasBackdropDependency = sceneHasBackdropReader(scene.root) || sceneHasBackdropReader(previous.root);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldNode = before.get(id); const newNode = after.get(id);
    const oldBounds = oldNode?.effectBounds ?? oldNode?.worldBounds;
    const newBounds = newNode?.effectBounds ?? newNode?.worldBounds;
    const dependencyChanged = oldNode && newNode && (
      oldNode.parentId !== newNode.parentId
      || oldNode.zIndex !== newNode.zIndex
      || !sameClipState(oldNode.clipState, newNode.clipState)
      || oldNode.maskNodeIds.join(",") !== newNode.maskNodeIds.join(",")
    );
    if (dependencyChanged) return [{ kind: "full-scene", reason: "dependency-changed" }];
    const changed = !oldNode || !newNode || oldNode.visible !== newNode.visible || oldNode.paintable !== newNode.paintable || !sameBounds(oldBounds, newBounds);
    if (!changed) continue;
    if (hasBackdropDependency) return [{ kind: "full-scene", reason: "dependency-changed" }];
    const bounds = unionBounds(oldBounds, newBounds);
    regions.push(bounds ? { kind: "region", reason: !oldNode ? "node-added" : !newNode ? "node-removed" : "node-changed", bounds } : { kind: "full-scene", reason: "node-changed" });
  }
  return regions.length > 64 ? [{ kind: "full-scene", reason: "too-many-changes" }] : regions;
}

function dependencyFingerprintFor(group: CompositingGroup): string {
  const project = (candidate: CompositingGroup): unknown => [
    candidate.id,
    candidate.ownerNodeId,
    candidate.requiresBackdrop,
    candidate.hasEffects,
    candidate.sourceBounds,
    candidate.opacity,
    candidate.blendMode,
    candidate.clipBounds,
    candidate.maskNodeIds,
    candidate.items.map((item) => item.type === "draw"
      ? ["draw", item.primitive.nodeId, item.primitive.materialKey]
      : ["group", project(item.group)]),
  ];
  return JSON.stringify(project(group));
}

function sceneHasBackdropReader(group: CompositingGroup): boolean {
  return group.requiresBackdrop || group.items.some((item) => item.type === "group" && sceneHasBackdropReader(item.group));
}

function presentationFingerprintFor(node: CanvasNode, resolvedConnectorPath?: ConnectorPath): string {
  return JSON.stringify([
    node.kind,
    normalizedFillPaints(node),
    normalizedStrokePaints(node),
    node.strokeWidth,
    node.strokeCapStart,
    node.strokeCapEnd,
    node.strokeJoin,
    node.strokeMiterLimit,
    node.strokeDashPattern,
    node.strokeWeights,
    node.strokeAlign,
    node.radius,
    node.cornerRadii,
    node.cornerSmoothing,
    node.arcData,
    node.parametricShape,
    node.vectorPath,
    node.booleanOperation,
    node.opacity,
    node.blendMode,
    normalizedNodeEffects(node),
    node.text,
    node.textProperties,
    node.codeLanguage,
    node.assetId,
    node.contentsHidden,
    node.clipsContent,
    node.isMask,
    node.componentMetadata,
    node.instanceMetadata,
    node.slotMetadata,
    node.componentSetMetadata,
    node.connectorMetadata,
    resolvedConnectorPath,
    node.embedMetadata,
    node.highlightHandleMirroring,
    node.interactiveSlideElementType,
    node.linkUnfurlMetadata,
    node.mediaMetadata,
    node.shapeWithTextType,
    node.slideMetadata,
    node.stickyMetadata,
    node.tableMetadata,
    node.tableCellMetadata,
    node.textPathMetadata,
    node.transformModifiers,
    node.widgetMetadata,
    node.extensions,
  ]);
}
function sameBounds(left: TransformBounds | undefined, right: TransformBounds | undefined) { return left?.left === right?.left && left?.top === right?.top && left?.right === right?.right && left?.bottom === right?.bottom; }
function sameClipState(left: ClipState | undefined, right: ClipState | undefined) {
  if (left?.kind !== right?.kind) return false;
  if (!left || !right || left.kind !== "bounded" || right.kind !== "bounded") return true;
  if (!sameBounds(left.bounds, right.bounds) || left.chain.length !== right.chain.length) return false;
  return left.chain.every((geometry, index) => {
    const candidate = right.chain[index];
    return candidate?.nodeId === geometry.nodeId
      && candidate.geometry === geometry.geometry
      && candidate.width === geometry.width
      && candidate.height === geometry.height
      && candidate.radius === geometry.radius
      && candidate.cornerSmoothing === geometry.cornerSmoothing
      && candidate.cornerRadii?.join(",") === geometry.cornerRadii?.join(",")
      && Object.keys(geometry.worldTransform).every((key) => geometry.worldTransform[key as keyof AffineMatrix] === candidate.worldTransform[key as keyof AffineMatrix]);
  });
}
function unionBounds(left: TransformBounds | undefined, right: TransformBounds | undefined): TransformBounds | undefined { if (!left) return right; if (!right) return left; return { left: Math.min(left.left, right.left), top: Math.min(left.top, right.top), right: Math.max(left.right, right.right), bottom: Math.max(left.bottom, right.bottom) }; }
