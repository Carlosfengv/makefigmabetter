import type { CanvasNode, Viewport } from "./editor-protocol";
import { resolveInsideRoundedRect } from "./rounded-rect";

const FLOATS_PER_VERTEX = 16;
const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;
const GPU_BUFFER_USAGE_VERTEX = 0x20;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const RGBA8_BYTES_PER_PIXEL = 4;
const SWAP_CHAIN_SURFACE_COUNT = 3;

/** Dedicated to the optional WebGPU scene, separate from the Canvas backing-store guard. */
export const MAX_GPU_SCENE_RESOURCE_BYTES = 256 * 1024 * 1024;
export const GPU_SCENE_VERTEX_BYTES_PER_NODE = 6 * FLOATS_PER_VERTEX * BYTES_PER_FLOAT;
export const MIN_GPU_SCENE_VERTEX_BUFFER_BYTES = 4 * 1024;

type GpuDevice = {
  readonly lost: Promise<unknown>;
  readonly queue: { writeBuffer(buffer: GpuBuffer, offset: number, data: Float32Array): void; submit(commandBuffers: unknown[]): void };
  createShaderModule(descriptor: { code: string }): unknown;
  createRenderPipeline(descriptor: unknown): GpuRenderPipeline;
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createCommandEncoder(): GpuCommandEncoder;
  destroy?(): void;
};
type GpuAdapter = { requestDevice(): Promise<GpuDevice> };
type GpuNavigator = { gpu?: { requestAdapter(): Promise<GpuAdapter | null>; getPreferredCanvasFormat?(): string } };
type GpuBuffer = { destroy?(): void };
type GpuRenderPipeline = unknown;
type GpuCanvasContext = { configure(configuration: { device: GpuDevice; format: string; alphaMode: "premultiplied" }): void; getCurrentTexture(): { createView(): unknown } };
type GpuCommandEncoder = { beginRenderPass(descriptor: unknown): GpuRenderPass; finish(): unknown };
type GpuRenderPass = { setPipeline(pipeline: GpuRenderPipeline): void; setVertexBuffer(slot: number, buffer: GpuBuffer): void; draw(vertexCount: number): void; end(): void };

export interface WebGpuSceneRenderInput {
  nodes: readonly CanvasNode[];
  viewport: Viewport;
  width: number;
  height: number;
  dpr: number;
}

export interface WebGpuSceneRenderResult {
  bitmap: ImageBitmap;
  renderedNodeIds: ReadonlySet<string>;
  resourceBytes: number;
}

export type GpuSceneResourceAdmission =
  | { accepted: true; resourceBytes: number; framebufferBytes: number; vertexBytes: number; renderableNodeCount: number }
  | { accepted: false; reason: "INVALID_SIZE" | "RESOURCE_LIMIT"; resourceBytes: number; maxBytes: number };

export class GpuSceneResourceLimitError extends Error {
  constructor(readonly admission: Extract<GpuSceneResourceAdmission, { accepted: false }>) {
    super(admission.reason);
    this.name = "GpuSceneResourceLimitError";
  }
}

/**
 * A real, bounded WebGPU scene spike. It renders solid Frame/Rectangle/Ellipse
 * fills and strokes on an auxiliary OffscreenCanvas; Canvas 2D retains the grid,
 * text and unsupported paint overlay until the Rust/wgpu render graph replaces it.
 */
export class WebGpuSceneRenderer {
  readonly deviceLost: Promise<unknown>;
  private readonly context: GpuCanvasContext;
  private readonly device: GpuDevice;
  private readonly format: string;
  private readonly canvas: OffscreenCanvas;
  private readonly pipeline: GpuRenderPipeline;
  private vertexBuffer: GpuBuffer | undefined;
  private vertexCapacity = 0;
  private pixelWidth = 0;
  private pixelHeight = 0;

  private constructor(canvas: OffscreenCanvas, context: GpuCanvasContext, device: GpuDevice, format: string) {
    this.canvas = canvas;
    this.context = context;
    this.device = device;
    this.format = format;
    this.deviceLost = device.lost;
    this.pipeline = createPipeline(device, format);
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
    const { vertices, renderedNodeIds } = buildWebGpuVertices(input);
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
    if (vertices.length) {
      this.ensureVertexBuffer(vertices.byteLength);
      this.device.queue.writeBuffer(this.vertexBuffer!, 0, vertices);
      pass.setPipeline(this.pipeline);
      pass.setVertexBuffer(0, this.vertexBuffer!);
      pass.draw(vertices.length / FLOATS_PER_VERTEX);
    } else this.releaseVertexBuffer();
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return { bitmap: this.canvas.transferToImageBitmap(), renderedNodeIds, resourceBytes: admission.resourceBytes };
  }

  destroy() {
    this.releaseVertexBuffer();
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

  private ensureVertexBuffer(requiredBytes: number) {
    const requiredCapacity = Math.max(requiredBytes, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES);
    if (this.vertexBuffer && this.vertexCapacity === requiredCapacity) return;
    this.releaseVertexBuffer();
    // Exact sizing makes the admission estimate match the resource we request.
    this.vertexCapacity = requiredCapacity;
    this.vertexBuffer = this.device.createBuffer({ size: this.vertexCapacity, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST });
  }

  private releaseVertexBuffer() {
    this.vertexBuffer?.destroy?.();
    this.vertexBuffer = undefined;
    this.vertexCapacity = 0;
  }
}

/** Estimates all resources before vertex-array allocation or GPU configuration. */
export function admitWebGpuSceneResources(
  input: Pick<WebGpuSceneRenderInput, "nodes" | "width" | "height" | "dpr">,
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
    ? Math.max(renderableNodeCount * GPU_SCENE_VERTEX_BYTES_PER_NODE, MIN_GPU_SCENE_VERTEX_BUFFER_BYTES)
    : 0;
  const resourceBytes = framebufferBytes + vertexBytes;
  if (!Number.isSafeInteger(framebufferBytes) || !Number.isSafeInteger(vertexBytes) || !Number.isSafeInteger(resourceBytes) || resourceBytes > maxBytes) {
    return { accepted: false, reason: "RESOURCE_LIMIT", resourceBytes: Number.isSafeInteger(resourceBytes) ? resourceBytes : Number.MAX_SAFE_INTEGER, maxBytes };
  }
  return { accepted: true, resourceBytes, framebufferBytes, vertexBytes, renderableNodeCount };
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
  return node.visible !== false && node.kind !== "text" && !node.fillGradient && !node.strokeGradient;
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
        arrayStride: FLOATS_PER_VERTEX * BYTES_PER_FLOAT,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },
          { shaderLocation: 1, offset: 2 * BYTES_PER_FLOAT, format: "float32x2" },
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

const WGSL = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec2<f32>, @location(1) local: vec2<f32>,
  @location(2) fill: vec4<f32>, @location(3) stroke: vec4<f32>, @location(4) params: vec4<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32>,
  @location(1) fill: vec4<f32>, @location(2) stroke: vec4<f32>, @location(3) params: vec4<f32>,
};
@vertex fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(input.position, 0.0, 1.0);
  output.local = input.local; output.fill = input.fill; output.stroke = input.stroke; output.params = input.params;
  return output;
}
fn rounded_box_distance(point: vec2<f32>, half_extent: vec2<f32>, radius: f32) -> f32 {
  let q = abs(point) - (half_extent - vec2<f32>(radius));
  return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  var distance: f32;
  if (input.params.x > 0.5) {
    distance = length((input.local - vec2<f32>(0.5)) * 2.0) - 1.0;
  } else {
    let aspect = max(input.params.w, 0.0001);
    let scale = select(vec2<f32>(1.0, 1.0 / aspect), vec2<f32>(aspect, 1.0), aspect >= 1.0);
    distance = rounded_box_distance((input.local - vec2<f32>(0.5)) * scale, vec2<f32>(0.5) * scale, min(input.params.y, 0.5));
  }
  if (distance > 0.0) { discard; }
  if (input.params.z > 0.0 && distance > -input.params.z) { return input.stroke; }
  return input.fill;
}`;
