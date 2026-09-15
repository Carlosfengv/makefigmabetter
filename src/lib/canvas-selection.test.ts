import { describe, expect, it } from "vitest";
import { resolveCanvasObjectSelection, resolveNestedKeyboardTarget, resolveNestedSelectionTarget } from "./canvas-selection";
import type { CanvasNode } from "./editor-protocol";

const groupTree: CanvasNode[] = [
  { id: "outer", name: "Outer", kind: "group", x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: "transparent", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
  { id: "inner", parentId: "outer", name: "Inner", kind: "group", x: 10, y: 10, width: 50, height: 50, rotation: 0, fill: "transparent", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
  { id: "child", parentId: "inner", name: "Child", kind: "rectangle", x: 15, y: 15, width: 20, height: 20, rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
];

const frameTree: CanvasNode[] = [
  { id: "frame", name: "Frame", kind: "frame", x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
  { id: "nested-frame", parentId: "frame", name: "Nested frame", kind: "frame", x: 10, y: 10, width: 80, height: 80, rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
  { id: "frame-child", parentId: "nested-frame", name: "Frame child", kind: "rectangle", x: 20, y: 20, width: 20, height: 20, rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
];

const transformGroupTree: CanvasNode[] = [
  { ...groupTree[0]!, id: "repeat", kind: "transformGroup", transformModifiers: [{ type: "REPEAT", repeatType: "RADIAL", count: 3, unitType: "PIXELS", offset: 40 }] },
  { ...groupTree[2]!, id: "repeat-child", parentId: "repeat" },
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

  it("selects the outer Group and drills through each nested boundary one level at a time", () => {
    expect(resolveNestedSelectionTarget(groupTree, "child", false)?.id).toBe("outer");
    expect(resolveNestedSelectionTarget(groupTree, "child", false, ["outer"])?.id).toBe("outer");
    expect(resolveNestedSelectionTarget(groupTree, "child", true, ["outer"])?.id).toBe("inner");
    expect(resolveNestedSelectionTarget(groupTree, "child", false, ["inner"])?.id).toBe("inner");
    expect(resolveNestedSelectionTarget(groupTree, "child", true, ["inner"])?.id).toBe("child");
    expect(resolveNestedSelectionTarget(groupTree, "child", true)?.id).toBe("child");
  });

  it("treats Frames as the same nested selection boundary and supports deep select", () => {
    expect(resolveNestedSelectionTarget(frameTree, "frame-child", false)?.id).toBe("frame");
    expect(resolveNestedSelectionTarget(frameTree, "frame-child", true, ["frame"])?.id).toBe("nested-frame");
    expect(resolveNestedSelectionTarget(frameTree, "frame-child", false, [], true)?.id).toBe("frame-child");
  });

  it("treats a TransformGroup as the boundary for source and derived Repeat hits", () => {
    expect(resolveNestedSelectionTarget(transformGroupTree, "repeat-child", false)?.id).toBe("repeat");
    expect(resolveNestedSelectionTarget(transformGroupTree, "repeat-child", true, ["repeat"])?.id).toBe("repeat-child");
    expect(resolveNestedKeyboardTarget(transformGroupTree, ["repeat"], "child")?.id).toBe("repeat-child");
  });

  it("moves a nested selection with Enter and Shift+Enter", () => {
    expect(resolveNestedKeyboardTarget(frameTree, ["frame"], "child")?.id).toBe("nested-frame");
    expect(resolveNestedKeyboardTarget(frameTree, ["nested-frame"], "parent")?.id).toBe("frame");
  });

  it("keeps a deeply selected child selected when beginning a canvas drag", () => {
    expect(resolveNestedSelectionTarget(groupTree, "child", false, ["child"])?.id).toBe("child");
  });

  it("keeps a directly hit Group and tolerates malformed parent cycles", () => {
    expect(resolveNestedSelectionTarget(groupTree, "inner", false)?.id).toBe("inner");
    const cyclic = [{ ...groupTree[2], parentId: "child" }];
    expect(resolveNestedSelectionTarget(cyclic, "child", false)?.id).toBe("child");
  });
});
