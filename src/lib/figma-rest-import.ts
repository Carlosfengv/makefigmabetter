import {
  createNode,
  type AutoLayoutAlignment,
  type BlendMode,
  type CanvasNode,
  type CanvasPage,
  type ConstraintType,
  type DocumentAutoLayout,
  type DocumentAsset,
  type DocumentColor,
  type DocumentEffect,
  type DocumentLinearGradient,
  type DocumentPaint,
  type DocumentTextProperties,
  type EditorCommand,
  type NodeKind,
  type StrokeAlign,
  type StrokeCap,
  type StrokeJoin,
} from "./editor-protocol";
import { parseFigmaSvgPaths } from "./figma-svg-path";
import { fromFigmaPluginArcData } from "./figma-plugin-node-projection";
import { coreProjectionNode, resolveCoreBatch, type CoreBatchCommand, type ResolvedCoreBatch } from "./transaction-batch";

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

/**
 * Produces one all-or-nothing Core batch. Page records deliberately precede
 * scene nodes because every `CreateInPage` is validated against the evolving
 * transaction state. The caller can use the returned batch with the normal
 * WASM and remote-operation paths; no Figma network access happens here.
 */
export function resolveFigmaRestImportBatch(plan: FigmaRestImportPlan): ResolvedCoreBatch | undefined {
  const pageIds = new Set(plan.pages.map((page) => page.id));
  if (!plan.pages.length || pageIds.size !== plan.pages.length || plan.nodes.some((node) => !node.pageId || !pageIds.has(node.pageId))) return undefined;
  const nodes = resolveCoreBatch([], plan.nodeCommands);
  if (!nodes) return undefined;
  return {
    ...nodes,
    batch: [
      ...plan.pages.map((page) => ({ type: "createPage" as const, page: structuredClone(page) })),
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
  const candidates = new Map<string, FigmaRestAuthorizedAsset[]>();
  const registration = new Map<string, DocumentAsset>();

  for (const entry of authorized) {
    const { request, asset } = entry;
    const sourceId = request.sourceId;
    if (!validAsset(asset)) {
      issues.push({ sourceId, capability: "image-asset", outcome: "rejected", reason: "The authorized Asset Service result is not a valid raster Asset record." });
      continue;
    }
    const existing = assetById.get(asset.assetId) ?? registration.get(asset.assetId);
    if (existing && !sameAsset(existing, asset)) {
      issues.push({ sourceId, capability: "image-asset", outcome: "rejected", reason: "An AssetId already exists with different immutable metadata." });
      continue;
    }
    if (!existing) registration.set(asset.assetId, asset);
    if (request.usage === "stroke") {
      issues.push({ sourceId, capability: "image-stroke", outcome: "preserved-extension", reason: "Phase 2 has no editable image-stroke binding; the admitted asset remains available but is not attached to this layer." });
      continue;
    }
    const target = targetById.get(request.nodeId);
    if (!target) {
      issues.push({ sourceId, capability: "image-asset", outcome: "rejected", reason: "The authorized asset target is not present in the current Canonical document." });
      continue;
    }
    if (!imageFillTarget(target)) {
      issues.push({ sourceId, capability: "image-fill", outcome: "preserved-extension", reason: "This Canonical node kind cannot hold the single Phase 2 image-fill reference." });
      continue;
    }
    const entries = candidates.get(target.id) ?? [];
    entries.push(entry);
    candidates.set(target.id, entries);
  }

  const updates: CanvasNode[] = [];
  for (const [nodeId, entries] of candidates) {
    const unique = new Map(entries.map((entry) => [`${entry.request.usage}:${entry.request.imageRef}`, entry]));
    const assetIds = new Set(entries.map((entry) => entry.asset.assetId));
    if (unique.size !== 1 || assetIds.size !== 1) {
      const sourceId = entries[0]?.request.sourceId;
      issues.push({ sourceId, capability: "image-fill", outcome: "preserved-extension", reason: "Multiple Figma image paints target one layer, but Phase 2 has one editable image-fill slot; no ambiguous asset was bound." });
      continue;
    }
    const target = targetById.get(nodeId)!;
    const assetId = entries[0]!.asset.assetId;
    if (target.assetId === assetId) continue;
    updates.push({ ...target, assetId, locked: target.extensions?.["figma.rest.deferred-lock.v1"] ? true : target.locked });
  }

  const batch: CoreBatchCommand[] = [
    ...[...registration.values()].map((asset) => ({ type: "registerAsset" as const, asset: structuredClone(asset) })),
    ...updates.map((node) => ({ type: "update" as const, node: coreProjectionNode(node) })),
  ];
  return { batch, nextNodes: currentNodes.map((node) => updates.find((update) => update.id === node.id) ?? node), boundNodeIds: updates.map((node) => node.id), issues };
}

export type FigmaRestImportOptions = {
  allocateNodeId: (figmaNodeId: string) => string;
  allocatePageId: (figmaPageId: string) => string;
  maxNodes?: number;
  maxDepth?: number;
  /** Sum of preserved SVG path source bytes, not a network download limit. */
  maxPathBytes?: number;
};

const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_DEPTH = 64;
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
  const pageSources = array(document?.children);
  if (!file || !document || !pageSources) {
    return {
      pages,
      nodes,
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
  normalizeImportedAlphaMasks(nodes, issues);
  return {
    pages,
    nodes,
    assetRequests,
    pageCommands: pages.map((page) => ({ type: "create-page", id: page.id, name: page.name, positionId: page.positionId })),
    nodeCommands: nodes.map((node) => ({ type: "create", node })),
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
    const fills = editablePaints(node.fills);
    const strokes = editablePaints(node.strokes);
    if (hasUnsupportedPaint(node.fills) || hasUnsupportedPaint(node.strokes)) {
      extensions["figma.rest.unsupported-paint.v1"] = jsonBytes({ fills: node.fills, strokes: node.strokes });
      issues.push({ sourceId, capability: "paint", outcome: "preserved-extension", reason: "Only visible SOLID and geometrically equivalent GRADIENT_LINEAR paints are editable; other paint types are preserved for import reporting." });
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
    const text = kind === "text" ? string(node.characters) ?? "" : imported.text;
    const textResult = kind === "text" ? textProperties(node, text ?? "", sourceId, issues) : undefined;
    if (textResult) Object.assign(extensions, textResult.extensions);
    const requests = imageAssetRequests(node, sourceId, id);
    // A lock is a Core mutation guard, so an image-bearing imported layer must
    // remain temporarily mutable until its separately authorized asset is
    // registered and bound. The binding transaction restores this exact flag.
    const deferredAssetLock = node.locked === true && requests.some((request) => request.usage !== "stroke");
    if (deferredAssetLock) extensions["figma.rest.deferred-lock.v1"] = bytes("true");
    const next: CanvasNode = {
      ...imported,
      id,
      pageId,
      parentId,
      name: string(node.name) ?? imported.name,
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      rotation: geometry.rotation,
      positionId: sourcePositionId,
      fill: fills[0]?.css ?? imported.fill,
      fillColor: fills[0]?.color ?? imported.fillColor,
      fillGradient: fills[0]?.gradient,
      fills: fills.length > 1 ? fills : undefined,
      stroke: strokes[0]?.css ?? imported.stroke,
      strokeColor: strokes[0]?.color ?? imported.strokeColor,
      strokeGradient: strokes[0]?.gradient,
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
      blendMode: blend(node.blendMode, sourceId, issues, extensions),
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
      clipsContent: kind === "frame" ? node.clipsContent !== false : undefined,
      extensions,
    };
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
    for (const paint of array(value) ?? []) {
      const item = record(paint);
      const imageRef = string(item?.imageRef);
      if (item?.type === "IMAGE" && imageRef) requests.push({ sourceId, nodeId, imageRef, usage });
    }
  };
  appendPaints(node.fills, "fill");
  appendPaints(node.strokes, "stroke");
  const nodeImageRef = string(node.imageRef);
  if (node.type === "IMAGE" && nodeImageRef) requests.push({ sourceId, nodeId, imageRef: nodeImageRef, usage: "node" });
  return requests;
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

type ImportedTextStyle = Pick<DocumentTextProperties["runs"][number], "fontSize" | "fontWeight" | "italic" | "letterSpacing">;

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
  const fontMetadata = [style, ...Object.values(record(node.styleOverrideTable) ?? {})].filter((candidate) => typeof record(candidate)?.fontFamily === "string");
  if (fontMetadata.length) {
    extensions["figma.rest.text-font.v1"] = jsonBytes(fontMetadata);
    issues.push({ sourceId, capability: "font-asset", outcome: "preserved-extension", reason: "Figma font family metadata is retained until an authorized Asset Service FontRef is available." });
  }
  const overrides = array(node.characterStyleOverrides);
  let styles: ImportedTextStyle[];
  if (!overrides?.length) styles = Array.from({ length: text.length }, () => base);
  else if (!isAscii(text) || overrides.length > text.length || overrides.some((entry) => !Number.isInteger(entry) || (entry as number) < 0)) {
    extensions["figma.rest.text-overrides.v1"] = jsonBytes({ styleOverrideTable: node.styleOverrideTable, characterStyleOverrides: node.characterStyleOverrides });
    issues.push({ sourceId, capability: "text-style-overrides", outcome: "preserved-extension", reason: "Only ASCII REST override indices are converted; Unicode override indexing remains opaque rather than risking invalid UTF-8 ranges." });
    styles = Array.from({ length: text.length }, () => base);
  } else {
    const table = record(node.styleOverrideTable) ?? {};
    styles = Array.from({ length: text.length }, (_, index) => {
      const override = overrides[index] ?? 0;
      const overrideStyle = override === 0 ? undefined : record(table[String(override)]);
      if (override !== 0 && !overrideStyle) {
        extensions["figma.rest.text-overrides.v1"] = jsonBytes({ styleOverrideTable: node.styleOverrideTable, characterStyleOverrides: node.characterStyleOverrides });
        issues.push({ sourceId, capability: "text-style-overrides", outcome: "preserved-extension", reason: `Figma style override ${override} is missing from styleOverrideTable.` });
        return base;
      }
      return overrideStyle ? importedTextStyle(overrideStyle, base) ?? base : base;
    });
  }
  const runs = textRuns(text, styles);
  return {
    extensions,
    properties: {
      runs,
      paragraph: { alignment: textAlignment(string(style.textAlignHorizontal)), lineHeight: positive(style.lineHeightPx), paragraphSpacing: finite(style.paragraphSpacing) ?? 0 },
      autoSize: textAutoSize(string(node.textAutoResize)),
    } satisfies DocumentTextProperties,
  };
}

function importedTextStyle(value: JsonRecord, fallback?: ImportedTextStyle): ImportedTextStyle | undefined {
  const fontSize = finite(value.fontSize) ?? fallback?.fontSize;
  const fontWeight = finite(value.fontWeight) ?? fallback?.fontWeight;
  const letterSpacing = finite(value.letterSpacing) ?? fallback?.letterSpacing ?? 0;
  if (fontSize === undefined || fontSize <= 0 || fontWeight === undefined || fontWeight <= 0 || !Number.isInteger(fontWeight)) return undefined;
  return { fontSize, fontWeight, italic: typeof value.italic === "boolean" ? value.italic : fallback?.italic ?? false, letterSpacing };
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

function sameTextStyle(left: ImportedTextStyle, right: ImportedTextStyle) { return left.fontSize === right.fontSize && left.fontWeight === right.fontWeight && left.italic === right.italic && left.letterSpacing === right.letterSpacing; }
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

function hasUnsupportedPaint(value: unknown) {
  return (array(value) ?? []).some((paint) => {
    const item = record(paint);
    return item && item.visible !== false && !editablePaint(item);
  });
}

/** Figma linear gradients carry three normalized handles. Canonical Canvas/SVG
 * has an axis only, so it is equivalent exactly when the width handle is
 * perpendicular to that axis. A skewed width handle changes the color-line
 * direction and must remain an external extension instead of being guessed. */
function editablePaint(item: JsonRecord): DocumentPaint | undefined {
  if (string(item.blendMode) && item.blendMode !== "NORMAL") return undefined;
  const opacity = finite(item.opacity) ?? 1;
  if (item.type === "SOLID") {
    const color = figmaColor(item.color, opacity);
    return color ? { css: cssColor(color), color } : undefined;
  }
  if (item.type === "GRADIENT_LINEAR") {
    const gradient = linearGradient(item, opacity);
    return gradient ? { css: cssColor(gradient.stops[0]!.color), gradient } : undefined;
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
  const map: Record<string, BlendMode> = { NORMAL: "normal", MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten" };
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
  return !node.locked && ["frame", "section", "rectangle", "ellipse", "image"].includes(node.kind);
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
