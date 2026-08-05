#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const defaultManifest = "verification/phase1/1.11/asset-hostile-fixture-manifest.json";
const requiredIds = ["svg-script", "svg-external-reference", "forged-png-mime", "truncated-png", "decode-amplified-png", "valid-woff2-container"];

export function verifyPhase1AssetHostileFixture({ manifestPath = defaultManifest, root = process.cwd() } = {}) {
  const absoluteManifest = resolve(root, manifestPath);
  let manifest;
  try { manifest = JSON.parse(readFileSync(absoluteManifest, "utf8")); } catch (error) { return failed("INVALID_MANIFEST", { manifestPath, message: messageFor(error) }); }
  if (manifest.format !== "makefigma-phase1-asset-hostile-manifest-v1" || manifest.fixtureName !== "F-ASSET-HOSTILE" || typeof manifest.fixture !== "string" || !isSha256(manifest.fixtureSha256) || JSON.stringify(manifest.caseIds) !== JSON.stringify(requiredIds)) return failed("INVALID_MANIFEST", { manifestPath });
  const fixturePath = resolve(root, manifest.fixture);
  if (!existsSync(fixturePath)) return failed("MISSING_FIXTURE", { fixture: manifest.fixture });
  const fixtureSha256 = sha256File(fixturePath);
  if (fixtureSha256 !== manifest.fixtureSha256) return failed("FIXTURE_HASH_MISMATCH", { fixture: manifest.fixture, expected: manifest.fixtureSha256, actual: fixtureSha256 });
  let fixture;
  try { fixture = JSON.parse(readFileSync(fixturePath, "utf8")); } catch (error) { return failed("INVALID_FIXTURE", { fixture: manifest.fixture, message: messageFor(error) }); }
  const ids = Array.isArray(fixture.cases) ? fixture.cases.map((entry) => entry?.id) : [];
  if (fixture.format !== "makefigma-phase1-asset-fixture-v1" || fixture.name !== manifest.fixtureName || JSON.stringify(ids) !== JSON.stringify(requiredIds)) return failed("INVALID_FIXTURE", { fixture: manifest.fixture });
  return { status: "pass", fixture: manifest.fixture, fixtureSha256, caseCount: ids.length };
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function messageFor(error) { return error instanceof Error ? error.message : "unreadable"; }
function failed(reason, details) { return { status: "fail", reason, ...details }; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyPhase1AssetHostileFixture();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
}
