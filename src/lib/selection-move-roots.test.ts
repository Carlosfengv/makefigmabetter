import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { movableSelectionIds } from "./selection-move-roots";

describe("movable selection roots", () => {
  it("moves a Relative-v1 Group once and lets its relative descendants inherit it", () => {
    const group = { ...createNode("group", 0, 0), id: "group", relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 } };
    const child = { ...createNode("rectangle", 0, 0), id: "child", parentId: group.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 15 } };
    const grandchild = { ...createNode("ellipse", 0, 0), id: "grandchild", parentId: child.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 2, f: 3 } };

    expect(movableSelectionIds([group, child, grandchild], [group.id])).toEqual(new Set([group.id]));
  });

  it("still includes legacy descendants because their world x/y do not inherit the parent", () => {
    const group = { ...createNode("group", 0, 0), id: "group", relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 } };
    const legacyChild = { ...createNode("rectangle", 100, 80), id: "legacy", parentId: group.id };

    expect(movableSelectionIds([group, legacyChild], [group.id])).toEqual(new Set([group.id, legacyChild.id]));
  });
});
