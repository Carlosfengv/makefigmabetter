import { describe, expect, it } from "vitest";
import { ellipseStrokeRing } from "./ellipse-stroke-ring";

describe("ellipseStrokeRing", () => {
  it("resolves Inside and Outside paint rings from the same ellipse geometry", () => {
    expect(ellipseStrokeRing(100, 60, 8, "inside")).toEqual({ outerRx: 50, outerRy: 30, innerRx: 42, innerRy: 22 });
    expect(ellipseStrokeRing(100, 60, 8, "outside")).toEqual({ outerRx: 58, outerRy: 38, innerRx: 50, innerRy: 30 });
  });

  it("caps an oversized Inside Stroke and leaves Center to the native outline", () => {
    expect(ellipseStrokeRing(100, 20, 40, "inside")).toEqual({ outerRx: 50, outerRy: 10 });
    expect(ellipseStrokeRing(100, 20, 8, "center")).toBeUndefined();
  });
});
