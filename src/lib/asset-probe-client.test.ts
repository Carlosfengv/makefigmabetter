import { afterEach, describe, expect, it, vi } from "vitest";

import { probeAssetInWorker } from "./asset-probe-client";

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;

  constructor() { FakeWorker.instances.push(this); }
}

function installWorker() {
  FakeWorker.instances = [];
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
}

afterEach(() => {
  if (originalWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
  else Object.defineProperty(globalThis, "Worker", originalWorker);
});

describe("probeAssetInWorker cancellation", () => {
  it("does not create a Worker when the import was already cancelled", async () => {
    installWorker();
    const controller = new AbortController();
    controller.abort();

    await expect(probeAssetInWorker("raster-image", "image/png", Uint8Array.of(1), { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("cancels and terminates an in-flight probe without accepting its late result", async () => {
    installWorker();
    const controller = new AbortController();
    const result = probeAssetInWorker("raster-image", "image/png", Uint8Array.of(1), { signal: controller.signal });
    const worker = FakeWorker.instances[0]!;
    const requestId = (worker.postMessage.mock.calls[0]?.[0] as { requestId: string }).requestId;

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "cancel", requestId });
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.onmessage?.({ data: { type: "result", requestId, detectedMime: "image/png", admission: { accepted: true, mime: "image/png" } } } as MessageEvent);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
