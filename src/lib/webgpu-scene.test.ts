import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { admitWebGpuSceneResources, buildWebGpuInstances, buildWebGpuVertices, classifyWebGpuRendererFailure, GPU_SCENE_INSTANCE_BYTES_PER_NODE, GPU_CAMERA_UNIFORM_BYTES, GPU_TEXT_INSTANCE_BYTES_PER_NODE, GPU_TEXT_INSTANCE_FLOATS, GPU_GLYPH_ATLAS_BYTES, MAX_GPU_GLYPH_ATLAS_PAGES, imageInstance, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES, WebGpuEffectTexturePool, WebGpuSceneRenderer, type WebGpuTextGlyph } from "./webgpu-scene";

describe("WebGPU scene vertex projection", () => {
  it("keeps effect surfaces pinned for a frame, then reuses or evicts only idle textures", () => {
    const created: Array<{ width: number; height: number }> = [];
    const destroyed: number[] = [];
    const device = {
      createTexture: ({ size }: { size: { width: number; height: number } }) => {
        created.push(size);
        return { createView: () => ({}), destroy: () => destroyed.push(1) };
      },
    };
    const pool = new WebGpuEffectTexturePool(device as never, 128);
    pool.beginFrame();
    const first = pool.acquire(4, 4);
    const second = pool.acquire(4, 4);
    // Both 64-byte textures are pinned, so a third surface cannot evict one.
    expect(pool.acquire(1, 1)).toBeUndefined();
    expect(pool.endFrame()).toMatchObject({ textures: 2, bytes: 128, active: 0, allocations: 2, rejected: 1 });

    pool.beginFrame();
    expect(pool.acquire(4, 4)).toBe(first);
    expect(pool.acquire(3, 3)).toBeDefined();
    expect(pool.endFrame()).toMatchObject({ textures: 2, bytes: 100, active: 0, cacheHits: 1, allocations: 1, evictions: 1, rejected: 0 });
    expect(created).toEqual([
      { width: 4, height: 4, depthOrArrayLayers: 1 },
      { width: 4, height: 4, depthOrArrayLayers: 1 },
      { width: 3, height: 3, depthOrArrayLayers: 1 },
    ]);
    expect(second).toBeDefined();
    expect(destroyed).toEqual([1]);
    pool.destroy();
    expect(destroyed).toEqual([1, 1, 1]);
  });

  it("rejects invalid effect surface sizes before allocating a GPU texture", () => {
    const pool = new WebGpuEffectTexturePool({ createTexture: () => { throw new Error("must not allocate"); } } as never, 128);
    pool.beginFrame();
    expect(pool.acquire(0, 4)).toBeUndefined();
    expect(pool.acquire(4.5, 4)).toBeUndefined();
    expect(pool.endFrame()).toMatchObject({ textures: 0, bytes: 0, rejected: 2 });
  });

  it("returns temporary effect ownership after a failed frame so the next render can reuse it", () => {
    const texture = { createView: () => ({}), destroy: () => undefined };
    const pool = new WebGpuEffectTexturePool({ createTexture: () => texture } as never, 128);
    pool.beginFrame();
    expect(pool.acquire(4, 4)).toBe(texture);
    pool.cancelFrame();
    pool.beginFrame();
    expect(pool.acquire(4, 4)).toBe(texture);
    expect(pool.endFrame()).toMatchObject({ textures: 1, bytes: 64, cacheHits: 1, allocations: 0 });
  });

  it("executes ordered Drop Shadows through bounded source, blur and composite passes", async () => {
    const draws: number[] = [];
    const textureSizes: Array<{ width: number; height: number }> = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: { writeBuffer: () => undefined, writeTexture: () => undefined, copyExternalImageToTexture: () => undefined, submit: () => undefined },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createSampler: () => ({}),
      createTexture: ({ size }: { size: { width: number; height: number } }) => { textureSizes.push(size); return { createView: () => ({}), destroy: () => undefined }; },
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
      const shadow = {
        ...createNode("rectangle", 4, 6), width: 40, height: 20,
        effectStack: [
          { dropShadow: { offsetX: -2, offsetY: 1, blurRadius: 3, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .1 }, visible: true } },
          { dropShadow: { offsetX: 3, offsetY: 4, blurRadius: 8, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true } },
        ],
      };
      const input = { nodes: [shadow], viewport: { x: 0, y: 0, zoom: 1 }, width: 32, height: 16, dpr: 1, sceneKey: "drop-shadow" };
      const first = renderer.render(input);
      expect(first.renderedNodeIds).toEqual(new Set([shadow.id]));
      expect(first.effectTextures).toMatchObject({ textures: 4, bytes: 8_192, allocations: 4, active: 0, rejected: 0 });
      expect(draws).toEqual([6, 6, 6, 6, 6, 6, 6]);
      expect(textureSizes).toEqual(Array.from({ length: 4 }, () => ({ width: 32, height: 16, depthOrArrayLayers: 1 })));
      expect(renderer.render(input).effectTextures).toMatchObject({ textures: 4, cacheHits: 4, allocations: 0, active: 0 });
      renderer.destroy();
    } finally {
      if (original === undefined) delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: original });
    }
  });

  it("executes one Layer Blur through the same bounded source and blur surfaces without repainting its source", async () => {
    const draws: number[] = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: { writeBuffer: () => undefined, writeTexture: () => undefined, copyExternalImageToTexture: () => undefined, submit: () => undefined },
      createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createBuffer: () => ({ destroy: () => undefined }), createSampler: () => ({}), createBindGroup: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy: () => undefined }),
      createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline: () => undefined, setBindGroup: () => undefined, setVertexBuffer: () => undefined, draw: (count: number) => draws.push(count), end: () => undefined }), finish: () => ({}) }),
    };
    const original = globalThis.OffscreenCanvas;
    class FakeOffscreenCanvas { width = 0; height = 0; getContext() { return context; } transferToImageBitmap() { return {} as ImageBitmap; } }
    Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: FakeOffscreenCanvas });
    try {
      const renderer = await WebGpuSceneRenderer.create({ gpu: { requestAdapter: async () => ({ requestDevice: async () => device }), getPreferredCanvasFormat: () => "bgra8unorm" } });
      const layerBlur = { ...createNode("rectangle", 4, 6), width: 40, height: 20, effectStack: [{ layerBlur: { radius: 8, visible: true } }] };
      const first = renderer.render({ nodes: [layerBlur], viewport: { x: 0, y: 0, zoom: 1 }, width: 32, height: 16, dpr: 1, sceneKey: "layer-blur" });
      expect(first.renderedNodeIds).toEqual(new Set([layerBlur.id]));
      expect(first.effectTextures).toMatchObject({ textures: 2, bytes: 4_096, allocations: 2, active: 0, rejected: 0 });
      expect(draws).toEqual([6, 6, 6]);
      renderer.destroy();
    } finally {
      if (original === undefined) delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: original });
    }
  });

  it("classifies GPU failures without retaining browser error text", () => {
    expect(classifyWebGpuRendererFailure({ name: "GPUOutOfMemoryError", message: "device allocation exceeded" })).toBe("WEBGPU_OUT_OF_MEMORY");
    expect(classifyWebGpuRendererFailure({ name: "GPUValidationError", message: "queue.writeTexture validation failed" })).toBe("WEBGPU_UPLOAD_FAILED");
    expect(classifyWebGpuRendererFailure({ name: "GPUValidationError", message: "invalid bind group" })).toBe("WEBGPU_VALIDATION_ERROR");
    expect(classifyWebGpuRendererFailure(new Error("opaque implementation failure"))).toBe("WEBGPU_SCENE_RENDER_FAILED");
  });

  it("triangulates supported solid nodes in screen space and leaves text paths/gradients for dedicated passes", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), width: 100, height: 50, rotation: 0, fill: "#ff000080", stroke: "#000000", strokeWidth: 2, opacity: 0.5, radius: 6 };
    const text = createNode("text", 0, 0);
    const textPath = createNode("textPath", 0, 0);
    const gradient = { ...createNode("ellipse", 0, 0), fillGradient: { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [] } };
    const gradientStroke = { ...createNode("ellipse", 0, 0), strokeGradient: { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [] } };
    const result = buildWebGpuVertices({ nodes: [rectangle, text, textPath, gradient, gradientStroke], viewport: { x: 100, y: 75, zoom: 1 }, width: 400, height: 300, dpr: 2 });
    expect(result.renderedNodeIds).toEqual(new Set([rectangle.id]));
    expect(buildWebGpuInstances([textPath]).renderedNodeIds).toEqual(new Set());
    expect(result.vertices).toHaveLength(6 * 16);
    expect(Array.from(result.vertices.slice(0, 16))).toEqual([0.5, -0.5, 0, 0, 1, 0, 0, 0.250980406999588, 0, 0, 0, 0.5, 0, 0.11999999731779099, 0.03999999910593033, 2]);
  });

  it("projects Center and Outside Ellipse Strokes as expanded GPU rings", () => {
    const aligned = { ...createNode("ellipse", 0, 0), width: 100, height: 50, strokeWidth: 8, strokeAlign: "outside" as const };
    const result = buildWebGpuVertices({ nodes: [aligned], viewport: { x: 0, y: 0, zoom: 1 }, width: 400, height: 300, dpr: 1 });
    expect(result.renderedNodeIds).toEqual(new Set([aligned.id]));
    const instances = buildWebGpuInstances([aligned]);
    // One expanded quad: left/top are -8 and its size is 116×66, exactly one
    // full Outside stroke width beyond each fill edge.
    expect(Array.from(instances.instances.slice(0, 4))).toEqual([-8, -8, 116, 66]);
  });

  it("projects Outside rounded Rectangle Strokes as expanded GPU rings", () => {
    const aligned = { ...createNode("rectangle", 10, 20), width: 100, height: 50, radius: 12, strokeWidth: 8, strokeAlign: "outside" as const };
    const instances = buildWebGpuInstances([aligned]);
    expect(Array.from(instances.instances.slice(0, 8))).toEqual([2, 12, 116, 66, 0, 0, 20, 8]);
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

  it("packs, reuses and releases bounded alpha masks in GPU Text atlas pages", async () => {
    const textureWrites: Array<{ byteLength: number; bytesPerRow: number; origin?: { x: number; y: number; z?: number } }> = [];
    const textureSizes: Array<{ width: number; height: number }> = [];
    const destroyedTextures: number[] = [];
    const draws: number[] = [];
    const bufferWrites: number[][] = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, data: Float32Array) => bufferWrites.push(Array.from(data)),
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
      const glyph: WebGpuTextGlyph = { textureKey: "font-a:1:16", nodeId: "text-a", x: 1, y: 2, width: 2, height: 2, rotation: 0, quadTransform: { a: -2, b: .5, c: 1, d: 3, e: 40, f: 50 }, fill: "#102030", opacity: 1, maskWidth: 2, maskHeight: 2, alphaMask: Uint8Array.from([0, 255, 255, 0]) };
      const secondGlyph: WebGpuTextGlyph = { ...glyph, textureKey: "font-a:2:16", x: 4, quadTransform: undefined, alphaMask: Uint8Array.from([255, 0, 0, 255]) };
      const input = { nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, width: 10, height: 10, dpr: 1, sceneKey: "text", textGlyphs: [glyph, secondGlyph] };
      expect(renderer.render(input).renderedNodeIds).toEqual(new Set(["text-a"]));
      expect(renderer.render(input).gpuUploadBytes).toBe(GPU_CAMERA_UNIFORM_BYTES + GPU_TEXT_INSTANCE_BYTES_PER_NODE * 2);
      const textPayload = bufferWrites.find((write) => write.length === GPU_TEXT_INSTANCE_FLOATS * 2);
      expect(textPayload?.slice(0, 6)).toEqual([40, 50, -2, .5, 1, 3]);
      [4, 2, 2, 0, 0, 2].forEach((value, index) => {
        expect(textPayload?.[GPU_TEXT_INSTANCE_FLOATS + index]).toBeCloseTo(value);
      });
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
      textureBytes: GPU_GLYPH_ATLAS_BYTES * MAX_GPU_GLYPH_ATLAS_PAGES,
      textAtlasBytes: GPU_GLYPH_ATLAS_BYTES * MAX_GPU_GLYPH_ATLAS_PAGES,
      resourceBytes: 4_199_600,
    });
  });

  it("continues onto a second atlas page before falling an entire node back", async () => {
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
      expect(result.renderedNodeIds).toEqual(new Set(["text-a"]));
      expect(draws).toEqual([6, 6]);
      renderer.destroy();
    } finally {
      if (original === undefined) delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: original });
    }
  });

  it("evicts an unused least-recently-used glyph page only between frames", async () => {
    const destroyedTextures: number[] = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: { writeBuffer: () => undefined, writeTexture: () => undefined, copyExternalImageToTexture: () => undefined, submit: () => undefined },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createSampler: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy: () => destroyedTextures.push(1) }),
      createBuffer: () => ({ destroy: () => undefined }),
      createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline: () => undefined, setBindGroup: () => undefined, setVertexBuffer: () => undefined, draw: () => undefined, end: () => undefined }), finish: () => ({}) }),
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
      const mask = new Uint8Array(1022 * 1022).fill(255);
      const glyph = (textureKey: string, nodeId: string): WebGpuTextGlyph => ({ textureKey, nodeId, x: 0, y: 0, width: 1022, height: 1022, rotation: 0, fill: "#000000", opacity: 1, maskWidth: 1022, maskHeight: 1022, alphaMask: mask });
      const firstFrame = [glyph("font:a", "first"), glyph("font:b", "second"), glyph("font:c", "third"), glyph("font:d", "fourth")];
      expect(renderer.render({ nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, width: 10, height: 10, dpr: 1, sceneKey: "four-pages", textGlyphs: firstFrame }).renderedNodeIds).toEqual(new Set(["first", "second", "third", "fourth"]));
      const replacement = renderer.render({ nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, width: 10, height: 10, dpr: 1, sceneKey: "new-page", textGlyphs: [glyph("font:replacement", "replacement")] });
      expect(replacement.renderedNodeIds).toEqual(new Set(["replacement"]));
      expect(replacement.textAtlas).toMatchObject({ pages: MAX_GPU_GLYPH_ATLAS_PAGES, entries: MAX_GPU_GLYPH_ATLAS_PAGES, evictions: 1, rejectedNodes: 0 });
      expect(destroyedTextures).toHaveLength(1);
      renderer.destroy();
      expect(destroyedTextures).toHaveLength(MAX_GPU_GLYPH_ATLAS_PAGES + 1);
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
      const initial = renderer.render(input);
      expect(initial.renderedNodeIds).toEqual(new Set([first.id, second.id]));
      expect(initial.imageTextures).toEqual({ textures: 1, bytes: 2_048, cacheHits: 1, uploads: 1, releases: 0 });
      expect(initial.effectTextures).toEqual({ textures: 0, bytes: 0, active: 0, cacheHits: 0, allocations: 0, evictions: 0, rejected: 0 });
      expect(renderer.render(input).gpuUploadBytes).toBe(GPU_CAMERA_UNIFORM_BYTES + 80);
      const retainedBetweenIslands = renderer.render({ ...input, nodes: [], sceneKey: "canvas-island" });
      expect(retainedBetweenIslands.imageTextures).toEqual({ textures: 1, bytes: 2_048, cacheHits: 0, uploads: 0, releases: 0 });
      const laterImageIsland = renderer.render({ ...input, nodes: [first], sceneKey: "later-image-island" });
      expect(laterImageIsland.imageTextures).toEqual({ textures: 1, bytes: 2_048, cacheHits: 1, uploads: 0, releases: 0 });
      const released = renderer.render({ ...input, nodes: [], imageBitmaps: new Map(), sceneKey: "images-removed" });
      expect(released.imageTextures).toEqual({ textures: 0, bytes: 0, cacheHits: 0, uploads: 0, releases: 1 });
      renderer.destroy();
      expect(textureWrites).toEqual([{ byteLength: 4_096, bytesPerRow: 256, width: 32, height: 16 }]);
      expect(draws).toEqual([6, 6, 6, 6, 6]);
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

      expect(created).toEqual([48, 32, 32, 16, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES]);
      expect(destroyed).toEqual([MIN_GPU_SCENE_VERTEX_BUFFER_BYTES, 48, 32, 32, 16]);
      expect(clearValues).toEqual([{ r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }]);
    } finally {
      if (original === undefined) delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: original });
    }
  });

  it("executes one zero-spread Inner Shadow through the bounded source/blur pair and composites it with source alpha", async () => {
    const draws: number[] = [];
    const blurUniforms: Float32Array[] = [];
    const innerUniforms: Float32Array[] = [];
    const context = { configure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const device = {
      lost: new Promise<unknown>(() => undefined),
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, data: Float32Array) => {
          if (data.length === 8) blurUniforms.push(data);
          if (data.length === 4) innerUniforms.push(data);
        },
        writeTexture: () => undefined,
        copyExternalImageToTexture: () => undefined,
        submit: () => undefined,
      },
      createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createBuffer: () => ({ destroy: () => undefined }), createSampler: () => ({}), createBindGroup: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy: () => undefined }),
      createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline: () => undefined, setBindGroup: () => undefined, setVertexBuffer: () => undefined, draw: (count: number) => draws.push(count), end: () => undefined }), finish: () => ({}) }),
    };
    const original = globalThis.OffscreenCanvas;
    class FakeOffscreenCanvas { width = 0; height = 0; getContext() { return context; } transferToImageBitmap() { return {} as ImageBitmap; } }
    Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: FakeOffscreenCanvas });
    try {
      const renderer = await WebGpuSceneRenderer.create({ gpu: { requestAdapter: async () => ({ requestDevice: async () => device }), getPreferredCanvasFormat: () => "bgra8unorm" } });
      const innerShadow = {
        ...createNode("rectangle", 4, 6), width: 40, height: 20,
        effectStack: [{ innerShadow: { offsetX: -2, offsetY: 3, blurRadius: 8, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true } }],
      };
      const result = renderer.render({ nodes: [innerShadow], viewport: { x: 0, y: 0, zoom: 1 }, width: 32, height: 16, dpr: 1, sceneKey: "inner-shadow" });
      expect(result.renderedNodeIds).toEqual(new Set([innerShadow.id]));
      expect(result.effectTextures).toMatchObject({ textures: 2, bytes: 4_096, allocations: 2, active: 0, rejected: 0 });
      expect(draws).toEqual([6, 6, 6]);
      expect(blurUniforms).toContainEqual(new Float32Array([8, 1 / 32, 1 / 16, 0, -2, 3, 0, 0]));
      expect(innerUniforms).toContainEqual(new Float32Array([0, 0, 0, 64 / 255]));
      renderer.destroy();
    } finally {
      if (original === undefined) delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: original });
    }
  });
});
