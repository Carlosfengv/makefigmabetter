#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://localhost:3000}"
evidence_dir="${2:-output/zoom-performance/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
renderer="${ZOOM_PERFORMANCE_RENDERER:-auto}"
warmup_seconds="${ZOOM_PERFORMANCE_WARMUP_SECONDS:-30}"
performance_runs="${ZOOM_PERFORMANCE_RUNS:-3}"
playwright_config="${PLAYWRIGHT_CLI_CONFIG:-}"
summary_writer="$(dirname "$0")/write-zoom-performance-summary.mjs"
mkdir -p "$evidence_dir"

if ! [[ "$warmup_seconds" =~ ^[0-9]+$ ]] || ! [[ "$performance_runs" =~ ^([3-9]|[1-9][0-9]+)$ ]]; then
  echo "ZOOM_PERFORMANCE_WARMUP_SECONDS must be non-negative and ZOOM_PERFORMANCE_RUNS must be an integer of at least 3." >&2
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
    "$pwcli" -s="$session" "$@" --config "$playwright_config"
  else
    "$pwcli" -s="$session" "$@"
  fi
}

sessions=()
cleanup_sessions() {
  local session_name
  for session_name in "${sessions[@]}"; do
    "$pwcli" -s="$session_name" close >/dev/null 2>&1 || true
  done
}
trap cleanup_sessions EXIT

wait_for_fixture() {
  local snapshot_path="$1"
  for attempt in $(seq 1 150); do
    # A 50K layer tree makes a full accessibility snapshot expensive enough to
    # perturb or stall the benchmark. Read only the status text and keep the
    # captured readiness response as evidence.
    if pw --raw eval '() => document.body.textContent?.includes("Rust/WASM bridge ready") ?? false' > "$snapshot_path" 2>&1 \
      && grep -Eq '^true$' "$snapshot_path"; then
      printf 'Fixture ready after %s status attempt(s).\n' "$attempt"
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
probe='(async () => { const canvas = document.querySelector("canvas"); if (!canvas) throw new Error("Canvas not found"); const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve())); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const wheel = (dx, dy, ctrl = false) => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 720, clientY: 480, deltaX: dx, deltaY: dy, ctrlKey: ctrl })); const surface = () => ({ css: [canvas.clientWidth, canvas.clientHeight], backing: [canvas.width, canvas.height] }); const nativeSurface = () => { const value = surface(); return value.backing.every((size, index) => size === Math.ceil(value.css[index] * devicePixelRatio)); }; const waitFor = async (predicate, timeoutMs) => { const deadline = performance.now() + timeoutMs; while (!predicate()) { if (performance.now() >= deadline) return false; await pause(20); } return true; }; for (let i = 0; i < 14; i += 1) { wheel(0, 10, true); await frame(); } for (let i = 0; i < 21; i += 1) { wheel(0, -10, true); await frame(); } for (let i = 0; i < 30; i += 1) { wheel(8, 0); await frame(); wheel(-8, 0); await frame(); } wheel(0, 10, true); await frame(); await pause(40); const interactiveSurface = surface(); await waitFor(nativeSurface, 3000); const settledSurface = surface(); return JSON.stringify({ worker: JSON.parse(document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-performance") ?? "{}"), frames: JSON.parse(document.querySelector("[aria-label=\"Frame interval evidence\"]")?.getAttribute("data-frame-intervals") ?? "{}"), longTasks: JSON.parse(document.querySelector("[aria-label=\"Main thread responsiveness\"]")?.getAttribute("data-main-thread-long-tasks") ?? "{}"), inputBacklog: JSON.parse(document.querySelector("[aria-label=\"Input backlog evidence\"]")?.getAttribute("data-input-backlog") ?? "{}"), dynamicDpr: { interactiveSurface, settledSurface } }); })()'
for run in $(seq 1 "$performance_runs"); do
  # Separate browser contexts eliminate state carry-over and avoid a concurrent
  # OffscreenCanvas transfer during a same-session navigation.
  session="makefigma-zoom-performance-run-$run"
  sessions+=("$session")
  pw open "$url" | tee "$evidence_dir/open-run-$run.log"
  pw resize 1440 960 | tee "$evidence_dir/resize-run-$run.log"
  wait_for_fixture "$evidence_dir/snapshot-run-$run.txt" | tee "$evidence_dir/readiness-run-$run.log"
  if (( warmup_seconds > 0 )); then sleep "$warmup_seconds"; fi
  pw eval "$probe" | tee "$evidence_dir/run-$run.json"
done
pw eval 'JSON.stringify({ dpr: devicePixelRatio, webgpu: Boolean(navigator.gpu), webgpuActive: document.querySelector(".engine-status")?.textContent?.includes("WebGPU scene active") ?? false, viewport: { width: innerWidth, height: innerHeight }, userAgent: navigator.userAgent })' | tee "$evidence_dir/runtime.json"
node "$summary_writer" "$evidence_dir" "$warmup_seconds" "$renderer"
echo "Zoom-performance evidence written to $evidence_dir"
