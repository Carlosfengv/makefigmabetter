#!/usr/bin/env bash
set -euo pipefail

cargo build -p editor-wasm --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/editor_wasm.wasm --out-dir src/wasm/generated --target web --typescript
