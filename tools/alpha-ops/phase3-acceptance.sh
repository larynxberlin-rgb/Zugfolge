#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

required() {
  local name=$1
  if [[ -z ${!name:-} || ${!name} == replace-* ]]; then
    echo "Phase-3-Parameter $name fehlt oder ist noch ein Platzhalter." >&2
    exit 64
  fi
}
for name in ODOO_DB_PASSWORD POSTGRES_USER POSTGRES_DB KEYCLOAK_REALM \
  PHASE3_INVITATION_REFERENCE PHASE3_REQUESTER_LOGIN PHASE3_APPROVER_LOGIN \
  PHASE3_PLAYER_ACCESS_TOKEN ALPHA_PUBLIC_WORLD_ID GRAFANA_ADMIN_PASSWORD; do
  required "$name"
done
command -v docker >/dev/null
command -v curl >/dev/null
command -v node >/dev/null

COMPOSE=(docker compose -f compose.alpha.yml)
WORK_REL=${ALPHA_PHASE3_WORKDIR:-var/alpha-ops/phase3}
case "$WORK_REL" in /*|*..*) echo "ALPHA_PHASE3_WORKDIR muss relativ innerhalb des Repositories liegen." >&2; exit 65;; esac
WORK_ABS="$ROOT/$WORK_REL"
mkdir -p "$WORK_ABS/backups" "$WORK_ABS/restores" "$WORK_ABS/protocols" var/alpha-ops
export ALPHA_OPS_HOST_DIR="$WORK_ABS"
RUN_ID=${ALPHA_PHASE3_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
case "$RUN_ID" in *[!A-Za-z0-9._-]*|'') echo "unsichere Drill-ID" >&2; exit 65;; esac
BACKUP_ID="phase3-$RUN_ID"
RESTORE_DB="zugfolge_odoo_restore_${RUN_ID//[^A-Za-z0-9_]/_}"
SOURCE_DB=${ODOO_DATABASE:-zugfolge_odoo}
SOURCE_URL="postgresql://odoo@odoo-postgres:5432/$SOURCE_DB"
ADMIN_URL="postgresql://odoo@odoo-postgres:5432/postgres"
RESTORE_URL="postgresql://odoo@odoo-postgres:5432/$RESTORE_DB"
PROMETHEUS_URL=${PHASE3_PROMETHEUS_URL:-http://localhost:${PROMETHEUS_PORT:-9090}}
GRAFANA_URL=${PHASE3_GRAFANA_URL:-http://localhost:${GRAFANA_PORT:-3001}}
GAME_API_URL=${PHASE3_GAME_API_URL:-http://localhost:${GAME_API_PORT:-3000}}
ALERT_TIMEOUT=${PHASE3_ALERT_TIMEOUT_SECONDS:-900}
ODOO_STOPPED=0
GAME_API_STOPPED=0

recover_services() {
  if [[ $GAME_API_STOPPED == 1 ]]; then "${COMPOSE[@]}" start game-api >/dev/null || true; fi
  if [[ $ODOO_STOPPED == 1 ]]; then "${COMPOSE[@]}" start odoo >/dev/null || true; fi
}
trap recover_services EXIT HUP INT TERM

run_ops() {
  "${COMPOSE[@]}" --profile operations run --rm alpha-ops "$@"
}

wait_http() {
  local url=$1 timeout=${2:-180} started=$SECONDS
  until curl --fail --silent --show-error "$url" >/dev/null 2>&1; do
    if (( SECONDS - started >= timeout )); then echo "Timeout fuer $url" >&2; return 1; fi
    sleep 5
  done
}

wait_alert() {
  local alert_name=$1 timeout=$2 started=$SECONDS
  until curl --fail --silent "$PROMETHEUS_URL/api/v1/alerts" | node -e '
    let body=""; process.stdin.on("data", c => body += c).on("end", () => {
      const name=process.argv[1]; const parsed=JSON.parse(body);
      process.exit(parsed.data?.alerts?.some(a => a.labels?.alertname === name && a.state === "firing") ? 0 : 1);
    });' "$alert_name"; do
    if (( SECONDS - started >= timeout )); then echo "Alert $alert_name feuerte nicht innerhalb von ${timeout}s." >&2; return 1; fi
    sleep 10
  done
}

assert_query_result() {
  local metric=$1
  node -e '
    let body=""; process.stdin.on("data", c => body += c).on("end", () => {
      const metric=process.argv[1]; const parsed=JSON.parse(body);
      if (parsed.status !== "success" || !Array.isArray(parsed.data?.result) || parsed.data.result.length === 0) {
        console.error(`Keine Live-Zeitreihe fuer ${metric}.`); process.exit(1);
      }
    });' "$metric"
}

"${COMPOSE[@]}" ps --status running --services | grep -qx odoo
"${COMPOSE[@]}" ps --status running --services | grep -qx game-api
wait_http "$GAME_API_URL/health/ready" 180
wait_http "$PROMETHEUS_URL/-/ready" 180
wait_http "$GRAFANA_URL/api/health" 180

# M9.4: Der Odoo-Mensch beantragt den Entzug, eine zweite Person genehmigt,
# queue_job sendet signiert, und erst das Game deaktiviert Identitaet/Zugang.
FOUR_EYES_OUTPUT=$("${COMPOSE[@]}" exec -T \
  -e PHASE3_INVITATION_REFERENCE -e PHASE3_REQUESTER_LOGIN -e PHASE3_APPROVER_LOGIN \
  odoo odoo shell --no-http --database="$SOURCE_DB" --db_host=odoo-postgres --db_user=odoo --db_password="$ODOO_DB_PASSWORD" \
  < tools/alpha-ops/phase3-four-eyes.py)
FOUR_EYES_JSON=$(printf '%s\n' "$FOUR_EYES_OUTPUT" | sed -n 's/^PHASE3_FOUR_EYES=//p' | tail -n 1)
test -n "$FOUR_EYES_JSON"
CORRELATION_ID=$(node -e 'const v=JSON.parse(process.argv[1]); if(!/^[a-f0-9-]{36}$/.test(v.correlationId))process.exit(1); process.stdout.write(v.correlationId)' "$FOUR_EYES_JSON")
WORLD_ID=$(node -e 'const v=JSON.parse(process.argv[1]); if(!/^[a-f0-9-]{36}$/.test(v.worldId))process.exit(1); process.stdout.write(v.worldId)' "$FOUR_EYES_JSON")
KEYCLOAK_SUBJECT=$(node -e 'const v=JSON.parse(process.argv[1]); if(!/^[A-Za-z0-9._:-]+$/.test(v.keycloakSubject))process.exit(1); process.stdout.write(v.keycloakSubject)' "$FOUR_EYES_JSON")

STARTED=$SECONDS
while :; do
  REQUEST_RESULT=$(run_ops -c "psql -X -qAt -h odoo-postgres -U odoo -d '$SOURCE_DB' -c \"select state || '|' || coalesce(game_audit_event_id,'') from zugfolge_admin_request where correlation_id='$CORRELATION_ID'\"")
  [[ $REQUEST_RESULT == completed\|* ]] && [[ $REQUEST_RESULT != "completed|" ]] && break
  if (( SECONDS - STARTED >= 300 )); then echo "Vier-Augen-Antrag wurde nicht autoritativ abgeschlossen." >&2; exit 68; fi
  sleep 5
done
ACCESS_STATUS=$("${COMPOSE[@]}" exec -T postgres psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select status from world_accesses where world_id='$WORLD_ID' and keycloak_subject='$KEYCLOAK_SUBJECT'")
test "$ACCESS_STATUS" = revoked
"${COMPOSE[@]}" exec -T -e PHASE3_KEYCLOAK_SUBJECT="$KEYCLOAK_SUBJECT" game-api \
  node tools/alpha-ops/phase3-verify-keycloak.mjs > "$WORK_ABS/protocols/$BACKUP_ID-keycloak.json"

# M9.7: Ein anderes, weiterhin aktives externes Konto sendet pseudonymisiertes
# Feedback. Odoo muss genau die Game-Referenz sehen, niemals das Subject.
FEEDBACK_BODY=$(PHASE3_FEEDBACK_MESSAGE="${PHASE3_FEEDBACK_MESSAGE:-Die Betriebsansicht wurde im Alpha-Drill geprueft und kommentiert.}" node -e '
  process.stdout.write(JSON.stringify({fromS:0,untilS:0,category:"usability",message:process.env.PHASE3_FEEDBACK_MESSAGE,contactAllowed:false}))')
FEEDBACK_RESPONSE=$(curl --fail-with-body --silent --show-error -X POST \
  -H "authorization: Bearer $PHASE3_PLAYER_ACCESS_TOKEN" -H 'content-type: application/json' \
  --data "$FEEDBACK_BODY" "$GAME_API_URL/worlds/$ALPHA_PUBLIC_WORLD_ID/alpha-feedback")
FEEDBACK_ID=$(node -e 'const v=JSON.parse(process.argv[1]); if(!/^[a-f0-9-]{36}$/.test(v.id))process.exit(1); process.stdout.write(v.id)' "$FEEDBACK_RESPONSE")
STARTED=$SECONDS
until [[ $(run_ops -c "psql -X -qAt -h odoo-postgres -U odoo -d '$SOURCE_DB' -c \"select count(*) from zugfolge_feedback f join zugfolge_world_projection w on w.id=f.world_projection_id where w.world_id='$ALPHA_PUBLIC_WORLD_ID' and f.feedback_reference='$FEEDBACK_ID' and f.source='game' and f.participant_pseudonym is not null\"") == 1 ]]; do
  if (( SECONDS - STARTED >= 180 )); then echo "Pseudonymisiertes Feedback erreichte Odoo nicht." >&2; exit 69; fi
  sleep 5
done

# M9.5: Live-Backup, isolierter Restore, Hashgleichheit, Modulupgrade,
# Odoo-Testlauf und echte Filestore-Anhangsstichprobe.
run_ops /ops/alpha/backup-odoo.sh "$SOURCE_URL" "/var/lib/odoo/filestore/$SOURCE_DB" /work/backups "$BACKUP_ID"
run_ops /ops/alpha/restore-odoo.sh "$ADMIN_URL" "$RESTORE_DB" "/work/restores/$RESTORE_DB" \
  "/work/backups/$BACKUP_ID" "/work/backups/$BACKUP_ID.manifest.json" \
  > "$WORK_ABS/protocols/$BACKUP_ID-restore.json"
RESTORE_FILESTORE="$WORK_ABS/restores/$RESTORE_DB"
"${COMPOSE[@]}" run --rm --no-deps \
  --volume "$RESTORE_FILESTORE:/var/lib/odoo/filestore/$RESTORE_DB" \
  odoo odoo --no-http --database="$RESTORE_DB" --db_host=odoo-postgres --db_user=odoo --db_password="$ODOO_DB_PASSWORD" \
  --addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/extra-addons \
  --load=base,web,queue_job \
  --update=zugfolge_admin --test-enable --test-tags=/zugfolge_admin --stop-after-init
run_ops /ops/alpha/compare-odoo-attachments.sh "$SOURCE_URL" "$RESTORE_URL" "/var/lib/odoo/filestore/$SOURCE_DB" "/work/restores/$RESTORE_DB" 5 \
  > "$WORK_ABS/protocols/$BACKUP_ID-attachment.json"

# Alert-Drill im angekuendigten Wartungsfenster: Odoo-Ausfall degradiert nur
# die Bridge; danach wird die Game API separat als echter Down-Fall geprueft.
"${COMPOSE[@]}" stop odoo >/dev/null
ODOO_STOPPED=1
wait_alert ZugfolgeOdooDown "$ALERT_TIMEOUT"
wait_alert ZugfolgeSubsystemDegraded "$ALERT_TIMEOUT"
"${COMPOSE[@]}" start odoo >/dev/null
ODOO_STOPPED=0
wait_http "http://localhost:${ODOO_PORT:-8069}/web/health" 180

"${COMPOSE[@]}" stop game-api >/dev/null
GAME_API_STOPPED=1
wait_alert ZugfolgeGameApiDown "$ALERT_TIMEOUT"
"${COMPOSE[@]}" start game-api >/dev/null
GAME_API_STOPPED=0
wait_http "$GAME_API_URL/health/ready" 300

curl --fail --silent --user "admin:$GRAFANA_ADMIN_PASSWORD" "$GRAFANA_URL/api/dashboards/uid/zugfolge-alpha-ops" \
  | grep -q 'Zugfolge Alpha - Betrieb'
for metric in zugfolge_alpha_odoo_projection_pending zugfolge_alpha_market_items; do
  curl --fail --silent --get --data-urlencode "query=$metric" "$PROMETHEUS_URL/api/v1/query" | assert_query_result "$metric"
  curl --fail --silent --user "admin:$GRAFANA_ADMIN_PASSWORD" --get --data-urlencode "query=$metric" \
    "$GRAFANA_URL/api/datasources/proxy/uid/zugfolge-prometheus/api/v1/query" | assert_query_result "Grafana/$metric"
done

PROTOCOL="$WORK_ABS/protocols/$BACKUP_ID-phase3.json"
node -e '
  const fs=require("node:fs");
  const [out, manifestPath, restorePath, attachmentPath, fourEyes, feedbackId]=process.argv.slice(1);
  const protocol={schema:"zugfolge-phase3-acceptance/v1",executedAt:new Date().toISOString(),fourEyes:JSON.parse(fourEyes),feedbackReference:feedbackId,backup:JSON.parse(fs.readFileSync(manifestPath,"utf8")),restore:JSON.parse(fs.readFileSync(restorePath,"utf8")),attachmentSample:JSON.parse(fs.readFileSync(attachmentPath,"utf8")),alerts:["ZugfolgeOdooDown","ZugfolgeSubsystemDegraded","ZugfolgeGameApiDown"],dashboardUid:"zugfolge-alpha-ops",status:"passed"};
  fs.writeFileSync(out, JSON.stringify(protocol,null,2)+"\n");
' "$PROTOCOL" "$WORK_ABS/backups/$BACKUP_ID.manifest.json" "$WORK_ABS/protocols/$BACKUP_ID-restore.json" "$WORK_ABS/protocols/$BACKUP_ID-attachment.json" "$FOUR_EYES_JSON" "$FEEDBACK_ID"
printf 'Phase 3 bestanden; Protokoll: %s\n' "$PROTOCOL"
