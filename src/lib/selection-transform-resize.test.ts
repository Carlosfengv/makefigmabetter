import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { transformPoint, worldTransformForNode } from "./scene-transform";
import { hasCommittedSelectionTransform, scaleSelectionTransforms } from "./selection-transform-resize";

describe("affine multi-selection resize", () => {
  it("scales a rotated Legacy leaf exactly in world space", () => {
    const node = { ...createNode("rectangle", 20, 10), id: "rotated", width: 40, height: 20, rotation: 30 };
    const before = { x: 0, y: 0, width: 100, height: 100 };
    const after = { x: 0, y: 0, width: 200, height: 50 };
    const patches = scaleSelectionTransforms([node], [node.id], before, after)!;
    const resized = { ...node, ...patches.get(node.id)! };
    const oldWorld = worldTransformForNode([node], node.id)!;
    const nextWorld = worldTransformForNode([resized], resized.id)!;
    for (const point of [{ x: 0, y: 0 }, { x: node.width, y: node.height }]) {
      const oldPoint = transformPoint(oldWorld, point);
      const nextPoint = transformPoint(nextWorld, point);
      expect(nextPoint.x).toBeCloseTo(oldPoint.x * 2, 10);
      expect(nextPoint.y).toBeCloseTo(oldPoint.y * .5, 10);
    }
    expect(resized.relativeTransform).toBeDefined();
  });

  it("does not migrate an unchanged Legacy selection", () => {
    const node = { ...createNode("rectangle", 20, 10), id: "legacy", width: 40, height: 20 };
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const patches = scaleSelectionTransforms([node], [node.id], bounds, bounds)!;
    expect(patches.get(node.id)?.relativeTransform).toBeUndefined();
    expect(hasCommittedSelectionTransform([node], patches)).toBe(false);
  });

  it("scales a rotated Line through its matrix instead of flattening its endpoint geometry", () => {
    const line = { ...createNode("line", 10, 20), id: "line", width: 100, height: 0, rotation: 45 };
    const patches = scaleSelectionTransforms([line], [line.id], { x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 200, height: 50 })!;
    const resized = { ...line, ...patches.get(line.id)! };
    const oldWorld = worldTransformForNode([line], line.id)!;
    const nextWorld = worldTransformForNode([resized], resized.id)!;
    for (const point of [{ x: 0, y: 0 }, { x: line.width, y: 0 }]) {
      const oldPoint = transformPoint(oldWorld, point);
      const nextPoint = transformPoint(nextWorld, point);
      expect(nextPoint.x).toBeCloseTo(oldPoint.x * 2, 10);
      expect(nextPoint.y).toBeCloseTo(oldPoint.y * .5, 10);
    }
  });

  it("updates matrix Frame geometry while retaining the exact world-space selection scale", () => {
    const frame = { ...createNode("frame", 20, 10), id: "frame", width: 100, height: 60, rotation: 30 };
    const patches = scaleSelectionTransforms([frame], [frame.id], { x: 0, y: 0, width: 200, height: 100 }, { x: 0, y: 0, width: 300, height: 50 })!;
    const resized = { ...frame, ...patches.get(frame.id)! };
    const oldWorld = worldTransformForNode([frame], frame.id)!;
    const nextWorld = worldTransformForNode([resized], resized.id)!;
    expect(resized.width).toBe(150);
    expect(resized.height).toBe(30);
    for (const point of [{ x: 0, y: 0 }, { x: frame.width, y: frame.height }]) {
      const oldPoint = transformPoint(oldWorld, point);
      const nextPoint = transformPoint(nextWorld, { x: point.x * 1.5, y: point.y * .5 });
      expect(nextPoint.x).toBeCloseTo(oldPoint.x * 1.5, 10);
      expect(nextPoint.y).toBeCloseTo(oldPoint.y * .5, 10);
    }
  });

  it("maps selected Frame descendants through the Frame's compensated post-resize matrix", () => {
    const frame = {
      ...createNode("frame", 0, 0), id: "frame", width: 100, height: 60,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    };
    const child = {
      ...createNode("rectangle", 0, 0), id: "child", parentId: frame.id, width: 30, height: 20,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 10 },
    };
    const before = { x: 0, y: 0, width: 100, height: 60 };
    const after = { x: 0, y: 0, width: 200, height: 120 };
    // Deliberately reverse the input order: implementation must still apply
    // the parent before its descendant.
    const patches = scaleSelectionTransforms([frame, child], [child.id, frame.id], before, after)!;
    const resizedFrame = { ...frame, ...patches.get(frame.id)! };
    const resizedChild = { ...child, ...patches.get(child.id)! };
    const oldWorld = worldTransformForNode([frame, child], child.id)!;
    const nextWorld = worldTransformForNode([resizedFrame, resizedChild], child.id)!;

    expect(resizedFrame).toMatchObject({ width: 200, height: 120 });
    for (const point of [{ x: 0, y: 0 }, { x: child.width, y: child.height }]) {
      const oldPoint = transformPoint(oldWorld, point);
      const nextPoint = transformPoint(nextWorld, point);
      expect(nextPoint.x).toBeCloseTo(oldPoint.x * 2, 10);
      expect(nextPoint.y).toBeCloseTo(oldPoint.y * 2, 10);
    }
  });

  it("reflects an affine selection with positive Frame geometry", () => {
    const frame = { ...createNode("frame", 0, 0), id: "frame", width: 100, height: 60, rotation: 20 };
    const patches = scaleSelectionTransforms([frame], [frame.id], { x: 0, y: 0, width: 100, height: 60 }, { x: 0, y: 0, width: 100, height: 60, flipX: true })!;
    const resized = { ...frame, ...patches.get(frame.id)! };
    const oldWorld = worldTransformForNode([frame], frame.id)!;
    const nextWorld = worldTransformForNode([resized], resized.id)!;
    expect(resized.width).toBe(100);
    expect(resized.height).toBe(60);
    for (const point of [{ x: 0, y: 0 }, { x: frame.width, y: frame.height }]) {
      const oldPoint = transformPoint(oldWorld, point);
      const nextPoint = transformPoint(nextWorld, point);
      expect(nextPoint.x).toBeCloseTo(100 - oldPoint.x, 10);
      expect(nextPoint.y).toBeCloseTo(oldPoint.y, 10);
    }
  });
});
