import { describe, expect, it } from "vitest";
import { frameDropTargetAtPoint, frameExitTargetAtPoint } from "./frame-drop-target";
import type { CanvasNode } from "./editor-protocol";

function node(id: string, patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    pageId: "page",
    parentId: undefined,
    positionId: id,
    name: id,
    kind: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 0,
    opacity: 1,
    visible: true,
    locked: false,
    radius: 0,
    text: "",
    ...patch,
  };
}

describe("frameDropTargetAtPoint", () => {
  it("prefers the deepest eligible Frame and identifies Auto Layout", () => {
    const outer = node("outer", { kind: "frame", x: 0, y: 0, width: 400, height: 400 });
    const inner = node("inner", { kind: "frame", parentId: "outer", x: 80, y: 80, width: 160, height: 160, autoLayout: { mode: "vertical", padding: [0, 0, 0, 0], itemSpacing: 0, wrap: false, primaryAlignment: "start", counterAlignment: "start", primarySizing: "fixed", counterSizing: "fixed", absolute: false } });
    const dragged = node("dragged", { x: 450, y: 0 });

    expect(frameDropTargetAtPoint([outer, inner, dragged], ["dragged"], { x: 120, y: 120 })).toMatchObject({ frame: { id: "inner" }, isAutoLayout: true });
  });

  it("never offers a moved Frame or any of its descendants as a target", () => {
    const outer = node("outer", { kind: "frame", x: 0, y: 0, width: 300, height: 300 });
    const inner = node("inner", { kind: "frame", parentId: "outer", x: 50, y: 50, width: 100, height: 100 });

    expect(frameDropTargetAtPoint([outer, inner], ["outer"], { x: 75, y: 75 })).toBeUndefined();
  });

  it("does not claim a Frame that already owns every moved layer", () => {
    const frame = node("frame", { kind: "frame", x: 0, y: 0, width: 300, height: 300 });
    const child = node("child", { parentId: "frame", x: 30, y: 30 });

    expect(frameDropTargetAtPoint([frame, child], ["child"], { x: 80, y: 80 })).toBeUndefined();
  });

  it("offers the Frame parent when a direct child is dragged beyond its bounds", () => {
    const outer = node("outer", { kind: "frame", x: 0, y: 0, width: 500, height: 500 });
    const inner = node("inner", { kind: "frame", parentId: "outer", x: 80, y: 80, width: 160, height: 160 });
    const child = node("child", { parentId: "inner", x: 20, y: 20 });

    expect(frameExitTargetAtPoint([outer, inner, child], ["child"], { x: 300, y: 300 })).toMatchObject({ frame: { id: "inner" }, parentId: "outer" });
    expect(frameExitTargetAtPoint([outer, inner, child], ["child"], { x: 120, y: 120 })).toBeUndefined();
  });

  it("does not detach a mixed-parent multi-selection", () => {
    const frame = node("frame", { kind: "frame", x: 0, y: 0, width: 200, height: 200 });
    const child = node("child", { parentId: "frame" });
    const loose = node("loose", { x: 240, y: 0 });

    expect(frameExitTargetAtPoint([frame, child, loose], ["child", "loose"], { x: 300, y: 300 })).toBeUndefined();
  });
});
