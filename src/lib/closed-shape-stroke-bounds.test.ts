import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { closedShapeStrokeLocalBounds } from "./closed-shape-stroke-bounds";

describe("closedShapeStrokeLocalBounds", () => {
  it("expands complete Ellipse and rectangular shapes by their visual Stroke", () => {
    const ellipse = { ...createNode("ellipse", 0, 0), width: 100, height: 60, strokeWidth: 8, strokeAlign: "outside" as const };
    expect(closedShapeStrokeLocalBounds(ellipse)).toEqual({ x: -8, y: -8, width: 116, height: 76 });
    const rectangle = {
      ...createNode("rectangle", 0, 0), width: 100, height: 60, strokeWidth: 8, strokeAlign: "center" as const,
      strokeWeights: [4, 8, 12, 16] as [number, number, number, number],
    };
    expect(closedShapeStrokeLocalBounds(rectangle)).toEqual({ x: -8, y: -2, width: 112, height: 68 });
  });

  it("keeps inside and Arc/Donut paint at geometric bounds", () => {
    const inside = { ...createNode("frame", 0, 0), strokeWidth: 8, strokeAlign: "inside" as const };
    expect(closedShapeStrokeLocalBounds(inside)).toBeUndefined();
    expect(closedShapeStrokeLocalBounds({ ...inside, strokeAlign: undefined })).toBeUndefined();
    const arc = { ...createNode("ellipse", 0, 0), strokeWidth: 8, strokeAlign: "outside" as const, arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } };
    expect(closedShapeStrokeLocalBounds(arc)).toBeUndefined();
  });
});
