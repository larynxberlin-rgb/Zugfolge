import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { serializeMapReleaseBuildEvidence } from "../tiles/map-release-build-evidence.mjs";
import { createDatabaseBackupRestoreEvidenceArtifacts } from "./create-database-backup-restore-evidence.mjs";
import { createDatabaseRollbackProofArtifact } from "./create-database-rollback-proof.mjs";
import {
  DATABASE_AUTHORITATIVE_TABLE_COUNT,
  DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
  databaseCutoverConstraintProofs,
  databaseCutoverGuardProofs,
  keycloakIdentityHeadFixture,
} from "./database-rollback-test-fixtures.mjs";

const DATABASE_ID = "00000000-0000-4000-8000-000000000031";
const SOURCE_URL = "postgres://source.example:5432/zugfolge";
const RESTORE_URL = "postgres://restore.example:5432/zugfolge_restore_contract";
const SOURCE_BACKEND = "3".repeat(64);
const RESTORE_BACKEND = "4".repeat(64);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshot(overrides = {}) {
  return {
    databaseIdentity: DATABASE_ID,
    migrationLedger: Array.from({ length: 33 }, (_, index) => ({
      id: index + 1,
      hash: (index + 1).toString(16).padStart(64, "0"),
      createdAt: 1_787_000_000_000 + index,
    })),
    constraints: databaseCutoverConstraintProofs(),
    guards: databaseCutoverGuardProofs(),
    heads: { total: 0, v2: 0, nonNullInitializationHash: 0, incompatible: 0 },
    authoritativeHead: {
      schema: "zugfolge-database-authoritative-head/v1",
      tableCount: DATABASE_AUTHORITATIVE_TABLE_COUNT,
      tableSetSha256: DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
      worldCount: 1,
      regionalStateCount: 0,
      domainEventCount: "0",
      stateHash: "8".repeat(64),
    },
    keycloakIdentityHead: keycloakIdentityHeadFixture(),
    ...overrides,
  };
}

function inspected(snapshotValue, backendSha256) {
  return Object.freeze({ snapshot: snapshotValue, backendSha256 });
}

async function fixture({ dump = Buffer.from("bound-game-backup", "utf8") } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-db-evidence-"));
  const dumpPath = join(root, "game.dump");
  const gameManifestPath = join(root, "game.manifest.json");
  const operationPath = join(root, "game.operation.json");
  const gameRestoreReceiptPath = join(root, "game.restore.json");
  const backupManifestPath = join(root, "database-backup-manifest.json");
  const restoreProofPath = join(root, "database-restore-proof.json");
  const rollbackProofPath = join(root, "database-rollback-proof.json");
  const dumpSha256 = sha256(dump);
  const gameManifest = {
    schema: "zugfolge-game-backup/v2",
    createdAt: "2026-08-25T10:00:00Z",
    bytes: dump.length,
    sha256: dumpSha256,
    migrationCount: 33,
    rpoSeconds: 300,
  };
  const gameManifestBytes = Buffer.from(`${JSON.stringify(gameManifest)}\n`, "utf8");
  const operation = {
    backupCompletedWalLsn: "0/16B6D20",
    backupId: `pgdump-sha256-${dumpSha256}`,
    backupStartedWalLsn: "0/16B6C50",
    completedAt: "2026-08-25T10:00:00Z",
    dumpSha256,
    gameBackupManifestSha256: sha256(gameManifestBytes),
    schema: "zugfolge-game-backup-operation/v1",
    writersQuiesced: true,
  };
  const restoreReceipt = {
    database: "zugfolge_restore_contract",
    dumpSha256,
    identical: true,
    manifestSha256: sha256(gameManifestBytes),
    migrationCount: 33,
    schema: "zugfolge-game-restore/v2",
  };
  await Promise.all([
    writeFile(dumpPath, dump),
    writeFile(gameManifestPath, gameManifestBytes),
    writeFile(operationPath, `${JSON.stringify(operation)}\n`),
    writeFile(gameRestoreReceiptPath, `${JSON.stringify(restoreReceipt)}\n`),
  ]);
  return {
    root,
    paths: {
      dumpPath,
      gameManifestPath,
      operationPath,
      gameRestoreReceiptPath,
      backupManifestPath,
      restoreProofPath,
      rollbackProofPath,
    },
    operation,
    restoreReceipt,
    environment: {
      DATABASE_ROLLBACK_WRITERS_QUIESCED: "true",
      DATABASE_URL: SOURCE_URL,
      DATABASE_ROLLBACK_RESTORED_DATABASE_URL: RESTORE_URL,
      DATABASE_ROLLBACK_GAME_BACKUP_DUMP_PATH: dumpPath,
      DATABASE_ROLLBACK_GAME_BACKUP_MANIFEST_PATH: gameManifestPath,
      DATABASE_ROLLBACK_GAME_BACKUP_OPERATION_PATH: operationPath,
      DATABASE_ROLLBACK_GAME_RESTORE_RECEIPT_PATH: gameRestoreReceiptPath,
      DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH: backupManifestPath,
      DATABASE_ROLLBACK_RESTORE_PROOF_PATH: restoreProofPath,
    },
  };
}

function inspectPair({ restoredSnapshot = snapshot(), sourceBackend = SOURCE_BACKEND, restoredBackend = RESTORE_BACKEND } = {}) {
  return async (url) => url === RESTORE_URL
    ? inspected(restoredSnapshot, restoredBackend)
    : inspected(snapshot(), sourceBackend);
}

async function missing(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

test("erzeugt aus echtem Dump-/Restore-Vertrag das kanonische v1-Paar und einen gueltigen v3-Rollbackbeleg", async () => {
  const value = await fixture();
  try {
    const result = await createDatabaseBackupRestoreEvidenceArtifacts({
      environment: value.environment,
      inspect: inspectPair(),
      now: () => new Date("2026-08-25T10:10:00.000Z"),
    });
    assert.match(result.backupManifestSha256, /^[a-f0-9]{64}$/u);
    assert.match(result.restoreProofSha256, /^[a-f0-9]{64}$/u);
    const backupManifestBytes = await readFile(value.paths.backupManifestPath);
    const restoreProofBytes = await readFile(value.paths.restoreProofPath);
    const backupManifest = JSON.parse(backupManifestBytes.toString("utf8"));
    const restoreProof = JSON.parse(restoreProofBytes.toString("utf8"));
    assert.equal(backupManifest.schema, "zugfolge-database-backup-manifest/v1");
    assert.equal(backupManifest.backupId, value.operation.backupId);
    assert.equal(restoreProof.schema, "zugfolge-database-restore-proof/v1");
    assert.equal(restoreProof.backupManifestSha256, sha256(backupManifestBytes));
    assert.deepEqual(backupManifestBytes, serializeMapReleaseBuildEvidence(backupManifest));
    assert.deepEqual(restoreProofBytes, serializeMapReleaseBuildEvidence(restoreProof));

    const rollback = await createDatabaseRollbackProofArtifact({
      environment: {
        ...value.environment,
        DATABASE_ROLLBACK_RELEASE_ID: "infra-deutschland-2026.4",
        DATABASE_ROLLBACK_PREVIOUS_RELEASE_ID: "infra-deutschland-2026.2",
        DATABASE_ROLLBACK_PROOF_OUTPUT_PATH: value.paths.rollbackProofPath,
      },
      postgresFactory: () => undefined,
      inspect: inspectPair(),
    });
    assert.match(rollback.proofHash, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.parse(await readFile(value.paths.rollbackProofPath, "utf8")).schema, "zugfolge-database-rollback-proof/v3");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("hasht einen grossen Game-Dump streaming statt ihn als JSON-Artefakt in den Speicher zu laden", async () => {
  const value = await fixture({ dump: Buffer.alloc(5 * 1_024 * 1_024, 0x5a) });
  try {
    const result = await createDatabaseBackupRestoreEvidenceArtifacts({
      environment: value.environment,
      inspect: inspectPair(),
      now: () => new Date("2026-08-25T10:10:00.000Z"),
    });
    assert.match(result.backupManifestSha256, /^[a-f0-9]{64}$/u);
    assert.match(result.restoreProofSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("publiziert nichts, wenn der Dump waehrend einer langsamen Datenbankinspektion mutiert", async () => {
  const value = await fixture();
  let mutated = false;
  try {
    await assert.rejects(
      createDatabaseBackupRestoreEvidenceArtifacts({
        environment: value.environment,
        inspect: async (url) => {
          if (!mutated) {
            mutated = true;
            await new Promise((resolve) => setTimeout(resolve, 50));
            await writeFile(value.paths.dumpPath, Buffer.from("mutated-game-dump", "utf8"));
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          return url === RESTORE_URL
            ? inspected(snapshot(), RESTORE_BACKEND)
            : inspected(snapshot(), SOURCE_BACKEND);
        },
      }),
      /ausgetauscht oder geaendert|Manifest/u,
    );
    await Promise.all([missing(value.paths.backupManifestPath), missing(value.paths.restoreProofPath)]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("publiziert nichts, wenn ein qualifizierter Rohbeleg vor dem Publish geloescht wird", async () => {
  const value = await fixture();
  let removed = false;
  try {
    await assert.rejects(
      createDatabaseBackupRestoreEvidenceArtifacts({
        environment: value.environment,
        inspect: async (url) => {
          if (!removed) {
            removed = true;
            await new Promise((resolve) => setTimeout(resolve, 50));
            await unlink(value.paths.operationPath);
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          return url === RESTORE_URL
            ? inspected(snapshot(), RESTORE_BACKEND)
            : inspected(snapshot(), SOURCE_BACKEND);
        },
      }),
      /ENOENT/u,
    );
    await Promise.all([missing(value.paths.backupManifestPath), missing(value.paths.restoreProofPath)]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert einen Restore-Receipt aus einem anderen Dump ohne Ausgabeartefakte", async () => {
  const value = await fixture();
  try {
    await writeFile(value.paths.gameRestoreReceiptPath, `${JSON.stringify({
      ...value.restoreReceipt,
      dumpSha256: "f".repeat(64),
    })}\n`);
    await assert.rejects(
      createDatabaseBackupRestoreEvidenceArtifacts({ environment: value.environment, inspect: inspectPair() }),
      /anderen Dump/u,
    );
    await Promise.all([missing(value.paths.backupManifestPath), missing(value.paths.restoreProofPath)]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert einen rueckwaerts laufenden WAL-Beleg", async () => {
  const value = await fixture();
  try {
    await writeFile(value.paths.operationPath, `${JSON.stringify({
      ...value.operation,
      backupStartedWalLsn: "0/16B6D20",
      backupCompletedWalLsn: "0/16B6C50",
    })}\n`);
    await assert.rejects(
      createDatabaseBackupRestoreEvidenceArtifacts({ environment: value.environment, inspect: inspectPair() }),
      /rueckwaerts laufende WAL-Spanne/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert einen logisch abweichenden Restore-Kopf", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      createDatabaseBackupRestoreEvidenceArtifacts({
        environment: value.environment,
        inspect: inspectPair({ restoredSnapshot: snapshot({ authoritativeHead: { ...snapshot().authoritativeHead, stateHash: "9".repeat(64) } }) }),
      }),
      /Restore weicht/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert verschiedene Endpunkte auf derselben PostgreSQL-Backendinstanz", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      createDatabaseBackupRestoreEvidenceArtifacts({
        environment: value.environment,
        inspect: inspectPair({ restoredBackend: SOURCE_BACKEND }),
      }),
      /derselben PostgreSQL-Backendinstanz/u,
    );
    await Promise.all([missing(value.paths.backupManifestPath), missing(value.paths.restoreProofPath)]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rollt die eigene erste Ausgabe zurueck, wenn der zweite Pfad bereits fremd belegt ist", async () => {
  const value = await fixture();
  try {
    await writeFile(value.paths.restoreProofPath, "foreign-restore-proof", "utf8");
    await assert.rejects(
      createDatabaseBackupRestoreEvidenceArtifacts({ environment: value.environment, inspect: inspectPair() }),
      /EEXIST/u,
    );
    await missing(value.paths.backupManifestPath);
    assert.equal(await readFile(value.paths.restoreProofPath, "utf8"), "foreign-restore-proof");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert denselben Ausgabepfad und veraendert die vorhandene Datei nicht", async () => {
  const value = await fixture();
  try {
    const shared = join(value.root, "shared.json");
    await writeFile(shared, "foreign", "utf8");
    await assert.rejects(
      createDatabaseBackupRestoreEvidenceArtifacts({
        environment: {
          ...value.environment,
          DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH: shared,
          DATABASE_ROLLBACK_RESTORE_PROOF_PATH: shared,
        },
        inspect: inspectPair(),
      }),
      /nicht denselben Ausgabepfad/u,
    );
    assert.equal(await readFile(shared, "utf8"), "foreign");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
