import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "makefigma-operation-hash-"));
  directories.push(directory);
  const worker = join(directory, "fake-playwright.sh");
  writeFileSync(worker, `#!/usr/bin/env bash
set -euo pipefail
case "$3" in
  open|resize|click) echo "ok" ;;
  snapshot) echo 'Rust/WASM bridge ready · remote document loaded · remote changes saved · button "Rectangle (R)" [ref=e7]' ;;
  eval) echo '{"matches":true,"browserRevision":"1","serverRevision":"1"}' >&2 ;;
  screenshot) printf "operation-hash" > "$5" ;;
  console) echo "Total messages: 0 (Errors: 0, Warnings: 0)" ;;
  close) echo "ok" ;;
  *) echo "unexpected command: $3" >&2; exit 64 ;;
esac
`);
  chmodSync(worker, 0o755);
  return { worker, evidenceDirectory: join(directory, "evidence") };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 1 browser/service operation hash evidence", () => {
  // The fixture launches a shell process and can contend with the remaining
  // evidence-script tests when Vitest runs the suite in parallel. Keep the
  // assertion strict while giving that process a bounded CI-safe window.
  it("requires a durable acknowledgement, matching header metadata, and a clean console", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase1-operation-hash-evidence.sh", "http://localhost:3000", evidenceDirectory], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PWCLI: worker },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(join(evidenceDirectory, "operation-hash-summary.json"), "utf8"))).toEqual({
      status: "pass", scenario: "accepted-operation-hash", required: "browser-core-and-service-snapshot-match",
    });
  }, 15_000);
});
