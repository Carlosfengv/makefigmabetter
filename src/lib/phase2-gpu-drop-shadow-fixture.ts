import { createNode, type CanvasNode, type Viewport } from "./editor-protocol";

export const PHASE2_GPU_DROP_SHADOW_FIXTURE_NAME = "F-PHASE2-GPU-DROP-SHADOW";

export interface Phase2GpuDropShadowFixture {
  format: "makefigma-phase2-gpu-drop-shadow-fixture-v1";
  name: typeof PHASE2_GPU_DROP_SHADOW_FIXTURE_NAME;
  viewport: Viewport;
  nodes: CanvasNode[];
}

/**
 * A deliberately flat page which admits E1's narrow GPU effect prefix. It
 * contains no parent clips, masks, Boolean wrappers or rich paint stacks, so
 * the worker can exercise source → blur → composite without weakening the
 * professional composite fixture's safer Canvas boundary.
 */
export function createPhase2GpuDropShadowFixture(): Phase2GpuDropShadowFixture {
  const background = {
    ...createNode("rectangle", -220, -140),
    id: "00000000-0000-4000-8000-000000004001",
    name: "GPU shadow backdrop",
    width: 440,
    height: 280,
    fill: "#dbeafe",
    fillColor: { space: "srgb" as const, components: [219 / 255, 234 / 255, 254 / 255] as [number, number, number], alpha: 1 },
    stroke: "transparent",
    strokeWidth: 0,
    radius: 24,
  };
  const shadowCard = {
    ...createNode("rectangle", -96, -62),
    id: "00000000-0000-4000-8000-000000004002",
    name: "GPU Drop Shadow card",
    width: 192,
    height: 124,
    fill: "#4f46e5",
    fillColor: { space: "srgb" as const, components: [79 / 255, 70 / 255, 229 / 255] as [number, number, number], alpha: 1 },
    stroke: "#312e81",
    strokeColor: { space: "srgb" as const, components: [49 / 255, 46 / 255, 129 / 255] as [number, number, number], alpha: 1 },
    strokeWidth: 2,
    radius: 18,
    effectStack: [{
      dropShadow: {
        offsetX: -4,
        offsetY: 8,
        blurRadius: 8,
        spread: 0,
        color: { space: "srgb" as const, components: [0.03, 0.04, 0.16] as [number, number, number], alpha: .16 },
        visible: true,
      },
    }, {
      dropShadow: {
        offsetX: 12,
        offsetY: 16,
        blurRadius: 20,
        spread: 0,
        color: { space: "srgb" as const, components: [0.03, 0.04, 0.16] as [number, number, number], alpha: .34 },
        visible: true,
      },
    }],
  };
  return {
    format: "makefigma-phase2-gpu-drop-shadow-fixture-v1",
    name: PHASE2_GPU_DROP_SHADOW_FIXTURE_NAME,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [background, shadowCard],
  };
}
