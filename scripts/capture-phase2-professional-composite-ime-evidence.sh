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
ime_probe=$(cat <<'JS'
async page => {
  const canvas = page.locator("canvas.design-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Design canvas missing");
  const openEditor = async () => {
    await canvas.dblclick({ position: { x: box.width / 2 - 290, y: box.height / 2 - 238 } });
    const editor = page.getByRole("textbox", { name: "Canvas text content", exact: true });
    await editor.waitFor();
    return editor;
  };
  const hash = page.locator('[aria-label="Canonical document hash"]');
  const reset = page.getByRole("button", { name: /^(Reset|Reset demo)$/ });
  const inspector = page.getByRole("textbox", { name: "Text content", exact: true });

  const before = await hash.getAttribute("data-document-hash");
  const editor = await openEditor();
  await editor.evaluate((element) => {
    const target = element;
    target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中" }));
    target.textContent = "Design · 中文 · مرحبا · 👋中";
    target.dispatchEvent(new InputEvent("input", { bubbles: true, data: "中", inputType: "insertCompositionText", isComposing: true }));
    target.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
    target.dispatchEvent(new InputEvent("input", { bubbles: true, data: "中", inputType: "insertText" }));
  });
  await page.waitForTimeout(400);
  await editor.blur();
  await page.waitForTimeout(700);
  const normal = {
    committedText: await inspector.inputValue(),
    canonicalChanged: before !== await hash.getAttribute("data-document-hash"),
    editorClosed: await editor.count() === 0,
  };
  await reset.click();
  await page.waitForTimeout(500);
  normal.restoredText = await inspector.inputValue();
  normal.restoredHash = await hash.getAttribute("data-document-hash");

  const beforeBlurFirst = await hash.getAttribute("data-document-hash");
  const blurFirstEditor = await openEditor();
  await blurFirstEditor.evaluate((element) => {
    const target = element;
    target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "先" }));
    target.textContent = "Design · 中文 · مرحبا · 👋先";
    target.dispatchEvent(new InputEvent("input", { bubbles: true, data: "先", inputType: "insertCompositionText", isComposing: true }));
  });
  await blurFirstEditor.blur();
  await page.waitForTimeout(100);
  const deferredWhileComposing = await blurFirstEditor.count() === 1;
  await blurFirstEditor.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "先" }));
  });
  await page.waitForTimeout(700);
  const blurFirst = {
    committedText: await inspector.inputValue(),
    canonicalChanged: beforeBlurFirst !== await hash.getAttribute("data-document-hash"),
    deferredWhileComposing,
    editorClosed: await blurFirstEditor.count() === 0,
  };
  await reset.click();
  await page.waitForTimeout(500);
  blurFirst.restoredText = await inspector.inputValue();
  blurFirst.restoredHash = await hash.getAttribute("data-document-hash");

  const beforeMultiline = await hash.getAttribute("data-document-hash");
  const multilineEditor = await openEditor();
  await multilineEditor.evaluate((element) => {
    element.innerHTML = '<div class="canvas-text-paragraph block">ab</div><div class="canvas-text-paragraph block">cd</div>';
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await page.waitForTimeout(300);
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="Canvas text content"]')?.getAttribute("data-rust-caret") === "ready"
  );
  await multilineEditor.evaluate((element) => {
    const second = element.querySelectorAll(".canvas-text-paragraph")[1];
    const text = second?.firstChild;
    if (!text) throw new Error("Second editable paragraph missing");
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.focus();
  });
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  const multiline = {
    draftAfterBackspace: await multilineEditor.innerText(),
  };
  await multilineEditor.blur();
  await page.waitForTimeout(700);
  multiline.committedText = await inspector.inputValue();
  multiline.canonicalChanged = beforeMultiline !== await hash.getAttribute("data-document-hash");
  multiline.editorClosed = await multilineEditor.count() === 0;
  await reset.click();
  await page.waitForTimeout(500);
  multiline.restoredText = await inspector.inputValue();
  multiline.restoredHash = await hash.getAttribute("data-document-hash");

  const emptyParagraphEditor = await openEditor();
  await emptyParagraphEditor.evaluate((element) => {
    element.innerHTML = '<div class="canvas-text-paragraph block">ab</div><div class="canvas-text-paragraph block"></div><div class="canvas-text-paragraph block">cd</div>';
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await page.waitForTimeout(300);
  await emptyParagraphEditor.blur();
  await page.waitForTimeout(700);
  const committedEmptyParagraphText = await inspector.inputValue();
  const committedEmptyParagraphHash = await hash.getAttribute("data-document-hash");
  const reopenedEmptyParagraphEditor = await openEditor();
  const reopenedParagraphs = await reopenedEmptyParagraphEditor.evaluate((element) =>
    [...element.querySelectorAll(".canvas-text-paragraph")].map((paragraph) => ({
      text: paragraph.textContent,
      height: paragraph.getBoundingClientRect().height,
    }))
  );
  await reopenedEmptyParagraphEditor.blur();
  await page.waitForTimeout(700);
  const emptyParagraph = {
    committedText: committedEmptyParagraphText,
    reopenedParagraphs,
    unchangedAfterReopen: committedEmptyParagraphHash === await hash.getAttribute("data-document-hash"),
    editorClosed: await reopenedEmptyParagraphEditor.count() === 0,
  };
  await reset.click();
  await page.waitForTimeout(500);
  emptyParagraph.restoredText = await inspector.inputValue();
  emptyParagraph.restoredHash = await hash.getAttribute("data-document-hash");
  return { normal, blurFirst, multiline, emptyParagraph };
}
JS
)
"$pwcli" --session "$session" run-code "$ime_probe" > "$evidence_dir/ime-result.txt" 2>&1
if ! grep -Fq '"normal":{"committedText":"Design · 中文 · مرحبا · 👋中","canonicalChanged":true,"editorClosed":true' "$evidence_dir/ime-result.txt" \
  || ! grep -Fq '"restoredText":"Design · 中文 · مرحبا · 👋"' "$evidence_dir/ime-result.txt" \
  || ! grep -Fq '"restoredHash":"088a9e111e36b25e0df22d237bf62d4b58daeddca05d933e510f9e2bdbdd1eaf"' "$evidence_dir/ime-result.txt" \
  || ! grep -Fq '"blurFirst":{"committedText":"Design · 中文 · مرحبا · 👋先","canonicalChanged":true,"deferredWhileComposing":true,"editorClosed":true' "$evidence_dir/ime-result.txt" \
  || ! grep -Fq '"multiline":{"draftAfterBackspace":"ab\nd","committedText":"ab\nd","canonicalChanged":true,"editorClosed":true' "$evidence_dir/ime-result.txt" \
  || ! grep -Eq '"emptyParagraph":\{"committedText":"ab\\n\\ncd","reopenedParagraphs":\[\{"text":"ab","height":[1-9][0-9.]*\},\{"text":"","height":[1-9][0-9.]*\},\{"text":"cd","height":[1-9][0-9.]*\}\],"unchangedAfterReopen":true,"editorClosed":true' "$evidence_dir/ime-result.txt"; then
  cat "$evidence_dir/ime-result.txt" >&2
  exit 1
fi
"$pwcli" --session "$session" console > "$evidence_dir/console.txt" 2>&1
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  cat "$evidence_dir/console.txt" >&2
  exit 1
fi
echo "Phase 2 professional IME candidate written to $evidence_dir"
