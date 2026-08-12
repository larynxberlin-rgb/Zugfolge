#!/bin/sh
set -eu

if [ "$#" -ne 5 ]; then
  echo "usage: $0 ADMIN_DATABASE_URL TARGET_DATABASE TARGET_FILESTORE BACKUP_PREFIX MANIFEST" >&2
  exit 64
fi

ADMIN_DATABASE_URL=$1
TARGET_DATABASE=$2
TARGET_FILESTORE=$3
PREFIX=$4
MANIFEST=$5
case "$TARGET_DATABASE" in zugfolge_odoo_restore_*) ;; *) echo "unsafe restore database" >&2; exit 65;; esac
test -f "$PREFIX.database.dump"
test -f "$PREFIX.filestore.tar.gz"
test -f "$MANIFEST"
EXPECTED_DB=$(sed -n 's/.*"databaseSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
EXPECTED_FS=$(sed -n 's/.*"filestoreSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
ACTUAL_DB=$(sha256sum "$PREFIX.database.dump" | cut -d ' ' -f 1)
ACTUAL_FS=$(sha256sum "$PREFIX.filestore.tar.gz" | cut -d ' ' -f 1)
test "$EXPECTED_DB" = "$ACTUAL_DB"
test "$EXPECTED_FS" = "$ACTUAL_FS"
if [ -d "$TARGET_FILESTORE" ] && [ -n "$(find "$TARGET_FILESTORE" -mindepth 1 -print -quit)" ]; then
  echo "target filestore is not empty" >&2
  exit 66
fi
dropdb --if-exists --force --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE"
createdb --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE"
TARGET_URL="${ADMIN_DATABASE_URL%/*}/$TARGET_DATABASE"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$TARGET_URL" "$PREFIX.database.dump"
mkdir -p "$TARGET_FILESTORE"
tar --extract --gzip --file="$PREFIX.filestore.tar.gz" --directory="$TARGET_FILESTORE"
