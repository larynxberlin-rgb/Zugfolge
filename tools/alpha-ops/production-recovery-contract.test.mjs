import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDatabaseRollbackProof,
  serializeMapReleaseBuildEvidence,
} from "../tiles/map-release-build-evidence.mjs";
import {
  DATABASE_AUTHORITATIVE_TABLE_COUNT,
  DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
  databaseCutoverConstraintProofs,
  databaseCutoverGuardProofs,
  databaseRollbackEvidenceFixtures,
  keycloakIdentityHeadFixture,
} from "./database-rollback-test-fixtures.mjs";
import {
  createProductionQuiescenceReceiptArtifact,
  createProductionRecoveryArtifacts,
  databaseEndpointSha256,
  executeProductionRecoveryAction,
  executeProductionRecoverySourceAction,
  excludeBoundRecoveryControlContainer,
  parseDockerRunningServices,
  validateProductionQuiescenceReceipt,
} from "./production-recovery-contract.mjs";

const CANDIDATE = "infra-deutschland-2026.4";
const PREVIOUS = "infra-deutschland-2026.2";
const RECOVERY_ID = "rollback-2026.4-001";
const GAME_LIVE = "zugfolge";
const ODOO_LIVE = "zugfolge_odoo";
const GAME_TARGET = "zugfolge_recovery_v1_2026_3_001";
const ODOO_TARGET = "zugfolge_odoo_recovery_v1_2026_3_001";
const GAME_LIVE_ADMIN = "postgres://game-live/postgres";
const ODOO_LIVE_ADMIN = "postgres://odoo-live/postgres";
const GAME_TARGET_ADMIN = "postgres://game-recovery/postgres";
const ODOO_TARGET_ADMIN = "postgres://odoo-recovery/postgres";
const GAME_TARGET_URL = `postgres://game-recovery/${GAME_TARGET}`;
const ODOO_TARGET_URL = `postgres://odoo-recovery/${ODOO_TARGET}`;
const LEGACY_GAME_SOURCE_COMMIT = "3".repeat(40);
const LEGACY_GAME_IMAGE_DIGEST = `sha256:${"4".repeat(64)}`;
const LEGACY_ODOO_IMAGE_DIGEST = `sha256:${"5".repeat(64)}`;
const LEGACY_WORLD_ID = "00000000-0000-4000-8000-000000000041";
const LEGACY_WORLD_EPOCH = "2026-12-13T00:00:00.000Z";
const LEGACY_REGION_ID = "de-sn-leipzig";

test("Docker-Engine-Inventar bindet Projekt, Service und unveraenderliche Container-ID", () => {
  const services = parseDockerRunningServices([
    {
      Id: "a".repeat(64),
      Labels: {
        "com.docker.compose.project": "zugfolge",
        "com.docker.compose.service": "postgres",
      },
    },
    {
      Id: "b".repeat(64),
      Labels: {
        "com.docker.compose.project": "zugfolge",
        "com.docker.compose.service": "odoo-postgres",
      },
    },
    {
      Id: "c".repeat(64),
      Labels: {
        "com.docker.compose.project": "zugfolge",
        "com.docker.compose.service": "production-recovery-action",
      },
    },
  ], "zugfolge");
  assert.deepEqual(excludeBoundRecoveryControlContainer(services, {
    HOSTNAME: "c".repeat(12),
    PRODUCTION_RECOVERY_CONTROL_SERVICE: "production-recovery-action",
  }), [
    { containerId: "a".repeat(64), service: "postgres" },
    { containerId: "b".repeat(64), service: "odoo-postgres" },
  ]);
  assert.throws(
    () => parseDockerRunningServices([{ Id: "c".repeat(64), Labels: { "com.docker.compose.project": "fremd", "com.docker.compose.service": "game-api" } }], "zugfolge"),
    /fremden Compose-Projekt/u,
  );
  assert.throws(
    () => excludeBoundRecoveryControlContainer(services, {
      HOSTNAME: "d".repeat(12),
      PRODUCTION_RECOVERY_CONTROL_SERVICE: "production-recovery-action",
    }),
    /nicht eindeutig/u,
  );
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function targetUrl(adminUrl, database) {
  const value = new URL(adminUrl);
  value.pathname = `/${database}`;
  return value.href;
}

function fence(database, adminUrl, backendSha256, previousConnectionLimit = -1) {
  return Object.freeze({
    activeClientBackends: 0,
    allowConnections: false,
    backendSha256,
    connectionLimit: 0,
    database,
    endpointSha256: databaseEndpointSha256(targetUrl(adminUrl, database)),
    fencedWalLsn: "0/16B6D20",
    previousConnectionLimit,
  });
}

function snapshot() {
  return {
    databaseIdentity: "00000000-0000-4000-8000-000000000031",
    migrationLedger: Array.from({ length: 33 }, (_, index) => index + 1).map((id) => ({
      createdAt: 1_787_000_000_000 + id,
      hash: id.toString(16).padStart(64, "0"),
      id,
    })),
    constraints: databaseCutoverConstraintProofs(),
    guards: databaseCutoverGuardProofs(),
    heads: { incompatible: 0, nonNullInitializationHash: 0, total: 1, v2: 0 },
    authoritativeHead: {
      domainEventCount: "0",
      regionalStateCount: 1,
      schema: "zugfolge-database-authoritative-head/v1",
      stateHash: "8".repeat(64),
      tableCount: DATABASE_AUTHORITATIVE_TABLE_COUNT,
      tableSetSha256: DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
      worldCount: 1,
    },
    keycloakIdentityHead: keycloakIdentityHeadFixture(),
  };
}

async function createQuiescence(root, overrides = {}) {
  const output = join(root, "quiescence.json");
  const liveGameFence = fence(GAME_LIVE, GAME_LIVE_ADMIN, "5".repeat(64));
  const liveOdooFence = fence(ODOO_LIVE, ODOO_LIVE_ADMIN, "6".repeat(64));
  let fenceCalls = 0;
  const environment = {
    PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID: CANDIDATE,
    PRODUCTION_RECOVERY_DOCKER_PROJECT: "zugfolge",
    PRODUCTION_RECOVERY_EVIDENCE_ROOT: root,
    PRODUCTION_RECOVERY_GAME_ADMIN_DATABASE_URL: GAME_LIVE_ADMIN,
    PRODUCTION_RECOVERY_GAME_LIVE_DATABASE: GAME_LIVE,
    PRODUCTION_RECOVERY_ID: RECOVERY_ID,
    PRODUCTION_RECOVERY_ODOO_ADMIN_DATABASE_URL: ODOO_LIVE_ADMIN,
    PRODUCTION_RECOVERY_ODOO_LIVE_DATABASE: ODOO_LIVE,
    PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID: PREVIOUS,
    PRODUCTION_RECOVERY_QUIESCENCE_OUTPUT_PATH: output,
    ...overrides.environment,
  };
  const result = await createProductionQuiescenceReceiptArtifact({
    environment,
    inspectRunningServices: overrides.inspectRunningServices ?? (async () => [
      { containerId: "a".repeat(12), service: "postgres" },
      { containerId: "b".repeat(12), service: "odoo-postgres" },
    ]),
    fenceDatabase: async ({ database }) => {
      fenceCalls += 1;
      return database === GAME_LIVE ? liveGameFence : liveOdooFence;
    },
    now: () => new Date("2026-08-26T12:00:00.000Z"),
  });
  return { environment, fenceCalls: () => fenceCalls, liveGameFence, liveOdooFence, output, result };
}

test("Quiescence wird aus Docker-Inventar und zwei dauerhaften DB-Fences create-new belegt", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-production-quiescence-"));
  try {
    const fixture = await createQuiescence(root);
    assert.equal(fixture.fenceCalls(), 2);
    const bytes = await readFile(fixture.output);
    const receipt = validateProductionQuiescenceReceipt(JSON.parse(bytes.toString("utf8")), {
      candidateReleaseId: CANDIDATE,
      previousReleaseId: PREVIOUS,
      recoveryId: RECOVERY_ID,
    });
    assert.equal(receipt.writerContainersRunning, 0);
    assert.equal(receipt.gameDatabase.allowConnections, false);
    assert.equal(receipt.odooDatabase.activeClientBackends, 0);
    assert.equal(fixture.result.receiptHash, receipt.receiptHash);

    await assert.rejects(
      createProductionQuiescenceReceiptArtifact({
        environment: fixture.environment,
        inspectRunningServices: async () => { throw new Error("darf nicht erreicht werden"); },
      }),
      /create-new/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Quiescence verweigert jeden noch laufenden Writer vor einer Datenbanksperre", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-production-quiescence-writer-"));
  try {
    let fenced = false;
    await assert.rejects(
      createProductionQuiescenceReceiptArtifact({
        environment: {
          PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID: CANDIDATE,
          PRODUCTION_RECOVERY_DOCKER_PROJECT: "zugfolge",
          PRODUCTION_RECOVERY_EVIDENCE_ROOT: root,
          PRODUCTION_RECOVERY_GAME_ADMIN_DATABASE_URL: GAME_LIVE_ADMIN,
          PRODUCTION_RECOVERY_GAME_LIVE_DATABASE: GAME_LIVE,
          PRODUCTION_RECOVERY_ID: RECOVERY_ID,
          PRODUCTION_RECOVERY_ODOO_ADMIN_DATABASE_URL: ODOO_LIVE_ADMIN,
          PRODUCTION_RECOVERY_ODOO_LIVE_DATABASE: ODOO_LIVE,
          PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID: PREVIOUS,
          PRODUCTION_RECOVERY_QUIESCENCE_OUTPUT_PATH: join(root, "quiescence.json"),
        },
        inspectRunningServices: async () => [
          { containerId: "a".repeat(12), service: "postgres" },
          { containerId: "b".repeat(12), service: "odoo-postgres" },
          { containerId: "c".repeat(12), service: "game-api" },
        ],
        fenceDatabase: async () => { fenced = true; },
      }),
      /Writer/u,
    );
    assert.equal(fenced, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function recoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-production-recovery-"));
  const quiescence = await createQuiescence(root);
  const source = snapshot();
  const evidence = databaseRollbackEvidenceFixtures(source);
  const rollbackProof = createDatabaseRollbackProof({
    releaseId: CANDIDATE,
    previousReleaseId: PREVIOUS,
    source,
    ...evidence,
    rollbackWindow: "pre-activation-only",
    writersQuiesced: true,
  });

  const gameDump = Buffer.from("qualified-game-dump\n", "utf8");
  const gameDumpPath = join(root, "game.dump");
  const gameManifestPath = join(root, "game.manifest.json");
  const gameOperationPath = join(root, "game.operation.json");
  const gameBackupManifestPath = join(root, "database-backup-manifest.json");
  const gameRestoreProofPath = join(root, "database-restore-proof.json");
  const rollbackProofPath = join(root, "database-rollback-proof.json");
  const gameRestoreReceiptPath = join(root, "game.recovery.restore.json");
  await writeFile(gameDumpPath, gameDump);
  const gameManifest = {
    schema: "zugfolge-game-backup/v2",
    createdAt: "2026-08-25T10:00:00Z",
    bytes: gameDump.length,
    sha256: sha256(gameDump),
    migrationCount: source.migrationLedger.length,
    rpoSeconds: 300,
  };
  const gameManifestBytes = Buffer.from(`${JSON.stringify(gameManifest)}\n`, "utf8");
  await writeFile(gameManifestPath, gameManifestBytes);
  await writeFile(gameOperationPath, `${JSON.stringify({
    backupCompletedWalLsn: "0/16B6D20",
    backupId: evidence.backupManifest.backupId,
    backupStartedWalLsn: "0/16B6C50",
    completedAt: "2026-08-25T10:00:00Z",
    dumpSha256: sha256(gameDump),
    gameBackupManifestSha256: sha256(gameManifestBytes),
    schema: "zugfolge-game-backup-operation/v1",
    writersQuiesced: true,
  })}\n`, "utf8");
  await writeFile(gameBackupManifestPath, serializeMapReleaseBuildEvidence(evidence.backupManifest));
  await writeFile(gameRestoreProofPath, serializeMapReleaseBuildEvidence(evidence.restoreProof));
  const rollbackProofBytes = serializeMapReleaseBuildEvidence(rollbackProof);
  await writeFile(rollbackProofPath, rollbackProofBytes);
  await writeFile(gameRestoreReceiptPath, serializeMapReleaseBuildEvidence({
    database: GAME_TARGET,
    dumpSha256: sha256(gameDump),
    identical: true,
    manifestSha256: sha256(gameManifestBytes),
    migrationCount: source.migrationLedger.length,
    recoveryId: RECOVERY_ID,
    schema: "zugfolge-production-game-restore/v1",
  }));

  const odooDump = Buffer.from("qualified-odoo-dump\n", "utf8");
  const odooArchive = Buffer.from("qualified-odoo-filestore-archive\n", "utf8");
  const odooDumpPath = join(root, "odoo.database.dump");
  const odooArchivePath = join(root, "odoo.filestore.tar.gz");
  const odooManifestPath = join(root, "odoo.manifest.json");
  const odooRestoreReceiptPath = join(root, "odoo.recovery.restore.json");
  await writeFile(odooDumpPath, odooDump);
  await writeFile(odooArchivePath, odooArchive);
  const filestoreRoot = join(root, "filestore-recovery");
  const filestorePath = join(filestoreRoot, ODOO_TARGET);
  const attachmentName = "a".repeat(40);
  const attachmentDirectory = join(filestorePath, "aa");
  const attachmentPath = join(attachmentDirectory, attachmentName);
  const attachmentBytes = Buffer.from("attachment\n", "utf8");
  await mkdir(attachmentDirectory, { recursive: true });
  await writeFile(attachmentPath, attachmentBytes);
  const treeSha256 = sha256(Buffer.from(`${sha256(attachmentBytes)}  ./aa/${attachmentName}\n`, "utf8"));
  const authoritativeStateSha256 = "9".repeat(64);
  const odooManifest = {
    schema: "zugfolge-odoo-backup/v2",
    createdAt: "2026-08-25T10:00:00Z",
    databaseSha256: sha256(odooDump),
    filestoreSha256: sha256(odooArchive),
    authoritativeStateSha256,
    filestoreTreeSha256: treeSha256,
    rpoSeconds: 900,
  };
  await writeFile(odooManifestPath, `${JSON.stringify(odooManifest)}\n`, "utf8");
  await writeFile(odooRestoreReceiptPath, serializeMapReleaseBuildEvidence({
    authoritativeStateSha256,
    database: ODOO_TARGET,
    databaseSha256: sha256(odooDump),
    filestoreArchiveSha256: sha256(odooArchive),
    filestoreTreeSha256: treeSha256,
    identical: true,
    recoveryId: RECOVERY_ID,
    schema: "zugfolge-production-odoo-restore/v1",
  }));
  await chmod(attachmentPath, 0o440);
  await chmod(attachmentDirectory, 0o550);
  await chmod(filestorePath, 0o550);

  const worldDeploymentPath = join(root, "attested-world-deployment.json");
  const worldDeployment = {
    deploymentHash: "d".repeat(64),
    infrastructureReleaseId: PREVIOUS,
    schema: "zugfolge-alpha-world-deployment/v1",
    worldEpoch: LEGACY_WORLD_EPOCH,
    worldId: LEGACY_WORLD_ID,
  };
  const worldDeploymentBytes = serializeMapReleaseBuildEvidence(worldDeployment);
  await writeFile(worldDeploymentPath, worldDeploymentBytes);
  const rollbackKeyId = "test-runtime-rollback";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const trustedKeysPath = join(root, "runtime-rollback-trusted-keys.json");
  await writeFile(trustedKeysPath, `${JSON.stringify({ [rollbackKeyId]: publicKeyPem })}\n`, "utf8");
  const runtimeTuple = {
    databaseRollback: {
      backupManifestSha256: rollbackProof.backupManifestSha256,
      bytes: rollbackProofBytes.length,
      databaseIdentity: rollbackProof.source.databaseIdentity,
      migrationLedgerPairSha256: rollbackProof.migrationLedgerPairSha256,
      previousReleaseId: PREVIOUS,
      proofHash: rollbackProof.proofHash,
      releaseId: CANDIDATE,
      restoreProofSha256: rollbackProof.restoreProofSha256,
      restoreSeparation: rollbackProof.restoreSeparation,
      rollbackWindow: rollbackProof.rollbackWindow,
      schema: rollbackProof.schema,
      sha256: sha256(rollbackProofBytes),
      sourceAuthoritativeHead: rollbackProof.source.authoritativeHead,
      sourceHeads: rollbackProof.source.heads,
      sourceKeycloakIdentityHead: rollbackProof.source.keycloakIdentityHead,
      writersQuiesced: rollbackProof.writersQuiesced,
    },
    imageDigest: LEGACY_GAME_IMAGE_DIGEST,
    mapReleaseId: PREVIOUS,
    odooImageDigest: LEGACY_ODOO_IMAGE_DIGEST,
    readModel: {
      applicationId: 1,
      bytes: 1,
      infrastructureReleaseId: PREVIOUS,
      repeatEveryS: 86_400,
      schema: "zugfolge-livemap-read-model-sqlite/v2",
      sha256: "a".repeat(64),
      userVersion: 2,
      worldEpoch: worldDeployment.worldEpoch,
      worldId: worldDeployment.worldId,
    },
    schema: "zugfolge-runtime-rollback-tuple/v3",
    sourceCommit: LEGACY_GAME_SOURCE_COMMIT,
    trainMapProjection: {
      applicationId: 2,
      bytes: 1,
      deploymentHash: worldDeployment.deploymentHash,
      infrastructureReleaseId: PREVIOUS,
      schema: "zugfolge-train-map-projection/v2",
      schemaSqlSha256: "b".repeat(64),
      sha256: "c".repeat(64),
      userVersion: 2,
      worldId: worldDeployment.worldId,
    },
    worldDeployment: {
      bytes: worldDeploymentBytes.length,
      deploymentHash: worldDeployment.deploymentHash,
      keyId: "test-world-key",
      repeatEveryS: 86_400,
      schema: worldDeployment.schema,
      sha256: sha256(worldDeploymentBytes),
      worldEpoch: worldDeployment.worldEpoch,
      worldId: worldDeployment.worldId,
    },
  };
  const unsignedAttestation = {
    approvalGate: { algorithm: "Ed25519", keyId: rollbackKeyId, status: "passed" },
    deliveryManifest: { bytes: 1, file: "delivery.json", sha256: "e".repeat(64) },
    packageManifest: { bytes: 1, file: "release.json", sha256: "f".repeat(64) },
    previousReleaseId: PREVIOUS,
    runtimeTuple,
    schema: "zugfolge-map-rollback-attestation/v3",
    signature: null,
  };
  const { signature: ignoredSignature, ...attestationPayload } = unsignedAttestation;
  void ignoredSignature;
  const attestationHash = sha256(serializeMapReleaseBuildEvidence(attestationPayload));
  const attestation = {
    ...unsignedAttestation,
    attestationHash,
    signature: {
      algorithm: "Ed25519",
      keyId: rollbackKeyId,
      valueBase64: signEd25519(null, Buffer.from(attestationHash, "hex"), privateKey).toString("base64"),
    },
  };
  const attestationPath = join(root, "runtime-rollback-attestation.json");
  await writeFile(attestationPath, serializeMapReleaseBuildEvidence(attestation));

  const environment = {
    PRODUCTION_RECOVERY_ATTESTED_WORLD_DEPLOYMENT_PATH: worldDeploymentPath,
    PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID: CANDIDATE,
    PRODUCTION_RECOVERY_DATABASE_ROLLBACK_PROOF_PATH: rollbackProofPath,
    PRODUCTION_RECOVERY_EVIDENCE_ROOT: root,
    PRODUCTION_RECOVERY_GAME_BACKUP_MANIFEST_PATH: gameBackupManifestPath,
    PRODUCTION_RECOVERY_GAME_BACKUP_OPERATION_PATH: gameOperationPath,
    PRODUCTION_RECOVERY_GAME_DUMP_PATH: gameDumpPath,
    PRODUCTION_RECOVERY_GAME_LIVE_ADMIN_DATABASE_URL: GAME_LIVE_ADMIN,
    PRODUCTION_RECOVERY_GAME_MANIFEST_PATH: gameManifestPath,
    PRODUCTION_RECOVERY_GAME_RESTORED_DATABASE_URL: GAME_TARGET_URL,
    PRODUCTION_RECOVERY_GAME_RESTORE_ADMIN_DATABASE_URL: GAME_TARGET_ADMIN,
    PRODUCTION_RECOVERY_GAME_RESTORE_PROOF_PATH: gameRestoreProofPath,
    PRODUCTION_RECOVERY_GAME_RESTORE_RECEIPT_PATH: gameRestoreReceiptPath,
    PRODUCTION_RECOVERY_ID: RECOVERY_ID,
    PRODUCTION_RECOVERY_LEGACY_GAME_IMAGE_DIGEST: LEGACY_GAME_IMAGE_DIGEST,
    PRODUCTION_RECOVERY_LEGACY_GAME_SOURCE_COMMIT: LEGACY_GAME_SOURCE_COMMIT,
    PRODUCTION_RECOVERY_ODOO_BACKUP_MANIFEST_PATH: odooManifestPath,
    PRODUCTION_RECOVERY_ODOO_DATABASE_DUMP_PATH: odooDumpPath,
    PRODUCTION_RECOVERY_ODOO_FILESTORE_ARCHIVE_PATH: odooArchivePath,
    PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT: filestoreRoot,
    PRODUCTION_RECOVERY_ODOO_LIVE_ADMIN_DATABASE_URL: ODOO_LIVE_ADMIN,
    PRODUCTION_RECOVERY_ODOO_RESTORED_DATABASE_URL: ODOO_TARGET_URL,
    PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH: filestorePath,
    PRODUCTION_RECOVERY_ODOO_RESTORE_ADMIN_DATABASE_URL: ODOO_TARGET_ADMIN,
    PRODUCTION_RECOVERY_ODOO_RESTORE_RECEIPT_PATH: odooRestoreReceiptPath,
    PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST: LEGACY_ODOO_IMAGE_DIGEST,
    PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID: worldDeployment.worldId,
    PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID: PREVIOUS,
    PRODUCTION_RECOVERY_PROMOTION_OUTPUT_PATH: join(root, "promotion.json"),
    PRODUCTION_RECOVERY_QUIESCENCE_PATH: quiescence.output,
    PRODUCTION_RECOVERY_RECEIPT_OUTPUT_PATH: join(root, "recovery.json"),
    PRODUCTION_RECOVERY_RUNTIME_ROLLBACK_ATTESTATION_PATH: attestationPath,
    PRODUCTION_RECOVERY_RUNTIME_ROLLBACK_TRUSTED_KEYS_PATH: trustedKeysPath,
  };
  const targetGameFence = fence(GAME_TARGET, GAME_TARGET_ADMIN, "7".repeat(64));
  const targetOdooFence = fence(ODOO_TARGET, ODOO_TARGET_ADMIN, "8".repeat(64));
  const observedFence = (database) => {
    const value = database === GAME_LIVE
      ? quiescence.liveGameFence
      : database === ODOO_LIVE
        ? quiescence.liveOdooFence
        : database === GAME_TARGET
          ? targetGameFence
          : targetOdooFence;
    const { fencedWalLsn, previousConnectionLimit: ignored, ...observed } = value;
    void ignored;
    return { ...observed, currentWalLsn: fencedWalLsn };
  };
  return {
    environment,
    filestore: { fileCount: 1, relativePaths: [`aa/${attachmentName}`], root: filestorePath, treeSha256 },
    odooManifest,
    root,
    rollbackProof,
    source,
    targetGameFence,
    targetOdooFence,
    dependencies: {
      inspectDatabaseFence: async ({ database }) => observedFence(database),
      inspectGameRestore: async () => ({ backendSha256: targetGameFence.backendSha256, snapshot: structuredClone(source) }),
      inspectOdooRestore: async () => ({
        attachmentCount: 1,
        authoritativeStateSha256,
        backendSha256: targetOdooFence.backendSha256,
        database: ODOO_TARGET,
        endpointSha256: targetOdooFence.endpointSha256,
        filestore: { fileCount: 1, relativePaths: [`aa/${attachmentName}`], root: filestorePath, treeSha256 },
      }),
      sealDatabase: async ({ database }) => database === GAME_TARGET ? targetGameFence : targetOdooFence,
    },
  };
}

test("Recovery bindet Game-Proof und Odoo-DB/Filestore gekoppelt und publiziert Receipt plus Promotion create-new", async () => {
  const fixture = await recoveryFixture();
  try {
    const result = await createProductionRecoveryArtifacts({
      environment: fixture.environment,
      ...fixture.dependencies,
      now: () => new Date("2026-08-26T12:15:00.000Z"),
    });
    assert.match(result.receiptHash, /^[a-f0-9]{64}$/u);
    assert.match(result.promotionHash, /^[a-f0-9]{64}$/u);
    const receipt = JSON.parse(await readFile(fixture.environment.PRODUCTION_RECOVERY_RECEIPT_OUTPUT_PATH, "utf8"));
    const promotion = JSON.parse(await readFile(fixture.environment.PRODUCTION_RECOVERY_PROMOTION_OUTPUT_PATH, "utf8"));
    assert.equal(receipt.schema, "zugfolge-production-recovery/v1");
    assert.equal(receipt.game.databaseRollbackProofHash, fixture.rollbackProof.proofHash);
    assert.equal(receipt.game.targetFence.allowConnections, false);
    assert.equal(receipt.odoo.database, ODOO_TARGET);
    assert.equal(receipt.odoo.filestoreTreeSha256, fixture.odooManifest.filestoreTreeSha256);
    assert.equal(receipt.odoo.attachmentCount, 1);
    assert.equal(promotion.schema, "zugfolge-production-recovery-promotion/v1");
    assert.equal(promotion.receiptHash, receipt.receiptHash);
    assert.equal(promotion.gameDatabase, GAME_TARGET);
    assert.equal(promotion.odooDatabase, ODOO_TARGET);

    await assert.rejects(
      createProductionRecoveryArtifacts({ environment: fixture.environment, ...fixture.dependencies }),
      /create-new/u,
    );
  } finally {
    await chmod(join(fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH, "aa"), 0o750).catch(() => {});
    await chmod(fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH, 0o750).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Recovery verweigert eine wieder geoeffnete Live-Fence vor Restore-Qualifikation und Ausgabe", async () => {
  const fixture = await recoveryFixture();
  try {
    let inspectedRestore = false;
    await assert.rejects(
      createProductionRecoveryArtifacts({
        environment: fixture.environment,
        ...fixture.dependencies,
        inspectDatabaseFence: async ({ database }) => {
          const observed = await fixture.dependencies.inspectDatabaseFence({ database });
          return database === GAME_LIVE ? { ...observed, allowConnections: true } : observed;
        },
        inspectGameRestore: async () => { inspectedRestore = true; return { backendSha256: fixture.targetGameFence.backendSha256, snapshot: fixture.source }; },
      }),
      /nicht mehr geschlossen/u,
    );
    assert.equal(inspectedRestore, false);
  } finally {
    await chmod(join(fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH, "aa"), 0o750).catch(() => {});
    await chmod(fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH, 0o750).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Recovery publiziert nichts bei manipuliertem Game-Dump oder fehlender Odoo-Haelfte", async () => {
  const fixture = await recoveryFixture();
  try {
    await writeFile(fixture.environment.PRODUCTION_RECOVERY_GAME_DUMP_PATH, "manipulated\n", "utf8");
    await assert.rejects(
      createProductionRecoveryArtifacts({ environment: fixture.environment, ...fixture.dependencies }),
      /Game-Dump weicht/u,
    );
    await assert.rejects(readFile(fixture.environment.PRODUCTION_RECOVERY_RECEIPT_OUTPUT_PATH), /ENOENT/u);
    await assert.rejects(readFile(fixture.environment.PRODUCTION_RECOVERY_PROMOTION_OUTPUT_PATH), /ENOENT/u);

    await writeFile(fixture.environment.PRODUCTION_RECOVERY_GAME_DUMP_PATH, "qualified-game-dump\n", "utf8");
    fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORE_RECEIPT_PATH = join(fixture.root, "missing-odoo.json");
    await assert.rejects(
      createProductionRecoveryArtifacts({ environment: fixture.environment, ...fixture.dependencies }),
      /ENOENT/u,
    );
  } finally {
    await chmod(join(fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH, "aa"), 0o750).catch(() => {});
    await chmod(fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH, 0o750).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function observedFence(value) {
  const { fencedWalLsn, previousConnectionLimit: ignored, ...observed } = value;
  void ignored;
  return structuredClone({ ...observed, currentWalLsn: fencedWalLsn });
}

async function activationFixture() {
  const fixture = await recoveryFixture();
  await createProductionRecoveryArtifacts({
    environment: fixture.environment,
    ...fixture.dependencies,
    now: () => new Date("2026-08-26T12:15:00.000Z"),
  });
  const quiescenceReceipt = await createQuiescenceReceiptForActivation(fixture);
  const states = new Map([
    [GAME_LIVE, observedFence(quiescenceReceipt.gameDatabase)],
    [ODOO_LIVE, observedFence(quiescenceReceipt.odooDatabase)],
    [GAME_TARGET, observedFence(fixture.targetGameFence)],
    [ODOO_TARGET, observedFence(fixture.targetOdooFence)],
  ]);
  let inspectCalls = 0;
  let openCalls = 0;
  let resealCalls = 0;
  const continuity = {
    authoritativeStateHash: fixture.source.authoritativeHead.stateHash,
    databaseIdentity: fixture.source.databaseIdentity,
    domainEventCount: 0n,
    keycloakIdentityStateHash: fixture.source.keycloakIdentityHead.stateHash,
    odooAttachmentCount: 1,
    odooAuthoritativeStateSha256: fixture.odooManifest.authoritativeStateSha256,
    publisherSequence: 0n,
    revision: 0n,
    stateHash: "a".repeat(64),
    worldId: LEGACY_WORLD_ID,
  };
  const filestoreStatus = await lstat(fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH);
  const environment = {
    ...fixture.environment,
    PRODUCTION_RECOVERY_ACTION_TIMEOUT_MS: "5000",
    PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH: join(fixture.root, `${RECOVERY_ID}.preflight.json`),
    PRODUCTION_RECOVERY_GAME_RESTORE_DATABASE: GAME_TARGET,
    PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_PATH: fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH,
    PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_ROOT: fixture.environment.PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT,
    PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE: ODOO_TARGET,
    PRODUCTION_RECOVERY_ODOO_RUNTIME_GID: String(filestoreStatus.gid),
    PRODUCTION_RECOVERY_ODOO_RUNTIME_UID: String(filestoreStatus.uid),
    PRODUCTION_RECOVERY_PROMOTION_PATH: fixture.environment.PRODUCTION_RECOVERY_PROMOTION_OUTPUT_PATH,
    PRODUCTION_RECOVERY_RECEIPT_PATH: fixture.environment.PRODUCTION_RECOVERY_RECEIPT_OUTPUT_PATH,
  };
  const dependencies = {
    ...fixture.dependencies,
    inspectDatabaseFence: async ({ database }) => {
      inspectCalls += 1;
      return structuredClone(states.get(database));
    },
    inspectGameContinuity: async () => {
      const currentSnapshot = structuredClone(fixture.source);
      currentSnapshot.databaseIdentity = continuity.databaseIdentity;
      currentSnapshot.authoritativeHead.domainEventCount = continuity.domainEventCount.toString();
      currentSnapshot.authoritativeHead.stateHash = continuity.authoritativeStateHash;
      currentSnapshot.keycloakIdentityHead.stateHash = continuity.keycloakIdentityStateHash;
      return {
        regions: [{
          initialization_hash: null,
          publisher_sequence: continuity.publisherSequence.toString(),
          region_id: LEGACY_REGION_ID,
          revision: continuity.revision.toString(),
          state_hash: continuity.stateHash,
          state_schema: "zugfolge-regional-simulation-state/v1",
          world_id: continuity.worldId,
        }],
        snapshot: currentSnapshot,
        world: {
          epoch: LEGACY_WORLD_EPOCH,
          lifecycle_status: "active",
          ranking_status: "ranked",
          schedule_period_weeks: 8,
          world_id: continuity.worldId,
          world_kind: "public",
        },
      };
    },
    inspectOdooRestore: async () => {
      const current = await fixture.dependencies.inspectOdooRestore();
      return {
        ...current,
        attachmentCount: continuity.odooAttachmentCount,
        authoritativeStateSha256: continuity.odooAuthoritativeStateSha256,
      };
    },
    openDatabase: async ({ expectedFence }) => {
      openCalls += 1;
      const current = states.get(expectedFence.database);
      states.set(expectedFence.database, {
        ...current,
        activeClientBackends: 0,
        allowConnections: true,
        connectionLimit: expectedFence.previousConnectionLimit,
      });
      return structuredClone(states.get(expectedFence.database));
    },
    inspectRunningServices: async () => [
      { containerId: "a".repeat(12), service: "postgres" },
      { containerId: "b".repeat(12), service: "odoo-postgres" },
    ],
    resealDatabase: async ({ expectedFence }) => {
      resealCalls += 1;
      const before = states.get(expectedFence.database);
      states.set(expectedFence.database, { ...observedFence(expectedFence), currentWalLsn: before.currentWalLsn });
      return structuredClone(states.get(expectedFence.database));
    },
  };
  return {
    ...fixture,
    dependencies,
    advanceGameContinuity: () => {
      continuity.revision += 1n;
      continuity.publisherSequence += 1n;
      continuity.domainEventCount += 1n;
      continuity.stateHash = sha256(Buffer.from(`state:${continuity.revision}`, "utf8"));
      continuity.authoritativeStateHash = sha256(Buffer.from(`authoritative:${continuity.revision}`, "utf8"));
      states.set(GAME_TARGET, { ...states.get(GAME_TARGET), currentWalLsn: `0/${(0x16B6D20n + continuity.revision).toString(16).toUpperCase()}` });
    },
    continuity,
    environment,
    inspectCalls: () => inspectCalls,
    openCalls: () => openCalls,
    resealCalls: () => resealCalls,
    states,
  };
}

async function createQuiescenceReceiptForActivation(fixture) {
  return JSON.parse(await readFile(fixture.environment.PRODUCTION_RECOVERY_QUIESCENCE_PATH, "utf8"));
}

async function cleanupActivationFixture(fixture) {
  await chmod(join(fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH, "aa"), 0o750).catch(() => {});
  await chmod(fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH, 0o750).catch(() => {});
  await rm(fixture.root, { recursive: true, force: true });
}

function actionEnvironment(fixture, action) {
  return {
    ...fixture.environment,
    PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH: join(fixture.root, `${RECOVERY_ID}.${action}.json`),
    ...(action === "activate" ? {
      PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH: join(fixture.root, `${RECOVERY_ID}.activate.intent.json`),
    } : {}),
  };
}

function sourceActionEnvironment(fixture, action) {
  return {
    ...fixture.environment,
    PRODUCTION_RECOVERY_SOURCE_ACTION_RECEIPT_OUTPUT_PATH: join(fixture.root, `${RECOVERY_ID}.source-${action}.json`),
    PRODUCTION_RECOVERY_SOURCE_INTENT_OUTPUT_PATH: join(fixture.root, `${RECOVERY_ID}.source-${action}.intent.json`),
  };
}

test("Source-Umschaltung oeffnet V2-Live gekoppelt, ist replay-sicher und sperrt vor V1-Rollback wieder gekoppelt", async () => {
  const fixture = await activationFixture();
  try {
    const releaseEnvironment = sourceActionEnvironment(fixture, "release");
    const release = await executeProductionRecoverySourceAction({
      action: "release",
      environment: releaseEnvironment,
      ...fixture.dependencies,
      now: () => new Date("2026-08-26T12:20:00.000Z"),
    });
    assert.equal(release.action, "release");
    assert.equal(release.replayed, false);
    assert.equal(fixture.states.get(GAME_LIVE).allowConnections, true);
    assert.equal(fixture.states.get(ODOO_LIVE).allowConnections, true);
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);
    const releaseReceipt = JSON.parse(await readFile(release.actionReceiptOutputPath, "utf8"));
    assert.equal(releaseReceipt.schema, "zugfolge-production-recovery-source-action/v2");
    assert.equal(release.sequence, 1);
    assert.match(releaseReceipt.intent.intentHash, /^[a-f0-9]{64}$/u);
    assert.equal(releaseReceipt.runtimeRollback.odooImageDigest, LEGACY_ODOO_IMAGE_DIGEST);

    const opensAfterRelease = fixture.openCalls();
    const releaseReplay = await executeProductionRecoverySourceAction({ action: "release", environment: releaseEnvironment, ...fixture.dependencies });
    assert.equal(releaseReplay.replayed, true);
    assert.equal(fixture.openCalls(), opensAfterRelease);

    const resealEnvironment = sourceActionEnvironment(fixture, "reseal");
    const reseal = await executeProductionRecoverySourceAction({ action: "reseal", environment: resealEnvironment, ...fixture.dependencies });
    assert.equal(reseal.replayed, false);
    assert.equal(reseal.sequence, 2);
    assert.equal(fixture.states.get(GAME_LIVE).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_LIVE).allowConnections, false);
    const resealsAfterAction = fixture.resealCalls();
    const resealReplay = await executeProductionRecoverySourceAction({ action: "reseal", environment: resealEnvironment, ...fixture.dependencies });
    assert.equal(resealReplay.replayed, true);
    assert.equal(fixture.resealCalls(), resealsAfterAction);

    const secondRelease = await executeProductionRecoverySourceAction({ action: "release", environment: releaseEnvironment, ...fixture.dependencies });
    assert.equal(secondRelease.replayed, false);
    assert.equal(secondRelease.sequence, 3);
    assert.notEqual(secondRelease.actionReceiptOutputPath, release.actionReceiptOutputPath);
    assert.equal(fixture.states.get(GAME_LIVE).allowConnections, true);
    assert.equal(fixture.states.get(ODOO_LIVE).allowConnections, true);
    const secondReleaseReplay = await executeProductionRecoverySourceAction({ action: "release", environment: releaseEnvironment, ...fixture.dependencies });
    assert.equal(secondReleaseReplay.replayed, true);
    assert.equal(secondReleaseReplay.sequence, 3);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Teiloeffnung der V2-Live-Quellen wird kompensiert und aus durable Intent sicher fortgesetzt", async () => {
  const fixture = await activationFixture();
  const environment = sourceActionEnvironment(fixture, "release");
  try {
    const originalOpen = fixture.dependencies.openDatabase;
    await assert.rejects(
      executeProductionRecoverySourceAction({
        action: "release",
        environment,
        ...fixture.dependencies,
        openDatabase: async (target) => {
          if (target.expectedFence.database === ODOO_LIVE) throw new Error("simulierter Odoo-Live-Oeffnungsfehler");
          return originalOpen(target);
        },
      }),
      /Live-Datenbank-Release/u,
    );
    assert.equal(fixture.states.get(GAME_LIVE).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_LIVE).allowConnections, false);
    await assert.rejects(readFile(environment.PRODUCTION_RECOVERY_SOURCE_ACTION_RECEIPT_OUTPUT_PATH), /ENOENT/u);
    const intent = JSON.parse(await readFile(join(fixture.root, `${RECOVERY_ID}.source-transition-000001-release.intent.json`), "utf8"));
    assert.equal(intent.schema, "zugfolge-production-recovery-source-intent/v2");

    const resumed = await executeProductionRecoverySourceAction({ action: "release", environment, ...fixture.dependencies });
    assert.equal(resumed.replayed, false);
    assert.equal(fixture.states.get(GAME_LIVE).allowConnections, true);
    assert.equal(fixture.states.get(ODOO_LIVE).allowConnections, true);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Source-Replay verweigert Drift im dauerhaft read-only V1-Odoo-Filestore und sperrt V2 gekoppelt", async () => {
  const fixture = await activationFixture();
  const environment = sourceActionEnvironment(fixture, "release");
  try {
    await executeProductionRecoverySourceAction({ action: "release", environment, ...fixture.dependencies });
    const filestore = fixture.environment.PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH;
    const driftFile = join(filestore, "unexpected-after-source-receipt.bin");
    await chmod(filestore, 0o750);
    await writeFile(driftFile, "unexpected source drift\n", "utf8");
    await chmod(driftFile, 0o440);
    await chmod(filestore, 0o550);

    await assert.rejects(
      executeProductionRecoverySourceAction({ action: "release", environment, ...fixture.dependencies }),
      /read-only V1-Odoo-Filestore|rueckgesperrt/u,
    );
    assert.equal(fixture.states.get(GAME_LIVE).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_LIVE).allowConnections, false);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Source-Transition verweigert WAL-/Backend-Ruecklauf und manipulierte Transition-Forks fail-closed", async () => {
  const walRollback = await activationFixture();
  try {
    await executeProductionRecoverySourceAction({ action: "release", environment: sourceActionEnvironment(walRollback, "release"), ...walRollback.dependencies });
    walRollback.states.set(GAME_LIVE, { ...walRollback.states.get(GAME_LIVE), currentWalLsn: "0/1" });
    await assert.rejects(
      executeProductionRecoverySourceAction({ action: "reseal", environment: sourceActionEnvironment(walRollback, "reseal"), ...walRollback.dependencies }),
      /rueckwaerts laufenden WAL|rueckgesperrt/u,
    );
    assert.equal(walRollback.states.get(GAME_LIVE).allowConnections, false);
    assert.equal(walRollback.states.get(ODOO_LIVE).allowConnections, false);
  } finally {
    await cleanupActivationFixture(walRollback);
  }

  const backendDrift = await activationFixture();
  try {
    await executeProductionRecoverySourceAction({ action: "release", environment: sourceActionEnvironment(backendDrift, "release"), ...backendDrift.dependencies });
    backendDrift.states.set(ODOO_LIVE, { ...backendDrift.states.get(ODOO_LIVE), backendSha256: "f".repeat(64) });
    await assert.rejects(
      executeProductionRecoverySourceAction({ action: "reseal", environment: sourceActionEnvironment(backendDrift, "reseal"), ...backendDrift.dependencies }),
      /Backend|ungueltig/u,
    );
    assert.equal(backendDrift.states.get(GAME_LIVE).allowConnections, false);
    assert.equal(backendDrift.states.get(ODOO_LIVE).allowConnections, false);
  } finally {
    await cleanupActivationFixture(backendDrift);
  }

  const receiptFork = await activationFixture();
  try {
    const release = await executeProductionRecoverySourceAction({ action: "release", environment: sourceActionEnvironment(receiptFork, "release"), ...receiptFork.dependencies });
    await writeFile(
      join(receiptFork.root, `${RECOVERY_ID}.source-transition-000001-reseal.receipt.json`),
      await readFile(release.actionReceiptOutputPath),
    );
    await assert.rejects(
      executeProductionRecoverySourceAction({ action: "reseal", environment: sourceActionEnvironment(receiptFork, "reseal"), ...receiptFork.dependencies }),
      /Dateinamen|Fork|ungueltig/u,
    );
    assert.equal(receiptFork.states.get(GAME_LIVE).allowConnections, false);
    assert.equal(receiptFork.states.get(ODOO_LIVE).allowConnections, false);
  } finally {
    await cleanupActivationFixture(receiptFork);
  }

  const proofDrift = await activationFixture();
  try {
    await executeProductionRecoverySourceAction({ action: "release", environment: sourceActionEnvironment(proofDrift, "release"), ...proofDrift.dependencies });
    proofDrift.environment.PRODUCTION_RECOVERY_LEGACY_GAME_IMAGE_DIGEST = `sha256:${"6".repeat(64)}`;
    await assert.rejects(
      executeProductionRecoverySourceAction({ action: "reseal", environment: sourceActionEnvironment(proofDrift, "reseal"), ...proofDrift.dependencies }),
      /Evidence war ungueltig/u,
    );
    assert.equal(proofDrift.states.get(GAME_LIVE).allowConnections, false);
    assert.equal(proofDrift.states.get(ODOO_LIVE).allowConnections, false);
  } finally {
    await cleanupActivationFixture(proofDrift);
  }
});

test("Recovery-Aktionen pruefen, oeffnen und versiegeln Game/Odoo nur gekoppelt", async () => {
  const fixture = await activationFixture();
  try {
    const preflight = await executeProductionRecoveryAction({
      action: "preflight",
      environment: actionEnvironment(fixture, "preflight"),
      ...fixture.dependencies,
      now: () => new Date("2026-08-26T12:30:00.000Z"),
    });
    assert.equal(preflight.action, "preflight");
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);

    const activation = await executeProductionRecoveryAction({
      action: "activate",
      environment: actionEnvironment(fixture, "activate"),
      ...fixture.dependencies,
      now: () => new Date("2026-08-26T12:31:00.000Z"),
    });
    assert.equal(activation.action, "activate");
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, true);
    assert.equal(fixture.states.get(GAME_TARGET).connectionLimit, fixture.targetGameFence.previousConnectionLimit);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, true);
    const activationReceipt = JSON.parse(await readFile(activation.actionReceiptOutputPath, "utf8"));
    assert.equal(activationReceipt.action, "activate");
    assert.match(activationReceipt.activationIntent.intentHash, /^[a-f0-9]{64}$/u);
    assert.equal(activationReceipt.gameDatabase.allowConnections, true);
    assert.equal(activationReceipt.odooFilestore.access, "owner-writable");
    assert.equal(activationReceipt.odooFilestore.treeSha256, fixture.filestore.treeSha256);
    assert.equal(activationReceipt.runtimeRollback.odooImageDigest, LEGACY_ODOO_IMAGE_DIGEST);
    const originReceipt = JSON.parse(await readFile(activation.continuityReceiptOutputPath, "utf8"));
    assert.equal(originReceipt.schema, "zugfolge-production-recovery-continuity-action/v1");
    assert.equal(originReceipt.action, "origin");
    assert.equal(originReceipt.sequence, 0);
    assert.equal(originReceipt.activation.actionReceiptHash, activationReceipt.actionReceiptHash);
    assert.equal(originReceipt.gameHead.authoritativeStateHash, fixture.source.authoritativeHead.stateHash);
    assert.equal(originReceipt.gameHead.keycloakIdentityStateHash, fixture.source.keycloakIdentityHead.stateHash);
    assert.equal(originReceipt.odooHead.authoritativeStateSha256, fixture.odooManifest.authoritativeStateSha256);
    assert.equal(originReceipt.odooHead.attachmentCount, 1);
    const intent = JSON.parse(await readFile(actionEnvironment(fixture, "activate").PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH, "utf8"));
    assert.equal(intent.schema, "zugfolge-production-recovery-activation-intent/v1");
    assert.equal(intent.odooFilestore.access, "read-only");

    const reseal = await executeProductionRecoveryAction({
      action: "reseal",
      environment: actionEnvironment(fixture, "reseal"),
      ...fixture.dependencies,
      now: () => new Date("2026-08-26T12:32:00.000Z"),
    });
    assert.equal(reseal.action, "reseal");
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);
    const resealReceipt = JSON.parse(await readFile(reseal.actionReceiptOutputPath, "utf8"));
    assert.equal(resealReceipt.schema, "zugfolge-production-recovery-continuity-action/v1");
    assert.equal(reseal.sequence, 1);
    assert.equal(resealReceipt.odooFilestore.access, "read-only");
    assert.equal(fixture.openCalls(), 2);
    assert.equal(fixture.resealCalls(), 2);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Legacy-Continuation startet nach Revision N+1 aus demselben attestierten Ursprung append-only neu", async () => {
  const fixture = await activationFixture();
  try {
    const activation = await executeProductionRecoveryAction({
      action: "activate",
      environment: actionEnvironment(fixture, "activate"),
      ...fixture.dependencies,
    });
    fixture.advanceGameContinuity();
    fixture.continuity.keycloakIdentityStateHash = "e".repeat(64);
    fixture.continuity.odooAuthoritativeStateSha256 = "f".repeat(64);

    const reseal = await executeProductionRecoveryAction({
      action: "reseal",
      environment: actionEnvironment(fixture, "reseal"),
      ...fixture.dependencies,
    });
    assert.equal(reseal.sequence, 1);
    const resealReceipt = JSON.parse(await readFile(reseal.actionReceiptOutputPath, "utf8"));
    assert.equal(resealReceipt.gameHead.regions[0].revision, "1");
    assert.equal(resealReceipt.gameHead.regions[0].publisherSequence, "1");
    assert.equal(resealReceipt.gameHead.authoritativeStateHash, fixture.continuity.authoritativeStateHash);
    assert.equal(resealReceipt.gameHead.keycloakIdentityStateHash, fixture.continuity.keycloakIdentityStateHash);
    assert.equal(resealReceipt.odooHead.authoritativeStateSha256, fixture.continuity.odooAuthoritativeStateSha256);
    assert.equal(resealReceipt.odooHead.attachmentCount, fixture.continuity.odooAttachmentCount);
    assert.equal(resealReceipt.activation.actionReceiptHash, activation.actionReceiptHash);
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);

    const continuation = await executeProductionRecoveryAction({
      action: "continue",
      environment: actionEnvironment(fixture, "continue"),
      ...fixture.dependencies,
    });
    assert.equal(continuation.sequence, 2);
    assert.equal(continuation.replayed, false);
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, true);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, true);
    const continuationReceipt = JSON.parse(await readFile(continuation.actionReceiptOutputPath, "utf8"));
    assert.equal(continuationReceipt.previous.actionReceiptHash, resealReceipt.actionReceiptHash);
    assert.equal(continuationReceipt.gameHead.regions[0].revision, "1");

    const openCalls = fixture.openCalls();
    const replay = await executeProductionRecoveryAction({
      action: "continue",
      environment: actionEnvironment(fixture, "continue"),
      ...fixture.dependencies,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.sequence, 2);
    assert.equal(fixture.openCalls(), openCalls);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Legacy-Continuation verweigert isolierten Game-, Keycloak- und Odoo-Kopfdrift nach Reseal", async (t) => {
  const cases = [
    {
      label: "Game",
      mutate: ({ continuity }) => { continuity.authoritativeStateHash = "1".repeat(64); },
    },
    {
      label: "Keycloak",
      mutate: ({ continuity }) => { continuity.keycloakIdentityStateHash = "2".repeat(64); },
    },
    {
      label: "Odoo-Zustand",
      mutate: ({ continuity }) => { continuity.odooAuthoritativeStateSha256 = "3".repeat(64); },
    },
    {
      label: "Odoo-Anhangszahl",
      mutate: ({ continuity }) => { continuity.odooAttachmentCount += 1; },
    },
  ];
  for (const drift of cases) {
    await t.test(drift.label, async () => {
      const fixture = await activationFixture();
      try {
        await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(fixture, "activate"), ...fixture.dependencies });
        fixture.advanceGameContinuity();
        await executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(fixture, "reseal"), ...fixture.dependencies });
        drift.mutate(fixture);

        await assert.rejects(
          executeProductionRecoveryAction({ action: "continue", environment: actionEnvironment(fixture, "continue"), ...fixture.dependencies }),
          /Recovery-Continuity war ungueltig|versiegelten .*kopf/ui,
        );
        assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
        assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);
      } finally {
        await cleanupActivationFixture(fixture);
      }
    });
  }
});

test("Fehlender Continuity-Ursprung und manipulierter Runtime-Proof sperren geoeffnete Legacy-Ziele fail-closed", async () => {
  const missingOrigin = await activationFixture();
  try {
    const activation = await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(missingOrigin, "activate"), ...missingOrigin.dependencies });
    await rm(activation.continuityReceiptOutputPath);
    await assert.rejects(
      executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(missingOrigin, "reseal"), ...missingOrigin.dependencies }),
      /Ursprungsbeleg fehlt|ungueltig/u,
    );
    assert.equal(missingOrigin.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(missingOrigin.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(missingOrigin);
  }

  const manipulatedOrigin = await activationFixture();
  try {
    const activation = await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(manipulatedOrigin, "activate"), ...manipulatedOrigin.dependencies });
    const origin = JSON.parse(await readFile(activation.continuityReceiptOutputPath, "utf8"));
    origin.gameHead.regions[0].stateHash = "f".repeat(64);
    await writeFile(activation.continuityReceiptOutputPath, serializeMapReleaseBuildEvidence(origin));
    await assert.rejects(
      executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(manipulatedOrigin, "reseal"), ...manipulatedOrigin.dependencies }),
      /kanonischen Hash|ungueltig/u,
    );
    assert.equal(manipulatedOrigin.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(manipulatedOrigin.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(manipulatedOrigin);
  }

  const proofDrift = await activationFixture();
  try {
    await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(proofDrift, "activate"), ...proofDrift.dependencies });
    proofDrift.environment.PRODUCTION_RECOVERY_LEGACY_GAME_IMAGE_DIGEST = `sha256:${"6".repeat(64)}`;
    await assert.rejects(
      executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(proofDrift, "reseal"), ...proofDrift.dependencies }),
      /Evidence war ungueltig/u,
    );
    assert.equal(proofDrift.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(proofDrift.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(proofDrift);
  }
});

test("Legacy-Continuity verweigert fremde Welt, Kopf-Ruecklauf und Teiloeffnung mit gekoppelter Kompensation", async () => {
  const worldDrift = await activationFixture();
  try {
    await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(worldDrift, "activate"), ...worldDrift.dependencies });
    worldDrift.continuity.worldId = "00000000-0000-4000-8000-000000000099";
    await assert.rejects(
      executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(worldDrift, "reseal"), ...worldDrift.dependencies }),
      /andere Welt|ungueltig/u,
    );
    assert.equal(worldDrift.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(worldDrift.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(worldDrift);
  }

  const databaseDrift = await activationFixture();
  try {
    await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(databaseDrift, "activate"), ...databaseDrift.dependencies });
    databaseDrift.continuity.databaseIdentity = "00000000-0000-4000-8000-000000000099";
    await assert.rejects(
      executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(databaseDrift, "reseal"), ...databaseDrift.dependencies }),
      /Datenbankidentitaet|Datenbankinstanz|ungueltig/u,
    );
    assert.equal(databaseDrift.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(databaseDrift.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(databaseDrift);
  }

  const headRollback = await activationFixture();
  try {
    await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(headRollback, "activate"), ...headRollback.dependencies });
    headRollback.advanceGameContinuity();
    await executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(headRollback, "reseal"), ...headRollback.dependencies });
    await executeProductionRecoveryAction({ action: "continue", environment: actionEnvironment(headRollback, "continue"), ...headRollback.dependencies });
    headRollback.continuity.revision = 0n;
    headRollback.continuity.publisherSequence = 0n;
    await assert.rejects(
      executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(headRollback, "reseal"), ...headRollback.dependencies }),
      /rueckwaerts laufenden Revision|ungueltig/u,
    );
    assert.equal(headRollback.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(headRollback.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(headRollback);
  }

  const publisherGap = await activationFixture();
  try {
    await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(publisherGap, "activate"), ...publisherGap.dependencies });
    publisherGap.continuity.revision = 1n;
    publisherGap.continuity.publisherSequence = 0n;
    await assert.rejects(
      executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(publisherGap, "reseal"), ...publisherGap.dependencies }),
      /Revision-\/Publishersequenz-Luecke|publishergleiche Revision|ungueltig/u,
    );
    assert.equal(publisherGap.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(publisherGap.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(publisherGap);
  }

  const partial = await activationFixture();
  try {
    await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(partial, "activate"), ...partial.dependencies });
    await executeProductionRecoveryAction({ action: "reseal", environment: actionEnvironment(partial, "reseal"), ...partial.dependencies });
    partial.states.set(GAME_TARGET, { ...partial.states.get(GAME_TARGET), allowConnections: true, connectionLimit: -1 });
    await assert.rejects(
      executeProductionRecoveryAction({ action: "continue", environment: actionEnvironment(partial, "continue"), ...partial.dependencies }),
      /Teiloeffnung|ungueltig/u,
    );
    assert.equal(partial.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(partial.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(partial);
  }
});

test("Nicht bestaetigbares Continuity-Reseal liefert AggregateError statt eines false-green Belegs", async () => {
  const fixture = await activationFixture();
  try {
    await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(fixture, "activate"), ...fixture.dependencies });
    const originalReseal = fixture.dependencies.resealDatabase;
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "reseal",
        environment: actionEnvironment(fixture, "reseal"),
        ...fixture.dependencies,
        resealDatabase: async (target) => {
          if (target.expectedFence.database === GAME_TARGET) throw new Error("simulierter persistenter Game-Reseal-Fehler");
          return originalReseal(target);
        },
      }),
      (error) => error instanceof AggregateError && /konnten nicht bestaetigt rueckgesperrt/u.test(error.message),
    );
    await assert.rejects(readFile(join(fixture.root, `${RECOVERY_ID}.continuity-000001-reseal.receipt.json`)), /ENOENT/u);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Prepared-Gate akzeptiert geoeffnete Live-Datenbanken nur bei unveraenderlicher Clusteridentitaet und versiegelten V1-Zielen", async () => {
  const fixture = await activationFixture();
  try {
    for (const database of [GAME_LIVE, ODOO_LIVE]) {
      fixture.states.set(database, {
        ...fixture.states.get(database),
        allowConnections: true,
        connectionLimit: -1,
      });
    }
    const prepared = await executeProductionRecoveryAction({
      action: "prepared",
      environment: actionEnvironment(fixture, "prepared"),
      ...fixture.dependencies,
    });
    assert.equal(prepared.action, "prepared");
    assert.equal(prepared.replayed, false);
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "preflight",
        environment: actionEnvironment(fixture, "preflight"),
        ...fixture.dependencies,
      }),
      /nicht mehr geschlossen/u,
    );
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Recovery-Preflight verweigert mutierte Promotion und mutiertes Receipt vor DB-Zugriff", async () => {
  const fixture = await activationFixture();
  try {
    const promotionPath = fixture.environment.PRODUCTION_RECOVERY_PROMOTION_PATH;
    const receiptPath = fixture.environment.PRODUCTION_RECOVERY_RECEIPT_PATH;
    const originalPromotion = await readFile(promotionPath);
    const originalReceipt = await readFile(receiptPath);
    const promotion = JSON.parse(originalPromotion.toString("utf8"));
    promotion.gameEndpointSha256 = "0".repeat(64);
    await writeFile(promotionPath, serializeMapReleaseBuildEvidence(promotion));
    await assert.rejects(
      executeProductionRecoveryAction({ action: "preflight", environment: actionEnvironment(fixture, "preflight"), ...fixture.dependencies }),
      /Promotion/u,
    );
    assert.equal(fixture.inspectCalls(), 0);

    await writeFile(promotionPath, originalPromotion);
    const receipt = JSON.parse(originalReceipt.toString("utf8"));
    receipt.game.dumpSha256 = "0".repeat(64);
    await writeFile(receiptPath, serializeMapReleaseBuildEvidence(receipt));
    await assert.rejects(
      executeProductionRecoveryAction({ action: "preflight", environment: actionEnvironment(fixture, "preflight"), ...fixture.dependencies }),
      /Receipt/u,
    );
    assert.equal(fixture.inspectCalls(), 0);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Recovery-Preflight verweigert einen fremden Container-Filestore", async () => {
  const fixture = await activationFixture();
  const foreignRoot = join(fixture.root, "foreign-container-filestore");
  const foreignPath = join(foreignRoot, ODOO_TARGET);
  try {
    await mkdir(foreignPath, { recursive: true });
    const foreignFile = join(foreignPath, "foreign");
    await writeFile(foreignFile, "foreign\n", "utf8");
    await chmod(foreignFile, 0o440);
    await chmod(foreignPath, 0o550);
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "preflight",
        environment: {
          ...actionEnvironment(fixture, "preflight"),
          PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_PATH: foreignPath,
          PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_ROOT: foreignRoot,
        },
        ...fixture.dependencies,
      }),
      /Containerfilestore/u,
    );
    assert.equal(fixture.openCalls(), 0);
  } finally {
    await chmod(foreignPath, 0o750).catch(() => {});
    await cleanupActivationFixture(fixture);
  }
});

test("Recovery-Preflight bindet die expliziten Compose-Datenbanknamen an Receipt und Promotion", async () => {
  const fixture = await activationFixture();
  try {
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "preflight",
        environment: {
          ...actionEnvironment(fixture, "preflight"),
          PRODUCTION_RECOVERY_GAME_RESTORE_DATABASE: "zugfolge_recovery_v1_fremd",
        },
        ...fixture.dependencies,
      }),
      /verschiedene Startziele/u,
    );
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "preflight",
        environment: {
          ...actionEnvironment(fixture, "preflight"),
          PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE: "zugfolge_odoo_recovery_v1_fremd",
        },
        ...fixture.dependencies,
      }),
      /verschiedene Startziele/u,
    );
    assert.equal(fixture.inspectCalls(), 0);
    assert.equal(fixture.openCalls(), 0);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Teiloeffnung wird kompensierend fuer beide Recovery-Datenbanken rueckgesperrt", async () => {
  const fixture = await activationFixture();
  try {
    const originalOpen = fixture.dependencies.openDatabase;
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "activate",
        environment: actionEnvironment(fixture, "activate"),
        ...fixture.dependencies,
        openDatabase: async (target) => {
          if (target.expectedFence.database === ODOO_TARGET) throw new Error("simulierter Odoo-Oeffnungsfehler");
          return originalOpen(target);
        },
      }),
      /vollstaendig geoeffnet/u,
    );
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);
    assert.equal(fixture.resealCalls(), 2);
    await assert.rejects(readFile(actionEnvironment(fixture, "activate").PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH), /ENOENT/u);
    const intent = JSON.parse(await readFile(actionEnvironment(fixture, "activate").PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH, "utf8"));
    assert.equal(intent.schema, "zugfolge-production-recovery-activation-intent/v1");
    const resealCallsBeforeReplay = fixture.resealCalls();
    await assert.rejects(
      executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(fixture, "activate"), ...fixture.dependencies }),
      /Intent ohne Abschlussbeleg/u,
    );
    assert.equal(fixture.resealCalls(), resealCallsBeforeReplay + 2, "Ein liegengebliebener Intent muss beide Ziele erneut fail-closed sperren.");
    const preflight = await executeProductionRecoveryAction({
      action: "preflight",
      environment: actionEnvironment(fixture, "preflight"),
      ...fixture.dependencies,
    });
    assert.equal(preflight.action, "preflight", "Kompensation muss DBs und Filestore wieder preflight-faehig sperren.");
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Recovery-Preflight verweigert Fence-Drift ohne Oeffnung oder Aktionsbeleg", async () => {
  const fixture = await activationFixture();
  try {
    fixture.states.set(GAME_TARGET, { ...fixture.states.get(GAME_TARGET), connectionLimit: 1 });
    await assert.rejects(
      executeProductionRecoveryAction({ action: "preflight", environment: actionEnvironment(fixture, "preflight"), ...fixture.dependencies }),
      /nicht mehr geschlossen/u,
    );
    assert.equal(fixture.openCalls(), 0);
    await assert.rejects(readFile(actionEnvironment(fixture, "preflight").PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH), /ENOENT/u);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Recovery-Aktivierung mutiert create-new und ist danach als vollstaendige Revalidierung replay-sicher", async () => {
  const fixture = await activationFixture();
  try {
    const environment = actionEnvironment(fixture, "activate");
    await executeProductionRecoveryAction({ action: "activate", environment, ...fixture.dependencies });
    const openCalls = fixture.openCalls();
    const inspectCalls = fixture.inspectCalls();
    const replay = await executeProductionRecoveryAction({ action: "activate", environment, ...fixture.dependencies });
    assert.equal(replay.action, "activate");
    assert.equal(replay.replayed, true);
    assert.equal(fixture.openCalls(), openCalls);
    assert.ok(fixture.inspectCalls() > inspectCalls, "Replay muss den belegten offenen Zustand erneut pruefen.");
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Recovery-Preflight verlangt die unveraenderte signierte Runtime-v3-Attestation samt Odoo-Image", async () => {
  const fixture = await activationFixture();
  try {
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "preflight",
        environment: {
          ...actionEnvironment(fixture, "preflight"),
          PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST: `sha256:${"6".repeat(64)}`,
        },
        ...fixture.dependencies,
      }),
      /Legacy-Odoo-Image-Digest/u,
    );
    const attestationPath = fixture.environment.PRODUCTION_RECOVERY_RUNTIME_ROLLBACK_ATTESTATION_PATH;
    const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
    attestation.runtimeTuple.odooImageDigest = `sha256:${"6".repeat(64)}`;
    await writeFile(attestationPath, serializeMapReleaseBuildEvidence(attestation));
    await assert.rejects(
      executeProductionRecoveryAction({ action: "preflight", environment: actionEnvironment(fixture, "preflight"), ...fixture.dependencies }),
      /kanonischen Hash/u,
    );
    assert.equal(fixture.inspectCalls(), 0);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Recovery-Aktion verweigert ein seit Quiescence veraendertes Writer-Inventar vor DB-Zugriff", async () => {
  const fixture = await activationFixture();
  try {
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "preflight",
        environment: actionEnvironment(fixture, "preflight"),
        ...fixture.dependencies,
        inspectRunningServices: async () => [
          { containerId: "a".repeat(12), service: "postgres" },
          { containerId: "b".repeat(12), service: "odoo-postgres" },
          { containerId: "c".repeat(12), service: "game-api" },
        ],
      }),
      /Writer-Inventar/u,
    );
    assert.equal(fixture.inspectCalls(), 0);
    assert.equal(fixture.openCalls(), 0);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Recovery-Preflight verweigert rueckwaerts driftende WAL-Beobachtung", async () => {
  const fixture = await activationFixture();
  try {
    fixture.states.set(GAME_TARGET, { ...fixture.states.get(GAME_TARGET), currentWalLsn: "0/1" });
    await assert.rejects(
      executeProductionRecoveryAction({ action: "preflight", environment: actionEnvironment(fixture, "preflight"), ...fixture.dependencies }),
      /rueckwaerts laufende WAL-LSN/u,
    );
    assert.equal(fixture.openCalls(), 0);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Post-Fence-Game-Drift bricht activate ab und kompensiert DBs plus Filestore", async () => {
  const fixture = await activationFixture();
  try {
    const environment = actionEnvironment(fixture, "activate");
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "activate",
        environment,
        ...fixture.dependencies,
        inspectGameRestore: async () => ({
          backendSha256: fixture.targetGameFence.backendSha256,
          snapshot: { ...structuredClone(fixture.source), databaseIdentity: "00000000-0000-4000-8000-000000000099" },
        }),
      }),
      /signiert attestierten Rollback-Kopf/u,
    );
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);
    await assert.rejects(readFile(environment.PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH), /ENOENT/u);
    assert.equal(JSON.parse(await readFile(environment.PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH, "utf8")).recoveryId, RECOVERY_ID);
    const preflight = await executeProductionRecoveryAction({
      action: "preflight",
      environment: actionEnvironment(fixture, "preflight"),
      ...fixture.dependencies,
    });
    assert.equal(preflight.action, "preflight");
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Harte Aktivierungsdeadline kompensiert eine haengende Teiloeffnung", async () => {
  const fixture = await activationFixture();
  try {
    const originalOpen = fixture.dependencies.openDatabase;
    let abortObserved = false;
    await assert.rejects(
      executeProductionRecoveryAction({
        action: "activate",
        environment: {
          ...actionEnvironment(fixture, "activate"),
          PRODUCTION_RECOVERY_ACTION_TIMEOUT_MS: "1000",
        },
        ...fixture.dependencies,
        openDatabase: async (target) => {
          if (target.expectedFence.database !== ODOO_TARGET) return originalOpen(target);
          return new Promise((resolvePromise, rejectPromise) => {
            void resolvePromise;
            target.signal.addEventListener("abort", () => {
              abortObserved = true;
              rejectPromise(new Error("simulierte abgebrochene Odoo-Oeffnung"));
            }, { once: true });
          });
        },
      }),
      /vollstaendig geoeffnet/u,
    );
    assert.equal(abortObserved, true);
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Preflight bleibt fest und Continuity-Reseal ist append-only replay-sicher", async () => {
  const fixture = await activationFixture();
  try {
    const preflightEnvironment = actionEnvironment(fixture, "preflight");
    const firstPreflight = await executeProductionRecoveryAction({ action: "preflight", environment: preflightEnvironment, ...fixture.dependencies });
    const secondPreflight = await executeProductionRecoveryAction({ action: "preflight", environment: preflightEnvironment, ...fixture.dependencies });
    assert.equal(firstPreflight.actionReceiptHash, secondPreflight.actionReceiptHash);
    assert.equal(secondPreflight.replayed, true);

    await executeProductionRecoveryAction({ action: "activate", environment: actionEnvironment(fixture, "activate"), ...fixture.dependencies });
    const resealEnvironment = actionEnvironment(fixture, "reseal");
    const firstReseal = await executeProductionRecoveryAction({ action: "reseal", environment: resealEnvironment, ...fixture.dependencies });
    const firstResealCalls = fixture.resealCalls();
    const secondReseal = await executeProductionRecoveryAction({ action: "reseal", environment: resealEnvironment, ...fixture.dependencies });
    assert.equal(firstReseal.actionReceiptHash, secondReseal.actionReceiptHash);
    assert.equal(secondReseal.replayed, true);
    assert.equal(fixture.resealCalls(), firstResealCalls);
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test("Drift hinter vorhandenem Aktivierungsabschluss wird beim Replay fail-closed rueckgesperrt", async () => {
  const fixture = await activationFixture();
  try {
    const environment = actionEnvironment(fixture, "activate");
    await executeProductionRecoveryAction({ action: "activate", environment, ...fixture.dependencies });
    fixture.states.set(GAME_TARGET, { ...fixture.states.get(GAME_TARGET), connectionLimit: 1 });
    await assert.rejects(
      executeProductionRecoveryAction({ action: "activate", environment, ...fixture.dependencies }),
      /fail-closed rueckgesperrt/u,
    );
    assert.equal(fixture.states.get(GAME_TARGET).allowConnections, false);
    assert.equal(fixture.states.get(ODOO_TARGET).allowConnections, false);
    const preflight = await executeProductionRecoveryAction({
      action: "preflight",
      environment: actionEnvironment(fixture, "preflight"),
      ...fixture.dependencies,
    });
    assert.equal(preflight.action, "preflight");
  } finally {
    await cleanupActivationFixture(fixture);
  }
});
