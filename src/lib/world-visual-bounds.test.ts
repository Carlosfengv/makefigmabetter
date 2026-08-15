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

  it("includes a visible Drop Shadow in the culling and export envelope", () => {
    const rectangle = {
      ...createNode("rectangle", 10, 20), id: "shadow", width: 100, height: 60,
      dropShadow: { offsetX: 8, offsetY: 12, blurRadius: 10, spread: 2, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true },
    };
    expect(worldVisualBoundsForNode([rectangle], rectangle)).toEqual({ left: 6, top: 20, right: 130, bottom: 104 });
  });

  it("unions every visible Effect Stack shadow into the culling envelope", () => {
    const first = { offsetX: 8, offsetY: 12, blurRadius: 10, spread: 2, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true };
    const second = { offsetX: -30, offsetY: -10, blurRadius: 4, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true };
    const rectangle = { ...createNode("rectangle", 10, 20), id: "stack", width: 100, height: 60, dropShadow: first, effectStack: [{ dropShadow: first }, { dropShadow: second }] };

    expect(worldVisualBoundsForNode([rectangle], rectangle)).toEqual({ left: -24, top: 6, right: 130, bottom: 104 });
  });
});
