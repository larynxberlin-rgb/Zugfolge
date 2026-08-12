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
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$TARGET_DATABASE" in zugfolge_odoo_restore_*) ;; *) echo "unsafe restore database" >&2; exit 65;; esac
test -f "$PREFIX.database.dump"
test -f "$PREFIX.filestore.tar.gz"
test -f "$MANIFEST"
EXPECTED_DB=$(sed -n 's/.*"databaseSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
EXPECTED_FS=$(sed -n 's/.*"filestoreSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
EXPECTED_STATE=$(sed -n 's/.*"authoritativeStateSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
EXPECTED_TREE=$(sed -n 's/.*"filestoreTreeSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
ACTUAL_DB=$(sha256sum "$PREFIX.database.dump" | cut -d ' ' -f 1)
ACTUAL_FS=$(sha256sum "$PREFIX.filestore.tar.gz" | cut -d ' ' -f 1)
test "$EXPECTED_DB" = "$ACTUAL_DB"
test "$EXPECTED_FS" = "$ACTUAL_FS"
test -n "$EXPECTED_STATE"
test -n "$EXPECTED_TREE"
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
RESTORED_STATE=$(psql -X -qAt "$TARGET_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/odoo-state-hash.sql" | sha256sum | cut -d ' ' -f 1)
RESTORED_TREE=$(sh "$SCRIPT_DIR/filestore-tree-hash.sh" "$TARGET_FILESTORE")
test "$EXPECTED_STATE" = "$RESTORED_STATE"
test "$EXPECTED_TREE" = "$RESTORED_TREE"
printf '{"schema":"zugfolge-odoo-restore/v1","database":"%s","authoritativeStateSha256":"%s","filestoreTreeSha256":"%s","identical":true}\n' "$TARGET_DATABASE" "$RESTORED_STATE" "$RESTORED_TREE"
