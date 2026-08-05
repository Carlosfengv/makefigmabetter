/// <reference lib="webworker" />

import { probeUntrustedAsset, type AssetProbeResult } from "../lib/asset-probe";
import { AssetProbeBudget } from "../lib/asset-probe-budget";
import type { AssetAdmission, AssetKind } from "../lib/untrusted-asset";
import { auditAssetProbe, auditCancelledAssetProbe, type AssetProbeAuditEvent } from "../lib/security-audit";

declare const self: DedicatedWorkerGlobalScope;

type ProbeRequest = {
  type: "probe";
  requestId: string;
  kind: AssetKind;
  declaredMime: string;
  bytes: ArrayBuffer;
};
type CancelRequest = { type: "cancel"; requestId: string };
type MainToAssetProbe = ProbeRequest | CancelRequest;
type AssetProbeResponse =
  | { type: "result"; requestId: string; detectedMime: string; admission: AssetAdmission; rasterDimensions?: AssetProbeResult["rasterDimensions"]; audit: AssetProbeAuditEvent }
  | { type: "cancelled"; requestId: string; audit: AssetProbeAuditEvent };

const cancelledRequests = new Set<string>();
const scheduledRequests = new Set<string>();
const budget = new AssetProbeBudget();
let auditSequence = 0;

function emit(response: AssetProbeResponse) {
  self.postMessage(response);
}

/**
 * The probe deliberately yields once before reading data. A cancellation received
 * before that point prevents all inspection; a cancellation received during this
 * short, bounded synchronous probe suppresses its result. Full decoders remain a
 * later isolated pipeline with their own interruption support.
 */
self.onmessage = ({ data }: MessageEvent<MainToAssetProbe>) => {
  if (data.type === "cancel") {
    if (scheduledRequests.has(data.requestId)) cancelledRequests.add(data.requestId);
    return;
  }

  const bytes = new Uint8Array(data.bytes);
  if (!budget.reserve(data.requestId, bytes.byteLength)) {
    const admission: AssetAdmission = { accepted: false, reason: "RESOURCE_LIMIT" };
    emit({ type: "result", requestId: data.requestId, detectedMime: "", admission, audit: auditAssetProbe({ kind: data.kind, bytes }, { detectedMime: "", admission }, ++auditSequence) });
    return;
  }
  scheduledRequests.add(data.requestId);
  // A task (rather than a microtask) gives a following cancellation message a
  // real chance to arrive before any UTF-8/header inspection begins.
  setTimeout(() => {
    try {
      if (cancelledRequests.delete(data.requestId)) {
        emit({ type: "cancelled", requestId: data.requestId, audit: auditCancelledAssetProbe({ kind: data.kind, bytes }, ++auditSequence) });
        return;
      }

      const result = probeUntrustedAsset({
        kind: data.kind,
        declaredMime: data.declaredMime,
        bytes,
      });
      if (cancelledRequests.delete(data.requestId)) {
        emit({ type: "cancelled", requestId: data.requestId, audit: auditCancelledAssetProbe({ kind: data.kind, bytes }, ++auditSequence) });
        return;
      }
      emit({ type: "result", requestId: data.requestId, ...result, audit: auditAssetProbe({ kind: data.kind, bytes }, result, ++auditSequence) });
    } catch {
      const admission: AssetAdmission = { accepted: false, reason: "CORRUPT_DATA" };
      emit({ type: "result", requestId: data.requestId, detectedMime: "", admission, audit: auditAssetProbe({ kind: data.kind, bytes }, { detectedMime: "", admission }, ++auditSequence) });
    } finally {
      scheduledRequests.delete(data.requestId);
      budget.release(data.requestId);
    }
  });
};
