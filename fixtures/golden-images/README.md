# Golden image baseline

`F-PHASE0-BASIC-CARD` is the first fixed Phase 0 visual fixture. Use a 1440×960 browser viewport, DPR 1, zoom 100%, and the Canvas 2D backend. `bash scripts/capture-phase0-evidence.sh <URL> <evidence-directory>` opens `?fixture=phase0-basic-card&renderer=canvas2d`, deliberately bypassing the browser's local document and optional WebGPU scene spike, then writes the screenshot, DOM snapshot, console, command logs, and `golden-verification.json` into the supplied directory. It never overwrites a baseline. `node scripts/verify-phase0-golden.mjs <capture.png>` verifies the fixture and a reviewed baseline by SHA-256.

`phase0-basic-card.png` is the reviewed Canvas 2D baseline captured on the documented 1440×960, DPR 1 contract. A capture may not silently replace it: visual changes require a new evidence directory and an explicit acceptance result.
