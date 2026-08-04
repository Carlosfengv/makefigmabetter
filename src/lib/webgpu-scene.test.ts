import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { admitWebGpuSceneResources, buildWebGpuVertices, GPU_SCENE_INSTANCE_BYTES_PER_NODE, GPU_CAMERA_UNIFORM_BYTES, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES, WebGpuSceneRenderer } from "./webgpu-scene";

describe("WebGPU scene vertex projection", () => {
  it("triangulates supported solid nodes in screen space and leaves text/gradients for the overlay", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), width: 100, height: 50, rotation: 0, fill: "#ff000080", stroke: "#000000", strokeWidth: 2, opacity: 0.5, radius: 6 };
    const text = createNode("text", 0, 0);
    const gradient = { ...createNode("ellipse", 0, 0), fillGradient: { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [] } };
    const gradientStroke = { ...createNode("ellipse", 0, 0), strokeGradient: { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [] } };
    const result = buildWebGpuVertices({ nodes: [rectangle, text, gradient, gradientStroke], viewport: { x: 100, y: 75, zoom: 1 }, width: 400, height: 300, dpr: 2 });
    expect(result.renderedNodeIds).toEqual(new Set([rectangle.id]));
    expect(result.vertices).toHaveLength(6 * 16);
    expect(Array.from(result.vertices.slice(0, 16))).toEqual([0.5, -0.5, 0, 0, 1, 0, 0, 0.250980406999588, 0, 0, 0, 0.5, 0, 0.11999999731779099, 0.03999999910593033, 2]);
  });

  it("rejects GPU resource amplification before allocating a vertex array or swap chain", () => {
    const rectangle = createNode("rectangle", 0, 0);
    expect(admitWebGpuSceneResources({ nodes: [rectangle], width: 100, height: 50, dpr: 2 })).toMatchObject({ accepted: true, vertexBytes: MIN_GPU_SCENE_VERTEX_BUFFER_BYTES, renderableNodeCount: 1 });
    expect(admitWebGpuSceneResources({ nodes: [rectangle], width: 100, height: 50, dpr: 2 }, 1)).toEqual({ accepted: false, reason: "RESOURCE_LIMIT", resourceBytes: 244_096, maxBytes: 1 });
    const manyRectangles = Array.from({ length: Math.ceil(MIN_GPU_SCENE_VERTEX_BUFFER_BYTES / GPU_SCENE_INSTANCE_BYTES_PER_NODE) + 1 }, () => rectangle);
    expect(admitWebGpuSceneResources({ nodes: manyRectangles, width: 1, height: 1, dpr: 1 })).toMatchObject({ accepted: true, vertexBytes: manyRectangles.length * GPU_SCENE_INSTANCE_BYTES_PER_NODE });
    expect(admitWebGpuSceneResources({ nodes: [], width: 0, height: 50, dpr: 1 })).toMatchObject({ accepted: false, reason: "INVALID_SIZE" });
  });

  it("reallocates to the admitted vertex size and releases buffers for an empty scene", async () => {
    const created: number[] = [];
    const destroyed: number[] = [];
    const clearValues: unknown[] = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: { writeBuffer: () => undefined, submit: () => undefined },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createBuffer: ({ size }: { size: number }) => {
        created.push(size);
        return { destroy: () => destroyed.push(size) };
      },
      createCommandEncoder: () => ({ beginRenderPass: (descriptor: { colorAttachments: Array<{ clearValue: unknown }> }) => { clearValues.push(descriptor.colorAttachments[0]?.clearValue); return { setPipeline: () => undefined, setBindGroup: () => undefined, setVertexBuffer: () => undefined, draw: () => undefined, end: () => undefined }; }, finish: () => ({}) }),
      destroy: () => undefined,
    };
    const original = globalThis.OffscreenCanvas;
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return context; }
      transferToImageBitmap() { return { close: () => undefined } as ImageBitmap; }
    }
    Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: FakeOffscreenCanvas });
    try {
      const navigatorLike: Parameters<typeof WebGpuSceneRenderer.create>[0] = { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }), getPreferredCanvasFormat: () => "bgra8unorm" } };
      const renderer = await WebGpuSceneRenderer.create(navigatorLike);
      const rectangle = createNode("rectangle", 0, 0);
      renderer.render({ nodes: [rectangle], viewport: { x: 0, y: 0, zoom: 1 }, width: 10, height: 10, dpr: 1, sceneKey: 1 });
      expect(renderer.render({ nodes: [rectangle], viewport: { x: 3, y: 2, zoom: 1.2 }, width: 10, height: 10, dpr: 1, sceneKey: 1 }).gpuUploadBytes).toBe(32);
      const moved = { ...rectangle, x: 24, y: 16 };
      expect(renderer.render({ nodes: [moved], viewport: { x: 3, y: 2, zoom: 1.2 }, width: 10, height: 10, dpr: 1, sceneKey: "1:drag-1" }).gpuUploadBytes).toBe(GPU_SCENE_INSTANCE_BYTES_PER_NODE + GPU_CAMERA_UNIFORM_BYTES);
      const many = Array.from({ length: 12 }, () => rectangle);
      renderer.render({ nodes: many, viewport: { x: 0, y: 0, zoom: 1 }, width: 10, height: 10, dpr: 1, sceneKey: 2 });
      renderer.render({ nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, width: 10, height: 10, dpr: 1, sceneKey: 3 });
      renderer.destroy();

      expect(created).toEqual([48, 32, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES]);
      expect(destroyed).toEqual([MIN_GPU_SCENE_VERTEX_BUFFER_BYTES, 48, 32]);
      expect(clearValues).toEqual([{ r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }]);
    } finally {
      if (original === undefined) delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: original });
    }
  });
});
