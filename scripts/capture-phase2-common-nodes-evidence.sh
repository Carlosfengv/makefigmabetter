#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3013}"
evidence_dir="${2:-output/phase2-common-nodes/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
metadata_writer="$(dirname "$0")/write-phase2-common-nodes-evidence.mjs"
performance_writer="$(dirname "$0")/write-phase2-common-nodes-performance-summary.mjs"
warmup_seconds="${PHASE2_COMMON_NODES_WARMUP_SECONDS:-5}"
performance_runs="${PHASE2_COMMON_NODES_PERFORMANCE_RUNS:-3}"

if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi
if ! [[ "$warmup_seconds" =~ ^[0-9]+$ ]] || ! [[ "$performance_runs" =~ ^([3-9]|[1-9][0-9]+)$ ]]; then
  echo "Phase 2 warmup must be non-negative and performance runs must be at least 3." >&2
  exit 64
fi
mkdir -p "$evidence_dir"
case "$base_url" in
  *"?"*) evidence_url="${base_url}&fixture=phase2-common-nodes" ;;
  *) evidence_url="${base_url}?fixture=phase2-common-nodes" ;;
esac

session="makefigma-phase2-common-nodes-${RANDOM}${RANDOM}"
"$pwcli" --session "$session" open "$evidence_url" | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 | tee "$evidence_dir/resize.log"
ready=0
for attempt in $(seq 1 50); do
  "$pwcli" --session "$session" snapshot > "$evidence_dir/snapshot.txt" 2>&1 || true
  if rg -Fq "Rust/WASM bridge ready" "$evidence_dir/snapshot.txt" && rg -Fq "fixed Phase 2 common-nodes fixture loaded" "$evidence_dir/snapshot.txt"; then
    printf 'Phase 2 common-nodes fixture ready after %s snapshot attempt(s).\n' "$attempt" | tee "$evidence_dir/readiness.log"
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for the Phase 2 common-nodes fixture." | tee "$evidence_dir/readiness.log" >&2
  exit 1
fi
"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase2-common-nodes.png" | tee "$evidence_dir/screenshot.log"
"$pwcli" --session "$session" eval 'JSON.stringify({ userAgent: navigator.userAgent, viewport: { width: window.innerWidth, height: window.innerHeight }, dpr: window.devicePixelRatio, webgpu: Boolean(navigator.gpu), hardwareConcurrency: navigator.hardwareConcurrency ?? null })' | tee "$evidence_dir/browser-environment.txt"
"$pwcli" --session "$session" console | tee "$evidence_dir/console.txt"
if ! rg -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Phase 2 common-nodes evidence capture emitted browser console errors." >&2
  exit 1
fi
if (( warmup_seconds > 0 )); then
  printf 'Warming up Phase 2 input and render metrics for %ss.\n' "$warmup_seconds" | tee "$evidence_dir/performance-warmup.log"
  sleep "$warmup_seconds"
else
  printf 'Phase 2 performance warmup skipped.\n' | tee "$evidence_dir/performance-warmup.log"
fi
performance_probe='(async () => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas missing"); const frame = () => new Promise((resolve) => requestAnimationFrame(resolve)); for (let index = 0; index < 64; index += 1) { canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 720, clientY: 480, deltaX: index % 2 ? 3 : -3, deltaY: 0 })); await frame(); } await new Promise((resolve) => setTimeout(resolve, 300)); return JSON.stringify({ render: JSON.parse(document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-performance") ?? "{}"), input: JSON.parse(document.querySelector("[aria-label=\"Input backlog evidence\"]")?.getAttribute("data-input-backlog") ?? "{}") }); })()'
for run in $(seq 1 "$performance_runs"); do
  "$pwcli" --session "$session" eval "$performance_probe" | tee "$evidence_dir/performance-run-$(printf '%02d' "$run").txt"
done
node "$performance_writer" "$evidence_dir" "$warmup_seconds"
node "$metadata_writer" "$evidence_dir" "$evidence_url"
echo "Phase 2 common-nodes evidence written to $evidence_dir"
