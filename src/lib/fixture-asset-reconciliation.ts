import type {
  CanvasNode,
  DocumentAsset,
  EditorCommand,
} from "./editor-protocol";

export function fixtureAssetNeedsRegistration(
  assets: readonly DocumentAsset[] | undefined,
  seed: Readonly<{ assetId: string; preRegistered?: boolean }>,
): boolean {
  return !seed.preRegistered && !assets?.some((asset) => asset.assetId === seed.assetId);
}

/** Worker recovery replays a durable fixture snapshot. Reconcile only the
 * fixture-only fields deliberately stripped from the legacy seed; an existing
 * plain image node must not receive an empty update that advances revision. */
export function fixtureAssetNodeCommands(
  currentNodes: readonly CanvasNode[],
  fixtureNodes: readonly CanvasNode[],
): EditorCommand[] {
  return fixtureNodes.flatMap((node): EditorCommand[] => {
    const current = currentNodes.find((candidate) => candidate.id === node.id);
    if (!current) return [{ type: "create", node }];
    const patch: Partial<CanvasNode> = {
      ...(node.fillStack !== undefined &&
      JSON.stringify(current.fillStack) !== JSON.stringify(node.fillStack)
        ? { fillStack: node.fillStack }
        : {}),
      ...(node.strokeStack !== undefined &&
      JSON.stringify(current.strokeStack) !== JSON.stringify(node.strokeStack)
        ? { strokeStack: node.strokeStack }
        : {}),
    };
    return Object.keys(patch).length
      ? [{ type: "update", id: node.id, patch }]
      : [];
  });
}
