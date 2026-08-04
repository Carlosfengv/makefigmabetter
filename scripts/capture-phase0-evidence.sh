#!/usr/bin/env bash
set -euo pipefail

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright evidence capture." >&2
  exit 1
fi

evidence_url="${1:-http://localhost:3000}"
evidence_dir="${2:-output/phase0-evidence/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
golden_verifier="$(dirname "$0")/verify-phase0-golden.mjs"
metadata_writer="$(dirname "$0")/write-phase0-evidence-metadata.mjs"

mkdir -p "$evidence_dir"

case "$evidence_url" in
  *"?"*) evidence_url="${evidence_url}&fixture=phase0-basic-card&renderer=canvas2d" ;;
  *) evidence_url="${evidence_url}?fixture=phase0-basic-card&renderer=canvas2d" ;;
esac

"$pwcli" --session makefigma-phase0-evidence open "$evidence_url" | tee "$evidence_dir/open.log"
"$pwcli" --session makefigma-phase0-evidence resize 1440 960 | tee "$evidence_dir/resize.log"
fixture_ready=0
for attempt in $(seq 1 50); do
  "$pwcli" --session makefigma-phase0-evidence snapshot | tee "$evidence_dir/snapshot.txt"
  if rg -q "Rust/WASM bridge ready" "$evidence_dir/snapshot.txt" && rg -q "fixed Phase 0 fixture loaded" "$evidence_dir/snapshot.txt"; then
    printf 'Fixture ready after %s snapshot attempt(s).\n' "$attempt" | tee "$evidence_dir/readiness.log"
    fixture_ready=1
    break
  fi
  sleep 0.2
done
if [[ "$fixture_ready" -ne 1 ]]; then
  echo "Timed out waiting for the fixed Fixture and Rust/WASM bridge." | tee "$evidence_dir/readiness.log" >&2
  exit 1
fi
"$pwcli" --session makefigma-phase0-evidence screenshot --filename "$evidence_dir/phase0-basic-card.png" | tee "$evidence_dir/screenshot.log"
"$pwcli" --session makefigma-phase0-evidence console | tee "$evidence_dir/console.txt"
"$pwcli" --session makefigma-phase0-evidence eval 'JSON.stringify({ userAgent: navigator.userAgent, platform: navigator.platform, crossOriginIsolated, devicePixelRatio, viewport: { width: innerWidth, height: innerHeight }, webgpu: Boolean(navigator.gpu) })' | tee "$evidence_dir/browser-runtime.log"

# A pending reviewer baseline is a useful, successful capture outcome. A changed
# reviewed baseline remains a non-zero failure so it cannot be accidentally hidden.
set +e
node "$golden_verifier" "$evidence_dir/phase0-basic-card.png" > "$evidence_dir/golden-verification.json"
verification_status=$?
set -e

# Persist the complete evidence descriptor before acting on the comparison
# result. A mismatch is itself an acceptance artifact and must remain
# reproducible instead of being discarded by an early non-zero exit.
node "$metadata_writer" "$evidence_dir" "$evidence_url"

if [[ "$verification_status" -eq 2 ]]; then
  echo "Golden comparison pending independent baseline review: $evidence_dir/golden-verification.json"
elif [[ "$verification_status" -ne 0 ]]; then
  cat "$evidence_dir/golden-verification.json" >&2
  exit "$verification_status"
fi

echo "Phase 0 evidence written to $evidence_dir"
