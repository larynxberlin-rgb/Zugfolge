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
if [[ "$revision" != "$source_sha" || "$deploy_patch" != "none" ]]; then
  printf 'Image-Labels stimmen nicht mit dem freigegebenen Build ueberein.\n' >&2
  exit 1
fi
docker image inspect zugfolge-game-api --format '{{json .RepoDigests}} {{.Id}}'
docker image inspect zugfolge-odoo:alpha --format '{{json .RepoDigests}} {{.Id}}'
