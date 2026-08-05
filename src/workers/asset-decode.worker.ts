/// <reference lib="webworker" />

import { probeUntrustedAsset } from "../lib/asset-probe";
import { declaredRasterAlpha, declaredRasterColorProfile, decodedRasterByteLength, dimensionsMatchAfterOrientation, jpegExifOrientation, rasterDecodeOptions, type RasterOrientation } from "../lib/raster-decode-policy";

declare const self: DedicatedWorkerGlobalScope;

type DecodeRequest = {
  type: "decode";
  requestId: string;
  mediaType: string;
  bytes: ArrayBuffer;
  source: { width: number; height: number };
  orientation?: RasterOrientation;
  maxDecodedBytes?: number;
};
type CancelRequest = { type: "cancel"; requestId: string };

const cancelled = new Set<string>();

self.onmessage = ({ data }: MessageEvent<DecodeRequest | CancelRequest>) => {
  if (data.type === "cancel") {
    cancelled.add(data.requestId);
    return;
  }
  void decode(data);
};

async function decode(request: DecodeRequest) {
  try {
    const bytes = new Uint8Array(request.bytes);
    const probe = probeUntrustedAsset({ kind: "raster-image", declaredMime: request.mediaType, bytes });
    if (!probe.admission.accepted || !probe.rasterDimensions) {
      self.postMessage({ type: "rejected", requestId: request.requestId, reason: probe.admission.accepted ? "CORRUPT_DATA" : probe.admission.reason });
      return;
    }
    if (probe.rasterDimensions.width !== request.source.width || probe.rasterDimensions.height !== request.source.height) {
      self.postMessage({ type: "rejected", requestId: request.requestId, reason: "CORRUPT_DATA" });
      return;
    }
    if (cancelled.delete(request.requestId)) {
      self.postMessage({ type: "cancelled", requestId: request.requestId });
      return;
    }
    const orientation = request.orientation ?? (probe.admission.mime === "image/jpeg" ? jpegExifOrientation(bytes) : 1);
    const maxDecodedBytes = request.maxDecodedBytes;
    if (maxDecodedBytes !== undefined && (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes <= 0)) {
      self.postMessage({ type: "rejected", requestId: request.requestId, reason: "RESOURCE_LIMIT" });
      return;
    }
    const options = rasterDecodeOptions(request.source, maxDecodedBytes);
    const bitmap = await createImageBitmap(
      new Blob([request.bytes], { type: request.mediaType }),
      options,
    );
    if (cancelled.delete(request.requestId)) {
      bitmap.close();
      self.postMessage({ type: "cancelled", requestId: request.requestId });
      return;
    }
    const decoded = { width: bitmap.width, height: bitmap.height };
    const byteLength = decodedRasterByteLength(decoded, maxDecodedBytes);
    const resized = Boolean(options?.resizeWidth);
    if (
      !byteLength
      || (!resized && !dimensionsMatchAfterOrientation(request.source, decoded, orientation))
    ) {
      bitmap.close();
      self.postMessage({ type: "rejected", requestId: request.requestId, reason: "CORRUPT_DATA" });
      return;
    }
    self.postMessage({
      type: "result",
      requestId: request.requestId,
      bitmap,
      metadata: {
        source: request.source,
        decoded,
        orientation: "normalized",
        sourceColorProfile: declaredRasterColorProfile(probe.admission.mime, bytes),
        canonicalColorSpace: "srgb",
        alpha: declaredRasterAlpha(probe.admission.mime, bytes),
        decodedByteLength: byteLength,
      },
    }, [bitmap]);
  } catch {
    self.postMessage({ type: "rejected", requestId: request.requestId, reason: "CORRUPT_DATA" });
  }
}
