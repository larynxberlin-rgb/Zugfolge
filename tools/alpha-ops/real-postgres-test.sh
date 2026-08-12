#!/usr/bin/env bash
set -euo pipefail

mkdir -p /mnt/c
mount -t drvfs C: /mnt/c 2>/dev/null || true
runuser -u openclaw -- env \
  PATH=/home/openclaw/.local/node-v24.14.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin \
  TEST_DATABASE_URL=postgres://zugfolge_m14_test:zugfolge-m14-local@127.0.0.1:5432/zugfolge_m14_test \
  bash -c 'set -euo pipefail
    cd "/mnt/c/Users/laryn/Projekt Zugfolge/packages/db"
    ./node_modules/.bin/vitest run src/postgres.integration.test.ts'
