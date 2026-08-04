#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const defaultManifest = "verification/phase0/0.11/golden-manifest.json";
const pendingMarker = "TO_BE_RECORDED_BY_REVIEWED_CAPTURE";

export function verifyPhase0Golden({ capturePath, manifestPath = defaultManifest, root = process.cwd() }) {
  const absoluteManifest = resolve(root, manifestPath);
  const absoluteCapture = resolve(root, capturePath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absoluteManifest, "utf8"));
  } catch (error) {
    return failed("INVALID_MANIFEST", { manifestPath, message: error instanceof Error ? error.message : "unreadable manifest" });
  }
  if (manifest.format !== "makefigma-golden-manifest-v1" || !Array.isArray(manifest.captures) || manifest.captures.length !== 1) {
    return failed("INVALID_MANIFEST", { manifestPath, message: "expected one makefigma-golden-manifest-v1 capture" });
  }
  const capture = manifest.captures[0];
  if (!isExpectedCapture(capture)) return failed("INVALID_MANIFEST", { manifestPath, message: "expected the fixed Canvas 2D DPR 1 Phase 0 capture contract" });
  if (!isSha256(manifest.fixtureSha256)) return failed("INVALID_MANIFEST", { manifestPath, message: "fixtureSha256 must be SHA-256" });
  const fixturePath = resolve(root, manifest.fixture);
  if (!existsSync(fixturePath)) return failed("MISSING_FIXTURE", { fixture: manifest.fixture });
  const fixtureSha256 = sha256File(fixturePath);
  if (fixtureSha256 !== manifest.fixtureSha256) return failed("FIXTURE_HASH_MISMATCH", { expected: manifest.fixtureSha256, actual: fixtureSha256 });
  if (!existsSync(absoluteCapture)) return failed("MISSING_CAPTURE", { capturePath });
  const captureSha256 = sha256File(absoluteCapture);
  const base = { fixture: manifest.fixture, fixtureSha256, capture: capturePath, captureSha256, backend: capture.backend, viewport: capture.viewport };
  if (capture.status === "pending-reviewed-baseline" || capture.baselineSha256 === pendingMarker || !existsSync(resolve(root, capture.baseline))) {
    return { status: "pending", reason: "PENDING_REVIEWED_BASELINE", ...base, baseline: capture.baseline };
  }
  if (!isSha256(capture.baselineSha256)) return failed("INVALID_MANIFEST", { ...base, message: "baselineSha256 must be SHA-256" });
  const baselinePath = resolve(root, capture.baseline);
  const baselineSha256 = sha256File(baselinePath);
  if (baselineSha256 !== capture.baselineSha256) return failed("BASELINE_HASH_MISMATCH", { ...base, expected: capture.baselineSha256, actual: baselineSha256 });
  if (captureSha256 !== baselineSha256) return failed("GOLDEN_MISMATCH", { ...base, baseline: capture.baseline, baselineSha256, pixelTolerance: capture.pixelTolerance });
  return { status: "pass", ...base, baseline: capture.baseline, baselineSha256, pixelTolerance: capture.pixelTolerance };
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function isExpectedCapture(capture) {
  return capture && capture.id === "phase0-basic-card-canvas2d-dpr1"
    && capture.backend === "Canvas 2D"
    && capture.viewport?.width === 1440
    && capture.viewport?.height === 960
    && capture.viewport?.dpr === 1
    && capture.viewport?.zoom === 1
    && capture.pixelTolerance === 0
    && (capture.status === "pending-reviewed-baseline" || capture.status === "reviewed");
}
function failed(reason, details) { return { status: "fail", reason, ...details }; }

function parseArgs(args) {
  let capturePath;
  let manifestPath = defaultManifest;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--manifest") manifestPath = args[++index] ?? "";
    else if (!capturePath) capturePath = args[index];
    else return undefined;
  }
  return capturePath ? { capturePath, manifestPath } : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(`Usage: node ${dirname(fileURLToPath(import.meta.url))}/verify-phase0-golden.mjs <capture.png> [--manifest <manifest.json>]`);
    process.exitCode = 64;
  } else {
    const result = verifyPhase0Golden(args);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "pass" ? 0 : result.status === "pending" ? 2 : 1;
  }
}
