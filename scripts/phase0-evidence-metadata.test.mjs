import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPhase0EvidenceMetadata, PHASE0_EVIDENCE_METADATA_FORMAT } from "./phase0-evidence-metadata.mjs";

const directories = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "makefigma-evidence-"));
  directories.push(root);
  const fixtureDirectory = join(root, "fixtures", "documents");
  const manifestDirectory = join(root, "verification", "phase0", "0.11");
  const wasmDirectory = join(root, "crates", "editor-wasm", "src");
  const evidenceDirectory = join(root, "output");
  for (const directory of [fixtureDirectory, manifestDirectory, wasmDirectory, evidenceDirectory]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  writeFileSync(join(wasmDirectory, "lib.rs"), "pub fn engine_semantics_version() -> u32 { 3 }\nlet snapshot = CoreSnapshot { schema_version: 9, };\n");
  writeFileSync(join(fixtureDirectory, "phase0-basic-card.fixture.json"), "fixture");
  writeFileSync(join(manifestDirectory, "golden-manifest.json"), "manifest");
  for (const [name, value] of Object.entries({
    "open.log": "open", "resize.log": "resize", "snapshot.txt": "snapshot", "readiness.log": "ready",
    "phase0-basic-card.png": "capture", "screenshot.log": "screenshot", "console.txt": "console",
    "browser-runtime.log": "runtime", "golden-verification.json": "verification",
  })) writeFileSync(join(evidenceDirectory, name), value);
  return { root, evidenceDirectory };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 0 evidence metadata", () => {
  it("records stable inputs, available artifacts, and no document content", () => {
    const { root, evidenceDirectory } = setup();
    const metadata = collectPhase0EvidenceMetadata({ root, evidenceDirectory, evidenceUrl: "http://localhost:3000/?fixture=phase0-basic-card", capturedAt: "2026-08-03T00:00:00.000Z", runtime: { version: "v1", platform: "test", arch: "x64" } });
    expect(metadata).toMatchObject({
      format: PHASE0_EVIDENCE_METADATA_FORMAT,
      capturedAt: "2026-08-03T00:00:00.000Z",
      runtime: { node: "v1", platform: "test", architecture: "x64" },
      build: { applicationVersion: "0.1.0-test", engineSemanticsVersion: 3, coreSnapshotSchemaVersion: 9 },
      fixture: { path: "fixtures/documents/phase0-basic-card.fixture.json" },
      goldenManifest: { path: "verification/phase0/0.11/golden-manifest.json" },
    });
    expect(metadata.artifacts.map((entry) => entry.path)).toEqual([
      "output/open.log", "output/resize.log", "output/snapshot.txt", "output/readiness.log",
      "output/phase0-basic-card.png", "output/screenshot.log", "output/console.txt",
      "output/browser-runtime.log", "output/golden-verification.json",
    ]);
  });
});
