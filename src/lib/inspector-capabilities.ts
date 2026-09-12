import type { CanvasNode } from "./editor-protocol";

type InspectorNodeKind = CanvasNode["kind"];

/**
 * Group is a structural container: it has neither a direct fill nor a direct
 * stroke. Keep single-select capability checks aligned with the mixed
 * Inspector so the UI never offers a write that has no visual node target.
 */
export function supportsGenericAppearanceInspector(kind: InspectorNodeKind): boolean {
  return kind !== "group" && kind !== "line" && kind !== "slice";
}

export function supportsPaintStackInspector(kind: InspectorNodeKind): boolean {
  return kind !== "group" && kind !== "text" && kind !== "slice";
}

/** Join, miter and dash belong to every drawable Stroke. Endpoint caps stay
 * Line-only, but closed shapes must not lose their Figma Stroke details. */
export function supportsStrokeDetailsInspector(kind: InspectorNodeKind): boolean {
  return kind !== "group" && kind !== "text" && kind !== "slice";
}

export function supportsCornerRadiusInspector(kind: InspectorNodeKind) {
  return kind === "frame" || kind === "rectangle" || kind === "section";
}

/** Stroke Align is only exposed where the renderer and Canonical model share
 * the same closed-shape semantics. Arc/Donut deliberately remain Inside-only.
 */
export function supportsStrokeAlignInspector(node: Pick<CanvasNode, "kind" | "arcData">) {
  return node.kind === "frame"
    || node.kind === "rectangle"
    || node.kind === "polygon"
    || node.kind === "star"
    || (node.kind === "ellipse" && !node.arcData);
}

/** Independent edge widths have deliberately narrower semantics than a
 * uniform Stroke: they apply to drawable rectangular nodes, not Section.
 */
export function supportsPerSideStrokeInspector(kind: InspectorNodeKind) {
  return kind === "frame" || kind === "rectangle";
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
    strokeWidth: every((node) => node.kind !== "group" && node.kind !== "text" && node.kind !== "slice"),
    strokeAlign: supportsMixedStrokeAlignInspector(nodes),
    perSideStroke: every((node) => supportsPerSideStrokeInspector(node.kind)),
    corners: every((node) => supportsCornerRadiusInspector(node.kind)),
    strokeDetails: every((node) => supportsStrokeDetailsInspector(node.kind)),
    lineStroke: every((node) => node.kind === "line"),
    frameClip: every((node) => node.kind === "frame"),
    sectionContents: every((node) => node.kind === "section"),
    dropShadow: every((node) => node.kind !== "group" && node.kind !== "slice"),
  } as const;
}
