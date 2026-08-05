import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function fakePlaywrightCli(directory) {
  const executable = join(directory, "pwcli.sh");
  writeFileSync(executable, `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" snapshot "*)
    state_file="\${TMPDIR:-/tmp}/makefigma-phase1-editing-state"
    count=0
    [[ -f "$state_file" ]] && count=$(cat "$state_file")
    count=$((count + 1))
    printf '%s' "$count" > "$state_file"
    case "$count" in
      1) echo 'Rust/WASM bridge ready · fixed Phase 1 render composite fixture loaded · 5/100000 nodes · button "Rectangle (R)" [ref=e30]' ;;
      2) echo '6/100000 nodes · button "□ Rectangle ◉"' ;;
      3) echo '5/100000 nodes' ;;
      *) echo '6/100000 nodes · button "□ Rectangle ◉"' ;;
    esac
    ;;
  *" console "*) echo 'Errors: 0' ;;
  *) exit 0 ;;
esac
`);
  chmodSync(executable, 0o755);
  return executable;
}

describe("Phase 1 editing evidence capture", () => {
  // This fixture starts a shell runner; under a fully parallel Vitest suite it
  // can wait behind other evidence processes despite normally finishing in
  // well under a second.
  it("records toolbar creation, pointer drawing, undo and redo", () => {
    const directory = mkdtempSync(join(tmpdir(), "makefigma-phase1-editing-"));
    const evidenceDirectory = join(directory, "evidence");
    const pwcli = fakePlaywrightCli(directory);
    const stateFile = join(tmpdir(), "makefigma-phase1-editing-state");
    rmSync(stateFile, { force: true });
    try {
      const result = spawnSync("bash", ["scripts/capture-phase1-editing-evidence.sh", "http://localhost:3000", evidenceDirectory], {
        cwd: ROOT,
        env: { ...process.env, PWCLI: pwcli, TMPDIR: tmpdir() },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(evidenceDirectory, "editing-summary.json"), "utf8"))).toEqual({
        status: "pass", fixture: "F-PHASE1-RENDER-COMPOSITE", interaction: ["toolbar-create", "pointer-draw", "undo", "redo"], expectedNodeCounts: [5, 6, 5, 6],
      });
    } finally {
      rmSync(stateFile, { force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
