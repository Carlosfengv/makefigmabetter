import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { cornerSmoothingSelection } from "./corner-smoothing-selection";

describe("multi-selection corner smoothing", () => {
  it("uses zero for the legacy omitted value and reports divergence as Mixed", () => {
    const frame = createNode("frame", 0, 0);
    const rectangle = { ...createNode("rectangle", 10, 0), cornerSmoothing: 0 };
    const section = { ...createNode("section", 20, 0), cornerSmoothing: .5 };

    expect(cornerSmoothingSelection([frame, rectangle])).toEqual({ kind: "same", value: 0 });
    expect(cornerSmoothingSelection([frame, section])).toEqual({ kind: "mixed" });
  });

  it("rejects shape mixes where smoothing has no Canonical meaning", () => {
    expect(cornerSmoothingSelection([createNode("rectangle", 0, 0), createNode("ellipse", 0, 0)])).toBeUndefined();
  });
});
