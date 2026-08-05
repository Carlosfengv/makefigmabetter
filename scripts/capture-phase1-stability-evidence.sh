#!/usr/bin/env bash
set -euo pipefail

# This is a candidate-run recorder, never a Phase 1 completion switch. The
# default duration is the required 30 minutes; CI or a developer may lower it
# only for a smoke run by setting MAKEFIGMA_STABILITY_DURATION_SECONDS.
base_url="${1:-http://127.0.0.1:3000}"
evidence_dir="${2:-output/playwright/phase1-stability/$(date -u +%Y%m%dT%H%M%SZ)}"
duration_seconds="${MAKEFIGMA_STABILITY_DURATION_SECONDS:-1800}"
cycle_seconds="${MAKEFIGMA_STABILITY_CYCLE_SECONDS:-15}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
session="makefigma-phase1-stability-${RANDOM}${RANDOM}"
document_restart="${MAKEFIGMA_STABILITY_DOCUMENT_RESTART_COMMAND:-}"
asset_restart="${MAKEFIGMA_STABILITY_ASSET_RESTART_COMMAND:-}"
isolated="${MAKEFIGMA_STABILITY_ISOLATED:-0}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
document_port="${MAKEFIGMA_STABILITY_DOCUMENT_PORT:-8894}"
asset_port="${MAKEFIGMA_STABILITY_ASSET_PORT:-8895}"
web_port="${MAKEFIGMA_STABILITY_WEB_PORT:-3015}"
image_path="${MAKEFIGMA_STABILITY_IMAGE_PATH:-$root_dir/fixtures/golden-images/phase0-basic-card.png}"
temp_dir=""
next_dist_dir=""
document_pid=""
asset_pid=""
web_pid=""

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright stability capture." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi
if ! [[ "$duration_seconds" =~ ^[0-9]+$ ]] || ! [[ "$cycle_seconds" =~ ^[0-9]+$ ]] || [[ "$cycle_seconds" -eq 0 ]]; then
  echo "Stability duration and cycle must be whole seconds." >&2
  exit 1
fi
if [[ "$isolated" != "0" && "$isolated" != "1" ]]; then
  echo "MAKEFIGMA_STABILITY_ISOLATED must be 0 or 1." >&2
  exit 1
fi
if [[ "$isolated" == "1" ]] && { lsof -nP -iTCP:"$document_port" -sTCP:LISTEN >/dev/null 2>&1 || lsof -nP -iTCP:"$asset_port" -sTCP:LISTEN >/dev/null 2>&1 || lsof -nP -iTCP:"$web_port" -sTCP:LISTEN >/dev/null 2>&1; }; then
  echo "Isolated stability ports are already in use." >&2
  exit 1
fi
if [[ ! -f "$image_path" ]]; then
  echo "Stability image fixture is unavailable: $image_path" >&2
  exit 1
fi

mkdir -p "$evidence_dir"
stop_document_api() {
  if [[ -n "$document_pid" ]] && kill -0 "$document_pid" 2>/dev/null; then
    kill "$document_pid" || true
    wait "$document_pid" 2>/dev/null || true
  fi
  document_pid=""
}
stop_asset_api() {
  if [[ -n "$asset_pid" ]] && kill -0 "$asset_pid" 2>/dev/null; then
    kill "$asset_pid" || true
    wait "$asset_pid" 2>/dev/null || true
  fi
  asset_pid=""
}
cleanup() {
  "$pwcli" --session "$session" close >/dev/null 2>&1 || true
  stop_document_api
  stop_asset_api
  if [[ -n "$web_pid" ]] && kill -0 "$web_pid" 2>/dev/null; then
    kill "$web_pid" || true
    wait "$web_pid" 2>/dev/null || true
  fi
  # Next adds generated route-type includes to the configured tsconfig. Remove
  # only this candidate's absolute paths, preserving all project configuration
  # and any user-managed includes.
  if [[ -n "$next_dist_dir" ]] && [[ -f "$root_dir/tsconfig.json" ]]; then
    MAKEFIGMA_STABILITY_NEXT_DIST_DIR="$next_dist_dir" \
    MAKEFIGMA_STABILITY_ROOT_TSCONFIG="$root_dir/tsconfig.json" \
      node -e 'const fs = require("node:fs"); const configPath = process.env.MAKEFIGMA_STABILITY_ROOT_TSCONFIG; const config = JSON.parse(fs.readFileSync(configPath, "utf8")); const prefix = process.env.MAKEFIGMA_STABILITY_NEXT_DIST_DIR; const include = (config.include ?? []).filter((value) => typeof value !== "string" || !value.startsWith(prefix + "/")); fs.writeFileSync(configPath, `${JSON.stringify({ ...config, include }, null, 2)}\n`);'
  fi
  [[ -n "$temp_dir" ]] && find "$temp_dir" -depth -delete
}
trap cleanup EXIT

wait_for_http() {
  local url="$1"
  for attempt in $(seq 1 100); do
    if curl --fail --silent "$url" >/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}
start_document_api() {
  MAKEFIGMA_DOCUMENT_API_ADDRESS="127.0.0.1:$document_port" \
  MAKEFIGMA_DOCUMENT_API_DATABASE="$temp_dir/document-api.sqlite" \
    "$root_dir/target/debug/makefigma-document-api" > "$temp_dir/document-api.log" 2>&1 &
  document_pid="$!"
  wait_for_http "http://127.0.0.1:$document_port/health"
}
start_asset_api() {
  MAKEFIGMA_ASSET_API_ADDRESS="127.0.0.1:$asset_port" \
  MAKEFIGMA_ASSET_API_DATABASE="$temp_dir/asset-api.sqlite" \
  MAKEFIGMA_ASSET_MAINTENANCE_INTERVAL_SECONDS=3600 \
    "$root_dir/target/debug/makefigma-asset-api" > "$temp_dir/asset-api.log" 2>&1 &
  asset_pid="$!"
  wait_for_http "http://127.0.0.1:$asset_port/health"
}

url_for_capture() {
  local separator="?"
  [[ "$base_url" == *"?"* ]] && separator="&"
  printf '%s%sstabilityEvidence=1&simulateGpuLoss=1&simulateWorkerCrash=1&simulateWorkerCrashDelayMs=5000&simulateAssetReadDelayMs=10000' "$base_url" "$separator"
}

capture_ui_state() {
  capture_browser_value "$1" '({ bridgeReady: document.body.textContent?.includes("Rust/WASM bridge ready") ?? false, status: document.querySelector("[role=\"status\"]")?.textContent?.trim() ?? "", pages: [...document.querySelectorAll("[role=\"list\"][aria-label=\"Pages\"] [role=\"listitem\"]")].map((page) => page.textContent?.trim()), imageNotice: document.body.textContent?.match(/Image (?:added|applied as fill)/)?.[0] ?? "" })'
}
run_browser_code() {
  # The wrapper reports some Playwright failures in its prose output while
  # returning zero. Convert those into a shell failure so a candidate cannot
  # silently omit a required interaction.
  local output=""
  local status=0
  output="$("$pwcli" --session "$session" run-code "$1" 2>&1)" || status=$?
  printf '%s\n' "$output"
  if [[ "$status" -ne 0 ]] || rg -q '^(### Error|TimeoutError:)' <<< "$output"; then return 1; fi
}
json_literal() {
  node -p 'JSON.stringify(process.argv[1])' "$1"
}
capture_browser_value() {
  local file="$1"
  local expression="$2"
  local target="$evidence_dir/$file"
  [[ "$target" == /* ]] || target="$root_dir/$target"
  local target_json
  target_json="$(json_literal "$target")"
  run_browser_code "async (page) => { const value = await page.evaluate(() => (${expression})); const downloadPromise = page.waitForEvent('download', { timeout: 15_000 }); await page.evaluate((serialized) => { const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([serialized], { type: 'application/json' })); anchor.download = 'phase1-browser-state.json'; anchor.click(); }, JSON.stringify(value)); const download = await downloadPromise; await download.saveAs(${target_json}); }"
}
wait_for_status() {
  local expected="$1"
  local expected_json
  expected_json="$(json_literal "$expected")"
  # Downloading a UI-state artifact takes materially longer than a transition
  # such as a local File read. Wait in the live page first, then capture one
  # artifact once the asserted state is known to have happened.
  run_browser_code "async (page) => { await page.waitForFunction((expected) => document.querySelector('[role=\"status\"]')?.textContent?.includes(expected), ${expected_json}, { timeout: 15_000 }); }"
}
wait_for_ui_expression() {
  local file="$1"
  local expression="$2"
  for attempt in $(seq 1 40); do
    capture_ui_state "$file"
    if rg -q -- "$expression" "$evidence_dir/$file"; then return 0; fi
    sleep 0.25
  done
  return 1
}
click_button() {
  local label="$1"
  run_browser_code "async (page) => { await page.getByRole('button', { name: $(json_literal "$label"), exact: true }).click(); }"
}
send_key() {
  local key="$1"
  local meta_key="${2:-false}"
  local shift_key="${3:-false}"
  local modifiers=""
  [[ "$meta_key" == true ]] && modifiers="Meta+"
  [[ "$shift_key" == true ]] && modifiers="${modifiers}Shift+"
  run_browser_code "async (page) => { await page.keyboard.press($(json_literal "${modifiers}${key}")); }"
}
read_hash() {
  capture_browser_value "$1" '(() => { const node = document.querySelector("[aria-label=\"Canonical document hash\"]"); return node ? { id: node.dataset.documentId, revision: node.dataset.documentRevision, hash: node.dataset.documentHash } : undefined; })()'
}
read_runtime() {
  capture_browser_value "$1" '({ diagnostics: document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-diagnostics") ?? "", performance: document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-render-performance") ?? "", workerRecoveries: Number(document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-engine-recoveries") ?? 0), longTasks: document.querySelector("[aria-label=\"Main thread responsiveness\"]")?.getAttribute("data-main-thread-long-tasks") ?? "" })'
}
wait_for_worker_recovery() {
  if ! run_browser_code 'async (page) => { await page.waitForFunction(() => Number(document.querySelector("[aria-label=\"Render evidence\"]")?.getAttribute("data-engine-recoveries") ?? 0) >= 1, { timeout: 15_000 }); }'; then
    echo "The controlled Engine Worker crash did not reach a confirmed recovery." >&2
    return 1
  fi
}
install_document_operation_trace() {
  # Optional diagnostic capture for a failing candidate. It observes only the
  # operation envelope's base revision and the service's public status/message;
  # it never changes the request or reconstructs document data.
  local trace='(() => { const entries = []; const readVarint = (bytes, offset) => { let value = 0; let shift = 0; while (offset < bytes.length) { const byte = bytes[offset++]; value += (byte & 127) * 2 ** shift; if (!(byte & 128)) return [value, offset]; shift += 7; } return [undefined, offset]; }; const baseRevision = (body) => { const bytes = new Uint8Array(body); let offset = 0; while (offset < bytes.length) { const [tag, next] = readVarint(bytes, offset); if (tag === undefined) return undefined; offset = next; const field = tag >>> 3; const wire = tag & 7; if (field === 8 && wire === 0) return readVarint(bytes, offset)[0]; if (wire === 0) offset = readVarint(bytes, offset)[1]; else if (wire === 2) { const [length, valueOffset] = readVarint(bytes, offset); offset = valueOffset + (length ?? bytes.length); } else return undefined; } return undefined; }; const safeMessage = (body) => { const bytes = new Uint8Array(body); let offset = 0; while (offset < bytes.length) { const [tag, next] = readVarint(bytes, offset); if (tag === undefined) return undefined; offset = next; const field = tag >>> 3; const wire = tag & 7; if (field === 2 && wire === 2) { const [length, valueOffset] = readVarint(bytes, offset); return new TextDecoder().decode(bytes.slice(valueOffset, valueOffset + (length ?? 0))); } if (wire === 0) offset = readVarint(bytes, offset)[1]; else if (wire === 2) { const [length, valueOffset] = readVarint(bytes, offset); offset = valueOffset + (length ?? bytes.length); } else return undefined; } return undefined; }; const original = window.fetch.bind(window); window.fetch = async (input, init) => { const response = await original(input, init); const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(); if (url.includes("/operations")) { const body = init?.body; const clone = response.clone(); entries.push({ status: response.status, baseRevision: body instanceof ArrayBuffer ? baseRevision(body) : undefined, message: response.ok ? undefined : safeMessage(await clone.arrayBuffer()) }); } return response; }; Object.defineProperty(window, "__makefigmaDocumentOperationTrace", { configurable: true, value: entries }); return "document-operation-trace-installed"; })()'
  run_browser_code "async (page) => { await page.evaluate(() => (${trace})); }" 2>&1 | tee "$evidence_dir/document-operation-trace-install.log"
}
capture_document_operation_trace() {
  capture_browser_value "document-operation-trace.json" 'structuredClone((window).__makefigmaDocumentOperationTrace ?? [])'
}

draw_rectangle() {
  local file="$1"
  local exercise_history="${2:-true}"
  click_button "Rectangle (R)" 2>&1 | tee "$evidence_dir/$file-select.log"
  local probe='(() => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas missing"); const setCapture = canvas.setPointerCapture; const hasCapture = canvas.hasPointerCapture; const releaseCapture = canvas.releasePointerCapture; canvas.setPointerCapture = () => {}; canvas.hasPointerCapture = () => false; canvas.releasePointerCapture = () => {}; try { const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 71, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y })); fire("pointermove", 510, 490); fire("pointerdown", 510, 490); fire("pointermove", 610, 560); fire("pointerup", 610, 560); return "drawn"; } finally { canvas.setPointerCapture = setCapture; canvas.hasPointerCapture = hasCapture; canvas.releasePointerCapture = releaseCapture; } })()'
  run_browser_code "async (page) => { await page.evaluate(() => (${probe})); }" 2>&1 | tee "$evidence_dir/$file-draw.log"
  if [[ "$exercise_history" == "true" ]]; then
    send_key "z" true false 2>&1 | tee "$evidence_dir/$file-undo.log"
    send_key "z" true true 2>&1 | tee "$evidence_dir/$file-redo.log"
    # Core redo intentionally clears selection. Re-select the restored node
    # before the required duplicate/delete branch so the candidate does not
    # issue an empty duplicate command.
    run_browser_code 'async (page) => { await page.mouse.click(560, 525); }' 2>&1 | tee "$evidence_dir/$file-reselect.log"
  fi
}

switch_pages_once() {
  capture_ui_state "pages-before.ui.json"
  click_button "Create page" 2>&1 | tee "$evidence_dir/create-page.log"
  if ! wait_for_ui_expression "pages-after-create.ui.json" '"pages":\[[^]]*"Page 2"'; then
    echo "The new page did not appear in the live page list." >&2
    return 1
  fi
  run_browser_code 'async (page) => { await page.evaluate(() => { const item = [...document.querySelectorAll("[role=\"list\"][aria-label=\"Pages\"] [role=\"listitem\"]")].find((candidate) => candidate.textContent?.trim() === "Page 1"); if (!(item instanceof HTMLElement)) throw new Error("Page 1 list item missing"); item.click(); }); }' 2>&1 | tee "$evidence_dir/switch-to-page-one.log"
}

exercise_text_ime_draft() {
  local probe='(() => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas missing"); const rect = canvas.getBoundingClientRect(); canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: rect.left + rect.width / 2 - 180, clientY: rect.top + rect.height / 2 + 85 })); return "editing"; })()'
  run_browser_code "async (page) => { await page.evaluate(() => (${probe})); }" 2>&1 | tee "$evidence_dir/text-open.log"
  local composing='(() => { const editor = document.querySelector("[aria-label=\"Canvas text content\"]"); if (!editor) throw new Error("Canvas text editor missing"); editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" })); editor.textContent = "Stability 中"; editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "中" })); editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" })); return editor.dataset.rustCaret; })()'
  run_browser_code "async (page) => { await page.evaluate(() => (${composing})); }" 2>&1 | tee "$evidence_dir/text-ime.log"
  send_key "Escape" false false 2>&1 | tee "$evidence_dir/text-cancel.log"
}

wait_for_remote_save() {
  local phase="$1"
  local saved
  if ! run_browser_code 'async (page) => { await page.waitForFunction(() => document.body.textContent?.includes("remote changes saved"), { timeout: 15_000 }); }' 2>&1 | tee "$evidence_dir/$phase-remote-saved.status.log"; then
    echo "The $phase mutation did not reach a confirmed Document API save." >&2
    return 1
  fi
}

open_import_picker() {
  local file="$1"
  capture_ui_state "$file"
  click_button "Import" 2>&1 | tee "$evidence_dir/${file%.ui.json}-open.log"
}

exercise_image_import_and_cancel() {
  open_import_picker "image-import-picker.ui.json"
  "$pwcli" --session "$session" upload "$image_path" 2>&1 | tee "$evidence_dir/image-import-select.log"
  if ! run_browser_code 'async (page) => { await page.waitForFunction(() => /Image (?:added|applied as fill)/.test(document.querySelector("[role=status]")?.textContent ?? ""), { timeout: 15_000 }); }' 2>&1 | tee "$evidence_dir/image-import-status.log"; then
    echo "The selected image was not imported into the live document." >&2
    return 1
  fi
  capture_ui_state "image-imported.ui.json"

  # The dev-only stability query pauses before the same File read that
  # production immediately starts. It is signal-aware, so this exercises the
  # import controller without relying on browser-realm prototype interception.
  printf '%s\n' "query-param signal-aware pre-read delay" > "$evidence_dir/image-cancel-delay.log"
  open_import_picker "image-cancel-picker.ui.json"
  "$pwcli" --session "$session" upload "$image_path" 2>&1 | tee "$evidence_dir/image-cancel-select.log"
  # Wait and click in one browser command. Separate CLI invocations can take
  # long enough for a deliberate pre-read delay to expire between them.
  if ! run_browser_code 'async (page) => { await page.waitForFunction(() => [...document.querySelectorAll("button.quiet-button")].some((candidate) => candidate.textContent?.trim() === "Cancel import"), { timeout: 15_000 }); await page.evaluate(() => { const button = [...document.querySelectorAll("button.quiet-button")].find((candidate) => candidate.textContent?.trim() === "Cancel import"); if (!button) throw new Error("Cancel import control disappeared"); button.click(); }); }' 2>&1 | tee "$evidence_dir/image-cancel-click.log"; then
    echo "The live import did not expose a clickable cancellation control." >&2
    return 1
  fi
  if ! run_browser_code 'async (page) => { await page.waitForFunction(() => document.querySelector("[role=\"status\"]")?.textContent?.includes("Import canceled"), { timeout: 15_000 }); }' 2>&1 | tee "$evidence_dir/image-canceled-status.log"; then
    echo "The image import did not report its abort result." >&2
    return 1
  fi
  capture_ui_state "image-canceled.ui.json"
}

restart_services() {
  local phase="$1"
  if [[ "$isolated" == "1" ]]; then
    printf '%s\n' "stopping" > "$evidence_dir/$phase-service-restart.txt"
    stop_document_api
    stop_asset_api
    printf '%s\n' "starting-document" > "$evidence_dir/$phase-service-restart.txt"
    start_document_api
    printf '%s\n' "starting-asset" > "$evidence_dir/$phase-service-restart.txt"
    start_asset_api
    printf '%s\n' "executed" > "$evidence_dir/$phase-service-restart.txt"
    return
  fi
  if [[ -z "$document_restart" || -z "$asset_restart" ]]; then
    printf '%s\n' "not-configured" > "$evidence_dir/$phase-service-restart.txt"
    return
  fi
  bash -lc "$document_restart" > "$evidence_dir/$phase-document-restart.log" 2>&1
  bash -lc "$asset_restart" > "$evidence_dir/$phase-asset-restart.log" 2>&1
  printf '%s\n' "executed" > "$evidence_dir/$phase-service-restart.txt"
}

if [[ "$isolated" == "1" ]]; then
  # Keep generated Next output outside the repository. A forcibly interrupted
  # candidate must never leave lint-visible Turbopack artifacts in the worktree.
  temp_dir="$(mktemp -d /tmp/makefigma-phase1-stability.XXXXXX)"
  next_dist_dir="$temp_dir/.next"
  (cd "$root_dir" && cargo build -p makefigma-document-api -p makefigma-asset-api >/dev/null)
  start_document_api
  start_asset_api
  MAKEFIGMA_NEXT_DIST_DIR="$next_dist_dir" \
  MAKEFIGMA_DOCUMENT_API_TARGET="http://127.0.0.1:$document_port" \
  MAKEFIGMA_ASSET_API_TARGET="http://127.0.0.1:$asset_port" \
    "$root_dir/node_modules/.bin/next" dev --port "$web_port" > "$temp_dir/web.log" 2>&1 &
  web_pid="$!"
  if ! wait_for_http "http://127.0.0.1:$web_port"; then
    cat "$temp_dir/web.log" >&2
    exit 1
  fi
  base_url="http://127.0.0.1:$web_port"
fi

if [[ "$isolated" == "1" ]]; then
  # The isolated Rust services start from empty databases. Clear this unique
  # browser session too, otherwise an interrupted prior candidate can replay
  # stale IndexedDB operations into a fresh service and manufacture conflicts.
  "$pwcli" --session "$session" delete-data >/dev/null
fi
"$pwcli" --session "$session" open "$(url_for_capture)" 2>&1 | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 2>&1 | tee "$evidence_dir/resize.log"
if [[ "${MAKEFIGMA_STABILITY_TRACE_DOCUMENT_OPERATIONS:-0}" == "1" ]]; then install_document_operation_trace; fi

ready=0
for attempt in $(seq 1 80); do
  capture_ui_state "ready.ui.json"
  if rg -Fq '"bridgeReady":true' "$evidence_dir/ready.ui.json"; then ready=1; break; fi
  sleep 0.25
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for the Rust/WASM bridge." >&2
  exit 1
fi

read_hash "baseline-hash.json"
read_runtime "baseline-runtime.json"
switch_pages_once
wait_for_remote_save "pages"
draw_rectangle "initial"
wait_for_remote_save "initial-draw"
send_key "d" true false 2>&1 | tee "$evidence_dir/initial-duplicate.log"
send_key "Backspace" false false 2>&1 | tee "$evidence_dir/initial-delete.log"
wait_for_remote_save "initial-duplicate-delete"
exercise_text_ime_draft
exercise_image_import_and_cancel
if [[ "${MAKEFIGMA_STABILITY_TRACE_DOCUMENT_OPERATIONS:-0}" == "1" ]]; then capture_document_operation_trace; fi
# The normal import already reaches its user-visible completed state before the
# subsequent canceled import. A cancellation intentionally makes no document
# mutation, so waiting for a later "remote changes saved" status here would
# manufacture a timeout after a successful abort.
printf '%s\n' "remote-save-confirmed" > "$evidence_dir/candidate-lifecycle.txt"

# A zero-duration candidate is a smoke test, but it must still exercise the
# required isolated-service restart instead of falling through with no loop.
if [[ "$duration_seconds" -eq 0 ]] && [[ "$isolated" == "1" ]]; then
  printf '%s\n' "restarting-services" > "$evidence_dir/candidate-lifecycle.txt"
  restart_services "smoke"
  service_restart_state="$(cat "$evidence_dir/smoke-service-restart.txt")"
  "$pwcli" --session "$session" reload 2>&1 | tee "$evidence_dir/smoke-reload.log"
  wait_for_worker_recovery
fi

started_at="$(date +%s)"
deadline="$((started_at + duration_seconds))"
next_restart="$((started_at + duration_seconds / 2))"
cycle=0
service_restart_state="${service_restart_state:-not-configured}"

while [[ "$(date +%s)" -lt "$deadline" ]]; do
  cycle="$((cycle + 1))"
  "$pwcli" --session "$session" mousewheel 0 -- -240 2>&1 | tee "$evidence_dir/cycle-$cycle-zoom-in.log"
  "$pwcli" --session "$session" mousewheel 0 180 2>&1 | tee "$evidence_dir/cycle-$cycle-pan.log"
  draw_rectangle "cycle-$cycle" false
  send_key "d" true false 2>&1 | tee "$evidence_dir/cycle-$cycle-duplicate.log"
  send_key "Backspace" false false 2>&1 | tee "$evidence_dir/cycle-$cycle-delete.log"
  wait_for_remote_save "cycle-$cycle"
  read_runtime "cycle-$cycle-runtime.json"
  capture_ui_state "cycle-$cycle.ui.json"
  if [[ "$(date +%s)" -ge "$next_restart" ]] && [[ "$service_restart_state" == "not-configured" ]]; then
    restart_services "midpoint"
    service_restart_state="$(cat "$evidence_dir/midpoint-service-restart.txt")"
    "$pwcli" --session "$session" reload 2>&1 | tee "$evidence_dir/midpoint-reload.log"
    next_restart="$((deadline + 1))"
  fi
  sleep "$cycle_seconds"
done

read_hash "final-hash.json"
read_runtime "final-runtime.json"
if ! rg -q '"workerRecoveries"[[:space:]]*:[[:space:]]*[1-9]' "$evidence_dir/final-runtime.json"; then
  echo "The controlled Engine Worker crash did not reach a confirmed recovery." >&2
  exit 1
fi
"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase1-stability.png" 2>&1 | tee "$evidence_dir/screenshot.log"
"$pwcli" --session "$session" console 2>&1 | tee "$evidence_dir/console.txt"

expected_bootstrap_error='^\[ERROR\] Failed to load resource: the server responded with a status of 404 \(Not Found\) @ http://127\.0\.0\.1:'"$web_port"'/document-api/v1/documents/00000000-0000-0000-0000-000000000000/snapshot:0$'
unexpected_console_errors="$(rg '^\[ERROR\]' "$evidence_dir/console.txt" | rg -v -- "$expected_bootstrap_error" || true)"
if [[ -n "$unexpected_console_errors" ]]; then
  printf '%s\n' "$unexpected_console_errors" >&2
  echo "Stability capture emitted unexpected browser console errors." >&2
  exit 1
fi
if [[ "$service_restart_state" != "executed" ]]; then
  printf '{"status":"incomplete","reason":"isolated document and asset restart commands were not configured","durationSeconds":%s,"cycles":%s}\n' "$duration_seconds" "$cycle" > "$evidence_dir/stability-summary.json"
  echo "Stability browser loop completed but required isolated service restarts were not configured." >&2
  exit 2
fi
printf '{"status":"local-candidate","durationSeconds":%s,"cycles":%s,"serviceRestart":"executed","requiredIndependentReview":true}\n' "$duration_seconds" "$cycle" > "$evidence_dir/stability-summary.json"
echo "Phase 1 stability candidate evidence written to $evidence_dir"
