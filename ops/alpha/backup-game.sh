#!/bin/sh
set -eu

if [ "$#" -ne 3 ] && [ "$#" -ne 4 ]; then
  echo "usage: $0 DATABASE_URL OUTPUT.dump MANIFEST.json [OPERATION.json]" >&2
  exit 64
fi

DATABASE_URL=$1
OUTPUT=$2
MANIFEST=$3
OPERATION=${4-}
for TARGET in "$OUTPUT" "$MANIFEST"; do
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    echo "Backup output already exists: $TARGET" >&2
    exit 66
  fi
done
if [ -n "$OPERATION" ]; then
  if [ "${DATABASE_ROLLBACK_WRITERS_QUIESCED:-false}" != true ]; then
    echo "DATABASE_ROLLBACK_WRITERS_QUIESCED must be exactly true for rollback evidence" >&2
    exit 65
  fi
  if [ -e "$OPERATION" ] || [ -L "$OPERATION" ]; then
    echo "Backup operation receipt already exists: $OPERATION" >&2
    exit 66
  fi
  mkdir -p "$(dirname "$OPERATION")"
  BACKUP_STARTED_WAL_LSN=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select pg_current_wal_lsn()::text")
  case "$BACKUP_STARTED_WAL_LSN" in
    ''|*[!A-F0-9/]*) echo "Invalid backup start WAL LSN: $BACKUP_STARTED_WAL_LSN" >&2; exit 67 ;;
  esac
fi
mkdir -p "$(dirname "$OUTPUT")" "$(dirname "$MANIFEST")"
umask 077
DUMP_TEMP=$(mktemp "$(dirname "$OUTPUT")/.zugfolge-game-dump.XXXXXX")
MANIFEST_TEMP=$(mktemp "$(dirname "$MANIFEST")/.zugfolge-game-manifest.XXXXXX")
OPERATION_TEMP=
OUTPUT_PUBLISHED=0
MANIFEST_PUBLISHED=0
OPERATION_PUBLISHED=0
cleanup() {
  rm -f -- "$DUMP_TEMP" "$MANIFEST_TEMP"
  if [ -n "$OPERATION_TEMP" ]; then rm -f -- "$OPERATION_TEMP"; fi
  if [ "$OPERATION_PUBLISHED" -eq 1 ]; then rm -f -- "$OPERATION"; fi
  if [ "$MANIFEST_PUBLISHED" -eq 1 ]; then rm -f -- "$MANIFEST"; fi
  if [ "$OUTPUT_PUBLISHED" -eq 1 ]; then rm -f -- "$OUTPUT"; fi
}
trap cleanup EXIT HUP INT TERM
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$DUMP_TEMP" "$DATABASE_URL"
BYTES=$(wc -c < "$DUMP_TEMP" | tr -d ' ')
SHA256=$(sha256sum "$DUMP_TEMP" | cut -d ' ' -f 1)
MIGRATION_COUNT=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations")
case "$MIGRATION_COUNT" in
  ''|*[!0-9]*) echo "Invalid migration count: $MIGRATION_COUNT" >&2; exit 67 ;;
esac
if [ -n "$OPERATION" ]; then
  BACKUP_COMPLETED_WAL_LSN=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select pg_current_wal_lsn()::text")
  case "$BACKUP_COMPLETED_WAL_LSN" in
    ''|*[!A-F0-9/]*) echo "Invalid backup completion WAL LSN: $BACKUP_COMPLETED_WAL_LSN" >&2; exit 67 ;;
  esac
fi
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"schema":"zugfolge-game-backup/v2","createdAt":"%s","bytes":%s,"sha256":"%s","migrationCount":%s,"rpoSeconds":300}\n' \
  "$CREATED_AT" "$BYTES" "$SHA256" "$MIGRATION_COUNT" > "$MANIFEST_TEMP"
if [ -n "$OPERATION" ]; then
  MANIFEST_SHA256=$(sha256sum "$MANIFEST_TEMP" | cut -d ' ' -f 1)
  BACKUP_ID="pgdump-sha256-$SHA256"
  OPERATION_TEMP=$(mktemp "$(dirname "$OPERATION")/.zugfolge-game-operation.XXXXXX")
  printf '{"backupCompletedWalLsn":"%s","backupId":"%s","backupStartedWalLsn":"%s","completedAt":"%s","dumpSha256":"%s","gameBackupManifestSha256":"%s","schema":"zugfolge-game-backup-operation/v1","writersQuiesced":true}\n' \
    "$BACKUP_COMPLETED_WAL_LSN" "$BACKUP_ID" "$BACKUP_STARTED_WAL_LSN" "$CREATED_AT" "$SHA256" "$MANIFEST_SHA256" > "$OPERATION_TEMP"
fi
sync -f "$DUMP_TEMP"
sync -f "$MANIFEST_TEMP"
if [ -n "$OPERATION_TEMP" ]; then sync -f "$OPERATION_TEMP"; fi
ln -- "$DUMP_TEMP" "$OUTPUT" || { echo "Could not create-new backup dump: $OUTPUT" >&2; exit 70; }
OUTPUT_PUBLISHED=1
ln -- "$MANIFEST_TEMP" "$MANIFEST" || { echo "Could not create-new backup manifest: $MANIFEST" >&2; exit 70; }
MANIFEST_PUBLISHED=1
if [ -n "$OPERATION" ]; then
  ln -- "$OPERATION_TEMP" "$OPERATION" || { echo "Could not create-new backup operation receipt: $OPERATION" >&2; exit 70; }
  OPERATION_PUBLISHED=1
fi
sync -f "$(dirname "$OUTPUT")"
sync -f "$(dirname "$MANIFEST")"
if [ -n "$OPERATION" ]; then sync -f "$(dirname "$OPERATION")"; fi
rm -f -- "$DUMP_TEMP" "$MANIFEST_TEMP"
if [ -n "$OPERATION_TEMP" ]; then rm -f -- "$OPERATION_TEMP"; fi
OUTPUT_PUBLISHED=0
MANIFEST_PUBLISHED=0
OPERATION_PUBLISHED=0
trap - EXIT HUP INT TERM
cat "$MANIFEST"
