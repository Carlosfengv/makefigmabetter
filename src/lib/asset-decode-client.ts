import type { AssetRejection } from "./untrusted-asset";
import type { RasterDecodeMetadata, RasterDimensions, RasterOrientation } from "./raster-decode-policy";
import { createId } from "./editor-protocol";

type DecodeResponse =
  | { type: "result"; requestId: string; bitmap: ImageBitmap; metadata: RasterDecodeMetadata }
  | { type: "rejected"; requestId: string; reason: AssetRejection }
  | { type: "cancelled"; requestId: string };

export type DecodedRaster = { bitmap: ImageBitmap; metadata: RasterDecodeMetadata };

/** Decodes untrusted image bytes in a short-lived isolated Worker. Late or
 * cancelled results are closed before they can mutate document-owned state. */
export function decodeRasterInWorker(
  mediaType: string,
  bytes: Uint8Array,
  source: RasterDimensions,
  options: { orientation?: RasterOrientation; signal?: AbortSignal; maxDecodedBytes?: number } = {},
): Promise<DecodedRaster> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Raster decode was cancelled.", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("../workers/asset-decode.worker.ts", import.meta.url));
    const requestId = createId();
    const state: { timer?: ReturnType<typeof globalThis.setTimeout>; finished: boolean } = { finished: false };
    const finish = () => {
      if (state.finished) return false;
      state.finished = true;
      if (state.timer !== undefined) globalThis.clearTimeout(state.timer);
      options.signal?.removeEventListener("abort", cancel);
      worker.terminate();
      return true;
    };
    const cancel = () => {
      if (state.finished) return;
      worker.postMessage({ type: "cancel", requestId });
      if (!finish()) return;
      reject(new DOMException("Raster decode was cancelled.", "AbortError"));
    };
    state.timer = globalThis.setTimeout(() => {
      if (!finish()) return;
      reject(new Error("ASSET_DECODE_TIMEOUT"));
    }, 15_000);
    worker.onmessage = ({ data }: MessageEvent<DecodeResponse>) => {
      if (data.requestId !== requestId) return;
      if (!finish()) {
        if (data.type === "result") data.bitmap.close();
        return;
      }
      if (data.type === "result") {
        resolve({ bitmap: data.bitmap, metadata: data.metadata });
      } else if (data.type === "cancelled") {
        reject(new DOMException("Raster decode was cancelled.", "AbortError"));
      } else {
        reject(new Error("ASSET_REJECTED_" + data.reason));
      }
    };
    worker.onerror = () => {
      if (!finish()) return;
      reject(new Error("ASSET_DECODE_FAILED"));
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const owned = new Uint8Array(bytes);
    worker.postMessage({
      type: "decode",
      requestId,
      mediaType,
      bytes: owned.buffer,
      source,
      orientation: options.orientation,
      maxDecodedBytes: options.maxDecodedBytes,
    }, [owned.buffer]);
  });
}
