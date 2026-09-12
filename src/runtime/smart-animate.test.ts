import { describe, expect, it } from "vitest";
import { smartAnimateRenderPlan } from "./smart-animate";
import type { RuntimeProjection } from "./runtime-projection-store";

const node = (id: string, parentId: string, name: string, x: number, extra: Record<string, unknown> = {}) => ({ id, type: "RECTANGLE", kind: "rectangle", parentId, name, x, y: 10, width: 20, height: 30, rotation: 0, opacity: 1, fill: "#000000", ...extra });

describe("M5 Smart Animate plan", () => {
  it("interpolates uniquely matched structure layers and leaves unmatched layers as explicit fallbacks", () => {
    const projection: RuntimeProjection = { revision: 1, nodes: [
      { id: "from", type: "FRAME" }, { id: "to", type: "FRAME" },
      node("from-card", "from", "Card", 0), node("from-only", "from", "Old", 20),
      node("to-card", "to", "Card", 100, { fill: "#ffffff", opacity: .5 }), node("to-only", "to", "New", 140),
    ] };
    const plan = smartAnimateRenderPlan(projection, "from", "to", .5);
    expect(plan.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interpolate", match: "structure", fromNodeId: "from-card", toNodeId: "to-card", properties: expect.objectContaining({ x: 50, opacity: .75, fill: "#808080" }) }),
      expect.objectContaining({ kind: "exit", fromNodeId: "from-only", properties: expect.objectContaining({ opacity: .5 }) }),
      expect.objectContaining({ kind: "enter", toNodeId: "to-only", properties: expect.objectContaining({ opacity: .5 }) }),
    ]));
    expect(plan.diagnostics).toEqual(expect.arrayContaining([{ code: "UNMATCHED_SOURCE_LAYER", nodeId: "from-only" }, { code: "UNMATCHED_DESTINATION_LAYER", nodeId: "to-only" }]));
  });

  it("prioritizes component source identity over a renamed instance child", () => {
    const source = (value: string) => ({ extensions: { "figma.instance.source-node.v1": [...new TextEncoder().encode(value)] } });
    const projection: RuntimeProjection = { revision: 1, nodes: [
      { id: "from", type: "FRAME" }, { id: "to", type: "FRAME" },
      node("from-label", "from", "Old label", 0, source("component-label")),
      node("to-label", "to", "New label", 80, source("component-label")),
    ] };
    expect(smartAnimateRenderPlan(projection, "from", "to", .25).layers[0]).toMatchObject({ kind: "interpolate", match: "component-source", properties: { x: 20 } });
  });
});
