import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { worldVisualBoundsForNode } from "./world-visual-bounds";

describe("worldVisualBoundsForNode", () => {
  it("expands full Ellipse bounds for Center and Outside Stroke", () => {
    const ellipse = { ...createNode("ellipse", 10, 20), id: "ellipse", width: 100, height: 60, strokeWidth: 8, strokeAlign: "outside" as const };
    expect(worldVisualBoundsForNode([ellipse], ellipse)).toEqual({ left: 2, top: 12, right: 118, bottom: 88 });
    const center = { ...ellipse, strokeAlign: "center" as const };
    expect(worldVisualBoundsForNode([center], center)).toEqual({ left: 6, top: 16, right: 114, bottom: 84 });
  });

  it("keeps Inside and Arc Ellipse bounds at their geometric envelope", () => {
    const ellipse = { ...createNode("ellipse", 10, 20), id: "ellipse", width: 100, height: 60, strokeWidth: 8, strokeAlign: "inside" as const };
    expect(worldVisualBoundsForNode([ellipse], ellipse)).toEqual({ left: 10, top: 20, right: 110, bottom: 80 });
    const arc = { ...ellipse, strokeAlign: "outside" as const, arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } };
    expect(worldVisualBoundsForNode([arc], arc)).toEqual({ left: 10, top: 20, right: 110, bottom: 80 });
  });

  it("expands Frame and Rectangle bounds by their aligned per-side Stroke", () => {
    const rectangle = {
      ...createNode("rectangle", 10, 20), id: "rectangle", width: 100, height: 60,
      strokeWidth: 8, strokeAlign: "outside" as const, strokeWeights: [4, 8, 12, 16],
    };
    expect(worldVisualBoundsForNode([rectangle], rectangle)).toEqual({ left: -6, top: 16, right: 118, bottom: 92 });
    const center = { ...rectangle, strokeAlign: "center" as const };
    expect(worldVisualBoundsForNode([center], center)).toEqual({ left: 2, top: 18, right: 114, bottom: 86 });
    const frame = { ...rectangle, id: "frame", kind: "frame" as const, strokeWeights: undefined };
    expect(worldVisualBoundsForNode([frame], frame)).toEqual({ left: 2, top: 12, right: 118, bottom: 88 });
  });
});
