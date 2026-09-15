import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-linear-blend.fixture.json";
import type { CanvasNode } from "./editor-protocol";
import { compositeLinearBlendRgba } from "./linear-blend-composite";
import { requiresSubtreeComposition } from "./subtree-compositing";

describe("W12-P linear blend fixture", () => {
  it("pairs exact node blends with independently calculated opaque references", () => {
    const nodes = fixture.nodes as CanvasNode[];
    const burn = nodes.find((node) => node.blendMode === "linear-burn")!;
    const dodge = nodes.find((node) => node.blendMode === "linear-dodge")!;
    const paintBurn = nodes.find((node) => node.name === "Paint linear burn 50%")!;
    const paintDodge = nodes.find((node) => node.name === "Paint linear dodge 50%")!;
    expect(requiresSubtreeComposition(burn, false)).toBe(true);
    expect(requiresSubtreeComposition(dodge, false)).toBe(true);

    const source = new Uint8ClampedArray([0x66, 0xcc, 0x33, 0xff]);
    const burnPixel = new Uint8ClampedArray([0xcc, 0x33, 0x66, 0xff]);
    const dodgePixel = new Uint8ClampedArray(burnPixel);
    compositeLinearBlendRgba(burnPixel, source, "linear-burn", .5);
    compositeLinearBlendRgba(dodgePixel, source, "linear-dodge", .5);
    expect([...burnPixel]).toEqual([0x80, 0x1a, 0x33, 0xff]);
    expect([...dodgePixel]).toEqual([0xe6, 0x99, 0x80, 0xff]);
    expect(nodes.find((node) => node.name === "Linear burn reference")?.fill).toBe("#801a33");
    expect(nodes.find((node) => node.name === "Linear dodge reference")?.fill).toBe("#e69980");
    expect(paintBurn.fillStack?.layers[0]).toMatchObject({ opacity: .5, blendMode: "linear-burn" });
    expect(paintDodge.fillStack?.layers[0]).toMatchObject({ opacity: .5, blendMode: "linear-dodge" });
    expect(nodes.find((node) => node.name === "Paint linear burn reference")?.fill).toBe("#801a33");
    expect(nodes.find((node) => node.name === "Paint linear dodge reference")?.fill).toBe("#e69980");
  });
});
