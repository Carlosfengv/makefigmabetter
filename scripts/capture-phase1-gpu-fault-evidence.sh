#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3000}"
evidence_dir="${2:-output/playwright/phase1-gpu-fault/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright GPU-fault capture." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi
mkdir -p "$evidence_dir"

url_for() {
  local fault="$1"
  case "$base_url" in
    *"?"*) printf '%s&fixture=phase0-basic-card&simulateGpuFault=%s' "$base_url" "$fault" ;;
    *) printf '%s?fixture=phase0-basic-card&simulateGpuFault=%s' "$base_url" "$fault" ;;
  esac
}

capture_case() {
  local fault="$1"
  local expected_code="$2"
  local expected_scene="$3"
  local session="makefigma-phase1-gpu-fault-${fault}-${RANDOM}${RANDOM}"
  local case_dir="$evidence_dir/$fault"
  mkdir -p "$case_dir"
  cleanup_case() { "$pwcli" --session "$session" close >/dev/null 2>&1 || true; }
  trap cleanup_case RETURN

  "$pwcli" --session "$session" open "$(url_for "$fault")" 2>&1 | tee "$case_dir/open.log"
  "$pwcli" --session "$session" resize 1440 960 2>&1 | tee "$case_dir/resize.log"
  local matched=0
  for attempt in $(seq 1 50); do
    "$pwcli" --session "$session" snapshot > "$case_dir/snapshot.txt" 2>&1 || true
    "$pwcli" --session "$session" eval '(() => document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-diagnostics") ?? "")()' > "$case_dir/diagnostics.json" 2>&1 || true
    if rg -Fq "Rust/WASM bridge ready" "$case_dir/snapshot.txt" \
      && rg -Fq "$expected_code" "$case_dir/diagnostics.json" \
      && rg -Fq "$expected_scene" "$case_dir/snapshot.txt"; then
      matched=1
      break
    fi
    sleep 0.2
  done
  if [[ "$matched" -ne 1 ]]; then
    cat "$case_dir/snapshot.txt" >&2
    cat "$case_dir/diagnostics.json" >&2
    echo "GPU fault $fault did not produce $expected_code and $expected_scene." >&2
    exit 1
  fi
  "$pwcli" --session "$session" screenshot --filename "$case_dir/phase1-gpu-fault-$fault.png" 2>&1 | tee "$case_dir/screenshot.log"
  "$pwcli" --session "$session" console 2>&1 | tee "$case_dir/console.txt"
  if ! rg -Fq "Errors: 0" "$case_dir/console.txt"; then
    echo "GPU fault $fault emitted browser console errors." >&2
    exit 1
  fi
  trap - RETURN
  cleanup_case
}

# OOM and upload failure discard derived GPU state and take the bounded recovery
# path. Validation remains a diagnostic-only event when the browser keeps the
# device valid.
capture_case out-of-memory WEBGPU_OUT_OF_MEMORY "WebGPU scene recovered (1)"
capture_case validation WEBGPU_VALIDATION_ERROR "WebGPU scene active"
capture_case upload WEBGPU_UPLOAD_FAILED "WebGPU scene recovered (1)"

printf '{"status":"pass","cases":[{"fault":"out-of-memory","diagnostic":"WEBGPU_OUT_OF_MEMORY","outcome":"recovered"},{"fault":"validation","diagnostic":"WEBGPU_VALIDATION_ERROR","outcome":"device-retained"},{"fault":"upload","diagnostic":"WEBGPU_UPLOAD_FAILED","outcome":"recovered"}]}\n' > "$evidence_dir/gpu-fault-summary.json"
echo "Phase 1 GPU fault evidence written to $evidence_dir"
