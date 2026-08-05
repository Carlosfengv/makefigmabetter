#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3000}"
evidence_dir="${2:-output/phase1-editing/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
session="makefigma-phase1-editing-${RANDOM}${RANDOM}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright editing capture." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi

mkdir -p "$evidence_dir"
case "$base_url" in
  *"?"*) evidence_url="${base_url}&fixture=phase1-render-composite" ;;
  *) evidence_url="${base_url}?fixture=phase1-render-composite" ;;
esac

close_session() {
  "$pwcli" --session "$session" close >/dev/null 2>&1 || true
}
trap close_session EXIT

snapshot() {
  local name="$1"
  "$pwcli" --session "$session" snapshot | tee "$evidence_dir/$name"
}

"$pwcli" --session "$session" open "$evidence_url" | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 | tee "$evidence_dir/resize.log"

ready=0
for attempt in $(seq 1 50); do
  snapshot "ready.snapshot.txt"
  if rg -Fq "Rust/WASM bridge ready" "$evidence_dir/ready.snapshot.txt" \
    && rg -Fq "fixed Phase 1 render composite fixture loaded" "$evidence_dir/ready.snapshot.txt" \
    && rg -Fq "5/100000 nodes" "$evidence_dir/ready.snapshot.txt"; then
    printf 'Phase 1 editing fixture ready after %s snapshot attempt(s).\n' "$attempt" | tee "$evidence_dir/readiness.log"
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for the Phase 1 editing fixture." | tee "$evidence_dir/readiness.log" >&2
  exit 1
fi

# Activate the production Rectangle tool from the fresh accessibility snapshot,
# then send real canvas PointerEvents. Clicking the live, labelled toolbar
# control keeps this browser evidence reliable across Playwright CLI daemon
# versions while exercising the same worker tool state used by the shortcut.
tool_ref="$(sed -nE 's/.*button "Rectangle \(R\)".*\[ref=(e[0-9]+)\].*/\1/p' "$evidence_dir/ready.snapshot.txt" | head -n 1)"
if [[ -z "$tool_ref" ]]; then
  echo "Could not resolve the Rectangle toolbar control from the live snapshot." >&2
  exit 1
fi
"$pwcli" --session "$session" click "$tool_ref" | tee "$evidence_dir/select-rectangle-tool.log"
# Keep the drag in one browser RPC. Some Playwright CLI daemon versions can
# leave a mouse-move RPC queued after an earlier pointer-down command, which
# would test the runner rather than the editor. These are still real DOM
# PointerEvents delivered to the production canvas handler.
draw_probe='(() => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas not found"); const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y })); fire("pointermove", 520, 510); fire("pointerdown", 520, 510); fire("pointermove", 650, 590); fire("pointerup", 650, 590); return "pointer-draw-dispatched"; })()'
"$pwcli" --session "$session" eval "$draw_probe" | tee "$evidence_dir/draw.log"
snapshot "created.snapshot.txt"
if ! rg -Fq "6/100000 nodes" "$evidence_dir/created.snapshot.txt" || ! rg -Fq "Rectangle" "$evidence_dir/created.snapshot.txt"; then
  echo "Rectangle creation did not update the canonical projection." >&2
  exit 1
fi

"$pwcli" --session "$session" press Meta+z | tee "$evidence_dir/undo.log"
snapshot "undo.snapshot.txt"
if ! rg -Fq "5/100000 nodes" "$evidence_dir/undo.snapshot.txt" || rg -Fq 'button "□ Rectangle ◉"' "$evidence_dir/undo.snapshot.txt"; then
  echo "Undo did not restore the fixture's original layer set." >&2
  exit 1
fi

"$pwcli" --session "$session" press Meta+Shift+z | tee "$evidence_dir/redo.log"
snapshot "redo.snapshot.txt"
if ! rg -Fq "6/100000 nodes" "$evidence_dir/redo.snapshot.txt" || ! rg -Fq 'button "□ Rectangle ◉"' "$evidence_dir/redo.snapshot.txt"; then
  echo "Redo did not restore the created rectangle." >&2
  exit 1
fi

"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase1-editing.png" | tee "$evidence_dir/screenshot.log"
"$pwcli" --session "$session" console | tee "$evidence_dir/console.txt"
if ! rg -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Phase 1 editing evidence emitted browser console errors." >&2
  exit 1
fi

printf '{"status":"pass","fixture":"F-PHASE1-RENDER-COMPOSITE","interaction":["toolbar-create","pointer-draw","undo","redo"],"expectedNodeCounts":[5,6,5,6]}\n' > "$evidence_dir/editing-summary.json"
echo "Phase 1 editing evidence written to $evidence_dir"
