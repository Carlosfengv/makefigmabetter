import { describe, expect, it } from "vitest";
import { createApiPrototypeCardFlow } from "./api-prototype-card-flow";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RuntimeSession } from "./runtime-session";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";

const initial: RuntimeProjection = { revision: 0, nodes: [{ id: "document", type: "DOCUMENT", name: "Document" }, { id: "page", type: "PAGE", parentId: "document", name: "Page", siblingIndex: 0 }] };

describe("api-prototype-card-flow", () => {
  it("builds, persists, reloads and plays the documented card navigation flow", async () => {
    const transport = new FixtureTransport(initial);
    const runtime = runtimeFor(transport.snapshot(), transport);
    const flow = await createApiPrototypeCardFlow(runtime);

    expect(flow.listFrame.children.map((node) => node.name)).toEqual(["Card"]);
    expect((await runtime.getNodeByIdAsync(flow.detailButton.id))?.reactions[0]?.actions[0]).toMatchObject({ type: "NODE", navigation: "NAVIGATE", destinationId: flow.detailFrame.id });

    const reloaded = runtimeFor(transport.snapshot());
    const player = reloaded.createPrototypePlayer(flow.listFrame.id, {
      reducedMotion: true,
      focusableNodeIds: (frameId) => frameId === flow.listFrame.id ? [flow.detailButton.id]
        : frameId === flow.detailFrame.id ? [flow.overlayButton.id, flow.backButton.id]
          : [flow.overlayCloseButton.id],
    });
    await player.dispatch({ type: "CLICK", targetId: flow.detailButton.id });
    expect(player.state.currentFrameId).toBe(flow.detailFrame.id);
    await player.dispatchKeyboard({ key: "ENTER" });
    expect(player.state.overlays.map((overlay) => overlay.frameId)).toEqual([flow.overlayFrame.id]);
    await player.dispatchKeyboard({ key: "ENTER" });
    expect(player.state.overlays).toEqual([]);
    await player.dispatch({ type: "CLICK", targetId: flow.backButton.id });
    expect(player.state.currentFrameId).toBe(flow.listFrame.id);
    player.close();
  });
});

function runtimeFor(projection: RuntimeProjection, transport = new FixtureTransport(projection)): FigmaCompatibleRuntime {
  let sequence = 0;
  return new FigmaCompatibleRuntime(new RuntimeSession({ sessionId: `api-prototype-card-flow:${projection.revision}`, projection, transport, createId: () => `flow-${sequence++}`, scheduleMicrotask: () => {} }));
}

class FixtureTransport implements RuntimeTransactionTransport {
  private projection: RuntimeProjection;
  constructor(projection: RuntimeProjection) { this.projection = structuredClone(projection); }
  snapshot(): RuntimeProjection { return structuredClone(this.projection); }
  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    if (transaction.baseRevision !== this.projection.revision) return { type: "rejected", errorCode: "REVISION_CONFLICT" };
    const nodes = new Map(this.projection.nodes.map((node) => [node.id, structuredClone(node)]));
    for (const operation of transaction.operations) {
      if (operation.type === "create") nodes.set(operation.node.id, { ...structuredClone(operation.node), removed: false });
      else if (operation.type === "remove") nodes.delete(operation.nodeId);
      else {
        const node = nodes.get(operation.nodeId);
        if (!node) return { type: "rejected", errorCode: "TRANSACTION_ABORTED" };
        nodes.set(operation.nodeId, { ...node, ...structuredClone(operation.patch) });
      }
    }
    this.projection = { revision: this.projection.revision + 1, nodes: [...nodes.values()] };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.snapshot() };
  }
}
