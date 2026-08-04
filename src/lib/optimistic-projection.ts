import type { EditorCommand, EditorSnapshot } from "./editor-protocol";

export type OptimisticUpdate = Extract<EditorCommand, { type: "update" }>;

/** Reapplies unacknowledged Inspector edits over the latest confirmed Worker state. */
export function applyOptimisticUpdates(snapshot: EditorSnapshot, updates: Iterable<OptimisticUpdate>): EditorSnapshot {
  let nodes = snapshot.nodes;
  for (const update of updates) {
    nodes = nodes.map((node) => node.id === update.id ? { ...node, ...update.patch, id: node.id, kind: node.kind } : node);
  }
  return nodes === snapshot.nodes ? snapshot : { ...snapshot, nodes };
}
