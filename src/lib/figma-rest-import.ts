import {
  createNode,
  isFigmaRestShapeWithTextType,
  type AutoLayoutAlignment,
  type BlendMode,
  type CanvasNode,
  type CanvasPage,
  type ConstraintType,
  type DocumentAutoLayout,
  type DocumentAsset,
  type DocumentColor,
  type DocumentEffect,
  type DocumentGradientPaint,
  type DocumentImageFilters,
  type DocumentLinearGradient,
  type DocumentPaintLayer,
  type DocumentPaintStack,
  type DocumentPaintStyleResource,
  type DocumentPaint,
  type RelativeTransform,
  type DocumentTextProperties,
  type DocumentTextStyleResource,
  type EditorCommand,
  type NodeKind,
  type StrokeAlign,
  type StrokeCap,
  type StrokeJoin,
} from "./editor-protocol";
import { parseFigmaSvgPaths } from "./figma-svg-path";
import { fromFigmaPluginArcData } from "./figma-plugin-node-projection";
import { textParagraphRanges } from "./text-layout";
import { coreProjectionNode, resolveCoreBatch, type CoreBatchCommand, type ResolvedCoreBatch } from "./transaction-batch";
import { canContainChildren, clipsChildren } from "./node-capabilities";
import { extensionsForNodeBlendMode } from "./node-blend-semantics";
import { invertAffine, transformPoint, worldTransformsForNodes, type AffineMatrix } from "./scene-transform";

/** A deliberately narrow, untrusted-input adapter for Figma's REST file JSON.
 * It produces Canonical *candidates* only: callers create pages and submit the
 * returned nodes through the normal Core transaction boundary.  It never fetches
 * Figma image URLs or writes editor state directly. */
export type FigmaImportIssue = {
  sourceId?: string;
  capability: string;
  outcome: "preserved-extension" | "omitted" | "rejected";
  reason: string;
};

export type FigmaRestImportPlan = {
  pages: CanvasPage[];
  nodes: CanvasNode[];
  textStyles?: DocumentTextStyleResource[];
  paintStyles?: DocumentPaintStyleResource[];
  /** Image references only. An authorized adapter must resolve/download bytes
   * and register an Asset before it binds any request to `nodeId`. */
  assetRequests: FigmaRestAssetRequest[];
  /** Submit pages first, then send `nodeCommands` to `resolveCoreBatch`. */
  pageCommands: Array<Extract<EditorCommand, { type: "create-page" }>>;
  nodeCommands: Array<Extract<EditorCommand, { type: "create" }>>;
  issues: FigmaImportIssue[];
};

/** Stable, byte-free compatibility artifact for an individual Figma REST
 * import. It deliberately contains only Canonical IDs and capability outcomes,
 * so it is safe to persist beside a document or offer as a download. */
export type FigmaRestImportReport = {
  format: "makefigma-figma-rest-import-report-v1";
  summary: {
    pageCount: number;
    nodeCount: number;
    assetRequestCount: number;
    rejectedCount: number;
    omittedCount: number;
    preservedExtensionCount: number;
  };
  issues: FigmaImportIssue[];
};

export type FigmaRestAssetRequest = {
  sourceId: string;
  nodeId: string;
  imageRef: string;
  usage: "fill" | "stroke" | "node";
  /** Zero-based index in the source fill/stroke array. Node-level IMAGE
   * requests omit it. This disambiguates repeated imageRefs and preserves the
   * original Paint Stack order across the authorization boundary. */
  paintIndex?: number;
};

/** An Asset Service result, after the caller has resolved Figma's short-lived
 * URL, downloaded within its budget and attached the admitted object to this
 * document. This intentionally has no URL, token or raw bytes. */
export type FigmaRestAuthorizedAsset = {
  request: FigmaRestAssetRequest;
  asset: DocumentAsset;
};

export type ResolvedFigmaRestAssetBinding = {
  batch: CoreBatchCommand[];
  nextNodes: CanvasNode[];
  boundNodeIds: string[];
  issues: FigmaImportIssue[];
};

export type ResolvedFigmaRestAssetCancellation = {
  batch: CoreBatchCommand[];
  nextNodes: CanvasNode[];
  cancelledNodeIds: string[];
  issues: FigmaImportIssue[];
};

const FIGMA_SOURCE_ID_EXTENSION = "figma.rest.source-id.v1";
const FIGMA_PAINT_SOURCE_EXTENSION = "figma.rest.unsupported-paint.v1";
const FIGMA_IMAGE_NODE_EXTENSION = "figma.rest.image-node.v1";
const FIGMA_AUTHORIZED_IMAGE_PAINTS_EXTENSION = "figma.rest.authorized-image-paints.v1";
const FIGMA_IMAGE_BINDING_CANCELLED_EXTENSION = "figma.rest.image-binding-cancelled.v1";

type AuthorizedImagePaintBinding = {
  usage: "fill" | "stroke";
  paintIndex: number;
  imageRef: string;
  assetId: string;
};

/**
 * Produces one all-or-nothing Core batch. Page records deliberately precede
 * scene nodes because every `CreateInPage` is validated against the evolving
 * transaction state. The caller can use the returned batch with the normal
 * WASM and remote-operation paths; no Figma network access happens here.
 */
export function resolveFigmaRestImportBatch(plan: FigmaRestImportPlan): ResolvedCoreBatch | undefined {
  if (plan.issues.some((issue) => issue.outcome === "rejected")) return undefined;
  const pageIds = new Set(plan.pages.map((page) => page.id));
  if (!plan.pages.length || pageIds.size !== plan.pages.length || plan.nodes.some((node) => !node.pageId || !pageIds.has(node.pageId))) return undefined;
  const nodes = resolveCoreBatch([], plan.nodeCommands);
  if (!nodes) return undefined;
  return {
    ...nodes,
    batch: [
      ...plan.pages.map((page) => ({ type: "createPage" as const, page: structuredClone(page) })),
      ...(plan.textStyles ?? []).map((style) => ({ type: "registerTextStyle" as const, style: structuredClone(style) })),
      ...(plan.paintStyles ?? []).map((style) => ({ type: "registerPaintStyle" as const, style: structuredClone(style) })),
      ...nodes.batch,
    ],
  };
}

export function figmaRestImportReport(plan: FigmaRestImportPlan): FigmaRestImportReport {
  const issues = structuredClone(plan.issues);
  return {
    format: "makefigma-figma-rest-import-report-v1",
    summary: {
      pageCount: plan.pages.length,
      nodeCount: plan.nodes.length,
      assetRequestCount: plan.assetRequests.length,
      rejectedCount: issues.filter((issue) => issue.outcome === "rejected").length,
      omittedCount: issues.filter((issue) => issue.outcome === "omitted").length,
      preservedExtensionCount: issues.filter((issue) => issue.outcome === "preserved-extension").length,
    },
    issues,
  };
}

/**
 * Turns Asset-Service-admitted Figma image results into a follow-up Core
 * transaction. It is deliberately separate from the structure import because
 * Figma image URLs expire and their bytes require a different authorization
 * boundary. Registering an asset and binding every eligible target remains one
 * all-or-nothing Core transaction, so no committed node can reference an
 * unregistered AssetId.
 */
export function resolveFigmaRestAssetBindings(
  currentNodes: readonly CanvasNode[],
  currentAssets: readonly DocumentAsset[],
  authorized: readonly FigmaRestAuthorizedAsset[],
): ResolvedFigmaRestAssetBinding {
  const issues: FigmaImportIssue[] = [];
  const assetById = new Map(currentAssets.map((asset) => [asset.assetId, asset]));
  const targetById = new Map(currentNodes.map((node) => [node.id, node]));
  const candidates = new Map<string, {
    target: CanvasNode;
    paintBindings: Map<string, AuthorizedImagePaintBinding>;
    nodeAssetId?: string;
    accepted: boolean;
    conflicted: boolean;
    assets: Map<string, DocumentAsset>;
  }>();
  const admitted = new Map<string, DocumentAsset>();
  const registration = new Map<string, DocumentAsset>();

  for (const entry of authorized) {
    const { request, asset } = entry;
    const sourceId = request.sourceId;
    if (!validAsset(asset)) {
      issues.push({ sourceId, capability: "image-asset", outcome: "rejected", reason: "The authorized Asset Service result is not a valid raster Asset record." });
      continue;
    }
    const existing = assetById.get(asset.assetId) ?? admitted.get(asset.assetId);
    if (existing && !sameAsset(existing, asset)) {
      issues.push({ sourceId, capability: "image-asset", outcome: "rejected", reason: "An AssetId already exists with different immutable metadata." });
      continue;
    }
    const target = targetById.get(request.nodeId);
    if (!target) {
      issues.push({ sourceId, capability: "image-asset", outcome: "rejected", reason: "The authorized asset target is not present in the current Canonical document." });
      continue;
    }
    if (extensionText(target.extensions?.[FIGMA_SOURCE_ID_EXTENSION]) !== sourceId) {
      issues.push({ sourceId, capability: "image-asset", outcome: "rejected", reason: "The authorization request does not match the target's preserved Figma source identity." });
      continue;
    }
    let candidate = candidates.get(target.id);
    if (!candidate) {
      const paintBindings = authorizedImagePaintBindings(target);
      if (!paintBindings) {
        issues.push({ sourceId, capability: "image-paint", outcome: "rejected", reason: "The target's persisted image-paint authorization state is malformed." });
        continue;
      }
      candidate = { target, paintBindings, accepted: false, conflicted: false, assets: new Map() };
      candidates.set(target.id, candidate);
    }
    if (request.usage === "node") {
      if (!imageFillTarget(target) || !matchesImageNodeRequest(target, request)) {
        issues.push({ sourceId, capability: "image-node", outcome: "rejected", reason: "The authorization request does not match an eligible preserved Figma IMAGE node." });
        continue;
      }
      if (candidate.nodeAssetId && candidate.nodeAssetId !== asset.assetId) {
        issues.push({ sourceId, capability: "image-node", outcome: "rejected", reason: "Conflicting assets were authorized for the same Figma IMAGE node in one transaction." });
        candidate.conflicted = true;
        continue;
      }
      candidate.nodeAssetId = asset.assetId;
    } else {
      if (!imagePaintStackTarget(target)) {
        issues.push({ sourceId, capability: `image-${request.usage}`, outcome: "preserved-extension", reason: "This Canonical node kind cannot execute an editable image Paint Stack." });
        continue;
      }
      const sourcePaint = sourcePaintForRequest(target, request);
      if (!sourcePaint) {
        issues.push({ sourceId, capability: `image-${request.usage}`, outcome: "rejected", reason: "The authorization request does not identify the matching source image-paint index." });
        continue;
      }
      const binding: AuthorizedImagePaintBinding = {
        usage: request.usage,
        paintIndex: request.paintIndex!,
        imageRef: request.imageRef,
        assetId: asset.assetId,
      };
      const key = imagePaintBindingKey(binding.usage, binding.paintIndex);
      const pending = candidate.paintBindings.get(key);
      if (pending && (pending.imageRef !== binding.imageRef || pending.assetId !== binding.assetId)) {
        issues.push({ sourceId, capability: `image-${request.usage}`, outcome: "rejected", reason: "Conflicting assets were authorized for the same source paint index." });
        candidate.conflicted = true;
        continue;
      }
      candidate.paintBindings.set(key, binding);
    }
    candidate.accepted = true;
    candidate.assets.set(asset.assetId, asset);
    if (!existing) admitted.set(asset.assetId, asset);
  }

  const updates: CanvasNode[] = [];
  for (const candidate of candidates.values()) {
    if (!candidate.accepted || candidate.conflicted) continue;
    for (const asset of candidate.assets.values()) if (!assetById.has(asset.assetId)) registration.set(asset.assetId, asset);
    const { target, paintBindings } = candidate;
    const extensions = { ...(target.extensions ?? {}) };
    if (paintBindings.size) {
      extensions[FIGMA_AUTHORIZED_IMAGE_PAINTS_EXTENSION] = jsonBytes(
        [...paintBindings.values()].sort((left, right) => left.usage.localeCompare(right.usage) || left.paintIndex - right.paintIndex),
      );
    }
    const next: CanvasNode = {
      ...target,
      ...(candidate.nodeAssetId ? { assetId: candidate.nodeAssetId } : {}),
      extensions,
    };
    for (const usage of ["fill", "stroke"] as const) {
      const result = versionedPaintStackFromSource(target, usage, paintBindings);
      if (result.status === "complete") {
        if (usage === "fill") next.fillStack = result.stack;
        else next.strokeStack = result.stack;
      } else if (result.status === "unsupported") {
        issues.push({
          sourceId: extensionText(target.extensions?.[FIGMA_SOURCE_ID_EXTENSION]),
          capability: `image-${usage}`,
          outcome: "preserved-extension",
          reason: result.reason,
        });
      }
    }
    if (next.fillStack?.layers.length === 1) {
      const layer = next.fillStack.layers[0]!;
      if (layer.image && layer.visible && layer.opacity === 1 && layer.blendMode === "normal") next.assetId = layer.image.assetId;
    }
    if (extensions["figma.rest.deferred-lock.v1"] && allSourceImagesAuthorized(next, paintBindings)) next.locked = true;
    updates.push(next);
  }

  const batch: CoreBatchCommand[] = [
    ...[...registration.values()].map((asset) => ({ type: "registerAsset" as const, asset: structuredClone(asset) })),
    ...updates.flatMap((node) => {
      const projected = coreProjectionNode(node);
      return [
        { type: "setExtensions" as const, id: node.id, extensions: projected.extensions ?? {} },
        { type: "update" as const, node: projected },
      ];
    }),
  ];
  return { batch, nextNodes: currentNodes.map((node) => updates.find((update) => update.id === node.id) ?? node), boundNodeIds: updates.map((node) => node.id), issues };
}

/** Ends a two-phase image import without binding the remaining assets. Source
 * image metadata stays preserved, while any deferred source lock is restored
 * through the same atomic Core update path used by a successful binding. */
export function cancelFigmaRestAssetBindings(
  currentNodes: readonly CanvasNode[],
  pending: readonly FigmaRestAssetRequest[],
): ResolvedFigmaRestAssetCancellation {
  const issues: FigmaImportIssue[] = [];
  const nodeById = new Map(currentNodes.map((node) => [node.id, node]));
  const updates = new Map<string, CanvasNode>();
  for (const request of pending) {
    const target = nodeById.get(request.nodeId);
    if (!target || extensionText(target.extensions?.[FIGMA_SOURCE_ID_EXTENSION]) !== request.sourceId) {
      issues.push({ sourceId: request.sourceId, capability: "image-asset-cancellation", outcome: "rejected", reason: "The cancelled request no longer matches an imported Figma layer." });
      continue;
    }
    const deferredLock = Boolean(target.extensions?.["figma.rest.deferred-lock.v1"]);
    const extensions = { ...target.extensions };
    delete extensions["figma.rest.deferred-lock.v1"];
    extensions[FIGMA_IMAGE_BINDING_CANCELLED_EXTENSION] = bytes("true");
    updates.set(target.id, {
      ...target,
      locked: deferredLock ? true : target.locked,
      extensions,
    });
  }
  const batch = [...updates.values()].flatMap((node) => {
    const projected = coreProjectionNode(node);
    return [
      { type: "setExtensions" as const, id: node.id, extensions: projected.extensions ?? {} },
      { type: "update" as const, node: projected },
    ];
  });
  return {
    batch,
    nextNodes: currentNodes.map((node) => updates.get(node.id) ?? node),
    cancelledNodeIds: [...updates.keys()],
    issues,
  };
}

/** Rebuilds the unresolved half of a two-phase REST image import from durable
 * Canonical metadata. This keeps Undo/Redo and a restored local snapshot from
 * stranding an imported image without its authorization controls. */
export function pendingFigmaRestAssetRequests(
  currentNodes: readonly CanvasNode[],
): FigmaRestAssetRequest[] {
  const pending: FigmaRestAssetRequest[] = [];
  for (const node of currentNodes) {
    if (node.extensions?.[FIGMA_IMAGE_BINDING_CANCELLED_EXTENSION]) continue;
    const sourceId = extensionText(node.extensions?.[FIGMA_SOURCE_ID_EXTENSION]);
    if (!sourceId) continue;
    const nodeImage = record(extensionJson(node.extensions?.[FIGMA_IMAGE_NODE_EXTENSION]));
    const nodeImageRef = string(nodeImage?.imageRef);
    if (nodeImage?.type === "IMAGE" && nodeImageRef && !node.assetId) {
      pending.push({ sourceId, nodeId: node.id, imageRef: nodeImageRef, usage: "node" });
    }
    const bindings = authorizedImagePaintBindings(node);
    if (!bindings) continue;
    for (const usage of ["fill", "stroke"] as const) {
      for (const [paintIndex, raw] of (figmaPaintSource(node, usage) ?? []).entries()) {
        const paint = record(raw);
        const imageRef = string(paint?.imageRef);
        if (paint?.type !== "IMAGE" || !imageRef) continue;
        const bound = bindings.get(imagePaintBindingKey(usage, paintIndex));
        if (!bound || bound.imageRef !== imageRef) {
          pending.push({ sourceId, nodeId: node.id, imageRef, usage, paintIndex });
        }
      }
    }
  }
  return pending;
}

export type FigmaRestImportOptions = {
  allocateNodeId: (figmaNodeId: string) => string;
  allocatePageId: (figmaPageId: string) => string;
  maxNodes?: number;
  maxDepth?: number;
  /** Sum of preserved SVG path source bytes, not a network download limit. */
  maxPathBytes?: number;
  /** Strict imports reject unresolved Component/Slot references. Callers must
   * opt into the lossy policy before a preserved reference can be committed. */
  unresolvedComponentPolicy?: "reject" | "preserve";
};

const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_DEPTH = 64;
const MAX_IMPORT_TRANSACTION_COMMANDS = 10_000;
const MAX_IMPORT_TRANSACTION_JSON_BYTES = 4 * 1024 * 1024;
// Mirrors editor-core's MAX_VECTOR_PATH_BYTES so a REST plan cannot create a
// candidate the Canonical reducer will subsequently reject for size alone.
const DEFAULT_MAX_PATH_BYTES = 1_024 * 1_024;
const encoder = new TextEncoder();

const NODE_KINDS: Record<string, NodeKind | undefined> = {
  FRAME: "frame",
  GROUP: "group",
  SECTION: "section",
  RECTANGLE: "rectangle",
  ELLIPSE: "ellipse",
  LINE: "line",
  TEXT: "text",
  SLICE: "slice",
  POLYGON: "polygon",
  STAR: "star",
  BOOLEAN_OPERATION: "booleanOperation",
  IMAGE: "image",
  VECTOR: "vector",
  COMPONENT: "component",
  INSTANCE: "instance",
  SLOT: "slot",
  COMPONENT_SET: "componentSet",
  CONNECTOR: "connector",
  SHAPE_WITH_TEXT: "shapeWithText",
};

type JsonRecord = Record<string, unknown>;

export function planFigmaRestImport(input: unknown, options: FigmaRestImportOptions): FigmaRestImportPlan {
  const issues: FigmaImportIssue[] = [];
  const pages: CanvasPage[] = [];
  const nodes: CanvasNode[] = [];
  const nodeById = new Map<string, CanvasNode>();
  const assetRequests: FigmaRestAssetRequest[] = [];
  const maxNodes = positiveLimit(options.maxNodes, DEFAULT_MAX_NODES);
  const maxDepth = positiveLimit(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxPathBytes = positiveLimit(options.maxPathBytes, DEFAULT_MAX_PATH_BYTES);
  const file = record(input);
  const document = record(file?.document);
  const sourceComponents = record(file?.components);
  const sourceComponentSets = record(file?.componentSets);
  const sourceStyles = record(file?.styles);
  const pageSources = array(document?.children);
  if (!file || !document || !pageSources) {
    return {
      pages,
      nodes,
      textStyles: [],
      paintStyles: [],
      assetRequests,
      pageCommands: [],
      nodeCommands: [],
      issues: [{ capability: "figma-rest-file", outcome: "rejected", reason: "Expected a Figma REST file response with document.children." }],
    };
  }
  if (typeof file.version !== "string") {
    issues.push({ capability: "figma-rest-file-version", outcome: "preserved-extension", reason: "File version is absent; import remains traceable but cannot report a source version." });
  }

  const usedIds = new Set<string>();
  const usedSourceIds = new Set<string>();
  const canonicalIdBySourceId = new Map<string, string>();
  const sourceIdByCanonicalId = new Map<string, string>();
  const sourceNodeByCanonicalId = new Map<string, JsonRecord>();
  const pendingInstanceMainSourceId = new Map<string, string>();
  const pendingSlotSourceId = new Map<string, string>();
  let pathBytes = 0;
  let visitedNodes = 0;
  let nodeBudgetExhausted = false;
  const allocate = (sourceId: string, kind: "node" | "page") => {
    const id = kind === "page" ? options.allocatePageId(sourceId) : options.allocateNodeId(sourceId);
    if (!isStableId(id) || usedIds.has(id)) {
      issues.push({ sourceId, capability: "canonical-id", outcome: "rejected", reason: "The caller supplied an empty or duplicate Canonical ID." });
      return undefined;
    }
    usedIds.add(id);
    return id;
  };

  for (const [pageIndex, pageSource] of pageSources.entries()) {
    const page = record(pageSource);
    const sourceId = string(page?.id);
    if (!page || !sourceId || (page.type !== "CANVAS" && page.type !== "PAGE")) {
      issues.push({ sourceId, capability: "page", outcome: "omitted", reason: "Only Figma CANVAS/PAGE records can become Canonical pages." });
      continue;
    }
    if (usedSourceIds.has(sourceId)) {
      issues.push({ sourceId, capability: "source-id", outcome: "rejected", reason: "Figma source IDs must be unique across Pages and scene nodes." });
      continue;
    }
    usedSourceIds.add(sourceId);
    const pageId = allocate(sourceId, "page");
    if (!pageId) continue;
    const pageRecord: CanvasPage = { id: pageId, name: string(page.name) ?? "Untitled page", positionId: orderedPositionId(pageIndex, pageSources.length) };
    pages.push(pageRecord);
    const children = array(page.children);
    if (!children) {
      issues.push({ sourceId, capability: "page-children", outcome: "rejected", reason: "A page must contain a children array." });
      continue;
    }
    for (const [index, child] of children.entries()) {
      walk(child, undefined, pageId, 1, orderedPositionId(index, children.length));
      if (nodeBudgetExhausted) break;
    }
  }
  const worldTransformByNodeId = worldTransformsForNodes(nodes);
  for (const imported of nodes) {
    if (imported.kind === "instance") {
      const mainSourceId = pendingInstanceMainSourceId.get(imported.id);
      const mainComponentId = mainSourceId ? canonicalIdBySourceId.get(mainSourceId) : undefined;
      const mainComponent = mainComponentId ? nodeById.get(mainComponentId) : undefined;
      if (mainComponentId && mainComponent?.kind === "component") {
        const source = sourceNodeByCanonicalId.get(imported.id);
        imported.instanceMetadata = {
          mainComponentId,
          scaleFactor: instanceScaleFactor(source, sourceIdByCanonicalId.get(imported.id), issues),
          componentProperties: instanceComponentProperties(source, sourceIdByCanonicalId.get(imported.id), issues),
          overrides: instanceOverrides(source, imported.id, canonicalIdBySourceId, nodeById, sourceIdByCanonicalId.get(imported.id), issues, options.unresolvedComponentPolicy === "preserve"),
          isExposedInstance: source?.isExposedInstance === true,
        };
      } else {
        const preserve = options.unresolvedComponentPolicy === "preserve";
        issues.push({
          sourceId: sourceIdByCanonicalId.get(imported.id),
          capability: "instance-main-component",
          outcome: preserve ? "preserved-extension" : "rejected",
          reason: preserve
            ? "The caller explicitly allowed a retained Instance subtree whose main Component is outside this import or unavailable."
            : "The Instance main Component is outside this import or unavailable; retry with the explicit preserve policy to accept this loss.",
        });
      }
    }
    if (imported.kind === "slot") {
      const sourceSlotId = pendingSlotSourceId.get(imported.id);
      if (!sourceSlotId) continue;
      const canonicalSourceSlotId = canonicalIdBySourceId.get(sourceSlotId);
      if (canonicalSourceSlotId && nodeById.get(canonicalSourceSlotId)?.kind === "slot" && imported.slotMetadata) {
        imported.slotMetadata.sourceSlotId = canonicalSourceSlotId;
      } else {
        const preserve = options.unresolvedComponentPolicy === "preserve";
        issues.push({
          sourceId: sourceIdByCanonicalId.get(imported.id),
          capability: "slot-source",
          outcome: preserve ? "preserved-extension" : "rejected",
          reason: preserve
            ? "The caller explicitly allowed a Slot whose source Slot is outside this import or unavailable."
            : "The Slot source is outside this import or unavailable; retry with the explicit preserve policy to accept this loss.",
        });
      }
    }
    if (imported.kind === "connector") {
      const source = sourceNodeByCanonicalId.get(imported.id);
      const sourceId = sourceIdByCanonicalId.get(imported.id);
      const world = worldTransformByNodeId.get(imported.id);
      const inverseWorld = world ? invertAffine(world) : undefined;
      const result = importConnectorMetadata(source, imported, inverseWorld, canonicalIdBySourceId, nodeById, sourceId, issues);
      imported.connectorMetadata = result.metadata;
      if (result.preserveSource) {
        imported.extensions ??= {};
        imported.extensions["figma.rest.connector.v1"] = jsonBytes({
          connectorStart: source?.connectorStart,
          connectorEnd: source?.connectorEnd,
          connectorStartStrokeCap: source?.connectorStartStrokeCap,
          connectorEndStrokeCap: source?.connectorEndStrokeCap,
          connectorLineType: source?.connectorLineType,
          cornerRadius: source?.cornerRadius,
        });
      }
    }
  }
  normalizeImportedAlphaMasks(nodes, issues);
  const textStyles = importedTextStyleResources(sourceStyles, nodes, issues);
  const paintStyles = importedPaintStyleResources(sourceStyles, nodes, sourceNodeByCanonicalId, issues);
  applyImportedPaintStyleLinks(nodes, paintStyles, sourceNodeByCanonicalId, issues);
  const pageCommands = pages.map((page) => ({ type: "create-page" as const, id: page.id, name: page.name, positionId: page.positionId }));
  const nodeCommands = nodes.map((node) => ({ type: "create" as const, node }));
  // The import path contains only Page/Create/SetMask commands. Build its
  // exact Core command shape directly for a bounded O(n) preflight; invoking
  // the general interactive reducer here would duplicate all node cloning.
  const transactionBatch: CoreBatchCommand[] = [
    ...pages.map((page) => ({ type: "createPage" as const, page: structuredClone(page) })),
    ...textStyles.map((style) => ({ type: "registerTextStyle" as const, style: structuredClone(style) })),
    ...paintStyles.map((style) => ({ type: "registerPaintStyle" as const, style: structuredClone(style) })),
    ...nodes.map((node) => ({ type: "create" as const, node: coreProjectionNode(node) })),
    ...nodes.filter((node) => node.isMask).map((node) => ({ type: "setMask" as const, id: node.id, enabled: true })),
  ];
  if (transactionBatch.length > MAX_IMPORT_TRANSACTION_COMMANDS) {
    issues.push({ capability: "transaction-commands", outcome: "rejected", reason: `Import requires ${transactionBatch.length} Core commands, above the ${MAX_IMPORT_TRANSACTION_COMMANDS}-command atomic limit.` });
  } else if (encoder.encode(JSON.stringify(transactionBatch)).byteLength > MAX_IMPORT_TRANSACTION_JSON_BYTES) {
    issues.push({ capability: "transaction-bytes", outcome: "rejected", reason: `Import exceeds the ${MAX_IMPORT_TRANSACTION_JSON_BYTES}-byte preflight payload limit.` });
  }
  return {
    pages,
    nodes,
    textStyles,
    paintStyles,
    assetRequests,
    pageCommands,
    nodeCommands,
    issues,
  };

  function walk(source: unknown, parentId: string | undefined, pageId: string, depth: number, sourcePositionId: string): void {
    if (nodeBudgetExhausted) return;
    if (visitedNodes >= maxNodes) {
      nodeBudgetExhausted = true;
      issues.push({ capability: "node-count", outcome: "rejected", reason: `Import exceeds the ${maxNodes}-node traversal limit.` });
      return;
    }
    visitedNodes += 1;
    const node = record(source);
    const sourceId = string(node?.id);
    if (!node || !sourceId) {
      issues.push({ capability: "node", outcome: "omitted", reason: "A Figma node is missing its string id." });
      return;
    }
    if (usedSourceIds.has(sourceId)) {
      issues.push({ sourceId, capability: "source-id", outcome: "rejected", reason: "Figma source IDs must be unique across Pages and scene nodes." });
      return;
    }
    usedSourceIds.add(sourceId);
    if (depth > maxDepth) {
      issues.push({ sourceId, capability: "tree-depth", outcome: "rejected", reason: `Import depth exceeds the ${maxDepth}-level limit.` });
      return;
    }
    const type = string(node.type);
    let vectorPath: CanvasNode["vectorPath"];
    if (type === "VECTOR") {
      const bytes = svgPathBytes(node);
      pathBytes += bytes;
      if (pathBytes > maxPathBytes) {
        issues.push({ sourceId, capability: "vector-path", outcome: "rejected", reason: `Vector path source exceeds the ${maxPathBytes}-byte document limit.` });
        return;
      }
      const paths = figmaPaths(node.fillGeometry);
      let invalidPointId = false;
      let pointIndex = 0;
      const parsed = parseFigmaSvgPaths(paths ?? [], () => allocate(`point:${sourceId}:${pointIndex++}`, "node") ?? (invalidPointId = true, "00000000-0000-4000-8000-000000000000"));
      if ("reason" in parsed || invalidPointId) {
        const reason = invalidPointId ? "The caller did not provide unique Canonical IDs for Vector points." : "reason" in parsed ? parsed.reason : "Vector path conversion failed.";
        issues.push({ sourceId, capability: "vector-path", outcome: invalidPointId ? "rejected" : "preserved-extension", reason });
        return;
      }
      vectorPath = parsed.path;
    }
    let kind = type ? NODE_KINDS[type] : undefined;
    if (!kind) {
      issues.push({ sourceId, capability: "node-kind", outcome: "omitted", reason: `Figma ${type ?? "unknown"} is outside the Phase 2 editable node subset.` });
      return;
    }
    // Core requires an Image to be created with an already registered AssetId.
    // REST image URLs are intentionally resolved only after external
    // authorization, so use the equivalent fill-capable placeholder and retain
    // the source type until an admitted image can bind to it.
    const imageNodePlaceholder = kind === "image";
    if (imageNodePlaceholder) {
      kind = "rectangle";
    }
    const id = allocate(sourceId, "node");
    if (!id) return;
    canonicalIdBySourceId.set(sourceId, id);
    sourceIdByCanonicalId.set(id, sourceId);
    sourceNodeByCanonicalId.set(id, node);
    const geometry = localGeometry(node, parentId === undefined);
    if (!geometry) {
      issues.push({ sourceId, capability: "geometry", outcome: "rejected", reason: "Node lacks finite local transform/size geometry." });
      return;
    }
    const imported = createNode(kind, geometry.x, geometry.y);
    const extensions: Record<string, number[]> = { "figma.rest.source-id.v1": bytes(sourceId) };
    if (type === "VECTOR" && svgGeometryContainsArc(node.fillGeometry)) {
      extensions["figma.rest.vector-arc-source.v1"] = jsonBytes(node.fillGeometry);
      issues.push({ sourceId, capability: "vector-arc", outcome: "preserved-extension", reason: "Figma SVG arc source was retained while its rendered geometry was deterministically converted to editable cubic handles." });
    }
    if (imageNodePlaceholder) {
      extensions["figma.rest.image-node.v1"] = jsonBytes({ type: "IMAGE", imageRef: string(node.imageRef) });
      issues.push({ sourceId, capability: "image-node", outcome: "preserved-extension", reason: "The Image node was imported as a fill-capable placeholder until an authorized Asset Service result binds its image." });
    }
    if (kind === "instance") {
      const mainSourceId = string(node.componentId);
      if (mainSourceId) {
        pendingInstanceMainSourceId.set(id, mainSourceId);
        extensions["figma.rest.instance-main-source-id.v1"] = bytes(mainSourceId);
      }
      if (node.componentProperties !== undefined || node.overrides !== undefined) {
        extensions["figma.rest.instance-overrides.v1"] = jsonBytes({ componentProperties: node.componentProperties, overrides: node.overrides });
      }
    }
    if (kind === "slot") {
      const sourceSlotId = string(node.sourceSlotId);
      if (sourceSlotId) {
        pendingSlotSourceId.set(id, sourceSlotId);
        extensions["figma.rest.slot-source-id.v1"] = bytes(sourceSlotId);
      }
    }
    const fills = editablePaints(node.fills);
    const strokes = editablePaints(node.strokes);
    const fill = fills[0] ?? transparentPaint();
    const stroke = strokes[0] ?? transparentPaint();
    const hasUnsupportedPaint = hasUneditablePaint(node.fills) || hasUneditablePaint(node.strokes);
    const hasVersionedPaint = [node.fills, node.strokes].some((value) =>
      (array(value) ?? []).some((paint) => {
        const item = record(paint);
        const type = string(item?.type);
        const blendMode = string(item?.blendMode);
        return type === "IMAGE" || type === "GRADIENT_RADIAL" || type === "GRADIENT_ANGULAR" || type === "GRADIENT_DIAMOND"
          || blendMode === "LINEAR_BURN" || blendMode === "LINEAR_DODGE";
      }),
    );
    if (hasUnsupportedPaint || hasVersionedPaint) {
      extensions["figma.rest.unsupported-paint.v1"] = jsonBytes({ fills: node.fills, strokes: node.strokes });
    }
    if (hasUnsupportedPaint) {
      issues.push({ sourceId, capability: "paint", outcome: "preserved-extension", reason: "Hidden paints and paint types outside visible SOLID, geometrically equivalent GRADIENT_LINEAR, and valid RADIAL/ANGULAR/DIAMOND gradients are preserved for import reporting and do not acquire editor creation defaults." });
    }
    const effectResult = effects(node.effects, sourceId, issues);
    Object.assign(extensions, effectResult.extensions);
    const mask = maskState(node, sourceId, issues);
    Object.assign(extensions, mask.extensions);
    exportSettings(node.exportSettings, sourceId, issues, extensions);
    const autoLayout = layout(node, kind, sourceId, issues, extensions);
    const constraints = constraintState(node.constraints, sourceId, issues, extensions);
    const appearance = strokeAppearance(node, kind, sourceId, issues, extensions);
    const parent = parentId ? nodeById.get(parentId) : undefined;
    // Core owns the position of an AUTO flow child. Figma still returns a
    // relativeTransform for that child, but preserving it would create two
    // incompatible geometry authorities. Absolute children remain affine.
    const flowChild = Boolean(parent?.autoLayout && parent.autoLayout.mode !== "none" && !autoLayout?.absolute);
    if (kind === "shapeWithText") {
      const shapeType = string(node.shapeType);
      if (isFigmaRestShapeWithTextType(shapeType)) imported.shapeWithTextType = shapeType;
      else {
        extensions["figma.rest.shape-with-text-type.v1"] = jsonBytes({ shapeType: node.shapeType });
        issues.push({
          sourceId,
          capability: "shape-with-text-type",
          outcome: "preserved-extension",
          reason: "The Figma ShapeWithText shapeType is missing or unknown; its source value was preserved and ROUNDED_RECTANGLE is used as the editable fallback.",
        });
      }
    }
    const hasTextSublayer = kind === "text" || kind === "shapeWithText";
    const text = hasTextSublayer ? string(node.characters) ?? "" : imported.text;
    const textResult = hasTextSublayer && record(node.style) ? textProperties(node, text ?? "", sourceId, issues) : undefined;
    if (textResult) Object.assign(extensions, textResult.extensions);
    const discoveredRequests = imageAssetRequests(node, sourceId, id);
    const requests = discoveredRequests.filter((request) =>
      request.usage === "node" ? imageNodeTargetKind(kind) : imagePaintStackTargetKind(kind),
    );
    if (requests.length !== discoveredRequests.length) {
      issues.push({
        sourceId,
        capability: kind === "text" ? "text-image-paint" : "image-paint",
        outcome: "preserved-extension",
        reason: kind === "text"
          ? "Text image paints remain preserved source metadata until glyph-outline clipping is implemented; no unusable authorization request is emitted."
          : "This structural node kind cannot own a Canonical image Paint Stack; its source paint remains preserved metadata.",
      });
    }
    // A lock is a Core mutation guard, so an image-bearing imported layer must
    // remain temporarily mutable until its separately authorized asset is
    // registered and bound. The binding transaction restores this exact flag.
    const deferredAssetLock = node.locked === true && requests.some((request) =>
      request.usage === "node" ? imageNodeTargetKind(kind) : imagePaintStackTargetKind(kind),
    );
    if (deferredAssetLock) extensions["figma.rest.deferred-lock.v1"] = bytes("true");
    const blendMode = blend(node.blendMode, sourceId, issues, extensions);
    const blendExtensions = extensionsForNodeBlendMode(
      extensions,
      blendMode,
      string(node.blendMode) === "NORMAL" && canContainChildren(kind),
    );
    const next: CanvasNode = {
      ...imported,
      id,
      pageId,
      parentId,
      name: string(node.name) ?? imported.name,
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      // Core stores Line and Connector nodes as zero-height path owners. A
      // Connector's actual local bounds live in connectorMetadata endpoints.
      height: kind === "connector" ? 0 : geometry.height,
      rotation: geometry.rotation,
      positionId: sourcePositionId,
      fill: fill.css,
      fillColor: fill.color,
      fillGradient: fill.gradient,
      fills: fills.length > 1 ? fills : undefined,
      stroke: stroke.css,
      strokeColor: stroke.color,
      strokeGradient: stroke.gradient,
      strokes: strokes.length > 1 ? strokes : undefined,
      strokeWidth: appearance.strokeWidth ?? imported.strokeWidth,
      strokeCapStart: appearance.strokeCapStart ?? imported.strokeCapStart,
      strokeCapEnd: appearance.strokeCapEnd ?? imported.strokeCapEnd,
      strokeJoin: appearance.strokeJoin ?? imported.strokeJoin,
      strokeMiterLimit: appearance.strokeMiterLimit ?? imported.strokeMiterLimit,
      strokeDashPattern: appearance.strokeDashPattern ?? imported.strokeDashPattern,
      strokeWeights: appearance.strokeWeights,
      strokeAlign: appearance.strokeAlign ?? imported.strokeAlign,
      radius: appearance.radius ?? imported.radius,
      cornerRadii: appearance.cornerRadii,
      cornerSmoothing: appearance.cornerSmoothing,
      arcData: appearance.arcData,
      relativeTransform: flowChild ? undefined : geometry.relativeTransform,
      opacity: clamp(finite(node.opacity) ?? 1, 0, 1),
      visible: node.visible !== false,
      locked: deferredAssetLock ? false : node.locked === true,
      blendMode,
      text,
      textProperties: textResult?.properties,
      constraints,
      autoLayout,
      booleanOperation: kind === "booleanOperation" ? booleanOperation(node.booleanOperation, sourceId, issues, extensions) : undefined,
      parametricShape: parametricShape(kind, node, sourceId, issues, extensions),
      vectorPath,
      effectStack: effectResult.effects.length ? effectResult.effects : undefined,
      // Core's legacy dropShadow field is an alias for the first effect only.
      // Pointing it at a later drop shadow changes effect order and makes the
      // otherwise valid appearance fail Core validation.
      dropShadow: leadingDropShadow(effectResult.effects),
      isMask: mask.alpha,
      clipsContent: clipsChildren(kind) ? node.clipsContent !== false : undefined,
      componentMetadata: kind === "component" ? componentMetadata(node, record(sourceComponents?.[sourceId]), id, extensions, sourceId, issues) : undefined,
      slotMetadata: kind === "slot" ? slotMetadata(node, extensions, sourceId, issues) : undefined,
      componentSetMetadata: kind === "componentSet" ? componentSetMetadata(node, record(sourceComponentSets?.[sourceId]), id, extensions, sourceId, issues) : undefined,
      extensions: blendExtensions,
    };
    for (const usage of ["fill", "stroke"] as const) {
      const result = versionedPaintStackFromSource(next, usage, new Map());
      if (result.status === "complete") {
        if (usage === "fill") next.fillStack = result.stack;
        else next.strokeStack = result.stack;
      }
    }
    nodes.push(next);
    nodeById.set(next.id, next);
    assetRequests.push(...requests);
    const children = array(node.children);
    if (children) {
      for (const [index, child] of children.entries()) {
        walk(child, id, pageId, depth + 1, orderedPositionId(index, children.length));
        if (nodeBudgetExhausted) break;
      }
    }
  }
}

type ImportedConnectorEndpoint = NonNullable<CanvasNode["connectorMetadata"]>["start"];

function importConnectorMetadata(
  source: JsonRecord | undefined,
  connector: CanvasNode,
  inverseWorld: AffineMatrix | undefined,
  canonicalIdBySourceId: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, CanvasNode>,
  sourceId: string | undefined,
  issues: FigmaImportIssue[],
): { metadata: NonNullable<CanvasNode["connectorMetadata"]>; preserveSource: boolean } {
  const sourceLineType = string(source?.connectorLineType);
  const lineType = isConnectorLineType(sourceLineType) ? sourceLineType : "STRAIGHT";
  let preserveSource = false;
  if (!isConnectorLineType(sourceLineType)) {
    preserveSource = true;
    issues.push({
      sourceId,
      capability: "connector-line-type",
      outcome: "preserved-extension",
      reason: "The Connector line type is missing or unknown; its source value was preserved and STRAIGHT is used as the editable fallback.",
    });
  }

  const startResult = importConnectorEndpoint(
    source?.connectorStart,
    { x: 0, y: 0 },
    inverseWorld,
    canonicalIdBySourceId,
    nodeById,
    connector.id,
    connector.pageId,
  );
  const sourceSize = record(source?.size);
  const sourceBox = record(source?.absoluteBoundingBox);
  const fallbackEnd = {
    x: finite(sourceSize?.x) ?? finite(sourceBox?.width) ?? connector.width,
    y: finite(sourceSize?.y) ?? finite(sourceBox?.height) ?? connector.height,
  };
  const endResult = importConnectorEndpoint(
    source?.connectorEnd,
    fallbackEnd,
    inverseWorld,
    canonicalIdBySourceId,
    nodeById,
    connector.id,
    connector.pageId,
  );
  if (startResult.preserveSource || endResult.preserveSource) {
    preserveSource = true;
    issues.push({
      sourceId,
      capability: "connector-endpoint",
      outcome: "preserved-extension",
      reason: "At least one Connector endpoint could not be represented exactly. Canvas positions were converted to connector-local coordinates when available; unresolved references and magnet-only dynamic routing remain preserved source metadata.",
    });
  }

  const startCap = connectorStrokeCap(string(source?.connectorStartStrokeCap));
  const endCap = connectorStrokeCap(string(source?.connectorEndStrokeCap));
  if (!startCap || !endCap) {
    preserveSource = true;
    issues.push({
      sourceId,
      capability: "connector-stroke-cap",
      outcome: "preserved-extension",
      reason: "At least one Connector endpoint cap is missing or outside the documented REST subset; the source value was preserved and NONE is used as the editable fallback.",
    });
  }

  const sourceCornerRadius = source?.cornerRadius;
  const cornerRadius = sourceCornerRadius === undefined ? undefined : finite(sourceCornerRadius);
  const validCornerRadius = cornerRadius !== undefined && cornerRadius >= 0;
  if (sourceCornerRadius !== undefined && !validCornerRadius) {
    preserveSource = true;
    issues.push({
      sourceId,
      capability: "connector-corner-radius",
      outcome: "preserved-extension",
      reason: "The Connector cornerRadius is invalid; its source value was preserved and omitted from the editable metadata.",
    });
  }

  return {
    metadata: {
      lineType,
      start: startResult.endpoint,
      end: endResult.endpoint,
      startStrokeCap: startCap ?? "NONE",
      endStrokeCap: endCap ?? "NONE",
      text: string(source?.characters) ?? "",
      ...(validCornerRadius ? { cornerRadius } : {}),
    },
    preserveSource,
  };
}

function importConnectorEndpoint(
  value: unknown,
  fallback: Readonly<{ x: number; y: number }>,
  inverseWorld: AffineMatrix | undefined,
  canonicalIdBySourceId: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, CanvasNode>,
  connectorId: string,
  connectorPageId: string | undefined,
): { endpoint: ImportedConnectorEndpoint; preserveSource: boolean } {
  const endpoint = record(value);
  if (!endpoint) return { endpoint: { ...fallback }, preserveSource: true };
  const sourceTargetId = string(endpoint.endpointNodeId);
  const candidateTargetId = sourceTargetId ? canonicalIdBySourceId.get(sourceTargetId) : undefined;
  const candidateTarget = candidateTargetId ? nodeById.get(candidateTargetId) : undefined;
  const targetId = candidateTarget && candidateTarget.id !== connectorId && candidateTarget.pageId === connectorPageId
    ? candidateTarget.id
    : undefined;
  const malformedTarget = endpoint.endpointNodeId !== undefined && !sourceTargetId;
  const sourcePosition = record(endpoint.position);
  const worldX = finite(sourcePosition?.x);
  const worldY = finite(sourcePosition?.y);
  if (worldX !== undefined && worldY !== undefined && inverseWorld) {
    const position = transformPoint(inverseWorld, { x: worldX, y: worldY });
    return {
      endpoint: { ...position, ...(targetId ? { endpointNodeId: targetId } : {}) },
      preserveSource: malformedTarget || Boolean(sourceTargetId && !targetId) || endpoint.magnet !== undefined,
    };
  }
  const magnet = connectorMagnet(string(endpoint.magnet));
  if (sourceTargetId && targetId && magnet) {
    return {
      endpoint: { ...fallback, endpointNodeId: targetId, magnet },
      preserveSource: true,
    };
  }
  return { endpoint: { ...fallback }, preserveSource: true };
}

function isConnectorLineType(value: string | undefined): value is NonNullable<CanvasNode["connectorMetadata"]>["lineType"] {
  return value === "ELBOWED" || value === "STRAIGHT" || value === "CURVED";
}

function connectorMagnet(value: string | undefined): ImportedConnectorEndpoint["magnet"] {
  return value === "NONE" || value === "AUTO" || value === "TOP" || value === "RIGHT" || value === "BOTTOM" || value === "LEFT" || value === "CENTER" ? value : undefined;
}

function connectorStrokeCap(value: string | undefined): string | undefined {
  const map: Record<string, string> = {
    NONE: "NONE",
    LINE_ARROW: "ARROW_LINES",
    TRIANGLE_ARROW: "ARROW_EQUILATERAL",
    DIAMOND_FILLED: "DIAMOND_FILLED",
    TRIANGLE_FILLED: "TRIANGLE_FILLED",
    CIRCLE_FILLED: "CIRCLE_FILLED",
  };
  return value ? map[value] : undefined;
}

function instanceScaleFactor(source: JsonRecord | undefined, sourceId: string | undefined, issues: FigmaImportIssue[]) {
  if (source?.scaleFactor === undefined) return 1;
  const scaleFactor = finite(source.scaleFactor);
  if (scaleFactor !== undefined && scaleFactor > 0) return scaleFactor;
  issues.push({ sourceId, capability: "instance-scale", outcome: "preserved-extension", reason: "An invalid Instance scaleFactor was retained as source metadata and was not applied." });
  return 1;
}

function instanceComponentProperties(source: JsonRecord | undefined, sourceId: string | undefined, issues: FigmaImportIssue[]) {
  if (source?.componentProperties === undefined) return {};
  const raw = record(source.componentProperties);
  if (!raw) {
    issues.push({ sourceId, capability: "instance-component-properties", outcome: "preserved-extension", reason: "Instance componentProperties is not an object and remains preserved source metadata." });
    return {};
  }
  const properties: Record<string, string | boolean> = {};
  let preserved = false;
  for (const [name, value] of Object.entries(raw)) {
    const property = record(value);
    const type = string(property?.type);
    const propertyValue = property?.value;
    const supported = type === "BOOLEAN"
      ? typeof propertyValue === "boolean"
      : ["TEXT", "VARIANT", "INSTANCE_SWAP"].includes(type ?? "") && typeof propertyValue === "string";
    if (!supported) {
      preserved = true;
      continue;
    }
    properties[name] = propertyValue as string | boolean;
  }
  if (preserved) {
    issues.push({ sourceId, capability: "instance-component-properties", outcome: "preserved-extension", reason: "Supported BOOLEAN, TEXT, VARIANT and INSTANCE_SWAP values were mapped; remaining Instance properties stay preserved source metadata." });
  }
  return properties;
}

function instanceOverrides(
  source: JsonRecord | undefined,
  instanceId: string,
  canonicalIdBySourceId: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, CanvasNode>,
  sourceId: string | undefined,
  issues: FigmaImportIssue[],
  preserveBrokenReferences: boolean,
): NonNullable<CanvasNode["instanceMetadata"]>["overrides"] {
  if (source?.overrides === undefined) return [];
  const rawOverrides = array(source.overrides);
  if (!rawOverrides) {
    issues.push({ sourceId, capability: "instance-overrides", outcome: "preserved-extension", reason: "Instance overrides is not an array and remains preserved source metadata." });
    return [];
  }
  const fieldsByTarget = new Map<string, Set<string>>();
  let preservedFields = false;
  for (const raw of rawOverrides) {
    const override = record(raw);
    const overrideSourceId = string(override?.id);
    const sourceFields = array(override?.overriddenFields);
    const targetId = overrideSourceId ? canonicalIdBySourceId.get(overrideSourceId) : undefined;
    if (!override || !overrideSourceId || !sourceFields?.every((field) => typeof field === "string") || !targetId || !isNodeInSubtree(nodeById, targetId, instanceId)) {
      issues.push({
        sourceId: overrideSourceId ?? sourceId,
        capability: "instance-override-reference",
        outcome: preserveBrokenReferences ? "preserved-extension" : "rejected",
        reason: preserveBrokenReferences
          ? "The caller explicitly allowed an Instance override whose target is absent or outside this imported Instance subtree."
          : "An Instance override target is absent or outside this imported Instance subtree; retry with the explicit preserve policy to accept this loss.",
      });
      continue;
    }
    const targetFields = fieldsByTarget.get(targetId) ?? new Set<string>();
    for (const sourceField of sourceFields as string[]) {
      const mapped = canonicalOverrideFields(sourceField);
      if (!mapped.length) preservedFields = true;
      for (const field of mapped) targetFields.add(field);
    }
    if (targetFields.size) fieldsByTarget.set(targetId, targetFields);
  }
  if (preservedFields) {
    issues.push({ sourceId, capability: "instance-override-fields", outcome: "preserved-extension", reason: "Supported override fields were mapped to Canonical properties; unsupported Figma fields remain preserved source metadata." });
  }
  return [...fieldsByTarget].map(([id, fields]) => ({ id, overriddenFields: [...fields].sort() }));
}

function isNodeInSubtree(nodeById: ReadonlyMap<string, CanvasNode>, nodeId: string, rootId: string) {
  let current = nodeById.get(nodeId);
  const visited = new Set<string>();
  while (current && visited.size <= nodeById.size && !visited.has(current.id)) {
    if (current.id === rootId) return true;
    visited.add(current.id);
    current = current.parentId ? nodeById.get(current.parentId) : undefined;
  }
  return false;
}

function canonicalOverrideFields(field: string): string[] {
  switch (field) {
    case "fills": return ["fill", "fillColor", "fillGradient", "fills", "fillStack"];
    case "strokes": return ["stroke", "strokeColor", "strokeGradient", "strokes", "strokeStack"];
    case "strokeWeight": case "stokeTopWeight": case "strokeBottomWeight": case "strokeLeftWeight": case "strokeRightWeight": return ["strokeWidth", "strokeWeights"];
    case "strokeCap": return ["strokeCapStart", "strokeCapEnd"];
    case "dashPattern": return ["strokeDashPattern"];
    case "cornerRadius": case "topLeftRadius": case "topRightRadius": case "bottomLeftRadius": case "bottomRightRadius": return ["radius", "cornerRadii"];
    case "characters": case "text": return ["text", "textProperties"];
    case "effects": return ["dropShadow", "effectStack"];
    case "layoutMode": case "paddingLeft": case "paddingTop": case "paddingRight": case "paddingBottom": case "itemSpacing": case "layoutAlign": case "counterAxisSizingMode": case "primaryAxisSizingMode": case "primaryAxisAlignItems": case "counterAxisAlignItems": case "layoutGrow": case "layoutPositioning": return ["autoLayout"];
    case "x": case "y": case "width": case "height": case "rotation": case "relativeTransform": case "name": case "constraints": case "locked": case "visible": case "opacity": case "blendMode": case "arcData": case "strokeAlign": case "strokeJoin": case "strokeMiterLimit": case "booleanOperation": case "cornerSmoothing": case "isMask": case "clipsContent": return [field];
    default: return [];
  }
}

function slotMetadata(
  node: JsonRecord,
  extensions: Record<string, number[]>,
  sourceId: string,
  issues: FigmaImportIssue[],
): CanvasNode["slotMetadata"] {
  const componentPropertyReferences = record(node.componentPropertyReferences);
  const propertyName = string(node.slotPropertyName) ?? string(componentPropertyReferences?.slot);
  if (!propertyName) {
    extensions["figma.rest.slot-metadata.v1"] = jsonBytes({ componentPropertyReferences: node.componentPropertyReferences });
    issues.push({ sourceId, capability: "slot-property", outcome: "preserved-extension", reason: "The Slot has no supported property name; its source metadata was retained without inventing one." });
    return undefined;
  }
  return { propertyName };
}

/** A Figma mask source is valid only when a later imported sibling remains in
 * the same container. Core enforces that invariant at transaction time; make
 * the downgrade explicit in the plan instead of yielding an unusable batch. */
function normalizeImportedAlphaMasks(nodes: CanvasNode[], issues: FigmaImportIssue[]) {
  const highestSiblingPosition = new Map<string, string>();
  for (const node of nodes) {
    const key = `${node.pageId ?? ""}\0${node.parentId ?? ""}`;
    const position = node.positionId ?? "";
    const current = highestSiblingPosition.get(key);
    if (current === undefined || position > current) highestSiblingPosition.set(key, position);
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node?.isMask) continue;
    const key = `${node.pageId ?? ""}\0${node.parentId ?? ""}`;
    const hasFollowingSibling = (highestSiblingPosition.get(key) ?? "") > (node.positionId ?? "");
    if (hasFollowingSibling) continue;
    nodes[index] = { ...node, isMask: false };
    issues.push({ capability: "mask", outcome: "preserved-extension", reason: "Figma alpha mask has no imported following sibling, so its source metadata was retained without creating an invalid Canonical mask." });
  }
}

function imageAssetRequests(node: JsonRecord, sourceId: string, nodeId: string): FigmaRestAssetRequest[] {
  const requests: FigmaRestAssetRequest[] = [];
  const appendPaints = (value: unknown, usage: "fill" | "stroke") => {
    for (const [paintIndex, paint] of (array(value) ?? []).entries()) {
      const item = record(paint);
      const imageRef = string(item?.imageRef);
      if (item?.type === "IMAGE" && imageRef) requests.push({ sourceId, nodeId, imageRef, usage, paintIndex });
    }
  };
  appendPaints(node.fills, "fill");
  appendPaints(node.strokes, "stroke");
  const nodeImageRef = string(node.imageRef);
  if (node.type === "IMAGE" && nodeImageRef) requests.push({ sourceId, nodeId, imageRef: nodeImageRef, usage: "node" });
  return requests;
}

function extensionText(value: number[] | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new TextDecoder().decode(Uint8Array.from(value));
  } catch {
    return undefined;
  }
}

function extensionJson(value: number[] | undefined): unknown | undefined {
  const source = extensionText(value);
  if (source === undefined) return undefined;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
}

function imagePaintBindingKey(usage: "fill" | "stroke", paintIndex: number) {
  return `${usage}:${paintIndex}`;
}

function authorizedImagePaintBindings(node: CanvasNode): Map<string, AuthorizedImagePaintBinding> | undefined {
  const encoded = node.extensions?.[FIGMA_AUTHORIZED_IMAGE_PAINTS_EXTENSION];
  if (!encoded) return new Map();
  const decoded = array(extensionJson(encoded));
  if (!decoded || decoded.length > 32) return undefined;
  const bindings = new Map<string, AuthorizedImagePaintBinding>();
  for (const value of decoded) {
    const entry = record(value);
    const usage = string(entry?.usage);
    const paintIndex = finite(entry?.paintIndex);
    const imageRef = string(entry?.imageRef);
    const assetId = string(entry?.assetId);
    if ((usage !== "fill" && usage !== "stroke") || !Number.isInteger(paintIndex) || paintIndex! < 0 || !imageRef || !assetId) return undefined;
    const binding = { usage, paintIndex: paintIndex!, imageRef, assetId } as AuthorizedImagePaintBinding;
    const key = imagePaintBindingKey(binding.usage, binding.paintIndex);
    if (bindings.has(key)) return undefined;
    bindings.set(key, binding);
  }
  return bindings;
}

function figmaPaintSource(node: CanvasNode, usage: "fill" | "stroke"): unknown[] | undefined {
  const source = record(extensionJson(node.extensions?.[FIGMA_PAINT_SOURCE_EXTENSION]));
  return array(source?.[usage === "fill" ? "fills" : "strokes"]);
}

function sourcePaintForRequest(node: CanvasNode, request: FigmaRestAssetRequest): JsonRecord | undefined {
  if ((request.usage !== "fill" && request.usage !== "stroke") || !Number.isInteger(request.paintIndex) || request.paintIndex! < 0) return undefined;
  const item = record(figmaPaintSource(node, request.usage)?.[request.paintIndex!]);
  return item?.type === "IMAGE" && string(item.imageRef) === request.imageRef ? item : undefined;
}

function matchesImageNodeRequest(node: CanvasNode, request: FigmaRestAssetRequest) {
  if (request.paintIndex !== undefined) return false;
  const source = record(extensionJson(node.extensions?.[FIGMA_IMAGE_NODE_EXTENSION]));
  return source?.type === "IMAGE" && string(source.imageRef) === request.imageRef;
}

type PaintStackSourceResult =
  | { status: "none" | "pending" }
  | { status: "complete"; stack: DocumentPaintStack }
  | { status: "unsupported"; reason: string };

function versionedPaintStackFromSource(
  node: CanvasNode,
  usage: "fill" | "stroke",
  bindings: ReadonlyMap<string, AuthorizedImagePaintBinding>,
): PaintStackSourceResult {
  const paints = figmaPaintSource(node, usage);
  return paintStackFromSourcePaints(paints, usage, bindings, false);
}

function paintStackFromSourcePaints(
  paints: unknown[] | undefined,
  usage: "fill" | "stroke",
  bindings: ReadonlyMap<string, AuthorizedImagePaintBinding>,
  includeSimplePaints: boolean,
): PaintStackSourceResult {
  if (!paints?.length) return paints ? { status: "complete", stack: { layers: [] } } : { status: "none" };
  if (!includeSimplePaints && !paints.some((paint) => {
    const item = record(paint);
    const type = string(item?.type);
    const blendMode = string(item?.blendMode);
    return type === "IMAGE" || type === "GRADIENT_RADIAL" || type === "GRADIENT_ANGULAR" || type === "GRADIENT_DIAMOND"
      || blendMode === "LINEAR_BURN" || blendMode === "LINEAR_DODGE";
  })) return { status: "none" };
  if (paints.length > 16) return { status: "unsupported", reason: "The source paint stack exceeds the 16-layer Canonical limit." };
  const layers: DocumentPaintLayer[] = [];
  for (const [paintIndex, raw] of paints.entries()) {
    const item = record(raw);
    if (!item) return { status: "unsupported", reason: "The source paint stack contains a malformed layer." };
    const opacity = item.opacity === undefined ? 1 : finite(item.opacity);
    const blendMode = paintLayerBlendMode(item.blendMode);
    if (opacity === undefined || opacity < 0 || opacity > 1 || !blendMode) {
      return { status: "unsupported", reason: "A source paint has opacity or blend semantics outside the Canonical Paint Stack." };
    }
    const layerBase = { visible: item.visible !== false, opacity, blendMode };
    if (item.type === "SOLID") {
      const color = figmaColor(item.color);
      if (!color) return { status: "unsupported", reason: "A source solid paint has an invalid color." };
      layers.push({ ...layerBase, paint: { css: cssColor(color), color } });
      continue;
    }
    if (item.type === "GRADIENT_LINEAR") {
      const gradient = linearGradient(item, 1);
      if (!gradient) return { status: "unsupported", reason: "A source linear gradient cannot be represented without changing its geometry." };
      layers.push({ ...layerBase, paint: { css: cssColor(gradient.stops[0]!.color), gradient } });
      continue;
    }
    if (item.type === "GRADIENT_RADIAL" || item.type === "GRADIENT_ANGULAR" || item.type === "GRADIENT_DIAMOND") {
      const gradientPaint = nonLinearGradient(item, 1);
      if (!gradientPaint) return { status: "unsupported", reason: "A source non-linear gradient has an invalid transform or stop list." };
      layers.push({ ...layerBase, paint: { css: cssColor(gradientPaint.stops[0]!.color), gradientPaint } });
      continue;
    }
    if (item.type === "IMAGE") {
      const binding = bindings.get(imagePaintBindingKey(usage, paintIndex));
      if (!binding || binding.imageRef !== string(item.imageRef)) return { status: "pending" };
      const image = documentImagePaint(item, binding.assetId);
      if (!image) return { status: "unsupported", reason: "A source image paint uses an unsupported scale, adjustment, or transform value." };
      layers.push({ ...layerBase, image });
      continue;
    }
    return { status: "unsupported", reason: `Figma ${string(item.type) ?? "unknown"} paint cannot be represented by the current Canonical Paint Stack.` };
  }
  return { status: "complete", stack: { layers } };
}

function paintLayerBlendMode(value: unknown): BlendMode | undefined {
  const map: Record<string, BlendMode> = {
    NORMAL: "normal", MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten",
    COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn", HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light",
    DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
    LINEAR_BURN: "linear-burn", LINEAR_DODGE: "linear-dodge",
  };
  return map[string(value) ?? "NORMAL"];
}

function documentImagePaint(item: JsonRecord, assetId: string): NonNullable<DocumentPaintLayer["image"]> | undefined {
  const modes = { FILL: "fill", FIT: "fit", CROP: "crop", TILE: "tile" } as const;
  const mode = string(item.scaleMode) ?? "FILL";
  const scaleMode = modes[mode as keyof typeof modes];
  if (!scaleMode || unsupportedImageScale(item)) return undefined;
  const rotationDegrees = imagePaintRotation(item.rotation, scaleMode);
  if (rotationDegrees === undefined) return undefined;
  const transform = imagePaintTransform(item.imageTransform);
  const filters = imagePaintFilters(item);
  if (filters === null) return undefined;
  return transform ? {
    assetId,
    scaleMode,
    transform,
    ...(rotationDegrees ? { rotationDegrees } : {}),
    ...(filters ? { filters } : {}),
  } : undefined;
}

function imagePaintTransform(value: unknown): RelativeTransform | undefined {
  if (value === undefined) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const matrix = array(value);
  const first = matrix && array(matrix[0]);
  const second = matrix && array(matrix[1]);
  if (matrix?.length !== 2 || first?.length !== 3 || second?.length !== 3) return undefined;
  const values = [first[0], second[0], first[1], second[1], first[2], second[2]].map(finite);
  if (values.some((entry) => entry === undefined)) return undefined;
  const [a, b, c, d, e, f] = values as number[];
  return Math.abs(a! * d! - b! * c!) <= 1e-12 ? undefined : { a: a!, b: b!, c: c!, d: d!, e: e!, f: f! };
}

function unsupportedImageScale(item: JsonRecord) {
  const scalingFactor = item.scalingFactor === undefined ? 1 : finite(item.scalingFactor);
  return scalingFactor === undefined || Math.abs(scalingFactor - 1) > 1e-9;
}

const IMAGE_FILTER_FIELDS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"] as const;
function imagePaintFilters(item: JsonRecord): DocumentImageFilters | undefined | null {
  if (item.filters === undefined) return undefined;
  const source = record(item.filters);
  if (!source || Object.keys(source).some((key) => !IMAGE_FILTER_FIELDS.includes(key as typeof IMAGE_FILTER_FIELDS[number]))) return null;
  const filters: DocumentImageFilters = {};
  for (const field of IMAGE_FILTER_FIELDS) {
    if (source[field] === undefined) continue;
    const value = finite(source[field]);
    if (value === undefined || value < -1 || value > 1) return null;
    filters[field] = value;
  }
  return filters;
}

function imagePaintRotation(
  value: unknown,
  scaleMode: NonNullable<DocumentPaintLayer["image"]>["scaleMode"],
): 0 | 90 | 180 | 270 | undefined {
  const rotation = value === undefined ? 0 : finite(value);
  if (rotation === undefined || ![0, 90, 180, 270].includes(rotation)) return undefined;
  if (scaleMode === "crop" && rotation !== 0) return undefined;
  return rotation as 0 | 90 | 180 | 270;
}

function allSourceImagesAuthorized(node: CanvasNode, bindings: ReadonlyMap<string, AuthorizedImagePaintBinding>) {
  for (const usage of ["fill", "stroke"] as const) {
    const paints = figmaPaintSource(node, usage) ?? [];
    for (const [paintIndex, raw] of paints.entries()) {
      const item = record(raw);
      if (item?.type !== "IMAGE") continue;
      const binding = bindings.get(imagePaintBindingKey(usage, paintIndex));
      if (!binding || binding.imageRef !== string(item.imageRef)) return false;
    }
  }
  const imageNode = record(extensionJson(node.extensions?.[FIGMA_IMAGE_NODE_EXTENSION]));
  return imageNode?.type !== "IMAGE" || Boolean(node.assetId);
}

function layout(node: JsonRecord, kind: NodeKind, sourceId: string, issues: FigmaImportIssue[], extensions: Record<string, number[]>): DocumentAutoLayout | undefined {
  const mode = string(node.layoutMode);
  const horizontal = mode === "HORIZONTAL";
  const vertical = mode === "VERTICAL";
  const absolute = string(node.layoutPositioning) === "ABSOLUTE";
  const alignSelf = childAlignment(string(node.layoutAlign));
  if (!horizontal && !vertical && !absolute && !alignSelf) {
    if (mode === "GRID") {
      extensions["figma.rest.layout-mode.v1"] = bytes(mode);
      issues.push({ sourceId, capability: "grid-auto-layout", outcome: "preserved-extension", reason: "Figma GRID is outside Phase 2 and is not coerced into flex layout." });
    }
    return undefined;
  }
  const mappedMode = horizontal ? "horizontal" : vertical ? "vertical" : "none";
  if (kind !== "frame" && (horizontal || vertical)) {
    issues.push({ sourceId, capability: "auto-layout", outcome: "rejected", reason: "Only Frame nodes may own an Auto Layout mode." });
    return undefined;
  }
  return {
    mode: mappedMode,
    padding: [finite(node.paddingTop) ?? 0, finite(node.paddingRight) ?? 0, finite(node.paddingBottom) ?? 0, finite(node.paddingLeft) ?? 0],
    itemSpacing: finite(node.itemSpacing) ?? 0,
    trackSpacing: finite(node.counterAxisSpacing) ?? undefined,
    trackAlignment: string(node.counterAxisAlignContent) === "SPACE_BETWEEN" ? "spaceBetween" : undefined,
    wrap: string(node.layoutWrap) === "WRAP",
    primaryAlignment: alignment(string(node.primaryAxisAlignItems), false),
    counterAlignment: alignment(string(node.counterAxisAlignItems), true),
    primarySizing: sizing(horizontal ? string(node.layoutSizingHorizontal) : string(node.layoutSizingVertical)),
    counterSizing: sizing(horizontal ? string(node.layoutSizingVertical) : string(node.layoutSizingHorizontal)),
    alignSelf,
    minWidth: finite(node.minWidth) ?? undefined,
    maxWidth: finite(node.maxWidth) ?? undefined,
    minHeight: finite(node.minHeight) ?? undefined,
    maxHeight: finite(node.maxHeight) ?? undefined,
    absolute,
  };
}

function constraintState(value: unknown, sourceId: string, issues: FigmaImportIssue[], extensions: Record<string, number[]>): CanvasNode["constraints"] {
  const constraints = record(value);
  if (!constraints) return undefined;
  const horizontal = constraint(string(constraints.horizontal));
  const vertical = constraint(string(constraints.vertical));
  if (horizontal && vertical) return { horizontal, vertical };
  extensions["figma.rest.constraints.v1"] = jsonBytes(value);
  issues.push({ sourceId, capability: "constraints", outcome: "preserved-extension", reason: "Unsupported Figma constraint values were not coerced to a different resize behavior." });
  return undefined;
}

type ImportedTextStyle = Pick<DocumentTextProperties["runs"][number], "fontSize" | "fontWeight" | "italic" | "letterSpacing" | "textCase" | "hyperlink" | "textDecoration" | "textDecorationStyle" | "textDecorationOffset" | "textDecorationThickness" | "textDecorationColor" | "textDecorationSkipInk" | "leadingTrim" | "openTypeFeatures" | "textStyleId">;

function importedPaintStyleResources(
  sourceStyles: JsonRecord | undefined,
  nodes: readonly CanvasNode[],
  sourceNodeByCanonicalId: ReadonlyMap<string, JsonRecord>,
  issues: FigmaImportIssue[],
): DocumentPaintStyleResource[] {
  if (!sourceStyles) return [];
  const consumers = new Map<string, DocumentPaintStack[]>();
  for (const node of nodes) {
    const source = sourceNodeByCanonicalId.get(node.id);
    const styles = record(source?.styles);
    for (const [field, rawPaints] of [["fill", source?.fills], ["stroke", source?.strokes]] as const) {
      const id = string(styles?.[field]);
      if (!id) continue;
      const result = paintStackFromSourcePaints(array(rawPaints), field, new Map(), true);
      if (result.status !== "complete") continue;
      const entries = consumers.get(id) ?? [];
      entries.push(result.stack);
      consumers.set(id, entries);
    }
  }
  const entries = Object.entries(sourceStyles).filter(([, source]) => {
    const metadata = record(source);
    const styleType = string(metadata?.styleType) ?? string(metadata?.style_type) ?? string(metadata?.type);
    return styleType === "FILL";
  });
  if (entries.length > 4_096) {
    issues.push({ capability: "paint-style-resource", outcome: "rejected", reason: "Figma PaintStyle metadata exceeds the 4,096-resource catalog limit." });
  }
  const resources: DocumentPaintStyleResource[] = [];
  for (const [id, source] of entries.slice(0, 4_096)) {
    const metadata = record(source);
    const values = consumers.get(id) ?? [];
    if (!values.length) {
      issues.push({ sourceId: id, capability: "paint-style-resource", outcome: "preserved-extension", reason: "Figma supplied PaintStyle metadata without a consuming layer that could resolve its complete paints." });
      continue;
    }
    const first = values[0]!;
    if (values.some((value) => JSON.stringify(value) !== JSON.stringify(first))) {
      issues.push({ sourceId: id, capability: "paint-style-resource", outcome: "preserved-extension", reason: "Consumers of this Figma PaintStyle disagree on its complete paints, so no ambiguous catalog entry was created." });
      continue;
    }
    const name = string(metadata?.name);
    const key = string(metadata?.key) ?? "";
    const description = string(metadata?.description) ?? "";
    const remote = metadata?.remote === true;
    const valid = name !== undefined
      && name.trim().length > 0
      && !name.includes("\0")
      && encoder.encode(name).byteLength <= 1_024
      && !id.includes("\0")
      && encoder.encode(id).byteLength <= 2_048
      && !key.includes("\0")
      && encoder.encode(key).byteLength <= 2_048
      && (!remote || key.length > 0)
      && !description.includes("\0")
      && encoder.encode(description).byteLength <= 32 * 1_024;
    if (!valid) {
      issues.push({ sourceId: id, capability: "paint-style-resource", outcome: "preserved-extension", reason: "Figma PaintStyle identity metadata exceeds the Canonical catalog bounds." });
      continue;
    }
    resources.push({ id, key, name, description, remote, paints: first });
  }
  return resources.sort((left, right) => left.id.localeCompare(right.id));
}

function applyImportedPaintStyleLinks(
  nodes: CanvasNode[],
  resources: readonly DocumentPaintStyleResource[],
  sourceNodeByCanonicalId: ReadonlyMap<string, JsonRecord>,
  issues: FigmaImportIssue[],
): void {
  const available = new Set(resources.map((resource) => resource.id));
  for (const node of nodes) {
    const source = sourceNodeByCanonicalId.get(node.id);
    const styles = record(source?.styles);
    const fill = string(styles?.fill);
    const stroke = string(styles?.stroke);
    if (fill && available.has(fill)) {
      node.fillStyleId = fill;
      if (["frame", "component", "instance", "slot", "componentSet"].includes(node.kind)) {
        node.backgroundStyleId = fill;
      }
    } else if (fill) {
      node.extensions ??= {};
      node.extensions["figma.rest.paint-style-links.v1"] = jsonBytes({ fill, stroke });
      issues.push({ sourceId: string(source?.id), capability: "paint-style-link", outcome: "preserved-extension", reason: "The fill PaintStyle could not be reconstructed as one complete Canonical resource, so its source identity was preserved without creating a dangling link." });
    }
    if (stroke && available.has(stroke)) {
      node.strokeStyleId = stroke;
    } else if (stroke) {
      node.extensions ??= {};
      node.extensions["figma.rest.paint-style-links.v1"] = jsonBytes({ fill, stroke });
      issues.push({ sourceId: string(source?.id), capability: "paint-style-link", outcome: "preserved-extension", reason: "The stroke PaintStyle could not be reconstructed as one complete Canonical resource, so its source identity was preserved without creating a dangling link." });
    }
  }
}

function importedTextStyleResources(
  sourceStyles: JsonRecord | undefined,
  nodes: readonly CanvasNode[],
  issues: FigmaImportIssue[],
): DocumentTextStyleResource[] {
  if (!sourceStyles) return [];
  const consumers = new Map<string, Array<{ style: DocumentTextStyleResource["style"]; paragraph: DocumentTextStyleResource["paragraph"] }>>();
  for (const node of nodes) {
    const properties = node.textProperties;
    if (!properties) continue;
    const candidates = properties.baseStyle
      ? [{ start: 0, end: 0, ...properties.baseStyle }]
      : properties.runs;
    for (const candidate of candidates) {
      const id = candidate.textStyleId;
      if (!id) continue;
      const { start: _start, end: _end, textStyleId: _id, hyperlink: _hyperlink, ...style } = candidate;
      void _start;
      void _end;
      void _id;
      void _hyperlink;
      const entries = consumers.get(id) ?? [];
      entries.push({ style, paragraph: structuredClone(properties.paragraph) });
      consumers.set(id, entries);
    }
  }

  const textStyleEntries = Object.entries(sourceStyles).filter(([, source]) => {
    const metadata = record(source);
    const styleType = string(metadata?.styleType) ?? string(metadata?.style_type) ?? string(metadata?.type);
    return styleType === "TEXT";
  });
  if (textStyleEntries.length > 4_096) {
    issues.push({ capability: "text-style-resource", outcome: "rejected", reason: "Figma TextStyle metadata exceeds the 4,096-resource catalog limit." });
  }
  const resources: DocumentTextStyleResource[] = [];
  for (const [id, source] of textStyleEntries.slice(0, 4_096)) {
    const metadata = record(source);
    const values = consumers.get(id) ?? [];
    if (!values.length) {
      issues.push({ sourceId: id, capability: "text-style-resource", outcome: "preserved-extension", reason: "Figma supplied TextStyle metadata without a consuming layer that could resolve its complete text values." });
      continue;
    }
    const first = values[0]!;
    if (values.some((value) => JSON.stringify(value) !== JSON.stringify(first))) {
      issues.push({ sourceId: id, capability: "text-style-resource", outcome: "preserved-extension", reason: "Consumers of this Figma TextStyle disagree on its complete text values, so no ambiguous catalog entry was created." });
      continue;
    }
    const name = string(metadata?.name);
    const key = string(metadata?.key) ?? "";
    const description = string(metadata?.description) ?? "";
    const remote = metadata?.remote === true;
    const valid = name !== undefined
      && name.trim().length > 0
      && !name.includes("\0")
      && encoder.encode(name).byteLength <= 1_024
      && !id.includes("\0")
      && encoder.encode(id).byteLength <= 2_048
      && !key.includes("\0")
      && encoder.encode(key).byteLength <= 2_048
      && (!remote || key.length > 0)
      && !description.includes("\0")
      && encoder.encode(description).byteLength <= 32 * 1_024;
    if (!valid) {
      issues.push({ sourceId: id, capability: "text-style-resource", outcome: "preserved-extension", reason: "Figma TextStyle identity metadata exceeds the Canonical catalog bounds." });
      continue;
    }
    resources.push({ id, key, name, description, remote, style: first.style, paragraph: first.paragraph });
  }
  return resources.sort((left, right) => left.id.localeCompare(right.id));
}

function textProperties(node: JsonRecord, text: string, sourceId: string, issues: FigmaImportIssue[]) {
  const extensions: Record<string, number[]> = {};
  const style = record(node.style);
  if (!style) return { extensions };
  const base = importedTextStyle(style);
  if (!base) {
    extensions["figma.rest.text-style.v1"] = jsonBytes(style);
    issues.push({ sourceId, capability: "text-style", outcome: "preserved-extension", reason: "Figma Text style has invalid metrics and was not coerced into a Canonical run." });
    return { extensions };
  }
  const textStyleId = importedNodeTextStyleId(node.styles);
  if (textStyleId === false) {
    extensions["figma.rest.text-style-link.v1"] = jsonBytes(node.styles);
    issues.push({ sourceId, capability: "text-style-link", outcome: "preserved-extension", reason: "An invalid Figma TextStyle link was preserved without creating an ambiguous Canonical identity." });
  }
  const linkedBase = textStyleId ? { ...base, textStyleId } : base;
  const fontMetadata = [style, ...Object.values(record(node.styleOverrideTable) ?? {})].filter((candidate) => typeof record(candidate)?.fontFamily === "string");
  if (fontMetadata.length) {
    extensions["figma.rest.text-font.v1"] = jsonBytes(fontMetadata);
    issues.push({ sourceId, capability: "font-asset", outcome: "preserved-extension", reason: "Figma font family metadata is retained until an authorized Asset Service FontRef is available." });
  }
  const overrides = array(node.characterStyleOverrides);
  let styles: ImportedTextStyle[];
  if (!overrides?.length) styles = Array.from({ length: text.length }, () => linkedBase);
  else if (!isAscii(text) || overrides.length > text.length || overrides.some((entry) => !Number.isInteger(entry) || (entry as number) < 0)) {
    extensions["figma.rest.text-overrides.v1"] = jsonBytes({ styleOverrideTable: node.styleOverrideTable, characterStyleOverrides: node.characterStyleOverrides });
    issues.push({ sourceId, capability: "text-style-overrides", outcome: "preserved-extension", reason: "Only ASCII REST override indices are converted; Unicode override indexing remains opaque rather than risking invalid UTF-8 ranges." });
    styles = Array.from({ length: text.length }, () => linkedBase);
  } else {
    const table = record(node.styleOverrideTable) ?? {};
    let invalidOverridePreserved = false;
    styles = Array.from({ length: text.length }, (_, index) => {
      const override = overrides[index] ?? 0;
      const overrideStyle = override === 0 ? undefined : record(table[String(override)]);
      if (override !== 0 && !overrideStyle) {
        extensions["figma.rest.text-overrides.v1"] = jsonBytes({ styleOverrideTable: node.styleOverrideTable, characterStyleOverrides: node.characterStyleOverrides });
        issues.push({ sourceId, capability: "text-style-overrides", outcome: "preserved-extension", reason: `Figma style override ${override} is missing from styleOverrideTable.` });
        return linkedBase;
      }
      if (!overrideStyle) return linkedBase;
      const imported = importedTextStyle(overrideStyle, linkedBase);
      if (!imported && !invalidOverridePreserved) {
        invalidOverridePreserved = true;
        extensions["figma.rest.text-overrides.v1"] = jsonBytes({ styleOverrideTable: node.styleOverrideTable, characterStyleOverrides: node.characterStyleOverrides });
        issues.push({ sourceId, capability: "text-style-overrides", outcome: "preserved-extension", reason: `Figma style override ${override} contains an unsupported text style value.` });
      }
      return imported ?? linkedBase;
    });
  }
  const runs = textRuns(text, styles);
  const truncationValue = node.textTruncation;
  const truncation = string(truncationValue);
  const maxLinesValue = node.maxLines;
  const maxLines = maxLinesValue === null || maxLinesValue === undefined ? undefined : finite(maxLinesValue);
  const validTruncation = truncationValue === undefined || truncation === "DISABLED" || truncation === "ENDING";
  const validMaxLines = maxLinesValue === null || maxLinesValue === undefined
    || (maxLines !== undefined && Number.isSafeInteger(maxLines) && maxLines >= 1);
  const truncationCombinationValid = maxLines === undefined || truncation === "ENDING";
  if (!validTruncation || !validMaxLines || !truncationCombinationValid) {
    extensions["figma.rest.text-truncation.v1"] = jsonBytes({ textTruncation: node.textTruncation, maxLines: node.maxLines });
    issues.push({ sourceId, capability: "text-truncation", outcome: "preserved-extension", reason: "Invalid Figma textTruncation/maxLines values were preserved without changing Canonical text layout." });
  }
  const lineHeight = importedLineHeight(style, sourceId, issues, extensions);
  const paragraphIndent = importedParagraphIndent(style, sourceId, issues, extensions);
  const textWrapStyle = importedTextWrapStyle(style, sourceId, issues, extensions);
  const listType = importedTextListType(style, sourceId, issues, extensions);
  const listSpacing = importedListSpacing(style, sourceId, issues, extensions);
  const hangingList = importedHangingList(style, sourceId, issues, extensions);
  const hangingPunctuation = importedHangingPunctuation(style, sourceId, issues, extensions);
  const indentation = importedTextIndentation(style, sourceId, issues, extensions);
  const paragraphSpacing = finite(style.paragraphSpacing);
  if (paragraphSpacing !== undefined && paragraphSpacing < 0) {
    extensions["figma.rest.paragraph-spacing.v1"] = jsonBytes({ paragraphSpacing: style.paragraphSpacing });
    issues.push({
      sourceId,
      capability: "paragraph-spacing",
      outcome: "preserved-extension",
      reason: "A negative Figma paragraphSpacing value was preserved without creating invalid Canonical text properties.",
    });
  }
  return {
    extensions,
    properties: {
      runs,
      ...(text.length === 0 || textStyleId ? { baseStyle: linkedBase } : {}),
      paragraph: {
        alignment: textAlignment(string(style.textAlignHorizontal)),
        ...lineHeight,
        paragraphSpacing: paragraphSpacing !== undefined && paragraphSpacing >= 0 ? paragraphSpacing : 0,
        ...paragraphIndent,
        ...textWrapStyle,
        ...listType,
        ...listSpacing,
        ...hangingList,
        ...hangingPunctuation,
      },
      ...(indentation !== undefined && indentation !== (listType.listType ? 1 : 0)
        ? { paragraphStyleRuns: textParagraphRanges(text).map(({ start }) => ({ start, indentation })) }
        : {}),
      autoSize: textAutoSize(string(node.textAutoResize)),
      ...((validTruncation && validMaxLines && truncationCombinationValid && truncation === "ENDING")
        ? { textTruncation: "ending" as const, ...(maxLines === undefined ? {} : { maxLines }) }
        : {}),
    } satisfies DocumentTextProperties,
  };
}

function importedNodeTextStyleId(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  const styles = record(value);
  if (!styles) return false;
  const lower = styles.text;
  const upper = styles.TEXT;
  if (lower !== undefined && upper !== undefined && lower !== upper) return false;
  const id = lower ?? upper;
  if (id === undefined || id === null) return undefined;
  return typeof id === "string" && id.length > 0 && encoder.encode(id).byteLength <= 2_048 && !id.includes("\0") ? id : false;
}

function importedTextIndentation(
  style: JsonRecord,
  sourceId: string,
  issues: FigmaImportIssue[],
  extensions: Record<string, number[]>,
): number | undefined {
  if (style.indentation === undefined || style.indentation === null) return undefined;
  const value = finite(style.indentation);
  if (value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 100) return value;
  extensions["figma.rest.text-indentation.v1"] = jsonBytes({ indentation: style.indentation });
  issues.push({
    sourceId,
    capability: "text-indentation",
    outcome: "preserved-extension",
    reason: "An invalid Figma indentation value was preserved without changing Canonical list nesting.",
  });
  return undefined;
}

function importedTextListType(
  style: JsonRecord,
  sourceId: string,
  issues: FigmaImportIssue[],
  extensions: Record<string, number[]>,
): Pick<DocumentTextProperties["paragraph"], "listType"> {
  if (style.listOptions === undefined || style.listOptions === null) return {};
  const options = record(style.listOptions);
  const type = string(options?.type);
  if (type === "NONE") return {};
  if (type === "ORDERED") return { listType: "ordered" };
  if (type === "UNORDERED") return { listType: "unordered" };
  extensions["figma.rest.text-list-options.v1"] = jsonBytes({ listOptions: style.listOptions });
  issues.push({
    sourceId,
    capability: "text-list-options",
    outcome: "preserved-extension",
    reason: "An invalid Figma listOptions value was preserved without changing Canonical list layout.",
  });
  return {};
}

function importedListSpacing(
  style: JsonRecord,
  sourceId: string,
  issues: FigmaImportIssue[],
  extensions: Record<string, number[]>,
): Pick<DocumentTextProperties["paragraph"], "listSpacing"> {
  if (style.listSpacing === undefined || style.listSpacing === null) return {};
  const value = finite(style.listSpacing);
  if (value !== undefined && value >= 0) return value === 0 ? {} : { listSpacing: value };
  extensions["figma.rest.text-list-spacing.v1"] = jsonBytes({ listSpacing: style.listSpacing });
  issues.push({
    sourceId,
    capability: "text-list-spacing",
    outcome: "preserved-extension",
    reason: "An invalid Figma listSpacing value was preserved without changing Canonical list layout.",
  });
  return {};
}

function importedHangingList(
  style: JsonRecord,
  sourceId: string,
  issues: FigmaImportIssue[],
  extensions: Record<string, number[]>,
): Pick<DocumentTextProperties["paragraph"], "hangingList"> {
  if (style.hangingList === undefined || style.hangingList === null || style.hangingList === false) return {};
  if (style.hangingList === true) return { hangingList: true };
  extensions["figma.rest.text-hanging-list.v1"] = jsonBytes({ hangingList: style.hangingList });
  issues.push({
    sourceId,
    capability: "text-hanging-list",
    outcome: "preserved-extension",
    reason: "An invalid Figma hangingList value was preserved without changing Canonical list layout.",
  });
  return {};
}

function importedHangingPunctuation(
  style: JsonRecord,
  sourceId: string,
  issues: FigmaImportIssue[],
  extensions: Record<string, number[]>,
): Pick<DocumentTextProperties["paragraph"], "hangingPunctuation"> {
  if (style.hangingPunctuation === undefined || style.hangingPunctuation === null || style.hangingPunctuation === false) return {};
  if (style.hangingPunctuation === true) return { hangingPunctuation: true };
  extensions["figma.rest.text-hanging-punctuation.v1"] = jsonBytes({ hangingPunctuation: style.hangingPunctuation });
  issues.push({
    sourceId,
    capability: "text-hanging-punctuation",
    outcome: "preserved-extension",
    reason: "An invalid Figma hangingPunctuation value was preserved without changing Canonical text layout.",
  });
  return {};
}

function importedTextWrapStyle(
  style: JsonRecord,
  sourceId: string,
  issues: FigmaImportIssue[],
  extensions: Record<string, number[]>,
): Pick<DocumentTextProperties["paragraph"], "textWrapStyle"> {
  if (style.textWrapStyle === undefined || style.textWrapStyle === "AUTO") return {};
  if (style.textWrapStyle === "BALANCE") return { textWrapStyle: "balance" };
  if (style.textWrapStyle === "PRETTY") return { textWrapStyle: "pretty" };
  extensions["figma.rest.text-wrap-style.v1"] = jsonBytes({ textWrapStyle: style.textWrapStyle });
  issues.push({
    sourceId,
    capability: "text-wrap-style",
    outcome: "preserved-extension",
    reason: "An unknown Figma textWrapStyle value was preserved without changing Canonical wrapping.",
  });
  return {};
}

function importedParagraphIndent(
  style: JsonRecord,
  sourceId: string,
  issues: FigmaImportIssue[],
  extensions: Record<string, number[]>,
): Pick<DocumentTextProperties["paragraph"], "paragraphIndent"> {
  if (style.paragraphIndent === undefined) return {};
  const value = finite(style.paragraphIndent);
  if (value !== undefined && value >= 0) return value === 0 ? {} : { paragraphIndent: value };
  extensions["figma.rest.paragraph-indent.v1"] = jsonBytes({ paragraphIndent: style.paragraphIndent });
  issues.push({
    sourceId,
    capability: "paragraph-indent",
    outcome: "preserved-extension",
    reason: "An invalid Figma paragraphIndent value was preserved without changing Canonical text layout.",
  });
  return {};
}

function importedLineHeight(
  style: JsonRecord,
  sourceId: string,
  issues: FigmaImportIssue[],
  extensions: Record<string, number[]>,
): Pick<DocumentTextProperties["paragraph"], "lineHeight" | "lineHeightUnit"> {
  const pixelValue = positive(style.lineHeightPx);
  if (style.lineHeightUnit === undefined) return pixelValue === undefined ? {} : { lineHeight: pixelValue };

  const unit = string(style.lineHeightUnit);
  if (unit === "PIXELS" && pixelValue !== undefined) return { lineHeight: pixelValue };
  if (unit === "FONT_SIZE_%") {
    const percent = positive(style.lineHeightPercentFontSize);
    if (percent !== undefined) return { lineHeight: percent, lineHeightUnit: "percent" };
  }
  if (unit === "INTRINSIC_%") {
    const intrinsicPercent = style.lineHeightPercent === undefined ? 100 : positive(style.lineHeightPercent);
    if (intrinsicPercent === 100) return { lineHeightUnit: "auto" };
  }

  extensions["figma.rest.text-line-height.v1"] = jsonBytes({
    lineHeightPx: style.lineHeightPx,
    lineHeightPercent: style.lineHeightPercent,
    lineHeightPercentFontSize: style.lineHeightPercentFontSize,
    lineHeightUnit: style.lineHeightUnit,
  });
  issues.push({
    sourceId,
    capability: "text-line-height",
    outcome: "preserved-extension",
    reason: "The Figma REST line-height unit could not be represented losslessly; its pixel value is used as a visual fallback when valid.",
  });
  return pixelValue === undefined ? {} : { lineHeight: pixelValue };
}

function importedTextStyle(value: JsonRecord, fallback?: ImportedTextStyle): ImportedTextStyle | undefined {
  const fontSize = finite(value.fontSize) ?? fallback?.fontSize;
  const fontWeight = finite(value.fontWeight) ?? fallback?.fontWeight;
  const letterSpacing = finite(value.letterSpacing) ?? fallback?.letterSpacing ?? 0;
  const textCase = importedTextCase(value.textCase, fallback?.textCase);
  const hyperlink = importedHyperlink(value.hyperlink, fallback?.hyperlink);
  const textDecoration = importedTextDecoration(value.textDecoration, fallback?.textDecoration);
  const textDecorationStyle = importedTextDecorationStyle(value.textDecorationStyle, fallback?.textDecorationStyle);
  const textDecorationOffset = importedTextDecorationOffset(value.textDecorationOffset, fallback?.textDecorationOffset);
  const textDecorationThickness = importedTextDecorationThickness(value.textDecorationThickness, fallback?.textDecorationThickness);
  const textDecorationColor = importedTextDecorationColor(value.textDecorationColor, fallback?.textDecorationColor);
  const textDecorationSkipInk = value.textDecorationSkipInk === undefined
    ? fallback?.textDecorationSkipInk
    : value.textDecorationSkipInk === null
      ? undefined
      : typeof value.textDecorationSkipInk === "boolean"
        ? value.textDecorationSkipInk
        : null;
  const leadingTrim = value.leadingTrim === undefined
    ? fallback?.leadingTrim
    : value.leadingTrim === "CAP_HEIGHT"
      ? "capHeight" as const
      : value.leadingTrim === "NONE" || value.leadingTrim === null
        ? undefined
        : null;
  const openTypeFeatures = importedOpenTypeFeatures(value.openTypeFlags, fallback?.openTypeFeatures);
  const textStyleId = fallback?.textStyleId;
  if (fontSize === undefined || fontSize <= 0 || fontWeight === undefined || fontWeight <= 0 || !Number.isInteger(fontWeight) || textCase === null || hyperlink === false || textDecoration === false || textDecorationStyle === false || textDecorationOffset === false || textDecorationThickness === false || textDecorationColor === false || textDecorationSkipInk === null || leadingTrim === null || openTypeFeatures === false) return undefined;
  return { fontSize, fontWeight, italic: typeof value.italic === "boolean" ? value.italic : fallback?.italic ?? false, letterSpacing, ...(textCase ? { textCase } : {}), ...(hyperlink ? { hyperlink } : {}), ...(textDecoration ? { textDecoration } : {}), ...(textDecoration && textDecorationStyle ? { textDecorationStyle } : {}), ...(textDecoration && textDecorationOffset ? { textDecorationOffset } : {}), ...(textDecoration && textDecorationThickness ? { textDecorationThickness } : {}), ...(textDecoration === "underline" && textDecorationColor ? { textDecorationColor } : {}), ...(textDecoration === "underline" && textDecorationSkipInk === true ? { textDecorationSkipInk: true } : {}), ...(leadingTrim ? { leadingTrim } : {}), ...(openTypeFeatures && Object.keys(openTypeFeatures).length ? { openTypeFeatures } : {}), ...(textStyleId ? { textStyleId } : {}) };
}

function importedOpenTypeFeatures(value: unknown, fallback?: ImportedTextStyle["openTypeFeatures"]): ImportedTextStyle["openTypeFeatures"] | false {
  if (value === undefined) return fallback;
  if (value === null) return undefined;
  const flags = record(value);
  if (!flags || Object.keys(flags).length > 128) return false;
  const entries = Object.entries(flags).map(([rawTag, rawEnabled]) => [rawTag.toUpperCase(), rawEnabled] as const);
  if (entries.some(([tag, enabled]) => !/^[A-Z0-9]{4}$/.test(tag) || (enabled !== 0 && enabled !== 1))) return false;
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (entries.some(([tag], index) => index > 0 && entries[index - 1]![0] === tag)) return false;
  return Object.fromEntries(entries.map(([tag, enabled]) => [tag, enabled === 1]));
}

function importedTextDecorationColor(
  value: unknown,
  fallback?: ImportedTextStyle["textDecorationColor"],
): ImportedTextStyle["textDecorationColor"] | false {
  if (value === undefined) return fallback;
  if (value === null) return undefined;
  const wrapper = record(value);
  if (!wrapper) return false;
  if (wrapper.value === "AUTO") return undefined;
  const paint = record(wrapper.value);
  if (!paint || paint.type !== "SOLID" || paint.boundVariables !== undefined) return false;
  const rgb = record(paint.color);
  const red = finite(rgb?.r);
  const green = finite(rgb?.g);
  const blue = finite(rgb?.b);
  if (rgb?.a !== undefined || [red, green, blue].some((component) => component === undefined || component! < 0 || component! > 1)) return false;
  const visible = paint.visible === undefined ? true : paint.visible;
  const opacity = paint.opacity === undefined ? 1 : finite(paint.opacity);
  const blendMode = paintLayerBlendMode(paint.blendMode);
  if (typeof visible !== "boolean" || opacity === undefined || opacity < 0 || opacity > 1 || !blendMode || blendMode === "pass-through") return false;
  return {
    color: { space: "srgb", components: [red!, green!, blue!], alpha: 1 },
    visible,
    opacity,
    blendMode,
  };
}

function importedTextDecorationOffset(
  value: unknown,
  fallback?: ImportedTextStyle["textDecorationOffset"],
): ImportedTextStyle["textDecorationOffset"] | false {
  if (value === undefined) return fallback;
  const offset = record(value);
  if (!offset) return false;
  if (offset.unit === "AUTO") return undefined;
  const numeric = finite(offset.value);
  if (numeric === undefined || numeric < -10_000 || numeric > 10_000) return false;
  if (offset.unit === "PIXELS") return { value: numeric, unit: "pixels" };
  if (offset.unit === "PERCENT") return { value: numeric, unit: "percent" };
  return false;
}

function importedTextDecorationThickness(
  value: unknown,
  fallback?: ImportedTextStyle["textDecorationThickness"],
): ImportedTextStyle["textDecorationThickness"] | false {
  if (value === undefined) return fallback;
  const thickness = record(value);
  if (!thickness) return false;
  if (thickness.unit === "AUTO") return undefined;
  const numeric = finite(thickness.value);
  if (numeric === undefined || numeric < 0 || numeric > 10_000) return false;
  if (thickness.unit === "PIXELS") return { value: numeric, unit: "pixels" };
  if (thickness.unit === "PERCENT") return { value: numeric, unit: "percent" };
  return false;
}

function importedTextDecorationStyle(
  value: unknown,
  fallback?: ImportedTextStyle["textDecorationStyle"],
): ImportedTextStyle["textDecorationStyle"] | false {
  if (value === undefined) return fallback;
  if (value === null || value === "SOLID") return undefined;
  if (value === "WAVY") return "wavy";
  if (value === "DOTTED") return "dotted";
  return false;
}

function importedTextDecoration(
  value: unknown,
  fallback?: ImportedTextStyle["textDecoration"],
): ImportedTextStyle["textDecoration"] | false {
  if (value === undefined) return fallback;
  if (value === "NONE") return undefined;
  if (value === "UNDERLINE") return "underline";
  if (value === "STRIKETHROUGH") return "strikethrough";
  return false;
}

function importedHyperlink(
  value: unknown,
  fallback?: ImportedTextStyle["hyperlink"],
): ImportedTextStyle["hyperlink"] | false {
  if (value === undefined) return fallback;
  if (value === null) return undefined;
  const target = record(value);
  const type = string(target?.type);
  const targetValue = string(target?.value);
  if ((type !== "URL" && type !== "NODE") || !targetValue || targetValue.includes("\0") || encoder.encode(targetValue).byteLength > 2_048) return false;
  return { type, value: targetValue };
}

function importedTextCase(value: unknown, fallback?: ImportedTextStyle["textCase"]): ImportedTextStyle["textCase"] | null {
  if (value === undefined || value === "ORIGINAL") return value === undefined ? fallback : undefined;
  if (value === "UPPER") return "upper";
  if (value === "LOWER") return "lower";
  if (value === "TITLE") return "title";
  if (value === "SMALL_CAPS") return "smallCaps";
  if (value === "SMALL_CAPS_FORCED") return "smallCapsForced";
  return null;
}

function textRuns(text: string, styles: ImportedTextStyle[]): DocumentTextProperties["runs"] {
  if (!text.length || !styles.length) return [];
  const runs: DocumentTextProperties["runs"] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index += 1) {
    if (index !== text.length && sameTextStyle(styles[start]!, styles[index]!)) continue;
    const style = styles[start]!;
    runs.push({ start: encoder.encode(text.slice(0, start)).byteLength, end: encoder.encode(text.slice(0, index)).byteLength, ...style });
    start = index;
  }
  return runs;
}

function sameTextStyle(left: ImportedTextStyle, right: ImportedTextStyle) { return left.fontSize === right.fontSize && left.fontWeight === right.fontWeight && left.italic === right.italic && left.letterSpacing === right.letterSpacing && left.textCase === right.textCase && JSON.stringify(left.hyperlink) === JSON.stringify(right.hyperlink) && left.textDecoration === right.textDecoration && left.textDecorationStyle === right.textDecorationStyle && JSON.stringify(left.textDecorationOffset) === JSON.stringify(right.textDecorationOffset) && JSON.stringify(left.textDecorationThickness) === JSON.stringify(right.textDecorationThickness) && JSON.stringify(left.textDecorationColor) === JSON.stringify(right.textDecorationColor) && left.textDecorationSkipInk === right.textDecorationSkipInk && left.leadingTrim === right.leadingTrim && JSON.stringify(left.openTypeFeatures) === JSON.stringify(right.openTypeFeatures) && left.textStyleId === right.textStyleId; }
function textAlignment(value: string | undefined): DocumentTextProperties["paragraph"]["alignment"] { return value === "CENTER" ? "center" : value === "RIGHT" ? "right" : value === "JUSTIFIED" ? "justify" : "left"; }
function textAutoSize(value: string | undefined): DocumentTextProperties["autoSize"] { return value === "HEIGHT" ? "height" : value === "WIDTH_AND_HEIGHT" ? "widthAndHeight" : "fixed"; }
function positive(value: unknown) { const number = finite(value); return number !== undefined && number > 0 ? number : undefined; }
function isAscii(value: string) { return /^[\x00-\x7f]*$/.test(value); }

function effects(value: unknown, sourceId: string, issues: FigmaImportIssue[]) {
  const extensions: Record<string, number[]> = {};
  const effects: DocumentEffect[] = [];
  const unsupported: unknown[] = [];
  for (const effect of array(value) ?? []) {
    const item = record(effect);
    const type = string(item?.type);
    const radius = finite(item?.radius) ?? 0;
    const visible = item?.visible !== false;
    const color = figmaColor(item?.color);
    if ((type === "DROP_SHADOW" || type === "INNER_SHADOW") && color) {
      const shadow = { offsetX: finite(item?.offset && record(item.offset)?.x) ?? 0, offsetY: finite(item?.offset && record(item.offset)?.y) ?? 0, blurRadius: radius, spread: finite(item?.spread) ?? 0, color, visible };
      effects.push(type === "DROP_SHADOW" ? { dropShadow: shadow } : { innerShadow: shadow });
    } else if (type === "LAYER_BLUR") effects.push({ layerBlur: { radius, visible } });
    else if (type === "BACKGROUND_BLUR") effects.push({ backgroundBlur: { radius, visible } });
    else unsupported.push(effect);
  }
  if (unsupported.length) {
    extensions["figma.rest.effects.v1"] = jsonBytes(unsupported);
    issues.push({ sourceId, capability: "effect", outcome: "preserved-extension", reason: "Unsupported Figma effects are retained as opaque import metadata." });
  }
  return { effects, extensions };
}

function leadingDropShadow(effects: DocumentEffect[]): CanvasNode["dropShadow"] {
  const first = effects[0];
  return first && "dropShadow" in first ? first.dropShadow : undefined;
}

function maskState(node: JsonRecord, sourceId: string, issues: FigmaImportIssue[]) {
  const extensions: Record<string, number[]> = {};
  if (node.isMask !== true) return { alpha: false, extensions };
  const type = string(node.maskType) ?? "ALPHA";
  extensions["figma.mask.type"] = bytes(type);
  if (type === "ALPHA") return { alpha: true, extensions };
  issues.push({ sourceId, capability: "mask", outcome: "preserved-extension", reason: `Figma ${type} mask is not reinterpreted as alpha.` });
  return { alpha: false, extensions };
}

/**
 * Figma export presets are not a rendering property: applying them during
 * import would unexpectedly export a document, and this Canonical schema has
 * no per-node preset contract yet. Keep the source bytes durable and make the
 * omission observable until that contract is introduced.
 */
function exportSettings(value: unknown, sourceId: string, issues: FigmaImportIssue[], extensions: Record<string, number[]>) {
  if (value === undefined) return;
  extensions["figma.rest.export-settings.v1"] = jsonBytes(value);
  issues.push({
    sourceId,
    capability: "export-settings",
    outcome: "preserved-extension",
    reason: "Figma export settings are retained as source metadata; they are not silently applied to MakeFigma's explicit export controls.",
  });
}

function localGeometry(node: JsonRecord, root: boolean) {
  const transform = array(node.relativeTransform);
  const first = transform && array(transform[0]);
  const second = transform && array(transform[1]);
  const box = record(node.absoluteBoundingBox);
  // With `geometry=paths`, Figma supplies untransformed `size`; use it before
  // absoluteBoundingBox, whose width/height already include rotation/scaling.
  const localSize = record(node.size);
  const width = finite(localSize?.x) ?? finite(box?.width);
  const height = finite(localSize?.y) ?? finite(box?.height);
  if (width === undefined || height === undefined || width < 0 || height < 0) return undefined;
  if (first?.length === 3 && second?.length === 3 && first.every((value) => finite(value) !== undefined) && second.every((value) => finite(value) !== undefined)) {
    const a = finite(first[0])!;
    const c = finite(first[1])!;
    const e = finite(first[2])!;
    const b = finite(second[0])!;
    const d = finite(second[1])!;
    const f = finite(second[2])!;
    if (Math.abs(a * d - b * c) <= 1e-12) return undefined;
    return { x: e, y: f, width, height, rotation: Math.atan2(b, a) * 180 / Math.PI, relativeTransform: { a, b, c, d, e, f } };
  }
  if (!root) return undefined;
  const x = finite(box?.x);
  const y = finite(box?.y);
  return x === undefined || y === undefined ? undefined : { x, y, width, height, rotation: 0, relativeTransform: undefined };
}

function editablePaints(value: unknown): DocumentPaint[] {
  return (array(value) ?? []).flatMap((paint) => {
    const item = record(paint);
    const mapped = item && item.visible !== false ? editablePaint(item) : undefined;
    return mapped ? [mapped] : [];
  });
}

function transparentPaint(): DocumentPaint {
  return {
    css: "#00000000",
    color: { space: "srgb", components: [0, 0, 0], alpha: 0 },
  };
}

function hasUneditablePaint(value: unknown) {
  return (array(value) ?? []).some((paint) => {
    const item = record(paint);
    return Boolean(item && (item.visible === false || !editablePaint(item)));
  });
}

/** Figma linear gradients carry three normalized handles. Canonical Canvas/SVG
 * has an axis only, so it is equivalent exactly when the width handle is
 * perpendicular to that axis. A skewed width handle changes the color-line
 * direction and must remain an external extension instead of being guessed. */
function editablePaint(item: JsonRecord): DocumentPaint | undefined {
  const blendMode = string(item.blendMode);
  if (blendMode && !["NORMAL", "LINEAR_BURN", "LINEAR_DODGE"].includes(blendMode)) return undefined;
  const opacity = finite(item.opacity) ?? 1;
  if (item.type === "SOLID") {
    const color = figmaColor(item.color, opacity);
    return color ? { css: cssColor(color), color } : undefined;
  }
  if (item.type === "GRADIENT_LINEAR") {
    const gradient = linearGradient(item, opacity);
    return gradient ? { css: cssColor(gradient.stops[0]!.color), gradient } : undefined;
  }
  if (item.type === "GRADIENT_RADIAL" || item.type === "GRADIENT_ANGULAR" || item.type === "GRADIENT_DIAMOND") {
    const gradientPaint = nonLinearGradient(item, opacity);
    return gradientPaint ? { css: cssColor(gradientPaint.stops[0]!.color), gradientPaint } : undefined;
  }
  return undefined;
}

function linearGradient(item: JsonRecord, opacity: number): DocumentLinearGradient | undefined {
  const handles = array(item.gradientHandlePositions);
  if (!handles || handles.length !== 3) return undefined;
  const start = gradientPoint(handles[0]);
  const end = gradientPoint(handles[1]);
  const width = gradientPoint(handles[2]);
  if (!start || !end || !width) return undefined;
  const axisX = end[0] - start[0];
  const axisY = end[1] - start[1];
  const widthX = width[0] - start[0];
  const widthY = width[1] - start[1];
  const axisLengthSquared = axisX * axisX + axisY * axisY;
  const widthLengthSquared = widthX * widthX + widthY * widthY;
  if (axisLengthSquared === 0 || widthLengthSquared === 0) return undefined;
  // Relative tolerance covers REST's ordinary floating-point serialization but
  // never turns a genuinely skewed Figma gradient into a different Canvas one.
  if (Math.abs(axisX * widthX + axisY * widthY) > 1e-6 * Math.sqrt(axisLengthSquared * widthLengthSquared)) return undefined;
  const sourceStops = array(item.gradientStops);
  if (!sourceStops || sourceStops.length < 2 || sourceStops.length > 16) return undefined;
  const stops: DocumentLinearGradient["stops"] = [];
  for (const source of sourceStops) {
    const stop = record(source);
    const position = finite(stop?.position);
    const color = stop && figmaColor(stop.color, opacity);
    if (position === undefined || position < 0 || position > 1 || !color || (stops.length > 0 && position < stops[stops.length - 1]!.position)) return undefined;
    stops.push({ position, color });
  }
  return { start, end, stops };
}

function nonLinearGradient(item: JsonRecord, opacity: number): DocumentGradientPaint | undefined {
  const handles = array(item.gradientHandlePositions);
  if (!handles || handles.length !== 3) return undefined;
  const start = gradientPoint(handles[0]);
  const end = gradientPoint(handles[1]);
  const width = gradientPoint(handles[2]);
  if (!start || !end || !width) return undefined;
  const gradientToLocal: RelativeTransform = {
    a: end[0] - start[0],
    b: end[1] - start[1],
    c: 2 * (start[0] - width[0]),
    d: 2 * (start[1] - width[1]),
    e: width[0],
    f: width[1],
  };
  const determinant = gradientToLocal.a * gradientToLocal.d - gradientToLocal.b * gradientToLocal.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) return undefined;
  const transform: RelativeTransform = {
    a: gradientToLocal.d / determinant,
    b: -gradientToLocal.b / determinant,
    c: -gradientToLocal.c / determinant,
    d: gradientToLocal.a / determinant,
    e: (gradientToLocal.c * gradientToLocal.f - gradientToLocal.d * gradientToLocal.e) / determinant,
    f: (gradientToLocal.b * gradientToLocal.e - gradientToLocal.a * gradientToLocal.f) / determinant,
  };
  const sourceStops = array(item.gradientStops);
  if (!sourceStops || sourceStops.length < 2 || sourceStops.length > 16) return undefined;
  const stops: DocumentGradientPaint["stops"] = [];
  for (const source of sourceStops) {
    const stop = record(source);
    const position = finite(stop?.position);
    const color = stop && figmaColor(stop.color, opacity);
    if (position === undefined || position < 0 || position > 1 || !color || (stops.length > 0 && position < stops[stops.length - 1]!.position)) return undefined;
    stops.push({ position, color });
  }
  return {
    kind: item.type === "GRADIENT_RADIAL" ? "radial" : item.type === "GRADIENT_ANGULAR" ? "angular" : "diamond",
    transform,
    stops,
  };
}

function gradientPoint(value: unknown): [number, number] | undefined {
  const point = record(value);
  const x = finite(point?.x);
  const y = finite(point?.y);
  return x === undefined || y === undefined ? undefined : [x, y];
}

type ImportedStrokeAppearance = Partial<Pick<CanvasNode, "strokeWidth" | "strokeCapStart" | "strokeCapEnd" | "strokeJoin" | "strokeMiterLimit" | "strokeDashPattern" | "strokeWeights" | "strokeAlign" | "radius" | "cornerRadii" | "cornerSmoothing" | "arcData">>;

function strokeAppearance(node: JsonRecord, kind: NodeKind, sourceId: string, issues: FigmaImportIssue[], extensions: Record<string, number[]>): ImportedStrokeAppearance {
  const appearance: ImportedStrokeAppearance = {};
  const unsupported: Record<string, unknown> = {};
  const strokeWeight = finite(node.strokeWeight);
  if (node.strokeWeight !== undefined) {
    if (strokeWeight === undefined || strokeWeight < 0) unsupported.strokeWeight = node.strokeWeight;
    else appearance.strokeWidth = strokeWeight;
  }
  const cap = strokeCap(string(node.strokeCap));
  if (node.strokeCap !== undefined) {
    if (!cap) unsupported.strokeCap = node.strokeCap;
    else { appearance.strokeCapStart = cap; appearance.strokeCapEnd = cap; }
  }
  const join = strokeJoin(string(node.strokeJoin));
  if (node.strokeJoin !== undefined) {
    if (!join) unsupported.strokeJoin = node.strokeJoin;
    else appearance.strokeJoin = join;
  }
  const dashes = dashPattern(node.strokeDashes);
  if (node.strokeDashes !== undefined) {
    if (!dashes) unsupported.strokeDashes = node.strokeDashes;
    else appearance.strokeDashPattern = dashes;
  }
  if (node.strokeMiterAngle !== undefined) unsupported.strokeMiterAngle = node.strokeMiterAngle;
  const arc = kind === "ellipse" ? ellipseArc(node.arcData) : undefined;
  if (node.arcData !== undefined && !arc) unsupported.arcData = node.arcData;
  else if (arc) appearance.arcData = arc;
  const align = strokeAlign(string(node.strokeAlign));
  if (node.strokeAlign !== undefined) {
    const canAlign = align === "inside" || (!arc && (kind === "frame" || kind === "rectangle" || kind === "ellipse" || kind === "polygon" || kind === "star"));
    if (!align || !canAlign) unsupported.strokeAlign = node.strokeAlign;
    else appearance.strokeAlign = align;
  }
  const weights = individualStrokeWeights(node.individualStrokeWeights);
  if (node.individualStrokeWeights !== undefined) {
    if (!weights || (kind !== "frame" && kind !== "rectangle")) unsupported.individualStrokeWeights = node.individualStrokeWeights;
    else appearance.strokeWeights = weights;
  }
  const corners = cornerAppearance(node, kind);
  if (corners.unsupported) unsupported.corners = corners.unsupported;
  Object.assign(appearance, corners.appearance);
  const complexStroke = record(node.complexStrokeProperties);
  // Figma emits an empty object for the default/basic complex-stroke value.
  // Only a populated non-BASIC value needs to remain an explicit fallback.
  if (complexStroke && Object.keys(complexStroke).length > 0 && string(complexStroke.type) !== "BASIC") unsupported.complexStrokeProperties = node.complexStrokeProperties;
  if (array(node.variableWidthPoints)?.length) unsupported.variableWidthPoints = node.variableWidthPoints;
  if (Object.keys(unsupported).length) {
    extensions["figma.rest.unsupported-stroke.v1"] = jsonBytes(unsupported);
    issues.push({ sourceId, capability: "stroke-appearance", outcome: "preserved-extension", reason: "Figma stroke/corner data outside the Canonical basic-stroke subset was preserved without coercion." });
  }
  return appearance;
}

function strokeCap(value: string | undefined): StrokeCap | undefined {
  const map: Record<string, StrokeCap> = { NONE: "none", ROUND: "round", SQUARE: "square", LINE_ARROW: "arrowLines", TRIANGLE_ARROW: "arrowEquilateral", DIAMOND_FILLED: "diamondFilled", TRIANGLE_FILLED: "triangleFilled", CIRCLE_FILLED: "circleFilled" };
  return value ? map[value] : undefined;
}
function strokeJoin(value: string | undefined): StrokeJoin | undefined { return value === "MITER" ? "miter" : value === "BEVEL" ? "bevel" : value === "ROUND" ? "round" : undefined; }
function strokeAlign(value: string | undefined): StrokeAlign | undefined { return value === "INSIDE" ? "inside" : value === "OUTSIDE" ? "outside" : value === "CENTER" ? "center" : undefined; }
function dashPattern(value: unknown): number[] | undefined {
  const dashes = array(value);
  if (!dashes || dashes.length > 32) return undefined;
  const pattern = dashes.map(finite);
  return pattern.some((dash) => dash === undefined || dash! < 0) || (pattern.length > 0 && !pattern.some((dash) => dash! > 0)) ? undefined : pattern as number[];
}
function individualStrokeWeights(value: unknown): [number, number, number, number] | undefined {
  const weights = record(value);
  const top = finite(weights?.top), right = finite(weights?.right), bottom = finite(weights?.bottom), left = finite(weights?.left);
  return [top, right, bottom, left].some((weight) => weight === undefined || weight! < 0) ? undefined : [top!, right!, bottom!, left!];
}
function ellipseArc(value: unknown): CanvasNode["arcData"] | undefined {
  return fromFigmaPluginArcData(value);
}
function cornerAppearance(node: JsonRecord, kind: NodeKind): { appearance: Partial<Pick<CanvasNode, "radius" | "cornerRadii" | "cornerSmoothing">>; unsupported?: Record<string, unknown> } {
  if (node.cornerRadius === undefined && node.rectangleCornerRadii === undefined && node.cornerSmoothing === undefined) return { appearance: {} };
  if (kind === "connector") {
    const unsupported = node.rectangleCornerRadii === undefined && node.cornerSmoothing === undefined
      ? undefined
      : { rectangleCornerRadii: node.rectangleCornerRadii, cornerSmoothing: node.cornerSmoothing };
    return { appearance: {}, ...(unsupported ? { unsupported } : {}) };
  }
  if (kind !== "frame" && kind !== "rectangle" && kind !== "section") return { appearance: {}, unsupported: { cornerRadius: node.cornerRadius, rectangleCornerRadii: node.rectangleCornerRadii, cornerSmoothing: node.cornerSmoothing } };
  const appearance: Partial<Pick<CanvasNode, "radius" | "cornerRadii" | "cornerSmoothing">> = {};
  const unsupported: Record<string, unknown> = {};
  const radius = finite(node.cornerRadius);
  if (node.cornerRadius !== undefined) {
    if (radius === undefined || radius < 0) unsupported.cornerRadius = node.cornerRadius;
    else appearance.radius = radius;
  }
  if (node.rectangleCornerRadii !== undefined) {
    const values = array(node.rectangleCornerRadii)?.map(finite);
    if (!values || values.length !== 4 || values.some((value) => value === undefined || value! < 0)) unsupported.rectangleCornerRadii = node.rectangleCornerRadii;
    else appearance.cornerRadii = [values[0]!, values[1]!, values[2]!, values[3]!];
  }
  const smoothing = finite(node.cornerSmoothing);
  if (node.cornerSmoothing !== undefined) {
    if (smoothing === undefined || smoothing < 0 || smoothing > 1) unsupported.cornerSmoothing = node.cornerSmoothing;
    else appearance.cornerSmoothing = smoothing;
  }
  return { appearance, unsupported: Object.keys(unsupported).length ? unsupported : undefined };
}

function figmaColor(value: unknown, opacity = 1): DocumentColor | undefined {
  const color = record(value);
  const red = finite(color?.r);
  const green = finite(color?.g);
  const blue = finite(color?.b);
  const alpha = finite(color?.a) ?? 1;
  if ([red, green, blue].some((component) => component === undefined)) return undefined;
  return { space: "srgb", components: [clamp(red!, 0, 1), clamp(green!, 0, 1), clamp(blue!, 0, 1)], alpha: clamp(alpha * opacity, 0, 1) };
}

function cssColor(color: DocumentColor) {
  const hex = color.components.map((component) => Math.round(component * 255).toString(16).padStart(2, "0")).join("");
  const alpha = Math.round(color.alpha * 255).toString(16).padStart(2, "0");
  return `#${hex}${alpha === "ff" ? "" : alpha}`;
}

function blend(value: unknown, sourceId: string, issues: FigmaImportIssue[], extensions: Record<string, number[]>): BlendMode {
  const map: Record<string, BlendMode> = {
    NORMAL: "normal", MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten",
    COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn", HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light",
    DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity", PASS_THROUGH: "pass-through",
    LINEAR_BURN: "linear-burn", LINEAR_DODGE: "linear-dodge",
  };
  const mode = string(value) ?? "NORMAL";
  if (map[mode]) return map[mode];
  extensions["figma.rest.blend-mode.v1"] = bytes(mode);
  issues.push({ sourceId, capability: "blend-mode", outcome: "preserved-extension", reason: `Figma ${mode} is not silently mapped to NORMAL.` });
  return "normal";
}

function booleanOperation(value: unknown, sourceId: string, issues: FigmaImportIssue[], extensions: Record<string, number[]>) {
  const map = { UNION: "union", INTERSECT: "intersect", SUBTRACT: "subtract", EXCLUDE: "exclude" } as const;
  const operation = string(value) ?? "UNION";
  if (operation in map) return map[operation as keyof typeof map];
  extensions["figma.rest.boolean-operation.v1"] = bytes(operation);
  issues.push({ sourceId, capability: "boolean-operation", outcome: "preserved-extension", reason: `Figma ${operation} is not silently changed to UNION.` });
  return undefined;
}

function parametricShape(kind: NodeKind, node: JsonRecord, sourceId: string, issues: FigmaImportIssue[], extensions: Record<string, number[]>) {
  if (kind !== "polygon" && kind !== "star") return undefined;
  const pointCount = finite(node.pointCount);
  if (pointCount === undefined || !Number.isInteger(pointCount) || pointCount < 3 || pointCount > 100) {
    if (pointCount !== undefined) {
      extensions["figma.rest.parametric-shape.v1"] = jsonBytes({ pointCount, innerRadius: node.innerRadius });
      issues.push({ sourceId, capability: "parametric-shape", outcome: "preserved-extension", reason: "Figma pointCount is outside Phase 2's 3–100 editable range." });
    }
    return undefined;
  }
  if (kind === "polygon") return { kind, pointCount } as const;
  const innerRatio = finite(node.innerRadius) ?? finite(node.innerRatio) ?? 0.5;
  if (innerRatio <= 0 || innerRatio >= 1) {
    extensions["figma.rest.parametric-shape.v1"] = jsonBytes({ pointCount, innerRadius: node.innerRadius });
    issues.push({ sourceId, capability: "parametric-shape", outcome: "preserved-extension", reason: "Figma Star inner radius is outside the open 0–1 range." });
    return undefined;
  }
  return { kind, pointCount, innerRatio } as const;
}

function alignment(value: string | undefined, counterAxis: boolean): AutoLayoutAlignment {
  if (value === "CENTER") return "center";
  if (value === "MAX") return "end";
  if (value === "SPACE_BETWEEN" && !counterAxis) return "spaceBetween";
  if (value === "BASELINE" && counterAxis) return "baseline";
  return "start";
}
function childAlignment(value: string | undefined): DocumentAutoLayout["alignSelf"] {
  return value === "MIN" ? "start" : value === "CENTER" ? "center" : value === "MAX" ? "end" : undefined;
}
function sizing(value: string | undefined): DocumentAutoLayout["primarySizing"] {
  return value === "HUG" ? "hug" : value === "FILL" ? "fill" : "fixed";
}
function constraint(value: string | undefined): ConstraintType | undefined {
  return value === "MIN" ? "min" : value === "CENTER" ? "center" : value === "MAX" ? "max" : value === "STRETCH" ? "stretch" : value === "SCALE" ? "scale" : undefined;
}
function figmaPaths(value: unknown): Array<{ path: string; windingRule?: string }> | undefined {
  const paths = array(value);
  if (!paths?.length) return undefined;
  const mapped: Array<{ path: string; windingRule?: string }> = [];
  for (const source of paths) {
    const entry = record(source);
    const path = string(entry?.path);
    if (!entry || path === undefined) return undefined;
    mapped.push({ path, windingRule: string(entry.windingRule) });
  }
  return mapped;
}
function svgGeometryContainsArc(value: unknown) {
  return (array(value) ?? []).some((entry) => /[Aa]/.test(string(record(entry)?.path) ?? ""));
}
function svgPathBytes(node: JsonRecord): number { return (array(node.fillGeometry) ?? []).reduce<number>((total, entry) => total + encoder.encode(string(record(entry)?.path) ?? "").byteLength, 0); }
function imageFillTarget(node: CanvasNode) {
  return !node.locked && imageNodeTargetKind(node.kind);
}
function imageNodeTargetKind(kind: NodeKind) {
  return ["frame", "section", "rectangle", "ellipse", "image"].includes(kind);
}
function imagePaintStackTarget(node: CanvasNode) {
  return !node.locked && imagePaintStackTargetKind(node.kind);
}
function imagePaintStackTargetKind(kind: NodeKind) {
  return !["group", "booleanOperation", "slice", "text"].includes(kind);
}

function componentMetadata(
  node: JsonRecord,
  catalog: JsonRecord | undefined,
  canonicalId: string,
  extensions: Record<string, number[]>,
  sourceId: string,
  issues: FigmaImportIssue[],
): NonNullable<CanvasNode["componentMetadata"]> {
  const rawDefinitions = record(node.componentPropertyDefinitions);
  const definitions: NonNullable<CanvasNode["componentMetadata"]>["componentPropertyDefinitions"] = {};
  let preservedDefinition = false;
  for (const [name, raw] of Object.entries(rawDefinitions ?? {})) {
    const definition = record(raw);
    const type = string(definition?.type);
    const defaultValue = definition?.defaultValue;
    if (!definition || !["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT", "SLOT"].includes(type ?? "") || (defaultValue !== undefined && typeof defaultValue !== "string" && typeof defaultValue !== "boolean")) {
      preservedDefinition = true;
      continue;
    }
    definitions[name] = {
      type: type as NonNullable<CanvasNode["componentMetadata"]>["componentPropertyDefinitions"][string]["type"],
      ...(defaultValue === undefined ? {} : { defaultValue }),
      ...(string(definition.description) === undefined ? {} : { description: string(definition.description) }),
    };
  }
  if (preservedDefinition) {
    extensions["figma.rest.component-properties.v1"] = jsonBytes(node.componentPropertyDefinitions);
    issues.push({ sourceId, capability: "component-properties", outcome: "preserved-extension", reason: "Unsupported Component property definitions were retained without inventing editable values." });
  }
  return {
    key: string(catalog?.key) ?? string(node.key) ?? canonicalId,
    remote: catalog?.remote === true || node.remote === true,
    description: string(catalog?.description) ?? string(node.description) ?? "",
    descriptionMarkdown: string(catalog?.descriptionMarkdown) ?? string(node.descriptionMarkdown) ?? "",
    documentationLinks: documentationLinks(catalog?.documentationLinks ?? node.documentationLinks),
    componentPropertyDefinitions: definitions,
  };
}

function componentSetMetadata(
  node: JsonRecord,
  catalog: JsonRecord | undefined,
  canonicalId: string,
  extensions: Record<string, number[]>,
  sourceId: string,
  issues: FigmaImportIssue[],
): NonNullable<CanvasNode["componentSetMetadata"]> {
  const rawVariants = record(catalog?.variantGroupProperties ?? node.variantGroupProperties);
  const variants: NonNullable<CanvasNode["componentSetMetadata"]>["variantGroupProperties"] = {};
  let preservedVariant = false;
  for (const [name, raw] of Object.entries(rawVariants ?? {})) {
    const values = array(record(raw)?.values);
    if (!values || !values.every((value) => typeof value === "string")) {
      preservedVariant = true;
      continue;
    }
    variants[name] = { values: values as string[] };
  }
  if (preservedVariant || node.componentPropertyDefinitions !== undefined) {
    extensions["figma.rest.component-set-properties.v1"] = jsonBytes({ variantGroupProperties: rawVariants, componentPropertyDefinitions: node.componentPropertyDefinitions });
    issues.push({ sourceId, capability: "component-set-properties", outcome: "preserved-extension", reason: "The supported variant value list was mapped; remaining ComponentSet property definitions stay preserved metadata." });
  }
  return {
    key: string(catalog?.key) ?? string(node.key) ?? canonicalId,
    remote: catalog?.remote === true || node.remote === true,
    description: string(catalog?.description) ?? string(node.description) ?? "",
    descriptionMarkdown: string(catalog?.descriptionMarkdown) ?? string(node.descriptionMarkdown) ?? "",
    documentationLinks: documentationLinks(catalog?.documentationLinks ?? node.documentationLinks),
    variantGroupProperties: variants,
  };
}

function documentationLinks(value: unknown): Array<{ uri: string; name?: string }> {
  return (array(value) ?? []).flatMap((raw) => {
    const link = record(raw);
    const uri = string(link?.uri);
    if (!uri) return [];
    const name = string(link?.name);
    return [{ uri, ...(name ? { name } : {}) }];
  });
}

function validAsset(asset: DocumentAsset) {
  const dimensions = asset.pixelWidth === undefined && asset.pixelHeight === undefined
    || Number.isSafeInteger(asset.pixelWidth) && asset.pixelWidth! > 0 && Number.isSafeInteger(asset.pixelHeight) && asset.pixelHeight! > 0;
  return isStableId(asset.assetId)
    && /^[0-9a-f]{64}$/i.test(asset.contentHash)
    && asset.mediaType.startsWith("image/")
    && Number.isSafeInteger(asset.byteLength)
    && asset.byteLength > 0
    && dimensions;
}
function sameAsset(left: DocumentAsset, right: DocumentAsset) {
  return left.assetId === right.assetId
    && left.contentHash.toLowerCase() === right.contentHash.toLowerCase()
    && left.mediaType === right.mediaType
    && left.byteLength === right.byteLength
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight;
}
function record(value: unknown): JsonRecord | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined; }
function array(value: unknown): unknown[] | undefined { return Array.isArray(value) ? value : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function finite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function bytes(value: string) { return [...encoder.encode(value)]; }
function jsonBytes(value: unknown) { return bytes(JSON.stringify(value)); }
/** Figma REST preserves `children` order. Translate it directly to sparse
 * canonical keys so local UUID allocation can never reorder imported layers. */
function orderedPositionId(index: number, count: number) {
  const max = 1n << 128n;
  const key = (BigInt(index + 1) * max / BigInt(count + 1)).toString(16).padStart(32, "0");
  return `${key}:00000000000000000000000000000000`;
}
function positiveLimit(value: number | undefined, fallback: number) { return Number.isSafeInteger(value) && value! > 0 ? value! : fallback; }
function isStableId(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
