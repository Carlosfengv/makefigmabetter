import { describe, expect, it } from "vitest";
import { canvasDesignTokens, canvasFont } from "./canvas-design-tokens";

describe("canvas design tokens", () => {
  it("defines the approved Frame layer-name treatment", () => {
    expect(canvasFont(canvasDesignTokens.typography.layerName)).toMatch(/^400 \d+px Inter, "Helvetica Neue", sans-serif$/);
    expect(canvasDesignTokens.color.layerName).toBe("rgba(35, 37, 31, 0.6)");
  });

  it("keeps selection, hover, marquee, and grid styles semantically distinct", () => {
    expect(canvasDesignTokens.stroke.selection.dash).toEqual([]);
    expect(canvasDesignTokens.stroke.marquee.dash).toEqual([4, 3]);
    expect(canvasDesignTokens.color.selection).toBe("#0048FF");
  });
});
