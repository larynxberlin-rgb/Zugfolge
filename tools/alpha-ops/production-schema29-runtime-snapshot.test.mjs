import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProductionSchema29RuntimeBeforeReceipt,
  validateProductionSchema29RuntimeBeforeReceipt,
} from "./production-schema29-runtime-snapshot.mjs";

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

test("Schema-29 runtime before snapshot is create-new and binds untouched Game/Odoo restores before legacy processes start", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-schema29-runtime-before-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = join(directory, "evidence");
  await mkdir(evidence);
  const recoveryId = "rollback-2026.4-001";
  const previousWorldId = "00000000-0000-4000-8000-000000000014";
  const authoritativeOdooStateSha256 = "4".repeat(64);
  const pristineOdooRestorePath = join(evidence, `${recoveryId}.schema29.odoo-restore.json`);
  const pristineOdooRestoreBytes = `${JSON.stringify({
    authoritativeStateSha256: authoritativeOdooStateSha256, database: "zugfolge_odoo_recovery_v1_schema29_pristine_test",
    databaseSha256: "b".repeat(64), filestoreArchiveSha256: "d".repeat(64),
    filestoreTreeSha256: "e".repeat(64), identical: true, recoveryId, schema: "zugfolge-production-odoo-restore/v1",
  })}\n`;
  await writeFile(pristineOdooRestorePath, pristineOdooRestoreBytes);
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
      operationSha256: "0".repeat(64), restoreEndpointSha256: "1".repeat(64),
      restoreReceiptSha256: createHash("sha256").update(pristineOdooRestoreBytes).digest("hex"), stateSha256: "3".repeat(64),
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
  const gameRestorePath = join(evidence, `${recoveryId}.schema29-runtime.game-restore.json`);
  await writeFile(gameRestorePath, `${JSON.stringify({
    database: "zugfolge_recovery_v1_schema29_runtime_test", dumpSha256: baseline.game.dumpSha256, identical: true,
    manifestSha256: baseline.game.manifestSha256, migrationCount: 29, recoveryId, schema: "zugfolge-production-game-restore/v1",
  })}\n`);
  const odooRestorePath = join(evidence, `${recoveryId}.schema29-runtime.odoo-restore.json`);
  await writeFile(odooRestorePath, `${JSON.stringify({
    authoritativeStateSha256: authoritativeOdooStateSha256, database: "zugfolge_odoo_recovery_v1_schema29_runtime_test",
    databaseSha256: baseline.odoo.databaseDumpSha256, filestoreArchiveSha256: baseline.odoo.filestoreArchiveSha256,
    filestoreTreeSha256: baseline.odoo.filestoreTreeSha256, identical: true, recoveryId, schema: "zugfolge-production-odoo-restore/v1",
  })}\n`);
  const gameUrl = "postgres://game:secret@recovery-verify-postgres:5432/zugfolge_recovery_v1_schema29_runtime_test";
  const odooUrl = "postgres://odoo:secret@recovery-verify-odoo-postgres:5432/zugfolge_odoo_recovery_v1_schema29_runtime_test";
  const outputPath = join(evidence, `${recoveryId}.schema29-runtime-before.json`);
  const environment = {
    DATABASE_URL: gameUrl,
    ODOO_DATABASE_URL: odooUrl,
    PRODUCTION_RECOVERY_ID: recoveryId,
    PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID: baseline.candidateReleaseId,
    PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID: baseline.previousReleaseId,
    PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID: previousWorldId,
    PRODUCTION_RECOVERY_EVIDENCE_ROOT: evidence,
    PRODUCTION_SCHEMA29_COLD_RECEIPT_PATH: baselinePath,
    PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORE_RECEIPT_PATH: pristineOdooRestorePath,
    PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_RECEIPT_PATH: gameRestorePath,
    PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_RECEIPT_PATH: odooRestorePath,
    PRODUCTION_SCHEMA29_RUNTIME_BEFORE_OUTPUT_PATH: outputPath,
    PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH: "/runtime-filestore",
  };
  const heads = [{
    publisherSequence: "10", regionId: "de-sn-leipzig", revision: "10", stateHash: "4".repeat(64),
    updatedAt: "2026-08-26T10:00:00.000Z", worldId: previousWorldId,
  }];
  const inspectDatabase = async (url, { game }) => game
    ? {
      backendSha256: baseline.game.restoreBackendSha256, endpointSha256: "4".repeat(64), stateSha256: baseline.game.stateSha256,
      state: { databaseIdentity: null, migrationLedger: Array.from({ length: 29 }, () => ({})) },
    }
    : { endpointSha256: "6".repeat(64), stateSha256: baseline.odoo.stateSha256, state: {} };
  const initializationBindingWindow = {
    afterConstraintDefinitionSha256: "a".repeat(64), afterConstraintValidated: true,
    beforeConstraintDefinitionSha256: "b".repeat(64), beforeConstraintValidated: false,
    invalidRowCount: "0", legacyRowCount: "2", migrationCount: 29, operationalRowCount: "0",
  };
  const result = await createProductionSchema29RuntimeBeforeReceipt({
    environment,
    inspectDatabase,
    inspectFilestore: async () => ({ treeSha256: baseline.odoo.filestoreTreeSha256 }),
    inspectHeads: async () => heads,
    prepareRuntimeWindow: async () => initializationBindingWindow,
    now: () => new Date("2026-08-26T10:00:30.000Z"),
  });
  const receipt = validateProductionSchema29RuntimeBeforeReceipt(JSON.parse(await readFile(result.outputPath, "utf8")), {
    recoveryId, previousWorldId,
  });
  assert.equal(receipt.gameRestoreStateSha256, baseline.game.stateSha256);
  assert.equal(receipt.headsSha256, canonicalSha256(heads));
  assert.deepEqual(receipt.initializationBindingWindow, initializationBindingWindow);
  await assert.rejects(
    createProductionSchema29RuntimeBeforeReceipt({ environment, inspectDatabase, inspectHeads: async () => heads }),
    /existiert bereits/u,
  );
});
