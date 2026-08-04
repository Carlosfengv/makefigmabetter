import { describe, expect, it } from "vitest";
import type { CanvasNode } from "./editor-protocol";
import { selectionDimensions, selectionTitle } from "./selection-label";

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, name: id, kind: "rectangle", x: 0, y: 0, width: 120, height: 80, rotation: 0,
  fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1, visible: true, ...patch,
});

describe("selection label", () => {
  it("shows a single layer name separately from compact dimensions", () => {
    expect(selectionTitle([node("Card")])).toBe("Card");
    expect(selectionDimensions(123.5, 40.125)).toBe("123.5 × 40.13");
  });

  it("does not show a title for a multi-selection", () => {
    expect(selectionTitle([node("first"), node("second")])).toBeUndefined();
    expect(selectionTitle([])).toBeUndefined();
  });
});
