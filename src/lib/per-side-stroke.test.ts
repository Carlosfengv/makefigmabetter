import { describe, expect, it } from "vitest";
import { perSideStrokeCenters } from "./per-side-stroke";

describe("perSideStrokeCenters", () => {
  const weights: [number, number, number, number] = [4, 12, 16, 8];

  it("keeps all of an Inside edge weight inside its shape", () => {
    expect(perSideStrokeCenters(100, 80, weights, "inside")).toEqual({
      topY: 2, rightX: 94, bottomY: 72, leftX: 4,
    });
  });

  it("keeps Center and Outside edge centers at their Figma alignment positions", () => {
    expect(perSideStrokeCenters(100, 80, weights, "center")).toEqual({
      topY: 0, rightX: 100, bottomY: 80, leftX: 0,
    });
    expect(perSideStrokeCenters(100, 80, weights, "outside")).toEqual({
      topY: -2, rightX: 106, bottomY: 88, leftX: -4,
    });
  });
});
