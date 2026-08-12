#!/bin/sh
set -eu

if [ "$#" -ne 5 ]; then
  echo "usage: $0 SOURCE_DATABASE_URL RESTORE_DATABASE_URL SOURCE_FILESTORE RESTORE_FILESTORE SAMPLE_SIZE" >&2
  exit 64
fi

SOURCE_DATABASE_URL=$1
RESTORE_DATABASE_URL=$2
SOURCE_FILESTORE=$3
RESTORE_FILESTORE=$4
SAMPLE_SIZE=$5
case "$SAMPLE_SIZE" in *[!0-9]*|'') echo "unsafe sample size" >&2; exit 65;; esac
test "$SAMPLE_SIZE" -gt 0

SAMPLE=$(mktemp)
trap 'rm -f "$SAMPLE"' EXIT HUP INT TERM
psql -X -qAt "$SOURCE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "select store_fname from ir_attachment where res_model like 'zugfolge.%' and store_fname is not null order by id limit $SAMPLE_SIZE" > "$SAMPLE"

COUNT=0
while IFS= read -r STORE_FNAME; do
  case "$STORE_FNAME" in ''|/*|*..*) echo "unsafe attachment path" >&2; exit 66;; esac
  test -f "$SOURCE_FILESTORE/$STORE_FNAME"
  test -f "$RESTORE_FILESTORE/$STORE_FNAME"
  SOURCE_SHA=$(sha256sum "$SOURCE_FILESTORE/$STORE_FNAME" | cut -d ' ' -f 1)
  RESTORE_SHA=$(sha256sum "$RESTORE_FILESTORE/$STORE_FNAME" | cut -d ' ' -f 1)
  test "$SOURCE_SHA" = "$RESTORE_SHA"
  COUNT=$((COUNT + 1))
done < "$SAMPLE"

if [ "$COUNT" -eq 0 ]; then
  echo "no Zugfolge attachment available for the mandatory restore sample" >&2
  exit 67
fi
printf '{"schema":"zugfolge-odoo-attachment-sample/v1","sampled":%s,"identical":true}\n' "$COUNT"
