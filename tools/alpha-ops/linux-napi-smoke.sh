#!/usr/bin/env bash
set -euo pipefail

mkdir -p /mnt/c
mount -t drvfs C: /mnt/c 2>/dev/null || true

runuser -u openclaw -- env \
  PATH=/home/openclaw/.cargo/bin:/home/openclaw/.local/node-v24.14.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin \
  CARGO_TARGET_DIR=/tmp/zugfolge-linux-target \
  bash -c 'set -euo pipefail
    cd "/mnt/c/Users/laryn/Projekt Zugfolge"
    cargo build --release -p zugfolge-runtime-napi --features node-addon
    cp /tmp/zugfolge-linux-target/release/libzugfolge_runtime_napi.so /tmp/zugfolge-runtime.node
    ZUGFOLGE_RUNTIME_NATIVE_PATH=/tmp/zugfolge-runtime.node node packages/runtime-native/smoke/native-smoke.mjs'
