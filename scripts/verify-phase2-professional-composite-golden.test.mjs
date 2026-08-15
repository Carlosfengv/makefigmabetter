import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPhase2ProfessionalCompositeGolden } from "./verify-phase2-professional-composite-golden.mjs";

const directories = [];

function setup({ status = "reviewed", capture = "same" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "makefigma-q1-golden-"));
  directories.push(root);
  writeFileSync(join(root, "fixture.ts"), "fixture");
  writeFileSync(join(root, "baseline.png"), "image");
  writeFileSync(join(root, "capture.png"), capture === "same" ? "image" : "different");
  const fixtureSha256 = "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d";
  const baselineSha256 = "6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d";
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    format: "makefigma-golden-manifest-v1", fixtureName: "F-PHASE2-PROFESSIONAL-COMPOSITE", fixture: "fixture.ts", fixtureSha256,
    captures: [{ id: "phase2-professional-composite-1440x960-dpr1", backend: "WebGPU + Canvas 2D overlay", viewport: { width: 1440, height: 960, dpr: 1, zoom: 1 }, baseline: "baseline.png", baselineSha256: status === "pending" ? "TO_BE_RECORDED_BY_REVIEWED_CAPTURE" : baselineSha256, pixelTolerance: 0, status: status === "pending" ? "pending-reviewed-baseline" : "reviewed" }],
  }));
  return { root, manifestPath: "manifest.json", capturePath: "capture.png" };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Q1 professional composite Golden verifier", () => {
  it("passes only when the fixture, reviewed baseline, and capture hashes agree", () => {
    expect(verifyPhase2ProfessionalCompositeGolden(setup())).toMatchObject({ status: "pass", captureSha256: "6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d" });
  });

  it("keeps a candidate pending until an independent reviewer freezes the baseline", () => {
    expect(verifyPhase2ProfessionalCompositeGolden(setup({ status: "pending" }))).toMatchObject({ status: "pending", reason: "PENDING_REVIEWED_BASELINE" });
  });

  it("fails a changed capture instead of accepting a visual regression", () => {
    expect(verifyPhase2ProfessionalCompositeGolden(setup({ capture: "different" }))).toMatchObject({ status: "fail", reason: "GOLDEN_MISMATCH" });
  });

  it("rejects a manifest that weakens the fixed WebGPU plus Canvas capture contract", () => {
    const fixture = setup();
    const manifest = JSON.parse(readFileSync(join(fixture.root, fixture.manifestPath), "utf8"));
    manifest.captures[0].backend = "Canvas 2D";
    writeFileSync(join(fixture.root, fixture.manifestPath), JSON.stringify(manifest));
    expect(verifyPhase2ProfessionalCompositeGolden(fixture)).toMatchObject({ status: "fail", reason: "INVALID_MANIFEST" });
  });
});
