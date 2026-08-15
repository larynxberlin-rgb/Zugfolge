#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: $0 ADMIN_DATABASE_URL TARGET_DATABASE BACKUP.dump MANIFEST.json" >&2
  exit 64
fi

ADMIN_DATABASE_URL=$1
TARGET_DATABASE=$2
BACKUP=$3
MANIFEST=$4
case "$TARGET_DATABASE" in
  zugfolge_restore_*) ;;
  *) echo "Restore target must start with zugfolge_restore_: $TARGET_DATABASE" >&2; exit 65 ;;
esac

if [ ! -f "$BACKUP" ]; then
  echo "Backup not found: $BACKUP" >&2
  exit 66
fi
if [ ! -f "$MANIFEST" ]; then
  echo "Backup manifest not found: $MANIFEST" >&2
  exit 66
fi

grep -Eq '^\{"schema":"zugfolge-game-backup/v2","createdAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z","bytes":[0-9]+,"sha256":"[a-f0-9]{64}","migrationCount":[0-9]+,"rpoSeconds":300\}$' "$MANIFEST" || {
  echo "Unsupported game backup manifest" >&2
  exit 67
}
EXPECTED_BYTES=$(sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p' "$MANIFEST")
EXPECTED_SHA256=$(sed -n 's/.*"sha256":"\([a-f0-9][a-f0-9]*\)".*/\1/p' "$MANIFEST")
EXPECTED_MIGRATIONS=$(sed -n 's/.*"migrationCount":\([0-9][0-9]*\).*/\1/p' "$MANIFEST")
case "$EXPECTED_BYTES:$EXPECTED_SHA256:$EXPECTED_MIGRATIONS" in
  *[!0-9a-f:]*) echo "Malformed game backup manifest" >&2; exit 67 ;;
esac
test -n "$EXPECTED_BYTES" && test ${#EXPECTED_SHA256} -eq 64 && test -n "$EXPECTED_MIGRATIONS" || {
  echo "Incomplete game backup manifest" >&2
  exit 67
}
ACTUAL_BYTES=$(wc -c < "$BACKUP" | tr -d ' ')
ACTUAL_SHA256=$(sha256sum "$BACKUP" | cut -d ' ' -f 1)
test "$ACTUAL_BYTES" = "$EXPECTED_BYTES" && test "$ACTUAL_SHA256" = "$EXPECTED_SHA256" || {
  echo "Game backup does not match its manifest" >&2
  exit 68
}

dropdb --if-exists --force --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE"
createdb --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE"
TARGET_URL="${ADMIN_DATABASE_URL%/*}/$TARGET_DATABASE"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$TARGET_URL" "$BACKUP"
ACTUAL_MIGRATIONS=$(psql "$TARGET_URL" -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations")
test "$ACTUAL_MIGRATIONS" = "$EXPECTED_MIGRATIONS" || {
  echo "Restored migration count $ACTUAL_MIGRATIONS does not match backup $EXPECTED_MIGRATIONS" >&2
  exit 69
}
printf '{"schema":"zugfolge-game-restore/v1","database":"%s","migrationCount":%s,"identical":true}\n' \
  "$TARGET_DATABASE" "$ACTUAL_MIGRATIONS"
