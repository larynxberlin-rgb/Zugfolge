#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: $0 ODOO_DATABASE_URL FILESTORE_DIRECTORY OUTPUT_DIRECTORY BACKUP_ID" >&2
  exit 64
fi

DATABASE_URL=$1
FILESTORE=$2
OUTPUT=$3
BACKUP_ID=$4
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$BACKUP_ID" in *[!A-Za-z0-9._-]*|'') echo "unsafe backup id" >&2; exit 65;; esac
test -d "$FILESTORE"
mkdir -p "$OUTPUT"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$OUTPUT/$BACKUP_ID.database.dump" "$DATABASE_URL"
tar --create --gzip --file="$OUTPUT/$BACKUP_ID.filestore.tar.gz" --directory="$FILESTORE" .
DB_SHA=$(sha256sum "$OUTPUT/$BACKUP_ID.database.dump" | cut -d ' ' -f 1)
FS_SHA=$(sha256sum "$OUTPUT/$BACKUP_ID.filestore.tar.gz" | cut -d ' ' -f 1)
STATE_SHA=$(psql -X -qAt "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/odoo-state-hash.sql" | sha256sum | cut -d ' ' -f 1)
TREE_SHA=$(sh "$SCRIPT_DIR/filestore-tree-hash.sh" "$FILESTORE")
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"schema":"zugfolge-odoo-backup/v2","createdAt":"%s","databaseSha256":"%s","filestoreSha256":"%s","authoritativeStateSha256":"%s","filestoreTreeSha256":"%s","rpoSeconds":900}\n' "$CREATED_AT" "$DB_SHA" "$FS_SHA" "$STATE_SHA" "$TREE_SHA" > "$OUTPUT/$BACKUP_ID.manifest.json"
