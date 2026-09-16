import type { RuntimeErrorCode } from "./runtime-errors";
import { externalNodeTypeForKind, NODE_KIND_CAPABILITIES } from "../lib/node-capabilities";

/** The exact public typing package pinned in package.json and pnpm-lock.yaml. */
export const FIGMA_PLUGIN_TYPINGS_VERSION = "1.134.0" as const;

export const RUNTIME_EDITOR_TYPES = ["figma", "figjam", "slides", "buzz"] as const;
export type RuntimeEditorType = (typeof RUNTIME_EDITOR_TYPES)[number];

export const RUNTIME_DOCUMENT_ACCESS_MODES = ["full-document", "dynamic-page"] as const;
export type RuntimeDocumentAccessMode = (typeof RUNTIME_DOCUMENT_ACCESS_MODES)[number];

export const RUNTIME_CAPABILITY_SURFACES = ["read", "write", "render", "hit-test", "export", "prototype", "plugin"] as const;
export type RuntimeCapabilitySurface = (typeof RUNTIME_CAPABILITY_SURFACES)[number];

export const RUNTIME_CAPABILITY_STATUSES = ["supported", "partial", "preserved", "rejected"] as const;
export type RuntimeCapabilityStatus = (typeof RUNTIME_CAPABILITY_STATUSES)[number];

export type RuntimeCapability = Readonly<{
  id: string;
  editorTypes: readonly RuntimeEditorType[];
  documentAccess: readonly RuntimeDocumentAccessMode[];
  nodeTypes?: readonly string[];
  property?: string;
  surface: RuntimeCapabilitySurface;
  status: RuntimeCapabilityStatus;
  limitation: string;
  errorCode?: RuntimeErrorCode;
}>;

function runtimePaintNodeTypes(usage: "fill" | "stroke"): string[] {
  return Object.entries(NODE_KIND_CAPABILITIES)
    .filter(([, capabilities]) => capabilities.ownPaint[usage])
    .map(([kind]) => externalNodeTypeForKind(kind as keyof typeof NODE_KIND_CAPABILITIES));
}

function runtimePaintStyleNodeTypes(): string[] {
  return [...new Set([...runtimePaintNodeTypes("fill"), ...runtimePaintNodeTypes("stroke")])];
}

/**
 * The source-of-truth Runtime capability matrix. It states the current runtime
 * contract rather than the broader editor's existing capabilities. A feature
 * may be present in the editor yet remain rejected here until it has a stable
 * RuntimeSession/Transaction contract.
 */
export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  {
    id: "runtime.entry",
    editorTypes: RUNTIME_EDITOR_TYPES,
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    surface: "read",
    status: "partial",
    limitation: "M5 begins RevisionLease-frozen Smart Animate layer plans; component/instance variant mutation and raster export remain staged.",
  },
  {
    id: "node.create-runtime",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["FRAME", "GROUP", "SECTION", "COMPONENT", "INSTANCE", "SLICE", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR", "LINE", "TEXT", "CONNECTOR", "SHAPE_WITH_TEXT"],
    property: "createFrame|createGroup|createSection|createComponent|createComponentFromNode|ComponentNode.createInstance|createSlice|createRectangle|createEllipse|createPolygon|createStar|createVector|createLine|createText|createConnector|createShapeWithText",
    surface: "write",
    status: "partial",
    limitation: "Runtime synchronously creates the listed nodes under currentPage with immediate read-your-writes projection and one fenced transaction. Local Component creation initializes a stable local key and complete local publishable metadata; createComponentFromNode atomically replaces a same-session Frame or Group outside Component/ComponentSet/Instance ancestry, preserving its direct children, geometry, page and final layer position; ComponentNode.createInstance clones a bounded supported subtree with durable source links and default component properties in one transaction; Slice creation initializes a paint-free export region. Other conversion sources, remote components, unsupported descendant types, editor-specific and resource-backed creators remain staged.",
  },
  {
    id: "node.sync-write",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["FRAME", "GROUP", "SECTION", "RECTANGLE", "ELLIPSE", "LINE", "TEXT"],
    property: "x|y|name|opacity|rotation|characters|textAutoResize|textTruncation|maxLines|text-range|imageHash",
    surface: "write",
    status: "partial",
    limitation: "M2/W12 supports P0 geometry, NONE/HEIGHT/WIDTH_AND_HEIGHT textAutoResize, DISABLED/ENDING textTruncation with nullable positive maxLines, Text range writes, presence-bearing multi-paint Solid/Linear/Radial/Angular/Diamond/Image getRangeFills/setRangeFills with hidden, opacity, blend and mixed-stack reads, and Canonical IMAGE binding through the Runtime transaction fence. The node-specific fill and stroke surfaces are declared separately; the deprecated textAutoResize TRUNCATE spelling and remaining text mixins stay staged.",
  },
  {
    id: "paint-stack.runtime",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: runtimePaintNodeTypes("fill"),
    property: "fills",
    surface: "write",
    status: "partial",
    limitation: "W12-P exposes ordered presence-bearing fill Paint arrays for the listed fill-bearing nodes. fillStyleId and the deprecated frame-like backgroundStyleId resolve a document PaintStyle to its complete stack, persist link identity through semantics 46/local Snapshot v61, report style consumers, unlink without changing paints, and use async setters under dynamic-page access. Solid, linear/radial/angular/diamond gradients and registered AssetId-backed Image layers cross the Worker/Core fence with visibility, opacity, 18 paint-layer blend modes, image transforms, independent quarter-turn image rotation and all seven presence-bearing Figma ImageFilters fields. Node-only PASS_THROUGH executes direct descendant compositing, while explicitly selected or imported NORMAL containers carry the semantics-10 isolation marker and composite one subtree surface; legacy unmarked NORMAL containers retain their old pixels and project as PASS_THROUGH. LINEAR_BURN and LINEAR_DODGE use explicit bounded Canvas pixel compositing at node and paint-layer scope. ImageFilters use a deterministic cached Canvas RGBA transform under semantics 11; exact Figma shader constants remain unverified, and structural SVG/PNG/PDF records an image-filters fallback. Structural linear-blend export also remains partial. Line and structural nodes reject fills before staging.",
    errorCode: "RESOURCE_UNAVAILABLE",
  },
  {
    id: "paint-stack.runtime-strokes",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: runtimePaintNodeTypes("stroke"),
    property: "strokes",
    surface: "write",
    status: "partial",
    limitation: "W12-P exposes the same ordered Paint subset, 18 paint-layer blend modes, independent quarter-turn image rotation and all seven presence-bearing Figma ImageFilters fields for the listed stroke-bearing nodes. strokeStyleId resolves the complete document PaintStyle stack, persists link identity through semantics 46/local Snapshot v61, reports consumers, unlinks without changing paints, and uses the async setter under dynamic-page access. PASS_THROUGH remains node-only; LINEAR_BURN and LINEAR_DODGE are admitted in Paint Stacks and use bounded Canvas pixel compositing. ImageFilters execute through the same deterministic cached Canvas RGBA transform as fills; structural SVG/PNG/PDF records an image-filters fallback and exact Figma shader constants remain unverified. Text, CodeBlock, Sticky, TableCell and TextPath reject strokes before staging; Line accepts strokes but rejects fills. Structural linear-blend export remains partial.",
    errorCode: "RESOURCE_UNAVAILABLE",
  },
  {
    id: "paint-style.runtime",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: runtimePaintStyleNodeTypes(),
    property: "getStyleByIdAsync|getLocalPaintStylesAsync|fillStyleId|setFillStyleIdAsync|getRangeFillStyleId|setRangeFillStyleId|setRangeFillStyleIdAsync|strokeStyleId|setStrokeStyleIdAsync|backgroundStyleId|getStyleConsumersAsync",
    surface: "write",
    status: "supported",
    limitation: "Document PaintStyle resources apply their complete ordered PaintStack atomically, persist node links through semantics 46/local Snapshot v61 and text-range links through semantics 47/local Snapshot v62, report linked fields per consumer, and unlink without changing the current paints. Whole/range text reads return figma.mixed across unequal links; direct fill writes unlink only the affected surface or range. Deprecated synchronous style setters require full-document access; async fill, stroke and text-range setters work with dynamic-page access. backgroundStyleId remains the deprecated synchronous frame-like alias defined by the Figma API.",
    errorCode: "RESOURCE_UNAVAILABLE",
  },
  {
    id: "variables.catalog-runtime",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    property: "variables.getVariableByIdAsync|variables.getVariableCollectionByIdAsync|variables.getLocalVariablesAsync|variables.getLocalVariableCollectionsAsync|variables.createVariableCollection|variables.createVariable|variables.createVariableAlias|variables.setBoundVariableForPaint|variables.setBoundVariableForEffect|Variable.setValueForMode|Variable.setVariableCodeSyntax|Variable.removeVariableCodeSyntax|Variable.remove|VariableCollection.addMode|VariableCollection.renameMode|VariableCollection.removeMode|VariableCollection.remove|Variable.resolveForConsumer|boundVariables|setBoundVariable|effects|explicitVariableModes|resolvedVariableModes|setExplicitVariableModeForCollection|clearExplicitVariableModeForCollection",
    surface: "write",
    status: "partial",
    limitation: "Document-owned variable collections, modes, BOOLEAN/COLOR/FLOAT/STRING values, scopes and aliases persist through semantics 48/local Snapshot v63; optional WEB/ANDROID/iOS code syntax uses semantics 49/local Snapshot v64. Runtime can create, edit and delete local variables and collections, atomically manage collection modes, filter local resources, preserve remote identity, and resolve bounded alias chains through the consumer's inherited mode. Scene nodes persist versioned width, height, characters, opacity, visible, corner radius, uniform/per-side stroke weight, Auto Layout gap/padding, min/max size, bounded Solid and gradient-stop fill/stroke colors, and bounded Drop/Inner Shadow plus Normal Layer/Background Blur binding identities in their forward-compatible extension map. Resolved values use the ordinary Core geometry/text/layout/paint/effect/appearance mutation paths, and direct property writes unlink only the corresponding bindings. Explicit modes inherit through ancestors; set/clear preflights and atomically recomputes up to 10,000 bound nodes in the affected subtree while respecting closer descendant overrides. Text-range/style paint bindings, Progressive/noise/texture/glass/shader effects, grid fields, EASING/TIMING, library import and plugin/shared-plugin metadata remain staged.",
    errorCode: "RESOURCE_UNAVAILABLE",
  },
  {
    id: "geometry.parametric-runtime",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR", "LINE", "BOOLEAN_OPERATION"],
    property: "createPolygon|createStar|createVector|createLine|pointCount|innerRadius|vectorPaths|vectorNetwork|setVectorNetworkAsync|strokeWeight|strokeCap|strokeJoin|strokeMiterLimit|dashPattern|union|subtract|intersect|exclude|booleanOperation|flatten",
    surface: "write",
    status: "partial",
    limitation: "W12-G supports Polygon and Star parameters, bounded Figma SVG VectorPaths, independent directed cubic VectorNetwork chains/cycles, and bounded shared-vertex branches with at most one globally styled fill region. Branch loops materialize as closed subpaths and remaining edges as deterministic open subpaths for Canvas/SVG while exact topology survives through a path-bound versioned extension; any generic path edit invalidates that projection. Branches require NONE endpoint caps and no corner/join-local data; loop segments must form directed closed chains and may belong to only one loop. setVectorNetworkAsync preserves tangents and shared start/end caps across ordinary open subpaths; region-local paints/styles, multiple branch regions, per-vertex corners and mixed effective joins are rejected before staging. Stroke weight/join/miter/dash writes, concrete strokeCap writes, Figma mixed reads for asymmetric endpoint caps, and four live Vector Boolean operations pass the Worker fence. Boolean operands may come from ordinary same-page Page, Frame, Section or local Component parents; document-order operands and world transforms survive the atomic move. Active Auto Layout sources/targets, direct Group/Boolean source dissolution, Instance descendants and remote components are rejected. Flatten accepts one confirmed live Vector Boolean or one confirmed Vector/Rectangle/Ellipse/Polygon/Star/Line, an ordinary same-page target parent and final index; it preserves world transform, paints, mask state and a forced replacement identity in one undoable Core transaction. Boolean empty Rust results are supported. Flattening multi-node lists, Auto Layout/structural-source moves, region-local network styles, and degenerate Star ranges remain staged.",
  },
  {
    id: "layout.auto-layout-runtime",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["FRAME", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR", "LINE", "TEXT"],
    property: "layoutMode|layoutWrap|primaryAxisSizingMode|counterAxisSizingMode|layoutSizingHorizontal|layoutSizingVertical|minWidth|maxWidth|minHeight|maxHeight|primaryAxisAlignItems|counterAxisAlignItems|counterAxisSpacing|counterAxisAlignContent|layoutPositioning|layoutAlign|constraints|padding|itemSpacing",
    surface: "write",
    status: "partial",
    limitation: "W12-L exposes fixed/hug Frame sizing, direct-child fill, physical min/max bounds, horizontal wrapping, per-track FILL distribution, counter-axis STRETCH, counter-axis HUG, horizontal baseline alignment, wrap-track spacing/distribution, Figma layoutAlign child overrides, absolute children, nested Frame reflow and MIN/CENTER/MAX/STRETCH/SCALE constraints through the transaction fence. Flexible children retain their sizing modes across atomic reparent and Undo; active Auto Layout owns flow geometry while preserving child constraints. GRID and text HUG without the richer text-auto-size API remain staged.",
  },
  {
    id: "special-nodes.runtime-subset",
    editorTypes: ["figma", "figjam"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["CONNECTOR", "SHAPE_WITH_TEXT", "TEXT_PATH", "TRANSFORM_GROUP"],
    property: "createConnector|createShapeWithText|createTextPath|transformGroup|transformModifiers|isMask|connectorLineType|connectorStart|connectorEnd|connectorStartStrokeCap|connectorEndStrokeCap|connectorText|reconnect|shapeType|characters|text.fontName|text.getRangeFontName|text.getRangeAllFontNames|text.getStyledTextSegments|text.setRangeFontName|text.hasMissingFont|text.textCase|text.getRangeTextCase|text.setRangeTextCase|text.hyperlink|text.getRangeHyperlink|text.setRangeHyperlink|text.textDecoration|text.getRangeTextDecoration|text.setRangeTextDecoration|text.textDecorationStyle|text.getRangeTextDecorationStyle|text.setRangeTextDecorationStyle|text.textDecorationOffset|text.getRangeTextDecorationOffset|text.setRangeTextDecorationOffset|text.textDecorationThickness|text.getRangeTextDecorationThickness|text.setRangeTextDecorationThickness|text.textDecorationColor|text.getRangeTextDecorationColor|text.setRangeTextDecorationColor|text.textDecorationSkipInk|text.getRangeTextDecorationSkipInk|text.setRangeTextDecorationSkipInk|leadingTrim|text.leadingTrim|text.lineHeight|text.paragraphSpacing|text.paragraphIndent|text.getRangeLineHeight|text.setRangeLineHeight|text.getRangeParagraphSpacing|text.setRangeParagraphSpacing|text.getRangeParagraphIndent|text.setRangeParagraphIndent|text.textWrapStyle|text.getRangeTextWrapStyle|text.setRangeTextWrapStyle|text.getRangeListOptions|text.setRangeListOptions|text.listSpacing|text.hangingList|text.hangingPunctuation|text.getRangeListSpacing|text.setRangeListSpacing|text.fills|text.getRangeFills|text.setRangeFills|textPathStartData|textAlignHorizontal|textAlignVertical|autoRename",
    surface: "write",
    status: "partial",
    limitation: "W12-S exposes Connector and ShapeWithText creation, same-session VECTOR-to-TEXT_PATH replacement, and bounded same-parent LINEAR/RADIAL/stacked Repeat TransformGroup creation/editing through the Worker/Core fence. Connector metadata, ShapeWithText type, its stable owner-bound TextSublayer subset, linear getStyledTextSegments projection and Repeat modifiers survive confirmed round trips; ShapeWithText characters, size, weight, PIXELS letter spacing and supported range edits use semantics 13 Canonical TextProperties; PIXELS/PERCENT/AUTO lineHeight, paragraphSpacing, paragraphIndent and AUTO/BALANCE/PRETTY textWrapStyle plus their range APIs reuse the existing paragraph record; relative units use ParagraphStyle tag 4, semantics 18 and local Snapshot v33 only when present, with PERCENT resolved from the largest run font size and AUTO resolved to the internal deterministic 1.2em rule; paragraphIndent uses append-only tag 5, semantics 19 and local Snapshot v34 only when present, participates in first-line wrapping/Canvas/SVG/auto-size, and rejects invalid writes before staging; textWrapStyle uses append-only tag 6, semantics 20 and local Snapshot v35 only for BALANCE/PRETTY, with AUTO retaining legacy greedy wrapping; BALANCE equalizes line lengths and PRETTY rebalances only an avoidable one-word final line through the shared Canvas/SVG/editor wrapper; inputs above 32 AUTO lines or 512 graphemes preserve the authored value and deterministically render as AUTO; both non-default values deliberately exit the current Rust/GPU uniform wrapping path; listOptions uses append-only ParagraphStyle tag 7, semantics 29 and local Snapshot v44 only for ORDERED/UNORDERED, while NONE remains omitted. listSpacing uses append-only ParagraphStyle tag 8, semantics 30 and local Snapshot v45 only for positive values; zero is normalized to omission, and whole/range writes reject negative or non-finite values before staging. Canvas/SVG draw list markers outside the source characters, add listSpacing only between hard-break list items, reserve one deterministic marker gutter and keep UTF-8 style-run offsets stable. Sparse ParagraphStyleRun records use semantics 31 / local Snapshot v46 to preserve per-paragraph indentation levels 0–100; level 1 keeps the established marker gutter and each deeper level adds one deterministic gutter step in Canvas/SVG/editor hit testing/Core auto-size. hangingList uses ParagraphStyle tag 9, semantics 32 and local Snapshot v47; true removes the first marker gutter from text-box layout while preserving deeper indentation steps across Canvas/SVG/editor hit testing/Core auto-size. Per-paragraph listOptions reuse ParagraphStyleRun tag 3, semantics 33 and local Snapshot v48; explicit NONE disables a global default, partial writes merge with indentation runs, mixed reads return figma.mixed, and text edits rebase UTF-8 paragraph starts. Per-paragraph listSpacing uses tag 4, semantics 34 and local Snapshot v49; omission inherits the global default, explicit zero disables it, partial writes merge into the same sparse record, and mixed reads follow paragraph ranges. Per-paragraph paragraphSpacing uses tag 5, semantics 35 and local Snapshot v50; explicit zero disables an inherited global gap, partial writes merge into the same sparse record, and mixed reads follow paragraph ranges. Per-paragraph paragraphIndent uses tag 6, semantics 36 and local Snapshot v51; explicit zero disables an inherited first-line inset, partial writes merge into the same sparse record, mixed reads follow paragraph ranges, and Canvas/SVG/editor hit testing/Core auto-size use the effective value. Per-paragraph lineHeight uses tags 7/8, semantics 37 and local Snapshot v52 as an atomic PIXELS/PERCENT/AUTO pair, with mixed reads, partial writes, text-edit rebasing and shared Core/Canvas/SVG/browser/caret layout. Per-paragraph textWrapStyle uses tag 9, semantics 39 and local Snapshot v54; explicit AUTO overrides inherited BALANCE/PRETTY, range reads may return figma.mixed, and shared Canvas/SVG/browser/caret layout resolves the effective value at each paragraph. Whole hangingPunctuation uses ParagraphStyle tag 10, semantics 38 and local Snapshot v53; false remains omitted, Text and ShapeWithText expose the official boolean, and Core/Canvas/SVG/browser/caret/bounds share one leading and trailing common Latin/CJK punctuation grapheme per visual line. Exact Figma marker and indentation-step metrics, RTL placement and font-specific optical hanging amounts remain staged. Figma exposes hangingList and hangingPunctuation only as whole-text properties; all official paragraph range fields accept valid multi-paragraph ranges through sparse paragraph runs; its whole/range fills use semantics 14 presence-bearing per-run PaintStacks, preserve empty/multi-paint/Solid/Linear/Radial/Angular/Diamond/Image layers with visibility, opacity and blend, project unequal stacks as figma.mixed, and use the same layered Canvas/SVG rendering as Text; Runtime-created image sources remain available to frozen SVG within a 16 MiB session budget, while metadata-only or over-budget assets report image-asset fallback. Connector endpoints are the bounded local-point/node-reference subset; ShapeWithText empty-text size, spacing, font and complete fills persist through semantics 15 baseStyle and materialize into ordinary runs on insertion. Its NONE/UNDERLINE/STRIKETHROUGH textDecoration whole/range API uses TextStyleRun tag 12, semantics 22 and local Snapshot v37, persists baseStyle for empty text, and renders solid AUTO decoration in Canvas/SVG; WAVY/DOTTED textDecorationStyle uses tag 13, semantics 23 and local Snapshot v38, with SOLID omitted and non-underlined reads returning null; PIXELS/PERCENT/AUTO textDecorationOffset uses tag 14, semantics 24 and local Snapshot v39, resolves percentages from font size, applies deterministic Canvas/SVG offsets, and returns null outside underlined ranges; PIXELS/PERCENT/AUTO textDecorationThickness uses tag 15, semantics 25 and local Snapshot v40, resolves percentages from font size, expands Canvas geometry around the AUTO underline center, emits SVG thickness, and returns null outside underlined ranges; textDecorationColor uses append-only tag 16, semantics 26 and local Snapshot v41, maps AUTO to omission and explicit SolidPaint color/visibility/opacity/blend into a compact Canonical record, returns null outside underlined ranges, paints the decoration once in Canvas, and emits SVG text-decoration-color; SVG records a compatibility fallback when decoration-only blend cannot be isolated from glyph compositing; boundVariables remain gated with the Variables API. textDecorationSkipInk uses append-only tag 17, semantics 27 and local Snapshot v42 for true; omission preserves legacy false, non-underlined reads return null, Canvas subtracts measured descender intervals from every decoration pattern, and SVG emits text-decoration-skip-ink. Its FontName, range FontName, all-font-name and missing-font APIs reversibly project admitted AssetId/face references through the Worker font catalog without adding duplicate Canonical state; preferred name-table family/style metadata is persisted once per admitted asset through semantics 40 / local Snapshot v55. Sorted localized family/style aliases use semantics 41 / local Snapshot v56, are enumerated and accepted by the same Runtime catalog, and remain bound to the same AssetId/face identity; ambiguous aliases fail closed. Advanced typography APIs remain staged. TextPath accepts only one live same-session Vector with a valid segment/position. TransformGroup accepts direct children of the requested non-Auto-Layout parent; nested TransformGroups share one root-to-leaf budget of at most 64 derived paint occurrences across creation, modifier edits, reparenting, Canvas, SVG, culling and hit testing. Canvas and SVG materialize ordinary nested Group/Frame/Section/component-family subtrees, nested Repeat groups, Frame clips, valid Vector Boolean outlines, standalone and descendant-owning-container foreground Drop Shadow/Inner Shadow/Layer Blur effects, primitive alpha-mask sibling runs plus effect-free Frame, descendant-owning Group, valid live Vector Boolean and bounded non-empty TransformGroup mask sources. Prepared effect, isolation and mask surfaces are reused sequentially and their final composite retains the current Repeat matrix, allowing standard node and paint-layer backdrop blends elsewhere in the same Repeat to see the real destination without a redundant whole-source pool. Descendant-owning Group masks may also carry owner opacity, owner blend, explicit NORMAL isolation and foreground Drop Shadow, Inner Shadow or Layer Blur through the same bounded source-alpha path. Runtime isMask writes lower to Core SetMask; an admitted masked Repeat recursively includes nested Repeat-derived bounds, renders container-mask descendants, a nested Repeat source or the Rust-derived Boolean path into the same bounded source-alpha surface, reserves each live source depth before clearing the visible canvas, applies the composed matrices, and maps derived hit points through the same source masks. Group and TransformGroup expose BlendMixin isMask through the shared capability registry; empty structural sources fail closed, while Slice and Section do not expose BlendMixin/isMask in the official typings. Linear Burn/Dodge node and paint-layer blends project a bounded device-pixel readback window for every Repeat occurrence and composite against its real destination. A leaf or descendant-owning container with an ordered active effect stack containing Background Blur transitions its intermediate surface into each linear or radial occurrence at the first backdrop effect, samples the real destination there, and executes later effects in occurrence space while transforming post-backdrop shadow offsets through the composed Repeat matrix and preflighting the largest transformed device window. An admitted non-mask prepared foreground-effect ancestor materializes its complete subtree in occurrence space; descendant Background Blur composes the ancestor's external destination with earlier local siblings before applying one blur. Ordinary prepared Group, Frame, Section and component-family ancestors may also carry owner opacity, explicit NORMAL isolation or node blend: each LINEAR/RADIAL occurrence materializes the complete subtree against its own external and local backing, then applies owner presentation exactly once at exit. BooleanOperation is not part of this admitted prepared-container set. Repeat-derived visual bounds compose each occurrence matrix with the canonical source world transform before measuring local visual geometry, preventing a rotated source AABB from being inflated again by RADIAL Repeat. A mask source or descendant retains Background Blur and authored paint-layer blend values in Canonical state and SVG compatibility reporting. The Canvas mask-alpha executor omits Background Blur and normalizes artistic paint blends to source-over alpha while retaining paint opacity and geometry, so destination colour cannot become mask coverage and Linear Burn/Dodge need no colour readback pool. A masked target run containing native blend, Linear Burn/Dodge paint layers or Background Blur seeds its canonical bounded surface from each LINEAR/RADIAL occurrence's real backing, then applies source alpha before one final composite. Remote Media playback and live Embed content remain unavailable.",
  },
  {
    id: "document.find-all",
    editorTypes: ["figma"],
    documentAccess: ["dynamic-page"],
    nodeTypes: ["DOCUMENT"],
    property: "findAll|findOne|findAllWithCriteria",
    surface: "read",
    status: "supported",
    limitation: "Dynamic-page sessions reject synchronous document traversal with PAGE_NOT_LOADED until every page is explicitly loaded; findAllNodesPagedAsync performs that boundary before yielding pages.",
  },
  {
    id: "text.async-font-and-range",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["TEXT", "TEXT_PATH", "SHAPE_WITH_TEXT"],
    property: "loadFontAsync|listAvailableFontsAsync|fontName|text.fontName|getRangeFontName|text.getRangeFontName|getRangeAllFontNames|text.getRangeAllFontNames|getStyledTextSegments|text.getStyledTextSegments|fontSize|fontWeight|text.fontWeight|getRangeFontSize|text.getRangeFontSize|getRangeFontWeight|text.getRangeFontWeight|openTypeFeatures|text.openTypeFeatures|getRangeOpenTypeFeatures|text.getRangeOpenTypeFeatures|textStyleId|text.textStyleId|getRangeTextStyleId|text.getRangeTextStyleId|setTextStyleIdAsync|text.setTextStyleIdAsync|setRangeTextStyleId|text.setRangeTextStyleId|setRangeTextStyleIdAsync|text.setRangeTextStyleIdAsync|setRangeFontName|text.setRangeFontName|hasMissingFont|text.hasMissingFont|textCase|text.textCase|getRangeTextCase|text.getRangeTextCase|setRangeTextCase|text.setRangeTextCase|hyperlink|text.hyperlink|getRangeHyperlink|text.getRangeHyperlink|setRangeHyperlink|text.setRangeHyperlink|textDecoration|text.textDecoration|getRangeTextDecoration|text.getRangeTextDecoration|setRangeTextDecoration|text.setRangeTextDecoration|textDecorationStyle|text.textDecorationStyle|getRangeTextDecorationStyle|text.getRangeTextDecorationStyle|setRangeTextDecorationStyle|text.setRangeTextDecorationStyle|textDecorationOffset|text.textDecorationOffset|getRangeTextDecorationOffset|text.getRangeTextDecorationOffset|setRangeTextDecorationOffset|text.setRangeTextDecorationOffset|textDecorationThickness|text.textDecorationThickness|getRangeTextDecorationThickness|text.getRangeTextDecorationThickness|setRangeTextDecorationThickness|text.setRangeTextDecorationThickness|textDecorationColor|text.textDecorationColor|getRangeTextDecorationColor|text.getRangeTextDecorationColor|setRangeTextDecorationColor|text.setRangeTextDecorationColor|textDecorationSkipInk|text.textDecorationSkipInk|getRangeTextDecorationSkipInk|text.getRangeTextDecorationSkipInk|setRangeTextDecorationSkipInk|text.setRangeTextDecorationSkipInk|leadingTrim|text.leadingTrim|paragraphSpacing|getRangeParagraphSpacing|setRangeParagraphSpacing|paragraphIndent|getRangeParagraphIndent|setRangeParagraphIndent|textWrapStyle|text.textWrapStyle|getRangeTextWrapStyle|text.getRangeTextWrapStyle|setRangeTextWrapStyle|text.setRangeTextWrapStyle|getRangeListOptions|text.getRangeListOptions|setRangeListOptions|text.setRangeListOptions|listSpacing|text.listSpacing|hangingList|text.hangingList|hangingPunctuation|text.hangingPunctuation|getRangeListSpacing|text.getRangeListSpacing|setRangeListSpacing|text.setRangeListSpacing|getRangeIndentation|text.getRangeIndentation|setRangeIndentation|text.setRangeIndentation|characters|text.characters|text.fontSize|letterSpacing|text.letterSpacing|text.lineHeight|text.paragraphSpacing|text.paragraphIndent|text.getRangeLineHeight|text.setRangeLineHeight|text.getRangeParagraphSpacing|text.setRangeParagraphSpacing|text.getRangeParagraphIndent|text.setRangeParagraphIndent|textAutoResize|textTruncation|maxLines|setRangeFontSize|text.setRangeFontSize|getRangeLetterSpacing|setRangeLetterSpacing|text.setRangeLetterSpacing|getRangeFills|setRangeFills|text.getRangeFills|text.setRangeFills|setRangeFontReference|insertCharacters|deleteCharacters",
    surface: "write",
    status: "partial",
    limitation: "Fonts are AssetId-addressed and must reach a Worker FontFace Snapshot fence before affected text changes, inherited-style insertion, auto-resize, truncation or TextCase changes. Figma FontName is a reversible Runtime view over admitted AssetId/face references: loadFontAsync, whole/range reads and writes, mixed values, all-font-name enumeration and hasMissingFont share the same catalog for Text and ShapeWithText; replacing a missing old font requires only the new font fence. getStyledTextSegments merges requested character and paragraph fields from the confirmed UTF-8 Canonical runs into UTF-16 Runtime ranges for Text, TextPath and ShapeWithText without adding wire state. Text and TextPath expose whole/range font-size and read-only font-weight APIs from the same runs; ShapeWithText shares the range weight read. openTypeFeatures and getRangeOpenTypeFeatures read explicit, versioned Canonical feature overrides, return figma.mixed across unequal runs, and preserve an empty map for legacy text. textStyleId and getRangeTextStyleId preserve REST-imported link identities through TextStyleRun tag 20, semantics 43 and local Snapshot v58; unequal runs return figma.mixed, unlinked legacy text returns an empty string, and empty text reads its persistent baseStyle. The document-owned TextStyle catalog resolves whole/range style setters to complete character and paragraph values before staging one TextProperties update; unlinking clears only the identity, missing styles reject, style fonts retain the existing load fence, async setters work with dynamic-page access, and deprecated synchronous setters require full-document access. Partial application uses sparse paragraph overrides and rejects alignment or hanging-field changes that Canonical cannot represent per paragraph. Admitted fonts expose their preferred name-table family/style from asset metadata protected by semantics 40 / local Snapshot v55; legacy assets without metadata retain the document-scoped Worker family and Regular/Face N labels. Duplicate public names are unavailable for reverse lookup rather than being routed to the wrong asset. Range mutations keep the caller's explicit UTF-16 position, reject indexes inside surrogate pairs, and persist scalar-aligned UTF-8 style runs through Worker/Core/SVG/Undo. All six Figma TextCase values are exposed on Text and ShapeWithText as whole/range properties; ORIGINAL is normalized to omission, unequal runs return figma.mixed, and semantics 16 / local Snapshot v31 preserve the other values in hash, history and round trips. Canvas and SVG transform presentation text without modifying Canonical characters, use source-range-aware wrapping for Unicode expansions such as ß to SS, and render both small-caps modes with font-variant-caps. Contiguous explicit font/size/PIXELS-tracking Text runs build one bounded frozen font bundle and enter Rust shaping together; face units, sizes and signed tracking are normalized to the first run before ICU4X line fitting, UAX #9 visual ordering and positioned carets. Tracking that would make a non-empty advance non-positive, move a caret outside its piece or reverse physical caret order rejects Rust admission. Eligible UPPER, LOWER and TITLE runs also use a monotonic source/display UTF-8 map so lines, visual runs, carets and glyph clusters return to Canonical source offsets; any non-exact structural boundary or incomplete source-grapheme caret set falls back to Canvas. For left-aligned, unrotated horizontal LTR/RTL text with no run-local paint, each shaped glyph selects its Style Run's AssetId, face index, variation axes, font size, raster scale, font weight and italic flag in the WebGPU atlas; weights above 400 use bounded deterministic alpha dilation, italic uses a baseline-relative 12-degree shear, and authored advance/ascent remain unchanged; signed PIXELS tracking is encoded in the Rust glyph advances consumed by the same pass, and RTL lines are right-anchored from Canonical box width minus Rust line advance; invalid run identities or unavailable rasters reject the whole node to Canvas. Both small-caps modes remain outside Rust until the boundary requests OpenType smcp/c2sc. Text and ShapeWithText range fill writes preserve presence-bearing empty and multi-paint Solid/Linear/Radial/Angular/Diamond/Image stacks, per-layer visibility, opacity and blend, and report unequal run stacks with figma.mixed. ShapeWithText exposes a stable TextSublayer subset for characters, size, weight, PIXELS letter spacing, PIXELS/PERCENT/AUTO lineHeight, paragraphSpacing, paragraphIndent, AUTO/BALANCE/PRETTY textWrapStyle, NONE/ORDERED/UNORDERED listOptions, whole hangingPunctuation and per-paragraph list indentation with bounded get/set range APIs, TextCase, complete whole/range fills, mixed reads, BEFORE/AFTER adjacent-style insertion, deletion and matching range reads/writes; paragraph fields that still use only the global Canonical record reject partial multi-paragraph writes before staging, while paragraphSpacing, paragraphIndent, lineHeight, textWrapStyle, listOptions, listSpacing and indentation use sparse paragraph runs and accept every valid paragraph-spanning range; its styled Canonical record requires semantics 13, per-run PaintStacks require semantics 14, persistent empty-text baseStyle requires semantics 15, TextCase requires semantics 16, and relative line-height units require ParagraphStyle tag 4, semantics 18 and local Snapshot v33 only when present; paragraphIndent requires tag 5, semantics 19 and local Snapshot v34 only when present; BALANCE/PRETTY textWrapStyle requires tag 6, semantics 20 and local Snapshot v35 only when present, while AUTO remains omitted; URL/NODE hyperlink targets use TextStyleRun tag 11, semantics 21 and local Snapshot v36 only when present, return null or figma.mixed according to range uniformity, and preserve inert escaped metadata in SVG without creating executable links; NONE/UNDERLINE/STRIKETHROUGH textDecoration uses append-only TextStyleRun tag 12, semantics 22 and local Snapshot v37 only when present, returns figma.mixed across unequal ranges, persists empty-text baseStyle, and renders a solid AUTO underline or line-through in Canvas/SVG; decorated Text remains outside the current WebGPU glyph pass, WAVY/DOTTED textDecorationStyle uses append-only tag 13, semantics 23 and local Snapshot v38 only when present; SOLID remains omitted, style reads return null when the range is not underlined, Canvas draws deterministic wave/dot patterns, and SVG emits the matching decoration style; PIXELS/PERCENT textDecorationOffset uses append-only tag 14, semantics 24 and local Snapshot v39 only when present, AUTO remains omitted, non-underlined reads return null, and Canvas/SVG resolve percentage offsets from the run font size; PIXELS/PERCENT textDecorationThickness uses append-only tag 15, semantics 25 and local Snapshot v40 only when present, AUTO remains omitted, non-underlined reads return null, Canvas keeps the AUTO underline center fixed while expanding thickness, and SVG emits the explicit unit; textDecorationColor uses append-only tag 16, semantics 26 and local Snapshot v41 only when present, maps AUTO to omission and explicit SolidPaint color/visibility/opacity/blend into a compact Canonical record, returns null outside underlined ranges, paints once in Canvas, and emits SVG text-decoration-color; SVG records a compatibility fallback for decoration-only non-NORMAL blend and boundVariables remain staged with Variables; boolean textDecorationSkipInk uses append-only tag 17, semantics 27 and local Snapshot v42 only for true, returns null outside underlined ranges, uses measured Canvas descender intervals for solid/dotted/wavy lines, and emits SVG text-decoration-skip-ink; leadingTrim CAP_HEIGHT uses append-only tag 18, semantics 28 and local Snapshot v43, requires loaded fonts, preserves mixed per-run values, changes Canvas/auto-size/Auto Layout line-box edges, records an SVG compatibility marker with a deterministic 0.7em baseline, and remains outside Rust shaping/WebGPU; ORDERED/UNORDERED listOptions uses append-only ParagraphStyle tag 7, semantics 29 and local Snapshot v44, while NONE remains omitted. Non-negative listSpacing is exposed through the official whole/range APIs; positive values use ParagraphStyle tag 8, semantics 30 and local Snapshot v45, while zero remains omitted. Sparse paragraphStyleRuns on TextProperties tag 8 use semantics 31 and local Snapshot v46 for official getRangeIndentation/setRangeIndentation; UTF-8 paragraph starts survive text edits, unequal levels return figma.mixed, and levels 0–100 are admitted. Whole hangingList uses ParagraphStyle tag 9, semantics 32 and local Snapshot v47; true hangs the first marker column outside the text box and false remains omitted; per-paragraph listOptions reuse ParagraphStyleRun tag 3, semantics 33 and local Snapshot v48, with explicit NONE inheritance overrides, mixed reads, partial writes and text-edit rebasing; per-paragraph listSpacing uses ParagraphStyleRun tag 4, semantics 34 and local Snapshot v49, with explicit zero inheritance overrides, mixed reads, partial writes and text-edit rebasing; per-paragraph paragraphSpacing uses ParagraphStyleRun tag 5, semantics 35 and local Snapshot v50, with explicit zero inheritance overrides, mixed reads, partial writes, text-edit rebasing and shared Canvas/SVG/Core boundary gaps; per-paragraph paragraphIndent uses ParagraphStyleRun tag 6, semantics 36 and local Snapshot v51, with explicit zero inheritance overrides, mixed reads, partial writes, text-edit rebasing and shared Canvas/SVG/editor-hit/Core first-line layout; per-paragraph lineHeight uses ParagraphStyleRun tags 7/8, semantics 37 and local Snapshot v52, with atomic PIXELS/PERCENT/AUTO inheritance overrides, mixed reads, partial writes, text-edit rebasing and shared Core/Canvas/SVG/browser/caret layout; per-paragraph textWrapStyle uses ParagraphStyleRun tag 9, semantics 39 and local Snapshot v54, preserves explicit AUTO inheritance overrides, supports mixed reads, partial writes and text-edit rebasing, and drives shared Canvas/SVG/browser/caret wrapping; whole hangingPunctuation uses ParagraphStyle tag 10, semantics 38 and local Snapshot v53, with false omitted and a shared one-grapheme common Latin/CJK visual-edge rule across Core auto-size, Canvas/SVG, browser auto-size, caret hit testing and visual bounds; hanging punctuation exits Rust shaping/WebGPU. Scene effect bounds, the Canvas spatial index, viewport/dirty-region culling, and direct marker hits include its conservative visual envelope. Canvas/SVG add spacing only between hard-break list items, draw markers outside Canonical characters, and apply deterministic nested-list insets while list text exits Rust shaping/WebGPU; the shared rebalancer falls back to AUTO above 32 AUTO lines or 512 graphemes, preserves the authored value, and non-default styles remain outside Rust shaping/WebGPU. AUTO line height uses an internal deterministic 1.2em rule; external Figma font-metric pixel equivalence remains unverified. ENDING truncation and nullable positive maxLines use the same frozen line ranges in Canvas/SVG. Locale-specific casing, exact Figma small-cap font synthesis, OpenType feature authoring APIs, exact Figma indentation-step metrics, font-specific optical hanging punctuation metrics, Variables, exact RTL list-marker placement, ShapeWithText Rust shaping, full IME matrices and deprecated textAutoResize TRUNCATE remain staged.",
    errorCode: "FONT_NOT_LOADED",
  },
  {
    id: "image.async-resource",
    editorTypes: ["figma", "figjam"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["IMAGE", "MEDIA"],
    property: "createImageAsync|getImageByHash|createImageNode|setImageAsset|createGif|mediaData",
    surface: "write",
    status: "partial",
    limitation: "M2 admits bounded raster bytes, registers metadata in Core and seeds Worker decode bytes. W12-P can reference the resulting AssetId through the admitted Figma-shaped Image Paint subset. The FigJam createGif subset requires an already-admitted image/gif AssetId and synchronously creates a MEDIA node with immutable hash and source dimensions; playback remains a deterministic poster fallback. Filters, video and the full Figma image-adjustment surface remain staged.",
    errorCode: "RESOURCE_UNAVAILABLE",
  },
  {
    id: "special-preview.runtime",
    editorTypes: ["figjam"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["EMBED", "LINK_UNFURL"],
    property: "embedData|linkUnfurlData|createLinkPreviewAsync",
    surface: "write",
    status: "partial",
    limitation: "Existing Embed and LinkUnfurl nodes expose immutable provider-resolved metadata through live Runtime proxies. createLinkPreviewAsync delegates provider discovery to an explicit host resolver, validates bounded HTTP(S) metadata, then stages one normal Canonical create transaction. Thumbnail retrieval, iframe activation and clone remain staged.",
  },
  {
    id: "runtime.view-state",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["PAGE"],
    property: "loadAsync|setCurrentPageAsync|selection|setSelectionAsync|onViewStateChange",
    surface: "read",
    status: "partial",
    limitation: "Worker Snapshot and view-state fences synchronize currentPage and selection across sessions; viewport events and the full Plugin event vocabulary remain staged.",
  },
  {
    id: "node.export-async",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["SCENE"],
    property: "exportAsync",
    surface: "export",
    status: "partial",
    limitation: "exportAsync({ format: SVG_STRING | PNG }) freezes the last confirmed Canvas-backed projection in a RevisionLease and reuses its shared Scene IR; PNG rasterizes that frozen SVG through the bounded export service. Structural SVG cannot sample the backdrop needed by node-level or paint-layer LINEAR_BURN/LINEAR_DODGE, so SVG and PNG report and use a Normal-compositing fallback for those modes. PDF and narrow non-Canvas projections remain unsupported.",
    errorCode: "UNSUPPORTED_FEATURE",
  },
  {
    id: "prototype.reactions",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["FRAME", "GROUP", "RECTANGLE", "ELLIPSE", "LINE", "TEXT", "VECTOR"],
    property: "reactions|setReactionsAsync",
    surface: "prototype",
    status: "partial",
    limitation: "M5 adds SMART_ANIMATE's frozen basic layer matching/interpolation plan, alongside Click/Press/Hover/Timeout and Navigate/Overlay/Back/Close/https URL. Variant mutation and advanced Smart Animate properties remain staged.",
  },
  {
    id: "runtime.commit-async",
    editorTypes: RUNTIME_EDITOR_TYPES,
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    surface: "write",
    status: "partial",
    limitation: "M1 commitAsync waits for the Runtime Ack + Projection fence; Worker registration by the application shell is still an integration task.",
  },
  {
    id: "plugin.sandbox",
    editorTypes: ["figma", "figjam"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    surface: "plugin",
    status: "partial",
    limitation: "M7 loads bounded self-contained UI bundles in opaque-origin iframes, with manifest permissions, bounded concurrent host requests, request deadlines and a host-mediated HTTPS proxy that revalidates redirects and DNS answers. Browser CPU/memory quotas and unrestricted plugin APIs remain staged.",
    errorCode: "PERMISSION_DENIED",
  },
  {
    id: "widget.runtime",
    editorTypes: ["figma", "figjam"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["WIDGET"],
    surface: "render",
    status: "partial",
    limitation: "M7 provides a bounded declarative Widget tree, actor-scoped state hooks and map writes that merge through Canonical commit commands, cleanup-aware effect lifecycles, a per-key LWW synchronized-state map with durable map-delete tombstones, a bounded observed-remove set, and an RGA-style ordered list. Arbitrary JSX evaluation, host/network access from widgets, and richer collection CRDTs remain staged.",
    errorCode: "PERMISSION_DENIED",
  },
] as const;

export function runtimeCapability(id: string): RuntimeCapability | undefined {
  return RUNTIME_CAPABILITIES.find((capability) => capability.id === id);
}

export function runtimeCapabilitiesFor(surface: RuntimeCapabilitySurface): readonly RuntimeCapability[] {
  return RUNTIME_CAPABILITIES.filter((capability) => capability.surface === surface);
}

export function validateRuntimeCapabilities(capabilities: readonly RuntimeCapability[] = RUNTIME_CAPABILITIES): void {
  const ids = new Set<string>();
  for (const capability of capabilities) {
    if (!capability.id || ids.has(capability.id)) throw new Error(`Duplicate or empty runtime capability id: ${capability.id}`);
    if (!capability.editorTypes.length || !capability.documentAccess.length || !capability.limitation.trim()) {
      throw new Error(`Runtime capability ${capability.id} is missing its applicability or limitation.`);
    }
    ids.add(capability.id);
  }
}
