import { describe, expect, it } from "vitest";
import { compositeLinearBlendRgba, linearBlendChannel } from "./linear-blend-composite";

describe("linear blend compositing", () => {
  it("freezes the bounded Linear Dodge and Linear Burn channel formulas", () => {
    expect(linearBlendChannel(.7, .6, "linear-dodge")).toBe(1);
    expect(linearBlendChannel(.2, .3, "linear-dodge")).toBe(.5);
    expect(linearBlendChannel(.7, .6, "linear-burn")).toBeCloseTo(.3);
    expect(linearBlendChannel(.2, .3, "linear-burn")).toBe(0);
  });

  it("composites opaque pixels without delegating to a browser blend alias", () => {
    const dodge = new Uint8ClampedArray([204, 102, 26, 255]);
    compositeLinearBlendRgba(dodge, new Uint8ClampedArray([102, 179, 230, 255]), "linear-dodge");
    expect([...dodge]).toEqual([255, 255, 255, 255]);

    const burn = new Uint8ClampedArray([204, 102, 26, 255]);
    compositeLinearBlendRgba(burn, new Uint8ClampedArray([102, 179, 230, 255]), "linear-burn");
    expect([...burn]).toEqual([51, 26, 1, 255]);
  });

  it("uses source-over alpha instead of Canvas lighter alpha", () => {
    const result = new Uint8ClampedArray([204, 51, 102, 128]);
    compositeLinearBlendRgba(
      result,
      new Uint8ClampedArray([102, 204, 51, 128]),
      "linear-dodge",
      .5,
    );
    // Independent source-over calculation: alpha≈.627 and RGB≈(.761,.48,.40).
    expect([...result]).toEqual([194, 122, 102, 160]);
  });

  it("validates buffer shape and opacity", () => {
    expect(() => compositeLinearBlendRgba(
      new Uint8ClampedArray(4),
      new Uint8ClampedArray(8),
      "linear-burn",
    )).toThrow(RangeError);
    expect(() => compositeLinearBlendRgba(
      new Uint8ClampedArray(4),
      new Uint8ClampedArray(4),
      "linear-burn",
      2,
    )).toThrow(RangeError);
  });
});
