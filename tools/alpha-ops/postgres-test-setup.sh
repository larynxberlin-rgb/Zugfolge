#!/usr/bin/env bash
set -euo pipefail

pg_ctlcluster 16 main start 2>/dev/null || true
runuser -u postgres -- psql -v ON_ERROR_STOP=1 <<'SQL'
DO $setup$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zugfolge_m14_test') THEN
    CREATE ROLE zugfolge_m14_test LOGIN PASSWORD 'zugfolge-m14-local';
  END IF;
END
$setup$;
SQL

if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'zugfolge_m14_test'" | grep -qx 1; then
  runuser -u postgres -- createdb -O zugfolge_m14_test zugfolge_m14_test
fi
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d zugfolge_m14_test -c 'CREATE EXTENSION IF NOT EXISTS postgis;'
pg_isready -h 127.0.0.1 -p 5432
