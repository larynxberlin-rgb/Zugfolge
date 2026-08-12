#!/usr/bin/env bash
set -euo pipefail

mkdir -p /mnt/c
mount -t drvfs C: /mnt/c 2>/dev/null || true
pg_ctlcluster 16 main start 2>/dev/null || true
pg_isready -h 127.0.0.1 -p 5432

readonly source_database=zugfolge_m14_test
readonly restore_database=zugfolge_m14_restore
readonly database_role=zugfolge_m14_test
readonly database_password=zugfolge-m14-local
readonly evidence_root='/mnt/c/Users/laryn/Zugfolge-Alpha-Evidence/mitteldeutschland-b/2026-08'
readonly dump_path="${evidence_root}/zugfolge-m14-postgres.dump"

mkdir -p "${evidence_root}"
PGPASSWORD="${database_password}" pg_dump \
  --host=127.0.0.1 \
  --username="${database_role}" \
  --dbname="${source_database}" \
  --format=custom \
  --exclude-table-data=public.spatial_ref_sys \
  --file="${dump_path}"

if runuser -u postgres -- psql -tAc "select 1 from pg_database where datname = '${restore_database}'" | grep -qx 1; then
  runuser -u postgres -- dropdb --force "${restore_database}"
fi
runuser -u postgres -- createdb --owner="${database_role}" "${restore_database}"
runuser -u postgres -- psql --set ON_ERROR_STOP=1 --dbname="${restore_database}" \
  --command='create extension if not exists postgis;'
PGPASSWORD="${database_password}" pg_restore \
  --host=127.0.0.1 \
  --username="${database_role}" \
  --dbname="${restore_database}" \
  --no-owner \
  --no-comments \
  --exit-on-error \
  "${dump_path}"

sha256sum "${dump_path}"
runuser -u openclaw -- env \
  PATH=/home/openclaw/.local/node-v24.14.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin \
  bash -c 'set -euo pipefail
    cd "/mnt/c/Users/laryn/Projekt Zugfolge"
    node tools/alpha-ops/authoritative-state-hash.mjs \
      postgres://zugfolge_m14_test:zugfolge-m14-local@127.0.0.1:5432/zugfolge_m14_test \
      postgres://zugfolge_m14_test:zugfolge-m14-local@127.0.0.1:5432/zugfolge_m14_restore'
