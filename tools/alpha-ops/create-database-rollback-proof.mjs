import { createHash } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDatabaseRollbackProof,
  serializeMapReleaseBuildEvidence,
} from "../tiles/map-release-build-evidence.mjs";
import { inspectLiveDatabaseRollbackSnapshot } from "./database-rollback-binding.mjs";

const MAX_JSON_ARTIFACT_BYTES = 4 * 1_024 * 1_024;

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} fehlt.`);
  return value;
}

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

export function databaseBackendIdentitySha256({ systemIdentifier, serverAddress, serverPort }) {
  if (
    typeof systemIdentifier !== "string"
      || systemIdentifier === ""
      || typeof serverAddress !== "string"
      || serverAddress === ""
      || !Number.isSafeInteger(Number(serverPort))
  ) {
    throw new Error("PostgreSQL-Backendinstanz besitzt keine dauerhaft hashbare Clusteridentitaet.");
  }
  return canonicalSha256({
    serverAddress,
    serverPort: Number(serverPort),
    systemIdentifier,
  });
}

export function databaseEndpointSha256(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("PostgreSQL-Endpunkt ist keine gueltige URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("PostgreSQL-Endpunkt verwendet kein postgres/postgresql-Schema.");
  }
  const endpoint = {
    protocol: "postgresql:",
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port === "" ? "5432" : parsed.port,
    database: decodeURIComponent(parsed.pathname.replace(/^\//u, "")),
    socketHost: parsed.searchParams.get("host") ?? null,
  };
  return canonicalSha256(endpoint);
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function stableRegularFile(path, label) {
  const absolute = resolve(path);
  const pathBefore = await lstat(absolute, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size <= 0n) {
    throw new Error(`${label} ist keine regulaere, nichtleere Datei.`);
  }
  if (pathBefore.size > BigInt(MAX_JSON_ARTIFACT_BYTES)) {
    throw new Error(`${label} ueberschreitet das JSON-Artefaktlimit.`);
  }
  const handle = await open(absolute, "r");
  let bytes;
  let metadata;
  try {
    const handleBefore = await handle.stat({ bigint: true });
    if (!handleBefore.isFile() || !sameFilesystemIdentity(pathBefore, handleBefore)) {
      throw new Error(`${label} wurde beim Oeffnen ausgetauscht.`);
    }
    bytes = await handle.readFile();
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absolute, { bigint: true });
    if (
      !sameFilesystemIdentity(handleBefore, handleAfter)
      || !sameFilesystemIdentity(handleAfter, pathAfter)
      || handleBefore.size !== handleAfter.size
      || BigInt(bytes.length) !== handleAfter.size
      || handleBefore.mtimeNs !== handleAfter.mtimeNs
    ) {
      throw new Error(`${label} aenderte sich waehrend der Hashbildung.`);
    }
    metadata = handleAfter;
  } finally {
    await handle.close();
  }
  return Object.freeze({
    path: absolute,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    metadata,
  });
}

async function regularCanonicalJson(path, label) {
  const artifact = await stableRegularFile(path, label);
  const { bytes } = artifact;
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} ist kein gueltiges JSON-Artefakt.`);
  }
  if (!bytes.equals(serializeMapReleaseBuildEvidence(value))) {
    throw new Error(`${label} ist nicht kanonisch serialisiert.`);
  }
  return Object.freeze({
    ...artifact,
    value,
  });
}

async function assertArtifactUnchanged(artifact, label) {
  const current = await regularCanonicalJson(artifact.path, label);
  if (
    !sameFilesystemIdentity(artifact.metadata, current.metadata)
    || artifact.metadata.size !== current.metadata.size
    || artifact.metadata.mtimeNs !== current.metadata.mtimeNs
    || artifact.sha256 !== current.sha256
    || !artifact.bytes.equals(current.bytes)
  ) {
    throw new Error(`${label} wurde nach seiner Qualifikation ausgetauscht oder geaendert.`);
  }
}

export async function inspectDatabaseRollbackEndpoint(databaseUrl, postgresFactory) {
  let factory = postgresFactory;
  if (factory === undefined) {
    const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
    const postgresModule = requireFromDb("postgres");
    factory = postgresModule.default ?? postgresModule;
  }
  const client = factory(databaseUrl, { max: 1 });
  try {
    return await client.begin("isolation level serializable read only deferrable", async (sql) => {
      const backendRows = await sql.unsafe(`
        select
          control.system_identifier::text as system_identifier,
          coalesce(inet_server_addr()::text, 'unix-socket') as server_address,
          inet_server_port()::int as server_port
        from pg_control_system() as control
      `);
      if (!Array.isArray(backendRows) || backendRows.length !== 1) {
        throw new Error("PostgreSQL-Backendinstanz konnte nicht eindeutig identifiziert werden.");
      }
      const backend = backendRows[0];
      if (
        typeof backend.system_identifier !== "string"
          || typeof backend.server_address !== "string"
          || !Number.isSafeInteger(Number(backend.server_port))
      ) {
        throw new Error("PostgreSQL-Backendinstanz besitzt keine unveraenderlich hashbare Identitaet.");
      }
      return Object.freeze({
        snapshot: await inspectLiveDatabaseRollbackSnapshot(sql),
        backendSha256: databaseBackendIdentitySha256({
          systemIdentifier: backend.system_identifier,
          serverAddress: backend.server_address,
          serverPort: Number(backend.server_port),
        }),
      });
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function removeIfOwned(path, identity) {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (sameFilesystemIdentity(current, identity)) await unlink(path);
}

async function writeCreateNew(path, bytes, verifyInputs) {
  const absolute = resolve(path);
  const handle = await open(absolute, "wx", 0o600);
  const identity = await handle.stat({ bigint: true });
  let closed = false;
  try {
    await verifyInputs();
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    closed = true;
    const installed = await stableRegularFile(absolute, "Erzeugter Datenbank-Rollbackbeleg");
    if (!sameFilesystemIdentity(identity, installed.metadata) || !installed.bytes.equals(bytes)) {
      throw new Error("Datenbank-Rollbackbeleg wurde beim Publizieren ausgetauscht oder geaendert.");
    }
    await verifyInputs();
  } catch (error) {
    if (!closed) {
      try {
        await handle.close();
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
    }
    try {
      await removeIfOwned(absolute, identity);
    } catch {
      // Eine fremde Ersatzdatei wird niemals geloescht.
    }
    throw error;
  }
}

export async function createDatabaseRollbackProofArtifact({
  environment = process.env,
  postgresFactory,
  inspect = inspectDatabaseRollbackEndpoint,
} = {}) {
  if (environment.DATABASE_ROLLBACK_WRITERS_QUIESCED !== "true") {
    throw new Error("DATABASE_ROLLBACK_WRITERS_QUIESCED muss nach nachweislichem Stop aller Writer exakt 'true' sein.");
  }
  const sourceDatabaseUrl = requiredEnvironment(environment, "DATABASE_URL");
  const restoredDatabaseUrl = requiredEnvironment(environment, "DATABASE_ROLLBACK_RESTORED_DATABASE_URL");
  const releaseId = requiredEnvironment(environment, "DATABASE_ROLLBACK_RELEASE_ID");
  const previousReleaseId = requiredEnvironment(environment, "DATABASE_ROLLBACK_PREVIOUS_RELEASE_ID");
  const backupManifestPath = requiredEnvironment(environment, "DATABASE_ROLLBACK_BACKUP_MANIFEST_PATH");
  const restoreProofPath = requiredEnvironment(environment, "DATABASE_ROLLBACK_RESTORE_PROOF_PATH");
  const outputPath = requiredEnvironment(environment, "DATABASE_ROLLBACK_PROOF_OUTPUT_PATH");
  const sourceEndpointSha256 = databaseEndpointSha256(sourceDatabaseUrl);
  const restoredEndpointSha256 = databaseEndpointSha256(restoredDatabaseUrl);
  if (sourceEndpointSha256 === restoredEndpointSha256) {
    throw new Error("Quell- und Restore-Datenbank duerfen nicht denselben PostgreSQL-Endpunkt verwenden.");
  }

  let factory = postgresFactory;
  if (factory === undefined) {
    const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
    const postgresModule = requireFromDb("postgres");
    factory = postgresModule.default ?? postgresModule;
  }
  const [sourceInspection, restoredInspection, backupManifestArtifact, restoreProofArtifact] = await Promise.all([
    inspect(sourceDatabaseUrl, factory),
    inspect(restoredDatabaseUrl, factory),
    regularCanonicalJson(backupManifestPath, "Backup-Manifest"),
    regularCanonicalJson(restoreProofPath, "Restore-Beleg"),
  ]);
  if (sourceInspection.backendSha256 === restoredInspection.backendSha256) {
    throw new Error("Quell- und Restore-Datenbank laufen auf derselben PostgreSQL-Backendinstanz.");
  }
  const restoreSeparation = Object.freeze({
    schema: "zugfolge-database-restore-separation/v1",
    sourceEndpointSha256,
    restoredEndpointSha256,
    sourceBackendSha256: sourceInspection.backendSha256,
    restoredBackendSha256: restoredInspection.backendSha256,
  });
  const proof = createDatabaseRollbackProof({
    releaseId,
    previousReleaseId,
    source: sourceInspection.snapshot,
    restored: restoredInspection.snapshot,
    restoreSeparation,
    backupManifest: backupManifestArtifact.value,
    backupManifestSha256: backupManifestArtifact.sha256,
    restoreProof: restoreProofArtifact.value,
    restoreProofSha256: restoreProofArtifact.sha256,
    writersQuiesced: true,
    rollbackWindow: "pre-activation-only",
  });
  const bytes = serializeMapReleaseBuildEvidence(proof);
  const verifyInputs = async () => {
    await Promise.all([
      assertArtifactUnchanged(backupManifestArtifact, "Backup-Manifest"),
      assertArtifactUnchanged(restoreProofArtifact, "Restore-Beleg"),
    ]);
  };
  await writeCreateNew(outputPath, bytes, verifyInputs);
  return Object.freeze({
    outputPath: resolve(outputPath),
    databaseIdentity: proof.source.databaseIdentity,
    authoritativeHeadSha256: proof.source.authoritativeHead.stateHash,
    proofHash: proof.proofHash,
    bytes: bytes.length,
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await createDatabaseRollbackProofArtifact())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}
