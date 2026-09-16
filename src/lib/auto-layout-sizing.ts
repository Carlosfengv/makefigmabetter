import type { AutoLayoutMode, CanvasNode, DocumentAutoLayout } from "./editor-protocol";

export type AutoLayoutAxis = "width" | "height";
export type AutoLayoutSizingKey = "primarySizing" | "counterSizing";

/**
 * Auto-layout stores sizing against its own primary/counter axes. Inspector
 * controls are deliberately expressed as width and height so a nested Frame
 * keeps the same meaning when its parent uses the opposite direction.
 */
export function autoLayoutSizingKeyForAxis(mode: Exclude<AutoLayoutMode, "none">, axis: AutoLayoutAxis): AutoLayoutSizingKey {
  if (mode === "grid") return axis === "width" ? "primarySizing" : "counterSizing";
  return (mode === "horizontal") === (axis === "width") ? "primarySizing" : "counterSizing";
}

export function autoLayoutSizingForAxis(layout: Pick<DocumentAutoLayout, "mode" | "primarySizing" | "counterSizing">, axis: AutoLayoutAxis) {
  if (layout.mode === "none") return "fixed" as const;
  return layout[autoLayoutSizingKeyForAxis(layout.mode, axis)];
}

const defaultChildAutoLayout = (): DocumentAutoLayout => ({
  mode: "none",
  padding: [0, 0, 0, 0],
  itemSpacing: 0,
  wrap: false,
  primaryAlignment: "start",
  counterAlignment: "start",
  primarySizing: "fixed",
  counterSizing: "fixed",
  absolute: false,
});

/**
 * A direct width/height edit is an explicit sizing decision. When a layer
 * participates in a parent Auto Layout flow, preserve the edited dimension by
 * changing only that parent-relative axis to Fixed. This deliberately applies
 * to nested Frames too: their own Auto Layout record is also their child-size
 * record in the parent layout.
 */
export function withManualAutoLayoutSizing(
  nodes: readonly CanvasNode[],
  nodeId: string,
  patch: Partial<CanvasNode>,
): Partial<CanvasNode> {
  if (patch.width === undefined && patch.height === undefined) return patch;
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const parent = node?.parentId ? nodes.find((candidate) => candidate.id === node.parentId) : undefined;
  const parentLayout = parent?.kind === "frame" ? parent.autoLayout : undefined;
  if (!node || !parentLayout || parentLayout.mode === "none" || node.autoLayout?.absolute) return patch;

  const childLayout = { ...(node.autoLayout ?? defaultChildAutoLayout()), ...(patch.autoLayout ?? {}) };
  // A nested Auto Layout Frame describes its child size with its *own*
  // physical axes; ordinary flow children use the parent direction instead.
  const sizingMode = node.kind === "frame" && childLayout.mode !== "none" ? childLayout.mode : parentLayout.mode;
  if (patch.width !== undefined) childLayout[autoLayoutSizingKeyForAxis(sizingMode, "width")] = "fixed";
  if (patch.height !== undefined) childLayout[autoLayoutSizingKeyForAxis(sizingMode, "height")] = "fixed";
  return { ...patch, autoLayout: childLayout };
}
