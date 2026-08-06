import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { resolvedStrokeWeights, strokeWeightSelection } from "./stroke-weight-selection";

describe("multi-selection Stroke weights", () => {
  it("treats uniform and explicit-equal weights as the same value", () => {
    const uniform = { ...createNode("rectangle", 0, 0), strokeWidth: 3 };
    const explicit = { ...createNode("frame", 20, 0), strokeWidth: 1, strokeWeights: [3, 3, 3, 3] as [number, number, number, number] };

    expect(strokeWeightSelection([uniform, explicit])).toEqual({
      top: { kind: "same", value: 3 }, right: { kind: "same", value: 3 },
      bottom: { kind: "same", value: 3 }, left: { kind: "same", value: 3 }, hasExplicitWeights: true,
    });
  });

  it("keeps each side independently Mixed and rejects an inapplicable kind", () => {
    const first = { ...createNode("rectangle", 0, 0), strokeWeights: [1, 2, 3, 4] as [number, number, number, number] };
    const second = { ...createNode("rectangle", 20, 0), strokeWeights: [1, 8, 3, 4] as [number, number, number, number] };

    expect(strokeWeightSelection([first, second])?.right).toEqual({ kind: "mixed" });
    expect(strokeWeightSelection([first, createNode("line", 0, 0)])).toBeUndefined();
    expect(resolvedStrokeWeights({ strokeWidth: 2 })).toEqual([2, 2, 2, 2]);
  });
});
