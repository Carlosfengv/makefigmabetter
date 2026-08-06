import { describe, expect, it } from "vitest";
import { hasCommittedResize, resizeGeometryFromCenter, resizeGeometryFromCorner, resizeGeometryFromCornerWithFlip, resizeRotatedLegacyGeometry } from "./canvas-resize";

describe("canvas corner resize", () => {
  const geometry = { x: 10, y: 20, width: 100, height: 60 };

  it("keeps the opposite corner fixed for every handle", () => {
    expect(resizeGeometryFromCorner(geometry, "se", { x: 20, y: 10 })).toEqual({ x: 10, y: 20, width: 120, height: 70 });
    expect(resizeGeometryFromCorner(geometry, "nw", { x: 20, y: 10 })).toEqual({ x: 30, y: 30, width: 80, height: 50 });
    expect(resizeGeometryFromCorner(geometry, "ne", { x: 20, y: 10 })).toEqual({ x: 10, y: 30, width: 120, height: 50 });
    expect(resizeGeometryFromCorner(geometry, "sw", { x: 20, y: 10 })).toEqual({ x: 30, y: 20, width: 80, height: 70 });
  });

  it("resizes a single axis from each side handle", () => {
    expect(resizeGeometryFromCorner(geometry, "e", { x: 20, y: 10 })).toEqual({ x: 10, y: 20, width: 120, height: 60 });
    expect(resizeGeometryFromCorner(geometry, "n", { x: 20, y: 10 })).toEqual({ x: 10, y: 30, width: 100, height: 50 });
    expect(resizeGeometryFromCorner(geometry, "w", { x: 20, y: 10 })).toEqual({ x: 30, y: 20, width: 80, height: 60 });
    expect(resizeGeometryFromCorner(geometry, "s", { x: 20, y: 10 })).toEqual({ x: 10, y: 20, width: 100, height: 70 });
  });

  it("prevents a corner from crossing its fixed opposite corner", () => {
    expect(resizeGeometryFromCorner(geometry, "nw", { x: 300, y: 300 })).toEqual({ x: 106, y: 76, width: 4, height: 4 });
  });

  it("keeps positive dimensions and returns a horizontal reflection after crossing an opposite edge", () => {
    expect(resizeGeometryFromCornerWithFlip(geometry, "e", { x: -140, y: 0 })).toEqual({
      x: -30, y: 20, width: 40, height: 60,
      flipX: true, flipY: false,
      localTransform: { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    });
    expect(resizeGeometryFromCornerWithFlip(geometry, "w", { x: 140, y: 0 })).toEqual({
      x: 110, y: 20, width: 40, height: 60,
      flipX: true, flipY: false,
      localTransform: { a: -1, b: 0, c: 0, d: 1, e: 140, f: 0 },
    });
  });

  it("can reflect both local axes from a crossed corner while retaining a finite minimum size", () => {
    expect(resizeGeometryFromCornerWithFlip(geometry, "se", { x: -140, y: -100 })).toEqual({
      x: -30, y: -20, width: 40, height: 40,
      flipX: true, flipY: true,
      localTransform: { a: -1, b: 0, c: 0, d: -1, e: 0, f: 0 },
    });
    const clamped = resizeGeometryFromCornerWithFlip(geometry, "e", { x: -102, y: 0 });
    expect(clamped).toMatchObject({ width: 4, flipX: true });
    expect(Number.isFinite(clamped.localTransform.e)).toBe(true);
  });

  it("keeps the starting aspect ratio when requested", () => {
    expect(resizeGeometryFromCorner(geometry, "nw", { x: 20, y: 0 }, 4, true)).toEqual({ x: 30, y: 32, width: 80, height: 48 });
  });

  it("keeps the centre fixed for an Alt/Option resize", () => {
    expect(resizeGeometryFromCenter(geometry, "se", { x: 20, y: 10 })).toEqual({ x: -10, y: 10, width: 140, height: 80 });
    expect(resizeGeometryFromCenter(geometry, "n", { x: 20, y: 10 })).toEqual({ x: 10, y: 30, width: 100, height: 40 });
  });

  it("uses the rotated local axes and moves the local origin back to world space", () => {
    const resized = resizeRotatedLegacyGeometry({ ...geometry, rotation: 90 }, "nw", { x: 0, y: 0 }, { x: 0, y: 20 });
    expect(resized.x).toBeCloseTo(10);
    expect(resized.y).toBeCloseTo(40);
    expect(resized.width).toBe(80);
    expect(resized.height).toBe(60);
  });

  it("does not mint a document update for a zero-distance gesture", () => {
    expect(hasCommittedResize(geometry, geometry)).toBe(false);
    expect(hasCommittedResize(geometry, { ...geometry, width: 101 })).toBe(true);
  });
});
