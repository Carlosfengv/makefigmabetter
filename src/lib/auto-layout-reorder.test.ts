import { describe, expect, it } from "vitest";
import { autoLayoutArrowReorder, autoLayoutDropReorder } from "./auto-layout-reorder";
import { createNode, type CanvasNode } from "./editor-protocol";

const layout = (mode: "horizontal" | "vertical") => ({ mode, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 10, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false });
const frame = (mode: "horizontal" | "vertical") => ({ ...createNode("frame", 0, 0), id: "frame", width: 300, height: 300, autoLayout: layout(mode) });
const child = (id: string, position: string, x: number, y: number): CanvasNode => ({ ...createNode("rectangle", x, y), id, parentId: "frame", positionId: `${position.padStart(32, "0")}:00000000000000000000000000000000`, width: 40, height: 40 });

describe("Auto layout child reordering", () => {
  it("uses the primary-axis arrow key to exchange a vertical child with its next sibling", () => {
    const nodes = [frame("vertical"), child("first", "1", 0, 0), child("second", "2", 0, 50), child("third", "3", 0, 100)];

    const resolved = autoLayoutArrowReorder(nodes, ["first"], "ArrowDown");

    expect(resolved.handled).toBe(true);
    expect(resolved.reorder?.result?.orderedIds).toEqual(["second", "first", "third"]);
  });

  it("uses the primary-axis arrow key to exchange a horizontal child with its previous sibling", () => {
    const nodes = [frame("horizontal"), child("first", "1", 0, 0), child("second", "2", 50, 0), child("third", "3", 100, 0)];

    expect(autoLayoutArrowReorder(nodes, ["second"], "ArrowLeft").reorder?.result?.orderedIds).toEqual(["second", "first", "third"]);
    expect(autoLayoutArrowReorder(nodes, ["second"], "ArrowDown")).toEqual(expect.objectContaining({ handled: true }));
  });

  it("inserts a dragged child before the sibling under the vertical pointer", () => {
    const nodes = [frame("vertical"), child("first", "1", 0, 0), child("second", "2", 0, 50), child("third", "3", 0, 100)];

    expect(autoLayoutDropReorder(nodes, ["third"], { x: 20, y: 0 })?.result?.orderedIds).toEqual(["third", "first", "second"]);
    expect(autoLayoutDropReorder(nodes, ["first"], { x: 20, y: 220 })?.result?.orderedIds).toEqual(["second", "third", "first"]);
  });

  it("keeps absolute children out of the flow reordering scope", () => {
    const absolute = { ...child("absolute", "2", 0, 50), autoLayout: { ...layout("vertical"), mode: "none" as const, absolute: true } };
    const nodes = [frame("vertical"), child("first", "1", 0, 0), absolute, child("second", "3", 0, 100)];

    expect(autoLayoutArrowReorder(nodes, ["absolute"], "ArrowDown")).toEqual({ handled: false });
  });
});
