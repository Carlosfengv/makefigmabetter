import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { worldLineVisualBounds } from "./line-world-bounds";

describe("Line world visual bounds", () => {
  it("includes stroke thickness and round caps for a rotated Legacy line", () => {
    const line = { ...createNode("line", 10, 20), id: "line", width: 100, height: 0, rotation: 90, strokeWidth: 10, strokeCapStart: "round" as const, strokeCapEnd: "round" as const };
    const bounds = worldLineVisualBounds([line], line)!;
    expect(bounds.left).toBeCloseTo(5);
    expect(bounds.top).toBeCloseTo(15);
    expect(bounds.right).toBeCloseTo(15);
    expect(bounds.bottom).toBeCloseTo(125);
  });

  it("transforms the complete marker envelope through an explicit skew matrix", () => {
    const line = {
      ...createNode("line", 0, 0), id: "line", width: 40, height: 0, strokeWidth: 4,
      strokeCapEnd: "arrowEquilateral" as const,
      relativeTransform: { a: 1, b: 0, c: .5, d: 1, e: 10, f: 20 },
    };
    expect(worldLineVisualBounds([line], line)).toEqual({ left: 6, top: 12, right: 54, bottom: 28 });
  });
});
