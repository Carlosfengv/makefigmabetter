import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

const ANNOUNCEMENT = "2 layers selected. Editable: Drop shadow. Mixed values: Fill. Not applicable: Stroke width, Stroke align, Per-side stroke, Corner radius, Stroke details, Line endpoints, Clip content, Section contents.";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "makefigma-phase2-a11y-"));
  directories.push(directory);
  const worker = join(directory, "fake-playwright.sh");
  // The fake Playwright CLI returns the live-region JSON the real browser probe
  // would produce for a Frame + Text selection, so the capture script's own
  // assertions and metadata writer run end to end without a live daemon.
  writeFileSync(worker, `#!/usr/bin/env bash
set -euo pipefail
case "$3" in
  open|resize|close|click|keydown|keyup) echo "ok" ;;
  snapshot) printf '%s\n' 'Rust/WASM bridge ready · fixed Phase 2 common-nodes fixture loaded · 2 layers selected' 'button "T Fixture label ◉" [ref=e101]' 'button "# Root Frame ◉" [ref=e106]' ;;
  screenshot) printf "phase2-a11y" > "$5" ;;
  console) echo "Total messages: 1 (Errors: 0, Warnings: 0)" ;;
  eval) printf '%s' '{"role":"status","ariaLive":"polite","announcement":"${ANNOUNCEMENT}","spokenText":"${ANNOUNCEMENT}"}' ;;
  *) echo "unexpected command: $3" >&2; exit 64 ;;
esac
`);
  chmodSync(worker, 0o755);
  return { worker, evidenceDirectory: join(directory, "evidence") };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 2 Inspector a11y evidence capture", () => {
  it("verifies and records the polite live-region tri-state announcement", () => {
    const { worker, evidenceDirectory } = setup();
    const result = spawnSync("bash", ["scripts/capture-phase2-inspector-a11y-evidence.sh", "http://localhost:3013", evidenceDirectory], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PWCLI: worker } });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const verdict = readFileSync(join(evidenceDirectory, "announcement-verdict.txt"), "utf8");
    expect(verdict).toContain("Inspector a11y announcement verified");

    const metadata = JSON.parse(readFileSync(join(evidenceDirectory, "evidence-metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      format: "makefigma-phase2-inspector-a11y-evidence-v1",
      selection: { kinds: ["frame", "text"] },
      liveRegion: { role: "status", ariaLive: "polite", announcement: ANNOUNCEMENT },
      signOff: { status: "pending-independent-review", requiresReviewerFreeze: true },
    });
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("phase2-inspector-a11y.png"))).toBe(true);
    expect(metadata.artifacts.some((artifact) => artifact.path.endsWith("selection-announcement.txt"))).toBe(true);
  }, 20_000);

  it("fails loudly if the live region drops the Mixed or NotApplicable clause", () => {
    const directory = mkdtempSync(join(tmpdir(), "makefigma-phase2-a11y-bad-"));
    directories.push(directory);
    const worker = join(directory, "fake-playwright.sh");
    writeFileSync(worker, `#!/usr/bin/env bash
set -euo pipefail
case "$3" in
  open|resize|close|click|keydown|keyup) echo "ok" ;;
  snapshot) printf '%s\n' 'Rust/WASM bridge ready · fixed Phase 2 common-nodes fixture loaded · 2 layers selected' 'button "T Fixture label ◉" [ref=e101]' 'button "# Root Frame ◉" [ref=e106]' ;;
  screenshot) printf "phase2-a11y" > "$5" ;;
  console) echo "Total messages: 1 (Errors: 0, Warnings: 0)" ;;
  eval) printf '%s' '{"role":"status","ariaLive":"polite","announcement":"2 layers selected.","spokenText":"2 layers selected."}' ;;
  *) echo "unexpected command: $3" >&2; exit 64 ;;
esac
`);
    chmodSync(worker, 0o755);
    const result = spawnSync("bash", ["scripts/capture-phase2-inspector-a11y-evidence.sh", "http://localhost:3013", join(directory, "evidence")], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PWCLI: worker } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("announcement missing editable Drop shadow clause");
  }, 20_000);
});
