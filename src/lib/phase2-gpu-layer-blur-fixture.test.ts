import { describe, expect, it } from "vitest";
import { createPhase2GpuLayerBlurFixture, PHASE2_GPU_LAYER_BLUR_FIXTURE_NAME } from "./phase2-gpu-layer-blur-fixture";
import { gpuLayerPrefix, isGpuLayerBlurEffectNode } from "./gpu-layer-prefix";
import { resolveCoreBatch } from "./transaction-batch";

describe("F-PHASE2-GPU-LAYER-BLUR fixture", () => {
  it("keeps a flat, deterministic E1 source/blur/composite evidence page", () => {
    const fixture = createPhase2GpuLayerBlurFixture();
    const [background, layerBlur] = fixture.nodes;

    expect(fixture).toMatchObject({
      format: "makefigma-phase2-gpu-layer-blur-fixture-v1",
      name: PHASE2_GPU_LAYER_BLUR_FIXTURE_NAME,
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(background).toMatchObject({ kind: "rectangle" });
    expect(layerBlur).toMatchObject({ kind: "rectangle", effectStack: [expect.objectContaining({ layerBlur: expect.objectContaining({ radius: 8, visible: true }) })] });
    expect(background).not.toHaveProperty("parentId");
    expect(layerBlur).not.toHaveProperty("parentId");
    expect(isGpuLayerBlurEffectNode(layerBlur!)).toBe(true);
    expect(gpuLayerPrefix(fixture.nodes, new Set()).map((node) => node.id)).toEqual([background!.id, layerBlur!.id]);
    expect(resolveCoreBatch([], fixture.nodes.map((node) => ({ type: "create" as const, node })))?.nextNodes).toHaveLength(2);
  });
});
