#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
bash "$script_dir/compose-with-map-release-env.sh" -f compose.alpha.yml up --no-build --wait --wait-timeout 600
for url in \
  "http://localhost:${GAME_API_PORT:-3000}/health" \
  "http://localhost:${GAME_API_PORT:-3000}/health/ready" \
  "http://localhost:${GAME_WEB_PORT:-4173}/" \
  "http://localhost:${LIVEMAP_PORT:-4174}/" \
  "http://localhost:${OPERATIONS_CENTER_PORT:-4175}/" \
  "http://localhost:${KEYCLOAK_PORT:-8080}/realms/zugfolge/.well-known/openid-configuration" \
  "http://localhost:${ODOO_PORT:-8069}/web/health" \
  "http://localhost:${PROMETHEUS_PORT:-9090}/-/ready" \
  "http://localhost:${GRAFANA_PORT:-3001}/api/health"; do
  curl --fail --silent --show-error "$url" >/dev/null
  printf 'healthy %s\n' "$url"
done
printf 'Livemap: http://localhost:%s/\n' "${LIVEMAP_PORT:-4174}"
