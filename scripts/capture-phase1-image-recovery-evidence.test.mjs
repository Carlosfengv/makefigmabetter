import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "makefigma-image-recovery-"));
  directories.push(directory);
  const worker = join(directory, "fake-playwright.sh");
  writeFileSync(worker, `#!/usr/bin/env bash
set -euo pipefail
case "$3" in
  open|resize) echo "ok" ;;
  snapshot) echo "WebGPU scene recovered (1) · Rust/WASM bridge ready · fixed Phase 1 render composite fixture loaded" ;;
  screenshot) printf "recovered-image" > "$5" ;;
  console) echo "Total messages: 0 (Errors: 0, Warnings: 0)" ;;
  *) echo "unexpected command: $3" >&2; exit 64 ;;
esac
`);
  chmodSync(worker, 0o755);
  return { worker, evidenceDirectory: join(directory, "evidence") };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 1 image-backed GPU recovery evidence", () => {
  it("requires recovered WebGPU state after the composite image fixture has loaded", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase1-image-recovery-evidence.sh", "http://localhost:3000", evidenceDirectory], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PWCLI: worker },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "recovery-summary.json"), "utf8"))).toEqual({
      status: "pass", fixture: "F-PHASE1-RENDER-COMPOSITE", simulateGpuLoss: 1, expected: "webgpu-recovered-after-image-upload",
    });
  });
});
