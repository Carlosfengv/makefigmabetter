import { describe, expect, it } from "vitest";
import { showsPersistentCanvasLayerName } from "./canvas-layer-name";

describe("persistent canvas layer names", () => {
  it("shows page-level containers and hides nested containers", () => {
    expect(showsPersistentCanvasLayerName({ kind: "frame", visible: true })).toBe(true);
    expect(showsPersistentCanvasLayerName({ kind: "section", visible: true })).toBe(true);
    expect(showsPersistentCanvasLayerName({ kind: "frame", parentId: "parent", visible: true })).toBe(false);
    expect(showsPersistentCanvasLayerName({ kind: "section", parentId: "parent", visible: true })).toBe(false);
  });

  it("does not label hidden containers or page-level shapes", () => {
    expect(showsPersistentCanvasLayerName({ kind: "frame", visible: false })).toBe(false);
    expect(showsPersistentCanvasLayerName({ kind: "rectangle", visible: true })).toBe(false);
  });
});
