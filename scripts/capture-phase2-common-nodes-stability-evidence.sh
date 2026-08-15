#!/usr/bin/env bash
set -euo pipefail

# Candidate recorder for the Phase 2 stability Gate. This script deliberately
# never marks Phase 2 complete: a reviewer still needs to inspect the captured
# run and freeze a Golden independently.
base_url="${1:-http://127.0.0.1:3013}"
evidence_dir="${2:-output/phase2-common-nodes/stability-$(date -u +%Y%m%dT%H%M%SZ)}"
duration_seconds="${MAKEFIGMA_PHASE2_STABILITY_DURATION_SECONDS:-3600}"
cycle_seconds="${MAKEFIGMA_PHASE2_STABILITY_CYCLE_SECONDS:-15}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
metadata_writer="$(dirname "$0")/write-phase2-common-nodes-evidence.mjs"
performance_writer="$(dirname "$0")/write-phase2-common-nodes-performance-summary.mjs"

if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi
if ! [[ "$duration_seconds" =~ ^[0-9]+$ ]] || ! [[ "$cycle_seconds" =~ ^[0-9]+$ ]] || [[ "$cycle_seconds" -eq 0 ]]; then
  echo "Phase 2 stability duration and cycle must be whole seconds." >&2
  exit 64
fi

mkdir -p "$evidence_dir"
case "$base_url" in
  *"?"*) evidence_url="${base_url}&fixture=phase2-common-nodes" ;;
  *) evidence_url="${base_url}?fixture=phase2-common-nodes" ;;
esac

session="makefigma-phase2-stability-${RANDOM}${RANDOM}"
cleanup() {
  "$pwcli" --session "$session" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$pwcli" --session "$session" open "$evidence_url" | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 | tee "$evidence_dir/resize.log"

ready=0
for attempt in $(seq 1 50); do
  "$pwcli" --session "$session" snapshot > "$evidence_dir/snapshot.txt" 2>&1 || true
  if grep -Fq "Rust/WASM bridge ready" "$evidence_dir/snapshot.txt" && grep -Fq "fixed Phase 2 common-nodes fixture loaded" "$evidence_dir/snapshot.txt"; then
    printf 'Phase 2 stability fixture ready after %s snapshot attempt(s).\n' "$attempt" | tee "$evidence_dir/readiness.log"
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for the Phase 2 common-nodes fixture." | tee "$evidence_dir/readiness.log" >&2
  exit 1
fi

"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase2-common-nodes-start.png" | tee "$evidence_dir/screenshot-start.log"
"$pwcli" --session "$session" eval 'JSON.stringify({ userAgent: navigator.userAgent, viewport: { width: window.innerWidth, height: window.innerHeight }, dpr: window.devicePixelRatio, webgpu: Boolean(navigator.gpu), hardwareConcurrency: navigator.hardwareConcurrency ?? null })' | tee "$evidence_dir/browser-environment.txt"

# Every cycle injects 64 alternating pans. The worker records the timestamp
# supplied by the UI event, so the resulting P95 is input-to-render rather
# than merely JavaScript dispatch time.
performance_probe='(async () => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas missing"); const frame = () => new Promise((resolve) => requestAnimationFrame(resolve)); for (let index = 0; index < 64; index += 1) { canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 720, clientY: 480, deltaX: index % 2 ? 3 : -3, deltaY: 0 })); await frame(); } await new Promise((resolve) => setTimeout(resolve, 300)); return JSON.stringify({ render: JSON.parse(document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-performance") ?? "{}"), input: JSON.parse(document.querySelector("[aria-label=\"Input backlog evidence\"]")?.getAttribute("data-input-backlog") ?? "{}") }); })()'

started_at="$(date +%s)"
run=0
while :; do
  elapsed=$(( $(date +%s) - started_at ))
  if (( elapsed >= duration_seconds )) && (( run >= 3 )); then break; fi
  run=$((run + 1))
  "$pwcli" --session "$session" eval "$performance_probe" | tee "$evidence_dir/performance-run-$(printf '%04d' "$run").txt"
  printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$elapsed" >> "$evidence_dir/cycles.tsv"
  elapsed=$(( $(date +%s) - started_at ))
  remaining=$(( duration_seconds - elapsed ))
  if (( remaining > 0 )); then sleep "$(( remaining < cycle_seconds ? remaining : cycle_seconds ))"; fi
done

"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase2-common-nodes-end.png" | tee "$evidence_dir/screenshot-end.log"
"$pwcli" --session "$session" console | tee "$evidence_dir/console.txt"
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Phase 2 stability capture emitted browser console errors." >&2
  exit 1
fi

node "$performance_writer" "$evidence_dir" 0
node "$metadata_writer" "$evidence_dir" "$evidence_url"
printf 'Phase 2 stability candidate captured for %ss across %s cycle(s).\n' "$duration_seconds" "$run" | tee "$evidence_dir/stability-summary.log"
