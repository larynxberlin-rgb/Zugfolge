#!/usr/bin/env bash
set -euo pipefail

pg_ctlcluster 16 main start 2>/dev/null || true
readonly database_name=zugfolge_m14_test
readonly database_role=zugfolge_m14_test
if runuser -u postgres -- psql -tAc "select 1 from pg_database where datname = '${database_name}'" | grep -qx 1; then
  runuser -u postgres -- dropdb --force "${database_name}"
fi
runuser -u postgres -- createdb --owner="${database_role}" "${database_name}"
runuser -u postgres -- psql --set ON_ERROR_STOP=1 --dbname="${database_name}" \
  --command='create extension if not exists postgis;'
pg_isready -h 127.0.0.1 -p 5432
