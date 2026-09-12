import type { RuntimeErrorCode } from "./runtime-errors";

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
    id: "node.sync-write",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["FRAME", "GROUP", "SECTION", "RECTANGLE", "ELLIPSE", "LINE", "TEXT"],
    property: "x|y|name|opacity|rotation|characters|text-range|imageHash",
    surface: "write",
    status: "partial",
    limitation: "M2 supports P0 geometry plus Text range writes and Canonical IMAGE binding through the Runtime transaction fence; advanced paints and complete text mixins remain staged.",
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
    nodeTypes: ["TEXT"],
    property: "loadFontAsync|listAvailableFontsAsync|characters|setRangeFontSize|setRangeFontReference|insertCharacters|deleteCharacters",
    surface: "write",
    status: "partial",
    limitation: "Fonts are AssetId-addressed and must reach a Worker FontFace Snapshot fence before affected text changes; advanced Figma typography mixins remain staged.",
    errorCode: "FONT_NOT_LOADED",
  },
  {
    id: "image.async-resource",
    editorTypes: ["figma"],
    documentAccess: RUNTIME_DOCUMENT_ACCESS_MODES,
    nodeTypes: ["IMAGE"],
    property: "createImageAsync|getImageByHash|createImageNode|setImageAsset",
    surface: "write",
    status: "partial",
    limitation: "M2 admits bounded raster bytes, registers metadata in Core and seeds Worker decode bytes. IMAGE is a project adapter for Canonical image layers, not a claim of full Figma paint compatibility.",
    errorCode: "RESOURCE_UNAVAILABLE",
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
    limitation: "exportAsync({ format: SVG_STRING | PNG }) freezes the last confirmed Canvas-backed projection in a RevisionLease and reuses its shared Scene IR; PNG rasterizes that frozen SVG through the bounded export service. PDF and narrow non-Canvas projections remain unsupported.",
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
