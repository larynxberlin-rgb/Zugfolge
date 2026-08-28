#!/bin/sh
set -eu

if [ "$#" -ne 6 ]; then
  echo "usage: $0 ADMIN_DATABASE_URL TARGET_DATABASE BACKUP.dump MANIFEST.json RECOVERY_ID RECEIPT.json" >&2
  exit 64
fi

ADMIN_DATABASE_URL=$1
TARGET_DATABASE=$2
BACKUP=$3
MANIFEST=$4
RECOVERY_ID=$5
RECEIPT=$6
EVIDENCE_ROOT=${PRODUCTION_RECOVERY_EVIDENCE_ROOT-}

case "$ADMIN_DATABASE_URL" in
  postgres://*/postgres|postgresql://*/postgres) ;;
  *) echo "admin URL must name the postgres maintenance database without query parameters" >&2; exit 65 ;;
esac
case "$TARGET_DATABASE" in
  zugfolge_recovery_v1_) echo "recovery database needs a non-empty suffix" >&2; exit 65 ;;
  zugfolge_recovery_v1_*) ;;
  *) echo "unsafe recovery database: $TARGET_DATABASE" >&2; exit 65 ;;
esac
case "$TARGET_DATABASE" in *[!a-z0-9_]*) echo "unsafe recovery database characters" >&2; exit 65 ;; esac
case "$RECOVERY_ID" in ''|*[!a-z0-9._-]*) echo "unsafe recovery id" >&2; exit 65 ;; esac
if [ -z "$EVIDENCE_ROOT" ] || [ ! -d "$EVIDENCE_ROOT" ] || [ -L "$EVIDENCE_ROOT" ]; then
  echo "PRODUCTION_RECOVERY_EVIDENCE_ROOT must be an existing symlink-free directory" >&2
  exit 65
fi
EVIDENCE_ROOT=$(CDPATH= cd -- "$EVIDENCE_ROOT" && pwd -P)
case "$EVIDENCE_ROOT" in /|.) echo "recovery evidence root is too broad" >&2; exit 65 ;; esac
RECEIPT_PARENT=$(CDPATH= cd -- "$(dirname -- "$RECEIPT")" 2>/dev/null && pwd -P) || {
  echo "recovery receipt parent must already exist" >&2
  exit 65
}
if [ "$RECEIPT_PARENT" != "$EVIDENCE_ROOT" ]; then
  echo "recovery receipt must be a direct child of the fixed evidence root" >&2
  exit 65
fi
RECEIPT_NAME=$(basename -- "$RECEIPT")
case "$RECEIPT_NAME" in [a-z0-9]*.json) ;; *) echo "unsafe recovery receipt filename" >&2; exit 65 ;; esac
case "$RECEIPT_NAME" in *[!a-z0-9._-]*) echo "unsafe recovery receipt filename" >&2; exit 65 ;; esac

for INPUT in "$BACKUP" "$MANIFEST"; do
  if [ ! -f "$INPUT" ] || [ -L "$INPUT" ]; then
    echo "recovery input is not a regular symlink-free file: $INPUT" >&2
    exit 66
  fi
done
if [ -e "$RECEIPT" ] || [ -L "$RECEIPT" ]; then
  echo "recovery receipt already exists: $RECEIPT" >&2
  exit 66
fi

grep -Eq '^\{"schema":"zugfolge-game-backup/v2","createdAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z","bytes":[0-9]+,"sha256":"[a-f0-9]{64}","migrationCount":[0-9]+,"rpoSeconds":300\}$' "$MANIFEST" || {
  echo "unsupported game backup manifest" >&2
  exit 67
}
EXPECTED_BYTES=$(sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p' "$MANIFEST")
EXPECTED_SHA256=$(sed -n 's/.*"sha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
EXPECTED_MIGRATIONS=$(sed -n 's/.*"migrationCount":\([0-9][0-9]*\).*/\1/p' "$MANIFEST")
ACTUAL_BYTES=$(wc -c < "$BACKUP" | tr -d ' ')
ACTUAL_SHA256=$(sha256sum "$BACKUP" | cut -d ' ' -f 1)
MANIFEST_SHA256=$(sha256sum "$MANIFEST" | cut -d ' ' -f 1)
if [ "$ACTUAL_BYTES" != "$EXPECTED_BYTES" ] || [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "game recovery dump does not match its manifest" >&2
  exit 68
fi

if [ -n "$(psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "select 1 from pg_database where datname = '$TARGET_DATABASE'")" ]; then
  echo "game recovery target database already exists; it will not be dropped: $TARGET_DATABASE" >&2
  exit 69
fi

CREATED=0
RECEIPT_TEMP=
RECEIPT_PUBLISHED=0
cleanup() {
  if [ -n "$RECEIPT_TEMP" ]; then rm -f -- "$RECEIPT_TEMP"; fi
  if [ "$RECEIPT_PUBLISHED" -eq 1 ]; then rm -f -- "$RECEIPT"; fi
  if [ "$CREATED" -eq 1 ]; then
    dropdb --if-exists --force --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM
createdb --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE"
CREATED=1
TARGET_URL="${ADMIN_DATABASE_URL%/*}/$TARGET_DATABASE"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$TARGET_URL" "$BACKUP"
ACTUAL_MIGRATIONS=$(psql "$TARGET_URL" -X -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations")
if [ "$ACTUAL_MIGRATIONS" != "$EXPECTED_MIGRATIONS" ]; then
  echo "restored migration count $ACTUAL_MIGRATIONS does not match backup $EXPECTED_MIGRATIONS" >&2
  exit 70
fi

umask 077
RECEIPT_TEMP=$(mktemp "$EVIDENCE_ROOT/.game-recovery-receipt.XXXXXX")
printf '{\n  "database": "%s",\n  "dumpSha256": "%s",\n  "identical": true,\n  "manifestSha256": "%s",\n  "migrationCount": %s,\n  "recoveryId": "%s",\n  "schema": "zugfolge-production-game-restore/v1"\n}\n' \
  "$TARGET_DATABASE" "$ACTUAL_SHA256" "$MANIFEST_SHA256" "$ACTUAL_MIGRATIONS" "$RECOVERY_ID" > "$RECEIPT_TEMP"
chmod 600 "$RECEIPT_TEMP"
sync -f "$RECEIPT_TEMP"
ln -- "$RECEIPT_TEMP" "$RECEIPT" || {
  echo "could not create-new game recovery receipt: $RECEIPT" >&2
  exit 71
}
RECEIPT_PUBLISHED=1
sync -f "$EVIDENCE_ROOT"
rm -f -- "$RECEIPT_TEMP"
RECEIPT_TEMP=
CREATED=0
RECEIPT_PUBLISHED=0
trap - EXIT HUP INT TERM
cat "$RECEIPT"
