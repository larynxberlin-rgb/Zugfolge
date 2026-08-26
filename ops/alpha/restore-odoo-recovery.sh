#!/bin/sh
set -eu

if [ "$#" -ne 7 ]; then
  echo "usage: $0 ADMIN_DATABASE_URL TARGET_DATABASE TARGET_FILESTORE BACKUP_PREFIX MANIFEST.json RECOVERY_ID RECEIPT.json" >&2
  exit 64
fi

ADMIN_DATABASE_URL=$1
TARGET_DATABASE=$2
TARGET_FILESTORE=$3
PREFIX=$4
MANIFEST=$5
RECOVERY_ID=$6
RECEIPT=$7
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
FILESTORE_ROOT=${PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT-}
EVIDENCE_ROOT=${PRODUCTION_RECOVERY_EVIDENCE_ROOT-}
ODOO_RUNTIME_UID=${PRODUCTION_RECOVERY_ODOO_RUNTIME_UID-}
ODOO_RUNTIME_GID=${PRODUCTION_RECOVERY_ODOO_RUNTIME_GID-}

case "$ADMIN_DATABASE_URL" in
  postgres://*/postgres|postgresql://*/postgres) ;;
  *) echo "admin URL must name the postgres maintenance database without query parameters" >&2; exit 65 ;;
esac
case "$TARGET_DATABASE" in
  zugfolge_odoo_recovery_v1_) echo "recovery database needs a non-empty suffix" >&2; exit 65 ;;
  zugfolge_odoo_recovery_v1_*) ;;
  *) echo "unsafe Odoo recovery database: $TARGET_DATABASE" >&2; exit 65 ;;
esac
case "$TARGET_DATABASE" in *[!a-z0-9_]*) echo "unsafe Odoo recovery database characters" >&2; exit 65 ;; esac
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
  echo "Odoo recovery receipt must be a direct child of the fixed evidence root" >&2
  exit 65
fi
RECEIPT_NAME=$(basename -- "$RECEIPT")
case "$RECEIPT_NAME" in [a-z0-9]*.json) ;; *) echo "unsafe Odoo recovery receipt filename" >&2; exit 65 ;; esac
case "$RECEIPT_NAME" in *[!a-z0-9._-]*) echo "unsafe Odoo recovery receipt filename" >&2; exit 65 ;; esac
if [ -z "$FILESTORE_ROOT" ] || [ ! -d "$FILESTORE_ROOT" ] || [ -L "$FILESTORE_ROOT" ]; then
  echo "PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT must be an existing symlink-free directory" >&2
  exit 65
fi
FILESTORE_ROOT=$(CDPATH= cd -- "$FILESTORE_ROOT" && pwd -P)
case "$FILESTORE_ROOT" in /|.) echo "filestore recovery root is too broad" >&2; exit 65 ;; esac
if [ "$TARGET_FILESTORE" != "$FILESTORE_ROOT/$TARGET_DATABASE" ]; then
  echo "target filestore must be the database-named direct child of the fixed recovery root" >&2
  exit 65
fi
case "$ODOO_RUNTIME_UID" in 0|''|*[!0-9]*) echo "PRODUCTION_RECOVERY_ODOO_RUNTIME_UID must be a non-root numeric uid" >&2; exit 65 ;; esac
case "$ODOO_RUNTIME_GID" in 0|''|*[!0-9]*) echo "PRODUCTION_RECOVERY_ODOO_RUNTIME_GID must be a non-root numeric gid" >&2; exit 65 ;; esac
if [ -e "$TARGET_FILESTORE" ] || [ -L "$TARGET_FILESTORE" ]; then
  echo "Odoo recovery filestore already exists; it will not be overwritten: $TARGET_FILESTORE" >&2
  exit 66
fi
for INPUT in "$PREFIX.database.dump" "$PREFIX.filestore.tar.gz" "$MANIFEST"; do
  if [ ! -f "$INPUT" ] || [ -L "$INPUT" ]; then
    echo "Odoo recovery input is not a regular symlink-free file: $INPUT" >&2
    exit 66
  fi
done
if [ -e "$RECEIPT" ] || [ -L "$RECEIPT" ]; then
  echo "Odoo recovery receipt already exists: $RECEIPT" >&2
  exit 66
fi

grep -Eq '^\{"schema":"zugfolge-odoo-backup/v2","createdAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z","databaseSha256":"[a-f0-9]{64}","filestoreSha256":"[a-f0-9]{64}","authoritativeStateSha256":"[a-f0-9]{64}","filestoreTreeSha256":"[a-f0-9]{64}","rpoSeconds":900\}$' "$MANIFEST" || {
  echo "unsupported Odoo backup manifest" >&2
  exit 67
}
EXPECTED_DB=$(sed -n 's/.*"databaseSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
EXPECTED_FS=$(sed -n 's/.*"filestoreSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
EXPECTED_STATE=$(sed -n 's/.*"authoritativeStateSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
EXPECTED_TREE=$(sed -n 's/.*"filestoreTreeSha256":"\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST")
ACTUAL_DB=$(sha256sum "$PREFIX.database.dump" | cut -d ' ' -f 1)
ACTUAL_FS=$(sha256sum "$PREFIX.filestore.tar.gz" | cut -d ' ' -f 1)
MANIFEST_SHA256=$(sha256sum "$MANIFEST" | cut -d ' ' -f 1)
if [ "$EXPECTED_DB" != "$ACTUAL_DB" ] || [ "$EXPECTED_FS" != "$ACTUAL_FS" ]; then
  echo "Odoo recovery backup bytes do not match their manifest" >&2
  exit 68
fi

LIST=$(mktemp "$FILESTORE_ROOT/.recovery-archive-list.XXXXXX")
VERBOSE_LIST=$(mktemp "$FILESTORE_ROOT/.recovery-archive-types.XXXXXX")
STAGE=$(mktemp -d "$FILESTORE_ROOT/.recovery-stage-$RECOVERY_ID.XXXXXX")
CREATED=0
MOVED=0
TARGET_FILESTORE_CREATED=0
RECEIPT_TEMP=
RECEIPT_PUBLISHED=0
cleanup() {
  rm -f -- "$LIST" "$VERBOSE_LIST"
  if [ -n "$RECEIPT_TEMP" ]; then rm -f -- "$RECEIPT_TEMP"; fi
  if [ "$RECEIPT_PUBLISHED" -eq 1 ]; then rm -f -- "$RECEIPT"; fi
  if [ "$MOVED" -eq 0 ]; then rm -rf -- "$STAGE"; fi
  if [ "$TARGET_FILESTORE_CREATED" -eq 1 ]; then rm -rf -- "$TARGET_FILESTORE"; fi
  if [ "$CREATED" -eq 1 ]; then
    dropdb --if-exists --force --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM
tar --list --gzip --file="$PREFIX.filestore.tar.gz" > "$LIST"
tar --list --verbose --gzip --file="$PREFIX.filestore.tar.gz" > "$VERBOSE_LIST"
while IFS= read -r ENTRY; do
  printf '%s\n' "$ENTRY" | grep -Eq '^(\./?|\./[a-f0-9]{2}/?|\./[a-f0-9]{2}/[a-f0-9]{40})$' || {
    echo "unsafe Odoo filestore archive path: $ENTRY" >&2
    exit 69
  }
done < "$LIST"
while IFS= read -r ENTRY; do
  TYPE=$(printf '%s' "$ENTRY" | cut -c 1)
  case "$TYPE" in -|d) ;; *) echo "Odoo filestore archive contains a non-file/non-directory member" >&2; exit 69 ;; esac
done < "$VERBOSE_LIST"

if [ -n "$(psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "select 1 from pg_database where datname = '$TARGET_DATABASE'")" ]; then
  echo "Odoo recovery target database already exists; it will not be dropped: $TARGET_DATABASE" >&2
  exit 70
fi
createdb --maintenance-db="$ADMIN_DATABASE_URL" "$TARGET_DATABASE"
CREATED=1
TARGET_URL="${ADMIN_DATABASE_URL%/*}/$TARGET_DATABASE"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$TARGET_URL" "$PREFIX.database.dump"
tar --extract --gzip --file="$PREFIX.filestore.tar.gz" --directory="$STAGE" --no-same-owner --no-same-permissions

RESTORED_STATE=$(psql -X -qAt "$TARGET_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/odoo-state-hash.sql" | sha256sum | cut -d ' ' -f 1)
RESTORED_TREE=$(sh "$SCRIPT_DIR/filestore-tree-hash.sh" "$STAGE")
if [ "$EXPECTED_STATE" != "$RESTORED_STATE" ] || [ "$EXPECTED_TREE" != "$RESTORED_TREE" ]; then
  echo "Odoo recovery state or filestore tree differs from the backup manifest" >&2
  exit 71
fi
chown -R "$ODOO_RUNTIME_UID:$ODOO_RUNTIME_GID" -- "$STAGE"
chmod -R a-w -- "$STAGE"
mv -T -- "$STAGE" "$TARGET_FILESTORE"
MOVED=1
TARGET_FILESTORE_CREATED=1
sync -f "$FILESTORE_ROOT"

umask 077
RECEIPT_TEMP=$(mktemp "$EVIDENCE_ROOT/.odoo-recovery-receipt.XXXXXX")
printf '{\n  "authoritativeStateSha256": "%s",\n  "database": "%s",\n  "databaseSha256": "%s",\n  "filestoreArchiveSha256": "%s",\n  "filestoreTreeSha256": "%s",\n  "identical": true,\n  "recoveryId": "%s",\n  "schema": "zugfolge-production-odoo-restore/v1"\n}\n' \
  "$RESTORED_STATE" "$TARGET_DATABASE" "$ACTUAL_DB" "$ACTUAL_FS" "$RESTORED_TREE" "$RECOVERY_ID" > "$RECEIPT_TEMP"
chmod 600 "$RECEIPT_TEMP"
sync -f "$RECEIPT_TEMP"
ln -- "$RECEIPT_TEMP" "$RECEIPT" || {
  echo "could not create-new Odoo recovery receipt: $RECEIPT" >&2
  exit 72
}
RECEIPT_PUBLISHED=1
sync -f "$EVIDENCE_ROOT"
rm -f -- "$RECEIPT_TEMP"
RECEIPT_TEMP=
CREATED=0
TARGET_FILESTORE_CREATED=0
RECEIPT_PUBLISHED=0
trap - EXIT HUP INT TERM
rm -f -- "$LIST" "$VERBOSE_LIST"
cat "$RECEIPT"
