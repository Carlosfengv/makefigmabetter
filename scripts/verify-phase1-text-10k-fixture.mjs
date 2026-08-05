#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const defaultManifest = "verification/phase1/1.11/text-10k-fixture-manifest.json";
const requiredBytes = 10_000;

export function verifyPhase1Text10kFixture({ manifestPath = defaultManifest, root = process.cwd() } = {}) {
  const absoluteManifest = resolve(root, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absoluteManifest, "utf8"));
  } catch (error) {
    return failed("INVALID_MANIFEST", { manifestPath, message: messageFor(error) });
  }
  if (manifest.format !== "makefigma-phase1-text-10k-manifest-v1" || manifest.fixtureName !== "F-TEXT-10K" || typeof manifest.fixture !== "string" || !isSha256(manifest.fixtureSha256)) {
    return failed("INVALID_MANIFEST", { manifestPath });
  }
  const fixturePath = resolve(root, manifest.fixture);
  if (!existsSync(fixturePath)) return failed("MISSING_FIXTURE", { fixture: manifest.fixture });
  const fixtureSha256 = sha256File(fixturePath);
  if (fixtureSha256 !== manifest.fixtureSha256) return failed("FIXTURE_HASH_MISMATCH", { fixture: manifest.fixture, expected: manifest.fixtureSha256, actual: fixtureSha256 });
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch (error) {
    return failed("INVALID_FIXTURE", { fixture: manifest.fixture, message: messageFor(error) });
  }
  if (fixture.format !== "makefigma-phase1-fixture-v1" || fixture.name !== "F-TEXT-10K" || !Array.isArray(fixture.nodes)) return failed("INVALID_FIXTURE", { fixture: manifest.fixture });
  const source = fixture.nodes.find((node) => node.name === "F-TEXT-10K source" && node.kind === "text");
  if (!source || typeof source.text !== "string" || new TextEncoder().encode(source.text).byteLength !== requiredBytes) return failed("INVALID_TEXT_LENGTH", { fixture: manifest.fixture, expectedBytes: requiredBytes });
  const run = source.textProperties?.runs?.[0];
  if (!run || source.textProperties.runs.length !== 1 || run.start !== 0 || run.end !== requiredBytes) return failed("INVALID_UTF8_STYLE_RUN", { fixture: manifest.fixture });
  return { status: "pass", fixture: manifest.fixture, fixtureSha256, textByteLength: requiredBytes };
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function messageFor(error) { return error instanceof Error ? error.message : "unreadable"; }
function failed(reason, details) { return { status: "fail", reason, ...details }; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyPhase1Text10kFixture();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
}
