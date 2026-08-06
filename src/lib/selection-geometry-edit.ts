import type { CanvasNode } from "./editor-protocol";
import { resolveMultiResizeSelection, type MultiResizeSelection } from "./multi-selection";
import { scaleLegacySelectionGeometry } from "./selection-resize";
import { scaleSelectionTransforms } from "./selection-transform-resize";

export type SelectionGeometryEdit = Partial<Pick<CanvasNode, "x" | "y" | "width" | "height">>;
export type SelectionGeometryPatch = Partial<Pick<CanvasNode, "x" | "y" | "width" | "height" | "rotation" | "relativeTransform">>;

/**
 * Converts one Inspector X/Y/W/H edit into patches for the same collective
 * selection geometry used by Canvas handles. The caller may submit all
 * returned patches as one Core transaction.
 */
export function selectionGeometryPatches(
  nodes: readonly CanvasNode[],
  selectedIds: readonly string[],
  edit: SelectionGeometryEdit,
): Readonly<{ selection: MultiResizeSelection; patches: ReadonlyMap<string, SelectionGeometryPatch> }> | undefined {
  const selection = resolveMultiResizeSelection(nodes, selectedIds);
  if (!selection) return undefined;
  const before = selection.bounds;
  const after = {
    x: edit.x ?? before.x,
    y: edit.y ?? before.y,
    width: edit.width ?? before.width,
    height: edit.height ?? before.height,
  };
  if (![after.x, after.y, after.width, after.height].every(Number.isFinite) || after.width <= 0 || after.height <= 0) return undefined;
  const patches = selection.requiresAffine
    ? scaleSelectionTransforms(nodes, selection.ids, before, after)
    : scaleLegacySelectionGeometry(nodes.filter((node) => selection.ids.includes(node.id)), before, after);
  if (!patches || patches.size !== selection.ids.length) return undefined;
  return { selection, patches };
}
