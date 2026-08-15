#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3000}"
evidence_dir="${2:-output/phase1-gpu-recovery/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright recovery capture." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi

mkdir -p "$evidence_dir"

url_for() {
  local losses="$1"
  case "$base_url" in
    *"?"*) printf '%s&fixture=phase0-basic-card&simulateGpuLoss=%s' "$base_url" "$losses" ;;
    *) printf '%s?fixture=phase0-basic-card&simulateGpuLoss=%s' "$base_url" "$losses" ;;
  esac
}

capture_case() {
  local losses="$1"
  local expected="$2"
  # Keep evidence captures isolated from a previous interrupted run and from
  # other Phase 1 browser probes running on the same development machine.
  local session="makefigma-phase1-gpu-recovery-${losses}-${RANDOM}${RANDOM}"
  local snapshot="$evidence_dir/gpu-loss-$losses.snapshot.txt"

  "$pwcli" -s="$session" open "$(url_for "$losses")" | tee "$evidence_dir/gpu-loss-$losses.open.log"
  # The CLI daemon may acknowledge `open` before its page RPC is ready. Let the
  # browser finish its deliberately scheduled device-loss/recovery cycle before
  # asking it for a snapshot; polling immediately can leave an orphaned RPC.
  sleep 4
  local ready=0
  for attempt in $(seq 1 3); do
    timeout 20 "$pwcli" -s="$session" snapshot > "$snapshot" 2>&1 || true
    if grep -Fq "Rust/WASM bridge ready" "$snapshot" && grep -Fq "$expected" "$snapshot"; then
      printf 'GPU loss %s reached expected state after %s snapshot attempt(s).\n' "$losses" "$attempt" | tee "$evidence_dir/gpu-loss-$losses.readiness.log"
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    cat "$snapshot" >&2
    "$pwcli" -s="$session" close >/dev/null 2>&1 || true
    echo "Timed out waiting for GPU loss $losses state: $expected" >&2
    exit 1
  fi
  "$pwcli" -s="$session" console error | tee "$evidence_dir/gpu-loss-$losses.console.txt"
  if ! grep -Eq "Errors: 0" "$evidence_dir/gpu-loss-$losses.console.txt"; then
    "$pwcli" -s="$session" close >/dev/null 2>&1 || true
    echo "GPU recovery case $losses emitted console errors." >&2
    exit 1
  fi
  "$pwcli" -s="$session" close | tee "$evidence_dir/gpu-loss-$losses.close.log"
}

capture_case 1 "WebGPU scene recovered (1)"
capture_case 2 "WebGPU recovery exhausted"

printf '{"status":"pass","cases":[{"simulateGpuLoss":1,"expected":"recovered"},{"simulateGpuLoss":2,"expected":"canvas-fallback"}]}\n' > "$evidence_dir/recovery-summary.json"
echo "Phase 1 GPU recovery evidence written to $evidence_dir"
