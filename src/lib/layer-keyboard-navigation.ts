export type LayerNavigationKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

/** Resolves keyboard movement in the Layer panel's rendered (top-to-bottom)
 * order. The caller owns focus restoration because the list is virtualized. */
export function layerKeyboardTarget(ids: readonly string[], currentId: string, key: LayerNavigationKey): string | undefined {
  const index = ids.indexOf(currentId);
  if (index < 0 || ids.length === 0) return undefined;
  if (key === "Home") return ids[0];
  if (key === "End") return ids.at(-1);
  const next = key === "ArrowDown" ? index + 1 : index - 1;
  return ids[Math.max(0, Math.min(ids.length - 1, next))];
}
