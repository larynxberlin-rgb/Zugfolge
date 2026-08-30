import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  qualifyProductionSchema29RuntimeDrill,
  validateProductionSchema29RuntimeDrillReceipt,
} from "./production-schema29-runtime-drill.mjs";

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

test("Schema-29 runtime drill binds the before snapshot, real legacy scheduler write, isolated Game/Odoo/Keycloak and pristine restores", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-schema29-runtime-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = join(directory, "evidence");
  await mkdir(evidence);
  const recoveryId = "rollback-2026.4-001";
  const previousWorldId = "00000000-0000-4000-8000-000000000014";
  const gameDigest = `sha256:${"a".repeat(64)}`;
  const odooDigest = `sha256:${"b".repeat(64)}`;
  const keycloakReference = "quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13";
  const baselinePayload = {
    candidateReleaseId: "infra-deutschland-2026.4",
    game: {
      backendSha256: "1".repeat(64), databaseIdentity: null, dumpSha256: "2".repeat(64), endpointSha256: "3".repeat(64),
      manifestSha256: "4".repeat(64), migrationCount: 29, operationSha256: "5".repeat(64), restoreBackendSha256: "6".repeat(64),
      restoreEndpointSha256: "7".repeat(64), restoreReceiptSha256: "8".repeat(64), stateSha256: "9".repeat(64),
    },
    observedRunningServices: [
      { containerId: "1".repeat(64), service: "odoo-postgres" },
      { containerId: "2".repeat(64), service: "postgres" },
      { containerId: "3".repeat(64), service: "recovery-verify-odoo-postgres" },
      { containerId: "4".repeat(64), service: "recovery-verify-postgres" },
    ],
    odoo: {
      backendSha256: "a".repeat(64), databaseDumpSha256: "b".repeat(64), endpointSha256: "c".repeat(64),
      filestoreArchiveSha256: "d".repeat(64), filestoreTreeSha256: "e".repeat(64), manifestSha256: "f".repeat(64),
      operationSha256: "0".repeat(64), restoreEndpointSha256: "1".repeat(64), restoreReceiptSha256: "2".repeat(64), stateSha256: "3".repeat(64),
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
  await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);

  const gameProbePayload = {
    afterUpdatedAt: "2026-08-26T10:01:00.000Z", beforeUpdatedAt: "2026-08-26T10:01:00.000Z",
    legacyImageDigest: gameDigest, migrationCount: 29, previousWorldId, recoveryId, rolledBack: true,
    schema: "zugfolge-legacy-schema29-write-probe/v1", transientUpdatedAt: "2026-08-26T10:01:01.000Z",
  };
  const gameProbePath = join(evidence, `${recoveryId}.schema29-game-runtime-write.json`);
  await writeFile(gameProbePath, `${JSON.stringify({ ...gameProbePayload, receiptHash: canonicalSha256(gameProbePayload) })}\n`);
  const odooProbePayload = {
    blobBytes: 73, blobRelativePath: `ab/${"c".repeat(40)}`, blobSha256: "6".repeat(64),
    cleanupComplete: true, createdFileCount: 1,
    databaseName: "zugfolge_odoo_recovery_v1_schema29_runtime_test", directReadSha256: "6".repeat(64),
    filestoreBeforeTreeSha256: baseline.odoo.filestoreTreeSha256,
    filestoreFinalTreeSha256: baseline.odoo.filestoreTreeSha256,
    filestoreWrittenTreeSha256: "7".repeat(64), fsynced: true, legacyOdooImageDigest: odooDigest,
    odooReadSha256: "6".repeat(64), recoveryId, rolledBack: true,
    schema: "zugfolge-legacy-odoo-schema29-write-probe/v2", temporaryAttachmentId: 43, temporaryRecordId: 42,
  };
  const odooProbePath = join(evidence, `${recoveryId}.schema29-odoo-runtime-write.json`);
  await writeFile(odooProbePath, `${JSON.stringify({ ...odooProbePayload, receiptHash: canonicalSha256(odooProbePayload) })}\n`);
  const gameRestorePath = join(evidence, `${recoveryId}.schema29-runtime.game-restore.json`);
  const gameRestoreReceipt = {
    database: "zugfolge_recovery_v1_schema29_runtime_test", dumpSha256: baseline.game.dumpSha256,
    identical: true, manifestSha256: baseline.game.manifestSha256, migrationCount: 29, recoveryId,
    schema: "zugfolge-production-game-restore/v1",
  };
  await writeFile(gameRestorePath, `${JSON.stringify(gameRestoreReceipt)}\n`);
  const odooRestorePath = join(evidence, `${recoveryId}.schema29-runtime.odoo-restore.json`);
  const odooRestoreReceipt = {
    authoritativeStateSha256: baseline.odoo.stateSha256,
    database: "zugfolge_odoo_recovery_v1_schema29_runtime_test",
    databaseSha256: baseline.odoo.databaseDumpSha256, filestoreArchiveSha256: baseline.odoo.filestoreArchiveSha256,
    filestoreTreeSha256: baseline.odoo.filestoreTreeSha256, identical: true, recoveryId,
    schema: "zugfolge-production-odoo-restore/v1",
  };
  await writeFile(odooRestorePath, `${JSON.stringify(odooRestoreReceipt)}\n`);

  const gameUrl = "postgres://game:secret@recovery-verify-postgres:5432/zugfolge_recovery_v1_schema29_runtime_test";
  const odooUrl = "postgres://odoo:secret@recovery-verify-odoo-postgres:5432/zugfolge_odoo_recovery_v1_schema29_runtime_test";
  const pristineGameUrl = "postgres://game:secret@recovery-verify-postgres:5432/zugfolge_recovery_v1_schema29_test";
  const pristineOdooUrl = "postgres://odoo:secret@recovery-verify-odoo-postgres:5432/zugfolge_odoo_recovery_v1_schema29_test";
  const worldDeploymentPath = join(evidence, "alpha-world-deployment.json");
  await writeFile(worldDeploymentPath, `${JSON.stringify({
    deployment: { worldId: previousWorldId }, deploymentHash: "f".repeat(64),
    evidencePadding: "x".repeat(4_194_304),
    signature: { algorithm: "Ed25519", keyId: "test", valueBase64: "AA==" },
  })}\n`);
  const beforeHeads = [{
    publisherSequence: "10", regionId: "de-sn-leipzig", revision: "10", stateHash: "4".repeat(64),
    updatedAt: "2026-08-26T10:00:00.000Z", worldId: previousWorldId,
  }];
  const beforePayload = {
    baselineReceiptHash: baseline.receiptHash,
    baselineReceiptSha256: createHash("sha256").update(await readFile(baselinePath)).digest("hex"),
    candidateReleaseId: baseline.candidateReleaseId,
    capturedAt: "2026-08-26T10:00:30.000Z",
    gameRestoreBackendSha256: baseline.game.restoreBackendSha256,
    gameRestoreEndpointSha256: "4".repeat(64),
    gameRestoreReceiptSha256: createHash("sha256").update(await readFile(gameRestorePath)).digest("hex"),
    gameRestoreStateSha256: baseline.game.stateSha256,
    heads: beforeHeads,
    headsSha256: canonicalSha256(beforeHeads),
    initializationBindingWindow: {
      afterConstraintDefinitionSha256: "a".repeat(64), afterConstraintValidated: true,
      beforeConstraintDefinitionSha256: "b".repeat(64), beforeConstraintValidated: false,
      invalidRowCount: "0", legacyRowCount: "2", migrationCount: 29, operationalRowCount: "0",
    },
    odooFilestoreTreeSha256: baseline.odoo.filestoreTreeSha256,
    odooRestoreEndpointSha256: "6".repeat(64),
    odooRestoreReceiptSha256: createHash("sha256").update(await readFile(odooRestorePath)).digest("hex"),
    odooRestoreStateSha256: baseline.odoo.stateSha256,
    previousReleaseId: baseline.previousReleaseId,
    previousWorldId,
    recoveryId,
    schema: "zugfolge-production-schema29-runtime-before/v2",
  };
  const beforePath = join(evidence, `${recoveryId}.schema29-runtime-before.json`);
  await writeFile(beforePath, `${JSON.stringify({ ...beforePayload, receiptHash: canonicalSha256(beforePayload) })}\n`);
  const beforeReceipt = JSON.parse(await readFile(beforePath, "utf8"));
  const openPayload = {
    baselineFilestoreTreeSha256: baseline.odoo.filestoreTreeSha256,
    beforeAccessSha256: "8".repeat(64), fileCount: 0, openedAccessSha256: "9".repeat(64),
    openedAt: "2026-08-26T10:00:40.000Z", ownerGid: 101, ownerUid: 100, recoveryId,
    runtimeBeforeReceiptHash: beforeReceipt.receiptHash,
    runtimeBeforeReceiptSha256: createHash("sha256").update(await readFile(beforePath)).digest("hex"),
    schema: "zugfolge-schema29-odoo-filestore-open/v1",
  };
  const openPath = join(evidence, `${recoveryId}.schema29-odoo-filestore-open.json`);
  await writeFile(openPath, `${JSON.stringify({ ...openPayload, receiptHash: canonicalSha256(openPayload) })}\n`);
  const openReceipt = JSON.parse(await readFile(openPath, "utf8"));
  const odooProbeReceipt = JSON.parse(await readFile(odooProbePath, "utf8"));
  const sealPayload = {
    baselineFilestoreTreeSha256: baseline.odoo.filestoreTreeSha256, fileCount: 0,
    finalAccessSha256: "a".repeat(64), finalFilestoreTreeSha256: baseline.odoo.filestoreTreeSha256,
    odooProbeReceiptHash: odooProbeReceipt.receiptHash,
    odooProbeReceiptSha256: createHash("sha256").update(await readFile(odooProbePath)).digest("hex"),
    openReceiptHash: openReceipt.receiptHash,
    openReceiptSha256: createHash("sha256").update(await readFile(openPath)).digest("hex"),
    ownerGid: 101, ownerUid: 100, recoveryId, schema: "zugfolge-schema29-odoo-filestore-seal/v1",
    sealedAt: "2026-08-26T10:01:30.000Z",
  };
  const sealPath = join(evidence, `${recoveryId}.schema29-odoo-filestore-seal.json`);
  await writeFile(sealPath, `${JSON.stringify({ ...sealPayload, receiptHash: canonicalSha256(sealPayload) })}\n`);
  const outputPath = join(evidence, `${recoveryId}.schema29-runtime-drill.json`);
  const environment = {
    DATABASE_URL: gameUrl,
    ODOO_DATABASE_URL: odooUrl,
    HOSTNAME: "7".repeat(12),
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST: gameDigest,
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE: gameDigest,
    MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH: worldDeploymentPath,
    PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST: odooDigest,
    PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE: odooDigest,
    PRODUCTION_RECOVERY_ODOO_RUNTIME_GID: "101",
    PRODUCTION_RECOVERY_ODOO_RUNTIME_UID: "100",
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH: "/srv/zugfolge/schema29-filestore/zugfolge_odoo_recovery_v1_schema29_runtime_test",
    PRODUCTION_SCHEMA29_KEYCLOAK_IMAGE_REFERENCE: keycloakReference,
    PRODUCTION_RECOVERY_ID: recoveryId,
    PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID: baseline.candidateReleaseId,
    PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID: baseline.previousReleaseId,
    PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID: previousWorldId,
    PRODUCTION_RECOVERY_DOCKER_PROJECT: "zugfolge",
    PRODUCTION_SCHEMA29_RUNTIME_CONTROL_SERVICE: "production-schema29-runtime-qualify",
    PRODUCTION_RECOVERY_EVIDENCE_ROOT: evidence,
    PRODUCTION_SCHEMA29_COLD_RECEIPT_PATH: baselinePath,
    PRODUCTION_SCHEMA29_GAME_LEGACY_PROBE_PATH: gameProbePath,
    PRODUCTION_SCHEMA29_ODOO_LEGACY_PROBE_PATH: odooProbePath,
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_OPEN_RECEIPT_PATH: openPath,
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_SEAL_RECEIPT_PATH: sealPath,
    PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_RECEIPT_PATH: gameRestorePath,
    PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_RECEIPT_PATH: odooRestorePath,
    PRODUCTION_SCHEMA29_RUNTIME_BEFORE_RECEIPT_PATH: beforePath,
    PRODUCTION_SCHEMA29_RUNTIME_RECEIPT_OUTPUT_PATH: outputPath,
    PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH: "/runtime-filestore",
    PRODUCTION_SCHEMA29_PRISTINE_GAME_RESTORED_DATABASE_URL: pristineGameUrl,
    PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORED_DATABASE_URL: pristineOdooUrl,
    PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORED_FILESTORE_PATH: "/pristine-filestore",
    PRODUCTION_SCHEMA29_GAME_HEALTH_URL: "http://schema29-game-runtime:3000/health/ready",
    PRODUCTION_SCHEMA29_ODOO_HEALTH_URL: "http://schema29-odoo-runtime:8069/web/health",
  };
  const databaseServices = ["odoo-postgres", "postgres", "recovery-verify-odoo-postgres", "recovery-verify-postgres"].map((service, index) => ({
    service, containerId: String(index + 1).repeat(64), command: [], configuredImage: "database", environment: [], health: "healthy",
    imageId: `sha256:${String(index + 1).repeat(64)}`, mounts: [],
    networks: service.startsWith("recovery-verify-") ? ["zugfolge-schema29-recovery"] : ["zugfolge_default"], portBindings: null,
  }));
  const inspectContainers = async () => [
    ...databaseServices,
    {
      service: "production-schema29-runtime-qualify", containerId: "7".repeat(64), command: [], configuredImage: "current",
      environment: [], health: null, imageId: `sha256:${"7".repeat(64)}`, mounts: [], networks: ["zugfolge-schema29-recovery"], portBindings: null,
    },
    {
      service: "schema29-game-runtime", containerId: "8".repeat(64), command: ["node", "apps/game-api/dist/server.js"], configuredImage: gameDigest,
      environment: [`DATABASE_URL=${gameUrl}`, `ALPHA_PUBLIC_WORLD_ID=${previousWorldId}`, `ALPHA_WORLD_RELEASE_PATHS_JSON=["${worldDeploymentPath}"]`], health: "healthy",
      imageId: `sha256:${"8".repeat(64)}`, mounts: [{ Destination: "/evidence", RW: false }], networks: ["zugfolge-schema29-recovery"], portBindings: null,
    },
    {
      service: "schema29-keycloak-runtime", containerId: "a".repeat(64), command: ["start"], configuredImage: keycloakReference,
      environment: ["KC_DB_URL=jdbc:postgresql://recovery-verify-postgres:5432/zugfolge_recovery_v1_schema29_runtime_test", "KC_DB_SCHEMA=public"],
      health: "healthy", imageId: `sha256:${"a".repeat(64)}`, mounts: [], networks: ["zugfolge-schema29-recovery"], portBindings: null,
    },
    {
      service: "schema29-odoo-runtime", containerId: "9".repeat(64),
      command: ["odoo", "--database=zugfolge_odoo_recovery_v1_schema29_runtime_test", "--db_host=recovery-verify-odoo-postgres"],
      configuredImage: odooDigest, environment: [], health: "healthy", imageId: `sha256:${"9".repeat(64)}`,
      mounts: [{ Destination: "/var/lib/odoo/filestore/zugfolge_odoo_recovery_v1_schema29_runtime_test", Source: environment.PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH, RW: true }], networks: ["zugfolge-schema29-recovery"], portBindings: null,
      user: "100:101",
    },
  ];
  const inspectDatabase = async (url, { game }) => {
    if (game) return {
      backendSha256: baseline.game.restoreBackendSha256,
      endpointSha256: url === pristineGameUrl ? baseline.game.restoreEndpointSha256 : "4".repeat(64),
      stateSha256: url === pristineGameUrl ? baseline.game.stateSha256 : "5".repeat(64),
      state: { databaseIdentity: null, migrationLedger: Array.from({ length: 29 }, () => ({})) },
    };
    return {
      endpointSha256: url === pristineOdooUrl ? baseline.odoo.restoreEndpointSha256 : "6".repeat(64),
      stateSha256: baseline.odoo.stateSha256, state: {},
    };
  };
  const afterHeads = [{
    publisherSequence: "11", regionId: "de-sn-leipzig", revision: "11", stateHash: "5".repeat(64),
    updatedAt: "2026-08-26T10:01:00.000Z", worldId: previousWorldId,
  }];
  const keycloakContinuity = {
    authorizationSha256: "0".repeat(64), authorizationStatusCode: 200,
    database: {
      clientsSha256: "1".repeat(64), offlineClientSessionCount: "0", offlineUserSessionCount: "0", realmName: "zugfolge",
      requiredClients: ["game-api", "game-web", "livemap", "operations-center", "provisioner"],
    },
    health: { bodySha256: "2".repeat(64), statusCode: 200 },
    jwksSha256: "3".repeat(64), jwksStatusCode: 200, oidcSha256: "4".repeat(64), oidcStatusCode: 200,
    realmSha256: "5".repeat(64), realmStatusCode: 200,
  };
  const result = await qualifyProductionSchema29RuntimeDrill({
    environment,
    inspectContainers,
    inspectDatabase,
    inspectFilestore: async () => ({ treeSha256: baseline.odoo.filestoreTreeSha256 }),
    inspectFilestoreAccess: async () => ({
      access: "read-only", accessSha256: sealPayload.finalAccessSha256, fileCount: 0,
      ownerGid: 101, ownerUid: 100, treeSha256: baseline.odoo.filestoreTreeSha256,
    }),
    inspectHealth: async (_url, label) => ({ bodySha256: label.includes("Game") ? "7".repeat(64) : "8".repeat(64), statusCode: 200 }),
    inspectHeads: async () => afterHeads,
    inspectKeycloak: async () => keycloakContinuity,
    now: () => new Date("2026-08-26T10:02:00.000Z"),
  });
  const receipt = validateProductionSchema29RuntimeDrillReceipt(JSON.parse(await readFile(result.outputPath, "utf8")), {
    recoveryId, baselineReceiptHash: baseline.receiptHash, gameImageDigest: gameDigest, odooImageDigest: odooDigest,
  });
  assert.equal(receipt.game.healthStatusCode, 200);
  assert.equal(receipt.gameSchedulerAdvance.advancedRegionCount, 1);
  assert.equal(receipt.keycloak.database.realmName, "zugfolge");
  assert.equal(receipt.odoo.healthStatusCode, 200);
  assert.equal(receipt.odooFilestoreHostPath, environment.PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH);
  assert.throws(
    () => validateProductionSchema29RuntimeDrillReceipt({ ...receipt, odooProbeReceiptHash: "0".repeat(64) }),
    /kanonischen Receipt-Hash/u,
  );
  await assert.rejects(
    qualifyProductionSchema29RuntimeDrill({
      environment: { ...environment, PRODUCTION_SCHEMA29_RUNTIME_RECEIPT_OUTPUT_PATH: join(evidence, "no-game-write.json") },
      inspectContainers,
      inspectDatabase,
      inspectFilestore: async () => ({ treeSha256: baseline.odoo.filestoreTreeSha256 }),
      inspectFilestoreAccess: async () => ({
        access: "read-only", accessSha256: sealPayload.finalAccessSha256, fileCount: 0,
        ownerGid: 101, ownerUid: 100, treeSha256: baseline.odoo.filestoreTreeSha256,
      }),
      inspectHealth: async () => ({ bodySha256: "7".repeat(64), statusCode: 200 }),
      inspectHeads: async () => beforeHeads,
      inspectKeycloak: async () => keycloakContinuity,
    }),
    /apps\/game-api\/dist\/server\.js erzeugte keinen dauerhaften Scheduler/u,
  );
  await assert.rejects(
    qualifyProductionSchema29RuntimeDrill({
      environment: { ...environment, PRODUCTION_SCHEMA29_RUNTIME_RECEIPT_OUTPUT_PATH: join(evidence, "filestore-drift.json") },
      inspectContainers,
      inspectDatabase,
      inspectFilestore: async () => ({ treeSha256: baseline.odoo.filestoreTreeSha256 }),
      inspectFilestoreAccess: async () => ({
        access: "read-only", accessSha256: sealPayload.finalAccessSha256, fileCount: 1,
        ownerGid: 101, ownerUid: 100, treeSha256: "f".repeat(64),
      }),
      inspectHealth: async () => ({ bodySha256: "7".repeat(64), statusCode: 200 }),
      inspectHeads: async () => afterHeads,
      inspectKeycloak: async () => keycloakContinuity,
    }),
    /bytegleich zur Baseline versiegelt/u,
  );
  await assert.rejects(
    qualifyProductionSchema29RuntimeDrill({
      environment: { ...environment, PRODUCTION_SCHEMA29_RUNTIME_RECEIPT_OUTPUT_PATH: join(evidence, "wrong-filestore-source.json") },
      inspectContainers: async () => (await inspectContainers()).map((container) => container.service === "schema29-odoo-runtime"
        ? { ...container, mounts: [{ ...container.mounts[0], Source: "/srv/zugfolge/pristine-filestore/zugfolge_odoo_recovery_v1_schema29_runtime_test" }] }
        : container),
      inspectDatabase,
      inspectFilestore: async () => ({ treeSha256: baseline.odoo.filestoreTreeSha256 }),
      inspectFilestoreAccess: async () => ({
        access: "read-only", accessSha256: sealPayload.finalAccessSha256, fileCount: 0,
        ownerGid: 101, ownerUid: 100, treeSha256: baseline.odoo.filestoreTreeSha256,
      }),
      inspectHealth: async () => ({ bodySha256: "7".repeat(64), statusCode: 200 }),
      inspectHeads: async () => afterHeads,
      inspectKeycloak: async () => keycloakContinuity,
    }),
    /exakten physischen Runtime-Filestore-Kindpfad/u,
  );
});
