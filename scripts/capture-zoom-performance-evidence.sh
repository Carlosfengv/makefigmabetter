#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://localhost:3000}"
evidence_dir="${2:-output/zoom-performance/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
renderer="${ZOOM_PERFORMANCE_RENDERER:-auto}"
warmup_seconds="${ZOOM_PERFORMANCE_WARMUP_SECONDS:-2}"
performance_runs="${ZOOM_PERFORMANCE_RUNS:-3}"
playwright_config="${PLAYWRIGHT_CLI_CONFIG:-}"
summary_writer="$(dirname "$0")/write-zoom-performance-summary.mjs"
mkdir -p "$evidence_dir"

if ! [[ "$warmup_seconds" =~ ^[0-9]+$ ]] || ! [[ "$performance_runs" =~ ^[1-9][0-9]*$ ]]; then
  echo "ZOOM_PERFORMANCE_WARMUP_SECONDS must be non-negative and ZOOM_PERFORMANCE_RUNS must be positive integers." >&2
  exit 64
fi

case "$base_url" in
  *"?"*) url="${base_url}&fixture=zoom-50k${renderer:+&renderer=$renderer}" ;;
  *) url="${base_url}?fixture=zoom-50k${renderer:+&renderer=$renderer}" ;;
esac

pw() {
  # playwright-cli accepts --config only while it creates the named session.
  # Subsequent session commands reject that option but retain its context.
  if [[ "$1" == "open" && -n "$playwright_config" ]]; then
    "$pwcli" --config "$playwright_config" --session "$session" "$@"
  else
    "$pwcli" --session "$session" "$@"
  fi
}

wait_for_fixture() {
  local snapshot_path="$1"
  for attempt in $(seq 1 150); do
    # Navigation can briefly make the CLI snapshot command unavailable. Treat
    # that as a readiness miss and keep polling instead of abandoning runs 2/3.
    if pw snapshot > "$snapshot_path" 2>&1 && rg -q "Rust/WASM bridge ready" "$snapshot_path"; then
      printf 'Fixture ready after %s snapshot attempt(s).\n' "$attempt"
      return 0
    fi
    sleep .2
  done
  echo "Timed out waiting for the 50K fixture and Rust/WASM bridge." >&2
  return 1
}

# Dispatching every event in one JavaScript task would be coalesced into one
# Worker batch. Yield one animation frame per input so this exercises continuous
# 100% → 25% → 200% zoom and panning rather than a single final render.
probe='(async () => { const canvas = document.querySelector("canvas"); if (!canvas) throw new Error("Canvas not found"); const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve())); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const wheel = (dx, dy, ctrl = false) => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 720, clientY: 480, deltaX: dx, deltaY: dy, ctrlKey: ctrl })); const surface = () => ({ css: [canvas.clientWidth, canvas.clientHeight], backing: [canvas.width, canvas.height] }); for (let i = 0; i < 14; i += 1) { wheel(0, 10, true); await frame(); } for (let i = 0; i < 21; i += 1) { wheel(0, -10, true); await frame(); } for (let i = 0; i < 30; i += 1) { wheel(8, 0); await frame(); wheel(-8, 0); await frame(); } wheel(0, 10, true); await frame(); await pause(40); const interactiveSurface = surface(); await pause(240); const settledSurface = surface(); return JSON.stringify({ worker: JSON.parse(document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-performance") ?? "{}"), frames: JSON.parse(document.querySelector("[aria-label=\"Frame interval evidence\"]")?.getAttribute("data-frame-intervals") ?? "{}"), longTasks: JSON.parse(document.querySelector("[aria-label=\"Main thread responsiveness\"]")?.getAttribute("data-main-thread-long-tasks") ?? "{}"), inputBacklog: JSON.parse(document.querySelector("[aria-label=\"Input backlog evidence\"]")?.getAttribute("data-input-backlog") ?? "{}"), dynamicDpr: { interactiveSurface, settledSurface } }); })()'
for run in $(seq 1 "$performance_runs"); do
  # Separate browser contexts eliminate state carry-over and avoid a concurrent
  # OffscreenCanvas transfer during a same-session navigation.
  session="makefigma-zoom-performance-run-$run"
  pw open "$url" | tee "$evidence_dir/open-run-$run.log"
  pw resize 1440 960 | tee "$evidence_dir/resize-run-$run.log"
  wait_for_fixture "$evidence_dir/snapshot-run-$run.txt" | tee "$evidence_dir/readiness-run-$run.log"
  if (( warmup_seconds > 0 )); then sleep "$warmup_seconds"; fi
  pw eval "$probe" | tee "$evidence_dir/run-$run.json"
done
pw eval 'JSON.stringify({ dpr: devicePixelRatio, webgpu: Boolean(navigator.gpu), webgpuActive: document.querySelector(".engine-status")?.textContent?.includes("WebGPU scene active") ?? false, viewport: { width: innerWidth, height: innerHeight }, userAgent: navigator.userAgent })' | tee "$evidence_dir/runtime.json"
node "$summary_writer" "$evidence_dir"
echo "Zoom-performance evidence written to $evidence_dir"
