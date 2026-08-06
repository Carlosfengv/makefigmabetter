import { describe, expect, it } from "vitest";
import { resolveCanvasObjectSelection, resolveGroupSelectionTarget } from "./canvas-selection";
import type { CanvasNode } from "./editor-protocol";

const groupTree: CanvasNode[] = [
  { id: "outer", name: "Outer", kind: "group", x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: "transparent", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
  { id: "inner", parentId: "outer", name: "Inner", kind: "group", x: 10, y: 10, width: 50, height: 50, rotation: 0, fill: "transparent", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
  { id: "child", parentId: "inner", name: "Child", kind: "rectangle", x: 15, y: 15, width: 20, height: 20, rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
];

describe("canvas object selection", () => {
  it("keeps an existing multi-selection when pressing a selected object", () => {
    expect(resolveCanvasObjectSelection(["sun", "signal"], "sun", false)).toEqual(["sun", "signal"]);
  });

  it("replaces the selection when pressing an unselected object", () => {
    expect(resolveCanvasObjectSelection(["sun", "signal"], "headline", false)).toEqual(["headline"]);
  });

  it("adds a target once when shift is held", () => {
    expect(resolveCanvasObjectSelection(["sun", "signal"], "sun", true)).toEqual(["sun", "signal"]);
    expect(resolveCanvasObjectSelection(["sun", "signal"], "headline", true)).toEqual(["sun", "signal", "headline"]);
  });

  it("selects the nearest Group for a normal press and drills into its child on a repeated press", () => {
    expect(resolveGroupSelectionTarget(groupTree, "child", false)?.id).toBe("inner");
    expect(resolveGroupSelectionTarget(groupTree, "child", true)?.id).toBe("child");
  });

  it("keeps a directly hit Group and tolerates malformed parent cycles", () => {
    expect(resolveGroupSelectionTarget(groupTree, "inner", false)?.id).toBe("inner");
    const cyclic = [{ ...groupTree[2], parentId: "child" }];
    expect(resolveGroupSelectionTarget(cyclic, "child", false)?.id).toBe("child");
  });
});
