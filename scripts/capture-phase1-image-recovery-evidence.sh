#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3000}"
evidence_dir="${2:-output/phase1-image-recovery/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
session="makefigma-phase1-image-recovery-${RANDOM}${RANDOM}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright recovery capture." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi

mkdir -p "$evidence_dir"
case "$base_url" in
  *"?"*) evidence_url="${base_url}&fixture=phase1-render-composite&simulateGpuLoss=1" ;;
  *) evidence_url="${base_url}?fixture=phase1-render-composite&simulateGpuLoss=1" ;;
esac

"$pwcli" --session "$session" open "$evidence_url" | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 | tee "$evidence_dir/resize.log"
ready=0
for attempt in $(seq 1 50); do
  "$pwcli" --session "$session" snapshot > "$evidence_dir/snapshot.txt" 2>&1 || true
  cat "$evidence_dir/snapshot.txt"
  if grep -Fq "WebGPU scene recovered (1)" "$evidence_dir/snapshot.txt" && grep -Fq "Rust/WASM bridge ready" "$evidence_dir/snapshot.txt" && grep -Fq "fixed Phase 1 render composite fixture loaded" "$evidence_dir/snapshot.txt"; then
    printf 'Image-backed GPU recovery reached its expected state after %s snapshot attempt(s).\n' "$attempt" | tee "$evidence_dir/readiness.log"
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for image-backed WebGPU recovery." | tee "$evidence_dir/readiness.log" >&2
  exit 1
fi
"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase1-image-recovery.png" | tee "$evidence_dir/screenshot.log"
"$pwcli" --session "$session" console | tee "$evidence_dir/console.txt"
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Image-backed GPU recovery emitted browser console errors." >&2
  exit 1
fi
printf '{"status":"pass","fixture":"F-PHASE1-RENDER-COMPOSITE","simulateGpuLoss":1,"expected":"webgpu-recovered-after-image-upload"}\n' > "$evidence_dir/recovery-summary.json"
echo "Phase 1 image recovery evidence written to $evidence_dir"
