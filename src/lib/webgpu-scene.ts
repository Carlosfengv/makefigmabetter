import type { CanvasNode, Viewport } from "./editor-protocol";
import { resolveInsideRoundedRect } from "./rounded-rect";

const FLOATS_PER_VERTEX = 16;
const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;
const GPU_BUFFER_USAGE_VERTEX = 0x20;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_BUFFER_USAGE_UNIFORM = 0x40;
const GPU_TEXTURE_USAGE_COPY_DST = 0x02;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
const RGBA8_BYTES_PER_PIXEL = 4;
const SWAP_CHAIN_SURFACE_COUNT = 3;

/** Dedicated to the optional WebGPU scene, separate from the Canvas backing-store guard. */
export const MAX_GPU_SCENE_RESOURCE_BYTES = 256 * 1024 * 1024;
export const GPU_SCENE_VERTEX_BYTES_PER_NODE = 6 * FLOATS_PER_VERTEX * BYTES_PER_FLOAT;
export const MIN_GPU_SCENE_VERTEX_BUFFER_BYTES = 4 * 1024;

type GpuDevice = {
  readonly lost: Promise<unknown>;
  readonly queue: { writeBuffer(buffer: GpuBuffer, offset: number, data: Float32Array): void; writeTexture(destination: { texture: GpuTexture; origin?: { x: number; y: number; z?: number } }, data: Uint8Array, layout: { bytesPerRow: number; rowsPerImage: number }, copySize: { width: number; height: number; depthOrArrayLayers: number }): void; copyExternalImageToTexture(source: { source: ImageBitmap; premultipliedAlpha?: boolean }, destination: { texture: GpuTexture }, copySize: { width: number; height: number }): void; submit(commandBuffers: unknown[]): void };
  createShaderModule(descriptor: { code: string }): unknown;
  createRenderPipeline(descriptor: unknown): GpuRenderPipeline;
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createTexture(descriptor: { size: { width: number; height: number; depthOrArrayLayers: number }; format: string; usage: number }): GpuTexture;
  createSampler(descriptor: { magFilter: "linear"; minFilter: "linear" }): GpuSampler;
  createBindGroup(descriptor: { layout: unknown; entries: Array<{ binding: number; resource: unknown }> }): GpuBindGroup;
  createCommandEncoder(): GpuCommandEncoder;
  destroy?(): void;
};
type GpuAdapter = { requestDevice(): Promise<GpuDevice> };
type GpuNavigator = { gpu?: { requestAdapter(): Promise<GpuAdapter | null>; getPreferredCanvasFormat?(): string } };
type GpuBuffer = { destroy?(): void };
type GpuTexture = { createView(): unknown; destroy?(): void };
type GpuSampler = unknown;
type GpuBindGroup = unknown;
type GpuRenderPipeline = { getBindGroupLayout(index: number): unknown };
type GpuCanvasContext = { configure(configuration: { device: GpuDevice; format: string; alphaMode: "premultiplied" }): void; getCurrentTexture(): { createView(): unknown } };
type GpuCommandEncoder = { beginRenderPass(descriptor: unknown): GpuRenderPass; finish(): unknown };
type GpuRenderPass = { setPipeline(pipeline: GpuRenderPipeline): void; setBindGroup(index: number, group: GpuBindGroup): void; setVertexBuffer(slot: number, buffer: GpuBuffer, offset?: number, size?: number): void; draw(vertexCount: number, instanceCount?: number): void; end(): void };

export interface WebGpuSceneRenderInput {
  nodes: readonly CanvasNode[];
  viewport: Viewport;
  width: number;
  height: number;
  dpr: number;
  /** Changes only when canonical scene data or renderer generation changes. */
  sceneKey?: string | number;
  /** A Canonical Rust-derived solid-shape batch. Text/images retain dedicated
   * passes, while transient drags may omit this and use the local fallback. */
  precomputedInstances?: { instances: Float32Array; renderedNodeIds: ReadonlySet<string> };
  /** Decoded, worker-owned resources for the Image pass. Missing entries retain
   * the Canvas placeholder rather than allocating an untrusted GPU texture. */
  imageBitmaps?: ReadonlyMap<string, ImageBitmap>;
  /** Rasterized alpha masks produced by the Rust text boundary. Only explicit
   * single-face LTR runs opt into this pass; all other text remains Canvas. */
  textGlyphs?: readonly WebGpuTextGlyph[];
}

export interface WebGpuTextGlyph {
  /** Cache identity includes the immutable font resource, glyph id and size. */
  textureKey: string;
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: string;
  opacity: number;
  maskWidth: number;
  maskHeight: number;
  alphaMask: Uint8Array;
}

export interface WebGpuSceneRenderResult {
  bitmap: ImageBitmap;
  renderedNodeIds: ReadonlySet<string>;
  resourceBytes: number;
  gpuUploadBytes: number;
  imageBitmapMs: number;
}

/** World-space instance payload used by the next renderer pass. Camera state is
 * deliberately absent so a viewport change cannot invalidate this scene data. */
export const GPU_INSTANCE_FLOATS = 16;
export const GPU_IMAGE_INSTANCE_FLOATS = 10;
/** position/size, rotation, color and glyph-atlas UV rectangle. */
export const GPU_TEXT_INSTANCE_FLOATS = 13;
export const GPU_CAMERA_UNIFORM_BYTES = 32;
export const GPU_SCENE_INSTANCE_BYTES_PER_NODE = GPU_INSTANCE_FLOATS * BYTES_PER_FLOAT;
export const GPU_IMAGE_INSTANCE_BYTES_PER_NODE = GPU_IMAGE_INSTANCE_FLOATS * BYTES_PER_FLOAT;
export const GPU_TEXT_INSTANCE_BYTES_PER_NODE = GPU_TEXT_INSTANCE_FLOATS * BYTES_PER_FLOAT;
/** A single R8 texture avoids unbounded per-glyph WebGPU allocations. */
export const GPU_GLYPH_ATLAS_DIMENSION = 1024;
export const GPU_GLYPH_ATLAS_BYTES = GPU_GLYPH_ATLAS_DIMENSION * GPU_GLYPH_ATLAS_DIMENSION;
const GPU_GLYPH_ATLAS_PADDING = 1;
export interface GpuSceneCacheKey { documentRevision: number; rendererGeneration: number; colorProfile: string; }
export interface GpuCameraUniform { viewportX: number; viewportY: number; zoom: number; canvasWidth: number; canvasHeight: number; dpr: number; }

type GlyphAtlasEntry = { x: number; y: number; width: number; height: number };
type GpuGlyphAtlas = {
  texture: GpuTexture;
  bindGroup: GpuBindGroup;
  entries: Map<string, GlyphAtlasEntry>;
  nextX: number;
  nextY: number;
  rowHeight: number;
};

export function buildWebGpuInstances(nodes: readonly CanvasNode[]): { instances: Float32Array; renderedNodeIds: ReadonlySet<string> } {
  const renderable = nodes.filter(isGpuRenderable).filter((node) => Boolean(cssColor(node.fill, node.opacity)));
  const instances = new Float32Array(renderable.length * GPU_INSTANCE_FLOATS);
  const renderedNodeIds = new Set<string>();
  renderable.forEach((node, index) => {
    const offset = index * GPU_INSTANCE_FLOATS;
    const fill = cssColor(node.fill, node.opacity)!;
    const stroke = cssColor(node.stroke, node.opacity) ?? [0, 0, 0, 0];
    const geometry = resolveInsideRoundedRect(Math.abs(node.width), Math.abs(node.height), node.radius, node.strokeWidth);
    instances.set([node.x, node.y, node.width, node.height, node.rotation, node.kind === "ellipse" ? 1 : 0, geometry.outerRadius, stroke[3] > 0 ? geometry.insideStrokeWidth : 0, ...fill, ...stroke], offset);
    renderedNodeIds.add(node.id);
  });
  return { instances, renderedNodeIds };
}

export function cameraUniform(camera: GpuCameraUniform) {
  // Eight floats meet WebGPU's uniform alignment requirement without dynamic offsets.
  return new Float32Array([camera.viewportX, camera.viewportY, camera.zoom, camera.canvasWidth, camera.canvasHeight, camera.dpr, 0, 0]);
}

/** World geometry plus cover-crop texture rectangle for one Image pass draw. */
export function imageInstance(node: Pick<CanvasNode, "x" | "y" | "width" | "height" | "rotation" | "opacity">, bitmap: Pick<ImageBitmap, "width" | "height">): number[] {
  const nodeAspect = Math.abs(node.width) / Math.max(1, Math.abs(node.height));
  const bitmapAspect = bitmap.width / Math.max(1, bitmap.height);
  const [u, v, width, height] = bitmapAspect > nodeAspect
    ? [(1 - nodeAspect / bitmapAspect) / 2, 0, nodeAspect / bitmapAspect, 1]
    : [0, (1 - bitmapAspect / nodeAspect) / 2, 1, bitmapAspect / nodeAspect];
  return [node.x, node.y, node.width, node.height, node.rotation, u, v, width, height, node.opacity];
}

function rgbaPixelsForImageBitmap(source: ImageBitmap) {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("IMAGE_PIXEL_EXTRACTION_UNAVAILABLE");
  context.drawImage(source, 0, 0);
  return context.getImageData(0, 0, source.width, source.height).data;
}

function padTextureRows(pixels: Uint8ClampedArray, rowBytes: number, bytesPerRow: number, height: number) {
  const padded = new Uint8Array(bytesPerRow * height);
  for (let row = 0; row < height; row += 1) padded.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), row * bytesPerRow);
  return padded;
}

function isValidTextGlyph(glyph: WebGpuTextGlyph) {
  return Boolean(glyph.textureKey && glyph.nodeId)
    && Number.isSafeInteger(glyph.maskWidth) && glyph.maskWidth > 0
    && Number.isSafeInteger(glyph.maskHeight) && glyph.maskHeight > 0
    && glyph.alphaMask.byteLength === glyph.maskWidth * glyph.maskHeight
    && [glyph.x, glyph.y, glyph.width, glyph.height, glyph.rotation, glyph.opacity].every(Number.isFinite)
    && glyph.width > 0 && glyph.height > 0;
}

export type GpuSceneResourceAdmission =
  | { accepted: true; resourceBytes: number; framebufferBytes: number; vertexBytes: number; textureBytes: number; textAtlasBytes: number; renderableNodeCount: number }
  | { accepted: false; reason: "INVALID_SIZE" | "RESOURCE_LIMIT"; resourceBytes: number; maxBytes: number };

export class GpuSceneResourceLimitError extends Error {
  constructor(readonly admission: Extract<GpuSceneResourceAdmission, { accepted: false }>) {
    super(admission.reason);
    this.name = "GpuSceneResourceLimitError";
  }
}

/**
 * A real, bounded WebGPU scene. It renders solid Frame/Rectangle/Ellipse fills,
 * strokes and decoded ImageBitmap resources on an auxiliary OffscreenCanvas.
 * Canvas 2D retains the grid, text and unsupported paint overlay until the
 * Rust/wgpu render graph replaces it.
 */
export class WebGpuSceneRenderer {
  readonly deviceLost: Promise<unknown>;
  private readonly context: GpuCanvasContext;
  private readonly device: GpuDevice;
  private readonly format: string;
  private readonly canvas: OffscreenCanvas;
  private readonly pipeline: GpuRenderPipeline;
  private readonly imagePipeline: GpuRenderPipeline;
  private readonly textPipeline: GpuRenderPipeline;
  private readonly imageSampler: GpuSampler;
  private readonly unitQuadBuffer: GpuBuffer;
  private readonly cameraBuffer: GpuBuffer;
  private readonly cameraBindGroup: GpuBindGroup;
  private readonly imageCameraBindGroup: GpuBindGroup;
  private readonly textCameraBindGroup: GpuBindGroup;
  private instanceBuffer: GpuBuffer | undefined;
  private instanceCapacity = 0;
  private imageInstanceBuffer: GpuBuffer | undefined;
  private imageInstanceCapacity = 0;
  private textInstanceBuffer: GpuBuffer | undefined;
  private textInstanceCapacity = 0;
  private imageTextures = new Map<string, { source: ImageBitmap; width: number; height: number; texture: GpuTexture; bindGroup: GpuBindGroup }>();
  /** Derived, device-generation-local glyph cache. It intentionally contains
   * no Canonical document state and is discarded on renderer destruction. */
  private textAtlas: GpuGlyphAtlas | undefined;
  private cachedSceneKey: string | number | undefined;
  private hasCachedScene = false;
  private cachedInstanceCount = 0;
  private cachedRenderedNodeIds: ReadonlySet<string> = new Set();
  private pixelWidth = 0;
  private pixelHeight = 0;

  private constructor(canvas: OffscreenCanvas, context: GpuCanvasContext, device: GpuDevice, format: string) {
    this.canvas = canvas;
    this.context = context;
    this.device = device;
    this.format = format;
    this.deviceLost = device.lost;
    this.pipeline = createPipeline(device, format);
    this.imagePipeline = createImagePipeline(device, format);
    this.textPipeline = createTextPipeline(device, format);
    this.imageSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.unitQuadBuffer = device.createBuffer({ size: UNIT_QUAD.byteLength, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST });
    this.cameraBuffer = device.createBuffer({ size: GPU_CAMERA_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST });
    const cameraEntry = [{ binding: 0, resource: { buffer: this.cameraBuffer } }];
    // `layout: "auto"` creates pipeline-specific bind group layouts. Although
    // the Camera declaration is identical, a bind group from the shape
    // pipeline is not compatible with the Image/Text pipelines in WebGPU.
    this.cameraBindGroup = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: cameraEntry });
    this.imageCameraBindGroup = device.createBindGroup({ layout: this.imagePipeline.getBindGroupLayout(0), entries: cameraEntry });
    this.textCameraBindGroup = device.createBindGroup({ layout: this.textPipeline.getBindGroupLayout(0), entries: cameraEntry });
    this.device.queue.writeBuffer(this.unitQuadBuffer, 0, UNIT_QUAD);
  }

  static async create(navigatorLike: GpuNavigator = navigator as unknown as GpuNavigator): Promise<WebGpuSceneRenderer> {
    const gpu = navigatorLike.gpu;
    if (!gpu) throw new Error("WEBGPU_UNAVAILABLE");
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error("NO_WEBGPU_ADAPTER");
    const device = await adapter.requestDevice();
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("webgpu") as unknown as GpuCanvasContext | null;
    if (!context) {
      device.destroy?.();
      throw new Error("WEBGPU_CONTEXT_UNAVAILABLE");
    }
    return new WebGpuSceneRenderer(canvas, context, device, gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm");
  }

  render(input: WebGpuSceneRenderInput): WebGpuSceneRenderResult {
    const admission = admitWebGpuSceneResources(input);
    if (!admission.accepted) throw new GpuSceneResourceLimitError(admission);
    const pixelWidth = Math.max(1, Math.ceil(input.width * input.dpr));
    const pixelHeight = Math.max(1, Math.ceil(input.height * input.dpr));
    this.resize(pixelWidth, pixelHeight);
    const sceneChanged = !this.hasCachedScene || this.cachedSceneKey !== input.sceneKey;
    const sceneUploadBytes = sceneChanged ? this.uploadScene(input.nodes, input.sceneKey, input.precomputedInstances) : 0;
    const images = this.uploadImages(input.nodes, input.imageBitmaps);
    const text = this.uploadTextGlyphs(input.textGlyphs);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraUniform({ viewportX: input.viewport.x, viewportY: input.viewport.y, zoom: input.viewport.zoom, canvasWidth: input.width, canvasHeight: input.height, dpr: input.dpr }));
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        // The main Canvas owns the backdrop and grid. Keeping this auxiliary
        // scene transparent lets it composite above that background but below
        // Canvas 2D overlays without obscuring or receiving the grid.
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    if (this.cachedInstanceCount) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.cameraBindGroup);
      pass.setVertexBuffer(0, this.unitQuadBuffer);
      pass.setVertexBuffer(1, this.instanceBuffer!);
      pass.draw(6, this.cachedInstanceCount);
    }
    if (images.instances.length) {
      pass.setPipeline(this.imagePipeline);
      pass.setBindGroup(0, this.imageCameraBindGroup);
      pass.setVertexBuffer(0, this.unitQuadBuffer);
      for (const image of images.draws) {
        pass.setBindGroup(1, image.bindGroup);
        pass.setVertexBuffer(1, this.imageInstanceBuffer!, image.offset, GPU_IMAGE_INSTANCE_BYTES_PER_NODE);
        pass.draw(6);
      }
    }
    if (text.instances.length) {
      pass.setPipeline(this.textPipeline);
      pass.setBindGroup(0, this.textCameraBindGroup);
      pass.setVertexBuffer(0, this.unitQuadBuffer);
      for (const glyph of text.draws) {
        pass.setBindGroup(1, glyph.bindGroup);
        pass.setVertexBuffer(1, this.textInstanceBuffer!, glyph.offset, GPU_TEXT_INSTANCE_BYTES_PER_NODE);
        pass.draw(6);
      }
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    const transferStartedAt = performance.now();
    const bitmap = this.canvas.transferToImageBitmap();
    return { bitmap, renderedNodeIds: new Set([...this.cachedRenderedNodeIds, ...images.renderedNodeIds, ...text.renderedNodeIds]), resourceBytes: admission.resourceBytes, gpuUploadBytes: sceneUploadBytes + images.uploadBytes + text.uploadBytes + GPU_CAMERA_UNIFORM_BYTES, imageBitmapMs: performance.now() - transferStartedAt };
  }

  destroy() {
    this.releaseInstanceBuffer();
    this.releaseImageResources();
    this.unitQuadBuffer.destroy?.();
    this.cameraBuffer.destroy?.();
    this.device.destroy?.();
  }

  private resize(pixelWidth: number, pixelHeight: number) {
    if (this.pixelWidth === pixelWidth && this.pixelHeight === pixelHeight) return;
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.context.configure({ device: this.device, format: this.format, alphaMode: "premultiplied" });
  }

  private uploadScene(
    nodes: readonly CanvasNode[],
    key: string | number | undefined,
    precomputed: WebGpuSceneRenderInput["precomputedInstances"],
  ) {
    const { instances, renderedNodeIds } = precomputed ?? buildWebGpuInstances(nodes);
    this.cachedSceneKey = key;
    this.hasCachedScene = true;
    this.cachedInstanceCount = instances.length / GPU_INSTANCE_FLOATS;
    this.cachedRenderedNodeIds = renderedNodeIds;
    if (!instances.length) { this.releaseInstanceBuffer(); return 0; }
    this.ensureInstanceBuffer(instances.byteLength);
    this.device.queue.writeBuffer(this.instanceBuffer!, 0, instances);
    return instances.byteLength;
  }

  private ensureInstanceBuffer(requiredBytes: number) {
    const requiredCapacity = Math.max(requiredBytes, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES);
    if (this.instanceBuffer && this.instanceCapacity === requiredCapacity) return;
    this.releaseInstanceBuffer();
    // Exact sizing makes the admission estimate match the resource we request.
    this.instanceCapacity = requiredCapacity;
    this.instanceBuffer = this.device.createBuffer({ size: this.instanceCapacity, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST });
  }

  private releaseInstanceBuffer() {
    this.instanceBuffer?.destroy?.();
    this.instanceBuffer = undefined;
    this.instanceCapacity = 0;
  }

  private uploadImages(nodes: readonly CanvasNode[], imageBitmaps: WebGpuSceneRenderInput["imageBitmaps"]) {
    const instances: number[] = [];
    const draws: Array<{ bindGroup: GpuBindGroup; offset: number }> = [];
    const renderedNodeIds = new Set<string>();
    const requiredAssets = new Set<string>();
    let uploadBytes = 0;
    for (const node of nodes) {
      if (node.kind !== "image" || node.visible === false || !node.assetId) continue;
      const bitmap = imageBitmaps?.get(node.assetId);
      if (!bitmap || bitmap.width <= 0 || bitmap.height <= 0) continue;
      requiredAssets.add(node.assetId);
      const texture = this.ensureImageTexture(node.assetId, bitmap);
      if (texture.uploaded) uploadBytes += bitmap.width * bitmap.height * RGBA8_BYTES_PER_PIXEL;
      const offset = instances.length * BYTES_PER_FLOAT;
      instances.push(...imageInstance(node, bitmap));
      draws.push({ bindGroup: texture.entry.bindGroup, offset });
      renderedNodeIds.add(node.id);
    }
    for (const [assetId, entry] of this.imageTextures) {
      if (!requiredAssets.has(assetId)) { entry.texture.destroy?.(); this.imageTextures.delete(assetId); }
    }
    const payload = new Float32Array(instances);
    if (payload.length) {
      this.ensureImageInstanceBuffer(payload.byteLength);
      this.device.queue.writeBuffer(this.imageInstanceBuffer!, 0, payload);
    } else this.releaseImageInstanceBuffer();
    return { instances: payload, draws, renderedNodeIds, uploadBytes: uploadBytes + payload.byteLength };
  }

  private ensureImageTexture(assetId: string, source: ImageBitmap) {
    const current = this.imageTextures.get(assetId);
    if (current?.source === source && current.width === source.width && current.height === source.height) return { entry: current, uploaded: false };
    current?.texture.destroy?.();
    const texture = this.device.createTexture({ size: { width: source.width, height: source.height, depthOrArrayLayers: 1 }, format: "rgba8unorm", usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING });
    // Some browser/Worker combinations accept `copyExternalImageToTexture` but
    // leave the destination zeroed. Extracting the trusted ImageBitmap once and
    // using the portable writeTexture path keeps the sampled GPU texture exact.
    const pixels = rgbaPixelsForImageBitmap(source);
    const rowBytes = source.width * RGBA8_BYTES_PER_PIXEL;
    const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
    const upload = bytesPerRow === rowBytes
      ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
      : padTextureRows(pixels, rowBytes, bytesPerRow, source.height);
    this.device.queue.writeTexture({ texture }, upload, { bytesPerRow, rowsPerImage: source.height }, { width: source.width, height: source.height, depthOrArrayLayers: 1 });
    const entry = { source, width: source.width, height: source.height, texture, bindGroup: this.device.createBindGroup({ layout: this.imagePipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: this.imageSampler }] }) };
    this.imageTextures.set(assetId, entry);
    return { entry, uploaded: true };
  }

  private ensureImageInstanceBuffer(requiredBytes: number) {
    const capacity = Math.max(requiredBytes, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES);
    if (this.imageInstanceBuffer && this.imageInstanceCapacity === capacity) return;
    this.releaseImageInstanceBuffer();
    this.imageInstanceCapacity = capacity;
    this.imageInstanceBuffer = this.device.createBuffer({ size: capacity, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST });
  }

  private releaseImageInstanceBuffer() {
    this.imageInstanceBuffer?.destroy?.();
    this.imageInstanceBuffer = undefined;
    this.imageInstanceCapacity = 0;
  }

  private uploadTextGlyphs(glyphs: WebGpuSceneRenderInput["textGlyphs"]) {
    const instances: number[] = [];
    const draws: Array<{ bindGroup: GpuBindGroup; offset: number }> = [];
    const renderedNodeIds = new Set<string>();
    let uploadBytes = 0;
    const glyphsByNode = new Map<string, WebGpuTextGlyph[]>();
    for (const glyph of glyphs ?? []) {
      if (!isValidTextGlyph(glyph) || !cssColor(glyph.fill, glyph.opacity)) continue;
      const group = glyphsByNode.get(glyph.nodeId) ?? [];
      group.push(glyph);
      glyphsByNode.set(glyph.nodeId, group);
    }
    // A node is all-GPU or all-Canvas. This prevents a full Canvas fallback
    // from double-painting the subset of glyphs that fit in the atlas.
    for (const [nodeId, nodeGlyphs] of glyphsByNode) {
      const nodeInstances: number[] = [];
      const nodeDraws: Array<{ bindGroup: GpuBindGroup; offset: number }> = [];
      let nodeUploadBytes = 0;
      let complete = true;
      for (const glyph of nodeGlyphs) {
        const atlas = this.ensureTextAtlasEntry(glyph);
        if (!atlas) { complete = false; break; }
        const color = cssColor(glyph.fill, glyph.opacity)!;
        if (atlas.uploaded) nodeUploadBytes += glyph.alphaMask.byteLength;
        const offset = (instances.length + nodeInstances.length) * BYTES_PER_FLOAT;
        nodeInstances.push(
          glyph.x, glyph.y, glyph.width, glyph.height, glyph.rotation, ...color,
          atlas.entry.x / GPU_GLYPH_ATLAS_DIMENSION,
          atlas.entry.y / GPU_GLYPH_ATLAS_DIMENSION,
          atlas.entry.width / GPU_GLYPH_ATLAS_DIMENSION,
          atlas.entry.height / GPU_GLYPH_ATLAS_DIMENSION,
        );
        nodeDraws.push({ bindGroup: this.textAtlas!.bindGroup, offset });
      }
      if (!complete) continue;
      instances.push(...nodeInstances);
      draws.push(...nodeDraws);
      uploadBytes += nodeUploadBytes;
      renderedNodeIds.add(nodeId);
    }
    const payload = new Float32Array(instances);
    if (payload.length) {
      this.ensureTextInstanceBuffer(payload.byteLength);
      this.device.queue.writeBuffer(this.textInstanceBuffer!, 0, payload);
    } else this.releaseTextInstanceBuffer();
    return { instances: payload, draws, renderedNodeIds, uploadBytes: uploadBytes + payload.byteLength };
  }

  private ensureTextAtlasEntry(glyph: WebGpuTextGlyph): { entry: GlyphAtlasEntry; uploaded: boolean } | undefined {
    const allocatedWidth = glyph.maskWidth + GPU_GLYPH_ATLAS_PADDING * 2;
    const allocatedHeight = glyph.maskHeight + GPU_GLYPH_ATLAS_PADDING * 2;
    if (allocatedWidth > GPU_GLYPH_ATLAS_DIMENSION || allocatedHeight > GPU_GLYPH_ATLAS_DIMENSION) return undefined;
    const atlas = this.textAtlas ?? this.createTextAtlas();
    const current = atlas.entries.get(glyph.textureKey);
    if (current && current.width === glyph.maskWidth && current.height === glyph.maskHeight) return { entry: current, uploaded: false };
    // A cache key is immutable font/glyph/size identity. A key that changes
    // dimensions is rejected rather than mutating an already drawn atlas cell.
    if (current) return undefined;
    if (atlas.nextX + allocatedWidth > GPU_GLYPH_ATLAS_DIMENSION) {
      atlas.nextX = 0;
      atlas.nextY += atlas.rowHeight;
      atlas.rowHeight = 0;
    }
    if (atlas.nextY + allocatedHeight > GPU_GLYPH_ATLAS_DIMENSION) return undefined;
    const entry = {
      x: atlas.nextX + GPU_GLYPH_ATLAS_PADDING,
      y: atlas.nextY + GPU_GLYPH_ATLAS_PADDING,
      width: glyph.maskWidth,
      height: glyph.maskHeight,
    };
    atlas.nextX += allocatedWidth;
    atlas.rowHeight = Math.max(atlas.rowHeight, allocatedHeight);
    const bytesPerRow = Math.ceil(glyph.maskWidth / 256) * 256;
    const padded = new Uint8Array(bytesPerRow * glyph.maskHeight);
    for (let row = 0; row < glyph.maskHeight; row += 1) {
      padded.set(glyph.alphaMask.subarray(row * glyph.maskWidth, (row + 1) * glyph.maskWidth), row * bytesPerRow);
    }
    this.device.queue.writeTexture({ texture: atlas.texture, origin: { x: entry.x, y: entry.y, z: 0 } }, padded, { bytesPerRow, rowsPerImage: glyph.maskHeight }, { width: glyph.maskWidth, height: glyph.maskHeight, depthOrArrayLayers: 1 });
    atlas.entries.set(glyph.textureKey, entry);
    return { entry, uploaded: true };
  }

  private createTextAtlas(): GpuGlyphAtlas {
    const texture = this.device.createTexture({ size: { width: GPU_GLYPH_ATLAS_DIMENSION, height: GPU_GLYPH_ATLAS_DIMENSION, depthOrArrayLayers: 1 }, format: "r8unorm", usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING });
    const atlas = {
      texture,
      bindGroup: this.device.createBindGroup({ layout: this.textPipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: this.imageSampler }] }),
      entries: new Map<string, GlyphAtlasEntry>(),
      nextX: 0,
      nextY: 0,
      rowHeight: 0,
    };
    this.textAtlas = atlas;
    return atlas;
  }

  private ensureTextInstanceBuffer(requiredBytes: number) {
    const capacity = Math.max(requiredBytes, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES);
    if (this.textInstanceBuffer && this.textInstanceCapacity === capacity) return;
    this.releaseTextInstanceBuffer();
    this.textInstanceCapacity = capacity;
    this.textInstanceBuffer = this.device.createBuffer({ size: capacity, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST });
  }

  private releaseTextInstanceBuffer() {
    this.textInstanceBuffer?.destroy?.();
    this.textInstanceBuffer = undefined;
    this.textInstanceCapacity = 0;
  }

  private releaseTextResources() {
    this.releaseTextInstanceBuffer();
    this.textAtlas?.texture.destroy?.();
    this.textAtlas = undefined;
  }

  private releaseImageResources() {
    this.releaseImageInstanceBuffer();
    this.imageTextures.forEach((entry) => entry.texture.destroy?.());
    this.imageTextures.clear();
    this.releaseTextResources();
  }
}

/** Estimates all resources before vertex-array allocation or GPU configuration. */
export function admitWebGpuSceneResources(
  input: Pick<WebGpuSceneRenderInput, "nodes" | "width" | "height" | "dpr" | "imageBitmaps" | "textGlyphs">,
  maxBytes = MAX_GPU_SCENE_RESOURCE_BYTES,
): GpuSceneResourceAdmission {
  const pixelWidth = Math.ceil(input.width * input.dpr);
  const pixelHeight = Math.ceil(input.height * input.dpr);
  if (!Number.isSafeInteger(pixelWidth) || !Number.isSafeInteger(pixelHeight) || pixelWidth <= 0 || pixelHeight <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return { accepted: false, reason: "INVALID_SIZE", resourceBytes: 0, maxBytes };
  }
  const renderableNodeCount = input.nodes.filter(isGpuRenderable).filter((node) => Boolean(cssColor(node.fill, node.opacity))).length;
  const framebufferBytes = pixelWidth * pixelHeight * RGBA8_BYTES_PER_PIXEL * SWAP_CHAIN_SURFACE_COUNT;
  const vertexBytes = renderableNodeCount
    ? Math.max(renderableNodeCount * GPU_SCENE_INSTANCE_BYTES_PER_NODE, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES)
    : 0;
  const imageAssetIds = new Set(input.nodes
    .filter((node) => node.kind === "image" && node.visible !== false && Boolean(node.assetId))
    .map((node) => node.assetId!));
  const imageTextureBytes = [...imageAssetIds].reduce((total, assetId) => {
    const bitmap = input.imageBitmaps?.get(assetId);
    return total + (bitmap ? bitmap.width * bitmap.height * RGBA8_BYTES_PER_PIXEL : 0);
  }, 0);
  const imageInstanceCount = input.nodes.filter((node) => node.kind === "image" && node.visible !== false && node.assetId && input.imageBitmaps?.has(node.assetId)).length;
  // Match ensureImageInstanceBuffer: a non-empty Image pass owns at least one
  // 4 KiB allocation even when its instance payload is much smaller.
  const imageInstanceBytes = imageInstanceCount
    ? Math.max(imageInstanceCount * GPU_IMAGE_INSTANCE_BYTES_PER_NODE, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES)
    : 0;
  const textInstanceCount = (input.textGlyphs ?? []).filter(isValidTextGlyph).length;
  // The Text pass has one bounded, derived R8 texture per renderer generation,
  // not an unbounded texture per glyph. It is cleared with the device.
  const textAtlasBytes = textInstanceCount ? GPU_GLYPH_ATLAS_BYTES : 0;
  const textureBytes = imageTextureBytes + textAtlasBytes;
  const textInstanceBytes = textInstanceCount
    ? Math.max(textInstanceCount * GPU_TEXT_INSTANCE_BYTES_PER_NODE, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES)
    : 0;
  const resourceBytes = framebufferBytes + vertexBytes + textureBytes + imageInstanceBytes + textInstanceBytes;
  if (!Number.isSafeInteger(framebufferBytes) || !Number.isSafeInteger(vertexBytes) || !Number.isSafeInteger(textureBytes) || !Number.isSafeInteger(textAtlasBytes) || !Number.isSafeInteger(imageInstanceBytes) || !Number.isSafeInteger(textInstanceBytes) || !Number.isSafeInteger(resourceBytes) || resourceBytes > maxBytes) {
    return { accepted: false, reason: "RESOURCE_LIMIT", resourceBytes: Number.isSafeInteger(resourceBytes) ? resourceBytes : Number.MAX_SAFE_INTEGER, maxBytes };
  }
  return { accepted: true, resourceBytes, framebufferBytes, vertexBytes, textureBytes, textAtlasBytes, renderableNodeCount };
}

export function buildWebGpuVertices(input: WebGpuSceneRenderInput): { vertices: Float32Array; renderedNodeIds: ReadonlySet<string> } {
  const values: number[] = [];
  const renderedNodeIds = new Set<string>();
  const pixelWidth = Math.max(1, Math.ceil(input.width * input.dpr));
  const pixelHeight = Math.max(1, Math.ceil(input.height * input.dpr));
  for (const node of input.nodes) {
    if (!isGpuRenderable(node)) continue;
    const fill = cssColor(node.fill, node.opacity);
    if (!fill) continue;
    const stroke = cssColor(node.stroke, node.opacity) ?? [0, 0, 0, 0];
    const nodePixelWidth = Math.abs(node.width * input.viewport.zoom);
    const nodePixelHeight = Math.abs(node.height * input.viewport.zoom);
    const size = Math.max(1, Math.min(nodePixelWidth, nodePixelHeight));
    const geometry = resolveInsideRoundedRect(nodePixelWidth, nodePixelHeight, node.radius * input.viewport.zoom, node.strokeWidth * input.viewport.zoom);
    const insideStrokeWidth = stroke[3] > 0 ? geometry.insideStrokeWidth : 0;
    const parameters: [number, number, number, number] = [
      node.kind === "ellipse" ? 1 : 0,
      geometry.outerRadius / size,
      insideStrokeWidth / size,
      nodePixelHeight > 0 ? nodePixelWidth / nodePixelHeight : 1,
    ];
    appendQuad(values, node, input.viewport, pixelWidth, pixelHeight, input.dpr, fill, stroke, parameters);
    renderedNodeIds.add(node.id);
  }
  return { vertices: new Float32Array(values), renderedNodeIds };
}

function isGpuRenderable(node: CanvasNode): boolean {
  // Images must enter only the texture-backed Image pass. Rendering their
  // fallback fill in the solid-shape batch would suppress Canvas's placeholder
  // before a trusted bitmap has decoded.
  return node.visible !== false && node.kind !== "text" && node.kind !== "image" && !node.fillGradient && !node.strokeGradient;
}

function appendQuad(
  values: number[],
  node: CanvasNode,
  viewport: Viewport,
  pixelWidth: number,
  pixelHeight: number,
  dpr: number,
  fill: number[],
  stroke: number[],
  parameters: [number, number, number, number],
) {
  const triangles: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [0, 1], [1, 0], [1, 1]];
  for (const local of triangles) {
    const point = screenPoint(node, viewport, local[0], local[1], pixelWidth / dpr, pixelHeight / dpr);
    const x = point.x * dpr / pixelWidth * 2 - 1;
    const y = 1 - point.y * dpr / pixelHeight * 2;
    values.push(x, y, local[0], local[1], ...fill, ...stroke, ...parameters);
  }
}

function screenPoint(node: CanvasNode, viewport: Viewport, localX: number, localY: number, width: number, height: number) {
  const x = node.x + node.width * localX;
  const y = node.y + node.height * localY;
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const radians = node.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotatedX = centerX + (x - centerX) * cosine - (y - centerY) * sine;
  const rotatedY = centerY + (x - centerX) * sine + (y - centerY) * cosine;
  return { x: (rotatedX + viewport.x) * viewport.zoom + width / 2, y: (rotatedY + viewport.y) * viewport.zoom + height / 2 };
}

function cssColor(value: string, opacity: number): [number, number, number, number] | undefined {
  if (value === "transparent") return [0, 0, 0, 0];
  const hex = value.startsWith("#") ? value.slice(1) : "";
  const expanded = hex.length === 3 || hex.length === 4 ? [...hex].map((part) => part + part).join("") : hex;
  if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(expanded)) return undefined;
  const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
  return [Number.parseInt(expanded.slice(0, 2), 16) / 255, Number.parseInt(expanded.slice(2, 4), 16) / 255, Number.parseInt(expanded.slice(4, 6), 16) / 255, alpha * opacity];
}

function createPipeline(device: GpuDevice, format: string): GpuRenderPipeline {
  const shaderModule = device.createShaderModule({ code: WGSL });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 2 * BYTES_PER_FLOAT,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },
        ],
      }, {
        arrayStride: GPU_INSTANCE_FLOATS * BYTES_PER_FLOAT,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 1, offset: 0, format: "float32x4" },
          { shaderLocation: 2, offset: 4 * BYTES_PER_FLOAT, format: "float32x4" },
          { shaderLocation: 3, offset: 8 * BYTES_PER_FLOAT, format: "float32x4" },
          { shaderLocation: 4, offset: 12 * BYTES_PER_FLOAT, format: "float32x4" },
        ],
      }],
    },
    fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] },
    primitive: { topology: "triangle-list" },
  });
}

function createImagePipeline(device: GpuDevice, format: string): GpuRenderPipeline {
  const shaderModule = device.createShaderModule({ code: IMAGE_WGSL });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 2 * BYTES_PER_FLOAT,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
      }, {
        arrayStride: GPU_IMAGE_INSTANCE_FLOATS * BYTES_PER_FLOAT,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 1, offset: 0, format: "float32x4" },
          { shaderLocation: 2, offset: 4 * BYTES_PER_FLOAT, format: "float32" },
          { shaderLocation: 3, offset: 5 * BYTES_PER_FLOAT, format: "float32x4" },
          { shaderLocation: 4, offset: 9 * BYTES_PER_FLOAT, format: "float32" },
        ],
      }],
    },
    fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] },
    primitive: { topology: "triangle-list" },
  });
}

function createTextPipeline(device: GpuDevice, format: string): GpuRenderPipeline {
  const shaderModule = device.createShaderModule({ code: TEXT_WGSL });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 2 * BYTES_PER_FLOAT,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
      }, {
        arrayStride: GPU_TEXT_INSTANCE_FLOATS * BYTES_PER_FLOAT,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 1, offset: 0, format: "float32x4" },
          { shaderLocation: 2, offset: 4 * BYTES_PER_FLOAT, format: "float32" },
          { shaderLocation: 3, offset: 5 * BYTES_PER_FLOAT, format: "float32x4" },
          { shaderLocation: 4, offset: 9 * BYTES_PER_FLOAT, format: "float32x4" },
        ],
      }],
    },
    fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] },
    primitive: { topology: "triangle-list" },
  });
}

const WGSL = /* wgsl */ `
struct VertexInput {
  @location(0) local: vec2<f32>, @location(1) position_size: vec4<f32>,
  @location(2) rotation_params: vec4<f32>, @location(3) fill: vec4<f32>, @location(4) stroke: vec4<f32>,
};
struct Camera { first: vec4<f32>, second: vec4<f32>, };
@group(0) @binding(0) var<uniform> camera: Camera;
struct VertexOutput {
  @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32>,
  @location(1) fill: vec4<f32>, @location(2) stroke: vec4<f32>, @location(3) params: vec4<f32>,
};
@vertex fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let size = input.position_size.zw;
  let center = size * 0.5;
  let radians = input.rotation_params.x * 0.01745329252;
  let cosine = cos(radians); let sine = sin(radians);
  let local_point = input.local * size - center;
  let world = input.position_size.xy + center + vec2<f32>(local_point.x * cosine - local_point.y * sine, local_point.x * sine + local_point.y * cosine);
  let screen = (world + camera.first.xy) * camera.first.z + vec2<f32>(camera.first.w * 0.5, camera.second.x * 0.5);
  output.position = vec4<f32>(screen.x / camera.first.w * 2.0 - 1.0, 1.0 - screen.y / camera.second.x * 2.0, 0.0, 1.0);
  let smallest = max(1.0, min(abs(size.x), abs(size.y)));
  output.local = input.local; output.fill = input.fill; output.stroke = input.stroke;
  output.params = vec4<f32>(input.rotation_params.y, input.rotation_params.z / smallest, input.rotation_params.w / smallest, abs(size.x) / max(1.0, abs(size.y)));
  return output;
}
fn rounded_box_distance(point: vec2<f32>, half_extent: vec2<f32>, radius: f32) -> f32 {
  let q = abs(point) - (half_extent - vec2<f32>(radius));
  return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (input.params.x > 0.5) {
    let aspect = max(input.params.w, 0.0001);
    let extent = select(vec2<f32>(1.0, 1.0 / aspect), vec2<f32>(aspect, 1.0), aspect >= 1.0);
    let outer_half_extent = extent * 0.5;
    let point = (input.local - vec2<f32>(0.5)) * extent;
    let outer_distance = length(point / outer_half_extent) - 1.0;
    if (outer_distance > 0.0) { discard; }
    if (input.params.z > 0.0) {
      let inner_half_extent = max(outer_half_extent - vec2<f32>(input.params.z), vec2<f32>(0.0001));
      let inner_distance = length(point / inner_half_extent) - 1.0;
      if (inner_distance > 0.0) { return input.stroke; }
    }
    return input.fill;
  } else {
    let aspect = max(input.params.w, 0.0001);
    let scale = select(vec2<f32>(1.0, 1.0 / aspect), vec2<f32>(aspect, 1.0), aspect >= 1.0);
    let distance = rounded_box_distance((input.local - vec2<f32>(0.5)) * scale, vec2<f32>(0.5) * scale, min(input.params.y, 0.5));
    if (distance > 0.0) { discard; }
    if (input.params.z > 0.0 && distance > -input.params.z) { return input.stroke; }
    return input.fill;
  }
}`;

const IMAGE_WGSL = /* wgsl */ `
struct VertexInput {
  @location(0) local: vec2<f32>, @location(1) position_size: vec4<f32>,
  @location(2) rotation_degrees: f32, @location(3) uv_rect: vec4<f32>, @location(4) opacity: f32,
};
struct Camera { first: vec4<f32>, second: vec4<f32>, };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var image_texture: texture_2d<f32>;
@group(1) @binding(1) var image_sampler: sampler;
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) opacity: f32, };
@vertex fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let size = input.position_size.zw;
  let center = size * 0.5;
  let radians = input.rotation_degrees * 0.01745329252;
  let cosine = cos(radians); let sine = sin(radians);
  let local_point = input.local * size - center;
  let world = input.position_size.xy + center + vec2<f32>(local_point.x * cosine - local_point.y * sine, local_point.x * sine + local_point.y * cosine);
  let screen = (world + camera.first.xy) * camera.first.z + vec2<f32>(camera.first.w * 0.5, camera.second.x * 0.5);
  output.position = vec4<f32>(screen.x / camera.first.w * 2.0 - 1.0, 1.0 - screen.y / camera.second.x * 2.0, 0.0, 1.0);
  output.uv = input.uv_rect.xy + input.local * input.uv_rect.zw;
  output.opacity = input.opacity;
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> { let sample = textureSample(image_texture, image_sampler, input.uv); return vec4<f32>(sample.rgb, sample.a * input.opacity); }
`;

const TEXT_WGSL = /* wgsl */ `
struct VertexInput {
  @location(0) local: vec2<f32>, @location(1) position_size: vec4<f32>,
  @location(2) rotation_degrees: f32, @location(3) color: vec4<f32>, @location(4) atlas_uv_rect: vec4<f32>,
};
struct Camera { first: vec4<f32>, second: vec4<f32>, };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var glyph_mask: texture_2d<f32>;
@group(1) @binding(1) var glyph_sampler: sampler;
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) color: vec4<f32>, };
@vertex fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let size = input.position_size.zw;
  let center = size * 0.5;
  let radians = input.rotation_degrees * 0.01745329252;
  let cosine = cos(radians); let sine = sin(radians);
  let local_point = input.local * size - center;
  let world = input.position_size.xy + center + vec2<f32>(local_point.x * cosine - local_point.y * sine, local_point.x * sine + local_point.y * cosine);
  let screen = (world + camera.first.xy) * camera.first.z + vec2<f32>(camera.first.w * 0.5, camera.second.x * 0.5);
  output.position = vec4<f32>(screen.x / camera.first.w * 2.0 - 1.0, 1.0 - screen.y / camera.second.x * 2.0, 0.0, 1.0);
  output.uv = input.atlas_uv_rect.xy + input.local * input.atlas_uv_rect.zw; output.color = input.color;
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let alpha = textureSample(glyph_mask, glyph_sampler, input.uv).r * input.color.a;
  return vec4<f32>(input.color.rgb, alpha);
}
`;

const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
