#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const defaultManifest = "verification/phase1/1.11/shape-100k-fixture-manifest.json";
const expectedDistribution = { rectangle: 80_000, ellipse: 10_000, text: 6_000, frame: 4_000 };

export function verifyPhase1Shape100kFixture({ manifestPath = defaultManifest, root = process.cwd() } = {}) {
  const absoluteManifest = resolve(root, manifestPath);
  let manifest;
  try { manifest = JSON.parse(readFileSync(absoluteManifest, "utf8")); } catch (error) { return failed("INVALID_MANIFEST", { manifestPath, message: messageFor(error) }); }
  if (
    manifest.format !== "makefigma-phase1-shape-100k-manifest-v1"
    || manifest.fixtureName !== "F-SHAPE-100K"
    || manifest.generator !== "phase1-shape-100k-v1"
    || manifest.seed !== 1_507_138_393
    || manifest.nodeCount !== 100_000
    || JSON.stringify(manifest.distribution) !== JSON.stringify(expectedDistribution)
    || typeof manifest.fixture !== "string"
    || !isSha256(manifest.fixtureSha256)
  ) return failed("INVALID_MANIFEST", { manifestPath });
  const fixturePath = resolve(root, manifest.fixture);
  if (!existsSync(fixturePath)) return failed("MISSING_FIXTURE", { fixture: manifest.fixture });
  const fixtureSha256 = sha256File(fixturePath);
  if (fixtureSha256 !== manifest.fixtureSha256) return failed("FIXTURE_HASH_MISMATCH", { fixture: manifest.fixture, expected: manifest.fixtureSha256, actual: fixtureSha256 });
  let fixture;
  try { fixture = JSON.parse(readFileSync(fixturePath, "utf8")); } catch (error) { return failed("INVALID_FIXTURE", { fixture: manifest.fixture, message: messageFor(error) }); }
  if (
    fixture.format !== "makefigma-phase1-generated-fixture-v1"
    || fixture.name !== manifest.fixtureName
    || fixture.generator !== manifest.generator
    || fixture.seed !== manifest.seed
    || fixture.nodeCount !== manifest.nodeCount
    || JSON.stringify(fixture.distribution) !== JSON.stringify(expectedDistribution)
  ) return failed("INVALID_FIXTURE", { fixture: manifest.fixture });
  return { status: "pass", fixture: manifest.fixture, fixtureSha256, nodeCount: fixture.nodeCount, distribution: fixture.distribution };
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function messageFor(error) { return error instanceof Error ? error.message : "unreadable"; }
function failed(reason, details) { return { status: "fail", reason, ...details }; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyPhase1Shape100kFixture();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
}
