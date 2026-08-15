#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3000}"
evidence_dir="${2:-output/playwright/phase1-text-caret/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
session="makefigma-phase1-text-caret-${RANDOM}${RANDOM}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright text-caret capture." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi

mkdir -p "$evidence_dir"
cleanup() { "$pwcli" --session "$session" close >/dev/null 2>&1 || true; }
trap cleanup EXIT

case "$base_url" in
  *"?"*) evidence_url="${base_url}&fixture=phase0-basic-card" ;;
  *) evidence_url="${base_url}?fixture=phase0-basic-card" ;;
esac

"$pwcli" --session "$session" open "$evidence_url" 2>&1 | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 2>&1 | tee "$evidence_dir/resize.log"

wait_for_eval() {
  local name="$1"
  local expression="$2"
  local expected="$3"
  for attempt in $(seq 1 40); do
    "$pwcli" --session "$session" eval "$expression" > "$evidence_dir/$name" 2>&1 || true
    if grep -Fq "$expected" "$evidence_dir/$name"; then return 0; fi
    sleep 0.2
  done
  cat "$evidence_dir/$name" >&2
  return 1
}

# The fixture's fixed Headline has no separate DOM target. Dispatching its
# double-click directly to the canvas exercises the same React handler while
# keeping the screenshot viewport deterministic.
double_click='(() => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas not found"); const rect = canvas.getBoundingClientRect(); canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: rect.left + rect.width / 2 - 180, clientY: rect.top + rect.height / 2 + 85 })); return "headline-editing"; })()'
"$pwcli" --session "$session" eval "$double_click" 2>&1 | tee "$evidence_dir/double-click.log"
caret_state='document.querySelector("[aria-label=\"Canvas text content\"]")?.dataset.rustCaret'
if ! wait_for_eval "initial-rust-caret.txt" "$caret_state" '"ready"'; then
  echo "Rust caret layout did not become ready after entering canvas text editing." >&2
  exit 1
fi

composition_start='(() => { const editor = document.querySelector("[aria-label=\"Canvas text content\"]"); if (!editor) throw new Error("Canvas text editor unavailable"); editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" })); editor.textContent = "Design, with intent.中"; editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "中" })); return editor.dataset.rustCaret; })()'
"$pwcli" --session "$session" eval "$composition_start" 2>&1 | tee "$evidence_dir/composition-start.log"
if ! wait_for_eval "composition-pending.txt" "$caret_state" '"pending"'; then
  echo "Rust caret layout was not paused while composing text." >&2
  exit 1
fi

composition_end='(() => { const editor = document.querySelector("[aria-label=\"Canvas text content\"]"); if (!editor) throw new Error("Canvas text editor unavailable"); editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" })); return editor.dataset.rustCaret; })()'
"$pwcli" --session "$session" eval "$composition_end" 2>&1 | tee "$evidence_dir/composition-end.log"
if ! wait_for_eval "composition-ready.txt" "$caret_state" '"ready"'; then
  echo "Rust caret layout did not resume after composition end." >&2
  exit 1
fi

# The DOM still paints the selection, but left/right navigation must walk the
# Core-returned legal stops. This uses the final CJK character as an unambiguous
# one-code-unit boundary after the composition exercise.
keyboard_navigation='(() => { const editor = document.querySelector("[aria-label=\"Canvas text content\"]"); if (!editor) throw new Error("Canvas text editor unavailable"); const offsetAt = (node, offset) => { const before = document.createRange(); before.selectNodeContents(editor); before.setEnd(node, offset); return before.toString().length; }; const pointAt = (target) => { const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let remaining = target; let node = walker.nextNode(); while (node) { const length = node.textContent.length; if (remaining <= length) return { node, offset: remaining }; remaining -= length; node = walker.nextNode(); } throw new Error("Selection target not found"); }; const read = () => { const selection = window.getSelection(); return { anchor: offsetAt(selection.anchorNode, selection.anchorOffset), focus: offsetAt(selection.focusNode, selection.focusOffset), selected: selection.toString() }; }; const beforeCjk = editor.innerText.indexOf("中"); if (beforeCjk < 0) throw new Error("Composition text missing"); const start = pointAt(beforeCjk); window.getSelection().setBaseAndExtent(start.node, start.offset, start.node, start.offset); editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })); const afterRight = read(); editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft", shiftKey: true })); const afterShiftLeft = read(); return "rust-keyboard-ok|before=" + beforeCjk + "|right=" + afterRight.anchor + ":" + afterRight.focus + "|shift=" + afterShiftLeft.anchor + ":" + afterShiftLeft.focus + ":" + afterShiftLeft.selected; })()'
"$pwcli" --session "$session" eval "$keyboard_navigation" 2>&1 | tee "$evidence_dir/keyboard-navigation.log"
if ! grep -Fq 'rust-keyboard-ok|before=20|right=21:21|shift=21:20:中' "$evidence_dir/keyboard-navigation.log"; then
  echo "Rust caret keyboard navigation did not preserve the expected legal CJK boundary." >&2
  exit 1
fi

# beforeinput is the actual contentEditable mutation boundary. Seed a surrogate
# pair, then require Backspace and a selected-range replacement to be cancelled
# and reconstructed from Rust's legal offsets rather than by the browser DOM.
emoji_seed='(() => { const editor = document.querySelector("[aria-label=\"Canvas text content\"]"); if (!editor) throw new Error("Canvas text editor unavailable"); editor.textContent = "A😀中"; editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "A😀中" })); return editor.dataset.rustCaret; })()'
"$pwcli" --session "$session" eval "$emoji_seed" 2>&1 | tee "$evidence_dir/emoji-seed.log"
if ! wait_for_eval "emoji-seed-ready.txt" "$caret_state" '"ready"'; then
  echo "Rust caret layout did not become ready for the Emoji deletion probe." >&2
  exit 1
fi

emoji_backspace='(() => { const editor = document.querySelector("[aria-label=\"Canvas text content\"]"); if (!editor) throw new Error("Canvas text editor unavailable"); const pointAt = (target) => { const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let remaining = target; let node = walker.nextNode(); while (node) { const length = node.textContent.length; if (remaining <= length) return { node, offset: remaining }; remaining -= length; node = walker.nextNode(); } throw new Error("Selection target not found"); }; const afterEmoji = pointAt(3); window.getSelection().setBaseAndExtent(afterEmoji.node, afterEmoji.offset, afterEmoji.node, afterEmoji.offset); const accepted = editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" })); return "rust-backspace-dispatch=" + accepted; })()'
"$pwcli" --session "$session" eval "$emoji_backspace" 2>&1 | tee "$evidence_dir/emoji-backspace.log"
if ! grep -Fq 'rust-backspace-dispatch=false' "$evidence_dir/emoji-backspace.log"; then
  echo "Rust caret Backspace was not accepted at the beforeinput boundary." >&2
  exit 1
fi
if ! wait_for_eval "emoji-backspace-ready.txt" '(() => { const editor = document.querySelector("[aria-label=\"Canvas text content\"]"); return editor ? editor.innerText + "|" + editor.dataset.rustCaret : "missing"; })()' 'A中|ready'; then
  echo "Rust caret Backspace did not remove exactly one complete Emoji." >&2
  exit 1
fi

selection_replacement='(() => { const editor = document.querySelector("[aria-label=\"Canvas text content\"]"); if (!editor) throw new Error("Canvas text editor unavailable"); const pointAt = (target) => { const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let remaining = target; let node = walker.nextNode(); while (node) { const length = node.textContent.length; if (remaining <= length) return { node, offset: remaining }; remaining -= length; node = walker.nextNode(); } throw new Error("Selection target not found"); }; const start = pointAt(1); const end = pointAt(2); window.getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset); const accepted = editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "B" })); return "rust-replacement-dispatch=" + accepted; })()'
"$pwcli" --session "$session" eval "$selection_replacement" 2>&1 | tee "$evidence_dir/selection-replacement.log"
if ! grep -Fq 'rust-replacement-dispatch=false' "$evidence_dir/selection-replacement.log"; then
  echo "Rust caret selected-range replacement was not accepted at beforeinput." >&2
  exit 1
fi
if ! wait_for_eval "selection-replacement-ready.txt" '(() => { const editor = document.querySelector("[aria-label=\"Canvas text content\"]"); return editor ? editor.innerText + "|" + editor.dataset.rustCaret : "missing"; })()' 'AB|ready'; then
  echo "Rust caret selected-range replacement did not preserve legal boundaries." >&2
  exit 1
fi

"$pwcli" --session "$session" console 2>&1 | tee "$evidence_dir/console.txt"
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Text caret evidence emitted browser console errors." >&2
  exit 1
fi
"$pwcli" --session "$session" press Escape 2>&1 | tee "$evidence_dir/cancel.log"
printf '{"status":"pass","scenario":"canvas-text-caret-composition-keyboard-deletion-and-replacement","required":"rust-caret-boundary-for-navigation-and-beforeinput-mutations"}\n' > "$evidence_dir/text-caret-summary.json"
echo "Phase 1 text caret evidence written to $evidence_dir"
