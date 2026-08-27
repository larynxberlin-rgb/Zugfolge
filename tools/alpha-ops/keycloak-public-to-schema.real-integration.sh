#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 DATABASE_URL EVIDENCE_DIRECTORY" >&2
  exit 64
fi

database_url=$1
evidence_root=$2
mapfile -t database_parts < <(node -e '
  const url = new URL(process.argv[1]);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) process.exit(64);
  for (const value of [url.hostname, url.port || "5432", decodeURIComponent(url.pathname.slice(1)), decodeURIComponent(url.username), decodeURIComponent(url.password)]) console.log(value);
' "$database_url")
if [[ ${#database_parts[@]} -ne 5 ]] || [[ -z ${database_parts[0]} || -z ${database_parts[2]} || -z ${database_parts[3]} ]]; then
  echo "DATABASE_URL must contain host, database, and username" >&2
  exit 64
fi
database_host=${database_parts[0]}
database_port=${database_parts[1]}
database_name=${database_parts[2]}
database_username=${database_parts[3]}
database_password=${database_parts[4]}
admin_database_url=$(node -e 'const url=new URL(process.argv[1]);url.pathname="/postgres";process.stdout.write(url.href);' "$database_url")
container_name=zugfolge-keycloak-schema-integration
keycloak_image='quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13'
keycloak_url='http://127.0.0.1:18080'
admin_username='schema-migration-admin'
admin_password='schema-migration-admin-password'
test_realm='schema-migration-test'
test_client='schema-migration-client'
test_username='schema-migration-player'
test_password='schema-migration-player-password'
migration_script='tools/alpha-ops/keycloak-public-to-schema.mjs'
catalog_path='ops/alpha/keycloak/keycloak-pg16-object-catalog.26.7.0.json'

mkdir -p "$evidence_root/up" "$evidence_root/down"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
  for restore_database in zugfolge_restore_keycloak_up zugfolge_restore_keycloak_down; do
    dropdb --if-exists --force --maintenance-db="$admin_database_url" "$restore_database" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

wait_for_keycloak() {
  for _ in $(seq 1 180); do
    if curl --fail --silent --show-error \
      --data-urlencode 'client_id=admin-cli' \
      --data-urlencode "username=$admin_username" \
      --data-urlencode "password=$admin_password" \
      --data-urlencode 'grant_type=password' \
      "$keycloak_url/realms/master/protocol/openid-connect/token" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container_name" >&2 || true
  echo "Keycloak did not become ready" >&2
  return 1
}

start_keycloak() {
  local schema=$1
  cleanup
  docker run --detach --name "$container_name" --network host \
    -e KC_BOOTSTRAP_ADMIN_USERNAME="$admin_username" \
    -e KC_BOOTSTRAP_ADMIN_PASSWORD="$admin_password" \
    -e KC_DB=postgres \
    -e KC_DB_URL="jdbc:postgresql://$database_host:$database_port/$database_name" \
    -e KC_DB_USERNAME="$database_username" \
    -e KC_DB_PASSWORD="$database_password" \
    -e KC_DB_SCHEMA="$schema" \
    "$keycloak_image" \
    start-dev --http-port=18080 --health-enabled=true >/dev/null
  wait_for_keycloak
}

stop_keycloak() {
  docker stop --time 30 "$container_name" >/dev/null
  docker rm "$container_name" >/dev/null
}

admin_token() {
  curl --fail --silent --show-error \
    --data-urlencode 'client_id=admin-cli' \
    --data-urlencode "username=$admin_username" \
    --data-urlencode "password=$admin_password" \
    --data-urlencode 'grant_type=password' \
    "$keycloak_url/realms/master/protocol/openid-connect/token" \
    | node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.parse(value).access_token));'
}

issue_player_token() {
  curl --silent --show-error \
    --data-urlencode "client_id=$test_client" \
    --data-urlencode "username=$test_username" \
    --data-urlencode "password=$test_password" \
    --data-urlencode 'grant_type=password' \
    "$keycloak_url/realms/$test_realm/protocol/openid-connect/token" \
    | node -e '
      let body = "";
      process.stdin.on("data", chunk => body += chunk);
      process.stdin.on("end", () => {
        const response = JSON.parse(body);
        if (typeof response.access_token === "string" && response.access_token.length > 0) {
          process.stdout.write(response.access_token);
          return;
        }
        const error = typeof response.error === "string" ? response.error : "unknown_error";
        const description = typeof response.error_description === "string"
          ? response.error_description
          : "Keycloak returned no error description";
        process.stderr.write(`Keycloak player token failed: ${error}: ${description}\n`);
        process.exitCode = 1;
      });
    '
}

token_subject() {
  node -e 'const payload=process.argv[1].split(".")[1];process.stdout.write(JSON.parse(Buffer.from(payload,"base64url").toString("utf8")).sub);' "$1"
}

initialize_identity_fixture() {
  local token
  token=$(admin_token)
  curl --fail --silent --show-error -o /dev/null \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    --data "{\"realm\":\"$test_realm\",\"enabled\":true}" \
    "$keycloak_url/admin/realms"
  curl --fail --silent --show-error -o /dev/null \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    --data "{\"clientId\":\"$test_client\",\"enabled\":true,\"publicClient\":true,\"directAccessGrantsEnabled\":true}" \
    "$keycloak_url/admin/realms/$test_realm/clients"
  curl --fail --silent --show-error -o /dev/null \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    --data "{\"username\":\"$test_username\",\"firstName\":\"Schema\",\"lastName\":\"Migration\",\"email\":\"schema-migration-player@example.invalid\",\"enabled\":true,\"emailVerified\":true,\"requiredActions\":[],\"credentials\":[{\"type\":\"password\",\"value\":\"$test_password\",\"temporary\":false}]}" \
    "$keycloak_url/admin/realms/$test_realm/users"
}

create_backup() {
  local directory=$1
  sh ops/alpha/backup-game.sh "$database_url" "$directory/game.dump" "$directory/game.manifest.json" >/dev/null
}

create_isolated_restore() {
  local directory=$1
  local phase=$2
  local restore_database="zugfolge_restore_keycloak_$phase"
  if [[ -e "$directory/restore-receipt.json" ]]; then
    echo "restore receipt already exists: $directory/restore-receipt.json" >&2
    return 65
  fi
  sh ops/alpha/restore-game.sh \
    "$admin_database_url" "$restore_database" \
    "$directory/game.dump" "$directory/game.manifest.json" \
    >"$directory/restore-receipt.json"
}

run_mutating_command() {
  local command=$1
  local directory=$2
  local receipt_output=${3:-$directory/receipt.json}
  local phase
  phase=$(basename "$directory")
  local restored_database_url
  restored_database_url=$(node -e 'const url=new URL(process.argv[1]);url.pathname=`/zugfolge_restore_keycloak_${process.argv[2]}`;process.stdout.write(url.href);' "$database_url" "$phase")
  env \
    DATABASE_URL="$database_url" \
    KEYCLOAK_SCHEMA_CATALOG_PATH="$catalog_path" \
    KEYCLOAK_SCHEMA_BACKUP_MANIFEST_PATH="$directory/game.manifest.json" \
    KEYCLOAK_SCHEMA_BACKUP_DUMP_PATH="$directory/game.dump" \
    KEYCLOAK_SCHEMA_RESTORED_DATABASE_URL="$restored_database_url" \
    KEYCLOAK_SCHEMA_RESTORE_RECEIPT_PATH="$directory/restore-receipt.json" \
    KEYCLOAK_SCHEMA_BACKUP_BINDING_PATH="$directory/backup-binding.json" \
    KEYCLOAK_SCHEMA_BACKUP_BINDING_OUTPUT_PATH="$directory/backup-binding.json" \
    KEYCLOAK_SCHEMA_PLAN_PATH="$directory/plan.json" \
    KEYCLOAK_SCHEMA_PLAN_OUTPUT_PATH="$directory/plan.json" \
    KEYCLOAK_SCHEMA_RECEIPT_OUTPUT_PATH="$receipt_output" \
    KEYCLOAK_SCHEMA_WRITERS_QUIESCED=true \
    node "$migration_script" "$command" >/dev/null
}

run_runtime_gate() {
  local command=$1
  local receipt=$2
  env \
    DATABASE_URL="$database_url" \
    KEYCLOAK_SCHEMA_CATALOG_PATH="$catalog_path" \
    KEYCLOAK_SCHEMA_RECEIPT_PATH="$receipt" \
    KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED=false \
    node "$migration_script" "$command" >/dev/null
}

start_keycloak public
initialize_identity_fixture
legacy_subject=$(token_subject "$(issue_player_token)")
stop_keycloak

create_backup "$evidence_root/up"
create_isolated_restore "$evidence_root/up" up
run_mutating_command bind-backup "$evidence_root/up"
run_mutating_command plan-up "$evidence_root/up"
run_mutating_command up "$evidence_root/up"
run_mutating_command recover "$evidence_root/up" "$evidence_root/up/recover-receipt.json"
run_runtime_gate preflight-up "$evidence_root/up/recover-receipt.json"
run_runtime_gate preflight "$evidence_root/up/recover-receipt.json"

start_keycloak keycloak
run_runtime_gate postflight "$evidence_root/up/recover-receipt.json"
migrated_subject=$(token_subject "$(issue_player_token)")
stop_keycloak

create_backup "$evidence_root/down"
create_isolated_restore "$evidence_root/down" down
run_mutating_command bind-backup "$evidence_root/down"
run_mutating_command plan-down "$evidence_root/down"
run_mutating_command down "$evidence_root/down"
run_mutating_command recover "$evidence_root/down" "$evidence_root/down/recover-receipt.json"

start_keycloak public
rolled_back_subject=$(token_subject "$(issue_player_token)")
stop_keycloak

if [[ "$legacy_subject" != "$migrated_subject" || "$legacy_subject" != "$rolled_back_subject" ]]; then
  echo "Keycloak token subjects changed across up/down migration" >&2
  exit 70
fi

# Der nachgelagerte Datenbank-Rollbackbeweis akzeptiert ausschliesslich den
# produktiven, migrierten Keycloak-Zustand. Der Down-Drill stellt zuvor
# byte-/identitaetsgleich den Legacy-Zustand wieder her; derselbe freigegebene
# Up-Plan muss ihn deshalb erneut und ohne neue Planannahmen migrieren koennen.
run_mutating_command up "$evidence_root/up" "$evidence_root/final-up-receipt.json"
run_runtime_gate preflight-up "$evidence_root/final-up-receipt.json"
run_runtime_gate preflight "$evidence_root/final-up-receipt.json"

node -e '
  const fs = require("node:fs");
  const up = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const down = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const upRecover = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const downRecover = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  const finalUp = JSON.parse(fs.readFileSync(process.argv[5], "utf8"));
  if (up.schema !== "keycloak-public-to-schema-receipt/v1" || up.action !== "up") process.exit(1);
  if (down.schema !== "keycloak-public-to-schema-receipt/v1" || down.action !== "down") process.exit(1);
  if (upRecover.schema !== "keycloak-public-to-schema-recover-receipt/v1" || upRecover.action !== "up") process.exit(1);
  if (downRecover.schema !== "keycloak-public-to-schema-recover-receipt/v1" || downRecover.action !== "down") process.exit(1);
  if (finalUp.schema !== "keycloak-public-to-schema-receipt/v1" || finalUp.action !== "up") process.exit(1);
' "$evidence_root/up/receipt.json" "$evidence_root/down/receipt.json" \
  "$evidence_root/up/recover-receipt.json" "$evidence_root/down/recover-receipt.json" \
  "$evidence_root/final-up-receipt.json"

printf '{"schema":"keycloak-public-to-schema-real-integration/v1","subject":"%s","up":true,"down":true,"finalState":"migrated","tokenIdentityPreserved":true}\n' "$legacy_subject"
