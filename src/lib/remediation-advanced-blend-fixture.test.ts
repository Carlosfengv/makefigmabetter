import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-advanced-blend.fixture.json";
import type { BlendMode } from "./editor-protocol";

describe("W12-P advanced blend fixture", () => {
  it("contains every CSS/Canvas-interoperable advanced Figma blend exactly once", () => {
    const expected: BlendMode[] = [
      "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
      "exclusion", "hue", "saturation", "color", "luminosity",
    ];
    expect(fixture.nodes.slice(1).map((node) => node.blendMode)).toEqual(expected);
    expect(new Set(fixture.nodes.map((node) => node.id)).size).toBe(fixture.nodes.length);
  });
});
