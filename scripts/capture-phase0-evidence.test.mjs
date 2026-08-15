import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];
const root = process.cwd();

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "makefigma-capture-"));
  directories.push(directory);
  const worker = join(directory, "fake-playwright.sh");
  writeFileSync(worker, `#!/usr/bin/env bash
set -euo pipefail
case "$3" in
  open|resize) echo "ok" ;;
  snapshot) echo "Rust/WASM bridge ready · fixed Phase 0 fixture loaded" ;;
  screenshot) printf "deliberately-different-capture" > "$5" ;;
  console) echo "console clean" ;;
  eval) echo '{"runtime":"fixture"}' ;;
  *) echo "unexpected command: $3" >&2; exit 64 ;;
esac
`);
  chmodSync(worker, 0o755);
  return { directory, worker, evidenceDirectory: join(directory, "evidence") };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 0 evidence capture", () => {
  it("persists metadata when a reviewed Golden comparison fails", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase0-evidence.sh", "http://localhost:3000", evidenceDirectory], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PWCLI: worker, PHASE0_PERFORMANCE_RUNS: "0", PHASE0_PERFORMANCE_WARMUP_SECONDS: "0" },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "golden-verification.json"), "utf8"))).toMatchObject({
      status: "fail",
      reason: "GOLDEN_MISMATCH",
    });
    const metadata = JSON.parse(readFileSync(join(evidenceDirectory, "evidence-metadata.json"), "utf8"));
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("golden-verification.json"))).toBe(true);
  }, 20_000);
});
