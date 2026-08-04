import { describe, expect, it } from "vitest";
import type { CanvasNode, EditorSnapshot } from "./editor-protocol";
import { applyOptimisticUpdates } from "./optimistic-projection";

const node: CanvasNode = { id: "one", name: "Card", kind: "rectangle", x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#fff", stroke: "#000", strokeWidth: 1, radius: 0, opacity: 1 };
const snapshot: EditorSnapshot = { revision: 2, nodes: [node], selectedIds: [node.id], viewport: { x: 0, y: 0, zoom: 1 }, canUndo: true, canRedo: false, renderer: "Canvas 2D", documentCore: "Rust/WASM bridge ready" };

describe("optimistic Inspector projection", () => {
  it("keeps later text input over an earlier confirmed Worker snapshot", () => {
    const projected = applyOptimisticUpdates(snapshot, [
      { type: "update", id: node.id, patch: { name: "Car" } },
      { type: "update", id: node.id, patch: { name: "Card draft" } },
    ]);
    expect(projected.nodes[0].name).toBe("Card draft");
    expect(snapshot.nodes[0].name).toBe("Card");
  });

  it("never lets an optimistic patch replace document identity", () => {
    const projected = applyOptimisticUpdates(snapshot, [
      { type: "update", id: node.id, patch: { id: "forged", kind: "ellipse", x: 12 } },
    ]);
    expect(projected.nodes[0]).toMatchObject({ id: "one", kind: "rectangle", x: 12 });
  });
});
