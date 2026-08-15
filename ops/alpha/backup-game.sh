#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 DATABASE_URL OUTPUT.dump MANIFEST.json" >&2
  exit 64
fi

DATABASE_URL=$1
OUTPUT=$2
MANIFEST=$3
mkdir -p "$(dirname "$OUTPUT")" "$(dirname "$MANIFEST")"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$OUTPUT" "$DATABASE_URL"
BYTES=$(wc -c < "$OUTPUT" | tr -d ' ')
SHA256=$(sha256sum "$OUTPUT" | cut -d ' ' -f 1)
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MIGRATION_COUNT=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations")
case "$MIGRATION_COUNT" in
  ''|*[!0-9]*) echo "Invalid migration count: $MIGRATION_COUNT" >&2; exit 67 ;;
esac
printf '{"schema":"zugfolge-game-backup/v2","createdAt":"%s","bytes":%s,"sha256":"%s","migrationCount":%s,"rpoSeconds":300}\n' \
  "$CREATED_AT" "$BYTES" "$SHA256" "$MIGRATION_COUNT" > "$MANIFEST"
cat "$MANIFEST"
