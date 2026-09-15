import type { CanvasNode } from "./editor-protocol";
import { supportsInspectorProperty } from "./node-capabilities";

type InspectorNodeKind = CanvasNode["kind"];

/**
 * Group is a structural container: it has neither a direct fill nor a direct
 * stroke. Keep single-select capability checks aligned with the mixed
 * Inspector so the UI never offers a write that has no visual node target.
 */
export function supportsGenericAppearanceInspector(kind: InspectorNodeKind): boolean {
  return supportsInspectorProperty(kind, "fill");
}

export function supportsPaintStackInspector(kind: InspectorNodeKind): boolean {
  return supportsInspectorProperty(kind, "paintStack");
}

/** Join, miter and dash belong to every drawable Stroke. Endpoint caps stay
 * Line-only, but closed shapes must not lose their Figma Stroke details. */
export function supportsStrokeDetailsInspector(kind: InspectorNodeKind): boolean {
  return supportsInspectorProperty(kind, "strokeDetails");
}

export function supportsCornerRadiusInspector(kind: InspectorNodeKind) {
  return supportsInspectorProperty(kind, "corners");
}

/** Stroke Align is only exposed where the renderer and Canonical model share
 * the same closed-shape semantics. Arc/Donut deliberately remain Inside-only.
 */
export function supportsStrokeAlignInspector(node: Pick<CanvasNode, "kind" | "arcData">) {
  return supportsInspectorProperty(node.kind, "strokeAlign")
    && (node.kind !== "ellipse" || !node.arcData);
}

/** Independent edge widths have deliberately narrower semantics than a
 * uniform Stroke: they apply to drawable rectangular nodes, not Section.
 */
export function supportsPerSideStrokeInspector(kind: InspectorNodeKind) {
  return supportsInspectorProperty(kind, "perSideStroke");
}

export function supportsMixedStrokeAlignInspector(nodes: readonly Pick<CanvasNode, "kind" | "arcData">[]) {
  return nodes.length > 0 && nodes.every(supportsStrokeAlignInspector);
}

/**
 * The multi-select Inspector must make one capability decision for the whole
 * set: a control is either safe to apply to every selected node or it is
 * NotApplicable. Keeping these decisions here prevents individual React
 * sections from gradually disagreeing about Group/Text/Line boundaries.
 */
export function mixedInspectorCapabilities(nodes: readonly Pick<CanvasNode, "kind" | "arcData">[]) {
  const every = (predicate: (node: Pick<CanvasNode, "kind" | "arcData">) => boolean) => nodes.length > 0 && nodes.every(predicate);
  return {
    fill: every((node) => supportsGenericAppearanceInspector(node.kind)),
    strokeWidth: every((node) => supportsInspectorProperty(node.kind, "strokeWidth")),
    strokeAlign: supportsMixedStrokeAlignInspector(nodes),
    perSideStroke: every((node) => supportsPerSideStrokeInspector(node.kind)),
    corners: every((node) => supportsCornerRadiusInspector(node.kind)),
    strokeDetails: every((node) => supportsStrokeDetailsInspector(node.kind)),
    lineStroke: every((node) => supportsInspectorProperty(node.kind, "lineStroke")),
    frameClip: every((node) => supportsInspectorProperty(node.kind, "frameClip")),
    sectionContents: every((node) => supportsInspectorProperty(node.kind, "sectionContents")),
    dropShadow: every((node) => supportsInspectorProperty(node.kind, "dropShadow")),
  } as const;
}
