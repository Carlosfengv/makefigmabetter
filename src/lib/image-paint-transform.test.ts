import { describe, expect, it } from "vitest";
import {
  imagePaintLayoutBox,
  resolvedImagePaintTransform,
} from "./image-paint-transform";
import { transformPoint } from "./scene-transform";

const image = {
  assetId: "asset",
  scaleMode: "fill" as const,
  transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
};

describe("image paint transform", () => {
  it("applies quarter-turn rotation around the node-local centre", () => {
    const transform = resolvedImagePaintTransform({ ...image, rotationDegrees: 90 }, 100, 50)!;
    expect(transformPoint(transform, { x: 50, y: 25 })).toEqual({ x: 50, y: 25 });
    expect(transformPoint(transform, { x: 0, y: 0 })).toEqual({ x: 75, y: -25 });
    expect(imagePaintLayoutBox({ ...image, rotationDegrees: 90 }, 100, 50)).toEqual({
      x: 25,
      y: -25,
      width: 50,
      height: 100,
    });
    expect(imagePaintLayoutBox({ ...image, rotationDegrees: 180 }, 100, 50)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it("rejects non-quarter-turn and Crop rotation", () => {
    expect(resolvedImagePaintTransform({ ...image, rotationDegrees: 45 as never }, 100, 50)).toBeUndefined();
    expect(resolvedImagePaintTransform({ ...image, scaleMode: "crop", rotationDegrees: 90 }, 100, 50)).toBeUndefined();
  });
});
