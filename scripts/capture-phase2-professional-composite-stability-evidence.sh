#!/usr/bin/env bash
set -euo pipefail

# Candidate recorder only. A 60-minute run and a reviewer-frozen Golden are
# still required before this evidence can count toward the Phase 2 Beta Gate.
base_url="${1:-http://127.0.0.1:3080}"
evidence_dir="${2:-output/phase2-professional-composite/stability-$(date -u +%Y%m%dT%H%M%SZ)}"
duration_seconds="${MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_DURATION_SECONDS:-3600}"
cycle_seconds="${MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_CYCLE_SECONDS:-15}"
command_timeout_seconds="${MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_COMMAND_TIMEOUT_SECONDS:-90}"
readiness_command_timeout_seconds="${MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_READINESS_COMMAND_TIMEOUT_SECONDS:-15}"
# A 60-minute candidate must be continuously sampled, not merely have three
# records separated by a suspended host. One record per two minutes is a
# deliberately conservative floor because a full interaction cycle can take
# materially longer than the requested 15-second rest interval.
minimum_cycles="${MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_MINIMUM_CYCLES:-$(( duration_seconds == 0 ? 3 : (duration_seconds + 119) / 120 ))}"
maximum_cycle_gap_seconds="${MAKEFIGMA_PHASE2_PROFESSIONAL_STABILITY_MAXIMUM_CYCLE_GAP_SECONDS:-300}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
metadata_writer="$(dirname "$0")/write-phase2-professional-composite-evidence.mjs"
performance_writer="$(dirname "$0")/write-phase2-common-nodes-performance-summary.mjs"
memory_writer="$(dirname "$0")/write-phase2-browser-memory-summary.mjs"
source_writer="$(dirname "$0")/write-phase2-source-fingerprint.mjs"
stability_writer="$(dirname "$0")/write-phase2-professional-composite-stability-summary.mjs"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi
if ! [[ "$duration_seconds" =~ ^[0-9]+$ ]] || ! [[ "$cycle_seconds" =~ ^[1-9][0-9]*$ ]] || ! [[ "$command_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || ! [[ "$readiness_command_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || ! [[ "$minimum_cycles" =~ ^[3-9][0-9]*$|^[1-9][0-9]+$ ]] || ! [[ "$maximum_cycle_gap_seconds" =~ ^[1-9][0-9]*$ ]] || (( maximum_cycle_gap_seconds < cycle_seconds )); then
  echo "Phase 2 professional stability duration must be non-negative; cycle, timeout, maximum gap and minimum-cycle values must be positive (minimum cycles is at least 3)." >&2
  exit 64
fi
mkdir -p "$evidence_dir"
case "$base_url" in
  *"?"*) evidence_url="${base_url}&fixture=phase2-professional-composite" ;;
  *) evidence_url="${base_url}?fixture=phase2-professional-composite" ;;
esac
session="makefigma-phase2-professional-stability-${RANDOM}${RANDOM}"
cleanup() { "$pwcli" --session "$session" close >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$pwcli" --session "$session" open "$evidence_url" | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 | tee "$evidence_dir/resize.log"
readiness_probe='async () => { const phase2ProfessionalReadiness = true; const status = document.querySelector(".engine-status")?.textContent ?? ""; const resources = document.querySelector("[aria-label=\"Resource evidence\"]")?.textContent ?? ""; return phase2ProfessionalReadiness && Boolean(document.querySelector("canvas.design-canvas")) && status.includes("Engine worker online") && status.includes("Rust/WASM bridge ready") && status.includes("fixed Phase 2 professional composite fixture loaded") && resources.includes("3 assets"); }'
ready=0
for attempt in $(seq 1 50); do
  # Accessibility snapshots can block indefinitely on a Worker canvas. The
  # status and resource evidence are the actual fixture readiness contract, so
  # probe them directly and bound the CLI invocation before a 60-minute run.
  if timeout "$readiness_command_timeout_seconds" "$pwcli" --session "$session" eval "$readiness_probe" > "$evidence_dir/readiness.txt" 2>&1; then
    :
  else
    exit_code=$?
    if [[ "$exit_code" -eq 124 ]]; then
      printf 'Phase 2 professional composite stability readiness probe timed out after %ss.\n' "$readiness_command_timeout_seconds" | tee "$evidence_dir/readiness.log" >&2
      exit 124
    fi
  fi
  if grep -Fxq "true" "$evidence_dir/readiness.txt"; then
    printf 'Phase 2 professional composite stability fixture ready after %s readiness probe attempt(s).\n' "$attempt" | tee "$evidence_dir/readiness.log"
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for the Phase 2 professional composite fixture." | tee "$evidence_dir/readiness.log" >&2
  exit 1
fi
"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase2-professional-composite-start.png" | tee "$evidence_dir/screenshot-start.log"
"$pwcli" --session "$session" eval 'async () => JSON.stringify({ userAgent: navigator.userAgent, viewport: { width: window.innerWidth, height: window.innerHeight }, dpr: window.devicePixelRatio, webgpu: Boolean(navigator.gpu), hardwareConcurrency: navigator.hardwareConcurrency ?? null })' > "$evidence_dir/browser-environment.txt" 2>&1

# `playwright-cli eval` receives a function expression, not an immediately
# invoked expression; the latter is treated as an invalid option by current
# versions of the CLI.
stability_probe='async page => { const pause = (ms = 120) => page.waitForTimeout(ms); const layer = async (name) => { await page.getByRole("button", { name }).click(); await pause(); }; const canvas = page.locator("canvas.design-canvas"); const box = await canvas.boundingBox(); if (!box) throw new Error("Design canvas missing"); const resetButton = page.getByRole("button", { name: "Reset demo", exact: true }); const resetGeneration = Number(await page.locator(".engine-status").getAttribute("data-fixture-reset-generation") ?? "0"); try { await canvas.evaluate((element) => { element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 500, clientY: 400, deltaY: -30, ctrlKey: true })); element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 500, clientY: 400, deltaX: 12, deltaY: 8 })); }); await page.getByRole("button", { name: "Pan (H)", exact: true }).click(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 16, box.y + box.height / 2 + 10, { steps: 3 }); await page.mouse.up(); await page.getByRole("button", { name: "Move (V)", exact: true }).click(); await layer(/^□ Blur and blend card/); const effect = page.getByRole("checkbox", { name: "Layer blur enabled", exact: true }); await effect.click(); await pause(); await effect.click(); await pause(); const width = page.getByRole("textbox", { name: "W", exact: true }); const beforeWidth = await width.inputValue(); await width.fill(String(Number(beforeWidth) + 1)); await width.press("Tab"); await pause(); await width.fill(beforeWidth); await width.press("Tab"); await pause(); await canvas.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))); await pause(); await canvas.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }))); await pause(); await layer(/^# Auto layout level 1/); const gap = page.getByRole("textbox", { name: "Auto layout Gap", exact: true }); const beforeGap = await gap.inputValue(); await gap.fill(String(Number(beforeGap) + 1)); await gap.press("Tab"); await pause(); await gap.fill(beforeGap); await gap.press("Tab"); await pause(); await layer(/^☆ Star/); const rotation = page.getByRole("textbox", { name: "Rotation", exact: true }); const beforeRotation = await rotation.inputValue(); await rotation.fill(String(Number(beforeRotation) + 10)); await rotation.press("Tab"); await pause(); await rotation.fill(beforeRotation); await rotation.press("Tab"); await pause(); await layer(/^T Mixed-language title/); const text = page.getByRole("textbox", { name: "Text content", exact: true }); const beforeText = await text.inputValue(); await text.fill(beforeText + " stability"); await pause(); await text.fill(beforeText); await pause(); const undo = page.getByRole("button", { name: /Undo/ }); if (await undo.isEnabled()) { await undo.click(); await pause(); const redo = page.getByRole("button", { name: /Redo/ }); if (await redo.isEnabled()) { await redo.click(); await pause(); } } return { performed: ["pan", "zoom", "select", "move", "resize", "rotate", "text", "layout", "effect", "undo", "redo"] }; } finally { await resetButton.click(); await page.waitForFunction((generation) => Number(document.querySelector(".engine-status")?.getAttribute("data-fixture-reset-generation") ?? "0") > generation, resetGeneration, { timeout: 5_000 }); await page.waitForFunction(() => document.querySelector(".engine-status")?.getAttribute("data-fixture-reset-pending") === "false", undefined, { timeout: 30_000 }); await pause(350); } }'
performance_probe='async () => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas missing"); const frame = () => new Promise((resolve) => requestAnimationFrame(resolve)); for (let index = 0; index < 64; index += 1) { canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 720, clientY: 480, deltaX: index % 2 ? 3 : -3, deltaY: 0 })); await frame(); } await new Promise((resolve) => setTimeout(resolve, 300)); return JSON.stringify({ render: JSON.parse(document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-performance") ?? "{}"), input: JSON.parse(document.querySelector("[aria-label=\"Input backlog evidence\"]")?.getAttribute("data-input-backlog") ?? "{}") }); }'
memory_probe='async () => JSON.stringify({ capturedAt: new Date().toISOString(), memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null })'
# The Layer panel deliberately owns bare arrow keys for roving focus. Verify
# real keyboard movement from an editor-control focus target separately, so a
# synthetic KeyboardEvent cannot stand in for the user-facing move path.
real_move_probe='async page => { const pause = (ms) => page.waitForTimeout(ms); const hash = page.locator("[aria-label=\"Canonical document hash\"]"); const status = page.locator(".engine-status"); await page.getByRole("button", { name: /^□ Blur and blend card/ }).click(); await pause(250); const before = await hash.getAttribute("data-document-hash"); if (!before) throw new Error("Missing canonical hash before move"); await page.getByRole("button", { name: "Move (V)", exact: true }).click(); await page.keyboard.press("ArrowRight"); await pause(600); const afterRight = await hash.getAttribute("data-document-hash"); if (!afterRight || afterRight === before) throw new Error("ArrowRight did not change the canonical document hash"); await page.keyboard.press("ArrowLeft"); await pause(300); const resetGeneration = Number(await status.getAttribute("data-fixture-reset-generation") ?? "0"); await page.getByRole("button", { name: "Reset demo", exact: true }).click(); await page.waitForFunction((generation) => Number(document.querySelector(".engine-status")?.getAttribute("data-fixture-reset-generation") ?? "0") > generation, resetGeneration, { timeout: 5_000 }); await page.waitForFunction(() => document.querySelector(".engine-status")?.getAttribute("data-fixture-reset-pending") === "false", undefined, { timeout: 30_000 }); await pause(350); return { moved: true, beforeHash: before.slice(0, 12), afterRightHash: afterRight.slice(0, 12) }; }'
capture_cycle_command() {
  local stage="$1"
  local output="$2"
  shift 2
  if timeout "$command_timeout_seconds" "$@" > "$output" 2>&1; then
    return 0
  else
    local exit_code=$?
    printf 'stage=%s\nexitCode=%s\ntimestamp=%s\ncommandTimeoutSeconds=%s\noutput=%s\n' "$stage" "$exit_code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$command_timeout_seconds" "$(basename "$output")" | tee "$evidence_dir/stability-failure.log" >&2
    return "$exit_code"
  fi
}
has_complete_performance_archive() {
  local output="$1"
  # A transport-level success from Playwright is insufficient: a dropped or
  # blank eval response would otherwise be discovered only after a full
  # 60-minute run when the summary is assembled. Validate the archived result
  # in the same cycle, before accepting it as continuous evidence.
  node --input-type=module - "$performance_writer" "$output" <<'NODE'
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const [writer, archive] = process.argv.slice(2);
const { parsePhase2CommonNodesPerformanceRun } = await import(pathToFileURL(writer).href);
const metrics = parsePhase2CommonNodesPerformanceRun(readFileSync(archive, "utf8"));
if (!metrics) process.exit(1);
NODE
}
verify_performance_archive() {
  local output="$1"
  if has_complete_performance_archive "$output"; then
    return 0
  else
    local exit_code=$?
    printf 'stage=performance-evidence\nexitCode=%s\ntimestamp=%s\noutput=%s\n' "$exit_code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$output")" | tee "$evidence_dir/stability-failure.log" >&2
    return "$exit_code"
  fi
}
has_complete_memory_archive() {
  local output="$1"
  # Heap sampling is evidence, not an optional best-effort diagnostic. Reject
  # an empty or unsupported sample in the cycle that produced it, rather than
  # allowing a later summary to invalidate a long otherwise-complete run.
  node --input-type=module - "$memory_writer" "$output" <<'NODE'
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const [writer, archive] = process.argv.slice(2);
const { parsePhase2BrowserMemoryRun } = await import(pathToFileURL(writer).href);
if (!parsePhase2BrowserMemoryRun(readFileSync(archive, "utf8"))) process.exit(1);
NODE
}
verify_memory_archive() {
  local output="$1"
  if has_complete_memory_archive "$output"; then
    return 0
  else
    local exit_code=$?
    printf 'stage=memory-evidence\nexitCode=%s\ntimestamp=%s\noutput=%s\n' "$exit_code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$output")" | tee "$evidence_dir/stability-failure.log" >&2
    return "$exit_code"
  fi
}
retry_invalid_archive_once() {
  local stage="$1"
  local validator="$2"
  local output="$3"
  shift 3
  if "$validator" "$output"; then return 0; fi
  # Keep the rejected response for review and retry the probe once in the same
  # interaction cycle. A second incomplete response remains a hard failure.
  mv "$output" "${output%.txt}.initial-invalid.txt"
  printf 'stage=%s\ninitialArchive=%s\nretryArchive=%s\ntimestamp=%s\n' "$stage" "$(basename "${output%.txt}.initial-invalid.txt")" "$(basename "$output")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${output%.txt}.retry.log"
  capture_cycle_command "${stage}-retry" "$output" "$@"
}
started_at="$(date +%s)"
run=0
previous_cycle_started_at=0
while :; do
  cycle_started_at="$(date +%s)"
  elapsed=$(( cycle_started_at - started_at ))
  if (( elapsed >= duration_seconds )) && (( run >= minimum_cycles )); then break; fi
  if (( previous_cycle_started_at > 0 )); then
    cycle_gap_seconds=$(( cycle_started_at - previous_cycle_started_at ))
    if (( cycle_gap_seconds > maximum_cycle_gap_seconds )); then
      printf 'stage=cycle-gap\nexitCode=1\ntimestamp=%s\ncycleGapSeconds=%s\nmaximumCycleGapSeconds=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$cycle_gap_seconds" "$maximum_cycle_gap_seconds" | tee "$evidence_dir/stability-failure.log" >&2
      exit 1
    fi
  fi
  run=$((run + 1))
  capture_cycle_command action "$evidence_dir/action-run-$(printf '%04d' "$run").txt" "$pwcli" --session "$session" run-code "$stability_probe"
  capture_cycle_command move "$evidence_dir/move-verification-run-$(printf '%04d' "$run").txt" "$pwcli" --session "$session" run-code "$real_move_probe"
  performance_output="$evidence_dir/performance-run-$(printf '%04d' "$run").txt"
  capture_cycle_command performance "$performance_output" "$pwcli" --session "$session" eval "$performance_probe"
  retry_invalid_archive_once performance has_complete_performance_archive "$performance_output" "$pwcli" --session "$session" eval "$performance_probe"
  verify_performance_archive "$performance_output"
  memory_output="$evidence_dir/memory-run-$(printf '%04d' "$run").txt"
  capture_cycle_command memory "$memory_output" "$pwcli" --session "$session" eval "$memory_probe"
  retry_invalid_archive_once memory has_complete_memory_archive "$memory_output" "$pwcli" --session "$session" eval "$memory_probe"
  verify_memory_archive "$memory_output"
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$elapsed" "$cycle_started_at" >> "$evidence_dir/cycles.tsv"
  previous_cycle_started_at="$cycle_started_at"
  elapsed=$(( $(date +%s) - started_at ))
  remaining=$(( duration_seconds - elapsed ))
  if (( remaining > 0 )); then sleep "$(( remaining < cycle_seconds ? remaining : cycle_seconds ))"; fi
done

"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase2-professional-composite-end.png" | tee "$evidence_dir/screenshot-end.log"
"$pwcli" --session "$session" console > "$evidence_dir/console.txt" 2>&1
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Phase 2 professional composite stability capture emitted browser console errors." >&2
  exit 1
fi
node "$performance_writer" "$evidence_dir" 0 "makefigma-phase2-professional-composite-performance-v1"
node "$memory_writer" "$evidence_dir"
(
  cd "$repo_root"
  node "$source_writer" "$evidence_dir" \
  "src/components/editor/editor-shell.tsx" \
  "src/workers/editor.worker.ts" \
  "crates/editor-core/src/lib.rs" \
  "crates/editor-core/src/geometry.rs" \
  "crates/editor-wasm/src/lib.rs" \
  "src/lib/phase2-professional-composite-fixture.ts" \
  "src/lib/phase2-gpu-layer-blur-fixture.ts" \
  "src/lib/rust-text-layout.ts" \
  "src/lib/text-layout.ts" \
  "src/lib/text-style-runs.ts" \
  "src/lib/transaction-batch.ts" \
  "src/lib/scene-transform.ts" \
  "src/lib/gpu-layer-prefix.ts" \
  "src/lib/webgpu-scene.ts" \
  "src/lib/vector-path.ts" \
  "src/lib/hit-test.ts" \
  "src/lib/selection-nudge.ts" \
  "src/lib/editor-key-command.ts" \
  "src/lib/svg-export.ts" \
  "src/lib/render-quality.ts" \
  "scripts/capture-phase2-professional-composite-stability-evidence.sh" \
  "scripts/write-phase2-professional-composite-evidence.mjs" \
  "scripts/write-phase2-common-nodes-performance-summary.mjs" \
  "scripts/write-phase2-browser-memory-summary.mjs" \
  "scripts/write-phase2-professional-composite-stability-summary.mjs" \
  "verification/phase2/q1-professional-composite-golden-manifest.json"
)
finished_at="$(date +%s)"
node "$stability_writer" "$evidence_dir" "$started_at" "$finished_at" "$duration_seconds" "$run" "$minimum_cycles"
node "$metadata_writer" "$evidence_dir" "$evidence_url"
printf 'Phase 2 professional composite stability candidate captured for %ss across %s cycle(s).\n' "$duration_seconds" "$run" | tee "$evidence_dir/stability-summary.log"
