import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { rotateSelectionAroundWorldPoint, rotationDeltaDegrees, rotateWorldPoint } from "./selection-rotation";
import { transformPoint, worldTransformForNode } from "./scene-transform";

describe("selection rotation", () => {
  it("rotates legacy geometry around its visual centre without introducing a matrix", () => {
    const rectangle = { ...createNode("rectangle", 10, 20), id: "rect", width: 100, height: 40 };
    const patches = rotateSelectionAroundWorldPoint([rectangle], [rectangle.id], { x: 60, y: 40 }, { x: 160, y: 40 }, { x: 60, y: 140 })!;
    expect(patches.get(rectangle.id)).toMatchObject({ x: 10, y: 20, rotation: 90, relativeTransform: undefined });
  });

  it("snaps Shift rotation to fifteen-degree increments", () => {
    expect(rotationDeltaDegrees({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 87, y: 50 }, true)).toBe(30);
    expect(rotationDeltaDegrees({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeUndefined();
  });

  it("rotates selected parents while updating only legacy descendants", () => {
    const frame = { ...createNode("frame", 0, 0), id: "frame", width: 100, height: 80 };
    const relativeChild = { ...createNode("rectangle", 0, 0), id: "relative", parentId: frame.id, width: 20, height: 10, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 15 } };
    const legacyChild = { ...createNode("rectangle", 120, 30), id: "legacy", parentId: frame.id, width: 20, height: 10 };
    const before = [frame, relativeChild, legacyChild];
    const patches = rotateSelectionAroundWorldPoint(before, [frame.id], { x: 50, y: 40 }, { x: 150, y: 40 }, { x: 50, y: 140 })!;
    expect([...patches.keys()].sort()).toEqual(["frame", "legacy"]);
    const after = before.map((node) => patches.has(node.id) ? { ...node, ...patches.get(node.id)! } : node);
    const relativeBefore = transformPoint(worldTransformForNode(before, relativeChild.id)!, { x: 0, y: 0 });
    const legacyBefore = transformPoint(worldTransformForNode(before, legacyChild.id)!, { x: 0, y: 0 });
    const expectedRelative = rotateWorldPoint(relativeBefore, { x: 50, y: 40 }, 90);
    const actualRelative = transformPoint(worldTransformForNode(after, relativeChild.id)!, { x: 0, y: 0 });
    expect(actualRelative.x).toBeCloseTo(expectedRelative.x, 10);
    expect(actualRelative.y).toBeCloseTo(expectedRelative.y, 10);
    const expectedLegacy = rotateWorldPoint(legacyBefore, { x: 50, y: 40 }, 90);
    const actualLegacy = transformPoint(worldTransformForNode(after, legacyChild.id)!, { x: 0, y: 0 });
    expect(actualLegacy.x).toBeCloseTo(expectedLegacy.x, 10);
    expect(actualLegacy.y).toBeCloseTo(expectedLegacy.y, 10);
  });
});
