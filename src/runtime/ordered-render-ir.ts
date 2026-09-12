import type { AffineMatrix, TransformBounds } from "../lib/scene-transform";

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
  /** Derived only; these values never enter the Canonical snapshot. */
  opacity?: number;
  blendMode?: string;
  clipBounds?: TransformBounds;
  maskNodeIds?: readonly string[];
  items: readonly RenderItem[];
}>;

export type SceneSemanticNode = Readonly<{
  nodeId: string;
  parentId?: string;
  visible: boolean;
  prototypeInteractive: boolean;
  paintable: boolean;
  zIndex: number;
  worldTransform?: AffineMatrix;
  worldBounds?: TransformBounds;
  clipBounds?: TransformBounds;
  effectBounds?: TransformBounds;
  maskNodeIds: readonly string[];
}>;

export type OrderedRenderScene = Readonly<{
  revision: number;
  root: CompositingGroup;
  semanticNodes: readonly SceneSemanticNode[];
}>;

export type RenderExecutionStep =
  | Readonly<{ type: "draw"; nodeId: string; materialKey: string }>
  | Readonly<{ type: "begin-group"; groupId: string }>
  | Readonly<{ type: "capture-backdrop"; groupId: string }>
  | Readonly<{ type: "apply-group-effects"; groupId: string }>
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
