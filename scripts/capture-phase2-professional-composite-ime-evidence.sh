#!/usr/bin/env bash
set -euo pipefail

# Records a real-browser IME composition candidate against the frozen
# professional fixture. This is intentionally a candidate: it validates the
# browser path but cannot substitute for OS IMEs or cross-platform review.
base_url="${1:-http://127.0.0.1:3080}"
evidence_dir="${2:-output/phase2-professional-composite/ime-$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"

if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi

mkdir -p "$evidence_dir"
case "$base_url" in
  *"?"*) evidence_url="${base_url}&fixture=phase2-professional-composite" ;;
  *) evidence_url="${base_url}?fixture=phase2-professional-composite" ;;
esac
session="makefigma-phase2-professional-ime-${RANDOM}${RANDOM}"
cleanup() { "$pwcli" --session "$session" close >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$pwcli" --session "$session" open "$evidence_url" | tee "$evidence_dir/open.log"
readiness_probe='async () => { const status = document.querySelector(".engine-status")?.textContent ?? ""; return Boolean(document.querySelector("canvas.design-canvas")) && status.includes("Rust/WASM bridge ready") && status.includes("fixed Phase 2 professional composite fixture loaded"); }'
ready=0
for attempt in $(seq 1 50); do
  "$pwcli" --session "$session" eval "$readiness_probe" > "$evidence_dir/readiness.txt" 2>&1 || true
  if grep -Fxq "true" "$evidence_dir/readiness.txt"; then
    printf 'Phase 2 professional IME fixture ready after %s probe(s).\n' "$attempt" | tee "$evidence_dir/readiness.log"
    ready=1
    break
  fi
  sleep .2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for the Phase 2 professional IME fixture." >&2
  exit 1
fi

# The fixed fixture starts at viewport (0, 0). Its title occupies the upper
# left Canvas area; derive the hit point from the actual Canvas dimensions so
# browser chrome does not enter the coordinate calculation.
ime_probe='async page => { const canvas = page.locator("canvas.design-canvas"); const box = await canvas.boundingBox(); if (!box) throw new Error("Design canvas missing"); await canvas.dblclick({ position: { x: box.width / 2 - 290, y: box.height / 2 - 238 } }); const editor = page.getByRole("textbox", { name: "Canvas text content", exact: true }); await editor.waitFor(); const hash = page.locator("[aria-label=\"Canonical document hash\"]"); const before = await hash.getAttribute("data-document-hash"); await editor.evaluate((element) => { const target = element; target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中" })); target.textContent = "Design · 中文 · مرحبا · 👋中"; target.dispatchEvent(new InputEvent("input", { bubbles: true, data: "中", inputType: "insertCompositionText", isComposing: true })); target.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" })); target.dispatchEvent(new InputEvent("input", { bubbles: true, data: "中", inputType: "insertText" })); }); await page.waitForTimeout(400); await editor.blur(); await page.waitForTimeout(700); const text = await page.getByRole("textbox", { name: "Text content", exact: true }).inputValue(); const after = await hash.getAttribute("data-document-hash"); const reset = page.getByRole("button", { name: "Reset demo", exact: true }); await reset.click(); await page.waitForTimeout(500); const restoredText = await page.getByRole("textbox", { name: "Text content", exact: true }).inputValue(); const restoredHash = await hash.getAttribute("data-document-hash"); return { committedText: text, canonicalChanged: Boolean(before && after && before !== after), editorClosed: await page.getByRole("textbox", { name: "Canvas text content", exact: true }).count() === 0, restoredText, restoredHash }; }'
"$pwcli" --session "$session" run-code "$ime_probe" > "$evidence_dir/ime-result.txt" 2>&1
if ! grep -Fq '"committedText":"Design · 中文 · مرحبا · 👋中"' "$evidence_dir/ime-result.txt" \
  || ! grep -Fq '"canonicalChanged":true' "$evidence_dir/ime-result.txt" \
  || ! grep -Fq '"editorClosed":true' "$evidence_dir/ime-result.txt" \
  || ! grep -Fq '"restoredText":"Design · 中文 · مرحبا · 👋"' "$evidence_dir/ime-result.txt" \
  || ! grep -Fq '"restoredHash":"b4d9c9d39a0f4a98931b514fbc9e772bf43c251008b9e14c792b349b59a46c7b"' "$evidence_dir/ime-result.txt"; then
  cat "$evidence_dir/ime-result.txt" >&2
  exit 1
fi
"$pwcli" --session "$session" console > "$evidence_dir/console.txt" 2>&1
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  cat "$evidence_dir/console.txt" >&2
  exit 1
fi
echo "Phase 2 professional IME candidate written to $evidence_dir"
