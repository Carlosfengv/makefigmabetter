export const RUST_RENDER_PASSES = ["mainScene", "images", "text", "overlay", "composite"] as const;
export type RustRenderPass = typeof RUST_RENDER_PASSES[number];

export type RustRenderGraphPlan = {
  documentRevision: number;
  commands: readonly { nodeId: string; pass: RustRenderPass }[];
  /** Lookup-only derived index: never serialized or persisted. */
  orderByNodeId: ReadonlyMap<string, { passIndex: number; commandIndex: number }>;
};

type IdentifiedNode = { id: string };

/**
 * Validates the derived Rust render plan before it can control presentation
 * order. A malformed plan must only disable this optimization, never hide a
 * Canvas node or alter Canonical state.
 */
export function parseRustRenderGraphPlan(value: string): RustRenderGraphPlan | undefined {
  try {
    const payload = JSON.parse(value) as { documentRevision?: unknown; fullScene?: unknown; passes?: unknown; commands?: unknown };
    const documentRevision = payload.documentRevision;
    if (typeof documentRevision !== "number" || !Number.isSafeInteger(documentRevision) || documentRevision < 0 || payload.fullScene !== true) return undefined;
    if (!Array.isArray(payload.passes) || payload.passes.length !== RUST_RENDER_PASSES.length || payload.passes.some((pass, index) => pass !== RUST_RENDER_PASSES[index])) return undefined;
    if (!Array.isArray(payload.commands)) return undefined;
    const nodeIds = new Set<string>();
    const commands: Array<{ nodeId: string; pass: RustRenderPass }> = [];
    const orderByNodeId = new Map<string, { passIndex: number; commandIndex: number }>();
    for (const [commandIndex, command] of payload.commands.entries()) {
      if (!command || typeof command !== "object") return undefined;
      const { nodeId, pass } = command as { nodeId?: unknown; pass?: unknown };
      if (typeof nodeId !== "string" || !nodeId || nodeIds.has(nodeId) || !RUST_RENDER_PASSES.includes(pass as RustRenderPass)) return undefined;
      nodeIds.add(nodeId);
      commands.push({ nodeId, pass: pass as RustRenderPass });
      orderByNodeId.set(nodeId, { passIndex: RUST_RENDER_PASSES.indexOf(pass as RustRenderPass), commandIndex });
    }
    return { documentRevision, commands, orderByNodeId };
  } catch {
    return undefined;
  }
}

/**
 * Applies the immutable Rust pass ordering to a culled presentation subset.
 * Nodes missing from a plan remain visible in their local order, so a stale or
 * partially available plan cannot cause a blank frame during recovery.
 */
export function orderNodesByRustRenderGraph<T extends IdentifiedNode>(nodes: readonly T[], plan: RustRenderGraphPlan | undefined): T[] {
  if (!plan) return [...nodes];
  // The plan can describe 100k nodes while only a small viewport subset is
  // visible. Sort that subset rather than re-walking every plan command.
  return nodes
    .map((node, localIndex) => ({ node, localIndex, order: plan.orderByNodeId.get(node.id) }))
    .sort((left, right) => {
      if (!left.order || !right.order) return (left.order ? -1 : right.order ? 1 : left.localIndex - right.localIndex);
      return left.order.passIndex - right.order.passIndex || left.order.commandIndex - right.order.commandIndex;
    })
    .map(({ node }) => node);
}
