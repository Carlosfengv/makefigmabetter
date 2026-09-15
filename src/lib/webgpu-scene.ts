import type { CanvasNode, Viewport } from "./editor-protocol";
import { closedShapeStrokeLocalBounds } from "./closed-shape-stroke-bounds";
import { colorToSrgbBytes, colorToSrgbCss } from "./color-rendering";
import { isGpuDropShadowEffectNode, isGpuInnerShadowEffectNode, isGpuLayerBlurEffectNode, isGpuSimpleEffectNode } from "./gpu-layer-prefix";
import { normalizedNodeEffects } from "./normalized-node-view";
import { resolveInsideRoundedRect } from "./rounded-rect";

const FLOATS_PER_VERTEX = 16;
const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;
const GPU_BUFFER_USAGE_VERTEX = 0x20;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_BUFFER_USAGE_UNIFORM = 0x40;
const GPU_TEXTURE_USAGE_COPY_DST = 0x02;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
const GPU_TEXTURE_USAGE_COPY_SRC = 0x01;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
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
  addEventListener?(type: "uncapturederror", listener: (event: { error?: unknown }) => void): void;
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
  /** Rasterized alpha masks produced by the Rust text boundary. Horizontal
   * Text and path-tangent TextPath runs may select a distinct font resource,
   * raster scale and rotation per glyph; unsupported paint semantics remain Canvas. */
  textGlyphs?: readonly WebGpuTextGlyph[];
}

export interface WebGpuTextGlyph {
  /** Cache identity includes the immutable font resource, face/axes, synthetic
   * weight/italic style, glyph id and raster size. */
  textureKey: string;
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** Optional normalized-quad → world transform. When present, WebGPU maps
   * the glyph mask's unit square through this complete affine. */
  quadTransform?: Readonly<{ a: number; b: number; c: number; d: number; e: number; f: number }>;
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
  imageTextures: WebGpuImageTextureStats;
  textAtlas: WebGpuTextAtlasStats;
  effectTextures: WebGpuEffectTextureStats;
}

/** Per-frame cache evidence. These counters are presentation-only and never
 * enter a Snapshot or operation payload. */
export interface WebGpuTextAtlasStats {
  pages: number;
  bytes: number;
  entries: number;
  cacheHits: number;
  uploads: number;
  evictions: number;
  rejectedNodes: number;
}

/** Per-frame evidence for the bounded, per-asset Image texture cache. */
export interface WebGpuImageTextureStats {
  textures: number;
  bytes: number;
  cacheHits: number;
  uploads: number;
  releases: number;
}

/** World-space instance payload used by the next renderer pass. Camera state is
 * deliberately absent so a viewport change cannot invalidate this scene data. */
export const GPU_INSTANCE_FLOATS = 16;
export const GPU_IMAGE_INSTANCE_FLOATS = 10;
/** normalized-quad origin/bases, color and glyph-atlas UV rectangle. */
export const GPU_TEXT_INSTANCE_FLOATS = 14;
export const GPU_CAMERA_UNIFORM_BYTES = 32;
export const GPU_SCENE_INSTANCE_BYTES_PER_NODE = GPU_INSTANCE_FLOATS * BYTES_PER_FLOAT;
export const GPU_IMAGE_INSTANCE_BYTES_PER_NODE = GPU_IMAGE_INSTANCE_FLOATS * BYTES_PER_FLOAT;
export const GPU_TEXT_INSTANCE_BYTES_PER_NODE = GPU_TEXT_INSTANCE_FLOATS * BYTES_PER_FLOAT;
/** A single R8 texture avoids unbounded per-glyph WebGPU allocations. */
export const GPU_GLYPH_ATLAS_DIMENSION = 1024;
export const GPU_GLYPH_ATLAS_BYTES = GPU_GLYPH_ATLAS_DIMENSION * GPU_GLYPH_ATLAS_DIMENSION;
/** A bounded page set keeps a full first atlas from permanently disabling GPU text. */
export const MAX_GPU_GLYPH_ATLAS_PAGES = 4;
/**
 * E1's offscreen effects are allowed two 128 MiB RGBA8 surfaces.  The pool is
 * renderer-local, never serialized, and makes the budget visible before an
 * effect pass can allocate an unbounded chain of temporary textures.
 */
export const MAX_GPU_EFFECT_TEXTURE_BYTES = 256 * 1024 * 1024;
export const MAX_GPU_EFFECT_SURFACE_BYTES = 128 * 1024 * 1024;
const GPU_GLYPH_ATLAS_PADDING = 1;
const GPU_EFFECT_BLUR_UNIFORM_BYTES = 32;
const GPU_EFFECT_INNER_SHADOW_UNIFORM_BYTES = 16;
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
  /** Monotonic renderer-local LRU marker. Atlas contents are derived only. */
  lastUsed: number;
};

type GpuEffectTextureEntry = {
  texture: GpuTexture;
  width: number;
  height: number;
  bytes: number;
  /** A texture may never be evicted while a render pass in this frame owns it. */
  inUse: boolean;
  /** Renderer-local LRU marker; no document state is retained here. */
  lastUsed: number;
};

export interface WebGpuEffectTextureStats {
  textures: number;
  bytes: number;
  active: number;
  cacheHits: number;
  allocations: number;
  evictions: number;
  rejected: number;
}

/**
 * Bounded RGBA8 offscreen surfaces for E1.  The pool is deliberately separate
 * from the scene/image caches: temporary blur and blend passes have a very
 * different lifetime, so sharing a cache would make frame-local resources
 * evict decoded image assets or vice versa.
 *
 * `beginFrame` / `endFrame` form a small ownership protocol.  Entries acquired
 * in a frame stay pinned until `endFrame`; only idle entries can be evicted to
 * make room for a differently sized surface in a later frame.
 */
export class WebGpuEffectTexturePool {
  private entries: GpuEffectTextureEntry[] = [];
  private tick = 0;
  private frameOpen = false;
  private frameCacheHits = 0;
  private frameAllocations = 0;
  private frameEvictions = 0;
  private frameRejected = 0;

  constructor(private readonly device: GpuDevice, private readonly maxBytes = MAX_GPU_EFFECT_TEXTURE_BYTES) {}

  beginFrame() {
    if (this.frameOpen) throw new Error("EFFECT_TEXTURE_FRAME_ALREADY_OPEN");
    this.frameOpen = true;
    this.frameCacheHits = 0;
    this.frameAllocations = 0;
    this.frameEvictions = 0;
    this.frameRejected = 0;
  }

  /** Acquires one exact-size RGBA8 surface, or returns undefined on budget rejection. */
  acquire(width: number, height: number): GpuTexture | undefined {
    if (!this.frameOpen) throw new Error("EFFECT_TEXTURE_FRAME_NOT_OPEN");
    const bytes = effectTextureBytes(width, height);
    if (bytes === undefined || bytes > MAX_GPU_EFFECT_SURFACE_BYTES || bytes > this.maxBytes) {
      this.frameRejected += 1;
      return undefined;
    }
    const reusable = this.entries.find((entry) => !entry.inUse && entry.width === width && entry.height === height);
    if (reusable) {
      reusable.inUse = true;
      reusable.lastUsed = ++this.tick;
      this.frameCacheHits += 1;
      return reusable.texture;
    }
    this.evictIdleUntil(bytes);
    if (this.totalBytes() + bytes > this.maxBytes) {
      this.frameRejected += 1;
      return undefined;
    }
    const texture = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    });
    this.entries.push({ texture, width, height, bytes, inUse: true, lastUsed: ++this.tick });
    this.frameAllocations += 1;
    return texture;
  }

  endFrame(): WebGpuEffectTextureStats {
    if (!this.frameOpen) throw new Error("EFFECT_TEXTURE_FRAME_NOT_OPEN");
    this.entries.forEach((entry) => { entry.inUse = false; });
    this.frameOpen = false;
    return this.stats();
  }

  /** Releases frame ownership after a failed command build without discarding
   * reusable derived textures. The next frame may safely try again. */
  cancelFrame() {
    if (!this.frameOpen) return;
    this.entries.forEach((entry) => { entry.inUse = false; });
    this.frameOpen = false;
  }

  stats(): WebGpuEffectTextureStats {
    return {
      textures: this.entries.length,
      bytes: this.totalBytes(),
      active: this.entries.filter((entry) => entry.inUse).length,
      cacheHits: this.frameCacheHits,
      allocations: this.frameAllocations,
      evictions: this.frameEvictions,
      rejected: this.frameRejected,
    };
  }

  destroy() {
    this.entries.forEach((entry) => entry.texture.destroy?.());
    this.entries = [];
    this.frameOpen = false;
  }

  private evictIdleUntil(requiredBytes: number) {
    while (this.totalBytes() + requiredBytes > this.maxBytes) {
      const evictionIndex = this.entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => !entry.inUse)
        .sort((a, b) => a.entry.lastUsed - b.entry.lastUsed)[0]?.index;
      if (evictionIndex === undefined) return;
      const [evicted] = this.entries.splice(evictionIndex, 1);
      evicted?.texture.destroy?.();
      this.frameEvictions += 1;
    }
  }

  private totalBytes() {
    return this.entries.reduce((total, entry) => total + entry.bytes, 0);
  }
}

function effectTextureBytes(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return undefined;
  const bytes = width * height * RGBA8_BYTES_PER_PIXEL;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

export function buildWebGpuInstances(nodes: readonly CanvasNode[]): { instances: Float32Array; renderedNodeIds: ReadonlySet<string> } {
  const renderable = nodes.filter(isGpuRenderable).filter((node) => Boolean(cssColor(node.fill, node.opacity)));
  const instances = new Float32Array(renderable.length * GPU_INSTANCE_FLOATS);
  const renderedNodeIds = new Set<string>();
  renderable.forEach((node, index) => {
    const offset = index * GPU_INSTANCE_FLOATS;
    const fill = cssColor(node.fill, node.opacity)!;
    const stroke = cssColor(node.stroke, node.opacity) ?? [0, 0, 0, 0];
    const shape = webGpuShapeGeometry(node, stroke[3] > 0);
    const geometry = resolveInsideRoundedRect(Math.abs(shape.bounds.width), Math.abs(shape.bounds.height), shape.radius, node.strokeWidth);
    instances.set([shape.bounds.x, shape.bounds.y, shape.bounds.width, shape.bounds.height, node.rotation, node.kind === "ellipse" ? 1 : 0, geometry.outerRadius, stroke[3] > 0 ? geometry.insideStrokeWidth : 0, ...fill, ...stroke], offset);
    renderedNodeIds.add(node.id);
  });
  return { instances, renderedNodeIds };
}

/**
 * The ellipse shader paints a stroke ring inside its submitted quad. Center
 * and Outside alignment therefore expand that quad around the Canonical fill
 * ellipse: the shader's inner ellipse remains the visible fill and the
 * surrounding band becomes the stroke. This is the same two-ellipse model as
 * Canvas/SVG, while Arc and image-filled ellipses keep their Canvas path.
 */
function webGpuShapeGeometry(node: CanvasNode, hasVisibleStroke: boolean) {
  const bounds = { x: node.x, y: node.y, width: node.width, height: node.height };
  const alignedClosedShape = node.kind === "ellipse"
    ? !node.arcData
    : (node.kind === "frame" || node.kind === "rectangle") && !node.strokeWeights?.length && !node.cornerRadii?.length && !node.cornerSmoothing;
  const visualBounds = closedShapeStrokeLocalBounds(node);
  if (!alignedClosedShape || !hasVisibleStroke || !visualBounds) return { bounds, radius: node.radius };
  const extent = -visualBounds.x;
  return {
    bounds: { x: node.x + visualBounds.x, y: node.y + visualBounds.y, width: visualBounds.width, height: visualBounds.height },
    // A ring expanded by `extent` also expands an ordinary rounded corner by
    // that amount. The shader then subtracts the full stroke width for the
    // fill boundary, matching Canvas/SVG Center and Outside rings.
    radius: node.kind === "ellipse" ? node.radius : node.radius + extent,
  };
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
  const affine = glyph.quadTransform;
  return Boolean(glyph.textureKey && glyph.nodeId)
    && Number.isSafeInteger(glyph.maskWidth) && glyph.maskWidth > 0
    && Number.isSafeInteger(glyph.maskHeight) && glyph.maskHeight > 0
    && glyph.alphaMask.byteLength === glyph.maskWidth * glyph.maskHeight
    && [glyph.x, glyph.y, glyph.width, glyph.height, glyph.rotation, glyph.opacity].every(Number.isFinite)
    && (!affine || [affine.a, affine.b, affine.c, affine.d, affine.e, affine.f].every(Number.isFinite))
    && glyph.width > 0 && glyph.height > 0;
}

/** Converts the compatibility rectangle into the same unit-quad affine used
 * by native TextPath projection. */
function textGlyphQuadTransform(glyph: WebGpuTextGlyph) {
  if (glyph.quadTransform) return glyph.quadTransform;
  const radians = glyph.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = glyph.width / 2;
  const centerY = glyph.height / 2;
  return {
    a: cosine * glyph.width,
    b: sine * glyph.width,
    c: -sine * glyph.height,
    d: cosine * glyph.height,
    e: glyph.x + centerX - cosine * centerX + sine * centerY,
    f: glyph.y + centerY - sine * centerX - cosine * centerY,
  };
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

/** Stable, content-free GPU failure classes that are safe to retain in the
 * diagnostic trail. Browser error messages can include implementation details,
 * so they must never cross the renderer boundary. */
export type WebGpuRendererFailureCode =
  | "WEBGPU_OUT_OF_MEMORY"
  | "WEBGPU_VALIDATION_ERROR"
  | "WEBGPU_UPLOAD_FAILED"
  | "WEBGPU_SCENE_RENDER_FAILED";

export function classifyWebGpuRendererFailure(error: unknown): WebGpuRendererFailureCode {
  const candidate = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : {};
  const name = typeof candidate.name === "string" ? candidate.name.toLowerCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  if (name.includes("outofmemory") || message.includes("out of memory")) return "WEBGPU_OUT_OF_MEMORY";
  // Texture, buffer and external-image transfers are an independently
  // actionable upload boundary even when browsers surface them as validation.
  if (message.includes("writetexture") || message.includes("copyexternalimagetotexture") || message.includes("writebuffer") || message.includes("texture upload")) return "WEBGPU_UPLOAD_FAILED";
  if (name.includes("validation") || message.includes("validation")) return "WEBGPU_VALIDATION_ERROR";
  return "WEBGPU_SCENE_RENDER_FAILED";
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
  private readonly effectSourcePipeline: GpuRenderPipeline;
  private readonly imagePipeline: GpuRenderPipeline;
  private readonly textPipeline: GpuRenderPipeline;
  private readonly effectBlurPipeline: GpuRenderPipeline;
  private readonly effectCompositePipeline: GpuRenderPipeline;
  private readonly effectInnerShadowPipeline: GpuRenderPipeline;
  private readonly imageSampler: GpuSampler;
  private readonly unitQuadBuffer: GpuBuffer;
  private readonly cameraBuffer: GpuBuffer;
  private readonly cameraBindGroup: GpuBindGroup;
  private readonly effectSourceCameraBindGroup: GpuBindGroup;
  private readonly imageCameraBindGroup: GpuBindGroup;
  private readonly textCameraBindGroup: GpuBindGroup;
  private readonly effectBlurUniform: GpuBuffer;
  private readonly effectInnerShadowUniform: GpuBuffer;
  private instanceBuffer: GpuBuffer | undefined;
  private instanceCapacity = 0;
  private imageInstanceBuffer: GpuBuffer | undefined;
  private imageInstanceCapacity = 0;
  private textInstanceBuffer: GpuBuffer | undefined;
  private textInstanceCapacity = 0;
  private effectInstanceBuffer: GpuBuffer | undefined;
  private effectInstanceCapacity = 0;
  private imageTextures = new Map<string, { source: ImageBitmap; width: number; height: number; texture: GpuTexture; bindGroup: GpuBindGroup }>();
  /** E1 temporary surfaces are renderer-local and are released with the device. */
  private readonly effectTextures: WebGpuEffectTexturePool;
  /** Derived, device-generation-local glyph cache. It intentionally contains
   * no Canonical document state and is discarded on renderer destruction. */
  private textAtlases: GpuGlyphAtlas[] = [];
  private atlasAccessTick = 0;
  private textAtlasEvictions = 0;
  private cachedSceneKey: string | number | undefined;
  private hasCachedScene = false;
  private cachedInstanceCount = 0;
  private cachedRenderedNodeIds: ReadonlySet<string> = new Set();
  private pixelWidth = 0;
  private pixelHeight = 0;
  private failureListener: ((code: WebGpuRendererFailureCode) => void) | undefined;

  private constructor(canvas: OffscreenCanvas, context: GpuCanvasContext, device: GpuDevice, format: string) {
    this.canvas = canvas;
    this.context = context;
    this.device = device;
    this.format = format;
    this.deviceLost = device.lost;
    device.addEventListener?.("uncapturederror", (event) => this.reportFailure(event.error));
    this.pipeline = createPipeline(device, format);
    this.effectSourcePipeline = createPipeline(device, "rgba8unorm");
    this.imagePipeline = createImagePipeline(device, format);
    this.textPipeline = createTextPipeline(device, format);
    // Pool textures are deliberately fixed RGBA8 even when the browser's
    // preferred swap-chain format is BGRA8, so the blur pass needs its own
    // attachment format while the final composite targets the swap chain.
    this.effectBlurPipeline = createEffectBlurPipeline(device, "rgba8unorm");
    this.effectCompositePipeline = createEffectCompositePipeline(device, format);
    this.effectInnerShadowPipeline = createEffectInnerShadowPipeline(device, format);
    this.imageSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.effectTextures = new WebGpuEffectTexturePool(device);
    this.unitQuadBuffer = device.createBuffer({ size: UNIT_QUAD.byteLength, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST });
    this.cameraBuffer = device.createBuffer({ size: GPU_CAMERA_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST });
    const cameraEntry = [{ binding: 0, resource: { buffer: this.cameraBuffer } }];
    // `layout: "auto"` creates pipeline-specific bind group layouts. Although
    // the Camera declaration is identical, a bind group from the shape
    // pipeline is not compatible with the Image/Text pipelines in WebGPU.
    this.cameraBindGroup = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: cameraEntry });
    this.effectSourceCameraBindGroup = device.createBindGroup({ layout: this.effectSourcePipeline.getBindGroupLayout(0), entries: cameraEntry });
    this.imageCameraBindGroup = device.createBindGroup({ layout: this.imagePipeline.getBindGroupLayout(0), entries: cameraEntry });
    this.textCameraBindGroup = device.createBindGroup({ layout: this.textPipeline.getBindGroupLayout(0), entries: cameraEntry });
    this.effectBlurUniform = device.createBuffer({ size: GPU_EFFECT_BLUR_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST });
    this.effectInnerShadowUniform = device.createBuffer({ size: GPU_EFFECT_INNER_SHADOW_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST });
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

  /** GPU validation/OOM errors may arrive asynchronously through an uncaptured
   * error event; expose only their stable category to the Engine Worker. */
  setFailureListener(listener: ((code: WebGpuRendererFailureCode) => void) | undefined) {
    this.failureListener = listener;
  }

  reportFailure(error: unknown) {
    this.failureListener?.(classifyWebGpuRendererFailure(error));
  }

  render(input: WebGpuSceneRenderInput): WebGpuSceneRenderResult {
    this.effectTextures.beginFrame();
    try {
      const admission = admitWebGpuSceneResources(input);
      if (!admission.accepted) throw new GpuSceneResourceLimitError(admission);
      const pixelWidth = Math.max(1, Math.ceil(input.width * input.dpr));
      const pixelHeight = Math.max(1, Math.ceil(input.height * input.dpr));
      this.resize(pixelWidth, pixelHeight);
      // A GPU effect is always the terminal pass of the admitted prefix. Its
      // source/blur work uses separate offscreen submissions, while ordinary
      // shapes keep the cached scene buffer and retain their prior ordering.
      const effectNode = input.nodes.find(isGpuSimpleEffectNode);
      const normalNodes = effectNode ? input.nodes.filter((node) => node.id !== effectNode.id) : input.nodes;
      const sceneChanged = !this.hasCachedScene || this.cachedSceneKey !== input.sceneKey;
      const sceneUploadBytes = sceneChanged ? this.uploadScene(normalNodes, input.sceneKey, effectNode ? undefined : input.precomputedInstances) : 0;
      const images = this.uploadImages(normalNodes, input.imageBitmaps);
      const text = this.uploadTextGlyphs(input.textGlyphs);
      this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraUniform({ viewportX: input.viewport.x, viewportY: input.viewport.y, zoom: input.viewport.zoom, canvasWidth: input.width, canvasHeight: input.height, dpr: input.dpr }));
      const preparedEffect = effectNode ? this.prepareDropShadowEffects(effectNode, input, pixelWidth, pixelHeight) ?? this.prepareLayerBlurEffect(effectNode, input, pixelWidth, pixelHeight) ?? this.prepareInnerShadowEffect(effectNode, input, pixelWidth, pixelHeight) : undefined;
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
      if (preparedEffect) {
        pass.setPipeline(this.effectCompositePipeline);
        pass.setVertexBuffer(0, this.unitQuadBuffer);
        for (const effect of preparedEffect.composites) {
          pass.setPipeline(effect.pipeline);
          pass.setBindGroup(0, effect.compositeBindGroup);
          pass.draw(6);
        }
        if (preparedEffect.drawOriginal) {
          pass.setPipeline(this.pipeline);
          pass.setBindGroup(0, this.cameraBindGroup);
          pass.setVertexBuffer(0, this.unitQuadBuffer);
          pass.setVertexBuffer(1, this.effectInstanceBuffer!);
          pass.draw(6);
        }
      }
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      const transferStartedAt = performance.now();
      const bitmap = this.canvas.transferToImageBitmap();
      return { bitmap, renderedNodeIds: new Set([...this.cachedRenderedNodeIds, ...images.renderedNodeIds, ...text.renderedNodeIds, ...(preparedEffect ? [preparedEffect.nodeId] : [])]), resourceBytes: admission.resourceBytes, gpuUploadBytes: sceneUploadBytes + images.uploadBytes + text.uploadBytes + (preparedEffect?.uploadBytes ?? 0) + GPU_CAMERA_UNIFORM_BYTES, imageBitmapMs: performance.now() - transferStartedAt, imageTextures: images.stats, textAtlas: text.stats, effectTextures: this.effectTextures.endFrame() };
    } catch (error) {
      this.effectTextures.cancelFrame();
      throw error;
    }
  }

  destroy() {
    this.releaseInstanceBuffer();
    this.releaseEffectInstanceBuffer();
    this.releaseImageResources();
    this.effectTextures.destroy();
    this.unitQuadBuffer.destroy?.();
    this.cameraBuffer.destroy?.();
    this.effectBlurUniform.destroy?.();
    this.effectInnerShadowUniform.destroy?.();
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

  /** Executes E1's bounded GPU path: every visible Drop Shadow gets an
   * offset source and blurred pool texture, then all are composited in stack
   * order before the untouched node. Any pool rejection returns undefined so
   * Canvas paints the entire node instead of a partial effect stack. */
  private prepareDropShadowEffects(node: CanvasNode, input: WebGpuSceneRenderInput, pixelWidth: number, pixelHeight: number) {
    if (!isGpuDropShadowEffectNode(node)) return undefined;
    const stack = normalizedNodeEffects(node);
    const shadows = stack.flatMap((effect) => {
      const shadow = effect.dropShadow;
      return shadow?.visible && shadow.color.alpha > 0 ? [shadow] : [];
    });
    const originalInstances = buildWebGpuInstances([node]).instances;
    if (!shadows.length || originalInstances.length !== GPU_INSTANCE_FLOATS) return undefined;
    this.ensureEffectInstanceBuffer(originalInstances.byteLength);
    const composites: Array<{ pipeline: GpuRenderPipeline; compositeBindGroup: GpuBindGroup }> = [];
    let uploadBytes = originalInstances.byteLength;
    for (const shadow of shadows) {
      const source = this.effectTextures.acquire(pixelWidth, pixelHeight);
      const blurred = this.effectTextures.acquire(pixelWidth, pixelHeight);
      if (!source || !blurred) return undefined;
      const shadowNode = {
        ...node,
        x: node.x + shadow.offsetX,
        y: node.y + shadow.offsetY,
        fill: colorToSrgbCss(shadow.color),
        stroke: colorToSrgbCss(shadow.color),
      };
      const sourceInstances = buildWebGpuInstances([shadowNode]).instances;
      if (sourceInstances.length !== GPU_INSTANCE_FLOATS) return undefined;
      this.device.queue.writeBuffer(this.effectInstanceBuffer!, 0, sourceInstances);
      const sourceEncoder = this.device.createCommandEncoder();
      const sourcePass = sourceEncoder.beginRenderPass({
        colorAttachments: [{ view: source.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
      });
      sourcePass.setPipeline(this.effectSourcePipeline);
      sourcePass.setBindGroup(0, this.effectSourceCameraBindGroup);
      sourcePass.setVertexBuffer(0, this.unitQuadBuffer);
      sourcePass.setVertexBuffer(1, this.effectInstanceBuffer!);
      sourcePass.draw(6);
      sourcePass.end();
      const blurRadius = Math.max(0, Math.min(128, shadow.blurRadius * input.viewport.zoom * input.dpr));
      this.writeEffectBlurUniform(blurRadius, pixelWidth, pixelHeight);
      const blurBindGroup = this.device.createBindGroup({
        layout: this.effectBlurPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source.createView() }, { binding: 1, resource: this.imageSampler }, { binding: 2, resource: { buffer: this.effectBlurUniform } }],
      });
      const blurPass = sourceEncoder.beginRenderPass({
        colorAttachments: [{ view: blurred.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
      });
      blurPass.setPipeline(this.effectBlurPipeline);
      blurPass.setBindGroup(0, blurBindGroup);
      blurPass.setVertexBuffer(0, this.unitQuadBuffer);
      blurPass.draw(6);
      blurPass.end();
      // Queue operations are ordered: submit this source before reusing the
      // shared instance/uniform buffers for the next ordered shadow.
      this.device.queue.submit([sourceEncoder.finish()]);
      composites.push({ pipeline: this.effectCompositePipeline, compositeBindGroup: this.device.createBindGroup({
        layout: this.effectCompositePipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: blurred.createView() }, { binding: 1, resource: this.imageSampler }],
      }) });
      uploadBytes += sourceInstances.byteLength + GPU_EFFECT_BLUR_UNIFORM_BYTES;
    }
    this.device.queue.writeBuffer(this.effectInstanceBuffer!, 0, originalInstances);
    return { nodeId: node.id, composites, uploadBytes, drawOriginal: true };
  }

  /** A bounded source blur replaces the original node. It intentionally accepts
   * only one Layer Blur because arbitrary Effect Stack ordering still belongs
   * to Canvas until the GPU graph can represent every intermediate source. */
  private prepareLayerBlurEffect(node: CanvasNode, input: WebGpuSceneRenderInput, pixelWidth: number, pixelHeight: number) {
    if (!isGpuLayerBlurEffectNode(node)) return undefined;
    const blur = normalizedNodeEffects(node)[0]?.layerBlur;
    if (!blur) return undefined;
    const originalInstances = buildWebGpuInstances([node]).instances;
    if (originalInstances.length !== GPU_INSTANCE_FLOATS) return undefined;
    const source = this.effectTextures.acquire(pixelWidth, pixelHeight);
    const blurred = this.effectTextures.acquire(pixelWidth, pixelHeight);
    if (!source || !blurred) return undefined;
    this.ensureEffectInstanceBuffer(originalInstances.byteLength);
    this.device.queue.writeBuffer(this.effectInstanceBuffer!, 0, originalInstances);
    const sourceEncoder = this.device.createCommandEncoder();
    const sourcePass = sourceEncoder.beginRenderPass({
      colorAttachments: [{ view: source.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
    });
    sourcePass.setPipeline(this.effectSourcePipeline);
    sourcePass.setBindGroup(0, this.effectSourceCameraBindGroup);
    sourcePass.setVertexBuffer(0, this.unitQuadBuffer);
    sourcePass.setVertexBuffer(1, this.effectInstanceBuffer!);
    sourcePass.draw(6);
    sourcePass.end();
    const blurRadius = Math.max(0, Math.min(128, blur.radius * input.viewport.zoom * input.dpr));
    this.writeEffectBlurUniform(blurRadius, pixelWidth, pixelHeight);
    const blurBindGroup = this.device.createBindGroup({
      layout: this.effectBlurPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: source.createView() }, { binding: 1, resource: this.imageSampler }, { binding: 2, resource: { buffer: this.effectBlurUniform } }],
    });
    const blurPass = sourceEncoder.beginRenderPass({
      colorAttachments: [{ view: blurred.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
    });
    blurPass.setPipeline(this.effectBlurPipeline);
    blurPass.setBindGroup(0, blurBindGroup);
    blurPass.setVertexBuffer(0, this.unitQuadBuffer);
    blurPass.draw(6);
    blurPass.end();
    this.device.queue.submit([sourceEncoder.finish()]);
    return {
      nodeId: node.id,
      composites: [{ pipeline: this.effectCompositePipeline, compositeBindGroup: this.device.createBindGroup({
        layout: this.effectCompositePipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: blurred.createView() }, { binding: 1, resource: this.imageSampler }],
      }) }],
      uploadBytes: originalInstances.byteLength + GPU_EFFECT_BLUR_UNIFORM_BYTES,
      drawOriginal: false,
    };
  }

  /** The Canvas path draws a source shifted by the inverse offset, blurs it,
   * clips it with the original alpha and then composites the tinted result over
   * the source. The GPU keeps that exact source/blur relationship in two
   * budgeted textures; the final shader performs the alpha clip and source-over
   * merge without allocating a third intermediate surface. */
  private prepareInnerShadowEffect(node: CanvasNode, input: WebGpuSceneRenderInput, pixelWidth: number, pixelHeight: number) {
    if (!isGpuInnerShadowEffectNode(node)) return undefined;
    const shadow = normalizedNodeEffects(node)[0]?.innerShadow;
    if (!shadow) return undefined;
    const originalInstances = buildWebGpuInstances([node]).instances;
    if (originalInstances.length !== GPU_INSTANCE_FLOATS) return undefined;
    const source = this.effectTextures.acquire(pixelWidth, pixelHeight);
    const blurred = this.effectTextures.acquire(pixelWidth, pixelHeight);
    if (!source || !blurred) return undefined;
    this.ensureEffectInstanceBuffer(originalInstances.byteLength);
    this.device.queue.writeBuffer(this.effectInstanceBuffer!, 0, originalInstances);
    const sourceEncoder = this.device.createCommandEncoder();
    const sourcePass = sourceEncoder.beginRenderPass({
      colorAttachments: [{ view: source.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
    });
    sourcePass.setPipeline(this.effectSourcePipeline);
    sourcePass.setBindGroup(0, this.effectSourceCameraBindGroup);
    sourcePass.setVertexBuffer(0, this.unitQuadBuffer);
    sourcePass.setVertexBuffer(1, this.effectInstanceBuffer!);
    sourcePass.draw(6);
    sourcePass.end();
    const blurRadius = Math.max(0, Math.min(128, shadow.blurRadius * input.viewport.zoom * input.dpr));
    // Canvas draws the source at -offset before clipping it back to its own
    // alpha. Sampling at +offset yields the same reversed interior direction.
    this.writeEffectBlurUniform(blurRadius, pixelWidth, pixelHeight, shadow.offsetX * input.viewport.zoom * input.dpr, shadow.offsetY * input.viewport.zoom * input.dpr);
    const blurBindGroup = this.device.createBindGroup({
      layout: this.effectBlurPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: source.createView() }, { binding: 1, resource: this.imageSampler }, { binding: 2, resource: { buffer: this.effectBlurUniform } }],
    });
    const blurPass = sourceEncoder.beginRenderPass({
      colorAttachments: [{ view: blurred.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
    });
    blurPass.setPipeline(this.effectBlurPipeline);
    blurPass.setBindGroup(0, blurBindGroup);
    blurPass.setVertexBuffer(0, this.unitQuadBuffer);
    blurPass.draw(6);
    blurPass.end();
    this.device.queue.submit([sourceEncoder.finish()]);
    const [red, green, blue] = colorToSrgbBytes(shadow.color);
    const alpha = Math.round(Math.min(1, Math.max(0, shadow.color.alpha)) * 255) / 255;
    this.device.queue.writeBuffer(this.effectInnerShadowUniform, 0, new Float32Array([red / 255, green / 255, blue / 255, alpha]));
    return {
      nodeId: node.id,
      composites: [{ pipeline: this.effectInnerShadowPipeline, compositeBindGroup: this.device.createBindGroup({
        layout: this.effectInnerShadowPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: blurred.createView() },
          { binding: 2, resource: this.imageSampler },
          { binding: 3, resource: { buffer: this.effectInnerShadowUniform } },
        ],
      }) }],
      uploadBytes: originalInstances.byteLength + GPU_EFFECT_BLUR_UNIFORM_BYTES + GPU_EFFECT_INNER_SHADOW_UNIFORM_BYTES,
      drawOriginal: false,
    };
  }

  private writeEffectBlurUniform(radius: number, pixelWidth: number, pixelHeight: number, offsetX = 0, offsetY = 0) {
    this.device.queue.writeBuffer(this.effectBlurUniform, 0, new Float32Array([radius, 1 / pixelWidth, 1 / pixelHeight, 0, offsetX, offsetY, 0, 0]));
  }

  private ensureEffectInstanceBuffer(requiredBytes: number) {
    const capacity = Math.max(requiredBytes, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES);
    if (this.effectInstanceBuffer && this.effectInstanceCapacity === capacity) return;
    this.releaseEffectInstanceBuffer();
    this.effectInstanceCapacity = capacity;
    this.effectInstanceBuffer = this.device.createBuffer({ size: capacity, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST });
  }

  private releaseEffectInstanceBuffer() {
    this.effectInstanceBuffer?.destroy?.();
    this.effectInstanceBuffer = undefined;
    this.effectInstanceCapacity = 0;
  }

  private uploadImages(nodes: readonly CanvasNode[], imageBitmaps: WebGpuSceneRenderInput["imageBitmaps"]) {
    const instances: number[] = [];
    const draws: Array<{ bindGroup: GpuBindGroup; offset: number }> = [];
    const renderedNodeIds = new Set<string>();
    let uploadBytes = 0;
    let cacheHits = 0;
    let uploads = 0;
    for (const node of nodes) {
      if (node.kind !== "image" || node.visible === false || !node.assetId) continue;
      const bitmap = imageBitmaps?.get(node.assetId);
      if (!bitmap || bitmap.width <= 0 || bitmap.height <= 0) continue;
      const texture = this.ensureImageTexture(node.assetId, bitmap);
      if (texture.uploaded) {
        uploadBytes += bitmap.width * bitmap.height * RGBA8_BYTES_PER_PIXEL;
        uploads += 1;
      } else cacheHits += 1;
      const offset = instances.length * BYTES_PER_FLOAT;
      instances.push(...imageInstance(node, bitmap));
      draws.push({ bindGroup: texture.entry.bindGroup, offset });
      renderedNodeIds.add(node.id);
    }
    let releases = 0;
    for (const [assetId, entry] of this.imageTextures) {
      // A multi-island frame supplies the complete retained asset set on each
      // call even though this bitmap draws only one ordered island. Releasing
      // against that frame set prevents shape/image interleaving from
      // destroying and re-uploading the same texture between adjacent passes.
      if (!imageBitmaps?.has(assetId)) {
        entry.texture.destroy?.();
        this.imageTextures.delete(assetId);
        releases += 1;
      }
    }
    const payload = new Float32Array(instances);
    if (payload.length) {
      this.ensureImageInstanceBuffer(payload.byteLength);
      this.device.queue.writeBuffer(this.imageInstanceBuffer!, 0, payload);
    } else this.releaseImageInstanceBuffer();
    return {
      instances: payload,
      draws,
      renderedNodeIds,
      uploadBytes: uploadBytes + payload.byteLength,
      stats: {
        textures: this.imageTextures.size,
        bytes: [...this.imageTextures.values()].reduce((total, entry) => total + entry.width * entry.height * RGBA8_BYTES_PER_PIXEL, 0),
        cacheHits,
        uploads,
        releases,
      },
    };
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
    let cacheHits = 0;
    let uploads = 0;
    let rejectedNodes = 0;
    const evictionsAtStart = this.textAtlasEvictions;
    const glyphsByNode = new Map<string, WebGpuTextGlyph[]>();
    for (const glyph of glyphs ?? []) {
      if (!isValidTextGlyph(glyph) || !cssColor(glyph.fill, glyph.opacity)) continue;
      const group = glyphsByNode.get(glyph.nodeId) ?? [];
      group.push(glyph);
      glyphsByNode.set(glyph.nodeId, group);
    }
    // An atlas page is replaced only when none of its cells will be sampled in
    // this frame. That gives the bounded cache an LRU escape hatch without
    // invalidating a bind group or UV used by an already prepared draw.
    const requiredTextureKeys = new Set([...glyphsByNode.values()].flatMap((nodeGlyphs) => nodeGlyphs.map((glyph) => glyph.textureKey)));
    // A node is all-GPU or all-Canvas. This prevents a full Canvas fallback
    // from double-painting the subset of glyphs that fit in the atlas.
    for (const [nodeId, nodeGlyphs] of glyphsByNode) {
      const nodeInstances: number[] = [];
      const nodeDraws: Array<{ bindGroup: GpuBindGroup; offset: number }> = [];
      let nodeUploadBytes = 0;
      let complete = true;
      for (const glyph of nodeGlyphs) {
        const atlas = this.ensureTextAtlasEntry(glyph, requiredTextureKeys);
        if (!atlas) { complete = false; break; }
        const color = cssColor(glyph.fill, glyph.opacity)!;
        if (atlas.uploaded) {
          nodeUploadBytes += glyph.alphaMask.byteLength;
          uploads += 1;
        } else cacheHits += 1;
        const offset = (instances.length + nodeInstances.length) * BYTES_PER_FLOAT;
        const quad = textGlyphQuadTransform(glyph);
        nodeInstances.push(
          quad.e, quad.f, quad.a, quad.b, quad.c, quad.d, ...color,
          atlas.entry.x / GPU_GLYPH_ATLAS_DIMENSION,
          atlas.entry.y / GPU_GLYPH_ATLAS_DIMENSION,
          atlas.entry.width / GPU_GLYPH_ATLAS_DIMENSION,
          atlas.entry.height / GPU_GLYPH_ATLAS_DIMENSION,
        );
        nodeDraws.push({ bindGroup: atlas.bindGroup, offset });
      }
      if (!complete) {
        rejectedNodes += 1;
        continue;
      }
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
    const entries = this.textAtlases.reduce((count, atlas) => count + atlas.entries.size, 0);
    return {
      instances: payload,
      draws,
      renderedNodeIds,
      uploadBytes: uploadBytes + payload.byteLength,
      stats: {
        pages: this.textAtlases.length,
        bytes: this.textAtlases.length * GPU_GLYPH_ATLAS_BYTES,
        entries,
        cacheHits,
        uploads,
        evictions: this.textAtlasEvictions - evictionsAtStart,
        rejectedNodes,
      },
    };
  }

  private ensureTextAtlasEntry(glyph: WebGpuTextGlyph, requiredTextureKeys: ReadonlySet<string>): { entry: GlyphAtlasEntry; bindGroup: GpuBindGroup; uploaded: boolean } | undefined {
    const allocatedWidth = glyph.maskWidth + GPU_GLYPH_ATLAS_PADDING * 2;
    const allocatedHeight = glyph.maskHeight + GPU_GLYPH_ATLAS_PADDING * 2;
    if (allocatedWidth > GPU_GLYPH_ATLAS_DIMENSION || allocatedHeight > GPU_GLYPH_ATLAS_DIMENSION) return undefined;
    for (const atlas of this.textAtlases) {
      const current = atlas.entries.get(glyph.textureKey);
      if (current && current.width === glyph.maskWidth && current.height === glyph.maskHeight) {
        atlas.lastUsed = ++this.atlasAccessTick;
        return { entry: current, bindGroup: atlas.bindGroup, uploaded: false };
      }
      // A cache key is immutable font/glyph/size identity. A key that changes
      // dimensions is rejected rather than mutating an already drawn atlas cell.
      if (current) return undefined;
      const entry = this.allocateTextAtlasEntry(atlas, glyph, allocatedWidth, allocatedHeight);
      if (entry) return this.uploadTextAtlasEntry(atlas, glyph, entry);
    }
    let target: GpuGlyphAtlas;
    if (this.textAtlases.length >= MAX_GPU_GLYPH_ATLAS_PAGES) {
      const evictionIndex = this.textAtlases
        .map((atlas, index) => ({ atlas, index }))
        .filter(({ atlas }) => [...atlas.entries.keys()].every((key) => !requiredTextureKeys.has(key)))
        .sort((left, right) => left.atlas.lastUsed - right.atlas.lastUsed)[0]?.index;
      if (evictionIndex === undefined) return undefined;
      this.textAtlases[evictionIndex]!.texture.destroy?.();
      this.textAtlasEvictions += 1;
      target = this.createTextAtlas();
      this.textAtlases[evictionIndex] = target;
    } else {
      target = this.createTextAtlas();
      this.textAtlases.push(target);
    }
    const entry = this.allocateTextAtlasEntry(target, glyph, allocatedWidth, allocatedHeight);
    return entry ? this.uploadTextAtlasEntry(target, glyph, entry) : undefined;
  }

  private allocateTextAtlasEntry(atlas: GpuGlyphAtlas, glyph: WebGpuTextGlyph, allocatedWidth: number, allocatedHeight: number): GlyphAtlasEntry | undefined {
    if (atlas.nextX + allocatedWidth > GPU_GLYPH_ATLAS_DIMENSION) {
      atlas.nextX = 0;
      atlas.nextY += atlas.rowHeight;
      atlas.rowHeight = 0;
    }
    if (atlas.nextY + allocatedHeight > GPU_GLYPH_ATLAS_DIMENSION) return undefined;
    const entry = { x: atlas.nextX + GPU_GLYPH_ATLAS_PADDING, y: atlas.nextY + GPU_GLYPH_ATLAS_PADDING, width: glyph.maskWidth, height: glyph.maskHeight };
    atlas.nextX += allocatedWidth;
    atlas.rowHeight = Math.max(atlas.rowHeight, allocatedHeight);
    return entry;
  }

  private uploadTextAtlasEntry(atlas: GpuGlyphAtlas, glyph: WebGpuTextGlyph, entry: GlyphAtlasEntry) {
    const bytesPerRow = Math.ceil(glyph.maskWidth / 256) * 256;
    const padded = new Uint8Array(bytesPerRow * glyph.maskHeight);
    for (let row = 0; row < glyph.maskHeight; row += 1) {
      padded.set(glyph.alphaMask.subarray(row * glyph.maskWidth, (row + 1) * glyph.maskWidth), row * bytesPerRow);
    }
    this.device.queue.writeTexture({ texture: atlas.texture, origin: { x: entry.x, y: entry.y, z: 0 } }, padded, { bytesPerRow, rowsPerImage: glyph.maskHeight }, { width: glyph.maskWidth, height: glyph.maskHeight, depthOrArrayLayers: 1 });
    atlas.entries.set(glyph.textureKey, entry);
    atlas.lastUsed = ++this.atlasAccessTick;
    return { entry, bindGroup: atlas.bindGroup, uploaded: true };
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
      lastUsed: ++this.atlasAccessTick,
    };
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
    this.textAtlases.forEach((atlas) => atlas.texture.destroy?.());
    this.textAtlases = [];
    this.textAtlasEvictions = 0;
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
  // Reserve the bounded page set before allocating any glyph texture. A full
  // first page can therefore advance to a second page without exceeding the
  // admission contract mid-frame; all pages are cleared with the device.
  const textAtlasBytes = textInstanceCount ? GPU_GLYPH_ATLAS_BYTES * MAX_GPU_GLYPH_ATLAS_PAGES : 0;
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
    const shape = webGpuShapeGeometry(node, stroke[3] > 0);
    const nodePixelWidth = Math.abs(shape.bounds.width * input.viewport.zoom);
    const nodePixelHeight = Math.abs(shape.bounds.height * input.viewport.zoom);
    const size = Math.max(1, Math.min(nodePixelWidth, nodePixelHeight));
    const geometry = resolveInsideRoundedRect(nodePixelWidth, nodePixelHeight, shape.radius * input.viewport.zoom, node.strokeWidth * input.viewport.zoom);
    const insideStrokeWidth = stroke[3] > 0 ? geometry.insideStrokeWidth : 0;
    const parameters: [number, number, number, number] = [
      node.kind === "ellipse" ? 1 : 0,
      geometry.outerRadius / size,
      insideStrokeWidth / size,
      nodePixelHeight > 0 ? nodePixelWidth / nodePixelHeight : 1,
    ];
    appendQuad(values, { ...node, ...shape.bounds }, input.viewport, pixelWidth, pixelHeight, input.dpr, fill, stroke, parameters);
    renderedNodeIds.add(node.id);
  }
  return { vertices: new Float32Array(values), renderedNodeIds };
}

function isGpuRenderable(node: CanvasNode): boolean {
  // Images must enter only the texture-backed Image pass. Rendering their
  // fallback fill in the solid-shape batch would suppress Canvas's placeholder
  // before a trusted bitmap has decoded.
  return node.visible !== false && node.kind !== "text" && node.kind !== "textPath" && node.kind !== "image" && !node.fillGradient && !node.strokeGradient
    && !(node.kind === "ellipse" && Boolean(node.arcData))
    && !((node.kind === "frame" || node.kind === "rectangle") && (Boolean(node.strokeWeights?.length) || Boolean(node.cornerRadii?.length) || Boolean(node.cornerSmoothing)));
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
          { shaderLocation: 1, offset: 0, format: "float32x2" },
          { shaderLocation: 2, offset: 2 * BYTES_PER_FLOAT, format: "float32x2" },
          { shaderLocation: 3, offset: 4 * BYTES_PER_FLOAT, format: "float32x2" },
          { shaderLocation: 4, offset: 6 * BYTES_PER_FLOAT, format: "float32x4" },
          { shaderLocation: 5, offset: 10 * BYTES_PER_FLOAT, format: "float32x4" },
        ],
      }],
    },
    fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] },
    primitive: { topology: "triangle-list" },
  });
}

function createEffectBlurPipeline(device: GpuDevice, format: string): GpuRenderPipeline {
  const shaderModule = device.createShaderModule({ code: EFFECT_BLUR_WGSL });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shaderModule, entryPoint: "vs_main", buffers: [{ arrayStride: 2 * BYTES_PER_FLOAT, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
    // Blur samples an already premultiplied source texture and writes into an
    // empty target, so blending here would multiply alpha a second time.
    fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

function createEffectCompositePipeline(device: GpuDevice, format: string): GpuRenderPipeline {
  const shaderModule = device.createShaderModule({ code: EFFECT_COMPOSITE_WGSL });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shaderModule, entryPoint: "vs_main", buffers: [{ arrayStride: 2 * BYTES_PER_FLOAT, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
    // The blurred texture stores premultiplied color from the source pass.
    fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format, blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] },
    primitive: { topology: "triangle-list" },
  });
}

function createEffectInnerShadowPipeline(device: GpuDevice, format: string): GpuRenderPipeline {
  const shaderModule = device.createShaderModule({ code: EFFECT_INNER_SHADOW_WGSL });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shaderModule, entryPoint: "vs_main", buffers: [{ arrayStride: 2 * BYTES_PER_FLOAT, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
    fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format, blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] },
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
  @location(0) local: vec2<f32>, @location(1) origin: vec2<f32>,
  @location(2) basis_x: vec2<f32>, @location(3) basis_y: vec2<f32>,
  @location(4) color: vec4<f32>, @location(5) atlas_uv_rect: vec4<f32>,
};
struct Camera { first: vec4<f32>, second: vec4<f32>, };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var glyph_mask: texture_2d<f32>;
@group(1) @binding(1) var glyph_sampler: sampler;
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) color: vec4<f32>, };
@vertex fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let world = input.origin + input.local.x * input.basis_x + input.local.y * input.basis_y;
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

const EFFECT_BLUR_WGSL = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, };
struct Blur { first: vec4<f32>, offset: vec4<f32>, };
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> blur: Blur;
@vertex fn vs_main(@location(0) local: vec2<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(local.x * 2.0 - 1.0, 1.0 - local.y * 2.0, 0.0, 1.0);
  output.uv = local;
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // A bounded 5×5 separable-binomial kernel avoids the visibly detached
  // samples of a sparse blur while remaining one fixed-cost GPU pass. Its
  // outermost samples reach the declared Canvas-compatible blur radius.
  let step = vec2<f32>(blur.first.x * 0.5 * blur.first.y, blur.first.x * 0.5 * blur.first.z);
  var result = vec4<f32>(0.0);
  for (var y: i32 = -2; y <= 2; y = y + 1) {
    let ay = abs(y);
    let wy = select(select(4.0, 1.0, ay == 2), 6.0, ay == 0);
    for (var x: i32 = -2; x <= 2; x = x + 1) {
      let ax = abs(x);
      let wx = select(select(4.0, 1.0, ax == 2), 6.0, ax == 0);
      result += textureSample(source_texture, source_sampler, input.uv + vec2<f32>(blur.offset.x * blur.first.y, blur.offset.y * blur.first.z) + vec2<f32>(f32(x), f32(y)) * step) * (wx * wy / 256.0);
    }
  }
  return result;
}
`;

const EFFECT_COMPOSITE_WGSL = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, };
@group(0) @binding(0) var effect_texture: texture_2d<f32>;
@group(0) @binding(1) var effect_sampler: sampler;
@vertex fn vs_main(@location(0) local: vec2<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(local.x * 2.0 - 1.0, 1.0 - local.y * 2.0, 0.0, 1.0);
  output.uv = local;
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> { return textureSample(effect_texture, effect_sampler, input.uv); }
`;

const EFFECT_INNER_SHADOW_WGSL = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, };
struct ShadowColor { value: vec4<f32>, };
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var blurred_texture: texture_2d<f32>;
@group(0) @binding(2) var effect_sampler: sampler;
@group(0) @binding(3) var<uniform> shadow_color: ShadowColor;
@vertex fn vs_main(@location(0) local: vec2<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(local.x * 2.0 - 1.0, 1.0 - local.y * 2.0, 0.0, 1.0);
  output.uv = local;
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let source = textureSample(source_texture, effect_sampler, input.uv);
  let inner_alpha = min(1.0, source.a * textureSample(blurred_texture, effect_sampler, input.uv).a * shadow_color.value.a);
  let inner = vec4<f32>(shadow_color.value.rgb * inner_alpha, inner_alpha);
  return inner + source * (1.0 - inner_alpha);
}
`;

const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
