#!/usr/bin/env bash
set -euo pipefail

# Runs the browser-facing W1 recovery matrix against throwaway services. It is
# intentionally self-contained: no developer database, browser profile, or
# previously accepted Document can influence the result.
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
document_port="${MAKEFIGMA_RECOVERY_DOCUMENT_PORT:-8892}"
web_port="${MAKEFIGMA_RECOVERY_WEB_PORT:-3012}"
evidence_dir="${1:-$root_dir/output/playwright/phase1-operation-recovery/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
session="makefigma-phase1-operation-recovery-${RANDOM}${RANDOM}"
temp_dir="$(mktemp -d /tmp/makefigma-operation-recovery.XXXXXX)"
document_pid=""
web_pid=""

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright operation-recovery capture." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi
if lsof -nP -iTCP:"$document_port" -sTCP:LISTEN >/dev/null 2>&1 || lsof -nP -iTCP:"$web_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Recovery evidence ports $document_port or $web_port are already in use." >&2
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
cleanup() {
  "$pwcli" --session "$session" network-state-set online >/dev/null 2>&1 || true
  "$pwcli" --session "$session" close >/dev/null 2>&1 || true
  stop_document_api
  if [[ -n "$web_pid" ]] && kill -0 "$web_pid" 2>/dev/null; then
    kill "$web_pid" || true
    wait "$web_pid" 2>/dev/null || true
  fi
  find "$temp_dir" -depth -delete
}
trap cleanup EXIT

wait_for_http() {
  local url="$1"
  for attempt in $(seq 1 80); do
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
  if ! wait_for_http "http://127.0.0.1:$document_port/health"; then
    cat "$temp_dir/document-api.log" >&2
    return 1
  fi
}
snapshot() { "$pwcli" --session "$session" snapshot 2>&1 | tee "$evidence_dir/$1"; }
wait_for_snapshot() {
  local name="$1"
  local expression="$2"
  for attempt in $(seq 1 80); do
    snapshot "$name"
    if grep -Eq -- "$expression" "$evidence_dir/$name"; then return 0; fi
    sleep 0.2
  done
  return 1
}
draw_rectangle() {
  local label="$1"
  local tool_ref
  snapshot "$label-before.snapshot.txt"
  tool_ref="$(sed -nE 's/.*button "Rectangle \(R\)[^"]*".*\[ref=(e[0-9]+)\].*/\1/p' "$evidence_dir/$label-before.snapshot.txt" | head -n 1)"
  if [[ -z "$tool_ref" ]]; then
    echo "Could not resolve Rectangle toolbar control." >&2
    return 1
  fi
  "$pwcli" --session "$session" click "$tool_ref" 2>&1 | tee "$evidence_dir/$label-select-tool.log"
  # The editor takes pointer capture. Browser-injected PointerEvents are not
  # active pointers, so temporarily make capture a no-op while exercising the
  # same React handlers; normal browser pointer capture is covered by the UI.
  local probe='(() => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas not found"); const previousSet = canvas.setPointerCapture; const previousHas = canvas.hasPointerCapture; const previousRelease = canvas.releasePointerCapture; canvas.setPointerCapture = () => {}; canvas.hasPointerCapture = () => false; canvas.releasePointerCapture = () => {}; try { const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 41, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y })); fire("pointermove", 520, 510); fire("pointerdown", 520, 510); fire("pointermove", 650, 590); fire("pointerup", 650, 590); return "pointer-draw-dispatched"; } finally { canvas.setPointerCapture = previousSet; canvas.hasPointerCapture = previousHas; canvas.releasePointerCapture = previousRelease; } })()'
  "$pwcli" --session "$session" eval "$probe" 2>&1 | tee "$evidence_dir/$label-draw.log"
}

# Build the service binary once, then restart that exact binary over the same
# SQLite file. This turns the stop/restart boundary into a real durable-service
# check rather than a mocked transport error.
(cd "$root_dir" && cargo build -p makefigma-document-api >/dev/null)
start_document_api
MAKEFIGMA_NEXT_DIST_DIR="$temp_dir/.next" \
MAKEFIGMA_DOCUMENT_API_TARGET="http://127.0.0.1:$document_port" \
  "$root_dir/node_modules/.bin/next" dev --port "$web_port" > "$temp_dir/web.log" 2>&1 &
web_pid="$!"
if ! wait_for_http "http://127.0.0.1:$web_port"; then
  cat "$temp_dir/web.log" >&2
  exit 1
fi

# The workspace root is intentionally a catalogue. Enter a stable catalogue
# document so this isolated Document API run can bootstrap its own durable
# record without relying on the main development database.
document_id="c46e30b5-4e63-4ec4-83ba-6b0fa3c9a7df"
"$pwcli" --session "$session" open "http://127.0.0.1:$web_port/workspace/design-lab-2026/design/$document_id" 2>&1 | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 2>&1 | tee "$evidence_dir/resize.log"
if ! wait_for_snapshot "ready.snapshot.txt" "Rust/WASM bridge ready.*remote document (created|loaded|verified)"; then
  echo "Timed out waiting for a connected Document API session." >&2
  exit 1
fi

draw_rectangle "accepted"
if ! wait_for_snapshot "accepted.snapshot.txt" "remote changes saved"; then
  echo "The initially connected operation was not acknowledged." >&2
  exit 1
fi

"$pwcli" --session "$session" network-state-set offline 2>&1 | tee "$evidence_dir/network-offline.log"
draw_rectangle "offline"
if ! wait_for_snapshot "offline.snapshot.txt" "(remote sync retrying|offline · recovery resumes when network returns)"; then
  echo "The offline operation was not retained for retry." >&2
  exit 1
fi

# Keep the browser offline while stopping the service. When it is brought back
# online, its pending envelope must survive both a failed retry and page reload.
stop_document_api
"$pwcli" --session "$session" network-state-set online 2>&1 | tee "$evidence_dir/network-online-service-down.log"
"$pwcli" --session "$session" reload 2>&1 | tee "$evidence_dir/reload-with-service-down.log"
if ! wait_for_snapshot "reloaded-offline.snapshot.txt" "remote (document unavailable|sync retrying)"; then
  echo "The reloaded browser did not retain the unavailable-service state." >&2
  exit 1
fi

start_document_api
if ! wait_for_snapshot "recovered.snapshot.txt" "remote (changes saved|document loaded)"; then
  echo "The pending operation did not recover after Document API restart." >&2
  exit 1
fi

hash_probe='(async () => { const evidence = document.querySelector(`[aria-label="Canonical document hash"]`); if (!evidence) throw new Error("Canonical hash evidence is missing"); const documentId = evidence.dataset.documentId; const browserRevision = evidence.dataset.documentRevision; const browserHash = evidence.dataset.documentHash; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000); try { const response = await fetch(`/document-api/v1/documents/${encodeURIComponent(documentId ?? "")}/snapshot`, { signal: controller.signal, headers: { "x-makefigma-dev-tenant-id": "00000000-0000-0000-0000-000000000002", "x-makefigma-dev-actor-id": "00000000-0000-0000-0000-000000000007" } }); const serverRevision = response.headers.get("x-makefigma-document-revision"); const serverHash = response.headers.get("x-makefigma-document-hash"); const contentLength = Number(response.headers.get("content-length")); return { matches: response.ok && browserRevision === "2" && serverRevision === "2" && browserHash?.toLowerCase() === serverHash?.toLowerCase(), browserRevision, browserHash, serverRevision, serverHash, snapshotBytes: Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : undefined }; } finally { clearTimeout(timer); } })()'
"$pwcli" --session "$session" eval "$hash_probe" 2>&1 | tee "$evidence_dir/hash-comparison.json"
if ! grep -Eq '"matches"[[:space:]]*:[[:space:]]*true' "$evidence_dir/hash-comparison.json"; then
  echo "The recovered browser and service Snapshot did not converge at revision 2." >&2
  exit 1
fi

"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase1-operation-recovery.png" 2>&1 | tee "$evidence_dir/screenshot.log"
"$pwcli" --session "$session" console 2>&1 | tee "$evidence_dir/console.txt"
expected_transport_errors='^\[ERROR\] Failed to load resource: the server responded with a status of (404|500) \((Not Found|Internal Server Error)\) @ http://127\.0\.0\.1:'"$web_port"'/document-api/v1/documents/'"$document_id"'/snapshot:0$'
unexpected_console_errors="$(grep -E '^\[ERROR\]' "$evidence_dir/console.txt" | grep -Ev -- "$expected_transport_errors" || true)"
if [[ -n "$unexpected_console_errors" ]]; then
  printf '%s\n' "$unexpected_console_errors" >&2
  echo "Operation recovery evidence emitted unexpected browser console errors." >&2
  exit 1
fi

printf '{"status":"pass","scenario":"offline-reload-service-restart","required":"opaque-pending-operation-applies-once-and-hash-converges"}\n' > "$evidence_dir/operation-recovery-summary.json"
echo "Phase 1 operation recovery evidence written to $evidence_dir"
