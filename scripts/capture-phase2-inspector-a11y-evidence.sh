#!/usr/bin/env bash
set -euo pipefail

# Phase 2 P1-2 acceptance: prove the multi-select Inspector announces its
# Same / Mixed / NotApplicable capability tri-state to a screen reader through a
# polite live region, not just through the visible layout. Drives the real
# LayerPanel to build a hostile heterogeneous selection (Frame + Text) and reads
# the live region the same assistive technology would.

base_url="${1:-http://127.0.0.1:3013}"
evidence_dir="${2:-output/phase2-a11y/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
metadata_writer="$(dirname "$0")/write-phase2-inspector-a11y-evidence.mjs"

if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi
mkdir -p "$evidence_dir"
case "$base_url" in
  *"?"*) evidence_url="${base_url}&fixture=phase2-common-nodes" ;;
  *) evidence_url="${base_url}?fixture=phase2-common-nodes" ;;
esac

session="makefigma-phase2-a11y-${RANDOM}${RANDOM}"
close_session() { "$pwcli" --session "$session" close >/dev/null 2>&1 || true; }
trap close_session EXIT

"$pwcli" --session "$session" open "$evidence_url" | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 | tee "$evidence_dir/resize.log"

ready=0
for attempt in $(seq 1 50); do
  "$pwcli" --session "$session" snapshot > "$evidence_dir/snapshot.txt" 2>&1 || true
  if grep -Fq "Rust/WASM bridge ready" "$evidence_dir/snapshot.txt" && grep -Fq "fixed Phase 2 common-nodes fixture loaded" "$evidence_dir/snapshot.txt"; then
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

# Select the Frame, then additively select the Text through real Playwright
# clicks on the LayerPanel rows. DOM-dispatched synthetic clicks do not always
# carry modifier state through React's delegated event handler, so derive the
# current accessibility refs from the fresh snapshot and use the CLI actions.
frame_ref="$(sed -n 's/.*button "# Root Frame ◉".*\[ref=\(e[0-9][0-9]*\)\].*/\1/p' "$evidence_dir/snapshot.txt" | head -n 1)"
text_ref="$(sed -n 's/.*button "T Fixture label ◉".*\[ref=\(e[0-9][0-9]*\)\].*/\1/p' "$evidence_dir/snapshot.txt" | head -n 1)"
if [[ -z "$frame_ref" || -z "$text_ref" ]]; then
  echo "Expected Root Frame and Fixture label layer rows in the accessibility snapshot." >&2
  exit 1
fi
"$pwcli" --session "$session" click "$frame_ref" | tee "$evidence_dir/select-frame.log"
"$pwcli" --session "$session" keydown Shift | tee "$evidence_dir/select-text.log"
"$pwcli" --session "$session" click "$text_ref" | tee -a "$evidence_dir/select-text.log"
"$pwcli" --session "$session" keyup Shift | tee -a "$evidence_dir/select-text.log"

# Layer selection is processed by the Worker before React renders the Inspector.
# Poll a rendered snapshot rather than assuming a browser turn is sufficient;
# otherwise the evidence can read the previous single-selection DOM.
selected=0
for attempt in $(seq 1 50); do
  "$pwcli" --session "$session" snapshot > "$evidence_dir/selection-snapshot.txt" 2>&1 || true
  if grep -Fq "2 layers selected" "$evidence_dir/selection-snapshot.txt"; then
    printf 'Multi-select Inspector rendered after %s snapshot attempt(s).\n' "$attempt" | tee "$evidence_dir/selection-readiness.log"
    selected=1
    break
  fi
  sleep 0.2
done
if [[ "$selected" -ne 1 ]]; then
  echo "Timed out waiting for the multi-select Inspector." >&2
  exit 1
fi

announce_probe='(() => {
  const region = document.querySelector(".multi-inspector .selection-title[role=\"status\"]");
  if (!region) throw new Error("Multi-select live region missing");
  return JSON.stringify({
    role: region.getAttribute("role"),
    ariaLive: region.getAttribute("aria-live"),
    announcement: region.getAttribute("data-selection-capabilities"),
    spokenText: region.querySelector(".visually-hidden")?.textContent ?? "",
  });
})()'
"$pwcli" --session "$session" eval "$announce_probe" | tee "$evidence_dir/selection-announcement.txt"

announcement="$(node -e 'const fs=require("node:fs");for(const line of fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/).map((v)=>v.trim())){if(!line)continue;try{let v=JSON.parse(line);if(typeof v==="string")v=JSON.parse(v);if(v&&typeof v==="object"){process.stdout.write(JSON.stringify(v));break;}}catch{}}' "$evidence_dir/selection-announcement.txt")"
node -e '
  const value = JSON.parse(process.argv[1]);
  const failures = [];
  if (value.role !== "status") failures.push("live region role is not status");
  if (value.ariaLive !== "polite") failures.push("live region is not aria-live=polite");
  if (value.announcement !== value.spokenText) failures.push("data attribute and spoken text diverged");
  if (!/^2 layers selected\./.test(value.announcement ?? "")) failures.push("announcement missing selection count");
  if (!/Editable: Drop shadow\./.test(value.announcement ?? "")) failures.push("announcement missing editable Drop shadow clause");
  if (!/Mixed values: Fill\./.test(value.announcement ?? "")) failures.push("announcement missing Mixed Fill clause");
  if (!/Not applicable: .*Stroke width.*Section contents\./.test(value.announcement ?? "")) failures.push("announcement missing NotApplicable clause");
  if (failures.length) { console.error("Inspector a11y announcement failed:\n" + failures.map((f) => " - " + f).join("\n")); process.exit(1); }
  console.log("Inspector a11y announcement verified: " + value.announcement);
' "$announcement" | tee "$evidence_dir/announcement-verdict.txt"

"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase2-inspector-a11y.png" | tee "$evidence_dir/screenshot.log"
"$pwcli" --session "$session" console | tee "$evidence_dir/console.txt"
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Phase 2 Inspector a11y capture emitted browser console errors." >&2
  exit 1
fi

node "$metadata_writer" "$evidence_dir" "$evidence_url" "$announcement"
echo "Phase 2 Inspector a11y evidence written to $evidence_dir"
