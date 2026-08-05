#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const defaultManifest = "verification/phase1/1.11/text-fixture-manifest.json";

export function verifyPhase1TextFixture({ manifestPath = defaultManifest, root = process.cwd() } = {}) {
  const absoluteManifest = resolve(root, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absoluteManifest, "utf8"));
  } catch (error) {
    return failed("INVALID_MANIFEST", { manifestPath, message: messageFor(error) });
  }
  if (
    manifest.format !== "makefigma-phase1-text-fixture-manifest-v1"
    || typeof manifest.fixture !== "string"
    || !isSha256(manifest.fixtureSha256)
    || manifest.fixtureName !== "F-TEXT-MULTILINGUAL"
    || !Array.isArray(manifest.requiredNodeNames)
  ) return failed("INVALID_MANIFEST", { manifestPath });

  const fixturePath = resolve(root, manifest.fixture);
  if (!existsSync(fixturePath)) return failed("MISSING_FIXTURE", { fixture: manifest.fixture });
  const fixtureSha256 = sha256File(fixturePath);
  if (fixtureSha256 !== manifest.fixtureSha256) {
    return failed("FIXTURE_HASH_MISMATCH", { fixture: manifest.fixture, expected: manifest.fixtureSha256, actual: fixtureSha256 });
  }
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch (error) {
    return failed("INVALID_FIXTURE", { fixture: manifest.fixture, message: messageFor(error) });
  }
  if (fixture.format !== "makefigma-phase1-fixture-v1" || fixture.name !== manifest.fixtureName || !Array.isArray(fixture.nodes)) {
    return failed("INVALID_FIXTURE", { fixture: manifest.fixture });
  }
  const names = new Set(fixture.nodes.map((node) => node.name));
  if (!manifest.requiredNodeNames.every((name) => names.has(name))) {
    return failed("MISSING_TEXT_CASE", { fixture: manifest.fixture });
  }
  const textFailure = fixture.nodes.find((node) => node.kind === "text" && !hasValidRuns(node));
  if (textFailure) return failed("INVALID_UTF8_STYLE_RUN", { fixture: manifest.fixture, nodeId: textFailure.id });
  return {
    status: "pass",
    fixture: manifest.fixture,
    fixtureSha256,
    textNodeCount: fixture.nodes.filter((node) => node.kind === "text").length,
  };
}

function hasValidRuns(node) {
  const properties = node.textProperties;
  if (!properties || !Array.isArray(properties.runs)) return false;
  const text = typeof node.text === "string" ? node.text : "";
  const encoder = new TextEncoder();
  const boundaries = new Set([0]);
  let byteOffset = 0;
  for (const scalar of text) {
    byteOffset += encoder.encode(scalar).byteLength;
    boundaries.add(byteOffset);
  }
  let expectedStart = 0;
  for (const run of properties.runs) {
    if (!Number.isInteger(run.start) || !Number.isInteger(run.end) || run.start !== expectedStart || run.end <= run.start || !boundaries.has(run.start) || !boundaries.has(run.end)) return false;
    expectedStart = run.end;
  }
  return properties.runs.length === 0 || expectedStart === byteOffset;
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function messageFor(error) { return error instanceof Error ? error.message : "unreadable"; }
function failed(reason, details) { return { status: "fail", reason, ...details }; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyPhase1TextFixture();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
}
