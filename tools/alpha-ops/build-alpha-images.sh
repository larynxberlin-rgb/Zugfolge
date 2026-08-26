#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository_root=$(git -C "$script_dir" rev-parse --show-toplevel)
cd "$repository_root"

source_sha=$(node tools/alpha-ops/image-provenance.mjs)
export ZUGFOLGE_SOURCE_SHA="$source_sha"
export ZUGFOLGE_DEPLOY_PATCH_SHA=none

bash "$script_dir/compose-with-map-release-env.sh" -f "$repository_root/compose.alpha.yml" build

verified_source_sha=$(node tools/alpha-ops/image-provenance.mjs)
if [[ "$verified_source_sha" != "$source_sha" ]]; then
  printf 'Git-HEAD hat sich waehrend des Imagebaus geaendert.\n' >&2
  exit 1
fi

revision=$(docker image inspect zugfolge-game-api --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
deploy_patch=$(docker image inspect zugfolge-game-api --format '{{ index .Config.Labels "de.zugfolge.deploy-patch" }}')
odoo_revision=$(docker image inspect zugfolge-odoo:alpha --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
odoo_deploy_patch=$(docker image inspect zugfolge-odoo:alpha --format '{{ index .Config.Labels "de.zugfolge.deploy-patch" }}')
if [[ "$revision" != "$source_sha" || "$deploy_patch" != "none" \
  || "$odoo_revision" != "$source_sha" || "$odoo_deploy_patch" != "none" ]]; then
  printf 'Game-/Odoo-Image-Labels stimmen nicht mit dem freigegebenen Build ueberein.\n' >&2
  exit 1
fi
docker image inspect zugfolge-game-api --format '{{json .RepoDigests}} {{.Id}}'
docker image inspect zugfolge-odoo:alpha --format '{{json .RepoDigests}} {{.Id}}'
game_image_id=$(docker image inspect zugfolge-game-api --format '{{.Id}}')
odoo_image_id=$(docker image inspect zugfolge-odoo:alpha --format '{{.Id}}')
if [[ ! "$game_image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf 'Das gebaute Game-Image besitzt keine unveraenderliche sha256-Image-ID.\n' >&2
  exit 1
fi
if [[ ! "$odoo_image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf 'Das gebaute Odoo-Image besitzt keine unveraenderliche sha256-Image-ID.\n' >&2
  exit 1
fi
printf 'ZUGFOLGE_GAME_API_IMAGE_REFERENCE=%s\n' "$game_image_id"
printf 'ZUGFOLGE_ODOO_IMAGE_REFERENCE=%s\n' "$odoo_image_id"
