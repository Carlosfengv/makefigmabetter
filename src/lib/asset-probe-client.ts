import type { AssetProbeResult } from "./asset-probe";
import type { AssetKind } from "./untrusted-asset";

type ProbeMessage = { type: "result"; requestId: string; detectedMime: string; admission: AssetProbeResult["admission"]; rasterDimensions?: AssetProbeResult["rasterDimensions"] } | { type: "cancelled"; requestId: string };

/** Runs byte admission outside React and the DOM. The transferable buffer keeps
 * a selected file out of the main-thread object graph while it is inspected. */
export function probeAssetInWorker(kind: Extract<AssetKind, "raster-image" | "font">, declaredMime: string, bytes: Uint8Array): Promise<AssetProbeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/asset-probe.worker.ts", import.meta.url));
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      worker.postMessage({ type: "cancel", requestId });
      worker.terminate();
      reject(new Error("ASSET_PROBE_TIMEOUT"));
    }, 5_000);
    worker.onmessage = ({ data }: MessageEvent<ProbeMessage>) => {
      if (data.requestId !== requestId) return;
      window.clearTimeout(timer);
      worker.terminate();
      if (data.type === "cancelled") { reject(new Error("ASSET_PROBE_CANCELLED")); return; }
      resolve({ detectedMime: data.detectedMime, admission: data.admission, ...(data.rasterDimensions ? { rasterDimensions: data.rasterDimensions } : {}) });
    };
    worker.onerror = () => { window.clearTimeout(timer); worker.terminate(); reject(new Error("ASSET_PROBE_FAILED")); };
    const owned = new Uint8Array(bytes);
    worker.postMessage({ type: "probe", requestId, kind, declaredMime, bytes: owned.buffer }, [owned.buffer]);
  });
}
