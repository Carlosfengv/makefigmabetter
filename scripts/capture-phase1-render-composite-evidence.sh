#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3000}"
evidence_dir="${2:-output/phase1-render-composite/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
metadata_writer="$(dirname "$0")/write-phase1-render-composite-evidence.mjs"
performance_writer="$(dirname "$0")/write-phase1-render-composite-performance-summary.mjs"
warmup_seconds="${PHASE1_RENDER_COMPOSITE_WARMUP_SECONDS:-30}"
performance_runs="${PHASE1_RENDER_COMPOSITE_RUNS:-3}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright evidence capture." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi
if ! [[ "$warmup_seconds" =~ ^[0-9]+$ ]] || ! [[ "$performance_runs" =~ ^([3-9]|[1-9][0-9]+)$ ]]; then
  echo "PHASE1_RENDER_COMPOSITE_WARMUP_SECONDS must be non-negative and PHASE1_RENDER_COMPOSITE_RUNS must be an integer of at least 3." >&2
  exit 64
fi

mkdir -p "$evidence_dir"
case "$base_url" in
  *"?"*) evidence_url="${base_url}&fixture=phase1-render-composite" ;;
  *) evidence_url="${base_url}?fixture=phase1-render-composite" ;;
esac

performance_probe='(async () => { const canvas = document.querySelector("canvas"); if (!canvas) throw new Error("Canvas not found"); const frame = () => new Promise((resolve) => requestAnimationFrame(resolve)); const wheel = (deltaX) => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 720, clientY: 480, deltaX, deltaY: 0 })); for (let index = 0; index < 120; index += 1) { wheel(1); await frame(); wheel(-1); await frame(); } await new Promise((resolve) => setTimeout(resolve, 300)); return document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-performance") ?? ""; })()'

session="makefigma-phase1-render-composite-${RANDOM}${RANDOM}"
"$pwcli" --session "$session" open "$evidence_url" | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 | tee "$evidence_dir/resize.log"
ready=0
for attempt in $(seq 1 50); do
  # A newly opened Playwright daemon can acknowledge navigation before its
  # first snapshot RPC is ready. Treat that short-lived failure as a miss.
  "$pwcli" --session "$session" snapshot > "$evidence_dir/snapshot.txt" 2>&1 || true
  cat "$evidence_dir/snapshot.txt"
  if grep -Fq "Rust/WASM bridge ready" "$evidence_dir/snapshot.txt" && grep -Fq "fixed Phase 1 render composite fixture loaded" "$evidence_dir/snapshot.txt" && grep -Fq "WebGPU scene active" "$evidence_dir/snapshot.txt"; then
    printf 'Phase 1 render composite fixture ready after %s snapshot attempt(s).\n' "$attempt" | tee "$evidence_dir/readiness.log"
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for the Phase 1 composite fixture and WebGPU renderer." | tee "$evidence_dir/readiness.log" >&2
  exit 1
fi
"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase1-render-composite.png" | tee "$evidence_dir/screenshot.log"
environment_probe='JSON.stringify({ userAgent: navigator.userAgent, viewport: { width: window.innerWidth, height: window.innerHeight }, dpr: window.devicePixelRatio, webgpu: Boolean(navigator.gpu), hardwareConcurrency: navigator.hardwareConcurrency ?? null })'
"$pwcli" --session "$session" eval "$environment_probe" | tee "$evidence_dir/browser-environment.txt"
"$pwcli" --session "$session" console | tee "$evidence_dir/console.txt"
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Phase 1 composite evidence capture emitted browser console errors." >&2
  exit 1
fi
if (( warmup_seconds > 0 )); then sleep "$warmup_seconds"; fi
printf 'Warmup: %ss\n' "$warmup_seconds" > "$evidence_dir/performance-warmup.log"
# Each probe performs 240 animation-frame-separated pans. The Worker sampling
# window is 240 entries, so every recorded run is a complete steady-state window.
for run in $(seq 1 "$performance_runs"); do
  "$pwcli" --session "$session" eval "$performance_probe" | tee "$evidence_dir/performance-run-$(printf '%02d' "$run").txt"
done
node "$performance_writer" "$evidence_dir" "$warmup_seconds"
node "$metadata_writer" "$evidence_dir" "$evidence_url"
echo "Phase 1 composite evidence written to $evidence_dir"
