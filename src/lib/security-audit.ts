import type { AssetProbeRequest, AssetProbeResult } from "./asset-probe";

export const SECURITY_AUDIT_SCHEMA_VERSION = 1;

type AuditedMime = "image/svg+xml" | "image/png" | "image/jpeg" | "image/webp" | "font/woff2" | "font/woff" | "font/ttf" | "font/otf" | "unknown";

/**
 * A privacy-safe event shape for a future audit sink. It intentionally excludes
 * SVG source, file names, declared MIME, request IDs, credentials, and paths.
 */
export interface AssetProbeAuditEvent {
  schemaVersion: typeof SECURITY_AUDIT_SCHEMA_VERSION;
  sequence: number;
  category: "asset-probe";
  code: "ASSET_PROBE_ACCEPTED" | "ASSET_PROBE_CANCELLED" | `ASSET_PROBE_REJECTED_${string}`;
  outcome: "accepted" | "rejected" | "cancelled";
  atMs: number;
  assetKind: AssetProbeRequest["kind"];
  byteLength: number;
  detectedMime: AuditedMime;
}

export function auditAssetProbe(
  request: Pick<AssetProbeRequest, "kind" | "bytes">,
  result: AssetProbeResult,
  sequence: number,
  now = Date.now(),
): AssetProbeAuditEvent {
  if (result.admission.accepted) {
    return event(request, sequence, now, "ASSET_PROBE_ACCEPTED", "accepted", result.detectedMime);
  }
  return event(request, sequence, now, `ASSET_PROBE_REJECTED_${result.admission.reason}`, "rejected", result.detectedMime);
}

export function auditCancelledAssetProbe(
  request: Pick<AssetProbeRequest, "kind" | "bytes">,
  sequence: number,
  now = Date.now(),
): AssetProbeAuditEvent {
  return event(request, sequence, now, "ASSET_PROBE_CANCELLED", "cancelled", "unknown");
}

function event(
  request: Pick<AssetProbeRequest, "kind" | "bytes">,
  sequence: number,
  now: number,
  code: AssetProbeAuditEvent["code"],
  outcome: AssetProbeAuditEvent["outcome"],
  detectedMime: string,
): AssetProbeAuditEvent {
  return {
    schemaVersion: SECURITY_AUDIT_SCHEMA_VERSION,
    sequence: Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0,
    category: "asset-probe",
    code,
    outcome,
    atMs: Number.isFinite(now) && now >= 0 ? now : 0,
    assetKind: request.kind,
    byteLength: request.bytes.byteLength,
    detectedMime: auditedMime(detectedMime),
  };
}

function auditedMime(value: string): AuditedMime {
  return isAuditedMime(value) ? value : "unknown";
}

function isAuditedMime(value: string): value is Exclude<AuditedMime, "unknown"> {
  return ["image/svg+xml", "image/png", "image/jpeg", "image/webp", "font/woff2", "font/woff", "font/ttf", "font/otf"].includes(value);
}
