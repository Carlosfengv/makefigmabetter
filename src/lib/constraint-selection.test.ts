import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { constraintSelection } from "./constraint-selection";

describe("multi-selection constraints", () => {
  it("keeps omitted constraints distinct from explicit Min", () => {
    const legacy = createNode("rectangle", 0, 0);
    const explicit = { ...createNode("ellipse", 10, 0), constraints: { horizontal: "min" as const, vertical: "center" as const } };

    expect(constraintSelection([legacy, explicit])).toEqual({
      horizontal: { kind: "mixed" }, vertical: { kind: "mixed" }, hasExplicitConstraints: true,
    });
  });

  it("accepts drawable kinds and rejects Group/Section", () => {
    const first = { ...createNode("line", 0, 0), constraints: { horizontal: "stretch" as const, vertical: "scale" as const } };
    const second = { ...createNode("text", 10, 0), constraints: { horizontal: "stretch" as const, vertical: "scale" as const } };

    expect(constraintSelection([first, second])).toEqual({
      horizontal: { kind: "same", value: "stretch" }, vertical: { kind: "same", value: "scale" }, hasExplicitConstraints: true,
    });
    expect(constraintSelection([first, createNode("section", 0, 0)])).toBeUndefined();
  });
});
