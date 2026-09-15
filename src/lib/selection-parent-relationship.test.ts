import { describe, expect, it } from "vitest";
import type { CanvasNode, DocumentAutoLayout } from "./editor-protocol";
import { selectionParentRelationship } from "./selection-parent-relationship";
import { worldTransformsForNodes } from "./scene-transform";

const layout: DocumentAutoLayout = {
  mode: "horizontal", padding: [20, 20, 20, 20], itemSpacing: 10,
  wrap: false, primaryAlignment: "start", counterAlignment: "start",
  primarySizing: "fixed", counterSizing: "fixed", absolute: false,
};
const parent: CanvasNode = {
  id: "parent", name: "Parent", kind: "frame", x: 100, y: 200,
  width: 300, height: 200, rotation: 0, fill: "#fff", stroke: "transparent",
  strokeWidth: 0, radius: 0, opacity: 1,
};
const child: CanvasNode = {
  ...parent, id: "child", name: "Child", kind: "rectangle", parentId: "parent",
  x: 130, y: 240, width: 100, height: 60,
};
const values = (nodes: CanvasNode[]) => selectionParentRelationship(nodes, ["child"])?.distances.map(({ side, value }) => [side, value]);

describe("selection parent relationship", () => {
  it("measures all four parent edges using legacy world coordinates", () => {
    expect(values([parent, child])).toEqual([["left", 30], ["right", 170], ["top", 40], ["bottom", 100]]);
    expect(selectionParentRelationship([parent, child], ["child"])?.distances[0]).toEqual({
      side: "left", value: 30, start: { x: 100, y: 270 }, end: { x: 130, y: 270 },
    });
  });

  it("shows only the dashed parent for flow children and distances for absolute children", () => {
    const frame = { ...parent, autoLayout: layout };
    expect(selectionParentRelationship([frame, child], ["child"])).toMatchObject({ autoLayout: true, distances: [] });
    expect(values([frame, { ...child, autoLayout: { ...layout, mode: "none", absolute: true } }])).toHaveLength(4);
    // A child's own Auto Layout does not decide its relationship to its parent.
    expect(values([parent, { ...child, autoLayout: layout }])).toHaveLength(4);
    expect(values([{ ...frame, autoLayout: { ...layout, mode: "none" } }, child])).toHaveLength(4);
  });

  it("recognizes an older parent record that contains only the Auto Layout mode", () => {
    const legacy = { ...parent, autoLayout: { mode: "vertical" } as DocumentAutoLayout };
    expect(selectionParentRelationship([legacy, child], ["child"])).toMatchObject({ autoLayout: true, distances: [] });
  });

  it.each(["frame", "component", "instance", "slot", "componentSet"] as const)("supports Auto Layout on %s containers", (kind) => {
    expect(selectionParentRelationship([{ ...parent, kind, autoLayout: layout }, child], ["child"])?.autoLayout).toBe(true);
  });

  it("uses the immediate parent, with nested rotation, reflection and scale applied only once", () => {
    const outer = { ...parent, id: "outer", relativeTransform: { a: 2, b: 0, c: 0, d: 2, e: 500, f: 600 } };
    const frame = { ...parent, parentId: "outer", relativeTransform: { a: 0, b: 1, c: -1, d: 0, e: 100, f: 200 } };
    const localChild = { ...child, x: 999, y: 999, relativeTransform: { a: -1, b: 0, c: 0, d: 1, e: 130, f: 40 } };
    const nodes = [outer, frame, localChild];
    expect(values(nodes)).toEqual([["left", 30], ["right", 170], ["top", 40], ["bottom", 100]]);
    const relation = selectionParentRelationship(nodes, ["child"], worldTransformsForNodes(nodes));
    expect(relation?.outline).toEqual([{ x: 700, y: 1000 }, { x: 700, y: 1600 }, { x: 300, y: 1600 }, { x: 300, y: 1000 }]);
    expect(relation?.distances[0]).toEqual({ side: "left", value: 30, start: { x: 560, y: 1000 }, end: { x: 560, y: 1060 } });
  });

  it("measures rotated child bounds in parent space", () => {
    expect(values([parent, { ...child, rotation: 90 }])).toEqual([["left", 50], ["right", 190], ["top", 20], ["bottom", 80]]);
  });

  it("preserves fractional and signed overflow distances, and omits flush edges", () => {
    expect(values([parent, { ...child, x: 90.75, y: 200 }])).toEqual([["left", -9.25], ["right", 209.25], ["bottom", 140]]);
  });

  it("does not invent a parent for roots, missing parents, empty or multi-selection", () => {
    for (const ids of [[], ["parent"], ["missing"], ["parent", "child"]]) {
      expect(selectionParentRelationship([parent, child], ids)).toBeUndefined();
    }
    expect(selectionParentRelationship([child], ["child"])).toBeUndefined();
  });

  it("ignores hidden, invalid and cross-page relationships", () => {
    for (const patch of [{ visible: false }, { contentsHidden: true }, { width: 0 }, { parentId: "child" },
      { relativeTransform: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 } }]) {
      expect(selectionParentRelationship([{ ...parent, ...patch }, child], ["child"])).toBeUndefined();
    }
    expect(selectionParentRelationship([parent, { ...child, visible: false }], ["child"])).toBeUndefined();
    expect(selectionParentRelationship([{ ...parent, pageId: "one" }, { ...child, pageId: "two" }], ["child"])).toBeUndefined();
  });
});
