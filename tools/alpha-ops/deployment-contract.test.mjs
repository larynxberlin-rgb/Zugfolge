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

test("Alpha-Compose erzwingt Map-Gate, Migration, signierten Bootstrap und einen Build ohne impliziten Neubau", async () => {
  const [compose, dockerfile, odooDockerfile, start, build, mapPreflight] = await Promise.all([
    read("compose.alpha.yml"),
    read("ops/alpha/container/Dockerfile"),
    read("ops/alpha/odoo/Dockerfile"),
    read("tools/alpha-ops/phase1-smoke.sh"),
    read("tools/alpha-ops/build-alpha-images.sh"),
    read("tools/alpha-ops/map-release-deployment-preflight.mjs"),
  ]);

  assert.match(compose, /map-release-preflight:[\s\S]*map-release-deployment-preflight\.mjs, "\$\{MAP_RELEASE_START_PREFLIGHT_MODE:\?[^}]+\}"/u);
  assert.match(compose, /MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: "\$\{MAP_RELEASE_ID:\?[^}]+\}"/u);
  assert.match(compose, /\$\{MAP_RELEASE_DEPLOYMENT_HOST_ROOT(?::-\.\/var\/maps|:\?[^}]+)\}:\/map-deployment:ro/u);
  assert.match(compose, /\$\{MAP_RELEASE_PREFLIGHT_HOST_DIR:\?[^}]+\}:\/map-preflight:ro/u);
  assert.match(compose, /\$\{MAP_RELEASE_RESTORE_HOST_DIR:\?[^}]+\}:\/map-restore:ro/u);
  assert.match(compose, /\$\{MAP_RELEASE_DEPLOYMENT_HOST_ROOT:\?[^}]+\}\/\$\{MAP_RELEASE_HOST_DIR:\?[^}]+\}:\/map-release:ro/u);
  assert.match(compose, /\$\{MAP_RELEASE_DEPLOYMENT_HOST_ROOT:\?[^}]+\}\/\$\{MAP_RELEASE_HOST_DIR:\?[^}]+\}:\/map-artifacts\/maps\/\$\{MAP_RELEASE_ID:\?[^}]+\}:ro/u);
  assert.match(compose, /game-migrate:[\s\S]*packages\/db\/dist\/migrate\.js/);
  assert.match(compose, /game-migrate:[\s\S]*map-release-preflight: \{ condition: service_completed_successfully \}/u);
  assert.match(compose, /game-bootstrap:[\s\S]*production-db-bootstrap\.mjs/);
  assert.match(compose, /depends_on: \{ game-bootstrap: \{ condition: service_completed_successfully \}, keycloak-reconcile: \{ condition: service_completed_successfully \} \}/);
  assert.match(compose, /game-api:[\s\S]*healthcheck: \{ <<: \*health, start_period: 15m,[^\n]+\/health\/ready/u);
  assert.match(compose, /odoo-upgrade:[\s\S]*--update=zugfolge_admin[\s\S]*--stop-after-init[\s\S]*restart: "no"/u);
  assert.match(compose, /odoo-upgrade:[\s\S]*HOST: odoo-postgres[\s\S]*USER: odoo[\s\S]*PASSWORD: "\$\{ODOO_DB_PASSWORD\}"/u);
  assert.match(compose, /odoo:[\s\S]*depends_on: \{ odoo-upgrade: \{ condition: service_completed_successfully \}, game-api:/u);
  assert.match(compose, /^name: zugfolge$/mu);
  assert.match(compose, /odoo-upgrade:[\s\S]*image: zugfolge-odoo:alpha/u);
  assert.match(compose, /\n  odoo:\n    image: zugfolge-odoo:alpha/u);
  assert.match(compose, /\n  odoo:[\s\S]*HOST: odoo-postgres[\s\S]*USER: odoo[\s\S]*PASSWORD: "\$\{ODOO_DB_PASSWORD\}"/u);
  const odooAddonPaths = [...compose.matchAll(/--addons-path=([^\s\]]+)/gu)];
  assert.equal(odooAddonPaths.length, 2);
  assert.equal(odooAddonPaths.every((match) => match[1]?.includes("/opt/zugfolge-addons")), true);
  assert.doesNotMatch(compose, /--addons-path=[^\s\]]*\/mnt\/extra-addons/u);
  assert.match(odooDockerfile, /\/opt\/zugfolge-addons\/queue_job/u);
  assert.match(odooDockerfile, /\/opt\/zugfolge-addons\/zugfolge_admin/u);
  assert.doesNotMatch(odooDockerfile, /\/mnt\/extra-addons/u);
  assert.match(compose, /\n  keycloak:[\s\S]*command: \[start, --import-realm, --health-enabled=true, --http-enabled=true\]/u);
  assert.match(compose, /\n  keycloak:\n    image: quay\.io\/keycloak\/keycloak:26\.7\.0/u);
  assert.match(compose, /\n  keycloak:[\s\S]*KC_HOSTNAME: "\$\{KEYCLOAK_PUBLIC_URL\}"[\s\S]*KC_PROXY_HEADERS: xforwarded/u);
  assert.match(compose, /keycloak:[\s\S]*proxy: \{ aliases: \[zugfolge-keycloak\] \}[\s\S]*mail: \{\}/u);
  assert.match(compose, /game-web:[\s\S]*proxy: \{ aliases: \[zugfolge-world-web\] \}/u);
  assert.match(compose, /livemap:[\s\S]*proxy: \{ aliases: \[zugfolge-world-livemap\] \}/u);
  assert.match(compose, /\n  odoo:[\s\S]*proxy: \{ aliases: \[zugfolge-odoo\] \}[\s\S]*mail: \{\}/u);
  assert.match(compose, /networks:[\s\S]*proxy: \{ external: true, name: zugfolge-proxy \}[\s\S]*mail: \{ external: true, name: zugfolge-mail \}/u);
  assert.match(mapPreflight, /expectedReleaseForMapPreflight\(evidence, mode, configuredReleaseId\)/u);
  assert.match(mapPreflight, /expectedActiveReleaseId/u);
  assert.doesNotMatch(mapPreflight, /fallback/u);
  assert.match(compose, /ZUGFOLGE_SOURCE_SHA: "\$\{ZUGFOLGE_SOURCE_SHA:-unversioned\}"/);
  assert.match(compose, /ZUGFOLGE_DEPLOY_PATCH_SHA: "\$\{ZUGFOLGE_DEPLOY_PATCH_SHA:-unversioned\}"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{ZUGFOLGE_SOURCE_SHA\}"/);
  assert.match(dockerfile, /de\.zugfolge\.deploy-patch="\$\{ZUGFOLGE_DEPLOY_PATCH_SHA\}"/);
  assert.match(dockerfile, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(dockerfile, /test "\$\{ZUGFOLGE_DEPLOY_PATCH_SHA\}" = "none"/);
  assert.match(start, /up --no-build --wait/);
  assert.doesNotMatch(start, /--build/);
  assert.match(build, /source_sha=\$\(node tools\/alpha-ops\/image-provenance\.mjs\)/);
  assert.match(build, /export ZUGFOLGE_SOURCE_SHA="\$source_sha"/);
  assert.match(build, /export ZUGFOLGE_DEPLOY_PATCH_SHA=none/);
  assert.match(build, /compose-with-map-release-env\.sh" -f "\$repository_root\/compose\.alpha\.yml" build/u);
  assert.match(build, /docker image inspect zugfolge-game-api/);
  assert.match(build, /docker image inspect zugfolge-odoo:alpha/);
});

test("Produktionsfreigabe dokumentiert .1 nur manuell und startet Fresh-Compose fail-closed mit .2", async () => {
  const [compose, environmentSource, installation] = await Promise.all([
    read("compose.alpha.yml"),
    read(".env.example"),
    read("ALPHA-INSTALL.md"),
  ]);
  const preflightService = compose.slice(
    compose.indexOf("  map-release-preflight:"),
    compose.indexOf("  game-migrate:"),
  );
  const migrateService = compose.slice(
    compose.indexOf("  game-migrate:"),
    compose.indexOf("  game-bootstrap:"),
  );
  assert.match(preflightService, /command: \[node, tools\/alpha-ops\/map-release-deployment-preflight\.mjs, "\$\{MAP_RELEASE_START_PREFLIGHT_MODE:\?[^}]+\}"\]/u);
  assert.match(preflightService, /MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: "\$\{MAP_RELEASE_ID:\?[^}]+\}"/u);
  assert.doesNotMatch(preflightService, /pre-activation|infra-deutschland-2026\.1/u);
  assert.match(migrateService, /map-release-preflight: \{ condition: service_completed_successfully \}/u);

  assert.match(environmentSource, /^MAP_RELEASE_DEPLOYMENT_HOST_ROOT=\.\/var\/maps$/mu);
  assert.match(environmentSource, /^MAP_RELEASE_PREFLIGHT_HOST_DIR=\.\/var\/map-release-preflight$/mu);
  assert.match(environmentSource, /^MAP_RELEASE_RESTORE_HOST_DIR=\.\/var\/map-release-restore\/infra-deutschland-2026\.2$/mu);
  assert.doesNotMatch(environmentSource, /^MAP_RELEASE_HOST_DIR=/mu);
  assert.doesNotMatch(environmentSource, /^MAP_RELEASE_ID=/mu);
  assert.doesNotMatch(environmentSource, /^MAP_BASEMAP_STYLE_URL=/mu);
  assert.doesNotMatch(environmentSource, /^MAP_GERMANY_PMTILES_URL=/mu);

  assert.match(installation, /compose-with-map-release-env\.sh[\s\\]+\s+-f \/opt\/zugfolge\/compose\.yml run --rm --no-deps/u);
  assert.doesNotMatch(installation, /-e MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID=/u);
  assert.match(installation, /map-release-deployment-preflight\.mjs pre-activation/u);
  assert.match(installation, /compose-with-map-release-env\.sh[\s\\]+\s+-f \/opt\/zugfolge\/compose\.yml up --no-build --wait/u);
  assert.match(installation, /`\.1` wird im normalen Startpfad niemals automatisch aktiviert/u);
});

test("Produktions-Bootstrap ist auf genau eine signierte öffentliche Welt begrenzt", async () => {
  const [bootstrap, environmentSource] = await Promise.all([
    read("tools/alpha-ops/production-db-bootstrap.mjs"),
    read(".env.example"),
  ]);
  assert.match(bootstrap, /deploymentPaths\.length !== 1/);
  assert.match(bootstrap, /definition\.kind !== "public" \|\| definition\.rankingStatus !== "ranked"/);
  assert.match(bootstrap, /onConflictDoNothing/);
  assert.match(bootstrap, /widerspricht dem signierten Vertrag/);
  assert.match(bootstrap, /ensureSignedPlanningAuthority/);
  const deploymentValue = /^ALPHA_WORLD_RELEASE_PATHS_JSON=(.+)$/mu.exec(environmentSource)?.[1];
  assert.notEqual(deploymentValue, undefined);
  assert.deepEqual(JSON.parse(deploymentValue), ["/evidence/alpha-world-deployment.json"]);
});

test("Infra-Paketstaging erbt denselben Release-Trust-Store wie der Weltstart", async () => {
  const server = await read("apps/game-api/src/server.ts");
  assert.match(server, /const trustedReleaseKeys = parseTrustedReleaseKeys\(requireEnv\("INFRA_RELEASE_TRUSTED_KEYS_JSON"\)\);[\s\S]*loadOptionalInfraPackageStaging\(trustedReleaseKeys\)/u);
  assert.match(server, /new InfraPackageStaging\(root, \{ packageVerifier, trustedReleaseKeys \}\)/u);
  assert.doesNotMatch(server, /new InfraPackageStaging\(root, \{ packageVerifier \}\)/u);
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
