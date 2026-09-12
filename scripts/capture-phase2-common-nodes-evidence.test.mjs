import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { summarizePhase2ProfessionalCompositeStability } from "./write-phase2-professional-composite-stability-summary.mjs";

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
  eval) if [[ "$*" == *"phase2ProfessionalReadiness"* ]]; then if [[ "\${FAKE_PHASE2_HANG_READINESS:-0}" == "1" ]]; then sleep 2; fi; echo true; elif [[ "$*" == *"userAgent"* ]]; then echo '{"userAgent":"fixture-chromium","viewport":{"width":1440,"height":960},"dpr":1,"webgpu":true}'; elif [[ "$*" == *"usedJSHeapSize"* ]]; then if [[ "\${FAKE_PHASE2_EMPTY_MEMORY:-0}" == "1" ]]; then :; elif [[ "\${FAKE_PHASE2_EMPTY_MEMORY_ONCE:-0}" == "1" && ! -f "\${FAKE_PHASE2_EMPTY_MEMORY_ONCE_MARKER:?}" ]]; then : > "\${FAKE_PHASE2_EMPTY_MEMORY_ONCE_MARKER}"; else echo '{"capturedAt":"2026-08-10T00:00:00.000Z","memory":{"usedJSHeapSize":100,"totalJSHeapSize":200,"jsHeapSizeLimit":4000}}'; fi; else if [[ "\${FAKE_PHASE2_HANG_PERFORMANCE:-0}" == "1" ]]; then sleep 2; fi; if [[ "\${FAKE_PHASE2_EMPTY_PERFORMANCE:-0}" != "1" ]]; then echo '{"render":{"samples":64,"p50Ms":0.6,"p95Ms":0.9,"maxMs":1.5,"inputToRenderSamples":64,"inputToRenderP95Ms":19},"input":{"samples":63,"p50Ms":16,"p95Ms":18,"maxMs":19}}'; fi; fi ;;
  run-code) if [[ "\${FAKE_PHASE2_HANG_RUN_CODE:-0}" == "1" ]]; then sleep 2; fi; if [[ "$*" == *"ArrowRight did not change the canonical document hash"* ]]; then echo '{"moved":true,"beforeHash":"fixture-before","afterRightHash":"fixture-after"}'; else echo '{"performed":["pan","zoom","select","move","resize","rotate","text","layout","effect","undo","redo"],"render":{"samples":64,"p50Ms":0.6,"p95Ms":0.9,"maxMs":1.5,"inputToRenderSamples":64,"inputToRenderP95Ms":19},"input":{"samples":63,"p50Ms":16,"p95Ms":18,"maxMs":19}}'; fi ;;
  *) echo "unexpected command: $3" >&2; exit 64 ;;
esac
`);
  chmodSync(worker, 0o755);
  return { worker, evidenceDirectory: join(directory, "evidence") };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 2 common-nodes evidence capture", () => {
  it("does not treat a few widely spaced records as a 60-minute professional stability candidate", () => {
    const actionResult = { performed: ["pan", "zoom", "select", "move", "resize", "rotate", "text", "layout", "effect", "undo", "redo"] };
    expect(() => summarizePhase2ProfessionalCompositeStability({
      requestedDurationSeconds: 3_600,
      elapsedSeconds: 3_600,
      minimumCycleCount: 30,
      cycles: ["a", "b", "c"],
      actionRuns: [{ result: actionResult }, { result: actionResult }, { result: actionResult }],
      moveRuns: [{ result: { moved: true } }, { result: { moved: true } }, { result: { moved: true } }],
      performanceRuns: ["a", "b", "c"],
      memoryRuns: ["a", "b", "c"],
      consoleText: "Errors: 0",
      hasStartScreenshot: true,
      hasEndScreenshot: true,
      hasBrowserEnvironment: true,
      hasSourceFingerprint: true,
    })).toThrow("at least 30 runs");
  });

  it("records a fixed browser proof surface pending independent Golden review", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-common-nodes-evidence.sh", "http://localhost:3013", evidenceDirectory], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PWCLI: worker, PHASE2_COMMON_NODES_WARMUP_SECONDS: "0" } });
    expect(result.status, result.stderr).toBe(0);
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
    expect(result.status, result.stderr).toBe(0);
    const metadata = JSON.parse(readFileSync(join(evidenceDirectory, "evidence-metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      format: "makefigma-phase2-professional-composite-evidence-v1",
      golden: { status: "pending-independent-review" },
      goldenVerification: { status: "pending", reason: "PENDING_REVIEWED_BASELINE" },
    });
    expect(metadata.fixtures).toHaveLength(2);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-professional-composite.png"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("golden-verification.json"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("golden-diff.png"))).toBe(false);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "golden-verification.json"), "utf8"))).toMatchObject({
      status: "pending",
      reason: "PENDING_REVIEWED_BASELINE",
    });
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "performance-summary.json"), "utf8"))).toMatchObject({
      format: "makefigma-phase2-professional-composite-performance-v1",
      status: "local-candidate",
    });
  }, 20_000);

  it("fails the professional candidate capture when its readiness probe hangs", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", FAKE_PHASE2_HANG_READINESS: "1", PHASE2_PROFESSIONAL_COMPOSITE_READINESS_COMMAND_TIMEOUT_SECONDS: "1" },
    });
    expect(result.status).toBe(124);
    expect(readFileSync(join(evidenceDirectory, "readiness.log"), "utf8")).toContain("readiness probe timed out after 1s");
  }, 20_000);

  it("fails the professional candidate capture when its performance probe hangs", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", FAKE_PHASE2_HANG_PERFORMANCE: "1", PHASE2_PROFESSIONAL_COMPOSITE_WARMUP_SECONDS: "0", PHASE2_PROFESSIONAL_COMPOSITE_COMMAND_TIMEOUT_SECONDS: "1" },
    });
    expect(result.status).toBe(124);
    expect(result.stderr).toContain("performance probe timed out after 1s (run 1)");
    expect(readFileSync(join(evidenceDirectory, "performance-run-01.txt"), "utf8")).toBe("");
  }, 20_000);

  it("keeps the professional stability recorder as a reviewable candidate", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-stability-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_DURATION_SECONDS: "0", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_CYCLE_SECONDS: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    const metadata = JSON.parse(readFileSync(join(evidenceDirectory, "evidence-metadata.json"), "utf8"));
    expect(metadata.golden.status).toBe("pending-independent-review");
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-professional-composite-start.png"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-professional-composite-end.png"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("action-run-0001.txt"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("move-verification-run-0001.txt"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("memory-run-0001.txt"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("source-fingerprint.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "stability-summary.json"), "utf8"))).toMatchObject({
      format: "makefigma-phase2-professional-composite-stability-v1",
      status: "local-candidate",
      gates: { matchingRunArchives: true, completeActionSequence: true, keyboardMoveMutatedCanonicalDocument: true, consoleErrorsZero: true },
    });
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

  it("fails the professional stability recorder when its readiness probe hangs", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-stability-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", FAKE_PHASE2_HANG_READINESS: "1", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_DURATION_SECONDS: "0", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_CYCLE_SECONDS: "1", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_READINESS_COMMAND_TIMEOUT_SECONDS: "1" },
    });
    expect(result.status).toBe(124);
    expect(readFileSync(join(evidenceDirectory, "readiness.log"), "utf8")).toContain("stability readiness probe timed out after 1s");
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

  it("fails the professional stability recorder immediately when a successful probe has no performance archive", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-stability-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", FAKE_PHASE2_EMPTY_PERFORMANCE: "1", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_DURATION_SECONDS: "0", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_CYCLE_SECONDS: "1" },
    });
    expect(result.status).toBe(1);
    expect(readFileSync(join(evidenceDirectory, "performance-run-0001.txt"), "utf8")).toBe("");
    expect(readFileSync(join(evidenceDirectory, "stability-failure.log"), "utf8")).toContain("stage=performance-evidence\nexitCode=1\n");
  }, 20_000);

  it("fails the professional stability recorder immediately when a successful probe has no memory archive", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-stability-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", FAKE_PHASE2_EMPTY_MEMORY: "1", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_DURATION_SECONDS: "0", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_CYCLE_SECONDS: "1" },
    });
    expect(result.status).toBe(1);
    expect(readFileSync(join(evidenceDirectory, "memory-run-0001.txt"), "utf8")).toBe("");
    expect(readFileSync(join(evidenceDirectory, "stability-failure.log"), "utf8")).toContain("stage=memory-evidence\nexitCode=1\n");
  }, 20_000);

  it("keeps the initial empty memory archive and accepts one complete retry in the same cycle", () => {
    const { worker, evidenceDirectory } = setup();
    const retryMarker = join(evidenceDirectory, "empty-memory-once.marker");
    const result = spawnSync("bash", ["scripts/capture-phase2-professional-composite-stability-evidence.sh", "http://localhost:3080", evidenceDirectory], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, FAKE_PHASE2_FIXTURE: "professional", FAKE_PHASE2_EMPTY_MEMORY_ONCE: "1", FAKE_PHASE2_EMPTY_MEMORY_ONCE_MARKER: retryMarker, MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_DURATION_SECONDS: "0", MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_CYCLE_SECONDS: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(evidenceDirectory, "memory-run-0001.initial-invalid.txt"), "utf8")).toBe("");
    expect(readFileSync(join(evidenceDirectory, "memory-run-0001.retry.log"), "utf8")).toContain("stage=memory");
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "memory-summary.json"), "utf8"))).toMatchObject({ status: "local-candidate", samples: expect.arrayContaining([expect.objectContaining({ file: "memory-run-0001.txt" })]) });
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
