import { createHash } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { serializeMapReleaseBuildEvidence } from "../tiles/map-release-build-evidence.mjs";
import {
  databaseEndpointSha256,
  inspectDatabaseRollbackEndpoint,
} from "./create-database-rollback-proof.mjs";

const GAME_BACKUP_SCHEMA = "zugfolge-game-backup/v2";
const GAME_BACKUP_OPERATION_SCHEMA = "zugfolge-game-backup-operation/v1";
const GAME_RESTORE_SCHEMA = "zugfolge-game-restore/v2";
const DATABASE_BACKUP_MANIFEST_SCHEMA = "zugfolge-database-backup-manifest/v1";
const DATABASE_RESTORE_PROOF_SCHEMA = "zugfolge-database-restore-proof/v1";
const EXPECTED_SCHEMA_MIGRATIONS = 33;
const MAX_JSON_ARTIFACT_BYTES = 4 * 1_024 * 1_024;
const STREAM_BUFFER_BYTES = 1 * 1_024 * 1_024;
const SHA256 = /^[a-f0-9]{64}$/u;
const WAL_LSN = /^[A-F0-9]+\/[A-F0-9]{1,8}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value;
}

function exactObjectKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${label} besitzt fremde oder fehlende Felder.`);
  return value;
}

function safeInteger(value, label, { positive = false } = {}) {
  invariant(Number.isSafeInteger(value), `${label} ist keine sichere Ganzzahl.`);
  invariant(positive ? value > 0 : value >= 0, `${label} liegt ausserhalb des erlaubten Bereichs.`);
  return value;
}

function canonicalInstant(value, label) {
  invariant(typeof value === "string" && Number.isFinite(Date.parse(value)), `${label} ist kein gueltiger UTC-Zeitpunkt.`);
  const canonical = new Date(value).toISOString();
  invariant(canonical.endsWith("Z"), `${label} ist kein UTC-Zeitpunkt.`);
  return canonical;
}

function walLsn(value, label) {
  invariant(typeof value === "string" && WAL_LSN.test(value), `${label} ist keine kanonische PostgreSQL-WAL-LSN.`);
  const [high, low] = value.split("/");
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(sortedValue(left)) === JSON.stringify(sortedValue(right));
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function stableRegularFile(path, label, { retainBytes = true } = {}) {
  const absolute = resolve(path);
  const pathBefore = await lstat(absolute, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n, `${label} ist keine regulaere, nichtleere Datei.`);
  invariant(pathBefore.size <= BigInt(Number.MAX_SAFE_INTEGER), `${label} ist fuer einen exakten Bytevertrag zu gross.`);
  if (retainBytes) {
    invariant(pathBefore.size <= BigInt(MAX_JSON_ARTIFACT_BYTES), `${label} ueberschreitet das JSON-Artefaktlimit.`);
  }
  const handle = await open(absolute, "r");
  try {
    const handleBefore = await handle.stat({ bigint: true });
    invariant(handleBefore.isFile() && sameFilesystemIdentity(pathBefore, handleBefore), `${label} wurde beim Oeffnen ausgetauscht.`);
    const hash = createHash("sha256");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
    let byteLength = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      invariant(Number.isSafeInteger(byteLength), `${label} besitzt keinen sicheren Bytezaehler.`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (retainBytes) chunks.push(Buffer.from(chunk));
    }
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absolute, { bigint: true });
    invariant(
      sameFilesystemIdentity(handleBefore, handleAfter)
        && sameFilesystemIdentity(handleAfter, pathAfter)
        && handleBefore.size === handleAfter.size
        && byteLength === Number(handleAfter.size)
        && handleBefore.mtimeNs === handleAfter.mtimeNs,
      `${label} aenderte sich waehrend des Lesens.`,
    );
    return Object.freeze({
      path: absolute,
      bytes: retainBytes ? Buffer.concat(chunks, byteLength) : undefined,
      byteLength,
      sha256: hash.digest("hex"),
      metadata: handleAfter,
    });
  } finally {
    await handle.close();
  }
}

async function assertArtifactUnchanged(artifact, label, { retainBytes = true } = {}) {
  const current = await stableRegularFile(artifact.path, label, { retainBytes });
  invariant(
    sameFilesystemIdentity(artifact.metadata, current.metadata)
      && artifact.metadata.size === current.metadata.size
      && artifact.metadata.mtimeNs === current.metadata.mtimeNs
      && artifact.byteLength === current.byteLength
      && artifact.sha256 === current.sha256
      && (!retainBytes || artifact.bytes.equals(current.bytes)),
    `${label} wurde nach seiner Qualifikation ausgetauscht oder geaendert.`,
  );
}

function parseJsonArtifact(artifact, label) {
  invariant(Buffer.isBuffer(artifact.bytes), `${label} wurde nicht als begrenztes JSON-Artefakt gelesen.`);
  let value;
  try {
    value = JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} ist kein gueltiges JSON-Artefakt.`);
  }
  return value;
}

function validateGameBackupManifest(value, dump) {
  exactObjectKeys(value, ["schema", "createdAt", "bytes", "sha256", "migrationCount", "rpoSeconds"], "Game-Backup-Manifest");
  invariant(value.schema === GAME_BACKUP_SCHEMA, "Game-Backup-Manifest besitzt ein unbekanntes Schema.");
  const completedAt = canonicalInstant(value.createdAt, "Game-Backup-Manifest.createdAt");
  safeInteger(value.bytes, "Game-Backup-Manifest.bytes", { positive: true });
  safeInteger(value.migrationCount, "Game-Backup-Manifest.migrationCount");
  invariant(value.rpoSeconds === 300, "Game-Backup-Manifest besitzt nicht den freigegebenen RPO-Vertrag.");
  invariant(SHA256.test(value.sha256), "Game-Backup-Manifest besitzt keinen Dump-SHA-256.");
  invariant(value.bytes === dump.byteLength && value.sha256 === dump.sha256, "Game-Backup-Dump stimmt nicht bytegenau mit seinem Manifest ueberein.");
  return Object.freeze({ ...value, completedAt });
}

function validateGameBackupOperation(value, dump, manifestArtifact, manifest) {
  exactObjectKeys(value, [
    "schema",
    "backupId",
    "backupStartedWalLsn",
    "backupCompletedWalLsn",
    "completedAt",
    "dumpSha256",
    "gameBackupManifestSha256",
    "writersQuiesced",
  ], "Game-Backup-Operationsbeleg");
  invariant(value.schema === GAME_BACKUP_OPERATION_SCHEMA, "Game-Backup-Operationsbeleg besitzt ein unbekanntes Schema.");
  invariant(value.backupId === `pgdump-sha256-${dump.sha256}`, "Game-Backup-Operationsbeleg bindet keine aus dem Dump abgeleitete Backup-ID.");
  invariant(value.dumpSha256 === dump.sha256, "Game-Backup-Operationsbeleg bindet einen anderen Dump.");
  invariant(value.gameBackupManifestSha256 === manifestArtifact.sha256, "Game-Backup-Operationsbeleg bindet ein anderes Game-Backup-Manifest.");
  const started = walLsn(value.backupStartedWalLsn, "Game-Backup-Operationsbeleg.backupStartedWalLsn");
  const completed = walLsn(value.backupCompletedWalLsn, "Game-Backup-Operationsbeleg.backupCompletedWalLsn");
  invariant(completed >= started, "Game-Backup-Operationsbeleg besitzt eine rueckwaerts laufende WAL-Spanne.");
  invariant(value.writersQuiesced === true, "Game-Backup-Operationsbeleg wurde nicht bei gestoppten Schreibern erzeugt.");
  const completedAt = canonicalInstant(value.completedAt, "Game-Backup-Operationsbeleg.completedAt");
  invariant(completedAt === manifest.completedAt, "Game-Backup-Operationsbeleg und Manifest binden verschiedene Abschlusszeitpunkte.");
  return Object.freeze({ ...value, completedAt });
}

function databaseName(databaseUrl, label) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${label} ist keine gueltige PostgreSQL-URL.`);
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  invariant(name !== "" && /^[a-z0-9_]+$/u.test(name), `${label} besitzt keinen sicheren Datenbanknamen.`);
  return name;
}

function validateGameRestoreReceipt(value, artifact, dump, manifestArtifact, manifest, restoredDatabaseUrl) {
  exactObjectKeys(value, ["database", "dumpSha256", "identical", "manifestSha256", "migrationCount", "schema"], "Game-Restore-Receipt");
  invariant(value.schema === GAME_RESTORE_SCHEMA, "Game-Restore-Receipt besitzt ein unbekanntes Schema.");
  invariant(value.database === databaseName(restoredDatabaseUrl, "Restore-Datenbankendpunkt"), "Game-Restore-Receipt bindet eine andere Restore-Datenbank.");
  invariant(value.dumpSha256 === dump.sha256, "Game-Restore-Receipt bindet einen anderen Dump.");
  invariant(value.manifestSha256 === manifestArtifact.sha256, "Game-Restore-Receipt bindet ein anderes Game-Backup-Manifest.");
  invariant(value.migrationCount === manifest.migrationCount, "Game-Restore-Receipt bindet einen anderen Migrationsstand.");
  invariant(value.identical === true, "Game-Restore-Receipt meldet keinen erfolgreichen artefaktidentischen Restore.");
  invariant(artifact.bytes.length > 0, "Game-Restore-Receipt ist leer.");
  return value;
}

async function removeIfOwned(claim) {
  let current;
  try {
    current = await lstat(claim.path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (sameFilesystemIdentity(current, claim.identity)) await unlink(claim.path);
}

async function publishCreateNewPair(artifacts, verifyInputs) {
  invariant(artifacts.length === 2, "Das Datenbank-Evidence-Paar ist unvollstaendig.");
  invariant(resolve(artifacts[0].path) !== resolve(artifacts[1].path), "Backup-Manifest und Restore-Beleg duerfen nicht denselben Ausgabepfad verwenden.");
  const claims = [];
  try {
    await verifyInputs();
    for (const artifact of artifacts) {
      const path = resolve(artifact.path);
      const handle = await open(path, "wx", 0o600);
      claims.push({ path, handle, identity: await handle.stat({ bigint: true }), bytes: artifact.bytes, closed: false });
    }
    for (const claim of claims) {
      await claim.handle.writeFile(claim.bytes);
      await claim.handle.sync();
      await claim.handle.close();
      claim.closed = true;
    }
    for (const claim of claims) {
      const installed = await stableRegularFile(claim.path, "Erzeugtes Datenbank-Evidence-Artefakt");
      invariant(sameFilesystemIdentity(claim.identity, installed.metadata), "Datenbank-Evidence-Ausgabepfad wurde beim Schreiben ausgetauscht.");
      invariant(installed.bytes.equals(claim.bytes), "Datenbank-Evidence-Ausgabe weicht von den qualifizierten Bytes ab.");
    }
    await verifyInputs();
  } catch (error) {
    for (const claim of claims) {
      if (!claim.closed) {
        try {
          await claim.handle.close();
        } catch {
          // Der urspruengliche Fehler bleibt massgeblich.
        }
      }
    }
    for (const claim of [...claims].reverse()) {
      try {
        await removeIfOwned(claim);
      } catch {
        // Fremde Ersatzdateien werden nie geloescht; der urspruengliche Fehler bleibt massgeblich.
      }
    }
    throw error;
  }
}

export async function createDatabaseBackupRestoreEvidenceArtifacts({
  environment = process.env,
  postgresFactory,
  inspect = inspectDatabaseRollbackEndpoint,
  now = () => new Date(),
} = {}) {
  invariant(
    environment.DATABASE_ROLLBACK_WRITERS_QUIESCED === "true",
    "DATABASE_ROLLBACK_WRITERS_QUIESCED muss nach nachweislichem Stop aller Writer exakt 'true' sein.",
  );
  const sourceDatabaseUrl = requiredEnvironment(environment, "DATABASE_URL");
  const restoredDatabaseUrl = requiredEnvironment(environment, "DATABASE_ROLLBACK_RESTORED_DATABASE_URL");
  const dumpPath = requiredEnvironment(environment, "DATABASE_ROLLBACK_GAME_BACKUP_DUMP_PATH");
  const gameManifestPath = requiredEnvironment(environment, "DATABASE_ROLLBACK_GAME_BACKUP_MANIFEST_PATH");
  const operationPath = requiredEnvironment(environment, "DATABASE_ROLLBACK_GAME_BACKUP_OPERATION_PATH");
  const gameRestoreReceiptPath = requiredEnvironment(environment, "DATABASE_ROLLBACK_GAME_RESTORE_RECEIPT_PATH");
  const backupManifestOutputPath = requiredEnvironment(environment, "DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH");
  const restoreProofOutputPath = requiredEnvironment(environment, "DATABASE_ROLLBACK_RESTORE_PROOF_PATH");
  const sourceEndpointSha256 = databaseEndpointSha256(sourceDatabaseUrl);
  const restoredEndpointSha256 = databaseEndpointSha256(restoredDatabaseUrl);
  invariant(sourceEndpointSha256 !== restoredEndpointSha256, "Quell- und Restore-Datenbank duerfen nicht denselben PostgreSQL-Endpunkt verwenden.");

  const [dump, gameManifestArtifact, operationArtifact, gameRestoreReceiptArtifact, sourceInspection, restoredInspection] = await Promise.all([
    stableRegularFile(dumpPath, "Game-Backup-Dump", { retainBytes: false }),
    stableRegularFile(gameManifestPath, "Game-Backup-Manifest"),
    stableRegularFile(operationPath, "Game-Backup-Operationsbeleg"),
    stableRegularFile(gameRestoreReceiptPath, "Game-Restore-Receipt"),
    inspect(sourceDatabaseUrl, postgresFactory),
    inspect(restoredDatabaseUrl, postgresFactory),
  ]);
  invariant(sourceInspection.backendSha256 !== restoredInspection.backendSha256, "Quell- und Restore-Datenbank laufen auf derselben PostgreSQL-Backendinstanz.");
  invariant(sameValue(sourceInspection.snapshot, restoredInspection.snapshot), "Der isolierte Restore weicht vom quieszierten Quellzustand ab.");

  const gameManifest = validateGameBackupManifest(parseJsonArtifact(gameManifestArtifact, "Game-Backup-Manifest"), dump);
  const operation = validateGameBackupOperation(
    parseJsonArtifact(operationArtifact, "Game-Backup-Operationsbeleg"),
    dump,
    gameManifestArtifact,
    gameManifest,
  );
  validateGameRestoreReceipt(
    parseJsonArtifact(gameRestoreReceiptArtifact, "Game-Restore-Receipt"),
    gameRestoreReceiptArtifact,
    dump,
    gameManifestArtifact,
    gameManifest,
    restoredDatabaseUrl,
  );
  invariant(gameManifest.migrationCount === EXPECTED_SCHEMA_MIGRATIONS, `Game-Backup-Manifest bindet nicht den Schema-${EXPECTED_SCHEMA_MIGRATIONS}-Stand.`);
  invariant(sourceInspection.snapshot.migrationLedger.length === EXPECTED_SCHEMA_MIGRATIONS, `Quelldatenbank besitzt nicht das Schema-${EXPECTED_SCHEMA_MIGRATIONS}-Migrationsledger.`);
  invariant(restoredInspection.snapshot.migrationLedger.length === EXPECTED_SCHEMA_MIGRATIONS, `Restore-Datenbank besitzt nicht das Schema-${EXPECTED_SCHEMA_MIGRATIONS}-Migrationsledger.`);

  const backupManifest = Object.freeze({
    schema: DATABASE_BACKUP_MANIFEST_SCHEMA,
    backupId: operation.backupId,
    databaseIdentity: sourceInspection.snapshot.databaseIdentity,
    sourceAuthoritativeHeadSha256: sourceInspection.snapshot.authoritativeHead.stateHash,
    sourceEndpointSha256,
    sourceBackendSha256: sourceInspection.backendSha256,
    backupStartedWalLsn: operation.backupStartedWalLsn,
    backupCompletedWalLsn: operation.backupCompletedWalLsn,
    writersQuiesced: true,
    completedAt: operation.completedAt,
  });
  const backupManifestBytes = serializeMapReleaseBuildEvidence(backupManifest);
  const backupManifestSha256 = sha256Bytes(backupManifestBytes);
  const verifiedAt = canonicalInstant(now().toISOString(), "Restore-Verifikationszeitpunkt");
  const restoreProof = Object.freeze({
    schema: DATABASE_RESTORE_PROOF_SCHEMA,
    backupManifestSha256,
    databaseIdentity: sourceInspection.snapshot.databaseIdentity,
    sourceAuthoritativeHeadSha256: sourceInspection.snapshot.authoritativeHead.stateHash,
    restoredAuthoritativeHeadSha256: restoredInspection.snapshot.authoritativeHead.stateHash,
    sourceEndpointSha256,
    restoredEndpointSha256,
    sourceBackendSha256: sourceInspection.backendSha256,
    restoredBackendSha256: restoredInspection.backendSha256,
    verification: "full-database-row-fingerprint",
    verified: true,
    verifiedAt,
  });
  const restoreProofBytes = serializeMapReleaseBuildEvidence(restoreProof);
  const verifyInputs = async () => {
    await Promise.all([
      assertArtifactUnchanged(dump, "Game-Backup-Dump", { retainBytes: false }),
      assertArtifactUnchanged(gameManifestArtifact, "Game-Backup-Manifest"),
      assertArtifactUnchanged(operationArtifact, "Game-Backup-Operationsbeleg"),
      assertArtifactUnchanged(gameRestoreReceiptArtifact, "Game-Restore-Receipt"),
    ]);
  };
  await publishCreateNewPair([
    { path: backupManifestOutputPath, bytes: backupManifestBytes },
    { path: restoreProofOutputPath, bytes: restoreProofBytes },
  ], verifyInputs);
  return Object.freeze({
    backupManifestPath: resolve(backupManifestOutputPath),
    backupManifestSha256,
    restoreProofPath: resolve(restoreProofOutputPath),
    restoreProofSha256: sha256Bytes(restoreProofBytes),
    databaseIdentity: backupManifest.databaseIdentity,
    authoritativeHeadSha256: backupManifest.sourceAuthoritativeHeadSha256,
    backupId: backupManifest.backupId,
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await createDatabaseBackupRestoreEvidenceArtifacts())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}
