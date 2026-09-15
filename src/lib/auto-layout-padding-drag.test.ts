import { describe, expect, it } from "vitest";
import type { DocumentAutoLayout } from "./editor-protocol";
import { autoLayoutPaddingDragDelta, autoLayoutWithDraggedPadding } from "./auto-layout-padding-drag";
import { isPointInAutoLayoutPaddingBadge } from "./render-auto-layout-padding";

const layout: DocumentAutoLayout = {
  mode: "vertical", padding: [10, 20, 30, 40], itemSpacing: 8, wrap: false,
  primaryAlignment: "start", counterAlignment: "start", primarySizing: "fixed",
  counterSizing: "fixed", absolute: false,
};

describe("Auto Layout padding badge drag", () => {
  it("adds leftward and upward motion and subtracts rightward and downward motion", () => {
    expect(autoLayoutPaddingDragDelta({ x: 20, y: 20 }, { x: 14, y: 21 })).toBe(6);
    expect(autoLayoutPaddingDragDelta({ x: 20, y: 20 }, { x: 27, y: 19 })).toBe(-7);
    expect(autoLayoutPaddingDragDelta({ x: 20, y: 20 }, { x: 21, y: 12 })).toBe(8);
    expect(autoLayoutPaddingDragDelta({ x: 20, y: 20 }, { x: 19, y: 29 })).toBe(-9);
  });

  it("updates only the dragged side in steps of one and clamps at zero", () => {
    expect(autoLayoutWithDraggedPadding(layout, "left", 3).padding).toEqual([10, 20, 30, 43]);
    expect(autoLayoutWithDraggedPadding(layout, "top", -99).padding).toEqual([0, 20, 30, 40]);
  });

  it("starts the scrub only inside the visible badge", () => {
    const bounds = { left: 90, top: 42, right: 110, bottom: 58, centerX: 100, centerY: 50, label: "40" };
    expect(isPointInAutoLayoutPaddingBadge(bounds, { x: 100, y: 50 })).toBe(true);
    expect(isPointInAutoLayoutPaddingBadge(bounds, { x: 111, y: 50 })).toBe(false);
  });
});
