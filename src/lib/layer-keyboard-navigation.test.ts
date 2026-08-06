import { describe, expect, it } from "vitest";
import { layerKeyboardTarget } from "./layer-keyboard-navigation";

describe("Layer keyboard navigation", () => {
  const layers = ["front", "middle", "back"];

  it("moves through the visible layer order without escaping its ends", () => {
    expect(layerKeyboardTarget(layers, "front", "ArrowDown")).toBe("middle");
    expect(layerKeyboardTarget(layers, "middle", "ArrowUp")).toBe("front");
    expect(layerKeyboardTarget(layers, "front", "ArrowUp")).toBe("front");
    expect(layerKeyboardTarget(layers, "back", "ArrowDown")).toBe("back");
  });

  it("supports Home/End and ignores stale focus IDs", () => {
    expect(layerKeyboardTarget(layers, "middle", "Home")).toBe("front");
    expect(layerKeyboardTarget(layers, "middle", "End")).toBe("back");
    expect(layerKeyboardTarget(layers, "missing", "Home")).toBeUndefined();
  });
});
