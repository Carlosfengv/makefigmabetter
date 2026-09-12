#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd -P)"
cargo_home="$(cd "$(dirname "$(command -v cargo)")/.." && pwd -P)"

# Rust assertion messages embed source paths in the WASM data section. Remap
# both variable roots so a clean clone produces the same committed bridge.
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${repo_root}=. --remap-path-prefix=${cargo_home}=.cargo" \
  cargo build -p editor-wasm --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/editor_wasm.wasm --out-dir src/wasm/generated --target web --typescript
