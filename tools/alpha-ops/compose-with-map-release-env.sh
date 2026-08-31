#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository_root=$(cd -- "$script_dir/../.." && pwd -P)
cd "$repository_root"

compose_project=zugfolge

if (($# == 0)); then
  printf 'Aufruf: compose-with-map-release-env.sh [--prepare-v2-schema31|--prepare-v2-cold|--schema33-after-cold|--keycloak-after-schema33|--keycloak-recover-after-schema33|--prepare-v2-hot|--quiesced-cutover|--attested-rollback|--attested-rollback-stop|--fixed-stop] COMPOSE_ARGUMENTE...\n' >&2
  exit 64
fi

preflight_mode=active-candidate
fixed_stop=0
quiesced_cutover=0
attested_rollback=0
attested_rollback_stop=0
prepare_v2_cold=0
prepare_v2_schema31=0
schema33_after_cold=0
keycloak_after_schema33=0
keycloak_recover_after_schema33=0
prepare_v2_hot=0
if [[ ${1:-} == --prepare-v2-schema31 ]]; then
  prepare_v2_schema31=1
  preflight_mode=pre-activation
  shift
  if (($# == 0)); then
    printf 'Die Schema-31-Vorbereitung braucht die kanonische Compose-Datei.\n' >&2
    exit 64
  fi
elif [[ ${1:-} == --prepare-v2-cold ]]; then
  prepare_v2_cold=1
  preflight_mode=pre-activation
  shift
  if (($# == 0)); then
    printf 'Die kalte V2-Vorbereitung braucht die kanonische Compose-Datei.\n' >&2
    exit 64
  fi
elif [[ ${1:-} == --schema33-after-cold ]]; then
  schema33_after_cold=1
  preflight_mode=pre-activation
  shift
  if (($# == 0)); then
    printf 'Der Schema-32/33-Gate braucht die kanonische Compose-Datei.\n' >&2
    exit 64
  fi
elif [[ ${1:-} == --keycloak-after-schema33 ]]; then
  keycloak_after_schema33=1
  preflight_mode=pre-activation
  shift
  if (($# == 0)); then
    printf 'Der Keycloak-public-nach-keycloak-Gate braucht die kanonische Compose-Datei.\n' >&2
    exit 64
  fi
elif [[ ${1:-} == --keycloak-recover-after-schema33 ]]; then
  keycloak_recover_after_schema33=1
  preflight_mode=pre-activation
  shift
  if (($# == 0)); then
    printf 'Der Keycloak-Up-Receipt-Recover-Gate braucht die kanonische Compose-Datei.\n' >&2
    exit 64
  fi
elif [[ ${1:-} == --prepare-v2-hot ]]; then
  prepare_v2_hot=1
  preflight_mode=pre-activation
  shift
  if (($# == 0)); then
    printf 'Die heisse Recovery-Qualifikation braucht die kanonische Compose-Datei.\n' >&2
    exit 64
  fi
elif [[ ${1:-} == --quiesced-cutover ]]; then
  quiesced_cutover=1
  shift
  if (($# == 0)); then
    printf 'Der quieszierende Cutovermodus braucht ein Compose-up-Kommando.\n' >&2
    exit 64
  fi
elif [[ ${1:-} == --attested-rollback ]]; then
  attested_rollback=1
  preflight_mode=attested-rollback
  shift
  if (($# == 0)); then
    printf 'Der attestierte Rollbackmodus braucht ein Compose-Kommando.\n' >&2
    exit 64
  fi
elif [[ ${1:-} == --attested-rollback-stop ]]; then
  attested_rollback_stop=1
  preflight_mode=pre-activation
  shift
  if (($# == 0)); then
    printf 'Der attestierte Rollback-Stop braucht das kanonische Compose-Ziel und down.\n' >&2
    exit 64
  fi
elif [[ ${1:-} == --fixed-stop ]]; then
  fixed_stop=1
  shift
  if (($# == 0)); then
    printf 'Der feste Stopmodus braucht das kanonische Compose-Ziel und down.\n' >&2
    exit 64
  fi
fi

compose_file=
compose_file_count=0
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index += 1)); do
  argument=${arguments[$index]}
  case "$argument" in
    -f|--file)
      ((index += 1))
      if ((index >= ${#arguments[@]})) || [[ -z ${arguments[$index]} ]]; then
        printf 'Das Compose-Dateiargument braucht einen Pfad.\n' >&2
        exit 64
      fi
      compose_file=${arguments[$index]}
      ((compose_file_count += 1))
      ;;
    --file=*)
      compose_file=${argument#--file=}
      ((compose_file_count += 1))
      ;;
    -p|--project-name|--project-name=*|-p*)
      printf 'Der Compose-Projektname ist fest auf %s gebunden und darf nicht ueberschrieben werden.\n' "$compose_project" >&2
      exit 64
      ;;
  esac
done

if ((compose_file_count != 1)) || [[ -z "$compose_file" ]]; then
  printf 'Genau eine kanonische Compose-Datei muss mit -f angegeben werden.\n' >&2
  exit 64
fi
if [[ "$compose_file" == /* ]]; then
  resolved_compose_file=$compose_file
else
  resolved_compose_file=$repository_root/$compose_file
fi
compose_parent=$(cd -- "$(dirname -- "$resolved_compose_file")" 2>/dev/null && pwd -P) || {
  printf 'Das Compose-Dateiverzeichnis fehlt.\n' >&2
  exit 65
}
resolved_compose_file=$compose_parent/$(basename -- "$resolved_compose_file")
if [[ "$resolved_compose_file" != "$repository_root/compose.alpha.yml" \
  && "$resolved_compose_file" != "$repository_root/compose.yml" ]]; then
  printf 'Erlaubt sind nur die Repo-Vorlage compose.alpha.yml und die daraus installierte compose.yml.\n' >&2
  exit 64
fi
if [[ ! -f "$resolved_compose_file" || -L "$resolved_compose_file" ]]; then
  printf 'Die kanonische Compose-Datei fehlt oder ist ein Symlink: %s\n' "$resolved_compose_file" >&2
  exit 65
fi
if [[ "$resolved_compose_file" == "$repository_root/compose.yml" ]]; then
  compose_template=$repository_root/compose.alpha.yml
  if [[ ! -f "$compose_template" || -L "$compose_template" ]] \
    || ! cmp --silent -- "$compose_template" "$resolved_compose_file"; then
    printf 'Die installierte compose.yml stimmt nicht bytegleich mit der Repo-Vorlage compose.alpha.yml ueberein.\n' >&2
    exit 65
  fi
fi

rollback_compose_template=$repository_root/compose.alpha.rollback.yml
if [[ "$resolved_compose_file" == "$repository_root/compose.yml" ]]; then
  rollback_compose_file=$repository_root/compose.rollback.yml
else
  rollback_compose_file=$rollback_compose_template
fi

canonical_image_build_requested=0
if (($# == 3)) && [[ ${1:-} == -f || ${1:-} == --file ]] && [[ ${3:-} == build ]]; then
  canonical_image_build_requested=1
fi

# Datenbankcontainer sind absichtlich nicht Teil dieser Liste. Ihre
# persistenten Identitaeten sind im signierten Recovery-Beleg gebunden und
# duerfen weder beim Cutover noch bei einem der beiden Unit-Stopwege entfernt
# oder neu erzeugt werden.
runtime_services=(
  odoo-upgrade
  keycloak-schema-migrate keycloak-schema-backup keycloak-schema-restore
  keycloak-schema-preflight keycloak keycloak-schema-postflight keycloak-reconcile
  map-release-preflight world-deployment-cutover-preflight game-migrate game-bootstrap
  game-api game-web livemap operations-center static odoo alpha-ops
  production-recovery-material production-recovery-schema29-cold-qualify production-recovery-cold-qualify
  production-schema29-runtime-snapshot production-schema29-odoo-filestore-access schema29-game-runtime schema29-keycloak-runtime schema29-odoo-runtime
  legacy-game-schema29-write-probe legacy-odoo-schema29-write-probe production-schema29-runtime-qualify
  game-schema31-migrate legacy-game-schema31-write-probe game-schema31-qualify
  game-schema33-migrate production-recovery-proof
  production-recovery-action prometheus grafana
)

if ((fixed_stop == 1)); then
  if (($# != 3)) || [[ ${1:-} != -f && ${1:-} != --file ]] || [[ ${3:-} != down ]]; then
    printf 'Der feste Stopmodus erlaubt ausschliesslich -f KANONISCHE_COMPOSE_DATEI down.\n' >&2
    exit 64
  fi

  # Der nach aussen eng auf `down` begrenzte Unit-Vertrag muss den bekannten
  # Stack auch dann erreichen, wenn der aktive Kartenzeiger fehlt oder
  # beschaedigt ist. Intern werden ausschliesslich Runtime-Container gestoppt
  # und entfernt: `postgres` und `odoo-postgres` muessen mit ihren attestierten
  # Container-IDs fuer den folgenden Recovery-/Continuation-Gate erhalten
  # bleiben. Sichere Dummywerte dienen nur der Compose-Interpolation.
  unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES
  export MAP_RELEASE_DEPLOYMENT_HOST_ROOT="$repository_root/.fixed-stop-placeholder/maps"
  export MAP_RELEASE_PREFLIGHT_HOST_DIR="$repository_root/.fixed-stop-placeholder/preflight"
  export MAP_RELEASE_RESTORE_HOST_DIR="$repository_root/.fixed-stop-placeholder/restore"
  export MAP_RELEASE_ID=infra-stop-placeholder-2000.1
  export MAP_RELEASE_HOST_DIR=releases/infra-stop-placeholder-2000.1
  export MAP_BASEMAP_STYLE_URL=/artifacts/maps/infra-stop-placeholder-2000.1/style.json
  export MAP_GERMANY_PMTILES_URL=/artifacts/maps/infra-stop-placeholder-2000.1/infra-stop-placeholder-2000.1.pmtiles
  export MAP_RELEASE_START_PREFLIGHT_MODE=active-candidate
  export ZUGFOLGE_GAME_API_IMAGE_REFERENCE="sha256:$(printf '0%.0s' {1..64})"
  export ZUGFOLGE_ODOO_IMAGE_REFERENCE="sha256:$(printf '1%.0s' {1..64})"

  stop_env_args=()
  if [[ -f .env && ! -L .env ]]; then
    stop_env_args=(--env-file .env)
  fi
  fixed_stop_compose=(
    docker compose
    "${stop_env_args[@]}"
    --project-name "$compose_project"
    --project-directory "$repository_root"
    -f "$resolved_compose_file"
    --profile operations
    --profile keycloak-schema-migration
    --profile production-recovery-preparation
  )
  "${fixed_stop_compose[@]}" stop --timeout 60 "${runtime_services[@]}"
  "${fixed_stop_compose[@]}" rm --force "${runtime_services[@]}"
  exit 0
fi

if [[ ! -f .env || -L .env ]]; then
  printf '.env fehlt oder ist kein regulaeres File ohne Symlink.\n' >&2
  exit 65
fi

umask 077
compose_env_snapshot_dir=$(mktemp -d "${TMPDIR:-/tmp}/zugfolge-compose-env.XXXXXX")
cleanup_compose_env_snapshot() {
  rm -rf -- "$compose_env_snapshot_dir"
}
trap cleanup_compose_env_snapshot EXIT
base_env_snapshot=$compose_env_snapshot_dir/base.env
if ! cp --no-dereference -- .env "$base_env_snapshot" \
  || [[ ! -f "$base_env_snapshot" || -L "$base_env_snapshot" ]] \
  || [[ ! -f .env || -L .env ]] \
  || ! cmp --silent -- .env "$base_env_snapshot"; then
  printf '.env aenderte sich beim Erzeugen des privaten Compose-Snapshots oder ist nicht symlinkfrei.\n' >&2
  exit 65
fi
chmod 600 "$base_env_snapshot"

map_release_root=
map_release_root_count=0
current_image_reference=
current_image_reference_count=0
current_odoo_image_reference=
current_odoo_image_reference_count=0
legacy_image_digest=
legacy_image_digest_count=0
legacy_image_reference=
legacy_image_reference_count=0
legacy_odoo_image_digest=
legacy_odoo_image_digest_count=0
legacy_odoo_image_reference=
legacy_odoo_image_reference_count=0
production_recovery_id=
production_recovery_id_count=0
production_recovery_candidate_release_id=
production_recovery_candidate_release_id_count=0
production_recovery_previous_release_id=
production_recovery_previous_release_id_count=0
production_recovery_evidence_host_root=
production_recovery_evidence_host_root_count=0
production_recovery_odoo_filestore_host_root=
production_recovery_odoo_filestore_host_root_count=0
production_recovery_backup_host_root=
production_recovery_backup_host_root_count=0
production_cold_game_restore_database=
production_cold_game_restore_database_count=0
production_cold_odoo_restore_database=
production_cold_odoo_restore_database_count=0
production_schema29_game_restore_database=
production_schema29_game_restore_database_count=0
production_schema29_odoo_restore_database=
production_schema29_odoo_restore_database_count=0
production_schema29_runtime_game_restore_database=
production_schema29_runtime_game_restore_database_count=0
production_schema29_runtime_odoo_restore_database=
production_schema29_runtime_odoo_restore_database_count=0
production_recovery_game_verify_database=
production_recovery_game_verify_database_count=0
keycloak_schema_evidence_host_dir=
keycloak_schema_evidence_host_dir_count=0
keycloak_schema_backup_host_dir=
keycloak_schema_backup_host_dir_count=0
keycloak_schema_restore_database=
keycloak_schema_restore_database_count=0
postgres_database=
postgres_database_count=0
keycloak_schema_receipt_container_path=
keycloak_schema_receipt_container_path_count=0
keycloak_schema_receipt_output_container_path=
keycloak_schema_receipt_output_container_path_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == *$'\r' ]]; then
    printf '.env muss LF-Zeilenenden verwenden.\n' >&2
    exit 65
  fi
  case "$line" in
    MAP_RELEASE_DEPLOYMENT_HOST_ROOT=*)
      map_release_root=${line#MAP_RELEASE_DEPLOYMENT_HOST_ROOT=}
      ((map_release_root_count += 1))
      ;;
    ZUGFOLGE_GAME_API_IMAGE_REFERENCE=*)
      current_image_reference=${line#ZUGFOLGE_GAME_API_IMAGE_REFERENCE=}
      ((current_image_reference_count += 1))
      ;;
    ZUGFOLGE_ODOO_IMAGE_REFERENCE=*)
      current_odoo_image_reference=${line#ZUGFOLGE_ODOO_IMAGE_REFERENCE=}
      ((current_odoo_image_reference_count += 1))
      ;;
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST=*)
      legacy_image_digest=${line#MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST=}
      ((legacy_image_digest_count += 1))
      ;;
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE=*)
      legacy_image_reference=${line#MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE=}
      ((legacy_image_reference_count += 1))
      ;;
    PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST=*)
      legacy_odoo_image_digest=${line#PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST=}
      ((legacy_odoo_image_digest_count += 1))
      ;;
    PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE=*)
      legacy_odoo_image_reference=${line#PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE=}
      ((legacy_odoo_image_reference_count += 1))
      ;;
    PRODUCTION_RECOVERY_ID=*)
      production_recovery_id=${line#PRODUCTION_RECOVERY_ID=}
      ((production_recovery_id_count += 1))
      ;;
    PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID=*)
      production_recovery_candidate_release_id=${line#PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID=}
      ((production_recovery_candidate_release_id_count += 1))
      ;;
    PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID=*)
      production_recovery_previous_release_id=${line#PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID=}
      ((production_recovery_previous_release_id_count += 1))
      ;;
    PRODUCTION_RECOVERY_EVIDENCE_HOST_ROOT=*)
      production_recovery_evidence_host_root=${line#PRODUCTION_RECOVERY_EVIDENCE_HOST_ROOT=}
      ((production_recovery_evidence_host_root_count += 1))
      ;;
    PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT=*)
      production_recovery_odoo_filestore_host_root=${line#PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT=}
      ((production_recovery_odoo_filestore_host_root_count += 1))
      ;;
    PRODUCTION_RECOVERY_BACKUP_HOST_ROOT=*)
      production_recovery_backup_host_root=${line#PRODUCTION_RECOVERY_BACKUP_HOST_ROOT=}
      ((production_recovery_backup_host_root_count += 1))
      ;;
    PRODUCTION_COLD_GAME_RESTORE_DATABASE=*)
      production_cold_game_restore_database=${line#PRODUCTION_COLD_GAME_RESTORE_DATABASE=}
      ((production_cold_game_restore_database_count += 1))
      ;;
    PRODUCTION_COLD_ODOO_RESTORE_DATABASE=*)
      production_cold_odoo_restore_database=${line#PRODUCTION_COLD_ODOO_RESTORE_DATABASE=}
      ((production_cold_odoo_restore_database_count += 1))
      ;;
    PRODUCTION_SCHEMA29_GAME_RESTORE_DATABASE=*)
      production_schema29_game_restore_database=${line#PRODUCTION_SCHEMA29_GAME_RESTORE_DATABASE=}
      ((production_schema29_game_restore_database_count += 1))
      ;;
    PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE=*)
      production_schema29_odoo_restore_database=${line#PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE=}
      ((production_schema29_odoo_restore_database_count += 1))
      ;;
    PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_DATABASE=*)
      production_schema29_runtime_game_restore_database=${line#PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_DATABASE=}
      ((production_schema29_runtime_game_restore_database_count += 1))
      ;;
    PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE=*)
      production_schema29_runtime_odoo_restore_database=${line#PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE=}
      ((production_schema29_runtime_odoo_restore_database_count += 1))
      ;;
    PRODUCTION_RECOVERY_GAME_VERIFY_DATABASE=*)
      production_recovery_game_verify_database=${line#PRODUCTION_RECOVERY_GAME_VERIFY_DATABASE=}
      ((production_recovery_game_verify_database_count += 1))
      ;;
    KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR=*)
      keycloak_schema_evidence_host_dir=${line#KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR=}
      ((keycloak_schema_evidence_host_dir_count += 1))
      ;;
    KEYCLOAK_SCHEMA_BACKUP_HOST_DIR=*)
      keycloak_schema_backup_host_dir=${line#KEYCLOAK_SCHEMA_BACKUP_HOST_DIR=}
      ((keycloak_schema_backup_host_dir_count += 1))
      ;;
    KEYCLOAK_SCHEMA_RESTORE_DATABASE=*)
      keycloak_schema_restore_database=${line#KEYCLOAK_SCHEMA_RESTORE_DATABASE=}
      ((keycloak_schema_restore_database_count += 1))
      ;;
    POSTGRES_DB=*)
      postgres_database=${line#POSTGRES_DB=}
      ((postgres_database_count += 1))
      ;;
    KEYCLOAK_SCHEMA_RECEIPT_CONTAINER_PATH=*)
      keycloak_schema_receipt_container_path=${line#KEYCLOAK_SCHEMA_RECEIPT_CONTAINER_PATH=}
      ((keycloak_schema_receipt_container_path_count += 1))
      ;;
    KEYCLOAK_SCHEMA_RECEIPT_OUTPUT_CONTAINER_PATH=*)
      keycloak_schema_receipt_output_container_path=${line#KEYCLOAK_SCHEMA_RECEIPT_OUTPUT_CONTAINER_PATH=}
      ((keycloak_schema_receipt_output_container_path_count += 1))
      ;;
  esac
  if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(MAP_RELEASE_ID|MAP_RELEASE_HOST_DIR|MAP_BASEMAP_STYLE_URL|MAP_GERMANY_PMTILES_URL|MAP_RELEASE_START_PREFLIGHT_MODE|MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID)[[:space:]]*= ]]; then
    printf '.env darf keine Kartenrelease-ID, keinen Releasepfad, keine Karten-URL und keinen Preflightmodus enthalten; diese Werte kommen nur aus Pointer und explizitem Wrappermodus.\n' >&2
    exit 65
  fi
done < "$base_env_snapshot"

image_reference_digest() {
  local reference=$1
  if [[ "$reference" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf '%s\n' "$reference"
    return 0
  fi
  if [[ "$reference" =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*@sha256:[a-f0-9]{64}$ ]]; then
    printf '%s\n' "${reference##*@}"
    return 0
  fi
  return 1
}

if ((current_image_reference_count != 1)) || [[ -z "$current_image_reference" ]]; then
  printf '.env muss ZUGFOLGE_GAME_API_IMAGE_REFERENCE genau einmal setzen.\n' >&2
  exit 65
fi
if ((current_odoo_image_reference_count != 1)) || [[ -z "$current_odoo_image_reference" ]]; then
  printf '.env muss ZUGFOLGE_ODOO_IMAGE_REFERENCE genau einmal setzen.\n' >&2
  exit 65
fi
if ((legacy_image_digest_count != 1)) || [[ -z "$legacy_image_digest" ]]; then
  printf '.env muss MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST genau einmal setzen.\n' >&2
  exit 65
fi
if ((legacy_image_reference_count != 1)) || [[ -z "$legacy_image_reference" ]]; then
  printf '.env muss MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE genau einmal setzen.\n' >&2
  exit 65
fi
if ((legacy_odoo_image_digest_count != 1)) || [[ -z "$legacy_odoo_image_digest" ]]; then
  printf '.env muss PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST genau einmal setzen.\n' >&2
  exit 65
fi
if ((legacy_odoo_image_reference_count != 1)) || [[ -z "$legacy_odoo_image_reference" ]]; then
  printf '.env muss PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE genau einmal setzen.\n' >&2
  exit 65
fi
if ((production_recovery_id_count != 1)) || [[ ! "$production_recovery_id" =~ ^[a-z0-9][a-z0-9._-]{0,79}$ ]]; then
  printf '.env muss PRODUCTION_RECOVERY_ID genau einmal und kanonisch setzen.\n' >&2
  exit 65
fi
if ((production_recovery_candidate_release_id_count != 1)) \
  || [[ ! "$production_recovery_candidate_release_id" =~ ^[a-z0-9][a-z0-9._-]*-20[0-9]{2}\.[1-9][0-9]*$ ]]; then
  printf '.env muss PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID genau einmal und als Jahres-Patchrelease setzen.\n' >&2
  exit 65
fi
if ((production_recovery_previous_release_id_count != 1)) \
  || [[ ! "$production_recovery_previous_release_id" =~ ^[a-z0-9][a-z0-9._-]*-20[0-9]{2}\.[1-9][0-9]*$ ]]; then
  printf '.env muss PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID genau einmal und als Jahres-Patchrelease setzen.\n' >&2
  exit 65
fi
if [[ "$production_recovery_candidate_release_id" == "$production_recovery_previous_release_id" ]]; then
  printf 'Kandidaten- und Vorgaengerrelease muessen verschieden sein.\n' >&2
  exit 65
fi
if ((production_recovery_evidence_host_root_count != 1)) || [[ -z "$production_recovery_evidence_host_root" ]]; then
  printf '.env muss PRODUCTION_RECOVERY_EVIDENCE_HOST_ROOT genau einmal setzen.\n' >&2
  exit 65
fi
if ((production_recovery_odoo_filestore_host_root_count != 1)) || [[ -z "$production_recovery_odoo_filestore_host_root" ]]; then
  printf '.env muss PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT genau einmal setzen.\n' >&2
  exit 65
fi
if ((production_recovery_backup_host_root_count != 1)) || [[ -z "$production_recovery_backup_host_root" ]]; then
  printf '.env muss PRODUCTION_RECOVERY_BACKUP_HOST_ROOT genau einmal setzen.\n' >&2
  exit 65
fi
if ((production_cold_game_restore_database_count != 1)) \
  || [[ ! "$production_cold_game_restore_database" =~ ^zugfolge_recovery_v1_[a-z0-9_]+$ ]]; then
  printf '.env muss PRODUCTION_COLD_GAME_RESTORE_DATABASE genau einmal als isoliertes V1-Recovery-Ziel setzen.\n' >&2
  exit 65
fi
if ((production_cold_odoo_restore_database_count != 1)) \
  || [[ ! "$production_cold_odoo_restore_database" =~ ^zugfolge_odoo_recovery_v1_[a-z0-9_]+$ ]]; then
  printf '.env muss PRODUCTION_COLD_ODOO_RESTORE_DATABASE genau einmal als isoliertes V1-Odoo-Recovery-Ziel setzen.\n' >&2
  exit 65
fi
if ((production_schema29_game_restore_database_count != 1)) \
  || [[ ! "$production_schema29_game_restore_database" =~ ^zugfolge_recovery_v1_[a-z0-9_]+$ ]] \
  || [[ "$production_schema29_game_restore_database" == "$production_cold_game_restore_database" ]]; then
  printf '.env muss PRODUCTION_SCHEMA29_GAME_RESTORE_DATABASE genau einmal als eigenes isoliertes Schema-29-Recovery-Ziel setzen.\n' >&2
  exit 65
fi
if ((production_schema29_odoo_restore_database_count != 1)) \
  || [[ ! "$production_schema29_odoo_restore_database" =~ ^zugfolge_odoo_recovery_v1_[a-z0-9_]+$ ]] \
  || [[ "$production_schema29_odoo_restore_database" == "$production_cold_odoo_restore_database" ]]; then
  printf '.env muss PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE genau einmal als eigenes isoliertes Schema-29-Odoo-Recovery-Ziel setzen.\n' >&2
  exit 65
fi
if ((production_schema29_runtime_game_restore_database_count != 1)) \
  || [[ ! "$production_schema29_runtime_game_restore_database" =~ ^zugfolge_recovery_v1_[a-z0-9_]+$ ]] \
  || [[ "$production_schema29_runtime_game_restore_database" == "$production_schema29_game_restore_database" ]] \
  || [[ "$production_schema29_runtime_game_restore_database" == "$production_cold_game_restore_database" ]]; then
  printf '.env muss PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_DATABASE genau einmal als getrenntes create-new Legacy-Runtime-Ziel setzen.\n' >&2
  exit 65
fi
if ((production_schema29_runtime_odoo_restore_database_count != 1)) \
  || [[ ! "$production_schema29_runtime_odoo_restore_database" =~ ^zugfolge_odoo_recovery_v1_[a-z0-9_]+$ ]] \
  || [[ "$production_schema29_runtime_odoo_restore_database" == "$production_schema29_odoo_restore_database" ]] \
  || [[ "$production_schema29_runtime_odoo_restore_database" == "$production_cold_odoo_restore_database" ]]; then
  printf '.env muss PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE genau einmal als getrenntes create-new Legacy-Odoo-Runtime-Ziel setzen.\n' >&2
  exit 65
fi
if ((production_recovery_game_verify_database_count != 1)) \
  || [[ ! "$production_recovery_game_verify_database" =~ ^zugfolge_restore_[a-z0-9_]+$ ]]; then
  printf '.env muss PRODUCTION_RECOVERY_GAME_VERIFY_DATABASE genau einmal als isoliertes Hot-Restore-Ziel setzen.\n' >&2
  exit 65
fi

validate_recovery_host_root() {
  local label=$1
  local path=$2
  if [[ ! "$path" =~ ^[A-Za-z0-9_./-]+$ ]] || [[ "/$path/" == */../* ]] \
    || [[ "$path" == / || "$path" == . || "$path" == ./ ]]; then
    printf '%s ist kein sicherer enger Hostpfad.\n' "$label" >&2
    exit 65
  fi
  if [[ ! -d "$path" || -L "$path" ]]; then
    printf '%s fehlt oder ist ein Symlink: %s\n' "$label" "$path" >&2
    exit 65
  fi
  (cd -- "$path" && pwd -P)
}

for recovery_host_root in "$production_recovery_evidence_host_root" "$production_recovery_odoo_filestore_host_root" "$production_recovery_backup_host_root"; do
  if [[ ! "$recovery_host_root" =~ ^[A-Za-z0-9_./-]+$ ]] || [[ "/$recovery_host_root/" == */../* ]] \
    || [[ "$recovery_host_root" == / || "$recovery_host_root" == . || "$recovery_host_root" == ./ ]]; then
    printf 'Recovery-Hostwurzeln muessen enge, sichere Pfade sein.\n' >&2
    exit 65
  fi
done
resolved_recovery_evidence_root=
resolved_recovery_filestore_root=
resolved_recovery_backup_root=
if ((attested_rollback == 1 || attested_rollback_stop == 1 || quiesced_cutover == 1 || prepare_v2_schema31 == 1 || prepare_v2_cold == 1 || schema33_after_cold == 1 || keycloak_after_schema33 == 1 || keycloak_recover_after_schema33 == 1 || prepare_v2_hot == 1)); then
  resolved_recovery_evidence_root=$(validate_recovery_host_root PRODUCTION_RECOVERY_EVIDENCE_HOST_ROOT "$production_recovery_evidence_host_root")
  resolved_recovery_filestore_root=$(validate_recovery_host_root PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT "$production_recovery_odoo_filestore_host_root")
  resolved_recovery_backup_root=$(validate_recovery_host_root PRODUCTION_RECOVERY_BACKUP_HOST_ROOT "$production_recovery_backup_host_root")
  if [[ "$resolved_recovery_evidence_root" == "$resolved_recovery_filestore_root" \
    || "$resolved_recovery_evidence_root" == "$resolved_recovery_backup_root" \
    || "$resolved_recovery_filestore_root" == "$resolved_recovery_backup_root" ]]; then
    printf 'Recovery-Evidence, Backupmaterial und Odoo-Filestore brauchen drei getrennte Hostwurzeln.\n' >&2
    exit 65
  fi
  for recovery_root in "$resolved_recovery_evidence_root" "$resolved_recovery_filestore_root" "$resolved_recovery_backup_root"; do
    for other_recovery_root in "$resolved_recovery_evidence_root" "$resolved_recovery_filestore_root" "$resolved_recovery_backup_root"; do
      if [[ "$recovery_root" != "$other_recovery_root" && "$other_recovery_root/" == "$recovery_root/"* ]]; then
        printf 'Recovery-Hostwurzeln duerfen nicht ineinander verschachtelt sein.\n' >&2
        exit 65
      fi
    done
  done
fi
if ((canonical_image_build_requested != 1)); then
  if ! current_image_digest=$(image_reference_digest "$current_image_reference"); then
    printf 'ZUGFOLGE_GAME_API_IMAGE_REFERENCE muss eine exakte lokale sha256-Image-ID oder eine kleingeschriebene Repository@sha256-Referenz sein.\n' >&2
    exit 65
  fi
  if [[ ! "$legacy_image_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf 'MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST muss der nackte attestierte sha256-Digest sein.\n' >&2
    exit 65
  fi
  if ! referenced_legacy_image_digest=$(image_reference_digest "$legacy_image_reference"); then
    printf 'MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE muss eine exakte lokale sha256-Image-ID oder eine kleingeschriebene Repository@sha256-Referenz sein.\n' >&2
    exit 65
  fi
  if [[ "$referenced_legacy_image_digest" != "$legacy_image_digest" ]]; then
    printf 'MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE bindet nicht exakt den attestierten MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST.\n' >&2
    exit 65
  fi
  if [[ "$current_image_digest" == "$legacy_image_digest" ]]; then
    printf 'Aktuelles Pruefer-Image und attestierte Legacy-Runtime muessen getrennte Digests besitzen.\n' >&2
    exit 65
  fi
  if ! current_odoo_image_digest=$(image_reference_digest "$current_odoo_image_reference"); then
    printf 'ZUGFOLGE_ODOO_IMAGE_REFERENCE muss eine exakte lokale sha256-Image-ID oder eine kleingeschriebene Repository@sha256-Referenz sein.\n' >&2
    exit 65
  fi
  if [[ ! "$legacy_odoo_image_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf 'PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST muss der nackte attestierte sha256-Digest sein.\n' >&2
    exit 65
  fi
  if ! referenced_legacy_odoo_image_digest=$(image_reference_digest "$legacy_odoo_image_reference"); then
    printf 'PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE muss eine exakte lokale sha256-Image-ID oder eine kleingeschriebene Repository@sha256-Referenz sein.\n' >&2
    exit 65
  fi
  if [[ "$referenced_legacy_odoo_image_digest" != "$legacy_odoo_image_digest" ]]; then
    printf 'PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE bindet nicht exakt den attestierten PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST.\n' >&2
    exit 65
  fi
  if [[ "$current_odoo_image_digest" == "$legacy_odoo_image_digest" ]]; then
    printf 'Aktuelles Odoo-Image und attestiertes Legacy-Odoo-Image muessen getrennte Digests besitzen.\n' >&2
    exit 65
  fi
fi
resolved_keycloak_schema_evidence_host_dir=
resolved_keycloak_schema_backup_host_dir=
if ((keycloak_after_schema33 == 1 || keycloak_recover_after_schema33 == 1 || prepare_v2_hot == 1)); then
  if ((keycloak_schema_evidence_host_dir_count != 1)) || [[ -z "$keycloak_schema_evidence_host_dir" ]]; then
    printf '.env muss KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR fuer den Keycloak-Cutover genau einmal setzen.\n' >&2
    exit 65
  fi
  if ((keycloak_schema_backup_host_dir_count != 1)) || [[ -z "$keycloak_schema_backup_host_dir" ]]; then
    printf '.env muss KEYCLOAK_SCHEMA_BACKUP_HOST_DIR fuer den Keycloak-Cutover genau einmal setzen.\n' >&2
    exit 65
  fi
  if ((keycloak_schema_restore_database_count != 1)) \
    || [[ ! "$keycloak_schema_restore_database" =~ ^zugfolge_restore_[a-z0-9_]+$ ]] \
    || ((postgres_database_count != 1)) \
    || [[ ! "$postgres_database" =~ ^[a-z_][a-z0-9_]*$ ]] \
    || [[ "$keycloak_schema_restore_database" == "$postgres_database" ]] \
    || [[ "$keycloak_schema_restore_database" == "$production_recovery_game_verify_database" ]]; then
    printf '.env muss KEYCLOAK_SCHEMA_RESTORE_DATABASE genau einmal als eigenes isoliertes Keycloak-Restore-Ziel setzen.\n' >&2
    exit 65
  fi
  if ((keycloak_schema_receipt_container_path_count != 1)) \
    || ((keycloak_schema_receipt_output_container_path_count != 1)) \
    || [[ ! "$keycloak_schema_receipt_container_path" =~ ^/keycloak-schema/[a-z0-9._-]+\.json$ ]] \
    || [[ "$keycloak_schema_receipt_output_container_path" != "$keycloak_schema_receipt_container_path" ]]; then
    printf '.env muss Keycloak-Up-Receipt-Eingang und -Ausgabe genau einmal auf denselben engen /keycloak-schema/*.json-Pfad setzen.\n' >&2
    exit 65
  fi
  resolved_keycloak_schema_evidence_host_dir=$(validate_recovery_host_root KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR "$keycloak_schema_evidence_host_dir")
  resolved_keycloak_schema_backup_host_dir=$(validate_recovery_host_root KEYCLOAK_SCHEMA_BACKUP_HOST_DIR "$keycloak_schema_backup_host_dir")
  if [[ "$resolved_keycloak_schema_evidence_host_dir" == "$resolved_keycloak_schema_backup_host_dir" \
    || "$resolved_keycloak_schema_evidence_host_dir/" == "$resolved_keycloak_schema_backup_host_dir/"* \
    || "$resolved_keycloak_schema_backup_host_dir/" == "$resolved_keycloak_schema_evidence_host_dir/"* ]]; then
    printf 'Keycloak-Evidence und Keycloak-Backup brauchen getrennte, nicht verschachtelte Hostpfade.\n' >&2
    exit 65
  fi
fi

if ((map_release_root_count != 1)) || [[ -z "$map_release_root" ]]; then
  printf '.env muss MAP_RELEASE_DEPLOYMENT_HOST_ROOT genau einmal setzen.\n' >&2
  exit 65
fi
if [[ ! "$map_release_root" =~ ^[A-Za-z0-9_./-]+$ ]] || [[ "/$map_release_root/" == */../* ]]; then
  printf 'MAP_RELEASE_DEPLOYMENT_HOST_ROOT ist kein sicherer Hostpfad.\n' >&2
  exit 65
fi
if [[ "$map_release_root" == / || "$map_release_root" == . || "$map_release_root" == ./ ]]; then
  printf 'MAP_RELEASE_DEPLOYMENT_HOST_ROOT darf keine breite Dateisystem- oder Repositorywurzel sein.\n' >&2
  exit 65
fi
if [[ ! -d "$map_release_root" || -L "$map_release_root" ]]; then
  printf 'MAP_RELEASE_DEPLOYMENT_HOST_ROOT fehlt oder ist ein Symlink.\n' >&2
  exit 65
fi

pointer_file="$map_release_root/active/map-release.env"
if [[ ! -f "$pointer_file" || -L "$pointer_file" ]]; then
  printf 'Der aktive Kartenrelease-Pointer fehlt oder ist ein Symlink: %s\n' "$pointer_file" >&2
  exit 65
fi
if [[ -n "$(tail -c 1 -- "$pointer_file")" ]]; then
  printf 'Der aktive Kartenrelease-Pointer muss mit genau einer LF-Zeile enden.\n' >&2
  exit 65
fi

declare -A pointer_values=()
pointer_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == *$'\r' ]] || [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=([^[:space:]\"\']+)$ ]]; then
    printf 'Der aktive Kartenrelease-Pointer ist keine kanonische LF-KEY=VALUE-Datei.\n' >&2
    exit 65
  fi
  key=${BASH_REMATCH[1]}
  value=${BASH_REMATCH[2]}
  case "$key" in
    MAP_RELEASE_ID|MAP_RELEASE_HOST_DIR|MAP_BASEMAP_STYLE_URL|MAP_GERMANY_PMTILES_URL) ;;
    *)
      printf 'Der aktive Kartenrelease-Pointer enthaelt einen fremden Schluessel: %s\n' "$key" >&2
      exit 65
      ;;
  esac
  if [[ -v "pointer_values[$key]" ]]; then
    printf 'Der aktive Kartenrelease-Pointer enthaelt einen doppelten Schluessel: %s\n' "$key" >&2
    exit 65
  fi
  pointer_values[$key]=$value
  ((pointer_count += 1))
done < "$pointer_file"

if ((pointer_count != 4)); then
  printf 'Der aktive Kartenrelease-Pointer muss genau vier Kartenwerte enthalten.\n' >&2
  exit 65
fi
release_id=${pointer_values[MAP_RELEASE_ID]:-}
if [[ ! "$release_id" =~ ^[a-z0-9][a-z0-9._-]*-20[0-9]{2}\.[1-9][0-9]*$ ]]; then
  printf 'MAP_RELEASE_ID im aktiven Pointer ist kein unveraenderlicher Jahres-Patchrelease.\n' >&2
  exit 65
fi
if [[ ${pointer_values[MAP_RELEASE_HOST_DIR]:-} != "releases/$release_id" ]] \
  || [[ ${pointer_values[MAP_BASEMAP_STYLE_URL]:-} != "/artifacts/maps/$release_id/style.json" ]] \
  || [[ ${pointer_values[MAP_GERMANY_PMTILES_URL]:-} != "/artifacts/maps/$release_id/$release_id.pmtiles" ]]; then
  printf 'Der aktive Kartenrelease-Pointer bindet Pfad, URLs und Release-ID nicht konsistent.\n' >&2
  exit 65
fi
if ((prepare_v2_schema31 == 1 || prepare_v2_cold == 1 || schema33_after_cold == 1 || keycloak_after_schema33 == 1 || keycloak_recover_after_schema33 == 1 || prepare_v2_hot == 1 \
  || attested_rollback == 1 || attested_rollback_stop == 1)) \
  && [[ "$release_id" != "$production_recovery_previous_release_id" ]]; then
  printf 'Recovery-Vorbereitung und Rollback muessen vom exakt gebundenen Vorgaengerrelease starten.\n' >&2
  exit 65
fi
if ((quiesced_cutover == 1)) && [[ "$release_id" != "$production_recovery_candidate_release_id" ]]; then
  printf 'Der quieszierende Cutover darf nur den exakt gebundenen Kandidatenrelease aktivieren.\n' >&2
  exit 65
fi

pointer_snapshot=$compose_env_snapshot_dir/map-release.env
printf 'MAP_RELEASE_ID=%s\nMAP_RELEASE_HOST_DIR=%s\nMAP_BASEMAP_STYLE_URL=%s\nMAP_GERMANY_PMTILES_URL=%s\n' \
  "$release_id" \
  "${pointer_values[MAP_RELEASE_HOST_DIR]}" \
  "${pointer_values[MAP_BASEMAP_STYLE_URL]}" \
  "${pointer_values[MAP_GERMANY_PMTILES_URL]}" > "$pointer_snapshot"
chmod 600 "$pointer_snapshot"

legacy_pointer_snapshot=$compose_env_snapshot_dir/legacy-map-release.env
printf 'MAP_RELEASE_ID=%s\nMAP_RELEASE_HOST_DIR=%s\nMAP_BASEMAP_STYLE_URL=%s\nMAP_GERMANY_PMTILES_URL=%s\n' \
  "$production_recovery_previous_release_id" \
  "releases/$production_recovery_previous_release_id" \
  "/artifacts/maps/$production_recovery_previous_release_id/style.json" \
  "/artifacts/maps/$production_recovery_previous_release_id/$production_recovery_previous_release_id.pmtiles" > "$legacy_pointer_snapshot"
chmod 600 "$legacy_pointer_snapshot"

for argument in "$@"; do
  case "$argument" in
    --prepare-v2-schema31|--prepare-v2-cold|--schema33-after-cold|--keycloak-after-schema33|--keycloak-recover-after-schema33|--prepare-v2-hot|--quiesced-cutover|--attested-rollback|--attested-rollback-stop|--fixed-stop)
      printf 'Der Wrappermodus muss das erste Wrapperargument sein.\n' >&2
      exit 64
      ;;
    --env-file|--env-file=*|--project-directory|--project-directory=*|-p|--project-name|--project-name=*|-p*)
      printf 'Zusaetzliche Compose-Envfiles, Projektverzeichnisse oder Projektnamen sind nicht erlaubt.\n' >&2
      exit 64
      ;;
    *MAP_RELEASE_*=*|*MAP_BASEMAP_STYLE_URL=*|*MAP_GERMANY_PMTILES_URL=*|*ZUGFOLGE_GAME_API_IMAGE_REFERENCE=*|*ZUGFOLGE_ODOO_IMAGE_REFERENCE=*)
      printf 'Kartenrelease- und Preflightwerte duerfen nicht als Compose-Argument ueberschrieben werden.\n' >&2
      exit 64
      ;;
  esac
done

compose_action=
compose_up_requested=0
for argument in "$@"; do
  if [[ "$argument" == up ]]; then
    compose_up_requested=1
    compose_action=up
  elif [[ "$argument" == down || "$argument" == config || "$argument" == build || "$argument" == run ]]; then
    compose_action=$argument
  fi
done

if [[ "$compose_action" == run ]] && ((prepare_v2_schema31 == 0 && prepare_v2_cold == 0 && schema33_after_cold == 0 && keycloak_after_schema33 == 0 && keycloak_recover_after_schema33 == 0)); then
  run_without_dependencies=0
  for argument in "$@"; do
    if [[ "$argument" == --no-deps ]]; then run_without_dependencies=1; fi
  done
  for argument in "$@"; do
    if [[ "$argument" == game-migrate || "$argument" == game-schema31-migrate || "$argument" == game-schema31-qualify || "$argument" == game-schema33-migrate ]]; then
      printf 'Eine direkte Schema-Migration ist gesperrt; initial sind ausschliesslich --prepare-v2-schema31 und --schema33-after-cold zulaessig.\n' >&2
      exit 64
    fi
    if ((run_without_dependencies == 1)); then
      case "$argument" in
        odoo-upgrade|keycloak-schema-migrate|keycloak-schema-restore|keycloak-reconcile|keycloak|game-bootstrap|game-api|odoo|alpha-ops|production-recovery-material|production-recovery-cold-qualify|production-recovery-proof)
          printf 'Ein mutierender oder privilegierter One-shot darf sein automatisches Production-Recovery-Gate nicht mit --no-deps umgehen.\n' >&2
          exit 64
          ;;
      esac
    fi
  done
fi

image_build=0
if [[ "$compose_action" == build ]]; then
  if (($# != 3)) || [[ ${1:-} != -f && ${1:-} != --file ]] || [[ ${3:-} != build ]]; then
    printf 'Der Imagebau erlaubt ausschliesslich -f KANONISCHE_COMPOSE_DATEI build.\n' >&2
    exit 64
  fi
  image_build=1
fi

if ((attested_rollback == 1)); then
  if (($# != 8)) \
    || [[ ${1:-} != -f && ${1:-} != --file ]] \
    || [[ ${3:-} != up || ${4:-} != --no-build || ${5:-} != --force-recreate ]] \
    || [[ ${6:-} != --wait || ${7:-} != --wait-timeout || ! ${8:-} =~ ^[1-9][0-9]*$ ]]; then
    printf 'Der attestierte Rollback erlaubt ausschliesslich den kanonischen Gesamtstack-Start: -f DATEI up --no-build --force-recreate --wait --wait-timeout SEKUNDEN.\n' >&2
    exit 64
  fi
fi

if ((attested_rollback_stop == 1)); then
  if (($# != 3)) || [[ ${1:-} != -f && ${1:-} != --file ]] || [[ ${3:-} != down ]]; then
    printf 'Der attestierte Rollback-Stop erlaubt ausschliesslich -f KANONISCHE_COMPOSE_DATEI down.\n' >&2
    exit 64
  fi
fi

if ((prepare_v2_schema31 == 1 || prepare_v2_cold == 1 || schema33_after_cold == 1 || keycloak_after_schema33 == 1 || keycloak_recover_after_schema33 == 1 || prepare_v2_hot == 1)); then
  if (($# != 2)) || [[ ${1:-} != -f && ${1:-} != --file ]]; then
    printf 'Recovery-Vorbereitung erlaubt ausschliesslich -f KANONISCHE_COMPOSE_DATEI.\n' >&2
    exit 64
  fi
fi

if ((quiesced_cutover == 1)); then
  canonical_cutover=0
  if (($# == 5)) \
    && [[ ${1:-} == -f || ${1:-} == --file ]] \
    && [[ ${3:-} == up && ${4:-} == --no-build && ${5:-} == --wait ]]; then
    canonical_cutover=1
  elif (($# == 7)) \
    && [[ ${1:-} == -f || ${1:-} == --file ]] \
    && [[ ${3:-} == up && ${4:-} == --no-build && ${5:-} == --wait ]] \
    && [[ ${6:-} == --wait-timeout && ${7:-} =~ ^[1-9][0-9]*$ ]]; then
    canonical_cutover=1
  fi
  if ((canonical_cutover != 1)); then
    printf 'Der quieszierende Cutovermodus erlaubt ausschliesslich den kanonischen Gesamtstack-Start: -f DATEI up --no-build --wait [--wait-timeout SEKUNDEN].\n' >&2
    exit 64
  fi
elif [[ "$preflight_mode" == active-candidate ]] && ((compose_up_requested == 1)); then
  printf 'Ein aktiver Produktionsstart braucht --quiesced-cutover, damit kein alter Game-Writer den Weltwechsel ueberlebt.\n' >&2
  exit 64
fi

# Shellwerte haben bei der Compose-Interpolation Vorrang vor --env-file. Diese
# Releasewerte duerfen deshalb ausschliesslich aus den beiden festen Dateien
# stammen; map-release.env ist absichtlich die zuletzt geladene Datei.
unset MAP_RELEASE_DEPLOYMENT_HOST_ROOT MAP_RELEASE_ID MAP_RELEASE_HOST_DIR
unset MAP_BASEMAP_STYLE_URL MAP_GERMANY_PMTILES_URL COMPOSE_ENV_FILES
unset MAP_RELEASE_PREFLIGHT_HOST_DIR MAP_RELEASE_RESTORE_HOST_DIR
unset MAP_RELEASE_START_PREFLIGHT_MODE
unset ZUGFOLGE_GAME_API_IMAGE_REFERENCE MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST
unset MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE
unset MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH
unset MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT
unset MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH
unset ZUGFOLGE_ODOO_IMAGE_REFERENCE PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST
unset PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE
unset PRODUCTION_RECOVERY_ID PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID
unset PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID
unset PRODUCTION_RECOVERY_EVIDENCE_HOST_ROOT PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT
unset PRODUCTION_RECOVERY_BACKUP_HOST_ROOT PRODUCTION_COLD_GAME_RESTORE_DATABASE
unset PRODUCTION_COLD_ODOO_RESTORE_DATABASE PRODUCTION_RECOVERY_GAME_VERIFY_DATABASE
unset PRODUCTION_SCHEMA29_GAME_RESTORE_DATABASE PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE
unset PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_DATABASE PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE
unset PRODUCTION_RECOVERY_GAME_RESTORE_DATABASE PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE
unset PRODUCTION_RECOVERY_ACTION_TIMEOUT_MS PRODUCTION_RECOVERY_ODOO_RUNTIME_UID
unset PRODUCTION_RECOVERY_ODOO_RUNTIME_GID PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH
unset PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH PRODUCTION_RECOVERY_DOCKER_SOCKET_PATH
unset PRODUCTION_RECOVERY_SOURCE_ACTION_RECEIPT_OUTPUT_PATH PRODUCTION_RECOVERY_SOURCE_INTENT_OUTPUT_PATH
unset PRODUCTION_RECOVERY_CONTROL_SERVICE PRODUCTION_RECOVERY_LEGACY_GAME_SOURCE_COMMIT
unset PRODUCTION_RECOVERY_LEGACY_GAME_IMAGE_DIGEST
export MAP_RELEASE_START_PREFLIGHT_MODE="$preflight_mode"
if ((image_build == 1)); then
  # Nur der Build darf einen lokalen, mutablen Ausgabenamen erzeugen. Kein
  # Compose-run/up-Pfad erreicht diesen Wert; der spaetere Start verwendet die
  # aus docker image inspect uebernommene unveraenderliche ID bzw. RepoDigest.
  export ZUGFOLGE_GAME_API_IMAGE_REFERENCE=zugfolge-game-api
  export ZUGFOLGE_ODOO_IMAGE_REFERENCE=zugfolge-odoo:alpha
fi

compose_command=(docker compose \
  --env-file "$base_env_snapshot" \
  --env-file "$pointer_snapshot" \
  --project-name "$compose_project" \
  --project-directory "$repository_root")

if ((attested_rollback == 1 || attested_rollback_stop == 1 || quiesced_cutover == 1)); then
  if [[ ! -f "$rollback_compose_template" || -L "$rollback_compose_template" ]]; then
    printf 'Der versionierte Legacy-Compose-Vertrag fehlt oder ist ein Symlink.\n' >&2
    exit 65
  fi
  if [[ "$rollback_compose_file" != "$rollback_compose_template" ]] \
    && { [[ ! -f "$rollback_compose_file" || -L "$rollback_compose_file" ]] \
      || ! cmp --silent -- "$rollback_compose_template" "$rollback_compose_file"; }; then
    printf 'Die installierte compose.rollback.yml stimmt nicht bytegleich mit der Repo-Vorlage compose.alpha.rollback.yml ueberein.\n' >&2
    exit 65
  fi
fi

if ((quiesced_cutover == 1 || attested_rollback == 1 || attested_rollback_stop == 1 || prepare_v2_schema31 == 1 || prepare_v2_cold == 1 || schema33_after_cold == 1 || keycloak_after_schema33 == 1 || keycloak_recover_after_schema33 == 1 || prepare_v2_hot == 1)); then
  if ((attested_rollback == 1)); then
    orchestration_timeout=${8}
  elif ((quiesced_cutover == 1)) && (($# == 7)); then
    orchestration_timeout=${7}
  else
    orchestration_timeout=600
  fi
  current_compose=("${compose_command[@]}" -f "$resolved_compose_file")
  legacy_compose=("${compose_command[@]}" --env-file "$legacy_pointer_snapshot" -f "$resolved_compose_file" -f "$rollback_compose_file")

  stop_runtime_services() {
    "${current_compose[@]}" --profile operations --profile keycloak-schema-migration --profile production-recovery-preparation \
      stop --timeout 60 "${runtime_services[@]}"
  }

  remove_runtime_services() {
    "${current_compose[@]}" --profile operations --profile keycloak-schema-migration --profile production-recovery-preparation \
      rm --force "${runtime_services[@]}"
  }

  start_database_services() {
    "${current_compose[@]}" up --no-recreate --no-deps --no-build --wait \
      --wait-timeout "$orchestration_timeout" postgres odoo-postgres
  }

  start_preparation_database_services() {
    "${current_compose[@]}" --profile production-recovery-preparation \
      up --no-recreate --no-deps --no-build --wait --wait-timeout "$orchestration_timeout" \
      postgres odoo-postgres recovery-verify-postgres recovery-verify-odoo-postgres
  }

  run_recovery_action() {
    local action=$1
    local action_receipt="/production-recovery/${production_recovery_id}.${action}.json"
    local activation_intent="/production-recovery/${production_recovery_id}.activate.intent.json"
    (
      export PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH="$action_receipt"
      export PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH="$activation_intent"
      "${current_compose[@]}" run --rm --no-deps \
        -e PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH \
        -e PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH \
        production-recovery-action \
        node tools/alpha-ops/activate-production-recovery.mjs "$action"
    )
  }

  run_recovery_continuation() {
    local action_receipt="/production-recovery/${production_recovery_id}.continue.json"
    local activation_intent="/production-recovery/${production_recovery_id}.activate.intent.json"
    (
      export PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH="$action_receipt"
      export PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH="$activation_intent"
      "${current_compose[@]}" run --rm --no-deps \
        -e PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH \
        -e PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH \
        production-recovery-action \
        node tools/alpha-ops/continue-production-recovery.mjs
    )
  }

  run_source_action() {
    local action=$1
    local action_receipt="/production-recovery/${production_recovery_id}.source-${action}.json"
    local source_intent="/production-recovery/${production_recovery_id}.source-${action}.intent.json"
    (
      export PRODUCTION_RECOVERY_SOURCE_ACTION_RECEIPT_OUTPUT_PATH="$action_receipt"
      export PRODUCTION_RECOVERY_SOURCE_INTENT_OUTPUT_PATH="$source_intent"
      "${current_compose[@]}" run --rm --no-deps \
        -e PRODUCTION_RECOVERY_SOURCE_ACTION_RECEIPT_OUTPUT_PATH \
        -e PRODUCTION_RECOVERY_SOURCE_INTENT_OUTPUT_PATH \
        production-recovery-action \
        node tools/alpha-ops/switch-production-recovery-source.mjs "$action"
    )
  }

  run_recovery_material() {
    "${current_compose[@]}" --profile production-recovery-preparation \
      run --rm --no-deps production-recovery-material "$@"
  }

  run_schema29_odoo_filestore_access() {
    local action=$1
    "${current_compose[@]}" --profile production-recovery-preparation \
      run --rm --no-deps production-schema29-odoo-filestore-access \
      node tools/alpha-ops/schema29-odoo-filestore-access.mjs "$action"
  }

  run_quiesced_keycloak_schema_command() {
    local action=$1
    "${current_compose[@]}" --profile keycloak-schema-migration \
      run --rm --no-deps \
      -e KEYCLOAK_SCHEMA_WRITERS_QUIESCED=true \
      keycloak-schema-migrate \
      node tools/alpha-ops/keycloak-public-to-schema.mjs "$action"
  }

  preparation_fail_closed() {
    stop_runtime_services || true
    if ((prepare_v2_schema31 == 1)); then
      schema29_filestore_open_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-odoo-filestore-open.json"
      schema29_filestore_seal_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-odoo-filestore-seal.json"
      if [[ -f "$schema29_filestore_open_host_path" && ! -e "$schema29_filestore_seal_host_path" && ! -L "$schema29_filestore_open_host_path" ]]; then
        run_schema29_odoo_filestore_access emergency-reseal || \
          printf 'WARNUNG: Der Schema-29-Odoo-Runtime-Filestore konnte nach dem Fehler nicht bestaetigt read-only versiegelt werden.\n' >&2
      fi
    fi
    printf 'Die Recovery-Vorbereitung ist fehlgeschlagen; Anwendungswriter bleiben gestoppt und vorhandene Datenbankcontainer unangetastet.\n' >&2
  }

  if ((prepare_v2_schema31 == 1)); then
    preparation_completed=0
    preparation_exit_cleanup() {
      local original_status=$?
      trap - EXIT INT TERM
      if ((preparation_completed == 0)); then preparation_fail_closed; fi
      cleanup_compose_env_snapshot
      exit "$original_status"
    }
    trap preparation_exit_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    stop_runtime_services
    start_preparation_database_services
    schema29_receipt_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-cold-qualified.json"
    if [[ -e "$schema29_receipt_host_path" || -L "$schema29_receipt_host_path" ]]; then
      if [[ ! -f "$schema29_receipt_host_path" || -L "$schema29_receipt_host_path" ]]; then
        printf 'Der vorhandene Schema-29-Vollbackup-Beleg ist keine regulaere symlinkfreie Datei.\n' >&2
        exit 65
      fi
    else
      run_recovery_material -eu -c '
        sh /ops/alpha/backup-game.sh \
          "$PRODUCTION_COLD_GAME_DATABASE_URL" \
          "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.game.dump" \
          "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.game.manifest.json" \
          "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.game.operation.json"
      '
      run_recovery_material -eu -c '
        sh /ops/alpha/backup-odoo.sh \
          "$PRODUCTION_COLD_ODOO_DATABASE_URL" \
          "$PRODUCTION_COLD_ODOO_LIVE_FILESTORE_PATH" \
          /recovery-material \
          "$PRODUCTION_RECOVERY_ID.schema29.odoo" \
          "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.odoo.operation.json"
      '
      run_recovery_material -eu -c '
        sh /ops/alpha/restore-game-recovery.sh \
          "$PRODUCTION_SCHEMA29_GAME_RESTORE_ADMIN_DATABASE_URL" \
          "$PRODUCTION_SCHEMA29_GAME_RESTORE_DATABASE" \
          "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.game.dump" \
          "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.game.manifest.json" \
          "$PRODUCTION_RECOVERY_ID" \
          "/production-recovery/$PRODUCTION_RECOVERY_ID.schema29.game-restore.json"
      '
      run_recovery_material -eu -c '
        sh /ops/alpha/restore-odoo-recovery.sh \
          "$PRODUCTION_SCHEMA29_ODOO_RESTORE_ADMIN_DATABASE_URL" \
          "$PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE" \
          "/odoo-recovery-filestore/$PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE" \
          "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.odoo" \
          "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.odoo.manifest.json" \
          "$PRODUCTION_RECOVERY_ID" \
          "/production-recovery/$PRODUCTION_RECOVERY_ID.schema29.odoo-restore.json"
      '
      "${current_compose[@]}" --profile production-recovery-preparation \
        run --rm --no-deps production-recovery-schema29-cold-qualify
    fi

    schema29_runtime_receipt_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-runtime-drill.json"
    if [[ -e "$schema29_runtime_receipt_host_path" || -L "$schema29_runtime_receipt_host_path" ]]; then
      if [[ ! -f "$schema29_runtime_receipt_host_path" || -L "$schema29_runtime_receipt_host_path" ]]; then
        printf 'Der vorhandene Schema-29-Legacy-Runtime-Beleg ist keine regulaere symlinkfreie Datei.\n' >&2
        exit 65
      fi
    else
      schema29_runtime_game_restore_receipt="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-runtime.game-restore.json"
      if [[ -e "$schema29_runtime_game_restore_receipt" || -L "$schema29_runtime_game_restore_receipt" ]]; then
        if [[ ! -f "$schema29_runtime_game_restore_receipt" || -L "$schema29_runtime_game_restore_receipt" ]]; then
          printf 'Der Schema-29-Game-Runtime-Restore-Beleg ist keine regulaere symlinkfreie Datei.\n' >&2
          exit 65
        fi
      else
        run_recovery_material -eu -c '
          sh /ops/alpha/restore-game-recovery.sh \
            "$PRODUCTION_SCHEMA29_GAME_RESTORE_ADMIN_DATABASE_URL" \
            "$PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_DATABASE" \
            "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.game.dump" \
            "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.game.manifest.json" \
            "$PRODUCTION_RECOVERY_ID" \
            "/production-recovery/$PRODUCTION_RECOVERY_ID.schema29-runtime.game-restore.json"
        '
      fi
      schema29_runtime_odoo_restore_receipt="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-runtime.odoo-restore.json"
      if [[ -e "$schema29_runtime_odoo_restore_receipt" || -L "$schema29_runtime_odoo_restore_receipt" ]]; then
        if [[ ! -f "$schema29_runtime_odoo_restore_receipt" || -L "$schema29_runtime_odoo_restore_receipt" ]]; then
          printf 'Der Schema-29-Odoo-Runtime-Restore-Beleg ist keine regulaere symlinkfreie Datei.\n' >&2
          exit 65
        fi
      else
        run_recovery_material -eu -c '
          sh /ops/alpha/restore-odoo-recovery.sh \
            "$PRODUCTION_SCHEMA29_ODOO_RESTORE_ADMIN_DATABASE_URL" \
            "$PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE" \
            "/odoo-recovery-filestore/$PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE" \
            "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.odoo" \
            "/recovery-material/$PRODUCTION_RECOVERY_ID.schema29.odoo.manifest.json" \
            "$PRODUCTION_RECOVERY_ID" \
            "/production-recovery/$PRODUCTION_RECOVERY_ID.schema29-runtime.odoo-restore.json"
        '
      fi
      schema29_runtime_filestore_host_path="$resolved_recovery_filestore_root/$production_schema29_runtime_odoo_restore_database"
      if [[ ! -d "$schema29_runtime_filestore_host_path" || -L "$schema29_runtime_filestore_host_path" ]] \
        || [[ "$(cd -- "$schema29_runtime_filestore_host_path" && pwd -P)" != "$schema29_runtime_filestore_host_path" ]]; then
        printf 'Der Schema-29-Odoo-Runtime-Filestore ist nicht das vorhandene symlinkfreie direkte Kind der physischen Recovery-Wurzel.\n' >&2
        exit 65
      fi
      schema29_runtime_before_receipt="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-runtime-before.json"
      if [[ -e "$schema29_runtime_before_receipt" || -L "$schema29_runtime_before_receipt" ]]; then
        if [[ ! -f "$schema29_runtime_before_receipt" || -L "$schema29_runtime_before_receipt" ]]; then
          printf 'Der Schema-29-Runtime-Vorher-Snapshot ist keine regulaere symlinkfreie Datei.\n' >&2
          exit 65
        fi
      else
        "${current_compose[@]}" --profile production-recovery-preparation \
          run --rm --no-deps production-schema29-runtime-snapshot
      fi
      schema29_filestore_open_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-odoo-filestore-open.json"
      schema29_filestore_seal_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-odoo-filestore-seal.json"
      if [[ -e "$schema29_filestore_open_host_path" || -L "$schema29_filestore_open_host_path" || -e "$schema29_filestore_seal_host_path" || -L "$schema29_filestore_seal_host_path" ]]; then
        printf 'Schema-29-Odoo-Filestore-Open-/Seal-Belege existieren bereits; der Runtime-Drill ist create-new.\n' >&2
        exit 65
      fi
      run_schema29_odoo_filestore_access open
      "${current_compose[@]}" --profile production-recovery-preparation \
        up --no-deps --no-build --force-recreate --wait --wait-timeout 7200 \
        schema29-keycloak-runtime schema29-game-runtime schema29-odoo-runtime
      schema29_game_probe_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-game-runtime-write.json"
      if [[ -e "$schema29_game_probe_host_path" || -L "$schema29_game_probe_host_path" ]]; then
        if [[ ! -f "$schema29_game_probe_host_path" || -L "$schema29_game_probe_host_path" ]]; then
          printf 'Der Schema-29-Game-App-Schreibbeleg ist keine regulaere symlinkfreie Datei.\n' >&2
          exit 65
        fi
      else
        "${current_compose[@]}" --profile production-recovery-preparation \
          run --rm --no-deps legacy-game-schema29-write-probe
      fi
      schema29_odoo_probe_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema29-odoo-runtime-write.json"
      if [[ -e "$schema29_odoo_probe_host_path" || -L "$schema29_odoo_probe_host_path" ]]; then
        if [[ ! -f "$schema29_odoo_probe_host_path" || -L "$schema29_odoo_probe_host_path" ]]; then
          printf 'Der Schema-29-Odoo-ORM-Schreibbeleg ist keine regulaere symlinkfreie Datei.\n' >&2
          exit 65
        fi
      else
        "${current_compose[@]}" --profile production-recovery-preparation \
          run --rm --no-deps legacy-odoo-schema29-write-probe
      fi
      "${current_compose[@]}" --profile production-recovery-preparation \
        stop --timeout 60 schema29-odoo-runtime
      run_schema29_odoo_filestore_access seal
      "${current_compose[@]}" --profile production-recovery-preparation \
        up --no-deps --no-build --no-recreate --wait --wait-timeout "$orchestration_timeout" schema29-odoo-runtime
      (
        export PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH="$schema29_runtime_filestore_host_path"
        "${current_compose[@]}" --profile production-recovery-preparation \
          run --rm --no-deps -e PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH production-schema29-runtime-qualify
      )
      "${current_compose[@]}" --profile production-recovery-preparation \
        stop --timeout 60 schema29-game-runtime schema29-keycloak-runtime schema29-odoo-runtime
      "${current_compose[@]}" --profile production-recovery-preparation \
        rm --force schema29-game-runtime schema29-keycloak-runtime schema29-odoo-runtime
    fi
    "${current_compose[@]}" --profile production-recovery-preparation \
      run --rm --no-deps game-schema31-migrate
    schema31_probe_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema31-legacy-write.json"
    if [[ -e "$schema31_probe_host_path" || -L "$schema31_probe_host_path" ]]; then
      if [[ ! -f "$schema31_probe_host_path" || -L "$schema31_probe_host_path" ]]; then
        printf 'Der vorhandene Legacy-Schema-31-Schreibbeleg ist keine regulaere symlinkfreie Datei.\n' >&2
        exit 65
      fi
    else
      "${current_compose[@]}" --profile production-recovery-preparation \
        run --rm --no-deps legacy-game-schema31-write-probe
    fi
    "${current_compose[@]}" --profile production-recovery-preparation \
      run --rm --no-deps game-schema31-qualify
    run_recovery_material -eu -c '
      test "$(psql "$PRODUCTION_COLD_GAME_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations")" = 31
    '
    preparation_completed=1
    trap - EXIT INT TERM
    cleanup_compose_env_snapshot
    exit 0
  fi

  if ((prepare_v2_cold == 1)); then
    preparation_completed=0
    preparation_exit_cleanup() {
      local original_status=$?
      trap - EXIT INT TERM
      if ((preparation_completed == 0)); then preparation_fail_closed; fi
      cleanup_compose_env_snapshot
      exit "$original_status"
    }
    trap preparation_exit_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    stop_runtime_services
    start_preparation_database_services
    schema31_receipt_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.schema31-prepared.json"
    if [[ ! -f "$schema31_receipt_host_path" || -L "$schema31_receipt_host_path" ]]; then
      printf 'Der Schema-31-Cold-Drill verlangt zuerst den regulaeren symlinkfreien Schema-31-Vorbereitungsbeleg.\n' >&2
      exit 65
    fi
    run_recovery_material -eu -c '
      sh /ops/alpha/backup-game.sh \
        "$PRODUCTION_COLD_GAME_DATABASE_URL" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.cold.game.dump" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.cold.game.manifest.json" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.cold.game.operation.json"
    '
    run_recovery_material -eu -c '
      sh /ops/alpha/backup-odoo.sh \
        "$PRODUCTION_COLD_ODOO_DATABASE_URL" \
        "$PRODUCTION_COLD_ODOO_LIVE_FILESTORE_PATH" \
        /recovery-material \
        "$PRODUCTION_RECOVERY_ID.cold.odoo" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.cold.odoo.operation.json"
    '
    run_recovery_material -eu -c '
      sh /ops/alpha/restore-game-recovery.sh \
        "$PRODUCTION_COLD_GAME_RESTORE_ADMIN_DATABASE_URL" \
        "$PRODUCTION_COLD_GAME_RESTORE_DATABASE" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.cold.game.dump" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.cold.game.manifest.json" \
        "$PRODUCTION_RECOVERY_ID" \
        "/production-recovery/$PRODUCTION_RECOVERY_ID.cold.game-restore.json"
    '
    run_recovery_material -eu -c '
      sh /ops/alpha/restore-odoo-recovery.sh \
        "$PRODUCTION_COLD_ODOO_ADMIN_DATABASE_URL" \
        "$PRODUCTION_COLD_ODOO_RESTORE_DATABASE" \
        "/odoo-recovery-filestore/$PRODUCTION_COLD_ODOO_RESTORE_DATABASE" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.cold.odoo" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.cold.odoo.manifest.json" \
        "$PRODUCTION_RECOVERY_ID" \
        "/production-recovery/$PRODUCTION_RECOVERY_ID.cold.odoo-restore.json"
    '
    "${current_compose[@]}" --profile production-recovery-preparation \
      run --rm --no-deps production-recovery-cold-qualify
    preparation_completed=1
    trap - EXIT INT TERM
    cleanup_compose_env_snapshot
    exit 0
  fi

  if ((schema33_after_cold == 1)); then
    preparation_completed=0
    preparation_exit_cleanup() {
      local original_status=$?
      trap - EXIT INT TERM
      if ((preparation_completed == 0)); then preparation_fail_closed; fi
      cleanup_compose_env_snapshot
      exit "$original_status"
    }
    trap preparation_exit_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    stop_runtime_services
    start_preparation_database_services
    "${current_compose[@]}" --profile production-recovery-preparation \
      run --rm --no-deps game-schema33-migrate
    run_recovery_material -eu -c '
      test "$(psql "$PRODUCTION_COLD_GAME_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations")" = 33
    '
    preparation_completed=1
    trap - EXIT INT TERM
    cleanup_compose_env_snapshot
    exit 0
  fi

  if ((keycloak_after_schema33 == 1)); then
    preparation_completed=0
    preparation_exit_cleanup() {
      local original_status=$?
      trap - EXIT INT TERM
      if ((preparation_completed == 0)); then preparation_fail_closed; fi
      cleanup_compose_env_snapshot
      exit "$original_status"
    }
    trap preparation_exit_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    stop_runtime_services
    start_preparation_database_services
    run_recovery_material -eu -c '
      test "$(psql "$PRODUCTION_COLD_GAME_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations")" = 33
    '
    "${current_compose[@]}" --profile keycloak-schema-migration \
      run --rm --no-deps keycloak-schema-backup
    "${current_compose[@]}" --profile keycloak-schema-migration \
      run --rm --no-deps keycloak-schema-restore
    run_quiesced_keycloak_schema_command bind-backup
    run_quiesced_keycloak_schema_command plan-up
    if ! run_quiesced_keycloak_schema_command up; then
      # Ein Prozessabbruch nach dem DB-Commit, aber vor dem create-new Receipt,
      # wird ausschließlich gegen denselben Plan als Recover abgeschlossen.
      # Ist `up` vor dem Commit gescheitert, verweigert `recover` den Legacy- oder
      # Teilzustand und der gemeinsame Cleanup lässt alle Writer gestoppt.
      run_quiesced_keycloak_schema_command recover
    fi
    run_quiesced_keycloak_schema_command preflight-up
    preparation_completed=1
    trap - EXIT INT TERM
    cleanup_compose_env_snapshot
    exit 0
  fi

  if ((keycloak_recover_after_schema33 == 1)); then
    preparation_completed=0
    preparation_exit_cleanup() {
      local original_status=$?
      trap - EXIT INT TERM
      if ((preparation_completed == 0)); then preparation_fail_closed; fi
      cleanup_compose_env_snapshot
      exit "$original_status"
    }
    trap preparation_exit_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    stop_runtime_services
    start_preparation_database_services
    run_recovery_material -eu -c '
      test "$(psql "$PRODUCTION_COLD_GAME_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations")" = 33
    '
    run_quiesced_keycloak_schema_command recover
    run_quiesced_keycloak_schema_command preflight-up
    preparation_completed=1
    trap - EXIT INT TERM
    cleanup_compose_env_snapshot
    exit 0
  fi

  if ((prepare_v2_hot == 1)); then
    preparation_completed=0
    preparation_exit_cleanup() {
      local original_status=$?
      trap - EXIT INT TERM
      if ((preparation_completed == 0)); then preparation_fail_closed; fi
      cleanup_compose_env_snapshot
      exit "$original_status"
    }
    trap preparation_exit_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    stop_runtime_services
    start_preparation_database_services
    run_recovery_material -eu -c '
      test "$(psql "$PRODUCTION_COLD_GAME_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "select count(*) from drizzle.__drizzle_migrations")" = 33
    '
    run_quiesced_keycloak_schema_command preflight-up
    run_recovery_material -eu -c '
      sh /ops/alpha/backup-game.sh \
        "$PRODUCTION_RECOVERY_GAME_DATABASE_URL" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.game.dump" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.game.manifest.json" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.game.operation.json"
    '
    run_recovery_material -eu -c '
      sh /ops/alpha/backup-odoo.sh \
        "$PRODUCTION_RECOVERY_ODOO_DATABASE_URL" \
        "$PRODUCTION_RECOVERY_ODOO_LIVE_FILESTORE_PATH" \
        /recovery-material \
        "$PRODUCTION_RECOVERY_ID.hot.odoo" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.odoo.operation.json"
    '
    run_recovery_material -eu -c '
      sh /ops/alpha/restore-game.sh \
        "$PRODUCTION_RECOVERY_GAME_VERIFY_ADMIN_DATABASE_URL" \
        "$PRODUCTION_RECOVERY_GAME_VERIFY_DATABASE" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.game.dump" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.game.manifest.json" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.game-verify-restore.json"
    '
    run_recovery_material -eu -c '
      sh /ops/alpha/restore-game-recovery.sh \
        "$PRODUCTION_RECOVERY_GAME_LIVE_ADMIN_DATABASE_URL" \
        "$PRODUCTION_RECOVERY_GAME_RESTORE_DATABASE" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.game.dump" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.game.manifest.json" \
        "$PRODUCTION_RECOVERY_ID" \
        "/production-recovery/$PRODUCTION_RECOVERY_ID.hot.game-recovery.json"
    '
    run_recovery_material -eu -c '
      sh /ops/alpha/restore-odoo-recovery.sh \
        "$PRODUCTION_RECOVERY_ODOO_ADMIN_DATABASE_URL" \
        "$PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE" \
        "/odoo-recovery-filestore/$PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.odoo" \
        "/recovery-material/$PRODUCTION_RECOVERY_ID.hot.odoo.manifest.json" \
        "$PRODUCTION_RECOVERY_ID" \
        "/production-recovery/$PRODUCTION_RECOVERY_ID.hot.odoo-recovery.json"
    '
    "${current_compose[@]}" --profile production-recovery-preparation \
      run --rm --no-deps production-recovery-proof \
      node tools/alpha-ops/create-database-backup-restore-evidence.mjs
    "${current_compose[@]}" --profile production-recovery-preparation \
      run --rm --no-deps production-recovery-proof \
      node tools/alpha-ops/create-database-rollback-proof.mjs
    preparation_completed=1
    trap - EXIT INT TERM
    cleanup_compose_env_snapshot
    exit 0
  fi

  if ((quiesced_cutover == 1)); then
    cutover_completed=0
    cutover_cleanup_running=0
    cutover_fail_closed() {
      local status=0
      if ((cutover_cleanup_running == 1)); then
        return 1
      fi
      cutover_cleanup_running=1
      stop_runtime_services || status=1
      start_database_services || status=1
      run_source_action reseal || status=1
      cutover_cleanup_running=0
      return "$status"
    }
    cutover_exit_cleanup() {
      local original_status=$?
      trap - EXIT INT TERM
      if ((cutover_completed == 0)); then
        if ! cutover_fail_closed; then
          printf 'Der fehlgeschlagene V2-Start konnte nicht vollstaendig rueckgesperrt werden; Anwendungswriter bleiben gestoppt.\n' >&2
        fi
      fi
      cleanup_compose_env_snapshot
      exit "$original_status"
    }
    trap cutover_exit_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    stop_runtime_services
    start_database_services
    # `prepared` prueft das vollstaendige signierte V1-Recovery-Set, die
    # Writer-Inventur und beide persistenten Datenbankidentitaeten. Erst danach
    # werden die V2-Livequellen gekoppelt und mit create-new Belegen geoeffnet.
    run_recovery_action prepared
    run_source_action release
    remove_runtime_services

    cutover_up=(up --no-recreate --no-build --wait)
    if (($# == 7)); then
      cutover_up+=(--wait-timeout "${7}")
    fi
    "${current_compose[@]}" "${cutover_up[@]}"
    # Compose wartet absichtlich nur auf Prozess-Liveness. Die Aktivierung ist
    # erst erfolgreich, wenn der serverautoritative Catch-up vollstaendig
    # ready ist; aktueller Fortschritt darf dabei laenger als das Docker-
    # Retryfenster dauern. Bei Stillstand greift der bestehende Cleanup-Trap.
    "${current_compose[@]}" exec -T game-api node \
      tools/alpha-ops/wait-game-readiness.mjs \
      http://127.0.0.1:3000 \
      "${ZUGFOLGE_GAME_READY_MAX_WAIT_MS:-7200000}"
    cutover_completed=1
    trap - EXIT INT TERM
    cleanup_compose_env_snapshot
    exit 0
  fi

  rollback_cleanup_running=0
  rollback_fail_closed() {
    local status=0
    if ((rollback_cleanup_running == 1)); then
      return 1
    fi
    rollback_cleanup_running=1
    stop_runtime_services || status=1
    start_database_services || status=1
    run_recovery_action reseal || status=1
    run_source_action reseal || status=1
    if ((status == 0)); then
      # Nur Runtime-Container entfernen. Die beiden attestierten
      # Datenbankcontainer samt unveraenderlichen Container-IDs bleiben fuer
      # den naechsten `continue`-/Source-Gate bestehen.
      remove_runtime_services || status=1
    fi
    rollback_cleanup_running=0
    return "$status"
  }

  if ((attested_rollback_stop == 1)); then
    if ! rollback_fail_closed; then
      printf 'Der attestierte Rollback-Stop konnte den V1-Rueckweg nicht vollstaendig rueckversiegeln; Anwendungswriter bleiben gestoppt.\n' >&2
      exit 65
    fi
    exit 0
  fi

  rollback_completed=0
  rollback_exit_cleanup() {
    local original_status=$?
    trap - EXIT INT TERM
    if ((rollback_completed == 0)); then
      rollback_fail_closed || true
    fi
    cleanup_compose_env_snapshot
    exit "$original_status"
  }
  trap rollback_exit_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  stop_runtime_services
  start_database_services
  run_source_action reseal

  # Nur der aktuelle, digestgebundene Verifier darf den v3-Beleg auswerten.
  # Die alte Runtime behauptet ihren eigenen Digest nicht selbst.
  "${current_compose[@]}" run --rm --no-deps map-release-preflight
  activation_receipt_host_path="$resolved_recovery_evidence_root/${production_recovery_id}.activate.json"
  if [[ -e "$activation_receipt_host_path" ]]; then
    if [[ ! -f "$activation_receipt_host_path" || -L "$activation_receipt_host_path" ]]; then
      printf 'Der vorhandene Recovery-Aktivierungsbeleg ist keine regulaere symlinkfreie Datei.\n' >&2
      exit 65
    fi
    run_recovery_continuation
  else
    run_recovery_action preflight
    run_recovery_action activate
  fi

  start_legacy_stage() {
    if ! "${legacy_compose[@]}" up --no-deps --no-build --force-recreate --wait --wait-timeout "$orchestration_timeout" "$@"; then
      printf 'Der attestierte Legacy-Start ist fehlgeschlagen; bereits gestartete Legacy-Dienste werden wieder beendet.\n' >&2
      exit 1
    fi
  }

  # Keine V2-Migration, kein Welt-Cutover und kein aktueller Bootstrap laufen
  # gegen die restaurierte V1-Datenbank. Nur diese explizite Dienstfolge darf
  # nach dem aktuellen Verifier die alte Runtime wiederanlaufen lassen.
  start_legacy_stage keycloak
  legacy_revision_baseline=$(
    "${current_compose[@]}" run --rm --no-deps production-recovery-action \
      node tools/alpha-ops/wait-legacy-game-readiness.mjs baseline \
      | tail -n 1
  )
  start_legacy_stage game-api
  # Der alte Prozess darf Odoo und die Oberflaechen erst freigeben, nachdem der
  # aktuelle digestgebundene Pruefer sowohl /health/ready als auch mindestens
  # eine neue, publishergleiche autoritative Regionalrevision belegt hat.
  "${current_compose[@]}" run --rm --no-deps production-recovery-action \
    node tools/alpha-ops/wait-legacy-game-readiness.mjs wait \
    http://game-api:3000 \
    "$legacy_revision_baseline" \
    "${ZUGFOLGE_LEGACY_GAME_READY_MAX_WAIT_MS:-7200000}"
  start_legacy_stage odoo
  start_legacy_stage game-web livemap operations-center static
  start_legacy_stage prometheus grafana
  rollback_completed=1
  trap - EXIT INT TERM
  cleanup_compose_env_snapshot
  exit 0
fi

"${compose_command[@]}" "$@"
