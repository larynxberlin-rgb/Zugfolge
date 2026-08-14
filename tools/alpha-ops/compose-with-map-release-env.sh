#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository_root=$(cd -- "$script_dir/../.." && pwd -P)
cd "$repository_root"

compose_project=zugfolge

if (($# == 0)); then
  printf 'Aufruf: compose-with-map-release-env.sh [--attested-rollback|--fixed-stop] COMPOSE_ARGUMENTE...\n' >&2
  exit 64
fi

preflight_mode=active-candidate
fixed_stop=0
if [[ ${1:-} == --attested-rollback ]]; then
  preflight_mode=pre-activation
  shift
  if (($# == 0)); then
    printf 'Der attestierte Rollbackmodus braucht ein Compose-Kommando.\n' >&2
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

if ((fixed_stop == 1)); then
  if (($# != 3)) || [[ ${1:-} != -f && ${1:-} != --file ]] || [[ ${3:-} != down ]]; then
    printf 'Der feste Stopmodus erlaubt ausschliesslich -f KANONISCHE_COMPOSE_DATEI down.\n' >&2
    exit 64
  fi

  # `down` muss den bekannten Stack auch dann erreichen, wenn der aktive
  # Kartenzeiger fehlt oder beschaedigt ist. Sichere Dummywerte dienen nur der
  # Compose-Interpolation; es wird damit kein Container gestartet.
  unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES
  export MAP_RELEASE_DEPLOYMENT_HOST_ROOT="$repository_root/.fixed-stop-placeholder/maps"
  export MAP_RELEASE_PREFLIGHT_HOST_DIR="$repository_root/.fixed-stop-placeholder/preflight"
  export MAP_RELEASE_RESTORE_HOST_DIR="$repository_root/.fixed-stop-placeholder/restore"
  export MAP_RELEASE_ID=infra-stop-placeholder-2000.1
  export MAP_RELEASE_HOST_DIR=releases/infra-stop-placeholder-2000.1
  export MAP_BASEMAP_STYLE_URL=/artifacts/maps/infra-stop-placeholder-2000.1/style.json
  export MAP_GERMANY_PMTILES_URL=/artifacts/maps/infra-stop-placeholder-2000.1/infra-stop-placeholder-2000.1.pmtiles
  export MAP_RELEASE_START_PREFLIGHT_MODE=active-candidate

  stop_env_args=()
  if [[ -f .env && ! -L .env ]]; then
    stop_env_args=(--env-file .env)
  fi
  exec docker compose \
    "${stop_env_args[@]}" \
    --project-name "$compose_project" \
    --project-directory "$repository_root" \
    "$@"
fi

if [[ ! -f .env || -L .env ]]; then
  printf '.env fehlt oder ist kein regulaeres File ohne Symlink.\n' >&2
  exit 65
fi

map_release_root=
map_release_root_count=0
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
  esac
  if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(MAP_RELEASE_ID|MAP_RELEASE_HOST_DIR|MAP_BASEMAP_STYLE_URL|MAP_GERMANY_PMTILES_URL|MAP_RELEASE_START_PREFLIGHT_MODE|MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID)[[:space:]]*= ]]; then
    printf '.env darf keine Kartenrelease-ID, keinen Releasepfad, keine Karten-URL und keinen Preflightmodus enthalten; diese Werte kommen nur aus Pointer und explizitem Wrappermodus.\n' >&2
    exit 65
  fi
done < .env

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

for argument in "$@"; do
  case "$argument" in
    --attested-rollback|--fixed-stop)
      printf 'Der Wrappermodus muss das erste Wrapperargument sein.\n' >&2
      exit 64
      ;;
    --env-file|--env-file=*|--project-directory|--project-directory=*|-p|--project-name|--project-name=*|-p*)
      printf 'Zusaetzliche Compose-Envfiles, Projektverzeichnisse oder Projektnamen sind nicht erlaubt.\n' >&2
      exit 64
      ;;
    *MAP_RELEASE_*=*|*MAP_BASEMAP_STYLE_URL=*|*MAP_GERMANY_PMTILES_URL=*)
      printf 'Kartenrelease- und Preflightwerte duerfen nicht als Compose-Argument ueberschrieben werden.\n' >&2
      exit 64
      ;;
  esac
done

if [[ "$preflight_mode" == pre-activation ]]; then
  compose_action=
  has_force_recreate=0
  unsupported_action=0
  for argument in "$@"; do
    [[ "$argument" == up || "$argument" == down || "$argument" == config ]] && compose_action=$argument
    [[ "$argument" == --force-recreate ]] && has_force_recreate=1
    case "$argument" in
      build|config-hash|convert|cp|create|events|exec|images|kill|logs|ls|pause|port|ps|pull|push|restart|rm|run|start|stats|stop|top|unpause|version|wait|watch) unsupported_action=1 ;;
    esac
  done
  if [[ "$unsupported_action" == 1 ]]; then
    printf 'Der attestierte Rollbackmodus erlaubt kein anderes Compose-Kommando neben up, down oder config.\n' >&2
    exit 64
  fi
  if [[ "$compose_action" == up && "$has_force_recreate" != 1 ]]; then
    printf 'Der attestierte Rollbackstart muss alle Laufzeitcontainer mit up --force-recreate neu erzeugen.\n' >&2
    exit 64
  fi
  if [[ "$compose_action" != up && "$compose_action" != down && "$compose_action" != config ]]; then
    printf 'Der attestierte Rollbackmodus erlaubt nur Compose up, down oder config.\n' >&2
    exit 64
  fi
fi

# Shellwerte haben bei der Compose-Interpolation Vorrang vor --env-file. Diese
# Releasewerte duerfen deshalb ausschliesslich aus den beiden festen Dateien
# stammen; map-release.env ist absichtlich die zuletzt geladene Datei.
unset MAP_RELEASE_DEPLOYMENT_HOST_ROOT MAP_RELEASE_ID MAP_RELEASE_HOST_DIR
unset MAP_BASEMAP_STYLE_URL MAP_GERMANY_PMTILES_URL COMPOSE_ENV_FILES
unset MAP_RELEASE_START_PREFLIGHT_MODE
export MAP_RELEASE_START_PREFLIGHT_MODE="$preflight_mode"

exec docker compose \
  --env-file .env \
  --env-file "$pointer_file" \
  --project-name "$compose_project" \
  --project-directory "$repository_root" \
  "$@"
