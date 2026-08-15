import { createNode, type CanvasNode, type Viewport } from "./editor-protocol";

export const PHASE2_GPU_LAYER_BLUR_FIXTURE_NAME = "F-PHASE2-GPU-LAYER-BLUR";

export interface Phase2GpuLayerBlurFixture {
  format: "makefigma-phase2-gpu-layer-blur-fixture-v1";
  name: typeof PHASE2_GPU_LAYER_BLUR_FIXTURE_NAME;
  viewport: Viewport;
  nodes: CanvasNode[];
}

/** Isolates E1's bounded source-blur-composite pass without a backdrop effect
 * or a second effect stack that would intentionally retain the Canvas path. */
export function createPhase2GpuLayerBlurFixture(): Phase2GpuLayerBlurFixture {
  const background = {
    ...createNode("rectangle", -220, -140),
    id: "00000000-0000-4000-8000-000000004101",
    name: "GPU layer blur backdrop",
    width: 440,
    height: 280,
    fill: "#fef3c7",
    fillColor: { space: "srgb" as const, components: [254 / 255, 243 / 255, 199 / 255] as [number, number, number], alpha: 1 },
    stroke: "transparent",
    strokeWidth: 0,
    radius: 24,
  };
  const blurCard = {
    ...createNode("rectangle", -96, -62),
    id: "00000000-0000-4000-8000-000000004102",
    name: "GPU Layer Blur card",
    width: 192,
    height: 124,
    fill: "#ea580c",
    fillColor: { space: "srgb" as const, components: [234 / 255, 88 / 255, 12 / 255] as [number, number, number], alpha: 1 },
    stroke: "#9a3412",
    strokeColor: { space: "srgb" as const, components: [154 / 255, 52 / 255, 18 / 255] as [number, number, number], alpha: 1 },
    strokeWidth: 2,
    radius: 18,
    effectStack: [{ layerBlur: { radius: 8, visible: true } }],
  };
  return {
    format: "makefigma-phase2-gpu-layer-blur-fixture-v1",
    name: PHASE2_GPU_LAYER_BLUR_FIXTURE_NAME,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [background, blurCard],
  };
}
