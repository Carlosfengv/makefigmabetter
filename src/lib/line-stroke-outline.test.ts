import { describe, expect, it } from "vitest";
import { solidLineStrokeOutline, solidLineStrokeOutlinePath } from "./line-stroke-outline";

describe("independent Line cap outline", () => {
  it("keeps the body butt-ended while adding only a requested round end", () => {
    expect(solidLineStrokeOutline(100, 10, "none", "round")).toEqual([
      { kind: "rect", x: 0, y: -5, width: 100, height: 10 },
      { kind: "circle", x: 100, y: 0, radius: 5 },
    ]);
  });

  it("extends only the square endpoint that requests it", () => {
    expect(solidLineStrokeOutline(100, 8, "square", "none")).toEqual([
      { kind: "rect", x: 0, y: -4, width: 100, height: 8 },
      { kind: "rect", x: -4, y: -4, width: 4, height: 8 },
    ]);
  });

  it("leaves marker caps to their dedicated endpoint renderer", () => {
    expect(solidLineStrokeOutline(100, 8, "arrowLines", "triangleFilled")).toEqual([
      { kind: "rect", x: 0, y: -4, width: 100, height: 8 },
    ]);
  });

  it("serializes the Canvas outline model as one SVG filled union", () => {
    expect(solidLineStrokeOutlinePath(100, 10, "square", "round")).toBe(
      "M 0 -5 H 100 V 5 H 0 Z M -5 -5 H 0 V 5 H -5 Z M 95 0 A 5 5 0 1 0 105 0 A 5 5 0 1 0 95 0 Z",
    );
  });
});
