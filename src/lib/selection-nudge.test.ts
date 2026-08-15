import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { resolveSelectionNudge } from "./selection-nudge";
import { worldTransformForNode } from "./scene-transform";

describe("selection keyboard nudge", () => {
  it("moves a Relative-v1 child in world space below a rotated parent", () => {
    const parent = { ...createNode("frame", 20, 30), id: "parent", rotation: 90 };
    const child = {
      ...createNode("rectangle", 0, 0),
      id: "child",
      parentId: parent.id,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 15 },
    };
    const before = worldTransformForNode([parent, child], child.id)!;
    const result = resolveSelectionNudge([parent, child], [child.id], { x: 1, y: 0 })!;
    expect(result.patches).toHaveLength(1);
    const after = worldTransformForNode([parent, { ...child, ...result.patches[0].patch }], child.id)!;
    expect(after.e).toBeCloseTo(before.e + 1);
    expect(after.f).toBeCloseTo(before.f);
  });

  it("moves selected modern containers once while legacy descendants retain world movement", () => {
    const group = { ...createNode("group", 0, 0), id: "group", relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
    const modernChild = { ...createNode("rectangle", 0, 0), id: "modern", parentId: group.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 4, f: 4 } };
    const legacyChild = { ...createNode("rectangle", 40, 40), id: "legacy", parentId: group.id };
    const result = resolveSelectionNudge([group, modernChild, legacyChild], [group.id], { x: 10, y: 0 })!;
    expect(result.patches.map(({ id }) => id).sort()).toEqual(["group", "legacy"]);
  });
});
