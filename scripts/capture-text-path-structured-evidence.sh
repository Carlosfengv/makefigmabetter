#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3010}"
evidence_dir="${2:-output/playwright/text-path-structured/$(date -u +%Y%m%dT%H%M%SZ)}"
pwcli="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
runs="${TEXT_PATH_STRUCTURED_RUNS:-2}"

if ! command -v npx >/dev/null 2>&1; then
  echo "Playwright evidence capture requires Node.js/npm (npx)." >&2
  exit 1
fi
if [[ ! -x "$pwcli" ]]; then
  echo "Playwright CLI is unavailable: $pwcli" >&2
  exit 1
fi
if ! [[ "$runs" =~ ^[1-9][0-9]*$ ]]; then
  echo "TEXT_PATH_STRUCTURED_RUNS must be a positive integer." >&2
  exit 64
fi

mkdir -p "$evidence_dir"
case "$base_url" in
  *"?"*) fixture_url="${base_url}&fixture=remediation-text-path-structured&stabilityEvidence=1&captureFrameHash=1" ;;
  *) fixture_url="${base_url}?fixture=remediation-text-path-structured&stabilityEvidence=1&captureFrameHash=1" ;;
esac

for run in $(seq 1 "$runs"); do
  for renderer in auto canvas2d; do
    session="makefigma-text-path-structured-${renderer}-${run}-${RANDOM}${RANDOM}"
    cleanup() { "$pwcli" --session "$session" close >/dev/null 2>&1 || true; }
    trap cleanup EXIT
    prefix="$evidence_dir/run-${run}-${renderer}"
    "$pwcli" --session "$session" open "${fixture_url}&renderer=${renderer}" >"${prefix}-open.txt" 2>&1
    "$pwcli" --session "$session" resize 1900 1000 >"${prefix}-resize.txt" 2>&1
    probe=$(cat <<'JS'
async page => {
  const evidence = page.locator('[aria-label="Render evidence"]');
  await page.waitForFunction((renderer) => {
    const target = document.querySelector('[aria-label="Render evidence"]');
    const raw = target?.getAttribute('data-render-diagnostics');
    if (!raw) return false;
    const recent = JSON.parse(raw).recent ?? [];
    const codes = recent.map((entry) => entry.code);
    const glyphResources = recent.filter((entry) => entry.code === 'RUST_TEXT_GLYPH_RESOURCE_READY' && entry.details?.entries === 6);
    return glyphResources.length >= 3 && (renderer === 'auto'
      ? codes.includes('WEBGPU_SCENE_READY')
        && codes.includes('GPU_ORDERED_ISLANDS')
        && codes.includes('GPU_CANVAS_ISLAND_FRAME_CLIP')
        && codes.includes('GPU_CANVAS_ISLAND_MASK')
        && codes.includes('GPU_CANVAS_ISLAND_SUBTREE_COMPOSITION')
      : codes.includes('WEBGPU_DISABLED_FOR_CAPTURE'));
  }, RENDERER, { timeout: 15_000 });
  await page.waitForTimeout(250);
  const canvas = page.locator('canvas.design-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Design canvas missing');
  return {
    renderer: RENDERER,
    userAgent: await page.evaluate(() => navigator.userAgent),
    viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })),
    canvas: { width: box.width, height: box.height },
    diagnostics: JSON.parse(await evidence.getAttribute('data-render-diagnostics') ?? '{}'),
    frameHash: JSON.parse(await evidence.getAttribute('data-frame-hash-evidence') ?? 'null'),
  };
}
JS
)
    probe="${probe//RENDERER/\"$renderer\"}"
    "$pwcli" --session "$session" run-code "$probe" >"${prefix}-probe.txt" 2>&1
    screenshot_path="$PWD/${prefix}-canvas.png"
    "$pwcli" --session "$session" run-code "async page => { await page.locator('canvas.design-canvas').screenshot({ path: '$screenshot_path' }); return { saved: true }; }" >"${prefix}-screenshot.txt" 2>&1
    "$pwcli" --session "$session" console >"${prefix}-console.txt" 2>&1
    grep -Fq "Errors: 0" "${prefix}-console.txt"
    grep -Fq "Warnings: 0" "${prefix}-console.txt"
    cleanup
    trap - EXIT
  done
done

TEXT_PATH_STRUCTURED_RUNS="$runs" node scripts/verify-text-path-structured-pixels.mjs "$evidence_dir"
echo "TextPath structured evidence written to $evidence_dir"
