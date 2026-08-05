import { afterEach, describe, expect, it, vi } from "vitest";

type WorkerScope = {
  onmessage?: (event: { data: unknown }) => void;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");

function pngHeader(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(29);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes[25] = 6;
  return bytes.buffer;
}

async function loadDecodeWorker(createBitmap: typeof createImageBitmap) {
  const messages: unknown[] = [];
  const scope: WorkerScope = { postMessage: (message) => messages.push(message) };
  Object.defineProperty(globalThis, "self", { configurable: true, value: scope });
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: createBitmap });
  vi.resetModules();
  await import("./asset-decode.worker");
  return { scope, messages };
}

async function settleWorker() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  if (originalSelf) Object.defineProperty(globalThis, "self", originalSelf);
  else Reflect.deleteProperty(globalThis, "self");
  if (originalCreateImageBitmap) Object.defineProperty(globalThis, "createImageBitmap", originalCreateImageBitmap);
  else Reflect.deleteProperty(globalThis, "createImageBitmap");
});

describe("Asset Decode Worker", () => {
  it("normalizes an admitted raster entirely inside the worker", async () => {
    const bitmap = { width: 2, height: 3, close: vi.fn() } as unknown as ImageBitmap;
    const createBitmap = vi.fn(async () => bitmap) as unknown as typeof createImageBitmap;
    const { scope, messages } = await loadDecodeWorker(createBitmap);

    scope.onmessage?.({ data: { type: "decode", requestId: "safe", mediaType: "image/png", bytes: pngHeader(2, 3), source: { width: 2, height: 3 } } });
    await settleWorker();

    expect(createBitmap).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ imageOrientation: "from-image", colorSpaceConversion: "default", premultiplyAlpha: "none" }));
    expect(messages).toEqual([expect.objectContaining({
      type: "result", requestId: "safe", bitmap,
      metadata: expect.objectContaining({ source: { width: 2, height: 3 }, decoded: { width: 2, height: 3 }, orientation: "normalized", canonicalColorSpace: "srgb", alpha: "present", decodedByteLength: 24 }),
    })]);
  });

  it("closes and rejects a decoder result whose dimensions do not match the admitted header", async () => {
    const close = vi.fn();
    const createBitmap = vi.fn(async () => ({ width: 3, height: 2, close })) as unknown as typeof createImageBitmap;
    const { scope, messages } = await loadDecodeWorker(createBitmap);

    scope.onmessage?.({ data: { type: "decode", requestId: "mismatch", mediaType: "image/png", bytes: pngHeader(2, 3), source: { width: 2, height: 3 } } });
    await settleWorker();

    expect(close).toHaveBeenCalledOnce();
    expect(messages).toEqual([{ type: "rejected", requestId: "mismatch", reason: "CORRUPT_DATA" }]);
  });

  it("closes a late decoded bitmap after cancellation", async () => {
    let resolveBitmap: ((bitmap: ImageBitmap) => void) | undefined;
    const createBitmap = vi.fn(() => new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve; })) as unknown as typeof createImageBitmap;
    const { scope, messages } = await loadDecodeWorker(createBitmap);
    const close = vi.fn();
    const bitmap = { width: 2, height: 3, close } as unknown as ImageBitmap;

    scope.onmessage?.({ data: { type: "decode", requestId: "cancel", mediaType: "image/png", bytes: pngHeader(2, 3), source: { width: 2, height: 3 } } });
    await Promise.resolve();
    scope.onmessage?.({ data: { type: "cancel", requestId: "cancel" } });
    resolveBitmap?.(bitmap);
    await settleWorker();

    expect(close).toHaveBeenCalledOnce();
    expect(messages).toEqual([{ type: "cancelled", requestId: "cancel" }]);
  });
});
