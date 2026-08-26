#!/bin/sh
set -eu

if [ "$#" -ne 4 ] && [ "$#" -ne 5 ]; then
  echo "usage: $0 ODOO_DATABASE_URL FILESTORE_DIRECTORY OUTPUT_DIRECTORY BACKUP_ID [OPERATION.json]" >&2
  exit 64
fi

DATABASE_URL=$1
FILESTORE=$2
OUTPUT=$3
BACKUP_ID=$4
OPERATION=${5-}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
case "$BACKUP_ID" in *[!A-Za-z0-9._-]*|'') echo "unsafe backup id" >&2; exit 65;; esac
if [ ! -d "$FILESTORE" ] || [ -L "$FILESTORE" ]; then
  echo "filestore must be an existing symlink-free directory" >&2
  exit 65
fi
if [ ! -d "$OUTPUT" ] || [ -L "$OUTPUT" ]; then
  echo "backup output must be an existing symlink-free directory" >&2
  exit 65
fi

DATABASE_DUMP="$OUTPUT/$BACKUP_ID.database.dump"
FILESTORE_ARCHIVE="$OUTPUT/$BACKUP_ID.filestore.tar.gz"
MANIFEST="$OUTPUT/$BACKUP_ID.manifest.json"
for TARGET in "$DATABASE_DUMP" "$FILESTORE_ARCHIVE" "$MANIFEST"; do
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    echo "Odoo backup output already exists: $TARGET" >&2
    exit 66
  fi
done
if [ -n "$OPERATION" ]; then
  if [ "${DATABASE_ROLLBACK_WRITERS_QUIESCED:-false}" != true ]; then
    echo "DATABASE_ROLLBACK_WRITERS_QUIESCED must be exactly true for Odoo rollback evidence" >&2
    exit 65
  fi
  if [ -e "$OPERATION" ] || [ -L "$OPERATION" ]; then
    echo "Odoo backup operation receipt already exists: $OPERATION" >&2
    exit 66
  fi
  OPERATION_PARENT=$(CDPATH= cd -- "$(dirname -- "$OPERATION")" 2>/dev/null && pwd -P) || {
    echo "Odoo operation receipt parent must already exist" >&2
    exit 65
  }
  OUTPUT_ROOT=$(CDPATH= cd -- "$OUTPUT" && pwd -P)
  if [ "$OPERATION_PARENT" != "$OUTPUT_ROOT" ]; then
    echo "Odoo operation receipt must be a direct child of the fixed backup output" >&2
    exit 65
  fi
fi

umask 077
DATABASE_TEMP=$(mktemp "$OUTPUT/.zugfolge-odoo-database.XXXXXX")
FILESTORE_TEMP=$(mktemp "$OUTPUT/.zugfolge-odoo-filestore.XXXXXX")
MANIFEST_TEMP=$(mktemp "$OUTPUT/.zugfolge-odoo-manifest.XXXXXX")
OPERATION_TEMP=
DATABASE_PUBLISHED=0
FILESTORE_PUBLISHED=0
MANIFEST_PUBLISHED=0
OPERATION_PUBLISHED=0
cleanup() {
  rm -f -- "$DATABASE_TEMP" "$FILESTORE_TEMP" "$MANIFEST_TEMP"
  if [ -n "$OPERATION_TEMP" ]; then rm -f -- "$OPERATION_TEMP"; fi
  if [ "$OPERATION_PUBLISHED" -eq 1 ]; then rm -f -- "$OPERATION"; fi
  if [ "$MANIFEST_PUBLISHED" -eq 1 ]; then rm -f -- "$MANIFEST"; fi
  if [ "$FILESTORE_PUBLISHED" -eq 1 ]; then rm -f -- "$FILESTORE_ARCHIVE"; fi
  if [ "$DATABASE_PUBLISHED" -eq 1 ]; then rm -f -- "$DATABASE_DUMP"; fi
}
trap cleanup EXIT HUP INT TERM

if [ -n "$OPERATION" ]; then
  BACKUP_STARTED_WAL_LSN=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "select pg_current_wal_lsn()::text")
  case "$BACKUP_STARTED_WAL_LSN" in
    ''|*[!A-F0-9/]*) echo "Invalid Odoo backup start WAL LSN: $BACKUP_STARTED_WAL_LSN" >&2; exit 67 ;;
  esac
  STATE_BEFORE=$(psql -X -qAt "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/odoo-state-hash.sql" | sha256sum | cut -d ' ' -f 1)
  TREE_BEFORE=$(sh "$SCRIPT_DIR/filestore-tree-hash.sh" "$FILESTORE")
fi

pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$DATABASE_TEMP" "$DATABASE_URL"
tar --create --gzip --file="$FILESTORE_TEMP" --directory="$FILESTORE" .
DB_SHA=$(sha256sum "$DATABASE_TEMP" | cut -d ' ' -f 1)
FS_SHA=$(sha256sum "$FILESTORE_TEMP" | cut -d ' ' -f 1)
STATE_SHA=$(psql -X -qAt "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/odoo-state-hash.sql" | sha256sum | cut -d ' ' -f 1)
TREE_SHA=$(sh "$SCRIPT_DIR/filestore-tree-hash.sh" "$FILESTORE")
if [ -n "$OPERATION" ]; then
  BACKUP_COMPLETED_WAL_LSN=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "select pg_current_wal_lsn()::text")
  case "$BACKUP_COMPLETED_WAL_LSN" in
    ''|*[!A-F0-9/]*) echo "Invalid Odoo backup completion WAL LSN: $BACKUP_COMPLETED_WAL_LSN" >&2; exit 67 ;;
  esac
  if [ "$STATE_BEFORE" != "$STATE_SHA" ] || [ "$TREE_BEFORE" != "$TREE_SHA" ]; then
    echo "Odoo database or filestore changed during the quiesced backup" >&2
    exit 68
  fi
fi

CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"schema":"zugfolge-odoo-backup/v2","createdAt":"%s","databaseSha256":"%s","filestoreSha256":"%s","authoritativeStateSha256":"%s","filestoreTreeSha256":"%s","rpoSeconds":900}\n' \
  "$CREATED_AT" "$DB_SHA" "$FS_SHA" "$STATE_SHA" "$TREE_SHA" > "$MANIFEST_TEMP"
if [ -n "$OPERATION" ]; then
  MANIFEST_SHA=$(sha256sum "$MANIFEST_TEMP" | cut -d ' ' -f 1)
  OPERATION_TEMP=$(mktemp "$OUTPUT/.zugfolge-odoo-operation.XXXXXX")
  printf '{"backupCompletedWalLsn":"%s","backupId":"odoo-pgdump-sha256-%s","backupStartedWalLsn":"%s","completedAt":"%s","databaseSha256":"%s","filestoreSha256":"%s","manifestSha256":"%s","schema":"zugfolge-odoo-backup-operation/v1","stateSha256":"%s","treeSha256":"%s","writersQuiesced":true}\n' \
    "$BACKUP_COMPLETED_WAL_LSN" "$DB_SHA" "$BACKUP_STARTED_WAL_LSN" "$CREATED_AT" "$DB_SHA" "$FS_SHA" "$MANIFEST_SHA" "$STATE_SHA" "$TREE_SHA" > "$OPERATION_TEMP"
fi

sync -f "$DATABASE_TEMP"
sync -f "$FILESTORE_TEMP"
sync -f "$MANIFEST_TEMP"
if [ -n "$OPERATION_TEMP" ]; then sync -f "$OPERATION_TEMP"; fi
ln -- "$DATABASE_TEMP" "$DATABASE_DUMP" || { echo "Could not create-new Odoo database dump: $DATABASE_DUMP" >&2; exit 70; }
DATABASE_PUBLISHED=1
ln -- "$FILESTORE_TEMP" "$FILESTORE_ARCHIVE" || { echo "Could not create-new Odoo filestore archive: $FILESTORE_ARCHIVE" >&2; exit 70; }
FILESTORE_PUBLISHED=1
ln -- "$MANIFEST_TEMP" "$MANIFEST" || { echo "Could not create-new Odoo backup manifest: $MANIFEST" >&2; exit 70; }
MANIFEST_PUBLISHED=1
if [ -n "$OPERATION" ]; then
  ln -- "$OPERATION_TEMP" "$OPERATION" || { echo "Could not create-new Odoo backup operation receipt: $OPERATION" >&2; exit 70; }
  OPERATION_PUBLISHED=1
fi
sync -f "$OUTPUT"

rm -f -- "$DATABASE_TEMP" "$FILESTORE_TEMP" "$MANIFEST_TEMP"
if [ -n "$OPERATION_TEMP" ]; then rm -f -- "$OPERATION_TEMP"; fi
DATABASE_PUBLISHED=0
FILESTORE_PUBLISHED=0
MANIFEST_PUBLISHED=0
OPERATION_PUBLISHED=0
trap - EXIT HUP INT TERM
cat "$MANIFEST"
