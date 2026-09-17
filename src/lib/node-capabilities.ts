import type { NodeKind } from "./editor-protocol";

export type NodeCapabilityStatus = "supported" | "partial" | "preserved" | "rejected";
export type NodeCapabilitySurface = "read" | "write" | "render" | "hit" | "export" | "import" | "runtime";
export type NodeRenderPrimitiveKind = "shape" | "vector" | "image" | "glyph-run" | "media" | "embedded-preview";
export type NodeChildPolicy = "none" | "scene" | "component-only" | "slide-row-only" | "slide-only" | "table-cell-only";
export type NodeInspectorProperty = "fill" | "paintStack" | "strokeWidth" | "strokeAlign" | "perSideStroke" | "corners" | "strokeDetails" | "lineStroke" | "frameClip" | "sectionContents" | "dropShadow";

export type NodeSurfaceSupport = Readonly<{
  status: NodeCapabilityStatus;
  limitation: string;
  /** Repository-relative behavior tests or fixed fixtures that justify this status. */
  evidence: readonly string[];
}>;

export type NodeCapabilities = Readonly<{
  childPolicy: NodeChildPolicy;
  ownPaint: Readonly<{ fill: boolean; stroke: boolean }>;
  childClip: boolean;
  text: boolean;
  path: boolean;
  autoLayout: boolean;
  maskEligible: boolean;
  selectable: boolean;
  exportRegion: boolean;
  renderPrimitive?: NodeRenderPrimitiveKind;
  /** Single- and multi-selection Inspector controls admitted for this kind.
   * Geometry-dependent exceptions (currently Ellipse arcs) narrow this static
   * whitelist at the call site; they never broaden it. */
  inspector: Readonly<Record<NodeInspectorProperty, boolean>>;
  entrySupport: Readonly<Record<NodeCapabilitySurface, NodeSurfaceSupport>>;
}>;

const READ_EVIDENCE = ["src/runtime/runtime-session.test.ts", "src/lib/figma-plugin-node-projection.test.ts"];
const WRITE_EVIDENCE = ["src/lib/transaction-batch.test.ts", "src/runtime/runtime-session.test.ts"];
const RENDER_EVIDENCE = ["src/runtime/scene-compiler.test.ts"];
const HIT_EVIDENCE = ["src/lib/hit-test.test.ts"];
const EXPORT_EVIDENCE = ["src/lib/svg-export.test.ts"];
const IMPORT_EVIDENCE = ["src/lib/figma-rest-import.test.ts"];
const RUNTIME_EVIDENCE = [
  "src/runtime/runtime-session.test.ts",
  "src/runtime/runtime-paint.test.ts",
  "verification/remediation/2026-09-13/w12-paint-stack-runtime-browser.json",
];
const SPECIAL_NODE_EVIDENCE = ["src/lib/m6-special-nodes-fixture.test.ts"];
const SPECIAL_NODE_RUNTIME_EVIDENCE = [
  "src/runtime/runtime-session.test.ts",
  "src/runtime/runtime-worker-bridge.test.ts",
  "src/lib/special-node-runtime-wasm.test.ts",
  "src/lib/transform-group-repeat-hit.test.ts",
  "src/lib/transform-group-repeat.test.ts",
  "src/lib/multi-selection.test.ts",
  "src/lib/selection-geometry-edit.test.ts",
  "verification/remediation/2026-09-13/w12-special-nodes-runtime-browser.json",
  "verification/remediation/2026-09-13/w12-radial-repeat-browser.json",
  "verification/remediation/2026-09-13/w12-repeat-alpha-mask-browser.json",
];
const TEXT_RUNTIME_EVIDENCE = [
  "src/runtime/runtime-text.test.ts",
  "src/runtime/runtime-session.test.ts",
  "verification/remediation/2026-09-13/w12-text-range-runtime-browser.json",
  "verification/remediation/2026-09-13/w12-rtl-caret-browser.json",
];

const SUPPORTED_READ = support("supported", "The Canonical projection and Plugin node projection preserve this node identity.", READ_EVIDENCE);
const PARTIAL_WRITE = support("partial", "Writes are admitted by property-specific builders and the Rust Core remains authoritative.", WRITE_EVIDENCE);
const SUPPORTED_RENDER = support("supported", "The shared scene compiler has a deterministic structural or drawing representation.", RENDER_EVIDENCE);
const SUPPORTED_HIT = support("supported", "The node participates in the shared scene visibility and geometry hit pipeline.", HIT_EVIDENCE);
const SUPPORTED_EXPORT = support("supported", "SVG export preserves the supported structure and appearance subset.", EXPORT_EVIDENCE);
const REJECTED_REST_IMPORT = support("rejected", "Figma REST import does not yet map this source node type into a Canonical node.", IMPORT_EVIDENCE);
const READONLY_RUNTIME = support("partial", "The public Runtime exposes stable identity, common properties and container traversal; unsupported specialized methods reject explicitly.", RUNTIME_EVIDENCE);
const SUPPORTED_REST_IMPORT = support("supported", "Figma REST import maps the current declared property subset into a Canonical node.", IMPORT_EVIDENCE);
const PARTIAL_IMAGE_IMPORT = support("partial", "Structure imports immediately; image bytes bind only after Asset Service authorization.", IMPORT_EVIDENCE);
const PARTIAL_COMPONENT_IMPORT = support("partial", "Structure, children, local references, supported properties and override paths import; unavailable external references require an explicit preserve policy or reject the strict import.", IMPORT_EVIDENCE);
const PARTIAL_CONNECTOR_IMPORT = support("partial", "REST Connector structure, paint, text, routing type, position endpoints, local node references, endpoint caps and corner radius import. Canvas endpoint positions are converted through the connector world transform; unresolved references, magnet-only dynamic routing and unsupported values remain preserved source metadata.", IMPORT_EVIDENCE);
const PARTIAL_CONNECTOR_RUNTIME = support("partial", "Connector uses the Figma Plugin endpoint discriminated union for projection and writes, preserves all seven official magnet values and all 12 current ConnectorStrokeCap values, and converts positioned endpoints into deterministic Canonical local points through the Worker/Core fence. TOP/RIGHT/BOTTOM/LEFT/CENTER anchors follow live target transforms, while AUTO chooses the nearest side from the opposite authored endpoint; Canvas, SVG, hit testing, bounds and Scene invalidation consume the same derived route and reuse caller-owned node/transform indexes. All six ERD variants share one endpoint mesh. NONE, unresolved, cross-page, self-referential and non-invertible targets retain the last local point; legacy nodes compare through the caller's default page identity. Figma-equivalent obstacle routing, external pixel parity and the complete label sublayers remain unavailable.", [
  "src/lib/connector-endpoint.test.ts",
  "src/lib/figma-plugin-node-projection.test.ts",
  "src/lib/figma-plugin-node-mutation.test.ts",
  "src/runtime/runtime-session.test.ts",
]);
const PARTIAL_RUNTIME = support("partial", "The public Runtime exposes the M1 identity/property subset and Figma-shaped Solid, Linear Gradient and AssetId Image Paint stacks for paint-bearing nodes.", RUNTIME_EVIDENCE);
const PARTIAL_SPECIAL_RENDER = support("partial", "The renderer uses a deterministic local representation while live remote or advanced behavior remains unavailable.", SPECIAL_NODE_EVIDENCE);
const PARTIAL_SPECIAL_EXPORT = support("partial", "Export emits the deterministic stored representation and reports unsupported live behavior.", SPECIAL_NODE_EVIDENCE);
const PARTIAL_SPECIAL_RUNTIME = support("partial", "The public Runtime creates and edits the bounded special-node subset through the Worker/Core fence, including same-parent linear, radial, stacked and nested Repeat TransformGroups; derived copies of ordinary nested Group, Frame, Section and component-family subtrees preserve Frame clips, while valid Vector Boolean sources reuse one derived outline identity and resolve live SVG paths through an exact-revision Worker request. Standalone leaf and descendant-owning-container Drop Shadow, Inner Shadow and Layer Blur preserve their Canvas, hit and SVG behavior under Repeat. Their bounded prepared surfaces are reused sequentially and composited through the current Repeat matrix at every authored or derived occurrence, so standard node and paint-layer backdrop blends elsewhere in the same Repeat see the real destination. Primitive masks plus effect-free Frame, descendant-owning Group, valid live Vector Boolean and bounded non-empty TransformGroup mask sources cross Runtime SetMask, bounded source-alpha composition, Canvas, hit testing and SVG, including recursively materialized nested Repeat subtrees under the shared occurrence and surface budgets. Descendant-owning Group masks may carry owner opacity, owner blend, explicit NORMAL isolation and foreground Drop Shadow, Inner Shadow or Layer Blur through the same bounded source-alpha path. Group and TransformGroup expose the official BlendMixin mask property through the shared capability registry; empty structural mask sources fail closed, while Slice and Section do not expose BlendMixin/isMask in the official typings. Linear Burn/Dodge node and paint-layer blends project a bounded device-pixel readback window for every Repeat occurrence and composite against its real destination. A leaf or descendant-owning container with an ordered active effect stack containing Background Blur transitions its intermediate surface into each linear or radial occurrence at the first backdrop effect, samples the real destination there, and executes later effects in occurrence space while transforming post-backdrop shadow offsets through the composed Repeat matrix and preflighting the largest transformed device window. An admitted non-mask prepared foreground-effect ancestor materializes its complete subtree in occurrence space; descendant Background Blur composes the ancestor's external destination with earlier local siblings before applying one blur. Ordinary prepared Group, Frame, Section and component-family ancestors may also carry owner opacity, explicit NORMAL isolation or node blend: each LINEAR/RADIAL occurrence materializes the complete subtree against its own external and local backing, then applies owner presentation exactly once at exit. Valid live BooleanOperation containers are also admitted: their Rust-derived outline is materialized once per occurrence, owner presentation is applied at the exit edge, and operands remain structural inputs rather than independent paint. Repeat-derived visual bounds compose each occurrence matrix with the canonical source world transform before measuring local visual geometry, preventing a rotated source AABB from being inflated again by RADIAL Repeat. Single and collective selections include that exact source-plus-derived envelope. Canvas handles and Inspector geometry resize a materializable Repeat through one canonical wrapper world matrix, so LINEAR, RADIAL and stacked occurrences share the same affine transform and one Undo boundary without exposing derived identities. A mask source or descendant retains Background Blur and authored paint-layer blend values in Canonical state and SVG compatibility reporting. The Canvas mask-alpha executor omits Background Blur and normalizes artistic paint blends to source-over alpha while retaining paint opacity and geometry, so destination colour cannot become mask coverage and Linear Burn/Dodge need no colour readback pool. A masked target run containing native blend, Linear Burn/Dodge paint layers or Background Blur seeds its canonical bounded surface from each LINEAR/RADIAL occurrence's real backing, then applies source alpha before one final composite. Advanced geometry and remote content remain staged.", SPECIAL_NODE_RUNTIME_EVIDENCE);
const PARTIAL_TEXT_RUNTIME = support("partial", "Runtime preserves explicit UTF-16 range intent as scalar-aligned UTF-8 style runs through the Worker/Core fence; pure RTL line navigation consumes Rust line direction while mixed-direction run-boundary affinity, richer typography and the complete cross-platform text interaction matrix remain staged.", TEXT_RUNTIME_EVIDENCE);
const PARTIAL_CONTAINER_HIT = support("partial", "Canvas selection resolves this structural container through its descendants; Layers selection remains direct.", HIT_EVIDENCE);
const PARTIAL_SLICE_HIT = support("partial", "Slice is selectable from Layers and tools but does not contribute painted Canvas hit geometry.", HIT_EVIDENCE);
const REJECTED_IMPORTED_WRITE = support("rejected", "This imported-only node type is not mutable through the current Plugin-facing builder.", WRITE_EVIDENCE);

type CapabilityOverrides = Partial<Omit<NodeCapabilities, "ownPaint" | "inspector" | "entrySupport">> & {
  ownPaint?: Partial<NodeCapabilities["ownPaint"]>;
  inspector?: Partial<NodeCapabilities["inspector"]>;
  entrySupport?: Partial<NodeCapabilities["entrySupport"]>;
};

function capability(overrides: CapabilityOverrides = {}): NodeCapabilities {
  const ownPaint = { fill: overrides.ownPaint?.fill ?? true, stroke: overrides.ownPaint?.stroke ?? true };
  return {
    childPolicy: overrides.childPolicy ?? "none",
    ownPaint,
    childClip: overrides.childClip ?? false,
    text: overrides.text ?? false,
    path: overrides.path ?? false,
    autoLayout: overrides.autoLayout ?? false,
    maskEligible: overrides.maskEligible ?? true,
    selectable: overrides.selectable ?? true,
    exportRegion: overrides.exportRegion ?? false,
    ...(overrides.renderPrimitive === undefined ? {} : { renderPrimitive: overrides.renderPrimitive }),
    inspector: {
      fill: ownPaint.fill,
      paintStack: ownPaint.fill || ownPaint.stroke,
      strokeWidth: ownPaint.stroke,
      strokeAlign: false,
      perSideStroke: false,
      corners: false,
      strokeDetails: ownPaint.stroke,
      lineStroke: false,
      frameClip: false,
      sectionContents: false,
      dropShadow: ownPaint.fill || ownPaint.stroke,
      ...overrides.inspector,
    },
    entrySupport: {
      read: SUPPORTED_READ,
      write: PARTIAL_WRITE,
      render: SUPPORTED_RENDER,
      hit: SUPPORTED_HIT,
      export: SUPPORTED_EXPORT,
      import: REJECTED_REST_IMPORT,
      runtime: READONLY_RUNTIME,
      ...overrides.entrySupport,
    },
  };
}

const frameLike = (entrySupport: CapabilityOverrides["entrySupport"] = {}) => capability({
  childPolicy: "scene",
  childClip: true,
  autoLayout: true,
  renderPrimitive: "shape",
  entrySupport,
});

const structural = (
  childPolicy: Exclude<NodeChildPolicy, "none">,
  entrySupport: CapabilityOverrides["entrySupport"] = {},
  maskEligible = false,
) => capability({
  childPolicy,
  ownPaint: { fill: false, stroke: false },
  maskEligible,
  entrySupport: { hit: PARTIAL_CONTAINER_HIT, ...entrySupport },
});

const glyph = (entrySupport: CapabilityOverrides["entrySupport"] = {}) => capability({
  ownPaint: { fill: true, stroke: false },
  text: true,
  renderPrimitive: "glyph-run",
  entrySupport,
});

/**
 * Shared semantic and entry-point catalog. The table describes current client
 * behavior; it never overrides Rust Core validation. Adding a NodeKind makes
 * this declaration fail type checking until the new row is classified.
 */
export const NODE_KIND_CAPABILITIES = {
  frame: capability({ childPolicy: "scene", childClip: true, autoLayout: true, renderPrimitive: "shape", inspector: { strokeAlign: true, perSideStroke: true, corners: true, frameClip: true }, entrySupport: { import: SUPPORTED_REST_IMPORT, runtime: PARTIAL_RUNTIME } }),
  group: structural("scene", { import: SUPPORTED_REST_IMPORT, runtime: PARTIAL_RUNTIME }, true),
  section: capability({ childPolicy: "scene", maskEligible: false, renderPrimitive: "shape", inspector: { corners: true, sectionContents: true }, entrySupport: { import: SUPPORTED_REST_IMPORT, runtime: PARTIAL_RUNTIME } }),
  rectangle: capability({ renderPrimitive: "shape", inspector: { strokeAlign: true, perSideStroke: true, corners: true }, entrySupport: { import: SUPPORTED_REST_IMPORT, runtime: PARTIAL_RUNTIME } }),
  ellipse: capability({ renderPrimitive: "shape", inspector: { strokeAlign: true }, entrySupport: { import: SUPPORTED_REST_IMPORT, runtime: PARTIAL_RUNTIME } }),
  polygon: capability({ path: true, renderPrimitive: "vector", inspector: { strokeAlign: true }, entrySupport: { import: SUPPORTED_REST_IMPORT } }),
  star: capability({ path: true, renderPrimitive: "vector", inspector: { strokeAlign: true }, entrySupport: { import: SUPPORTED_REST_IMPORT } }),
  vector: capability({ path: true, renderPrimitive: "vector", entrySupport: { import: SUPPORTED_REST_IMPORT } }),
  booleanOperation: capability({ childPolicy: "scene", ownPaint: { fill: false, stroke: false }, path: true, renderPrimitive: "vector", entrySupport: { import: SUPPORTED_REST_IMPORT, hit: PARTIAL_CONTAINER_HIT } }),
  slice: capability({ ownPaint: { fill: false, stroke: false }, maskEligible: false, exportRegion: true, entrySupport: { import: SUPPORTED_REST_IMPORT, hit: PARTIAL_SLICE_HIT } }),
  line: capability({ ownPaint: { fill: false, stroke: true }, path: true, renderPrimitive: "vector", inspector: { lineStroke: true }, entrySupport: { import: SUPPORTED_REST_IMPORT, runtime: PARTIAL_RUNTIME } }),
  text: capability({ ownPaint: { fill: true, stroke: false }, text: true, renderPrimitive: "glyph-run", inspector: { paintStack: false }, entrySupport: { import: SUPPORTED_REST_IMPORT, runtime: PARTIAL_TEXT_RUNTIME } }),
  image: capability({ renderPrimitive: "image", entrySupport: { import: PARTIAL_IMAGE_IMPORT, runtime: PARTIAL_RUNTIME } }),
  codeBlock: glyph(),
  component: frameLike({ import: PARTIAL_COMPONENT_IMPORT }),
  instance: frameLike({ import: PARTIAL_COMPONENT_IMPORT }),
  slot: frameLike({ import: PARTIAL_COMPONENT_IMPORT }),
  componentSet: capability({ childPolicy: "component-only", childClip: true, autoLayout: true, renderPrimitive: "shape", entrySupport: { import: PARTIAL_COMPONENT_IMPORT } }),
  connector: capability({ ownPaint: { fill: false, stroke: true }, text: true, path: true, renderPrimitive: "vector", entrySupport: { import: PARTIAL_CONNECTOR_IMPORT, runtime: PARTIAL_CONNECTOR_RUNTIME } }),
  embed: capability({ renderPrimitive: "embedded-preview", entrySupport: { render: PARTIAL_SPECIAL_RENDER, export: PARTIAL_SPECIAL_EXPORT, runtime: PARTIAL_SPECIAL_RUNTIME } }),
  highlight: capability({ path: true, renderPrimitive: "vector" }),
  interactiveSlideElement: capability({ renderPrimitive: "embedded-preview", entrySupport: { write: REJECTED_IMPORTED_WRITE, render: PARTIAL_SPECIAL_RENDER, export: PARTIAL_SPECIAL_EXPORT } }),
  linkUnfurl: capability({ renderPrimitive: "embedded-preview", entrySupport: { render: PARTIAL_SPECIAL_RENDER, export: PARTIAL_SPECIAL_EXPORT, runtime: PARTIAL_SPECIAL_RUNTIME } }),
  media: capability({ renderPrimitive: "media", entrySupport: { render: PARTIAL_SPECIAL_RENDER, export: PARTIAL_SPECIAL_EXPORT, runtime: PARTIAL_SPECIAL_RUNTIME } }),
  shapeWithText: capability({ text: true, path: true, renderPrimitive: "glyph-run", entrySupport: { render: PARTIAL_SPECIAL_RENDER, export: PARTIAL_SPECIAL_EXPORT, runtime: PARTIAL_SPECIAL_RUNTIME } }),
  slideGrid: structural("slide-row-only", { write: REJECTED_IMPORTED_WRITE }),
  slide: capability({ childPolicy: "scene", renderPrimitive: "shape" }),
  slideRow: structural("slide-only", { write: REJECTED_IMPORTED_WRITE }),
  stamp: capability({ renderPrimitive: "shape" }),
  sticky: glyph(),
  table: capability({ childPolicy: "table-cell-only", renderPrimitive: "shape" }),
  tableCell: glyph(),
  textPath: capability({ ownPaint: { fill: true, stroke: false }, text: true, path: true, renderPrimitive: "glyph-run", entrySupport: { render: PARTIAL_SPECIAL_RENDER, export: PARTIAL_SPECIAL_EXPORT, runtime: PARTIAL_SPECIAL_RUNTIME } }),
  transformGroup: structural("scene", { render: PARTIAL_SPECIAL_RENDER, export: PARTIAL_SPECIAL_EXPORT, runtime: PARTIAL_SPECIAL_RUNTIME }, true),
  washiTape: capability({ path: true, renderPrimitive: "shape" }),
  widget: capability({ renderPrimitive: "embedded-preview", entrySupport: { render: PARTIAL_SPECIAL_RENDER, export: PARTIAL_SPECIAL_EXPORT } }),
} satisfies Record<NodeKind, NodeCapabilities>;

export function nodeCapabilities(kind: NodeKind): NodeCapabilities {
  return NODE_KIND_CAPABILITIES[kind];
}

/** Canonical NodeKind names map mechanically to the upper-snake names used by
 * the Plugin-facing Runtime. Keeping the conversion beside the registry lets
 * entry points derive capability lists instead of copying 36-kind maps. */
type UpperSnakeCase<Value extends string> = Value extends `${infer Head}${infer Tail}`
  ? Head extends Lowercase<Head>
    ? `${Uppercase<Head>}${UpperSnakeCase<Tail>}`
    : `_${Head}${UpperSnakeCase<Tail>}`
  : "";

export type ExternalNodeType<Kind extends NodeKind = NodeKind> = UpperSnakeCase<Kind>;

export function externalNodeTypeForKind<Kind extends NodeKind>(kind: Kind): ExternalNodeType<Kind> {
  return kind.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase() as ExternalNodeType<Kind>;
}

const NODE_KIND_BY_EXTERNAL_TYPE = new Map<string, NodeKind>(
  (Object.keys(NODE_KIND_CAPABILITIES) as NodeKind[]).map((kind) => [externalNodeTypeForKind(kind), kind]),
);

export const EXTERNAL_NODE_TYPES: readonly ExternalNodeType[] = Object.freeze(
  (Object.keys(NODE_KIND_CAPABILITIES) as NodeKind[]).map(externalNodeTypeForKind),
);

export function nodeKindFromExternalType(type: string): NodeKind | undefined {
  return NODE_KIND_BY_EXTERNAL_TYPE.get(type);
}

export function canContainChildren(kind: NodeKind): boolean {
  return nodeCapabilities(kind).childPolicy !== "none";
}

export function canContainNodeKind(parent: NodeKind, child: NodeKind): boolean {
  const policy = nodeCapabilities(parent).childPolicy;
  if (policy === "none") return false;
  if (policy === "component-only") return child === "component";
  if (policy === "slide-row-only") return child === "slideRow";
  if (policy === "slide-only") return child === "slide";
  if (policy === "table-cell-only") return child === "tableCell";
  return child !== "slide" && child !== "slideRow" && child !== "slideGrid";
}

export function clipsChildren(kind: NodeKind): boolean {
  return nodeCapabilities(kind).childClip;
}

export function supportsOwnFill(kind: NodeKind): boolean {
  return nodeCapabilities(kind).ownPaint.fill;
}

export function supportsOwnStroke(kind: NodeKind): boolean {
  return nodeCapabilities(kind).ownPaint.stroke;
}

export function supportsInspectorProperty(kind: NodeKind, property: NodeInspectorProperty): boolean {
  return nodeCapabilities(kind).inspector[property];
}

function support(status: NodeCapabilityStatus, limitation: string, evidence: readonly string[]): NodeSurfaceSupport {
  return { status, limitation, evidence };
}
