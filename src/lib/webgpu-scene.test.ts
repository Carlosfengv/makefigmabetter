import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { admitWebGpuSceneResources, buildWebGpuVertices, GPU_SCENE_INSTANCE_BYTES_PER_NODE, GPU_CAMERA_UNIFORM_BYTES, GPU_TEXT_INSTANCE_BYTES_PER_NODE, imageInstance, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES, WebGpuSceneRenderer, type WebGpuTextGlyph } from "./webgpu-scene";

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

  it("projects an Image pass with deterministic cover-crop UVs", () => {
    const node = { ...createNode("image", 0, 0), width: 200, height: 100, rotation: 15 };
    expect(imageInstance(node, { width: 100, height: 100 } as ImageBitmap)).toEqual([0, 0, 200, 100, 15, 0, 0.25, 1, 0.5, 1]);
    expect(imageInstance({ ...node, opacity: .4 }, { width: 400, height: 100 } as ImageBitmap)).toEqual([0, 0, 200, 100, 15, 0.25, 0, 0.5, 1, .4]);
  });

  it("accounts for one texture per decoded asset and the minimum Image instance buffer", () => {
    const first = { ...createNode("image", 0, 0), assetId: "asset-a" };
    const second = { ...createNode("image", 50, 0), assetId: "asset-a" };
    const bitmap = { width: 32, height: 16 } as ImageBitmap;
    expect(admitWebGpuSceneResources({ nodes: [first, second], width: 10, height: 10, dpr: 1, imageBitmaps: new Map([["asset-a", bitmap]]) })).toMatchObject({
      accepted: true,
      vertexBytes: 0,
      textureBytes: 2_048,
      resourceBytes: 7_344,
    });
  });

  it("packs, reuses and releases bounded alpha masks in one GPU Text atlas", async () => {
    const textureWrites: Array<{ byteLength: number; bytesPerRow: number; origin?: { x: number; y: number; z?: number } }> = [];
    const textureSizes: Array<{ width: number; height: number }> = [];
    const destroyedTextures: number[] = [];
    const draws: number[] = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: {
        writeBuffer: () => undefined,
        writeTexture: (destination: { origin?: { x: number; y: number; z?: number } }, data: Uint8Array, layout: { bytesPerRow: number }) => textureWrites.push({ byteLength: data.byteLength, bytesPerRow: layout.bytesPerRow, origin: destination.origin }),
        copyExternalImageToTexture: () => undefined,
        submit: () => undefined,
      },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createSampler: () => ({}),
      createTexture: ({ size }: { size: { width: number; height: number } }) => { textureSizes.push(size); return { createView: () => ({}), destroy: () => destroyedTextures.push(1) }; },
      createBuffer: () => ({ destroy: () => undefined }),
      createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline: () => undefined, setBindGroup: () => undefined, setVertexBuffer: () => undefined, draw: (count: number) => draws.push(count), end: () => undefined }), finish: () => ({}) }),
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
      const glyph: WebGpuTextGlyph = { textureKey: "font-a:1:16", nodeId: "text-a", x: 1, y: 2, width: 2, height: 2, rotation: 0, fill: "#102030", opacity: 1, maskWidth: 2, maskHeight: 2, alphaMask: Uint8Array.from([0, 255, 255, 0]) };
      const secondGlyph: WebGpuTextGlyph = { ...glyph, textureKey: "font-a:2:16", x: 4, alphaMask: Uint8Array.from([255, 0, 0, 255]) };
      const input = { nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, width: 10, height: 10, dpr: 1, sceneKey: "text", textGlyphs: [glyph, secondGlyph] };
      expect(renderer.render(input).renderedNodeIds).toEqual(new Set(["text-a"]));
      expect(renderer.render(input).gpuUploadBytes).toBe(GPU_CAMERA_UNIFORM_BYTES + GPU_TEXT_INSTANCE_BYTES_PER_NODE * 2);
      renderer.destroy();
      expect(textureSizes).toEqual([{ width: 1024, height: 1024, depthOrArrayLayers: 1 }]);
      expect(textureWrites).toEqual([
        { byteLength: 512, bytesPerRow: 256, origin: { x: 1, y: 1, z: 0 } },
        { byteLength: 512, bytesPerRow: 256, origin: { x: 5, y: 1, z: 0 } },
      ]);
      expect(draws).toEqual([6, 6, 6, 6]);
      expect(destroyedTextures).toEqual([1]);
    } finally {
      if (original === undefined) delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: original });
    }
  });

  it("includes unique glyph masks and the allocated Text instance buffer in GPU admission", () => {
    const glyph = (nodeId: string): WebGpuTextGlyph => ({ textureKey: "font-a:1:16", nodeId, x: 0, y: 0, width: 2, height: 2, rotation: 0, fill: "#000000", opacity: 1, maskWidth: 2, maskHeight: 2, alphaMask: Uint8Array.from([0, 255, 255, 0]) });
    expect(admitWebGpuSceneResources({ nodes: [], width: 10, height: 10, dpr: 1, textGlyphs: [glyph("one"), glyph("two")] })).toMatchObject({
      accepted: true,
      textureBytes: 1_048_576,
      textAtlasBytes: 1_048_576,
      resourceBytes: 1_053_872,
    });
  });

  it("falls an entire text node back when its glyphs cannot all fit in the atlas", async () => {
    const draws: number[] = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: { writeBuffer: () => undefined, writeTexture: () => undefined, copyExternalImageToTexture: () => undefined, submit: () => undefined },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createSampler: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy: () => undefined }),
      createBuffer: () => ({ destroy: () => undefined }),
      createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline: () => undefined, setBindGroup: () => undefined, setVertexBuffer: () => undefined, draw: (count: number) => draws.push(count), end: () => undefined }), finish: () => ({}) }),
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
      const largeMask = new Uint8Array(1022 * 1022).fill(255);
      const first: WebGpuTextGlyph = { textureKey: "font-a:large", nodeId: "text-a", x: 0, y: 0, width: 1022, height: 1022, rotation: 0, fill: "#000000", opacity: 1, maskWidth: 1022, maskHeight: 1022, alphaMask: largeMask };
      const second: WebGpuTextGlyph = { textureKey: "font-a:extra", nodeId: "text-a", x: 0, y: 0, width: 1, height: 1, rotation: 0, fill: "#000000", opacity: 1, maskWidth: 1, maskHeight: 1, alphaMask: Uint8Array.of(255) };
      const result = renderer.render({ nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, width: 10, height: 10, dpr: 1, sceneKey: "atlas-overflow", textGlyphs: [first, second] });
      expect(result.renderedNodeIds).toEqual(new Set());
      expect(draws).toEqual([]);
      renderer.destroy();
    } finally {
      if (original === undefined) delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: original });
    }
  });

  it("uploads each decoded asset once and draws each visible image with its texture", async () => {
    const textureWrites: Array<{ byteLength: number; bytesPerRow: number; width: number; height: number }> = [];
    const destroyedTextures: number[] = [];
    const draws: number[] = [];
    const created: number[] = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: {
        writeBuffer: () => undefined,
        writeTexture: (_destination: unknown, data: Uint8Array, layout: { bytesPerRow: number }, copySize: { width: number; height: number }) => textureWrites.push({ byteLength: data.byteLength, bytesPerRow: layout.bytesPerRow, width: copySize.width, height: copySize.height }),
        copyExternalImageToTexture: () => undefined,
        submit: () => undefined,
      },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createSampler: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy: () => destroyedTextures.push(1) }),
      createBuffer: ({ size }: { size: number }) => { created.push(size); return { destroy: () => undefined }; },
      createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline: () => undefined, setBindGroup: () => undefined, setVertexBuffer: () => undefined, draw: (count: number) => draws.push(count), end: () => undefined }), finish: () => ({}) }),
      destroy: () => undefined,
    };
    const original = globalThis.OffscreenCanvas;
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return { ...context, drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(255) }) }; }
      transferToImageBitmap() { return { close: () => undefined } as ImageBitmap; }
    }
    Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: FakeOffscreenCanvas });
    try {
      const navigatorLike: Parameters<typeof WebGpuSceneRenderer.create>[0] = { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }), getPreferredCanvasFormat: () => "bgra8unorm" } };
      const renderer = await WebGpuSceneRenderer.create(navigatorLike);
      const bitmap = { width: 32, height: 16 } as ImageBitmap;
      const first = { ...createNode("image", 0, 0), assetId: "asset-a", width: 32, height: 16 };
      const second = { ...createNode("image", 40, 0), assetId: "asset-a", width: 32, height: 16 };
      const input = { nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 }, width: 100, height: 50, dpr: 1, sceneKey: "images", imageBitmaps: new Map([["asset-a", bitmap]]) };
      expect(renderer.render(input).renderedNodeIds).toEqual(new Set([first.id, second.id]));
      expect(renderer.render(input).gpuUploadBytes).toBe(GPU_CAMERA_UNIFORM_BYTES + 80);
      renderer.destroy();
      expect(textureWrites).toEqual([{ byteLength: 4_096, bytesPerRow: 256, width: 32, height: 16 }]);
      expect(draws).toEqual([6, 6, 6, 6]);
      expect(created).toContain(MIN_GPU_SCENE_VERTEX_BUFFER_BYTES);
      expect(destroyedTextures).toEqual([1]);
    } finally {
      if (original === undefined) delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: original });
    }
  });

  it("reallocates to the admitted vertex size and releases buffers for an empty scene", async () => {
    const created: number[] = [];
    const destroyed: number[] = [];
    const clearValues: unknown[] = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: { writeBuffer: () => undefined, copyExternalImageToTexture: () => undefined, submit: () => undefined },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createSampler: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy: () => undefined }),
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
      const canonicalBatch = {
        instances: new Float32Array([0, 0, 100, 100, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]),
        renderedNodeIds: new Set(["canonical-shape"]),
      };
      expect(renderer.render({ nodes: [rectangle], viewport: { x: 0, y: 0, zoom: 1 }, width: 10, height: 10, dpr: 1, sceneKey: 1, precomputedInstances: canonicalBatch }).renderedNodeIds).toEqual(new Set(["canonical-shape"]));
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
