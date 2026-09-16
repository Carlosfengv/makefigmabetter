import { COMPONENT_PROPERTY_REFERENCES_EXTENSION, createId as generateId, createNode, documentColorFromCssHex, type CanvasNode, type CoreBatchCommand, type CoreProjectionNode, type DocumentVectorPath, type EditorClipboard, type EditorCommand } from "./editor-protocol";
import { validateClipboardCapture } from "./editor-clipboard";
import { orderNewLayerAtFront, positionIdForLayerInsertion, resolveLayerDrop, sortNodesByLayerOrder } from "./layer-order";
import { nodePropsForWorldTransform, normalizeGroupBounds, worldBoundsForNode, worldSpaceProjectionNode, worldTransformForNode } from "./scene-transform";
import { encodePrototypeValue, PROTOTYPE_METADATA_EXTENSION, PROTOTYPE_REACTIONS_EXTENSION, validatePrototypeMetadata, validatePrototypeReactions } from "../runtime/prototype-contract";
import { clipsChildren } from "./node-capabilities";
import { TEXT_PATH_SOURCE_KINDS } from "./text-path-conversion";

export type { CoreBatchCommand, CoreProjectionNode } from "./editor-protocol";
export type ResolvedCoreBatch = {
  batch: CoreBatchCommand[];
  nextNodes: CanvasNode[];
  createdIds: string[];
  /** UI state is resolved alongside the atomic Core batch, never inferred from
   * command ordering. Structural commands deliberately replace the selection. */
  selectionIds: string[];
  affectedGroupIds: string[];
};

/**
 * Runtime property setters commonly produce several consecutive updates for
 * the same node. Collapse those updates before they reach Core, while treating
 * every structural or constraint-bypassing command as an ordering barrier.
 * This keeps Reparent/Reposition in the order emitted by the Runtime bridge
 * and prevents one logical setter batch from triggering duplicate reflows.
 */
export function coalesceAdjacentNodeUpdates(commands: readonly EditorCommand[]): EditorCommand[] {
  const result: EditorCommand[] = [];
  const pending = new Map<string, Partial<CanvasNode>>();
  const flush = () => {
    pending.forEach((patch, id) => result.push({ type: "update", id, patch }));
    pending.clear();
  };

  for (const command of commands) {
    if (command.type === "update") {
      pending.set(command.id, { ...(pending.get(command.id) ?? {}), ...command.patch });
      continue;
    }
    flush();
    result.push(command);
  }
  flush();
  return result;
}

const EXTENSION_BACKED_PATCH_KEYS = new Set<keyof CanvasNode>([
  "extensions",
  "reactions",
  "prototypeMetadata",
  "codeLanguage",
  "componentMetadata",
  "instanceMetadata",
  "slotMetadata",
  "componentSetMetadata",
  "componentPropertyReferences",
  "connectorMetadata",
  "embedMetadata",
  "highlightHandleMirroring",
  "interactiveSlideElementType",
  "linkUnfurlMetadata",
  "mediaMetadata",
  "shapeWithTextType",
  "slideMetadata",
  "stickyMetadata",
  "tableMetadata",
  "tableCellMetadata",
  "textPathMetadata",
  "transformModifiers",
  "widgetMetadata",
]);

export function coreProjectionNode(node: CanvasNode): CoreProjectionNode {
  const extensions = { ...node.extensions };
  if (node.componentPropertyReferences !== undefined) {
    extensions[COMPONENT_PROPERTY_REFERENCES_EXTENSION] = [...new TextEncoder().encode(JSON.stringify(node.componentPropertyReferences))];
  } else {
    delete extensions[COMPONENT_PROPERTY_REFERENCES_EXTENSION];
  }
  if (node.reactions !== undefined) extensions[PROTOTYPE_REACTIONS_EXTENSION] = encodePrototypeValue(validatePrototypeReactions(node.reactions));
  if (node.prototypeMetadata !== undefined) extensions[PROTOTYPE_METADATA_EXTENSION] = encodePrototypeValue(validatePrototypeMetadata(node.prototypeMetadata));
  if (node.kind === "codeBlock") extensions["figma.code-block.language.v1"] = [...new TextEncoder().encode(node.codeLanguage ?? "PLAINTEXT")];
  if (node.kind === "component" && node.componentMetadata) extensions["figma.component.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.componentMetadata))];
  if (node.kind === "instance" && node.instanceMetadata) extensions["figma.instance.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.instanceMetadata))];
  if (node.kind === "slot" && node.slotMetadata) extensions["figma.slot.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.slotMetadata))];
  if (node.kind === "componentSet" && node.componentSetMetadata) extensions["figma.component-set.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.componentSetMetadata))];
  if (node.kind === "connector" && node.connectorMetadata) extensions["figma.connector.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.connectorMetadata))];
  if (node.kind === "embed" && node.embedMetadata) extensions["figma.embed.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.embedMetadata))];
  if (node.kind === "highlight" && node.highlightHandleMirroring) extensions["figma.highlight.handle-mirroring.v1"] = [...new TextEncoder().encode(node.highlightHandleMirroring)];
  if (node.kind === "interactiveSlideElement" && node.interactiveSlideElementType) extensions["figma.interactive-slide-element.type.v1"] = [...new TextEncoder().encode(node.interactiveSlideElementType)];
  if (node.kind === "linkUnfurl" && node.linkUnfurlMetadata) extensions["figma.link-unfurl.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.linkUnfurlMetadata))];
  if (node.kind === "media" && node.mediaMetadata) extensions["figma.media.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.mediaMetadata))];
  if (node.kind === "shapeWithText" && node.shapeWithTextType) extensions["figma.shape-with-text.type.v1"] = [...new TextEncoder().encode(node.shapeWithTextType)];
  if (node.kind === "slide" && node.slideMetadata) extensions["figma.slide.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.slideMetadata))];
  if (node.kind === "sticky" && node.stickyMetadata) extensions["figma.sticky.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.stickyMetadata))];
  if (node.kind === "table" && node.tableMetadata) extensions["figma.table.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.tableMetadata))];
  if (node.kind === "tableCell" && node.tableCellMetadata) extensions["figma.table-cell.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.tableCellMetadata))];
  if (node.kind === "textPath" && node.textPathMetadata) extensions["figma.text-path.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.textPathMetadata))];
  if (node.kind === "transformGroup" && node.transformModifiers) extensions["figma.transform-group.modifiers.v1"] = [...new TextEncoder().encode(JSON.stringify(node.transformModifiers))];
  if (node.kind === "widget" && node.widgetMetadata) extensions["figma.widget.metadata.v1"] = [...new TextEncoder().encode(JSON.stringify(node.widgetMetadata))];
  // Keep the legacy R3 field synchronized with the first ordered effect so
  // older snapshots and render paths remain lossless while the Inspector edits
  // the whole stack.
  const effectStack = node.effectStack?.length
    ? node.effectStack[0].dropShadow && node.dropShadow && !sameDropShadow(node.effectStack[0].dropShadow, node.dropShadow)
      ? [{ dropShadow: node.dropShadow }, ...node.effectStack.slice(1)]
      : node.effectStack
    : node.dropShadow ? [{ dropShadow: node.dropShadow }] : [];
  const dropShadow = effectStack[0]?.dropShadow ?? node.dropShadow;
  return { id: node.id, pageId: node.pageId, parentId: node.parentId, name: node.name, kind: node.kind, x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation, fill: node.fill, fillColor: node.fillColor, fillGradient: node.fillGradient, fills: node.fills, fillStack: node.fillStack, fillStyleId: node.fillStyleId, positionId: node.positionId, stroke: node.stroke, strokeColor: node.strokeColor, strokeGradient: node.strokeGradient, strokes: node.strokes, strokeStack: node.strokeStack, strokeStyleId: node.strokeStyleId, backgroundStyleId: node.backgroundStyleId, strokeWidth: node.strokeWidth, strokeCapStart: node.strokeCapStart ?? "none", strokeCapEnd: node.strokeCapEnd ?? "none", strokeJoin: node.strokeJoin ?? "miter", strokeMiterLimit: node.strokeMiterLimit ?? 10, strokeDashPattern: node.strokeDashPattern ?? [], strokeWeights: node.strokeWeights, strokeAlign: node.strokeAlign ?? "inside", arcData: node.arcData, parametricShape: node.parametricShape, vectorPath: node.vectorPath, booleanOperation: node.booleanOperation, cornerRadii: node.cornerRadii, cornerSmoothing: node.cornerSmoothing, constraints: node.constraints, autoLayout: node.autoLayout, relativeTransform: node.relativeTransform, opacity: node.opacity, blendMode: node.blendMode ?? "normal", dropShadow, effectStack, cornerRadius: node.radius ?? 0, text: node.text ?? "", textProperties: node.textProperties, visible: node.visible !== false, locked: Boolean(node.locked), contentsHidden: Boolean(node.contentsHidden), clipsContent: clipsChildren(node.kind) ? node.clipsContent !== false : undefined, isMask: Boolean(node.isMask), assetId: node.assetId, extensions };
}

function sameDropShadow(left: CanvasNode["dropShadow"], right: CanvasNode["dropShadow"]) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export type FlattenedBooleanPath = Readonly<{
  subpaths: readonly {
    closed: boolean;
    points: readonly { x: number; y: number }[];
  }[];
}>;

export type ResolvedFlattenBooleanBatch = Readonly<{
  batch: CoreBatchCommand[];
  replacement: CanvasNode;
}>;

export type ResolvedOutlineStrokeBatch = Readonly<{
  batch: CoreBatchCommand[];
  outlined: CanvasNode;
}>;

export type ResolvedLineOutlineStrokeBatch = Readonly<{
  batch: CoreBatchCommand[];
  outlined: CanvasNode;
}>;

export type ResolvedParametricToVectorBatch = Readonly<{
  batch: CoreBatchCommand[];
  replacement: CanvasNode;
}>;

export type ResolvedFlattenNodeBatch = Readonly<{
  batch: CoreBatchCommand[];
  replacement: CanvasNode;
}>;

/** Turns one valid live Boolean subtree into the Vector result produced by the
 * Rust geometry bridge. The replacement is created before deleting the wrapper
 * and takes the wrapper's old layer position, so Core records the entire
 * conversion as exactly one undoable transaction. */
export function resolveFlattenBooleanBatch(
  nodes: readonly CanvasNode[],
  booleanId: string,
  path: FlattenedBooleanPath,
  createId: () => string = generateId,
  replacementId?: string,
  target?: Readonly<{ parentId?: string; pageId?: string; index?: number }>,
): ResolvedFlattenBooleanBatch | undefined {
  const boolean = nodes.find((node) => node.id === booleanId);
  const operands = boolean && sortNodesByLayerOrder(nodes.filter((node) => node.parentId === boolean.id));
  const source = operands?.[0];
  if (!boolean || boolean.kind !== "booleanOperation" || !source || operands.length < 2 || operands.some((node) => node.kind !== "vector" || !node.vectorPath)) return undefined;
  if (target?.parentId !== undefined && target.pageId !== undefined) return undefined;
  const hasExplicitTarget = target?.parentId !== undefined || target?.pageId !== undefined || target?.index !== undefined;
  const targetParentId = target?.parentId !== undefined ? target.parentId : target?.pageId !== undefined ? undefined : boolean.parentId;
  const targetParent = targetParentId ? nodes.find((node) => node.id === targetParentId) : undefined;
  const targetPageId = target?.pageId ?? targetParent?.pageId ?? boolean.pageId;
  if (targetPageId !== boolean.pageId || (targetParentId && (!targetParent || !["frame", "component", "group", "transformGroup", "booleanOperation", "section", "slot"].includes(targetParent.kind)))) return undefined;
  if (targetParentId && (targetParentId === boolean.id || hasAncestor(nodes, targetParentId, boolean.id))) return undefined;
  const remainingTargetSiblings = sortNodesByLayerOrder(nodes.filter((node) =>
    node.pageId === targetPageId && node.parentId === targetParentId && node.id !== boolean.id));
  const currentIndex = sortNodesByLayerOrder(nodes.filter((node) => node.pageId === boolean.pageId && node.parentId === boolean.parentId)).findIndex((node) => node.id === boolean.id);
  const destination = target?.index ?? (hasExplicitTarget ? remainingTargetSiblings.length : currentIndex);
  if (!Number.isSafeInteger(destination) || destination < 0 || destination > remainingTargetSiblings.length) return undefined;
  const booleanWorld = worldTransformForNode(nodes, boolean.id);
  const targetParentWorld = targetParentId ? worldTransformForNode(nodes, targetParentId) : undefined;
  const replacementTransform = booleanWorld && nodePropsForWorldTransform(booleanWorld, targetParentWorld, boolean.width, boolean.height);
  if (!replacementTransform) return undefined;
  replacementId ??= createId();
  if (!replacementId || nodes.some((node) => node.id === replacementId)) return undefined;
  const desiredPositionId = targetParentId === boolean.parentId && destination === currentIndex
    ? boolean.positionId ?? positionIdForLayerInsertion(remainingTargetSiblings.map((node) => ({ positionId: node.positionId })), destination)
    : positionIdForLayerInsertion(remainingTargetSiblings.map((node) => ({ positionId: node.positionId })), destination);
  if (!desiredPositionId) return undefined;
  const replacement: CanvasNode = {
    ...source,
    id: replacementId,
    kind: "vector",
    name: `${boolean.name} flattened`,
    pageId: targetPageId,
    parentId: targetParentId,
    ...replacementTransform,
    width: boolean.width,
    height: boolean.height,
    // Flatten replaces the Boolean wrapper, not its first operand.  Its mask
    // identity must therefore follow the wrapper into the Vector result.
    isMask: Boolean(boolean.isMask),
    positionId: `${replacementId.replaceAll("-", "")}:00000000000000000000000000000000`,
    vectorPath: {
      fillRule: "nonZero",
      subpaths: path.subpaths.map((subpath) => ({
        closed: subpath.closed,
        points: subpath.points.map((point) => ({ id: createId(), x: point.x, y: point.y, pointType: "corner" as const })),
      })),
    },
  };
  const batch: CoreBatchCommand[] = [
    { type: "create", node: coreProjectionNode(replacement) },
    // Core deliberately rejects parent deletion while its live Boolean
    // operands still exist. Delete children first, then the wrapper, within
    // this one atomic transaction so Undo restores the whole structure.
    { type: "delete", ids: operands.map((operand) => operand.id) },
    { type: "delete", ids: [boolean.id] },
    { type: "reposition", positionIds: [{ id: replacementId, positionId: desiredPositionId }] },
  ];
  const nextNodes = [...nodes.filter((node) => node.id !== boolean.id && !operands.some((operand) => operand.id === node.id)), { ...replacement, positionId: desiredPositionId }];
  if (!appendCreatedMaskCommands(batch, nextNodes)) return undefined;
  return { replacement, batch };
}

/** Replaces one leaf vector-like node with an equivalent editable Vector.
 * Geometry is resolved by the Runtime before crossing the Worker boundary;
 * Core receives one create/delete/reposition transaction so Undo restores the
 * original parametric node and its identity. */
export function resolveFlattenNodeBatch(
  nodes: readonly CanvasNode[],
  sourceId: string,
  vectorPath: DocumentVectorPath,
  createId: () => string = generateId,
  replacementId?: string,
  target?: Readonly<{ parentId?: string; pageId?: string; index?: number }>,
): ResolvedFlattenNodeBatch | undefined {
  const source = nodes.find((node) => node.id === sourceId);
  if (!source || !TEXT_PATH_SOURCE_KINDS.includes(source.kind)) return undefined;
  if (target?.parentId !== undefined && target.pageId !== undefined) return undefined;
  const hasExplicitTarget = target?.parentId !== undefined || target?.pageId !== undefined || target?.index !== undefined;
  const targetParentId = target?.parentId !== undefined ? target.parentId : target?.pageId !== undefined ? undefined : source.parentId;
  const targetParent = targetParentId ? nodes.find((node) => node.id === targetParentId) : undefined;
  const targetPageId = target?.pageId ?? targetParent?.pageId ?? source.pageId;
  if (targetPageId !== source.pageId || (targetParentId && (!targetParent || !["frame", "component", "group", "transformGroup", "booleanOperation", "section", "slot"].includes(targetParent.kind)))) return undefined;
  if (targetParentId && (targetParentId === source.id || hasAncestor(nodes, targetParentId, source.id))) return undefined;
  const remainingTargetSiblings = sortNodesByLayerOrder(nodes.filter((node) =>
    node.pageId === targetPageId && node.parentId === targetParentId && node.id !== source.id));
  const currentIndex = sortNodesByLayerOrder(nodes.filter((node) => node.pageId === source.pageId && node.parentId === source.parentId)).findIndex((node) => node.id === source.id);
  const destination = target?.index ?? (hasExplicitTarget ? remainingTargetSiblings.length : currentIndex);
  if (!Number.isSafeInteger(destination) || destination < 0 || destination > remainingTargetSiblings.length) return undefined;
  const sourceWorld = worldTransformForNode(nodes, source.id);
  const targetParentWorld = targetParentId ? worldTransformForNode(nodes, targetParentId) : undefined;
  const replacementTransform = sourceWorld && nodePropsForWorldTransform(sourceWorld, targetParentWorld, source.width, source.height);
  if (!replacementTransform) return undefined;
  replacementId ??= createId();
  if (!replacementId || nodes.some((node) => node.id === replacementId)) return undefined;
  const desiredPositionId = targetParentId === source.parentId && destination === currentIndex
    ? source.positionId ?? positionIdForLayerInsertion(remainingTargetSiblings.map((node) => ({ positionId: node.positionId })), destination)
    : positionIdForLayerInsertion(remainingTargetSiblings.map((node) => ({ positionId: node.positionId })), destination);
  if (!desiredPositionId) return undefined;
  const replacement: CanvasNode = {
    ...source,
    id: replacementId,
    kind: "vector",
    name: `${source.name} flattened`,
    pageId: targetPageId,
    parentId: targetParentId,
    ...replacementTransform,
    positionId: `${replacementId.replaceAll("-", "")}:00000000000000000000000000000000`,
    vectorPath: structuredClone(vectorPath),
    arcData: undefined,
    parametricShape: undefined,
    booleanOperation: undefined,
    radius: 0,
    cornerRadii: undefined,
    cornerSmoothing: 0,
    contentsHidden: false,
    clipsContent: undefined,
  };
  const batch: CoreBatchCommand[] = [
    { type: "create", node: coreProjectionNode(replacement) },
    { type: "delete", ids: [source.id] },
    { type: "reposition", positionIds: [{ id: replacementId, positionId: desiredPositionId }] },
  ];
  const nextNodes = [...nodes.filter((node) => node.id !== source.id), { ...replacement, positionId: desiredPositionId }];
  if (!appendCreatedMaskCommands(batch, nextNodes)) return undefined;
  return { replacement, batch };
}

/** Replaces a Vector's paint stroke with the closed fill contours derived by
 * Rust's shared stroke tessellation. Keeping its ID turns Outline Stroke into
 * one normal Vector update, with exact Core undo/redo semantics. */
export function resolveOutlineStrokeBatch(
  nodes: readonly CanvasNode[],
  vectorId: string,
  path: FlattenedBooleanPath,
  createId: () => string = generateId,
): ResolvedOutlineStrokeBatch | undefined {
  const vector = nodes.find((node) => node.id === vectorId);
  if (!vector || vector.kind !== "vector" || !vector.vectorPath || vector.strokeWidth <= 0 || vector.strokeDashPattern?.length || !path.subpaths.length || path.subpaths.some((subpath) => !subpath.closed || subpath.points.length < 3)) return undefined;
  const outlined: CanvasNode = {
    ...vector,
    name: `${vector.name} outlined`,
    fill: vector.stroke,
    fillColor: vector.strokeColor,
    fillGradient: vector.strokeGradient,
    fills: vector.strokes && structuredClone(vector.strokes),
    stroke: "transparent",
    strokeColor: undefined,
    strokeGradient: undefined,
    strokes: undefined,
    strokeWidth: 0,
    strokeCapStart: "none",
    strokeCapEnd: "none",
    strokeDashPattern: [],
    vectorPath: {
      fillRule: "nonZero",
      subpaths: path.subpaths.map((subpath) => ({
        closed: true,
        points: subpath.points.map((point) => ({ id: createId(), x: point.x, y: point.y, pointType: "corner" as const })),
      })),
    },
  };
  return { outlined, batch: [{ type: "update", node: coreProjectionNode(outlined) }] };
}

/** Converts a solid, matching-cap Line into the same Rust-derived closed
 * contours used for Vector outlining. Node kinds are immutable in Core, so a
 * Line needs one create/delete/reposition transaction instead of a Vector's
 * same-ID update. The replacement's affine maps its path's local origin to
 * the original line endpoint, preserving rotation and Relative-v1 parents. */
export function resolveLineOutlineStrokeBatch(
  nodes: readonly CanvasNode[],
  lineId: string,
  path: FlattenedBooleanPath,
  createId: () => string = generateId,
): ResolvedLineOutlineStrokeBatch | undefined {
  const line = nodes.find((node) => node.id === lineId);
  if (!line || line.kind !== "line" || line.strokeWidth <= 0 || line.strokeDashPattern?.length || !path.subpaths.length || path.subpaths.some((subpath) => !subpath.closed || subpath.points.length < 3)) return undefined;
  const points = path.subpaths.flatMap((subpath) => subpath.points);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  const world = worldTransformForNode(nodes, line.id);
  const parentWorld = line.parentId ? worldTransformForNode(nodes, line.parentId) : undefined;
  const transform = world && nodePropsForWorldTransform(world, parentWorld, width, height);
  if (!transform) return undefined;
  const replacementId = createId();
  const outlined: CanvasNode = {
    ...line,
    ...transform,
    id: replacementId,
    kind: "vector",
    name: `${line.name} outlined`,
    width,
    height,
    positionId: `${replacementId.replaceAll("-", "")}:00000000000000000000000000000000`,
    fill: line.stroke,
    fillColor: line.strokeColor,
    fillGradient: line.strokeGradient,
    fills: line.strokes && structuredClone(line.strokes),
    stroke: "transparent",
    strokeColor: undefined,
    strokeGradient: undefined,
    strokes: undefined,
    strokeWidth: 0,
    strokeCapStart: "none",
    strokeCapEnd: "none",
    strokeDashPattern: [],
    vectorPath: {
      fillRule: "nonZero",
      subpaths: path.subpaths.map((subpath) => ({
        closed: true,
        points: subpath.points.map((point) => ({ id: createId(), x: point.x, y: point.y, pointType: "corner" as const })),
      })),
    },
  };
  const batch: CoreBatchCommand[] = [
    { type: "create", node: coreProjectionNode(outlined) },
    { type: "delete", ids: [line.id] },
    { type: "reposition", positionIds: [{ id: replacementId, positionId: line.positionId ?? outlined.positionId! }] },
  ];
  if (!appendCreatedMaskCommands(batch, [...nodes.filter((node) => node.id !== line.id), { ...outlined, positionId: line.positionId ?? outlined.positionId }])) return undefined;
  return { outlined, batch };
}

/** Replaces one regular parametric shape with the exact derived closed path in
 * one Core transaction. The replacement keeps the source transform, paints and
 * layer position; its new identity lets Core undo restore the original NodeKind
 * and its editable parameters without a special-case history record. */
export function resolveParametricShapeToVectorBatch(
  nodes: readonly CanvasNode[],
  shapeId: string,
  points: readonly { x: number; y: number }[],
  createId: () => string = generateId,
): ResolvedParametricToVectorBatch | undefined {
  const shape = nodes.find((node) => node.id === shapeId);
  if (!shape || (shape.kind !== "polygon" && shape.kind !== "star") || !shape.parametricShape || points.length < 3 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return undefined;
  const replacementId = createId();
  const replacement: CanvasNode = {
    ...shape,
    id: replacementId,
    kind: "vector",
    name: `${shape.name} vector`,
    positionId: `${replacementId.replaceAll("-", "")}:00000000000000000000000000000000`,
    parametricShape: undefined,
    vectorPath: {
      fillRule: "nonZero",
      subpaths: [{
        closed: true,
        points: points.map((point) => ({ id: createId(), x: point.x, y: point.y, pointType: "corner" as const })),
      }],
    },
  };
  const batch: CoreBatchCommand[] = [
    { type: "create", node: coreProjectionNode(replacement) },
    { type: "delete", ids: [shape.id] },
    { type: "reposition", positionIds: [{ id: replacementId, positionId: shape.positionId ?? replacement.positionId! }] },
  ];
  if (!appendCreatedMaskCommands(batch, [...nodes.filter((node) => node.id !== shape.id), { ...replacement, positionId: shape.positionId ?? replacement.positionId }])) return undefined;
  return { replacement, batch };
}

/** Resolves UI-level partial patches to the concrete Core commands accepted by WASM.
 * A failed resolution returns nothing and deliberately leaves the caller's projection
 * untouched, matching Rust's all-or-nothing transaction boundary. */
export function resolveCoreBatch(nodes: CanvasNode[], commands: EditorCommand[], createId: () => string = generateId): ResolvedCoreBatch | undefined {
  const nextNodes = structuredClone(nodes);
  const knownNodeIds = new Set(nextNodes.map((node) => node.id));
  const batch: CoreBatchCommand[] = [];
  const createdIds: string[] = [];
  let selectionIds: string[] = [];
  const affectedGroupIds = new Set<string>();
  for (const command of commands) {
    if (command.type === "register-text-style") {
      batch.push({ type: "registerTextStyle", style: structuredClone(command.style) });
      continue;
    }
    if (command.type === "register-paint-style") {
      batch.push({ type: "registerPaintStyle", style: structuredClone(command.style) });
      continue;
    }
    if (command.type === "set-text-style") {
      batch.push({ type: "setTextStyle", style: structuredClone(command.style) });
      continue;
    }
    if (command.type === "delete-text-style") {
      batch.push({ type: "deleteTextStyle", id: command.id });
      continue;
    }
    if (command.type === "set-paint-style") {
      batch.push({ type: "setPaintStyle", style: structuredClone(command.style) });
      continue;
    }
    if (command.type === "delete-paint-style") {
      batch.push({ type: "deletePaintStyle", id: command.id });
      continue;
    }
    if (command.type === "register-variable-collection") {
      batch.push({ type: "registerVariableCollection", collection: structuredClone(command.collection) });
      continue;
    }
    if (command.type === "register-variable") {
      batch.push({ type: "registerVariable", variable: structuredClone(command.variable) });
      continue;
    }
    if (command.type === "set-variable") {
      batch.push({ type: "setVariable", variable: structuredClone(command.variable) });
      continue;
    }
    if (command.type === "delete-variable") {
      batch.push({ type: "deleteVariable", id: command.id });
      continue;
    }
    if (command.type === "set-variable-collection") {
      batch.push({ type: "setVariableCollection", collection: structuredClone(command.collection), variables: structuredClone(command.variables) });
      continue;
    }
    if (command.type === "delete-variable-collection") {
      batch.push({ type: "deleteVariableCollection", id: command.id });
      continue;
    }
    if (command.type === "convertToTextPath") {
      const index = nextNodes.findIndex((node) => node.id === command.id);
      const node = nextNodes[index];
      if (index === -1 || !TEXT_PATH_SOURCE_KINDS.includes(node.kind) || !command.vectorPath.subpaths.length) return undefined;
      const replacement: CanvasNode = {
        ...node,
        kind: "textPath",
        name: "Text path",
        text: "",
        vectorPath: structuredClone(command.vectorPath),
        textPathMetadata: structuredClone(command.metadata),
        arcData: undefined,
        parametricShape: undefined,
        booleanOperation: undefined,
        radius: 0,
        cornerRadii: undefined,
        cornerSmoothing: 0,
        strokeWeights: undefined,
        contentsHidden: false,
        clipsContent: undefined,
      };
      nextNodes[index] = replacement;
      batch.push({ type: "convertToTextPath", node: coreProjectionNode(replacement) });
      continue;
    }
    if (command.type === "create") {
      if (knownNodeIds.has(command.node.id)) return undefined;
      const node = structuredClone(command.node);
      nextNodes.push(node);
      knownNodeIds.add(node.id);
      batch.push({ type: "create", node: coreProjectionNode(node) });
      createdIds.push(node.id);
      continue;
    }
    if (command.type === "update" || command.type === "resizeWithoutConstraints") {
      const index = nextNodes.findIndex((node) => node.id === command.id);
      if (index === -1) return undefined;
      const previous = nextNodes[index];
      // Figma exposes the TextPath baseline as an immutable source path. It is
      // installed by convertToTextPath and must not be replaced through the
      // generic Inspector/Runtime update surface.
      if (previous.kind === "textPath" && Object.hasOwn(command.patch, "vectorPath")) return undefined;
      // IDs and kinds are document identity, never Inspector-editable values.
      const node = { ...previous, ...command.patch, id: previous.id, kind: previous.kind };
      if ("fill" in command.patch) { node.fillColor = documentColorFromCssHex(node.fill); node.fillGradient = undefined; }
      if ("stroke" in command.patch) { node.strokeColor = documentColorFromCssHex(node.stroke); node.strokeGradient = undefined; }
      const enablesAutoLayout = isFrameLike(previous)
        && (previous.autoLayout?.mode ?? "none") === "none"
        && (node.autoLayout?.mode === "horizontal" || node.autoLayout?.mode === "vertical");
      // Figma converts a Frame's ordinary children into layout children when
      // Auto Layout is added. Relative-v1 matrices are valid under a manual
      // Frame but intentionally invalid for a flow child, whose geometry is
      // now owned by the layout engine. Normalize those direct flow children
      // first in the same transaction; absolute children retain their matrix.
      if (enablesAutoLayout) {
        nextNodes.forEach((child, childIndex) => {
          if (child.parentId !== previous.id || !child.relativeTransform || child.autoLayout?.absolute) return;
          const normalized = { ...child, relativeTransform: undefined };
          nextNodes[childIndex] = normalized;
          batch.push({ type: "update", node: coreProjectionNode(normalized) });
        });
      }
      nextNodes[index] = node;
      if (updateAffectsGroupBounds(command.patch)) {
        if (node.kind === "group" || node.kind === "booleanOperation") affectedGroupIds.add(node.id);
        groupAncestorIds(nextNodes, node.parentId).forEach((id) => affectedGroupIds.add(id));
      }
      const coreNode = coreProjectionNode(node);
      if (Object.keys(command.patch).some((key) => EXTENSION_BACKED_PATCH_KEYS.has(key as keyof CanvasNode))) {
        batch.push({ type: "setExtensions", id: node.id, extensions: coreNode.extensions ?? {} });
      }
      const patchKeys = Object.keys(command.patch);
      const plainTextOnly = node.kind === "shapeWithText" || node.kind === "textPath"
        ? patchKeys.length > 0 && patchKeys.every((key) => key === "text" || key === "textProperties" || (node.kind === "textPath" && key === "name"))
        : patchKeys.length === 1
          && Object.hasOwn(command.patch, "text")
          && ["codeBlock", "sticky", "tableCell"].includes(node.kind);
      batch.push({
        type: "update",
        node: coreNode,
        ...(command.type === "resizeWithoutConstraints" ? { ignoreConstraints: true as const } : {}),
        ...(plainTextOnly ? { plainTextOnly: true as const } : {}),
        ...(plainTextOnly && node.kind === "textPath" && Object.hasOwn(command.patch, "name") ? { renameTextPath: true as const } : {}),
      });
      if (isComponentSubtreeNode(nextNodes, node.id)) syncComponentChangeToInstances(nextNodes, node.id, command.patch, batch);
      continue;
    }
    if (command.type === "moveVectorPoint") {
      if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) return undefined;
      const index = nextNodes.findIndex((node) => node.id === command.id);
      const node = nextNodes[index];
      if (index === -1 || node.kind !== "vector" || !node.vectorPath) return undefined;
      const path = structuredClone(node.vectorPath);
      const point = path.subpaths.flatMap((subpath) => subpath.points).find((candidate) => candidate.id === command.pointId);
      if (!point) return undefined;
      point.x = command.x;
      point.y = command.y;
      if (path.subpaths.some((subpath) => subpath.points.some((candidate, pointIndex) => pointIndex > 0 && candidate.x === subpath.points[pointIndex - 1].x && candidate.y === subpath.points[pointIndex - 1].y) || (subpath.closed && subpath.points.length > 1 && subpath.points[0].x === subpath.points[subpath.points.length - 1].x && subpath.points[0].y === subpath.points[subpath.points.length - 1].y))) return undefined;
      nextNodes[index] = { ...node, vectorPath: path };
      batch.push({ type: "moveVectorPoint", id: command.id, pointId: command.pointId, x: command.x, y: command.y });
      continue;
    }
    if (command.type === "setVectorSubpathClosed") {
      if (!Number.isInteger(command.subpathIndex) || command.subpathIndex < 0) return undefined;
      const index = nextNodes.findIndex((node) => node.id === command.id);
      const node = nextNodes[index];
      if (index === -1 || node.kind !== "vector" || !node.vectorPath) return undefined;
      const path = structuredClone(node.vectorPath);
      const subpath = path.subpaths[command.subpathIndex];
      if (!subpath || (command.closed && subpath.points.length < 3)) return undefined;
      subpath.closed = command.closed;
      nextNodes[index] = { ...node, vectorPath: path };
      batch.push({ type: "setVectorSubpathClosed", id: command.id, subpathIndex: command.subpathIndex, closed: command.closed });
      continue;
    }
    if (command.type === "insertVectorPoint") {
      if (!Number.isInteger(command.subpathIndex) || command.subpathIndex < 0 || ![command.point.x, command.point.y, command.point.handleIn?.x, command.point.handleIn?.y, command.point.handleOut?.x, command.point.handleOut?.y].every((value) => value === undefined || Number.isFinite(value))) return undefined;
      const index = nextNodes.findIndex((node) => node.id === command.id);
      const node = nextNodes[index];
      if (index === -1 || node.kind !== "vector" || !node.vectorPath || node.vectorPath.subpaths.flatMap((subpath) => subpath.points).some((point) => point.id === command.point.id)) return undefined;
      const path = structuredClone(node.vectorPath);
      const subpath = path.subpaths[command.subpathIndex];
      if (!subpath) return undefined;
      const insertionIndex = command.afterPointId === undefined ? 0 : subpath.points.findIndex((point) => point.id === command.afterPointId) + 1;
      if (insertionIndex === 0 && command.afterPointId !== undefined) return undefined;
      subpath.points.splice(insertionIndex, 0, structuredClone(command.point));
      nextNodes[index] = { ...node, vectorPath: path };
      batch.push({ type: "insertVectorPoint", id: command.id, subpathIndex: command.subpathIndex, afterPointId: command.afterPointId, point: structuredClone(command.point) });
      continue;
    }
    if (command.type === "splitVectorSegment") {
      if (!Number.isInteger(command.subpathIndex) || command.subpathIndex < 0 || !Number.isFinite(command.t) || command.t <= 0 || command.t >= 1) return undefined;
      const index = nextNodes.findIndex((node) => node.id === command.id);
      const node = nextNodes[index];
      if (index === -1 || node.kind !== "vector" || !node.vectorPath || node.vectorPath.subpaths.flatMap((subpath) => subpath.points).some((point) => point.id === command.pointId)) return undefined;
      const path = structuredClone(node.vectorPath);
      const subpath = path.subpaths[command.subpathIndex];
      const afterIndex = subpath?.points.findIndex((point) => point.id === command.afterPointId) ?? -1;
      const nextIndex = afterIndex + 1 < (subpath?.points.length ?? 0) ? afterIndex + 1 : subpath?.closed ? 0 : -1;
      if (!subpath || afterIndex < 0 || nextIndex < 0) return undefined;
      const from = subpath.points[afterIndex];
      const to = subpath.points[nextIndex];
      const controlFrom = from.handleOut ? { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y } : { x: from.x, y: from.y };
      const controlTo = to.handleIn ? { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y } : { x: to.x, y: to.y };
      const lerp = (left: { x: number; y: number }, right: { x: number; y: number }) => ({ x: left.x + (right.x - left.x) * command.t, y: left.y + (right.y - left.y) * command.t });
      const first = lerp(from, controlFrom); const second = lerp(controlFrom, controlTo); const third = lerp(controlTo, to);
      const fourth = lerp(first, second); const fifth = lerp(second, third); const position = lerp(fourth, fifth);
      const curved = Boolean(from.handleOut || to.handleIn);
      subpath.points[afterIndex].handleOut = curved ? { x: first.x - from.x, y: first.y - from.y } : undefined;
      subpath.points[nextIndex].handleIn = curved ? { x: third.x - to.x, y: third.y - to.y } : undefined;
      subpath.points.splice(afterIndex + 1, 0, { id: command.pointId, x: position.x, y: position.y, handleIn: curved ? { x: fourth.x - position.x, y: fourth.y - position.y } : undefined, handleOut: curved ? { x: fifth.x - position.x, y: fifth.y - position.y } : undefined, pointType: curved ? "asymmetric" : "corner" });
      nextNodes[index] = { ...node, vectorPath: path };
      batch.push({ ...command });
      continue;
    }
    if (command.type === "connectVectorEndpoints") {
      if (![command.firstSubpathIndex, command.secondSubpathIndex].every((index) => Number.isInteger(index) && index >= 0)) return undefined;
      const index = nextNodes.findIndex((node) => node.id === command.id);
      const node = nextNodes[index];
      if (index === -1 || node.kind !== "vector" || !node.vectorPath) return undefined;
      const path = structuredClone(node.vectorPath);
      const first = path.subpaths[command.firstSubpathIndex];
      const second = path.subpaths[command.secondSubpathIndex];
      const endpoint = (subpath: typeof first, pointId: string) => {
        if (!subpath || subpath.closed || !subpath.points.length) return undefined;
        if (subpath.points[0].id === pointId) return "start" as const;
        if (subpath.points.at(-1)?.id === pointId) return "end" as const;
        return undefined;
      };
      const firstEndpoint = endpoint(first, command.firstPointId);
      const secondEndpoint = endpoint(second, command.secondPointId);
      if (!first || !second || !firstEndpoint || !secondEndpoint) return undefined;
      if (command.firstSubpathIndex === command.secondSubpathIndex) {
        if (command.firstPointId === command.secondPointId || firstEndpoint === secondEndpoint || first.points.length < 3) return undefined;
        first.closed = true;
      } else {
        const reverse = (subpath: typeof first) => {
          subpath.points.reverse();
          subpath.points.forEach((point) => {
            const handleIn = point.handleIn;
            point.handleIn = point.handleOut;
            point.handleOut = handleIn;
          });
        };
        const merged = structuredClone(first);
        const other = structuredClone(second);
        if (firstEndpoint === "start") reverse(merged);
        if (secondEndpoint === "end") reverse(other);
        if (merged.points.at(-1) && other.points[0] && merged.points.at(-1)!.x === other.points[0].x && merged.points.at(-1)!.y === other.points[0].y) {
          const joined = other.points.shift()!;
          const last = merged.points.at(-1)!;
          last.handleOut = joined.handleOut;
          last.pointType = last.handleIn || last.handleOut ? "asymmetric" : "corner";
        }
        merged.points.push(...other.points);
        const insertionIndex = Math.min(command.firstSubpathIndex, command.secondSubpathIndex);
        path.subpaths.splice(Math.max(command.firstSubpathIndex, command.secondSubpathIndex), 1);
        path.subpaths.splice(insertionIndex, 1, merged);
      }
      nextNodes[index] = { ...node, vectorPath: path };
      batch.push({ ...command });
      continue;
    }
    if (command.type === "setMask") {
      const index = nextNodes.findIndex((node) => node.id === command.id);
      const node = nextNodes[index];
      if (index === -1) return undefined;
      if (command.enabled && ["section", "slice"].includes(node.kind)) return undefined;
      if (command.enabled && ["group", "transformGroup"].includes(node.kind) && !nextNodes.some((candidate) => candidate.parentId === node.id)) return undefined;
      if (command.enabled && node.kind === "booleanOperation") {
        const operands = nextNodes.filter((candidate) => candidate.parentId === node.id);
        if (operands.length < 2 || operands.some((operand) => operand.kind !== "vector" || !operand.vectorPath)) return undefined;
      }
      nextNodes[index] = { ...node, isMask: command.enabled };
      batch.push({ ...command });
      continue;
    }
    if (command.type === "deleteVectorPoint") {
      const index = nextNodes.findIndex((node) => node.id === command.id);
      const node = nextNodes[index];
      if (index === -1 || node.kind !== "vector" || !node.vectorPath) return undefined;
      const path = structuredClone(node.vectorPath);
      const subpath = path.subpaths.find((candidate) => candidate.points.some((point) => point.id === command.pointId));
      if (!subpath || subpath.points.length <= (subpath.closed ? 3 : 1)) return undefined;
      subpath.points.splice(subpath.points.findIndex((point) => point.id === command.pointId), 1);
      nextNodes[index] = { ...node, vectorPath: path };
      batch.push({ type: "deleteVectorPoint", id: command.id, pointId: command.pointId });
      continue;
    }
    if (command.type === "setVectorPointHandles") {
      if (![command.handleIn?.x, command.handleIn?.y, command.handleOut?.x, command.handleOut?.y].every((value) => value === undefined || Number.isFinite(value))) return undefined;
      const index = nextNodes.findIndex((node) => node.id === command.id);
      const node = nextNodes[index];
      if (index === -1 || node.kind !== "vector" || !node.vectorPath) return undefined;
      const path = structuredClone(node.vectorPath);
      const point = path.subpaths.flatMap((subpath) => subpath.points).find((candidate) => candidate.id === command.pointId);
      if (!point) return undefined;
      point.handleIn = command.handleIn && structuredClone(command.handleIn);
      point.handleOut = command.handleOut && structuredClone(command.handleOut);
      point.pointType = command.pointType;
      nextNodes[index] = { ...node, vectorPath: path };
      batch.push({ ...command, handleIn: command.handleIn && structuredClone(command.handleIn), handleOut: command.handleOut && structuredClone(command.handleOut) });
      continue;
    }
    if (command.type === "delete") {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length || command.ids.some((id) => !nextNodes.some((node) => node.id === id))) return undefined;
      const ids = new Set<string>();
      const ordered = (id: string) => {
        if (ids.has(id)) return;
        nextNodes.filter((node) => node.parentId === id).forEach((child) => ordered(child.id));
        ids.add(id);
      };
      command.ids.forEach(ordered);
      const subtreeIds = [...ids];
      // Core automatically dissolves an occupied Group when its final child is
      // deleted. Sending a second explicit delete for it would invalidate the
      // otherwise atomic subtree transaction.
      const coreIds = subtreeIds.filter((id) => {
        const node = nextNodes.find((candidate) => candidate.id === id);
        return node?.kind !== "group" || !nextNodes.some((candidate) => candidate.parentId === id);
      });
      nextNodes.splice(0, nextNodes.length, ...nextNodes.filter((node) => !ids.has(node.id)));
      batch.push({ type: "delete", ids: coreIds });
      continue;
    }
    if (command.type === "reposition") {
      if (!command.positionIds.length || new Set(command.positionIds.map(({ id }) => id)).size !== command.positionIds.length || command.positionIds.some(({ id, positionId }) => !nextNodes.some((node) => node.id === id) || !positionId)) return undefined;
      command.positionIds.forEach(({ id, positionId }) => {
        const index = nextNodes.findIndex((node) => node.id === id);
        nextNodes[index] = { ...nextNodes[index], positionId };
      });
      batch.push({ type: "reposition", positionIds: command.positionIds.map((entry) => ({ ...entry })) });
      continue;
    }
    if (command.type === "reparent") {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length) return undefined;
      const selected = nextNodes.filter((node) => command.ids.includes(node.id));
      if (selected.length !== command.ids.length) return undefined;
      const target = command.parentId ? nextNodes.find((node) => node.id === command.parentId) : undefined;
      if (command.parentId && (!target || !["frame", "component", "group", "booleanOperation", "section", "slot"].includes(target.kind))) return undefined;
      const pageId = selected[0].pageId;
      if (selected.some((node) => node.pageId !== pageId || (target && node.pageId !== target.pageId))) return undefined;
      const selectedIds = new Set(selected.map((node) => node.id));
      const roots = selected.filter((node) => {
        let ancestor = node.parentId;
        while (ancestor) {
          if (selectedIds.has(ancestor)) return false;
          ancestor = nextNodes.find((candidate) => candidate.id === ancestor)?.parentId;
        }
        return true;
      });
      if (!roots.length) return undefined;
      let targetAncestor = command.parentId;
      while (targetAncestor) {
        if (selectedIds.has(targetAncestor)) return undefined;
        targetAncestor = nextNodes.find((node) => node.id === targetAncestor)?.parentId;
      }
      const parentWorld = command.parentId ? worldTransformForNode(nextNodes, command.parentId) : undefined;
      if (command.parentId && !parentWorld) return undefined;
      const targetOwnsAutoLayout = isAutoLayoutFrame(target);
      const siblingNodes = nextNodes.filter((node) => node.pageId === pageId && node.parentId === command.parentId && !selectedIds.has(node.id));
      const reparented: CanvasNode[] = [];
      const autoLayoutMatrixClears: CanvasNode[] = [];
      for (const node of sortNodesByLayerOrder(roots)) {
        const world = worldTransformForNode(nextNodes, node.id);
        const local = world && nodePropsForWorldTransform(world, parentWorld, node.width, node.height);
        if (!local) return undefined;
        const positionId = orderNewLayerAtFront([...siblingNodes, ...reparented], node.id);
        if (!positionId) return undefined;
        const index = nextNodes.findIndex((candidate) => candidate.id === node.id);
        // A layout Frame chooses its flow children’s position on the Core side.
        // Do not carry the world-preserving Relative-v1 matrix into that scope:
        // it would make the child incompatible with Auto Layout before the
        // reflow transaction gets a chance to place it.
        nextNodes[index] = targetOwnsAutoLayout
          ? { ...nextNodes[index], relativeTransform: undefined, parentId: command.parentId, positionId }
          : { ...nextNodes[index], ...local, parentId: command.parentId, positionId };
        reparented.push(nextNodes[index]);
        if (targetOwnsAutoLayout && node.relativeTransform) autoLayoutMatrixClears.push(nextNodes[index]);
      }
      if (targetOwnsAutoLayout) {
        // A flow child's geometry belongs to the destination layout. Clear a
        // legacy matrix while the child is still under its source parent, then
        // let the reparent operation trigger the destination reflow. Ordinary
        // children need no redundant full-geometry update after that reflow.
        autoLayoutMatrixClears.forEach((node) => batch.push({ type: "update", node: coreProjectionNode(node) }));
        batch.push({ type: "reparent", parentIds: reparented.map((node) => ({ id: node.id, parentId: command.parentId, positionId: node.positionId! })) });
      } else {
        // Outside Auto Layout, reparent first so the world-preserving local
        // matrix is interpreted in the destination container.
        batch.push({ type: "reparent", parentIds: reparented.map((node) => ({ id: node.id, parentId: command.parentId, positionId: node.positionId! })) });
        reparented.forEach((node) => batch.push({ type: "update", node: coreProjectionNode(node) }));
      }
      continue;
    }
    if (command.type === "group" || command.type === "boolean" || command.type === "transformGroup" || command.type === "componentSet") {
      const selected = nextNodes.filter((node) => command.ids.includes(node.id));
      if (!selected.length || new Set(command.ids).size !== command.ids.length || selected.length !== command.ids.length) return undefined;
      const selectedIds = new Set(selected.map((node) => node.id));
      // A selected Group owns its descendants. Do not try to wrap both the
      // Group and one of its children: that would create a cycle rather than a
      // nested Group. Independent selected Groups remain normal roots and can
      // be wrapped together with sibling shapes or other Groups.
      const rootCandidates = selected.filter((node) => !hasSelectedAncestor(nextNodes, node, selectedIds));
      const roots = command.type === "boolean" || command.type === "componentSet"
        ? sortNodesByDocumentOrder(nextNodes, rootCandidates)
        : sortNodesByLayerOrder(rootCandidates);
      if (!roots.length || (command.type === "boolean" && roots.length < 2)) return undefined;
      if (command.type === "componentSet" && roots.some((node) => node.kind !== "component")) return undefined;
      const pageId = selected[0].pageId;
      if (roots.some((node) => node.pageId !== pageId)) return undefined;
      const commonParentId = nearestCommonParentId(nextNodes, roots);
      let parentId = commonParentId;
      if (command.type === "boolean" || command.type === "transformGroup" || command.type === "componentSet") {
        if (command.parentId !== undefined && command.pageId !== undefined) return undefined;
        if (command.parentId !== undefined) {
          const requestedParent = nextNodes.find((node) => node.id === command.parentId);
          if (!requestedParent || requestedParent.pageId !== pageId) return undefined;
          parentId = command.parentId;
        } else if (command.pageId !== undefined) {
          if (pageId !== command.pageId) return undefined;
          parentId = undefined;
        }
        if (command.index !== undefined && (!Number.isSafeInteger(command.index) || command.index < 0)) return undefined;
        const crossParentRoots = roots.filter((node) => node.parentId !== parentId);
        if (crossParentRoots.some((node) => {
          const sourceParent = node.parentId ? nextNodes.find((candidate) => candidate.id === node.parentId) : undefined;
          return sourceParent && (sourceParent.kind === "group" || sourceParent.kind === "booleanOperation" || isAutoLayoutFrame(sourceParent));
        })) return undefined;
        for (const structuralParentId of new Set([...roots.map((node) => node.parentId), parentId])) {
          if (!structuralParentId) continue;
          const structuralParent = nextNodes.find((node) => node.id === structuralParentId);
          if (!structuralParent || (structuralParent.kind !== "group" && structuralParent.kind !== "booleanOperation")) continue;
          const selectedChildCount = roots.filter((node) => node.parentId === structuralParentId).length;
          const currentChildCount = nextNodes.filter((node) => node.parentId === structuralParentId).length;
          const childCountAfter = currentChildCount - selectedChildCount + (structuralParentId === parentId ? 1 : 0);
          if ((structuralParent.kind === "group" && childCountAfter < 1) || (structuralParent.kind === "booleanOperation" && childCountAfter < 2)) return undefined;
        }
      }
      const parent = parentId ? nextNodes.find((node) => node.id === parentId) : undefined;
      if (parentId && (!parent || !["frame", "component", "group", "transformGroup", "booleanOperation", "section", "slot"].includes(parent.kind))) return undefined;
      if ((command.type === "boolean" || command.type === "transformGroup" || command.type === "componentSet") && roots.some((node) => node.parentId !== parentId) && parent && isAutoLayoutFrame(parent)) return undefined;
      const id = (command.type === "transformGroup" || command.type === "boolean" || command.type === "componentSet") && command.id ? command.id : createId();
      if (nextNodes.some((node) => node.id === id)) return undefined;
      const bounds = roots.map((node) => worldBoundsForNode(nextNodes, node));
      if (bounds.some((bound) => !bound)) return undefined;
      const resolvedBounds = bounds as NonNullable<(typeof bounds)[number]>[];
      const left = Math.min(...resolvedBounds.map((bound) => bound.left));
      const top = Math.min(...resolvedBounds.map((bound) => bound.top));
      const right = Math.max(...resolvedBounds.map((bound) => bound.right));
      const bottom = Math.max(...resolvedBounds.map((bound) => bound.bottom));
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      const parentWorld = parentId ? worldTransformForNode(nextNodes, parentId) : undefined;
      if (parentId && !parentWorld) return undefined;
      const groupTransform = nodePropsForWorldTransform({ a: 1, b: 0, c: 0, d: 1, e: left, f: top }, parentWorld, width, height);
      if (!groupTransform) return undefined;
      // The wrapper is created before its selected roots are reparented. Give
      // it its own unique Core fallback key for that short-lived shared-parent
      // state: reusing a selected root's front key here makes the all-or-
      // nothing batch fail before the root has vacated that sibling slot.
      const remainingSiblings = nextNodes.filter((node) => node.pageId === pageId && node.parentId === parentId && !selectedIds.has(node.id));
      const requestedIndex = command.type === "boolean" || command.type === "transformGroup" || command.type === "componentSet" ? command.index : undefined;
      if (requestedIndex !== undefined && requestedIndex > remainingSiblings.length) return undefined;
      const groupPositionId = requestedIndex === undefined
        ? `${id.replaceAll("-", "").toLowerCase()}:00000000000000000000000000000000`
        : positionIdForLayerInsertion(
            sortNodesByLayerOrder(remainingSiblings).map((node) => ({ positionId: node.positionId })),
            requestedIndex,
          );
      if (!groupPositionId) return undefined;
      // The requested final slot can equal a selected root's current slot
      // because that root has deliberately been removed from the insertion
      // plan. Core validates the Create before the following Reparent, so use
      // a wrapper-owned temporary slot for that short interval and reposition
      // the wrapper after the selected roots have vacated the parent.
      const groupCreationPositionId = nextNodes.some((node) =>
        node.parentId === parentId && node.positionId === groupPositionId)
        ? `${id.replaceAll("-", "").toLowerCase()}:00000000000000000000000000000000`
        : groupPositionId;
      const wrapperKind = command.type === "boolean" ? "booleanOperation" : command.type === "transformGroup" ? "transformGroup" : command.type === "componentSet" ? "componentSet" : command.autoLayout ? "frame" : "group";
      const booleanPatch = command.type === "boolean" ? command.patch ?? {} : {};
      if (command.type === "boolean" && Object.keys(booleanPatch).some((key) => !["name", "opacity", "visible", "booleanOperation", "blendMode", "locked", "contentsHidden"].includes(key))) return undefined;
      const transformGroupPatch = command.type === "transformGroup" ? command.patch ?? {} : {};
      if (command.type === "transformGroup" && Object.keys(transformGroupPatch).some((key) => !["name", "opacity", "visible", "blendMode", "locked", "contentsHidden"].includes(key))) return undefined;
      const componentSetPatch = command.type === "componentSet" ? command.patch ?? {} : {};
      if (command.type === "componentSet" && Object.keys(componentSetPatch).some((key) => !["name", "opacity", "visible", "blendMode", "locked", "contentsHidden"].includes(key))) return undefined;
      const group = {
        ...createNode(wrapperKind, left, top),
        ...groupTransform,
        id,
        pageId,
        parentId,
        width,
        height,
        positionId: groupPositionId,
        ...(command.type === "boolean" ? { booleanOperation: command.operation } : {}),
        ...booleanPatch,
        ...transformGroupPatch,
        ...componentSetPatch,
        ...(command.type === "transformGroup" ? { transformModifiers: structuredClone(command.modifiers) } : {}),
        ...(command.type === "componentSet" ? { componentSetMetadata: structuredClone(command.metadata) } : {}),
        ...(command.type === "group" && command.autoLayout ? { autoLayout: structuredClone(command.autoLayout) } : {}),
        // Core deliberately keeps Auto Layout Frames on legacy local geometry:
        // Relative-v1 matrices are not a supported layout-container transform.
        // `groupTransform` already resolved equivalent x/y/rotation values in
        // the common parent's coordinate space, so clear only the matrix.
        ...(command.type === "group" && command.autoLayout ? { relativeTransform: undefined } : {}),
      };
      nextNodes.push(group);
      const groupWorld = worldTransformForNode(nextNodes, group.id);
      if (!groupWorld) return undefined;
      const reparented: CanvasNode[] = [];
      roots.forEach((node) => {
        const childWorld = worldTransformForNode(nextNodes, node.id);
        const local = childWorld && nodePropsForWorldTransform(childWorld, groupWorld, node.width, node.height);
        if (!local) return;
        const positionId = node.positionId && !reparented.some((candidate) => candidate.positionId === node.positionId)
          ? node.positionId
          : orderNewLayerAtFront(reparented, node.id);
        if (!positionId) return;
        const index = nextNodes.findIndex((candidate) => candidate.id === node.id);
        // The newly created Auto Layout Frame determines flow-child placement
        // during Core reflow. A legacy matrix would freeze the child at its
        // former canvas position until the next edit.
        nextNodes[index] = { ...nextNodes[index], ...local, ...(command.type === "group" && command.autoLayout ? { relativeTransform: undefined } : {}), parentId: id, positionId };
        reparented.push(nextNodes[index]);
      });
      if (reparented.length !== roots.length) return undefined;
      // A Core Reparent validates its target container immediately. Creating
      // this Frame with Auto Layout already active would therefore reject the
      // selected roots before their legacy Relative-v1 matrices have been
      // cleared below. Create the ordinary Frame first, move and normalize the
      // children atomically, then enable Auto Layout as the last command.
      const wrapperAtCreation = command.type === "group" && command.autoLayout
        ? { ...group, autoLayout: undefined, positionId: groupCreationPositionId }
        : { ...group, positionId: groupCreationPositionId };
      batch.push({ type: "create", node: coreProjectionNode(wrapperAtCreation) });
      batch.push({ type: "reparent", parentIds: reparented.map((node) => ({ id: node.id, parentId: id, positionId: node.positionId! })) });
      // The child matrices above are local to the newly created Group. Their
      // geometry must therefore be updated only after that parent link exists.
      reparented.forEach((node) => batch.push({ type: "update", node: coreProjectionNode(node) }));
      if (command.type === "group" && command.autoLayout) {
        batch.push({ type: "update", node: coreProjectionNode(group) });
      }
      if (groupCreationPositionId !== groupPositionId) {
        batch.push({ type: "reposition", positionIds: [{ id, positionId: groupPositionId }] });
      }
      createdIds.push(id);
      selectionIds = [id];
      affectedGroupIds.add(id);
      roots.forEach((root) => groupAncestorIds(nextNodes, root.parentId).forEach((ancestorId) => affectedGroupIds.add(ancestorId)));
      groupAncestorIds(nextNodes, parentId).forEach((ancestorId) => affectedGroupIds.add(ancestorId));
      continue;
    }
    if (command.type === "ungroup") {
      const group = nextNodes.find((node) => node.id === command.id);
      if (!group || group.kind !== "group") return undefined;
      const children = nextNodes.filter((node) => node.parentId === group.id);
      if (!children.length) return undefined;
      const parentWorld = group.parentId ? worldTransformForNode(nextNodes, group.parentId) : undefined;
      if (group.parentId && !parentWorld) return undefined;
      const siblings = nextNodes.filter((node) => node.pageId === group.pageId && node.parentId === group.parentId && node.id !== group.id);
      const orderedAtParent = sortNodesByLayerOrder([...siblings, group]);
      const nextSibling = orderedAtParent[orderedAtParent.findIndex((node) => node.id === group.id) + 1];
      // The old child keys only need to be unique in the Group. Allocate a new
      // contiguous sibling block at the Group's former location instead of
      // reusing keys that may collide in its parent.
      const positionPlan = resolveLayerDrop(
        [...siblings, ...children],
        children.map((child) => child.id),
        nextSibling?.id,
      );
      if (!positionPlan) return undefined;
      const reparented: CanvasNode[] = [];
      children.forEach((child) => {
        const childWorld = worldTransformForNode(nextNodes, child.id);
        const local = childWorld && nodePropsForWorldTransform(childWorld, parentWorld, child.width, child.height);
        if (!local) return;
        const positionId = positionPlan.positionIds.get(child.id);
        if (!positionId) return;
        const index = nextNodes.findIndex((node) => node.id === child.id);
        nextNodes[index] = { ...nextNodes[index], ...local, parentId: group.parentId, positionId };
        reparented.push(nextNodes[index]);
      });
      if (reparented.length !== children.length) return undefined;
      nextNodes.splice(nextNodes.findIndex((node) => node.id === group.id), 1);
      batch.push({ type: "reparent", parentIds: reparented.map((node) => ({ id: node.id, parentId: group.parentId, positionId: node.positionId! })) });
      // As with Group, each child transform has already been converted to the
      // former Group's parent coordinate space. Reparent before applying it.
      reparented.forEach((node) => batch.push({ type: "update", node: coreProjectionNode(node) }));
      // The Core dissolves a Group when its final child leaves. Keeping this
      // as only a parent move makes the history entry atomic and replayable.
      selectionIds = reparented.map((node) => node.id);
      groupAncestorIds(nextNodes, group.parentId).forEach((ancestorId) => affectedGroupIds.add(ancestorId));
      continue;
    }
    if (command.type === "duplicate") {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length || command.ids.some((id) => !nextNodes.some((node) => node.id === id))) return undefined;
      // Figma duplicates selected roots, not just their container records. A
      // Group/Frame/Section copy must therefore bring along its complete
      // subtree, remapping every internal parent reference to the new IDs.
      // When both an ancestor and descendant are selected, the ancestor owns
      // the copy and the descendant is never duplicated twice.
      const sourceDocument = structuredClone(nextNodes);
      const requestedIds = new Set(command.ids);
      const selectedRoots = sortNodesByLayerOrder(sourceDocument.filter((node) => requestedIds.has(node.id)).filter((node) => !hasSelectedAncestor(sourceDocument, node, requestedIds)));
      const copiedIds = new Set<string>();
      for (const root of selectedRoots) {
        const subtree = subtreeNodes(sourceDocument, root.id);
        if (!subtree.length) return undefined;
        const idMap = new Map<string, string>();
        for (const source of subtree) {
          const id = createId();
          if (copiedIds.has(id) || nextNodes.some((node) => node.id === id)) return undefined;
          copiedIds.add(id);
          idMap.set(source.id, id);
        }
        for (const source of subtree) {
          const id = idMap.get(source.id);
          if (!id) return undefined;
          const isRoot = source.id === root.id;
          const parentId = source.parentId && idMap.get(source.parentId) ? idMap.get(source.parentId) : source.parentId;
          let copy: CanvasNode = { ...source, id, parentId };
          if (isRoot) {
            const siblings = nextNodes.filter((node) => node.pageId === source.pageId && node.parentId === source.parentId);
            const positionId = orderNewLayerAtFront(siblings, id);
            if (!positionId) return undefined;
            copy = { ...copy, name: `${source.name} copy`, positionId, ...duplicateRootOffset(sourceDocument, source, source.parentId) };
          } else if (!source.relativeTransform) {
            // Legacy descendants retain world-space geometry. Relative-v1
            // descendants inherit the translated copied ancestor instead.
            copy = { ...copy, x: source.x + 24, y: source.y + 24 };
          }
          // A flow child is positioned by its destination Auto Layout Frame.
          // Keeping a legacy Relative-v1 matrix turns an otherwise valid
          // Command-D copy into an unsupported layout transaction; absolute
          // children intentionally retain their independent geometry.
          const destinationParent = parentId ? nextNodes.find((node) => node.id === parentId) : undefined;
          if (isAutoLayoutFrame(destinationParent) && !source.autoLayout?.absolute) {
            copy = { ...copy, relativeTransform: undefined };
          }
          nextNodes.push(copy);
          batch.push({ type: "create", node: coreProjectionNode(copy) });
          if (isRoot) createdIds.push(copy.id);
        }
      }
      continue;
    }
    return undefined;
  }
  if (!batch.length) return undefined;
  // Relative-v1 structural containers deliberately skip Core's legacy AABB
  // rebasing. Resolve their affected subtree at this shared boundary, then
  // replace (rather than append after) any preliminary node updates with the
  // complete parent-before-child projection in the same Core transaction.
  // This keeps a child Inspector edit, its derived Group bounds and history
  // replay inseparable rather than relying on an individual canvas gesture to
  // remember a follow-up Group update.
  if (affectedGroupIds.size) {
    const excludedGroupIds = new Set(nextNodes
      .filter((node) => (node.kind === "group" || node.kind === "booleanOperation") && !affectedGroupIds.has(node.id))
      .map((node) => node.id));
    const normalized = normalizeGroupBounds(nextNodes, { excludeGroupIds: excludedGroupIds });
    if (!normalized) return undefined;
    const beforeById = new Map(nextNodes.map((node) => [node.id, node]));
    const changed = normalized.filter((node) => {
      const before = beforeById.get(node.id);
      return before && hasGroupNormalizationChange(before, node);
    }).sort((left, right) => nodeDepth(normalized, left.id) - nodeDepth(normalized, right.id));
    if (changed.length) {
      nextNodes.splice(0, nextNodes.length, ...normalized);
      const changedIds = new Set(changed.map((node) => node.id));
      // A child geometry edit starts as an Update and may then move while its
      // Group is re-based. Sending both forms of that child in one batch is
      // redundant and, in browser WASM, can re-enter the exported mutable
      // reducer. Keep only the final normalized record for each changed node.
      const firstChangedUpdate = batch.findIndex((entry) => entry.type === "update" && changedIds.has(entry.node.id));
      const retained = batch.filter((entry) => entry.type !== "update" || !changedIds.has(entry.node.id));
      const insertionIndex = firstChangedUpdate < 0
        ? retained.length
        : batch.slice(0, firstChangedUpdate).filter((entry) => entry.type !== "update" || !changedIds.has(entry.node.id)).length;
      retained.splice(insertionIndex, 0, ...changed.map((node) => ({ type: "update" as const, node: coreProjectionNode(node) })));
      batch.splice(0, batch.length, ...retained);
    }
  }
  // Core validates a mask against an already-existing following sibling. A
  // fixture/import batch can create that target later in the same transaction,
  // so defer every created node's final mask state until structural creation,
  // deletion and repositioning have all resolved. This is still one atomic
  // Core batch and works equally for local WASM hydration and Protobuf replay.
  if (!appendCreatedMaskCommands(batch, nextNodes)) return undefined;
  return { batch, nextNodes, createdIds, selectionIds, affectedGroupIds: [...affectedGroupIds] };
}

/** Normalizes mask state for nodes created in this batch. `CreateNode` does
 * not persist `isMask`; Core owns that through SetMask and rejects a source
 * without a final following sibling. */
function appendCreatedMaskCommands(batch: CoreBatchCommand[], nodes: readonly CanvasNode[]) {
  const createdIds = new Set(batch.flatMap((entry) => entry.type === "create" ? [entry.node.id] : []));
  if (!createdIds.size) return true;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const createdMaskIds = new Set([...createdIds].filter((id) => nodeById.get(id)?.isMask));
  // Most interactive create batches contain no masks. Avoid parsing/sorting
  // unrelated fixture positions and avoid an O(n log n) pass on that hot path.
  if (!createdMaskIds.size) return true;
  // A caller may have explicitly toggled a node it also created. Its final
  // Canvas projection is the source of truth, so replace any early toggle with
  // one post-structure command rather than replaying an invalid intermediate.
  for (let index = batch.length - 1; index >= 0; index -= 1) {
    const entry = batch[index];
    if (entry?.type === "setMask" && createdMaskIds.has(entry.id)) batch.splice(index, 1);
  }
  const maskContainerKeys = new Set([...createdMaskIds].flatMap((id) => {
    const node = nodeById.get(id);
    return node ? [`${node.pageId ?? ""}\0${node.parentId ?? ""}`] : [];
  }));
  const siblingsByContainer = new Map<string, CanvasNode[]>();
  for (const node of nodes) {
    const key = `${node.pageId ?? ""}\0${node.parentId ?? ""}`;
    if (!maskContainerKeys.has(key)) continue;
    const siblings = siblingsByContainer.get(key) ?? [];
    siblings.push(node);
    siblingsByContainer.set(key, siblings);
  }
  const hasFollowingSibling = new Set<string>();
  for (const siblings of siblingsByContainer.values()) {
    const ordered = sortNodesByLayerOrder(siblings);
    ordered.slice(0, -1).forEach((node) => hasFollowingSibling.add(node.id));
  }
  for (const id of createdMaskIds) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (!hasFollowingSibling.has(id)) return false;
    batch.push({ type: "setMask", id, enabled: true });
  }
  return true;
}

function hasGroupNormalizationChange(before: CanvasNode, after: CanvasNode) {
  return before.x !== after.x
    || before.y !== after.y
    || before.width !== after.width
    || before.height !== after.height
    || before.rotation !== after.rotation
    || JSON.stringify(before.relativeTransform) !== JSON.stringify(after.relativeTransform);
}

/** Appearance-only edits (including effects) do not alter a Group's geometric
 * bounds. Keeping them out of the normalization batch avoids rewriting every
 * descendant for an Inspector change that leaves its transforms untouched. */
function updateAffectsGroupBounds(patch: Extract<EditorCommand, { type: "update" }>["patch"]) {
  return ["x", "y", "width", "height", "rotation", "relativeTransform", "vectorPath", "strokeWidth", "strokeWeights", "strokeAlign", "strokeCapStart", "strokeCapEnd", "strokeJoin", "strokeMiterLimit", "strokeDashPattern", "arcData", "cornerRadii", "radius"].some((key) => key in patch);
}

function nodeDepth(nodes: readonly CanvasNode[], id: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>([id]);
  let depth = 0;
  let parentId = byId.get(id)?.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentId;
  }
  return depth;
}

function hasSelectedAncestor(nodes: readonly CanvasNode[], node: CanvasNode, selectedIds: ReadonlySet<string>) {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    if (selectedIds.has(parentId)) return true;
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

function hasAncestor(nodes: readonly CanvasNode[], nodeId: string, ancestorId: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let current = byId.get(nodeId);
  while (current?.parentId && !visited.has(current.parentId)) {
    if (current.parentId === ancestorId) return true;
    visited.add(current.parentId);
    current = byId.get(current.parentId);
  }
  return false;
}

function groupAncestorIds(nodes: readonly CanvasNode[], parentId: string | undefined) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: string[] = [];
  const visited = new Set<string>();
  let current = parentId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const node = byId.get(current);
    if (!node) break;
    if (node.kind === "group" || node.kind === "booleanOperation") result.push(node.id);
    current = node.parentId;
  }
  return result;
}

/** Returns the closest shared container (or the page root) for a wrap action. */
function nearestCommonParentId(nodes: readonly CanvasNode[], roots: readonly CanvasNode[]): string | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestorChain = (node: CanvasNode) => {
    const chain: Array<string | undefined> = [];
    const visited = new Set<string>();
    let parentId = node.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      chain.push(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    chain.push(undefined);
    return chain;
  };
  const [first, ...rest] = roots.map(ancestorChain);
  return first?.find((candidate) => rest.every((chain) => chain.includes(candidate)));
}

function sortNodesByDocumentOrder(nodes: readonly CanvasNode[], selected: readonly CanvasNode[]): CanvasNode[] {
  const byParent = new Map<string, CanvasNode[]>();
  nodes.forEach((node) => {
    const key = `${node.pageId}:${node.parentId ?? "<page>"}`;
    const siblings = byParent.get(key) ?? [];
    siblings.push(node);
    byParent.set(key, siblings);
  });
  byParent.forEach((siblings, key) => byParent.set(key, sortNodesByLayerOrder(siblings)));
  const rank = new Map<string, number>();
  let nextRank = 0;
  const visit = (pageId: string, parentId: string | undefined, visited: Set<string>): void => {
    const key = `${pageId}:${parentId ?? "<page>"}`;
    if (visited.has(key)) return;
    const nextVisited = new Set(visited).add(key);
    for (const child of byParent.get(key) ?? []) {
      rank.set(child.id, nextRank++);
      visit(pageId, child.id, nextVisited);
    }
  };
  const pageIds = [...new Set(selected.map((node) => node.pageId).filter((pageId): pageId is string => typeof pageId === "string"))];
  pageIds.forEach((pageId) => visit(pageId, undefined, new Set()));
  const inputOrder = new Map(selected.map((node, index) => [node.id, index]));
  return [...selected].sort((left, right) =>
    (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || (inputOrder.get(left.id) ?? 0) - (inputOrder.get(right.id) ?? 0));
}

/** Parent-first order lets a Core create a copied Group before its children. */
function subtreeNodes(nodes: readonly CanvasNode[], rootId: string): CanvasNode[] {
  const byParent = new Map<string, CanvasNode[]>();
  nodes.forEach((node) => {
    if (!node.parentId) return;
    const children = byParent.get(node.parentId) ?? [];
    children.push(node);
    byParent.set(node.parentId, children);
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: CanvasNode[] = [];
  const visit = (id: string, visited = new Set<string>()) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return;
    result.push(node);
    sortNodesByLayerOrder(byParent.get(id) ?? []).forEach((child) => visit(child.id, visited));
  };
  visit(rootId);
  return result;
}

/** Applies Figma-style duplicate displacement without breaking Relative-v1 roots. */
function duplicateRootOffset(nodes: readonly CanvasNode[], source: CanvasNode, targetParentId: string | undefined): Pick<CanvasNode, "x" | "y" | "rotation" | "relativeTransform"> {
  if (!source.relativeTransform) return { x: source.x + 24, y: source.y + 24, rotation: source.rotation, relativeTransform: undefined };
  if (!targetParentId) {
    const projected = worldSpaceProjectionNode(nodes, source);
    if (projected) return { x: projected.x + 24, y: projected.y + 24, rotation: projected.rotation, relativeTransform: undefined };
  }
  const world = worldTransformForNode(nodes, source.id);
  const parentWorld = targetParentId ? worldTransformForNode(nodes, targetParentId) : undefined;
  const translated = world && { ...world, e: world.e + 24, f: world.f + 24 };
  const offset = translated && nodePropsForWorldTransform(translated, parentWorld, source.width, source.height);
  return offset ?? { x: source.x + 24, y: source.y + 24, rotation: source.rotation, relativeTransform: source.relativeTransform };
}

/** Captures the selected hierarchy roots into a self-contained clipboard. The
 * returned payload holds full subtree projections by value and references image
 * bytes only by AssetId, so it is safe to serialize to another tab or document
 * where paste re-validates each AssetId (P0-1). Returns nothing on an invalid or
 * empty selection, matching the all-or-nothing transaction boundary. */
export function captureClipboard(nodes: readonly CanvasNode[], ids: readonly string[], schemaVersion: number): EditorClipboard | undefined {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !nodes.some((node) => node.id === id))) return undefined;
  const requestedIds = new Set(ids);
  // An ancestor owns its selected descendants; capturing both would clone the
  // descendant twice, exactly as duplicate collapses overlapping selections.
  const roots = sortNodesByLayerOrder(nodes.filter((node) => requestedIds.has(node.id)).filter((node) => !hasSelectedAncestor(nodes, node, requestedIds)));
  if (!roots.length) return undefined;
  const captured: CanvasNode[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const node of subtreeNodes(nodes, root.id)) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      captured.push(structuredClone(node));
    }
  }
  // Image and font resources are document-authorized independently. Carry both
  // IDs so cross-document paste cannot retain a text FontId that the target
  // document has not explicitly attached.
  const assetIds = referencedAssetIds(captured);
  return { schemaVersion, rootIds: roots.map((root) => root.id), nodes: captured, assetIds };
}

function referencedAssetIds(nodes: readonly CanvasNode[]) {
  return [...new Set(nodes.flatMap((node) => [
    ...(node.kind === "image" && node.assetId ? [node.assetId] : []),
    ...(node.fillStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []),
    ...(node.strokeStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []),
    ...(node.textProperties?.runs.flatMap((run) => run.font ? [run.font.assetId] : []) ?? []),
    ...(node.textProperties?.baseStyle?.font ? [node.textProperties.baseStyle.font.assetId] : []),
    ...(node.textProperties?.runs.flatMap((run) => run.fillStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []) ?? []),
    ...(node.textProperties?.baseStyle?.fillStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []),
    ...(node.textProperties?.fallbackFonts?.map((font) => font.assetId) ?? []),
  ]))];
}

/** Resolves a clipboard into concrete Core create commands under a target
 * container (or the page root when absent). Every captured node is remapped to a
 * fresh ID; image nodes whose AssetId is not present in `availableAssetIds` are
 * rejected so a cross-document paste can never smuggle an unauthorized asset
 * reference (P0-1). The result mirrors duplicate: only the pasted roots are
 * reported in `createdIds`, offset for visibility. */
export function resolvePasteBatch(
  nodes: CanvasNode[],
  clipboard: EditorClipboard,
  target: { pageId?: string; parentId?: string },
  availableAssetIds: ReadonlySet<string>,
  createId: () => string = generateId,
  expectedSchemaVersion?: number,
  availableAssetContentHashes?: ReadonlyMap<string, string>,
): ResolvedCoreBatch | undefined {
  if (validateClipboardCapture(clipboard, expectedSchemaVersion)) return undefined;
  if (!isValidPasteTarget(nodes, target)) return undefined;
  // A paste into a document missing a referenced image asset must fail wholesale
  // rather than instantiate a dangling reference.
  if (clipboard.assetIds.some((assetId) => !availableAssetIds.has(assetId))) return undefined;
  if (clipboard.assetContentHashes && (!availableAssetContentHashes || clipboard.assetIds.some((assetId) => availableAssetContentHashes.get(assetId) !== clipboard.assetContentHashes?.[assetId]))) return undefined;
  const source = structuredClone(clipboard.nodes);
  const sourceById = new Map(source.map((node) => [node.id, node]));
  const capturedIds = new Set(source.map((node) => node.id));
  const nextNodes = structuredClone(nodes);
  const batch: CoreBatchCommand[] = [];
  const createdIds: string[] = [];
  const idMap = new Map<string, string>();
  for (const node of source) {
    const id = createId();
    if (idMap.has(node.id) || nextNodes.some((candidate) => candidate.id === id) || [...idMap.values()].includes(id)) return undefined;
    idMap.set(node.id, id);
  }
  const rootSet = new Set(clipboard.rootIds);
  for (const original of source) {
    const id = idMap.get(original.id);
    if (!id) return undefined;
    const isRoot = rootSet.has(original.id);
    // A descendant whose parent is inside the capture is remapped; a root re-homes
    // onto the paste target. Nodes are emitted parent-before-child.
    const parentId = isRoot
      ? target.parentId
      : original.parentId && capturedIds.has(original.parentId)
        ? idMap.get(original.parentId)
        : target.parentId;
    let copy: CanvasNode = { ...original, id, parentId, pageId: target.pageId };
    if (isRoot) {
      const siblings = nextNodes.filter((node) => node.pageId === target.pageId && node.parentId === target.parentId);
      const positionId = orderNewLayerAtFront(siblings, id);
      if (!positionId) return undefined;
      copy = { ...copy, positionId, ...duplicateRootOffset(source, sourceById.get(original.id)!, target.parentId) };
    } else if (!original.relativeTransform) {
      copy = { ...copy, x: original.x + 24, y: original.y + 24 };
    }
    // Core owns the geometry of a flow child under an Auto Layout Frame. A
    // copied Relative-v1 matrix would make that otherwise valid child
    // unsupported during the transaction's layout reflow. Keep matrices for
    // absolute children, whose geometry is intentionally outside the flow.
    const sourceParent = original.parentId ? sourceById.get(original.parentId) : undefined;
    const destinationParent = parentId ? nextNodes.find((node) => node.id === parentId) : undefined;
    if ((isAutoLayoutFrame(sourceParent) || isAutoLayoutFrame(destinationParent)) && !original.autoLayout?.absolute) {
      copy = { ...copy, relativeTransform: undefined };
    }
    nextNodes.push(copy);
    batch.push({ type: "create", node: coreProjectionNode(copy) });
    if (isRoot) createdIds.push(copy.id);
  }
  if (!batch.length || !appendCreatedMaskCommands(batch, nextNodes)) return undefined;
  return { batch, nextNodes, createdIds, selectionIds: createdIds, affectedGroupIds: [] };
}

/** Legacy projections could encode both an Auto Layout frame and its flow
 * children with Relative-v1 matrices. Core deliberately rejects that state
 * because the layout reducer owns their geometry. Normalize it at the browser
 * bridge boundary while retaining matrices for ordinary and absolute children. */
export function normalizeAutoLayoutProjection(nodes: readonly CanvasNode[]): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const ownsLayout = isAutoLayoutFrame(node);
    const isFlowChild = isAutoLayoutFrame(parent) && !node.autoLayout?.absolute;
    if (!ownsLayout && !isFlowChild) return node;
    // Core owns active layout frames and their flow-child positions in legacy
    // world space. Materialize the Relative-v1 matrix before removing it:
    // clearing the matrix alone leaves local x/y interpreted as page x/y and
    // visibly offsets nested layouts after hydration or export.
    return worldSpaceProjectionNode(nodes, node) ?? { ...node, relativeTransform: undefined };
  });
}

/**
 * Turns the narrowly-scoped legacy Auto Layout migration into ordinary update
 * patches so callers can commit it atomically with the edit that exposed the
 * invalid representation.  In particular, a flow-child alignment change must
 * clear the parent/frame matrices in the *same* Core transaction: Core only
 * runs its layout reducer after the whole batch has been applied.
 */
export function autoLayoutProjectionNormalizationPatches(nodes: readonly CanvasNode[]): Array<{ id: string; patch: Partial<CanvasNode> }> {
  const normalized = normalizeAutoLayoutProjection(nodes);
  return normalized.flatMap((node, index) => {
    const previous = nodes[index];
    const patch: Partial<CanvasNode> = {};
    if (node.x !== previous.x) patch.x = node.x;
    if (node.y !== previous.y) patch.y = node.y;
    if (node.width !== previous.width) patch.width = node.width;
    if (node.height !== previous.height) patch.height = node.height;
    if (node.rotation !== previous.rotation) patch.rotation = node.rotation;
    if (node.relativeTransform !== previous.relativeTransform) patch.relativeTransform = node.relativeTransform;
    return Object.keys(patch).length ? [{ id: node.id, patch }] : [];
  });
}

/** Pasting may only re-home roots beneath a real container from the current
 * document. This prevents an untrusted clipboard envelope from creating a
 * dangling parent relation even before the Core validates the create batch. */
function isValidPasteTarget(nodes: readonly CanvasNode[], target: { pageId?: string; parentId?: string }) {
  if (!target.parentId) return true;
  const parent = nodes.find((node) => node.id === target.parentId);
  if (!parent || !["frame", "component", "group", "section", "slot"].includes(parent.kind)) return false;
  return !target.pageId || (parent.pageId ?? undefined) === target.pageId;
}

function isFrameLike(node: CanvasNode | undefined) {
  return Boolean(node && clipsChildren(node.kind));
}

function isAutoLayoutFrame(node: CanvasNode | undefined) {
  return Boolean(node && isFrameLike(node) && node.autoLayout?.mode !== undefined && node.autoLayout.mode !== "none");
}

/** Component edits propagate to the matching cloned instance layers in the
 * same Core transaction. Instance-local override fields stay intact. */
function syncComponentChangeToInstances(nodes: CanvasNode[], sourceNodeId: string, patch: Partial<CanvasNode>, batch: CoreBatchCommand[]) {
  const syncableEntries = Object.entries(patch).filter(([key]) => !["componentMetadata", "instanceMetadata", "extensions", "parentId", "pageId", "positionId"].includes(key));
  if (!syncableEntries.length) return;
  const sourcePatch = Object.fromEntries(syncableEntries) as Partial<CanvasNode>;
  nodes.forEach((candidate, index) => {
    if (instanceSourceNodeId(candidate) !== sourceNodeId) return;
    const root = instanceRootForNode(nodes, candidate);
    if (!root?.instanceMetadata) return;
    // Figma's public `InstanceNode.overrides` identifies the overridden node in
    // the instance subtree. Older MakeFigma-created instances stored the source
    // Component node ID, so accept both while imported documents migrate through
    // normal edits and snapshots.
    const overridden = root.instanceMetadata.overrides.find((entry) => entry.id === candidate.id || entry.id === sourceNodeId)?.overriddenFields ?? [];
    const patchWithoutOverrides = Object.fromEntries(Object.entries(sourcePatch).filter(([key]) => !overridden.includes(key))) as Partial<CanvasNode>;
    if (!Object.keys(patchWithoutOverrides).length) return;
    const updated = { ...candidate, ...patchWithoutOverrides };
    nodes[index] = updated;
    batch.push({ type: "update", node: coreProjectionNode(updated) });
  });
}

function isComponentSubtreeNode(nodes: readonly CanvasNode[], id: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let current = byId.get(id);
  while (current && !visited.has(current.id)) {
    if (current.kind === "component") return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function instanceSourceNodeId(node: CanvasNode) {
  const bytes = node.extensions?.["figma.instance.source-node.v1"];
  return bytes ? new TextDecoder().decode(Uint8Array.from(bytes)) : undefined;
}

function instanceRootForNode(nodes: readonly CanvasNode[], node: CanvasNode) {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let current: CanvasNode | undefined = node;
  while (current && !visited.has(current.id)) {
    if (current.kind === "instance") return current;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}
