import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { lineSelectionAppearance, parseLineDashPattern, strokeSelectionAppearance } from "./line-selection-appearance";

describe("all-Line selection appearance", () => {
  it("exposes shared endpoint and join properties", () => {
    const first = { ...createNode("line", 0, 0), strokeCapEnd: "arrowLines" as const, strokeJoin: "round" as const, strokeMiterLimit: 6 };
    const second = { ...createNode("line", 20, 0), strokeCapEnd: "arrowLines" as const, strokeJoin: "round" as const, strokeMiterLimit: 6 };

    expect(lineSelectionAppearance([first, second])).toEqual({
      strokeCapStart: { kind: "same", value: "none" },
      strokeCapEnd: { kind: "same", value: "arrowLines" },
      strokeJoin: { kind: "same", value: "round" },
      strokeMiterLimit: { kind: "same", value: 6 },
      strokeDashPattern: { kind: "same", value: "" },
    });
  });

  it("reports divergent values as Mixed and rejects a heterogeneous selection", () => {
    const line = createNode("line", 0, 0);
    const decorated = { ...createNode("line", 20, 0), strokeCapStart: "round" as const, strokeMiterLimit: 4 };

    expect(lineSelectionAppearance([line, decorated])?.strokeCapStart).toEqual({ kind: "mixed" });
    expect(lineSelectionAppearance([line, createNode("rectangle", 0, 0)])).toBeUndefined();
  });

  it("compares Dash patterns structurally and normalizes user-entered odd patterns", () => {
    const first = { ...createNode("line", 0, 0), strokeDashPattern: [8, 4] };
    const second = { ...createNode("line", 20, 0), strokeDashPattern: [8, 4] };
    const third = { ...createNode("line", 40, 0), strokeDashPattern: [2, 2] };

    expect(lineSelectionAppearance([first, second])?.strokeDashPattern).toEqual({ kind: "same", value: "8, 4" });
    expect(lineSelectionAppearance([first, third])?.strokeDashPattern).toEqual({ kind: "mixed" });
    expect(parseLineDashPattern("8, 4, 2")).toEqual([8, 4, 2, 8, 4, 2]);
    expect(parseLineDashPattern("0, 0")).toBeUndefined();
  });

  it("shares Join, Miter and Dash with all drawable mixed selections, but excludes structural nodes", () => {
    const frame = { ...createNode("frame", 0, 0), strokeJoin: "round" as const, strokeMiterLimit: 6, strokeDashPattern: [8, 4] };
    const rectangle = { ...createNode("rectangle", 20, 0), strokeJoin: "round" as const, strokeMiterLimit: 6, strokeDashPattern: [8, 4] };

    expect(strokeSelectionAppearance([frame, rectangle])).toEqual({
      strokeJoin: { kind: "same", value: "round" },
      strokeMiterLimit: { kind: "same", value: 6 },
      strokeDashPattern: { kind: "same", value: "8, 4" },
    });
    expect(strokeSelectionAppearance([frame, createNode("group", 40, 0)])).toBeUndefined();
  });
});
