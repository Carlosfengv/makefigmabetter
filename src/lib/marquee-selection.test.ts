import { describe, expect, it } from "vitest";
import type { CanvasNode } from "./editor-protocol";
import { exceedsMarqueeDragThreshold, lineLocalBounds, lineSelectionBounds, marqueeRect, resolveMarqueeSelection, rotatedNodeBounds, selectNodesInMarquee } from "./marquee-selection";

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

  it("keeps zero-height Lines centred on their path for bounds and marquee selection", () => {
    const line = node("line", { kind: "line", x: 10, y: 20, width: 100, height: 0, strokeWidth: 1 });
    expect(rotatedNodeBounds(line)).toEqual({ x: 10, y: 16, width: 100, height: 8 });
    expect(selectNodesInMarquee([line], { x: 50, y: 18 }, { x: 60, y: 22 })).toEqual(["line"]);
  });

  it("includes filled endpoint decorations in Line selection bounds", () => {
    const line = node("line", { kind: "line", width: 100, height: 0, strokeWidth: 2, strokeCapEnd: "circleFilled" });
    expect(lineLocalBounds(line)).toMatchObject({ width: 104, height: 8 });
  });

  it("keeps the Figma Line selection frame centred on the painted stroke", () => {
    const line = node("line", { kind: "line", width: 100, height: 0, strokeWidth: 16, strokeCapStart: "square", strokeCapEnd: "arrowLines" });
    expect(lineSelectionBounds(line)).toEqual({ x: -8, y: -32, width: 108, height: 64 });
  });

  it("does not leave asymmetric dashed caps outside Canvas' Butt selection footprint", () => {
    const line = node("line", { kind: "line", width: 100, height: 0, strokeWidth: 10, strokeDashPattern: [8, 4], strokeCapStart: "square", strokeCapEnd: "round" });
    expect(lineSelectionBounds(line)).toEqual({ x: 0, y: -5, width: 100, height: 10 });
  });

  it("does not extend a symmetric dashed Line into an unpainted terminal gap", () => {
    const line = node("line", { kind: "line", width: 94, height: 0, strokeWidth: 10, strokeDashPattern: [8, 4], strokeCapStart: "square", strokeCapEnd: "square" });
    expect(lineSelectionBounds(line)).toEqual({ x: -5, y: -5, width: 99, height: 10 });
  });

  it("rotates a Line's visual selection footprint around its actual endpoint origin", () => {
    const line = node("line", { kind: "line", x: 10, y: 20, width: 100, height: 0, rotation: 90, strokeWidth: 1 });
    const bounds = rotatedNodeBounds(line);
    expect(bounds.x).toBeCloseTo(6);
    expect(bounds.y).toBeCloseTo(20);
    expect(bounds.width).toBeCloseTo(8);
    expect(bounds.height).toBeCloseTo(100);
  });

  it("does not turn a click in the empty corner of a rotated layer's bounds into a marquee hit", () => {
    const rotated = node("rotated", { width: 100, height: 40, rotation: 45 });
    const emptyCorner = { x: 5, y: -20 };

    expect(selectNodesInMarquee([rotated], emptyCorner, emptyCorner)).toEqual([]);
  });

  it("starts marquee selection only after three CSS pixels of pointer movement", () => {
    expect(exceedsMarqueeDragThreshold({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(false);
    expect(exceedsMarqueeDragThreshold({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(true);
    expect(exceedsMarqueeDragThreshold({ x: 10, y: 10 }, { x: 12, y: 13 })).toBe(true);
  });

  it("adds marquee results to the existing selection only when Shift is held", () => {
    expect(resolveMarqueeSelection(["first"], ["first", "second"], true)).toEqual(["first", "second"]);
    expect(resolveMarqueeSelection(["first"], ["second"], false)).toEqual(["second"]);
  });
});
