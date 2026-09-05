import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveImageProvenance } from "./image-provenance.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const run = promisify(execFile);
const fullStackMapPreflightEnvironment = Object.freeze([
  "MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH",
  "MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT",
  "MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST",
  "PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST",
  "MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH",
]);

function assertFullStackMapPreflightEnvironment(serviceSource) {
  for (const name of fullStackMapPreflightEnvironment) {
    assert.match(serviceSource, new RegExp(`${name}: "\\$\\{${name}:\\?[^}]+\\}"`, "u"));
  }
  assert.match(serviceSource, /\.\/var\/alpha-evidence:\/evidence:ro/u);
}

async function git(cwd, ...args) {
  return run("git", args, { cwd, windowsHide: true });
}

async function cleanRepositoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-image-provenance-"));
  await git(directory, "init", "--quiet");
  await writeFile(join(directory, "tracked.txt"), "freigegeben\n", "utf8");
  await git(directory, "add", "tracked.txt");
  await git(
    directory,
    "-c", "user.name=Zugfolge Test",
    "-c", "user.email=zugfolge-test@example.invalid",
    "commit", "--quiet", "-m", "fixture",
  );
  return directory;
}

test("Alpha-Compose erzwingt Map- und Welt-Cutover-Gates, Migration, signierten Bootstrap und einen Build ohne impliziten Neubau", async () => {
  const [compose, rollbackCompose, dockerfile, odooDockerfile, start, build, mapPreflight, worldPreflight, composeWrapper] = await Promise.all([
    read("compose.alpha.yml"),
    read("compose.alpha.rollback.yml"),
    read("ops/alpha/container/Dockerfile"),
    read("ops/alpha/odoo/Dockerfile"),
    read("tools/alpha-ops/phase1-smoke.sh"),
    read("tools/alpha-ops/build-alpha-images.sh"),
    read("tools/alpha-ops/map-release-deployment-preflight.mjs"),
    read("tools/alpha-ops/world-deployment-cutover-preflight.mjs"),
    read("tools/alpha-ops/compose-with-map-release-env.sh"),
  ]);

  const mapReleasePreflightService = compose.slice(
    compose.indexOf("  map-release-preflight:"),
    compose.indexOf("  world-deployment-cutover-preflight:"),
  );
  const gameApiService = compose.slice(compose.indexOf("  game-api:"), compose.indexOf("  game-web:"));
  assert.match(gameApiService, /ZUGFOLGE_WORLD_ID: "\$\{ZUGFOLGE_WORLD_ID:\?[^}]+\}"/u);
  assert.match(gameApiService, /PUBLIC_GAME_URL: "\$\{PUBLIC_GAME_URL:\?[^}]+\}"/u);
  const gameBootstrapService = compose.slice(compose.indexOf("  game-bootstrap:"), compose.indexOf("  game-api:"));
  const worldDeploymentPreflightService = compose.slice(
    compose.indexOf("  world-deployment-cutover-preflight:"),
    compose.indexOf("  game-migrate:"),
  );
  assert.match(worldDeploymentPreflightService, /ZUGFOLGE_WORLD_ID: "\$\{ZUGFOLGE_WORLD_ID:\?[^}]+\}"/u);
  assert.match(gameBootstrapService, /ZUGFOLGE_WORLD_ID: "\$\{ZUGFOLGE_WORLD_ID:\?[^}]+\}"/u);
  const livemapService = compose.slice(compose.indexOf("  livemap:"), compose.indexOf("  operations-center:"));
  const keycloakMigrationService = compose.slice(compose.indexOf("  keycloak-schema-migrate:"), compose.indexOf("  keycloak-schema-backup:"));
  const keycloakRestoreService = compose.slice(compose.indexOf("  keycloak-schema-restore:"), compose.indexOf("  keycloak-schema-preflight:"));
  const keycloakPreflightService = compose.slice(compose.indexOf("  keycloak-schema-preflight:"), compose.indexOf("  keycloak:"));
  const keycloakService = compose.slice(compose.indexOf("  keycloak:"), compose.indexOf("  keycloak-schema-postflight:"));
  const keycloakPostflightService = compose.slice(compose.indexOf("  keycloak-schema-postflight:"), compose.indexOf("  keycloak-reconcile:"));
  const keycloakReconcileService = compose.slice(compose.indexOf("  keycloak-reconcile:"), compose.indexOf("  map-release-preflight:"));
  const recoveryActionService = compose.slice(compose.indexOf("  production-recovery-action:"), compose.indexOf("  prometheus:"));
  const livePostgresService = compose.slice(compose.indexOf("  postgres:"), compose.indexOf("  odoo-postgres:"));
  const liveOdooPostgresService = compose.slice(compose.indexOf("  odoo-postgres:"), compose.indexOf("  recovery-verify-postgres:"));
  const recoveryPostgresService = compose.slice(compose.indexOf("  recovery-verify-postgres:"), compose.indexOf("  recovery-verify-odoo-postgres:"));
  const recoveryOdooPostgresService = compose.slice(compose.indexOf("  recovery-verify-odoo-postgres:"), compose.indexOf("  odoo-upgrade:"));
  const productionRecoveryMaterialService = compose.slice(compose.indexOf("  production-recovery-material:"), compose.indexOf("  production-recovery-schema29-cold-qualify:"));
  const schema29SnapshotService = compose.slice(compose.indexOf("  production-schema29-runtime-snapshot:"), compose.indexOf("  production-schema29-odoo-filestore-access:"));
  const schema29FilestoreAccessService = compose.slice(compose.indexOf("  production-schema29-odoo-filestore-access:"), compose.indexOf("  schema29-game-runtime:"));
  const schema29GameService = compose.slice(compose.indexOf("  schema29-game-runtime:"), compose.indexOf("  schema29-keycloak-runtime:"));
  const schema29KeycloakService = compose.slice(compose.indexOf("  schema29-keycloak-runtime:"), compose.indexOf("  schema29-odoo-runtime:"));
  const schema29OdooService = compose.slice(compose.indexOf("  schema29-odoo-runtime:"), compose.indexOf("  legacy-game-schema29-write-probe:"));
  const schema29GameProbeService = compose.slice(compose.indexOf("  legacy-game-schema29-write-probe:"), compose.indexOf("  legacy-odoo-schema29-write-probe:"));
  const schema29OdooProbeService = compose.slice(compose.indexOf("  legacy-odoo-schema29-write-probe:"), compose.indexOf("  production-schema29-runtime-qualify:"));
  const schema29QualifierService = compose.slice(compose.indexOf("  production-schema29-runtime-qualify:"), compose.indexOf("  production-recovery-cold-qualify:"));
  const schema31GameProbeService = compose.slice(compose.indexOf("  legacy-game-schema31-write-probe:"), compose.indexOf("  game-schema31-qualify:"));
  for (const serviceSource of [mapReleasePreflightService, gameApiService, livemapService]) {
    assertFullStackMapPreflightEnvironment(serviceSource);
  }
  assert.match(compose, /map-release-preflight:[\s\S]*map-release-deployment-preflight\.mjs, "\$\{MAP_RELEASE_START_PREFLIGHT_MODE:\?[^}]+\}"/u);
  assert.match(compose, /MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: "\$\{MAP_RELEASE_ID:\?[^}]+\}"/u);
  assert.match(compose, /\$\{MAP_RELEASE_DEPLOYMENT_HOST_ROOT(?::-\.\/var\/maps|:\?[^}]+)\}:\/map-deployment:ro/u);
  assert.match(compose, /\$\{MAP_RELEASE_PREFLIGHT_HOST_DIR:\?[^}]+\}:\/map-preflight:ro/u);
  assert.match(compose, /\$\{MAP_RELEASE_RESTORE_HOST_DIR:\?[^}]+\}:\/map-restore:ro/u);
  assert.match(compose, /\$\{MAP_RELEASE_DEPLOYMENT_HOST_ROOT:\?[^}]+\}\/\$\{MAP_RELEASE_HOST_DIR:\?[^}]+\}:\/map-release:ro/u);
  assert.match(compose, /\$\{MAP_RELEASE_DEPLOYMENT_HOST_ROOT:\?[^}]+\}\/\$\{MAP_RELEASE_HOST_DIR:\?[^}]+\}:\/map-artifacts\/maps\/\$\{MAP_RELEASE_ID:\?[^}]+\}:ro/u);
  assert.match(compose, /world-deployment-cutover-preflight:[\s\S]*world-deployment-cutover-preflight\.mjs/u);
  assert.match(compose, /world-deployment-cutover-preflight:[\s\S]*ALPHA_WORLD_RELEASE_PATHS_JSON:[^\n]+[\s\S]*INFRA_RELEASE_TRUSTED_KEYS_JSON:[^\n]+[\s\S]*RELEASE_TRUSTED_KEY_SCOPES_JSON:[^\n]+[\s\S]*ALPHA_PUBLIC_WORLD_ID:[^\n]+[\s\S]*LIVEMAP_READ_MODEL_PATH: \/map-release\/read-model\.sqlite/u);
  for (const serviceSource of [mapReleasePreflightService, worldDeploymentPreflightService, gameBootstrapService, gameApiService]) {
    assert.match(serviceSource, /RELEASE_TRUSTED_KEY_SCOPES_JSON: "\$\{RELEASE_TRUSTED_KEY_SCOPES_JSON:\?RELEASE_TRUSTED_KEY_SCOPES_JSON fehlt\}"/u);
  }
  assert.match(compose, /world-deployment-cutover-preflight:[\s\S]*ALPHA_WORLD_V2_CUTOVER_AUTHORIZATION_JSON:/u);
  assert.match(compose, /world-deployment-cutover-preflight:[\s\S]*postgres: \{ condition: service_healthy \}, map-release-preflight: \{ condition: service_completed_successfully \}/u);
  assert.match(compose, /game-migrate:[\s\S]*packages\/db\/dist\/migrate\.js/);
  assert.match(compose, /game-migrate:[\s\S]*map-release-preflight: \{ condition: service_completed_successfully \}/u);
  assert.match(compose, /game-migrate:[\s\S]*world-deployment-cutover-preflight: \{ condition: service_completed_successfully \}/u);
  assert.match(compose, /game-migrate:[\s\S]*keycloak-schema-preflight: \{ condition: service_completed_successfully \}/u);
  assert.match(compose, /game-migrate:[\s\S]*production-recovery-action: \{ condition: service_completed_successfully \}/u);
  assert.match(compose, /recovery-verify-postgres:[\s\S]*profiles: \[production-recovery-preparation\][\s\S]*recovery-verify-db:\/var\/lib\/postgresql\/data/u);
  assert.doesNotMatch(livePostgresService, /schema29-recovery/u);
  assert.doesNotMatch(liveOdooPostgresService, /schema29-recovery/u);
  assert.match(recoveryPostgresService, /networks: \{ schema29-recovery: \{\} \}/u);
  assert.match(recoveryOdooPostgresService, /recovery-verify-odoo-db:\/var\/lib\/postgresql\/data[\s\S]*networks: \{ schema29-recovery: \{\} \}/u);
  assert.match(compose, /schema29-recovery: \{ internal: true, name: zugfolge-schema29-recovery \}/u);
  assert.match(productionRecoveryMaterialService, /image: postgres:16\.14-trixie/u);
  assert.doesNotMatch(productionRecoveryMaterialService, /ZUGFOLGE_ODOO_IMAGE_REFERENCE/u);
  assert.match(productionRecoveryMaterialService, /\/ops\/alpha:ro[\s\S]*odoo-filestore:\/odoo-live-filestore:ro/u);
  assert.match(compose, /production-recovery-cold-qualify:[\s\S]*production-cold-backup\.mjs, qualify[\s\S]*\/var\/run\/docker\.sock[\s\S]*recovery-verify-postgres: \{ condition: service_healthy \}/u);
  assert.match(schema29SnapshotService, /user: "0:0"[\s\S]*production-schema29-runtime-snapshot\.mjs, create[\s\S]*schema29\.odoo-restore\.json[\s\S]*schema29-runtime-before\.json[\s\S]*networks: \{ schema29-recovery: \{\} \}/u);
  assert.match(schema29FilestoreAccessService, /user: "0:0"[\s\S]*schema29-odoo-filestore-access\.mjs, open[\s\S]*schema29-odoo-filestore-open\.json[\s\S]*schema29-odoo-filestore-seal\.json[\s\S]*PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE[^\n]+:\/odoo-recovery-filestore\/\$\{PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE[^\n]+:rw[\s\S]*network_mode: none/u);
  assert.match(schema29GameService, /image: "\$\{MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE:[^\n]+[\s\S]*command: \[node, apps\/game-api\/dist\/server\.js\]/u);
  assert.match(schema29GameService, /ALPHA_WORLD_RELEASE_PATHS_JSON: '\["\$\{MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH:[^\n]+[\s\S]*\.\/var\/alpha-evidence:\/evidence:ro[\s\S]*networks: \{ schema29-recovery: \{\} \}/u);
  assert.match(schema29GameService, /healthcheck: \{ <<: \*health, start_period: 2h,[^\n]+\/health\/ready/u);
  assert.doesNotMatch(schema29GameService, /\n\s+ports:/u);
  assert.match(schema29KeycloakService, /quay\.io\/keycloak\/keycloak:26\.7\.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13/u);
  assert.match(schema29KeycloakService, /KC_DB_URL: "jdbc:postgresql:\/\/recovery-verify-postgres:5432\/\$\{PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_DATABASE:[^\n]+[\s\S]*KC_DB_SCHEMA: public[\s\S]*networks: \{ schema29-recovery: \{\} \}/u);
  assert.doesNotMatch(schema29KeycloakService, /\n\s+ports:/u);
  assert.match(schema29OdooService, /image: "\$\{PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE:[^\n]+[\s\S]*user: "\$\{PRODUCTION_RECOVERY_ODOO_RUNTIME_UID:[^\n]+:\$\{PRODUCTION_RECOVERY_ODOO_RUNTIME_GID:[^\n]+[\s\S]*--db_host=recovery-verify-odoo-postgres[\s\S]*networks: \{ schema29-recovery: \{\} \}/u);
  assert.match(schema29OdooService, /PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE[^\n]+:\/var\/lib\/odoo\/filestore\/\$\{PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE[^\n]+:rw/u);
  assert.doesNotMatch(schema29OdooService, /:\/var\/lib\/odoo\/filestore:rw/u);
  assert.doesNotMatch(schema29OdooService, /\n\s+ports:/u);
  assert.match(schema29GameProbeService, /group_add:[\s\S]*PRODUCTION_RECOVERY_ODOO_RUNTIME_GID[\s\S]*legacy-schema29-write-probe\.mjs[\s\S]*production-recovery:rw/u);
  assert.match(schema29OdooProbeService, /user: "\$\{PRODUCTION_RECOVERY_ODOO_RUNTIME_UID:[^\n]+:\$\{PRODUCTION_RECOVERY_ODOO_RUNTIME_GID:[^\n]+[\s\S]*PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH:[^\n]+[\s\S]*legacy-schema29-odoo-write-probe\.py[\s\S]*PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE[^\n]+:\/var\/lib\/odoo\/filestore\/\$\{PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE[^\n]+:rw/u);
  assert.match(schema29QualifierService, /PRODUCTION_SCHEMA29_RUNTIME_BEFORE_RECEIPT_PATH:[^\n]+schema29-runtime-before\.json/u);
  assert.match(schema29QualifierService, /PRODUCTION_SCHEMA29_ODOO_FILESTORE_OPEN_RECEIPT_PATH:[^\n]+schema29-odoo-filestore-open\.json[\s\S]*PRODUCTION_SCHEMA29_ODOO_FILESTORE_SEAL_RECEIPT_PATH:[^\n]+schema29-odoo-filestore-seal\.json/u);
  assert.match(schema29QualifierService, /PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORE_RECEIPT_PATH:[\s\S]*PRODUCTION_SCHEMA29_PRISTINE_GAME_RESTORED_DATABASE_URL:[\s\S]*PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORED_DATABASE_URL:[\s\S]*PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORED_FILESTORE_PATH:/u);
  assert.match(schema29QualifierService, /MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH:[\s\S]*\.\/var\/alpha-evidence:\/evidence:ro/u);
  assert.match(schema29QualifierService, /schema29-game-runtime: \{ condition: service_healthy \}, schema29-keycloak-runtime: \{ condition: service_healthy \}, schema29-odoo-runtime: \{ condition: service_healthy \}/u);
  assert.match(composeWrapper, /production-schema29-runtime-snapshot[\s\S]*schema29-odoo-filestore-access\.mjs "\$action"[\s\S]*run_schema29_odoo_filestore_access open[\s\S]*legacy-odoo-schema29-write-probe[\s\S]*stop --timeout 60 schema29-odoo-runtime[\s\S]*run_schema29_odoo_filestore_access seal[\s\S]*--no-recreate --wait[\s\S]*schema29-odoo-runtime[\s\S]*production-schema29-runtime-qualify/u);
  assert.match(composeWrapper, /run_schema29_odoo_filestore_access open[\s\S]*--force-recreate --wait --wait-timeout 7200[\s\S]*schema29-keycloak-runtime schema29-game-runtime schema29-odoo-runtime/u);
  assert.match(composeWrapper, /schema29_runtime_filestore_host_path="\$resolved_recovery_filestore_root\/\$production_schema29_runtime_odoo_restore_database"[\s\S]*! -d "\$schema29_runtime_filestore_host_path"[\s\S]*pwd -P[\s\S]*export PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH="\$schema29_runtime_filestore_host_path"[\s\S]*run --rm --no-deps -e PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH production-schema29-runtime-qualify/u);
  assert.match(schema31GameProbeService, /group_add:[\s\S]*PRODUCTION_RECOVERY_ODOO_RUNTIME_GID[\s\S]*legacy-schema31-write-probe\.mjs[\s\S]*production-recovery:rw/u);
  assert.match(compose, /production-recovery-cold-qualify:[\s\S]*PRODUCTION_SCHEMA31_RECEIPT_PATH:[^\n]+schema31-prepared\.json/u);
  assert.match(compose, /game-schema33-migrate:[\s\S]*PRODUCTION_SCHEMA31_RECEIPT_PATH:[^\n]+schema31-prepared\.json/u);
  assert.match(compose, /game-schema33-migrate:[\s\S]*production-cold-backup\.mjs, preflight, node, packages\/db\/dist\/migrate\.js/u);
  assert.match(composeWrapper, /--schema33-after-cold[\s\S]*game-schema33-migrate[\s\S]*select count\(\*\) from drizzle\.__drizzle_migrations"\)" = 34/u);
  assert.match(
    composeWrapper,
    /if \(\(keycloak_after_schema33 == 1\)\); then[\s\S]*select count\(\*\) from drizzle\.__drizzle_migrations"\)" = 34[\s\S]*keycloak-schema-backup[\s\S]*keycloak-schema-restore[\s\S]*bind-backup[\s\S]*plan-up[\s\S]*keycloak_schema_command up[\s\S]*keycloak_schema_command recover[\s\S]*keycloak_schema_command preflight-up/u,
  );
  assert.match(
    composeWrapper,
    /if \(\(prepare_v2_hot == 1\)\); then[\s\S]*select count\(\*\) from drizzle\.__drizzle_migrations"\)" = 34[\s\S]*keycloak_schema_command preflight-up[\s\S]*backup-game\.sh/u,
  );
  assert.match(
    composeWrapper,
    /start_legacy_stage keycloak[\s\S]*production-recovery-action[\s\S]*wait-legacy-game-readiness\.mjs baseline[\s\S]*start_legacy_stage game-api[\s\S]*production-recovery-action[\s\S]*wait-legacy-game-readiness\.mjs wait[\s\S]*start_legacy_stage odoo/u,
  );
  assert.match(compose, /production-recovery-proof:[\s\S]*create-database-backup-restore-evidence|production-recovery-proof:[\s\S]*DATABASE_ROLLBACK_GAME_BACKUP_DUMP_PATH/u);
  assert.match(compose, /game-bootstrap:[\s\S]*production-db-bootstrap\.mjs/);
  assert.match(compose, /depends_on: \{ game-bootstrap: \{ condition: service_completed_successfully \}, keycloak-reconcile: \{ condition: service_completed_successfully \} \}/);
  assert.match(gameApiService, /healthcheck: \{ <<: \*health, test: [^\n]+localhost:3000\/health'/u);
  assert.doesNotMatch(gameApiService, /healthcheck: [^\n]+\/health\/ready/u);
  assert.doesNotMatch(gameApiService, /healthcheck:[^\n]+start_period: 15m/u);
  assert.doesNotMatch(compose, /LIVEMAP_TRAIN_PROJECTION_PATH|train-map-projection\.sqlite/u);
  assert.match(gameApiService, /ZUGFOLGE_OPERATIONAL_INFRASTRUCTURE_ROOTS_JSON:/u);
  assert.match(gameApiService, /\$\{MAP_RELEASE_ID:\?[^}]+\}":"\/map-release/u);
  assert.match(gameApiService, /tutorial-minimal-2026\.1:operational-infra":"\/app\/apps\/game-api\/tutorial-infrastructure\/tutorial-minimal-2026\.1/u);
  assert.doesNotMatch(gameApiService, /ZUGFOLGE_OPERATIONAL_INFRASTRUCTURE_ROOT:/u);
  assert.match(compose, /game-bootstrap:[\s\S]*ALPHA_WORLD_V2_CUTOVER_AUTHORIZATION_JSON:/u);
  assert.match(compose, /game-bootstrap:[\s\S]*ALPHA_PUBLIC_WORLD_ID:/u);
  assert.match(compose, /game-bootstrap:[\s\S]*LIVEMAP_READ_MODEL_PATH: \/map-release\/read-model\.sqlite/u);
  assert.match(gameBootstrapService, /MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH: \/map-preflight\/database-rollback-proof\.json/u);
  assert.match(gameBootstrapService, /KEYCLOAK_SCHEMA_CATALOG_PATH: \/keycloak-schema-catalog\.json/u);
  assert.match(gameBootstrapService, /keycloak-pg16-object-catalog\.26\.7\.0\.json:\/keycloak-schema-catalog\.json:ro/u);
  assert.match(gameBootstrapService, /depends_on: \{ game-migrate: \{ condition: service_completed_successfully \}, keycloak-schema-postflight: \{ condition: service_completed_successfully \} \}/u);
  assert.match(gameBootstrapService, /\$\{MAP_RELEASE_PREFLIGHT_HOST_DIR:\?[^}]+\}:\/map-preflight:ro/u);
  assert.match(compose, /game-bootstrap:[\s\S]*\$\{MAP_RELEASE_DEPLOYMENT_HOST_ROOT:\?[^}]+\}\/\$\{MAP_RELEASE_HOST_DIR:\?[^}]+\}:\/map-release:ro/u);
  const bootstrapApply = await read("tools/alpha-ops/world-deployment-cutover-apply.mjs");
  assert.match(bootstrapApply, /client\.begin\("isolation level read committed"/u);
  assert.match(bootstrapApply, /new Set\(\[candidateWorldId, predecessorWorldId\][\s\S]*\.sort\(/u);
  assert.match(bootstrapApply, /pg_advisory_xact_lock\([\s\S]*md5\(\$1::uuid::text\)[\s\S]*cutoverWorldIds\([\s\S]*candidate\.deployment\.worldId[\s\S]*cutoverAuthorization\?\.predecessorWorldId/u);
  assert.doesNotMatch(bootstrapApply, /isolation level serializable|CUTOVER_LOCK_NAMESPACE/u);
  assert.match(bootstrapApply, /acquireExclusiveWorldLocks\([\s\S]*validateWorldDeploymentCutover\([\s\S]*set local lock_timeout = '10s'[\s\S]*lockKeycloakCatalogTables\(tx, KEYCLOAK_TARGET_SCHEMA[\s\S]*mode: "share"[\s\S]*inspectRollbackSnapshot\(tx\)/u);
  assert.match(bootstrapApply, /validateWorldDeploymentCutover\([\s\S]*insert into worlds[\s\S]*validateWorldDeploymentCutover\(/u);
  assert.match(bootstrapApply, /set state = 'closing'[\s\S]*profile\.state = 'running'[\s\S]*set state = 'archived'[\s\S]*profile\.state = 'closing'[\s\S]*set lifecycle_status = 'archived'/u);
  assert.match(bootstrapApply, /assertDatabaseRollbackProofMatchesLive[\s\S]*final_state_hash = \$3[\s\S]*insert into world_cutover_receipts/u);
  assert.match(bootstrapApply, /set legacy_writer_fenced = true[\s\S]*unfenced !== 0/u);
  assert.doesNotMatch(bootstrapApply, /delete from|truncate/u);
  assert.match(compose, /odoo-upgrade:[\s\S]*--update=zugfolge_admin[\s\S]*--stop-after-init[\s\S]*restart: "no"/u);
  assert.match(compose, /odoo-upgrade:[\s\S]*HOST: odoo-postgres[\s\S]*USER: odoo[\s\S]*PASSWORD: "\$\{ODOO_DB_PASSWORD\}"/u);
  assert.match(compose, /odoo-upgrade:[\s\S]*production-recovery-action: \{ condition: service_completed_successfully \}/u);
  assert.match(compose, /odoo:[\s\S]*depends_on: \{ odoo-upgrade: \{ condition: service_completed_successfully \}, game-api:/u);
  assert.match(compose, /^name: zugfolge$/mu);
  assert.equal((compose.match(/image: "\$\{ZUGFOLGE_GAME_API_IMAGE_REFERENCE:\?[^}]+\}"/gu) ?? []).length, 23);
  assert.equal((compose.match(/image: "\$\{ZUGFOLGE_ODOO_IMAGE_REFERENCE:\?[^}]+\}"/gu) ?? []).length, 2);
  assert.equal((compose.match(/pull_policy: never/gu) ?? []).length, 30);
  assert.doesNotMatch(compose, /^\s+image: zugfolge-game-api(?::[^\s]+)?\s*$/mu);
  assert.equal((rollbackCompose.match(/image: "\$\{MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE:\?[^}]+\}"/gu) ?? []).length, 5);
  assert.equal((rollbackCompose.match(/image: "\$\{PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE:\?[^}]+\}"/gu) ?? []).length, 1);
  const rollbackGameApi = rollbackCompose.slice(rollbackCompose.indexOf("  game-api:"), rollbackCompose.indexOf("  game-web:"));
  assert.match(rollbackCompose, /keycloak:[\s\S]*KC_DB_SCHEMA: keycloak/u);
  assert.doesNotMatch(rollbackCompose, /keycloak:[\s\S]*KC_DB_SCHEMA: public/u);
  assert.match(rollbackGameApi, /command: \[node, apps\/game-api\/dist\/server\.js\]/u);
  assert.match(rollbackGameApi, /healthcheck: \{ start_period: 2h \}/u);
  assert.match(rollbackCompose, /livemap:[\s\S]*command: \[node, tools\/alpha-ops\/static-server\.mjs/u);
  assert.doesNotMatch(rollbackCompose, /(?:map-release-preflight|world-deployment-cutover-preflight|game-migrate|game-bootstrap|keycloak-schema-(?:preflight|postflight)|keycloak-reconcile):/u);
  assert.doesNotMatch(recoveryActionService, /profiles:/u);
  assert.match(recoveryActionService, /command: \[node, tools\/alpha-ops\/activate-production-recovery\.mjs, prepared\]/u);
  assert.match(recoveryActionService, /PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH: "\/production-recovery\/\$\{PRODUCTION_RECOVERY_ID:\?[^}]+\}\.prepared\.json"/u);
  assert.match(recoveryActionService, /PRODUCTION_RECOVERY_CONTROL_SERVICE: production-recovery-action/u);
  assert.match(recoveryActionService, /KEYCLOAK_SCHEMA_CATALOG_PATH: \/keycloak-schema-catalog\.json/u);
  assert.match(recoveryActionService, /keycloak-pg16-object-catalog\.26\.7\.0\.json:\/keycloak-schema-catalog\.json:ro/u);
  assert.match(recoveryActionService, /PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT: \/odoo-recovery-filestore/u);
  assert.match(recoveryActionService, /PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_ROOT: \/odoo-recovery-filestore/u);
  assert.match(recoveryActionService, /depends_on: \{ postgres: \{ condition: service_healthy \}, odoo-postgres: \{ condition: service_healthy \} \}/u);
  for (const mutatingService of [keycloakMigrationService, keycloakRestoreService, keycloakPreflightService, mapReleasePreflightService]) {
    assert.match(mutatingService, /production-recovery-action: \{ condition: service_completed_successfully \}/u);
  }
  for (const [serviceName, nextServiceName] of [["static", "odoo"], ["alpha-ops", "production-recovery-action"], ["prometheus", "grafana"]]) {
    const serviceStart = compose.indexOf(`  ${serviceName}:`);
    const serviceEnd = compose.indexOf(`  ${nextServiceName}:`, serviceStart + 3);
    assert.match(compose.slice(serviceStart, serviceEnd), /production-recovery-action: \{ condition: service_completed_successfully \}/u);
  }
  assert.match(composeWrapper, /current_compose=[\s\S]*"\$\{current_compose\[@\]\}" run --rm --no-deps map-release-preflight/u);
  assert.match(composeWrapper, /run_recovery_action prepared[\s\S]*run_source_action release[\s\S]*remove_runtime_services[\s\S]*cutover_up=\(up --no-recreate --no-build --wait\)/u);
  assert.match(composeWrapper, /cutover_up[\s\S]*wait-game-readiness\.mjs[\s\S]*cutover_completed=1/u);
  assert.match(composeWrapper, /stop_runtime_services[\s\S]*start_database_services[\s\S]*run_source_action reseal[\s\S]*map-release-preflight[\s\S]*if \[\[ -e "\$activation_receipt_host_path" \]\][\s\S]*run_recovery_continuation[\s\S]*else[\s\S]*run_recovery_action preflight[\s\S]*run_recovery_action activate[\s\S]*start_legacy_stage keycloak[\s\S]*start_legacy_stage game-api[\s\S]*start_legacy_stage odoo[\s\S]*start_legacy_stage game-web livemap operations-center static/u);
  assert.match(composeWrapper, /run_recovery_continuation\(\)[\s\S]*continue-production-recovery\.mjs/u);
  assert.match(composeWrapper, /local source_intent="\/production-recovery\/\$\{production_recovery_id\}\.source-\$\{action\}\.intent\.json"[\s\S]*PRODUCTION_RECOVERY_SOURCE_INTENT_OUTPUT_PATH="\$source_intent"/u);
  assert.match(composeWrapper, /start_database_services\(\)[\s\S]*up --no-recreate --no-deps --no-build/u);
  assert.match(composeWrapper, /attested_rollback=1\n\s+preflight_mode=attested-rollback/u);
  const cutoverOrchestration = composeWrapper.slice(
    composeWrapper.indexOf("    cutover_completed=0"),
    composeWrapper.indexOf("  rollback_cleanup_running=0"),
  );
  assert.doesNotMatch(cutoverOrchestration, /"\$\{(?:current|legacy)_compose\[@\]\}"[^\n]*\bdown\b/u);
  assert.doesNotMatch(composeWrapper.slice(composeWrapper.indexOf("start_legacy_stage keycloak")), /start_legacy_stage (?:world-deployment-cutover-preflight|game-migrate|game-bootstrap|keycloak-schema-preflight|keycloak-schema-postflight|keycloak-reconcile)/u);
  assert.match(compose, /odoo-upgrade:[\s\S]*image: "\$\{ZUGFOLGE_ODOO_IMAGE_REFERENCE:\?[^}]+\}"/u);
  assert.match(compose, /\n  odoo:\n    image: "\$\{ZUGFOLGE_ODOO_IMAGE_REFERENCE:\?[^}]+\}"/u);
  assert.match(compose, /\n  odoo:[\s\S]*HOST: odoo-postgres[\s\S]*USER: odoo[\s\S]*PASSWORD: "\$\{ODOO_DB_PASSWORD\}"/u);
  const odooAddonPaths = [...compose.matchAll(/--addons-path=([^\s\]]+)/gu)];
  assert.equal(odooAddonPaths.length, 4);
  assert.equal(odooAddonPaths.every((match) => match[1]?.includes("/opt/zugfolge-addons")), true);
  assert.doesNotMatch(compose, /--addons-path=[^\s\]]*\/mnt\/extra-addons/u);
  assert.match(odooDockerfile, /\/opt\/zugfolge-addons\/queue_job/u);
  assert.match(odooDockerfile, /\/opt\/zugfolge-addons\/zugfolge_admin/u);
  assert.doesNotMatch(odooDockerfile, /\/mnt\/extra-addons/u);
  assert.match(compose, /\n  keycloak:[\s\S]*command: \[start, --import-realm, --health-enabled=true, --http-enabled=true\]/u);
  assert.match(compose, /\n  keycloak:\n    image: quay\.io\/keycloak\/keycloak:26\.7\.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13/u);
  assert.match(compose, /\n  keycloak:[\s\S]*KC_HOSTNAME: "\$\{KEYCLOAK_PUBLIC_URL\}"[\s\S]*KC_PROXY_HEADERS: xforwarded/u);
  assert.match(keycloakService, /KC_DB_SCHEMA: keycloak/u);
  assert.match(keycloakService, /depends_on: \{ keycloak-schema-preflight: \{ condition: service_completed_successfully \} \}/u);
  assert.match(keycloakMigrationService, /profiles: \[keycloak-schema-migration\]/u);
  for (const serviceSource of [keycloakMigrationService, keycloakPreflightService, keycloakPostflightService]) {
    assert.match(serviceSource, /user: "\$\{KEYCLOAK_SCHEMA_OPERATOR_UID:-1000\}:\$\{KEYCLOAK_SCHEMA_OPERATOR_GID:-1000\}"/u);
  }
  assert.match(compose, /keycloak-schema-backup:[\s\S]*user: "\$\{KEYCLOAK_SCHEMA_OPERATOR_UID:-1000\}:\$\{KEYCLOAK_SCHEMA_OPERATOR_GID:-1000\}"/u);
  assert.match(keycloakMigrationService, /keycloak-public-to-schema\.mjs, "\$\{KEYCLOAK_SCHEMA_ACTION:-inspect\}"/u);
  assert.match(keycloakMigrationService, /KEYCLOAK_SCHEMA_WRITERS_QUIESCED: "\$\{KEYCLOAK_SCHEMA_WRITERS_QUIESCED:-false\}"/u);
  assert.match(keycloakMigrationService, /KEYCLOAK_SCHEMA_RESTORED_DATABASE_URL:[^\n]+zugfolge_restore_keycloak_schema/u);
  assert.match(keycloakMigrationService, /KEYCLOAK_SCHEMA_RESTORE_RECEIPT_PATH:/u);
  assert.match(keycloakMigrationService, /KEYCLOAK_SCHEMA_RECEIPT_PATH: "\$\{KEYCLOAK_SCHEMA_RECEIPT_CONTAINER_PATH:-\/keycloak-schema\/receipt\.json\}"/u);
  assert.match(keycloakMigrationService, /KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR:\?[^}]+\}:\/keycloak-schema:rw/u);
  assert.match(compose, /keycloak-schema-backup:[\s\S]*profiles: \[keycloak-schema-migration\][\s\S]*postgres:16\.14-trixie[\s\S]*backup-game\.sh[\s\S]*KEYCLOAK_SCHEMA_BACKUP_HOST_DIR:\?[^}]+\}:\/keycloak-backup:rw/u);
  assert.match(keycloakRestoreService, /profiles: \[keycloak-schema-migration\][\s\S]*postgres:16\.14-trixie[\s\S]*restore-game\.sh[\s\S]*KEYCLOAK_SCHEMA_BACKUP_HOST_DIR:\?[^}]+\}:\/keycloak-backup:ro[\s\S]*KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR:\?[^}]+\}:\/keycloak-schema:rw/u);
  assert.match(keycloakRestoreService, /test ! -e[^\n]+KEYCLOAK_SCHEMA_RESTORE_RECEIPT_PATH/u);
  assert.match(keycloakRestoreService, /test "\$\$KEYCLOAK_SCHEMA_RESTORE_DATABASE" != "\$\$KEYCLOAK_SCHEMA_LIVE_DATABASE"/u);
  assert.match(keycloakRestoreService, /KEYCLOAK_SCHEMA_LIVE_DATABASE: "\$\{POSTGRES_DB\}"/u);
  assert.match(keycloakRestoreService, /restore-game\.sh[^\n]+"\$\$KEYCLOAK_SCHEMA_RESTORE_RECEIPT_PATH"/u);
  assert.doesNotMatch(keycloakRestoreService, /restore-game\.sh[^\n]+>[^\n]+KEYCLOAK_SCHEMA_RESTORE_RECEIPT_PATH/u);
  assert.match(keycloakPreflightService, /keycloak-public-to-schema\.mjs, preflight/u);
  assert.match(keycloakPreflightService, /KEYCLOAK_SCHEMA_RECEIPT_PATH:/u);
  assert.match(keycloakPreflightService, /KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR:\?[^}]+\}:\/keycloak-schema:ro/u);
  assert.match(keycloakPostflightService, /keycloak-public-to-schema\.mjs, postflight/u);
  assert.match(keycloakPostflightService, /KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_OUTPUT_PATH:/u);
  assert.match(keycloakPostflightService, /KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR:\?[^}]+\}:\/keycloak-schema:rw/u);
  assert.match(keycloakPostflightService, /depends_on: \{ keycloak: \{ condition: service_healthy \}, game-migrate: \{ condition: service_completed_successfully \} \}/u);
  assert.match(keycloakReconcileService, /depends_on: \{ keycloak-schema-postflight: \{ condition: service_completed_successfully \}, game-bootstrap: \{ condition: service_completed_successfully \} \}/u);
  assert.match(compose, /010-keycloak-schema\.sql:\/docker-entrypoint-initdb\.d\/010-keycloak-schema\.sql:ro/u);
  assert.match(await read("ops/alpha/postgres/010-keycloak-schema.sql"), /COMMENT ON SCHEMA keycloak IS 'zugfolge:keycloak-bootstrap-origin\/v1'/u);
  assert.match(compose, /keycloak:[\s\S]*proxy: \{ aliases: \[zugfolge-keycloak\] \}[\s\S]*mail: \{\}/u);
  assert.match(compose, /game-web:[\s\S]*proxy: \{ aliases: \[zugfolge-world-web\] \}/u);
  assert.match(compose, /livemap:[\s\S]*proxy: \{ aliases: \[zugfolge-world-livemap\] \}/u);
  assert.match(compose, /\n  odoo:[\s\S]*proxy: \{ aliases: \[zugfolge-odoo\] \}[\s\S]*mail: \{\}/u);
  assert.match(compose, /networks:[\s\S]*proxy: \{ external: true, name: zugfolge-proxy \}[\s\S]*mail: \{ external: true, name: zugfolge-mail \}/u);
  assert.match(mapPreflight, /expectedReleaseForMapPreflight\(evidence, mode, configuredReleaseId\)/u);
  assert.match(mapPreflight, /expectedActiveReleaseId/u);
  assert.match(mapPreflight, /mode === "attested-rollback" \? rollbackPreflight : preflight/u);
  assert.doesNotMatch(mapPreflight, /fallback/u);
  assert.match(worldPreflight, /active_world_requires_operational_v2_cutover/u);
  assert.match(worldPreflight, /active_tutorial_requires_v2_cutover_archive/u);
  assert.match(worldPreflight, /set transaction read only/u);
  assert.doesNotMatch(worldPreflight, /fallback/u);
  assert.match(compose, /ZUGFOLGE_SOURCE_SHA: "\$\{ZUGFOLGE_SOURCE_SHA:-unversioned\}"/);
  assert.match(compose, /ZUGFOLGE_DEPLOY_PATCH_SHA: "\$\{ZUGFOLGE_DEPLOY_PATCH_SHA:-unversioned\}"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{ZUGFOLGE_SOURCE_SHA\}"/);
  assert.match(dockerfile, /de\.zugfolge\.deploy-patch="\$\{ZUGFOLGE_DEPLOY_PATCH_SHA\}"/);
  assert.match(dockerfile, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(dockerfile, /test "\$\{ZUGFOLGE_DEPLOY_PATCH_SHA\}" = "none"/);
  assert.match(odooDockerfile, /org\.opencontainers\.image\.revision="\$\{ZUGFOLGE_SOURCE_SHA\}"/);
  assert.match(odooDockerfile, /de\.zugfolge\.deploy-patch="\$\{ZUGFOLGE_DEPLOY_PATCH_SHA\}"/);
  assert.match(odooDockerfile, /test "\$\{ZUGFOLGE_DEPLOY_PATCH_SHA\}" = "none"/);
  assert.match(start, /up --no-build --wait/);
  assert.doesNotMatch(start, /--build/);
  assert.match(build, /source_sha=\$\(node tools\/alpha-ops\/image-provenance\.mjs\)/);
  assert.match(build, /export ZUGFOLGE_SOURCE_SHA="\$source_sha"/);
  assert.match(build, /export ZUGFOLGE_DEPLOY_PATCH_SHA=none/);
  assert.match(build, /compose-with-map-release-env\.sh" -f "\$repository_root\/compose\.alpha\.yml" build/u);
  assert.match(build, /docker image inspect zugfolge-game-api/);
  assert.match(build, /docker image inspect zugfolge-odoo:alpha/);
  assert.match(build, /ZUGFOLGE_GAME_API_IMAGE_REFERENCE=%s/);
  assert.match(build, /ZUGFOLGE_ODOO_IMAGE_REFERENCE=%s/);
});

test("Produktionsfreigabe dokumentiert .2 nur manuell und startet Fresh-Compose fail-closed mit .4", async () => {
  const [compose, environmentSource, installation] = await Promise.all([
    read("compose.alpha.yml"),
    read(".env.example"),
    read("ALPHA-INSTALL.md"),
  ]);
  const preflightService = compose.slice(
    compose.indexOf("  map-release-preflight:"),
    compose.indexOf("  world-deployment-cutover-preflight:"),
  );
  const worldPreflightService = compose.slice(
    compose.indexOf("  world-deployment-cutover-preflight:"),
    compose.indexOf("  game-migrate:"),
  );
  const migrateService = compose.slice(
    compose.indexOf("  game-migrate:"),
    compose.indexOf("  game-bootstrap:"),
  );
  assert.match(preflightService, /command: \[node, tools\/alpha-ops\/map-release-deployment-preflight\.mjs, "\$\{MAP_RELEASE_START_PREFLIGHT_MODE:\?[^}]+\}"\]/u);
  assert.match(preflightService, /MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: "\$\{MAP_RELEASE_ID:\?[^}]+\}"/u);
  assert.doesNotMatch(preflightService, /pre-activation|infra-deutschland-2026\.1/u);
  assert.match(worldPreflightService, /world-deployment-cutover-preflight\.mjs/u);
  assert.match(worldPreflightService, /LIVEMAP_READ_MODEL_PATH: \/map-release\/read-model\.sqlite/u);
  assert.match(worldPreflightService, /map-release-preflight: \{ condition: service_completed_successfully \}/u);
  assert.match(migrateService, /map-release-preflight: \{ condition: service_completed_successfully \}/u);
  assert.match(migrateService, /world-deployment-cutover-preflight: \{ condition: service_completed_successfully \}/u);

  assert.match(environmentSource, /^MAP_RELEASE_DEPLOYMENT_HOST_ROOT=\.\/var\/maps$/mu);
  assert.match(environmentSource, /^MAP_RELEASE_PREFLIGHT_HOST_DIR=\.\/var\/map-release-preflight$/mu);
  assert.match(environmentSource, /^MAP_RELEASE_RESTORE_HOST_DIR=\.\/var\/map-release-restore\/infra-deutschland-2026\.4$/mu);
  assert.match(environmentSource, /^MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH=\/map-preflight\/database-rollback-proof\.json$/mu);
  assert.match(environmentSource, /^MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT=replace-with-attested-rollback-source-commit$/mu);
  assert.match(environmentSource, /^ZUGFOLGE_GAME_API_IMAGE_REFERENCE=sha256:replace-with-current-game-api-image-id$/mu);
  assert.match(environmentSource, /^MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST=sha256:replace-with-attested-rollback-image-digest$/mu);
  assert.match(environmentSource, /^MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE=sha256:replace-with-attested-rollback-image-id$/mu);
  assert.match(environmentSource, /^MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH=\/evidence\/alpha-world-deployment\.json$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR=\.\/var\/keycloak-schema-migration$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_BACKUP_HOST_DIR=\.\/var\/keycloak-schema-backup$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_RESTORE_DATABASE=zugfolge_restore_keycloak_schema$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_RESTORE_RECEIPT_CONTAINER_PATH=\/keycloak-schema\/restore-receipt\.json$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_OPERATOR_UID=1000$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_OPERATOR_GID=1000$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_RECEIPT_CONTAINER_PATH=\/keycloak-schema\/receipt\.json$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_OUTPUT_CONTAINER_PATH=\/keycloak-schema\/receipt\.json$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED=false$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_ACTION=inspect$/mu);
  assert.match(environmentSource, /^KEYCLOAK_SCHEMA_WRITERS_QUIESCED=false$/mu);
  assert.doesNotMatch(environmentSource, /^MAP_RELEASE_HOST_DIR=/mu);
  assert.doesNotMatch(environmentSource, /^MAP_RELEASE_ID=/mu);
  assert.doesNotMatch(environmentSource, /^MAP_BASEMAP_STYLE_URL=/mu);
  assert.doesNotMatch(environmentSource, /^MAP_GERMANY_PMTILES_URL=/mu);
  assert.doesNotMatch(environmentSource, /^LIVEMAP_TRAIN_PROJECTION_PATH=/mu);

  assert.match(installation, /--prepare-v2-cold -f \/opt\/zugfolge\/compose\.yml/u);
  assert.match(installation, /--schema33-after-cold -f \/opt\/zugfolge\/compose\.yml/u);
  assert.match(installation, /--keycloak-after-schema33 -f \/opt\/zugfolge\/compose\.yml/u);
  assert.match(installation, /--keycloak-recover-after-schema33/u);
  assert.match(installation, /--prepare-v2-hot -f \/opt\/zugfolge\/compose\.yml/u);
  assert.match(installation, /KC_DB_SCHEMA=keycloak[\s\S]*keine[^\n]*Keycloak-[\s\S]*Down-Migration/u);
  assert.match(installation, /schema29-keycloak-runtime[\s\S]*KC_DB_SCHEMA=public/u);
  assert.match(installation, /direktes `run game-migrate` ist im kanonischen Wrapper gesperrt/u);
  assert.doesNotMatch(installation, /-e MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID=/u);
  assert.match(installation, /map-release-deployment-preflight\.mjs pre-activation/u);
  assert.match(installation, /compose-with-map-release-env\.sh[\s\\]+\s+--quiesced-cutover\s+-f \/opt\/zugfolge\/compose\.yml up --no-build --wait/u);
  assert.match(installation, /`\.2` wird im normalen Startpfad niemals automatisch aktiviert/u);
});

test("Installationsvertrag trennt den V1-V2-Hard-Cutover von spaeteren Same-World-Revisionen", async () => {
  const [installation, preflight, identitySource, migrationSource] = await Promise.all([
    read("ALPHA-INSTALL.md"),
    read("tools/alpha-ops/world-deployment-cutover-preflight.mjs"),
    read("tools/region-import/specifications/alpha-world-germany-2026.3.identity.json"),
    read("tools/region-import/specifications/alpha-fleet-v1-migration.annual-2026.3.json"),
  ]);
  const identity = JSON.parse(identitySource);
  const migration = JSON.parse(migrationSource);

  assert.notEqual(migration.legacy.worldId, migration.target.worldId);
  assert.equal(migration.target.worldId, identity.worldId);
  assert.match(preflight, /deployment\.deploymentRevision === 1[\s\S]*Eine neue V2-Welt muss mit Deployment-Revision 1 beginnen/u);
  assert.match(installation, /Der Hard-Cutover übernimmt die alte `world_id` nicht/u);
  assert.match(installation, /archiviert und versiegelt die freigegebene V1-Welt unverändert/u);
  assert.match(installation, /neue, zuvor unbenutzte V2-`world_id` mit\s+`deploymentRevision: 1`/u);
  assert.match(installation, /`deploymentRevision: 2` gilt erst für eine spätere,\s+neu signierte Deploymentgeneration derselben V2-Welt/u);
});

test("die erweiterte Abnahme fuehrt den V1-V2-Postgres/Odoo-Vertrag an beiden Dienstgrenzen aus", async () => {
  const [workflow, postgresTest, commerceTest, odooTest] = await Promise.all([
    read(".github/workflows/extended.yml"),
    read("tools/alpha-ops/world-deployment-v1-v2.postgres-odoo.integration.test.mjs"),
    read("packages/commerce/src/commerce.test.ts"),
    read("odoo/addons/zugfolge_admin/tests/test_projection_ingress.py"),
  ]);
  assert.match(workflow, /node --test tools\/alpha-ops\/world-deployment-v1-v2\.postgres-odoo\.integration\.test\.mjs/u);
  assert.match(postgresTest, /legacyAuthorityAccountId[\s\S]*applyWorldDeploymentCutover/u);
  assert.match(postgresTest, /inspectLiveDatabaseRollbackSnapshot[\s\S]*databaseRollbackProof: rollbackProof/u);
  assert.doesNotMatch(postgresTest, /function rollbackSnapshot|DATABASE_AUTHORITATIVE_TABLE_COUNT/u);
  assert.match(postgresTest, /lifecycle_status, "archived"[\s\S]*legacy_writer_fenced, true/u);
  assert.match(postgresTest, /world_cutover_receipts[\s\S]*receipt_hash: first\.cutoverReceiptHash/u);
  assert.match(postgresTest, /const second = await applyWorldDeploymentCutover\(applyInput\)[\s\S]*second\.cutoverReceiptHash, first\.cutoverReceiptHash/u);
  assert.match(commerceTest, /v1_v2_postgres_odoo_contract\.json[\s\S]*enqueueAuthoritativeWorldStartProjection/u);
  assert.match(odooTest, /v1_v2_postgres_odoo_contract\.json[\s\S]*test_v1_v2_contract_keeps_revision_one_per_new_world/u);
});

test("aktueller Karteninstallationsvertrag bindet 2026.4 an den echten 2026.2-Rueckweg und verwirft 2026.3", async () => {
  const documentation = await read("docs/kartenartefakte-installation.md");
  const currentContract = documentation.slice(documentation.indexOf("## Reproduzierbarer Buildbeleg"));
  assert.match(currentContract, /DATABASE_ROLLBACK_RELEASE_ID=infra-deutschland-2026\.4/u);
  assert.match(currentContract, /DATABASE_ROLLBACK_PREVIOUS_RELEASE_ID=infra-deutschland-2026\.2/u);
  assert.match(currentContract, /infra-deutschland-2026\.3[^\n]*verworfen[\s\S]*nicht vertrauenswürdig[\s\S]*weder Preflight- noch Aktivierungsquelle/u);
  assert.match(currentContract, /create-database-backup-restore-evidence\.mjs/u);
  assert.match(currentContract, /zugfolge-database-backup-manifest\/v1[\s\S]*zugfolge-database-restore-proof\/v1/u);
  assert.doesNotMatch(currentContract, /infra-deutschland-2026\.1/u);
});

test("Produktions-Runbooks erzwingen Schema 33, Keycloak-Up und Hot-Drill in dieser Reihenfolge", async () => {
  const [installation, recovery, keycloak, rollbackCompose] = await Promise.all([
    read("ALPHA-INSTALL.md"),
    read("docs/produktions-recovery-v2-v1.md"),
    read("docs/keycloak-schema-migration.md"),
    read("compose.alpha.rollback.yml"),
  ]);
  for (const source of [installation, recovery]) {
    const schema33 = source.indexOf("--schema33-after-cold");
    const keycloakUp = source.indexOf("--keycloak-after-schema33", schema33);
    const hot = source.indexOf("--prepare-v2-hot", keycloakUp);
    assert.ok(schema33 >= 0 && keycloakUp > schema33 && hot > keycloakUp);
    assert.match(source, /preflight-up[\s\S]*Fresh-Bootstrap-Receipt[\s\S]*unzulässig/u);
  }
  assert.match(keycloak, /--keycloak-after-schema33[\s\S]*bind-backup[\s\S]*plan-up[\s\S]*`up`[\s\S]*preflight-up/u);
  assert.match(keycloak, /--keycloak-recover-after-schema33/u);
  assert.match(recovery, /Rollback-Compose[\s\S]*KC_DB_SCHEMA=keycloak[\s\S]*KC_DB_SCHEMA=public[\s\S]*schema29-keycloak-runtime/u);
  assert.match(recovery, /PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID[\s\S]*exakten[\s\S]*Regionsmenge[\s\S]*wartet derselbe[\s\S]*`\/health\/ready`[\s\S]*neue\s+autoritative Revision in genau dieser Welt/u);
  assert.match(recovery, /continuity-000000-origin[\s\S]*origin\(0\) → reseal\(1\) → continue\(2\)[\s\S]*Revision `N → N\+1`/u);
  assert.match(recovery, /source-transition-000001-release[\s\S]*Sequenz 2 als `reseal`[\s\S]*Sequenz 3[\s\S]*`release`/u);
  assert.match(installation, /ExecStopPost[\s\S]*--attested-rollback-stop[\s\S]*neue Start verwendet `continue`, nicht erneut `activate`/u);
  assert.match(installation, /source-transition-000001-release[\s\S]*Sequenz 2 als `reseal`[\s\S]*Sequenz 3 als `release`/u);
  assert.match(rollbackCompose, /KC_DB_SCHEMA: keycloak/u);
  assert.doesNotMatch(rollbackCompose, /KC_DB_SCHEMA: public/u);
  const rollbackOdoo = rollbackCompose.slice(rollbackCompose.indexOf("  odoo:"));
  assert.match(rollbackOdoo, /\$\{PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT:\?[^}]+\}\/\$\{PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE:\?[^}]+\}:\/var\/lib\/odoo\/filestore\/\$\{PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE:\?[^}]+\}:rw/u);
  assert.doesNotMatch(rollbackOdoo, /\$\{PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT:\?[^}]+\}:\/var\/lib\/odoo\/filestore:rw/u);
  assert.equal((rollbackOdoo.match(/\/var\/lib\/odoo\/filestore/gu) ?? []).length, 1);
});

test("die erweiterte Abnahme prueft Keycloak mit echter Identitaet und Token vor, nach Up und nach Down", async () => {
  const [workflow, integration, migration] = await Promise.all([
    read(".github/workflows/extended.yml"),
    read("tools/alpha-ops/keycloak-public-to-schema.real-integration.sh"),
    read("tools/alpha-ops/keycloak-public-to-schema.mjs"),
  ]);
  assert.match(workflow, /keycloak-public-to-schema\.real-integration\.sh[\s\\]+\s+"\$TEST_DATABASE_URL"/u);
  assert.match(integration, /quay\.io\/keycloak\/keycloak:26\.7\.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13/u);
  assert.match(integration, /start_keycloak public[\s\S]*create_isolated_restore[^\n]+up[\s\S]*run_mutating_command bind-backup[\s\S]*run_mutating_command plan-up[\s\S]*run_mutating_command up[\s\S]*run_mutating_command recover[\s\S]*start_keycloak keycloak/u);
  assert.match(integration, /run_mutating_command recover[^\n]+up\/recover-receipt\.json[\s\S]*run_runtime_gate preflight-up[^\n]+up\/recover-receipt\.json/u);
  assert.match(integration, /create_isolated_restore[^\n]+down[\s\S]*run_mutating_command plan-down[\s\S]*run_mutating_command down[\s\S]*run_mutating_command recover[\s\S]*start_keycloak public/u);
  assert.match(integration, /legacy_subject.*migrated_subject.*rolled_back_subject/u);
  assert.match(integration, /firstName.*lastName.*email.*requiredActions/u);
  assert.match(integration, /response\.error_description/u);
  assert.match(integration, /Keycloak player token failed:/u);
  assert.match(migration, /collation_row\.collname as "collation"/u);
  assert.match(migration, /pg_collation as collation_row on collation_row\.oid/u);
  assert.doesNotMatch(migration, /pg_collation as collation on collation\.oid/u);
  assert.match(integration, /rolled_back_subject[\s\S]*create_backup "\$evidence_root\/final_up"[\s\S]*create_isolated_restore "\$evidence_root\/final_up" final_up[\s\S]*run_mutating_command bind-backup "\$evidence_root\/final_up"[\s\S]*run_mutating_command plan-up "\$evidence_root\/final_up"[\s\S]*run_mutating_command up "\$evidence_root\/final_up"[\s\S]*run_runtime_gate preflight[^\n]+final_up\/receipt\.json/u);
  assert.doesNotMatch(integration, /rolled_back_subject[\s\S]*run_mutating_command up "\$evidence_root\/up"/u);
  assert.match(integration, /"finalState":"migrated"/u);
  assert.ok(
    workflow.indexOf("keycloak-public-to-schema.real-integration.sh")
      < workflow.indexOf("Game-Backup, isolierter Restore und gleicher autoritativer Hash"),
    "der Rollbackbeweis darf erst nach dem final migrierten Keycloak-Zustand laufen",
  );
  assert.match(integration, /tokenIdentityPreserved/u);
});

test("Produktions-Bootstrap ist auf genau eine signierte öffentliche Welt begrenzt", async () => {
  const [bootstrap, apply, environmentSource] = await Promise.all([
    read("tools/alpha-ops/production-db-bootstrap.mjs"),
    read("tools/alpha-ops/world-deployment-cutover-apply.mjs"),
    read(".env.example"),
  ]);
  assert.match(bootstrap, /deploymentPaths\.length !== 1/);
  assert.match(bootstrap, /definition\.kind !== "public" \|\| definition\.rankingStatus !== "ranked"/);
  assert.match(bootstrap, /applyWorldDeploymentCutover/);
  assert.match(bootstrap, /const uiWorldId = assertProductionServerWorldEnvironment\(process.env\);/u);
  assert.ok(bootstrap.indexOf("const uiWorldId = assertProductionServerWorldEnvironment") < bootstrap.indexOf("const client = postgres("));
  assert.match(apply, /on conflict \(id\) do nothing/);
  assert.match(apply, /widerspricht dem signierten Vertrag/);
  assert.match(bootstrap, /ensureSignedPlanningAuthority/);
  const deploymentValue = /^ALPHA_WORLD_RELEASE_PATHS_JSON=(.+)$/mu.exec(environmentSource)?.[1];
  assert.notEqual(deploymentValue, undefined);
  assert.deepEqual(JSON.parse(deploymentValue), ["/evidence/alpha-world-deployment.json"]);
});

test("Game trennt einen kanonischen Release-Keyring strikt nach Alpha- und Map-/Infra-Rolle", async () => {
  const [server, dockerfile] = await Promise.all([
    read("apps/game-api/src/server.ts"),
    read("ops/alpha/container/Dockerfile"),
  ]);
  assert.match(server, /const trustedReleaseKeys = parseTrustedReleaseKeys\(requireEnv\("INFRA_RELEASE_TRUSTED_KEYS_JSON"\)\);[\s\S]*parseTrustedReleaseKeyScopes\([\s\S]*requireEnv\("RELEASE_TRUSTED_KEY_SCOPES_JSON"\)[\s\S]*trustedReleaseKeys[\s\S]*const alphaWorldTrustedKeys = trustedReleaseKeyScopes\.alphaWorldDeployments;[\s\S]*const mapInfraTrustedKeys = trustedReleaseKeyScopes\.mapInfraDeliveries;/u);
  assert.match(server, /loadOptionalInfraPackageStaging\(mapInfraTrustedKeys\)/u);
  assert.match(server, /alphaWorldReleasePaths\(\)\.map\(\(path\) => loadSignedAlphaWorldDeployment\(path, alphaWorldTrustedKeys\)\)/u);
  assert.match(server, /resolveAlphaWorldStartupDeployments\([\s\S]*db,[\s\S]*alphaWorldTrustedKeys,[\s\S]*configuredSignedDeployments,[\s\S]*\)/u);
  assert.match(server, /new InfraUpdateService\([\s\S]*mapInfraTrustedKeys/u);
  assert.match(server, /trustedKeys: alphaWorldTrustedKeys/u);
  assert.match(server, /createInfraOperationalV2NativeVerifier\(operationalVerifierPath\)/u);
  assert.match(server, /new InfraPackageStaging\(root, \{ packageVerifier, trustedReleaseKeys, nativeOperationalVerifier \}\)/u);
  assert.doesNotMatch(server, /new InfraPackageStaging\(root, \{ packageVerifier \}\)/u);
  assert.match(
    dockerfile,
    /COPY tools\/region-import\/germany\/operational-infrastructure-v2-direct-contract-launcher\.windows\.ps1 tools\/region-import\/germany\/operational-infrastructure-v2-direct-contract-launcher\.windows\.ps1/u,
  );
  assert.match(
    dockerfile,
    /RUN cargo build[^\n]+-p zugfolge-runtime-napi --features node-addon -p zugfolge-planning-runtime-napi --features node-addon\nRUN cargo build[^\n]+-p zugfolge-infra --bin zugfolge-infra-release/u,
  );
  assert.match(dockerfile, /cargo build[^\n]+-p zugfolge-infra --bin zugfolge-infra-release/u);
  assert.match(dockerfile, /COPY --from=native \/src\/target\/release\/zugfolge-infra-release \/app\/native\/zugfolge-infra-release/u);
  assert.match(dockerfile, /INFRA_OPERATIONAL_V2_VALIDATOR_PATH=\/app\/native\/zugfolge-infra-release/u);
});

test("Image-Provenienz wird aus einem sauberen echten Git-HEAD abgeleitet", async () => {
  const directory = await cleanRepositoryFixture();
  try {
    const expected = (await git(directory, "rev-parse", "HEAD")).stdout.trim();
    const provenance = resolveImageProvenance({ cwd: directory, environment: {} });
    assert.equal(provenance.sourceSha, expected);
    assert.match(provenance.sourceSha, /^[0-9a-f]{40}$/u);
    assert.equal(provenance.deployPatchSha, "none");
    assert.equal(
      resolveImageProvenance({
        cwd: directory,
        environment: { ZUGFOLGE_SOURCE_SHA: expected, ZUGFOLGE_DEPLOY_PATCH_SHA: "none" },
      }).sourceSha,
      expected,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Image-Provenienz verweigert selbstdeklarierte SHA, Deploypatch und schmutzige Bäume", async () => {
  const directory = await cleanRepositoryFixture();
  try {
    assert.throws(
      () => resolveImageProvenance({ cwd: directory, environment: { ZUGFOLGE_SOURCE_SHA: "a".repeat(39) } }),
      /stimmt nicht exakt/u,
    );
    assert.throws(
      () => resolveImageProvenance({ cwd: directory, environment: { ZUGFOLGE_SOURCE_SHA: "f".repeat(40) } }),
      /stimmt nicht exakt/u,
    );
    assert.throws(
      () => resolveImageProvenance({ cwd: directory, environment: { ZUGFOLGE_DEPLOY_PATCH_SHA: "a".repeat(40) } }),
      /Separate Deploypatches sind verboten/u,
    );

    await writeFile(join(directory, "tracked.txt"), "lokal geaendert\n", "utf8");
    assert.throws(
      () => resolveImageProvenance({ cwd: directory, environment: {} }),
      /vollstaendig sauberen Git-Checkout/u,
    );
    await writeFile(join(directory, "tracked.txt"), "freigegeben\n", "utf8");
    await writeFile(join(directory, "untracked.txt"), "nicht committed\n", "utf8");
    assert.throws(
      () => resolveImageProvenance({ cwd: directory, environment: {} }),
      /vollstaendig sauberen Git-Checkout/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Telemetry-Gap alarmiert jedes verpflichtende Healthsignal einzeln", async () => {
  const alerts = await read("ops/alpha/alerts.yml");
  assert.match(alerts, /ZugfolgeHealthSignalMissing[\s\S]*unless on \(check\)/);
  for (const check of [
    "postgres",
    "simulation-event-log",
    "economy-outbox",
    "economy-scheduler",
    "regional-simulation-scheduler",
    "livemap-freshness",
    "disruption-provider",
    "odoo-bridge",
  ]) {
    assert.match(alerts, new RegExp(`label_replace\\(vector\\(1\\), "check", "${check}"`));
  }
  assert.match(alerts, /summary: "Verpflichtendes Alpha-Healthsignal \{\{ \$labels\.check \}\} fehlt"/);
});
