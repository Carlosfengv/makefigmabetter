import type { AssetProbeResult } from "./asset-probe";
import type { AssetKind } from "./untrusted-asset";
import { createId } from "./editor-protocol";

type ProbeMessage = { type: "result"; requestId: string; detectedMime: string; admission: AssetProbeResult["admission"]; rasterDimensions?: AssetProbeResult["rasterDimensions"] } | { type: "cancelled"; requestId: string };

/** Runs byte admission outside React and the DOM. The transferable buffer keeps
 * a selected file out of the main-thread object graph while it is inspected. */
export function probeAssetInWorker(
  kind: Extract<AssetKind, "raster-image" | "font">,
  declaredMime: string,
  bytes: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<AssetProbeResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Asset probe was cancelled.", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("../workers/asset-probe.worker.ts", import.meta.url));
    const requestId = createId();
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      globalThis.clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      worker.terminate();
      return true;
    };
    const cancel = () => {
      if (finished) return;
      worker.postMessage({ type: "cancel", requestId });
      if (!finish()) return;
      reject(new DOMException("Asset probe was cancelled.", "AbortError"));
    };
    const timer = globalThis.setTimeout(() => {
      worker.postMessage({ type: "cancel", requestId });
      if (!finish()) return;
      reject(new Error("ASSET_PROBE_TIMEOUT"));
    }, 5_000);
    worker.onmessage = ({ data }: MessageEvent<ProbeMessage>) => {
      if (data.requestId !== requestId) return;
      if (!finish()) return;
      if (data.type === "cancelled") { reject(new Error("ASSET_PROBE_CANCELLED")); return; }
      resolve({ detectedMime: data.detectedMime, admission: data.admission, ...(data.rasterDimensions ? { rasterDimensions: data.rasterDimensions } : {}) });
    };
    worker.onerror = () => { if (finish()) reject(new Error("ASSET_PROBE_FAILED")); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const owned = new Uint8Array(bytes);
    worker.postMessage({ type: "probe", requestId, kind, declaredMime, bytes: owned.buffer }, [owned.buffer]);
  });
}
