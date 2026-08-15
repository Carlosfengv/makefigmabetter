#!/usr/bin/env bash
set -euo pipefail

# Records a reproducible candidate for the professional Phase 2 composite.
# It deliberately remains pending independent Golden review.
base_url="${1:-http://127.0.0.1:3080}"
evidence_dir="${2:-output/phase2-professional-composite/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
metadata_writer="$(dirname "$0")/write-phase2-professional-composite-evidence.mjs"
performance_writer="$(dirname "$0")/write-phase2-common-nodes-performance-summary.mjs"
warmup_seconds="${PHASE2_PROFESSIONAL_COMPOSITE_WARMUP_SECONDS:-5}"
performance_runs="${PHASE2_PROFESSIONAL_COMPOSITE_PERFORMANCE_RUNS:-3}"

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
  *"?"*) evidence_url="${base_url}&fixture=phase2-professional-composite" ;;
  *) evidence_url="${base_url}?fixture=phase2-professional-composite" ;;
esac

session="makefigma-phase2-professional-${RANDOM}${RANDOM}"
cleanup() { "$pwcli" --session "$session" close >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$pwcli" --session "$session" open "$evidence_url" | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 | tee "$evidence_dir/resize.log"
ready=0
for attempt in $(seq 1 50); do
  # Keep the CLI output itself as the stable accessibility snapshot. The
  # installed Playwright CLI does not support a `--filename` option here.
  "$pwcli" --session "$session" snapshot > "$evidence_dir/snapshot.txt" 2>&1 || true
  if grep -Fq "Engine worker online" "$evidence_dir/snapshot.txt" \
    && grep -Fq "Rust/WASM bridge ready" "$evidence_dir/snapshot.txt" \
    && grep -Fq "3 assets" "$evidence_dir/snapshot.txt" \
    && grep -Fq "fixed Phase 2 professional composite fixture loaded" "$evidence_dir/snapshot.txt"; then
    printf 'Phase 2 professional composite fixture ready after %s snapshot attempt(s).\n' "$attempt" | tee "$evidence_dir/readiness.log"
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for the Phase 2 professional composite fixture." | tee "$evidence_dir/readiness.log" >&2
  exit 1
fi
"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase2-professional-composite.png" | tee "$evidence_dir/screenshot.log"
"$pwcli" --session "$session" eval 'async () => JSON.stringify({ userAgent: navigator.userAgent, viewport: { width: window.innerWidth, height: window.innerHeight }, dpr: window.devicePixelRatio, webgpu: Boolean(navigator.gpu), hardwareConcurrency: navigator.hardwareConcurrency ?? null })' > "$evidence_dir/browser-environment.txt" 2>&1
"$pwcli" --session "$session" console > "$evidence_dir/console.txt" 2>&1
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Phase 2 professional composite evidence capture emitted browser console errors." >&2
  exit 1
fi
if (( warmup_seconds > 0 )); then sleep "$warmup_seconds"; fi
# `playwright-cli eval` evaluates a function directly. Passing an immediately
# invoked async expression is parsed as an option by recent CLI versions, so
# keep this as an async function expression just like the environment probe.
performance_probe='async () => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas missing"); const frame = () => new Promise((resolve) => requestAnimationFrame(resolve)); for (let index = 0; index < 64; index += 1) { canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 720, clientY: 480, deltaX: index % 2 ? 3 : -3, deltaY: 0 })); await frame(); } await new Promise((resolve) => setTimeout(resolve, 300)); return JSON.stringify({ render: JSON.parse(document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-performance") ?? "{}"), input: JSON.parse(document.querySelector("[aria-label=\"Input backlog evidence\"]")?.getAttribute("data-input-backlog") ?? "{}") }); }'
for run in $(seq 1 "$performance_runs"); do
  "$pwcli" --session "$session" eval "$performance_probe" > "$evidence_dir/performance-run-$(printf '%02d' "$run").txt" 2>&1
done
node "$performance_writer" "$evidence_dir" "$warmup_seconds" "makefigma-phase2-professional-composite-performance-v1"
node "$metadata_writer" "$evidence_dir" "$evidence_url"
echo "Phase 2 professional composite evidence written to $evidence_dir"
