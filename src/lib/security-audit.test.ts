import { describe, expect, it } from "vitest";
import { auditAssetProbe, auditCancelledAssetProbe } from "./security-audit";

const request = { kind: "svg" as const, declaredMime: 'text/plain; filename="private.svg"', bytes: new TextEncoder().encode("<svg/>") };

describe("asset probe audit events", () => {
  it("emits a versioned accepted event without untrusted source metadata", () => {
    const event = auditAssetProbe(request, { detectedMime: "image/svg+xml", admission: { accepted: true, mime: "image/svg+xml" } }, 4, 12.5);
    expect(event).toEqual({ schemaVersion: 1, sequence: 4, category: "asset-probe", code: "ASSET_PROBE_ACCEPTED", outcome: "accepted", atMs: 12.5, assetKind: "svg", byteLength: 6, detectedMime: "image/svg+xml" });
    expect(JSON.stringify(event)).not.toContain("private");
    expect(JSON.stringify(event)).not.toContain("text/plain");
  });

  it("records structured rejection and cancellation outcomes", () => {
    expect(auditAssetProbe(request, { detectedMime: "<untrusted>", admission: { accepted: false, reason: "UNSAFE_SVG" } }, 5, 2)).toMatchObject({ code: "ASSET_PROBE_REJECTED_UNSAFE_SVG", outcome: "rejected", detectedMime: "unknown" });
    expect(auditCancelledAssetProbe(request, 6, -1)).toMatchObject({ code: "ASSET_PROBE_CANCELLED", outcome: "cancelled", atMs: 0, detectedMime: "unknown" });
  });
});
