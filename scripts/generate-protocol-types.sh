#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="$root_dir/packages/protocol-types/src"

rm -rf "$output_dir/editor"
protoc \
  --plugin="protoc-gen-ts_proto=$root_dir/node_modules/.bin/protoc-gen-ts_proto" \
  --proto_path="$root_dir/schemas/proto" \
  --ts_proto_out="$output_dir" \
  --ts_proto_opt="env=both,esModuleInterop=true,forceLong=string,useOptionals=messages,outputEncodeMethods=true,outputJsonMethods=false,outputClientImpl=false" \
  "$root_dir/schemas/proto/editor/v1/editor.proto"
