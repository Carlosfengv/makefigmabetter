import type { CanvasPage } from "./editor-protocol";

/** Page position IDs are Canonical ordering keys. Keep export independent of
 * the active tab or creation timing; the ID tie-break makes malformed legacy
 * input deterministic until Core rejects or repairs it. */
export function pagesInCanonicalExportOrder(pages: readonly CanvasPage[]): CanvasPage[] {
  return [...pages].sort((left, right) => left.positionId.localeCompare(right.positionId) || left.id.localeCompare(right.id));
}
