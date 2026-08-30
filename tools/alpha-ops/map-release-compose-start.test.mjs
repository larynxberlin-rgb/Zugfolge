import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const CURRENT_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const LEGACY_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const LEGACY_IMAGE_REFERENCE = `registry.example/zugfolge/game-api@${LEGACY_IMAGE_DIGEST}`;
const CURRENT_ODOO_IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const LEGACY_ODOO_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const LEGACY_ODOO_IMAGE_REFERENCE = `registry.example/zugfolge/odoo@${LEGACY_ODOO_IMAGE_DIGEST}`;

function bashPath() {
  if (process.platform !== "win32") return "bash";
  return "C:\\Program Files\\Git\\bin\\bash.exe";
}

function bashDirectoryPath(path) {
  if (process.platform !== "win32") return path;
  return `/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
}

async function wrapperFixture(t, {
  environmentLines = [],
  pointerLines = [],
  releaseId = "infra-deutschland-2026.2",
  currentImageReference = CURRENT_IMAGE_DIGEST,
  legacyImageDigest = LEGACY_IMAGE_DIGEST,
  legacyImageReference = LEGACY_IMAGE_REFERENCE,
  currentOdooImageReference = CURRENT_ODOO_IMAGE_DIGEST,
  postgresDatabase = "zugfolge",
  legacyOdooImageDigest = LEGACY_ODOO_IMAGE_DIGEST,
  legacyOdooImageReference = LEGACY_ODOO_IMAGE_REFERENCE,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-compose-pointer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "tools", "alpha-ops", "compose-with-map-release-env.sh");
  await mkdir(dirname(script), { recursive: true });
  await cp(new URL("./compose-with-map-release-env.sh", import.meta.url), script);
  await writeFile(join(directory, "compose.alpha.yml"), "name: zugfolge\nservices: {}\n", "utf8");
  await cp(new URL("../../compose.alpha.rollback.yml", import.meta.url), join(directory, "compose.alpha.rollback.yml"));
  await writeFile(join(directory, ".env"), [
    "MAP_RELEASE_DEPLOYMENT_HOST_ROOT=./maps",
    "POSTGRES_USER=zugfolge",
    `POSTGRES_DB=${postgresDatabase}`,
    `ZUGFOLGE_GAME_API_IMAGE_REFERENCE=${currentImageReference}`,
    `ZUGFOLGE_ODOO_IMAGE_REFERENCE=${currentOdooImageReference}`,
    `MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST=${legacyImageDigest}`,
    `MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE=${legacyImageReference}`,
    `PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST=${legacyOdooImageDigest}`,
    `PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE=${legacyOdooImageReference}`,
    "PRODUCTION_RECOVERY_ID=rollback-2026.2-001",
    "PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID=infra-deutschland-2026.2",
    "PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID=infra-deutschland-2026.1",
    "PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID=00000000-0000-4000-8000-000000000014",
    "PRODUCTION_RECOVERY_EVIDENCE_HOST_ROOT=./production-recovery/evidence",
    "PRODUCTION_RECOVERY_BACKUP_HOST_ROOT=./production-recovery/material",
    "PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT=./production-recovery/odoo-filestore",
    "KEYCLOAK_SCHEMA_EVIDENCE_HOST_DIR=./keycloak-schema/evidence",
    "KEYCLOAK_SCHEMA_BACKUP_HOST_DIR=./keycloak-schema/backup",
    "KEYCLOAK_SCHEMA_RESTORE_DATABASE=zugfolge_restore_keycloak_schema",
    "KEYCLOAK_SCHEMA_RECEIPT_CONTAINER_PATH=/keycloak-schema/receipt.json",
    "KEYCLOAK_SCHEMA_RECEIPT_OUTPUT_CONTAINER_PATH=/keycloak-schema/receipt.json",
    "PRODUCTION_RECOVERY_GAME_RESTORE_DATABASE=zugfolge_recovery_v1_test",
    "PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE=zugfolge_odoo_recovery_v1_test",
    "PRODUCTION_RECOVERY_GAME_VERIFY_DATABASE=zugfolge_restore_recovery_test",
    "PRODUCTION_COLD_GAME_RESTORE_DATABASE=zugfolge_recovery_v1_verify_test",
    "PRODUCTION_COLD_ODOO_RESTORE_DATABASE=zugfolge_odoo_recovery_v1_cold_test",
    "PRODUCTION_SCHEMA29_GAME_RESTORE_DATABASE=zugfolge_recovery_v1_schema29_test",
    "PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE=zugfolge_odoo_recovery_v1_schema29_test",
    "PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_DATABASE=zugfolge_recovery_v1_schema29_runtime_test",
    "PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_DATABASE=zugfolge_odoo_recovery_v1_schema29_runtime_test",
    "PRODUCTION_RECOVERY_ODOO_RUNTIME_UID=100",
    "PRODUCTION_RECOVERY_ODOO_RUNTIME_GID=101",
    ...environmentLines,
    "",
  ].join("\n"));
  await mkdir(join(directory, "maps", "active"), { recursive: true });
  await mkdir(join(directory, "production-recovery", "evidence"), { recursive: true });
  await mkdir(join(directory, "production-recovery", "material"), { recursive: true });
  await mkdir(join(directory, "production-recovery", "odoo-filestore"), { recursive: true });
  await mkdir(join(directory, "production-recovery", "odoo-filestore", "zugfolge_odoo_recovery_v1_schema29_runtime_test"));
  await mkdir(join(directory, "keycloak-schema", "evidence"), { recursive: true });
  await mkdir(join(directory, "keycloak-schema", "backup"), { recursive: true });
  await writeFile(join(directory, "production-recovery", "evidence", "rollback-2026.2-001.schema31-prepared.json"), "{}\n");
  await writeFile(join(directory, "maps", "active", "map-release.env"), [
    `MAP_RELEASE_ID=${releaseId}`,
    `MAP_RELEASE_HOST_DIR=releases/${releaseId}`,
    `MAP_BASEMAP_STYLE_URL=/artifacts/maps/${releaseId}/style.json`,
    `MAP_GERMANY_PMTILES_URL=/artifacts/maps/${releaseId}/${releaseId}.pmtiles`,
    ...pointerLines,
    "",
  ].join("\n"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const docker = join(bin, "docker");
  await writeFile(docker, [
    "#!/usr/bin/env bash",
    "printf 'CALL=%s\\n' \"$*\"",
    "printf 'ARG=%s\\n' \"$@\"",
    "printf 'SHELL_MAP_RELEASE_ID=%s\\n' \"${MAP_RELEASE_ID-unset}\"",
    "printf 'SHELL_MAP_RELEASE_HOST_DIR=%s\\n' \"${MAP_RELEASE_HOST_DIR-unset}\"",
    "printf 'START_PREFLIGHT_MODE=%s\\n' \"${MAP_RELEASE_START_PREFLIGHT_MODE-unset}\"",
    "printf 'SHELL_CURRENT_IMAGE=%s\\n' \"${ZUGFOLGE_GAME_API_IMAGE_REFERENCE-unset}\"",
    "printf 'SHELL_CURRENT_ODOO_IMAGE=%s\\n' \"${ZUGFOLGE_ODOO_IMAGE_REFERENCE-unset}\"",
    "printf 'RECOVERY_ACTION_RECEIPT=%s\\n' \"${PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH-unset}\"",
    "printf 'SOURCE_ACTION_RECEIPT=%s\\n' \"${PRODUCTION_RECOVERY_SOURCE_ACTION_RECEIPT_OUTPUT_PATH-unset}\"",
    "printf 'SOURCE_INTENT=%s\\n' \"${PRODUCTION_RECOVERY_SOURCE_INTENT_OUTPUT_PATH-unset}\"",
    "printf 'SCHEMA29_ODOO_FILESTORE_HOST_PATH=%s\\n' \"${PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH-unset}\"",
    "if [[ -n \"${FAKE_DB_CONTAINER_ID_STATE_PATH:-}\" ]]; then",
    "  expected_db_ids=${FAKE_EXPECTED_DB_CONTAINER_IDS:-db-container-ids-v1}",
    "  removes_database=0",
    "  if [[ \" $* \" == *\" rm --force \"* ]]; then",
    "    for argument in \"$@\"; do",
    "      if [[ \"$argument\" == postgres || \"$argument\" == odoo-postgres ]]; then removes_database=1; fi",
    "    done",
    "  fi",
    "  if [[ \" $* \" == *\" down \"* || $removes_database == 1 ]]; then",
    "    printf 'db-container-ids-recreated\\n' > \"$FAKE_DB_CONTAINER_ID_STATE_PATH\"",
    "  fi",
    "  observed_db_ids=$(tr -d '\\r\\n' < \"$FAKE_DB_CONTAINER_ID_STATE_PATH\")",
    "  printf 'DB_CONTAINER_IDS=%s\\n' \"$observed_db_ids\"",
    "  if [[ \" $* \" == *\" production-recovery-action \"* && \"$observed_db_ids\" != \"$expected_db_ids\" ]]; then exit 71; fi",
    "fi",
    "previous=",
    "for argument in \"$@\"; do",
    "  if [[ \"$previous\" == --env-file ]]; then",
    "    snapshot_id=$(sed -n 's/^MAP_RELEASE_ID=//p' -- \"$argument\")",
    "    printf 'SNAPSHOT_MAP_RELEASE_ID=%s\\n' \"$snapshot_id\"",
    "  fi",
    "  previous=$argument",
    "done",
    "if [[ \" $* \" == *\" ${FAKE_POINTER_REPLACE_ACTION:-down} \"* && -n \"${FAKE_POINTER_TO_REPLACE:-}\" ]]; then",
    "  replacement=${FAKE_REPLACEMENT_RELEASE_ID:-infra-deutschland-2099.9}",
    "  printf 'MAP_RELEASE_ID=%s\\nMAP_RELEASE_HOST_DIR=releases/%s\\nMAP_BASEMAP_STYLE_URL=/artifacts/maps/%s/style.json\\nMAP_GERMANY_PMTILES_URL=/artifacts/maps/%s/%s.pmtiles\\n' \"$replacement\" \"$replacement\" \"$replacement\" \"$replacement\" \"$replacement\" > \"$FAKE_POINTER_TO_REPLACE\"",
    "fi",
    "if [[ \" $* \" == *\" wait-legacy-game-readiness.mjs baseline \"* ]]; then",
    "  printf '{\"schema\":\"zugfolge-legacy-revision-baseline/v2\",\"regionCount\":\"1\",\"regionIds\":[\"de-sn-leipzig\"],\"revisionTotal\":\"41\",\"worldId\":\"00000000-0000-4000-8000-000000000014\"}\\n'",
    "fi",
    "if [[ \"${FAKE_CREATE_SCHEMA29_FILESTORE_OPEN:-0}\" == 1 && \"$*\" == *schema29-odoo-filestore-access.mjs* && \"${@: -1}\" == open ]]; then",
    "  printf '{}\\n' > production-recovery/evidence/rollback-2026.2-001.schema29-odoo-filestore-open.json",
    "fi",
    "if [[ -n \"${FAKE_DOCKER_FAIL_SUFFIX:-}\" && \"$*\" == *\"${FAKE_DOCKER_FAIL_SUFFIX}\" ]]; then exit 70; fi",
    "if [[ -n \"${FAKE_DOCKER_FAIL_MATCH:-}\" && \" $* \" == *\"${FAKE_DOCKER_FAIL_MATCH}\"* ]]; then exit 70; fi",
  ].join("\n"));
  await chmod(docker, 0o755);
  return { directory, script, bin };
}

function runWrapper(fixture, args = ["-f", "compose.alpha.yml", "config"], extraEnvironment = {}) {
  return spawnSync(bashPath(), [fixture.script, ...args], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      MAP_RELEASE_ID: "forged-shell-release",
      MAP_RELEASE_HOST_DIR: "forged-shell-path",
      ZUGFOLGE_GAME_API_IMAGE_REFERENCE: "zugfolge-game-api:latest",
      ZUGFOLGE_ODOO_IMAGE_REFERENCE: "zugfolge-odoo:latest",
      MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST: `sha256:${"f".repeat(64)}`,
      MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE: "zugfolge-game-api:latest",
      ...extraEnvironment,
    },
  });
}

function assertRuntimeOnlyRemoval(call) {
  assert.match(call, / rm --force /u);
  assert.doesNotMatch(call, /(?:^| )down(?: |$)/u);
  assert.doesNotMatch(call, /(?:^| )(?:postgres|odoo-postgres)(?: |$)/u);
}

test("host wrapper loads .env first and the sole active pointer last", async (t) => {
  const fixture = await wrapperFixture(t);
  const result = runWrapper(fixture);
  assert.equal(result.status, 0, result.stderr);
  const argumentsOnly = result.stdout.split("\n").filter((line) => line.startsWith("ARG=")).map((line) => line.slice(4));
  assert.equal(argumentsOnly[0], "compose");
  assert.equal(argumentsOnly[1], "--env-file");
  assert.match(argumentsOnly[2], /zugfolge-compose-env\.[A-Za-z0-9]+\/base\.env$/u);
  assert.equal(argumentsOnly[3], "--env-file");
  assert.match(argumentsOnly[4], /zugfolge-compose-env\.[A-Za-z0-9]+\/map-release\.env$/u);
  assert.equal(argumentsOnly[5], "--project-name");
  assert.equal(argumentsOnly[6], "zugfolge");
  assert.equal(argumentsOnly[7], "--project-directory");
  assert.match(argumentsOnly[8], /\/zugfolge-compose-pointer-[A-Za-z0-9_-]+$/u);
  assert.equal(argumentsOnly[9], "-f");
  assert.match(result.stdout, /^SHELL_MAP_RELEASE_ID=unset$/mu);
  assert.match(result.stdout, /^SHELL_MAP_RELEASE_HOST_DIR=unset$/mu);
  assert.match(result.stdout, /^START_PREFLIGHT_MODE=active-candidate$/mu);
  assert.match(result.stdout, /^SHELL_CURRENT_IMAGE=unset$/mu);
  assert.match(result.stdout, /^SHELL_CURRENT_ODOO_IMAGE=unset$/mu);
});

test("rollback is explicit, ignores forged mode env, and requires container recreation", async (t) => {
  const fixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  const normal = runWrapper(fixture, ["-f", "compose.alpha.yml", "config"], { MAP_RELEASE_START_PREFLIGHT_MODE: "pre-activation" });
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /^START_PREFLIGHT_MODE=active-candidate$/mu);

  const unsafeRollback = runWrapper(fixture, ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build"]);
  assert.equal(unsafeRollback.status, 64);
  assert.match(unsafeRollback.stderr, /--force-recreate/);
  const restartRollback = runWrapper(fixture, ["--attested-rollback", "-f", "compose.alpha.yml", "restart", "game-api"]);
  assert.equal(restartRollback.status, 64);
  assert.match(restartRollback.stderr, /kanonischen Gesamtstack-Start/);

  const rollback = runWrapper(fixture, ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "600"]);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(rollback.stdout, /^START_PREFLIGHT_MODE=pre-activation$/mu);
  const calls = rollback.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(calls.length, 12);
  assert.match(calls[0], /-f .*compose\.alpha\.yml .*stop --timeout 60/u);
  assert.doesNotMatch(calls[0], /compose\.alpha\.rollback\.yml/u);
  assert.match(calls[1], /-f .*compose\.alpha\.yml up --no-recreate --no-deps --no-build --wait --wait-timeout 600 postgres odoo-postgres$/u);
  assert.match(calls[2], /run --rm --no-deps[\s\S]*switch-production-recovery-source\.mjs reseal$/u);
  assert.match(calls[3], /-f .*compose\.alpha\.yml run --rm --no-deps map-release-preflight$/u);
  assert.doesNotMatch(calls[3], /compose\.alpha\.rollback\.yml/u);
  assert.match(calls[4], /run --rm --no-deps[\s\S]*activate-production-recovery\.mjs preflight$/u);
  assert.match(calls[5], /run --rm --no-deps[\s\S]*activate-production-recovery\.mjs activate$/u);
  for (const call of [calls[6], calls[7], ...calls.slice(9)]) {
    assert.match(call, /-f .*compose\.alpha\.yml -f .*compose\.alpha\.rollback\.yml up --no-deps --no-build --force-recreate --wait --wait-timeout 600/u);
    assert.doesNotMatch(call, /(?:world-deployment-cutover-preflight|game-migrate|game-bootstrap|keycloak-schema-(?:preflight|postflight)|keycloak-reconcile)/u);
  }
  assert.match(calls[6], / keycloak$/u);
  assert.match(calls[7], / game-api$/u);
  assert.match(calls[8], /-f .*compose\.alpha\.yml run --rm --no-deps production-recovery-action node tools\/alpha-ops\/wait-legacy-game-readiness\.mjs wait http:\/\/game-api:3000 [^ ]+ 7200000$/u);
  assert.doesNotMatch(calls[8], /compose\.alpha\.rollback\.yml/u);
  assert.match(calls[9], / odoo$/u);
  assert.match(calls[10], / game-web livemap operations-center static$/u);
  assert.match(calls[11], / prometheus grafana$/u);
});

test("systemd rollback restart uses append-only Legacy-Continuation instead of replaying first activation", async (t) => {
  const fixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  await writeFile(join(fixture.directory, "production-recovery", "evidence", "rollback-2026.2-001.activate.json"), "{}\n");

  const stopped = runWrapper(fixture, ["--attested-rollback-stop", "-f", "compose.alpha.yml", "down"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const stopCalls = stopped.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assertRuntimeOnlyRemoval(stopCalls.at(-1));

  const restarted = runWrapper(fixture, ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "600"]);
  assert.equal(restarted.status, 0, restarted.stderr);
  const calls = restarted.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(calls.length, 11);
  assert.match(calls[2], /switch-production-recovery-source\.mjs reseal$/u);
  assert.match(calls[4], /continue-production-recovery\.mjs$/u);
  assert.equal(calls.some((call) => /activate-production-recovery\.mjs (?:preflight|activate)$/u.test(call)), false);
  assert.match(calls[5], / keycloak$/u);
  assert.match(calls[6], / game-api$/u);
  assert.match(restarted.stdout, /^SOURCE_INTENT=\/production-recovery\/rollback-2026\.2-001\.source-reseal\.intent\.json$/mu);

  const failedFixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  await writeFile(join(failedFixture.directory, "production-recovery", "evidence", "rollback-2026.2-001.activate.json"), "{}\n");
  const failed = runWrapper(
    failedFixture,
    ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "600"],
    { FAKE_DOCKER_FAIL_MATCH: "continue-production-recovery.mjs" },
  );
  assert.notEqual(failed.status, 0);
  const failedCalls = failed.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  const continuationIndex = failedCalls.findIndex((call) => /continue-production-recovery\.mjs$/u.test(call));
  assert.ok(continuationIndex >= 0);
  assert.equal(failedCalls.slice(0, continuationIndex).some((call) => / keycloak$| game-api$| odoo$/u.test(call)), false);
  assert.ok(failedCalls.slice(continuationIndex + 1).some((call) => /activate-production-recovery\.mjs reseal$/u.test(call)));
  assert.ok(failedCalls.slice(continuationIndex + 1).some((call) => /switch-production-recovery-source\.mjs reseal$/u.test(call)));
  assertRuntimeOnlyRemoval(failedCalls.at(-1));
});

test("rollback failure and systemd stop always stop writers, reseal both stores, then remove only runtimes", async (t) => {
  const fixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  const failed = runWrapper(
    fixture,
    ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "600"],
    { FAKE_DOCKER_FAIL_MATCH: "activate-production-recovery.mjs activate" },
  );
  assert.notEqual(failed.status, 0);
  const failedCalls = failed.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.ok(failedCalls.some((call) => /activate-production-recovery\.mjs activate$/u.test(call)));
  const failedActivationIndex = failedCalls.findIndex((call) => /activate-production-recovery\.mjs activate$/u.test(call));
  assert.ok(failedCalls.slice(failedActivationIndex + 1).some((call) => / stop --timeout 60/u.test(call)));
  assert.ok(failedCalls.slice(failedActivationIndex + 1).some((call) => /activate-production-recovery\.mjs reseal$/u.test(call)));
  assert.ok(failedCalls.slice(failedActivationIndex + 1).some((call) => /switch-production-recovery-source\.mjs reseal$/u.test(call)));
  assertRuntimeOnlyRemoval(failedCalls.at(-1));

  const readinessFixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  const failedReadiness = runWrapper(
    readinessFixture,
    ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "600"],
    { FAKE_DOCKER_FAIL_MATCH: "wait-legacy-game-readiness.mjs wait" },
  );
  assert.equal(failedReadiness.status, 70);
  const failedReadinessCalls = failedReadiness.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  const readinessIndex = failedReadinessCalls.findIndex((call) => /wait-legacy-game-readiness\.mjs wait/u.test(call));
  assert.ok(readinessIndex > 0);
  assert.equal(failedReadinessCalls.slice(0, readinessIndex).some((call) => / odoo$/u.test(call)), false);
  assert.equal(failedReadinessCalls.slice(0, readinessIndex).some((call) => / game-web livemap operations-center static$/u.test(call)), false);
  assert.ok(failedReadinessCalls.slice(readinessIndex + 1).some((call) => / stop --timeout 60/u.test(call)));
  assert.ok(failedReadinessCalls.slice(readinessIndex + 1).some((call) => /activate-production-recovery\.mjs reseal$/u.test(call)));
  assert.ok(failedReadinessCalls.slice(readinessIndex + 1).some((call) => /switch-production-recovery-source\.mjs reseal$/u.test(call)));
  assertRuntimeOnlyRemoval(failedReadinessCalls.at(-1));

  const stopped = runWrapper(fixture, ["--attested-rollback-stop", "-f", "compose.alpha.yml", "down"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const stopCalls = stopped.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(stopCalls.length, 5);
  assert.match(stopCalls[0], / stop --timeout 60/u);
  assert.match(stopCalls[1], / up --no-recreate --no-deps --no-build --wait --wait-timeout 600 postgres odoo-postgres$/u);
  assert.match(stopCalls[2], /activate-production-recovery\.mjs reseal$/u);
  assert.match(stopCalls[3], /switch-production-recovery-source\.mjs reseal$/u);
  assertRuntimeOnlyRemoval(stopCalls[4]);
});

test("wrapper accepts only immutable current and digest-bound legacy image references", async (t) => {
  const repositoryReference = await wrapperFixture(t, {
    currentImageReference: `ghcr.io/zugfolge/game-api@${CURRENT_IMAGE_DIGEST}`,
  });
  assert.equal(runWrapper(repositoryReference).status, 0);

  for (const currentImageReference of [
    "zugfolge-game-api",
    "zugfolge-game-api:latest",
    `SHA256:${"a".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `ghcr.io/Zugfolge/game-api@${CURRENT_IMAGE_DIGEST}`,
  ]) {
    const fixture = await wrapperFixture(t, { currentImageReference });
    const result = runWrapper(fixture);
    assert.equal(result.status, 65);
    assert.match(result.stderr, /ZUGFOLGE_GAME_API_IMAGE_REFERENCE/u);
  }

  const mismatchedLegacy = await wrapperFixture(t, {
    legacyImageReference: `registry.example/zugfolge/game-api@sha256:${"c".repeat(64)}`,
  });
  const mismatch = runWrapper(mismatchedLegacy);
  assert.equal(mismatch.status, 65);
  assert.match(mismatch.stderr, /bindet nicht exakt den attestierten/u);

  const sameImage = await wrapperFixture(t, {
    legacyImageDigest: CURRENT_IMAGE_DIGEST,
    legacyImageReference: CURRENT_IMAGE_DIGEST,
  });
  const same = runWrapper(sameImage);
  assert.equal(same.status, 65);
  assert.match(same.stderr, /muessen getrennte Digests besitzen/u);

  const mutableOdoo = await wrapperFixture(t, { currentOdooImageReference: "zugfolge-odoo:alpha" });
  const mutableOdooResult = runWrapper(mutableOdoo);
  assert.equal(mutableOdooResult.status, 65);
  assert.match(mutableOdooResult.stderr, /ZUGFOLGE_ODOO_IMAGE_REFERENCE/u);

  const mismatchedLegacyOdoo = await wrapperFixture(t, {
    legacyOdooImageReference: `registry.example/zugfolge/odoo@sha256:${"e".repeat(64)}`,
  });
  const odooMismatch = runWrapper(mismatchedLegacyOdoo);
  assert.equal(odooMismatch.status, 65);
  assert.match(odooMismatch.stderr, /PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE bindet nicht exakt/u);

  const sameOdooImage = await wrapperFixture(t, {
    legacyOdooImageDigest: CURRENT_ODOO_IMAGE_DIGEST,
    legacyOdooImageReference: CURRENT_ODOO_IMAGE_DIGEST,
  });
  const sameOdoo = runWrapper(sameOdooImage);
  assert.equal(sameOdoo.status, 65);
  assert.match(sameOdoo.stderr, /Odoo-Image.*getrennte Digests/u);
});

test("mutable image name is confined to the canonical build and never accepted by run or up", async (t) => {
  const fixture = await wrapperFixture(t, {
    currentImageReference: "sha256:replace-current-after-build",
    legacyImageDigest: "sha256:replace-attested-legacy-digest",
    legacyImageReference: "sha256:replace-attested-legacy-reference",
  });
  const build = runWrapper(fixture, ["-f", "compose.alpha.yml", "build"]);
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout, /^SHELL_CURRENT_IMAGE=zugfolge-game-api$/mu);
  assert.match(build.stdout, /^SHELL_CURRENT_ODOO_IMAGE=zugfolge-odoo:alpha$/mu);
  assert.equal(build.stdout.split("\n").filter((line) => line.startsWith("CALL=")).length, 1);

  const run = runWrapper(fixture, ["-f", "compose.alpha.yml", "run", "--rm", "game-api"]);
  assert.equal(run.status, 65);
  assert.match(run.stderr, /ZUGFOLGE_GAME_API_IMAGE_REFERENCE/u);
  const up = runWrapper(fixture, ["--quiesced-cutover", "-f", "compose.alpha.yml", "up", "--no-build", "--wait"]);
  assert.equal(up.status, 65);
  assert.match(up.stderr, /ZUGFOLGE_GAME_API_IMAGE_REFERENCE/u);
});

test("Schema 29 is cold-restored before fixed 30/31, legacy-write, Schema-31-cold and Schema-32/33 gates", async (t) => {
  const fixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  const schema31 = runWrapper(fixture, ["--prepare-v2-schema31", "-f", "compose.alpha.yml"]);
  assert.equal(schema31.status, 0, schema31.stderr);
  const schema31Calls = schema31.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.match(schema31Calls[0], /--profile operations --profile keycloak-schema-migration --profile production-recovery-preparation stop/u);
  assert.match(schema31Calls[1], /up --no-recreate --no-deps --no-build --wait[\s\S]*postgres odoo-postgres recovery-verify-postgres recovery-verify-odoo-postgres/u);
  assert.equal(schema31Calls.filter((call) => /run --rm --no-deps production-recovery-material/u.test(call)).length, 7);
  assert.match(schema31Calls[6], /run --rm --no-deps production-recovery-schema29-cold-qualify$/u);
  assert.match(schema31Calls[7], /run --rm --no-deps production-recovery-material -eu -c/u);
  assert.match(schema31Calls[8], /run --rm --no-deps production-recovery-material -eu -c/u);
  assert.match(schema31Calls[9], /run --rm --no-deps production-schema29-runtime-snapshot$/u);
  assert.match(schema31Calls[10], /run --rm --no-deps production-schema29-odoo-filestore-access node tools\/alpha-ops\/schema29-odoo-filestore-access\.mjs open$/u);
  assert.match(schema31Calls[11], /up --no-deps --no-build --force-recreate --wait --wait-timeout 600 schema29-keycloak-runtime schema29-game-runtime schema29-odoo-runtime$/u);
  assert.match(schema31Calls[12], /run --rm --no-deps legacy-game-schema29-write-probe$/u);
  assert.match(schema31Calls[13], /run --rm --no-deps legacy-odoo-schema29-write-probe$/u);
  assert.match(schema31Calls[14], /stop --timeout 60 schema29-odoo-runtime$/u);
  assert.match(schema31Calls[15], /schema29-odoo-filestore-access\.mjs seal$/u);
  assert.match(schema31Calls[16], /up --no-deps --no-build --no-recreate --wait --wait-timeout 600 schema29-odoo-runtime$/u);
  assert.match(schema31Calls[17], /run --rm --no-deps -e PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH production-schema29-runtime-qualify$/u);
  assert.match(schema31.stdout, /^SCHEMA29_ODOO_FILESTORE_HOST_PATH=\/.*\/production-recovery\/odoo-filestore\/zugfolge_odoo_recovery_v1_schema29_runtime_test$/mu);
  assert.match(schema31Calls[18], /stop --timeout 60 schema29-game-runtime schema29-keycloak-runtime schema29-odoo-runtime$/u);
  assert.match(schema31Calls[19], /rm --force schema29-game-runtime schema29-keycloak-runtime schema29-odoo-runtime$/u);
  assert.match(schema31Calls[20], /run --rm --no-deps game-schema31-migrate$/u);
  assert.match(schema31Calls[21], /run --rm --no-deps legacy-game-schema31-write-probe$/u);
  assert.match(schema31Calls[22], /run --rm --no-deps game-schema31-qualify$/u);
  assert.match(schema31Calls[23], /run --rm --no-deps production-recovery-material -eu -c/u);
  assert.equal(schema31Calls.some((call) => /\bdown\b/u.test(call)), false);

  const missingFilestoreFixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  await rm(join(missingFilestoreFixture.directory, "production-recovery", "odoo-filestore", "zugfolge_odoo_recovery_v1_schema29_runtime_test"), { recursive: true });
  const missingFilestore = runWrapper(missingFilestoreFixture, ["--prepare-v2-schema31", "-f", "compose.alpha.yml"]);
  assert.equal(missingFilestore.status, 65);
  assert.match(missingFilestore.stderr, /vorhandene symlinkfreie direkte Kind/u);
  assert.equal(missingFilestore.stdout.includes("schema29-odoo-filestore-access.mjs open"), false);

  const cold = runWrapper(fixture, ["--prepare-v2-cold", "-f", "compose.alpha.yml"]);
  assert.equal(cold.status, 0, cold.stderr);
  const coldCalls = cold.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.match(coldCalls[0], /--profile operations --profile keycloak-schema-migration --profile production-recovery-preparation stop/u);
  assert.match(coldCalls[1], /up --no-recreate --no-deps --no-build --wait[\s\S]*postgres odoo-postgres recovery-verify-postgres recovery-verify-odoo-postgres/u);
  assert.equal(coldCalls.filter((call) => /run --rm --no-deps production-recovery-material/u.test(call)).length, 4);
  assert.match(coldCalls.at(-1), /run --rm --no-deps production-recovery-cold-qualify$/u);
  assert.equal(coldCalls.some((call) => /\bdown\b/u.test(call)), false);

  const direct = runWrapper(fixture, ["-f", "compose.alpha.yml", "run", "--rm", "--no-deps", "game-migrate"]);
  assert.equal(direct.status, 64);
  assert.match(direct.stderr, /direkte Schema-Migration ist gesperrt/u);
  assert.doesNotMatch(direct.stdout, /^CALL=/mu);

  for (const service of ["odoo-upgrade", "keycloak-schema-migrate", "keycloak-schema-restore", "game-bootstrap"]) {
    const bypass = runWrapper(fixture, ["-f", "compose.alpha.yml", "run", "--rm", "--no-deps", service]);
    assert.equal(bypass.status, 64);
    assert.match(bypass.stderr, /Production-Recovery-Gate nicht mit --no-deps umgehen/u);
    assert.doesNotMatch(bypass.stdout, /^CALL=/mu);
  }

  const migration = runWrapper(fixture, ["--schema33-after-cold", "-f", "compose.alpha.yml"]);
  assert.equal(migration.status, 0, migration.stderr);
  const migrationCalls = migration.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.match(migrationCalls.at(-2), /run --rm --no-deps game-schema33-migrate$/u);
  assert.match(migrationCalls.at(-1), /run --rm --no-deps production-recovery-material -eu -c/u);
  assert.equal(migrationCalls.some((call) => /\bdown\b/u.test(call)), false);

  const keycloak = runWrapper(fixture, ["--keycloak-after-schema33", "-f", "compose.alpha.yml"]);
  assert.equal(keycloak.status, 0, keycloak.stderr);
  const keycloakCalls = keycloak.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.match(keycloakCalls[0], /--profile operations --profile keycloak-schema-migration --profile production-recovery-preparation stop/u);
  assert.match(keycloakCalls[1], /up --no-recreate --no-deps --no-build --wait[\s\S]*postgres odoo-postgres recovery-verify-postgres recovery-verify-odoo-postgres/u);
  assert.match(keycloakCalls[2], /run --rm --no-deps production-recovery-material -eu -c/u);
  assert.match(keycloakCalls[3], /--profile keycloak-schema-migration run --rm --no-deps keycloak-schema-backup$/u);
  assert.match(keycloakCalls[4], /--profile keycloak-schema-migration run --rm --no-deps keycloak-schema-restore$/u);
  for (const [index, action] of ["bind-backup", "plan-up", "up", "preflight-up"].entries()) {
    assert.match(
      keycloakCalls[index + 5],
      new RegExp(`--profile keycloak-schema-migration run --rm --no-deps -e KEYCLOAK_SCHEMA_WRITERS_QUIESCED=true keycloak-schema-migrate node tools/alpha-ops/keycloak-public-to-schema\\.mjs ${action}$`, "u"),
    );
  }
  assert.equal(keycloakCalls.some((call) => /\bdown\b/u.test(call)), false);

  const failedKeycloak = runWrapper(
    fixture,
    ["--keycloak-after-schema33", "-f", "compose.alpha.yml"],
    { FAKE_DOCKER_FAIL_MATCH: "keycloak-public-to-schema.mjs plan-up" },
  );
  assert.equal(failedKeycloak.status, 70);
  const failedKeycloakCalls = failedKeycloak.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(failedKeycloakCalls.some((call) => /keycloak-public-to-schema\.mjs up$/u.test(call)), false);
  assert.match(failedKeycloakCalls.at(-1), /--profile operations --profile keycloak-schema-migration --profile production-recovery-preparation stop/u);
  assert.match(failedKeycloak.stderr, /Anwendungswriter bleiben gestoppt/u);

  const recoveredKeycloak = runWrapper(
    fixture,
    ["--keycloak-after-schema33", "-f", "compose.alpha.yml"],
    { FAKE_DOCKER_FAIL_MATCH: "keycloak-public-to-schema.mjs up" },
  );
  assert.equal(recoveredKeycloak.status, 0, recoveredKeycloak.stderr);
  const recoveredKeycloakCalls = recoveredKeycloak.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.match(recoveredKeycloakCalls.at(-2), /keycloak-public-to-schema\.mjs recover$/u);
  assert.match(recoveredKeycloakCalls.at(-1), /keycloak-public-to-schema\.mjs preflight-up$/u);

  const explicitRecovery = runWrapper(fixture, ["--keycloak-recover-after-schema33", "-f", "compose.alpha.yml"]);
  assert.equal(explicitRecovery.status, 0, explicitRecovery.stderr);
  const explicitRecoveryCalls = explicitRecovery.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(explicitRecoveryCalls.length, 5);
  assert.match(explicitRecoveryCalls[2], /run --rm --no-deps production-recovery-material -eu -c/u);
  assert.match(explicitRecoveryCalls[3], /keycloak-public-to-schema\.mjs recover$/u);
  assert.match(explicitRecoveryCalls[4], /keycloak-public-to-schema\.mjs preflight-up$/u);

  const hot = runWrapper(fixture, ["--prepare-v2-hot", "-f", "compose.alpha.yml"]);
  assert.equal(hot.status, 0, hot.stderr);
  const hotCalls = hot.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(hotCalls.filter((call) => /run --rm --no-deps production-recovery-material/u.test(call)).length, 6);
  assert.match(hotCalls[2], /run --rm --no-deps production-recovery-material -eu -c/u);
  assert.match(hotCalls[3], /keycloak-public-to-schema\.mjs preflight-up$/u);
  assert.match(hotCalls.at(-2), /production-recovery-proof node tools\/alpha-ops\/create-database-backup-restore-evidence\.mjs$/u);
  assert.match(hotCalls.at(-1), /production-recovery-proof node tools\/alpha-ops\/create-database-rollback-proof\.mjs$/u);
  assert.equal(hotCalls.some((call) => /\bdown\b/u.test(call)), false);

  const missingKeycloak = runWrapper(
    fixture,
    ["--prepare-v2-hot", "-f", "compose.alpha.yml"],
    { FAKE_DOCKER_FAIL_MATCH: "keycloak-public-to-schema.mjs preflight-up" },
  );
  assert.equal(missingKeycloak.status, 70);
  const missingKeycloakCalls = missingKeycloak.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(missingKeycloakCalls.some((call) => /backup-game\.sh|backup-odoo\.sh/u.test(call)), false);
  assert.match(missingKeycloakCalls.at(-1), /--profile operations --profile keycloak-schema-migration --profile production-recovery-preparation stop/u);
  assert.match(missingKeycloak.stderr, /Anwendungswriter bleiben gestoppt/u);

  const failedHot = runWrapper(
    fixture,
    ["--prepare-v2-hot", "-f", "compose.alpha.yml"],
    { FAKE_DOCKER_FAIL_MATCH: "production-recovery-proof node tools/alpha-ops/create-database-backup-restore-evidence.mjs" },
  );
  assert.equal(failedHot.status, 70);
  const failedHotCalls = failedHot.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.match(failedHotCalls.at(-1), /--profile operations --profile keycloak-schema-migration --profile production-recovery-preparation stop/u);
  assert.match(failedHot.stderr, /Anwendungswriter bleiben gestoppt/u);

  const wrongSource = await wrapperFixture(t);
  const wrongSourceResult = runWrapper(wrongSource, ["--prepare-v2-cold", "-f", "compose.alpha.yml"]);
  assert.equal(wrongSourceResult.status, 65);
  assert.match(wrongSourceResult.stderr, /exakt gebundenen Vorgaengerrelease/u);
  assert.doesNotMatch(wrongSourceResult.stdout, /^CALL=/mu);

  const missingSchema31 = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  await rm(join(missingSchema31.directory, "production-recovery", "evidence", "rollback-2026.2-001.schema31-prepared.json"));
  const missingSchema31Result = runWrapper(missingSchema31, ["--prepare-v2-cold", "-f", "compose.alpha.yml"]);
  assert.equal(missingSchema31Result.status, 65);
  assert.match(missingSchema31Result.stderr, /verlangt zuerst.*Schema-31-Vorbereitungsbeleg/u);
  assert.equal(missingSchema31Result.stdout.includes("backup-game.sh"), false);

  const missingKeycloakBackupRoot = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  await rm(join(missingKeycloakBackupRoot.directory, "keycloak-schema", "backup"), { recursive: true });
  const missingKeycloakBackupRootResult = runWrapper(missingKeycloakBackupRoot, ["--keycloak-after-schema33", "-f", "compose.alpha.yml"]);
  assert.equal(missingKeycloakBackupRootResult.status, 65);
  assert.match(missingKeycloakBackupRootResult.stderr, /KEYCLOAK_SCHEMA_BACKUP_HOST_DIR fehlt oder ist ein Symlink/u);
  assert.doesNotMatch(missingKeycloakBackupRootResult.stdout, /^CALL=/mu);

  const liveRestoreCollision = await wrapperFixture(t, {
    releaseId: "infra-deutschland-2026.1",
    postgresDatabase: "zugfolge_restore_keycloak_schema",
  });
  const liveRestoreCollisionResult = runWrapper(liveRestoreCollision, ["--keycloak-after-schema33", "-f", "compose.alpha.yml"]);
  assert.equal(liveRestoreCollisionResult.status, 65);
  assert.match(liveRestoreCollisionResult.stderr, /eigenes isoliertes Keycloak-Restore-Ziel/u);
  assert.doesNotMatch(liveRestoreCollisionResult.stdout, /^CALL=/mu);

  const splitReceipt = await wrapperFixture(t, {
    releaseId: "infra-deutschland-2026.1",
    environmentLines: ["KEYCLOAK_SCHEMA_RECEIPT_OUTPUT_CONTAINER_PATH=/keycloak-schema/other.json"],
  });
  const splitReceiptResult = runWrapper(splitReceipt, ["--keycloak-after-schema33", "-f", "compose.alpha.yml"]);
  assert.equal(splitReceiptResult.status, 65);
  assert.match(splitReceiptResult.stderr, /Receipt-Eingang und -Ausgabe genau einmal/u);
  assert.doesNotMatch(splitReceiptResult.stdout, /^CALL=/mu);
});

test("Schema-29 Odoo probe failure stops writers and emergency-reseals an opened runtime filestore", async (t) => {
  const fixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  const result = runWrapper(fixture, ["--prepare-v2-schema31", "-f", "compose.alpha.yml"], {
    FAKE_CREATE_SCHEMA29_FILESTORE_OPEN: "1",
    FAKE_DOCKER_FAIL_SUFFIX: "run --rm --no-deps legacy-odoo-schema29-write-probe",
  });
  assert.equal(result.status, 70);
  const calls = result.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.ok(calls.some((call) => /schema29-odoo-filestore-access\.mjs open$/u.test(call)));
  assert.ok(calls.some((call) => /legacy-odoo-schema29-write-probe$/u.test(call)));
  assert.equal(await readFile(join(fixture.directory, "production-recovery", "evidence", "rollback-2026.2-001.schema29-odoo-filestore-open.json"), "utf8"), "{}\n");
  assert.ok(calls.some((call) => /schema29-odoo-filestore-access\.mjs emergency-reseal$/u.test(call)), calls.join("\n"));
  assert.equal(calls.some((call) => /production-schema29-runtime-qualify$/u.test(call)), false);
  assert.match(result.stderr, /Anwendungswriter bleiben gestoppt/u);
});

test("special wrapper modes remove private compose snapshots on success and failure", async (t) => {
  const fixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  const temporaryRoot = join(fixture.directory, "wrapper-tmp");
  await mkdir(temporaryRoot);
  const environment = { TMPDIR: bashDirectoryPath(temporaryRoot) };

  const success = runWrapper(fixture, ["--prepare-v2-schema31", "-f", "compose.alpha.yml"], environment);
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(await readdir(temporaryRoot), []);

  const failed = runWrapper(fixture, ["--prepare-v2-schema31", "-f", "compose.alpha.yml"], {
    ...environment,
    FAKE_DOCKER_FAIL_MATCH: "game-schema31-migrate",
  });
  assert.equal(failed.status, 70);
  assert.match(failed.stderr, /Anwendungswriter bleiben gestoppt/u);
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test("active cutover preserves database identities and releases both V2 sources only after signed recovery preflight", async (t) => {
  const fixture = await wrapperFixture(t);
  const unsafe = runWrapper(fixture, ["-f", "compose.alpha.yml", "up", "--no-build", "--wait"]);
  assert.equal(unsafe.status, 64);
  assert.match(unsafe.stderr, /--quiesced-cutover/u);
  const disguisedUnsafe = runWrapper(fixture, ["-f", "compose.alpha.yml", "up", "game-api", "down"]);
  assert.equal(disguisedUnsafe.status, 64);
  assert.match(disguisedUnsafe.stderr, /--quiesced-cutover/u);

  const cutover = runWrapper(fixture, ["--quiesced-cutover", "-f", "compose.alpha.yml", "up", "--no-build", "--wait", "--wait-timeout", "600"]);
  assert.equal(cutover.status, 0, cutover.stderr);
  const calls = cutover.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(calls.length, 7);
  assert.match(calls[0], /stop --timeout 60/u);
  assert.doesNotMatch(calls[0], /(?:^| )postgres(?: |$)|(?:^| )odoo-postgres(?: |$)/u);
  assert.match(calls[1], /up --no-recreate --no-deps --no-build --wait --wait-timeout 600 postgres odoo-postgres$/u);
  assert.match(calls[2], /activate-production-recovery\.mjs prepared$/u);
  assert.match(calls[3], /switch-production-recovery-source\.mjs release$/u);
  assert.match(calls[4], /rm --force/u);
  assert.doesNotMatch(calls[4], /(?:^| )postgres(?: |$)|(?:^| )odoo-postgres(?: |$)/u);
  assert.match(calls[5], /up --no-recreate --no-build --wait --wait-timeout 600$/u);
  assert.match(calls[6], /exec -T game-api node tools\/alpha-ops\/wait-game-readiness\.mjs http:\/\/127\.0\.0\.1:3000 7200000$/u);
  assert.ok(calls.every((call) => !/(?:^| )down(?: |$)/u.test(call)), "der Cutover darf die gebundenen Datenbankcontainer nie per down entfernen");
  assert.match(cutover.stdout, /^RECOVERY_ACTION_RECEIPT=\/production-recovery\/rollback-2026\.2-001\.prepared\.json$/mu);
  assert.match(cutover.stdout, /^SOURCE_ACTION_RECEIPT=\/production-recovery\/rollback-2026\.2-001\.source-release\.json$/mu);
  assert.match(cutover.stdout, /^SOURCE_INTENT=\/production-recovery\/rollback-2026\.2-001\.source-release\.intent\.json$/mu);

  for (const extra of [
    ["--no-deps", "postgres", "game-api"],
    ["--profile", "unsafe"],
    ["--scale", "game-api=0"],
  ]) {
    const bypass = runWrapper(fixture, ["--quiesced-cutover", "-f", "compose.alpha.yml", "up", "--no-build", "--wait", ...extra]);
    assert.equal(bypass.status, 64);
    assert.match(bypass.stderr, /kanonischen Gesamtstack-Start/u);
  }
});

test("a failed V2 start stops every writer and reseals both live sources", async (t) => {
  const fixture = await wrapperFixture(t);
  const failed = runWrapper(
    fixture,
    ["--quiesced-cutover", "-f", "compose.alpha.yml", "up", "--no-build", "--wait", "--wait-timeout", "600"],
    { FAKE_DOCKER_FAIL_MATCH: "up --no-recreate --no-build --wait" },
  );
  assert.notEqual(failed.status, 0);
  const calls = failed.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  const releaseIndex = calls.findIndex((call) => /switch-production-recovery-source\.mjs release$/u.test(call));
  const failedUpIndex = calls.findIndex((call) => /up --no-recreate --no-build --wait --wait-timeout 600$/u.test(call));
  assert.ok(releaseIndex >= 0 && failedUpIndex > releaseIndex);
  assert.ok(calls.slice(failedUpIndex + 1).some((call) => /stop --timeout 60/u.test(call)));
  assert.ok(calls.slice(failedUpIndex + 1).some((call) => /up --no-recreate --no-deps --no-build[\s\S]*postgres odoo-postgres$/u.test(call)));
  assert.ok(calls.slice(failedUpIndex + 1).some((call) => /switch-production-recovery-source\.mjs reseal$/u.test(call)));
  assert.ok(calls.every((call) => !/(?:^| )down(?: |$)/u.test(call)));
  assert.match(failed.stdout, /^SOURCE_ACTION_RECEIPT=\/production-recovery\/rollback-2026\.2-001\.source-reseal\.json$/mu);

  const stalledFixture = await wrapperFixture(t);
  const stalled = runWrapper(
    stalledFixture,
    ["--quiesced-cutover", "-f", "compose.alpha.yml", "up", "--no-build", "--wait", "--wait-timeout", "600"],
    { FAKE_DOCKER_FAIL_MATCH: "wait-game-readiness.mjs" },
  );
  assert.notEqual(stalled.status, 0);
  const stalledCalls = stalled.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  const readinessIndex = stalledCalls.findIndex((call) => /wait-game-readiness\.mjs/u.test(call));
  assert.ok(readinessIndex >= 0);
  assert.ok(stalledCalls.slice(readinessIndex + 1).some((call) => /stop --timeout 60/u.test(call)));
  assert.ok(stalledCalls.slice(readinessIndex + 1).some((call) => /switch-production-recovery-source\.mjs reseal$/u.test(call)));

  const rejectedCandidate = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.3" });
  const rejectedResult = runWrapper(rejectedCandidate, ["--quiesced-cutover", "-f", "compose.alpha.yml", "up", "--no-build", "--wait"]);
  assert.equal(rejectedResult.status, 65);
  assert.match(rejectedResult.stderr, /exakt gebundenen Kandidatenrelease/u);
  assert.doesNotMatch(rejectedResult.stdout, /^CALL=/mu);
});

test("quiesced cutover uses one validated private env snapshot across stop, recovery gates, and up", async (t) => {
  const fixture = await wrapperFixture(t);
  const cutover = runWrapper(
    fixture,
    ["--quiesced-cutover", "-f", "compose.alpha.yml", "up", "--no-build", "--wait", "--wait-timeout", "600"],
    {
      FAKE_POINTER_TO_REPLACE: "./maps/active/map-release.env",
      FAKE_REPLACEMENT_RELEASE_ID: "infra-deutschland-2099.9",
      FAKE_POINTER_REPLACE_ACTION: "stop",
    },
  );
  assert.equal(cutover.status, 0, cutover.stderr);
  const snapshots = cutover.stdout
    .split("\n")
    .filter((line) => line.startsWith("SNAPSHOT_MAP_RELEASE_ID=") && !line.endsWith("="));
  assert.equal(snapshots.length, 7);
  assert.ok(snapshots.every((line) => line === "SNAPSHOT_MAP_RELEASE_ID=infra-deutschland-2026.2"));
  assert.doesNotMatch(cutover.stdout, /SNAPSHOT_MAP_RELEASE_ID=infra-deutschland-2099\.9/u);
  assert.match(
    await readFile(join(fixture.directory, "maps", "active", "map-release.env"), "utf8"),
    /MAP_RELEASE_ID=infra-deutschland-2099\.9/u,
  );
});

test("host wrapper rejects a second map source, malformed pointer, and caller env-file overrides", async (t) => {
  const duplicateSource = await wrapperFixture(t, { environmentLines: ["MAP_RELEASE_ID=infra-deutschland-2026.2"] });
  const duplicateResult = runWrapper(duplicateSource);
  assert.equal(duplicateResult.status, 65);
  assert.match(duplicateResult.stderr, /nur aus Pointer und explizitem Wrappermodus/);

  const foreignPointer = await wrapperFixture(t, { pointerLines: ["FOREIGN=value"] });
  const foreignResult = runWrapper(foreignPointer);
  assert.equal(foreignResult.status, 65);
  assert.match(foreignResult.stderr, /fremden Schluessel/);

  const override = await wrapperFixture(t);
  const overrideResult = runWrapper(override, ["-f", "compose.alpha.yml", "--env-file", "forged.env", "config"]);
  assert.equal(overrideResult.status, 64);
  assert.match(overrideResult.stderr, /nicht erlaubt/);
  const projectOverride = runWrapper(override, ["-p", "shadow-stack", "-f", "compose.alpha.yml", "config"]);
  assert.equal(projectOverride.status, 64);
  assert.match(projectOverride.stderr, /fest auf zugfolge gebunden/);
  const composeOverride = runWrapper(override, ["-f", "foreign.yml", "config"]);
  assert.equal(composeOverride.status, 64);
  assert.match(composeOverride.stderr, /nur die Repo-Vorlage compose\.alpha\.yml/);
  const argumentOverride = runWrapper(override, ["-f", "compose.alpha.yml", "run", "-e", "MAP_RELEASE_ID=forged", "game-api"]);
  assert.equal(argumentOverride.status, 64);
  assert.match(argumentOverride.stderr, /duerfen nicht als Compose-Argument ueberschrieben werden/);
  const imageArgumentOverride = runWrapper(override, ["-f", "compose.alpha.yml", "run", "-e", "ZUGFOLGE_GAME_API_IMAGE_REFERENCE=zugfolge-game-api:latest", "game-api"]);
  assert.equal(imageArgumentOverride.status, 64);
  assert.match(imageArgumentOverride.stderr, /duerfen nicht als Compose-Argument ueberschrieben werden/);
  const envMode = await wrapperFixture(t, { environmentLines: ["MAP_RELEASE_START_PREFLIGHT_MODE=pre-activation"] });
  const envModeResult = runWrapper(envMode);
  assert.equal(envModeResult.status, 65);
  assert.match(envModeResult.stderr, /explizitem Wrappermodus/);

  const unterminated = await wrapperFixture(t);
  const unterminatedPath = join(unterminated.directory, "maps", "active", "map-release.env");
  const unterminatedBytes = await readFile(unterminatedPath);
  await writeFile(unterminatedPath, unterminatedBytes.subarray(0, -1));
  const unterminatedResult = runWrapper(unterminated);
  assert.equal(unterminatedResult.status, 65);
  assert.match(unterminatedResult.stderr, /mit genau einer LF-Zeile enden/);
});

test("fixed stop reaches only the canonical zugfolge project without a usable map pointer", async (t) => {
  const fixture = await wrapperFixture(t);
  await rm(join(fixture.directory, "maps", "active", "map-release.env"));

  const stopped = runWrapper(fixture, ["--fixed-stop", "-f", "compose.alpha.yml", "down"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const stopCalls = stopped.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(stopCalls.length, 2);
  assert.match(stopCalls[0], /--project-name zugfolge[\s\S]* stop --timeout 60 /u);
  assertRuntimeOnlyRemoval(stopCalls[1]);
  assert.match(stopped.stdout, /^SHELL_MAP_RELEASE_ID=infra-stop-placeholder-2000\.1$/mu);

  await writeFile(join(fixture.directory, "maps", "active", "map-release.env"), "BROKEN POINTER\n", "utf8");
  const corruptPointerStop = runWrapper(fixture, ["--fixed-stop", "-f", "compose.alpha.yml", "down"]);
  assert.equal(corruptPointerStop.status, 0, corruptPointerStop.stderr);
  assert.match(corruptPointerStop.stdout, /ARG=zugfolge/u);

  const unsafeAction = runWrapper(fixture, ["--fixed-stop", "-f", "compose.alpha.yml", "up"]);
  assert.equal(unsafeAction.status, 64);
  assert.match(unsafeAction.stderr, /ausschliesslich .* down/);
});

test("normaler Unit-Stop erhaelt DB-Container-IDs durch Rollback-Continuation und Rueckkehr zu V2", async (t) => {
  const fixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.2" });
  const dbIdState = join(fixture.directory, "db-container-ids.state");
  const dbIdEnvironment = {
    FAKE_DB_CONTAINER_ID_STATE_PATH: bashDirectoryPath(dbIdState),
    FAKE_EXPECTED_DB_CONTAINER_IDS: "db-container-ids-v1",
  };
  await writeFile(dbIdState, "db-container-ids-v1\n", "utf8");

  const normalStop = runWrapper(fixture, ["--fixed-stop", "-f", "compose.alpha.yml", "down"], dbIdEnvironment);
  assert.equal(normalStop.status, 0, normalStop.stderr);
  assert.equal(await readFile(dbIdState, "utf8"), "db-container-ids-v1\n");
  const normalStopCalls = normalStop.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(normalStopCalls.every((call) => !/(?:^| )down(?: |$)/u.test(call)), true);
  assertRuntimeOnlyRemoval(normalStopCalls.at(-1));

  await writeFile(join(fixture.directory, "maps", "active", "map-release.env"), [
    "MAP_RELEASE_ID=infra-deutschland-2026.1",
    "MAP_RELEASE_HOST_DIR=releases/infra-deutschland-2026.1",
    "MAP_BASEMAP_STYLE_URL=/artifacts/maps/infra-deutschland-2026.1/style.json",
    "MAP_GERMANY_PMTILES_URL=/artifacts/maps/infra-deutschland-2026.1/infra-deutschland-2026.1.pmtiles",
    "",
  ].join("\n"));
  const firstRollback = runWrapper(fixture, ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "600"], dbIdEnvironment);
  assert.equal(firstRollback.status, 0, firstRollback.stderr);
  assert.match(firstRollback.stdout, /activate-production-recovery\.mjs activate/u);
  assert.equal(await readFile(dbIdState, "utf8"), "db-container-ids-v1\n");

  await writeFile(join(fixture.directory, "production-recovery", "evidence", "rollback-2026.2-001.activate.json"), "{}\n");
  const rollbackStop = runWrapper(fixture, ["--attested-rollback-stop", "-f", "compose.alpha.yml", "down"], dbIdEnvironment);
  assert.equal(rollbackStop.status, 0, rollbackStop.stderr);
  const rollbackStopCalls = rollbackStop.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assertRuntimeOnlyRemoval(rollbackStopCalls.at(-1));
  assert.equal(await readFile(dbIdState, "utf8"), "db-container-ids-v1\n");

  const restartedRollback = runWrapper(fixture, ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "600"], dbIdEnvironment);
  assert.equal(restartedRollback.status, 0, restartedRollback.stderr);
  assert.match(restartedRollback.stdout, /continue-production-recovery\.mjs/u);
  assert.equal(await readFile(dbIdState, "utf8"), "db-container-ids-v1\n");

  const restartedRollbackStop = runWrapper(fixture, ["--attested-rollback-stop", "-f", "compose.alpha.yml", "down"], dbIdEnvironment);
  assert.equal(restartedRollbackStop.status, 0, restartedRollbackStop.stderr);
  const restartedStopCalls = restartedRollbackStop.stdout.split("\n").filter((line) => line.startsWith("CALL=")).map((line) => line.slice(5));
  assert.equal(restartedStopCalls.every((call) => !/(?:^| )down(?: |$)/u.test(call)), true);
  assertRuntimeOnlyRemoval(restartedStopCalls.at(-1));
  assert.equal(await readFile(dbIdState, "utf8"), "db-container-ids-v1\n");

  await writeFile(join(fixture.directory, "maps", "active", "map-release.env"), [
    "MAP_RELEASE_ID=infra-deutschland-2026.2",
    "MAP_RELEASE_HOST_DIR=releases/infra-deutschland-2026.2",
    "MAP_BASEMAP_STYLE_URL=/artifacts/maps/infra-deutschland-2026.2/style.json",
    "MAP_GERMANY_PMTILES_URL=/artifacts/maps/infra-deutschland-2026.2/infra-deutschland-2026.2.pmtiles",
    "",
  ].join("\n"));
  const returnedToV2 = runWrapper(fixture, ["--quiesced-cutover", "-f", "compose.alpha.yml", "up", "--no-build", "--wait", "--wait-timeout", "600"], dbIdEnvironment);
  assert.equal(returnedToV2.status, 0, returnedToV2.stderr);
  assert.match(returnedToV2.stdout, /switch-production-recovery-source\.mjs release/u);
  assert.equal(await readFile(dbIdState, "utf8"), "db-container-ids-v1\n");
});

test("installed compose.yml must remain byte-identical to the repository template", async (t) => {
  const fixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  const template = join(fixture.directory, "compose.alpha.yml");
  const installed = join(fixture.directory, "compose.yml");
  const rollbackTemplate = join(fixture.directory, "compose.alpha.rollback.yml");
  const installedRollback = join(fixture.directory, "compose.rollback.yml");
  await cp(template, installed);
  await cp(rollbackTemplate, installedRollback);

  const accepted = runWrapper(fixture, ["-f", "compose.yml", "config"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  const acceptedRollback = runWrapper(fixture, ["--attested-rollback", "-f", "compose.yml", "up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "600"]);
  assert.equal(acceptedRollback.status, 0, acceptedRollback.stderr);
  await writeFile(installedRollback, "services: {}\n", "utf8");
  const rollbackDrift = runWrapper(fixture, ["--attested-rollback", "-f", "compose.yml", "up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "600"]);
  assert.equal(rollbackDrift.status, 65);
  assert.match(rollbackDrift.stderr, /compose\.rollback\.yml stimmt nicht bytegleich/u);
  assert.doesNotMatch(rollbackDrift.stdout, /^CALL=/mu);
  await writeFile(installed, "name: shadow-stack\nservices: {}\n", "utf8");
  const drift = runWrapper(fixture, ["-f", "compose.yml", "config"]);
  assert.equal(drift.status, 65);
  assert.match(drift.stderr, /nicht bytegleich mit der Repo-Vorlage/);
});

test("Compose restarts Game API and Livemap only through the explicit per-process map gate", async () => {
  const [compose, rollbackCompose, environment, phase1, build, phase3, service, rollbackService, wrapper, installation] = await Promise.all([
    read("compose.alpha.yml"),
    read("compose.alpha.rollback.yml"),
    read(".env.example"),
    read("tools/alpha-ops/phase1-smoke.sh"),
    read("tools/alpha-ops/build-alpha-images.sh"),
    read("tools/alpha-ops/phase3-acceptance.sh"),
    read("ops/alpha/zugfolge-alpha.service"),
    read("ops/alpha/zugfolge-alpha-rollback.service"),
    read("tools/alpha-ops/compose-with-map-release-env.sh"),
    read("ALPHA-INSTALL.md"),
  ]);
  assert.match(compose, /^name: zugfolge$/mu);
  const odooUpgrade = compose.slice(compose.indexOf("  odoo-upgrade:"), compose.indexOf("  keycloak:"));
  const odoo = compose.slice(compose.indexOf("  odoo:"), compose.indexOf("  alpha-ops:"));
  assert.match(odooUpgrade, /image: "\$\{ZUGFOLGE_ODOO_IMAGE_REFERENCE:\?[^}]+\}"/u);
  assert.match(odoo, /image: "\$\{ZUGFOLGE_ODOO_IMAGE_REFERENCE:\?[^}]+\}"/u);
  const currentImageBindings = compose.match(/image: "\$\{ZUGFOLGE_GAME_API_IMAGE_REFERENCE:\?[^}]+\}"/gu) ?? [];
  assert.equal(currentImageBindings.length, 23);
  assert.equal((compose.match(/image: "\$\{ZUGFOLGE_ODOO_IMAGE_REFERENCE:\?[^}]+\}"/gu) ?? []).length, 2);
  assert.equal((compose.match(/pull_policy: never/gu) ?? []).length, 30);
  assert.doesNotMatch(compose, /^\s+image: zugfolge-game-api(?::[^\s]+)?\s*$/mu);
  assert.equal((rollbackCompose.match(/image: "\$\{MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE:\?[^}]+\}"/gu) ?? []).length, 5);
  assert.equal((rollbackCompose.match(/image: "\$\{PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE:\?[^}]+\}"/gu) ?? []).length, 1);
  assert.match(rollbackCompose, /keycloak:[\s\S]*KC_DB_SCHEMA: keycloak/u);
  assert.doesNotMatch(rollbackCompose, /keycloak:[\s\S]*KC_DB_SCHEMA: public/u);
  const rollbackOdoo = rollbackCompose.slice(rollbackCompose.indexOf("  odoo:"));
  assert.match(rollbackOdoo, /\$\{PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT:\?[^}]+\}\/\$\{PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE:\?[^}]+\}:\/var\/lib\/odoo\/filestore\/\$\{PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE:\?[^}]+\}:rw/u);
  assert.doesNotMatch(rollbackOdoo, /\$\{PRODUCTION_RECOVERY_ODOO_FILESTORE_HOST_ROOT:\?[^}]+\}:\/var\/lib\/odoo\/filestore:rw/u);
  assert.equal((rollbackOdoo.match(/\/var\/lib\/odoo\/filestore/gu) ?? []).length, 1);
  assert.match(rollbackCompose, /game-api:[\s\S]*command: \[node, apps\/game-api\/dist\/server\.js\]/u);
  assert.match(rollbackCompose, /livemap:[\s\S]*command: \[node, tools\/alpha-ops\/static-server\.mjs/u);
  assert.doesNotMatch(rollbackCompose, /(?:map-release-preflight|world-deployment-cutover-preflight|game-migrate|game-bootstrap|keycloak-schema-(?:preflight|postflight)|keycloak-reconcile):/u);
  const gameApi = compose.slice(compose.indexOf("  game-api:"), compose.indexOf("  game-web:"));
  const livemap = compose.slice(compose.indexOf("  livemap:"), compose.indexOf("  operations-center:"));
  for (const serviceSource of [gameApi, livemap]) {
    assert.match(serviceSource, /command: \[node, tools\/alpha-ops\/start-after-map-release-preflight\.mjs, node,/u);
    assert.match(serviceSource, /MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID:/u);
    assert.match(serviceSource, /MAP_RELEASE_START_PREFLIGHT_MODE:/u);
    assert.match(serviceSource, /MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH: "\$\{MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH:\?[^}]+\}"/u);
    assert.match(serviceSource, /MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT: "\$\{MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT:\?[^}]+\}"/u);
    assert.match(serviceSource, /MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST: "\$\{MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST:\?[^}]+\}"/u);
    assert.match(serviceSource, /MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH: "\$\{MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH:\?[^}]+\}"/u);
    assert.match(serviceSource, /\.\/var\/alpha-evidence:\/evidence:ro/u);
    assert.match(serviceSource, /:\/map-deployment:ro/u);
    assert.match(serviceSource, /:\/map-preflight:ro/u);
    assert.match(serviceSource, /:\/map-restore:ro/u);
  }
  assert.doesNotMatch(environment, /^MAP_RELEASE_ID=/mu);
  assert.doesNotMatch(environment, /^MAP_RELEASE_HOST_DIR=/mu);
  assert.doesNotMatch(environment, /^MAP_BASEMAP_STYLE_URL=/mu);
  assert.doesNotMatch(environment, /^MAP_GERMANY_PMTILES_URL=/mu);
  assert.match(environment, /^MAP_RELEASE_DEPLOYMENT_HOST_ROOT=\.\/var\/maps$/mu);
  assert.match(environment, /^MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH=\/map-preflight\/database-rollback-proof\.json$/mu);
  assert.match(environment, /^MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT=replace-with-attested-rollback-source-commit$/mu);
  assert.match(environment, /^ZUGFOLGE_GAME_API_IMAGE_REFERENCE=sha256:replace-with-current-game-api-image-id$/mu);
  assert.match(environment, /^ZUGFOLGE_ODOO_IMAGE_REFERENCE=sha256:replace-with-current-odoo-image-id$/mu);
  assert.match(environment, /^MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST=sha256:replace-with-attested-rollback-image-digest$/mu);
  assert.match(environment, /^MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE=sha256:replace-with-attested-rollback-image-id$/mu);
  assert.match(environment, /^MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH=\/evidence\/alpha-world-deployment\.json$/mu);
  for (const script of [phase1, build, phase3]) assert.match(script, /compose-with-map-release-env\.sh/u);
  assert.doesNotMatch([phase1, build, phase3].join("\n"), /docker compose/u);
  assert.equal((phase3.match(/wait_game_ready/g) ?? []).length, 3);
  assert.doesNotMatch(phase3, /wait_http "\$GAME_API_URL\/health\/ready"/u);
  assert.match(service, /ExecStart=.*compose-with-map-release-env\.sh/u);
  assert.match(service, /ExecStart=.*--quiesced-cutover[\s\S]*up --no-build --wait/u);
  assert.match(service, /TimeoutStartSec=7500/u);
  assert.match(service, /ExecStop=.*compose-with-map-release-env\.sh --fixed-stop -f \/opt\/zugfolge\/compose\.yml down/u);
  assert.doesNotMatch(service, /ExecStart=.*docker compose/u);
  assert.match(service, /Conflicts=zugfolge-alpha-rollback\.service/u);
  assert.match(rollbackService, /Conflicts=zugfolge-alpha\.service/u);
  assert.match(rollbackService, /ExecStart=.*compose-with-map-release-env\.sh --attested-rollback[\s\S]*up --no-build --force-recreate/u);
  assert.doesNotMatch(rollbackService, /^ExecStop=/mu);
  assert.match(rollbackService, /ExecStopPost=.*compose-with-map-release-env\.sh --attested-rollback-stop -f \/opt\/zugfolge\/compose\.yml down/u);
  const rollbackTimeoutSeconds = Number(rollbackService.match(/^TimeoutStartSec=(\d+)$/mu)?.[1]);
  const legacyReadyWaitMilliseconds = Number(
    environment.match(/^ZUGFOLGE_LEGACY_GAME_READY_MAX_WAIT_MS=(\d+)$/mu)?.[1]
      ?? wrapper.match(/ZUGFOLGE_LEGACY_GAME_READY_MAX_WAIT_MS:-([0-9]+)/u)?.[1]
      ?? "0",
  );
  const rollbackComposeWaitSeconds = Number(rollbackService.match(/--wait-timeout (\d+)/u)?.[1]);
  const legacyStartStageCount = (wrapper.match(/^[ \t]+start_legacy_stage[ \t]+/gmu) ?? []).length;
  const recoveryAndCleanupReserveSeconds = rollbackComposeWaitSeconds;
  const minimumRollbackTimeoutSeconds = Math.ceil(legacyReadyWaitMilliseconds / 1_000)
    + ((legacyStartStageCount + 1) * rollbackComposeWaitSeconds)
    + recoveryAndCleanupReserveSeconds;
  assert.ok(
    rollbackTimeoutSeconds >= minimumRollbackTimeoutSeconds,
    `Rollback-Unit muss Legacy-Readiness (${legacyReadyWaitMilliseconds} ms), DB-/Legacy-Compose-Waits und Recovery-Reserve abdecken; ${rollbackTimeoutSeconds}s < ${minimumRollbackTimeoutSeconds}s.`,
  );
  const oneShot = compose.slice(compose.indexOf("  map-release-preflight:"), compose.indexOf("  game-migrate:"));
  assert.match(oneShot, /map-release-deployment-preflight\.mjs, "\$\{MAP_RELEASE_START_PREFLIGHT_MODE:\?[^}]+\}"/u);
  assert.doesNotMatch(installation, /^docker compose .*\b(?:up|run|restart|down)\b/mu);
  assert.match(installation, /docker compose --env-file \/opt\/zugfolge\/\.env[\s\\]+\s+--env-file \/opt\/zugfolge\/maps\/active\/map-release\.env/u);
  assert.match(installation, /--quiesced-cutover\s+-f \/opt\/zugfolge\/compose\.yml up --no-build --wait/u);
});
