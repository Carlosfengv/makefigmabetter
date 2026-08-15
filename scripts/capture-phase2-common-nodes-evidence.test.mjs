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
  snapshot) snapshot="Rust/WASM bridge ready · fixed Phase 2 common-nodes fixture loaded"; if [[ "\${FAKE_PHASE2_FIXTURE:-common}" == "professional" ]]; then snapshot="Engine worker online · Rust/WASM bridge ready · 3 assets · fixed Phase 2 professional composite fixture loaded"; fi; if [[ "\${4:-}" == "--filename" ]]; then printf '%s\\n' "$snapshot" > "$5"; else echo "$snapshot"; fi ;;
  screenshot) printf "phase2-capture" > "$5" ;;
  console) echo "Total messages: 1 (Errors: 0, Warnings: 0)" ;;
  eval) if [[ "$*" == *"userAgent"* ]]; then echo '{"userAgent":"fixture-chromium","viewport":{"width":1440,"height":960},"dpr":1,"webgpu":true}'; elif [[ "$*" == *"usedJSHeapSize"* ]]; then echo '{"capturedAt":"2026-08-10T00:00:00.000Z","memory":{"usedJSHeapSize":100,"totalJSHeapSize":200,"jsHeapSizeLimit":4000}}'; else echo '{"render":{"samples":64,"p50Ms":0.6,"p95Ms":0.9,"maxMs":1.5,"inputToRenderSamples":64,"inputToRenderP95Ms":19},"input":{"samples":63,"p50Ms":16,"p95Ms":18,"maxMs":19}}'; fi ;;
  run-code) if [[ "\${FAKE_PHASE2_HANG_RUN_CODE:-0}" == "1" ]]; then sleep 2; fi; echo '{"performed":["pan","zoom","select","move","resize","rotate","text","layout","effect","undo","redo"],"render":{"samples":64,"p50Ms":0.6,"p95Ms":0.9,"maxMs":1.5,"inputToRenderSamples":64,"inputToRenderP95Ms":19},"input":{"samples":63,"p50Ms":16,"p95Ms":18,"maxMs":19}}' ;;
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
  }, 20_000);

  it("records the professional composite separately from the common-nodes Golden candidate", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", PHASE2_PROFESSIONAL_COMPOSITE_WARMUP_SECONDS: "0" },
    });
    expect(result.status).toBe(0);
    const metadata = JSON.parse(readFileSync(join(evidenceDirectory, "evidence-metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      format: "makefigma-phase2-professional-composite-evidence-v1",
      golden: { status: "pending-independent-review" },
    });
    expect(metadata.fixtures).toHaveLength(2);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-professional-composite.png"))).toBe(true);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "performance-summary.json"), "utf8"))).toMatchObject({
      format: "makefigma-phase2-professional-composite-performance-v1",
      status: "local-candidate",
    });
  }, 20_000);

  it("keeps the professional stability recorder as a reviewable candidate", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-stability-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_DURATION_SECONDS: "0", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_CYCLE_SECONDS: "1" },
    });
    expect(result.status).toBe(0);
    const metadata = JSON.parse(readFileSync(join(evidenceDirectory, "evidence-metadata.json"), "utf8"));
    expect(metadata.golden.status).toBe("pending-independent-review");
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-professional-composite-start.png"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-professional-composite-end.png"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("action-run-0001.txt"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("move-verification-run-0001.txt"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("memory-run-0001.txt"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("source-fingerprint.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "action-run-0001.txt"), "utf8"))).toMatchObject({
      performed: ["pan", "zoom", "select", "move", "resize", "rotate", "text", "layout", "effect", "undo", "redo"],
    });
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "performance-summary.json"), "utf8"))).toMatchObject({
      format: "makefigma-phase2-professional-composite-performance-v1",
      status: "local-candidate",
    });
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "memory-summary.json"), "utf8"))).toMatchObject({
      format: "makefigma-phase2-browser-memory-v1",
      status: "local-candidate",
      usedJSHeapSize: { first: 100 },
    });
  }, 20_000);

  it("archives and fails a hung professional stability action instead of waiting indefinitely", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-stability-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", FAKE_PHASE2_HANG_RUN_CODE: "1", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_DURATION_SECONDS: "0", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_CYCLE_SECONDS: "1", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_COMMAND_TIMEOUT_SECONDS: "1" },
    });
    expect(result.status).toBe(124);
    expect(readFileSync(join(evidenceDirectory, "stability-failure.log"), "utf8")).toContain("stage=action\nexitCode=124\n");
    expect(readFileSync(join(evidenceDirectory, "action-run-0001.txt"), "utf8")).toBe("");
  }, 20_000);

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
  }, 20_000);
});
