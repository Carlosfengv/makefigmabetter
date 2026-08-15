import { describe, expect, it } from "vitest";
import { createPhase2GpuDropShadowFixture, PHASE2_GPU_DROP_SHADOW_FIXTURE_NAME } from "./phase2-gpu-drop-shadow-fixture";
import { gpuLayerPrefix, isGpuDropShadowEffectNode } from "./gpu-layer-prefix";
import { resolveCoreBatch } from "./transaction-batch";

describe("F-PHASE2-GPU-DROP-SHADOW fixture", () => {
  it("keeps a flat, deterministic E1 source/blur/composite evidence page", () => {
    const fixture = createPhase2GpuDropShadowFixture();
    const [background, shadow] = fixture.nodes;

    expect(fixture).toMatchObject({
      format: "makefigma-phase2-gpu-drop-shadow-fixture-v1",
      name: PHASE2_GPU_DROP_SHADOW_FIXTURE_NAME,
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(background).toMatchObject({ kind: "rectangle" });
    expect(shadow).toMatchObject({ kind: "rectangle", effectStack: [
      expect.objectContaining({ dropShadow: expect.objectContaining({ spread: 0, visible: true }) }),
      expect.objectContaining({ dropShadow: expect.objectContaining({ spread: 0, visible: true }) }),
    ] });
    expect(background).not.toHaveProperty("parentId");
    expect(shadow).not.toHaveProperty("parentId");
    expect(isGpuDropShadowEffectNode(shadow!)).toBe(true);
    expect(gpuLayerPrefix(fixture.nodes, new Set()).map((node) => node.id)).toEqual([background!.id, shadow!.id]);
    expect(resolveCoreBatch([], fixture.nodes.map((node) => ({ type: "create" as const, node })))?.nextNodes).toHaveLength(2);
  });
});
