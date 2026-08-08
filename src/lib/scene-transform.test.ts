import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { IDENTITY_AFFINE, invertAffine, multiplyAffine, nodePropsForWorldTransform, normalizeGroupBounds, transformPoint, translateNodeWorldPatch, worldBoundsForNode, worldSpaceProjectionNode, worldTransformForNode } from "./scene-transform";

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

describe("translateNodeWorldPatch", () => {
  it("moves a legacy node by adding the delta to its world x/y", () => {
    const node = { ...createNode("rectangle", 20, 30), id: "legacy", width: 80, height: 40 };
    const patch = translateNodeWorldPatch([node], node.id, 15, -5)!;
    expect(patch).toMatchObject({ x: 35, y: 25, relativeTransform: undefined });
  });

  it("moves a Relative-v1 node so its derived world position actually shifts", () => {
    // A grouped child derives its rendered position from relativeTransform and
    // ignores x/y, so only a new relativeTransform can move it.
    const group = { ...createNode("group", 40, 20), id: "group", width: 120, height: 80, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 40, f: 20 } };
    const child = { ...createNode("rectangle", 999, 999), id: "child", parentId: group.id, width: 60, height: 30, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 12 } };
    const before = transformPoint(worldTransformForNode([group, child], child.id)!, { x: 0, y: 0 });
    const patch = translateNodeWorldPatch([group, child], child.id, 25, 40)!;
    expect(patch.relativeTransform).toBeDefined();
    const moved = { ...child, ...patch };
    const after = transformPoint(worldTransformForNode([group, moved], moved.id)!, { x: 0, y: 0 });
    expect(after.x).toBeCloseTo(before.x + 25, 10);
    expect(after.y).toBeCloseTo(before.y + 40, 10);
  });

  it("preserves rotation and scale of a rotated relative node under translation", () => {
    const child = { ...createNode("rectangle", 0, 0), id: "child", width: 80, height: 40, relativeTransform: { a: 0, b: 2, c: -3, d: 0, e: 100, f: 50 } };
    const patch = translateNodeWorldPatch([child], child.id, 10, 20)!;
    const moved = { ...child, ...patch };
    const before = worldSpaceProjectionNode([child], child)!;
    const after = worldSpaceProjectionNode([moved], moved)!;
    expect(after.rotation).toBeCloseTo(before.rotation, 10);
    expect(after.width).toBeCloseTo(before.width, 10);
    expect(after.height).toBeCloseTo(before.height, 10);
  });

  it("applies the caller's snap to the resulting world origin for both models", () => {
    const round = (point: { x: number; y: number }) => ({ x: Math.round(point.x), y: Math.round(point.y) });
    const legacy = { ...createNode("rectangle", 0, 0), id: "legacy", width: 10, height: 10 };
    expect(translateNodeWorldPatch([legacy], legacy.id, 2.4, 3.6, round)).toMatchObject({ x: 2, y: 4 });
    const relative = { ...createNode("rectangle", 0, 0), id: "relative", width: 10, height: 10, relativeTransform: { ...IDENTITY_AFFINE, e: 5, f: 5 } };
    const patch = translateNodeWorldPatch([relative], relative.id, 1.6, 1.6, round)!;
    expect(transformPoint(worldTransformForNode([{ ...relative, ...patch }], relative.id)!, { x: 0, y: 0 })).toEqual({ x: 7, y: 7 });
  });

  it("returns nothing for a missing node", () => {
    expect(translateNodeWorldPatch([], "absent", 1, 1)).toBeUndefined();
  });
});

describe("normalizeGroupBounds", () => {
  it("fits a Group to a moved child without moving either child in world space", () => {
    const group = { ...createNode("group", 100, 50), id: "group", width: 200, height: 120, relativeTransform: { ...IDENTITY_AFFINE, e: 100, f: 50 } };
    const first = { ...createNode("rectangle", 0, 0), id: "first", parentId: group.id, width: 40, height: 20, relativeTransform: { ...IDENTITY_AFFINE, e: 30, f: 25 } };
    const second = { ...createNode("rectangle", 0, 0), id: "second", parentId: group.id, width: 30, height: 30, relativeTransform: { ...IDENTITY_AFFINE, e: 110, f: 75 } };
    const movedFirst = { ...first, relativeTransform: { ...first.relativeTransform!, e: 10, f: 5 } };
    const before = [movedFirst, second].map((node) => worldTransformForNode([group, movedFirst, second], node.id)!);
    const normalized = normalizeGroupBounds([group, movedFirst, second])!;
    const normalizedGroup = normalized.find((node) => node.id === group.id)!;

    expect(normalizedGroup).toMatchObject({ width: 130, height: 100 });
    for (const [index, node] of [movedFirst, second].entries()) {
      const after = worldTransformForNode(normalized, node.id)!;
      for (const point of [{ x: 0, y: 0 }, { x: node.width, y: node.height }]) {
        expect(transformPoint(after, point)).toEqual(transformPoint(before[index], point));
      }
    }
  });

  it("normalizes inner Groups before their parent while preserving leaf world transforms", () => {
    const outer = { ...createNode("group", 0, 0), id: "outer", width: 500, height: 500, relativeTransform: { ...IDENTITY_AFFINE } };
    const inner = { ...createNode("group", 0, 0), id: "inner", parentId: outer.id, width: 200, height: 200, relativeTransform: { ...IDENTITY_AFFINE, e: 80, f: 60 } };
    const leaf = { ...createNode("rectangle", 0, 0), id: "leaf", parentId: inner.id, width: 20, height: 30, relativeTransform: { ...IDENTITY_AFFINE, e: 40, f: 25 } };
    const before = worldTransformForNode([outer, inner, leaf], leaf.id)!;
    const normalized = normalizeGroupBounds([outer, inner, leaf])!;
    const after = worldTransformForNode(normalized, leaf.id)!;

    expect(transformPoint(after, { x: 0, y: 0 })).toEqual(transformPoint(before, { x: 0, y: 0 }));
    expect(normalized.find((node) => node.id === inner.id)).toMatchObject({ width: 20, height: 30 });
    expect(normalized.find((node) => node.id === outer.id)).toMatchObject({ width: 20, height: 30 });
  });

  it("uses the pointer-down scene for each child-drag frame instead of compounding prior rebases", () => {
    const group = { ...createNode("group", 0, 0), id: "group", width: 160, height: 80, relativeTransform: { ...IDENTITY_AFFINE } };
    const child = { ...createNode("rectangle", 0, 0), id: "child", parentId: group.id, width: 40, height: 20, relativeTransform: { ...IDENTITY_AFFINE, e: 20, f: 20 } };
    const sibling = { ...createNode("rectangle", 0, 0), id: "sibling", parentId: group.id, width: 30, height: 20, relativeTransform: { ...IDENTITY_AFFINE, e: 100, f: 40 } };
    const before = [group, child, sibling];
    const secondFramePatch = translateNodeWorldPatch(before, child.id, 80, 20)!;
    const secondFrame = normalizeGroupBounds(before.map((node) => node.id === child.id ? { ...node, ...secondFramePatch } : node))!;
    const movedChild = secondFrame.find((node) => node.id === child.id)!;
    const origin = transformPoint(worldTransformForNode(secondFrame, child.id)!, { x: 0, y: 0 });

    expect(origin).toEqual({ x: 100, y: 40 });
    expect(movedChild.relativeTransform).toBeDefined();
  });
});
