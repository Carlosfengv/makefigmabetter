#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3000}"
evidence_dir="${2:-output/phase1-operation-hash/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
session="makefigma-phase1-operation-hash-${RANDOM}${RANDOM}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run the Playwright operation-hash capture." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi

mkdir -p "$evidence_dir"
close_session() { "$pwcli" --session "$session" close >/dev/null 2>&1 || true; }
trap close_session EXIT
snapshot() { "$pwcli" --session "$session" snapshot 2>&1 | tee "$evidence_dir/$1"; }

"$pwcli" --session "$session" open "$base_url" 2>&1 | tee "$evidence_dir/open.log"
"$pwcli" --session "$session" resize 1440 960 2>&1 | tee "$evidence_dir/resize.log"

ready=0
for attempt in $(seq 1 50); do
  snapshot "ready.snapshot.txt"
  if grep -Fq "Rust/WASM bridge ready" "$evidence_dir/ready.snapshot.txt" \
    && grep -Eq -e "remote document (created|loaded|verified)" "$evidence_dir/ready.snapshot.txt"; then
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Timed out waiting for a connected Document API session." >&2
  exit 1
fi

tool_ref="$(sed -nE 's/.*button "Rectangle \(R\)".*\[ref=(e[0-9]+)\].*/\1/p' "$evidence_dir/ready.snapshot.txt" | head -n 1)"
if [[ -z "$tool_ref" ]]; then
  echo "Could not resolve the Rectangle toolbar control from the live snapshot." >&2
  exit 1
fi
"$pwcli" --session "$session" click "$tool_ref" 2>&1 | tee "$evidence_dir/select-rectangle-tool.log"
draw_probe='(() => { const canvas = document.querySelector("canvas.design-canvas"); if (!canvas) throw new Error("Design canvas not found"); const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y })); fire("pointermove", 520, 510); fire("pointerdown", 520, 510); fire("pointermove", 650, 590); fire("pointerup", 650, 590); return "pointer-draw-dispatched"; })()'
"$pwcli" --session "$session" eval "$draw_probe" 2>&1 | tee "$evidence_dir/draw.log"

saved=0
for attempt in $(seq 1 50); do
  snapshot "saved.snapshot.txt"
  if grep -Fq "remote changes saved" "$evidence_dir/saved.snapshot.txt"; then
    saved=1
    break
  fi
  sleep 0.2
done
if [[ "$saved" -ne 1 ]]; then
  echo "Timed out waiting for the accepted operation acknowledgement." >&2
  exit 1
fi

# The DOM only exposes the Worker-computed hash/revision. The corresponding
# service values come from authenticated Snapshot response headers; the bytes
# remain opaque and are never decoded by this evidence runner.
hash_probe='(async () => { const evidence = document.querySelector(`[aria-label="Canonical document hash"]`); if (!evidence) throw new Error("Canonical hash evidence is missing"); const documentId = evidence.dataset.documentId; const browserRevision = evidence.dataset.documentRevision; const browserHash = evidence.dataset.documentHash; if (!documentId || !browserRevision || !/^[a-f0-9]{64}$/i.test(browserHash ?? "")) throw new Error("Browser Core did not publish a complete hash"); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000); try { const response = await fetch(`/document-api/v1/documents/${encodeURIComponent(documentId)}/snapshot`, { headers: { "x-makefigma-dev-tenant-id": "00000000-0000-0000-0000-000000000002", "x-makefigma-dev-actor-id": "00000000-0000-0000-0000-000000000007" }, signal: controller.signal }); const serverRevision = response.headers.get("x-makefigma-document-revision"); const serverHash = response.headers.get("x-makefigma-document-hash"); return { matches: response.ok && serverRevision === browserRevision && serverHash?.toLowerCase() === browserHash.toLowerCase(), documentId, browserRevision, browserHash, serverRevision, serverHash, snapshotBytes: Number(response.headers.get("content-length") ?? 0) }; } finally { clearTimeout(timeout); } })()'
"$pwcli" --session "$session" eval "$hash_probe" 2>&1 | tee "$evidence_dir/hash-comparison.json"
if ! grep -Eq '"matches"[[:space:]]*:[[:space:]]*true' "$evidence_dir/hash-comparison.json"; then
  echo "Browser Core and service Snapshot revision/hash differ." >&2
  exit 1
fi

"$pwcli" --session "$session" screenshot --filename "$evidence_dir/phase1-operation-hash.png" 2>&1 | tee "$evidence_dir/screenshot.log"
"$pwcli" --session "$session" console 2>&1 | tee "$evidence_dir/console.txt"
if ! grep -Fq "Errors: 0" "$evidence_dir/console.txt"; then
  echo "Operation-hash evidence emitted browser console errors." >&2
  exit 1
fi

mkdir -p "$evidence_dir/recovery"
cp "$evidence_dir/hash-comparison.json" "$evidence_dir/recovery/hash-comparison.json"
printf '{"status":"pass","scenario":"accepted-operation-hash","required":"browser-core-and-service-snapshot-match"}\n' > "$evidence_dir/operation-hash-summary.json"
echo "Phase 1 operation hash evidence written to $evidence_dir"
