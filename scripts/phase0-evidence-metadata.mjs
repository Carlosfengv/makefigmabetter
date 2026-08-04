import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const PHASE0_EVIDENCE_METADATA_FORMAT = "makefigma-phase0-evidence-v1";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifact(root, path) {
  return existsSync(path) ? { path: relative(root, path), sha256: sha256(path) } : undefined;
}

function packageVersion(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value.version === "string" ? value.version : undefined;
  } catch { return undefined; }
}

function wasmVersions(path) {
  try {
    const source = readFileSync(path, "utf8");
    return {
      engineSemanticsVersion: numberAfter(source, /pub fn engine_semantics_version\(\) -> u32\s*\{\s*(\d+)/),
      coreSnapshotSchemaVersion: numberAfter(source, /schema_version:\s*(\d+),/),
    };
  } catch { return {}; }
}

function numberAfter(value, expression) {
  const match = value.match(expression);
  return match ? Number(match[1]) : undefined;
}

/** Builds a privacy-safe, reproducible descriptor for one Phase 0 evidence run. */
export function collectPhase0EvidenceMetadata({ root, evidenceDirectory, evidenceUrl, capturedAt = new Date().toISOString(), runtime = process }) {
  const fixture = join(root, "fixtures", "documents", "phase0-basic-card.fixture.json");
  const manifest = join(root, "verification", "phase0", "0.11", "golden-manifest.json");
  const wasmSource = join(root, "crates", "editor-wasm", "src", "lib.rs");
  const wasmBinary = join(root, "src", "wasm", "generated", "editor_wasm_bg.wasm");
  const evidenceArtifacts = [
    "open.log",
    "resize.log",
    "snapshot.txt",
    "readiness.log",
    "phase0-basic-card.png",
    "screenshot.log",
    "console.txt",
    "browser-runtime.log",
    "golden-verification.json",
  ]
    .map((name) => artifact(root, join(evidenceDirectory, name)))
    .filter(Boolean);
  return {
    format: PHASE0_EVIDENCE_METADATA_FORMAT,
    capturedAt,
    evidenceUrl,
    runtime: {
      node: runtime.version,
      platform: runtime.platform,
      architecture: runtime.arch,
    },
    build: {
      applicationVersion: packageVersion(join(root, "package.json")),
      ...wasmVersions(wasmSource),
      wasmBinary: artifact(root, wasmBinary),
    },
    fixture: artifact(root, fixture),
    goldenManifest: artifact(root, manifest),
    artifacts: evidenceArtifacts,
  };
}
