import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { IDENTITY_AFFINE, invertAffine, multiplyAffine, nodePropsForWorldTransform, transformPoint, worldBoundsForNode, worldSpaceProjectionNode, worldTransformForNode } from "./scene-transform";

describe("scene transform foundation", () => {
  it("resolves a three-level relative hierarchy into deterministic world space", () => {
    const frame = { ...createNode("frame", 100, 50), id: "frame", width: 300, height: 200, rotation: 30 };
    const group = { ...createNode("group", 40, 20), id: "group", parentId: frame.id, width: 120, height: 80, rotation: -20, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 40, f: 20 } };
    const line = { ...createNode("line", 10, 12), id: "line", parentId: group.id, width: 90, height: 0, rotation: 15, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 12 } };
    const world = worldTransformForNode([frame, group, line], line.id);

    expect(world).toBeDefined();
    expect(transformPoint(world!, { x: 0, y: 0 })).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    const bounds = worldBoundsForNode([frame, group, line], line)!;
    expect(bounds.right).toBeGreaterThan(bounds.left);
    expect(bounds.bottom).not.toBeNaN();
  });

  it("composes parent and child transforms in Canvas order", () => {
    const parent = { ...IDENTITY_AFFINE, e: 100, f: 50 };
    const child = { ...IDENTITY_AFFINE, a: 0, b: 1, c: -1, d: 0, e: 20, f: 0 };
    expect(transformPoint(multiplyAffine(parent, child), { x: 4, y: 6 })).toEqual({ x: 114, y: 54 });
  });

  it("prefers a persisted relative transform over legacy x/y/rotation", () => {
    const parent = { ...createNode("frame", 100, 50), id: "parent", width: 300, height: 200 };
    const child = {
      ...createNode("rectangle", 999, 999), id: "child", parentId: parent.id, width: 80, height: 40,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 },
    };
    expect(transformPoint(worldTransformForNode([parent, child], child.id)!, { x: 0, y: 0 })).toEqual({ x: 120, y: 80 });
  });

  it("keeps legacy children in world coordinates even when their structural parent moves", () => {
    const parent = { ...createNode("frame", 100, 50), id: "parent", width: 300, height: 200, rotation: 30 };
    const legacyChild = { ...createNode("rectangle", 20, 30), id: "child", parentId: parent.id, width: 80, height: 40 };
    expect(transformPoint(worldTransformForNode([parent, legacyChild], legacyChild.id)!, { x: 0, y: 0 })).toEqual({ x: 20, y: 30 });
  });

  it("uses a Legacy Line's first endpoint as its transform origin", () => {
    const line = { ...createNode("line", 10, 20), id: "line", width: 100, height: 0, rotation: 90 };
    const world = worldTransformForNode([line], line.id)!;
    expect(transformPoint(world, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    expect(transformPoint(world, { x: 100, y: 0 }).x).toBeCloseTo(10);
    expect(transformPoint(world, { x: 100, y: 0 }).y).toBeCloseTo(120);
  });

  it("flattens a relative translate/rotate/scale node for the current Canvas renderer", () => {
    const node = {
      ...createNode("rectangle", 0, 0), id: "child", width: 80, height: 40,
      relativeTransform: { a: 0, b: 2, c: -3, d: 0, e: 100, f: 50 },
    };
    const projected = worldSpaceProjectionNode([node], node)!;
    expect(projected).toMatchObject({ x: -40, y: 70, width: 160, height: 120, rotation: 90, relativeTransform: undefined });
    expect(transformPoint(worldTransformForNode([node], node.id)!, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
  });

  it("retains skew and reflection for the matrix-native Canvas pass", () => {
    const skewed = {
      ...createNode("rectangle", 0, 0), id: "skewed", width: 80, height: 40,
      relativeTransform: { a: -1, b: 0, c: .35, d: 1, e: 100, f: 50 },
    };
    expect(worldSpaceProjectionNode([skewed], skewed)).toBeUndefined();
    expect(worldBoundsForNode([skewed], skewed)).toEqual({ left: 20, top: 50, right: 114, bottom: 90 });
  });

  it("converts a world transform to a new parent-local transform without visual drift", () => {
    const oldParent = { ...createNode("frame", 100, 50), id: "old", width: 300, height: 200, rotation: 30 };
    const child = { ...createNode("rectangle", 40, 20), id: "child", parentId: oldParent.id, width: 80, height: 40, rotation: -15 };
    const newParent = { ...createNode("frame", -120, 80), id: "new", width: 240, height: 160, rotation: -25 };
    const desired = worldTransformForNode([oldParent, child, newParent], child.id)!;
    const local = nodePropsForWorldTransform(desired, worldTransformForNode([oldParent, child, newParent], newParent.id), child.width, child.height)!;
    const reparented = { ...child, parentId: newParent.id, ...local };
    const actual = worldTransformForNode([oldParent, newParent, reparented], reparented.id)!;

    for (const point of [{ x: 0, y: 0 }, { x: child.width, y: child.height }]) {
      const projected = transformPoint(actual, point);
      const expected = transformPoint(desired, point);
      expect(projected.x).toBeCloseTo(expected.x, 10);
      expect(projected.y).toBeCloseTo(expected.y, 10);
    }
  });

  it("rejects singular parent transforms and hierarchy cycles", () => {
    expect(invertAffine({ ...IDENTITY_AFFINE, a: 0, d: 0 })).toBeUndefined();
    const first = { ...createNode("frame", 0, 0), id: "first", parentId: "second" };
    const second = { ...createNode("frame", 0, 0), id: "second", parentId: "first" };
    expect(worldTransformForNode([first, second], first.id)).toBeUndefined();
  });
});
