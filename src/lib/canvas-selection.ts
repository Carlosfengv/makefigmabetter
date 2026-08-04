/**
 * Resolves a click on a canvas object without unexpectedly collapsing an
 * existing multi-selection. This allows dragging any selected object to move
 * the complete selection, matching Figma's direct-manipulation behavior.
 */
export function resolveCanvasObjectSelection(selectedIds: readonly string[], targetId: string, additive: boolean): string[] {
  if (additive) return [...new Set([...selectedIds, targetId])];
  return selectedIds.includes(targetId) ? [...selectedIds] : [targetId];
}
