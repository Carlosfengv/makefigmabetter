import type { CanvasNode, CoreBatchCommand } from "./editor-protocol";
import { coreProjectionNode } from "./transaction-batch";

/** Turns an already-applied Core history transition into replayable operations.
 * Reappearing nodes use `restore`, because Core reserves tombstoned IDs. */
export function historyReplayBatch(before: readonly CanvasNode[], after: readonly CanvasNode[]): CoreBatchCommand[] {
  const beforeById = new Map(before.map((node) => [node.id, node]));
  const afterById = new Map(after.map((node) => [node.id, node]));
  const deletedIds = before.filter((node) => !afterById.has(node.id)).map((node) => node.id);
  const restores = after
    .filter((node) => !beforeById.has(node.id))
    .map((node) => ({ type: "restore" as const, node: coreProjectionNode(node) }));
  const updates: CoreBatchCommand[] = [];
  const positions: Array<{ id: string; positionId: string }> = [];
  for (const [id, current] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) continue;
    const previousProjection = coreProjectionNode(previous);
    const currentProjection = coreProjectionNode(current);
    const { positionId: previousPosition, ...previousSemantic } = previousProjection;
    const { positionId: currentPosition, ...currentSemantic } = currentProjection;
    if (JSON.stringify(previousSemantic) !== JSON.stringify(currentSemantic)) updates.push({ type: "update", node: currentProjection });
    if (previousPosition !== currentPosition && currentPosition) positions.push({ id, positionId: currentPosition });
  }
  return [
    ...(deletedIds.length ? [{ type: "delete" as const, ids: deletedIds }] : []),
    ...restores,
    ...updates,
    ...(positions.length ? [{ type: "reposition" as const, positionIds: positions }] : []),
  ];
}

/** Rare recovery fallback when a Core hash changed but a historic projection
 * cannot be diffed. Updating every extant node is conservative and preserves
 * the authoritative post-undo state for remote replay. */
export function fullStateReplayBatch(nodes: readonly CanvasNode[]): CoreBatchCommand[] {
  return nodes.map((node) => ({ type: "update" as const, node: coreProjectionNode(node) }));
}
