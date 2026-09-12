import type { CanvasNode } from "../lib/editor-protocol";
import { sortNodesByLayerOrder } from "../lib/layer-order";
import { worldBoundsForTransform, worldTransformsForNodes, type TransformBounds } from "../lib/scene-transform";
import { worldVisualBoundsForNode } from "../lib/world-visual-bounds";
import { specialNodeFallback } from "../lib/special-node-fallback";
import type { CompositingGroup, OrderedRenderScene, RenderItem, RenderPrimitiveKind, SceneSemanticNode } from "./ordered-render-ir";

export type SceneCompilerDiagnostic = Readonly<{
  nodeId: string;
  capability: "invalid-transform" | "unsupported-node" | "special-node";
  reason: string;
}>;

export type SceneDirtyRegion = Readonly<{
  kind: "region" | "full-scene";
  reason: "initial" | "node-added" | "node-removed" | "node-changed" | "too-many-changes";
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
  previousScene?: OrderedRenderScene;
}>;

type Scope = Readonly<{ visible: boolean; clipBounds?: TransformBounds; maskNodeId?: string }>;

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
  const seen = new Set<string>();
  let zIndex = 0;

  const compileSiblings = (siblings: readonly CanvasNode[], scope: Scope): RenderItem[] => {
    const items: RenderItem[] = [];
    let maskNodeId: string | undefined;
    for (const node of stableOrder(siblings)) {
      const effectiveScope = { ...scope, ...(maskNodeId ? { maskNodeId } : {}) };
      const nodeItems = compileNode(node, effectiveScope);
      if (node.isMask) {
        maskNodeId = node.id;
        continue;
      }
      if (maskNodeId && nodeItems.length) {
        items.push({ type: "group", group: {
          id: `mask:${maskNodeId}:${node.id}`,
          ownerNodeId: node.id,
          requiresBackdrop: false,
          hasEffects: false,
          maskNodeIds: [maskNodeId],
          items: nodeItems,
        } });
      } else items.push(...nodeItems);
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
      ? worldVisualBoundsForNode(nodes, node, { transform: worldTransform, bounds: worldBounds })
      : undefined;
    if (!worldTransform || !worldBounds) diagnostics.push({ nodeId: node.id, capability: "invalid-transform", reason: "Node has no finite, acyclic world transform." });
    const maskBounds = scope.maskNodeId ? visualBoundsFor(scope.maskNodeId) : undefined;
    const clipBounds = intersectBounds(scope.clipBounds, maskBounds);
    const visible = scope.visible && node.visible !== false && Boolean(worldTransform && worldBounds) && (!scope.maskNodeId || Boolean(clipBounds));
    const primitive = primitiveFor(node, diagnostics);
    const paintable = visible && !node.isMask && Boolean(primitive);
    const effectBounds = effectBoundsFor(node, visualBounds, worldTransform);
    semanticNodes.push({
      nodeId: node.id,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      zIndex: zIndex++,
      visible,
      prototypeInteractive: visible && Boolean(node.reactions?.length),
      paintable,
      ...(worldTransform ? { worldTransform } : {}),
      ...(worldBounds ? { worldBounds } : {}),
      ...(clipBounds ? { clipBounds } : {}),
      ...(effectBounds ? { effectBounds } : {}),
      maskNodeIds: scope.maskNodeId ? [scope.maskNodeId] : [],
    });

    const ownItems: RenderItem[] = [];
    if (paintable && primitive) ownItems.push({ type: "draw", primitive: { nodeId: node.id, kind: primitive, materialKey: materialKeyFor(primitive) } });
    const childClipBounds = node.kind === "frame" && node.clipsContent !== false
      ? intersectBounds(clipBounds, worldBounds)
      : clipBounds;
    ownItems.push(...compileSiblings(children.get(node.id) ?? [], {
      visible: visible && !(node.kind === "section" && node.contentsHidden === true),
      ...(childClipBounds ? { clipBounds: childClipBounds } : {}),
    }));

    if (!ownItems.length || !visible) return [];
    const hasEffects = hasEffectsFor(node);
    const needsContext = node.kind === "frame" && node.clipsContent !== false
      || node.opacity < 1 || (node.blendMode !== undefined && node.blendMode !== "normal") || hasEffects;
    if (!needsContext) return ownItems;
    const group: CompositingGroup = {
      id: `context:${node.id}`,
      ownerNodeId: node.id,
      requiresBackdrop: hasBackgroundBlur(node),
      hasEffects,
      ...(node.opacity < 1 ? { opacity: node.opacity } : {}),
      ...(node.blendMode && node.blendMode !== "normal" ? { blendMode: node.blendMode } : {}),
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
    items: compileSiblings(children.get(undefined) ?? [], { visible: true }),
  };
  const scene: OrderedRenderScene = { revision: options.revision, root, semanticNodes };
  return { scene, diagnostics, dirtyRegions: dirtyRegionsFor(scene, options.previousScene) };

  function visualBoundsFor(id: string) {
    const target = byId.get(id);
    const transform = worldTransforms.get(id);
    return target && transform
      ? worldVisualBoundsForNode(nodes, target, { transform, bounds: worldBoundsForTransform(target, transform) })
      : undefined;
  }
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
    .find((node) => node.visible && node.paintable && contains(node.effectBounds ?? node.worldBounds, point) && (!node.clipBounds || contains(node.clipBounds, point)) && (preciseContains?.(node.nodeId) ?? true));
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
  if (node.kind === "group" || node.kind === "section" || node.kind === "slice" || node.kind === "slideGrid" || node.kind === "slideRow" || node.kind === "componentSet" || node.kind === "slot" || node.kind === "transformGroup") return undefined;
  if (node.kind === "text" || node.kind === "codeBlock" || node.kind === "sticky" || node.kind === "shapeWithText" || node.kind === "tableCell" || node.kind === "textPath") return "glyph-run";
  if (node.kind === "image") return "image";
  if (node.kind === "vector" || node.kind === "booleanOperation" || node.kind === "line" || node.kind === "connector" || node.kind === "polygon" || node.kind === "star") return "vector";
  if (node.kind === "media") return "media";
  if (node.kind === "embed" || node.kind === "linkUnfurl" || node.kind === "interactiveSlideElement" || node.kind === "widget") return "embedded-preview";
  if (node.kind === "frame" || node.kind === "rectangle" || node.kind === "ellipse" || node.kind === "component" || node.kind === "instance" || node.kind === "slide" || node.kind === "highlight" || node.kind === "stamp" || node.kind === "table" || node.kind === "washiTape") return "shape";
  diagnostics.push({ nodeId: node.id, capability: "unsupported-node", reason: `No render primitive mapping for ${node.kind}.` });
  return undefined;
}

function materialKeyFor(kind: RenderPrimitiveKind): string { return kind; }
function hasEffectsFor(node: CanvasNode): boolean { return Boolean(node.dropShadow?.visible || node.effectStack?.some((effect) => effect.dropShadow?.visible || effect.layerBlur?.visible || effect.innerShadow?.visible || effect.backgroundBlur?.visible)); }
function hasBackgroundBlur(node: CanvasNode): boolean { return Boolean(node.effectStack?.some((effect) => effect.backgroundBlur?.visible)); }

function effectBoundsFor(node: CanvasNode, visualBounds: TransformBounds | undefined, transform: SceneSemanticNode["worldTransform"]): TransformBounds | undefined {
  if (!visualBounds || !transform) return visualBounds;
  const radii = node.effectStack?.flatMap((effect) => [effect.layerBlur?.visible ? effect.layerBlur.radius : 0, effect.innerShadow?.visible ? effect.innerShadow.blurRadius : 0, effect.backgroundBlur?.visible ? effect.backgroundBlur.radius : 0]) ?? [];
  const radius = Math.max(0, ...radii);
  if (!radius) return visualBounds;
  const scale = Math.max(Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d));
  const outset = radius * scale;
  return { left: visualBounds.left - outset, top: visualBounds.top - outset, right: visualBounds.right + outset, bottom: visualBounds.bottom + outset };
}

function intersectBounds(left: TransformBounds | undefined, right: TransformBounds | undefined): TransformBounds | undefined {
  if (!left) return right;
  if (!right) return left;
  const result = { left: Math.max(left.left, right.left), top: Math.max(left.top, right.top), right: Math.min(left.right, right.right), bottom: Math.min(left.bottom, right.bottom) };
  return result.left < result.right && result.top < result.bottom ? result : undefined;
}
function contains(bounds: TransformBounds | undefined, point: Readonly<{ x: number; y: number }>) { return Boolean(bounds && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom); }

function dirtyRegionsFor(scene: OrderedRenderScene, previous: OrderedRenderScene | undefined): readonly SceneDirtyRegion[] {
  if (!previous) return [{ kind: "full-scene", reason: "initial" }];
  const before = new Map(previous.semanticNodes.map((node) => [node.nodeId, node]));
  const after = new Map(scene.semanticNodes.map((node) => [node.nodeId, node]));
  const regions: SceneDirtyRegion[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldNode = before.get(id); const newNode = after.get(id);
    const oldBounds = oldNode?.effectBounds ?? oldNode?.worldBounds;
    const newBounds = newNode?.effectBounds ?? newNode?.worldBounds;
    const changed = !oldNode || !newNode || oldNode.zIndex !== newNode.zIndex || oldNode.visible !== newNode.visible || oldNode.paintable !== newNode.paintable || !sameBounds(oldBounds, newBounds) || !sameBounds(oldNode?.clipBounds, newNode?.clipBounds) || oldNode?.maskNodeIds.join(",") !== newNode?.maskNodeIds.join(",");
    if (!changed) continue;
    const bounds = unionBounds(oldBounds, newBounds);
    regions.push(bounds ? { kind: "region", reason: !oldNode ? "node-added" : !newNode ? "node-removed" : "node-changed", bounds } : { kind: "full-scene", reason: "node-changed" });
  }
  return regions.length > 64 ? [{ kind: "full-scene", reason: "too-many-changes" }] : regions;
}
function sameBounds(left: TransformBounds | undefined, right: TransformBounds | undefined) { return left?.left === right?.left && left?.top === right?.top && left?.right === right?.right && left?.bottom === right?.bottom; }
function unionBounds(left: TransformBounds | undefined, right: TransformBounds | undefined): TransformBounds | undefined { if (!left) return right; if (!right) return left; return { left: Math.min(left.left, right.left), top: Math.min(left.top, right.top), right: Math.max(left.right, right.right), bottom: Math.max(left.bottom, right.bottom) }; }
