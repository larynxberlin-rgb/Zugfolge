#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 ADMIN_DATABASE_URL TARGET_DATABASE BACKUP.dump" >&2
  exit 64
fi

ADMIN_DATABASE_URL=$1
TARGET_DATABASE=$2
BACKUP=$3
case "$TARGET_DATABASE" in
  zugfolge_restore_*) ;;
  *) echo "Restore target must start with zugfolge_restore_: $TARGET_DATABASE" >&2; exit 65 ;;
esac

if [ ! -f "$BACKUP" ]; then
  echo "Backup not found: $BACKUP" >&2
  exit 66
fi
dropdb --if-exists --force --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE"
createdb --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE"
TARGET_URL="${ADMIN_DATABASE_URL%/*}/$TARGET_DATABASE"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$TARGET_URL" "$BACKUP"
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations"
