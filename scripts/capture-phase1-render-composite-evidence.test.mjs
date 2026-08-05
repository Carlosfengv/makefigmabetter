import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "makefigma-phase1-capture-"));
  directories.push(directory);
  const worker = join(directory, "fake-playwright.sh");
  writeFileSync(worker, `#!/usr/bin/env bash
set -euo pipefail
case "$3" in
  open|resize) echo "ok" ;;
  snapshot) echo "WebGPU scene active · Rust/WASM bridge ready · fixed Phase 1 render composite fixture loaded" ;;
  screenshot) printf "composite-capture" > "$5" ;;
  console) echo "Total messages: 1 (Errors: 0, Warnings: 0)" ;;
  eval) echo '"{\\"samples\\":240,\\"p50Ms\\":0.4,\\"p95Ms\\":0.8,\\"maxMs\\":1.2}"' ;;
  *) echo "unexpected command: $3" >&2; exit 64 ;;
esac
`);
  chmodSync(worker, 0o755);
  return { directory, worker, evidenceDirectory: join(directory, "evidence") };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 1 composite evidence capture", () => {
  it("records a browser proof surface with pending independent Golden review", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase1-render-composite-evidence.sh", "http://localhost:3000", evidenceDirectory], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PWCLI: worker, PHASE1_RENDER_COMPOSITE_WARMUP_SECONDS: "0", PHASE1_RENDER_COMPOSITE_RUNS: "3" },
    });
    expect(result.status).toBe(0);
    const metadata = JSON.parse(readFileSync(join(evidenceDirectory, "evidence-metadata.json"), "utf8"));
    expect(metadata).toMatchObject({ format: "makefigma-phase1-render-composite-evidence-v1", golden: { status: "pending-independent-review" } });
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase1-render-composite.png"))).toBe(true);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "performance-summary.json"), "utf8"))).toMatchObject({ status: "pass", samplesPerRun: 240, median: { p95Ms: 0.8 } });
  });

  it("rejects a run count that cannot produce a median evidence summary", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase1-render-composite-evidence.sh", "http://localhost:3000", evidenceDirectory], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PWCLI: worker, PHASE1_RENDER_COMPOSITE_WARMUP_SECONDS: "0", PHASE1_RENDER_COMPOSITE_RUNS: "1" },
    });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("at least 3");
  });
});
