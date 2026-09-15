import { describe, expect, it } from "vitest";
import { createNode, type CanvasNode } from "./editor-protocol";
import { constraintGuidesForNode } from "./constraint-guides";

function fixture(): CanvasNode[] {
  const frame = { ...createNode("frame", 100, 50), id: "frame", width: 400, height: 300 };
  const child = {
    ...createNode("rectangle", 40, 30),
    id: "child",
    parentId: frame.id,
    width: 100,
    height: 60,
    relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 40, f: 30 },
    constraints: { horizontal: "stretch" as const, vertical: "center" as const },
  };
  return [frame, child];
}

describe("constraint canvas guides", () => {
  it("draws two horizontal Stretch spans and one vertical Center span", () => {
    const nodes = fixture();
    const guides = constraintGuidesForNode(nodes, nodes[1]);
    expect(guides.map(({ axis, role }) => `${axis}:${role}`)).toEqual([
      "horizontal:min",
      "horizontal:max",
      "vertical:center",
    ]);
    expect(guides[0].start).toEqual({ x: 100, y: 110 });
    expect(guides[0].end).toEqual({ x: 140, y: 110 });
  });

  it("treats absent constraints as the canonical Left/Top default", () => {
    const nodes = fixture();
    delete nodes[1].constraints;
    expect(constraintGuidesForNode(nodes, nodes[1]).map(({ role }) => role)).toEqual(["min", "min"]);
  });

  it("does not expose guides outside an applicable Frame scope", () => {
    const root = createNode("rectangle", 0, 0);
    expect(constraintGuidesForNode([root], root)).toEqual([]);
  });
});
