import { describe, expect, it } from "vitest";
import { orderNewLayerAtFront, resolveLayerDrop, resolveLayerOrder, sortNodesByLayerOrder } from "./layer-order";
import type { CanvasNode } from "./editor-protocol";

const node = (id: string, key: string): CanvasNode => ({ id, positionId: `${key.padStart(32, "0")}:00000000000000000000000000000000`, name: id, kind: "rectangle", x: 0, y: 0, width: 1, height: 1, rotation: 0, fill: "#000000", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 });
const layers = [node("back", "1"), node("middle", "2"), node("front", "3")];

describe("layer order", () => {
  it("orders canonical siblings back-to-front", () => {
    expect(sortNodesByLayerOrder([layers[2], layers[0], layers[1]]).map(({ id }) => id)).toEqual(["back", "middle", "front"]);
  });

  it("moves selected layers as a stable block", () => {
    const result = resolveLayerOrder(layers, ["back", "middle"], "front");
    expect(result?.orderedIds).toEqual(["front", "back", "middle"]);
    expect(result?.positionIds.get("back")).toBeDefined();
    expect(result?.positionIds.get("middle")).toBeDefined();
  });

  it("inserts a dragged layer before the requested sibling", () => {
    expect(resolveLayerDrop(layers, ["front"], "middle")?.orderedIds).toEqual(["back", "front", "middle"]);
  });

  it("allocates after a legacy sibling whose Core position falls back to its ID", () => {
    const legacy = { ...node("00000000-0000-0000-0000-000000000001", "1"), positionId: undefined };
    expect(orderNewLayerAtFront([legacy], "00000000-0000-0000-0000-000000000002"))
      .toBe("00000000000000000000000000000002:00000000000000000000000000000000");
  });
});
