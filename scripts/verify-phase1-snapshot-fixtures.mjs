#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = "fixtures/documents/phase1-snapshot-fixture-manifest.json";
const expectedVersions = [13, 14, 15, 16, 17, 18, 19, 20, 21];
// The current durable projection version emitted by snapshot_json(). The
// manifest's currentSchemaVersion must equal it so a bump on either side that
// forgets the other fails verification (P0-4).
const CURRENT_SCHEMA_VERSION = 21;

export function verifyPhase1SnapshotFixtures({ root = process.cwd() } = {}) {
  const manifest = readJson(root, manifestPath);
  if (
    !manifest
    || manifest.format !== "makefigma-phase1-snapshot-fixture-manifest-v1"
    || manifest.currentSchemaVersion !== CURRENT_SCHEMA_VERSION
    || !Array.isArray(manifest.fixtures)
    || JSON.stringify(manifest.fixtures.map(({ schemaVersion }) => schemaVersion)) !== JSON.stringify(expectedVersions)
  ) return failed("INVALID_MANIFEST");

  // The newest fixture must pin the current emitted projection version, tying
  // the manifest to snapshot_json()'s output rather than tracking it by hand.
  const newest = Math.max(...manifest.fixtures.map(({ schemaVersion }) => schemaVersion));
  if (newest !== CURRENT_SCHEMA_VERSION) return failed("MANIFEST_VERSION_DRIFT", { newest });

  for (const entry of manifest.fixtures) {
    if (!isSha256(entry.sourceSha256) || !isSha256(entry.expectedCanonicalHash)) return failed("INVALID_HASH", { schemaVersion: entry.schemaVersion });
    const bytes = readBytes(root, entry.fixture);
    if (!bytes || sha256(bytes) !== entry.sourceSha256) return failed("FIXTURE_HASH_MISMATCH", { fixture: entry.fixture });
    const fixture = parseJson(bytes);
    if (!validFixture(fixture, entry.schemaVersion)) return failed("INVALID_FIXTURE", { fixture: entry.fixture });
  }
  return { status: "pass", fixtureCount: manifest.fixtures.length };
}

function validFixture(fixture, schemaVersion) {
  if (
    !fixture
    || fixture.schemaVersion !== schemaVersion
    || !Array.isArray(fixture.pages)
    || fixture.pages.length < 2
    || !Array.isArray(fixture.resourceIndex)
    || !Array.isArray(fixture.nodes)
  ) return false;
  const names = new Set(fixture.nodes.map((node) => node?.name));
  const image = fixture.nodes.find((node) => node?.kind === "image" && typeof node.assetId === "string");
  const nested = fixture.nodes.find((node) => typeof node.parentId === "string");
  const text = fixture.nodes.find((node) => node?.kind === "text" && typeof node.text === "string");
  return names.has("Root frame")
    && image
    && nested
    && text
    && fixture.resourceIndex.some((asset) => asset?.assetId === image.assetId);
}

function readJson(root, path) {
  const bytes = readBytes(root, path);
  return bytes ? parseJson(bytes) : undefined;
}
function readBytes(root, path) {
  try { return readFileSync(resolve(root, path)); } catch { return undefined; }
}
function parseJson(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function failed(reason, details = {}) { return { status: "fail", reason, ...details }; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyPhase1SnapshotFixtures();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
}
