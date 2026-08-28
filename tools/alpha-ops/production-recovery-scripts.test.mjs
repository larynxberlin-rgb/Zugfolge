import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertProductionColdBackupPreflight,
  createProductionColdBackupReceipt,
  validateProductionColdBackupReceipt,
} from "./production-cold-backup.mjs";

const run = promisify(execFile);
const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sortedValue = (value) => {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
};
const canonicalHash = (value) => sha256(Buffer.from(JSON.stringify(sortedValue(value)), "utf8"));

function shellPath() {
  return process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\sh.exe" : "sh";
}

function shellFilePath(path) {
  if (process.platform !== "win32") return path;
  return `/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
}

test("Recovery-Backup-/Restore-Skripte publizieren create-new und binden sichere Ziele", async () => {
  const [gameBackup, odooBackup, game, odoo] = await Promise.all([
    read("ops/alpha/backup-game.sh"),
    read("ops/alpha/backup-odoo.sh"),
    read("ops/alpha/restore-game-recovery.sh"),
    read("ops/alpha/restore-odoo-recovery.sh"),
  ]);
  assert.match(gameBackup, /OUTPUT_PUBLISHED=1[\s\S]*MANIFEST_PUBLISHED=1[\s\S]*OPERATION_PUBLISHED=1/u);
  assert.match(gameBackup, /sync -f "\$DUMP_TEMP"[\s\S]*ln -- "\$DUMP_TEMP" "\$OUTPUT"/u);
  assert.match(gameBackup, /if \[ "\$OUTPUT_PUBLISHED" -eq 1 \]; then rm -f -- "\$OUTPUT"/u);
  assert.match(odooBackup, /DATABASE_ROLLBACK_WRITERS_QUIESCED must be exactly true for Odoo rollback evidence/u);
  assert.match(odooBackup, /STATE_BEFORE[\s\S]*TREE_BEFORE[\s\S]*STATE_SHA[\s\S]*TREE_SHA[\s\S]*changed during the quiesced backup/u);
  assert.match(odooBackup, /ln -- "\$DATABASE_TEMP" "\$DATABASE_DUMP"[\s\S]*ln -- "\$FILESTORE_TEMP" "\$FILESTORE_ARCHIVE"[\s\S]*ln -- "\$MANIFEST_TEMP" "\$MANIFEST"[\s\S]*ln -- "\$OPERATION_TEMP" "\$OPERATION"/u);
  assert.match(game, /zugfolge_recovery_v1_/u);
  assert.match(odoo, /zugfolge_odoo_recovery_v1_/u);
  assert.ok(game.indexOf("select 1 from pg_database") < game.indexOf("createdb --maintenance-db"));
  assert.ok(game.indexOf("createdb --maintenance-db") < game.indexOf("pg_restore --exit-on-error"));
  assert.ok(odoo.indexOf("select 1 from pg_database") < odoo.indexOf("createdb --maintenance-db"));
  assert.ok(odoo.indexOf("createdb --maintenance-db") < odoo.indexOf("pg_restore --exit-on-error"));
  assert.equal((game.match(/dropdb /gu) ?? []).length, 1);
  assert.equal((odoo.match(/dropdb /gu) ?? []).length, 1);
  assert.match(game, /if \[ "\$CREATED" -eq 1 \][\s\S]*dropdb/u);
  assert.match(odoo, /if \[ "\$CREATED" -eq 1 \][\s\S]*dropdb/u);
  assert.match(game, /ln -- "\$RECEIPT_TEMP" "\$RECEIPT"/u);
  assert.match(odoo, /chown -R "\$ODOO_RUNTIME_UID:\$ODOO_RUNTIME_GID" -- "\$STAGE"[\s\S]*chmod -R a-w -- "\$STAGE"[\s\S]*mv -T -- "\$STAGE" "\$TARGET_FILESTORE"[\s\S]*ln -- "\$RECEIPT_TEMP" "\$RECEIPT"/u);
  assert.doesNotMatch(game, /dropdb[^\n]+zugfolge(?:"|'|\s|$)/u);
  assert.match(odoo, /if \[ "\$TARGET_FILESTORE_CREATED" -eq 1 \]; then rm -rf -- "\$TARGET_FILESTORE"/u);
  assert.ok(odoo.indexOf("TARGET_FILESTORE_CREATED=1") < odoo.indexOf('ln -- "$RECEIPT_TEMP" "$RECEIPT"'));
  assert.ok(odoo.lastIndexOf("TARGET_FILESTORE_CREATED=0") > odoo.indexOf('ln -- "$RECEIPT_TEMP" "$RECEIPT"'));
});

test("Recovery-Restore-Skripte verweigern fremde Datenbanknamen ohne externe Programme aufzurufen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-recovery-script-names-"));
  try {
    const evidence = join(directory, "evidence");
    const filestore = join(directory, "filestore");
    await mkdir(evidence);
    await mkdir(filestore);
    const environment = {
      ...process.env,
      PRODUCTION_RECOVERY_EVIDENCE_ROOT: evidence,
      PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT: filestore,
    };
    await assert.rejects(
      run(shellPath(), [
        fileURLToPath(new URL("../../ops/alpha/restore-game-recovery.sh", import.meta.url)),
        "postgres://host/postgres",
        "zugfolge",
        join(directory, "missing.dump"),
        join(directory, "missing.json"),
        "rollback-001",
        join(evidence, "game.json"),
      ], { env: environment, windowsHide: true }),
      (error) => error.code === 65 && /unsafe recovery database/u.test(error.stderr),
    );
    await assert.rejects(
      run(shellPath(), [
        fileURLToPath(new URL("../../ops/alpha/restore-odoo-recovery.sh", import.meta.url)),
        "postgres://host/postgres",
        "zugfolge_odoo",
        join(filestore, "zugfolge_odoo"),
        join(directory, "missing"),
        join(directory, "missing.json"),
        "rollback-001",
        join(evidence, "odoo.json"),
      ], { env: environment, windowsHide: true }),
      (error) => error.code === 65 && /unsafe Odoo recovery database/u.test(error.stderr),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Odoo-Recovery verlangt vor jedem Restore eine explizite nicht-root Runtime-Eigentuemerschaft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-recovery-odoo-owner-"));
  try {
    const evidence = join(directory, "evidence");
    const filestore = join(directory, "filestore");
    await mkdir(evidence);
    await mkdir(filestore);
    await assert.rejects(
      run(shellPath(), [
        fileURLToPath(new URL("../../ops/alpha/restore-odoo-recovery.sh", import.meta.url)),
        "postgres://host/postgres",
        "zugfolge_odoo_recovery_v1_owner",
        `${shellFilePath(filestore)}/zugfolge_odoo_recovery_v1_owner`,
        `${shellFilePath(directory)}/missing`,
        `${shellFilePath(directory)}/missing.json`,
        "rollback-001",
        `${shellFilePath(evidence)}/odoo.json`,
      ], {
        env: {
          ...process.env,
          PRODUCTION_RECOVERY_EVIDENCE_ROOT: shellFilePath(evidence),
          PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT: shellFilePath(filestore),
        },
        windowsHide: true,
      }),
      (error) => error.code === 65 && /ODOO_RUNTIME_UID/u.test(error.stderr),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("kalter Vollbackup-Beleg koppelt beide DB-Restores, Filestore und writerfreies Compose-Inventar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-cold-backup-contract-"));
  try {
    const evidence = join(directory, "evidence");
    const material = join(directory, "material");
    await mkdir(evidence);
    await mkdir(material);
    const createdAt = "2026-08-26T10:00:00Z";
    const recoveryId = "rollback-2026.4-001";
    const schema31PreparationPayload = {
      baselineReceiptHash: "1".repeat(64), candidateReleaseId: "infra-deutschland-2026.4",
      legacyImageDigest: `sha256:${"2".repeat(64)}`, legacyProbeReceiptHash: "3".repeat(64),
      liveDatabaseIdentity: "00000000-0000-4000-8000-000000000031", migrationHeadHash: "4".repeat(64),
      migrationCount: 31, normalizedStateSha256: "5".repeat(64), previousReleaseId: "infra-deutschland-2026.2",
      previousWorldId: "00000000-0000-4000-8000-000000000014", recoveryId,
      restoredDatabaseIdentity: "00000000-0000-4000-8000-000000000032",
      schema29RuntimeDrillReceiptSha256: "6".repeat(64),
      schema: "zugfolge-production-schema31-preparation/v1",
    };
    const schema31PreparationPath = join(evidence, `${recoveryId}.schema31-prepared.json`);
    await writeFile(schema31PreparationPath, `${JSON.stringify({
      ...schema31PreparationPayload,
      receiptHash: canonicalHash(schema31PreparationPayload),
    })}\n`);
    const gameDump = Buffer.from("cold-game-dump", "utf8");
    const gameDumpPath = join(material, `${recoveryId}.cold.game.dump`);
    const gameManifestPath = join(material, `${recoveryId}.cold.game.manifest.json`);
    const gameOperationPath = join(material, `${recoveryId}.cold.game.operation.json`);
    const gameRestorePath = join(evidence, `${recoveryId}.cold.game-restore.json`);
    await writeFile(gameDumpPath, gameDump);
    const gameManifest = {
      schema: "zugfolge-game-backup/v2", createdAt, bytes: gameDump.length,
      sha256: sha256(gameDump), migrationCount: 31, rpoSeconds: 300,
    };
    const gameManifestBytes = Buffer.from(`${JSON.stringify(gameManifest)}\n`, "utf8");
    await writeFile(gameManifestPath, gameManifestBytes);
    await writeFile(gameOperationPath, `${JSON.stringify({
      backupCompletedWalLsn: "0/16B6C50", backupId: `pgdump-sha256-${sha256(gameDump)}`,
      backupStartedWalLsn: "0/16B6C40", completedAt: createdAt, dumpSha256: sha256(gameDump),
      gameBackupManifestSha256: sha256(gameManifestBytes), schema: "zugfolge-game-backup-operation/v1", writersQuiesced: true,
    })}\n`);
    await writeFile(gameRestorePath, `${JSON.stringify({
      database: "zugfolge_recovery_v1_verify_test", dumpSha256: sha256(gameDump), identical: true,
      manifestSha256: sha256(gameManifestBytes), migrationCount: 31, recoveryId,
      schema: "zugfolge-production-game-restore/v1",
    })}\n`);

    const odooDump = Buffer.from("cold-odoo-dump", "utf8");
    const odooArchive = Buffer.from("cold-odoo-filestore", "utf8");
    const treeSha256 = "e".repeat(64);
    const stateSha256 = "f".repeat(64);
    const odooPrefix = join(material, `${recoveryId}.cold.odoo`);
    const odooManifestPath = `${odooPrefix}.manifest.json`;
    const odooOperationPath = `${odooPrefix}.operation.json`;
    const odooRestorePath = join(evidence, `${recoveryId}.cold.odoo-restore.json`);
    await writeFile(`${odooPrefix}.database.dump`, odooDump);
    await writeFile(`${odooPrefix}.filestore.tar.gz`, odooArchive);
    const odooManifest = {
      schema: "zugfolge-odoo-backup/v2", createdAt, databaseSha256: sha256(odooDump),
      filestoreSha256: sha256(odooArchive), authoritativeStateSha256: stateSha256,
      filestoreTreeSha256: treeSha256, rpoSeconds: 900,
    };
    const odooManifestBytes = Buffer.from(`${JSON.stringify(odooManifest)}\n`, "utf8");
    await writeFile(odooManifestPath, odooManifestBytes);
    await writeFile(odooOperationPath, `${JSON.stringify({
      backupCompletedWalLsn: "0/26B6C50", backupId: `odoo-pgdump-sha256-${sha256(odooDump)}`,
      backupStartedWalLsn: "0/26B6C40", completedAt: createdAt, databaseSha256: sha256(odooDump),
      filestoreSha256: sha256(odooArchive), manifestSha256: sha256(odooManifestBytes),
      schema: "zugfolge-odoo-backup-operation/v1", stateSha256, treeSha256, writersQuiesced: true,
    })}\n`);
    await writeFile(odooRestorePath, `${JSON.stringify({
      authoritativeStateSha256: stateSha256, database: "zugfolge_odoo_recovery_v1_cold_test",
      databaseSha256: sha256(odooDump), filestoreArchiveSha256: sha256(odooArchive),
      filestoreTreeSha256: treeSha256, identical: true, recoveryId,
      schema: "zugfolge-production-odoo-restore/v1",
    })}\n`);

    const environment = {
      PRODUCTION_RECOVERY_ID: recoveryId,
      PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID: "infra-deutschland-2026.4",
      PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID: "infra-deutschland-2026.2",
      PRODUCTION_RECOVERY_EVIDENCE_ROOT: evidence,
      PRODUCTION_COLD_RECEIPT_OUTPUT_PATH: join(evidence, `${recoveryId}.cold-qualified.json`),
      PRODUCTION_SCHEMA31_RECEIPT_PATH: schema31PreparationPath,
      PRODUCTION_COLD_GAME_DUMP_PATH: gameDumpPath,
      PRODUCTION_COLD_GAME_MANIFEST_PATH: gameManifestPath,
      PRODUCTION_COLD_GAME_OPERATION_PATH: gameOperationPath,
      PRODUCTION_COLD_GAME_RESTORE_RECEIPT_PATH: gameRestorePath,
      PRODUCTION_COLD_ODOO_DATABASE_DUMP_PATH: `${odooPrefix}.database.dump`,
      PRODUCTION_COLD_ODOO_FILESTORE_ARCHIVE_PATH: `${odooPrefix}.filestore.tar.gz`,
      PRODUCTION_COLD_ODOO_MANIFEST_PATH: odooManifestPath,
      PRODUCTION_COLD_ODOO_OPERATION_PATH: odooOperationPath,
      PRODUCTION_COLD_ODOO_RESTORE_RECEIPT_PATH: odooRestorePath,
      DATABASE_URL: "postgres://game:secret@postgres:5432/zugfolge",
      PRODUCTION_COLD_GAME_RESTORED_DATABASE_URL: "postgres://game:secret@recovery-verify-postgres:5432/zugfolge_recovery_v1_verify_test",
      ODOO_DATABASE_URL: "postgres://odoo:secret@odoo-postgres:5432/zugfolge_odoo",
      PRODUCTION_COLD_ODOO_RESTORED_DATABASE_URL: "postgres://odoo:secret@recovery-verify-odoo-postgres:5432/zugfolge_odoo_recovery_v1_cold_test",
      PRODUCTION_COLD_ODOO_LIVE_FILESTORE_PATH: "/live",
      PRODUCTION_COLD_ODOO_RESTORED_FILESTORE_PATH: "/restored",
      PRODUCTION_RECOVERY_DOCKER_PROJECT: "zugfolge",
    };
    const gameState = {
      columnsSha256: "1".repeat(64), constraintsSha256: "2".repeat(64),
      databaseIdentity: "00000000-0000-4000-8000-000000000031",
      indexesSha256: "3".repeat(64),
      migrationLedger: Array.from({ length: 31 }, (_, index) => ({ id: String(index + 1), hash: `h${index}`, createdAt: String(index + 1) })),
      sequences: [], tables: [],
    };
    const odooState = { columnsSha256: "4".repeat(64), constraintsSha256: "5".repeat(64), databaseIdentity: null, indexesSha256: "6".repeat(64), migrationLedger: [], sequences: [], tables: [] };
    const inspectDatabase = async (url, { game }) => {
      const restored = url.includes("recovery-verify") || url.includes("cold_test");
      const state = game ? gameState : odooState;
      return {
        backendSha256: game && restored ? "8".repeat(64) : game ? "7".repeat(64) : "9".repeat(64),
        database: new URL(url).pathname.slice(1),
        endpointSha256: restored ? "b".repeat(64) : game ? "a".repeat(64) : "c".repeat(64),
        state,
        stateSha256: game ? "d".repeat(64) : "0".repeat(64),
      };
    };
    const inspectRunningServices = async () => [
      { containerId: "a".repeat(64), service: "odoo-postgres" },
      { containerId: "b".repeat(64), service: "postgres" },
      { containerId: "c".repeat(64), service: "recovery-verify-odoo-postgres" },
      { containerId: "d".repeat(64), service: "recovery-verify-postgres" },
    ];
    const inspectFilestore = async () => ({ fileCount: 1, treeSha256 });
    const result = await createProductionColdBackupReceipt({
      environment, inspectDatabase, inspectRunningServices, inspectFilestore,
      now: () => new Date("2026-08-26T10:05:00.000Z"),
    });
    const receipt = validateProductionColdBackupReceipt(JSON.parse(await readFile(result.outputPath, "utf8")), {
      recoveryId, candidateReleaseId: "infra-deutschland-2026.4", previousReleaseId: "infra-deutschland-2026.2",
    });
    assert.equal(receipt.game.migrationCount, 31);
    assert.equal(receipt.game.backendSha256 === receipt.game.restoreBackendSha256, false);
    assert.equal(receipt.odoo.filestoreTreeSha256, treeSha256);
    assert.throws(
      () => validateProductionColdBackupReceipt({ ...receipt, candidateReleaseId: "infra-deutschland-2026.3.1" }),
      /Jahres-Patchrelease/u,
    );

    await assert.rejects(
      createProductionColdBackupReceipt({
        environment,
        inspectDatabase: async () => { throw new Error("must not inspect on replay"); },
        inspectRunningServices: async () => { throw new Error("must not inspect on replay"); },
        inspectFilestore: async () => { throw new Error("must not inspect on replay"); },
      }),
      /existiert bereits/u,
    );

    await assertProductionColdBackupPreflight({
      environment: { ...environment, PRODUCTION_COLD_RECEIPT_PATH: result.outputPath },
      inspectDatabase, inspectRunningServices, inspectFilestore,
    });
    const schema31PreparationBytes = await readFile(schema31PreparationPath);
    await writeFile(schema31PreparationPath, `${JSON.stringify(JSON.parse(schema31PreparationBytes), null, 4)}\n`);
    await assert.rejects(
      assertProductionColdBackupPreflight({
        environment: { ...environment, PRODUCTION_COLD_RECEIPT_PATH: result.outputPath },
        inspectDatabase, inspectRunningServices, inspectFilestore,
      }),
      /bindet einen anderen Schema-31-Vorbereitungsbeleg/u,
    );
    await writeFile(schema31PreparationPath, schema31PreparationBytes);
    await assert.rejects(
      assertProductionColdBackupPreflight({
        environment: { ...environment, PRODUCTION_COLD_RECEIPT_PATH: result.outputPath },
        inspectDatabase: async (url, options) => {
          const value = await inspectDatabase(url, options);
          return options.game ? value : { ...value, stateSha256: "1".repeat(64) };
        },
        inspectRunningServices,
        inspectFilestore,
      }),
      /Odoo-Live-Datenbank hat sich/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
