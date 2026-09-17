import { colorToLinearSrgbComponents, colorToOpaqueSrgbCss, colorToSrgbCss, sampleLinearGradientForCanvas } from "./color-rendering";
import { cornerSmoothingExponent, resolveCornerSmoothing } from "./corner-smoothing";
import { insetRoundedRectRadii, outsetRoundedRectRadii } from "./aligned-rounded-rect";
import { type CanvasNode, type DocumentGradientPaint, type DocumentPaint, type DocumentPaintLayer, type DocumentVectorPath, type RelativeTransform } from "./editor-protocol";
import { resolvedTextLineHeight, resolvedTextLineHeightAt } from "./text-line-height";
import { visibleNodesOnPage } from "./hierarchy-visibility";
import { sortNodesByLayerOrder } from "./layer-order";
import { solidLineStrokeOutlinePath } from "./line-stroke-outline";
import { decorativeCapMeshPath, isDecorativeCap } from "./decorative-cap-mesh";
import { perSideStrokeCenters } from "./per-side-stroke";
import { styledTextSpans, type RenderTextStyle } from "./text-style-runs";
import { effectiveTextOpenTypeFeatures, textCaseFontVariantCaps } from "./text-case";
import { endingEllipsis, textDisplayLines } from "./text-truncation";
import { transformPoint, worldBoundsForTransform, worldTransformsForNodes, type AffineMatrix } from "./scene-transform";
import { worldVisualBoundsForNode } from "./world-visual-bounds";
import { ellipseStrokeRing } from "./ellipse-stroke-ring";
import { nodeParametricShape, parametricShapePath, parametricShapePoints } from "./parametric-shape";
import { vectorPathSvgD } from "./vector-path";
import { fontVariationCss } from "./font-variation-axes";
import { layoutTextRanges, textAlignedLineLeft, textHangingPunctuationOffsets, textListIndentationOffset, textListMarker, textListMarkerBaseIndent, textListMarkerGutterForProperties, textParagraphGap, textParagraphIndentAt, textParagraphListTypeAt, textParagraphStartAtOffset, textParagraphWrapStyleAt } from "./text-layout";
import { sceneNodesInPaintOrder } from "../runtime/scene-compiler";
import type { OrderedRenderScene } from "../runtime/ordered-render-ir";
import { vectorNetworkRegionPaintPlansFromExtension } from "../runtime/runtime-vector-network";
import { specialNodeFallback } from "./special-node-fallback";
import { connectorPathForNode, connectorPathSvgD } from "./connector-path";
import { connectorDecorationTriangles, connectorEndpointDecorations, connectorLabelLayout } from "./connector-presentation";
import { shapeWithTextDecorationPathD, shapeWithTextDecorations, shapeWithTextPath, shapeWithTextPathD } from "./shape-with-text-path";
import { layoutTextPath, textPathGeometry, textPathTraversalVectorPath } from "./text-path-layout";
import { affineSvgMatrix, transformGroupRepeatMatrices, transformGroupRepeatSubtree } from "./transform-group-repeat";
import { clipsChildren } from "./node-capabilities";
import { activeNodeEffects, requiresSubtreeComposition } from "./subtree-compositing";
import { isLinearBlendMode } from "./linear-blend-composite";
import { isolatesNormalBlend } from "./node-blend-semantics";
import { imageFiltersAreNeutral } from "./image-filters";
import { normalizedFillLayers, normalizedFillPaints, normalizedNodeEffects, normalizedStrokeLayers, normalizedStrokePaints } from "./normalized-node-view";
import {
  imagePaintLayoutBox,
  resolvedImagePaintTransform,
} from "./image-paint-transform";

export type SvgExportResult = {
  svg: string;
  /** Revision of the immutable snapshot supplied by the editor. Every
   * derivative and its JSON sidecar can therefore be traced to one source. */
  sourceRevision?: number;
  /** Frozen SVG viewport dimensions, reused by PNG/PDF Slice rasterization. */
  width: number;
  height: number;
  /** Unsupported or unavailable asset bytes remain visible through an explicit fallback. */
  warnings: string[];
  /** Machine-readable subset of compatibility fallbacks. PNG/PDF Slice export
   * rasterizes this SVG, so the same records describe its source fallback. */
  compatibilityFallbacks: SvgCompatibilityFallback[];
};

export type SvgCompatibilityFallback = {
  nodeId?: string;
  capability: "layer-blur" | "inner-shadow" | "shadow-spread" | "background-blur" | "image-asset" | "image-transform" | "image-filters" | "font-asset" | "text-layout" | "display-p3" | "live-boolean" | "slice-selection" | "node-selection" | "scene-order" | "special-node" | "pdf-rasterization" | "linear-blend" | "text-decoration-color-blend" | "transform-group-repeat";
  outcome: "fallback";
  reason: string;
};

/** A short-lived, Core-derived line projection. It is deliberately separate
 * from Canonical text: export needs the same frozen line boundaries Canvas
 * shaped from the selected font, but must never persist derived layout data. */
export type SvgTextLayoutProjection = {
  unitsPerEm?: number;
  lines: ReadonlyArray<{ start: number; end: number; direction: "ltr" | "rtl"; advance?: number }>;
};

export type SvgExportOptions = {
  pageId: string;
  defaultPageId: string;
  /** Immutable source revision captured before any asynchronous asset or WASM
   * work begins. It is presentation metadata and is never persisted. */
  sourceRevision?: number;
  /** Optional M4 Scene Compiler output from this same frozen source revision.
   * When supplied, SVG uses its paint order instead of independently sorting
   * nodes; a revision mismatch is reported and safely falls back. */
  scene?: OrderedRenderScene;
  padding?: number;
  /** Transient Rust-derived paths for live Boolean wrappers. They are never
   * persisted; the caller must calculate them from the frozen export snapshot. */
  booleanPaths?: ReadonlyMap<string, DocumentVectorPath>;
  /** Transient Rust/WASM-flattened Vector paths from the same frozen snapshot
   * Canvas uses. Supplying these prevents SVG and its PNG/PDF raster path from
   * independently approximating cubic curves. */
  vectorPaths?: ReadonlyMap<string, DocumentVectorPath>;
  /** Transient Rust-derived Polygon/Star outlines. PNG/PDF rasterize this SVG,
   * so callers can keep all three exports on the frozen Core geometry. */
  parametricShapePaths?: ReadonlyMap<string, readonly { x: number; y: number }[]>;
  /** When present, crop the frozen page paint to this non-painting Slice. */
  sliceId?: string;
  /** Exports these selected layer roots and their descendants instead of the
   * full Page. Node transforms remain resolved from the same frozen document. */
  nodeIds?: readonly string[];
  /** Short-lived, already-authorized data URIs for raster fills. They are
   * presentation-only: no asset bytes are ever written into the Document. */
  imageDataUris?: ReadonlyMap<string, string>;
  /** Short-lived, already-authorized font data URIs from the same frozen
   * source. Export embeds these as isolated @font-face rules. */
  fontDataUris?: ReadonlyMap<string, string>;
  /** ICU4X/Rustybuzz line ranges derived from the same frozen font bytes Canvas
   * used. SVG, and therefore PNG/PDF, consumes them without measuring text. */
  textLayouts?: ReadonlyMap<string, SvgTextLayoutProjection>;
};

type SvgPaint = Readonly<{ value: string; opacity?: number }>;

function paintUsesDisplayP3(paint: DocumentPaint) {
  return paint.color?.space === "display-p3"
    || Boolean(paint.gradient?.stops.some((stop) => stop.color.space === "display-p3"))
    || Boolean(paint.gradientPaint?.stops.some((stop) => stop.color.space === "display-p3"));
}

function invertRelativeTransform(transform: RelativeTransform): RelativeTransform | undefined {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) return undefined;
  return {
    a: transform.d / determinant,
    b: -transform.b / determinant,
    c: -transform.c / determinant,
    d: transform.a / determinant,
    e: (transform.c * transform.f - transform.d * transform.e) / determinant,
    f: (transform.b * transform.e - transform.a * transform.f) / determinant,
  };
}

function gradientPoint(transform: RelativeTransform, x: number, y: number) {
  return { x: transform.a * x + transform.c * y + transform.e, y: transform.b * x + transform.d * y + transform.f };
}

function sampledGradientColor(gradient: DocumentGradientPaint, position: number) {
  const bounded = Math.min(1, Math.max(0, position));
  let rightIndex = gradient.stops.findIndex((stop) => stop.position >= bounded);
  if (rightIndex < 0) rightIndex = gradient.stops.length - 1;
  const right = gradient.stops[rightIndex]!;
  const left = gradient.stops[Math.max(0, rightIndex - 1)]!;
  const amount = right.position === left.position ? 1 : (bounded - left.position) / (right.position - left.position);
  const leftLinear = colorToLinearSrgbComponents(left.color);
  const rightLinear = colorToLinearSrgbComponents(right.color);
  return colorToSrgbCss({
    space: "linear-srgb",
    components: leftLinear.map((component, index) => component + (rightLinear[index]! - component) * amount) as [number, number, number],
    alpha: left.color.alpha + (right.color.alpha - left.color.alpha) * amount,
  });
}

/** SVG is deliberately serialized in the same clipped sRGB form as Canvas
 * and the JPEG-backed PDF path. Keep that conversion explicit in the export
 * report instead of making a wide-gamut document appear lossless downstream. */
function nodeUsesDisplayP3(node: CanvasNode) {
  const paints = [
    ...normalizedFillPaints(node),
    ...normalizedStrokePaints(node),
  ];
  if (paints.some(paintUsesDisplayP3)) return true;
  if (node.textProperties?.runs.some((run) => run.color?.space === "display-p3")) return true;
  return normalizedNodeEffects(node).some((effect) => effect.dropShadow?.color.space === "display-p3" || effect.innerShadow?.color.space === "display-p3");
}

// Exported SVG must never become a transport for an untrusted SVG payload.
// Callers only construct these URIs from the isolated raster asset pipeline,
// but validate again at this trust boundary because `SvgExportOptions` is a
// public library API used by tests and non-editor callers as well.
const MAX_EMBEDDED_RASTER_DATA_URI_LENGTH = Math.ceil(16 * 1024 * 1024 * 4 / 3) + 128;
const EMBEDDED_RASTER_DATA_URI = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const MAX_EMBEDDED_FONT_DATA_URI_LENGTH = Math.ceil(16 * 1024 * 1024 * 4 / 3) + 128;
const EMBEDDED_FONT_DATA_URI = /^data:font\/(?:woff2?|ttf|otf);base64,[A-Za-z0-9+/]*={0,2}$/;

function isSafeEmbeddedRasterDataUri(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_EMBEDDED_RASTER_DATA_URI_LENGTH
    && EMBEDDED_RASTER_DATA_URI.test(value);
}

function isSafeEmbeddedFontDataUri(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_EMBEDDED_FONT_DATA_URI_LENGTH
    && EMBEDDED_FONT_DATA_URI.test(value);
}

function svgFontFamily(assetId: string) {
  return `makefigma-font-${assetId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * Produces a self-contained SVG for the active page's vector common nodes.
 * It deliberately consumes the shared world-transform and hierarchy helpers,
 * so Dual-read nodes, paint order and Frame clipping do not diverge from the
 * canvas projection. Image bytes stay external to the CanvasNode; callers may
 * provide a bounded, authorized data URI map for a self-contained export.
 */
export function exportPageToSvg(nodes: readonly CanvasNode[], options: SvgExportOptions): SvgExportResult {
  const visiblePageNodes = visibleNodesOnPage(nodes, options.pageId, options.defaultPageId);
  const sceneMatchesFrozenRevision = Boolean(options.scene && (options.sourceRevision === undefined || options.scene.revision === options.sourceRevision));
  const allPageNodes = sceneMatchesFrozenRevision
    ? sceneNodesInPaintOrder(options.scene, visiblePageNodes)
    : sortNodesByLayerOrder(visiblePageNodes);
  const allPageById = new Map(allPageNodes.map((node) => [node.id, node]));
  const selectedNodeIds = new Set((options.nodeIds ?? []).filter((id) => {
    const node = allPageById.get(id);
    return Boolean(node && node.kind !== "slice");
  }));
  const selectedNodeScope = selectedNodeIds.size > 0;
  /** Ancestors needed to preserve Frame Clip/Mask nesting for a selected
   * descendant. They carry structure only: their own fill/stroke is not part
   * of a layer-selection export unless the user selected that ancestor. */
  const selectionContextNodeIds = new Set<string>();
  const pageNodes = selectedNodeScope
    ? (() => {
      const included = new Set(allPageNodes.filter((node) => {
      if (selectedNodeIds.has(node.id)) return true;
      const visited = new Set<string>();
      let parentId = node.parentId;
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        if (selectedNodeIds.has(parentId)) return true;
        parentId = allPageById.get(parentId)?.parentId;
      }
      return false;
      }).map((node) => node.id));
      const siblingsByParent = new Map<string | undefined, CanvasNode[]>();
      for (const node of allPageNodes) {
        const siblings = siblingsByParent.get(node.parentId) ?? [];
        siblings.push(node);
        siblingsByParent.set(node.parentId, siblings);
      }
      // A selected descendant is still visually governed by a preceding alpha
      // mask at any ancestor level. Export that mask definition too, but only
      // the active mask in each sibling run—unrelated siblings stay excluded.
      for (const selectedId of selectedNodeIds) {
        let current = allPageById.get(selectedId);
        const visited = new Set<string>();
        while (current && !visited.has(current.id)) {
          visited.add(current.id);
          const siblings = siblingsByParent.get(current.parentId) ?? [];
          const index = siblings.findIndex((node) => node.id === current!.id);
          for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            const candidate = siblings[cursor]!;
            if (!candidate.isMask) continue;
            included.add(candidate.id);
            break;
          }
          const parent = current.parentId ? allPageById.get(current.parentId) : undefined;
          if (parent) {
            included.add(parent.id);
            if (!selectedNodeIds.has(parent.id)) selectionContextNodeIds.add(parent.id);
          }
          current = parent;
        }
      }
      return allPageNodes.filter((node) => included.has(node.id));
    })()
    : allPageNodes;
  const requestedSlice = options.sliceId
    ? nodes.find((node) => node.id === options.sliceId && node.kind === "slice" && (node.pageId ?? options.defaultPageId) === options.pageId)
    : undefined;
  const byId = new Map(pageNodes.map((node) => [node.id, node]));
  const worldTransformByNodeId = worldTransformsForNodes(nodes);
  // A live BooleanOperation is rendered from Rust-derived path geometry in the
  // editor worker. The synchronous base exporter only receives a Boolean path
  // when its caller has derived one from this exact frozen snapshot.
  const isLiveBooleanOperand = (node: CanvasNode) => {
    const visited = new Set<string>();
    let parentId = node.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return false;
      if (parent.kind === "booleanOperation") return true;
      parentId = parent.parentId;
    }
    return false;
  };
  const exportableNodes = pageNodes.filter((node) => !selectionContextNodeIds.has(node.id) && !node.isMask && (node.kind !== "booleanOperation" || options.booleanPaths?.has(node.id)) && !isLiveBooleanOperand(node));
  const bounds = exportableNodes
    .filter((node) => node.kind !== "group" && node.kind !== "slice")
    .map((node) => {
      const transform = worldTransformByNodeId.get(node.id);
      return transform ? worldVisualBoundsForNode(nodes, node, {
        transform,
        bounds: worldBoundsForTransform(node, transform),
        defaultPageId: options.defaultPageId,
        nodeById: byId,
        worldTransformByNodeId,
      }) : undefined;
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const sliceTransform = requestedSlice ? worldTransformByNodeId.get(requestedSlice.id) : undefined;
  const slicePoints = requestedSlice && sliceTransform
    ? [{ x: 0, y: 0 }, { x: requestedSlice.width, y: 0 }, { x: requestedSlice.width, y: requestedSlice.height }, { x: 0, y: requestedSlice.height }].map((point) => transformPoint(sliceTransform, point))
    : undefined;
  const sliceBounds = slicePoints ? {
    left: Math.min(...slicePoints.map((point) => point.x)), top: Math.min(...slicePoints.map((point) => point.y)),
    right: Math.max(...slicePoints.map((point) => point.x)), bottom: Math.max(...slicePoints.map((point) => point.y)),
  } : undefined;
  const padding = requestedSlice ? 0 : Math.max(0, options.padding ?? 16);
  const left = sliceBounds?.left ?? (bounds.length ? Math.min(...bounds.map((value) => value.left)) - padding : 0);
  const top = sliceBounds?.top ?? (bounds.length ? Math.min(...bounds.map((value) => value.top)) - padding : 0);
  const right = sliceBounds?.right ?? (bounds.length ? Math.max(...bounds.map((value) => value.right)) + padding : 1);
  const bottom = sliceBounds?.bottom ?? (bounds.length ? Math.max(...bounds.map((value) => value.bottom)) + padding : 1);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const children = new Map<string, CanvasNode[]>();
  const roots: CanvasNode[] = [];
  for (const node of pageNodes) {
    if (!node.parentId || !byId.has(node.parentId)) roots.push(node);
    else {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  }

  const definitions: string[] = [];
  const warnings = new Set<string>();
  const compatibilityFallbacks: SvgCompatibilityFallback[] = [];
  const reportFallback = (capability: SvgCompatibilityFallback["capability"], reason: string, nodeId?: string) => {
    warnings.add(reason);
    if (!compatibilityFallbacks.some((entry) => entry.nodeId === nodeId && entry.capability === capability)) {
      compatibilityFallbacks.push({ nodeId, capability, outcome: "fallback", reason });
    }
  };
  if (options.scene && !sceneMatchesFrozenRevision) {
    reportFallback("scene-order", "Scene order fallback: the supplied Scene IR revision does not match the frozen export revision.");
  }
  const reportEffectFallback = (nodeId: string, capability: SvgCompatibilityFallback["capability"], label: string) => {
    const reason = `Effect fallback for ${nodeId}: SVG export does not yet preserve ${label}.`;
    reportFallback(capability, reason, nodeId);
  };
  const activeEffects = activeNodeEffects;
  const hasStandaloneLayerBlur = (node: CanvasNode) => {
    const effects = activeEffects(node);
    return effects.length === 1 && Boolean(effects[0]?.layerBlur?.visible) && (effects[0]?.layerBlur?.radius ?? 0) > 0;
  };
  const hasStandaloneInnerShadow = (node: CanvasNode) => {
    const effects = activeEffects(node);
    const shadow = effects.length === 1 ? effects[0]?.innerShadow : undefined;
    return Boolean(shadow?.visible && shadow.color.alpha > 0);
  };
  /** SVG can faithfully express an ordered Canvas stack when every entry is a
   * single Layer Blur, Drop Shadow or Inner Shadow. Each step consumes the
   * prior composited result, so blur/shadow order remains observably distinct
   * instead of being flattened to independent SourceGraphic filters. */
  const hasComposedShadowBlurStack = (node: CanvasNode) => {
    const effects = activeEffects(node);
    return effects.length > 1
      && effects.every((effect) => [effect.layerBlur, effect.dropShadow, effect.innerShadow].filter(Boolean).length === 1);
  };
  if (options.nodeIds?.length && !selectedNodeScope) reportFallback("node-selection", "Requested layer selection is unavailable on this page; exported the full page instead.");
  for (const node of exportableNodes) {
    const referencedFonts = node.kind === "text" || node.kind === "textPath"
      ? [...(node.textProperties?.runs.flatMap((run) => run.font ? [run.font.assetId] : []) ?? []), ...(node.textProperties?.fallbackFonts?.map((font) => font.assetId) ?? [])]
      : [];
    const hasUnembeddedFontAsset = referencedFonts.some((assetId) => !isSafeEmbeddedFontDataUri(options.fontDataUris?.get(assetId)));
    if (hasUnembeddedFontAsset) {
      reportFallback("font-asset", `Font fallback for ${node.id}: SVG export does not embed document font assets.`, node.id);
    }
    // System-font text has always had an explicit browser-layout policy. A
    // document-owned font is different: if export did not receive the frozen
    // Rust line ranges, its SVG line breaking can diverge from Canvas and must
    // be visible in the delivery sidecar instead of silently looking supported.
    if ((node.kind === "text" || node.kind === "textPath") && referencedFonts.length > 0 && !options.textLayouts?.has(node.id)) {
      reportFallback("text-layout", `Text layout fallback for ${node.id}: SVG export did not receive frozen Rust text line ranges; browser line layout may differ from Canvas.`, node.id);
    }
    if (nodeUsesDisplayP3(node)) {
      reportFallback("display-p3", `Color fallback for ${node.id}: Display P3 colors are converted to clipped sRGB for SVG, PNG and PDF export.`, node.id);
    }
    if (isLinearBlendMode(node.blendMode)) {
      reportFallback("linear-blend", `Blend fallback for ${node.id}: structural SVG cannot sample its backdrop for exact ${node.blendMode} compositing. Canvas is the verified path; SVG and its PNG/PDF raster derivatives use Normal compositing.`, node.id);
    }
    if ([...normalizedFillLayers(node), ...normalizedStrokeLayers(node)]
      .some((layer) => isLinearBlendMode(layer.blendMode))) {
      reportFallback("linear-blend", `Paint-layer blend fallback for ${node.id}: structural SVG cannot sample the bounded backdrop required for exact Linear Burn/Dodge compositing. Canvas is the verified path; SVG and its PNG/PDF raster derivatives use Normal compositing.`, node.id);
    }
    if (node.textProperties?.runs.some((run) => run.fillStack?.layers.some((layer) => isLinearBlendMode(layer.blendMode)))) {
      reportFallback("linear-blend", `Text paint-layer blend fallback for ${node.id}: structural SVG cannot sample the bounded backdrop required for exact Linear Burn/Dodge compositing. Canvas is the verified path; SVG and its PNG/PDF raster derivatives use Normal compositing.`, node.id);
    }
    if ([...(node.textProperties?.runs ?? []), ...(node.textProperties?.baseStyle ? [node.textProperties.baseStyle] : [])]
      .some((run) => run.textDecoration === "underline" && run.textDecorationColor?.blendMode !== undefined && run.textDecorationColor.blendMode !== "normal")) {
      reportFallback("text-decoration-color-blend", `Text decoration color blend fallback for ${node.id}: structural SVG cannot isolate decoration compositing from glyph compositing. Canvas is the verified path; SVG and its PNG/PDF raster derivatives use Normal decoration compositing.`, node.id);
    }
  }
  // Masks are not ordinary painted export nodes, but Canvas still applies their
  // effects before source-alpha compositing. Include them in capability
  // reporting so an unsupported mask effect cannot disappear behind a <mask>
  // definition without a delivery-side warning.
  const effectNodes = [...new Map([...exportableNodes, ...pageNodes.filter((node) => node.isMask)].map((node) => [node.id, node])).values()];
  for (const node of effectNodes) {
    for (const effect of normalizedNodeEffects(node)) {
      if (effect.layerBlur?.visible && effect.layerBlur.radius > 0 && !hasStandaloneLayerBlur(node) && !hasComposedShadowBlurStack(node)) reportEffectFallback(node.id, "layer-blur", "Layer Blur");
      if (effect.innerShadow?.visible && effect.innerShadow.color.alpha > 0 && !hasStandaloneInnerShadow(node) && !hasComposedShadowBlurStack(node)) reportEffectFallback(node.id, "inner-shadow", "Inner Shadow");
      if (effect.backgroundBlur?.visible && effect.backgroundBlur.radius > 0) reportEffectFallback(node.id, "background-blur", "Background Blur");
    }
  }
  const blendStyle = (node: CanvasNode) => node.blendMode && node.blendMode !== "normal" && node.blendMode !== "pass-through" && !isLinearBlendMode(node.blendMode) ? ` style="mix-blend-mode:${node.blendMode}"` : "";
  let nextDefinitionId = 0;
  const embeddedFontIds = [...new Set(exportableNodes.flatMap((node) => node.kind === "text" ? [
    ...(node.textProperties?.runs.flatMap((run) => run.font ? [run.font.assetId] : []) ?? []),
    ...(node.textProperties?.fallbackFonts?.map((font) => font.assetId) ?? []),
  ] : []))].filter((assetId) => isSafeEmbeddedFontDataUri(options.fontDataUris?.get(assetId)));
  if (embeddedFontIds.length) {
    definitions.push(`<style>${embeddedFontIds.map((assetId) => `@font-face{font-family:'${svgFontFamily(assetId)}';src:url('${options.fontDataUris!.get(assetId)!}') format('${fontFormat(options.fontDataUris!.get(assetId)!)}');}`).join("")}</style>`);
  }
  const paintValue = (paint: DocumentPaint): SvgPaint => {
    const layerOpacity = paint.layerOpacity ?? 1;
    if (paint.gradientPaint) {
      const id = `makefigma-gradient-${nextDefinitionId++}`;
      const gradient = paint.gradientPaint;
      const inverse = invertRelativeTransform(gradient.transform);
      if (!inverse) return { value: paint.css, opacity: layerOpacity };
      if (gradient.kind === "radial") {
        const matrix = `matrix(${number(inverse.a)} ${number(inverse.b)} ${number(inverse.c)} ${number(inverse.d)} ${number(inverse.e)} ${number(inverse.f)})`;
        const sampledStops = sampleLinearGradientForCanvas({ start: [0, 0], end: [1, 0], stops: gradient.stops });
        definitions.push(`<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx="0" cy="0.5" r="1" gradientTransform="${matrix}">${sampledStops.map((stop) => `<stop offset="${number(stop.position)}" stop-color="${attribute(stop.color)}"/>`).join("")}</radialGradient>`);
      } else if (gradient.kind === "diamond") {
        const steps = 128;
        const polygons = [`<rect x="0" y="0" width="1" height="1" fill="${attribute(sampledGradientColor(gradient, 1))}"/>`];
        for (let step = steps - 1; step >= 0; step -= 1) {
          const position = step / steps;
          const points = [[position, .5], [0, .5 + position / 2], [-position, .5], [0, .5 - position / 2]]
            .map(([x, y]) => gradientPoint(inverse, x!, y!));
          polygons.push(`<polygon points="${points.map((point) => `${number(point.x)},${number(point.y)}`).join(" ")}" fill="${attribute(sampledGradientColor(gradient, position))}"/>`);
        }
        definitions.push(`<pattern id="${id}" data-makefigma-gradient="diamond" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox" width="1" height="1">${polygons.join("")}</pattern>`);
      } else {
        const steps = 256;
        const center = gradientPoint(inverse, 0, .5);
        const gradientCorners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => gradientPoint(gradient.transform, x!, y!));
        const radius = Math.max(1, ...gradientCorners.map((point) => Math.hypot(point.x, (point.y - .5) * 2))) * 2;
        const wedges: string[] = [];
        for (let step = 0; step < steps; step += 1) {
          const start = step / steps;
          const end = (step + 1.01) / steps;
          const first = gradientPoint(inverse, Math.cos(start * Math.PI * 2) * radius, .5 + Math.sin(start * Math.PI * 2) * radius / 2);
          const second = gradientPoint(inverse, Math.cos(end * Math.PI * 2) * radius, .5 + Math.sin(end * Math.PI * 2) * radius / 2);
          wedges.push(`<path d="M ${number(center.x)} ${number(center.y)} L ${number(first.x)} ${number(first.y)} L ${number(second.x)} ${number(second.y)} Z" fill="${attribute(sampledGradientColor(gradient, (step + .5) / steps))}"/>`);
        }
        definitions.push(`<pattern id="${id}" data-makefigma-gradient="angular" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox" width="1" height="1">${wedges.join("")}</pattern>`);
      }
      return { value: `url(#${id})`, opacity: layerOpacity };
    }
    if (!paint.gradient) return paint.color
      ? { value: colorToOpaqueSrgbCss(paint.color), opacity: paint.color.alpha * layerOpacity }
      : { value: paint.css, opacity: layerOpacity };
    const id = `makefigma-gradient-${nextDefinitionId++}`;
    const gradient = paint.gradient;
    definitions.push(`<linearGradient id="${id}" x1="${number(gradient.start[0])}" y1="${number(gradient.start[1])}" x2="${number(gradient.end[0])}" y2="${number(gradient.end[1])}">${gradient.stops.map((stop) => `<stop offset="${number(stop.position)}" stop-color="${attribute(colorToOpaqueSrgbCss(stop.color))}" stop-opacity="${number(stop.color.alpha)}"/>`).join("")}</linearGradient>`);
    return { value: `url(#${id})`, opacity: layerOpacity };
  };
  const activePaints = (node: CanvasNode, kind: "fill" | "stroke"): DocumentPaint[] => {
    return [...(kind === "fill" ? normalizedFillPaints(node) : normalizedStrokePaints(node))];
  };
  /** SVG's morphology primitive is the export-side spread contract: it alters
   * SourceAlpha before blur/offset, preserving both positive and negative
   * spread without changing the blur kernel. PNG/PDF rasterize this same frozen
   * SVG, so this path cannot silently diverge by target format. */
  const dropShadowFilter = (node: CanvasNode) => {
    const shadows = normalizedNodeEffects(node).map((effect) => effect.dropShadow).filter((shadow): shadow is NonNullable<CanvasNode["dropShadow"]> => Boolean(shadow))
      .filter((shadow) => shadow.visible && shadow.color.alpha > 0);
    if (!shadows.length) return "";
    const id = `makefigma-drop-shadow-${nextDefinitionId++}`;
    const bounds = shadows.reduce((result, shadow) => {
      const extent = Math.max(0, shadow.blurRadius) + Math.abs(shadow.spread) + 1;
      return {
        left: Math.min(result.left, shadow.offsetX - extent),
        top: Math.min(result.top, shadow.offsetY - extent),
        right: Math.max(result.right, node.width + shadow.offsetX + extent),
        bottom: Math.max(result.bottom, node.height + shadow.offsetY + extent),
      };
    }, { left: 0, top: 0, right: node.width, bottom: node.height });
    const primitives = shadows.map((shadow, index) => {
      const suffix = shadows.length === 1 ? "" : `-${index}`;
      const spread = shadow.spread === 0 ? "" : `<feMorphology in="SourceAlpha" operator="${shadow.spread > 0 ? "dilate" : "erode"}" radius="${number(Math.abs(shadow.spread))}" result="spread${suffix}"/>`;
      const source = shadow.spread === 0 ? "SourceAlpha" : `spread${suffix}`;
      return `${spread}<feGaussianBlur in="${source}" stdDeviation="${number(Math.max(0, shadow.blurRadius) / 2)}" result="blur${suffix}"/><feOffset in="blur${suffix}" dx="${number(shadow.offsetX)}" dy="${number(shadow.offsetY)}" result="offsetBlur${suffix}"/><feFlood flood-color="${attribute(colorToOpaqueSrgbCss(shadow.color))}" flood-opacity="${number(shadow.color.alpha)}" result="shadowColor${suffix}"/><feComposite in="shadowColor${suffix}" in2="offsetBlur${suffix}" operator="in" result="shadow${suffix}"/>`;
    }).join("");
    const merges = `${shadows.map((_, index) => `<feMergeNode in="shadow${shadows.length === 1 ? "" : `-${index}`}"/>`).join("")}<feMergeNode in="SourceGraphic"/>`;
    definitions.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${number(bounds.left)}" y="${number(bounds.top)}" width="${number(bounds.right - bounds.left)}" height="${number(bounds.bottom - bounds.top)}">${primitives}<feMerge>${merges}</feMerge></filter>`);
    return ` filter="url(#${id})"`;
  };
  /** Builds one SVG filter graph for Canvas-compatible ordered Layer Blur,
   * Drop Shadow and Inner Shadow entries. `current` is deliberately threaded
   * through every primitive: each operation observes the prior composite, and
   * PNG/PDF rasterize this exact frozen graph. */
  const composedShadowBlurFilter = (node: CanvasNode) => {
    if (!hasComposedShadowBlurStack(node)) return "";
    const effects = activeEffects(node);
    const extent = effects.reduce((total, effect) => {
      const shadow = effect.dropShadow ?? effect.innerShadow;
      return total + (effect.layerBlur?.radius ?? 0) + (shadow ? Math.max(0, shadow.blurRadius) + Math.abs(shadow.spread) + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) : 0) + 1;
    }, 0);
    const id = `makefigma-composed-effect-${nextDefinitionId++}`;
    let current = "SourceGraphic";
    const primitives = effects.map((effect, index) => {
      if (effect.layerBlur) {
        const result = `effect-${index}`;
        const input = current;
        current = result;
        return `<feGaussianBlur in="${input}" stdDeviation="${number(effect.layerBlur.radius / 2)}" result="${result}"/>`;
      }
      const shadow = effect.dropShadow ?? effect.innerShadow!;
      const suffix = `-${index}`;
      const input = current;
      const alpha = `alpha${suffix}`;
      const spread = `spread${suffix}`;
      const blurred = `blur${suffix}`;
      const offset = `offset${suffix}`;
      const shadowColor = `shadowColor${suffix}`;
      const shadowResult = `shadow${suffix}`;
      const result = `effect-${index}`;
      const morphology = shadow.spread === 0 ? "" : `<feMorphology in="${alpha}" operator="${shadow.spread > 0 ? "dilate" : "erode"}" radius="${number(Math.abs(shadow.spread))}" result="${spread}"/>`;
      const shadowSource = shadow.spread === 0 ? alpha : spread;
      current = result;
      if (effect.innerShadow) {
        return `<feColorMatrix in="${input}" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="${alpha}"/>${morphology}<feGaussianBlur in="${shadowSource}" stdDeviation="${number(Math.max(0, shadow.blurRadius) / 2)}" result="${blurred}"/><feOffset in="${blurred}" dx="${number(-shadow.offsetX)}" dy="${number(-shadow.offsetY)}" result="${offset}"/><feComposite in="${offset}" in2="${alpha}" operator="in" result="innerMask${suffix}"/><feFlood flood-color="${attribute(colorToOpaqueSrgbCss(shadow.color))}" flood-opacity="${number(shadow.color.alpha)}" result="${shadowColor}"/><feComposite in="${shadowColor}" in2="innerMask${suffix}" operator="in" result="${shadowResult}"/><feMerge result="${result}"><feMergeNode in="${input}"/><feMergeNode in="${shadowResult}"/></feMerge>`;
      }
      return `<feColorMatrix in="${input}" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="${alpha}"/>${morphology}<feGaussianBlur in="${shadowSource}" stdDeviation="${number(Math.max(0, shadow.blurRadius) / 2)}" result="${blurred}"/><feOffset in="${blurred}" dx="${number(shadow.offsetX)}" dy="${number(shadow.offsetY)}" result="${offset}"/><feFlood flood-color="${attribute(colorToOpaqueSrgbCss(shadow.color))}" flood-opacity="${number(shadow.color.alpha)}" result="${shadowColor}"/><feComposite in="${shadowColor}" in2="${offset}" operator="in" result="${shadowResult}"/><feMerge result="${result}"><feMergeNode in="${shadowResult}"/><feMergeNode in="${input}"/></feMerge>`;
    }).join("");
    definitions.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${number(-extent)}" y="${number(-extent)}" width="${number(node.width + extent * 2)}" height="${number(node.height + extent * 2)}">${primitives}</filter>`);
    return ` filter="url(#${id})"`;
  };
  /** A sole Layer Blur maps directly to SVG's source-graphic Gaussian blur.
   * Ordered blends with shadows, inner shadows or backdrop sampling retain the
   * explicit compatibility fallback because their intermediate composition is
   * not represented by this one-input filter. */
  const layerBlurFilter = (node: CanvasNode) => {
    if (!hasStandaloneLayerBlur(node)) return "";
    const radius = activeEffects(node)[0]!.layerBlur!.radius;
    const extent = Math.max(1, radius + 1);
    const id = `makefigma-layer-blur-${nextDefinitionId++}`;
    definitions.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${number(-extent)}" y="${number(-extent)}" width="${number(node.width + extent * 2)}" height="${number(node.height + extent * 2)}"><feGaussianBlur in="SourceGraphic" stdDeviation="${number(radius / 2)}"/></filter>`);
    return ` filter="url(#${id})"`;
  };
  /** SVG preserves a standalone Inner Shadow with an alpha-only source,
   * morphology spread, offset blur and an explicit SourceAlpha clip. */
  const innerShadowFilter = (node: CanvasNode) => {
    if (!hasStandaloneInnerShadow(node)) return "";
    const shadow = activeEffects(node)[0]!.innerShadow!;
    const id = `makefigma-inner-shadow-${nextDefinitionId++}`;
    const color = colorToOpaqueSrgbCss(shadow.color);
    const blur = Math.max(0, shadow.blurRadius);
    const extent = blur + Math.abs(shadow.spread) + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) + 1;
    const spread = shadow.spread === 0 ? "" : `<feMorphology in="SourceAlpha" operator="${shadow.spread > 0 ? "dilate" : "erode"}" radius="${number(Math.abs(shadow.spread))}" result="spread"/>`;
    const source = shadow.spread === 0 ? "SourceAlpha" : "spread";
    definitions.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${number(-extent)}" y="${number(-extent)}" width="${number(node.width + extent * 2)}" height="${number(node.height + extent * 2)}">${spread}<feGaussianBlur in="${source}" stdDeviation="${number(blur / 2)}" result="blur"/><feOffset in="blur" dx="${number(-shadow.offsetX)}" dy="${number(-shadow.offsetY)}" result="offsetBlur"/><feComposite in="offsetBlur" in2="SourceAlpha" operator="in" result="innerMask"/><feFlood flood-color="${attribute(color)}" flood-opacity="${number(shadow.color.alpha)}" result="innerColor"/><feComposite in="innerColor" in2="innerMask" operator="in" result="innerShadow"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="innerShadow"/></feMerge></filter>`);
    return ` filter="url(#${id})"`;
  };
  // Decorative Line endpoints (arrowheads, diamond, dot) are filled from the
  // shared `decorative-cap-mesh` triangle source — the exact geometry Canvas
  // draws and hit testing selects — instead of an independently sized SVG
  // <marker>. `endpoint`/`direction` place it in the Line's local space.
  const decorativeCapPaint = (cap: CanvasNode["strokeCapStart"], endpoint: number, direction: -1 | 1, node: CanvasNode, paint: SvgPaint) => {
    if (!isDecorativeCap(cap)) return "";
    const d = decorativeCapMeshPath(cap, endpoint, direction, node.strokeWidth, number);
    if (!d) return "";
    return `<path d="${d}" fill="${attribute(paint.value)}"${paintOpacity("fill", paint)} stroke="none" fill-rule="nonzero"/>`;
  };
  const connectorDecorativeCapPaint = (node: CanvasNode, path: NonNullable<ReturnType<typeof connectorPathForNode>>, paint: SvgPaint) => connectorEndpointDecorations(node, path).map((decoration) => {
    const d = connectorDecorationTriangles(decoration, node.strokeWidth).map(([a, b, c]) => `M ${number(a.x)} ${number(a.y)} L ${number(b.x)} ${number(b.y)} L ${number(c.x)} ${number(c.y)} Z`).join(" ");
    return `<path d="${d}" fill="${attribute(paint.value)}"${paintOpacity("fill", paint)} stroke="none" fill-rule="nonzero"/>`;
  }).join("");
  const shape = (node: CanvasNode, fill: SvgPaint, stroke: SvgPaint, fillRule = "nonzero") => {
    const common = `fill="${attribute(fill.value)}"${paintOpacity("fill", fill)} stroke="${attribute(stroke.value)}"${paintOpacity("stroke", stroke)} fill-rule="${fillRule}" stroke-linecap="${svgStrokeCap(node)}" stroke-linejoin="${attribute(node.strokeJoin ?? "miter")}" stroke-miterlimit="${number(node.strokeMiterLimit ?? 10)}"${node.strokeDashPattern?.length ? ` stroke-dasharray="${node.strokeDashPattern.map(number).join(" ")}"` : ""}${stroke.value !== "none" ? ` stroke-width="${number(node.strokeWidth)}"` : ""}`;
    if (node.kind === "connector") {
      const connectorPath = node.kind === "connector" ? connectorPathForNode(node, { nodes, defaultPageId: options.defaultPageId, nodeById: byId, worldTransformByNodeId }) : undefined;
      if (connectorPath) return `<path d="${connectorPathSvgD(connectorPath, number)}" ${common}/>${stroke.value === "none" ? "" : connectorDecorativeCapPaint(node, connectorPath, stroke)}`;
    }
    if (node.kind === "line") {
      const markers = stroke.value === "none" ? "" : `${decorativeCapPaint(node.strokeCapStart, 0, -1, node, stroke)}${decorativeCapPaint(node.strokeCapEnd, node.width, 1, node, stroke)}`;
      if (stroke.value !== "none" && !node.strokeDashPattern?.length && needsIndependentLineOutline(node)) {
        return `<path d="${solidLineStrokeOutlinePath(node.width, node.strokeWidth, node.strokeCapStart, node.strokeCapEnd, number)}" fill="${attribute(stroke.value)}"${paintOpacity("fill", stroke)} stroke="none" fill-rule="nonzero"/>${markers}`;
      }
      return `<path d="M 0 0 H ${number(node.width)}" ${common}/>${markers}`;
    }
    if (node.kind === "ellipse") {
      if (node.arcData) return `<path d="${ellipseArcPath(node)}" ${common.replace(`fill-rule="${fillRule}"`, 'fill-rule="evenodd"')}/>`;
      return `<ellipse cx="${number(node.width / 2)}" cy="${number(node.height / 2)}" rx="${number(node.width / 2)}" ry="${number(node.height / 2)}" ${common}/>`;
    }
    if (node.kind === "shapeWithText") {
      const shapePath = shapeWithTextPath(node.shapeWithTextType, node.width, node.height);
      if (shapePath?.kind === "ellipse") return `<ellipse cx="${number(node.width / 2)}" cy="${number(node.height / 2)}" rx="${number(node.width / 2)}" ry="${number(node.height / 2)}" ${common}/>`;
      const d = shapePath ? shapeWithTextPathD(shapePath, number) : undefined;
      if (d) return `<path d="${d}" ${common}/>`;
    }
    if (node.kind === "vector" && node.vectorPath) {
      const vectorPath = options.vectorPaths?.get(node.id) ?? node.vectorPath;
      return `<path d="${vectorPathSvgD(vectorPath, number)}" ${common.replace(`fill-rule="${fillRule}"`, `fill-rule="${vectorPath.fillRule === "evenOdd" ? "evenodd" : "nonzero"}"`)}/>`;
    }
    const parametricShape = nodeParametricShape(node);
    if (parametricShape) {
      const derived = options.parametricShapePaths?.get(node.id);
      const points = derived && derived.length >= 3 && derived.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        ? derived
        : parametricShapePoints(node.width, node.height, parametricShape);
      return `<path d="${parametricShapePath(points, number)}" ${common}/>`;
    }
    return `<path d="${roundedRectPath(node.width, node.height, node.radius, node.cornerRadii, node.cornerSmoothing)}" ${common}/>`;
  };
  const imageClipMarkup = (node: CanvasNode) => {
    if (node.kind === "ellipse" && !node.arcData) return `<ellipse cx="${number(node.width / 2)}" cy="${number(node.height / 2)}" rx="${number(node.width / 2)}" ry="${number(node.height / 2)}"/>`;
    if (["frame", "rectangle", "image"].includes(node.kind)) return `<path d="${roundedRectPath(node.width, node.height, node.radius, node.cornerRadii, node.cornerSmoothing)}"/>`;
    return undefined;
  };
  const rasterImageMarkup = (node: CanvasNode, href: string, strokes: SvgPaint[]) => {
    const clip = imageClipMarkup(node);
    if (!clip) return undefined;
    const clipId = `makefigma-image-clip-${nextDefinitionId++}`;
    definitions.push(`<clipPath id="${clipId}">${clip}</clipPath>`);
    // `slice` matches Canvas's cover placement: an asset always fills the node
    // geometry while preserving its own aspect ratio before clipping.
    const image = `<image href="${attribute(href)}" x="0" y="0" width="${number(node.width)}" height="${number(node.height)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`;
    const outline = strokes.filter(() => node.strokeWidth > 0).map((paint) => shape(node, { value: "none" }, paint)).join("");
    return `${image}${outline}`;
  };
  const paintLayerPresentation = (layer: DocumentPaintLayer) => `${layer.opacity < 1 ? ` opacity="${number(layer.opacity)}"` : ""}${layer.blendMode !== "normal" && !isLinearBlendMode(layer.blendMode) ? ` style="mix-blend-mode:${attribute(layer.blendMode)}"` : ""}`;
  const versionedFillMarkup = (node: CanvasNode) => normalizedFillLayers(node).map((layer) => {
    const presentation = paintLayerPresentation(layer);
    if (layer.paint) {
      return `<g${presentation}>${shape(node, paintValue(layer.paint), { value: "none" })}</g>`;
    }
    if (!layer.image) return "";
    if (!imageFiltersAreNeutral(layer.image.filters)) {
      reportFallback("image-filters", "Image adjustments are preserved in Canonical data but structural SVG export does not yet reproduce Figma's private filter shader.", node.id);
    }
    const supplied = options.imageDataUris?.get(layer.image.assetId);
    const href = isSafeEmbeddedRasterDataUri(supplied) ? supplied : undefined;
    if (!href) {
      reportFallback("image-asset", "Paint Stack image bytes were unavailable or cannot be embedded for this SVG export.", node.id);
      return "";
    }
    const transform = resolvedImagePaintTransform(layer.image, node.width, node.height);
    const layout = imagePaintLayoutBox(layer.image, node.width, node.height);
    if (!transform || !layout) {
      reportFallback("image-transform", "Image Paint rotation or transform is invalid for this scale mode.", node.id);
      return "";
    }
    const matrix = `matrix(${number(transform.a)} ${number(transform.b)} ${number(transform.c)} ${number(transform.d)} ${number(transform.e)} ${number(transform.f)})`;
    if (layer.image.scaleMode === "tile") {
      const patternId = `makefigma-image-pattern-${nextDefinitionId++}`;
      const tileWidth = Math.max(1, node.width / 4);
      const tileHeight = Math.max(1, node.height / 4);
      definitions.push(`<pattern id="${patternId}" patternUnits="userSpaceOnUse" width="${number(tileWidth)}" height="${number(tileHeight)}" patternTransform="${matrix}"><image href="${attribute(href)}" x="0" y="0" width="${number(tileWidth)}" height="${number(tileHeight)}" preserveAspectRatio="xMidYMid slice"/></pattern>`);
      return `<g${presentation}>${shape(node, { value: `url(#${patternId})` }, { value: "none" })}</g>`;
    }
    const clip = imageClipMarkup(node) ?? shape(node, { value: "#ffffff" }, { value: "none" });
    const clipId = `makefigma-stack-image-clip-${nextDefinitionId++}`;
    definitions.push(`<clipPath id="${clipId}">${clip}</clipPath>`);
    const preserveAspectRatio = layer.image.scaleMode === "fit" ? "xMidYMid meet" : "xMidYMid slice";
    return `<g${presentation} clip-path="url(#${clipId})"><g transform="${matrix}"><image href="${attribute(href)}" x="${number(layout.x)}" y="${number(layout.y)}" width="${number(layout.width)}" height="${number(layout.height)}" preserveAspectRatio="${preserveAspectRatio}"/></g></g>`;
  }).join("");
  const imageStrokePaint = (node: CanvasNode, layer: DocumentPaintLayer): SvgPaint | undefined => {
    if (!layer.image) return undefined;
    if (!imageFiltersAreNeutral(layer.image.filters)) {
      reportFallback("image-filters", "Image stroke adjustments are preserved in Canonical data but structural SVG export does not yet reproduce Figma's private filter shader.", node.id);
    }
    const supplied = options.imageDataUris?.get(layer.image.assetId);
    const href = isSafeEmbeddedRasterDataUri(supplied) ? supplied : undefined;
    if (!href) {
      reportFallback("image-asset", "Paint Stack image bytes were unavailable or cannot be embedded for this SVG export.", node.id);
      return undefined;
    }
    const transform = resolvedImagePaintTransform(layer.image, node.width, node.height);
    const layout = imagePaintLayoutBox(layer.image, node.width, node.height);
    if (!transform || !layout) {
      reportFallback("image-transform", "Image Paint rotation or transform is invalid for this scale mode.", node.id);
      return undefined;
    }
    const matrix = `matrix(${number(transform.a)} ${number(transform.b)} ${number(transform.c)} ${number(transform.d)} ${number(transform.e)} ${number(transform.f)})`;
    const patternId = `makefigma-stroke-image-pattern-${nextDefinitionId++}`;
    if (layer.image.scaleMode === "tile") {
      const tileWidth = Math.max(1, node.width / 4);
      const tileHeight = Math.max(1, Math.max(node.height, node.strokeWidth) / 4);
      definitions.push(`<pattern id="${patternId}" patternUnits="userSpaceOnUse" width="${number(tileWidth)}" height="${number(tileHeight)}" patternTransform="${matrix}"><image href="${attribute(href)}" x="0" y="0" width="${number(tileWidth)}" height="${number(tileHeight)}" preserveAspectRatio="xMidYMid slice"/></pattern>`);
    } else {
      const height = Math.max(layout.height, node.strokeWidth, 1);
      const preserveAspectRatio = layer.image.scaleMode === "fit" ? "xMidYMid meet" : "xMidYMid slice";
      definitions.push(`<pattern id="${patternId}" patternUnits="userSpaceOnUse" x="${number(layout.x)}" y="${number(layout.y)}" width="${number(Math.max(layout.width, 1))}" height="${number(height)}" patternTransform="${matrix}"><image href="${attribute(href)}" x="0" y="0" width="${number(Math.max(layout.width, 1))}" height="${number(height)}" preserveAspectRatio="${preserveAspectRatio}"/></pattern>`);
    }
    return { value: `url(#${patternId})` };
  };
  const versionedStrokeMarkup = (node: CanvasNode) => node.strokeWidth <= 0 ? "" : normalizedStrokeLayers(node).map((layer) => {
    const paint = layer.paint ? paintValue(layer.paint) : imageStrokePaint(node, layer);
    return paint ? `<g${paintLayerPresentation(layer)}>${shape(node, { value: "none" }, paint)}</g>` : "";
  }).join("");
  const textStylePaintLayers = (node: CanvasNode, style: RenderTextStyle): readonly DocumentPaintLayer[] => {
    if (style.fillStack !== undefined) return style.fillStack.layers;
    if (style.color) return [{ visible: true, opacity: 1, blendMode: "normal", paint: { css: colorToSrgbCss(style.color), color: style.color } }];
    return node.fillStack !== undefined ? node.fillStack.layers : normalizedFillLayers(node);
  };
  const textStylePaintAttributes = (node: CanvasNode, style: RenderTextStyle, layerIndex: number) => {
    if (node.kind !== "textPath" && style.fillStack === undefined) {
      if (layerIndex > 0) return ` fill="none"`;
      return style.color ? ` fill="${attribute(colorToSrgbCss(style.color))}"` : "";
    }
    const layer = textStylePaintLayers(node, style)[layerIndex];
    if (!layer?.visible || layer.opacity <= 0) return ` fill="none"`;
    const paint = layer.paint
      ? paintValue({ ...layer.paint, layerOpacity: layer.opacity })
      : imageStrokePaint(node, layer);
    if (!paint) return ` fill="none"`;
    const opacity = layer.paint ? paint.opacity : layer.opacity;
    const blend = layer.blendMode !== "normal" && !isLinearBlendMode(layer.blendMode)
      ? ` style="mix-blend-mode:${attribute(layer.blendMode)}"`
      : "";
    return ` fill="${attribute(paint.value)}"${opacity === undefined || opacity >= 1 ? "" : ` fill-opacity="${number(Math.max(0, opacity))}"`}${blend}`;
  };
  const richTextPathMarkup = (node: CanvasNode, fill: SvgPaint) => {
    const layout = options.textLayouts?.get(node.id);
    const line = layout?.lines.length === 1 ? layout.lines[0] : undefined;
    const primary = node.textProperties?.runs[0];
    const geometry = textPathGeometry(node.vectorPath, node.textPathMetadata);
    const traversal = textPathTraversalVectorPath(node.vectorPath, node.textPathMetadata);
    if (!line || !layout?.unitsPerEm || !primary || !geometry || !traversal || line.advance === undefined) return undefined;
    const pathId = `makefigma-text-path-${nextDefinitionId++}`;
    definitions.push(`<path id="${pathId}" d="${vectorPathSvgD(traversal, number)}"/>`);
    const source = node.text ?? "";
    const sourceLength = new TextEncoder().encode(source).byteLength;
    const spans = styledTextSpans(source, 0, sourceLength, node.textProperties);
    if (!spans.length && source) return undefined;
    const baseStart = geometry.length * node.textPathMetadata!.startPosition;
    const available = Math.max(0, geometry.length - baseStart);
    const shapedWidth = line.advance * primary.fontSize / layout.unitsPerEm;
    const justified = node.textPathMetadata!.textAlignHorizontal === "JUSTIFIED";
    const anchor = node.textPathMetadata!.textAlignHorizontal === "CENTER" ? "middle" : node.textPathMetadata!.textAlignHorizontal === "RIGHT" ? "end" : "start";
    const startOffset = node.textPathMetadata!.textAlignHorizontal === "CENTER"
      ? baseStart + available / 2
      : node.textPathMetadata!.textAlignHorizontal === "RIGHT"
        ? geometry.length
        : baseStart;
    const textLength = justified ? available : shapedWidth;
    const vertical = node.textPathMetadata!.textAlignVertical === "TOP" ? primary.fontSize * .4 : node.textPathMetadata!.textAlignVertical === "BOTTOM" ? -primary.fontSize * .4 : 0;
    const fallbackFamilies = (node.textProperties?.fallbackFonts ?? [])
      .filter((font) => isSafeEmbeddedFontDataUri(options.fontDataUris?.get(font.assetId)))
      .map((font) => svgFontFamily(font.assetId));
    const layerCount = Math.max(1, ...node.textProperties!.runs.map((run) => textStylePaintLayers(node, run).length));
    const body = (layerIndex: number) => spans.map((span) => `<tspan ${svgTextStyleAttributes(span.style, options.fontDataUris, fallbackFamilies, false)}${svgHyperlinkDataAttributes(span.style)}${textStylePaintAttributes(node, span.style, layerIndex)}>${escapeSvgText(span.text)}</tspan>`).join("");
    return Array.from({ length: layerCount }, (_, layerIndex) => `<text fill="${attribute(fill.value)}"${fill.opacity === undefined ? "" : ` fill-opacity="${number(fill.opacity)}"`} text-anchor="${anchor}" direction="${line.direction}" dominant-baseline="alphabetic"><textPath href="#${pathId}" startOffset="${number(startOffset)}" dy="${number(vertical)}" textLength="${number(Math.max(0, textLength))}" lengthAdjust="spacingAndGlyphs">${body(layerIndex)}</textPath></text>`).join("");
  };
  const filledPath = (path: string, paint: SvgPaint, transform = "") => `<path d="${path}"${transform} fill="${attribute(paint.value)}"${paintOpacity("fill", paint)} stroke="none"/>`;
  const filledEllipse = (cx: number, cy: number, rx: number, ry: number, paint: SvgPaint) => `<ellipse cx="${number(cx)}" cy="${number(cy)}" rx="${number(rx)}" ry="${number(ry)}" fill="${attribute(paint.value)}"${paintOpacity("fill", paint)} stroke="none"/>`;
  /** `drawImage(Image(svg))` in Chromium does not reliably honor a transform
   * nested inside `clipPath`; PNG/PDF exports then keep the Frame itself but
   * clip all descendants. Bake the Frame boundary into world coordinates so
   * interactive SVG and raster delivery share the same transform source. */
  const frameClipPath = (node: CanvasNode, transform: AffineMatrix) => {
    const points = roundedRectClipPoints(node.width, node.height, node.radius, node.cornerRadii).map((point) => transformPoint(transform, point));
    return `M ${points.map((point) => `${number(point.x)} ${number(point.y)}`).join(" L ")} Z`;
  };
  const alignedClosedShapeLayers = (node: CanvasNode, fills: SvgPaint[], strokes: SvgPaint[]) => {
    if ((!clipsChildren(node.kind) && node.kind !== "rectangle") || node.strokeWidth <= 0) return undefined;
    if (node.strokeWeights?.length === 4) return undefined;
    if (node.strokeAlign === "center") return undefined;
    const path = roundedRectPath(node.width, node.height, node.radius, node.cornerRadii, node.cornerSmoothing);
    const dashedStroke = (outline: string, paint: SvgPaint, transform = "") => `<path d="${outline}"${transform} fill="none" stroke="${attribute(paint.value)}"${paintOpacity("stroke", paint)} stroke-width="${number(node.strokeWidth)}" stroke-linecap="butt" stroke-linejoin="${attribute(node.strokeJoin ?? "miter")}" stroke-miterlimit="${number(node.strokeMiterLimit ?? 10)}" stroke-dasharray="${node.strokeDashPattern!.map(number).join(" ")}"/>`;
    if (node.strokeDashPattern?.length) {
      const half = node.strokeWidth / 2;
      if (node.strokeAlign === "outside") {
        const outerRadii = outsetRoundedRectRadii(node.width, node.height, node.radius, node.cornerRadii, half);
        const outer = roundedRectPath(node.width + node.strokeWidth, node.height + node.strokeWidth, node.radius + half, outerRadii, node.cornerSmoothing);
        return `${fills.map((paint) => filledPath(path, paint)).join("")}${strokes.map((paint) => dashedStroke(outer, paint, ` transform="translate(${-number(half)} ${-number(half)})"`)).join("")}`;
      }
      const innerWidth = Math.max(0, node.width - node.strokeWidth);
      const innerHeight = Math.max(0, node.height - node.strokeWidth);
      const innerRadii = insetRoundedRectRadii(node.width, node.height, node.radius, node.cornerRadii, half);
      const inner = roundedRectPath(innerWidth, innerHeight, Math.max(0, node.radius - half), innerRadii, node.cornerSmoothing);
      return `${fills.map((paint) => filledPath(path, paint)).join("")}${innerWidth > 0 && innerHeight > 0 ? strokes.map((paint) => dashedStroke(inner, paint, ` transform="translate(${number(half)} ${number(half)})"`)).join("") : ""}`;
    }
    const shortestSide = Math.max(0, Math.min(node.width, node.height));
    if (node.strokeAlign === "outside") {
      const outset = node.strokeWidth;
      const outerRadii = outsetRoundedRectRadii(node.width, node.height, node.radius, node.cornerRadii, outset);
      const outer = roundedRectPath(node.width + outset * 2, node.height + outset * 2, node.radius + outset, outerRadii, node.cornerSmoothing, -outset, -outset);
      const strokeMarkup = strokes.map((paint) => `<path d="${outer} ${path}" fill="${attribute(paint.value)}"${paintOpacity("fill", paint)} fill-rule="evenodd" stroke="none"/>`).join("");
      return `${fills.map((paint) => filledPath(path, paint)).join("")}${strokeMarkup}`;
    }
    const inset = Math.min(node.strokeWidth, shortestSide / 2);
    const innerWidth = Math.max(0, node.width - inset * 2);
    const innerHeight = Math.max(0, node.height - inset * 2);
    const innerRadii = insetRoundedRectRadii(node.width, node.height, node.radius, node.cornerRadii, inset);
    const inner = roundedRectPath(innerWidth, innerHeight, Math.max(0, node.radius - inset), innerRadii, node.cornerSmoothing, inset, inset);
    if (innerWidth <= 0 || innerHeight <= 0) {
      return `${fills.map((paint) => filledPath(path, paint)).join("")}${strokes.map((paint) => filledPath(path, paint)).join("")}`;
    }
    const strokeMarkup = strokes.map((paint) => `<path d="${path} ${inner}" fill="${attribute(paint.value)}"${paintOpacity("fill", paint)} fill-rule="evenodd" stroke="none"/>`).join("");
    return `${fills.map((paint) => filledPath(path, paint)).join("")}${strokeMarkup}`;
  };
  const alignedEllipseLayers = (node: CanvasNode, fills: SvgPaint[], strokes: SvgPaint[]) => {
    if (node.kind !== "ellipse" || node.arcData || node.strokeWidth <= 0 || node.strokeAlign === "center") return undefined;
    const cx = node.width / 2;
    const cy = node.height / 2;
    const ring = ellipseStrokeRing(node.width, node.height, node.strokeWidth, node.strokeAlign);
    if (!ring) return undefined;
    const inner = ring.innerRx !== undefined && ring.innerRy !== undefined
      ? fills.map((paint) => filledEllipse(cx, cy, ring.innerRx!, ring.innerRy!, paint)).join("")
      : "";
    return `${strokes.map((paint) => filledEllipse(cx, cy, ring.outerRx, ring.outerRy, paint)).join("")}${inner}`;
  };
  const perSideStrokeLayers = (node: CanvasNode, fills: SvgPaint[], strokes: SvgPaint[]) => {
    if ((!clipsChildren(node.kind) && node.kind !== "rectangle") || node.strokeWeights?.length !== 4) return undefined;
    const path = roundedRectPath(node.width, node.height, node.radius, node.cornerRadii, node.cornerSmoothing);
    const [top, right, bottom, left] = node.strokeWeights.map((value) => Math.max(0, value));
    const align = node.strokeAlign ?? "inside";
    const { topY, rightX, bottomY, leftX } = perSideStrokeCenters(node.width, node.height, [top, right, bottom, left], align);
    const sides: ReadonlyArray<readonly [width: number, d: string]> = [
      [top, `M 0 ${number(topY)} H ${number(node.width)}`],
      [right, `M ${number(rightX)} 0 V ${number(node.height)}`],
      [bottom, `M ${number(node.width)} ${number(bottomY)} H 0`],
      [left, `M ${number(leftX)} ${number(node.height)} V 0`],
    ];
    const rendered = sides.flatMap(([width, d]) => width > 0
      ? strokes.map((paint) => `<path d="${d}" fill="none" stroke="${attribute(paint.value)}"${paintOpacity("stroke", paint)} stroke-width="${number(width)}" stroke-linecap="butt" stroke-linejoin="${attribute(node.strokeJoin ?? "miter")}" stroke-miterlimit="${number(node.strokeMiterLimit ?? 10)}"${node.strokeDashPattern?.length ? ` stroke-dasharray="${node.strokeDashPattern.map(number).join(" ")}"` : ""}/>`)
      : []);
    const strokeMarkup = align === "inside"
      ? (() => {
        const clipId = `makefigma-stroke-clip-${nextDefinitionId++}`;
        definitions.push(`<clipPath id="${clipId}"><path d="${path}"/></clipPath>`);
        return `<g clip-path="url(#${clipId})">${rendered.join("")}</g>`;
      })()
      : rendered.join("");
    return `${fills.map((paint) => filledPath(path, paint)).join("")}${strokeMarkup}`;
  };
  const ownerEffect = (node: CanvasNode) => composedShadowBlurFilter(node) || dropShadowFilter(node) || layerBlurFilter(node) || innerShadowFilter(node);
  const ownerPresentationAttributes = (node: CanvasNode) => ` opacity="${number(node.opacity)}"${isolatesNormalBlend(node) ? ' style="isolation:isolate"' : blendStyle(node)}${ownerEffect(node)}`;
  const containerFillSourceNode = (node: CanvasNode): CanvasNode => ({
    ...node,
    strokeWidth: 0,
    strokeWeights: undefined,
    strokeStack: { layers: [] },
  });
  const containerStrokeSourceNode = (node: CanvasNode): CanvasNode => ({
    ...node,
    assetId: undefined,
    fillStack: { layers: [] },
  });
  const nodeMarkup = (node: CanvasNode, applyOwnerPresentation = true) => {
    const specialFallback = specialNodeFallback(node, "svg");
    if (specialFallback) reportFallback("special-node", `${specialFallback.code}: ${specialFallback.reason}`, node.id);
    if (node.kind === "group" || node.kind === "slice" || node.kind === "slideGrid" || node.kind === "slideRow" || node.kind === "transformGroup") return "";
    if (node.kind === "booleanOperation") {
      const vectorPath = options.booleanPaths?.get(node.id);
      const source = children.get(node.id)?.find((candidate) => candidate.kind === "vector");
      if (!vectorPath || !source || source.kind !== "vector") return "";
      const transform = worldTransformByNodeId.get(node.id);
      if (!transform) return "";
      const matrix = `matrix(${number(transform.a)} ${number(transform.b)} ${number(transform.c)} ${number(transform.d)} ${number(transform.e)} ${number(transform.f)})`;
      // The Boolean wrapper is the rendered node: Canvas isolates this derived
      // result before it applies the wrapper's ordered effects. Retain that
      // ownership in SVG so its PNG/PDF raster consumers do not silently lose
      // a supported standalone effect.
      const presentation = applyOwnerPresentation
        ? ` opacity="${number(node.opacity * source.opacity)}"${blendStyle(node)}${ownerEffect(node)}`
        : "";
      const derived = { ...source, vectorPath };
      const fillPaints = activePaints(source, "fill").map(paintValue);
      const strokePaints = activePaints(source, "stroke").map(paintValue);
      const layers = [
        ...fillPaints.map((paint) => shape(derived, paint, { value: "none" })),
        ...strokePaints.filter(() => source.strokeWidth > 0).map((paint) => shape(derived, { value: "none" }, paint)),
      ].join("");
      return `<g transform="${matrix}"${presentation}>${layers}</g>`;
    }
    const fills = activePaints(node, "fill");
    const strokes = activePaints(node, "stroke");
    const transform = worldTransformByNodeId.get(node.id);
    if (!transform) return "";
    const matrix = `matrix(${number(transform.a)} ${number(transform.b)} ${number(transform.c)} ${number(transform.d)} ${number(transform.e)} ${number(transform.f)})`;
    const presentation = applyOwnerPresentation ? ownerPresentationAttributes(node) : "";
    if (node.kind === "text") {
      const fill = fills[0] ? paintValue(fills[0]) : { value: "none" };
      return `<g transform="${matrix}"${presentation}>${svgTextMarkup(node, fill, options.fontDataUris, options.textLayouts?.get(node.id), (style, layerIndex) => textStylePaintAttributes(node, style, layerIndex))}</g>`;
    }
    if (node.kind === "textPath") {
      const richMarkup = richTextPathMarkup(node, { value: "none" });
      const markup = richMarkup ?? normalizedFillLayers(node).flatMap((layer) => {
        const paint = layer.paint ? paintValue({ ...layer.paint, layerOpacity: layer.opacity }) : imageStrokePaint(node, layer);
        return paint ? [{ layer, paint }] : [];
      }).map(({ layer, paint }) => {
          const body = svgTextPathMarkup(node, paint.value, paint.opacity, number);
          return body ? `<g${paintLayerPresentation(layer)}>${body}</g>` : "";
        }).join("");
      if (markup) return `<g transform="${matrix}"${presentation}>${markup}</g>`;
    }
    // Versioned stacks serialize their own ordered layers below. Avoid
    // allocating duplicate gradient definitions that no rendered element can
    // reference.
    const fillPaints = node.fillStack ? [] : fills.map(paintValue);
    const strokePaints = node.strokeStack ? [] : strokes.map(paintValue);
    const suppliedAssetUri = node.assetId ? options.imageDataUris?.get(node.assetId) : undefined;
    const assetUri = isSafeEmbeddedRasterDataUri(suppliedAssetUri) ? suppliedAssetUri : undefined;
    if (node.assetId && assetUri) {
      const image = rasterImageMarkup(node, assetUri, strokePaints);
      if (image) return `<g transform="${matrix}"${presentation}>${image}</g>`;
    }
    if (node.assetId && !assetUri) reportFallback("image-asset", "Image asset bytes were unavailable or cannot be embedded for this SVG export.", node.id);
    const vectorRegionPaints = node.kind === "vector" && node.vectorPath
      ? vectorNetworkRegionPaintPlansFromExtension(node.extensions, node.vectorPath)
      : undefined;
    if (vectorRegionPaints?.length) {
      const regionFills = vectorRegionPaints.map((region) => {
        const regionNode: CanvasNode = {
          ...node,
          vectorPath: region.path,
          ...(region.fillStack ? { fillStack: region.fillStack } : {}),
        };
        if (region.fillStack || node.fillStack) return versionedFillMarkup(regionNode);
        return fills.map(paintValue).map((paint) => shape(regionNode, paint, { value: "none" })).join("");
      }).join("");
      const regionStrokes = node.strokeStack
        ? versionedStrokeMarkup(node)
        : strokes.map(paintValue).filter(() => node.strokeWidth > 0).map((paint) => shape(node, { value: "none" }, paint)).join("");
      return `<g transform="${matrix}"${presentation}>${regionFills}${regionStrokes}</g>`;
    }
    const layers = node.fillStack || node.strokeStack
      ? `${node.fillStack ? versionedFillMarkup(node) : fillPaints.map((paint) => shape(node, paint, { value: "none" })).join("")}${node.strokeStack ? versionedStrokeMarkup(node) : strokePaints.filter(() => node.strokeWidth > 0).map((paint) => shape(node, { value: "none" }, paint)).join("")}`
      : perSideStrokeLayers(node, fillPaints, strokePaints)
        ?? alignedClosedShapeLayers(node, fillPaints, strokePaints)
        ?? alignedEllipseLayers(node, fillPaints, strokePaints)
        ?? [
          ...fillPaints.map((paint) => shape(node, paint, { value: "none" })),
          ...strokePaints.filter(() => node.strokeWidth > 0).map((paint) => shape(node, { value: "none" }, paint)),
        ].join("");
    const connectorLabel = node.kind === "connector"
      ? (() => {
        const path = connectorPathForNode(node, { nodes, defaultPageId: options.defaultPageId, nodeById: byId, worldTransformByNodeId }); const label = path && connectorLabelLayout(node, path);
        return label ? `<g><rect x="${number(label.x - label.width / 2)}" y="${number(label.y - label.height / 2)}" width="${number(label.width)}" height="${number(label.height)}" fill="#ffffff" fill-opacity=".94"/><text fill="#0f172a" font-family="sans-serif" font-size="12" text-anchor="middle" dominant-baseline="central">${label.lines.map((line, index) => `<tspan x="${number(label.x)}" y="${number(label.y - (label.lines.length - 1) * 8 + index * 16)}">${escapeSvgText(line)}</tspan>`).join("")}</text></g>` : "";
      })()
      : "";
    const shapeWithTextDecoration = node.kind === "shapeWithText" && node.strokeWidth > 0
      ? shapeWithTextDecorations(node.shapeWithTextType, node.width, node.height).flatMap((decoration) => strokePaints.filter((paint) => paint.value !== "none").map((paint) => `<path d="${shapeWithTextDecorationPathD(decoration, number)}" fill="none" stroke="${attribute(paint.value)}"${paintOpacity("stroke", paint)} stroke-width="${number(node.strokeWidth)}" stroke-linecap="${svgStrokeCap(node)}" stroke-linejoin="${attribute(node.strokeJoin ?? "miter")}"/>`)).join("")
      : "";
    const specialComposition = svgSpecialNodeComposition(node, number, options.fontDataUris, (style, layerIndex) => textStylePaintAttributes(node, style, layerIndex));
    return `<g transform="${matrix}"${presentation}>${layers}${connectorLabel}${shapeWithTextDecoration}${specialComposition}</g>`;
  };
  const renderSiblings = (siblings: readonly CanvasNode[], lineage: Set<string>): string => {
    let markup = "";
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index];
      if (node.isMask) {
        let end = index + 1;
        while (end < siblings.length && !siblings[end].isMask) end += 1;
        const targets = siblings.slice(index + 1, end);
        if (targets.length) {
          const maskId = `makefigma-alpha-mask-${nextDefinitionId++}`;
          // `mask-type="alpha"` freezes G4 to source alpha rather than SVG's
          // luminance default. The mask source keeps its world transform, so
          // rotation and nested Frame clips match the Canvas composition path.
          definitions.push(`<mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" mask-type="alpha">${renderBranch(node, lineage)}</mask>`);
          markup += `<g mask="url(#${maskId})">${renderSiblings(targets, lineage)}</g>`;
        }
        index = end - 1;
        continue;
      }
      markup += renderBranch(node, lineage);
    }
    return markup;
  };
  const renderBranch = (node: CanvasNode, lineage: Set<string>): string => {
    if (lineage.has(node.id)) return "";
    if (node.kind === "booleanOperation") {
      if (!options.booleanPaths?.has(node.id)) {
        reportFallback("live-boolean", "Live BooleanOperation layers are omitted from SVG export; flatten them first to export their Rust-derived vector result.", node.id);
        return "";
      }
      return nodeMarkup(node);
    }
    const descendants = children.get(node.id) ?? [];
    const nextLineage = new Set(lineage).add(node.id);
    const descendantsMarkup = renderSiblings(descendants, nextLineage);
    const isolatesSubtree = requiresSubtreeComposition(node, descendants.length > 0);
    const wrapOwnerPresentation = (content: string) => isolatesSubtree && content
      ? `<g${ownerPresentationAttributes(node)}>${content}</g>`
      : content;
    if (node.kind === "transformGroup") {
      // Let the regular node path report an unsupported modifier, then keep
      // the one-time source subtree visible. Supported bounded linear Repeat
      // instances wrap that same subtree, preserving its sibling paint order.
      const own = nodeMarkup(node, !isolatesSubtree);
      const repeatSubtree = transformGroupRepeatSubtree(nodes, node, children);
      const repeats = repeatSubtree ? transformGroupRepeatMatrices(nodes, node) : undefined;
      if (node.transformModifiers?.length && !repeatSubtree) {
        reportFallback(
          "transform-group-repeat",
          "Nested Repeat expansion exceeds the shared 64-derived-instance budget or contains a composition path that structural SVG cannot reproduce; exported the authored source subtree once.",
          node.id,
        );
      }
      const derived = repeats?.map((matrix) => `<g transform="${affineSvgMatrix(matrix, number)}">${renderSiblings(descendants, nextLineage)}</g>`).join("") ?? "";
      return wrapOwnerPresentation(`${own}${descendantsMarkup}${derived}`);
    }
    const includeOwn = !selectionContextNodeIds.has(node.id);
    const splitContainerPaint = includeOwn && clipsChildren(node.kind) && Boolean(descendantsMarkup) && node.strokeWidth > 0;
    const own = includeOwn
      ? nodeMarkup(splitContainerPaint ? containerFillSourceNode(node) : node, !isolatesSubtree)
      : "";
    const ownerStroke = splitContainerPaint ? nodeMarkup(containerStrokeSourceNode(node), !isolatesSubtree) : "";
    if (!clipsChildren(node.kind) || node.clipsContent === false || !descendantsMarkup) return wrapOwnerPresentation(`${own}${descendantsMarkup}${ownerStroke}`);
    const transform = worldTransformByNodeId.get(node.id);
    if (!transform) return wrapOwnerPresentation(`${own}${descendantsMarkup}`);
    const clipId = `makefigma-clip-${nextDefinitionId++}`;
    definitions.push(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="${frameClipPath(node, transform)}"/></clipPath>`);
    return wrapOwnerPresentation(`${own}<g clip-path="url(#${clipId})">${descendantsMarkup}</g>${ownerStroke}`);
  };
  const content = renderSiblings(roots, new Set());
  const croppedContent = requestedSlice && sliceTransform && slicePoints
    ? (() => {
      const clipId = `makefigma-slice-${nextDefinitionId++}`;
      definitions.push(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="M ${slicePoints.map((point) => `${number(point.x)} ${number(point.y)}`).join(" L ")} Z"/></clipPath>`);
      return `<g clip-path="url(#${clipId})">${content}</g>`;
    })()
    : content;
  if (options.sliceId && !requestedSlice) reportFallback("slice-selection", "Requested Slice is unavailable on this page; exported the full page instead.", options.sliceId);
  if (requestedSlice && !sliceTransform) reportFallback("slice-selection", "Slice has an invalid world transform; exported the full page instead.", requestedSlice.id);
  const defs = definitions.length ? `<defs>${definitions.join("")}</defs>` : "";
  return {
    svg: `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"${options.sourceRevision === undefined ? "" : ` data-makefigma-source-revision="${number(options.sourceRevision)}"`} viewBox="${number(left)} ${number(top)} ${number(width)} ${number(height)}" width="${number(width)}" height="${number(height)}">${defs}${croppedContent}</svg>`,
    sourceRevision: options.sourceRevision,
    width,
    height,
    warnings: [...warnings],
    compatibilityFallbacks,
  };
}

function svgTextPathMarkup(node: CanvasNode, fill: string, opacity: number | undefined, number: (value: number) => string): string | undefined {
  const fontSize = node.textProperties?.runs[0]?.fontSize ?? 14;
  const glyphs = layoutTextPath(node, Math.max(1, fontSize * .6));
  if (!glyphs) return undefined;
  return glyphs.map((glyph) => `<text x="${number(glyph.x)}" y="${number(glyph.y)}" transform="rotate(${number(glyph.angle * 180 / Math.PI)} ${number(glyph.x)} ${number(glyph.y)})" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${number(fontSize)}" fill="${attribute(fill)}"${opacity === undefined ? "" : ` fill-opacity="${number(opacity)}"`}>${escapeSvgText(glyph.text)}</text>`).join("");
}

function escapeSvgText(value: string): string { return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;"); }

/** M6's plain-text card subset. It deliberately avoids pretending that a
 * generic SVG exporter performed rich-run shaping; Text and TextPath keep
 * their dedicated layout paths above. */
function svgSpecialNodeComposition(
  node: CanvasNode,
  number: (value: number) => string,
  fontDataUris?: ReadonlyMap<string, string>,
  textPaintAttributes?: (style: RenderTextStyle, layerIndex: number) => string,
): string {
  const text = node.kind === "shapeWithText" || node.kind === "sticky" || node.kind === "tableCell" ? node.text?.trim() : undefined;
  const textMarkup = text
    ? node.kind === "shapeWithText"
      ? svgShapeWithTextSublayerMarkup(node, number, fontDataUris, textPaintAttributes)
      : (() => {
      const x = 10;
      const y = 10;
      const anchor = "start";
      const lines = text.split(/\r\n|[\n\r\u2028\u2029]/u).slice(0, 8);
      const lineHeight = 16;
      const startY = y;
      return `<text x="${number(x)}" y="${number(startY)}" fill="#1f2937" font-family="sans-serif" font-size="14" text-anchor="${anchor}" dominant-baseline="central">${lines.map((line, index) => `<tspan x="${number(x)}" dy="${index ? number(lineHeight) : "0"}">${escapeSvgText(line)}</tspan>`).join("")}</text>`;
      })()
    : "";
  if (node.kind === "media") {
    const x = Math.max(12, node.width / 2 - 12); const y = Math.max(12, node.height / 2 - 14);
    return `${textMarkup}<path d="M ${number(x)} ${number(y)} L ${number(x)} ${number(y + 28)} L ${number(x + 24)} ${number(y + 14)} Z" fill="#f8fafc" fill-opacity=".9"/><text x="${number(node.width / 2)}" y="${number(Math.min(node.height - 12, y + 42))}" fill="#f8fafc" font-family="sans-serif" font-size="12" text-anchor="middle" dominant-baseline="central">Media preview</text>`;
  }
  if (node.kind === "embed" || node.kind === "linkUnfurl") {
    const metadata = node.kind === "embed" ? node.embedMetadata : node.linkUnfurlMetadata;
    const title = metadata?.title || metadata?.provider || (node.kind === "embed" ? "Embed preview" : "Link preview");
    const description = node.kind === "linkUnfurl" ? node.linkUnfurlMetadata?.description : node.embedMetadata?.canonicalUrl;
    const provider = metadata?.provider;
    const lines = [title, description, provider].filter((value): value is string => Boolean(value)).slice(0, 3);
    return `${textMarkup}<rect x="8" y="8" width="${number(Math.max(0, node.width - 16))}" height="${number(Math.max(0, node.height - 16))}" rx="4" fill="#f8fafc" fill-opacity=".86"/>${lines.map((line, index) => `<text x="16" y="${number(24 + index * 18)}" fill="#1f2937" font-family="sans-serif" font-size="${index ? "12" : "14"}" font-weight="${index ? "400" : "600"}" dominant-baseline="central">${escapeSvgText(line)}</text>`).join("")}`;
  }
  if (node.kind === "interactiveSlideElement") {
    const label = node.interactiveSlideElementType === "POLL" ? "Poll interaction" : "Interactive slide element";
    const x = Math.max(8, node.width / 2 - 34); const y = Math.max(8, node.height / 2 - 18);
    return `${textMarkup}<rect x="${number(x)}" y="${number(y)}" width="68" height="36" rx="18" fill="#475569" fill-opacity=".72"/><text x="${number(node.width / 2)}" y="${number(y + 18)}" fill="#f8fafc" font-family="sans-serif" font-size="12" text-anchor="middle" dominant-baseline="central">${label}</text>`;
  }
  if (node.kind !== "table" || !node.tableMetadata) return textMarkup;
  const columns = node.tableMetadata.columnWidths.filter((value) => Number.isFinite(value) && value > 0);
  const rows = node.tableMetadata.rowHeights.filter((value) => Number.isFinite(value) && value > 0);
  let x = 0; let y = 0;
  const vertical = columns.slice(0, -1).map((width) => { x += width; return `<path d="M ${number(x)} 0 V ${number(node.height)}" fill="none" stroke="#94a3b8" stroke-width="1"/>`; }).join("");
  const horizontal = rows.slice(0, -1).map((height) => { y += height; return `<path d="M 0 ${number(y)} H ${number(node.width)}" fill="none" stroke="#94a3b8" stroke-width="1"/>`; }).join("");
  return `${vertical}${horizontal}`;
}

function svgShapeWithTextSublayerMarkup(
  node: CanvasNode,
  number: (value: number) => string,
  fontDataUris?: ReadonlyMap<string, string>,
  textPaintAttributes?: (style: RenderTextStyle, layerIndex: number) => string,
): string {
  // Style-run offsets are UTF-8 byte ranges into the exact Canonical string.
  // Trimming here would shift every run after leading whitespace.
  const source = node.text ?? "";
  if (!source) return "";
  const primary = node.textProperties?.runs[0];
  const lineHeight = resolvedTextLineHeight(node.textProperties, primary?.fontSize ?? 14, 20);
  const alignment = node.textProperties?.paragraph.alignment ?? "center";
  const inset = 10;
  const availableWidth = Math.max(0, node.width - inset * 2);
  const approximateStyleMeasure = (value: string, style: RenderTextStyle) =>
    Array.from(value).length * (style.fontSize * .6 + Math.max(0, style.letterSpacing));
  const listMarkerGutter = textListMarkerGutterForProperties(source, node.textProperties, (value) =>
    approximateStyleMeasure(value, primary ?? { fontSize: 14, fontWeight: 400, italic: false, letterSpacing: 0 }));
  const listMarkerGap = listMarkerGutter > 0
    ? approximateStyleMeasure(" ", primary ?? { fontSize: 14, fontWeight: 400, italic: false, letterSpacing: 0 })
    : 0;
  const lines = layoutTextRanges({
    text: source,
    maxWidth: Math.max(1, availableWidth),
    firstLineIndent: (_index, start) => textParagraphIndentAt(node.textProperties, start) + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, start),
    paragraphIndent: (_index, start) => textListIndentationOffset(source, node.textProperties, start, listMarkerGutter),
    wrapStyle: (_index, start) => textParagraphWrapStyleAt(node.textProperties, start),
    hangingPunctuation: node.textProperties?.paragraph.hangingPunctuation ?? false,
    measure: (value) => Array.from(value).length * ((primary?.fontSize ?? 14) * .6 + Math.max(0, primary?.letterSpacing ?? 0)),
    measureRange: (start, end) => styledTextSpans(source, start, end, node.textProperties)
      .reduce((total, span) => total + approximateStyleMeasure(span.text, span.style), 0),
  }).slice(0, 8);
  const sourceBytes = new TextEncoder().encode(source);
  let previousEnd = 0;
  const firstLineFlags = lines.map((line, index) => {
    const skipped = new TextDecoder().decode(sourceBytes.slice(previousEnd, line.start));
    previousEnd = line.end;
    return index === 0 || /\r\n|[\n\r\u2028\u2029]/u.test(skipped);
  });
  const paragraphStarts = lines.map((line) => textParagraphStartAtOffset(source, line.start));
  let paragraphGapTotal = 0;
  let previousParagraphStart = 0;
  for (const [index, paragraphStart] of paragraphStarts.entries()) {
    if (index > 0 && firstLineFlags[index]) {
      paragraphGapTotal += textParagraphGap(node.textProperties, previousParagraphStart, paragraphStart);
      previousParagraphStart = paragraphStart;
    }
  }
  const lineHeights = paragraphStarts.map((start) => resolvedTextLineHeightAt(node.textProperties, start, primary?.fontSize ?? 14, 20));
  const capHeight = (primary?.fontSize ?? 14) * .7;
  const outerLeading = ((lineHeights[0] ?? lineHeight) + (lineHeights.at(-1) ?? lineHeight)) / 2 - capHeight;
  const totalHeight = Math.max(0, lineHeights.reduce((sum, value) => sum + value, 0) + paragraphGapTotal
    - (primary?.leadingTrim === "capHeight" ? outerLeading : 0));
  const startY = Math.max(10, (node.height - totalHeight) / 2 + (primary?.leadingTrim === "capHeight" ? capHeight : (primary?.fontSize ?? 14)));
  const fallbackFamilies = (node.textProperties?.fallbackFonts ?? [])
    .filter((font) => isSafeEmbeddedFontDataUri(fontDataUris?.get(font.assetId)))
    .map((font) => svgFontFamily(font.assetId));
  const layerCount = Math.max(1, ...(node.textProperties?.runs.map((run) => run.fillStack?.layers.length ?? 1) ?? [1]));
  const bodyForLayer = (layerIndex: number) => {
    let lineTop = startY;
    let paragraphIndex = 0;
    let previousParagraphStart = 0;
    return lines.map((line, index) => {
    const paragraphStart = paragraphStarts[index] ?? 0;
    if (index > 0 && firstLineFlags[index]) {
      lineTop += textParagraphGap(node.textProperties, previousParagraphStart, paragraphStart);
      previousParagraphStart = paragraphStart;
    }
    if (index > 0 && firstLineFlags[index]) paragraphIndex += 1;
    const listType = textParagraphListTypeAt(node.textProperties, paragraphStart);
    const spans = styledTextSpans(source, line.start, line.end, node.textProperties);
    const content = spans.map((span) => `<tspan ${svgTextStyleAttributes(span.style, fontDataUris, fallbackFamilies, !textPaintAttributes)}${svgHyperlinkDataAttributes(span.style)}${textPaintAttributes?.(span.style, layerIndex) ?? ""}>${text(span.text)}</tspan>`).join("");
    const nestingIndent = textListIndentationOffset(source, node.textProperties, line.start, listMarkerGutter);
    const indent = nestingIndent + (firstLineFlags[index]
      ? textParagraphIndentAt(node.textProperties, paragraphStart) + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, paragraphStart)
      : 0);
    const lineBoxWidth = Math.max(0, availableWidth - indent);
    const lineWidth = spans.reduce((total, span) => total + approximateStyleMeasure(span.text, span.style), 0);
    const hanging = node.textProperties?.paragraph.hangingPunctuation
      ? textHangingPunctuationOffsets(line.text, line.direction, (value) => approximateStyleMeasure(value, primary ?? { fontSize: 14, fontWeight: 400, italic: false, letterSpacing: 0 }))
      : { left: 0, right: 0 };
    const contentStart = textAlignedLineLeft(inset + indent, lineBoxWidth, lineWidth, alignment, line.direction, hanging);
    const anchor = alignment === "center" ? "middle" : alignment === "right" ? "end" : "start";
    const x = contentStart + (anchor === "middle" ? lineWidth / 2 : anchor === "end" ? lineWidth : 0);
    const marker = listType && firstLineFlags[index]
      ? `<tspan x="${number(contentStart - listMarkerGap)}" y="${number(lineTop)}" text-anchor="end" data-makefigma-list-marker="${listType.toUpperCase()}">${text(textListMarker(listType, paragraphIndex))}</tspan>`
      : "";
    const markup = `${marker}<tspan x="${number(x)}" y="${number(lineTop)}" text-anchor="${anchor}" direction="${line.direction}" unicode-bidi="plaintext">${content}</tspan>`;
    lineTop += lineHeights[index] ?? lineHeight;
    return markup;
  }).join("");
  };
  return Array.from({ length: layerCount }, (_, layerIndex) => `<text fill="#1f2937" font-family="sans-serif">${bodyForLayer(layerIndex)}</text>`).join("");
}

function roundedRectPath(width: number, height: number, radius: number, radii: CanvasNode["cornerRadii"], cornerSmoothing?: number, x = 0, y = 0) {
  const [topLeft, topRight, bottomRight, bottomLeft] = resolvedRadii(width, height, radius, radii);
  const smoothing = resolveCornerSmoothing(cornerSmoothing);
  if (smoothing > 0) {
    const exponent = cornerSmoothingExponent(smoothing);
    const segments = Math.round(8 + smoothing * 8);
    const corner = (centerX: number, centerY: number, cornerRadius: number, start: number, end: number) => {
      if (cornerRadius <= 0) return "";
      return Array.from({ length: segments }, (_, offset) => {
        const angle = start + (end - start) * (offset + 1) / segments;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const pointX = x + centerX + Math.sign(cosine) * Math.abs(cosine) ** (2 / exponent) * cornerRadius;
        const pointY = y + centerY + Math.sign(sine) * Math.abs(sine) ** (2 / exponent) * cornerRadius;
        return ` L ${number(pointX)} ${number(pointY)}`;
      }).join("");
    };
    return `M ${number(x + topLeft)} ${number(y)} H ${number(x + width - topRight)}${corner(width - topRight, topRight, topRight, -Math.PI / 2, 0)} V ${number(y + height - bottomRight)}${corner(width - bottomRight, height - bottomRight, bottomRight, 0, Math.PI / 2)} H ${number(x + bottomLeft)}${corner(bottomLeft, height - bottomLeft, bottomLeft, Math.PI / 2, Math.PI)} V ${number(y + topLeft)}${corner(topLeft, topLeft, topLeft, Math.PI, Math.PI * 1.5)} Z`;
  }
  return `M ${number(x + topLeft)} ${number(y)} H ${number(x + width - topRight)} A ${number(topRight)} ${number(topRight)} 0 0 1 ${number(x + width)} ${number(y + topRight)} V ${number(y + height - bottomRight)} A ${number(bottomRight)} ${number(bottomRight)} 0 0 1 ${number(x + width - bottomRight)} ${number(y + height)} H ${number(x + bottomLeft)} A ${number(bottomLeft)} ${number(bottomLeft)} 0 0 1 ${number(x)} ${number(y + height - bottomLeft)} V ${number(y + topLeft)} A ${number(topLeft)} ${number(topLeft)} 0 0 1 ${number(x + topLeft)} ${number(y)} Z`;
}

/** A transformed SVG clip cannot depend on a nested `transform` when that SVG
 * is decoded into an Image for PNG/PDF. Approximate each rounded corner with
 * three deterministic boundary points in the final world coordinate system. */
function roundedRectClipPoints(width: number, height: number, radius: number, radii: CanvasNode["cornerRadii"]) {
  const [topLeft, topRight, bottomRight, bottomLeft] = resolvedRadii(width, height, radius, radii);
  const points: Array<{ x: number; y: number }> = [{ x: topLeft, y: 0 }, { x: width - topRight, y: 0 }];
  const arc = (x: number, y: number, value: number, from: number, to: number) => {
    for (let index = 1; index <= 3; index += 1) {
      const angle = from + (to - from) * index / 3;
      points.push({ x: x + Math.cos(angle) * value, y: y + Math.sin(angle) * value });
    }
  };
  arc(width - topRight, topRight, topRight, -Math.PI / 2, 0);
  arc(width - bottomRight, height - bottomRight, bottomRight, 0, Math.PI / 2);
  arc(bottomLeft, height - bottomLeft, bottomLeft, Math.PI / 2, Math.PI);
  arc(topLeft, topLeft, topLeft, Math.PI, Math.PI * 1.5);
  return points;
}

function ellipseArcPath(node: CanvasNode) {
  const arc = node.arcData!;
  const start = arc.startingAngle * Math.PI / 180;
  const span = arc.endingAngle * Math.PI / 180 - start;
  const radiusX = node.width / 2;
  const radiusY = node.height / 2;
  const centerX = radiusX;
  const centerY = radiusY;
  // Preserve Figma's inclusive `innerRadius` range. At exactly one the two
  // contours coincide, which is intentionally a zero-area even-odd fill.
  const inner = Math.max(0, Math.min(1, arc.innerRadius));
  if (Math.abs(span) >= Math.PI * 2 - 1e-8) {
    const outer = `M ${number(centerX + radiusX)} ${number(centerY)} A ${number(radiusX)} ${number(radiusY)} 0 1 1 ${number(centerX - radiusX)} ${number(centerY)} A ${number(radiusX)} ${number(radiusY)} 0 1 1 ${number(centerX + radiusX)} ${number(centerY)}`;
    if (inner === 0) return `${outer} Z`;
    const innerX = radiusX * inner;
    const innerY = radiusY * inner;
    return `${outer} Z M ${number(centerX + innerX)} ${number(centerY)} A ${number(innerX)} ${number(innerY)} 0 1 0 ${number(centerX - innerX)} ${number(centerY)} A ${number(innerX)} ${number(innerY)} 0 1 0 ${number(centerX + innerX)} ${number(centerY)} Z`;
  }
  const end = start + span;
  const outerStart = pointOnEllipse(centerX, centerY, radiusX, radiusY, start);
  const outerEnd = pointOnEllipse(centerX, centerY, radiusX, radiusY, end);
  const largeArc = Math.abs(span) > Math.PI ? 1 : 0;
  const sweep = span >= 0 ? 1 : 0;
  let path = `M ${number(outerStart.x)} ${number(outerStart.y)} A ${number(radiusX)} ${number(radiusY)} 0 ${largeArc} ${sweep} ${number(outerEnd.x)} ${number(outerEnd.y)}`;
  if (inner === 0) return `${path} L ${number(centerX)} ${number(centerY)} Z`;
  const innerStart = pointOnEllipse(centerX, centerY, radiusX * inner, radiusY * inner, start);
  const innerEnd = pointOnEllipse(centerX, centerY, radiusX * inner, radiusY * inner, end);
  path += ` L ${number(innerEnd.x)} ${number(innerEnd.y)} A ${number(radiusX * inner)} ${number(radiusY * inner)} 0 ${largeArc} ${sweep ? 0 : 1} ${number(innerStart.x)} ${number(innerStart.y)} Z`;
  return path;
}

function pointOnEllipse(centerX: number, centerY: number, radiusX: number, radiusY: number, angle: number) {
  return { x: centerX + radiusX * Math.cos(angle), y: centerY + radiusY * Math.sin(angle) };
}

function resolvedRadii(width: number, height: number, radius: number, radii: CanvasNode["cornerRadii"]) {
  const source = radii?.length === 4 ? radii : [radius, radius, radius, radius];
  const values = source.map((value) => Math.max(0, Number.isFinite(value) ? value : 0));
  const scale = Math.min(1, width / Math.max(1e-12, values[0] + values[1]), width / Math.max(1e-12, values[2] + values[3]), height / Math.max(1e-12, values[0] + values[3]), height / Math.max(1e-12, values[1] + values[2]));
  return values.map((value) => value * scale) as [number, number, number, number];
}

function strokeCap(value: CanvasNode["strokeCapStart"]) {
  return value === "round" ? "round" : value === "square" ? "square" : "butt";
}

/** SVG needs explicit tspans to retain Canvas' newline semantics and its
 * Canonical UTF-8 Style Runs. Advanced shaping/kerning remains Partial, but
 * ordinary mixed size/weight/italic/tracking no longer flattens to run zero. */
function svgTextMarkup(
  node: CanvasNode,
  fill: SvgPaint,
  fontDataUris?: ReadonlyMap<string, string>,
  layout?: SvgTextLayoutProjection,
  textPaintAttributes?: (style: RenderTextStyle, layerIndex: number) => string,
) {
  const primary = node.textProperties?.runs[0];
  const size = primary?.fontSize ?? 31;
  const paragraph = node.textProperties?.paragraph;
  const alignment = paragraph?.alignment ?? "left";
  const anchor = alignment === "center" ? "middle" : alignment === "right" ? "end" : "start";
  const x = alignment === "center" ? node.width / 2 : alignment === "right" ? node.width : 0;
  const source = node.text ?? "";
  const sourceBytes = new TextEncoder().encode(source);
  const approximateMeasure = (value: string) => Array.from(value).length * (size * .6 + Math.max(0, primary?.letterSpacing ?? 0));
  const approximateStyleMeasure = (value: string, style: RenderTextStyle) =>
    Array.from(value).length * (style.fontSize * .6 + Math.max(0, style.letterSpacing));
  const approximateStyledRange = (start: number, end: number) =>
    styledTextSpans(source, start, end, node.textProperties)
      .reduce((total, span) => total + approximateStyleMeasure(span.text, span.style), 0);
  const listMarkerGutter = textListMarkerGutterForProperties(source, node.textProperties, approximateMeasure);
  const listMarkerGap = listMarkerGutter > 0 ? approximateMeasure(" ") : 0;
  const lines = layout?.lines.length
    ? layout.lines.map((line) => ({ ...line, text: new TextDecoder().decode(sourceBytes.slice(line.start, line.end)) }))
    : layoutTextRanges({
        text: source,
        maxWidth: Math.max(1, node.width),
        firstLineIndent: (_index, start) => textParagraphIndentAt(node.textProperties, start) + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, start),
        paragraphIndent: (_index, start) => textListIndentationOffset(source, node.textProperties, start, listMarkerGutter),
        wrapStyle: (_index, start) => textParagraphWrapStyleAt(node.textProperties, start),
        hangingPunctuation: paragraph?.hangingPunctuation ?? false,
        measure: approximateMeasure,
        measureRange: (start, end) => approximateStyledRange(start, end),
      });
  const displayLines = textDisplayLines(
    source,
    lines,
    node.textProperties,
    node.height,
    (paragraphStart) => resolvedTextLineHeightAt(node.textProperties, paragraphStart, size),
    (previousStart, nextStart) => textParagraphGap(node.textProperties, previousStart, nextStart),
  );
  const fallbackFamilies = (node.textProperties?.fallbackFonts ?? [])
    .filter((font) => isSafeEmbeddedFontDataUri(fontDataUris?.get(font.assetId)))
    .map((font) => svgFontFamily(font.assetId));
  const attributes = `x="${number(x)}" fill="${attribute(fill.value)}"${paintOpacity("fill", fill)} text-anchor="${anchor}" font-family="${[...fallbackFamilies, "sans-serif"].map(attribute).join(",")}"`;
  const layerCount = Math.max(1, ...(node.textProperties?.runs.map((run) => run.fillStack?.layers.length ?? 1) ?? [1]));
  const lineMarkupForLayer = (layerIndex: number) => {
    let previousEnd = 0;
    let paragraphIndex = 0;
    return displayLines.map((line, index) => {
    const skipped = new TextDecoder().decode(sourceBytes.slice(previousEnd, line.start));
    const first = index === 0 || /\r\n|[\n\r\u2028\u2029]/u.test(skipped);
    if (index > 0 && first) paragraphIndex += 1;
    previousEnd = line.end;
    const paragraphStart = textParagraphStartAtOffset(source, line.start);
    const listType = textParagraphListTypeAt(node.textProperties, paragraphStart);
    const nestingIndent = textListIndentationOffset(source, node.textProperties, line.start, listMarkerGutter);
    const indent = nestingIndent + (first
      ? textParagraphIndentAt(node.textProperties, paragraphStart) + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, paragraphStart)
      : 0);
    const lineBoxWidth = Math.max(0, node.width - indent);
    const shouldEllipsize = line.truncateEnding
      || (node.textProperties?.textTruncation === "ending" && approximateStyledRange(line.start, line.end) > lineBoxWidth);
    const truncated = shouldEllipsize ? endingEllipsis(
      line.text,
      lineBoxWidth,
      approximateMeasure,
      (_retained, retainedUtf8Bytes) => {
        const end = line.start + retainedUtf8Bytes;
        const spans = styledTextSpans(source, line.start, end, node.textProperties);
        const ellipsisStyle = spans.at(-1)?.style ?? {
          font: primary?.font,
          fontSize: size,
          fontWeight: primary?.fontWeight ?? 500,
          italic: primary?.italic ?? false,
          letterSpacing: primary?.letterSpacing ?? 0,
          color: primary?.color,
          fillStack: primary?.fillStack,
          textCase: primary?.textCase,
          textDecoration: primary?.textDecoration,
          textDecorationStyle: primary?.textDecorationStyle,
          textDecorationOffset: primary?.textDecorationOffset,
          textDecorationThickness: primary?.textDecorationThickness,
          textDecorationColor: primary?.textDecorationColor,
          textDecorationSkipInk: primary?.textDecorationSkipInk,
          leadingTrim: primary?.leadingTrim,
          openTypeFeatures: primary?.openTypeFeatures,
        };
        return approximateStyledRange(line.start, end) + approximateStyleMeasure("…", ellipsisStyle);
      },
    ) : undefined;
    const displayEnd = truncated ? line.start + truncated.retainedUtf8Bytes : line.end;
    const spans = styledTextSpans(source, line.start, displayEnd, node.textProperties);
    if (truncated?.text) spans.push({ text: "…", start: displayEnd, end: displayEnd, style: spans.at(-1)?.style ?? {
      font: primary?.font,
      fontSize: size,
      fontWeight: primary?.fontWeight ?? 500,
      italic: primary?.italic ?? false,
      letterSpacing: primary?.letterSpacing ?? 0,
      color: primary?.color,
      fillStack: primary?.fillStack,
      textCase: primary?.textCase,
      textDecoration: primary?.textDecoration,
      textDecorationStyle: primary?.textDecorationStyle,
      textDecorationOffset: primary?.textDecorationOffset,
      textDecorationThickness: primary?.textDecorationThickness,
      textDecorationColor: primary?.textDecorationColor,
      textDecorationSkipInk: primary?.textDecorationSkipInk,
      leadingTrim: primary?.leadingTrim,
      openTypeFeatures: primary?.openTypeFeatures,
    } });
    const content = spans.map((span) => `<tspan ${svgTextStyleAttributes(span.style, fontDataUris, fallbackFamilies, !textPaintAttributes)}${svgHyperlinkDataAttributes(span.style)}${textPaintAttributes?.(span.style, layerIndex) ?? ""}>${text(span.text)}</tspan>`).join("");
    // Canvas resolves a paragraph base direction before choosing the visual
    // start edge. Preserve that same bidi contract in exported SVG instead of
    // letting a left-aligned Arabic/Hebrew line begin at x=0.
    // A frozen Rust projection has already resolved each visual line's base
    // direction. Re-deriving it from the sliced source here can disagree at
    // BiDi-neutral boundaries, which would make SVG/PNG/PDF pick a different
    // visual start edge from the Canvas snapshot.
    const direction = line.direction;
    const baselineOffset = primary?.leadingTrim === "capHeight" ? size * .7 : size;
    const lineWidth = approximateStyledRange(line.start, displayEnd) + (truncated?.text ? approximateMeasure("…") : 0);
    const hanging = paragraph?.hangingPunctuation
      ? textHangingPunctuationOffsets(truncated?.text ?? line.text, direction, approximateMeasure)
      : { left: 0, right: 0 };
    const contentStart = textAlignedLineLeft(indent, lineBoxWidth, lineWidth, alignment, direction, hanging);
    const lineAnchor = alignment === "center" ? "middle" : alignment === "right" || direction === "rtl" ? "end" : "start";
    const lineX = contentStart + (lineAnchor === "middle" ? lineWidth / 2 : lineAnchor === "end" ? lineWidth : 0);
    const marker = listType && first
      ? `<tspan x="${number(contentStart - listMarkerGap)}" y="${number(baselineOffset + line.lineTop)}" text-anchor="end" direction="ltr" data-makefigma-list-marker="${listType.toUpperCase()}">${text(textListMarker(listType, paragraphIndex))}</tspan>`
      : "";
    const markup = `${marker}<tspan x="${number(lineX)}" y="${number(baselineOffset + line.lineTop)}" text-anchor="${lineAnchor}" direction="${direction}" unicode-bidi="plaintext">${content}</tspan>`;
    return markup;
  }).join("");
  };
  return Array.from({ length: layerCount }, (_, layerIndex) => `<text ${attributes}>${lineMarkupForLayer(layerIndex)}</text>`).join("");
}

function svgTextStyleAttributes(style: RenderTextStyle, fontDataUris?: ReadonlyMap<string, string>, fallbackFamilies: readonly string[] = [], includeColor = true) {
  const color = includeColor && style.color ? ` fill="${attribute(colorToSrgbCss(style.color))}"` : "";
  const family = style.font && isSafeEmbeddedFontDataUri(fontDataUris?.get(style.font.assetId))
    ? [svgFontFamily(style.font.assetId), ...fallbackFamilies, "sans-serif"]
    : fallbackFamilies.length ? [...fallbackFamilies, "sans-serif"] : undefined;
  const variations = style.font?.variationAxes?.length ? ` font-variation-settings="${attribute(fontVariationCss(style.font.variationAxes))}"` : "";
  const capsValue = textCaseFontVariantCaps(style.textCase);
  const caps = capsValue ? ` font-variant-caps="${capsValue}"` : "";
  const features = Object.entries(effectiveTextOpenTypeFeatures(style.textCase, style.openTypeFeatures))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([tag, enabled]) => `'${tag.toLowerCase()}' ${enabled ? 1 : 0}`)
    .join(", ");
  const featureSettings = features ? ` font-feature-settings="${attribute(features)}"` : "";
  const decoration = style.textDecoration === "underline"
    ? ` text-decoration="underline"`
    : style.textDecoration === "strikethrough"
      ? ` text-decoration="line-through"`
      : "";
  const decorationStyle = style.textDecoration === "underline" && style.textDecorationStyle
    ? ` text-decoration-style="${style.textDecorationStyle}"`
    : "";
  const decorationCss = style.textDecoration === "underline"
    ? [
        style.textDecorationOffset
          ? `text-underline-offset:${number(style.textDecorationOffset.value)}${style.textDecorationOffset.unit === "pixels" ? "px" : "%"}`
          : undefined,
        `text-decoration-skip-ink:${style.textDecorationSkipInk === true ? "auto" : "none"}`,
      ].filter(Boolean).join(";")
    : "";
  const decorationInlineStyle = decorationCss ? ` style="${decorationCss}"` : "";
  const decorationThickness = style.textDecoration === "underline" && style.textDecorationThickness
    ? ` text-decoration-thickness="${number(style.textDecorationThickness.value)}${style.textDecorationThickness.unit === "pixels" ? "px" : "%"}"`
    : "";
  const decorationColor = style.textDecoration === "underline" && style.textDecorationColor
    ? ` text-decoration-color="${attribute(colorToSrgbCss({
        ...style.textDecorationColor.color,
        alpha: style.textDecorationColor.visible
          ? style.textDecorationColor.color.alpha * style.textDecorationColor.opacity
          : 0,
      }))}"`
    : "";
  const leadingTrim = style.leadingTrim === "capHeight" ? ` data-makefigma-leading-trim="CAP_HEIGHT"` : "";
  return `font-size="${number(style.fontSize)}" font-weight="${number(style.fontWeight)}" font-style="${style.italic ? "italic" : "normal"}" letter-spacing="${number(style.letterSpacing)}"${caps}${featureSettings}${decoration}${decorationStyle}${decorationInlineStyle}${decorationThickness}${decorationColor}${leadingTrim}${family ? ` font-family="${family.map(attribute).join(",")}"` : ""}${variations}${color}`;
}

function svgHyperlinkDataAttributes(style: RenderTextStyle) {
  return style.hyperlink
    ? ` data-makefigma-hyperlink-type="${style.hyperlink.type}" data-makefigma-hyperlink-value="${attribute(style.hyperlink.value)}"`
    : "";
}

function fontFormat(dataUri: string) {
  if (dataUri.startsWith("data:font/woff2;")) return "woff2";
  if (dataUri.startsWith("data:font/woff;")) return "woff";
  if (dataUri.startsWith("data:font/ttf;")) return "truetype";
  return "opentype";
}

/** Canvas and SVG cannot apply different caps to individual dash segments.
 * Keep the documented conservative Butt fallback when a dashed Line's two
 * endpoints differ, rather than accidentally applying the start style to all
 * dashes in the exported SVG. */
function svgStrokeCap(node: CanvasNode) {
  if (node.kind === "line" && node.strokeDashPattern?.length && node.strokeCapStart !== node.strokeCapEnd) return "butt";
  return strokeCap(node.strokeCapStart);
}

function needsIndependentLineOutline(node: CanvasNode) {
  return [node.strokeCapStart, node.strokeCapEnd].some((cap) => cap === "round" || cap === "square");
}

function paintOpacity(kind: "fill" | "stroke", paint: SvgPaint) {
  return paint.opacity === undefined || paint.opacity >= 1 ? "" : ` ${kind}-opacity="${number(Math.max(0, paint.opacity))}"`;
}

function number(value: number) {
  if (!Number.isFinite(value)) return "0";
  const nearestInteger = Math.round(value);
  const normalized = Math.abs(value - nearestInteger) <= 1e-12 ? nearestInteger : value;
  return String(Object.is(normalized, -0) ? 0 : normalized);
}

function attribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function text(value: string) {
  return attribute(value).replaceAll("'", "&apos;");
}
