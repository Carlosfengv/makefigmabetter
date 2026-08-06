import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "makefigma-phase2-capture-"));
  directories.push(directory);
  const worker = join(directory, "fake-playwright.sh");
  writeFileSync(worker, `#!/usr/bin/env bash
set -euo pipefail
case "$3" in
  open|resize) echo "ok" ;;
  snapshot) echo "Rust/WASM bridge ready · fixed Phase 2 common-nodes fixture loaded" ;;
  screenshot) printf "phase2-capture" > "$5" ;;
  console) echo "Total messages: 1 (Errors: 0, Warnings: 0)" ;;
  eval) if [[ "$*" == *"userAgent"* ]]; then echo '{"userAgent":"fixture-chromium","viewport":{"width":1440,"height":960},"dpr":1,"webgpu":true}'; else echo '{"render":{"samples":64,"p50Ms":0.6,"p95Ms":0.9,"maxMs":1.5,"inputToRenderSamples":64,"inputToRenderP95Ms":19},"input":{"samples":63,"p50Ms":16,"p95Ms":18,"maxMs":19}}'; fi ;;
  *) echo "unexpected command: $3" >&2; exit 64 ;;
esac
`);
  chmodSync(worker, 0o755);
  return { worker, evidenceDirectory: join(directory, "evidence") };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 2 common-nodes evidence capture", () => {
  it("records a fixed browser proof surface pending independent Golden review", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-common-nodes-evidence.sh", "http://localhost:3013", evidenceDirectory], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PWCLI: worker, PHASE2_COMMON_NODES_WARMUP_SECONDS: "0" } });
    expect(result.status).toBe(0);
    const metadata = JSON.parse(readFileSync(join(evidenceDirectory, "evidence-metadata.json"), "utf8"));
    expect(metadata).toMatchObject({ format: "makefigma-phase2-common-nodes-evidence-v1", browserEnvironment: { userAgent: "fixture-chromium", dpr: 1 }, golden: { status: "pending-independent-review", candidatePolicy: { comparison: "rgba-pixel-diff", requiresReviewerFreeze: true } } });
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-common-nodes.png"))).toBe(true);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "performance-summary.json"), "utf8"))).toMatchObject({ status: "local-candidate", gates: { inputToRenderP95Under50Ms: true } });
  });

  it("records the 60-minute stability Gate as a reviewable candidate rather than a pass switch", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-common-nodes-stability-evidence.sh", "http://localhost:3013", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, MAKEFIGMA_PHASE2_STABILITY_DURATION_SECONDS: "0", MAKEFIGMA_PHASE2_STABILITY_CYCLE_SECONDS: "1" },
    });
    expect(result.status).toBe(0);
    const metadata = JSON.parse(readFileSync(join(evidenceDirectory, "evidence-metadata.json"), "utf8"));
    expect(metadata.golden.status).toBe("pending-independent-review");
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-common-nodes-start.png"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-common-nodes-end.png"))).toBe(true);
    const performance = JSON.parse(readFileSync(join(evidenceDirectory, "performance-summary.json"), "utf8"));
    expect(performance).toMatchObject({
      status: "local-candidate",
      gates: { inputToRenderP95Under50Ms: true },
    });
    expect(performance.runs).toHaveLength(3);
  });
});
