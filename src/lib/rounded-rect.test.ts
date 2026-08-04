import { describe, expect, it } from "vitest";
import { resolveInsideRoundedRect } from "./rounded-rect";

describe("inside rounded-rectangle geometry", () => {
  it("keeps the outer radius and stroke within resized bounds", () => {
    expect(resolveInsideRoundedRect(40, 30, 50, 10)).toEqual({
      outerRadius: 15, insideStrokeWidth: 10,
      innerX: 10, innerY: 10, innerWidth: 20, innerHeight: 10, innerRadius: 5,
    });
  });

  it("collapses an over-wide stroke to the available inside geometry without negative dimensions", () => {
    expect(resolveInsideRoundedRect(12, 8, 9, 20)).toEqual({
      outerRadius: 4, insideStrokeWidth: 4,
      innerX: 4, innerY: 4, innerWidth: 4, innerHeight: 0, innerRadius: 0,
    });
  });

  it("rejects non-finite geometry at the rendering boundary", () => {
    expect(resolveInsideRoundedRect(Number.NaN, 20, Number.POSITIVE_INFINITY, 2)).toEqual({
      outerRadius: 0, insideStrokeWidth: 0,
      innerX: 0, innerY: 0, innerWidth: 0, innerHeight: 20, innerRadius: 0,
    });
  });
});
