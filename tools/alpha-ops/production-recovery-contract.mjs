import { execFile as execFileCallback } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify as verifyEd25519 } from "node:crypto";
import { constants as fileConstants, createReadStream } from "node:fs";
import { request as httpRequest } from "node:http";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  parseCanonicalDatabaseRollbackProof,
  serializeMapReleaseBuildEvidence,
} from "../tiles/map-release-build-evidence.mjs";
import {
  databaseBackendIdentitySha256,
  inspectDatabaseRollbackEndpoint,
} from "./create-database-rollback-proof.mjs";
import { inspectLiveDatabaseRollbackSnapshot } from "./database-rollback-binding.mjs";

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/u;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]*-20[0-9]{2}\.[1-9][0-9]*$/u;
const RECOVERY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const PG_LSN = /^[A-F0-9]+\/[A-F0-9]{1,8}$/u;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;
const MAX_JSON_BYTES = 4 * 1_024 * 1_024;
const QUIESCENCE_SCHEMA = "zugfolge-production-recovery-quiescence/v1";
const RECOVERY_SCHEMA = "zugfolge-production-recovery/v1";
const PROMOTION_SCHEMA = "zugfolge-production-recovery-promotion/v1";
const RECOVERY_ACTION_SCHEMA = "zugfolge-production-recovery-action/v1";
const RECOVERY_ACTIVATION_INTENT_SCHEMA = "zugfolge-production-recovery-activation-intent/v1";
const RECOVERY_CONTINUITY_ACTION_SCHEMA = "zugfolge-production-recovery-continuity-action/v1";
const RECOVERY_CONTINUITY_INTENT_SCHEMA = "zugfolge-production-recovery-continuity-intent/v1";
const RECOVERY_SOURCE_ACTION_SCHEMA = "zugfolge-production-recovery-source-action/v2";
const RECOVERY_SOURCE_INTENT_SCHEMA = "zugfolge-production-recovery-source-intent/v2";
const GAME_RESTORE_SCHEMA = "zugfolge-production-game-restore/v1";
const ODOO_RESTORE_SCHEMA = "zugfolge-production-odoo-restore/v1";
const REQUIRED_DATABASE_SERVICES = Object.freeze(["odoo-postgres", "postgres"]);
const RECOVERY_ACTIONS = Object.freeze(["activate", "continue", "preflight", "prepared", "reseal"]);
const STATIC_RECOVERY_RECEIPT_ACTIONS = Object.freeze(["activate", "preflight", "prepared"]);
const TRANSITION_SEQUENCE_WIDTH = 6;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} besitzt unbekannte oder fehlende Felder.`,
  );
}

function canonicalInstant(value, label) {
  invariant(typeof value === "string" && Number.isFinite(Date.parse(value)), `${label} ist kein UTC-Zeitpunkt.`);
  invariant(new Date(value).toISOString() === value, `${label} ist nicht kanonisch serialisiert.`);
  return value;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pgLsnValue(value, label) {
  invariant(typeof value === "string" && PG_LSN.test(value), `${label} ist keine kanonische PostgreSQL-WAL-LSN.`);
  const [high, low] = value.split("/");
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
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

function canonicalValueSha256(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(sortedValue(value)), "utf8"));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalHashWithout(value, omittedKey) {
  const { [omittedKey]: ignored, ...payload } = value;
  void ignored;
  return sha256Bytes(serializeMapReleaseBuildEvidence(payload));
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value;
}

function requiredRecoveryId(value) {
  invariant(RECOVERY_ID.test(value), "Recovery-ID ist nicht kanonisch oder nicht pfadsicher.");
  return value;
}

function requiredReleasePair(candidateReleaseId, previousReleaseId) {
  invariant(RELEASE_ID.test(candidateReleaseId), "Kandidatenrelease-ID ist ungueltig.");
  invariant(RELEASE_ID.test(previousReleaseId), "Vorgaengerrelease-ID ist ungueltig.");
  invariant(candidateReleaseId !== previousReleaseId, "Recovery braucht verschiedene Kandidaten- und Vorgaengerrelease-IDs.");
}

function requiredDatabaseName(value, label, prefix) {
  invariant(DATABASE_NAME.test(value), `${label} ist kein sicherer PostgreSQL-Datenbankname.`);
  if (prefix !== undefined) invariant(value.startsWith(prefix), `${label} besitzt nicht das feste Recovery-Praefix '${prefix}'.`);
  return value;
}

export function databaseEndpointSha256(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("PostgreSQL-Endpunkt ist keine gueltige URL.");
  }
  invariant(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:", "PostgreSQL-Endpunkt verwendet kein PostgreSQL-Schema.");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  invariant(database !== "", "PostgreSQL-Endpunkt besitzt keinen Datenbanknamen.");
  return canonicalValueSha256({
    database,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port === "" ? "5432" : parsed.port,
    protocol: "postgresql:",
    socketHost: parsed.searchParams.get("host") ?? null,
  });
}

function databaseNameFromUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
}

async function stableRegularFile(path, label, { retainBytes = true, maxBytes } = {}) {
  const absolute = resolve(path);
  const pathBefore = await lstat(absolute, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n, `${label} ist keine regulaere, nichtleere Datei.`);
  if (maxBytes !== undefined) invariant(pathBefore.size <= BigInt(maxBytes), `${label} ueberschreitet das Dateilimit.`);
  const handle = await open(absolute, "r");
  let metadata;
  let bytes;
  let sha256;
  try {
    const handleBefore = await handle.stat({ bigint: true });
    invariant(sameIdentity(pathBefore, handleBefore), `${label} wurde beim Oeffnen ausgetauscht.`);
    if (retainBytes) {
      bytes = await handle.readFile();
      sha256 = sha256Bytes(bytes);
    } else {
      const hash = createHash("sha256");
      const stream = createReadStream(absolute, { fd: handle.fd, autoClose: false, start: 0 });
      for await (const chunk of stream) hash.update(chunk);
      sha256 = hash.digest("hex");
    }
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absolute, { bigint: true });
    invariant(
      sameIdentity(handleBefore, handleAfter)
        && sameIdentity(handleAfter, pathAfter)
        && handleBefore.size === handleAfter.size
        && handleBefore.mtimeNs === handleAfter.mtimeNs
        && (!retainBytes || BigInt(bytes.length) === handleAfter.size),
      `${label} aenderte sich waehrend der Qualifikation.`,
    );
    metadata = handleAfter;
  } finally {
    await handle.close();
  }
  return Object.freeze({ path: absolute, bytes, sha256, metadata });
}

async function stableJsonFile(path, label, { canonical = true } = {}) {
  const artifact = await stableRegularFile(path, label, { maxBytes: MAX_JSON_BYTES });
  let value;
  try {
    value = JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} ist kein gueltiges JSON-Artefakt.`);
  }
  if (canonical) {
    invariant(artifact.bytes.equals(serializeMapReleaseBuildEvidence(value)), `${label} ist nicht kanonisch serialisiert.`);
  }
  return Object.freeze({ ...artifact, value });
}

function validateRuntimeRollbackBinding(value, label = "Runtime-Rollback-Bindung") {
  exactKeys(value, [
    "attestationHash",
    "attestationKeyId",
    "attestationSha256",
    "databaseRollbackProofHash",
    "databaseRollbackProofSha256",
    "imageDigest",
    "odooImageDigest",
    "sourceCommit",
    "trustedKeysSha256",
    "worldDeploymentHash",
    "worldDeploymentSha256",
  ], label);
  invariant(GIT_COMMIT.test(value.sourceCommit) && !/^0+$/u.test(value.sourceCommit), `${label} besitzt keinen unveraenderlichen Source-Commit.`);
  invariant(OCI_DIGEST.test(value.imageDigest), `${label} besitzt keinen unveraenderlichen Legacy-Image-Digest.`);
  invariant(OCI_DIGEST.test(value.odooImageDigest), `${label} besitzt keinen unveraenderlichen Legacy-Odoo-Image-Digest.`);
  invariant(/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(value.attestationKeyId), `${label} besitzt keine sichere Attestation-Key-ID.`);
  for (const hash of [
    value.attestationHash,
    value.attestationSha256,
    value.databaseRollbackProofHash,
    value.databaseRollbackProofSha256,
    value.trustedKeysSha256,
    value.worldDeploymentHash,
    value.worldDeploymentSha256,
  ]) invariant(SHA256.test(hash), `${label} besitzt eine ungueltige SHA-256-Bindung.`);
  return value;
}

function canonicalRuntimeRollbackAttestationHash(attestation) {
  const { attestationHash: ignoredHash, signature: ignoredSignature, ...payload } = attestation;
  void ignoredHash;
  void ignoredSignature;
  return sha256Bytes(serializeMapReleaseBuildEvidence(payload));
}

function trustedRuntimeRollbackPublicKey(keyring, keyId) {
  invariant(keyring !== null && typeof keyring === "object" && !Array.isArray(keyring), "Runtime-Rollback-Keyring ist kein Objekt.");
  const keyIds = Object.keys(keyring);
  invariant(keyIds.length > 0, "Runtime-Rollback-Keyring ist leer.");
  for (const candidateKeyId of keyIds) {
    invariant(/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(candidateKeyId), "Runtime-Rollback-Keyring besitzt eine unsichere Key-ID.");
    invariant(typeof keyring[candidateKeyId] === "string", `Runtime-Rollback-Key '${candidateKeyId}' ist kein PEM.`);
    let candidate;
    try {
      candidate = createPublicKey(keyring[candidateKeyId]);
    } catch {
      throw new Error(`Runtime-Rollback-Key '${candidateKeyId}' ist kein gueltiger Public Key.`);
    }
    invariant(candidate.type === "public" && candidate.asymmetricKeyType === "ed25519", `Runtime-Rollback-Key '${candidateKeyId}' ist kein Ed25519-Public-Key.`);
    invariant(candidate.export({ type: "spki", format: "pem" }) === keyring[candidateKeyId], `Runtime-Rollback-Key '${candidateKeyId}' ist nicht kanonisch als SPKI-PEM serialisiert.`);
  }
  invariant(typeof keyring[keyId] === "string", `Runtime-Rollback-Attestation-Key '${keyId}' ist nicht vertrauenswuerdig.`);
  return createPublicKey(keyring[keyId]);
}

async function loadRuntimeRollbackEvidence({ environment, candidateReleaseId, previousReleaseId, expectedDatabaseRollbackArtifact }) {
  const sourceCommit = requiredEnvironment(environment, "PRODUCTION_RECOVERY_LEGACY_GAME_SOURCE_COMMIT");
  const imageDigest = requiredEnvironment(environment, "PRODUCTION_RECOVERY_LEGACY_GAME_IMAGE_DIGEST");
  const odooImageDigest = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST");
  const previousWorldId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID");
  invariant(GIT_COMMIT.test(sourceCommit) && !/^0+$/u.test(sourceCommit), "Erwarteter Legacy-Game-Source-Commit ist nicht unveraenderlich.");
  invariant(OCI_DIGEST.test(imageDigest), "Erwarteter Legacy-Game-Image-Digest ist nicht unveraenderlich.");
  invariant(OCI_DIGEST.test(odooImageDigest), "Erwarteter Legacy-Odoo-Image-Digest ist nicht unveraenderlich.");
  invariant(UUID.test(previousWorldId), "Erwartete Legacy-Welt-ID ist keine kanonische UUID.");
  const [attestationArtifact, trustedKeysArtifact, worldDeploymentArtifact, databaseRollbackArtifact] = await Promise.all([
    stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_RUNTIME_ROLLBACK_ATTESTATION_PATH"), "Signierte Runtime-Rollback-Attestation"),
    stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_RUNTIME_ROLLBACK_TRUSTED_KEYS_PATH"), "Runtime-Rollback-Keyring", { canonical: false }),
    stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ATTESTED_WORLD_DEPLOYMENT_PATH"), "Attestiertes World-Deployment", { canonical: false }),
    stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_DATABASE_ROLLBACK_PROOF_PATH"), "Attestierter Datenbank-Rollback-Proof"),
  ]);
  const attestation = attestationArtifact.value;
  exactKeys(attestation, [
    "approvalGate",
    "attestationHash",
    "deliveryManifest",
    "packageManifest",
    "previousReleaseId",
    "runtimeTuple",
    "schema",
    "signature",
  ], "Signierte Runtime-Rollback-Attestation");
  invariant(attestation.schema === "zugfolge-map-rollback-attestation/v3" && attestation.previousReleaseId === previousReleaseId, "Runtime-Rollback-Attestation gehoert nicht zum belegten Vorgaengerrelease.");
  exactKeys(attestation.approvalGate, ["algorithm", "keyId", "status"], "Runtime-Rollback-Attestation-Approval");
  exactKeys(attestation.signature, ["algorithm", "keyId", "valueBase64"], "Runtime-Rollback-Attestation-Signatur");
  invariant(attestation.approvalGate.status === "passed" && attestation.approvalGate.algorithm === "Ed25519", "Runtime-Rollback-Attestation besitzt keine signierte Freigabe.");
  invariant(attestation.signature.algorithm === "Ed25519" && attestation.signature.keyId === attestation.approvalGate.keyId, "Runtime-Rollback-Attestation besitzt keine konsistente Signaturhuelle.");
  const attestationHash = canonicalRuntimeRollbackAttestationHash(attestation);
  invariant(attestation.attestationHash === attestationHash, "Runtime-Rollback-Attestation besitzt keinen gueltigen kanonischen Hash.");
  const publicKey = trustedRuntimeRollbackPublicKey(trustedKeysArtifact.value, attestation.signature.keyId);
  const signatureBytes = Buffer.from(attestation.signature.valueBase64, "base64");
  invariant(signatureBytes.length === 64 && signatureBytes.toString("base64") === attestation.signature.valueBase64, "Runtime-Rollback-Attestation besitzt keine kanonischen Signaturbytes.");
  invariant(verifyEd25519(null, Buffer.from(attestationHash, "hex"), publicKey, signatureBytes), "Runtime-Rollback-Attestation besitzt keine gueltige vertrauenswuerdige Ed25519-Signatur.");
  const runtimeTuple = attestation.runtimeTuple;
  invariant(runtimeTuple?.schema === "zugfolge-runtime-rollback-tuple/v3" && runtimeTuple.mapReleaseId === previousReleaseId, "Runtime-Rollback-Attestation besitzt kein V3-Runtime-Tuple fuer den Vorgaenger.");
  invariant(runtimeTuple.sourceCommit === sourceCommit && runtimeTuple.imageDigest === imageDigest, "Runtime-Rollback-Attestation bindet nicht den explizit erwarteten Legacy-Source-/Image-Stand.");
  invariant(runtimeTuple.odooImageDigest === odooImageDigest && runtimeTuple.odooImageDigest !== runtimeTuple.imageDigest, "Runtime-Rollback-Attestation bindet nicht den explizit erwarteten separaten Legacy-Odoo-Image-Digest.");
  const world = runtimeTuple.worldDeployment;
  invariant(
    Number.isSafeInteger(world?.bytes)
      && world.bytes === Number(worldDeploymentArtifact.metadata.size)
      && world.sha256 === worldDeploymentArtifact.sha256
      && SHA256.test(world.deploymentHash)
      && worldDeploymentArtifact.value?.deploymentHash === world.deploymentHash,
    "Runtime-Rollback-Attestation bindet nicht die bereitgestellten World-Deployment-Bytes.",
  );
  invariant(
    worldDeploymentArtifact.value?.worldId === previousWorldId
      && world.worldId === previousWorldId,
    "Runtime-Rollback-Attestation und World-Deployment binden nicht die explizit erwartete Legacy-Welt-ID.",
  );
  const parsedDatabaseRollback = parseCanonicalDatabaseRollbackProof(databaseRollbackArtifact.bytes, { releaseId: candidateReleaseId, previousReleaseId });
  const databaseBinding = runtimeTuple.databaseRollback;
  invariant(
    databaseBinding?.schema === parsedDatabaseRollback.proof.schema
      && databaseBinding.bytes === Number(databaseRollbackArtifact.metadata.size)
      && databaseBinding.sha256 === databaseRollbackArtifact.sha256
      && databaseBinding.proofHash === parsedDatabaseRollback.proof.proofHash
      && databaseBinding.releaseId === candidateReleaseId
      && databaseBinding.previousReleaseId === previousReleaseId,
    "Runtime-Rollback-Attestation bindet nicht den bereitgestellten Datenbank-Rollback-Proof.",
  );
  if (expectedDatabaseRollbackArtifact !== undefined) {
    invariant(
      sameIdentity(databaseRollbackArtifact.metadata, expectedDatabaseRollbackArtifact.metadata)
        && databaseRollbackArtifact.sha256 === expectedDatabaseRollbackArtifact.sha256
        && databaseRollbackArtifact.bytes.equals(expectedDatabaseRollbackArtifact.bytes),
      "Recovery und Runtime-Rollback-Attestation verwenden nicht dieselben Datenbank-Rollback-Proof-Bytes.",
    );
  }
  const binding = Object.freeze(validateRuntimeRollbackBinding({
    attestationHash,
    attestationKeyId: attestation.signature.keyId,
    attestationSha256: attestationArtifact.sha256,
    databaseRollbackProofHash: parsedDatabaseRollback.proof.proofHash,
    databaseRollbackProofSha256: databaseRollbackArtifact.sha256,
    imageDigest,
    odooImageDigest,
    sourceCommit,
    trustedKeysSha256: trustedKeysArtifact.sha256,
    worldDeploymentHash: world.deploymentHash,
    worldDeploymentSha256: worldDeploymentArtifact.sha256,
  }));
  return Object.freeze({
    artifacts: Object.freeze([attestationArtifact, trustedKeysArtifact, worldDeploymentArtifact, databaseRollbackArtifact]),
    binding,
    databaseRollbackProof: parsedDatabaseRollback.proof,
    worldDeployment: Object.freeze({ ...worldDeploymentArtifact.value }),
  });
}

async function assertArtifactUnchanged(artifact, label, { retainBytes = artifact.bytes !== undefined } = {}) {
  const current = await stableRegularFile(artifact.path, label, {
    retainBytes,
    maxBytes: retainBytes ? MAX_JSON_BYTES : undefined,
  });
  invariant(
    sameIdentity(artifact.metadata, current.metadata)
      && artifact.metadata.size === current.metadata.size
      && artifact.metadata.mtimeNs === current.metadata.mtimeNs
      && artifact.sha256 === current.sha256
      && (!retainBytes || artifact.bytes.equals(current.bytes)),
    `${label} wurde nach seiner Qualifikation ausgetauscht oder geaendert.`,
  );
}

async function removeIfOwned(path, identity) {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (sameIdentity(current, identity)) await unlink(path);
}

async function assertCreateNewPathAvailable(path, label) {
  const absolute = resolve(path);
  try {
    await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return absolute;
    throw error;
  }
  throw new Error(`${label} existiert bereits; Recovery-Ausgaben sind create-new.`);
}

async function optionalStableJsonFile(path, label) {
  try {
    return await stableJsonFile(path, label);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function containedCreateNewOutput(rootPath, outputPath, label) {
  const root = await realpath(rootPath);
  const rootStatus = await lstat(root, { bigint: true });
  invariant(rootStatus.isDirectory() && !rootStatus.isSymbolicLink(), "Production-Recovery-Evidence-Wurzel ist kein regulaeres Verzeichnis.");
  invariant(root !== resolve(root, sep) && root !== resolve(sep), "Production-Recovery-Evidence-Wurzel ist zu breit.");
  const absolute = resolve(outputPath);
  const outputParent = await realpath(dirname(absolute));
  invariant(outputParent === root, `${label} muss direkt in der festen Evidence-Wurzel liegen.`);
  invariant(/^[a-z0-9][a-z0-9._-]*\.json$/u.test(basename(absolute)), `${label} besitzt keinen sicheren JSON-Dateinamen.`);
  return absolute;
}

async function containedEvidenceArtifact(rootPath, artifactPath, label) {
  const root = await realpath(rootPath);
  const rootStatus = await lstat(root, { bigint: true });
  invariant(rootStatus.isDirectory() && !rootStatus.isSymbolicLink(), "Production-Recovery-Evidence-Wurzel ist kein regulaeres Verzeichnis.");
  invariant(root !== resolve(root, sep) && root !== resolve(sep), "Production-Recovery-Evidence-Wurzel ist zu breit.");
  const absolute = resolve(artifactPath);
  const artifactParent = await realpath(dirname(absolute));
  invariant(artifactParent === root, `${label} muss direkt in der festen Evidence-Wurzel liegen.`);
  invariant(/^[a-z0-9][a-z0-9._-]*\.json$/u.test(basename(absolute)), `${label} besitzt keinen sicheren JSON-Dateinamen.`);
  return absolute;
}

function transitionSequence(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value < 1_000_000, `${label} ist keine sichere monotone Sequenz.`);
  return value;
}

function transitionSequenceText(value) {
  return String(transitionSequence(value, "Transition.sequence")).padStart(TRANSITION_SEQUENCE_WIDTH, "0");
}

function transitionBinding(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  exactKeys(value, ["actionReceiptHash", "sequence", "sha256"], label);
  transitionSequence(value.sequence, `${label}.sequence`);
  invariant(SHA256.test(value.actionReceiptHash) && SHA256.test(value.sha256), `${label} bindet den Vorgaenger nicht bytegenau.`);
  return value;
}

function intentBinding(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  exactKeys(value, ["intentHash", "sha256"], label);
  invariant(SHA256.test(value.intentHash) && SHA256.test(value.sha256), `${label} bindet den Intent nicht bytegenau.`);
  return value;
}

function transitionArtifactPath(evidenceRoot, recoveryId, namespace, sequence, action, kind) {
  invariant(namespace === "continuity" || namespace === "source-transition", "Recovery-Transition besitzt einen unbekannten Namespace.");
  invariant(["origin", "continue", "reseal", "release"].includes(action), "Recovery-Transition besitzt eine unbekannte Aktion.");
  invariant(kind === "intent" || kind === "receipt", "Recovery-Transition besitzt eine unbekannte Artefaktart.");
  return join(evidenceRoot, `${recoveryId}.${namespace}-${transitionSequenceText(sequence)}-${action}.${kind}.json`);
}

function transitionArtifactPattern(recoveryId, namespace) {
  const escapedRecoveryId = recoveryId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedNamespace = namespace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escapedRecoveryId}\\.${escapedNamespace}-([0-9]{${TRANSITION_SEQUENCE_WIDTH}})-(origin|continue|reseal|release)\\.(intent|receipt)\\.json$`, "u");
}

async function loadTransitionChain({
  actions,
  evidenceRoot,
  firstAction,
  firstSequence,
  namespace,
  recoveryId,
  validateIntent,
  validateReceipt,
}) {
  const root = await realpath(evidenceRoot);
  const pattern = transitionArtifactPattern(recoveryId, namespace);
  const parsed = [];
  for (const name of await readdir(root)) {
    const match = pattern.exec(name);
    if (match === null) continue;
    const sequence = Number(match[1]);
    const action = match[2];
    const kind = match[3];
    invariant(actions.includes(action), `Recovery-Transition '${name}' besitzt eine fuer diesen Vertrag fremde Aktion.`);
    const artifact = await stableJsonFile(join(root, name), `Recovery-Transition '${name}'`);
    const value = kind === "intent" ? validateIntent(artifact.value) : validateReceipt(artifact.value);
    invariant(value.recoveryId === recoveryId && value.sequence === sequence && value.action === action, `Recovery-Transition '${name}' widerspricht ihrem Dateinamen.`);
    parsed.push(Object.freeze({ action, artifact, kind, sequence, value }));
  }
  const receipts = parsed.filter(({ kind }) => kind === "receipt").sort((left, right) => left.sequence - right.sequence);
  const intents = parsed.filter(({ kind }) => kind === "intent").sort((left, right) => left.sequence - right.sequence);
  invariant(new Set(receipts.map(({ sequence }) => sequence)).size === receipts.length, "Recovery-Transition besitzt einen Receipt-Fork.");
  invariant(new Set(intents.map(({ sequence }) => sequence)).size === intents.length, "Recovery-Transition besitzt einen Intent-Fork.");
  for (let index = 0; index < receipts.length; index += 1) {
    const current = receipts[index];
    const expectedSequence = firstSequence + index;
    invariant(current.sequence === expectedSequence, "Recovery-Transition besitzt eine Sequenzluecke oder einen rueckwaertigen Receipt-Fork.");
    if (index === 0) {
      invariant(current.action === firstAction && current.value.previous === null, "Recovery-Transition besitzt keinen kanonischen Ursprung.");
    } else {
      const previous = receipts[index - 1];
      invariant(current.action !== previous.action, "Recovery-Transition wiederholt eine erreichte Aktion als neue Sequenz.");
      invariant(
        current.value.previous.sequence === previous.sequence
          && current.value.previous.actionReceiptHash === previous.value.actionReceiptHash
          && current.value.previous.sha256 === previous.artifact.sha256,
        "Recovery-Transition bindet nicht bytegenau ihren unmittelbaren Vorgaenger.",
      );
    }
    if (current.action === firstAction && current.sequence === firstSequence && namespace === "continuity") {
      invariant(current.value.intent === null, "Recovery-Continuity-Ursprung darf keinen Transition-Intent vortaeuschen.");
    } else {
      const matchingIntent = intents.find(({ sequence }) => sequence === current.sequence);
      invariant(matchingIntent !== undefined && matchingIntent.action === current.action, "Recovery-Transition-Receipt besitzt keinen eindeutigen gleichsequenzierten Intent.");
      invariant(
        current.value.intent.intentHash === matchingIntent.value.intentHash
          && current.value.intent.sha256 === matchingIntent.artifact.sha256,
        "Recovery-Transition-Receipt bindet andere Intent-Bytes.",
      );
      invariant(
        sameValue(matchingIntent.value.previous, current.value.previous),
        "Recovery-Transition-Intent bindet einen anderen Vorgaenger als sein Receipt.",
      );
    }
  }
  const maximumReceiptSequence = receipts.at(-1)?.sequence ?? (firstSequence - 1);
  const pendingIntents = intents.filter(({ sequence }) => sequence > maximumReceiptSequence);
  invariant(pendingIntents.length <= 1, "Recovery-Transition besitzt mehr als einen unabgeschlossenen Intent.");
  if (pendingIntents.length === 1) {
    invariant(pendingIntents[0].sequence === maximumReceiptSequence + 1, "Recovery-Transition-Intent liegt nicht unmittelbar hinter dem Receipt-Kopf.");
    const previous = receipts.at(-1);
    if (previous === undefined) {
      invariant(
        namespace === "source-transition"
          && pendingIntents[0].sequence === firstSequence
          && pendingIntents[0].action === firstAction
          && pendingIntents[0].value.previous === null,
        "Recovery-Transition darf nicht mit einem ursprungslosen Intent beginnen.",
      );
    } else {
      invariant(
        pendingIntents[0].value.previous.sequence === previous.sequence
          && pendingIntents[0].value.previous.actionReceiptHash === previous.value.actionReceiptHash
          && pendingIntents[0].value.previous.sha256 === previous.artifact.sha256,
        "Recovery-Transition-Intent bindet nicht bytegenau den Receipt-Kopf.",
      );
    }
  }
  invariant(
    intents.every(({ sequence }) => sequence <= maximumReceiptSequence || pendingIntents.some((pending) => pending.sequence === sequence)),
    "Recovery-Transition besitzt einen verwaisten Intent-Fork.",
  );
  return Object.freeze({ intents: Object.freeze(intents), pendingIntent: pendingIntents[0], receipts: Object.freeze(receipts) });
}

function requiredRecoveryAction(value) {
  invariant(RECOVERY_ACTIONS.includes(value), "Recovery-Aktion muss 'prepared', 'preflight', 'activate', 'continue' oder 'reseal' sein.");
  return value;
}

async function syncPublicationDirectories(paths) {
  if (process.platform === "win32") return;
  for (const directory of new Set(paths.map((path) => dirname(path)))) {
    const handle = await open(directory, fileConstants.O_RDONLY | fileConstants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function publishCreateNew(artifacts, verifyInputs = async () => {}) {
  invariant(artifacts.length > 0, "Recovery-Publikation ist leer.");
  const paths = artifacts.map(({ path }) => resolve(path));
  invariant(new Set(paths).size === paths.length, "Recovery-Ausgaben duerfen keine Pfade teilen.");
  const claims = [];
  try {
    await verifyInputs();
    for (let index = 0; index < artifacts.length; index += 1) {
      const path = paths[index];
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await open(temporaryPath, "wx", 0o600);
      claims.push({ path, temporaryPath, handle, identity: await handle.stat({ bigint: true }), bytes: artifacts[index].bytes, closed: false, linked: false });
    }
    for (const claim of claims) {
      await claim.handle.writeFile(claim.bytes);
      await claim.handle.sync();
      await claim.handle.close();
      claim.closed = true;
    }
    await verifyInputs();
    for (const claim of claims) {
      await link(claim.temporaryPath, claim.path);
      claim.linked = true;
    }
    await syncPublicationDirectories(paths);
    for (const claim of claims) {
      const installed = await stableRegularFile(claim.path, "Erzeugtes Recovery-Artefakt", { maxBytes: MAX_JSON_BYTES });
      invariant(sameIdentity(claim.identity, installed.metadata) && installed.bytes.equals(claim.bytes), "Recovery-Ausgabe wurde beim Publizieren ausgetauscht.");
      await unlink(claim.temporaryPath);
    }
    await syncPublicationDirectories(paths);
    await verifyInputs();
  } catch (error) {
    for (const claim of claims) {
      if (!claim.closed) {
        try { await claim.handle.close(); } catch { /* urspruenglicher Fehler bleibt massgeblich */ }
      }
    }
    for (const claim of [...claims].reverse()) {
      if (claim.linked) {
        try { await removeIfOwned(claim.path, claim.identity); } catch { /* fremde Pfade werden nicht geloescht */ }
      }
      try { await removeIfOwned(claim.temporaryPath, claim.identity); } catch { /* fremde Pfade werden nicht geloescht */ }
    }
    throw error;
  }
}

export function parseDockerRunningServices(value, project) {
  invariant(Array.isArray(value), "Docker-Engine lieferte kein Containerinventar.");
  return value.map((container) => {
    invariant(container !== null && typeof container === "object" && !Array.isArray(container), "Docker-Engine lieferte einen ungueltigen Containereintrag.");
    const containerId = container.Id;
    const labels = container.Labels;
    invariant(labels !== null && typeof labels === "object" && !Array.isArray(labels), "Docker-Engine-Container besitzt keine Labels.");
    const service = labels["com.docker.compose.service"];
    const observedProject = labels["com.docker.compose.project"];
    invariant(CONTAINER_ID.test(containerId) && /^[a-z0-9][a-z0-9-]*$/u.test(service), "Docker-Servicebeobachtung ist nicht kanonisch.");
    invariant(observedProject === project, "Docker-Servicebeobachtung stammt aus einem fremden Compose-Projekt.");
    return { containerId, service };
  });
}

export function excludeBoundRecoveryControlContainer(services, environment = process.env) {
  const controlService = environment.PRODUCTION_RECOVERY_CONTROL_SERVICE;
  if (typeof controlService !== "string" || controlService.trim() === "") return services;
  invariant(controlService === "production-recovery-action", "Recovery-Control-Service ist nicht der feste One-shot-Dienst.");
  const selfContainerId = environment.HOSTNAME;
  invariant(typeof selfContainerId === "string" && CONTAINER_ID.test(selfContainerId), "Recovery-Control-Container besitzt keine gebundene Docker-ID als Hostname.");
  const matches = services.filter(({ containerId, service }) => service === controlService && containerId.startsWith(selfContainerId));
  invariant(matches.length === 1, "Recovery-Control-Container ist im aktuellen Docker-Inventar nicht eindeutig an sich selbst gebunden.");
  return services.filter(({ containerId }) => containerId !== matches[0].containerId);
}

async function runningServicesFromDockerSocket(project, socketPath) {
  const socketMetadata = await lstat(socketPath);
  invariant(socketMetadata.isSocket() && !socketMetadata.isSymbolicLink(), "Docker-Engine-Socket ist kein direkter Unix-Socket.");
  const filters = encodeURIComponent(JSON.stringify({
    label: [`com.docker.compose.project=${project}`],
    status: ["running"],
  }));
  const responseBytes = await new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({
      headers: { Accept: "application/json", Host: "docker" },
      method: "GET",
      path: `/v1.43/containers/json?all=0&filters=${filters}`,
      socketPath,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1_024 * 1_024) {
          request.destroy(new Error("Docker-Engine-Containerinventar ueberschreitet das Bytelimit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          rejectPromise(new Error(`Docker-Engine-Containerinventar endete mit HTTP ${response.statusCode ?? "unbekannt"}.`));
          return;
        }
        resolvePromise(Buffer.concat(chunks));
      });
    });
    request.once("error", rejectPromise);
    request.end();
  });
  let value;
  try {
    value = JSON.parse(responseBytes.toString("utf8"));
  } catch {
    throw new Error("Docker-Engine-Containerinventar ist kein gueltiges JSON.");
  }
  return excludeBoundRecoveryControlContainer(parseDockerRunningServices(value, project));
}

async function defaultRunningServices(project) {
  const dockerSocketPath = process.env.PRODUCTION_RECOVERY_DOCKER_SOCKET_PATH;
  if (typeof dockerSocketPath === "string" && dockerSocketPath.trim() !== "") {
    invariant(dockerSocketPath === "/var/run/docker.sock", "PRODUCTION_RECOVERY_DOCKER_SOCKET_PATH darf nur den festen Docker-Engine-Socket adressieren.");
    return runningServicesFromDockerSocket(project, dockerSocketPath);
  }
  const { stdout } = await execFile("docker", [
    "ps",
    "--filter", `label=com.docker.compose.project=${project}`,
    "--filter", "status=running",
    "--format", "{{.ID}}\t{{.Label \"com.docker.compose.service\"}}\t{{.Label \"com.docker.compose.project\"}}",
  ], { windowsHide: true, maxBuffer: 1_024 * 1_024 });
  return stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
    const [containerId, service, observedProject, ...extra] = line.split("\t");
    invariant(extra.length === 0 && CONTAINER_ID.test(containerId) && /^[a-z0-9][a-z0-9-]*$/u.test(service), "Docker-Servicebeobachtung ist nicht kanonisch.");
    invariant(observedProject === project, "Docker-Servicebeobachtung stammt aus einem fremden Compose-Projekt.");
    return { containerId, service };
  });
}

function postgresFactoryDefault() {
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const postgresModule = requireFromDb("postgres");
  return postgresModule.default ?? postgresModule;
}

async function defaultInspectGameContinuity({ databaseUrl, worldId }, postgresFactory) {
  const factory = postgresFactory ?? postgresFactoryDefault();
  const client = factory(databaseUrl, { max: 1 });
  try {
    return await client.begin("isolation level serializable read only deferrable", async (sql) => {
      const [snapshot, worldRows, regionRows] = await Promise.all([
        inspectLiveDatabaseRollbackSnapshot(sql),
        sql.unsafe(`
          select id::text as world_id,
                 to_char(epoch at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as epoch,
                 lifecycle_status, ranking_status, schedule_period_weeks::int,
                 world_kind
          from worlds
          where id = $1::uuid
        `, [worldId]),
        sql.unsafe(`
          select world_id::text as world_id, region_id, state_schema,
                 initialization_hash, revision::text as revision,
                 publisher_sequence::text as publisher_sequence, state_hash
          from regional_simulation_states
          where world_id = $1::uuid
          order by world_id, region_id
        `, [worldId]),
      ]);
      invariant(worldRows.length === 1, "Legacy-Continuity-Welt fehlt oder ist nicht eindeutig.");
      return Object.freeze({
        regions: Object.freeze(regionRows.map((row) => Object.freeze({ ...row }))),
        snapshot,
        world: Object.freeze({ ...worldRows[0] }),
      });
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function defaultFenceDatabase({ adminDatabaseUrl, database }, postgresFactory) {
  requiredDatabaseName(database, "Zu sperrende Datenbank");
  const factory = postgresFactory ?? postgresFactoryDefault();
  const client = factory(adminDatabaseUrl, { max: 1 });
  try {
    const beforeRows = await client.unsafe(`
      select datallowconn as allow_connections, datconnlimit::int as connection_limit
      from pg_database where datname = $1
    `, [database]);
    invariant(beforeRows.length === 1, `Zu sperrende Datenbank '${database}' fehlt.`);
    invariant(beforeRows[0].allow_connections === true, `Datenbank '${database}' war bereits fuer Verbindungen gesperrt.`);
    const previousConnectionLimit = Number(beforeRows[0].connection_limit);
    invariant(Number.isSafeInteger(previousConnectionLimit), `Datenbank '${database}' besitzt kein gueltiges Verbindungslimit.`);
    await client.unsafe(`alter database "${database}" with connection limit 0`);
    await client.unsafe(`alter database "${database}" with allow_connections false`);
    await client.unsafe("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
    const [stateRows, sessionRows, backendRows] = await Promise.all([
      client.unsafe("select datallowconn as allow_connections, datconnlimit::int as connection_limit from pg_database where datname = $1", [database]),
      client.unsafe("select count(*)::int as active_client_backends from pg_stat_activity where datname = $1 and backend_type = 'client backend'", [database]),
      client.unsafe(`
        select
          control.system_identifier::text as system_identifier,
          coalesce(inet_server_addr()::text, 'unix-socket') as server_address,
          inet_server_port()::int as server_port,
          pg_current_wal_lsn()::text as current_wal_lsn
        from pg_control_system() as control
      `),
    ]);
    invariant(stateRows.length === 1 && stateRows[0].allow_connections === false && Number(stateRows[0].connection_limit) === 0, `Datenbank '${database}' ist nicht dauerhaft gesperrt.`);
    invariant(sessionRows.length === 1 && Number(sessionRows[0].active_client_backends) === 0, `Datenbank '${database}' besitzt nach der Sperre noch Client-Sitzungen.`);
    invariant(backendRows.length === 1 && typeof backendRows[0].system_identifier === "string", `Datenbank '${database}' besitzt keine Backendidentitaet.`);
    const targetUrl = new URL(adminDatabaseUrl);
    targetUrl.pathname = `/${database}`;
    return Object.freeze({
      activeClientBackends: 0,
      allowConnections: false,
      backendSha256: databaseBackendIdentitySha256({
        serverAddress: backendRows[0].server_address,
        serverPort: Number(backendRows[0].server_port),
        systemIdentifier: backendRows[0].system_identifier,
      }),
      connectionLimit: 0,
      database,
      endpointSha256: databaseEndpointSha256(targetUrl.href),
      fencedWalLsn: backendRows[0].current_wal_lsn,
      previousConnectionLimit,
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function inspectDatabaseStateWithClient({ adminDatabaseUrl, client, database }) {
  const [stateRows, sessionRows, backendRows] = await Promise.all([
    client.unsafe("select datallowconn as allow_connections, datconnlimit::int as connection_limit from pg_database where datname = $1", [database]),
    client.unsafe("select count(*)::int as active_client_backends from pg_stat_activity where datname = $1 and backend_type = 'client backend'", [database]),
    client.unsafe(`
      select
        control.system_identifier::text as system_identifier,
        coalesce(inet_server_addr()::text, 'unix-socket') as server_address,
        inet_server_port()::int as server_port,
        pg_current_wal_lsn()::text as current_wal_lsn
      from pg_control_system() as control
    `),
  ]);
  invariant(stateRows.length === 1 && sessionRows.length === 1 && backendRows.length === 1, `Datenbank-Fence '${database}' ist nicht eindeutig pruefbar.`);
  const targetUrl = new URL(adminDatabaseUrl);
  targetUrl.pathname = `/${database}`;
  return Object.freeze({
    activeClientBackends: Number(sessionRows[0].active_client_backends),
    allowConnections: stateRows[0].allow_connections,
    backendSha256: databaseBackendIdentitySha256({
      serverAddress: backendRows[0].server_address,
      serverPort: Number(backendRows[0].server_port),
      systemIdentifier: backendRows[0].system_identifier,
    }),
    connectionLimit: Number(stateRows[0].connection_limit),
    database,
    endpointSha256: databaseEndpointSha256(targetUrl.href),
    currentWalLsn: backendRows[0].current_wal_lsn,
  });
}

async function defaultInspectDatabaseFence({ adminDatabaseUrl, database }, postgresFactory) {
  requiredDatabaseName(database, "Zu pruefende Datenbank-Fence");
  const factory = postgresFactory ?? postgresFactoryDefault();
  const client = factory(adminDatabaseUrl, { max: 1 });
  try {
    return await inspectDatabaseStateWithClient({ adminDatabaseUrl, client, database });
  } finally {
    await client.end({ timeout: 5 });
  }
}

function assertFenceStillClosed(expected, observed, label) {
  invariant(observed.database === expected.database, `${label} pruefte eine andere Datenbank.`);
  invariant(observed.activeClientBackends === 0 && observed.allowConnections === false && observed.connectionLimit === 0, `${label} ist nicht mehr geschlossen.`);
  invariant(observed.backendSha256 === expected.backendSha256 && observed.endpointSha256 === expected.endpointSha256, `${label} gehoert nicht mehr zum belegten Endpunkt/Backend.`);
  invariant(pgLsnValue(observed.currentWalLsn, `${label}.currentWalLsn`) >= pgLsnValue(expected.fencedWalLsn, `${label}.fencedWalLsn`), `${label} meldet eine rueckwaerts laufende WAL-LSN.`);
}

function validateFence(value, label) {
  exactKeys(value, [
    "activeClientBackends",
    "allowConnections",
    "backendSha256",
    "connectionLimit",
    "database",
    "endpointSha256",
    "fencedWalLsn",
    "previousConnectionLimit",
  ], label);
  requiredDatabaseName(value.database, `${label}.database`);
  invariant(value.activeClientBackends === 0 && value.allowConnections === false && value.connectionLimit === 0, `${label} beweist keine geschlossene Datenbank-Fence.`);
  invariant(Number.isSafeInteger(value.previousConnectionLimit), `${label} bindet kein vorheriges Verbindungslimit.`);
  invariant(SHA256.test(value.backendSha256) && SHA256.test(value.endpointSha256), `${label} bindet Endpunkt/Backend nicht bytegenau.`);
  pgLsnValue(value.fencedWalLsn, `${label}.fencedWalLsn`);
  return value;
}

function assertRecoveryDatabaseIdentity(expected, observed, label) {
  invariant(observed !== null && typeof observed === "object", `${label} ist nicht pruefbar.`);
  invariant(observed.database === expected.database, `${label} pruefte eine andere Datenbank.`);
  invariant(observed.backendSha256 === expected.backendSha256 && observed.endpointSha256 === expected.endpointSha256, `${label} gehoert nicht mehr zum belegten Endpunkt/Backend.`);
  invariant(Number.isSafeInteger(observed.activeClientBackends) && observed.activeClientBackends >= 0, `${label} besitzt keine gueltige Sitzungszahl.`);
  invariant(typeof observed.allowConnections === "boolean" && Number.isSafeInteger(observed.connectionLimit), `${label} besitzt keinen gueltigen Verbindungszustand.`);
  invariant(pgLsnValue(observed.currentWalLsn, `${label}.currentWalLsn`) >= pgLsnValue(expected.fencedWalLsn, `${label}.fencedWalLsn`), `${label} meldet eine rueckwaerts laufende WAL-LSN.`);
}

function assertRecoveryDatabaseOpen(expected, observed, label) {
  assertRecoveryDatabaseIdentity(expected, observed, label);
  invariant(expected.previousConnectionLimit === -1 || expected.previousConnectionLimit > 0, `${label} bindet kein aktivierbares vorheriges Verbindungslimit.`);
  invariant(
    observed.allowConnections === true
      && observed.connectionLimit === expected.previousConnectionLimit
      && observed.activeClientBackends === 0,
    `${label} ist nicht exakt auf seinen vor der Fence gebundenen Zustand geoeffnet.`,
  );
}

function assertAdminDatabaseIsSeparate(adminDatabaseUrl, targetDatabase, label) {
  invariant(databaseNameFromUrl(adminDatabaseUrl) !== targetDatabase, `${label} darf nicht ueber die zu schaltende Datenbank administriert werden.`);
}

async function configureDatabaseActionDeadline(client, deadlineMs) {
  invariant(Number.isSafeInteger(deadlineMs) && deadlineMs >= 1_000 && deadlineMs <= 60_000, "Recovery-Datenbank-Deadline ist ungueltig.");
  await client.unsafe(`set statement_timeout = ${deadlineMs}`);
  await client.unsafe(`set lock_timeout = ${deadlineMs}`);
}

async function defaultOpenRecoveryDatabase({ adminDatabaseUrl, deadlineMs, expectedFence, signal }, postgresFactory) {
  const database = requiredDatabaseName(expectedFence.database, "Zu aktivierende Recovery-Datenbank");
  assertAdminDatabaseIsSeparate(adminDatabaseUrl, database, "Recovery-Aktivierung");
  invariant(expectedFence.previousConnectionLimit === -1 || expectedFence.previousConnectionLimit > 0, `Recovery-Datenbank '${database}' besitzt kein aktivierbares vorheriges Verbindungslimit.`);
  const factory = postgresFactory ?? postgresFactoryDefault();
  const client = factory(adminDatabaseUrl, { max: 1 });
  try {
    invariant(signal?.aborted !== true, "Recovery-Datenbank-Aktivierung wurde vor Beginn abgebrochen.");
    await configureDatabaseActionDeadline(client, deadlineMs);
    const before = await inspectDatabaseStateWithClient({ adminDatabaseUrl, client, database });
    assertFenceStillClosed(expectedFence, before, `Recovery-Datenbank-Fence '${database}'`);
    invariant(signal?.aborted !== true, "Recovery-Datenbank-Aktivierung wurde vor dem Oeffnen abgebrochen.");
    await client.unsafe(`alter database "${database}" with connection limit ${expectedFence.previousConnectionLimit}`);
    await client.unsafe(`alter database "${database}" with allow_connections true`);
    const after = await inspectDatabaseStateWithClient({ adminDatabaseUrl, client, database });
    assertRecoveryDatabaseOpen(expectedFence, after, `Recovery-Datenbank '${database}'`);
    return after;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function defaultResealRecoveryDatabase({ adminDatabaseUrl, deadlineMs, expectedFence, signal }, postgresFactory) {
  const database = requiredDatabaseName(expectedFence.database, "Erneut zu sperrende Recovery-Datenbank");
  assertAdminDatabaseIsSeparate(adminDatabaseUrl, database, "Recovery-Reseal");
  const factory = postgresFactory ?? postgresFactoryDefault();
  const client = factory(adminDatabaseUrl, { max: 1 });
  try {
    invariant(signal?.aborted !== true, "Recovery-Datenbank-Reseal wurde vor Beginn abgebrochen.");
    await configureDatabaseActionDeadline(client, deadlineMs);
    const before = await inspectDatabaseStateWithClient({ adminDatabaseUrl, client, database });
    assertRecoveryDatabaseIdentity(expectedFence, before, `Recovery-Datenbank '${database}' vor Reseal`);
    invariant(signal?.aborted !== true, "Recovery-Datenbank-Reseal wurde vor der Sperre abgebrochen.");
    await client.unsafe(`alter database "${database}" with connection limit 0`);
    await client.unsafe(`alter database "${database}" with allow_connections false`);
    await client.unsafe("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
    const after = await inspectDatabaseStateWithClient({ adminDatabaseUrl, client, database });
    assertFenceStillClosed(expectedFence, after, `Recovery-Datenbank '${database}' nach Reseal`);
    return after;
  } finally {
    await client.end({ timeout: 5 });
  }
}

export function validateProductionQuiescenceReceipt(value, expected = {}) {
  exactKeys(value, [
    "allowedRunningServices",
    "candidateReleaseId",
    "dockerProject",
    "fencedAt",
    "gameDatabase",
    "observedRunningServices",
    "odooDatabase",
    "previousReleaseId",
    "receiptHash",
    "recoveryId",
    "schema",
    "writerContainersRunning",
  ], "Production-Quiescence-Receipt");
  invariant(value.schema === QUIESCENCE_SCHEMA, "Production-Quiescence-Receipt besitzt ein unbekanntes Schema.");
  requiredRecoveryId(value.recoveryId);
  requiredReleasePair(value.candidateReleaseId, value.previousReleaseId);
  if (expected.recoveryId !== undefined) invariant(value.recoveryId === expected.recoveryId, "Quiescence-Receipt gehoert zu einer anderen Recovery.");
  if (expected.candidateReleaseId !== undefined) invariant(value.candidateReleaseId === expected.candidateReleaseId, "Quiescence-Receipt gehoert zu einem anderen Kandidatenrelease.");
  if (expected.previousReleaseId !== undefined) invariant(value.previousReleaseId === expected.previousReleaseId, "Quiescence-Receipt gehoert zu einem anderen Vorgaengerrelease.");
  invariant(/^[a-z0-9][a-z0-9_-]*$/u.test(value.dockerProject), "Quiescence-Receipt besitzt kein sicheres Compose-Projekt.");
  invariant(sameValue(value.allowedRunningServices, REQUIRED_DATABASE_SERVICES), "Quiescence-Receipt erlaubt nicht exakt die beiden Datenbankdienste.");
  invariant(Array.isArray(value.observedRunningServices), "Quiescence-Receipt besitzt keine Docker-Beobachtung.");
  for (const entry of value.observedRunningServices) {
    exactKeys(entry, ["containerId", "service"], "Beobachteter Docker-Dienst");
    invariant(CONTAINER_ID.test(entry.containerId) && REQUIRED_DATABASE_SERVICES.includes(entry.service), "Quiescence-Receipt enthaelt einen unbekannten laufenden Container.");
  }
  invariant(
    sameValue(value.observedRunningServices.map(({ service }) => service).sort(), REQUIRED_DATABASE_SERVICES),
    "Quiescence-Receipt beweist nicht exakt die beiden allein laufenden Datenbankdienste.",
  );
  invariant(value.writerContainersRunning === 0, "Quiescence-Receipt meldet noch laufende Writer-Container.");
  validateFence(value.gameDatabase, "Game-Live-Datenbank-Fence");
  validateFence(value.odooDatabase, "Odoo-Live-Datenbank-Fence");
  invariant(value.gameDatabase.endpointSha256 !== value.odooDatabase.endpointSha256, "Game und Odoo wurden nicht als getrennte Datenbankziele gesperrt.");
  canonicalInstant(value.fencedAt, "Quiescence-Zeitpunkt");
  invariant(SHA256.test(value.receiptHash) && value.receiptHash === canonicalHashWithout(value, "receiptHash"), "Quiescence-Receipt besitzt keinen gueltigen kanonischen Hash.");
  return value;
}

export async function createProductionQuiescenceReceiptArtifact({
  environment = process.env,
  inspectRunningServices = defaultRunningServices,
  fenceDatabase = defaultFenceDatabase,
  postgresFactory,
  now = () => new Date(),
} = {}) {
  const recoveryId = requiredRecoveryId(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID"));
  const candidateReleaseId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID");
  const previousReleaseId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID");
  requiredReleasePair(candidateReleaseId, previousReleaseId);
  const dockerProject = requiredEnvironment(environment, "PRODUCTION_RECOVERY_DOCKER_PROJECT");
  invariant(/^[a-z0-9][a-z0-9_-]*$/u.test(dockerProject), "Compose-Projekt ist nicht sicher benannt.");
  const gameDatabase = requiredDatabaseName(requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_LIVE_DATABASE"), "Game-Live-Datenbank");
  const odooDatabase = requiredDatabaseName(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_LIVE_DATABASE"), "Odoo-Live-Datenbank");
  invariant(gameDatabase !== odooDatabase, "Game- und Odoo-Live-Datenbank duerfen nicht denselben Namen verwenden.");
  const outputPath = await containedCreateNewOutput(
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_EVIDENCE_ROOT"),
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_QUIESCENCE_OUTPUT_PATH"),
    "Production-Quiescence-Receipt",
  );
  await assertCreateNewPathAvailable(outputPath, "Production-Quiescence-Receipt");
  const services = (await inspectRunningServices(dockerProject)).sort((left, right) => left.service.localeCompare(right.service, "en"));
  invariant(sameValue(services.map(({ service }) => service), REQUIRED_DATABASE_SERVICES), "Vor der Recovery laufen noch Writer oder es fehlt ein Datenbankdienst.");
  const [gameFence, odooFence] = await Promise.all([
    fenceDatabase({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_ADMIN_DATABASE_URL"),
      database: gameDatabase,
    }, postgresFactory),
    fenceDatabase({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_ADMIN_DATABASE_URL"),
      database: odooDatabase,
    }, postgresFactory),
  ]);
  const payload = {
    allowedRunningServices: REQUIRED_DATABASE_SERVICES,
    candidateReleaseId,
    dockerProject,
    fencedAt: canonicalInstant(now().toISOString(), "Quiescence-Zeitpunkt"),
    gameDatabase: validateFence(gameFence, "Game-Live-Datenbank-Fence"),
    observedRunningServices: services,
    odooDatabase: validateFence(odooFence, "Odoo-Live-Datenbank-Fence"),
    previousReleaseId,
    recoveryId,
    schema: QUIESCENCE_SCHEMA,
    writerContainersRunning: 0,
  };
  const receipt = validateProductionQuiescenceReceipt({ ...payload, receiptHash: canonicalHashWithout(payload, "receiptHash") });
  const bytes = serializeMapReleaseBuildEvidence(receipt);
  await publishCreateNew([{ path: outputPath, bytes }]);
  return Object.freeze({ outputPath: resolve(outputPath), receiptHash: receipt.receiptHash, bytes: bytes.length });
}

function validateGameBackupManifest(value, dump) {
  exactKeys(value, ["bytes", "createdAt", "migrationCount", "rpoSeconds", "schema", "sha256"], "Game-Backup-Manifest");
  invariant(value.schema === "zugfolge-game-backup/v2", "Game-Backup-Manifest besitzt ein unbekanntes Schema.");
  invariant(typeof value.createdAt === "string" && /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u.test(value.createdAt), "Game-Backup-Manifest besitzt keinen UTC-Zeitpunkt.");
  invariant(Number.isSafeInteger(value.bytes) && BigInt(value.bytes) === dump.metadata.size, "Game-Dump weicht in der Bytezahl vom Manifest ab.");
  invariant(SHA256.test(value.sha256) && value.sha256 === dump.sha256, "Game-Dump weicht im SHA-256 vom Manifest ab.");
  invariant(Number.isSafeInteger(value.migrationCount) && value.migrationCount > 0, "Game-Backup-Manifest besitzt keinen Migrationsstand.");
  invariant(value.rpoSeconds === 300, "Game-Backup-Manifest besitzt einen unerwarteten RPO-Vertrag.");
  return value;
}

function validateGameBackupOperation(value, expected) {
  exactKeys(value, [
    "backupCompletedWalLsn",
    "backupId",
    "backupStartedWalLsn",
    "completedAt",
    "dumpSha256",
    "gameBackupManifestSha256",
    "schema",
    "writersQuiesced",
  ], "Game-Backup-Operationsbeleg");
  invariant(value.schema === "zugfolge-game-backup-operation/v1", "Game-Backup-Operationsbeleg besitzt ein unbekanntes Schema.");
  invariant(typeof value.backupId === "string" && /^[A-Za-z0-9._-]+$/u.test(value.backupId), "Game-Backup-Operationsbeleg besitzt keine sichere Backup-ID.");
  invariant(value.dumpSha256 === expected.dumpSha256 && value.gameBackupManifestSha256 === expected.manifestSha256, "Game-Backup-Operationsbeleg bindet andere Dump-/Manifestbytes.");
  invariant(value.writersQuiesced === true, "Game-Backup-Operationsbeleg wurde nicht bei quieszierten Schreibern erzeugt.");
  invariant(typeof value.completedAt === "string" && Number.isFinite(Date.parse(value.completedAt)), "Game-Backup-Operationsbeleg besitzt keinen Abschlusszeitpunkt.");
  invariant(/^[A-F0-9]+\/[A-F0-9]{1,8}$/u.test(value.backupStartedWalLsn) && /^[A-F0-9]+\/[A-F0-9]{1,8}$/u.test(value.backupCompletedWalLsn), "Game-Backup-Operationsbeleg besitzt keine WAL-Spanne.");
  return value;
}

function validateGameRecoveryRestoreReceipt(value, expected) {
  exactKeys(value, ["database", "dumpSha256", "identical", "manifestSha256", "migrationCount", "recoveryId", "schema"], "Game-Recovery-Restore-Receipt");
  invariant(value.schema === GAME_RESTORE_SCHEMA, "Game-Recovery-Restore-Receipt besitzt ein unbekanntes Schema.");
  invariant(value.recoveryId === expected.recoveryId, "Game-Recovery-Restore-Receipt gehoert zu einer anderen Recovery.");
  requiredDatabaseName(value.database, "Game-Recovery-Datenbank", "zugfolge_recovery_v1_");
  invariant(value.database === expected.database, "Game-Recovery-Restore-Receipt bindet eine andere Zieldatenbank.");
  invariant(value.dumpSha256 === expected.dumpSha256 && value.manifestSha256 === expected.manifestSha256, "Game-Recovery-Restore-Receipt bindet andere Backupbytes.");
  invariant(value.migrationCount === expected.migrationCount && value.identical === true, "Game-Recovery-Restore-Receipt meldet keinen vollstaendigen Restore.");
  return value;
}

function validateOdooBackupManifest(value, databaseDump, filestoreArchive) {
  exactKeys(value, [
    "authoritativeStateSha256",
    "createdAt",
    "databaseSha256",
    "filestoreSha256",
    "filestoreTreeSha256",
    "rpoSeconds",
    "schema",
  ], "Odoo-Backup-Manifest");
  invariant(value.schema === "zugfolge-odoo-backup/v2", "Odoo-Backup-Manifest besitzt ein unbekanntes Schema.");
  invariant(typeof value.createdAt === "string" && /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u.test(value.createdAt), "Odoo-Backup-Manifest besitzt keinen UTC-Zeitpunkt.");
  invariant(value.databaseSha256 === databaseDump.sha256, "Odoo-Datenbankdump weicht vom Backup-Manifest ab.");
  invariant(value.filestoreSha256 === filestoreArchive.sha256, "Odoo-Filestorearchiv weicht vom Backup-Manifest ab.");
  invariant(SHA256.test(value.authoritativeStateSha256) && SHA256.test(value.filestoreTreeSha256), "Odoo-Backup-Manifest bindet Zustand/Filestore nicht bytegenau.");
  invariant(value.rpoSeconds === 900, "Odoo-Backup-Manifest besitzt einen unerwarteten RPO-Vertrag.");
  return value;
}

function validateOdooRecoveryRestoreReceipt(value, expected) {
  exactKeys(value, [
    "authoritativeStateSha256",
    "database",
    "databaseSha256",
    "filestoreArchiveSha256",
    "filestoreTreeSha256",
    "identical",
    "recoveryId",
    "schema",
  ], "Odoo-Recovery-Restore-Receipt");
  invariant(value.schema === ODOO_RESTORE_SCHEMA, "Odoo-Recovery-Restore-Receipt besitzt ein unbekanntes Schema.");
  invariant(value.recoveryId === expected.recoveryId, "Odoo-Recovery-Restore-Receipt gehoert zu einer anderen Recovery.");
  requiredDatabaseName(value.database, "Odoo-Recovery-Datenbank", "zugfolge_odoo_recovery_v1_");
  invariant(value.database === expected.database, "Odoo-Recovery-Restore-Receipt bindet eine andere Zieldatenbank.");
  invariant(value.databaseSha256 === expected.databaseSha256 && value.filestoreArchiveSha256 === expected.filestoreArchiveSha256, "Odoo-Recovery-Restore-Receipt bindet andere Backupbytes.");
  invariant(value.authoritativeStateSha256 === expected.authoritativeStateSha256 && value.filestoreTreeSha256 === expected.filestoreTreeSha256, "Odoo-Recovery-Restore-Receipt bindet einen anderen logischen Restorezustand.");
  invariant(value.identical === true, "Odoo-Recovery-Restore-Receipt meldet keinen identischen Restore.");
  return value;
}

function assertFilestoreAccess(status, isDirectory, expectedAccess, expectedOwner, label) {
  const mode = Number(status.mode) & 0o777;
  if (expectedOwner !== undefined) {
    invariant(Number(status.uid) === expectedOwner.uid && Number(status.gid) === expectedOwner.gid, `${label} gehoert nicht dem gebundenen Odoo-Runtime-Benutzer.`);
  }
  const observedAccess = (mode & 0o222) === 0 ? "read-only" : "owner-writable";
  if (expectedAccess === "read-only") {
    invariant((mode & 0o222) === 0, `${label} ist vor der Promotion noch beschreibbar.`);
  } else if (expectedAccess === "owner-writable" || (expectedAccess === "any" && observedAccess === "owner-writable")) {
    invariant((mode & 0o200) !== 0, `${label} ist fuer den gebundenen Odoo-Runtime-Benutzer nicht beschreibbar.`);
    if (process.platform !== "win32") {
      invariant((mode & 0o022) === 0, `${label} ist fuer Gruppe oder Andere beschreibbar.`);
      invariant((mode & (isDirectory ? 0o500 : 0o400)) === (isDirectory ? 0o500 : 0o400), `${label} besitzt nicht die erforderlichen Owner-Lese-/Ausfuehrungsrechte.`);
    }
  }
  return observedAccess;
}

async function inspectFilestoreTree(rootPath, { expectedAccess = "read-only", expectedOwner } = {}) {
  invariant(["any", "owner-writable", "read-only"].includes(expectedAccess), "Odoo-Recovery-Filestorepruefung besitzt einen unbekannten Zugriffsvertrag.");
  const root = await realpath(rootPath);
  const rootStatus = await lstat(root, { bigint: true });
  invariant(rootStatus.isDirectory() && !rootStatus.isSymbolicLink(), "Odoo-Recovery-Filestore ist kein regulaeres Verzeichnis.");
  const observedAccess = assertFilestoreAccess(rootStatus, true, expectedAccess, expectedOwner, "Odoo-Recovery-Filestore");
  const files = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      invariant(entry.name !== "." && entry.name !== ".." && !entry.name.includes("/") && !entry.name.includes("\\"), "Odoo-Recovery-Filestore enthaelt einen unsicheren Namen.");
      const absolute = resolve(directory, entry.name);
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const status = await lstat(absolute, { bigint: true });
      invariant(!status.isSymbolicLink(), "Odoo-Recovery-Filestore enthaelt einen Symlink.");
      if (status.isDirectory()) {
        invariant(assertFilestoreAccess(status, true, expectedAccess, expectedOwner, `Odoo-Filestoreverzeichnis '${relativePath}'`) === observedAccess, `Odoo-Filestoreverzeichnis '${relativePath}' besitzt einen gemischten Zugriffsmodus.`);
        await visit(absolute, relativePath);
      } else {
        invariant(status.isFile(), "Odoo-Recovery-Filestore enthaelt einen unzulaessigen Dateityp.");
        invariant(assertFilestoreAccess(status, false, expectedAccess, expectedOwner, `Odoo-Filestoredatei '${relativePath}'`) === observedAccess, `Odoo-Filestoredatei '${relativePath}' besitzt einen gemischten Zugriffsmodus.`);
        const artifact = await stableRegularFile(absolute, `Odoo-Filestoredatei '${relativePath}'`, { retainBytes: false });
        files.push({ relativePath, sha256: artifact.sha256 });
      }
    }
  }
  await visit(root, "");
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  const shaLines = files.map(({ relativePath, sha256 }) => `${sha256}  ./${relativePath}\n`).join("");
  return Object.freeze({
    access: observedAccess,
    root,
    fileCount: files.length,
    ownerGid: Number(rootStatus.gid),
    ownerUid: Number(rootStatus.uid),
    relativePaths: Object.freeze(files.map(({ relativePath }) => relativePath)),
    treeSha256: sha256Bytes(Buffer.from(shaLines, "utf8")),
  });
}

async function collectFilestoreAccessEntries(rootPath, expectedOwner) {
  const root = await realpath(rootPath);
  const entries = [];
  async function visit(path, depth) {
    const status = await lstat(path, { bigint: true });
    invariant(!status.isSymbolicLink(), "Odoo-Recovery-Filestore-Zugriffspfad enthaelt einen Symlink.");
    const isDirectory = status.isDirectory();
    invariant(isDirectory || status.isFile(), "Odoo-Recovery-Filestore-Zugriffspfad enthaelt einen unzulaessigen Dateityp.");
    invariant(Number(status.uid) === expectedOwner.uid && Number(status.gid) === expectedOwner.gid, "Odoo-Recovery-Filestore-Zugriffspfad gehoert nicht der gebundenen Odoo-Runtime-Identitaet.");
    entries.push({ depth, identity: status, isDirectory, path });
    if (!isDirectory) return;
    const children = await readdir(path, { withFileTypes: true });
    for (const child of children) {
      invariant(child.name !== "." && child.name !== ".." && !child.name.includes("/") && !child.name.includes("\\"), "Odoo-Recovery-Filestore enthaelt einen unsicheren Namen.");
      await visit(resolve(path, child.name), depth + 1);
    }
  }
  await visit(root, 0);
  entries.sort((left, right) => Number(left.isDirectory) - Number(right.isDirectory) || right.depth - left.depth || left.path.localeCompare(right.path, "en"));
  return Object.freeze({ entries: Object.freeze(entries), root });
}

async function chmodStableFilestoreEntry(entry, mode, expectedOwner) {
  if (process.platform === "win32") {
    const before = await lstat(entry.path, { bigint: true });
    invariant(sameIdentity(before, entry.identity) && !before.isSymbolicLink(), "Odoo-Recovery-Filestorepfad wurde vor dem Moduswechsel ausgetauscht.");
    await chmod(entry.path, mode);
    const after = await lstat(entry.path, { bigint: true });
    invariant(sameIdentity(before, after) && Number(after.uid) === expectedOwner.uid && Number(after.gid) === expectedOwner.gid, "Odoo-Recovery-Filestorepfad wurde beim Moduswechsel ausgetauscht.");
    return;
  }
  const flags = fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | (entry.isDirectory ? fileConstants.O_DIRECTORY : 0);
  const handle = await open(entry.path, flags);
  try {
    const before = await handle.stat({ bigint: true });
    invariant(sameIdentity(before, entry.identity) && Number(before.uid) === expectedOwner.uid && Number(before.gid) === expectedOwner.gid, "Odoo-Recovery-Filestorepfad wurde vor dem Moduswechsel ausgetauscht.");
    await handle.chmod(mode);
    const after = await handle.stat({ bigint: true });
    invariant(sameIdentity(before, after) && Number(after.uid) === expectedOwner.uid && Number(after.gid) === expectedOwner.gid, "Odoo-Recovery-Filestorepfad wurde beim Moduswechsel ausgetauscht.");
  } finally {
    await handle.close();
  }
  const installed = await lstat(entry.path, { bigint: true });
  invariant(sameIdentity(entry.identity, installed) && !installed.isSymbolicLink(), "Odoo-Recovery-Filestorepfad wurde nach dem Moduswechsel ausgetauscht.");
}

async function defaultSetFilestoreAccess({ containerPath, owner, signal, writable }) {
  invariant(typeof writable === "boolean", "Odoo-Recovery-Filestore-Modus ist ungueltig.");
  const collected = await collectFilestoreAccessEntries(containerPath, owner);
  for (const entry of collected.entries) {
    invariant(signal?.aborted !== true, "Odoo-Recovery-Filestore-Moduswechsel ueberschritt seine Deadline.");
    const mode = writable
      ? (entry.isDirectory ? 0o750 : 0o640)
      : (entry.isDirectory ? 0o550 : 0o440);
    await chmodStableFilestoreEntry(entry, mode, owner);
  }
}

const ODOO_STATE_QUERIES = Object.freeze([
  ["zugfolge_world_projection", "select 'zugfolge_world_projection=' || coalesce((select jsonb_agg(to_jsonb(t) order by t.id)::text from zugfolge_world_projection t), '[]') as line"],
  ["zugfolge_admin_capability", "select 'zugfolge_admin_capability=' || coalesce((select jsonb_agg(to_jsonb(t) order by t.id)::text from zugfolge_admin_capability t), '[]') as line"],
  ["zugfolge_admin_request", "select 'zugfolge_admin_request=' || coalesce((select jsonb_agg(to_jsonb(t) order by t.id)::text from zugfolge_admin_request t), '[]') as line"],
  ["zugfolge_alpha_invitation", "select 'zugfolge_alpha_invitation=' || coalesce((select jsonb_agg(to_jsonb(t) order by t.id)::text from zugfolge_alpha_invitation t), '[]') as line"],
  ["zugfolge_feedback", "select 'zugfolge_feedback=' || coalesce((select jsonb_agg(to_jsonb(t) order by t.id)::text from zugfolge_feedback t), '[]') as line"],
  ["zugfolge_projection_receipt", "select 'zugfolge_projection_receipt=' || coalesce((select jsonb_agg(to_jsonb(t) order by t.id)::text from zugfolge_projection_receipt t), '[]') as line"],
  ["ir_attachment", "select 'ir_attachment=' || coalesce((select jsonb_agg(to_jsonb(t) order by t.id)::text from ir_attachment t where t.res_model like 'zugfolge.%'), '[]') as line"],
]);

async function defaultInspectOdooRestore({ databaseUrl, filestoreOptions, filestorePath }, postgresFactory) {
  const factory = postgresFactory ?? postgresFactoryDefault();
  const client = factory(databaseUrl, { max: 1 });
  try {
    const stateLines = [];
    for (const [label, query] of ODOO_STATE_QUERIES) {
      const rows = await client.unsafe(query);
      invariant(rows.length === 1 && typeof rows[0].line === "string" && rows[0].line.startsWith(`${label}=`), `Odoo-Restorezustand '${label}' ist nicht eindeutig hashbar.`);
      stateLines.push(rows[0].line);
    }
    const backendRows = await client.unsafe(`
      select
        control.system_identifier::text as system_identifier,
        coalesce(inet_server_addr()::text, 'unix-socket') as server_address,
        inet_server_port()::int as server_port,
        current_database()::text as database
      from pg_control_system() as control
    `);
    invariant(backendRows.length === 1, "Odoo-Recovery-Backend ist nicht eindeutig.");
    const backend = backendRows[0];
    const filestore = await inspectFilestoreTree(filestorePath, filestoreOptions);
    const attachmentRows = await client.unsafe(`
      select store_fname::text as store_fname
      from ir_attachment
      where res_model like 'zugfolge.%' and store_fname is not null
      order by store_fname
    `);
    const filestorePaths = new Set(filestore.relativePaths);
    for (const row of attachmentRows) {
      invariant(typeof row.store_fname === "string" && /^[a-f0-9]{2}\/[a-f0-9]{40}$/u.test(row.store_fname), "Odoo-Recovery besitzt einen unsicheren Zugfolge-Anhangspfad.");
      invariant(filestorePaths.has(row.store_fname), `Odoo-Recovery-Filestore fehlt fuer Anhang '${row.store_fname}'.`);
    }
    return Object.freeze({
      attachmentCount: attachmentRows.length,
      authoritativeStateSha256: sha256Bytes(Buffer.from(`${stateLines.join("\n")}\n`, "utf8")),
      backendSha256: databaseBackendIdentitySha256({
        serverAddress: backend.server_address,
        serverPort: Number(backend.server_port),
        systemIdentifier: backend.system_identifier,
      }),
      database: backend.database,
      endpointSha256: databaseEndpointSha256(databaseUrl),
      filestore,
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function containedRecoveryFilestore(rootPath, targetPath, targetDatabase) {
  const root = await realpath(rootPath);
  const target = await realpath(targetPath);
  const relativePath = relative(root, target);
  invariant(relativePath !== "" && !relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.startsWith(sep), "Odoo-Recovery-Filestore liegt ausserhalb der festen Recovery-Wurzel.");
  invariant(dirname(target) === root && basename(target) === targetDatabase, "Odoo-Recovery-Filestore muss ein direktes, datenbankgleiches Kind der Recovery-Wurzel sein.");
  return target;
}

export function validateProductionRecoveryReceipt(value, expected = {}) {
  exactKeys(value, [
    "candidateReleaseId",
    "game",
    "odoo",
    "previousReleaseId",
    "qualifiedAt",
    "quiescence",
    "receiptHash",
    "recoveryId",
    "runtimeRollback",
    "schema",
  ], "Production-Recovery-Receipt");
  invariant(value.schema === RECOVERY_SCHEMA, "Production-Recovery-Receipt besitzt ein unbekanntes Schema.");
  requiredRecoveryId(value.recoveryId);
  requiredReleasePair(value.candidateReleaseId, value.previousReleaseId);
  if (expected.recoveryId !== undefined) invariant(value.recoveryId === expected.recoveryId, "Production-Recovery-Receipt gehoert zu einer anderen Recovery.");
  exactKeys(value.quiescence, ["receiptHash", "sha256"], "Recovery-Quiescence-Bindung");
  invariant(SHA256.test(value.quiescence.receiptHash) && SHA256.test(value.quiescence.sha256), "Recovery bindet Quiescence nicht bytegenau.");
  exactKeys(value.game, [
    "backupOperationSha256",
    "backupManifestSha256",
    "database",
    "databaseRollbackProofHash",
    "databaseRollbackProofSha256",
    "dumpBytes",
    "dumpSha256",
    "endpointSha256",
    "rawManifestSha256",
    "restoreProofSha256",
    "restoreReceiptSha256",
    "targetFence",
  ], "Game-Recovery-Bindung");
  exactKeys(value.odoo, [
    "attachmentCount",
    "authoritativeStateSha256",
    "backupManifestSha256",
    "database",
    "databaseDumpBytes",
    "databaseDumpSha256",
    "endpointSha256",
    "filestoreArchiveBytes",
    "filestoreArchiveSha256",
    "filestoreFileCount",
    "filestorePath",
    "filestoreTreeSha256",
    "restoreReceiptSha256",
    "targetFence",
  ], "Odoo-Recovery-Bindung");
  requiredDatabaseName(value.game.database, "Game-Recovery-Datenbank", "zugfolge_recovery_v1_");
  requiredDatabaseName(value.odoo.database, "Odoo-Recovery-Datenbank", "zugfolge_odoo_recovery_v1_");
  validateFence(value.game.targetFence, "Game-Recovery-Target-Fence");
  validateFence(value.odoo.targetFence, "Odoo-Recovery-Target-Fence");
  invariant(value.game.targetFence.database === value.game.database && value.game.targetFence.endpointSha256 === value.game.endpointSha256, "Game-Recovery-Bindung und Target-Fence widersprechen sich.");
  invariant(value.odoo.targetFence.database === value.odoo.database && value.odoo.targetFence.endpointSha256 === value.odoo.endpointSha256, "Odoo-Recovery-Bindung und Target-Fence widersprechen sich.");
  for (const hash of [
    value.game.backupOperationSha256,
    value.game.backupManifestSha256,
    value.game.databaseRollbackProofHash,
    value.game.databaseRollbackProofSha256,
    value.game.dumpSha256,
    value.game.endpointSha256,
    value.game.rawManifestSha256,
    value.game.restoreProofSha256,
    value.game.restoreReceiptSha256,
    value.odoo.authoritativeStateSha256,
    value.odoo.backupManifestSha256,
    value.odoo.databaseDumpSha256,
    value.odoo.endpointSha256,
    value.odoo.filestoreArchiveSha256,
    value.odoo.filestoreTreeSha256,
    value.odoo.restoreReceiptSha256,
  ]) invariant(SHA256.test(hash), "Production-Recovery-Receipt besitzt eine ungueltige SHA-256-Bindung.");
  invariant(Number.isSafeInteger(value.game.dumpBytes) && value.game.dumpBytes > 0, "Game-Recovery-Dumpgroesse ist ungueltig.");
  invariant(Number.isSafeInteger(value.odoo.databaseDumpBytes) && value.odoo.databaseDumpBytes > 0, "Odoo-Recovery-Dumpgroesse ist ungueltig.");
  invariant(Number.isSafeInteger(value.odoo.filestoreArchiveBytes) && value.odoo.filestoreArchiveBytes > 0, "Odoo-Recovery-Archivgroesse ist ungueltig.");
  invariant(Number.isSafeInteger(value.odoo.filestoreFileCount) && value.odoo.filestoreFileCount >= 0, "Odoo-Recovery-Filestorezaehlung ist ungueltig.");
  invariant(Number.isSafeInteger(value.odoo.attachmentCount) && value.odoo.attachmentCount >= 0, "Odoo-Recovery-Anhangszaehlung ist ungueltig.");
  validateRuntimeRollbackBinding(value.runtimeRollback, "Production-Recovery-Runtime-Rollback-Bindung");
  invariant(
    value.runtimeRollback.databaseRollbackProofHash === value.game.databaseRollbackProofHash
      && value.runtimeRollback.databaseRollbackProofSha256 === value.game.databaseRollbackProofSha256,
    "Production-Recovery-Receipt bindet verschiedene Datenbank- und Runtime-Rollback-Proofs.",
  );
  canonicalInstant(value.qualifiedAt, "Recovery-Qualifikationszeitpunkt");
  invariant(SHA256.test(value.receiptHash) && value.receiptHash === canonicalHashWithout(value, "receiptHash"), "Production-Recovery-Receipt besitzt keinen gueltigen kanonischen Hash.");
  return value;
}

export function validateProductionRecoveryPromotion(value, expected = {}) {
  exactKeys(value, [
    "candidateReleaseId",
    "gameDatabase",
    "gameEndpointSha256",
    "odooDatabase",
    "odooEndpointSha256",
    "odooFilestorePath",
    "previousReleaseId",
    "promotionHash",
    "receiptHash",
    "receiptSha256",
    "recoveryId",
    "runtimeRollback",
    "schema",
  ], "Production-Recovery-Promotion");
  invariant(value.schema === PROMOTION_SCHEMA, "Production-Recovery-Promotion besitzt ein unbekanntes Schema.");
  requiredRecoveryId(value.recoveryId);
  requiredReleasePair(value.candidateReleaseId, value.previousReleaseId);
  if (expected.recoveryId !== undefined) invariant(value.recoveryId === expected.recoveryId, "Production-Recovery-Promotion gehoert zu einer anderen Recovery.");
  if (expected.candidateReleaseId !== undefined) invariant(value.candidateReleaseId === expected.candidateReleaseId, "Production-Recovery-Promotion gehoert zu einem anderen Kandidatenrelease.");
  if (expected.previousReleaseId !== undefined) invariant(value.previousReleaseId === expected.previousReleaseId, "Production-Recovery-Promotion gehoert zu einem anderen Vorgaengerrelease.");
  requiredDatabaseName(value.gameDatabase, "Game-Recovery-Datenbank", "zugfolge_recovery_v1_");
  requiredDatabaseName(value.odooDatabase, "Odoo-Recovery-Datenbank", "zugfolge_odoo_recovery_v1_");
  invariant(value.gameDatabase !== value.odooDatabase, "Production-Recovery-Promotion verwendet dieselbe Game-/Odoo-Datenbank.");
  invariant(typeof value.odooFilestorePath === "string" && value.odooFilestorePath !== "", "Production-Recovery-Promotion besitzt keinen Odoo-Filestorepfad.");
  for (const hash of [value.gameEndpointSha256, value.odooEndpointSha256, value.receiptHash, value.receiptSha256]) {
    invariant(SHA256.test(hash), "Production-Recovery-Promotion besitzt eine ungueltige SHA-256-Bindung.");
  }
  validateRuntimeRollbackBinding(value.runtimeRollback, "Production-Recovery-Promotion-Runtime-Rollback-Bindung");
  invariant(SHA256.test(value.promotionHash) && value.promotionHash === canonicalHashWithout(value, "promotionHash"), "Production-Recovery-Promotion besitzt keinen gueltigen kanonischen Hash.");
  return value;
}

function promotionArtifact(receipt, receiptSha256) {
  const payload = {
    candidateReleaseId: receipt.candidateReleaseId,
    gameDatabase: receipt.game.database,
    gameEndpointSha256: receipt.game.endpointSha256,
    odooDatabase: receipt.odoo.database,
    odooEndpointSha256: receipt.odoo.endpointSha256,
    odooFilestorePath: receipt.odoo.filestorePath,
    previousReleaseId: receipt.previousReleaseId,
    receiptHash: receipt.receiptHash,
    receiptSha256,
    recoveryId: receipt.recoveryId,
    runtimeRollback: receipt.runtimeRollback,
    schema: PROMOTION_SCHEMA,
  };
  return Object.freeze(validateProductionRecoveryPromotion({ ...payload, promotionHash: canonicalHashWithout(payload, "promotionHash") }));
}

export async function createProductionRecoveryArtifacts({
  environment = process.env,
  inspectGameRestore = inspectDatabaseRollbackEndpoint,
  inspectOdooRestore = defaultInspectOdooRestore,
  inspectDatabaseFence = defaultInspectDatabaseFence,
  sealDatabase = defaultFenceDatabase,
  postgresFactory,
  now = () => new Date(),
} = {}) {
  const recoveryId = requiredRecoveryId(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID"));
  const candidateReleaseId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID");
  const previousReleaseId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID");
  requiredReleasePair(candidateReleaseId, previousReleaseId);
  const evidenceRoot = requiredEnvironment(environment, "PRODUCTION_RECOVERY_EVIDENCE_ROOT");
  const receiptOutputPath = await containedCreateNewOutput(
    evidenceRoot,
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_RECEIPT_OUTPUT_PATH"),
    "Production-Recovery-Receipt",
  );
  const promotionOutputPath = await containedCreateNewOutput(
    evidenceRoot,
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_PROMOTION_OUTPUT_PATH"),
    "Production-Recovery-Promotion",
  );
  await Promise.all([
    assertCreateNewPathAvailable(receiptOutputPath, "Production-Recovery-Receipt"),
    assertCreateNewPathAvailable(promotionOutputPath, "Production-Recovery-Promotion"),
  ]);
  invariant(resolve(receiptOutputPath) !== resolve(promotionOutputPath), "Recovery-Receipt und Promotion duerfen nicht denselben Pfad verwenden.");
  const quiescenceArtifact = await stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_QUIESCENCE_PATH"), "Production-Quiescence-Receipt");
  const quiescence = validateProductionQuiescenceReceipt(quiescenceArtifact.value, { recoveryId, candidateReleaseId, previousReleaseId });
  const [liveGameFence, liveOdooFence] = await Promise.all([
    inspectDatabaseFence({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_LIVE_ADMIN_DATABASE_URL"),
      database: quiescence.gameDatabase.database,
    }, postgresFactory),
    inspectDatabaseFence({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_LIVE_ADMIN_DATABASE_URL"),
      database: quiescence.odooDatabase.database,
    }, postgresFactory),
  ]);
  assertFenceStillClosed(quiescence.gameDatabase, liveGameFence, "Game-V2-Live-Datenbank-Fence");
  assertFenceStillClosed(quiescence.odooDatabase, liveOdooFence, "Odoo-V2-Live-Datenbank-Fence");
  const gameDump = await stableRegularFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_DUMP_PATH"), "Game-Recovery-Dump", { retainBytes: false });
  const gameManifestArtifact = await stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_MANIFEST_PATH"), "Game-Backup-Manifest", { canonical: false });
  const gameManifest = validateGameBackupManifest(gameManifestArtifact.value, gameDump);
  const gameOperationArtifact = await stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_BACKUP_OPERATION_PATH"), "Game-Backup-Operationsbeleg", { canonical: false });
  const gameOperation = validateGameBackupOperation(gameOperationArtifact.value, {
    dumpSha256: gameDump.sha256,
    manifestSha256: gameManifestArtifact.sha256,
  });
  const gameBackupManifestArtifact = await stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_BACKUP_MANIFEST_PATH"), "Semantisches Game-Backup-Manifest");
  const gameRestoreProofArtifact = await stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORE_PROOF_PATH"), "Game-Restore-Proof");
  const rollbackProofArtifact = await stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_DATABASE_ROLLBACK_PROOF_PATH"), "Datenbank-Rollback-Proof");
  const { proof: rollbackProof } = parseCanonicalDatabaseRollbackProof(rollbackProofArtifact.bytes, { candidateReleaseId, releaseId: candidateReleaseId, previousReleaseId });
  invariant(rollbackProof.backupManifestSha256 === gameBackupManifestArtifact.sha256 && sameValue(rollbackProof.backupManifest, gameBackupManifestArtifact.value), "Rollback-Proof bindet nicht das bereitgestellte semantische Game-Backup-Manifest.");
  invariant(rollbackProof.restoreProofSha256 === gameRestoreProofArtifact.sha256 && sameValue(rollbackProof.restoreProof, gameRestoreProofArtifact.value), "Rollback-Proof bindet nicht den bereitgestellten Game-Restore-Proof.");
  invariant(gameManifest.migrationCount === rollbackProof.source.migrationLedger.length, "Game-Dump und Rollback-Proof binden verschiedene Migrationsstaende.");
  invariant(rollbackProof.backupManifest.backupId === gameOperation.backupId, "Game-Backup-Operationsbeleg gehoert nicht zum im Rollback-Proof gebundenen Backup.");
  invariant(
    rollbackProof.backupManifest.backupStartedWalLsn === gameOperation.backupStartedWalLsn
      && rollbackProof.backupManifest.backupCompletedWalLsn === gameOperation.backupCompletedWalLsn
      && Date.parse(rollbackProof.backupManifest.completedAt) === Date.parse(gameOperation.completedAt),
    "Game-Backup-Operationsbeleg und Rollback-Proof binden nicht dieselbe abgeschlossene Backup-Operation.",
  );
  const runtimeRollbackEvidence = await loadRuntimeRollbackEvidence({
    environment,
    candidateReleaseId,
    previousReleaseId,
    expectedDatabaseRollbackArtifact: rollbackProofArtifact,
  });
  const gameRestoreDatabaseUrl = requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORED_DATABASE_URL");
  const gameRestoreDatabase = requiredDatabaseName(databaseNameFromUrl(gameRestoreDatabaseUrl), "Game-Recovery-Datenbank", "zugfolge_recovery_v1_");
  const gameRestoreReceiptArtifact = await stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORE_RECEIPT_PATH"), "Game-Recovery-Restore-Receipt");
  validateGameRecoveryRestoreReceipt(gameRestoreReceiptArtifact.value, {
    database: gameRestoreDatabase,
    dumpSha256: gameDump.sha256,
    manifestSha256: gameManifestArtifact.sha256,
    migrationCount: gameManifest.migrationCount,
    recoveryId,
  });
  const gameInspection = await inspectGameRestore(gameRestoreDatabaseUrl, postgresFactory);
  invariant(sameValue(gameInspection.snapshot, rollbackProof.source), "Neu isolierter Game-Restore weicht vom vor Cutover qualifizierten Kopf ab.");
  const gameEndpointSha256 = databaseEndpointSha256(gameRestoreDatabaseUrl);
  invariant(gameEndpointSha256 !== quiescence.gameDatabase.endpointSha256, "Game-Recovery wuerde die gesperrte V2-Live-Datenbank wiederverwenden.");

  const odooDatabaseDump = await stableRegularFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_DATABASE_DUMP_PATH"), "Odoo-Recovery-Datenbankdump", { retainBytes: false });
  const odooFilestoreArchive = await stableRegularFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_FILESTORE_ARCHIVE_PATH"), "Odoo-Recovery-Filestorearchiv", { retainBytes: false });
  const odooBackupManifestArtifact = await stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_BACKUP_MANIFEST_PATH"), "Odoo-Backup-Manifest", { canonical: false });
  const odooBackupManifest = validateOdooBackupManifest(odooBackupManifestArtifact.value, odooDatabaseDump, odooFilestoreArchive);
  const odooRestoreDatabaseUrl = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORED_DATABASE_URL");
  const odooRestoreDatabase = requiredDatabaseName(databaseNameFromUrl(odooRestoreDatabaseUrl), "Odoo-Recovery-Datenbank", "zugfolge_odoo_recovery_v1_");
  const odooRestoreReceiptArtifact = await stableJsonFile(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORE_RECEIPT_PATH"), "Odoo-Recovery-Restore-Receipt");
  validateOdooRecoveryRestoreReceipt(odooRestoreReceiptArtifact.value, {
    authoritativeStateSha256: odooBackupManifest.authoritativeStateSha256,
    database: odooRestoreDatabase,
    databaseSha256: odooDatabaseDump.sha256,
    filestoreArchiveSha256: odooFilestoreArchive.sha256,
    filestoreTreeSha256: odooBackupManifest.filestoreTreeSha256,
    recoveryId,
  });
  const odooFilestorePath = await containedRecoveryFilestore(
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_FILESTORE_ROOT"),
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORED_FILESTORE_PATH"),
    odooRestoreDatabase,
  );
  const odooInspection = await inspectOdooRestore({ databaseUrl: odooRestoreDatabaseUrl, filestorePath: odooFilestorePath }, postgresFactory);
  invariant(odooInspection.database === odooRestoreDatabase, "Odoo-Inspektion lief gegen eine andere Recovery-Datenbank.");
  invariant(odooInspection.authoritativeStateSha256 === odooBackupManifest.authoritativeStateSha256, "Odoo-Recovery-Datenbank weicht vom qualifizierten Zustand ab.");
  invariant(odooInspection.filestore.treeSha256 === odooBackupManifest.filestoreTreeSha256, "Odoo-Recovery-Filestore weicht vom qualifizierten Baum ab.");
  const odooEndpointSha256 = databaseEndpointSha256(odooRestoreDatabaseUrl);
  invariant(odooEndpointSha256 !== quiescence.odooDatabase.endpointSha256, "Odoo-Recovery wuerde die gesperrte V2-Live-Datenbank wiederverwenden.");

  const [gameTargetFence, odooTargetFence] = await Promise.all([
    sealDatabase({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORE_ADMIN_DATABASE_URL"),
      database: gameRestoreDatabase,
    }, postgresFactory),
    sealDatabase({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORE_ADMIN_DATABASE_URL"),
      database: odooRestoreDatabase,
    }, postgresFactory),
  ]);
  validateFence(gameTargetFence, "Game-Recovery-Target-Fence");
  validateFence(odooTargetFence, "Odoo-Recovery-Target-Fence");
  invariant(gameTargetFence.endpointSha256 === gameEndpointSha256 && gameTargetFence.backendSha256 === gameInspection.backendSha256, "Game-Recovery-Fence gehoert nicht zum qualifizierten Restore-Endpunkt.");
  invariant(odooTargetFence.endpointSha256 === odooEndpointSha256 && odooTargetFence.backendSha256 === odooInspection.backendSha256, "Odoo-Recovery-Fence gehoert nicht zum qualifizierten Restore-Endpunkt.");

  const payload = {
    candidateReleaseId,
    game: {
      backupOperationSha256: gameOperationArtifact.sha256,
      backupManifestSha256: gameBackupManifestArtifact.sha256,
      database: gameRestoreDatabase,
      databaseRollbackProofHash: rollbackProof.proofHash,
      databaseRollbackProofSha256: rollbackProofArtifact.sha256,
      dumpBytes: Number(gameDump.metadata.size),
      dumpSha256: gameDump.sha256,
      endpointSha256: gameEndpointSha256,
      rawManifestSha256: gameManifestArtifact.sha256,
      restoreProofSha256: gameRestoreProofArtifact.sha256,
      restoreReceiptSha256: gameRestoreReceiptArtifact.sha256,
      targetFence: gameTargetFence,
    },
    odoo: {
      attachmentCount: odooInspection.attachmentCount,
      authoritativeStateSha256: odooInspection.authoritativeStateSha256,
      backupManifestSha256: odooBackupManifestArtifact.sha256,
      database: odooRestoreDatabase,
      databaseDumpBytes: Number(odooDatabaseDump.metadata.size),
      databaseDumpSha256: odooDatabaseDump.sha256,
      endpointSha256: odooEndpointSha256,
      filestoreArchiveBytes: Number(odooFilestoreArchive.metadata.size),
      filestoreArchiveSha256: odooFilestoreArchive.sha256,
      filestoreFileCount: odooInspection.filestore.fileCount,
      filestorePath: odooFilestorePath.replaceAll("\\", "/"),
      filestoreTreeSha256: odooInspection.filestore.treeSha256,
      restoreReceiptSha256: odooRestoreReceiptArtifact.sha256,
      targetFence: odooTargetFence,
    },
    previousReleaseId,
    qualifiedAt: canonicalInstant(now().toISOString(), "Recovery-Qualifikationszeitpunkt"),
    quiescence: { receiptHash: quiescence.receiptHash, sha256: quiescenceArtifact.sha256 },
    recoveryId,
    runtimeRollback: runtimeRollbackEvidence.binding,
    schema: RECOVERY_SCHEMA,
  };
  const receipt = validateProductionRecoveryReceipt({ ...payload, receiptHash: canonicalHashWithout(payload, "receiptHash") });
  const receiptBytes = serializeMapReleaseBuildEvidence(receipt);
  const promotion = promotionArtifact(receipt, sha256Bytes(receiptBytes));
  const promotionBytes = serializeMapReleaseBuildEvidence(promotion);
  const inputArtifacts = [
    quiescenceArtifact,
    gameDump,
    gameManifestArtifact,
    gameOperationArtifact,
    gameBackupManifestArtifact,
    gameRestoreProofArtifact,
    rollbackProofArtifact,
    gameRestoreReceiptArtifact,
    odooDatabaseDump,
    odooFilestoreArchive,
    odooBackupManifestArtifact,
    odooRestoreReceiptArtifact,
    ...runtimeRollbackEvidence.artifacts.filter(({ path }) => path !== rollbackProofArtifact.path),
  ];
  const verifyInputs = async () => {
    await Promise.all(inputArtifacts.map((artifact) => assertArtifactUnchanged(artifact, `Recovery-Eingabe '${basename(artifact.path)}'`, { retainBytes: artifact.bytes !== undefined })));
    const currentFilestore = await inspectFilestoreTree(odooFilestorePath);
    invariant(currentFilestore.treeSha256 === odooInspection.filestore.treeSha256 && currentFilestore.fileCount === odooInspection.filestore.fileCount, "Odoo-Recovery-Filestore aenderte sich vor der Publikation.");
    const [currentLiveGameFence, currentLiveOdooFence, currentGameTargetFence, currentOdooTargetFence] = await Promise.all([
      inspectDatabaseFence({
        adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_LIVE_ADMIN_DATABASE_URL"),
        database: quiescence.gameDatabase.database,
      }, postgresFactory),
      inspectDatabaseFence({
        adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_LIVE_ADMIN_DATABASE_URL"),
        database: quiescence.odooDatabase.database,
      }, postgresFactory),
      inspectDatabaseFence({
        adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORE_ADMIN_DATABASE_URL"),
        database: gameRestoreDatabase,
      }, postgresFactory),
      inspectDatabaseFence({
        adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORE_ADMIN_DATABASE_URL"),
        database: odooRestoreDatabase,
      }, postgresFactory),
    ]);
    assertFenceStillClosed(quiescence.gameDatabase, currentLiveGameFence, "Game-V2-Live-Datenbank-Fence");
    assertFenceStillClosed(quiescence.odooDatabase, currentLiveOdooFence, "Odoo-V2-Live-Datenbank-Fence");
    assertFenceStillClosed(gameTargetFence, currentGameTargetFence, "Game-V1-Recovery-Datenbank-Fence");
    assertFenceStillClosed(odooTargetFence, currentOdooTargetFence, "Odoo-V1-Recovery-Datenbank-Fence");
  };
  await publishCreateNew([
    { path: receiptOutputPath, bytes: receiptBytes },
    { path: promotionOutputPath, bytes: promotionBytes },
  ], verifyInputs);
  return Object.freeze({
    promotionHash: promotion.promotionHash,
    promotionOutputPath: resolve(promotionOutputPath),
    receiptHash: receipt.receiptHash,
    receiptOutputPath: resolve(receiptOutputPath),
  });
}

function databaseActionEvidence(value, label) {
  exactKeys(value, [
    "activeClientBackends",
    "allowConnections",
    "backendSha256",
    "connectionLimit",
    "currentWalLsn",
    "database",
    "endpointSha256",
  ], label);
  requiredDatabaseName(value.database, `${label}.database`);
  invariant(Number.isSafeInteger(value.activeClientBackends) && value.activeClientBackends >= 0, `${label} besitzt keine gueltige Sitzungszahl.`);
  invariant(typeof value.allowConnections === "boolean" && Number.isSafeInteger(value.connectionLimit), `${label} besitzt keinen gueltigen Verbindungszustand.`);
  pgLsnValue(value.currentWalLsn, `${label}.currentWalLsn`);
  invariant(SHA256.test(value.backendSha256) && SHA256.test(value.endpointSha256), `${label} bindet Endpunkt/Backend nicht bytegenau.`);
  return value;
}

export function validateProductionRecoveryActionReceipt(value) {
  exactKeys(value, [
    "action",
    "activationIntent",
    "actionReceiptHash",
    "candidateReleaseId",
    "completedAt",
    "gameDatabase",
    "odooDatabase",
    "odooFilestore",
    "previousReleaseId",
    "promotionHash",
    "promotionSha256",
    "recoveryId",
    "recoveryReceiptHash",
    "recoveryReceiptSha256",
    "runtimeRollback",
    "schema",
  ], "Production-Recovery-Aktionsbeleg");
  requiredRecoveryAction(value.action);
  invariant(STATIC_RECOVERY_RECEIPT_ACTIONS.includes(value.action), "Statischer Production-Recovery-Aktionsbeleg darf keine Continuity-Aktion behaupten.");
  requiredRecoveryId(value.recoveryId);
  requiredReleasePair(value.candidateReleaseId, value.previousReleaseId);
  invariant(value.schema === RECOVERY_ACTION_SCHEMA, "Production-Recovery-Aktionsbeleg besitzt ein unbekanntes Schema.");
  databaseActionEvidence(value.gameDatabase, "Game-Aktionszustand");
  databaseActionEvidence(value.odooDatabase, "Odoo-Aktionszustand");
  if (value.action === "activate") {
    exactKeys(value.activationIntent, ["intentHash", "sha256"], "Recovery-Aktivierungs-Intent-Bindung");
    invariant(SHA256.test(value.activationIntent.intentHash) && SHA256.test(value.activationIntent.sha256), "Aktivierungsbeleg bindet den durable Intent nicht bytegenau.");
    for (const state of [value.gameDatabase, value.odooDatabase]) {
      invariant(state.allowConnections === true && state.activeClientBackends === 0 && (state.connectionLimit === -1 || state.connectionLimit > 0), "Aktivierungsbeleg beweist keine exakt geoeffnete Recovery-Datenbank.");
    }
  } else {
    invariant(value.activationIntent === null, "Prepared-/Preflight-Beleg darf keinen Aktivierungs-Intent vortaeuschen.");
    for (const state of [value.gameDatabase, value.odooDatabase]) {
      invariant(state.allowConnections === false && state.activeClientBackends === 0 && state.connectionLimit === 0, "Prepared-/Preflight-Beleg beweist keine geschlossene Recovery-Datenbank-Fence.");
    }
  }
  exactKeys(value.odooFilestore, ["access", "containerPath", "fileCount", "ownerGid", "ownerUid", "treeSha256"], "Odoo-Aktions-Filestore");
  invariant(typeof value.odooFilestore.containerPath === "string" && value.odooFilestore.containerPath !== "", "Odoo-Aktions-Filestore besitzt keinen Containerpfad.");
  invariant(Number.isSafeInteger(value.odooFilestore.fileCount) && value.odooFilestore.fileCount >= 0, "Odoo-Aktions-Filestore besitzt keine gueltige Dateizahl.");
  invariant(Number.isSafeInteger(value.odooFilestore.ownerUid) && value.odooFilestore.ownerUid >= 0 && Number.isSafeInteger(value.odooFilestore.ownerGid) && value.odooFilestore.ownerGid >= 0, "Odoo-Aktions-Filestore besitzt keine gebundene Runtime-Ownership.");
  invariant(value.odooFilestore.access === (value.action === "activate" ? "owner-writable" : "read-only"), "Odoo-Aktions-Filestore besitzt nicht den aktionsgerechten Zugriffsmodus.");
  for (const hash of [
    value.odooFilestore.treeSha256,
    value.promotionHash,
    value.promotionSha256,
    value.recoveryReceiptHash,
    value.recoveryReceiptSha256,
  ]) invariant(SHA256.test(hash), "Production-Recovery-Aktionsbeleg besitzt eine ungueltige SHA-256-Bindung.");
  validateRuntimeRollbackBinding(value.runtimeRollback, "Production-Recovery-Aktions-Runtime-Rollback-Bindung");
  canonicalInstant(value.completedAt, "Recovery-Aktionszeitpunkt");
  invariant(SHA256.test(value.actionReceiptHash) && value.actionReceiptHash === canonicalHashWithout(value, "actionReceiptHash"), "Production-Recovery-Aktionsbeleg besitzt keinen gueltigen kanonischen Hash.");
  return value;
}

async function loadProductionRecoveryActivationEvidence(environment) {
  const recoveryId = requiredRecoveryId(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID"));
  const candidateReleaseId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID");
  const previousReleaseId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID");
  requiredReleasePair(candidateReleaseId, previousReleaseId);
  const evidenceRoot = requiredEnvironment(environment, "PRODUCTION_RECOVERY_EVIDENCE_ROOT");
  const receiptPath = await containedEvidenceArtifact(
    evidenceRoot,
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_RECEIPT_PATH"),
    "Production-Recovery-Receipt",
  );
  const promotionPath = await containedEvidenceArtifact(
    evidenceRoot,
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_PROMOTION_PATH"),
    "Production-Recovery-Promotion",
  );
  const quiescencePath = await containedEvidenceArtifact(
    evidenceRoot,
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_QUIESCENCE_PATH"),
    "Production-Quiescence-Receipt",
  );
  invariant(new Set([receiptPath, promotionPath, quiescencePath]).size === 3, "Recovery-Aktivierung braucht drei getrennte Eingabeartefakte.");
  const [receiptArtifact, promotionArtifactInput, quiescenceArtifact] = await Promise.all([
    stableJsonFile(receiptPath, "Production-Recovery-Receipt"),
    stableJsonFile(promotionPath, "Production-Recovery-Promotion"),
    stableJsonFile(quiescencePath, "Production-Quiescence-Receipt"),
  ]);
  const receipt = validateProductionRecoveryReceipt(receiptArtifact.value, { recoveryId });
  invariant(receipt.candidateReleaseId === candidateReleaseId && receipt.previousReleaseId === previousReleaseId, "Production-Recovery-Receipt gehoert zu einem anderen Releasepaar.");
  const promotion = validateProductionRecoveryPromotion(promotionArtifactInput.value, { candidateReleaseId, previousReleaseId, recoveryId });
  const quiescence = validateProductionQuiescenceReceipt(quiescenceArtifact.value, { candidateReleaseId, previousReleaseId, recoveryId });
  const gameRestoreDatabase = requiredDatabaseName(requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORE_DATABASE"), "Explizite Game-Recovery-Datenbank", "zugfolge_recovery_v1_");
  const odooRestoreDatabase = requiredDatabaseName(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORE_DATABASE"), "Explizite Odoo-Recovery-Datenbank", "zugfolge_odoo_recovery_v1_");
  const runtimeRollbackEvidence = await loadRuntimeRollbackEvidence({ environment, candidateReleaseId, previousReleaseId });
  invariant(receipt.quiescence.receiptHash === quiescence.receiptHash && receipt.quiescence.sha256 === quiescenceArtifact.sha256, "Production-Recovery-Receipt bindet nicht den bereitgestellten Quiescence-Beleg.");
  invariant(promotion.receiptHash === receipt.receiptHash && promotion.receiptSha256 === receiptArtifact.sha256, "Production-Recovery-Promotion bindet nicht die bereitgestellten Receipt-Bytes.");
  invariant(
    promotion.gameDatabase === receipt.game.database
      && promotion.gameEndpointSha256 === receipt.game.endpointSha256
      && promotion.odooDatabase === receipt.odoo.database
      && promotion.odooEndpointSha256 === receipt.odoo.endpointSha256
      && promotion.odooFilestorePath === receipt.odoo.filestorePath,
    "Production-Recovery-Promotion und Receipt binden verschiedene Recovery-Ziele.",
  );
  invariant(
    gameRestoreDatabase === receipt.game.database
      && gameRestoreDatabase === promotion.gameDatabase
      && odooRestoreDatabase === receipt.odoo.database
      && odooRestoreDatabase === promotion.odooDatabase,
    "Explizite Recovery-Datenbanknamen, Receipt und Promotion binden verschiedene Startziele.",
  );
  invariant(
    sameValue(receipt.runtimeRollback, runtimeRollbackEvidence.binding)
      && sameValue(promotion.runtimeRollback, runtimeRollbackEvidence.binding),
    "Receipt, Promotion und aktuell verifizierte Runtime-Rollback-Attestation binden verschiedene Legacy-Runtime-Tuples.",
  );
  const inputArtifacts = Object.freeze([receiptArtifact, promotionArtifactInput, quiescenceArtifact, ...runtimeRollbackEvidence.artifacts]);
  invariant(new Set(inputArtifacts.map(({ path }) => path)).size === inputArtifacts.length, "Recovery-Aktivierung braucht getrennte Attestation-/Receipt-/Promotion-Eingabeartefakte.");
  return Object.freeze({
    candidateReleaseId,
    evidenceRoot,
    gameRestoreDatabase,
    inputArtifacts,
    previousReleaseId,
    promotion,
    promotionArtifact: promotionArtifactInput,
    quiescence,
    receipt,
    receiptArtifact,
    recoveryId,
    odooRestoreDatabase,
    runtimeRollbackEvidence,
  });
}

async function assertActivationArtifactsUnchanged(evidence) {
  await Promise.all(evidence.inputArtifacts.map((artifact) => assertArtifactUnchanged(artifact, `Recovery-Aktivierungseingabe '${basename(artifact.path)}'`)));
}

function requiredNumericIdentity(environment, name) {
  const raw = requiredEnvironment(environment, name);
  invariant(/^(0|[1-9][0-9]{0,9})$/u.test(raw), `${name} ist keine kanonische numerische Identitaet.`);
  const value = Number(raw);
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647, `${name} liegt ausserhalb des zulaessigen Bereichs.`);
  return value;
}

function requiredActionDeadline(environment) {
  const raw = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ACTION_TIMEOUT_MS");
  invariant(/^[1-9][0-9]{3,4}$/u.test(raw), "PRODUCTION_RECOVERY_ACTION_TIMEOUT_MS ist nicht kanonisch.");
  const value = Number(raw);
  invariant(Number.isSafeInteger(value) && value >= 1_000 && value <= 60_000, "PRODUCTION_RECOVERY_ACTION_TIMEOUT_MS muss zwischen 1000 und 60000 liegen.");
  return value;
}

async function withDeadline(operation, deadlineMs, label) {
  let timeout;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((resolvePromise, rejectPromise) => {
        void resolvePromise;
        timeout = setTimeout(() => {
          controller.abort();
          rejectPromise(new Error(`${label} ueberschritt die harte Deadline von ${deadlineMs} ms.`));
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function odooRuntimeOwner(environment) {
  return Object.freeze({
    gid: requiredNumericIdentity(environment, "PRODUCTION_RECOVERY_ODOO_RUNTIME_GID"),
    uid: requiredNumericIdentity(environment, "PRODUCTION_RECOVERY_ODOO_RUNTIME_UID"),
  });
}

function assertActivationFilestore(receipt, filestore, containerPath, expectedAccess, owner) {
  invariant(filestore.root === containerPath, "Odoo-Recovery-Filestore wurde nicht ueber den festgelegten Containerpfad geprueft.");
  invariant(filestore.treeSha256 === receipt.odoo.filestoreTreeSha256, "Odoo-Recovery-Containerfilestore weicht vom qualifizierten Receipt ab.");
  invariant(filestore.fileCount === receipt.odoo.filestoreFileCount, "Odoo-Recovery-Containerfilestore besitzt eine andere Dateizahl als das qualifizierte Receipt.");
  invariant(filestore.ownerUid === owner.uid && filestore.ownerGid === owner.gid, "Odoo-Recovery-Containerfilestore gehoert nicht der explizit gebundenen Odoo-Runtime-Identitaet.");
  if (expectedAccess !== "any") invariant(filestore.access === expectedAccess, "Odoo-Recovery-Containerfilestore besitzt nicht den erwarteten Zugriffsmodus.");
}

async function inspectActivationFilestore(environment, receipt, inspectFilestore, expectedAccess, owner) {
  const containerPath = await containedRecoveryFilestore(
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_ROOT"),
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_PATH"),
    receipt.odoo.database,
  );
  const filestore = await inspectFilestore(containerPath, { expectedAccess, expectedOwner: owner });
  assertActivationFilestore(receipt, filestore, containerPath, expectedAccess, owner);
  return Object.freeze({ containerPath, filestore });
}

async function inspectContinuityFilestore(environment, receipt, inspectFilestore, expectedAccess, owner) {
  const containerPath = await containedRecoveryFilestore(
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_ROOT"),
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_PATH"),
    receipt.odoo.database,
  );
  const filestore = await inspectFilestore(containerPath, { expectedAccess, expectedOwner: owner });
  invariant(filestore.root === containerPath, "Odoo-Continuity-Filestore wurde nicht ueber den festgelegten Containerpfad geprueft.");
  invariant(filestore.ownerUid === owner.uid && filestore.ownerGid === owner.gid, "Odoo-Continuity-Filestore gehoert nicht der gebundenen Runtime-Identitaet.");
  if (expectedAccess !== "any") invariant(filestore.access === expectedAccess, "Odoo-Continuity-Filestore besitzt nicht den erwarteten Zugriffsmodus.");
  invariant(Number.isSafeInteger(filestore.fileCount) && filestore.fileCount >= 0 && SHA256.test(filestore.treeSha256), "Odoo-Continuity-Filestore besitzt keinen kanonischen Bestand.");
  return Object.freeze({ containerPath, filestore });
}

function recoveryDatabaseTargets(environment, evidence) {
  return Object.freeze({
    gameLive: Object.freeze({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_LIVE_ADMIN_DATABASE_URL"),
      expectedFence: evidence.quiescence.gameDatabase,
    }),
    gameRecovery: Object.freeze({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORE_ADMIN_DATABASE_URL"),
      expectedFence: evidence.receipt.game.targetFence,
    }),
    odooLive: Object.freeze({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_LIVE_ADMIN_DATABASE_URL"),
      expectedFence: evidence.quiescence.odooDatabase,
    }),
    odooRecovery: Object.freeze({
      adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORE_ADMIN_DATABASE_URL"),
      expectedFence: evidence.receipt.odoo.targetFence,
    }),
  });
}

async function assertCurrentWriterInventory(evidence, inspectRunningServices) {
  const services = (await inspectRunningServices(evidence.quiescence.dockerProject))
    .map(({ containerId, service }) => ({ containerId, service }))
    .sort((left, right) => left.service.localeCompare(right.service, "en"));
  for (const entry of services) {
    invariant(CONTAINER_ID.test(entry.containerId) && REQUIRED_DATABASE_SERVICES.includes(entry.service), "Aktuelles Writer-Inventar enthaelt einen unbekannten laufenden Container.");
  }
  const expected = evidence.quiescence.observedRunningServices
    .map(({ containerId, service }) => ({ containerId, service }))
    .sort((left, right) => left.service.localeCompare(right.service, "en"));
  invariant(sameValue(services, expected), "Aktuelles Writer-Inventar weicht vom quieszierten Datenbankdienst-Inventar ab.");
  return Object.freeze(services);
}

async function inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory) {
  const entries = Object.entries(targets);
  const observations = await Promise.all(entries.map(async ([name, target]) => [name, await inspectDatabaseFence({
    adminDatabaseUrl: target.adminDatabaseUrl,
    database: target.expectedFence.database,
  }, postgresFactory)]));
  return Object.freeze(Object.fromEntries(observations));
}

function assertLiveDatabasesClosed(targets, observations) {
  assertFenceStillClosed(targets.gameLive.expectedFence, observations.gameLive, "Game-V2-Live-Datenbank-Fence");
  assertFenceStillClosed(targets.odooLive.expectedFence, observations.odooLive, "Odoo-V2-Live-Datenbank-Fence");
}

function assertLiveDatabaseIdentities(targets, observations) {
  assertRecoveryDatabaseIdentity(targets.gameLive.expectedFence, observations.gameLive, "Game-Live-Datenbank");
  assertRecoveryDatabaseIdentity(targets.odooLive.expectedFence, observations.odooLive, "Odoo-Live-Datenbank");
}

function assertLiveDatabasesOpen(targets, observations) {
  assertRecoveryDatabaseOpen(targets.gameLive.expectedFence, observations.gameLive, "Game-Live-Datenbank");
  assertRecoveryDatabaseOpen(targets.odooLive.expectedFence, observations.odooLive, "Odoo-Live-Datenbank");
}

function assertRecoveryDatabasesClosed(targets, observations) {
  assertFenceStillClosed(targets.gameRecovery.expectedFence, observations.gameRecovery, "Game-V1-Recovery-Datenbank-Fence");
  assertFenceStillClosed(targets.odooRecovery.expectedFence, observations.odooRecovery, "Odoo-V1-Recovery-Datenbank-Fence");
}

function assertRecoveryDatabasesOpen(targets, observations) {
  assertRecoveryDatabaseOpen(targets.gameRecovery.expectedFence, observations.gameRecovery, "Game-V1-Recovery-Datenbank");
  assertRecoveryDatabaseOpen(targets.odooRecovery.expectedFence, observations.odooRecovery, "Odoo-V1-Recovery-Datenbank");
}

function assertRecoveryDatabaseIdentities(targets, observations) {
  assertRecoveryDatabaseIdentity(targets.gameRecovery.expectedFence, observations.gameRecovery, "Game-V1-Recovery-Datenbank");
  assertRecoveryDatabaseIdentity(targets.odooRecovery.expectedFence, observations.odooRecovery, "Odoo-V1-Recovery-Datenbank");
}

async function assertPostFenceRecoveryState({
  environment,
  evidence,
  filestore,
  inspectGameRestore,
  inspectOdooRestore,
  owner,
  postgresFactory,
}) {
  const gameDatabaseUrl = requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORED_DATABASE_URL");
  const odooDatabaseUrl = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORED_DATABASE_URL");
  invariant(databaseNameFromUrl(gameDatabaseUrl) === evidence.gameRestoreDatabase && databaseEndpointSha256(gameDatabaseUrl) === evidence.receipt.game.endpointSha256, "Post-Fence-Game-Inspektion bindet nicht den expliziten Recovery-Endpunkt.");
  invariant(databaseNameFromUrl(odooDatabaseUrl) === evidence.odooRestoreDatabase && databaseEndpointSha256(odooDatabaseUrl) === evidence.receipt.odoo.endpointSha256, "Post-Fence-Odoo-Inspektion bindet nicht den expliziten Recovery-Endpunkt.");
  const [gameInspection, odooInspection] = await Promise.all([
    inspectGameRestore(gameDatabaseUrl, postgresFactory),
    inspectOdooRestore({
      databaseUrl: odooDatabaseUrl,
      filestoreOptions: { expectedAccess: "owner-writable", expectedOwner: owner },
      filestorePath: filestore.containerPath,
    }, postgresFactory),
  ]);
  invariant(gameInspection.backendSha256 === evidence.receipt.game.targetFence.backendSha256, "Post-Fence-Game-Inspektion lief gegen ein anderes PostgreSQL-Backend.");
  invariant(sameValue(gameInspection.snapshot, evidence.runtimeRollbackEvidence.databaseRollbackProof.source), "Post-Fence-Game-Zustand weicht vom signiert attestierten Rollback-Kopf ab.");
  invariant(odooInspection.database === evidence.odooRestoreDatabase && odooInspection.backendSha256 === evidence.receipt.odoo.targetFence.backendSha256, "Post-Fence-Odoo-Inspektion lief gegen ein anderes Recovery-Ziel.");
  invariant(odooInspection.authoritativeStateSha256 === evidence.receipt.odoo.authoritativeStateSha256, "Post-Fence-Odoo-Zustand weicht vom qualifizierten Receipt ab.");
  invariant(odooInspection.attachmentCount === evidence.receipt.odoo.attachmentCount, "Post-Fence-Odoo-Anhangsbestand weicht vom qualifizierten Receipt ab.");
  invariant(odooInspection.filestore.treeSha256 === evidence.receipt.odoo.filestoreTreeSha256 && odooInspection.filestore.fileCount === evidence.receipt.odoo.filestoreFileCount, "Post-Fence-Odoo-Filestore weicht vom qualifizierten Receipt ab.");
}

function actionDatabaseEvidence(observed) {
  return Object.freeze({
    activeClientBackends: observed.activeClientBackends,
    allowConnections: observed.allowConnections,
    backendSha256: observed.backendSha256,
    connectionLimit: observed.connectionLimit,
    currentWalLsn: observed.currentWalLsn,
    database: observed.database,
    endpointSha256: observed.endpointSha256,
  });
}

function canonicalNonnegativeIntegerString(value, label) {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  invariant(/^(?:0|[1-9][0-9]*)$/u.test(normalized), `${label} ist keine kanonische nichtnegative Ganzzahl.`);
  return normalized;
}

function gameContinuityContract(snapshot) {
  exactKeys(snapshot, ["authoritativeHead", "constraints", "databaseIdentity", "guards", "heads", "keycloakIdentityHead", "migrationLedger"], "Legacy-Continuity-Datenbanksnapshot");
  invariant(UUID.test(snapshot.databaseIdentity), "Legacy-Continuity-Datenbanksnapshot besitzt keine persistente Datenbankidentitaet.");
  const authoritative = snapshot.authoritativeHead;
  exactKeys(authoritative, ["domainEventCount", "regionalStateCount", "schema", "stateHash", "tableCount", "tableSetSha256", "worldCount"], "Legacy-Continuity-Authoritative-Head");
  invariant(SHA256.test(authoritative.tableSetSha256), "Legacy-Continuity-Tabellenvertrag besitzt keinen Kataloghash.");
  const keycloakObjectCatalogSha256 = snapshot.keycloakIdentityHead?.objectCatalogSha256;
  invariant(SHA256.test(keycloakObjectCatalogSha256), "Legacy-Continuity-Keycloak-Schema besitzt keinen Objektkataloghash.");
  invariant(SHA256.test(snapshot.keycloakIdentityHead?.stateHash), "Legacy-Continuity-Keycloak-Identitaet besitzt keinen vollstaendigen Zustandshash.");
  return Object.freeze({
    authoritativeContract: Object.freeze({
      regionalStateCount: authoritative.regionalStateCount,
      schema: authoritative.schema,
      tableCount: authoritative.tableCount,
      tableSetSha256: authoritative.tableSetSha256,
      worldCount: authoritative.worldCount,
    }),
    constraints: snapshot.constraints,
    databaseIdentity: snapshot.databaseIdentity,
    guards: snapshot.guards,
    heads: snapshot.heads,
    keycloakObjectCatalogSha256,
    migrationLedger: snapshot.migrationLedger,
  });
}

function normalizeGameContinuityHead(inspection, evidence) {
  exactKeys(inspection, ["regions", "snapshot", "world"], "Legacy-Continuity-Inspektion");
  const proofSnapshot = evidence.runtimeRollbackEvidence.databaseRollbackProof.source;
  const currentContract = gameContinuityContract(inspection.snapshot);
  const proofContract = gameContinuityContract(proofSnapshot);
  invariant(sameValue(currentContract, proofContract), "Legacy-Continuation veraenderte Datenbankidentitaet, Schema-, Guard- oder Katalogvertrag.");
  const expectedWorld = evidence.runtimeRollbackEvidence.worldDeployment;
  const world = inspection.world;
  exactKeys(world, ["epoch", "lifecycle_status", "ranking_status", "schedule_period_weeks", "world_id", "world_kind"], "Legacy-Continuity-Welt");
  invariant(world.world_id === expectedWorld.worldId && world.epoch === expectedWorld.worldEpoch, "Legacy-Continuation bindet eine andere Welt oder Weltepoche.");
  invariant(["active", "archived"].includes(world.lifecycle_status), "Legacy-Continuity-Welt besitzt keinen fortsetzbaren Lifecycle.");
  invariant(["ranked", "unranked"].includes(world.ranking_status) && ["public", "private"].includes(world.world_kind), "Legacy-Continuity-Welt besitzt einen unbekannten Weltvertrag.");
  invariant(Number.isSafeInteger(world.schedule_period_weeks) && world.schedule_period_weeks >= 3 && world.schedule_period_weeks <= 8, "Legacy-Continuity-Welt besitzt keine gueltige Fahrplanperiode.");
  invariant(Array.isArray(inspection.regions), "Legacy-Continuity-Regionalkopf fehlt.");
  invariant(inspection.regions.length > 0 && inspection.regions.length <= inspection.snapshot.heads.total, "Legacy-Continuity-Welt besitzt keine belegbare regionale Kopfmenge.");
  const regions = inspection.regions.map((row) => {
    exactKeys(row, ["initialization_hash", "publisher_sequence", "region_id", "revision", "state_hash", "state_schema", "world_id"], "Legacy-Continuity-Region");
    invariant(row.world_id === expectedWorld.worldId, "Legacy-Continuation enthaelt einen Regionalkopf aus einer anderen Welt.");
    invariant(typeof row.region_id === "string" && row.region_id.length > 0 && row.region_id.length <= 200, "Legacy-Continuation besitzt keine sichere Regions-ID.");
    invariant(row.state_schema === "zugfolge-regional-simulation-state/v1" && row.initialization_hash === null, "Legacy-Continuation veraenderte den attestierten V1-Regionalvertrag.");
    invariant(SHA256.test(row.state_hash), "Legacy-Continuation besitzt keinen gueltigen Regional-State-Hash.");
    const revision = canonicalNonnegativeIntegerString(row.revision, "Legacy-Continuity.revision");
    const publisherSequence = canonicalNonnegativeIntegerString(row.publisher_sequence, "Legacy-Continuity.publisherSequence");
    invariant(revision === publisherSequence, "Legacy-Continuation besitzt eine Revision-/Publishersequenz-Luecke.");
    return Object.freeze({
      initializationHash: null,
      publisherSequence,
      regionId: row.region_id,
      revision,
      stateHash: row.state_hash,
      stateSchema: row.state_schema,
      worldId: row.world_id,
    });
  }).sort((left, right) => left.regionId.localeCompare(right.regionId, "en"));
  invariant(new Set(regions.map(({ regionId }) => regionId)).size === regions.length, "Legacy-Continuation besitzt doppelte Regionalkoepfe.");
  return Object.freeze(validateGameContinuityHead({
    authoritativeStateHash: inspection.snapshot.authoritativeHead.stateHash,
    databaseIdentity: currentContract.databaseIdentity,
    domainEventCount: canonicalNonnegativeIntegerString(inspection.snapshot.authoritativeHead.domainEventCount, "Legacy-Continuity.domainEventCount"),
    immutableContractSha256: canonicalValueSha256(currentContract),
    keycloakIdentityStateHash: inspection.snapshot.keycloakIdentityHead.stateHash,
    regions,
    world: {
      epoch: world.epoch,
      lifecycleStatus: world.lifecycle_status,
      rankingStatus: world.ranking_status,
      schedulePeriodWeeks: world.schedule_period_weeks,
      worldId: world.world_id,
      worldKind: world.world_kind,
    },
  }));
}

function validateGameContinuityHead(value) {
  exactKeys(value, ["authoritativeStateHash", "databaseIdentity", "domainEventCount", "immutableContractSha256", "keycloakIdentityStateHash", "regions", "world"], "Legacy-Continuity-Game-Head");
  invariant(UUID.test(value.databaseIdentity) && SHA256.test(value.immutableContractSha256), "Legacy-Continuity-Game-Head bindet Datenbank/Vertrag nicht exakt.");
  invariant(SHA256.test(value.authoritativeStateHash) && SHA256.test(value.keycloakIdentityStateHash), "Legacy-Continuity-Game-Head bindet Game-/Keycloak-Zustand nicht vollstaendig.");
  canonicalNonnegativeIntegerString(value.domainEventCount, "Legacy-Continuity-Game-Head.domainEventCount");
  exactKeys(value.world, ["epoch", "lifecycleStatus", "rankingStatus", "schedulePeriodWeeks", "worldId", "worldKind"], "Legacy-Continuity-Weltbindung");
  invariant(UUID.test(value.world.worldId), "Legacy-Continuity-Weltbindung besitzt keine UUID.");
  canonicalInstant(value.world.epoch, "Legacy-Continuity-Weltepoche");
  invariant(["active", "archived"].includes(value.world.lifecycleStatus), "Legacy-Continuity-Weltbindung besitzt keinen gueltigen Lifecycle.");
  invariant(["ranked", "unranked"].includes(value.world.rankingStatus) && ["public", "private"].includes(value.world.worldKind), "Legacy-Continuity-Weltbindung besitzt einen unbekannten Weltvertrag.");
  invariant(Number.isSafeInteger(value.world.schedulePeriodWeeks) && value.world.schedulePeriodWeeks >= 3 && value.world.schedulePeriodWeeks <= 8, "Legacy-Continuity-Weltbindung besitzt keine gueltige Fahrplanperiode.");
  invariant(Array.isArray(value.regions), "Legacy-Continuity-Game-Head besitzt keine Regionen.");
  let previousRegionId;
  for (const region of value.regions) {
    exactKeys(region, ["initializationHash", "publisherSequence", "regionId", "revision", "stateHash", "stateSchema", "worldId"], "Legacy-Continuity-Regionalkopf");
    invariant(region.worldId === value.world.worldId && region.stateSchema === "zugfolge-regional-simulation-state/v1" && region.initializationHash === null, "Legacy-Continuity-Regionalkopf bindet einen fremden Welt-/Schemavertrag.");
    invariant(typeof region.regionId === "string" && region.regionId.length > 0 && region.regionId.length <= 200 && region.regionId !== previousRegionId, "Legacy-Continuity-Regionalkopf ist nicht eindeutig sortiert.");
    invariant(previousRegionId === undefined || previousRegionId.localeCompare(region.regionId, "en") < 0, "Legacy-Continuity-Regionalkoepfe sind nicht kanonisch sortiert.");
    const revision = canonicalNonnegativeIntegerString(region.revision, "Legacy-Continuity-Region.revision");
    const publisher = canonicalNonnegativeIntegerString(region.publisherSequence, "Legacy-Continuity-Region.publisherSequence");
    invariant(revision === publisher && SHA256.test(region.stateHash), "Legacy-Continuity-Regionalkopf besitzt keine publishergleiche Revision.");
    previousRegionId = region.regionId;
  }
  return value;
}

function assertGameContinuityMonotone(previous, current, label = "Legacy-Continuation", { requireExactMutableHeads = false } = {}) {
  validateGameContinuityHead(previous);
  validateGameContinuityHead(current);
  invariant(
    previous.databaseIdentity === current.databaseIdentity
      && previous.immutableContractSha256 === current.immutableContractSha256
      && sameValue(previous.world, current.world),
    `${label} wechselte Datenbank-, Schema-/Guard- oder Weltursprung.`,
  );
  invariant(previous.regions.length === current.regions.length, `${label} veraenderte die attestierte Regionsmenge.`);
  for (let index = 0; index < previous.regions.length; index += 1) {
    const before = previous.regions[index];
    const after = current.regions[index];
    invariant(before.regionId === after.regionId && before.worldId === after.worldId && before.stateSchema === after.stateSchema && before.initializationHash === after.initializationHash, `${label} veraenderte eine Regionsidentitaet.`);
    invariant(BigInt(after.revision) >= BigInt(before.revision) && BigInt(after.publisherSequence) >= BigInt(before.publisherSequence), `${label} besitzt einen rueckwaerts laufenden Revision-/Publisherkopf.`);
    if (after.revision === before.revision) invariant(after.stateHash === before.stateHash, `${label} veraenderte einen State-Hash ohne neue Revision.`);
  }
  invariant(BigInt(current.domainEventCount) >= BigInt(previous.domainEventCount), `${label} besitzt einen rueckwaerts laufenden Domain-Event-Kopf.`);
  if (requireExactMutableHeads) {
    invariant(sameValue(previous, current), `${label} veraenderte einen versiegelten Game-/Keycloak-Kopf vor dem Writerstart.`);
  }
}

function validateOdooContinuityHead(value, label = "Legacy-Continuity-Odoo-Head") {
  exactKeys(value, ["attachmentCount", "authoritativeStateSha256"], label);
  invariant(Number.isSafeInteger(value.attachmentCount) && value.attachmentCount >= 0, `${label} besitzt keine gueltige Anhangszahl.`);
  invariant(SHA256.test(value.authoritativeStateSha256), `${label} besitzt keinen vollstaendigen autoritativen Zustandshash.`);
  return value;
}

function assertOdooContinuityExact(previous, current, label = "Legacy-Continuation") {
  validateOdooContinuityHead(previous, `${label}-Vorgaenger-Odoo-Head`);
  validateOdooContinuityHead(current, `${label}-Aktueller-Odoo-Head`);
  invariant(sameValue(previous, current), `${label} veraenderte einen versiegelten Odoo-Datenbankkopf vor dem Writerstart.`);
}

function assertDatabaseEvidenceMonotone(previous, current, label) {
  databaseActionEvidence(previous, `${label}-Vorgaenger`);
  databaseActionEvidence(current, `${label}-Aktuell`);
  invariant(previous.database === current.database && previous.backendSha256 === current.backendSha256 && previous.endpointSha256 === current.endpointSha256, `${label} wechselte Datenbank, Backend oder Endpunkt.`);
  invariant(pgLsnValue(current.currentWalLsn, `${label}.currentWalLsn`) >= pgLsnValue(previous.currentWalLsn, `${label}.previousWalLsn`), `${label} besitzt einen rueckwaerts laufenden WAL-Kopf.`);
}

function transitionFilestoreEvidence(filestore) {
  return Object.freeze({
    access: filestore.filestore.access,
    containerPath: filestore.containerPath.replaceAll("\\", "/"),
    fileCount: filestore.filestore.fileCount,
    ownerGid: filestore.filestore.ownerGid,
    ownerUid: filestore.filestore.ownerUid,
    treeSha256: filestore.filestore.treeSha256,
  });
}

function normalizeOdooContinuityHead(inspection, evidence, filestore) {
  exactKeys(inspection, ["attachmentCount", "authoritativeStateSha256", "backendSha256", "database", "endpointSha256", "filestore"], "Legacy-Continuity-Odoo-Inspektion");
  invariant(
    inspection.database === evidence.odooRestoreDatabase
      && inspection.backendSha256 === evidence.receipt.odoo.targetFence.backendSha256
      && inspection.endpointSha256 === evidence.receipt.odoo.endpointSha256,
    "Legacy-Continuation inspizierte einen fremden Odoo-Datenbank-/Backendursprung.",
  );
  invariant(
    inspection.filestore.fileCount === filestore.filestore.fileCount
      && inspection.filestore.treeSha256 === filestore.filestore.treeSha256,
    "Legacy-Continuation-Odoo-Datenbankkopf und Filestore-Inspektion widersprechen sich.",
  );
  return Object.freeze(validateOdooContinuityHead({
    attachmentCount: inspection.attachmentCount,
    authoritativeStateSha256: inspection.authoritativeStateSha256,
  }));
}

async function inspectOpenContinuityHeads({
  environment,
  evidence,
  filestore,
  inspectGameContinuity,
  inspectOdooRestore,
  owner,
  postgresFactory,
}) {
  const gameDatabaseUrl = requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORED_DATABASE_URL");
  const odooDatabaseUrl = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORED_DATABASE_URL");
  invariant(databaseNameFromUrl(gameDatabaseUrl) === evidence.gameRestoreDatabase && databaseEndpointSha256(gameDatabaseUrl) === evidence.receipt.game.endpointSha256, "Recovery-Continuity-Game-Inspektion bindet nicht den attestierten Recovery-Endpunkt.");
  invariant(databaseNameFromUrl(odooDatabaseUrl) === evidence.odooRestoreDatabase && databaseEndpointSha256(odooDatabaseUrl) === evidence.receipt.odoo.endpointSha256, "Recovery-Continuity-Odoo-Inspektion bindet nicht den attestierten Recovery-Endpunkt.");
  const [gameInspection, odooInspection] = await Promise.all([
    inspectGameContinuity({ databaseUrl: gameDatabaseUrl, worldId: evidence.runtimeRollbackEvidence.worldDeployment.worldId }, postgresFactory),
    inspectOdooRestore({
      databaseUrl: odooDatabaseUrl,
      filestoreOptions: { expectedAccess: "owner-writable", expectedOwner: owner },
      filestorePath: filestore.containerPath,
    }, postgresFactory),
  ]);
  return Object.freeze({
    gameHead: normalizeGameContinuityHead(gameInspection, evidence),
    odooHead: normalizeOdooContinuityHead(odooInspection, evidence, filestore),
  });
}

function productionRecoveryActivationIntent({ evidence, filestore, observations, now }) {
  const payload = {
    candidateReleaseId: evidence.candidateReleaseId,
    createdAt: canonicalInstant(now().toISOString(), "Recovery-Aktivierungs-Intent-Zeitpunkt"),
    gameDatabase: actionDatabaseEvidence(observations.gameRecovery),
    odooDatabase: actionDatabaseEvidence(observations.odooRecovery),
    odooFilestore: {
      access: filestore.filestore.access,
      containerPath: filestore.containerPath.replaceAll("\\", "/"),
      fileCount: filestore.filestore.fileCount,
      ownerGid: filestore.filestore.ownerGid,
      ownerUid: filestore.filestore.ownerUid,
      treeSha256: filestore.filestore.treeSha256,
    },
    previousReleaseId: evidence.previousReleaseId,
    promotionHash: evidence.promotion.promotionHash,
    promotionSha256: evidence.promotionArtifact.sha256,
    recoveryId: evidence.recoveryId,
    recoveryReceiptHash: evidence.receipt.receiptHash,
    recoveryReceiptSha256: evidence.receiptArtifact.sha256,
    runtimeRollback: evidence.receipt.runtimeRollback,
    schema: RECOVERY_ACTIVATION_INTENT_SCHEMA,
  };
  const intent = { ...payload, intentHash: canonicalHashWithout(payload, "intentHash") };
  return Object.freeze(validateProductionRecoveryActivationIntent(intent));
}

export function validateProductionRecoveryActivationIntent(intent, expected = {}) {
  exactKeys(intent, [
    "candidateReleaseId",
    "createdAt",
    "gameDatabase",
    "intentHash",
    "odooDatabase",
    "odooFilestore",
    "previousReleaseId",
    "promotionHash",
    "promotionSha256",
    "recoveryId",
    "recoveryReceiptHash",
    "recoveryReceiptSha256",
    "runtimeRollback",
    "schema",
  ], "Production-Recovery-Aktivierungs-Intent");
  invariant(intent.schema === RECOVERY_ACTIVATION_INTENT_SCHEMA && SHA256.test(intent.intentHash) && intent.intentHash === canonicalHashWithout(intent, "intentHash"), "Production-Recovery-Aktivierungs-Intent ist nicht kanonisch gebunden.");
  requiredRecoveryId(intent.recoveryId);
  requiredReleasePair(intent.candidateReleaseId, intent.previousReleaseId);
  if (expected.recoveryId !== undefined) invariant(intent.recoveryId === expected.recoveryId, "Production-Recovery-Aktivierungs-Intent gehoert zu einer anderen Recovery.");
  if (expected.candidateReleaseId !== undefined) invariant(intent.candidateReleaseId === expected.candidateReleaseId, "Production-Recovery-Aktivierungs-Intent gehoert zu einem anderen Kandidatenrelease.");
  if (expected.previousReleaseId !== undefined) invariant(intent.previousReleaseId === expected.previousReleaseId, "Production-Recovery-Aktivierungs-Intent gehoert zu einem anderen Vorgaengerrelease.");
  canonicalInstant(intent.createdAt, "Recovery-Aktivierungs-Intent-Zeitpunkt");
  for (const hash of [
    intent.promotionHash,
    intent.promotionSha256,
    intent.recoveryReceiptHash,
    intent.recoveryReceiptSha256,
  ]) invariant(SHA256.test(hash), "Production-Recovery-Aktivierungs-Intent besitzt eine ungueltige SHA-256-Bindung.");
  validateRuntimeRollbackBinding(intent.runtimeRollback, "Production-Recovery-Aktivierungs-Intent-Runtime-Rollback-Bindung");
  databaseActionEvidence(intent.gameDatabase, "Game-Aktivierungs-Intent-Zustand");
  databaseActionEvidence(intent.odooDatabase, "Odoo-Aktivierungs-Intent-Zustand");
  invariant(intent.gameDatabase.allowConnections === false && intent.gameDatabase.connectionLimit === 0 && intent.odooDatabase.allowConnections === false && intent.odooDatabase.connectionLimit === 0, "Production-Recovery-Aktivierungs-Intent wurde nicht aus geschlossenen Recovery-Datenbanken erzeugt.");
  exactKeys(intent.odooFilestore, ["access", "containerPath", "fileCount", "ownerGid", "ownerUid", "treeSha256"], "Production-Recovery-Aktivierungs-Intent-Filestore");
  invariant(intent.odooFilestore.access === "read-only", "Production-Recovery-Aktivierungs-Intent wurde nicht aus einem read-only Filestore erzeugt.");
  invariant(typeof intent.odooFilestore.containerPath === "string" && intent.odooFilestore.containerPath !== "", "Production-Recovery-Aktivierungs-Intent bindet keinen Container-Filestorepfad.");
  invariant(Number.isSafeInteger(intent.odooFilestore.fileCount) && intent.odooFilestore.fileCount >= 0 && SHA256.test(intent.odooFilestore.treeSha256), "Production-Recovery-Aktivierungs-Intent bindet keinen exakten Filestorebestand.");
  invariant(Number.isSafeInteger(intent.odooFilestore.ownerUid) && intent.odooFilestore.ownerUid >= 0 && Number.isSafeInteger(intent.odooFilestore.ownerGid) && intent.odooFilestore.ownerGid >= 0, "Production-Recovery-Aktivierungs-Intent bindet keine Odoo-Runtime-Ownership.");
  return Object.freeze(intent);
}

function assertActivationIntentArtifact({ artifact, containerPath, evidence, owner }) {
  const intent = validateProductionRecoveryActivationIntent(artifact.value, {
    candidateReleaseId: evidence.candidateReleaseId,
    previousReleaseId: evidence.previousReleaseId,
    recoveryId: evidence.recoveryId,
  });
  invariant(intent.promotionHash === evidence.promotion.promotionHash && intent.promotionSha256 === evidence.promotionArtifact.sha256, "Production-Recovery-Aktivierungs-Intent bindet eine andere Promotion.");
  invariant(intent.recoveryReceiptHash === evidence.receipt.receiptHash && intent.recoveryReceiptSha256 === evidence.receiptArtifact.sha256, "Production-Recovery-Aktivierungs-Intent bindet ein anderes Recovery-Receipt.");
  invariant(sameValue(intent.runtimeRollback, evidence.receipt.runtimeRollback), "Production-Recovery-Aktivierungs-Intent bindet ein anderes Runtime-Rollback-Tuple.");
  for (const [state, fence, label] of [
    [intent.gameDatabase, evidence.receipt.game.targetFence, "Game"],
    [intent.odooDatabase, evidence.receipt.odoo.targetFence, "Odoo"],
  ]) {
    invariant(state.database === fence.database && state.backendSha256 === fence.backendSha256 && state.endpointSha256 === fence.endpointSha256, `Production-Recovery-Aktivierungs-Intent bindet ein anderes ${label}-Recovery-Ziel.`);
    invariant(pgLsnValue(state.currentWalLsn, `${label}-Aktivierungs-Intent.currentWalLsn`) >= pgLsnValue(fence.fencedWalLsn, `${label}-Recovery-Fence.fencedWalLsn`), `Production-Recovery-Aktivierungs-Intent bindet eine rueckwaerts laufende ${label}-WAL-LSN.`);
  }
  invariant(
    intent.odooFilestore.containerPath === containerPath.replaceAll("\\", "/")
      && intent.odooFilestore.treeSha256 === evidence.receipt.odoo.filestoreTreeSha256
      && intent.odooFilestore.fileCount === evidence.receipt.odoo.filestoreFileCount
      && intent.odooFilestore.ownerUid === owner.uid
      && intent.odooFilestore.ownerGid === owner.gid,
    "Production-Recovery-Aktivierungs-Intent bindet einen anderen Container-Filestore.",
  );
  return intent;
}

function productionRecoveryActionReceipt({ action, activationIntent, evidence, filestore, observations, now }) {
  const payload = {
    action,
    activationIntent,
    candidateReleaseId: evidence.candidateReleaseId,
    completedAt: canonicalInstant(now().toISOString(), "Recovery-Aktionszeitpunkt"),
    gameDatabase: actionDatabaseEvidence(observations.gameRecovery),
    odooDatabase: actionDatabaseEvidence(observations.odooRecovery),
    odooFilestore: {
      access: filestore.filestore.access,
      containerPath: filestore.containerPath.replaceAll("\\", "/"),
      fileCount: filestore.filestore.fileCount,
      ownerGid: filestore.filestore.ownerGid,
      ownerUid: filestore.filestore.ownerUid,
      treeSha256: filestore.filestore.treeSha256,
    },
    previousReleaseId: evidence.previousReleaseId,
    promotionHash: evidence.promotion.promotionHash,
    promotionSha256: evidence.promotionArtifact.sha256,
    recoveryId: evidence.recoveryId,
    recoveryReceiptHash: evidence.receipt.receiptHash,
    recoveryReceiptSha256: evidence.receiptArtifact.sha256,
    runtimeRollback: evidence.receipt.runtimeRollback,
    schema: RECOVERY_ACTION_SCHEMA,
  };
  return Object.freeze(validateProductionRecoveryActionReceipt({ ...payload, actionReceiptHash: canonicalHashWithout(payload, "actionReceiptHash") }));
}

async function resealRecoveryDatabases({ deadlineMs, inspectDatabaseFence, postgresFactory, resealDatabase, targets }) {
  const results = await Promise.allSettled([
    withDeadline((signal) => resealDatabase({ adminDatabaseUrl: targets.gameRecovery.adminDatabaseUrl, deadlineMs, expectedFence: targets.gameRecovery.expectedFence, signal }, postgresFactory), deadlineMs, "Game-Recovery-Reseal"),
    withDeadline((signal) => resealDatabase({ adminDatabaseUrl: targets.odooRecovery.adminDatabaseUrl, deadlineMs, expectedFence: targets.odooRecovery.expectedFence, signal }, postgresFactory), deadlineMs, "Odoo-Recovery-Reseal"),
  ]);
  let observations;
  let verificationError;
  try {
    observations = await inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory);
    assertLiveDatabasesClosed(targets, observations);
    assertRecoveryDatabasesClosed(targets, observations);
  } catch (error) {
    verificationError = error;
  }
  const operationErrors = results.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
  if (verificationError !== undefined) {
    throw new AggregateError([...operationErrors, verificationError], "Gekoppelte Recovery-Ruecksperre konnte nicht bestaetigt werden.");
  }
  return observations;
}

async function resealProductionRecoveryState({
  deadlineMs,
  environment,
  evidence,
  inspectDatabaseFence,
  inspectFilestore,
  owner,
  postgresFactory,
  resealDatabase,
  setFilestoreAccess,
  targets,
}) {
  const containerPath = await containedRecoveryFilestore(
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_ROOT"),
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_PATH"),
    evidence.receipt.odoo.database,
  );
  const results = await Promise.allSettled([
    resealRecoveryDatabases({ deadlineMs, inspectDatabaseFence, postgresFactory, resealDatabase, targets }),
    withDeadline(
      (signal) => setFilestoreAccess({ containerPath, owner, signal, writable: false }),
      deadlineMs,
      "Odoo-Recovery-Filestore-Reseal",
    ),
  ]);
  let observations;
  let filestore;
  let verificationError;
  try {
    observations = await inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory);
    assertLiveDatabasesClosed(targets, observations);
    assertRecoveryDatabasesClosed(targets, observations);
    filestore = await inspectActivationFilestore(environment, evidence.receipt, inspectFilestore, "read-only", owner);
  } catch (error) {
    verificationError = error;
  }
  const operationErrors = results.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
  if (verificationError !== undefined) {
    throw new AggregateError([...operationErrors, verificationError], "Gekoppelte Recovery-Ruecksperre fuer Datenbanken und Filestore konnte nicht bestaetigt werden.");
  }
  return Object.freeze({ filestore, observations });
}

async function resealProductionRecoveryContinuityState({
  deadlineMs,
  environment,
  evidence,
  inspectDatabaseFence,
  inspectFilestore,
  owner,
  postgresFactory,
  resealDatabase,
  setFilestoreAccess,
  targets,
}) {
  const containerPath = await containedRecoveryFilestore(
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_ROOT"),
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_PATH"),
    evidence.receipt.odoo.database,
  );
  const results = await Promise.allSettled([
    resealRecoveryDatabases({ deadlineMs, inspectDatabaseFence, postgresFactory, resealDatabase, targets }),
    withDeadline(
      (signal) => setFilestoreAccess({ containerPath, owner, signal, writable: false }),
      deadlineMs,
      "Odoo-Recovery-Continuity-Filestore-Reseal",
    ),
  ]);
  let observations;
  let filestore;
  let verificationError;
  try {
    observations = await inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory);
    assertLiveDatabasesClosed(targets, observations);
    assertRecoveryDatabasesClosed(targets, observations);
    filestore = await inspectContinuityFilestore(environment, evidence.receipt, inspectFilestore, "read-only", owner);
  } catch (error) {
    verificationError = error;
  }
  const operationErrors = results.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
  if (verificationError !== undefined || operationErrors.length > 0) {
    throw new AggregateError(
      [...operationErrors, ...(verificationError === undefined ? [] : [verificationError])],
      "Gekoppelte Recovery-Continuity-Ruecksperre fuer Datenbanken und Filestore konnte nicht bestaetigt werden.",
    );
  }
  return Object.freeze({ filestore, observations });
}

async function emergencyResealContinuityFromActivation({
  deadlineMs,
  environment,
  evidenceRoot,
  inspectDatabaseFence,
  inspectFilestore,
  owner,
  postgresFactory,
  recoveryId,
  resealDatabase,
  setFilestoreAccess,
}) {
  const activationPath = await containedEvidenceArtifact(evidenceRoot, join(evidenceRoot, `${recoveryId}.activate.json`), "Notfall-Erstaktivierungsbeleg");
  const activationArtifact = await stableJsonFile(activationPath, "Notfall-Erstaktivierungsbeleg");
  const activation = validateProductionRecoveryActionReceipt(activationArtifact.value);
  invariant(activation.action === "activate" && activation.recoveryId === recoveryId, "Notfall-Reseal besitzt keinen kanonischen Erstaktivierungsbeleg.");
  const expectedFence = (state) => Object.freeze({
    ...state,
    activeClientBackends: 0,
    allowConnections: false,
    connectionLimit: 0,
    fencedWalLsn: state.currentWalLsn,
    previousConnectionLimit: state.connectionLimit,
  });
  const targets = [
    Object.freeze({ adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_RESTORE_ADMIN_DATABASE_URL"), expectedFence: expectedFence(activation.gameDatabase), label: "Game" }),
    Object.freeze({ adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_RESTORE_ADMIN_DATABASE_URL"), expectedFence: expectedFence(activation.odooDatabase), label: "Odoo" }),
  ];
  const containerPath = await containedRecoveryFilestore(
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_ROOT"),
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_PATH"),
    activation.odooDatabase.database,
  );
  const results = await Promise.allSettled([
    ...targets.map((target) => withDeadline(
      (signal) => resealDatabase({ adminDatabaseUrl: target.adminDatabaseUrl, deadlineMs, expectedFence: target.expectedFence, signal }, postgresFactory),
      deadlineMs,
      `${target.label}-Recovery-Notfall-Reseal`,
    )),
    withDeadline((signal) => setFilestoreAccess({ containerPath, owner, signal, writable: false }), deadlineMs, "Odoo-Recovery-Notfall-Filestore-Reseal"),
  ]);
  let verificationError;
  try {
    const [game, odoo, filestore] = await Promise.all([
      inspectDatabaseFence({ adminDatabaseUrl: targets[0].adminDatabaseUrl, database: targets[0].expectedFence.database }, postgresFactory),
      inspectDatabaseFence({ adminDatabaseUrl: targets[1].adminDatabaseUrl, database: targets[1].expectedFence.database }, postgresFactory),
      inspectFilestore(containerPath, { expectedAccess: "read-only", expectedOwner: owner }),
    ]);
    assertFenceStillClosed(targets[0].expectedFence, game, "Game-Recovery-Notfall-Fence");
    assertFenceStillClosed(targets[1].expectedFence, odoo, "Odoo-Recovery-Notfall-Fence");
    invariant(filestore.root === containerPath && filestore.access === "read-only", "Odoo-Recovery-Notfall-Filestore ist nicht bestaetigt read-only.");
  } catch (error) {
    verificationError = error;
  }
  const operationErrors = results.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
  if (verificationError !== undefined || operationErrors.length > 0) {
    throw new AggregateError([...operationErrors, ...(verificationError === undefined ? [] : [verificationError])], "Recovery-Continuity-Notfall-Reseal konnte nicht bestaetigt werden.");
  }
}

function assertExistingActionReceipt({ action, artifact, evidence, filestore, observations }) {
  const receipt = validateProductionRecoveryActionReceipt(artifact.value);
  invariant(receipt.action === action && receipt.recoveryId === evidence.recoveryId, "Bestehender Recovery-Aktionsbeleg gehoert zu einer anderen Aktion/Recovery.");
  invariant(receipt.candidateReleaseId === evidence.candidateReleaseId && receipt.previousReleaseId === evidence.previousReleaseId, "Bestehender Recovery-Aktionsbeleg gehoert zu einem anderen Releasepaar.");
  invariant(receipt.promotionHash === evidence.promotion.promotionHash && receipt.promotionSha256 === evidence.promotionArtifact.sha256, "Bestehender Recovery-Aktionsbeleg bindet eine andere Promotion.");
  invariant(receipt.recoveryReceiptHash === evidence.receipt.receiptHash && receipt.recoveryReceiptSha256 === evidence.receiptArtifact.sha256, "Bestehender Recovery-Aktionsbeleg bindet ein anderes Recovery-Receipt.");
  invariant(sameValue(receipt.runtimeRollback, evidence.receipt.runtimeRollback), "Bestehender Recovery-Aktionsbeleg bindet ein anderes Runtime-Rollback-Tuple.");
  for (const [stored, current, expected, label] of [
    [receipt.gameDatabase, observations.gameRecovery, evidence.receipt.game.targetFence, "Game"],
    [receipt.odooDatabase, observations.odooRecovery, evidence.receipt.odoo.targetFence, "Odoo"],
  ]) {
    invariant(stored.database === expected.database && stored.backendSha256 === expected.backendSha256 && stored.endpointSha256 === expected.endpointSha256, `Bestehender ${label}-Aktionsbeleg bindet ein anderes Recovery-Ziel.`);
    invariant(current.database === expected.database && current.backendSha256 === expected.backendSha256 && current.endpointSha256 === expected.endpointSha256, `Aktueller ${label}-Recovery-Zustand bindet ein anderes Ziel als der bestehende Aktionsbeleg.`);
  }
  invariant(
    receipt.odooFilestore.containerPath === filestore.containerPath.replaceAll("\\", "/")
      && receipt.odooFilestore.treeSha256 === filestore.filestore.treeSha256
      && receipt.odooFilestore.fileCount === filestore.filestore.fileCount
      && receipt.odooFilestore.ownerUid === filestore.filestore.ownerUid
      && receipt.odooFilestore.ownerGid === filestore.filestore.ownerGid,
    "Bestehender Recovery-Aktionsbeleg bindet einen anderen Container-Filestore.",
  );
  return receipt;
}

function continuityActivationBinding(value, label = "Recovery-Continuity-Aktivierungsbindung") {
  exactKeys(value, ["actionReceiptHash", "sha256"], label);
  invariant(SHA256.test(value.actionReceiptHash) && SHA256.test(value.sha256), `${label} ist nicht bytegenau.`);
  return value;
}

function validateContinuityFilestore(value, label, expectedAccess) {
  exactKeys(value, ["access", "containerPath", "fileCount", "ownerGid", "ownerUid", "treeSha256"], label);
  invariant(value.access === expectedAccess, `${label} besitzt nicht den aktionsgerechten Zugriffsmodus.`);
  invariant(typeof value.containerPath === "string" && value.containerPath !== "" && SHA256.test(value.treeSha256), `${label} besitzt keinen exakten Pfad-/Tree-Vertrag.`);
  invariant(Number.isSafeInteger(value.fileCount) && value.fileCount >= 0 && Number.isSafeInteger(value.ownerUid) && value.ownerUid >= 0 && Number.isSafeInteger(value.ownerGid) && value.ownerGid >= 0, `${label} besitzt keine kanonischen Dateizahl-/Ownership-Werte.`);
  return value;
}

function validateContinuityCommon(value, label) {
  requiredRecoveryId(value.recoveryId);
  requiredReleasePair(value.candidateReleaseId, value.previousReleaseId);
  invariant(value.action === "origin" || value.action === "continue" || value.action === "reseal", `${label} besitzt eine unbekannte Aktion.`);
  transitionSequence(value.sequence, `${label}.sequence`);
  transitionBinding(value.previous, `${label}.previous`, { nullable: true });
  continuityActivationBinding(value.activation, `${label}.activation`);
  validateRuntimeRollbackBinding(value.runtimeRollback, `${label}.runtimeRollback`);
  for (const hash of [value.promotionHash, value.promotionSha256, value.recoveryReceiptHash, value.recoveryReceiptSha256]) {
    invariant(SHA256.test(hash), `${label} besitzt eine ungueltige Recovery-Ursprungsbindung.`);
  }
  databaseActionEvidence(value.gameDatabase, `${label}.gameDatabase`);
  databaseActionEvidence(value.odooDatabase, `${label}.odooDatabase`);
  validateGameContinuityHead(value.gameHead);
  validateOdooContinuityHead(value.odooHead, `${label}.odooHead`);
}

export function validateProductionRecoveryContinuityIntent(value) {
  exactKeys(value, [
    "action",
    "activation",
    "candidateReleaseId",
    "createdAt",
    "gameDatabase",
    "gameHead",
    "intentHash",
    "odooDatabase",
    "odooFilestore",
    "odooHead",
    "previous",
    "previousReleaseId",
    "promotionHash",
    "promotionSha256",
    "recoveryId",
    "recoveryReceiptHash",
    "recoveryReceiptSha256",
    "runtimeRollback",
    "schema",
    "sequence",
  ], "Production-Recovery-Continuity-Intent");
  invariant(value.schema === RECOVERY_CONTINUITY_INTENT_SCHEMA && (value.action === "continue" || value.action === "reseal"), "Production-Recovery-Continuity-Intent besitzt ein unbekanntes Schema oder eine ungueltige Aktion.");
  validateContinuityCommon(value, "Production-Recovery-Continuity-Intent");
  invariant(value.sequence > 0 && value.previous !== null, "Production-Recovery-Continuity-Intent besitzt keinen belegten Vorgaenger.");
  const expectedOpen = value.action === "reseal";
  for (const state of [value.gameDatabase, value.odooDatabase]) {
    invariant(
      expectedOpen
        ? state.allowConnections === true && state.activeClientBackends === 0 && (state.connectionLimit === -1 || state.connectionLimit > 0)
        : state.allowConnections === false && state.activeClientBackends === 0 && state.connectionLimit === 0,
      "Production-Recovery-Continuity-Intent wurde nicht aus dem aktionsgerechten gekoppelten Zustand erzeugt.",
    );
  }
  validateContinuityFilestore(value.odooFilestore, "Production-Recovery-Continuity-Intent-Filestore", expectedOpen ? "owner-writable" : "read-only");
  canonicalInstant(value.createdAt, "Production-Recovery-Continuity-Intent-Zeitpunkt");
  invariant(value.intentHash === canonicalHashWithout(value, "intentHash"), "Production-Recovery-Continuity-Intent besitzt keinen gueltigen kanonischen Hash.");
  return value;
}

export function validateProductionRecoveryContinuityReceipt(value) {
  exactKeys(value, [
    "action",
    "actionReceiptHash",
    "activation",
    "candidateReleaseId",
    "completedAt",
    "gameDatabase",
    "gameHead",
    "intent",
    "odooDatabase",
    "odooFilestore",
    "odooHead",
    "previous",
    "previousReleaseId",
    "promotionHash",
    "promotionSha256",
    "recoveryId",
    "recoveryReceiptHash",
    "recoveryReceiptSha256",
    "runtimeRollback",
    "schema",
    "sequence",
  ], "Production-Recovery-Continuity-Beleg");
  invariant(value.schema === RECOVERY_CONTINUITY_ACTION_SCHEMA, "Production-Recovery-Continuity-Beleg besitzt ein unbekanntes Schema.");
  validateContinuityCommon(value, "Production-Recovery-Continuity-Beleg");
  const expectedOpen = value.action === "origin" || value.action === "continue";
  invariant(value.action === "origin" ? value.sequence === 0 && value.previous === null && value.intent === null : value.sequence > 0 && value.previous !== null, "Production-Recovery-Continuity-Beleg besitzt keinen gueltigen Ursprung/Vorgaenger.");
  if (value.action !== "origin") intentBinding(value.intent, "Production-Recovery-Continuity-Intent-Bindung");
  for (const state of [value.gameDatabase, value.odooDatabase]) {
    invariant(
      expectedOpen
        ? state.allowConnections === true && state.activeClientBackends === 0 && (state.connectionLimit === -1 || state.connectionLimit > 0)
        : state.allowConnections === false && state.activeClientBackends === 0 && state.connectionLimit === 0,
      "Production-Recovery-Continuity-Beleg beweist nicht den aktionsgerechten gekoppelten Zustand.",
    );
  }
  validateContinuityFilestore(value.odooFilestore, "Production-Recovery-Continuity-Filestore", expectedOpen ? "owner-writable" : "read-only");
  canonicalInstant(value.completedAt, "Production-Recovery-Continuity-Zeitpunkt");
  invariant(value.actionReceiptHash === canonicalHashWithout(value, "actionReceiptHash"), "Production-Recovery-Continuity-Beleg besitzt keinen gueltigen kanonischen Hash.");
  return value;
}

function continuityCommonPayload({ action, activation, evidence, filestore, gameHead, observations, odooHead, previous, sequence }) {
  return {
    action,
    activation,
    candidateReleaseId: evidence.candidateReleaseId,
    gameDatabase: actionDatabaseEvidence(observations.gameRecovery),
    gameHead,
    odooDatabase: actionDatabaseEvidence(observations.odooRecovery),
    odooFilestore: transitionFilestoreEvidence(filestore),
    odooHead,
    previous,
    previousReleaseId: evidence.previousReleaseId,
    promotionHash: evidence.promotion.promotionHash,
    promotionSha256: evidence.promotionArtifact.sha256,
    recoveryId: evidence.recoveryId,
    recoveryReceiptHash: evidence.receipt.receiptHash,
    recoveryReceiptSha256: evidence.receiptArtifact.sha256,
    runtimeRollback: evidence.receipt.runtimeRollback,
    sequence,
  };
}

function productionRecoveryContinuityIntent({ action, activation, evidence, filestore, gameHead, observations, odooHead, previous, sequence, now }) {
  const payload = {
    ...continuityCommonPayload({ action, activation, evidence, filestore, gameHead, observations, odooHead, previous, sequence }),
    createdAt: canonicalInstant(now().toISOString(), "Recovery-Continuity-Intent-Zeitpunkt"),
    schema: RECOVERY_CONTINUITY_INTENT_SCHEMA,
  };
  return Object.freeze(validateProductionRecoveryContinuityIntent({ ...payload, intentHash: canonicalHashWithout(payload, "intentHash") }));
}

function productionRecoveryContinuityReceipt({ action, activation, evidence, filestore, gameHead, intent, observations, odooHead, previous, sequence, now }) {
  const payload = {
    ...continuityCommonPayload({ action, activation, evidence, filestore, gameHead, observations, odooHead, previous, sequence }),
    completedAt: canonicalInstant(now().toISOString(), "Recovery-Continuity-Zeitpunkt"),
    intent,
    schema: RECOVERY_CONTINUITY_ACTION_SCHEMA,
  };
  return Object.freeze(validateProductionRecoveryContinuityReceipt({ ...payload, actionReceiptHash: canonicalHashWithout(payload, "actionReceiptHash") }));
}

function assertContinuityEvidenceBinding({ activationArtifact, evidence, entry }) {
  const value = entry.value;
  invariant(value.recoveryId === evidence.recoveryId && value.candidateReleaseId === evidence.candidateReleaseId && value.previousReleaseId === evidence.previousReleaseId, "Recovery-Continuity gehoert zu einer anderen Recovery-/Release-Linie.");
  invariant(value.promotionHash === evidence.promotion.promotionHash && value.promotionSha256 === evidence.promotionArtifact.sha256, "Recovery-Continuity bindet eine andere Promotion.");
  invariant(value.recoveryReceiptHash === evidence.receipt.receiptHash && value.recoveryReceiptSha256 === evidence.receiptArtifact.sha256, "Recovery-Continuity bindet ein anderes Recovery-Receipt.");
  invariant(sameValue(value.runtimeRollback, evidence.receipt.runtimeRollback), "Recovery-Continuity bindet ein anderes World-/Image-/Proof-Tuple.");
  invariant(value.activation.actionReceiptHash === activationArtifact.value.actionReceiptHash && value.activation.sha256 === activationArtifact.sha256, "Recovery-Continuity bindet einen anderen Erstaktivierungsbeleg.");
}

function assertContinuityCurrentState({ current, previous, allowFilestoreChange = false, requireExactMutableHeads = false }) {
  if (current.gameHead !== undefined) assertGameContinuityMonotone(previous.value.gameHead, current.gameHead, "Legacy-Continuation", { requireExactMutableHeads });
  if (current.odooHead !== undefined) {
    validateOdooContinuityHead(current.odooHead);
    if (requireExactMutableHeads) assertOdooContinuityExact(previous.value.odooHead, current.odooHead);
  }
  assertDatabaseEvidenceMonotone(previous.value.gameDatabase, current.observations.gameRecovery, "Game-Recovery-Continuity");
  assertDatabaseEvidenceMonotone(previous.value.odooDatabase, current.observations.odooRecovery, "Odoo-Recovery-Continuity");
  const stored = previous.value.odooFilestore;
  const observed = transitionFilestoreEvidence(current.filestore);
  invariant(stored.containerPath === observed.containerPath && stored.ownerUid === observed.ownerUid && stored.ownerGid === observed.ownerGid, "Recovery-Continuity wechselte Odoo-Filestorepfad oder Runtime-Ownership.");
  if (!allowFilestoreChange) invariant(stored.fileCount === observed.fileCount && stored.treeSha256 === observed.treeSha256, "Recovery-Continuity-Filestore driftete ohne abgeschlossene Reseal-Transition.");
}

async function loadContinuityActivationArtifact(evidence) {
  const activationPath = await containedEvidenceArtifact(
    evidence.evidenceRoot,
    join(evidence.evidenceRoot, `${evidence.recoveryId}.activate.json`),
    "Production-Recovery-Erstaktivierungsbeleg",
  );
  const artifact = await stableJsonFile(activationPath, "Production-Recovery-Erstaktivierungsbeleg");
  const receipt = validateProductionRecoveryActionReceipt(artifact.value);
  invariant(receipt.action === "activate" && receipt.recoveryId === evidence.recoveryId, "Recovery-Continuity besitzt keinen passenden Erstaktivierungsbeleg.");
  invariant(receipt.candidateReleaseId === evidence.candidateReleaseId && receipt.previousReleaseId === evidence.previousReleaseId, "Erstaktivierungsbeleg gehoert zu einer anderen Release-Linie.");
  invariant(receipt.promotionHash === evidence.promotion.promotionHash && receipt.promotionSha256 === evidence.promotionArtifact.sha256, "Erstaktivierungsbeleg bindet eine andere Promotion.");
  invariant(receipt.recoveryReceiptHash === evidence.receipt.receiptHash && receipt.recoveryReceiptSha256 === evidence.receiptArtifact.sha256, "Erstaktivierungsbeleg bindet ein anderes Recovery-Receipt.");
  invariant(sameValue(receipt.runtimeRollback, evidence.receipt.runtimeRollback), "Erstaktivierungsbeleg bindet ein anderes World-/Image-/Proof-Tuple.");
  for (const [state, expected, label] of [
    [receipt.gameDatabase, evidence.receipt.game.targetFence, "Game"],
    [receipt.odooDatabase, evidence.receipt.odoo.targetFence, "Odoo"],
  ]) {
    invariant(state.database === expected.database && state.backendSha256 === expected.backendSha256 && state.endpointSha256 === expected.endpointSha256, `Erstaktivierungsbeleg bindet ein anderes ${label}-Recovery-Ziel.`);
  }
  return Object.freeze({ ...artifact, value: receipt });
}

function assertContinuityOrigin({ activationArtifact, evidence, origin }) {
  assertContinuityEvidenceBinding({ activationArtifact, evidence, entry: origin });
  invariant(origin.sequence === 0 && origin.value.action === "origin", "Recovery-Continuity besitzt keinen kanonischen Ursprung bei Sequenz 0.");
  invariant(sameValue(origin.value.gameDatabase, activationArtifact.value.gameDatabase), "Recovery-Continuity-Ursprung bindet einen anderen Game-Aktivierungszustand.");
  invariant(sameValue(origin.value.odooDatabase, activationArtifact.value.odooDatabase), "Recovery-Continuity-Ursprung bindet einen anderen Odoo-Aktivierungszustand.");
  invariant(sameValue(origin.value.odooFilestore, activationArtifact.value.odooFilestore), "Recovery-Continuity-Ursprung bindet einen anderen Aktivierungsfilestore.");
  const expectedContractSha256 = canonicalValueSha256(gameContinuityContract(evidence.runtimeRollbackEvidence.databaseRollbackProof.source));
  invariant(origin.value.gameHead.databaseIdentity === evidence.runtimeRollbackEvidence.databaseRollbackProof.source.databaseIdentity, "Recovery-Continuity-Ursprung bindet eine fremde Datenbankinstanz.");
  invariant(origin.value.gameHead.immutableContractSha256 === expectedContractSha256, "Recovery-Continuity-Ursprung bindet einen fremden Schema-/Guard-Vertrag.");
  invariant(origin.value.gameHead.world.worldId === evidence.runtimeRollbackEvidence.worldDeployment.worldId && origin.value.gameHead.world.epoch === evidence.runtimeRollbackEvidence.worldDeployment.worldEpoch, "Recovery-Continuity-Ursprung bindet eine andere Welt oder Weltepoche.");
  invariant(origin.value.gameHead.authoritativeStateHash === evidence.runtimeRollbackEvidence.databaseRollbackProof.source.authoritativeHead.stateHash, "Recovery-Continuity-Ursprung bindet einen anderen autoritativen Game-Kopf.");
  invariant(origin.value.gameHead.keycloakIdentityStateHash === evidence.runtimeRollbackEvidence.databaseRollbackProof.source.keycloakIdentityHead.stateHash, "Recovery-Continuity-Ursprung bindet einen anderen Keycloak-Identitaetskopf.");
  invariant(origin.value.odooHead.authoritativeStateSha256 === evidence.receipt.odoo.authoritativeStateSha256 && origin.value.odooHead.attachmentCount === evidence.receipt.odoo.attachmentCount, "Recovery-Continuity-Ursprung bindet einen anderen Odoo-Datenbankkopf.");
}

function assertContinuityTransition(previous, current, { allowFilestoreChange }) {
  const requireExactMutableHeads = previous.action === "reseal";
  assertGameContinuityMonotone(previous.value.gameHead, current.value.gameHead, "Legacy-Continuation", { requireExactMutableHeads });
  validateOdooContinuityHead(current.value.odooHead);
  if (requireExactMutableHeads) assertOdooContinuityExact(previous.value.odooHead, current.value.odooHead);
  assertDatabaseEvidenceMonotone(previous.value.gameDatabase, current.value.gameDatabase, "Game-Recovery-Continuity-Beleg");
  assertDatabaseEvidenceMonotone(previous.value.odooDatabase, current.value.odooDatabase, "Odoo-Recovery-Continuity-Beleg");
  const before = previous.value.odooFilestore;
  const after = current.value.odooFilestore;
  invariant(before.containerPath === after.containerPath && before.ownerUid === after.ownerUid && before.ownerGid === after.ownerGid, "Recovery-Continuity-Beleg wechselte Filestorepfad oder Runtime-Ownership.");
  if (!allowFilestoreChange) invariant(before.fileCount === after.fileCount && before.treeSha256 === after.treeSha256, "Recovery-Continuity-Beleg veraenderte einen versiegelten Filestore.");
}

function assertContinuityChain({ activationArtifact, chain, evidence }) {
  invariant(chain.receipts.length > 0, "Recovery-Continuity-Ursprungsbeleg fehlt.");
  const origin = chain.receipts[0];
  assertContinuityOrigin({ activationArtifact, evidence, origin });
  for (let index = 1; index < chain.receipts.length; index += 1) {
    const previous = chain.receipts[index - 1];
    const current = chain.receipts[index];
    const expectedAction = previous.action === "reseal" ? "continue" : "reseal";
    invariant(current.action === expectedAction, "Recovery-Continuity besitzt keine streng alternierende Stop-/Startfolge.");
    assertContinuityEvidenceBinding({ activationArtifact, evidence, entry: current });
    assertContinuityTransition(previous, current, { allowFilestoreChange: previous.action !== "reseal" });
  }
  for (const intent of chain.intents) {
    assertContinuityEvidenceBinding({ activationArtifact, evidence, entry: intent });
    const previous = chain.receipts.find(({ sequence }) => sequence === intent.sequence - 1);
    invariant(previous !== undefined, "Recovery-Continuity-Intent besitzt keinen belegten Vorgaenger.");
    const expectedAction = previous.action === "reseal" ? "continue" : "reseal";
    invariant(intent.action === expectedAction, "Recovery-Continuity-Intent widerspricht der streng alternierenden Stop-/Startfolge.");
    assertContinuityTransition(previous, intent, { allowFilestoreChange: previous.action !== "reseal" });
  }
  return origin;
}

function recoveryContinuityPhase(targets, observations, filestore) {
  let open = false;
  let closed = false;
  try {
    assertRecoveryDatabasesOpen(targets, observations);
    invariant(filestore.filestore.access === "owner-writable", "Geoeffnete Recovery-Datenbanken besitzen keinen schreibbaren Odoo-Filestore.");
    open = true;
  } catch { /* Die geschlossene Kopplung wird getrennt geprueft. */ }
  try {
    assertRecoveryDatabasesClosed(targets, observations);
    invariant(filestore.filestore.access === "read-only", "Geschlossene Recovery-Datenbanken besitzen keinen read-only Odoo-Filestore.");
    closed = true;
  } catch { /* Die offene Kopplung wurde getrennt geprueft. */ }
  invariant(open !== closed, "Recovery-Continuity befindet sich in einer Teiloeffnung oder einem widerspruechlichen Filestorezustand.");
  return open ? "open" : "closed";
}

async function executeProductionRecoveryContinuityAction({
  action,
  actionReceiptAnchor,
  deadlineMs,
  environment,
  evidence,
  inspectDatabaseFence,
  inspectFilestore,
  inspectGameContinuity,
  inspectOdooRestore,
  inspectRunningServices,
  openDatabase,
  owner,
  postgresFactory,
  resealDatabase,
  setFilestoreAccess,
  targets,
  now,
}) {
  invariant(action === "continue" || action === "reseal", "Recovery-Continuity besitzt eine unbekannte Aktion.");
  const compensate = () => resealProductionRecoveryContinuityState({
    deadlineMs,
    environment,
    evidence,
    inspectDatabaseFence,
    inspectFilestore,
    owner,
    postgresFactory,
    resealDatabase,
    setFilestoreAccess,
    targets,
  });
  let activationArtifact;
  let chain;
  let state;

  const inspectBoundState = async () => {
    await assertActivationArtifactsUnchanged(evidence);
    await assertArtifactUnchanged(activationArtifact, "Production-Recovery-Erstaktivierungsbeleg");
    await assertCurrentWriterInventory(evidence, inspectRunningServices);
    const [filestore, observations] = await Promise.all([
      inspectContinuityFilestore(environment, evidence.receipt, inspectFilestore, "any", owner),
      inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory),
    ]);
    assertLiveDatabasesClosed(targets, observations);
    assertRecoveryDatabaseIdentities(targets, observations);
    const phase = recoveryContinuityPhase(targets, observations, filestore);
    let gameHead;
    let odooHead;
    if (phase === "open") {
      ({ gameHead, odooHead } = await inspectOpenContinuityHeads({
        environment,
        evidence,
        filestore,
        inspectGameContinuity,
        inspectOdooRestore,
        owner,
        postgresFactory,
      }));
    }
    return Object.freeze({ filestore, gameHead, observations, odooHead, phase });
  };

  const assertIntentStateUnchanged = (intent, current) => {
    assertContinuityCurrentState({ current, previous: intent, allowFilestoreChange: false, requireExactMutableHeads: true });
  };

  try {
    await assertCreateNewPathAvailable(actionReceiptAnchor, "Legacy-Recovery-Continuity-Aktionsbeleganker");
    activationArtifact = await loadContinuityActivationArtifact(evidence);
    chain = await loadTransitionChain({
      actions: ["origin", "continue", "reseal"],
      evidenceRoot: evidence.evidenceRoot,
      firstAction: "origin",
      firstSequence: 0,
      namespace: "continuity",
      recoveryId: evidence.recoveryId,
      validateIntent: validateProductionRecoveryContinuityIntent,
      validateReceipt: validateProductionRecoveryContinuityReceipt,
    });
    assertContinuityChain({ activationArtifact, chain, evidence });
    state = await inspectBoundState();
    const last = chain.receipts.at(-1);
    invariant(last !== undefined, "Recovery-Continuity-Ursprungsbeleg fehlt.");
    const expectedLastPhase = last.action === "reseal" ? "closed" : "open";
    if (chain.pendingIntent === undefined) {
      invariant(state.phase === expectedLastPhase, "Recovery-Continuity-Kopf und gekoppelte physische Oeffnung widersprechen sich.");
      assertContinuityCurrentState({ current: state, previous: last, allowFilestoreChange: expectedLastPhase === "open" });
      if (last.action === action) {
        assertContinuityCurrentState({ current: state, previous: last, allowFilestoreChange: false, requireExactMutableHeads: true });
        await assertArtifactUnchanged(last.artifact, "Bestehender Recovery-Continuity-Beleg");
        return Object.freeze({
          action,
          actionReceiptHash: last.value.actionReceiptHash,
          actionReceiptOutputPath: resolve(last.artifact.path),
          promotionHash: evidence.promotion.promotionHash,
          replayed: true,
          recoveryId: evidence.recoveryId,
          sequence: last.sequence,
        });
      }
    } else {
      invariant(chain.pendingIntent.action === action, "Recovery-Continuity besitzt einen Intent-Fork fuer eine andere Aktion.");
      const sourcePhase = action === "reseal" ? "open" : "closed";
      const targetPhase = action === "reseal" ? "closed" : "open";
      invariant(state.phase === sourcePhase || state.phase === targetPhase, "Recovery-Continuity-Intent trifft auf eine Teiloeffnung.");
      assertIntentStateUnchanged(chain.pendingIntent, state);
    }
    const expectedAction = last.action === "reseal" ? "continue" : "reseal";
    invariant(action === expectedAction, "Recovery-Continuity-Aktion widerspricht der erreichten streng alternierenden Stop-/Startfolge.");
  } catch (error) {
    try {
      await compensate();
    } catch (resealError) {
      throw new AggregateError([error, resealError], "Recovery-Continuity war ungueltig und Ziele/Filestore konnten nicht bestaetigt rueckgesperrt werden.");
    }
    throw new AggregateError([error], "Recovery-Continuity war ungueltig; Ziele und Filestore wurden fail-closed rueckgesperrt.");
  }

  const previousEntry = chain.receipts.at(-1);
  const previous = Object.freeze({
    actionReceiptHash: previousEntry.value.actionReceiptHash,
    sequence: previousEntry.sequence,
    sha256: previousEntry.artifact.sha256,
  });
  const sequence = previousEntry.sequence + 1;
  const intentPath = transitionArtifactPath(evidence.evidenceRoot, evidence.recoveryId, "continuity", sequence, action, "intent");
  const receiptPath = transitionArtifactPath(evidence.evidenceRoot, evidence.recoveryId, "continuity", sequence, action, "receipt");
  const activation = Object.freeze({ actionReceiptHash: activationArtifact.value.actionReceiptHash, sha256: activationArtifact.sha256 });
  let intentEntry = chain.pendingIntent;
  if (intentEntry === undefined) {
    try {
      const sourcePhase = action === "reseal" ? "open" : "closed";
      invariant(state.phase === sourcePhase, "Neue Recovery-Continuity-Aktion startet nicht aus ihrem belegten Quellzustand.");
      const gameHead = state.gameHead ?? previousEntry.value.gameHead;
      const odooHead = state.odooHead ?? previousEntry.value.odooHead;
      const intent = productionRecoveryContinuityIntent({ action, activation, evidence, filestore: state.filestore, gameHead, observations: state.observations, odooHead, previous, sequence, now });
      const intentBytes = serializeMapReleaseBuildEvidence(intent);
      await publishCreateNew([{ path: intentPath, bytes: intentBytes }], async () => {
        const current = await inspectBoundState();
        invariant(current.phase === sourcePhase, "Recovery-Continuity wechselte vor der Intent-Publikation den gekoppelten Zustand.");
        assertIntentStateUnchanged({ value: intent }, current);
      });
      const artifact = await stableJsonFile(intentPath, "Production-Recovery-Continuity-Intent");
      intentEntry = Object.freeze({ action, artifact, kind: "intent", sequence, value: validateProductionRecoveryContinuityIntent(artifact.value) });
    } catch (error) {
      try { await compensate(); } catch (resealError) { throw new AggregateError([error, resealError], "Recovery-Continuity-Intent scheiterte und Ziele/Filestore konnten nicht bestaetigt rueckgesperrt werden."); }
      throw error;
    }
  }
  const targetPhase = action === "reseal" ? "closed" : "open";
  const intentBindingValue = Object.freeze({ intentHash: intentEntry.value.intentHash, sha256: intentEntry.artifact.sha256 });
  let finalState;
  let finalGameHead;
  let finalOdooHead;

  try {
    state = await inspectBoundState();
    assertIntentStateUnchanged(intentEntry, state);
    if (state.phase !== targetPhase) {
      if (action === "reseal") {
        const resealed = await resealProductionRecoveryContinuityState({
          deadlineMs,
          environment,
          evidence,
          inspectDatabaseFence,
          inspectFilestore,
          owner,
          postgresFactory,
          resealDatabase,
          setFilestoreAccess,
          targets,
        });
        finalState = Object.freeze({ ...resealed, gameHead: undefined, phase: "closed" });
      } else {
        await withDeadline(
          (signal) => setFilestoreAccess({ containerPath: state.filestore.containerPath, owner, signal, writable: true }),
          deadlineMs,
          "Odoo-Recovery-Continuity-Filestore-Oeffnung",
        );
        const openingResults = await Promise.allSettled([
          withDeadline((signal) => openDatabase({ adminDatabaseUrl: targets.gameRecovery.adminDatabaseUrl, deadlineMs, expectedFence: targets.gameRecovery.expectedFence, signal }, postgresFactory), deadlineMs, "Game-Recovery-Continuation"),
          withDeadline((signal) => openDatabase({ adminDatabaseUrl: targets.odooRecovery.adminDatabaseUrl, deadlineMs, expectedFence: targets.odooRecovery.expectedFence, signal }, postgresFactory), deadlineMs, "Odoo-Recovery-Continuation"),
        ]);
        const openingErrors = openingResults.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
        if (openingErrors.length > 0) throw new AggregateError(openingErrors, "Gekoppelte Recovery-Continuation konnte nicht vollstaendig geoeffnet werden.");
      }
    }
    if (finalState === undefined) finalState = await inspectBoundState();
    else {
      await assertActivationArtifactsUnchanged(evidence);
      await assertArtifactUnchanged(activationArtifact, "Production-Recovery-Erstaktivierungsbeleg");
      await assertCurrentWriterInventory(evidence, inspectRunningServices);
    }
    invariant(finalState.phase === targetPhase, "Recovery-Continuity erreichte ihren gekoppelten Zielzustand nicht.");
    assertIntentStateUnchanged(intentEntry, finalState);
    finalGameHead = finalState.gameHead ?? intentEntry.value.gameHead;
    finalOdooHead = finalState.odooHead ?? intentEntry.value.odooHead;

    const receipt = productionRecoveryContinuityReceipt({
      action,
      activation,
      evidence,
      filestore: finalState.filestore,
      gameHead: finalGameHead,
      intent: intentBindingValue,
      observations: finalState.observations,
      odooHead: finalOdooHead,
      previous,
      sequence,
      now,
    });
    await publishCreateNew([{ path: receiptPath, bytes: serializeMapReleaseBuildEvidence(receipt) }], async () => {
      const current = await inspectBoundState();
      invariant(current.phase === targetPhase, "Recovery-Continuity-Ziel driftete vor der Receipt-Publikation.");
      assertContinuityCurrentState({ current, previous: { value: receipt }, allowFilestoreChange: false, requireExactMutableHeads: true });
    });
    return Object.freeze({
      action,
      actionReceiptHash: receipt.actionReceiptHash,
      actionReceiptOutputPath: resolve(receiptPath),
      promotionHash: evidence.promotion.promotionHash,
      replayed: false,
      recoveryId: evidence.recoveryId,
      sequence,
    });
  } catch (error) {
    try {
      await compensate();
    } catch (resealError) {
      throw new AggregateError([error, resealError], "Recovery-Continuity scheiterte und Ziele/Filestore konnten nicht bestaetigt rueckgesperrt werden.");
    }
    throw error;
  }
}

function requiredRecoverySourceAction(value) {
  invariant(value === "release" || value === "reseal", "Recovery-Source-Aktion muss 'release' oder 'reseal' sein.");
  return value;
}

function sourceCommonPayload({ action, evidence, filestore, observations, previous, sequence }) {
  return {
    action,
    candidateReleaseId: evidence.candidateReleaseId,
    gameLiveDatabase: actionDatabaseEvidence(observations.gameLive),
    gameRecoveryDatabase: actionDatabaseEvidence(observations.gameRecovery),
    odooFilestore: transitionFilestoreEvidence(filestore),
    odooLiveDatabase: actionDatabaseEvidence(observations.odooLive),
    odooRecoveryDatabase: actionDatabaseEvidence(observations.odooRecovery),
    previous,
    previousReleaseId: evidence.previousReleaseId,
    promotionHash: evidence.promotion.promotionHash,
    promotionSha256: evidence.promotionArtifact.sha256,
    recoveryId: evidence.recoveryId,
    recoveryReceiptHash: evidence.receipt.receiptHash,
    recoveryReceiptSha256: evidence.receiptArtifact.sha256,
    runtimeRollback: evidence.receipt.runtimeRollback,
    sequence,
  };
}

function productionRecoverySourceIntent({ action, evidence, filestore, observations, previous, sequence, now }) {
  const payload = {
    ...sourceCommonPayload({ action, evidence, filestore, observations, previous, sequence }),
    createdAt: canonicalInstant(now().toISOString(), "Recovery-Source-Intent-Zeitpunkt"),
    schema: RECOVERY_SOURCE_INTENT_SCHEMA,
  };
  return Object.freeze(validateProductionRecoverySourceIntent({ ...payload, intentHash: canonicalHashWithout(payload, "intentHash") }));
}

export function validateProductionRecoverySourceIntent(value) {
  exactKeys(value, [
    "action", "candidateReleaseId", "createdAt", "gameLiveDatabase", "gameRecoveryDatabase", "intentHash",
    "odooFilestore", "odooLiveDatabase", "odooRecoveryDatabase", "previous", "previousReleaseId",
    "promotionHash", "promotionSha256", "recoveryId", "recoveryReceiptHash",
    "recoveryReceiptSha256", "runtimeRollback", "schema", "sequence",
  ], "Production-Recovery-Source-Intent");
  requiredRecoverySourceAction(value.action);
  requiredRecoveryId(value.recoveryId);
  requiredReleasePair(value.candidateReleaseId, value.previousReleaseId);
  invariant(value.schema === RECOVERY_SOURCE_INTENT_SCHEMA, "Production-Recovery-Source-Intent besitzt ein unbekanntes Schema.");
  transitionSequence(value.sequence, "Production-Recovery-Source-Intent.sequence");
  transitionBinding(value.previous, "Production-Recovery-Source-Intent.previous", { nullable: true });
  invariant(value.sequence === 1 ? value.action === "release" && value.previous === null : value.sequence > 1 && value.previous !== null, "Production-Recovery-Source-Intent besitzt keinen gueltigen Ursprung/Vorgaenger.");
  const expectedLiveOpen = value.action === "reseal";
  for (const state of [value.gameLiveDatabase, value.odooLiveDatabase]) {
    databaseActionEvidence(state, "Live-Source-Intent-Zustand");
    invariant(expectedLiveOpen
      ? state.allowConnections === true && state.activeClientBackends === 0 && (state.connectionLimit === -1 || state.connectionLimit > 0)
      : state.allowConnections === false && state.activeClientBackends === 0 && state.connectionLimit === 0,
    "Recovery-Source-Intent wurde nicht aus dem aktionsgerechten Live-Zustand erzeugt.");
  }
  for (const state of [value.gameRecoveryDatabase, value.odooRecoveryDatabase]) {
    databaseActionEvidence(state, "Recovery-Source-Intent-Zustand");
    invariant(state.allowConnections === false && state.activeClientBackends === 0 && state.connectionLimit === 0, "Recovery-Source-Intent wurde nicht mit geschlossenen V1-Zielen erzeugt.");
  }
  validateContinuityFilestore(value.odooFilestore, "Recovery-Source-Intent-Filestore", "read-only");
  for (const hash of [value.intentHash, value.promotionHash, value.promotionSha256, value.recoveryReceiptHash, value.recoveryReceiptSha256]) invariant(SHA256.test(hash), "Recovery-Source-Intent besitzt eine ungueltige SHA-256-Bindung.");
  validateRuntimeRollbackBinding(value.runtimeRollback, "Recovery-Source-Intent-Runtime-Rollback-Bindung");
  canonicalInstant(value.createdAt, "Recovery-Source-Intent-Zeitpunkt");
  invariant(value.intentHash === canonicalHashWithout(value, "intentHash"), "Recovery-Source-Intent besitzt keinen gueltigen kanonischen Hash.");
  return value;
}

function productionRecoverySourceActionReceipt({ action, evidence, filestore, intent, observations, previous, sequence, now }) {
  const payload = {
    ...sourceCommonPayload({ action, evidence, filestore, observations, previous, sequence }),
    completedAt: canonicalInstant(now().toISOString(), "Recovery-Source-Aktionszeitpunkt"),
    intent,
    schema: RECOVERY_SOURCE_ACTION_SCHEMA,
  };
  return Object.freeze(validateProductionRecoverySourceActionReceipt({ ...payload, actionReceiptHash: canonicalHashWithout(payload, "actionReceiptHash") }));
}

export function validateProductionRecoverySourceActionReceipt(value) {
  exactKeys(value, [
    "action", "actionReceiptHash", "candidateReleaseId", "completedAt", "gameLiveDatabase",
    "gameRecoveryDatabase", "intent", "odooFilestore", "odooLiveDatabase", "odooRecoveryDatabase",
    "previous", "previousReleaseId", "promotionHash", "promotionSha256", "recoveryId",
    "recoveryReceiptHash", "recoveryReceiptSha256", "runtimeRollback", "schema", "sequence",
  ], "Production-Recovery-Source-Aktionsbeleg");
  requiredRecoverySourceAction(value.action);
  requiredRecoveryId(value.recoveryId);
  requiredReleasePair(value.candidateReleaseId, value.previousReleaseId);
  invariant(value.schema === RECOVERY_SOURCE_ACTION_SCHEMA, "Production-Recovery-Source-Aktionsbeleg besitzt ein unbekanntes Schema.");
  transitionSequence(value.sequence, "Production-Recovery-Source-Aktionsbeleg.sequence");
  transitionBinding(value.previous, "Production-Recovery-Source-Aktionsbeleg.previous", { nullable: true });
  invariant(value.sequence === 1 ? value.action === "release" && value.previous === null : value.sequence > 1 && value.previous !== null, "Production-Recovery-Source-Aktionsbeleg besitzt keinen gueltigen Ursprung/Vorgaenger.");
  intentBinding(value.intent, "Recovery-Source-Intent-Bindung");
  for (const [state, label] of [[value.gameLiveDatabase, "Game-Live"], [value.odooLiveDatabase, "Odoo-Live"], [value.gameRecoveryDatabase, "Game-Recovery"], [value.odooRecoveryDatabase, "Odoo-Recovery"]]) databaseActionEvidence(state, `${label}-Source-Aktionszustand`);
  for (const state of [value.gameRecoveryDatabase, value.odooRecoveryDatabase]) invariant(state.allowConnections === false && state.activeClientBackends === 0 && state.connectionLimit === 0, "Recovery-Source-Aktionsbeleg beweist keine geschlossenen V1-Ziele.");
  const expectedLiveOpen = value.action === "release";
  for (const state of [value.gameLiveDatabase, value.odooLiveDatabase]) invariant(expectedLiveOpen
    ? state.allowConnections === true && state.activeClientBackends === 0 && (state.connectionLimit === -1 || state.connectionLimit > 0)
    : state.allowConnections === false && state.activeClientBackends === 0 && state.connectionLimit === 0,
  "Recovery-Source-Aktionsbeleg besitzt nicht den aktionsgerechten Live-Datenbankzustand.");
  validateContinuityFilestore(value.odooFilestore, "Recovery-Source-Aktions-Filestore", "read-only");
  for (const hash of [value.actionReceiptHash, value.promotionHash, value.promotionSha256, value.recoveryReceiptHash, value.recoveryReceiptSha256]) invariant(SHA256.test(hash), "Recovery-Source-Aktionsbeleg besitzt eine ungueltige SHA-256-Bindung.");
  validateRuntimeRollbackBinding(value.runtimeRollback, "Recovery-Source-Aktions-Runtime-Rollback-Bindung");
  canonicalInstant(value.completedAt, "Recovery-Source-Aktionszeitpunkt");
  invariant(value.actionReceiptHash === canonicalHashWithout(value, "actionReceiptHash"), "Recovery-Source-Aktionsbeleg besitzt keinen gueltigen kanonischen Hash.");
  return value;
}

function assertSourceEvidenceBinding(entry, evidence) {
  const value = entry.value;
  invariant(value.recoveryId === evidence.recoveryId && value.candidateReleaseId === evidence.candidateReleaseId && value.previousReleaseId === evidence.previousReleaseId, "Source-Transition gehoert zu einer anderen Recovery-/Release-Linie.");
  invariant(value.promotionHash === evidence.promotion.promotionHash && value.promotionSha256 === evidence.promotionArtifact.sha256, "Source-Transition bindet eine andere Promotion.");
  invariant(value.recoveryReceiptHash === evidence.receipt.receiptHash && value.recoveryReceiptSha256 === evidence.receiptArtifact.sha256, "Source-Transition bindet ein anderes Recovery-Receipt.");
  invariant(sameValue(value.runtimeRollback, evidence.receipt.runtimeRollback), "Source-Transition bindet ein anderes World-/Image-/Proof-Tuple.");
}

function assertSourceStateMonotone(previous, current) {
  for (const [stored, observed, label] of [
    [previous.value.gameLiveDatabase, current.observations.gameLive, "Game-Live-Source"],
    [previous.value.odooLiveDatabase, current.observations.odooLive, "Odoo-Live-Source"],
    [previous.value.gameRecoveryDatabase, current.observations.gameRecovery, "Game-Recovery-Source"],
    [previous.value.odooRecoveryDatabase, current.observations.odooRecovery, "Odoo-Recovery-Source"],
  ]) assertDatabaseEvidenceMonotone(stored, observed, label);
  const storedFilestore = previous.value.odooFilestore;
  const currentFilestore = transitionFilestoreEvidence(current.filestore);
  invariant(storedFilestore.containerPath === currentFilestore.containerPath && storedFilestore.ownerUid === currentFilestore.ownerUid && storedFilestore.ownerGid === currentFilestore.ownerGid, "Source-Transition wechselte V1-Odoo-Filestore oder Runtime-Ownership.");
  invariant(storedFilestore.fileCount === currentFilestore.fileCount && storedFilestore.treeSha256 === currentFilestore.treeSha256, "Source-Transition stellte Drift im dauerhaft read-only V1-Odoo-Filestore fest.");
}

function assertSourceTransitionMonotone(previous, current) {
  for (const [stored, observed, label] of [
    [previous.value.gameLiveDatabase, current.value.gameLiveDatabase, "Game-Live-Source-Beleg"],
    [previous.value.odooLiveDatabase, current.value.odooLiveDatabase, "Odoo-Live-Source-Beleg"],
    [previous.value.gameRecoveryDatabase, current.value.gameRecoveryDatabase, "Game-Recovery-Source-Beleg"],
    [previous.value.odooRecoveryDatabase, current.value.odooRecoveryDatabase, "Odoo-Recovery-Source-Beleg"],
  ]) assertDatabaseEvidenceMonotone(stored, observed, label);
  const before = previous.value.odooFilestore;
  const after = current.value.odooFilestore;
  invariant(before.containerPath === after.containerPath && before.ownerUid === after.ownerUid && before.ownerGid === after.ownerGid, "Source-Transition-Beleg wechselte V1-Odoo-Filestore oder Runtime-Ownership.");
  invariant(before.fileCount === after.fileCount && before.treeSha256 === after.treeSha256, "Source-Transition-Beleg veraenderte den dauerhaft read-only V1-Odoo-Filestore.");
}

function sourceLivePhase(targets, observations) {
  let open = false;
  let closed = false;
  try { assertLiveDatabasesOpen(targets, observations); open = true; } catch { /* geschlossen wird getrennt geprueft */ }
  try { assertLiveDatabasesClosed(targets, observations); closed = true; } catch { /* offen wurde getrennt geprueft */ }
  invariant(open !== closed, "Source-Transition befindet sich in einer gekoppelten Teiloeffnung.");
  return open ? "open" : "closed";
}

async function resealLiveDatabases({ deadlineMs, inspectDatabaseFence, postgresFactory, resealDatabase, targets }) {
  const results = await Promise.allSettled([
    withDeadline((signal) => resealDatabase({ adminDatabaseUrl: targets.gameLive.adminDatabaseUrl, deadlineMs, expectedFence: targets.gameLive.expectedFence, signal }, postgresFactory), deadlineMs, "Game-Live-Reseal"),
    withDeadline((signal) => resealDatabase({ adminDatabaseUrl: targets.odooLive.adminDatabaseUrl, deadlineMs, expectedFence: targets.odooLive.expectedFence, signal }, postgresFactory), deadlineMs, "Odoo-Live-Reseal"),
  ]);
  const observations = await inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory);
  let verificationError;
  try {
    assertLiveDatabasesClosed(targets, observations);
    assertRecoveryDatabasesClosed(targets, observations);
  } catch (error) {
    verificationError = error;
  }
  const operationErrors = results.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
  if (verificationError !== undefined || operationErrors.length > 0) {
    throw new AggregateError([...operationErrors, ...(verificationError === undefined ? [] : [verificationError])], "Gekoppelte Live-Datenbank-Ruecksperre konnte nicht bestaetigt werden.");
  }
  return observations;
}

async function emergencyResealLiveSourcesFromQuiescence({
  deadlineMs,
  environment,
  evidenceRoot,
  inspectDatabaseFence,
  postgresFactory,
  recoveryId,
  resealDatabase,
}) {
  const quiescencePath = await containedEvidenceArtifact(
    evidenceRoot,
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_QUIESCENCE_PATH"),
    "Notfall-Quiescence-Receipt",
  );
  const artifact = await stableJsonFile(quiescencePath, "Notfall-Quiescence-Receipt");
  const quiescence = validateProductionQuiescenceReceipt(artifact.value, {
    candidateReleaseId: requiredEnvironment(environment, "PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID"),
    previousReleaseId: requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID"),
    recoveryId,
  });
  const targets = [
    Object.freeze({ adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_GAME_LIVE_ADMIN_DATABASE_URL"), expectedFence: quiescence.gameDatabase, label: "Game" }),
    Object.freeze({ adminDatabaseUrl: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_LIVE_ADMIN_DATABASE_URL"), expectedFence: quiescence.odooDatabase, label: "Odoo" }),
  ];
  const results = await Promise.allSettled(targets.map((target) => withDeadline(
    (signal) => resealDatabase({ adminDatabaseUrl: target.adminDatabaseUrl, deadlineMs, expectedFence: target.expectedFence, signal }, postgresFactory),
    deadlineMs,
    `${target.label}-Live-Notfall-Reseal`,
  )));
  let verificationError;
  try {
    const observations = await Promise.all(targets.map((target) => inspectDatabaseFence({
      adminDatabaseUrl: target.adminDatabaseUrl,
      database: target.expectedFence.database,
    }, postgresFactory)));
    for (let index = 0; index < targets.length; index += 1) {
      assertFenceStillClosed(targets[index].expectedFence, observations[index], `${targets[index].label}-Live-Notfall-Fence`);
    }
  } catch (error) {
    verificationError = error;
  }
  const operationErrors = results.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
  if (verificationError !== undefined || operationErrors.length > 0) {
    throw new AggregateError([...operationErrors, ...(verificationError === undefined ? [] : [verificationError])], "Live-Source-Notfall-Reseal konnte nicht bestaetigt werden.");
  }
}

export async function executeProductionRecoverySourceAction({
  action,
  environment = process.env,
  inspectDatabaseFence = defaultInspectDatabaseFence,
  inspectFilestore = inspectFilestoreTree,
  inspectRunningServices = defaultRunningServices,
  openDatabase = defaultOpenRecoveryDatabase,
  postgresFactory,
  resealDatabase = defaultResealRecoveryDatabase,
  now = () => new Date(),
} = {}) {
  const normalizedAction = requiredRecoverySourceAction(action);
  const recoveryId = requiredRecoveryId(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID"));
  const deadlineMs = requiredActionDeadline(environment);
  const owner = odooRuntimeOwner(environment);
  const evidenceRoot = requiredEnvironment(environment, "PRODUCTION_RECOVERY_EVIDENCE_ROOT");
  const outputAnchor = await containedCreateNewOutput(evidenceRoot, requiredEnvironment(environment, "PRODUCTION_RECOVERY_SOURCE_ACTION_RECEIPT_OUTPUT_PATH"), "Production-Recovery-Source-Aktionsbeleganker");
  invariant(basename(outputAnchor) === `${recoveryId}.source-${normalizedAction}.json`, "Recovery-Source-Aktionsbeleganker besitzt nicht den recovery- und aktionsgebundenen Dateinamen.");
  await assertCreateNewPathAvailable(outputAnchor, "Legacy-Source-Aktionsbeleganker");
  const intentAnchor = await containedCreateNewOutput(evidenceRoot, requiredEnvironment(environment, "PRODUCTION_RECOVERY_SOURCE_INTENT_OUTPUT_PATH"), "Production-Recovery-Source-Intentanker");
  invariant(basename(intentAnchor) === `${recoveryId}.source-${normalizedAction}.intent.json`, "Recovery-Source-Intentanker besitzt nicht den recovery- und aktionsgebundenen Dateinamen.");
  await assertCreateNewPathAvailable(intentAnchor, "Legacy-Source-Intentanker");
  let evidence;
  try {
    evidence = await loadProductionRecoveryActivationEvidence(environment);
  } catch (error) {
    try {
      await emergencyResealLiveSourcesFromQuiescence({
        deadlineMs,
        environment,
        evidenceRoot,
        inspectDatabaseFence,
        postgresFactory,
        recoveryId,
        resealDatabase,
      });
    } catch (resealError) {
      throw new AggregateError([error, resealError], "Source-Transition-Evidence war ungueltig und das Live-Notfall-Reseal konnte nicht bestaetigt werden.");
    }
    throw new AggregateError([error], "Source-Transition-Evidence war ungueltig; beide Live-Quellen wurden ueber den Quiescence-Ursprung fail-closed rueckgesperrt.");
  }
  const targets = recoveryDatabaseTargets(environment, evidence);
  const inspectFilestoreBound = () => inspectContinuityFilestore(environment, evidence.receipt, inspectFilestore, "read-only", owner);
  const inspectBoundState = async () => {
    await assertActivationArtifactsUnchanged(evidence);
    await assertCurrentWriterInventory(evidence, inspectRunningServices);
    const [filestore, observations] = await Promise.all([
      inspectFilestoreBound(),
      inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory),
    ]);
    assertLiveDatabaseIdentities(targets, observations);
    assertRecoveryDatabasesClosed(targets, observations);
    return { filestore, observations };
  };
  const compensate = () => resealLiveDatabases({ deadlineMs, inspectDatabaseFence, postgresFactory, resealDatabase, targets });
  let chain;
  let state;
  try {
    chain = await loadTransitionChain({
      actions: ["release", "reseal"], evidenceRoot, firstAction: "release", firstSequence: 1,
      namespace: "source-transition", recoveryId,
      validateIntent: validateProductionRecoverySourceIntent,
      validateReceipt: validateProductionRecoverySourceActionReceipt,
    });
    for (const entry of [...chain.receipts, ...chain.intents]) assertSourceEvidenceBinding(entry, evidence);
    for (let index = 1; index < chain.receipts.length; index += 1) {
      assertSourceTransitionMonotone(chain.receipts[index - 1], chain.receipts[index]);
    }
    for (const intent of chain.intents) {
      const previous = chain.receipts.find(({ sequence }) => sequence === intent.sequence - 1);
      if (previous !== undefined) assertSourceTransitionMonotone(previous, intent);
    }
    state = await inspectBoundState();
    const last = chain.receipts.at(-1);
    if (last !== undefined) assertSourceStateMonotone(last, state);
    if (last !== undefined && last.action === normalizedAction && chain.pendingIntent === undefined) {
      if (normalizedAction === "release") assertLiveDatabasesOpen(targets, state.observations);
      else assertLiveDatabasesClosed(targets, state.observations);
      await assertArtifactUnchanged(last.artifact, "Bestehender Source-Transition-Beleg");
      return Object.freeze({ action: normalizedAction, actionReceiptHash: last.value.actionReceiptHash, actionReceiptOutputPath: resolve(last.artifact.path), replayed: true, recoveryId, sequence: last.sequence });
    }
    invariant(last === undefined ? normalizedAction === "release" : last.action !== normalizedAction, "Source-Transition besitzt einen widerspruechlichen Aktionskopf.");
    const phase = sourceLivePhase(targets, state.observations);
    if (chain.pendingIntent === undefined) {
      const expectedPhase = last === undefined || last.action === "reseal" ? "closed" : "open";
      invariant(phase === expectedPhase, "Source-Transition-Kopf und physischer Live-Zustand widersprechen sich.");
    } else {
      invariant(chain.pendingIntent.action === normalizedAction, "Source-Transition besitzt einen Intent-Fork fuer eine andere Aktion.");
      const sourcePhase = normalizedAction === "release" ? "closed" : "open";
      const targetPhase = normalizedAction === "release" ? "open" : "closed";
      invariant(phase === sourcePhase || phase === targetPhase, "Source-Transition-Intent trifft auf eine Teiloeffnung.");
      assertSourceStateMonotone(chain.pendingIntent, state);
      const storedFilestore = chain.pendingIntent.value.odooFilestore;
      const currentFilestore = transitionFilestoreEvidence(state.filestore);
      invariant(storedFilestore.fileCount === currentFilestore.fileCount && storedFilestore.treeSha256 === currentFilestore.treeSha256, "Source-Transition-Filestore driftete nach durable Intent.");
    }
  } catch (error) {
    try { await compensate(); } catch (resealError) { throw new AggregateError([error, resealError], "Source-Transition war ungueltig und beide Live-Quellen konnten nicht bestaetigt rueckgesperrt werden."); }
    throw new AggregateError([error], "Source-Transition war ungueltig; beide Live-Quellen wurden fail-closed rueckgesperrt.");
  }

  const previousEntry = chain.receipts.at(-1);
  const previous = previousEntry === undefined ? null : Object.freeze({ actionReceiptHash: previousEntry.value.actionReceiptHash, sequence: previousEntry.sequence, sha256: previousEntry.artifact.sha256 });
  const sequence = (previousEntry?.sequence ?? 0) + 1;
  const intentPath = transitionArtifactPath(evidenceRoot, recoveryId, "source-transition", sequence, normalizedAction, "intent");
  const receiptPath = transitionArtifactPath(evidenceRoot, recoveryId, "source-transition", sequence, normalizedAction, "receipt");
  let intentEntry = chain.pendingIntent;
  if (intentEntry !== undefined) invariant(intentEntry.action === normalizedAction && intentEntry.sequence === sequence, "Source-Transition besitzt einen Intent-Fork fuer eine andere Aktion.");
  if (intentEntry === undefined) {
    try {
      const intent = productionRecoverySourceIntent({ action: normalizedAction, evidence, filestore: state.filestore, observations: state.observations, previous, sequence, now });
      const bytes = serializeMapReleaseBuildEvidence(intent);
      await publishCreateNew([{ path: intentPath, bytes }], async () => {
        const current = await inspectBoundState();
        if (previousEntry !== undefined) assertSourceStateMonotone(previousEntry, current);
        if (normalizedAction === "release") assertLiveDatabasesClosed(targets, current.observations);
        else assertLiveDatabasesOpen(targets, current.observations);
      });
      const artifact = await stableJsonFile(intentPath, "Production-Recovery-Source-Transition-Intent");
      intentEntry = Object.freeze({ action: normalizedAction, artifact, kind: "intent", sequence, value: validateProductionRecoverySourceIntent(artifact.value) });
    } catch (error) {
      try { await compensate(); } catch (resealError) { throw new AggregateError([error, resealError], "Source-Transition-Intent scheiterte und beide Live-Quellen konnten nicht bestaetigt rueckgesperrt werden."); }
      throw error;
    }
  }
  const intentBindingValue = Object.freeze({ intentHash: intentEntry.value.intentHash, sha256: intentEntry.artifact.sha256 });

  try {
    state = await inspectBoundState();
    if (previousEntry !== undefined) assertSourceStateMonotone(previousEntry, state);
    const targetAlreadyReached = (() => {
      try {
        if (normalizedAction === "release") assertLiveDatabasesOpen(targets, state.observations);
        else assertLiveDatabasesClosed(targets, state.observations);
        return true;
      } catch { return false; }
    })();
    if (!targetAlreadyReached) {
      if (normalizedAction === "release") {
        assertLiveDatabasesClosed(targets, state.observations);
        const results = await Promise.allSettled([
          withDeadline((signal) => openDatabase({ adminDatabaseUrl: targets.gameLive.adminDatabaseUrl, deadlineMs, expectedFence: targets.gameLive.expectedFence, signal }, postgresFactory), deadlineMs, "Game-Live-Release"),
          withDeadline((signal) => openDatabase({ adminDatabaseUrl: targets.odooLive.adminDatabaseUrl, deadlineMs, expectedFence: targets.odooLive.expectedFence, signal }, postgresFactory), deadlineMs, "Odoo-Live-Release"),
        ]);
        const errors = results.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
        if (errors.length > 0) throw new AggregateError(errors, "Gekoppeltes Live-Datenbank-Release schlug fehl.");
      } else {
        await resealLiveDatabases({ deadlineMs, inspectDatabaseFence, postgresFactory, resealDatabase, targets });
      }
    }
    state = await inspectBoundState();
    if (normalizedAction === "release") assertLiveDatabasesOpen(targets, state.observations);
    else assertLiveDatabasesClosed(targets, state.observations);
    if (previousEntry !== undefined) assertSourceStateMonotone(previousEntry, state);
  } catch (error) {
    try { await compensate(); } catch (resealError) { throw new AggregateError([error, resealError], "Source-Transition scheiterte und beide Live-Quellen konnten nicht bestaetigt rueckgesperrt werden."); }
    throw error;
  }

  let receipt;
  try {
    receipt = productionRecoverySourceActionReceipt({ action: normalizedAction, evidence, filestore: state.filestore, intent: intentBindingValue, observations: state.observations, previous, sequence, now });
    await publishCreateNew([{ path: receiptPath, bytes: serializeMapReleaseBuildEvidence(receipt) }], async () => {
      const current = await inspectBoundState();
      if (normalizedAction === "release") assertLiveDatabasesOpen(targets, current.observations);
      else assertLiveDatabasesClosed(targets, current.observations);
      assertSourceStateMonotone(intentEntry, current);
      const currentFilestore = transitionFilestoreEvidence(current.filestore);
      invariant(receipt.odooFilestore.fileCount === currentFilestore.fileCount && receipt.odooFilestore.treeSha256 === currentFilestore.treeSha256, "Source-Transition-Filestore driftete vor der Receipt-Publikation.");
    });
  } catch (error) {
    try { await compensate(); } catch (resealError) { throw new AggregateError([error, resealError], "Source-Transition-Receipt scheiterte und beide Live-Quellen konnten nicht bestaetigt rueckgesperrt werden."); }
    throw error;
  }
  return Object.freeze({ action: normalizedAction, actionReceiptHash: receipt.actionReceiptHash, actionReceiptOutputPath: resolve(receiptPath), replayed: false, recoveryId, sequence });
}

export async function executeProductionRecoveryAction({
  action,
  environment = process.env,
  inspectDatabaseFence = defaultInspectDatabaseFence,
  inspectFilestore = inspectFilestoreTree,
  inspectGameContinuity = defaultInspectGameContinuity,
  inspectGameRestore = inspectDatabaseRollbackEndpoint,
  inspectOdooRestore = defaultInspectOdooRestore,
  inspectRunningServices = defaultRunningServices,
  openDatabase = defaultOpenRecoveryDatabase,
  postgresFactory,
  resealDatabase = defaultResealRecoveryDatabase,
  setFilestoreAccess = defaultSetFilestoreAccess,
  now = () => new Date(),
} = {}) {
  const normalizedAction = requiredRecoveryAction(action);
  const recoveryId = requiredRecoveryId(requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID"));
  const deadlineMs = requiredActionDeadline(environment);
  const owner = odooRuntimeOwner(environment);
  const evidenceRoot = requiredEnvironment(environment, "PRODUCTION_RECOVERY_EVIDENCE_ROOT");
  const actionReceiptOutputPath = await containedCreateNewOutput(
    evidenceRoot,
    requiredEnvironment(environment, "PRODUCTION_RECOVERY_ACTION_RECEIPT_OUTPUT_PATH"),
    "Production-Recovery-Aktionsbeleg",
  );
  invariant(basename(actionReceiptOutputPath) === `${recoveryId}.${normalizedAction}.json`, "Production-Recovery-Aktionsbeleg besitzt nicht den recovery- und aktionsgebundenen Dateinamen.");
  const existingActionReceiptArtifact = await optionalStableJsonFile(actionReceiptOutputPath, "Bestehender Production-Recovery-Aktionsbeleg");
  let intentOutputPath;
  let existingIntentArtifact;
  let continuityOriginOutputPath;
  if (normalizedAction === "activate") {
    intentOutputPath = await containedCreateNewOutput(
      evidenceRoot,
      requiredEnvironment(environment, "PRODUCTION_RECOVERY_ACTIVATION_INTENT_OUTPUT_PATH"),
      "Production-Recovery-Aktivierungs-Intent",
    );
    invariant(basename(intentOutputPath) === `${recoveryId}.activate.intent.json`, "Production-Recovery-Aktivierungs-Intent besitzt nicht den recovery-gebundenen Dateinamen.");
    invariant(resolve(intentOutputPath) !== resolve(actionReceiptOutputPath), "Production-Recovery-Aktivierungs-Intent und Aktionsbeleg duerfen keinen Pfad teilen.");
    existingIntentArtifact = await optionalStableJsonFile(intentOutputPath, "Bestehender Production-Recovery-Aktivierungs-Intent");
    continuityOriginOutputPath = transitionArtifactPath(evidenceRoot, recoveryId, "continuity", 0, "origin", "receipt");
    invariant(resolve(continuityOriginOutputPath) !== resolve(actionReceiptOutputPath) && resolve(continuityOriginOutputPath) !== resolve(intentOutputPath), "Recovery-Continuity-Ursprung braucht einen getrennten Pfad.");
  }
  if (existingActionReceiptArtifact === undefined) await assertCreateNewPathAvailable(actionReceiptOutputPath, "Production-Recovery-Aktionsbeleg");
  if (normalizedAction === "activate" && existingActionReceiptArtifact === undefined) {
    await assertCreateNewPathAvailable(continuityOriginOutputPath, "Recovery-Continuity-Ursprungsbeleg");
  }
  let evidence;
  try {
    evidence = await loadProductionRecoveryActivationEvidence(environment);
  } catch (error) {
    if (normalizedAction !== "continue" && normalizedAction !== "reseal") throw error;
    try {
      await emergencyResealContinuityFromActivation({
        deadlineMs,
        environment,
        evidenceRoot,
        inspectDatabaseFence,
        inspectFilestore,
        owner,
        postgresFactory,
        recoveryId,
        resealDatabase,
        setFilestoreAccess,
      });
    } catch (resealError) {
      throw new AggregateError([error, resealError], "Recovery-Continuity-Evidence war ungueltig und das Notfall-Reseal konnte nicht bestaetigt werden.");
    }
    throw new AggregateError([error], "Recovery-Continuity-Evidence war ungueltig; Legacy-Ziele wurden ueber den unveraenderten Erstaktivierungsbeleg fail-closed rueckgesperrt.");
  }
  invariant(evidence.recoveryId === recoveryId, "Recovery-Aktion und qualifizierter Beleg verwenden verschiedene Recovery-IDs.");
  invariant(!evidence.inputArtifacts.some(({ path }) => resolve(path) === resolve(actionReceiptOutputPath)), "Recovery-Aktionsbeleg darf kein Eingabeartefakt ueberschreiben.");
  if (intentOutputPath !== undefined) invariant(!evidence.inputArtifacts.some(({ path }) => resolve(path) === resolve(intentOutputPath)), "Production-Recovery-Aktivierungs-Intent darf kein Eingabeartefakt ueberschreiben.");
  if (continuityOriginOutputPath !== undefined) invariant(!evidence.inputArtifacts.some(({ path }) => resolve(path) === resolve(continuityOriginOutputPath)), "Recovery-Continuity-Ursprung darf kein Eingabeartefakt ueberschreiben.");
  const targets = recoveryDatabaseTargets(environment, evidence);
  const inspectBoundFilestore = async (expectedAccess) => {
    await assertActivationArtifactsUnchanged(evidence);
    return inspectActivationFilestore(environment, evidence.receipt, inspectFilestore, expectedAccess, owner);
  };
  const failClosedReseal = () => resealProductionRecoveryState({
    deadlineMs,
    environment,
    evidence,
    inspectDatabaseFence,
    inspectFilestore,
    owner,
    postgresFactory,
    resealDatabase,
    setFilestoreAccess,
    targets,
  });
  if (normalizedAction === "continue" || normalizedAction === "reseal") {
    return executeProductionRecoveryContinuityAction({
      action: normalizedAction,
      actionReceiptAnchor: actionReceiptOutputPath,
      deadlineMs,
      environment,
      evidence,
      inspectDatabaseFence,
      inspectFilestore,
      inspectGameContinuity,
      inspectOdooRestore,
      inspectRunningServices,
      openDatabase,
      owner,
      postgresFactory,
      resealDatabase,
      setFilestoreAccess,
      targets,
      now,
    });
  }
  if (normalizedAction === "activate" && existingActionReceiptArtifact !== undefined) {
    let replayError;
    let replayOrigin;
    try {
      invariant(existingIntentArtifact !== undefined, "Bestehender Aktivierungsbeleg besitzt keinen durable Aktivierungs-Intent.");
      await assertCurrentWriterInventory(evidence, inspectRunningServices);
      const currentFilestore = await inspectBoundFilestore("owner-writable");
      const intent = assertActivationIntentArtifact({ artifact: existingIntentArtifact, containerPath: currentFilestore.containerPath, evidence, owner });
      const currentObservations = await inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory);
      assertLiveDatabasesClosed(targets, currentObservations);
      assertRecoveryDatabasesOpen(targets, currentObservations);
      await assertPostFenceRecoveryState({ environment, evidence, filestore: currentFilestore, inspectGameRestore, inspectOdooRestore, owner, postgresFactory });
      const receipt = assertExistingActionReceipt({ action: "activate", artifact: existingActionReceiptArtifact, evidence, filestore: currentFilestore, observations: currentObservations });
      invariant(receipt.activationIntent.intentHash === intent.intentHash && receipt.activationIntent.sha256 === existingIntentArtifact.sha256, "Bestehender Aktivierungsbeleg bindet nicht die bereitgestellten Intent-Bytes.");
      const continuityChain = await loadTransitionChain({
        actions: ["origin", "continue", "reseal"],
        evidenceRoot,
        firstAction: "origin",
        firstSequence: 0,
        namespace: "continuity",
        recoveryId,
        validateIntent: validateProductionRecoveryContinuityIntent,
        validateReceipt: validateProductionRecoveryContinuityReceipt,
      });
      invariant(continuityChain.receipts.length === 1 && continuityChain.pendingIntent === undefined && continuityChain.intents.length === 0, "Erstaktivierungs-Replay ist nach einer Continuity-Transition nicht mehr zulaessig.");
      const activationArtifact = Object.freeze({ ...existingActionReceiptArtifact, value: receipt });
      const origin = assertContinuityChain({ activationArtifact, chain: continuityChain, evidence });
      replayOrigin = origin;
      const currentHeads = await inspectOpenContinuityHeads({
        environment,
        evidence,
        filestore: currentFilestore,
        inspectGameContinuity,
        inspectOdooRestore,
        owner,
        postgresFactory,
      });
      invariant(
        sameValue(currentHeads.gameHead, origin.value.gameHead)
          && sameValue(currentHeads.odooHead, origin.value.odooHead),
        "Erstaktivierungs-Replay driftete vom belegten Game-/Keycloak-/Odoo-Continuity-Ursprung.",
      );
      assertContinuityCurrentState({
        current: { filestore: currentFilestore, ...currentHeads, observations: currentObservations },
        previous: origin,
        requireExactMutableHeads: true,
      });
      await Promise.all([
        assertArtifactUnchanged(existingActionReceiptArtifact, "Bestehender Production-Recovery-Aktivierungsbeleg"),
        assertArtifactUnchanged(existingIntentArtifact, "Bestehender Production-Recovery-Aktivierungs-Intent"),
        assertArtifactUnchanged(origin.artifact, "Bestehender Recovery-Continuity-Ursprung"),
      ]);
    } catch (error) {
      replayError = error;
    }
    if (replayError === undefined) {
      const receipt = validateProductionRecoveryActionReceipt(existingActionReceiptArtifact.value);
      return Object.freeze({
        action: "activate",
        actionReceiptHash: receipt.actionReceiptHash,
        actionReceiptOutputPath: resolve(actionReceiptOutputPath),
        continuityReceiptOutputPath: resolve(replayOrigin.artifact.path),
        promotionHash: evidence.promotion.promotionHash,
        replayed: true,
        recoveryId,
        sequence: 0,
      });
    }
    try {
      await failClosedReseal();
    } catch (resealError) {
      throw new AggregateError([replayError, resealError], "Bestehender Aktivierungsbeleg war nicht sicher replaybar und Recovery-Ziele konnten nicht bestaetigt rueckgesperrt werden.");
    }
    throw new AggregateError([replayError], "Bestehender Aktivierungsbeleg war unvollstaendig oder driftete; Recovery-Ziele wurden fail-closed rueckgesperrt.");
  }
  if (normalizedAction === "activate" && existingIntentArtifact !== undefined) {
    let intentError;
    try {
      const containerPath = await containedRecoveryFilestore(
        requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_ROOT"),
        requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_CONTAINER_FILESTORE_PATH"),
        evidence.receipt.odoo.database,
      );
      assertActivationIntentArtifact({ artifact: existingIntentArtifact, containerPath, evidence, owner });
    } catch (error) {
      intentError = error;
    }
    try {
      await failClosedReseal();
    } catch (resealError) {
      throw new AggregateError([...(intentError === undefined ? [] : [intentError]), resealError], "Unvollstaendige Recovery-Aktivierung konnte nicht bestaetigt rueckgesperrt werden.");
    }
    throw new AggregateError(intentError === undefined ? [] : [intentError], "Durable Aktivierungs-Intent ohne Abschlussbeleg erkannt; Recovery-Ziele wurden fail-closed rueckgesperrt. Vor einem neuen activate ist ein neues Recovery-ID-/Belegset erforderlich.");
  }
  if (normalizedAction === "activate") {
    let staleContinuityError;
    try {
      const freshChain = await loadTransitionChain({
        actions: ["origin", "continue", "reseal"],
        evidenceRoot,
        firstAction: "origin",
        firstSequence: 0,
        namespace: "continuity",
        recoveryId,
        validateIntent: validateProductionRecoveryContinuityIntent,
        validateReceipt: validateProductionRecoveryContinuityReceipt,
      });
      invariant(freshChain.receipts.length === 0 && freshChain.intents.length === 0, "Neue Erstaktivierung besitzt bereits Continuity-Artefakte.");
    } catch (error) {
      staleContinuityError = error;
    }
    if (staleContinuityError !== undefined) {
      try { await failClosedReseal(); } catch (resealError) { throw new AggregateError([staleContinuityError, resealError], "Neue Erstaktivierung besass fremde Continuity-Artefakte und konnte nicht bestaetigt rueckgesperrt werden."); }
      throw new AggregateError([staleContinuityError], "Neue Erstaktivierung besass fremde Continuity-Artefakte; Recovery-Ziele wurden fail-closed rueckgesperrt.");
    }
  }
  let initialFilestore;
  let initialObservations;
  let initialGateError;
  try {
    await assertCurrentWriterInventory(evidence, inspectRunningServices);
    initialFilestore = await inspectBoundFilestore(normalizedAction === "reseal" ? "any" : "read-only");
    initialObservations = await inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory);
    if (normalizedAction === "prepared") assertLiveDatabaseIdentities(targets, initialObservations);
    else assertLiveDatabasesClosed(targets, initialObservations);
    if (normalizedAction === "reseal") assertRecoveryDatabaseIdentities(targets, initialObservations);
    else assertRecoveryDatabasesClosed(targets, initialObservations);
  } catch (error) {
    initialGateError = error;
  }

  let finalObservations;
  let finalFilestore;
  let activationIntentBinding = null;
  if (normalizedAction === "reseal") {
    const resealed = await resealProductionRecoveryState({
      deadlineMs,
      environment,
      evidence,
      inspectDatabaseFence,
      inspectFilestore,
      owner,
      postgresFactory,
      resealDatabase,
      setFilestoreAccess,
      targets,
    });
    finalObservations = resealed.observations;
    finalFilestore = resealed.filestore;
    await assertActivationArtifactsUnchanged(evidence);
    await assertCurrentWriterInventory(evidence, inspectRunningServices);
    if (initialGateError !== undefined) throw initialGateError;
  } else {
    if (initialGateError !== undefined) throw initialGateError;
    if (normalizedAction === "preflight" || normalizedAction === "prepared") {
      finalObservations = initialObservations;
      finalFilestore = initialFilestore;
    } else {
      invariant(intentOutputPath !== undefined && existingIntentArtifact === undefined, "Neue Recovery-Aktivierung besitzt keinen freien durable Intent-Pfad.");
      await assertCreateNewPathAvailable(intentOutputPath, "Production-Recovery-Aktivierungs-Intent");
      const intent = productionRecoveryActivationIntent({ evidence, filestore: initialFilestore, observations: initialObservations, now });
      const intentBytes = serializeMapReleaseBuildEvidence(intent);
      const verifyIntent = async () => {
        await assertCurrentWriterInventory(evidence, inspectRunningServices);
        await inspectBoundFilestore("read-only");
        const observations = await inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory);
        assertLiveDatabasesClosed(targets, observations);
        assertRecoveryDatabasesClosed(targets, observations);
      };
      await publishCreateNew([{ path: intentOutputPath, bytes: intentBytes }], verifyIntent);
      const intentArtifact = await stableJsonFile(intentOutputPath, "Production-Recovery-Aktivierungs-Intent");
      invariant(intentArtifact.bytes.equals(intentBytes), "Publizierter Production-Recovery-Aktivierungs-Intent besitzt andere Bytes.");
      assertActivationIntentArtifact({ artifact: intentArtifact, containerPath: initialFilestore.containerPath, evidence, owner });
      activationIntentBinding = Object.freeze({ intentHash: intent.intentHash, sha256: intentArtifact.sha256 });
      try {
        await assertCurrentWriterInventory(evidence, inspectRunningServices);
        await withDeadline(
          (signal) => setFilestoreAccess({ containerPath: initialFilestore.containerPath, owner, signal, writable: true }),
          deadlineMs,
          "Odoo-Recovery-Filestore-Aktivierung",
        );
        finalFilestore = await inspectBoundFilestore("owner-writable");
        await assertCurrentWriterInventory(evidence, inspectRunningServices);
        const openingResults = await Promise.allSettled([
          withDeadline((signal) => openDatabase({ adminDatabaseUrl: targets.gameRecovery.adminDatabaseUrl, deadlineMs, expectedFence: targets.gameRecovery.expectedFence, signal }, postgresFactory), deadlineMs, "Game-Recovery-Aktivierung"),
          withDeadline((signal) => openDatabase({ adminDatabaseUrl: targets.odooRecovery.adminDatabaseUrl, deadlineMs, expectedFence: targets.odooRecovery.expectedFence, signal }, postgresFactory), deadlineMs, "Odoo-Recovery-Aktivierung"),
        ]);
        const openingErrors = openingResults.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
        if (openingErrors.length > 0) throw new AggregateError(openingErrors, "Gekoppelte Recovery-Aktivierung konnte nicht vollstaendig geoeffnet werden.");
        finalObservations = await inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory);
        assertLiveDatabasesClosed(targets, finalObservations);
        assertRecoveryDatabasesOpen(targets, finalObservations);
        await assertCurrentWriterInventory(evidence, inspectRunningServices);
        await assertPostFenceRecoveryState({ environment, evidence, filestore: finalFilestore, inspectGameRestore, inspectOdooRestore, owner, postgresFactory });
        finalFilestore = await inspectBoundFilestore("owner-writable");
      } catch (error) {
        try {
          await resealProductionRecoveryState({
            deadlineMs,
            environment,
            evidence,
            inspectDatabaseFence,
            inspectFilestore,
            owner,
            postgresFactory,
            resealDatabase,
            setFilestoreAccess,
            targets,
          });
        } catch (resealError) {
          throw new AggregateError([error, resealError], "Recovery-Aktivierung scheiterte und Datenbanken/Filestore konnten nicht bestaetigt rueckgesperrt werden.");
        }
        throw error;
      }
    }
  }

  let activationOrigin;
  const verifyForPublish = async () => {
    await assertCurrentWriterInventory(evidence, inspectRunningServices);
    const filestore = await inspectBoundFilestore(normalizedAction === "activate" ? "owner-writable" : "read-only");
    const observations = await inspectRecoveryDatabases(targets, inspectDatabaseFence, postgresFactory);
    if (normalizedAction === "prepared") assertLiveDatabaseIdentities(targets, observations);
    else assertLiveDatabasesClosed(targets, observations);
    if (normalizedAction === "activate") {
      assertRecoveryDatabasesOpen(targets, observations);
      await assertPostFenceRecoveryState({ environment, evidence, filestore, inspectGameRestore, inspectOdooRestore, owner, postgresFactory });
      if (activationOrigin !== undefined) {
        const currentHeads = await inspectOpenContinuityHeads({
          environment,
          evidence,
          filestore,
          inspectGameContinuity,
          inspectOdooRestore,
          owner,
          postgresFactory,
        });
        invariant(
          sameValue(currentHeads.gameHead, activationOrigin.gameHead)
            && sameValue(currentHeads.odooHead, activationOrigin.odooHead),
          "Recovery-Continuity-Ursprung driftete vor seiner gekoppelten Publikation.",
        );
      }
    }
    else assertRecoveryDatabasesClosed(targets, observations);
  };
  let actionReceipt;
  try {
    actionReceipt = productionRecoveryActionReceipt({
      action: normalizedAction,
      activationIntent: activationIntentBinding,
      evidence,
      filestore: finalFilestore,
      observations: finalObservations,
      now,
    });
    if (existingActionReceiptArtifact === undefined) {
      const actionReceiptBytes = serializeMapReleaseBuildEvidence(actionReceipt);
      const artifacts = [{ path: actionReceiptOutputPath, bytes: actionReceiptBytes }];
      if (normalizedAction === "activate") {
        invariant(continuityOriginOutputPath !== undefined, "Erstaktivierung besitzt keinen Continuity-Ursprungspfad.");
        const { gameHead, odooHead } = await inspectOpenContinuityHeads({
          environment,
          evidence,
          filestore: finalFilestore,
          inspectGameContinuity,
          inspectOdooRestore,
          owner,
          postgresFactory,
        });
        const activation = Object.freeze({ actionReceiptHash: actionReceipt.actionReceiptHash, sha256: sha256Bytes(actionReceiptBytes) });
        activationOrigin = productionRecoveryContinuityReceipt({
          action: "origin",
          activation,
          evidence,
          filestore: finalFilestore,
          gameHead,
          intent: null,
          observations: finalObservations,
          odooHead,
          previous: null,
          sequence: 0,
          now,
        });
        artifacts.push({ path: continuityOriginOutputPath, bytes: serializeMapReleaseBuildEvidence(activationOrigin) });
      }
      await publishCreateNew(artifacts, verifyForPublish);
    } else {
      actionReceipt = assertExistingActionReceipt({
        action: normalizedAction,
        artifact: existingActionReceiptArtifact,
        evidence,
        filestore: finalFilestore,
        observations: finalObservations,
      });
      await verifyForPublish();
      await assertArtifactUnchanged(existingActionReceiptArtifact, "Bestehender Production-Recovery-Aktionsbeleg");
    }
  } catch (error) {
    if (normalizedAction !== "activate") throw error;
    try {
      await resealProductionRecoveryState({
        deadlineMs,
        environment,
        evidence,
        inspectDatabaseFence,
        inspectFilestore,
        owner,
        postgresFactory,
        resealDatabase,
        setFilestoreAccess,
        targets,
      });
    } catch (resealError) {
      throw new AggregateError([error, resealError], "Recovery-Aktionsbeleg konnte nicht sicher publiziert und Datenbanken/Filestore nicht bestaetigt rueckgesperrt werden.");
    }
    throw error;
  }
  return Object.freeze({
    action: normalizedAction,
    actionReceiptHash: actionReceipt.actionReceiptHash,
    actionReceiptOutputPath: resolve(actionReceiptOutputPath),
    promotionHash: evidence.promotion.promotionHash,
    replayed: existingActionReceiptArtifact !== undefined,
    recoveryId,
    ...(normalizedAction === "activate" ? { continuityReceiptOutputPath: resolve(continuityOriginOutputPath), sequence: 0 } : {}),
  });
}

export const PRODUCTION_RECOVERY_SCHEMAS = Object.freeze({
  action: RECOVERY_ACTION_SCHEMA,
  activationIntent: RECOVERY_ACTIVATION_INTENT_SCHEMA,
  gameRestore: GAME_RESTORE_SCHEMA,
  odooRestore: ODOO_RESTORE_SCHEMA,
  promotion: PROMOTION_SCHEMA,
  quiescence: QUIESCENCE_SCHEMA,
  recovery: RECOVERY_SCHEMA,
  continuityAction: RECOVERY_CONTINUITY_ACTION_SCHEMA,
  continuityIntent: RECOVERY_CONTINUITY_INTENT_SCHEMA,
  sourceAction: RECOVERY_SOURCE_ACTION_SCHEMA,
  sourceIntent: RECOVERY_SOURCE_INTENT_SCHEMA,
});
