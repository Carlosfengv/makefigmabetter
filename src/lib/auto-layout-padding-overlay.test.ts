import { describe, expect, it } from "vitest";
import type { CanvasNode, DocumentAutoLayout } from "./editor-protocol";
import { autoLayoutPaddingOverlay, autoLayoutPaddingSideAtWorldPoint } from "./auto-layout-padding-overlay";

const layout: DocumentAutoLayout = {
  mode: "vertical", padding: [10, 20, 30, 40], itemSpacing: 8, wrap: false,
  primaryAlignment: "start", counterAlignment: "start", primarySizing: "fixed",
  counterSizing: "fixed", absolute: false,
};
const frame: CanvasNode = {
  id: "frame", name: "Frame", kind: "frame", x: 0, y: 0, width: 200, height: 100,
  rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0,
  opacity: 1, visible: true, autoLayout: layout,
};
const child: CanvasNode = { ...frame, id: "child", parentId: "frame", kind: "rectangle", x: 40, y: 10, width: 100, height: 60, autoLayout: undefined };

describe("Auto Layout padding hover", () => {
  it.each([
    [{ x: 100, y: 5 }, "top"],
    [{ x: 190, y: 50 }, "right"],
    [{ x: 100, y: 80 }, "bottom"],
    [{ x: 20, y: 50 }, "left"],
  ] as const)("resolves %o to the %s padding edge", (point, side) => {
    expect(autoLayoutPaddingSideAtWorldPoint([frame, child], ["frame"], point, 1)).toEqual({ frameId: "frame", side });
  });

  it("uses the Auto Layout parent when its direct child is selected", () => {
    expect(autoLayoutPaddingSideAtWorldPoint([frame, child], ["child"], { x: 2, y: 50 }, 1)).toEqual({ frameId: "frame", side: "left" });
    expect(autoLayoutPaddingSideAtWorldPoint([frame, child], ["child"], { x: 100, y: 50 }, 1)).toBeUndefined();
  });

  it("keeps zero padding hoverable with a fixed screen-space edge band", () => {
    const zero = { ...frame, autoLayout: { ...layout, padding: [0, 0, 0, 0] as DocumentAutoLayout["padding"] } };
    expect(autoLayoutPaddingSideAtWorldPoint([zero], ["frame"], { x: 100, y: 5 }, 1)?.side).toBe("top");
  });

  it("returns the exact world polygon and badge value for the hovered side", () => {
    expect(autoLayoutPaddingOverlay([frame, child], ["child"], { frameId: "frame", side: "left" })).toEqual({
      frameId: "frame", side: "left", value: 40,
      polygon: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 100 }, { x: 0, y: 100 }],
    });
  });

  it("does not expose padding for ordinary frames or unrelated hover state", () => {
    expect(autoLayoutPaddingSideAtWorldPoint([{ ...frame, autoLayout: undefined }], ["frame"], { x: 2, y: 2 }, 1)).toBeUndefined();
    expect(autoLayoutPaddingOverlay([frame], ["frame"], { frameId: "other", side: "top" })).toBeUndefined();
  });
});
