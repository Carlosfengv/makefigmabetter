import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { cornerRadiusSelection, resolvedCornerRadii } from "./corner-radius-selection";

describe("multi-selection corner radii", () => {
  it("treats a uniform radius and identical explicit radii as the same values", () => {
    const uniform = { ...createNode("rectangle", 0, 0), radius: 12 };
    const explicit = { ...createNode("section", 10, 0), radius: 0, cornerRadii: [12, 12, 12, 12] as [number, number, number, number] };

    expect(cornerRadiusSelection([uniform, explicit])).toEqual({
      topLeft: { kind: "same", value: 12 }, topRight: { kind: "same", value: 12 },
      bottomRight: { kind: "same", value: 12 }, bottomLeft: { kind: "same", value: 12 }, hasExplicitRadii: true,
    });
  });

  it("keeps every corner independent and rejects an inapplicable node", () => {
    const first = { ...createNode("frame", 0, 0), cornerRadii: [1, 2, 3, 4] as [number, number, number, number] };
    const second = { ...createNode("rectangle", 10, 0), cornerRadii: [1, 8, 3, 4] as [number, number, number, number] };

    expect(cornerRadiusSelection([first, second])?.topRight).toEqual({ kind: "mixed" });
    expect(cornerRadiusSelection([first, createNode("ellipse", 0, 0)])).toBeUndefined();
    expect(resolvedCornerRadii({ radius: 5 })).toEqual([5, 5, 5, 5]);
  });
});
