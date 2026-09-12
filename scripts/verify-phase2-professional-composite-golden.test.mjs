import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPhase2ProfessionalCompositeGolden } from "./verify-phase2-professional-composite-golden.mjs";

const directories = [];

function png({ rgba = [18, 52, 86, 255], ancillary = false, width = 1_440, height = 960 } = {}) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    const start = row * (width * 4 + 1);
    scanlines[start] = 0;
    for (let column = 0; column < width; column += 1) Buffer.from(rgba).copy(scanlines, start + 1 + column * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...(ancillary ? [chunk("tEXt", Buffer.from("fixture=encoded-differently"))] : []),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function setup({ status = "reviewed", capture = "same" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "makefigma-q1-golden-"));
  directories.push(root);
  writeFileSync(join(root, "fixture.ts"), "fixture");
  const baseline = png();
  const captured = capture === "same" ? baseline : capture === "equivalent-pixels" ? png({ ancillary: true }) : png({ rgba: [18, 52, 87, 255] });
  writeFileSync(join(root, "baseline.png"), baseline);
  writeFileSync(join(root, "capture.png"), captured);
  const fixtureSha256 = "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d";
  const baselineSha256 = sha256(baseline);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    format: "makefigma-golden-manifest-v1", fixtureName: "F-PHASE2-PROFESSIONAL-COMPOSITE", fixture: "fixture.ts", fixtureSha256,
    captures: [{ id: "phase2-professional-composite-1440x960-dpr1", backend: "WebGPU + Canvas 2D overlay", viewport: { width: 1440, height: 960, dpr: 1, zoom: 1 }, baseline: "baseline.png", baselineSha256: status === "pending" ? "TO_BE_RECORDED_BY_REVIEWED_CAPTURE" : baselineSha256, pixelTolerance: 0, status: status === "pending" ? "pending-reviewed-baseline" : "reviewed" }],
  }));
  return { root, manifestPath: "manifest.json", capturePath: "capture.png" };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Q1 professional composite Golden verifier", () => {
  it("passes only when the fixture, reviewed baseline, and capture hashes agree", () => {
    expect(verifyPhase2ProfessionalCompositeGolden(setup())).toMatchObject({ status: "pass", pixelDiff: { differentPixels: 0 } });
  });

  it("keeps a candidate pending until an independent reviewer freezes the baseline", () => {
    expect(verifyPhase2ProfessionalCompositeGolden(setup({ status: "pending" }))).toMatchObject({ status: "pending", reason: "PENDING_REVIEWED_BASELINE" });
  });

  it("fails a changed capture instead of accepting a visual regression", () => {
    const fixture = setup({ capture: "different" });
    const result = verifyPhase2ProfessionalCompositeGolden({ ...fixture, diffPath: "golden-diff.png" });
    expect(result).toMatchObject({ status: "fail", reason: "GOLDEN_MISMATCH", pixelDiff: { differentPixels: 1_382_400, maximumChannelDelta: 1 }, diff: join(fixture.root, "golden-diff.png") });
    expect(readFileSync(join(fixture.root, "golden-diff.png")).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("rejects a screenshot whose actual PNG dimensions do not meet the fixed capture contract and writes a diff", () => {
    const fixture = setup();
    writeFileSync(join(fixture.root, fixture.capturePath), png({ width: 1_439, height: 960 }));
    const result = verifyPhase2ProfessionalCompositeGolden({ ...fixture, diffPath: "golden-diff.png" });
    expect(result).toMatchObject({ status: "fail", reason: "GOLDEN_DIMENSIONS_MISMATCH", expectedWidth: 1_440, expectedHeight: 960, diff: join(fixture.root, "golden-diff.png") });
    expect(readFileSync(join(fixture.root, "golden-diff.png")).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("accepts a byte-different PNG when its reviewed RGBA pixels are identical", () => {
    expect(verifyPhase2ProfessionalCompositeGolden(setup({ capture: "equivalent-pixels" }))).toMatchObject({ status: "pass", pixelDiff: { differentPixels: 0 } });
  });

  it("reports invalid image input as structured Golden evidence", () => {
    const fixture = setup({ capture: "different" });
    writeFileSync(join(fixture.root, fixture.capturePath), "not a PNG");
    expect(verifyPhase2ProfessionalCompositeGolden(fixture)).toMatchObject({ status: "fail", reason: "INVALID_PNG" });
  });

  it("does not accept matching bytes that are not valid reviewed screenshots", () => {
    const fixture = setup();
    writeFileSync(join(fixture.root, "baseline.png"), "not a PNG");
    writeFileSync(join(fixture.root, fixture.capturePath), "not a PNG");
    const manifest = JSON.parse(readFileSync(join(fixture.root, fixture.manifestPath), "utf8"));
    manifest.captures[0].baselineSha256 = sha256(Buffer.from("not a PNG"));
    writeFileSync(join(fixture.root, fixture.manifestPath), JSON.stringify(manifest));
    expect(verifyPhase2ProfessionalCompositeGolden(fixture)).toMatchObject({ status: "fail", reason: "INVALID_PNG" });
  });

  it("rejects a manifest that weakens the fixed WebGPU plus Canvas capture contract", () => {
    const fixture = setup();
    const manifest = JSON.parse(readFileSync(join(fixture.root, fixture.manifestPath), "utf8"));
    manifest.captures[0].backend = "Canvas 2D";
    writeFileSync(join(fixture.root, fixture.manifestPath), JSON.stringify(manifest));
    expect(verifyPhase2ProfessionalCompositeGolden(fixture)).toMatchObject({ status: "fail", reason: "INVALID_MANIFEST" });
  });
});
