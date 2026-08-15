import { describe, expect, it } from "vitest";
import { autoLayoutSizingForAxis, autoLayoutSizingKeyForAxis, withManualAutoLayoutSizing } from "./auto-layout-sizing";
import { createNode } from "./editor-protocol";

describe("Auto-layout frame sizing axes", () => {
  it("keeps width and height stable when the frame direction changes", () => {
    expect(autoLayoutSizingKeyForAxis("horizontal", "width")).toBe("primarySizing");
    expect(autoLayoutSizingKeyForAxis("horizontal", "height")).toBe("counterSizing");
    expect(autoLayoutSizingKeyForAxis("vertical", "width")).toBe("counterSizing");
    expect(autoLayoutSizingKeyForAxis("vertical", "height")).toBe("primarySizing");
  });

  it("reads the intended physical axis from a nested frame layout", () => {
    expect(autoLayoutSizingForAxis({ mode: "vertical", primarySizing: "hug", counterSizing: "fixed" }, "width")).toBe("fixed");
    expect(autoLayoutSizingForAxis({ mode: "vertical", primarySizing: "hug", counterSizing: "fixed" }, "height")).toBe("hug");
  });

  it("turns only manually edited child axes into Fixed in its parent layout direction", () => {
    const parent = {
      ...createNode("frame", 0, 0), id: "parent",
      autoLayout: { mode: "vertical" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false },
    };
    const child = { ...createNode("rectangle", 0, 0), id: "child", parentId: parent.id, autoLayout: { mode: "none" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fill" as const, counterSizing: "fill" as const, absolute: false } };

    expect(withManualAutoLayoutSizing([parent, child], child.id, { width: 140 })).toMatchObject({ autoLayout: { primarySizing: "fill", counterSizing: "fixed" } });
    expect(withManualAutoLayoutSizing([parent, child], child.id, { height: 80 })).toMatchObject({ autoLayout: { primarySizing: "fixed", counterSizing: "fill" } });
  });

  it("uses a nested Auto Layout Frame’s own physical axes", () => {
    const parent = { ...createNode("frame", 0, 0), id: "parent", autoLayout: { mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false } };
    const child = { ...createNode("frame", 0, 0), id: "child", parentId: parent.id, autoLayout: { mode: "vertical" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fill" as const, counterSizing: "hug" as const, absolute: false } };
    expect(withManualAutoLayoutSizing([parent, child], child.id, { width: 140 })).toMatchObject({ autoLayout: { primarySizing: "fill", counterSizing: "fixed" } });
  });

  it("leaves absolute Auto Layout children free to retain their own geometry", () => {
    const parent = { ...createNode("frame", 0, 0), id: "parent", autoLayout: { mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false } };
    const child = { ...createNode("rectangle", 0, 0), id: "child", parentId: parent.id, autoLayout: { mode: "none" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fill" as const, counterSizing: "fill" as const, absolute: true } };
    expect(withManualAutoLayoutSizing([parent, child], child.id, { width: 140 })).toEqual({ width: 140 });
  });
});
