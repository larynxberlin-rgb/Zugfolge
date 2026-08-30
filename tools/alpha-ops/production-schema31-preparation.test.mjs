import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareGameSchema31,
  qualifyGameSchema31,
  validatePreSchema33MarkersAbsent,
} from "./production-schema31-preparation.mjs";

const root = new URL("../../", import.meta.url);

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

async function expectedLedger(count) {
  const journal = JSON.parse(await readFile(new URL("packages/db/drizzle/meta/_journal.json", root), "utf8"));
  return Promise.all(journal.entries.slice(0, count).map(async (entry, index) => ({
    id: String(index + 1),
    hash: createHash("sha256").update(await readFile(new URL(`packages/db/drizzle/${entry.tag}.sql`, root), "utf8")).digest("hex"),
    createdAt: String(entry.when),
  })));
}

function snapshot({ backend, endpoint, identity, ledger, stateSha256, identityRowHash = "0".repeat(64) }) {
  return {
    backendSha256: backend,
    endpointSha256: endpoint,
    stateSha256,
    state: {
      columnsSha256: "1".repeat(64),
      constraintsSha256: "2".repeat(64),
      databaseIdentity: identity,
      indexesSha256: "3".repeat(64),
      migrationLedger: ledger,
      sequences: [],
      tables: identity === null ? [] : [{ schema: "public", table: "zugfolge_database_identity", rowCount: "1", rowsSha256: identityRowHash }],
    },
  };
}

test("Schema-31 preparation resumes 29/31 asymmetry, compares isolated state and binds the legacy write probe", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-schema31-preparation-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = join(directory, "evidence");
  await mkdir(evidence);
  const ledger29 = await expectedLedger(29);
  const ledger31 = await expectedLedger(31);
  const recoveryId = "rollback-2026.4-001";
  const gameLiveUrl = "postgres://game:secret@postgres:5432/zugfolge";
  const gameRestoreUrl = "postgres://game:secret@recovery-verify-postgres:5432/zugfolge_recovery_v1_schema29_test";
  const odooLiveUrl = "postgres://odoo:secret@odoo-postgres:5432/zugfolge_odoo";
  const odooRestoreUrl = "postgres://odoo:secret@odoo-postgres:5432/zugfolge_odoo_recovery_v1_schema29_test";
  const baselinePayload = {
    candidateReleaseId: "infra-deutschland-2026.4",
    game: {
      backendSha256: "4".repeat(64), databaseIdentity: null, dumpSha256: "5".repeat(64), endpointSha256: "6".repeat(64),
      manifestSha256: "7".repeat(64), migrationCount: 29, operationSha256: "8".repeat(64), restoreBackendSha256: "9".repeat(64),
      restoreEndpointSha256: "a".repeat(64), restoreReceiptSha256: "b".repeat(64), stateSha256: "c".repeat(64),
    },
    observedRunningServices: [
      { containerId: "1".repeat(64), service: "odoo-postgres" },
      { containerId: "2".repeat(64), service: "postgres" },
      { containerId: "3".repeat(64), service: "recovery-verify-odoo-postgres" },
      { containerId: "4".repeat(64), service: "recovery-verify-postgres" },
    ],
    odoo: {
      backendSha256: "d".repeat(64), databaseDumpSha256: "e".repeat(64), endpointSha256: "f".repeat(64),
      filestoreArchiveSha256: "0".repeat(64), filestoreTreeSha256: "1".repeat(64), manifestSha256: "2".repeat(64),
      operationSha256: "3".repeat(64), restoreEndpointSha256: "4".repeat(64), restoreReceiptSha256: "5".repeat(64), stateSha256: "6".repeat(64),
    },
    previousReleaseId: "infra-deutschland-2026.2",
    qualifiedAt: "2026-08-26T10:00:00.000Z",
    recoveryId,
    schema: "zugfolge-production-cold-backup/v1",
    schema31PreparationReceiptSha256: null,
    writerContainersRunning: 0,
  };
  const baseline = { ...baselinePayload, receiptHash: canonicalSha256(baselinePayload) };
  const baselinePath = join(evidence, `${recoveryId}.schema29-cold-qualified.json`);
  const runtimePath = join(evidence, `${recoveryId}.schema29-runtime-drill.json`);
  const probePath = join(evidence, `${recoveryId}.schema31-legacy-write.json`);
  const outputPath = join(evidence, `${recoveryId}.schema31-prepared.json`);
  await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);
  const baselineArtifactSha256 = createHash("sha256").update(await readFile(baselinePath)).digest("hex");
  const gameImageDigest = `sha256:${"e".repeat(64)}`;
  const odooImageDigest = `sha256:${"f".repeat(64)}`;
  const runtimePayload = {
    baselineReceiptHash: baseline.receiptHash,
    baselineReceiptSha256: baselineArtifactSha256,
    candidateReleaseId: baseline.candidateReleaseId,
    game: {
      containerId: "5".repeat(64), healthBodySha256: "7".repeat(64), healthStatusCode: 200,
      imageDigest: gameImageDigest, imageId: `sha256:${"8".repeat(64)}`, imageReference: gameImageDigest,
    },
    gameProbeReceiptHash: "9".repeat(64), gameProbeReceiptSha256: "a".repeat(64),
    gameRestoreReceiptSha256: "b".repeat(64), gameRestoreStateSha256: "c".repeat(64),
    gameSchedulerAdvance: {
      advancedRegionCount: 1,
      advances: [{
        afterPublisherSequence: "11", afterRevision: "11", afterStateHash: "d".repeat(64),
        afterUpdatedAt: "2026-08-26T10:09:00.000Z", beforePublisherSequence: "10", beforeRevision: "10",
        beforeStateHash: "e".repeat(64), beforeUpdatedAt: "2026-08-26T10:08:00.000Z",
        regionId: "de-sn-leipzig", worldId: "00000000-0000-4000-8000-000000000014",
      }],
      afterHeadsSha256: "d".repeat(64), beforeHeadsSha256: "e".repeat(64),
    },
    keycloak: {
      authorizationSha256: "1".repeat(64), authorizationStatusCode: 200, containerId: "7".repeat(64),
      database: {
        clientsSha256: "2".repeat(64), offlineClientSessionCount: "0", offlineUserSessionCount: "0",
        realmName: "zugfolge", requiredClients: ["game-api", "game-web", "livemap", "operations-center"],
      },
      healthBodySha256: "3".repeat(64), healthStatusCode: 200,
      imageDigest: "sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13",
      imageId: `sha256:${"4".repeat(64)}`,
      imageReference: "quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13",
      jwksSha256: "5".repeat(64), jwksStatusCode: 200, oidcSha256: "6".repeat(64), oidcStatusCode: 200,
      realmSha256: "7".repeat(64), realmStatusCode: 200,
    },
    odoo: {
      containerId: "6".repeat(64), healthBodySha256: "d".repeat(64), healthStatusCode: 200,
      imageDigest: odooImageDigest, imageId: `sha256:${"e".repeat(64)}`, imageReference: odooImageDigest,
      runtimeUser: "100:101",
    },
    odooFilestoreFinalAccessSha256: "2".repeat(64),
    odooFilestoreHostPath: "/srv/zugfolge/schema29-filestore/zugfolge_odoo_recovery_v1_schema29_runtime_test",
    odooFilestoreOpenReceiptHash: "3".repeat(64), odooFilestoreOpenReceiptSha256: "4".repeat(64),
    odooFilestoreOwnerGid: 101, odooFilestoreOwnerUid: 100,
    odooFilestoreSealReceiptHash: "5".repeat(64), odooFilestoreSealReceiptSha256: "6".repeat(64),
    odooFilestoreTreeSha256: baseline.odoo.filestoreTreeSha256,
    odooProbeReceiptHash: "f".repeat(64), odooProbeReceiptSha256: "0".repeat(64),
    odooRestoreReceiptSha256: "1".repeat(64), odooRestoreStateSha256: "c".repeat(64),
    odooStartupSequenceAdvances: [
      { afterLastValue: "986", beforeLastValue: "985", sequence: "public.ir_attachment_id_seq" },
      { afterLastValue: "46", beforeLastValue: "45", sequence: "public.ir_config_parameter_id_seq" },
    ],
    previousReleaseId: baseline.previousReleaseId,
    previousWorldId: "00000000-0000-4000-8000-000000000014",
    pristineGameRestoreStateSha256: baseline.game.stateSha256,
    pristineOdooFilestoreTreeSha256: baseline.odoo.filestoreTreeSha256,
    pristineOdooRestoreStateSha256: baseline.odoo.stateSha256,
    qualifiedAt: "2026-08-26T10:10:00.000Z",
    recoveryId,
    runtimeBeforeReceiptHash: "8".repeat(64), runtimeBeforeReceiptSha256: "9".repeat(64),
    schema: "zugfolge-production-schema29-runtime-drill/v3",
    worldDeploymentHash: "a".repeat(64), worldDeploymentSha256: "b".repeat(64),
  };
  await writeFile(runtimePath, `${JSON.stringify({ ...runtimePayload, receiptHash: canonicalSha256(runtimePayload) })}\n`);

  const liveIdentity = "00000000-0000-4000-8000-000000000031";
  const restoreIdentity = "00000000-0000-4000-8000-000000000032";
  let liveCount = 31;
  let restoreCount = 29;
  let migrations = 0;
  const inspectDatabase = async (url, { game }) => {
    if (!game) {
      const restored = url === odooRestoreUrl;
      return { backendSha256: restored ? "7".repeat(64) : baseline.odoo.backendSha256, endpointSha256: restored ? baseline.odoo.restoreEndpointSha256 : baseline.odoo.endpointSha256, stateSha256: baseline.odoo.stateSha256, state: {} };
    }
    const restored = url === gameRestoreUrl;
    const count = restored ? restoreCount : liveCount;
    return snapshot({
      backend: restored ? baseline.game.restoreBackendSha256 : baseline.game.backendSha256,
      endpoint: restored ? baseline.game.restoreEndpointSha256 : baseline.game.endpointSha256,
      identity: count === 29 ? null : restored ? restoreIdentity : liveIdentity,
      identityRowHash: restored ? "8".repeat(64) : "9".repeat(64),
      ledger: count === 29 ? ledger29 : ledger31,
      stateSha256: count === 29 ? baseline.game.stateSha256 : restored ? "a".repeat(64) : "b".repeat(64),
    });
  };
  const environment = {
    DATABASE_URL: gameLiveUrl,
    ODOO_DATABASE_URL: odooLiveUrl,
    PRODUCTION_RECOVERY_ID: recoveryId,
    PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID: baseline.candidateReleaseId,
    PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID: baseline.previousReleaseId,
    PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID: "00000000-0000-4000-8000-000000000014",
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST: gameImageDigest,
    PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST: odooImageDigest,
    PRODUCTION_RECOVERY_DOCKER_PROJECT: "zugfolge",
    PRODUCTION_SCHEMA29_COLD_RECEIPT_PATH: baselinePath,
    PRODUCTION_SCHEMA29_RUNTIME_RECEIPT_PATH: runtimePath,
    PRODUCTION_SCHEMA29_GAME_RESTORED_DATABASE_URL: gameRestoreUrl,
    PRODUCTION_SCHEMA29_ODOO_RESTORED_DATABASE_URL: odooRestoreUrl,
    PRODUCTION_SCHEMA29_ODOO_LIVE_FILESTORE_PATH: "/live",
    PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH: "/restore",
    PRODUCTION_SCHEMA31_LEGACY_PROBE_PATH: probePath,
    PRODUCTION_SCHEMA31_RECEIPT_OUTPUT_PATH: outputPath,
  };
  const options = {
    environment,
    inspectDatabase,
    inspectRunningServices: async () => baseline.observedRunningServices,
    inspectFilestore: async () => ({ treeSha256: baseline.odoo.filestoreTreeSha256 }),
    inspectMarkers: async () => ({
      command_receipt_capture_function_present: false,
      command_receipt_ledger_present: false,
      operational_initialization_immutability_function_present: false,
      operational_initialization_immutability_trigger_present: false,
      writer_guard_count: 0,
      writer_guard_function_present: false,
    }),
    migrateDatabase: async (url) => {
      migrations += 1;
      if (url === gameRestoreUrl) restoreCount = 31;
      else liveCount = 31;
    },
  };

  const resumed = await prepareGameSchema31(options);
  assert.equal(migrations, 1);
  assert.equal(resumed.live.state.databaseIdentity, liveIdentity);
  await prepareGameSchema31(options);
  assert.equal(migrations, 1, "completed 31/31 replay must not migrate again");

  const probePayload = {
    afterUpdatedAt: "2026-08-26 10:00:00+00", beforeUpdatedAt: "2026-08-26 10:00:00+00",
    databaseIdentity: liveIdentity, legacyImageDigest: environment.MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST,
    migrationCount: 31, previousWorldId: environment.PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID,
    recoveryId, rolledBack: true, schema: "zugfolge-legacy-schema31-write-probe/v1",
    transientUpdatedAt: "2026-08-26 10:00:01+00",
  };
  await writeFile(probePath, `${JSON.stringify({ ...probePayload, receiptHash: canonicalSha256(probePayload) })}\n`);
  const qualified = await qualifyGameSchema31(options);
  assert.equal(qualified.migrationCount, 31);
  assert.equal(qualified.liveDatabaseIdentity, liveIdentity);
  assert.equal(qualified.schema29RuntimeDrillReceiptSha256, createHash("sha256").update(await readFile(runtimePath)).digest("hex"));
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), qualified);
  assert.deepEqual(await qualifyGameSchema31(options), qualified, "qualified replay must validate the existing receipt");
  await rm(runtimePath);
  const migrationsBeforeMissingRuntime = migrations;
  await assert.rejects(prepareGameSchema31(options), /Schema-29-Runtime-Beleg fehlt/u);
  assert.equal(migrations, migrationsBeforeMissingRuntime, "missing runtime predecessor must fail before any migration");
});

test("Schema-31 preparation rejects partial Schema-32/33 markers before any migration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-schema31-marker-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(directory.length > 0, true);
  const source = await readFile(new URL("tools/alpha-ops/production-schema31-preparation.mjs", root), "utf8");
  const absent = {
    command_receipt_capture_function_present: false,
    command_receipt_ledger_present: false,
    operational_initialization_immutability_function_present: false,
    operational_initialization_immutability_trigger_present: false,
    writer_guard_count: 0,
    writer_guard_function_present: false,
  };
  assert.equal(validatePreSchema33MarkersAbsent(absent), absent);
  for (const marker of Object.keys(absent)) {
    assert.throws(
      () => validatePreSchema33MarkersAbsent({ ...absent, [marker]: marker === "writer_guard_count" ? 1 : true }),
      /vor seinem kalten Gate bereits teilweise vorhanden/u,
      marker,
    );
  }
  assert.match(source, /validatePreSchema33MarkersAbsent\(markers\)/u);
  assert.match(source, /entries\.slice\(0, TARGET_MIGRATION_COUNT\)/u);
  assert.doesNotMatch(source, /packages\/db\/dist\/migrate\.js/u);
});
