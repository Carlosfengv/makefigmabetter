import { describe, expect, it } from "vitest";
import type { CanvasNode } from "./editor-protocol";
import { marqueeRect, resolveMarqueeSelection, selectNodesInMarquee } from "./marquee-selection";

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, name: id, kind: "rectangle", x: 0, y: 0, width: 40, height: 40, rotation: 0,
  fill: "#ffffff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1, visible: true, ...patch,
});

describe("marquee selection", () => {
  it("normalizes a drag in either direction", () => {
    expect(marqueeRect({ x: 50, y: 20 }, { x: 10, y: 60 })).toEqual({ x: 10, y: 20, width: 40, height: 40 });
  });

  it("selects visible layers touched by the marquee and excludes hidden layers", () => {
    const nodes = [node("inside"), node("edge", { x: 35 }), node("outside", { x: 80 }), node("hidden", { visible: false })];
    expect(selectNodesInMarquee(nodes, { x: -5, y: -5 }, { x: 50, y: 45 })).toEqual(["inside", "edge"]);
  });

  it("uses the visual bounds of rotated layers", () => {
    expect(selectNodesInMarquee([node("rotated", { x: 50, y: 50, width: 40, height: 20, rotation: 45 })], { x: 45, y: 45 }, { x: 52, y: 52 })).toEqual(["rotated"]);
  });

  it("adds marquee results to the existing selection only when Shift is held", () => {
    expect(resolveMarqueeSelection(["first"], ["first", "second"], true)).toEqual(["first", "second"]);
    expect(resolveMarqueeSelection(["first"], ["second"], false)).toEqual(["second"]);
  });
});
