import { describe, expect, it } from "vitest";
import { ellipseArcUpdatePatch } from "./ellipse-arc";

describe("ellipseArcUpdatePatch", () => {
  it("resets an aligned full Ellipse to Inside atomically when creating an Arc", () => {
    expect(ellipseArcUpdatePatch({ strokeAlign: "outside" }, { endingAngle: 180 })).toEqual({
      arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 },
      strokeAlign: "inside",
    });
  });

  it("preserves the supported Inside alignment for an existing Arc", () => {
    expect(ellipseArcUpdatePatch({ strokeAlign: "inside", arcData: { startingAngle: 30, endingAngle: 270, innerRadius: .4 } }, { innerRadius: .5 })).toEqual({
      arcData: { startingAngle: 30, endingAngle: 270, innerRadius: .5 },
    });
  });
});
