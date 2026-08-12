#!/usr/bin/env bash
set -euo pipefail

mkdir -p /mnt/c
mount -t drvfs C: /mnt/c 2>/dev/null || true
pg_ctlcluster 16 main start 2>/dev/null || true
pg_isready -h 127.0.0.1 -p 5432

runuser -u openclaw -- env \
  PATH=/home/openclaw/.cargo/bin:/home/openclaw/.local/node-v24.14.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin \
  CARGO_TARGET_DIR=/tmp/zugfolge-linux-target \
  TEST_DATABASE_URL=postgres://zugfolge_m14_test:zugfolge-m14-local@127.0.0.1:5432/zugfolge_m14_test \
  ZUGFOLGE_RUNTIME_NATIVE_PATH=/tmp/zugfolge-runtime.node \
  ALPHA_WORLD_RELEASE_PATH='/mnt/c/Users/laryn/Zugfolge-Alpha-Evidence/mitteldeutschland-b/2026-08/alpha-world-deployment.json' \
  bash -c 'set -euo pipefail
    cd "/mnt/c/Users/laryn/Projekt Zugfolge"
    cargo build --release -p zugfolge-runtime-napi --features node-addon
    cp /tmp/zugfolge-linux-target/release/libzugfolge_runtime_napi.so /tmp/zugfolge-runtime.node
    node tools/alpha-ops/real-postgres-world-start.mjs'
