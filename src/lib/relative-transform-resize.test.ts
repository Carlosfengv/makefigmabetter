import { describe, expect, it } from "vitest";
import { resizeRelativeTransformFromWorldGesture } from "./relative-transform-resize";

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

describe("relative transform resize", () => {
  it("moves a leading corner through the node's local transform", () => {
    const resized = resizeRelativeTransformFromWorldGesture(
      { width: 100, height: 60, relativeTransform: identity },
      identity,
      "nw",
      { x: 0, y: 0 },
      { x: 20, y: 10 },
    );
    expect(resized).toEqual({ width: 80, height: 50, relativeTransform: { ...identity, e: 20, f: 10 } });
  });

  it("uses world inverse so a rotated node still resizes in its local axes", () => {
    const rotate90 = { a: 0, b: 1, c: -1, d: 0, e: 100, f: 200 };
    const resized = resizeRelativeTransformFromWorldGesture(
      { width: 100, height: 60, relativeTransform: rotate90 },
      rotate90,
      "w",
      { x: 100, y: 200 },
      { x: 100, y: 220 },
    );
    expect(resized).toEqual({ width: 80, height: 60, relativeTransform: { ...rotate90, e: 100, f: 220 } });
  });

  it("keeps the initial aspect ratio for a shifted corner gesture", () => {
    const resized = resizeRelativeTransformFromWorldGesture(
      { width: 100, height: 60, relativeTransform: identity },
      identity,
      "se",
      { x: 100, y: 60 },
      { x: 120, y: 60 },
      true,
    );
    expect(resized).toEqual({ width: 120, height: 72, relativeTransform: identity });
  });

  it("keeps the visual centre fixed for an Alt/Option gesture", () => {
    const resized = resizeRelativeTransformFromWorldGesture(
      { width: 100, height: 60, relativeTransform: identity },
      identity,
      "se",
      { x: 100, y: 60 },
      { x: 120, y: 70 },
      false,
      true,
    );
    expect(resized).toEqual({ width: 140, height: 80, relativeTransform: { ...identity, e: -20, f: -10 } });
  });
});
