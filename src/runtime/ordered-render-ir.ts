import type { AffineMatrix, TransformBounds } from "../lib/scene-transform";
import type { CanvasNode, DocumentEffect } from "../lib/editor-protocol";

export type ClipGeometryRef = Readonly<{
  nodeId: string;
  /** Exact outer geometry understood by the shared hit/clip predicate. */
  geometry: "rounded-rect" | "ellipse";
  worldTransform: AffineMatrix;
  width: number;
  height: number;
  radius: number;
  cornerRadii?: readonly [number, number, number, number];
  cornerSmoothing?: number;
}>;

export type ClipState =
  | Readonly<{ kind: "unbounded" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "bounded"; bounds: TransformBounds; chain: readonly ClipGeometryRef[] }>;

export type RenderPrimitiveKind = "shape" | "vector" | "image" | "glyph-run" | "media" | "embedded-preview";

export type RenderPrimitive = Readonly<{
  nodeId: string;
  kind: RenderPrimitiveKind;
  materialKey: string;
}>;

export type RenderItem =
  | Readonly<{ type: "draw"; primitive: RenderPrimitive }>
  | Readonly<{ type: "group"; group: CompositingGroup }>;

export type CompositingGroup = Readonly<{
  id: string;
  ownerNodeId: string;
  requiresBackdrop: boolean;
  hasEffects: boolean;
  /** Frozen ordered owner effects; executors never re-read mutable nodes. */
  effects?: readonly DocumentEffect[];
  /** Complete visible source subtree before owner effects and composition. */
  sourceBounds?: TransformBounds;
  /** Derived only; these values never enter the Canonical snapshot. */
  opacity?: number;
  blendMode?: string;
  clipState?: ClipState;
  clipBounds?: TransformBounds;
  /**
   * Alpha sources applied once after every item in this contiguous sibling
   * run has been composited. A backend must not apply the mask per item.
   */
  maskNodeIds?: readonly string[];
  items: readonly RenderItem[];
}>;

export type SceneSemanticNode = Readonly<{
  nodeId: string;
  parentId?: string;
  /** Derived presentation identity used only for renderer invalidation. */
  presentationFingerprint: string;
  visible: boolean;
  prototypeInteractive: boolean;
  paintable: boolean;
  zIndex: number;
  worldTransform?: AffineMatrix;
  worldBounds?: TransformBounds;
  clipState: ClipState;
  clipBounds?: TransformBounds;
  effectBounds?: TransformBounds;
  maskNodeIds: readonly string[];
}>;

export type OrderedRenderScene = Readonly<{
  revision: number;
  /** Resource readiness may change without advancing the canonical revision. */
  resourceGeneration?: string | number;
  /** Render-tree dependencies that make a local bounds replay unsafe. */
  dependencyFingerprint?: string;
  root: CompositingGroup;
  semanticNodes: readonly SceneSemanticNode[];
  /** Mask owners are rare; freeze their complete paint/resource projection. */
  maskSources?: readonly Readonly<{ node: CanvasNode; worldTransform?: AffineMatrix }>[];
}>;

export type RenderExecutionStep =
  | Readonly<{ type: "draw"; nodeId: string; materialKey: string }>
  | Readonly<{ type: "begin-group"; groupId: string }>
  | Readonly<{ type: "capture-backdrop"; groupId: string }>
  | Readonly<{ type: "apply-group-effects"; groupId: string }>
  | Readonly<{ type: "apply-alpha-mask"; groupId: string; maskNodeIds: readonly string[] }>
  | Readonly<{ type: "composite-group"; groupId: string }>;

/**
 * Produces execution steps in Canonical display-list order. Pipeline/material
 * keys are retained for local batching only; they never create a global
 * Shape/Image/Text pass that could reorder sibling layers.
 */
export function orderedRenderExecution(scene: OrderedRenderScene): readonly RenderExecutionStep[] {
  if (!Number.isSafeInteger(scene.revision) || scene.revision < 0) throw new Error("Invalid scene revision.");
  const steps: RenderExecutionStep[] = [];
  appendGroup(scene.root, steps, true);
  return steps;
}

/**
 * Indexes the immutable clip geometry embedded in a compiled scene. Canvas
 * executors use these references instead of rebuilding a clip from the latest
 * mutable node projection while a frame is in flight.
 */
export function sceneClipGeometryByNodeId(scene: OrderedRenderScene): ReadonlyMap<string, ClipGeometryRef> {
  const geometries = new Map<string, ClipGeometryRef>();
  const include = (state: ClipState | undefined) => {
    if (state?.kind !== "bounded") return;
    state.chain.forEach((geometry) => {
      if (!geometries.has(geometry.nodeId)) geometries.set(geometry.nodeId, geometry);
    });
  };
  const visitGroup = (group: CompositingGroup) => {
    include(group.clipState);
    group.items.forEach((item) => {
      if (item.type === "group") visitGroup(item.group);
    });
  };
  visitGroup(scene.root);
  scene.semanticNodes.forEach((node) => include(node.clipState));
  return geometries;
}

/** Complete immutable mask sources consumed by alpha-compositing backends. */
export function sceneMaskSourceByNodeId(scene: OrderedRenderScene): ReadonlyMap<string, Readonly<{ node: CanvasNode; worldTransform?: AffineMatrix }>> {
  return new Map((scene.maskSources ?? []).map((source) => [source.node.id, source]));
}

function appendGroup(group: CompositingGroup, steps: RenderExecutionStep[], root = false): void {
  if (!root) {
    steps.push({ type: "begin-group", groupId: group.id });
    if (group.requiresBackdrop) steps.push({ type: "capture-backdrop", groupId: group.id });
  }
  for (const item of group.items) {
    if (item.type === "draw") {
      steps.push({ type: "draw", nodeId: item.primitive.nodeId, materialKey: item.primitive.materialKey });
    } else {
      appendGroup(item.group, steps);
    }
  }
  if (!root) {
    if (group.hasEffects) steps.push({ type: "apply-group-effects", groupId: group.id });
    if (group.maskNodeIds?.length) steps.push({ type: "apply-alpha-mask", groupId: group.id, maskNodeIds: group.maskNodeIds });
    steps.push({ type: "composite-group", groupId: group.id });
  }
}

export type OrderedDrawBatch = Readonly<{
  materialKey: string;
  nodeIds: readonly string[];
}>;

/** Batches only directly adjacent draw steps, preserving every display-list barrier. */
export function orderedDrawBatches(steps: readonly RenderExecutionStep[]): readonly OrderedDrawBatch[] {
  const batches: Array<{ materialKey: string; nodeIds: string[] }> = [];
  let previousStepWasDraw = false;
  for (const step of steps) {
    if (step.type !== "draw") {
      previousStepWasDraw = false;
      continue;
    }
    const last = batches.at(-1);
    if (previousStepWasDraw && last?.materialKey === step.materialKey) last.nodeIds.push(step.nodeId);
    else batches.push({ materialKey: step.materialKey, nodeIds: [step.nodeId] });
    previousStepWasDraw = true;
  }
  return batches.map((batch) => ({ materialKey: batch.materialKey, nodeIds: batch.nodeIds }));
}
