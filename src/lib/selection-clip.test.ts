import { describe, expect, it } from "vitest";
import type { CanvasNode } from "./editor-protocol";
import { isFullyClippedForSelection } from "./selection-clip";

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, name: id, kind: "rectangle", x: 0, y: 0, width: 40, height: 40, rotation: 0,
  fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1, visible: true, ...patch,
});
const bounds = (candidate: CanvasNode) => ({ x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height });

describe("structural marquee clipping", () => {
  it("rejects a descendant that is entirely outside an ancestor Frame clip", () => {
    const frame = node("frame", { kind: "frame", width: 100, height: 100, clipsContent: true });
    const outside = node("outside", { parentId: frame.id, x: 140, y: 10 });
    expect(isFullyClippedForSelection([frame, outside], outside.id, bounds)).toBe(true);
  });

  it("retains a descendant that has a visible overlap with an ancestor Frame clip", () => {
    const frame = node("frame", { kind: "frame", width: 100, height: 100, clipsContent: true });
    const partial = node("partial", { parentId: frame.id, x: 80, y: 10 });
    expect(isFullyClippedForSelection([frame, partial], partial.id, bounds)).toBe(false);
  });

  it("rejects a descendant when nested clips have no common visible region", () => {
    const outer = node("outer", { kind: "frame", x: 0, y: 0, width: 40, height: 40, clipsContent: true });
    const inner = node("inner", { kind: "frame", parentId: outer.id, x: 60, y: 0, width: 40, height: 40, clipsContent: true });
    const target = node("target", { parentId: inner.id, x: 0, y: 0, width: 100, height: 40 });
    expect(isFullyClippedForSelection([outer, inner, target], target.id, bounds)).toBe(true);
  });

  it("rejects a masked target outside its active alpha source while retaining the mask layer", () => {
    const mask = node("mask", { isMask: true, x: 0, y: 0, width: 40, height: 40 });
    const hidden = node("hidden", { x: 100, y: 0 });
    expect(isFullyClippedForSelection([mask, hidden], hidden.id, bounds)).toBe(true);
    expect(isFullyClippedForSelection([mask, hidden], mask.id, bounds)).toBe(false);
  });

  it("rejects every target in a run when its alpha mask is hidden", () => {
    const mask = node("mask", { isMask: true, visible: false });
    const target = node("target", { x: 5, y: 5 });
    expect(isFullyClippedForSelection([mask, target], target.id, bounds)).toBe(true);
  });
});
