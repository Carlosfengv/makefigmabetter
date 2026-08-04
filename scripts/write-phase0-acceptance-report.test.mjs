import { describe, expect, it } from "vitest";
import { renderPhase0AcceptanceReport } from "./write-phase0-acceptance-report.mjs";

describe("Phase 0.11 acceptance report", () => {
  it("records build identity and keeps a Golden mismatch as a failed human-acceptance result", () => {
    const report = renderPhase0AcceptanceReport({
      evidenceDirectory: "output/evidence",
      metadata: {
        capturedAt: "2026-08-04T00:00:00.000Z",
        evidenceUrl: "http://localhost:3000/?fixture=phase0-basic-card&renderer=canvas2d",
        runtime: { node: "v23", platform: "test", architecture: "x64" },
        build: { applicationVersion: "0.1.0", engineSemanticsVersion: 3, coreSnapshotSchemaVersion: 9, wasmBinary: { sha256: "wasm-hash" } },
        fixture: { path: "fixtures/documents/phase0-basic-card.fixture.json", sha256: "fixture-hash" },
        goldenManifest: { path: "verification/phase0/0.11/golden-manifest.json", sha256: "manifest-hash" },
      },
      verification: {
        status: "fail", reason: "GOLDEN_MISMATCH", baseline: "fixtures/golden.png", baselineSha256: "baseline-hash", captureSha256: "capture-hash",
        viewport: { width: 1440, height: 960, dpr: 1 },
      },
    });

    expect(report).toContain("WASM semantics 3；Core Snapshot schema 9；WASM SHA-256 wasm-hash");
    expect(report).toContain("| Result | FAIL：GOLDEN_MISMATCH |");
    expect(report).toContain("Sign-off | 验收人、日期：待填写");
  });
});
