import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { buildWebGpuInstances, cameraUniform, GPU_CAMERA_UNIFORM_BYTES, GPU_INSTANCE_FLOATS } from "./webgpu-scene";

describe("WebGPU world-space scene data", () => {
  it("keeps world geometry independent of viewport and packs one instance per supported node", () => {
    const rectangle = { ...createNode("rectangle", 12, -8), width: 100, height: 40, rotation: 30, radius: 6 };
    const text = createNode("text", 0, 0);
    const result = buildWebGpuInstances([rectangle, text]);
    expect(result.instances).toHaveLength(GPU_INSTANCE_FLOATS);
    expect(Array.from(result.instances.slice(0, 8))).toEqual([12, -8, 100, 40, 30, 0, 6, 1]);
    expect(result.renderedNodeIds).toEqual(new Set([rectangle.id]));
  });

  it("writes the small camera uniform separately from scene instances", () => {
    const camera = cameraUniform({ viewportX: 2, viewportY: 3, zoom: 1.5, canvasWidth: 800, canvasHeight: 600, dpr: 2 });
    expect(camera.byteLength).toBe(GPU_CAMERA_UNIFORM_BYTES);
    expect(Array.from(camera.slice(0, 6))).toEqual([2, 3, 1.5, 800, 600, 2]);
  });
});
