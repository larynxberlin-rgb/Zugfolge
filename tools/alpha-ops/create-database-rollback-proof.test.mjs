import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { serializeMapReleaseBuildEvidence } from "../tiles/map-release-build-evidence.mjs";
import {
  createDatabaseRollbackProofArtifact,
  databaseBackendIdentitySha256,
  databaseEndpointSha256,
} from "./create-database-rollback-proof.mjs";
import {
  DATABASE_AUTHORITATIVE_TABLE_COUNT,
  DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
  databaseCutoverConstraintProofs,
  databaseCutoverGuardProofs,
  databaseRollbackEvidenceFixtures,
  keycloakIdentityHeadFixture,
} from "./database-rollback-test-fixtures.mjs";

const DATABASE_A = "00000000-0000-4000-8000-000000000031";
const DATABASE_B = "00000000-0000-4000-8000-000000000032";

test("PostgreSQL-Clusteridentitaet bleibt ueber einen Prozessneustart stabil", () => {
  const identity = {
    serverAddress: "10.0.0.5",
    serverPort: 5432,
    systemIdentifier: "7523188472012345678",
  };
  assert.equal(databaseBackendIdentitySha256(identity), databaseBackendIdentitySha256({
    ...identity,
    postmasterStartedAt: "2026-08-26T03:00:00.000Z",
  }));
  assert.notEqual(databaseBackendIdentitySha256(identity), databaseBackendIdentitySha256({
    ...identity,
    systemIdentifier: "7523188472012345679",
  }));
});

function snapshot(databaseIdentity = DATABASE_A) {
  return {
    databaseIdentity,
    migrationLedger: Array.from({ length: 33 }, (_, index) => index + 1).map((id) => ({
      id,
      hash: id.toString(16).padStart(64, "0"),
      createdAt: 1_787_000_000_000 + id,
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
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-db-proof-"));
  const backup = join(root, "backup-manifest.json");
  const restore = join(root, "restore-proof.json");
  const output = join(root, "database-rollback-proof.json");
  const source = snapshot();
  const restoreSeparation = {
    schema: "zugfolge-database-restore-separation/v1",
    sourceEndpointSha256: databaseEndpointSha256("postgres://source"),
    restoredEndpointSha256: databaseEndpointSha256("postgres://restore"),
    sourceBackendSha256: "3".repeat(64),
    restoredBackendSha256: "4".repeat(64),
  };
  const evidence = databaseRollbackEvidenceFixtures(source, { restoreSeparation });
  await writeFile(backup, serializeMapReleaseBuildEvidence(evidence.backupManifest));
  await writeFile(restore, serializeMapReleaseBuildEvidence(evidence.restoreProof));
  return {
    root,
    output,
    source,
    evidence,
    environment: {
      DATABASE_ROLLBACK_WRITERS_QUIESCED: "true",
      DATABASE_URL: "postgres://source",
      DATABASE_ROLLBACK_RESTORED_DATABASE_URL: "postgres://restore",
      DATABASE_ROLLBACK_RELEASE_ID: "infra-deutschland-2026.4",
      DATABASE_ROLLBACK_PREVIOUS_RELEASE_ID: "infra-deutschland-2026.2",
      DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH: backup,
      DATABASE_ROLLBACK_RESTORE_PROOF_PATH: restore,
      DATABASE_ROLLBACK_PROOF_OUTPUT_PATH: output,
    },
  };
}

function inspected(snapshotValue, backendSha256) {
  return Object.freeze({ snapshot: snapshotValue, backendSha256 });
}

test("erzeugt create-new nur fuer denselben quieszierten Quell-/Restore-Kopf", async () => {
  const value = await fixture();
  try {
    const result = await createDatabaseRollbackProofArtifact({
      environment: value.environment,
      postgresFactory: () => undefined,
      inspect: async (url) => url.includes("restore")
        ? inspected(snapshot(), "4".repeat(64))
        : inspected(snapshot(), "3".repeat(64)),
    });
    assert.equal(result.databaseIdentity, DATABASE_A);
    assert.match(result.proofHash, /^[a-f0-9]{64}$/u);
    const proof = JSON.parse(await readFile(value.output, "utf8"));
    assert.equal(proof.schema, "zugfolge-database-rollback-proof/v3");
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: value.environment,
        postgresFactory: () => undefined,
        inspect: async (url) => url.includes("restore")
          ? inspected(snapshot(), "4".repeat(64))
          : inspected(snapshot(), "3".repeat(64)),
      }),
      /EEXIST/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert strukturgleichen Restore aus einer anderen Datenbankinstanz", async () => {
  const value = await fixture();
  let call = 0;
  try {
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: value.environment,
        postgresFactory: () => undefined,
        inspect: async () => inspected(
          snapshot(call === 0 ? DATABASE_A : DATABASE_B),
          call++ === 0 ? "3".repeat(64) : "4".repeat(64),
        ),
      }),
      /Restore weicht|selben persistenten Datenbankinstanz/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert einen nur behaupteten Quiescence-Zustand", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: { ...value.environment, DATABASE_ROLLBACK_WRITERS_QUIESCED: "false" },
      }),
      /Writer.*true/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert denselben Quell-/Restore-Endpunkt bereits vor einer DB-Verbindung", async () => {
  const value = await fixture();
  let inspectedCount = 0;
  try {
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: {
          ...value.environment,
          DATABASE_ROLLBACK_RESTORED_DATABASE_URL: value.environment.DATABASE_URL,
        },
        postgresFactory: () => undefined,
        inspect: async () => {
          inspectedCount += 1;
          return inspected(snapshot(), "3".repeat(64));
        },
      }),
      /nicht denselben PostgreSQL-Endpunkt/u,
    );
    assert.equal(inspectedCount, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert verschiedene URLs zur selben PostgreSQL-Backendinstanz", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: value.environment,
        postgresFactory: () => undefined,
        inspect: async () => inspected(snapshot(), "3".repeat(64)),
      }),
      /derselben PostgreSQL-Backendinstanz/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert einen kanonisch serialisierten, aber semantisch unvollstaendigen Restore-Beleg", async () => {
  const value = await fixture();
  try {
    await writeFile(
      value.environment.DATABASE_ROLLBACK_RESTORE_PROOF_PATH,
      serializeMapReleaseBuildEvidence({ schema: "zugfolge-database-restore-proof/v1" }),
    );
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: value.environment,
        postgresFactory: () => undefined,
        inspect: async (url) => url.includes("restore")
          ? inspected(snapshot(), "4".repeat(64))
          : inspected(snapshot(), "3".repeat(64)),
      }),
      /restoreProof besitzt fremde oder fehlende Felder/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert ein beliebiges kanonisches JSON als Backup-Manifest", async () => {
  const value = await fixture();
  try {
    await writeFile(
      value.environment.DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH,
      serializeMapReleaseBuildEvidence({ schema: "unrelated-file/v1", payload: "nicht-ein-backup" }),
    );
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: value.environment,
        postgresFactory: () => undefined,
        inspect: async (url) => url.includes("restore")
          ? inspected(snapshot(), "4".repeat(64))
          : inspected(snapshot(), "3".repeat(64)),
      }),
      /backupManifest besitzt fremde oder fehlende Felder/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert einen bytegleichen Pfadaustausch waehrend der Datenbankinspektion", async () => {
  const value = await fixture();
  const backupPath = value.environment.DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH;
  const originalBytes = await readFile(backupPath);
  let swapped = false;
  try {
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: value.environment,
        postgresFactory: () => undefined,
        inspect: async (url) => {
          if (!swapped) {
            swapped = true;
            await new Promise((resolve) => setTimeout(resolve, 50));
            await rename(backupPath, `${backupPath}.qualified`);
            await writeFile(backupPath, originalBytes);
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          return url.includes("restore")
            ? inspected(snapshot(), "4".repeat(64))
            : inspected(snapshot(), "3".repeat(64));
        },
      }),
      /ausgetauscht oder geaendert/u,
    );
    await assert.rejects(readFile(value.output), { code: "ENOENT" });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert uebergrosse und symlinkbasierte JSON-Belege vor dem Publish", async (t) => {
  const oversized = await fixture();
  try {
    await writeFile(
      oversized.environment.DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH,
      Buffer.alloc((4 * 1_024 * 1_024) + 1, 0x20),
    );
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: oversized.environment,
        postgresFactory: () => undefined,
        inspect: async (url) => url.includes("restore")
          ? inspected(snapshot(), "4".repeat(64))
          : inspected(snapshot(), "3".repeat(64)),
      }),
      /JSON-Artefaktlimit/u,
    );
  } finally {
    await rm(oversized.root, { recursive: true, force: true });
  }

  const linked = await fixture();
  try {
    const backupPath = linked.environment.DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH;
    const targetPath = `${backupPath}.target`;
    await rename(backupPath, targetPath);
    try {
      await symlink(targetPath, backupPath, "file");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.diagnostic("Symlinks werden auf dieser Plattform nicht zugelassen (EPERM).");
        return;
      }
      throw error;
    }
    await assert.rejects(
      createDatabaseRollbackProofArtifact({
        environment: linked.environment,
        postgresFactory: () => undefined,
        inspect: async (url) => url.includes("restore")
          ? inspected(snapshot(), "4".repeat(64))
          : inspected(snapshot(), "3".repeat(64)),
      }),
      /keine regulaere/u,
    );
  } finally {
    await rm(linked.root, { recursive: true, force: true });
  }
});
