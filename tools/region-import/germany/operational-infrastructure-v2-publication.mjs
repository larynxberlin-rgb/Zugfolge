import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCreateNewTargets,
} from "../../tiles/create-new-output.mjs";
import { materializeOperationalInfrastructureV2 } from "../materialize-operational-infrastructure-v2.mjs";
import {
  OperationalInfrastructureDerivationBlockedError,
  OperationalInfrastructureDerivationIncompleteError,
  assessGermanyOperationalInfrastructureV2Readiness,
  validateGermanyOperationalInfrastructureV2NativeReceipt,
  validateGermanyOperationalInfrastructureV2NativeReport,
  validateGermanyOperationalInfrastructureV2Specification,
} from "./operational-infrastructure-v2.mjs";
import { verifyOperationalValidatorRebuildEvidence } from "./operational-validator-rebuild-evidence.mjs";

export const GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_SCHEMA = "zugfolge-germany-operational-v2-native-receipt-capture/v1";
export const GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_CLAIM_SCHEMA = "zugfolge-germany-operational-v2-native-receipt-capture-claim/v1";
export const GERMANY_OPERATIONAL_PUBLICATION_RECEIPT_SCHEMA = "zugfolge-germany-operational-v2-publication-receipt/v1";
export const GERMANY_OPERATIONAL_PUBLICATION_CLAIM_SCHEMA = "zugfolge-germany-operational-v2-publication-claim/v1";
export const GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT = "tools/region-import/germany/publish-operational-infrastructure-v2.mjs";
export const GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_ENTRYPOINT = "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs";
export const GERMANY_OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE_SCHEMA = "zugfolge-operational-validator-rebuild-evidence/v2";
export const GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES = Object.freeze({
  wrapper: GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT,
  implementation: "tools/region-import/germany/operational-infrastructure-v2-publication.mjs",
  operationalDeriver: "tools/region-import/germany/operational-infrastructure-v2.mjs",
  materializer: "tools/region-import/materialize-operational-infrastructure-v2.mjs",
  createNewOutput: "tools/tiles/create-new-output.mjs",
  operationalBinding: "tools/region-import/operational-infrastructure-binding.mjs",
  validatorRebuildBootstrap: "tools/region-import/germany/operational-validator-rebuild-bootstrap.mjs",
  validatorRebuildVerifier: "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
});

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const MAX_SMALL_JSON_BYTES = 64 * 1024 * 1024;
const STAGING_PREFIX = ".operational-v2-publish-";
const CAPTURE_STAGING_PREFIX = ".operational-v2-native-receipt-";
const OWNED_CLEANUP_PREFIX = ".operational-v2-owned-cleanup-";
const CREATE_NEW_ROLLBACK_PREFIX = ".zugfolge-create-new-rollback-";
const CLAIM_FILE = ".operational-infrastructure-v2.publication-claim.json";
const CAPTURE_CLAIM_FILE = ".operational-infrastructure-v2.native-receipt-capture-claim.json";
const OPERATIONAL_FILE = "operational-infrastructure-v2.json";
const SIDECAR_FILE = "operational-infrastructure-v2.movement-route-templates-v2.json";
const PUBLICATION_RECEIPT_FILE = "operational-infrastructure-v2.publication-receipt.json";
const NATIVE_RECEIPT_FILE = "operational-infrastructure-v2.native-receipt.json";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  invariant(isRecord(value), `${label} muss ein Objekt sein.`);
  invariant(Object.keys(value).sort().join(",") === [...keys].sort().join(","), `${label} besitzt unerwartete oder fehlende Felder.`);
}

function nonEmptyString(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} muss eine nichtleere Zeichenkette sein.`);
  return value;
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} muss eine positive sichere Ganzzahl sein.`);
  return value;
}

function sha256(value, label) {
  invariant(typeof value === "string" && SHA256.test(value), `${label} muss ein SHA-256 sein.`);
  return value;
}

function sha256OrNull(value, label) {
  invariant(value === null || (typeof value === "string" && SHA256.test(value)), `${label} muss null oder ein SHA-256 sein.`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function serializeGermanyOperationalPublicationJson(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error });
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableMetadata(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameIdentitySizeMtime(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function identityValue(metadata) {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}

function identityMatches(metadata, value) {
  return isRecord(value)
    && typeof value.dev === "string"
    && typeof value.ino === "string"
    && DECIMAL.test(value.dev)
    && DECIMAL.test(value.ino)
    && metadata.dev.toString() === value.dev
    && metadata.ino.toString() === value.ino;
}

function matchesExpectedIdentity(metadata, expected) {
  return typeof expected?.dev === "bigint" && typeof expected?.ino === "bigint"
    ? sameIdentity(metadata, expected)
    : identityMatches(metadata, expected);
}

async function assertOwnedRegularFile(path, expectedIdentity, label) {
  const metadata = await lstat(path, { bigint: true });
  invariant(
    metadata.isFile()
      && !metadata.isSymbolicLink()
      && matchesExpectedIdentity(metadata, expectedIdentity),
    `${label} wurde fremd ersetzt oder besitzt keine regulaere Dateidentitaet.`,
  );
  return metadata;
}

async function assertHeldOwnedRegularFile(path, handle, expectedIdentity, label) {
  let held;
  let metadata;
  try {
    [held, metadata] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
  } catch (error) {
    throw new Error(`${label} wurde fremd ersetzt oder sein reservierter Handle ist nicht mehr nutzbar.`, { cause: error });
  }
  invariant(
    held.isFile()
      && metadata.isFile()
      && !metadata.isSymbolicLink()
      && matchesExpectedIdentity(held, expectedIdentity)
      && sameStableMetadata(held, metadata),
    `${label} wurde fremd ersetzt oder driftet von seinem reservierten Handle.`,
  );
  return metadata;
}

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizedPathForComparison(path) {
  const normalized = resolve(path).replaceAll("/", "\\").replace(/\\+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isMissing(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}

async function maybeMetadata(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function regularFileProof(pathInput, label) {
  const path = resolve(pathInput);
  const pathBefore = await lstat(path, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n, `${label} ist keine nichtleere regulaere Datei.`);
  invariant(pathBefore.size <= BigInt(Number.MAX_SAFE_INTEGER), `${label} ist fuer einen sicheren Bytebeleg zu gross.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && sameStableMetadata(pathBefore, before), `${label} aenderte sich vor der Hashbildung.`);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      digest.update(chunk);
      bytes += chunk.length;
      invariant(Number.isSafeInteger(bytes), `${label} ist fuer einen sicheren Bytebeleg zu gross.`);
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    invariant(pathAfter.isFile() && !pathAfter.isSymbolicLink(), `${label} ist nach der Hashbildung keine regulaere Datei mehr.`);
    invariant(sameStableMetadata(before, after) && sameStableMetadata(after, pathAfter) && BigInt(bytes) === after.size,
      `${label} aenderte sich waehrend der Hashbildung.`);
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function smallJsonSource(pathInput, label) {
  const path = resolve(pathInput);
  const pathBefore = await lstat(path, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n, `${label} ist keine nichtleere regulaere Datei.`);
  invariant(pathBefore.size <= BigInt(MAX_SMALL_JSON_BYTES), `${label} ueberschreitet das Limit fuer typisierte JSON-Metadaten.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && sameStableMetadata(pathBefore, before), `${label} aenderte sich vor dem Lesen.`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    invariant(pathAfter.isFile() && !pathAfter.isSymbolicLink(), `${label} ist nach dem Lesen keine regulaere Datei mehr.`);
    invariant(sameStableMetadata(before, after) && sameStableMetadata(after, pathAfter) && BigInt(bytes.length) === after.size,
      `${label} aenderte sich waehrend des Lesens.`);
    return { bytes, value: parseJson(bytes, label), proof: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
  } finally {
    await handle.close();
  }
}

function validatePortableRelativePath(value, label) {
  nonEmptyString(value, label);
  invariant(!isAbsolute(value) && !value.includes("\\") && !value.split("/").includes("..") && value !== ".", `${label} muss ein sicherer Workspace-relativer POSIX-Pfad sein.`);
  return value;
}

function portableRelativePath(workspaceRoot, pathInput, label) {
  const root = resolve(workspaceRoot);
  const path = resolve(pathInput);
  const result = relative(root, path);
  invariant(result !== "" && result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result), `${label} muss innerhalb des Workspace liegen.`);
  return result.replaceAll("\\", "/");
}

function resolvePortablePath(workspaceRoot, value, label) {
  validatePortableRelativePath(value, label);
  const root = resolve(workspaceRoot);
  const path = resolve(root, ...value.split("/"));
  invariant(path !== root && !relative(root, path).startsWith(`..${sep}`), `${label} verlaesst den Workspace.`);
  return path;
}

function validateProof(value, label) {
  exactKeys(value, ["bytes", "sha256"], label);
  positiveInteger(value.bytes, `${label}.bytes`);
  sha256(value.sha256, `${label}.sha256`);
  return value;
}

function validateFileProof(value, label) {
  exactKeys(value, ["file", "bytes", "sha256"], label);
  validatePortableRelativePath(value.file, `${label}.file`);
  positiveInteger(value.bytes, `${label}.bytes`);
  sha256(value.sha256, `${label}.sha256`);
  return value;
}

function validateValidatorRebuildBinding(value, label) {
  exactKeys(value, ["evidence", "normalizedPeSha256", "preserved", "rebuilt", "sourceCommit", "specification"], label);
  validateFileProof(value.specification, `${label}.specification`);
  exactKeys(value.evidence, ["bytes", "file", "schema", "sha256"], `${label}.evidence`);
  validateFileProof(
    { file: value.evidence.file, bytes: value.evidence.bytes, sha256: value.evidence.sha256 },
    `${label}.evidence`,
  );
  invariant(value.evidence.schema === GERMANY_OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE_SCHEMA,
    `${label}.evidence besitzt ein unbekanntes Schema.`);
  validateFileProof(value.preserved, `${label}.preserved`);
  validateFileProof(value.rebuilt, `${label}.rebuilt`);
  invariant(typeof value.sourceCommit === "string" && /^[a-f0-9]{40}$/u.test(value.sourceCommit), `${label}.sourceCommit muss ein voller Git-Commit sein.`);
  sha256(value.normalizedPeSha256, `${label}.normalizedPeSha256`);
  return value;
}

function validateStateFileProof(value, label) {
  exactKeys(value, ["file", "bytes", "sha256", "stateHash"], label);
  validatePortableRelativePath(value.file, `${label}.file`);
  positiveInteger(value.bytes, `${label}.bytes`);
  sha256(value.sha256, `${label}.sha256`);
  sha256(value.stateHash, `${label}.stateHash`);
  return value;
}

function validateMovementFileProof(value, label) {
  exactKeys(value, ["file", "bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256"], label);
  validatePortableRelativePath(value.file, `${label}.file`);
  positiveInteger(value.bytes, `${label}.bytes`);
  for (const field of ["sha256", "stateHash", "operationalStateHash"]) sha256(value[field], `${label}.${field}`);
  sha256OrNull(value.timetableTransferSetSha256, `${label}.timetableTransferSetSha256`);
  return value;
}

function proofMatches(actual, expected, label) {
  invariant(actual.bytes === expected.bytes && actual.sha256 === expected.sha256, `${label} driftet von seiner Receipt-Bindung.`);
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function nativeCandidateSidecarName(candidatePath) {
  const file = basename(candidatePath);
  invariant(file.endsWith(".json"), "Nativer Operational-v2-Candidate muss auf .json enden.");
  return `${file.slice(0, -5)}.movement-route-templates-v2.json`;
}

async function pinParentDirectory(pathInput, { create = false } = {}) {
  const requested = resolve(pathInput);
  if (create) await mkdir(requested, { recursive: true });
  const before = await lstat(requested, { bigint: true });
  invariant(before.isDirectory() && !before.isSymbolicLink(), "Operational-v2-Publikationselternpfad muss ein regulaeres Verzeichnis sein.");
  const real = await realpath(requested);
  invariant(normalizedPathForComparison(real) === normalizedPathForComparison(requested), "Operational-v2-Publikationselternpfad darf weder Symlink noch Junction enthalten.");
  const after = await lstat(real, { bigint: true });
  invariant(sameIdentity(before, after), "Operational-v2-Publikationselternpfad aenderte sich waehrend der Pin-Pruefung.");
  return { requested, real, identity: after };
}

async function assertPinnedParent(parent) {
  const currentReal = await realpath(parent.requested);
  invariant(normalizedPathForComparison(currentReal) === normalizedPathForComparison(parent.real), "Operational-v2-Publikationselternpfad wurde ausgetauscht.");
  const current = await lstat(parent.real, { bigint: true });
  invariant(current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, parent.identity), "Operational-v2-Publikationselternpfad verlor seine gepinnte Identitaet.");
}

async function proofFromBoundPublication(binding) {
  const before = await binding.handle.stat({ bigint: true });
  const pathBefore = await lstat(binding.path, { bigint: true });
  invariant(
    before.isFile()
      && pathBefore.isFile()
      && !pathBefore.isSymbolicLink()
      // Removing another hard link to this inode legitimately advances ctime.
      // Keep the original inode/size/mtime binding, while requiring the held
      // handle and the published path to agree on the current stable metadata.
      && sameIdentitySizeMtime(before, binding.identity)
      && sameIdentitySizeMtime(pathBefore, binding.identity)
      && sameStableMetadata(before, pathBefore),
    `${binding.label} wurde nach dem create-new Link fremd ersetzt oder veraendert.`,
  );
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < Number(before.size)) {
    const length = Math.min(buffer.length, Number(before.size) - position);
    const { bytesRead } = await binding.handle.read(buffer, 0, length, position);
    invariant(bytesRead === length, `${binding.label} konnte ueber den gehaltenen Handle nicht vollstaendig gelesen werden.`);
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await binding.handle.stat({ bigint: true });
  const pathAfter = await lstat(binding.path, { bigint: true });
  invariant(
    sameStableMetadata(before, after) && sameStableMetadata(after, pathAfter),
    `${binding.label} driftete waehrend der gehaltenen Zielpruefung.`,
  );
  return { bytes: position, sha256: digest.digest("hex") };
}

async function closeBoundPublications(bindings) {
  const errors = [];
  for (const binding of [...bindings].reverse()) {
    try {
      await binding.handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  bindings.length = 0;
  if (errors.length > 0) throw new AggregateError(errors, "Create-new-Zielhandles konnten nicht vollstaendig geschlossen werden.");
}

async function publishBoundFileCreateNew({
  sourcePath,
  outputPath,
  expectedIdentity,
  expectedProof,
  label,
  parent,
  registerOwned,
  afterLinkBeforeAudit,
}) {
  const source = resolve(sourcePath);
  const output = resolve(outputPath);
  const sourceBefore = await lstat(source, { bigint: true });
  invariant(sourceBefore.isFile() && !sourceBefore.isSymbolicLink() && sameIdentity(sourceBefore, expectedIdentity), `${label}-Quelle driftete vor dem create-new Link.`);
  await assertPinnedParent(parent);
  try {
    await link(source, output);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`${label} existiert bereits: ${output}`, { cause: error });
    throw error;
  }
  registerOwned({ outputPath: output, identity: expectedIdentity, label });
  if (afterLinkBeforeAudit !== undefined) await afterLinkBeforeAudit({ source, output, parent });
  await assertPinnedParent(parent);
  const handle = await open(output, "r");
  try {
    const [sourceAfter, outputAfter, held] = await Promise.all([
      lstat(source, { bigint: true }),
      lstat(output, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    invariant(
      sourceAfter.isFile()
        && outputAfter.isFile()
        && held.isFile()
        && !sourceAfter.isSymbolicLink()
        && !outputAfter.isSymbolicLink()
        && sameIdentity(sourceAfter, expectedIdentity)
        && sameIdentitySizeMtime(sourceBefore, sourceAfter)
        && sameStableMetadata(sourceAfter, outputAfter)
        && sameStableMetadata(outputAfter, held),
      `${label} wurde nicht als quell- und zielgebundener create-new Hardlink publiziert.`,
    );
    await assertPinnedParent(parent);
    const binding = { handle, identity: held, label, path: output, expectedProof };
    if (expectedProof !== undefined) proofMatches(await proofFromBoundPublication(binding), expectedProof, label);
    return binding;
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], `${label}-Bindung und Handle-Close sind fehlgeschlagen.`);
    }
    throw error;
  }
}

async function loadAndVerifyValidatorRebuild({
  workspaceRoot,
  validatorRebuildSpecificationPath,
  validatorRebuildEvidencePath,
  expectedReleaseId,
  expectedValidator,
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence,
}) {
  const specificationSource = await smallJsonSource(
    validatorRebuildSpecificationPath,
    "Operational-Validator-Rebuild-Spezifikation",
  );
  const verified = await verifyValidatorRebuildEvidence({
    spec: specificationSource.value,
    receiptPath: resolve(validatorRebuildEvidencePath),
    workspaceRoot: resolve(workspaceRoot),
  });
  invariant(isRecord(verified) && isRecord(verified.receipt) && isRecord(verified.proof),
    "Operational-Validator-Rebuild-Verifier lieferte keinen typisierten Beleg.");
  const receipt = verified.receipt;
  invariant(receipt.schema === GERMANY_OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE_SCHEMA,
    "Operational-Validator-Rebuild-Receipt besitzt ein unbekanntes Schema.");
  invariant(receipt.releaseId === expectedReleaseId,
    "Operational-Validator-Rebuild-Receipt bindet nicht die erwartete InfraRelease-ID.");
  invariant(isRecord(receipt.binaries?.preserved) && isRecord(receipt.binaries?.rebuilt),
    "Operational-Validator-Rebuild-Receipt besitzt kein vollstaendiges Binary-Paar.");
  invariant(isRecord(receipt.source?.git) && typeof receipt.source.git.commit === "string",
    "Operational-Validator-Rebuild-Receipt besitzt keinen geprueften Quellcommit.");
  invariant(isRecord(receipt.pe?.normalized) && typeof receipt.pe.normalized.expectedSha256 === "string",
    "Operational-Validator-Rebuild-Receipt besitzt keinen normalisierten PE-Beleg.");
  const evidenceProof = await regularFileProof(
    validatorRebuildEvidencePath,
    "Operational-Validator-Rebuild-Receipt",
  );
  proofMatches(evidenceProof, verified.proof, "Operational-Validator-Rebuild-Receipt");
  proofMatches(specificationSource.proof, receipt.specification, "Operational-Validator-Rebuild-Spezifikation");
  const binding = validateValidatorRebuildBinding({
    specification: {
      file: portableRelativePath(workspaceRoot, validatorRebuildSpecificationPath, "Operational-Validator-Rebuild-Spezifikation"),
      ...specificationSource.proof,
    },
    evidence: {
      file: portableRelativePath(workspaceRoot, validatorRebuildEvidencePath, "Operational-Validator-Rebuild-Receipt"),
      ...evidenceProof,
      schema: receipt.schema,
    },
    preserved: { ...receipt.binaries.preserved },
    rebuilt: { ...receipt.binaries.rebuilt },
    sourceCommit: receipt.source.git.commit,
    normalizedPeSha256: receipt.pe.normalized.expectedSha256,
  }, "Operational-Validator-Rebuild-Bindung");
  invariant(binding.specification.file === receipt.specification.file,
    "Operational-Validator-Rebuild-Receipt bindet einen anderen Spezifikationspfad.");
  if (expectedValidator !== undefined) {
    invariant(sameCanonicalValue(binding.preserved, expectedValidator),
      "Operational-Validator-Rebuild-Receipt bindet nicht das effektiv ausgefuehrte preserved Validator-Binary.");
  }
  return { binding, receipt, proof: evidenceProof, specificationSource };
}

function validateCaptureReceipt(value, expectedReleaseId) {
  exactKeys(value, ["schema", "infraReleaseId", "nativeReceipt", "specification", "sources", "producer", "validatorRebuild"], "Native-Receipt-Capture");
  invariant(value.schema === GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_SCHEMA, "Native-Receipt-Capture besitzt ein unbekanntes Schema.");
  invariant(value.infraReleaseId === expectedReleaseId, "Native-Receipt-Capture bindet nicht die erwartete InfraRelease-ID.");
  validateFileProof(value.specification, "Native-Receipt-Capture.specification");
  exactKeys(value.sources, ["candidate", "movementRouteTemplates", "report"], "Native-Receipt-Capture.sources");
  validateStateFileProof(value.sources.candidate, "Native-Receipt-Capture.sources.candidate");
  validateMovementFileProof(value.sources.movementRouteTemplates, "Native-Receipt-Capture.sources.movementRouteTemplates");
  validateFileProof(value.sources.report, "Native-Receipt-Capture.sources.report");
  exactKeys(value.producer, ["command", "executable", "captureEntrypoint", "executionInventory"], "Native-Receipt-Capture.producer");
  invariant(value.producer.command === "derive-germany-operational-v2", "Native-Receipt-Capture besitzt einen falschen nativen Befehl.");
  validateFileProof(value.producer.executable, "Native-Receipt-Capture.producer.executable");
  validateFileProof(value.producer.captureEntrypoint, "Native-Receipt-Capture.producer.captureEntrypoint");
  validateExecutionInventory(value.producer.executionInventory, "Native-Receipt-Capture.producer.executionInventory");
  invariant(sameCanonicalValue(value.producer.executable, value.producer.executionInventory.validatorExecutable),
    "Native-Receipt-Capture bindet Ausfuehrungsinventar und Validator-Binary verschieden.");
  validateValidatorRebuildBinding(value.validatorRebuild, "Native-Receipt-Capture.validatorRebuild");
  invariant(sameCanonicalValue(value.validatorRebuild.preserved, value.producer.executable),
    "Native-Receipt-Capture bindet Rebuild-Preserved und effektiv ausgefuehrtes Validator-Binary verschieden.");
  const expectedSidecarFile = basename(value.sources.movementRouteTemplates.file);
  const nativeReceipt = validateGermanyOperationalInfrastructureV2NativeReceipt(value.nativeReceipt, expectedReleaseId, {
    expectedMovementRouteTemplatesFile: expectedSidecarFile,
  });
  invariant(nativeReceipt.candidate.bytes === value.sources.candidate.bytes
    && nativeReceipt.candidate.sha256 === value.sources.candidate.sha256
    && nativeReceipt.candidate.stateHash === value.sources.candidate.stateHash,
  "Native-Receipt-Capture bindet Candidate und natives Receipt verschieden.");
  invariant(nativeReceipt.report.bytes === value.sources.report.bytes && nativeReceipt.report.sha256 === value.sources.report.sha256,
    "Native-Receipt-Capture bindet Bericht und natives Receipt verschieden.");
  invariant(nativeReceipt.movementRouteTemplates.bytes === value.sources.movementRouteTemplates.bytes
    && nativeReceipt.movementRouteTemplates.sha256 === value.sources.movementRouteTemplates.sha256
    && nativeReceipt.movementRouteTemplates.stateHash === value.sources.movementRouteTemplates.stateHash
    && nativeReceipt.movementRouteTemplates.operationalStateHash === value.sources.movementRouteTemplates.operationalStateHash
    && nativeReceipt.movementRouteTemplates.timetableTransferSetSha256 === value.sources.movementRouteTemplates.timetableTransferSetSha256,
  "Native-Receipt-Capture bindet Movement-Sidecar und natives Receipt verschieden.");
  return value;
}

function validateNativeTripletBindings({ specification, specificationProof, capture, report, candidateProof, movementProof, reportProof }) {
  invariant(report.inputs.spec.bytes === specificationProof.bytes && report.inputs.spec.sha256 === specificationProof.sha256,
    "Nativer Bericht bindet nicht die verwendeten Spezifikationsbytes.");
  proofMatches(candidateProof, capture.sources.candidate, "Operational-v2-Candidate");
  proofMatches(movementProof, capture.sources.movementRouteTemplates, "Operational-v2-Candidate-Sidecar");
  proofMatches(reportProof, capture.sources.report, "Operational-v2-Ableitungsbericht");
  invariant(report.candidate.bytes === capture.sources.candidate.bytes
    && report.candidate.sha256 === capture.sources.candidate.sha256
    && report.candidate.stateHash === capture.sources.candidate.stateHash,
  "Nativer Bericht und Capture besitzen verschiedene Candidate-Bindungen.");
  invariant(sameCanonicalValue(report.candidate.movementRouteTemplates, capture.nativeReceipt.movementRouteTemplates),
    "Nativer Bericht und Capture besitzen verschiedene Movement-Sidecar-Bindungen.");
  invariant(report.activationEligible === capture.nativeReceipt.activationEligible
    && report.unresolvedRequired === capture.nativeReceipt.unresolvedRequired,
  "Nativer Bericht und Capture besitzen verschiedene Aktivierungsgates.");
  invariant(capture.sources.movementRouteTemplates.operationalStateHash === capture.sources.candidate.stateHash,
    "Native Candidate- und Sidecar-Zustandsbindung laufen auseinander.");
  invariant(specification.infraReleaseId === capture.infraReleaseId, "Spezifikation und Native-Receipt-Capture besitzen verschiedene Release-IDs.");
}

async function loadAndValidateCapture({
  workspaceRoot,
  nativeReceiptPath,
  specificationPath,
  candidatePath,
  candidateMovementRouteTemplatesPath,
  reportPath,
  validatorRebuildSpecificationPath,
  validatorRebuildEvidencePath,
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence,
}) {
  const captureSource = await smallJsonSource(nativeReceiptPath, "Native-Receipt-Capture vor Validator-Ausfuehrung");
  const pinnedExecutionInventory = validateExecutionInventory(
    captureSource.value?.producer?.executionInventory,
    "Native-Receipt-Capture.producer.executionInventory vor Validator-Ausfuehrung",
  );
  executionInventoryMatches(
    await publisherExecutionInventoryProof(workspaceRoot, pinnedExecutionInventory.validatorExecutable),
    pinnedExecutionInventory,
    "Native-Receipt-Capture-Ausfuehrungsinventar vor Validator-Ausfuehrung",
  );
  const [specificationSource, reportSource, candidateProof, movementProof] = await Promise.all([
    smallJsonSource(specificationPath, "Operational-v2-Spezifikation"),
    smallJsonSource(reportPath, "Nativer Operational-v2-Ableitungsbericht"),
    regularFileProof(candidatePath, "Nativer Operational-v2-Candidate"),
    regularFileProof(candidateMovementRouteTemplatesPath, "Natives Candidate-Movement-Sidecar"),
  ]);
  const kind = validateGermanyOperationalInfrastructureV2Specification(specificationSource.value);
  if (kind !== "conservative") throw new OperationalInfrastructureDerivationBlockedError(assessGermanyOperationalInfrastructureV2Readiness(specificationSource.value));
  const capture = validateCaptureReceipt(captureSource.value, specificationSource.value.infraReleaseId);
  invariant(captureSource.bytes.equals(serializeGermanyOperationalPublicationJson(capture)), "Native-Receipt-Capture ist nicht kanonisch serialisiert.");
  const expectedFiles = {
    specification: portableRelativePath(workspaceRoot, specificationPath, "Operational-v2-Spezifikation"),
    nativeReceipt: portableRelativePath(workspaceRoot, nativeReceiptPath, "Native-Receipt-Capture"),
    candidate: portableRelativePath(workspaceRoot, candidatePath, "Operational-v2-Candidate"),
    movement: portableRelativePath(workspaceRoot, candidateMovementRouteTemplatesPath, "Operational-v2-Candidate-Sidecar"),
    report: portableRelativePath(workspaceRoot, reportPath, "Operational-v2-Ableitungsbericht"),
    validatorRebuildSpecification: portableRelativePath(workspaceRoot, validatorRebuildSpecificationPath, "Operational-Validator-Rebuild-Spezifikation"),
    validatorRebuildEvidence: portableRelativePath(workspaceRoot, validatorRebuildEvidencePath, "Operational-Validator-Rebuild-Receipt"),
  };
  invariant(capture.specification.file === expectedFiles.specification
    && capture.sources.candidate.file === expectedFiles.candidate
    && capture.sources.movementRouteTemplates.file === expectedFiles.movement
    && capture.sources.report.file === expectedFiles.report
    && capture.validatorRebuild.specification.file === expectedFiles.validatorRebuildSpecification
    && capture.validatorRebuild.evidence.file === expectedFiles.validatorRebuildEvidence,
  "Publisher-Eingabepfade driften vom Native-Receipt-Capture.");
  proofMatches(specificationSource.proof, capture.specification, "Operational-v2-Spezifikation");
  const report = validateGermanyOperationalInfrastructureV2NativeReport(reportSource.value, specificationSource.value, {
    expectedMovementRouteTemplatesFile: basename(candidateMovementRouteTemplatesPath),
  });
  validateNativeTripletBindings({
    specification: specificationSource.value,
    specificationProof: specificationSource.proof,
    capture,
    report,
    candidateProof,
    movementProof,
    reportProof: reportSource.proof,
  });
  for (const producer of [capture.producer.executable, capture.producer.captureEntrypoint]) {
    const actual = await regularFileProof(resolvePortablePath(workspaceRoot, producer.file, "Native-Receipt-Capture-Provenienzpfad"), "Native-Receipt-Capture-Provenienz");
    proofMatches(actual, producer, "Native-Receipt-Capture-Provenienz");
  }
  const validatorRebuild = await loadAndVerifyValidatorRebuild({
    workspaceRoot,
    validatorRebuildSpecificationPath,
    validatorRebuildEvidencePath,
    expectedReleaseId: capture.infraReleaseId,
    expectedValidator: capture.producer.executable,
    verifyValidatorRebuildEvidence,
  });
  invariant(sameCanonicalValue(validatorRebuild.binding, capture.validatorRebuild),
    "Native-Receipt-Capture driftet vom erneut geprueften Operational-Validator-Rebuild-Beleg.");
  return { specificationSource, captureSource, capture, reportSource, report, candidateProof, movementProof, expectedFiles, validatorRebuild };
}

async function writeNewFile(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeHandleBytes(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    invariant(bytesWritten > 0, "Publication-Receipt-Schreibvorgang machte keinen Fortschritt.");
    offset += bytesWritten;
  }
}

async function copyRegularFileStreaming(sourceInput, destinationInput, { onChunk } = {}) {
  const source = resolve(sourceInput);
  const destination = resolve(destinationInput);
  const pathBefore = await lstat(source, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n, "Candidate-Movement-Sidecar ist keine nichtleere regulaere Datei.");
  invariant(pathBefore.size <= BigInt(Number.MAX_SAFE_INTEGER), "Candidate-Movement-Sidecar ist fuer einen sicheren Bytebeleg zu gross.");
  const sourceHandle = await open(source, "r");
  try {
    const before = await sourceHandle.stat({ bigint: true });
    invariant(before.isFile() && sameStableMetadata(pathBefore, before), "Candidate-Movement-Sidecar aenderte sich vor der Streaming-Kopie.");
    const output = await open(destination, "wx", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of sourceHandle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
          invariant(bytesWritten > 0, "Streaming-Kopie schrieb keine weiteren Bytes.");
          offset += bytesWritten;
        }
        bytes += chunk.length;
        invariant(Number.isSafeInteger(bytes), "Candidate-Movement-Sidecar ist fuer einen sicheren Bytebeleg zu gross.");
        if (onChunk !== undefined) await onChunk({ bytes, rss: process.memoryUsage().rss });
      }
      await output.sync();
    } finally {
      await output.close();
    }
    const after = await sourceHandle.stat({ bigint: true });
    const pathAfter = await lstat(source, { bigint: true });
    invariant(pathAfter.isFile() && !pathAfter.isSymbolicLink(), "Candidate-Movement-Sidecar ist nach der Streaming-Kopie keine regulaere Datei mehr.");
    invariant(sameStableMetadata(before, after) && sameStableMetadata(after, pathAfter) && BigInt(bytes) === after.size,
      "Candidate-Movement-Sidecar aenderte sich waehrend der Streaming-Kopie.");
    const proof = { bytes, sha256: digest.digest("hex") };
    proofMatches(await regularFileProof(destination, "Gestagetes Movement-Sidecar"), proof, "Gestagetes Movement-Sidecar");
    return proof;
  } finally {
    await sourceHandle.close();
  }
}

async function captureScriptProof(workspaceRoot, entrypointPath, expectedEntrypoint) {
  const file = portableRelativePath(workspaceRoot, entrypointPath, "Receipt-Capture-Entrypoint");
  invariant(file === expectedEntrypoint, `Receipt-Capture-Entrypoint muss ${expectedEntrypoint} sein.`);
  return { file, ...(await regularFileProof(entrypointPath, "Receipt-Capture-Entrypoint")) };
}

async function publisherExecutionInventoryProof(workspaceRoot, validatorExecutable) {
  const entries = await Promise.all(Object.entries(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES).map(async ([id, file]) => [
    id,
    { file, ...(await regularFileProof(resolvePortablePath(workspaceRoot, file, `Operational-v2-Ausfuehrungsinventar.${id}`), `Operational-v2-Ausfuehrungsinventar.${id}`)) },
  ]));
  return {
    ...Object.fromEntries(entries),
    validatorExecutable: {
      ...validatorExecutable,
      ...(await regularFileProof(
        resolvePortablePath(workspaceRoot, validatorExecutable.file, "Operational-v2-Validator-Binary"),
        "Operational-v2-Validator-Binary",
      )),
    },
  };
}

function executionInventoryMatches(actual, expected, label) {
  for (const id of [...Object.keys(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES), "validatorExecutable"]) {
    invariant(actual[id].file === expected[id].file, `${label}.${id} bindet einen anderen Pfad.`);
    proofMatches(actual[id], expected[id], `${label}.${id}`);
  }
}

function validateExecutionInventory(value, label) {
  exactKeys(value, [...Object.keys(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES), "validatorExecutable"], label);
  for (const [id, file] of Object.entries(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES)) {
    const proof = validateFileProof(value[id], `${label}.${id}`);
    invariant(proof.file === file, `${label}.${id} bindet nicht den festgelegten Implementierungspfad.`);
  }
  validateFileProof(value.validatorExecutable, `${label}.validatorExecutable`);
  return value;
}

function captureClaimPath(parent) {
  return join(parent, CAPTURE_CLAIM_FILE);
}

function validateCaptureClaim(value) {
  exactKeys(value, ["schema", "parent", "claim", "staging", "target", "receipt"], "Native-Receipt-Capture-Claim");
  invariant(value.schema === GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_CLAIM_SCHEMA, "Native-Receipt-Capture-Claim besitzt ein unbekanntes Schema.");
  for (const [label, identity] of [["parent", value.parent], ["claim", value.claim], ["staging.identity", value.staging?.identity], ["receipt.identity", value.receipt?.identity]]) {
    exactKeys(identity, ["dev", "ino"], `Native-Receipt-Capture-Claim.${label}`);
    invariant(DECIMAL.test(identity.dev) && DECIMAL.test(identity.ino), `Native-Receipt-Capture-Claim.${label} besitzt keine Dateisystemidentitaet.`);
  }
  exactKeys(value.staging, ["directory", "identity", "files"], "Native-Receipt-Capture-Claim.staging");
  invariant(typeof value.staging.directory === "string" && value.staging.directory.startsWith(CAPTURE_STAGING_PREFIX) && basename(value.staging.directory) === value.staging.directory,
    "Native-Receipt-Capture-Claim bindet kein sicheres Staging-Verzeichnis.");
  exactKeys(value.staging.files, [NATIVE_RECEIPT_FILE, CAPTURE_CLAIM_FILE], "Native-Receipt-Capture-Claim.staging.files");
  for (const [name, identity] of Object.entries(value.staging.files)) {
    exactKeys(identity, ["dev", "ino"], `Native-Receipt-Capture-Claim.staging.files.${name}`);
    invariant(DECIMAL.test(identity.dev) && DECIMAL.test(identity.ino), `Native-Receipt-Capture-Claim.staging.files.${name} besitzt keine Dateisystemidentitaet.`);
  }
  invariant(value.target === NATIVE_RECEIPT_FILE, "Native-Receipt-Capture-Claim bindet keinen kanonischen Zielnamen.");
  exactKeys(value.receipt, ["bytes", "sha256", "identity"], "Native-Receipt-Capture-Claim.receipt");
  validateProof({ bytes: value.receipt.bytes, sha256: value.receipt.sha256 }, "Native-Receipt-Capture-Claim.receipt");
  return value;
}

async function acquireCaptureClaim(parent, staging, stagingIdentity, stagedReceipt, receiptIdentity, receiptProof, hooks, registerStagedClaim) {
  const stagedClaim = join(staging, CAPTURE_CLAIM_FILE);
  const finalClaim = captureClaimPath(parent.real);
  let handle;
  let binding;
  let owned;
  let claimIdentity;
  try {
    handle = await open(stagedClaim, "wx", 0o600);
    claimIdentity = await handle.stat({ bigint: true });
    registerStagedClaim(claimIdentity);
    const value = validateCaptureClaim({
      schema: GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_CLAIM_SCHEMA,
      parent: identityValue(parent.identity),
      claim: identityValue(claimIdentity),
      staging: {
        directory: basename(staging),
        identity: identityValue(stagingIdentity),
        files: {
          [NATIVE_RECEIPT_FILE]: identityValue(receiptIdentity),
          [CAPTURE_CLAIM_FILE]: identityValue(claimIdentity),
        },
      },
      target: NATIVE_RECEIPT_FILE,
      receipt: { ...receiptProof, identity: identityValue(receiptIdentity) },
    });
    const bytes = serializeGermanyOperationalPublicationJson(value);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    binding = await publishBoundFileCreateNew({
      sourcePath: stagedClaim,
      outputPath: finalClaim,
      expectedIdentity: claimIdentity,
      expectedProof: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
      label: "Native-Receipt-Capture-Claim",
      parent,
      registerOwned: (entry) => { owned = entry; },
      afterLinkBeforeAudit: hooks?.afterNativeReceiptClaimLinkBeforeAudit,
    });
    return { path: finalClaim, identity: claimIdentity, value, binding, stagedClaimIdentity: claimIdentity };
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    const cleanupErrors = [];
    if (binding !== undefined) await binding.handle.close().catch((closeError) => cleanupErrors.push(closeError));
    if (owned !== undefined) {
      await removeOwnedPathByQuarantine(parent, finalClaim, owned.identity, { kind: "file", label: "Native-Receipt-Capture-Claim", hooks })
        .catch((rollbackError) => cleanupErrors.push(rollbackError));
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Native-Receipt-Capture-Claim und owned-only Recovery sind fehlgeschlagen.");
    throw error;
  }
}

async function readCaptureClaim(parent) {
  const path = captureClaimPath(parent.real);
  const metadata = await maybeMetadata(path);
  if (metadata === null) return null;
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0n && metadata.size <= BigInt(MAX_SMALL_JSON_BYTES), "Native-Receipt-Capture-Claim ist keine gueltige regulaere Datei.");
  const source = await smallJsonSource(path, "Native-Receipt-Capture-Claim");
  const value = validateCaptureClaim(source.value);
  invariant(source.bytes.equals(serializeGermanyOperationalPublicationJson(value)), "Native-Receipt-Capture-Claim ist nicht kanonisch serialisiert.");
  invariant(identityMatches(metadata, value.claim) && identityMatches(parent.identity, value.parent), "Native-Receipt-Capture-Claim bindet Claim oder Elternverzeichnis falsch.");
  return { path, identity: metadata, value };
}

async function recoverCaptureClaimIfPresent({ parent, output, expectedProof, expectedReceipt, hooks = {} }) {
  const claim = await readCaptureClaim(parent);
  const outputMetadata = await maybeMetadata(output);
  const orphanStaging = (await readdir(parent.real)).filter((name) => name.startsWith(CAPTURE_STAGING_PREFIX));
  if (claim === null) {
    invariant(orphanStaging.length === 0, "Native-Receipt-Capture besitzt verwaistes Staging ohne recoverbaren Claim.");
    if (outputMetadata === null) return null;
    proofMatches(await regularFileProof(output, "Bereits vollstaendiger Native-Receipt-Capture"), expectedProof, "Bereits vollstaendiger Native-Receipt-Capture");
    const source = await smallJsonSource(output, "Bereits vollstaendiger Native-Receipt-Capture");
    invariant(source.bytes.equals(serializeGermanyOperationalPublicationJson(expectedReceipt)), "Bestehender Native-Receipt-Capture driftet vom erwarteten kanonischen Receipt.");
    await assertPinnedParent(parent);
    return { path: output, receipt: expectedReceipt, ...expectedProof, recovery: "already-complete" };
  }
  invariant(orphanStaging.length <= 1 && (orphanStaging.length === 0 || orphanStaging[0] === claim.value.staging.directory), "Native-Receipt-Capture-Claim besitzt zusaetzliches fremdes Staging.");
  invariant(claim.value.target === basename(output), "Native-Receipt-Capture-Claim bindet ein anderes Ziel.");
  proofMatches(claim.value.receipt, expectedProof, "Native-Receipt-Capture-Claim-Receipt");
  const staging = join(parent.real, claim.value.staging.directory);
  const stagingMetadata = await maybeMetadata(staging);
  if (stagingMetadata !== null) {
    invariant(stagingMetadata.isDirectory() && !stagingMetadata.isSymbolicLink() && identityMatches(stagingMetadata, claim.value.staging.identity), "Native-Receipt-Capture-Recovery-Staging wurde fremd ersetzt.");
  }
  if (outputMetadata !== null) {
    invariant(outputMetadata.isFile() && !outputMetadata.isSymbolicLink() && identityMatches(outputMetadata, claim.value.receipt.identity), "Native-Receipt-Capture-Ziel wurde nach Crash fremd ersetzt.");
    proofMatches(await regularFileProof(output, "Recoverter Native-Receipt-Capture"), expectedProof, "Recoverter Native-Receipt-Capture");
  }
  if (stagingMetadata !== null) {
    await removeOwnedPathByQuarantine(parent, staging, stagingMetadata, {
      kind: "directory",
      label: "Native-Receipt-Capture-Recovery-Staging",
      hooks,
      expectedFiles: {
        [NATIVE_RECEIPT_FILE]: claim.value.staging.files[NATIVE_RECEIPT_FILE],
        [CAPTURE_CLAIM_FILE]: claim.value.staging.files[CAPTURE_CLAIM_FILE],
      },
    });
  }
  await removeOwnedPathByQuarantine(parent, claim.path, claim.identity, { kind: "file", label: "Native-Receipt-Capture-Claim", hooks });
  invariant(await maybeMetadata(claim.path) === null, "Native-Receipt-Capture-Claim blieb nach Recovery sichtbar.");
  await assertPinnedParent(parent);
  if (outputMetadata === null) return null;
  proofMatches(await regularFileProof(output, "Native-Receipt-Capture nach Recovery-Cleanup"), expectedProof, "Native-Receipt-Capture nach Recovery-Cleanup");
  return { path: output, receipt: expectedReceipt, ...expectedProof, recovery: "completed" };
}

export async function captureGermanyOperationalInfrastructureV2NativeReceipt({
  nativeReceipt,
  specificationPath,
  candidatePath,
  candidateMovementRouteTemplatesPath,
  reportPath,
  nativeExecutablePath,
  validatorRebuildSpecificationPath,
  validatorRebuildEvidencePath,
  outputPath,
  workspaceRoot = REPOSITORY_ROOT,
  captureEntrypointPath = resolve(REPOSITORY_ROOT, GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_ENTRYPOINT),
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence,
  hooks = {},
}) {
  const root = resolve(workspaceRoot);
  const [executableProof, captureEntrypoint] = await Promise.all([
    regularFileProof(nativeExecutablePath, "Nativer Operational-v2-Compiler vor Validator-Ausfuehrung"),
    captureScriptProof(root, captureEntrypointPath, GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_ENTRYPOINT),
  ]);
  const executableBinding = {
    file: portableRelativePath(root, nativeExecutablePath, "Nativer Operational-v2-Compiler"),
    ...executableProof,
  };
  const executionInventoryBefore = await publisherExecutionInventoryProof(root, executableBinding);
  proofMatches(executionInventoryBefore.validatorExecutable, executableBinding, "Nativer Operational-v2-Compiler vor Capture-Validierung");
  const specification = await smallJsonSource(specificationPath, "Operational-v2-Spezifikation");
  const kind = validateGermanyOperationalInfrastructureV2Specification(specification.value);
  if (kind !== "conservative") throw new OperationalInfrastructureDerivationBlockedError(assessGermanyOperationalInfrastructureV2Readiness(specification.value));
  const expectedSidecarFile = nativeCandidateSidecarName(candidatePath);
  invariant(basename(candidateMovementRouteTemplatesPath) === expectedSidecarFile
    && resolve(candidateMovementRouteTemplatesPath) === join(dirname(resolve(candidatePath)), expectedSidecarFile),
  "Candidate-Sidecar besitzt nicht den vom Candidate abgeleiteten Geschwisterpfad.");
  const validatedNativeReceipt = validateGermanyOperationalInfrastructureV2NativeReceipt(nativeReceipt, specification.value.infraReleaseId, {
    expectedMovementRouteTemplatesFile: expectedSidecarFile,
  });
  const [candidateProof, movementProof, reportSource] = await Promise.all([
    regularFileProof(candidatePath, "Nativer Operational-v2-Candidate"),
    regularFileProof(candidateMovementRouteTemplatesPath, "Natives Candidate-Movement-Sidecar"),
    smallJsonSource(reportPath, "Nativer Operational-v2-Ableitungsbericht"),
  ]);
  const report = validateGermanyOperationalInfrastructureV2NativeReport(reportSource.value, specification.value, {
    expectedMovementRouteTemplatesFile: expectedSidecarFile,
  });
  const validatorRebuild = await loadAndVerifyValidatorRebuild({
    workspaceRoot: root,
    validatorRebuildSpecificationPath,
    validatorRebuildEvidencePath,
    expectedReleaseId: specification.value.infraReleaseId,
    expectedValidator: executableBinding,
    verifyValidatorRebuildEvidence,
  });
  const capture = validateCaptureReceipt({
    schema: GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_SCHEMA,
    infraReleaseId: specification.value.infraReleaseId,
    nativeReceipt: validatedNativeReceipt,
    specification: { file: portableRelativePath(root, specificationPath, "Operational-v2-Spezifikation"), ...specification.proof },
    sources: {
      candidate: { file: portableRelativePath(root, candidatePath, "Operational-v2-Candidate"), ...candidateProof, stateHash: validatedNativeReceipt.candidate.stateHash },
      movementRouteTemplates: {
        file: portableRelativePath(root, candidateMovementRouteTemplatesPath, "Candidate-Movement-Sidecar"),
        ...movementProof,
        stateHash: validatedNativeReceipt.movementRouteTemplates.stateHash,
        operationalStateHash: validatedNativeReceipt.movementRouteTemplates.operationalStateHash,
        timetableTransferSetSha256: validatedNativeReceipt.movementRouteTemplates.timetableTransferSetSha256,
      },
      report: { file: portableRelativePath(root, reportPath, "Operational-v2-Ableitungsbericht"), ...reportSource.proof },
    },
    producer: {
      command: "derive-germany-operational-v2",
      executable: executableBinding,
      captureEntrypoint,
      executionInventory: executionInventoryBefore,
    },
    validatorRebuild: validatorRebuild.binding,
  }, specification.value.infraReleaseId);
  validateNativeTripletBindings({
    specification: specification.value,
    specificationProof: specification.proof,
    capture,
    report,
    candidateProof,
    movementProof,
    reportProof: reportSource.proof,
  });
  executionInventoryMatches(
    await publisherExecutionInventoryProof(root, executableBinding),
    executionInventoryBefore,
    "Native-Receipt-Capture-Ausfuehrungsinventar nach Validierung",
  );
  const output = resolve(outputPath);
  invariant(basename(output) === NATIVE_RECEIPT_FILE, `Native-Receipt-Capture muss ${NATIVE_RECEIPT_FILE} heissen.`);
  const parent = await pinParentDirectory(dirname(output), { create: true });
  invariant(dirname(output) === parent.real, "Native-Receipt-Ziel muss direkt im gepinnten Elternverzeichnis liegen.");
  const bytes = serializeGermanyOperationalPublicationJson(capture);
  const expectedProof = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const recovered = await recoverCaptureClaimIfPresent({ parent, output, expectedProof, expectedReceipt: capture, hooks });
  if (recovered !== null) return recovered;
  await assertCreateNewTargets([{ path: output, label: "Native-Receipt-Capture" }]);
  const staging = await mkdtemp(join(parent.real, CAPTURE_STAGING_PREFIX));
  const stagingIdentity = await lstat(staging, { bigint: true });
  const staged = join(staging, basename(output));
  let stagedIdentity;
  let stagedClaimIdentity;
  let claim;
  const publishedEntries = [];
  const publishedBindings = [];
  let result;
  let primaryError;
  try {
    await writeNewFile(staged, bytes);
    stagedIdentity = await lstat(staged, { bigint: true });
    claim = await acquireCaptureClaim(parent, staging, stagingIdentity, staged, stagedIdentity, expectedProof, hooks, (identity) => { stagedClaimIdentity = identity; });
    const binding = await publishBoundFileCreateNew({
      sourcePath: staged,
      outputPath: output,
      expectedIdentity: stagedIdentity,
      expectedProof,
      label: "Native-Receipt-Capture",
      parent,
      registerOwned: (entry) => publishedEntries.push(entry),
      afterLinkBeforeAudit: hooks?.afterNativeReceiptSourceLinkBeforeAudit,
    });
    publishedBindings.push(binding);
    await runHook(hooks, "afterNativeReceiptLink", { parent, output, staging, staged });
    proofMatches(await proofFromBoundPublication(binding), expectedProof, "Publizierter Native-Receipt-Capture");
    result = { path: output, receipt: capture, ...expectedProof };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (primaryError !== undefined && publishedBindings.length > 0) {
    try {
      await closeBoundPublications(publishedBindings);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError !== undefined && publishedEntries.length > 0) {
    try {
      await rollbackOwnedPublishedEntries(parent, publishedEntries, hooks);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await removeOwnedPathByQuarantine(parent, staging, stagingIdentity, {
      kind: "directory",
      label: "Native-Receipt-Capture-Staging",
      hooks,
      expectedFiles: stagedIdentity === undefined ? {} : {
        [basename(output)]: stagedIdentity,
        ...(stagedClaimIdentity === undefined ? {} : { [CAPTURE_CLAIM_FILE]: stagedClaimIdentity }),
      },
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (claim !== undefined && cleanupErrors.length === 0) {
    try {
      if (claim.binding !== undefined) {
        await claim.binding.handle.close();
        claim.binding = undefined;
      }
      await removeOwnedPathByQuarantine(parent, claim.path, claim.identity, { kind: "file", label: "Native-Receipt-Capture-Claim", hooks });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (claim?.binding !== undefined) {
    try {
      await claim.binding.handle.close();
      claim.binding = undefined;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError === undefined && cleanupErrors.length > 0 && publishedBindings.length > 0) {
    try { await closeBoundPublications(publishedBindings); } catch (error) { cleanupErrors.push(error); }
  }
  if (primaryError === undefined && cleanupErrors.length > 0 && publishedEntries.length > 0) {
    try { await rollbackOwnedPublishedEntries(parent, publishedEntries, hooks); } catch (error) { cleanupErrors.push(error); }
  }
  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        `Native-Receipt-Capture scheiterte: ${errorDetail(primaryError)}; owned-only Rollback/Cleanup meldete zusaetzlich: ${cleanupErrors.map(errorDetail).join(" | ")}`,
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    throw new AggregateError(cleanupErrors, "Native-Receipt-Capture-Cleanup und owned-only Rollback sind fehlgeschlagen.");
  }
  let finalAuditError;
  try {
    await runHook(hooks, "afterNativeReceiptCleanupBeforeFinalAudit", { parent, output });
    await assertPinnedParent(parent);
    for (const binding of publishedBindings) {
      proofMatches(await proofFromBoundPublication(binding), expectedProof, "Native-Receipt-Capture nach Cleanup");
    }
    invariant(await maybeMetadata(captureClaimPath(parent.real)) === null, "Native-Receipt-Capture-Claim blieb nach Success sichtbar.");
    proofMatches(await regularFileProof(output, "Native-Receipt-Capture unmittelbar vor Success"), expectedProof, "Native-Receipt-Capture unmittelbar vor Success");
    await assertPinnedParent(parent);
  } catch (error) {
    finalAuditError = error;
  }
  let finalCloseError;
  try { await closeBoundPublications(publishedBindings); } catch (error) { finalCloseError = error; }
  if (finalAuditError && finalCloseError) {
    throw new AggregateError([finalAuditError, finalCloseError], "Finaler Native-Receipt-Capture-Audit und Handle-Close sind fehlgeschlagen.");
  }
  if (finalAuditError) throw finalAuditError;
  if (finalCloseError) throw finalCloseError;
  return result;
}

function publicationPaths(outputPath, publicationReceiptPath) {
  const output = resolve(outputPath);
  const parent = dirname(output);
  const movementRouteTemplates = join(parent, SIDECAR_FILE);
  const receipt = resolve(publicationReceiptPath);
  invariant(basename(output) === OPERATIONAL_FILE, `Operational-v2-Ausgabe muss ${OPERATIONAL_FILE} heissen.`);
  invariant(dirname(receipt) === parent, "Publication-Receipt muss neben der finalen Operational-v2-Paarung liegen.");
  invariant(basename(receipt) === PUBLICATION_RECEIPT_FILE, `Publication-Receipt muss ${PUBLICATION_RECEIPT_FILE} heissen.`);
  invariant(new Set([output, movementRouteTemplates, receipt]).size === 3, "Finale Operational-v2-Ziele muessen getrennte Dateien sein.");
  return { parent, output, movementRouteTemplates, receipt };
}

function claimPath(parent) {
  return join(parent, CLAIM_FILE);
}

function validateClaim(value) {
  exactKeys(value, ["schema", "runId", "parent", "claim", "staging", "targets"], "Operational-v2-Publikationsclaim");
  invariant(value.schema === GERMANY_OPERATIONAL_PUBLICATION_CLAIM_SCHEMA, "Operational-v2-Publikationsclaim besitzt ein unbekanntes Schema.");
  nonEmptyString(value.runId, "Operational-v2-Publikationsclaim.runId");
  for (const [name, identity] of Object.entries({ parent: value.parent, claim: value.claim, staging: value.staging.identity })) {
    exactKeys(identity, ["dev", "ino"], `Operational-v2-Publikationsclaim.${name}`);
    invariant(DECIMAL.test(identity.dev) && DECIMAL.test(identity.ino), `Operational-v2-Publikationsclaim.${name} besitzt keine Dateisystemidentitaet.`);
  }
  exactKeys(value.staging, ["directory", "identity", "files"], "Operational-v2-Publikationsclaim.staging");
  invariant(typeof value.staging.directory === "string" && value.staging.directory.startsWith(STAGING_PREFIX) && basename(value.staging.directory) === value.staging.directory,
    "Operational-v2-Publikationsclaim besitzt kein sicheres Staging-Verzeichnis.");
  exactKeys(value.staging.files, [SIDECAR_FILE, OPERATIONAL_FILE, PUBLICATION_RECEIPT_FILE, CLAIM_FILE], "Operational-v2-Publikationsclaim.staging.files");
  for (const [file, identity] of Object.entries(value.staging.files)) {
    exactKeys(identity, ["dev", "ino"], `Operational-v2-Publikationsclaim.staging.files.${file}`);
    invariant(DECIMAL.test(identity.dev) && DECIMAL.test(identity.ino), `Operational-v2-Publikationsclaim.staging.files.${file} besitzt keine Dateisystemidentitaet.`);
  }
  exactKeys(value.targets, ["movementRouteTemplates", "operationalInfrastructure", "publicationReceipt"], "Operational-v2-Publikationsclaim.targets");
  invariant(value.targets.movementRouteTemplates === SIDECAR_FILE && value.targets.operationalInfrastructure === OPERATIONAL_FILE,
    "Operational-v2-Publikationsclaim besitzt falsche kanonische Zielnamen.");
  invariant(value.targets.publicationReceipt === PUBLICATION_RECEIPT_FILE,
    "Operational-v2-Publikationsclaim besitzt keinen kanonischen Receipt-Zielnamen.");
  return value;
}

async function acquireClaim(parent, staging, receiptFile, stagedFiles, hooks = {}) {
  await assertPinnedParent(parent);
  const stagingMetadata = await lstat(staging, { bigint: true });
  invariant(stagingMetadata.isDirectory() && !stagingMetadata.isSymbolicLink(), "Operational-v2-Publikationsstaging ist kein regulaeres Verzeichnis.");
  const path = claimPath(parent.real);
  const stagedClaim = join(staging, CLAIM_FILE);
  let handle;
  let binding;
  let owned;
  try {
    handle = await open(stagedClaim, "wx", 0o600);
    const claimMetadata = await handle.stat({ bigint: true });
    stagedFiles[CLAIM_FILE] = claimMetadata;
    const value = validateClaim({
      schema: GERMANY_OPERATIONAL_PUBLICATION_CLAIM_SCHEMA,
      runId: randomUUID(),
      parent: identityValue(parent.identity),
      claim: identityValue(claimMetadata),
      staging: {
        directory: basename(staging),
        identity: identityValue(stagingMetadata),
        files: Object.fromEntries(Object.entries(stagedFiles).map(([file, metadata]) => [file, identityValue(metadata)])),
      },
      targets: {
        movementRouteTemplates: SIDECAR_FILE,
        operationalInfrastructure: OPERATIONAL_FILE,
        publicationReceipt: receiptFile,
      },
    });
    await handle.writeFile(serializeGermanyOperationalPublicationJson(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    binding = await publishBoundFileCreateNew({
      sourcePath: stagedClaim,
      outputPath: path,
      expectedIdentity: claimMetadata,
      expectedProof: { bytes: serializeGermanyOperationalPublicationJson(value).length, sha256: createHash("sha256").update(serializeGermanyOperationalPublicationJson(value)).digest("hex") },
      label: "Operational-v2-Publikationsclaim",
      parent,
      registerOwned: (entry) => { owned = entry; },
      afterLinkBeforeAudit: hooks.afterClaimSourceLinkBeforeAudit,
    });
    return { path, identity: claimMetadata, value, binding };
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    const recoveryErrors = [];
    if (binding !== undefined) {
      try { await binding.handle.close(); } catch (closeError) { recoveryErrors.push(closeError); }
    }
    if (owned !== undefined) {
      try {
        await removeOwnedPathByQuarantine(parent, path, owned.identity, { kind: "file", label: "Operational-v2-Publikationsclaim", hooks });
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError);
      }
    }
    if (error !== null && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`Operational-v2-Publikationsclaim existiert bereits; Preflight/Recovery ist erforderlich: ${path}`, { cause: error });
    }
    if (recoveryErrors.length > 0) throw new AggregateError([error, ...recoveryErrors], "Operational-v2-Publikationsclaim-Erstellung und owned-only Recovery sind fehlgeschlagen.");
    throw error;
  }
}

async function restoreMismatchedQuarantine({ original, quarantined, quarantineRoot, kind, label }) {
  try {
    invariant(await maybeMetadata(original) === null, `${label} wurde waehrend der Quarantaene erneut fremd belegt.`);
    if (kind === "file") {
      await link(quarantined, original);
      await unlink(quarantined);
    } else {
      await rename(quarantined, original);
    }
    await rmdir(quarantineRoot);
  } catch (restoreError) {
    throw new AggregateError(
      [restoreError],
      `${label} wurde vor der owned-only Loeschung fremd ersetzt; die fremde Identitaet wurde nicht geloescht.`,
    );
  }
}

async function restoreMismatchedDirectoryEntry({ original, quarantined, entryQuarantine, label }) {
  try {
    invariant(await maybeMetadata(original) === null, `${label} wurde nach der Quarantaene erneut fremd belegt.`);
    await rename(quarantined, original);
    await rmdir(entryQuarantine);
  } catch (restoreError) {
    throw new AggregateError(
      [restoreError],
      `${label} wurde im Directory-Cleanup fremd ersetzt; die fremde Identitaet bleibt in der Quarantaene erhalten.`,
    );
  }
}

async function removeOwnedPathByQuarantine(
  parent,
  pathInput,
  expectedIdentity,
  { kind, label, expectedFiles = {}, hooks = {} },
) {
  await assertPinnedParent(parent);
  const original = resolve(pathInput);
  invariant(dirname(original) === parent.real, `${label} liegt nicht direkt im gepinnten Elternverzeichnis.`);
  const current = await maybeMetadata(original);
  invariant(current !== null, `${label} fehlt vor der owned-only Loeschung.`);
  invariant(
    (kind === "file" ? current.isFile() : current.isDirectory())
      && !current.isSymbolicLink()
      && matchesExpectedIdentity(current, expectedIdentity),
    `${label} wurde vor der owned-only Loeschung fremd ersetzt.`,
  );
  await runHook(hooks, "beforeOwnedPathQuarantineRename", {
    label,
    kind,
    original,
    expectedIdentity,
    observedIdentity: current,
  });

  const quarantineRoot = await mkdtemp(join(parent.real, OWNED_CLEANUP_PREFIX));
  const quarantined = join(quarantineRoot, basename(original));
  await rename(original, quarantined);
  const moved = await lstat(quarantined, { bigint: true });
  if (!matchesExpectedIdentity(moved, expectedIdentity)) {
    await restoreMismatchedQuarantine({ original, quarantined, quarantineRoot, kind, label });
    throw new Error(`${label} wurde waehrend der owned-only Loeschung fremd ersetzt.`);
  }

  if (kind === "file") {
    invariant(moved.isFile() && !moved.isSymbolicLink(), `${label} ist in der Quarantaene keine regulaere Datei.`);
    await unlink(quarantined);
  } else {
    invariant(moved.isDirectory() && !moved.isSymbolicLink(), `${label} ist in der Quarantaene kein regulaeres Verzeichnis.`);
    invariant(isRecord(expectedFiles), `${label} besitzt keine erwarteten Stagingdatei-Identitaeten.`);
    const entries = await readdir(quarantined, { withFileTypes: true });
    invariant(entries.length === Object.keys(expectedFiles).length, `${label} besitzt fehlende oder unerwartete Stagingdateien; Quarantaene bleibt fail-closed erhalten.`);
    const entryQuarantine = join(quarantineRoot, ".owned-entries");
    await mkdir(entryQuarantine, { recursive: false, mode: 0o700 });
    for (const entry of entries) {
      invariant(Object.hasOwn(expectedFiles, entry.name), `${label} enthaelt den unerwarteten Eintrag ${entry.name}; Quarantaene bleibt fail-closed erhalten.`);
      const entryPath = join(quarantined, entry.name);
      const metadata = await lstat(entryPath, { bigint: true });
      invariant(
        metadata.isFile()
          && !metadata.isSymbolicLink()
          && matchesExpectedIdentity(metadata, expectedFiles[entry.name]),
        `${label}.${entry.name} wurde vor der owned-only Loeschung fremd ersetzt; Quarantaene bleibt fail-closed erhalten.`,
      );
      await runHook(hooks, "beforeOwnedDirectoryEntryQuarantineRename", {
        label,
        entryName: entry.name,
        entryPath,
        expectedIdentity: expectedFiles[entry.name],
        observedIdentity: metadata,
      });
      const quarantinedEntry = join(entryQuarantine, entry.name);
      await rename(entryPath, quarantinedEntry);
      const movedEntry = await lstat(quarantinedEntry, { bigint: true });
      if (!movedEntry.isFile() || movedEntry.isSymbolicLink() || !matchesExpectedIdentity(movedEntry, expectedFiles[entry.name])) {
        await restoreMismatchedDirectoryEntry({ original: entryPath, quarantined: quarantinedEntry, entryQuarantine, label: `${label}.${entry.name}` });
        throw new Error(`${label}.${entry.name} wurde waehrend der owned-only Loeschung fremd ersetzt.`);
      }
      await unlink(quarantinedEntry);
    }
    await rmdir(entryQuarantine);
    invariant((await readdir(quarantined)).length === 0, `${label} erhielt waehrend des Cleanup fremde Eintraege; Quarantaene bleibt fail-closed erhalten.`);
    await rmdir(quarantined);
  }
  await rmdir(quarantineRoot);
  await assertPinnedParent(parent);
}

async function removeOwnedClaim(parent, claim, hooks = {}) {
  if (claim.binding !== undefined) {
    await claim.binding.handle.close();
    claim.binding = undefined;
  }
  await removeOwnedPathByQuarantine(parent, claim.path, claim.identity, {
    kind: "file",
    label: "Operational-v2-Publikationsclaim",
    hooks,
  });
}

async function removeOwnedStaging(parent, staging, expectedIdentity, expectedFiles, hooks = {}) {
  await removeOwnedPathByQuarantine(parent, staging, expectedIdentity, {
    kind: "directory",
    label: "Operational-v2-Publikationsstaging",
    expectedFiles,
    hooks,
  });
}

async function rollbackOwnedPublishedEntries(parent, entries, hooks = {}) {
  const rollbackErrors = [];
  for (const entry of [...entries].reverse()) {
    try {
      await removeOwnedPathByQuarantine(parent, entry.outputPath, entry.identity, {
        kind: "file",
        label: entry.label,
        hooks,
      });
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(rollbackErrors, "Operational-v2-owned-only-Rollback ist fehlgeschlagen.");
  }
}

function validatePublicationReceipt(value, expectedReleaseId) {
  exactKeys(value, ["schema", "status", "publicationMode", "infraReleaseId", "specification", "nativeReceipt", "sources", "published", "state", "publisher", "validatorRebuild"], "Operational-v2-Publication-Receipt");
  invariant(value.schema === GERMANY_OPERATIONAL_PUBLICATION_RECEIPT_SCHEMA, "Operational-v2-Publication-Receipt besitzt ein unbekanntes Schema.");
  invariant(value.status === "published" && value.publicationMode === "create-new-recovery-v1", "Operational-v2-Publication-Receipt besitzt keinen erfolgreichen create-new-Status.");
  invariant(value.infraReleaseId === expectedReleaseId, "Operational-v2-Publication-Receipt bindet eine falsche Release-ID.");
  validateFileProof(value.specification, "Operational-v2-Publication-Receipt.specification");
  exactKeys(value.nativeReceipt, ["file", "bytes", "sha256", "schema"], "Operational-v2-Publication-Receipt.nativeReceipt");
  validatePortableRelativePath(value.nativeReceipt.file, "Operational-v2-Publication-Receipt.nativeReceipt.file");
  positiveInteger(value.nativeReceipt.bytes, "Operational-v2-Publication-Receipt.nativeReceipt.bytes");
  sha256(value.nativeReceipt.sha256, "Operational-v2-Publication-Receipt.nativeReceipt.sha256");
  invariant(value.nativeReceipt.schema === GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_SCHEMA, "Operational-v2-Publication-Receipt bindet ein falsches Native-Receipt-Schema.");
  validateValidatorRebuildBinding(value.validatorRebuild, "Operational-v2-Publication-Receipt.validatorRebuild");
  exactKeys(value.sources, ["candidate", "movementRouteTemplates", "report"], "Operational-v2-Publication-Receipt.sources");
  validateStateFileProof(value.sources.candidate, "Operational-v2-Publication-Receipt.sources.candidate");
  validateMovementFileProof(value.sources.movementRouteTemplates, "Operational-v2-Publication-Receipt.sources.movementRouteTemplates");
  validateFileProof(value.sources.report, "Operational-v2-Publication-Receipt.sources.report");
  exactKeys(value.published, ["operationalInfrastructure", "movementRouteTemplates"], "Operational-v2-Publication-Receipt.published");
  validateStateFileProof(value.published.operationalInfrastructure, "Operational-v2-Publication-Receipt.published.operationalInfrastructure");
  validateMovementFileProof(value.published.movementRouteTemplates, "Operational-v2-Publication-Receipt.published.movementRouteTemplates");
  exactKeys(value.state, ["operationalStateHash", "movementRouteTemplatesStateHash", "timetableTransferSetSha256"], "Operational-v2-Publication-Receipt.state");
  sha256(value.state.operationalStateHash, "Operational-v2-Publication-Receipt.state.operationalStateHash");
  sha256(value.state.movementRouteTemplatesStateHash, "Operational-v2-Publication-Receipt.state.movementRouteTemplatesStateHash");
  sha256OrNull(value.state.timetableTransferSetSha256, "Operational-v2-Publication-Receipt.state.timetableTransferSetSha256");
  if (expectedReleaseId === "infra-deutschland-2026.5") {
    sha256(value.state.timetableTransferSetSha256, "Operational-v2-Publication-Receipt.state.timetableTransferSetSha256");
  }
  exactKeys(value.publisher, ["entrypoint", "executionInventory"], "Operational-v2-Publication-Receipt.publisher");
  validatePortableRelativePath(value.publisher.entrypoint, "Operational-v2-Publication-Receipt.publisher.entrypoint");
  validateExecutionInventory(value.publisher.executionInventory, "Operational-v2-Publication-Receipt.publisher.executionInventory");
  invariant(sameCanonicalValue(value.validatorRebuild.preserved, value.publisher.executionInventory.validatorExecutable),
    "Operational-v2-Publication-Receipt bindet Rebuild-Preserved und effektives Validator-Binary verschieden.");
  invariant(
    value.publisher.entrypoint === value.publisher.executionInventory.wrapper.file,
    "Operational-v2-Publication-Receipt bindet Wrapper und Publisher-Entrypoint verschieden.",
  );
  invariant(value.state.operationalStateHash === value.sources.candidate.stateHash
    && value.state.operationalStateHash === value.sources.movementRouteTemplates.operationalStateHash
    && value.state.operationalStateHash === value.published.operationalInfrastructure.stateHash
    && value.state.operationalStateHash === value.published.movementRouteTemplates.operationalStateHash,
  "Operational-v2-Publication-Receipt besitzt verschiedene Operational-State-Hashes.");
  invariant(value.state.movementRouteTemplatesStateHash === value.sources.movementRouteTemplates.stateHash
    && value.state.movementRouteTemplatesStateHash === value.published.movementRouteTemplates.stateHash,
  "Operational-v2-Publication-Receipt besitzt verschiedene Movement-Sidecar-State-Hashes.");
  invariant(value.state.timetableTransferSetSha256 === value.sources.movementRouteTemplates.timetableTransferSetSha256
    && value.state.timetableTransferSetSha256 === value.published.movementRouteTemplates.timetableTransferSetSha256,
  "Operational-v2-Publication-Receipt besitzt verschiedene Transfer-Set-Hashes.");
  invariant(value.sources.movementRouteTemplates.bytes === value.published.movementRouteTemplates.bytes
    && value.sources.movementRouteTemplates.sha256 === value.published.movementRouteTemplates.sha256,
  "Operational-v2-Publication-Receipt belegt keine byteidentische Sidecar-Publikation.");
  invariant(value.published.operationalInfrastructure.file.endsWith(`/${OPERATIONAL_FILE}`) || value.published.operationalInfrastructure.file === OPERATIONAL_FILE,
    "Operational-v2-Publication-Receipt besitzt keinen kanonischen Operational-Zielpfad.");
  invariant(value.published.movementRouteTemplates.file.endsWith(`/${SIDECAR_FILE}`) || value.published.movementRouteTemplates.file === SIDECAR_FILE,
    "Operational-v2-Publication-Receipt besitzt keinen kanonischen Sidecar-Zielpfad.");
  return value;
}

export async function verifyGermanyOperationalInfrastructureV2PublicationReceipt({
  workspaceRoot = REPOSITORY_ROOT,
  publicationReceiptPath,
  expectedReleaseId,
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence,
}) {
  const root = resolve(workspaceRoot);
  const receiptPath = resolve(publicationReceiptPath);
  invariant(basename(receiptPath) === PUBLICATION_RECEIPT_FILE, `Operational-v2-Publication-Receipt muss ${PUBLICATION_RECEIPT_FILE} heissen.`);
  const source = await smallJsonSource(receiptPath, "Operational-v2-Publication-Receipt");
  const receipt = validatePublicationReceipt(source.value, expectedReleaseId);
  invariant(source.bytes.equals(serializeGermanyOperationalPublicationJson(receipt)), "Operational-v2-Publication-Receipt ist nicht kanonisch serialisiert.");
  const receiptParent = dirname(receiptPath);
  for (const [label, proof, expectedPath] of [
    ["published.operationalInfrastructure", receipt.published.operationalInfrastructure, join(receiptParent, OPERATIONAL_FILE)],
    ["published.movementRouteTemplates", receipt.published.movementRouteTemplates, join(receiptParent, SIDECAR_FILE)],
    ["nativeReceipt", receipt.nativeReceipt, join(receiptParent, NATIVE_RECEIPT_FILE)],
  ]) {
    invariant(
      normalizedPathForComparison(resolvePortablePath(root, proof.file, `Operational-v2-Publication-Receipt.${label}.file`)) === normalizedPathForComparison(expectedPath),
      `Operational-v2-Publication-Receipt.${label}.file ist nicht an das Receipt-Geschwisterpaar gebunden.`,
    );
  }
  for (const [label, proof] of [
    ["Spezifikation", receipt.specification],
    ["Native-Receipt-Capture", receipt.nativeReceipt],
    ["Candidate", receipt.sources.candidate],
    ["Candidate-Movement-Sidecar", receipt.sources.movementRouteTemplates],
    ["Ableitungsbericht", receipt.sources.report],
    ["publiziertes Operational-v2", receipt.published.operationalInfrastructure],
    ["publiziertes Movement-Sidecar", receipt.published.movementRouteTemplates],
    ["Operational-Validator-Rebuild-Spezifikation", receipt.validatorRebuild.specification],
    ["Operational-Validator-Rebuild-Receipt", receipt.validatorRebuild.evidence],
  ]) {
    proofMatches(await regularFileProof(resolvePortablePath(root, proof.file, `Operational-v2-Publication-Receipt.${label}`), label), proof, label);
  }
  for (const [id, proof] of Object.entries(receipt.publisher.executionInventory)) {
    proofMatches(
      await regularFileProof(
        resolvePortablePath(root, proof.file, `Operational-v2-Ausfuehrungsinventar.${id}`),
        `Operational-v2-Ausfuehrungsinventar.${id}`,
      ),
      proof,
      `Operational-v2-Ausfuehrungsinventar.${id}`,
    );
  }
  const capture = await loadAndValidateCapture({
    workspaceRoot: root,
    nativeReceiptPath: resolvePortablePath(root, receipt.nativeReceipt.file, "Native-Receipt-Capture"),
    specificationPath: resolvePortablePath(root, receipt.specification.file, "Operational-v2-Spezifikation"),
    candidatePath: resolvePortablePath(root, receipt.sources.candidate.file, "Operational-v2-Candidate"),
    candidateMovementRouteTemplatesPath: resolvePortablePath(root, receipt.sources.movementRouteTemplates.file, "Candidate-Movement-Sidecar"),
    reportPath: resolvePortablePath(root, receipt.sources.report.file, "Operational-v2-Ableitungsbericht"),
    validatorRebuildSpecificationPath: resolvePortablePath(root, receipt.validatorRebuild.specification.file, "Operational-Validator-Rebuild-Spezifikation"),
    validatorRebuildEvidencePath: resolvePortablePath(root, receipt.validatorRebuild.evidence.file, "Operational-Validator-Rebuild-Receipt"),
    verifyValidatorRebuildEvidence,
  });
  invariant(capture.capture.infraReleaseId === receipt.infraReleaseId, "Publication-Receipt und Native-Receipt-Capture besitzen verschiedene Release-IDs.");
  invariant(
    sameCanonicalValue(
      capture.capture.producer.executable,
      receipt.publisher.executionInventory.validatorExecutable,
    ),
    "Publication-Receipt und Native-Receipt-Capture binden verschiedene Validator-Binaries.",
  );
  invariant(sameCanonicalValue(capture.capture.validatorRebuild, receipt.validatorRebuild),
    "Publication-Receipt und Native-Receipt-Capture binden verschiedene Validator-Rebuild-Belege.");
  return { receipt, proof: source.proof, captureReceipt: capture.capture };
}

async function runHook(hooks, name, context) {
  if (hooks?.[name] !== undefined) await hooks[name](context);
}

export async function publishGermanyOperationalInfrastructureV2FromNativeReceipt({
  specificationPath,
  candidatePath,
  candidateMovementRouteTemplatesPath,
  reportPath,
  nativeReceiptPath,
  validatorRebuildSpecificationPath,
  validatorRebuildEvidencePath,
  outputPath,
  publicationReceiptPath,
  workspaceRoot = REPOSITORY_ROOT,
  publisherEntrypointPath = resolve(REPOSITORY_ROOT, GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT),
  materialize = materializeOperationalInfrastructureV2,
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence,
  hooks,
}) {
  const root = resolve(workspaceRoot);
  const paths = publicationPaths(outputPath, publicationReceiptPath);
  const parent = await pinParentDirectory(paths.parent, { create: true });
  invariant(parent.real === paths.parent, "Finale Operational-v2-Ziele muessen direkt im gepinnten Elternverzeichnis liegen.");
  const captureBeforeValidation = await smallJsonSource(nativeReceiptPath, "Native-Receipt-Capture vor Publisher-Validator-Ausfuehrung");
  const externallyPinnedInventory = validateExecutionInventory(
    captureBeforeValidation.value?.producer?.executionInventory,
    "Native-Receipt-Capture.producer.executionInventory vor Publisher-Validator-Ausfuehrung",
  );
  const executionInventoryBefore = await publisherExecutionInventoryProof(root, externallyPinnedInventory.validatorExecutable);
  executionInventoryMatches(
    executionInventoryBefore,
    externallyPinnedInventory,
    "Operational-v2-Ausfuehrungsinventar vor Publisher-Validator-Ausfuehrung",
  );
  const preflight = await inspectGermanyOperationalInfrastructureV2Publication({
    outputPath,
    publicationReceiptPath,
    workspaceRoot: root,
    verifyValidatorRebuildEvidence,
  });
  invariant(preflight.status === "clean", `Operational-v2-Publikationspreflight ist nicht sauber: ${preflight.status}.`);
  const capture = await loadAndValidateCapture({
    workspaceRoot: root,
    nativeReceiptPath,
    specificationPath,
    candidatePath,
    candidateMovementRouteTemplatesPath,
    reportPath,
    validatorRebuildSpecificationPath,
    validatorRebuildEvidencePath,
    verifyValidatorRebuildEvidence,
  });
  executionInventoryMatches(capture.capture.producer.executionInventory, executionInventoryBefore, "Native-Receipt-Capture-Ausfuehrungsinventar");
  if (!capture.report.activationEligible) {
    throw new OperationalInfrastructureDerivationIncompleteError({
      nativeReceipt: capture.capture.nativeReceipt,
      nativeReport: capture.report,
      paths: { candidate: resolve(candidatePath), movementRouteTemplates: resolve(candidateMovementRouteTemplatesPath), report: resolve(reportPath), output: null },
    });
  }
  const publisherEntrypoint = portableRelativePath(root, publisherEntrypointPath, "Operational-v2-Publisher-Entrypoint");
  invariant(publisherEntrypoint === GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT, `Operational-v2-Publisher-Entrypoint muss ${GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT} sein.`);
  const validatorExecutablePath = resolvePortablePath(
    root,
    capture.capture.producer.executable.file,
    "Native-Receipt-Capture.producer.executable",
  );
  proofMatches(
    executionInventoryBefore.validatorExecutable,
    capture.capture.producer.executable,
    "Operational-v2-Validator-Binary vor Materialisierung",
  );
  const targets = [
    { path: paths.movementRouteTemplates, label: "Kanonisches Movement-Route-Sidecar-Ziel" },
    { path: paths.output, label: "Kanonisches Operational-v2-Ziel" },
    { path: paths.receipt, label: "Operational-v2-Publication-Receipt" },
  ];
  await assertCreateNewTargets(targets);
  const staging = await mkdtemp(join(parent.real, STAGING_PREFIX));
  const stagingIdentity = await lstat(staging, { bigint: true });
  const stagedMovement = join(staging, SIDECAR_FILE);
  const stagedOutput = join(staging, OPERATIONAL_FILE);
  const stagedReceipt = join(staging, basename(paths.receipt));
  let claim;
  let receiptHandle;
  const publishedEntries = [];
  const publishedBindings = [];
  const stagedFileIdentities = {};
  let completed = false;
  let failure;
  try {
    const streamedMovementProof = await copyRegularFileStreaming(candidateMovementRouteTemplatesPath, stagedMovement, { onChunk: hooks?.onStreamingChunk });
    stagedFileIdentities[SIDECAR_FILE] = await lstat(stagedMovement, { bigint: true });
    proofMatches(streamedMovementProof, capture.capture.sources.movementRouteTemplates, "Gestagetes Movement-Sidecar");
    const materialization = await materialize({
      candidatePath: resolve(candidatePath),
      expectedReleaseId: capture.capture.infraReleaseId,
      outputPath: stagedOutput,
      validatorExecutablePath,
    });
    const stagedOutputMetadata = await lstat(stagedOutput, { bigint: true });
    invariant(
      stagedOutputMetadata.isFile() && !stagedOutputMetadata.isSymbolicLink(),
      "Gestagetes Operational-v2-Artefakt ist keine regulaere Datei.",
    );
    stagedFileIdentities[OPERATIONAL_FILE] = stagedOutputMetadata;
    invariant(
      typeof materialization.validatorExecutablePath === "string"
        && normalizedPathForComparison(materialization.validatorExecutablePath) === normalizedPathForComparison(validatorExecutablePath),
      "Operational-v2-Materialisierung belegt nicht das vom Capture gebundene Validator-Binary.",
    );
    const executionInventoryAfterMaterialization = await publisherExecutionInventoryProof(
      root,
      capture.capture.producer.executable,
    );
    executionInventoryMatches(
      executionInventoryAfterMaterialization,
      executionInventoryBefore,
      "Operational-v2-Ausfuehrungsinventar nach Materialisierung",
    );
    proofMatches(
      executionInventoryAfterMaterialization.validatorExecutable,
      capture.capture.producer.executable,
      "Operational-v2-Validator-Binary nach Materialisierung",
    );
    const validatorRebuildAfterMaterialization = await loadAndVerifyValidatorRebuild({
      workspaceRoot: root,
      validatorRebuildSpecificationPath,
      validatorRebuildEvidencePath,
      expectedReleaseId: capture.capture.infraReleaseId,
      expectedValidator: capture.capture.producer.executable,
      verifyValidatorRebuildEvidence,
    });
    invariant(sameCanonicalValue(validatorRebuildAfterMaterialization.binding, capture.capture.validatorRebuild),
      "Operational-Validator-Rebuild-Beleg driftet waehrend der Materialisierung.");
    invariant(materialization.sourceBytes === capture.candidateProof.bytes && materialization.sourceSha256 === capture.candidateProof.sha256,
      "Operational-v2-Materialisierung bindet nicht den qualifizierten Candidate.");
    invariant(materialization.stateHash === capture.capture.sources.candidate.stateHash,
      "Operational-v2-Materialisierung und Native-Receipt-Capture besitzen verschiedene Zustandshashes.");
    const stagedOutputProof = await regularFileProof(stagedOutput, "Gestagetes Operational-v2-Artefakt");
    invariant(stagedOutputProof.bytes === materialization.bytes && stagedOutputProof.sha256 === materialization.sha256,
      "Operational-v2-Materialisierungsreceipt driftet von den gestageten Bytes.");
    receiptHandle = await open(stagedReceipt, "wx", 0o600);
    stagedFileIdentities[PUBLICATION_RECEIPT_FILE] = await receiptHandle.stat({ bigint: true });
    await runHook(hooks, "afterReceiptReservation", { parent, paths, staging, stagedReceipt, receiptHandle });
    await assertPinnedParent(parent);
    await assertHeldOwnedRegularFile(
      stagedReceipt,
      receiptHandle,
      stagedFileIdentities[PUBLICATION_RECEIPT_FILE],
      "Reserviertes Operational-v2-Publication-Receipt",
    );
    await assertCreateNewTargets(targets);
    claim = await acquireClaim(parent, staging, basename(paths.receipt), stagedFileIdentities, hooks);
    await runHook(hooks, "afterClaim", { parent, paths, staging, claim });

    const sidecarBinding = await publishBoundFileCreateNew({
      sourcePath: stagedMovement,
      outputPath: paths.movementRouteTemplates,
      expectedIdentity: stagedFileIdentities[SIDECAR_FILE],
      expectedProof: streamedMovementProof,
      label: "Kanonisches Movement-Route-Sidecar-Ziel",
      parent,
      registerOwned: (entry) => publishedEntries.push(entry),
      afterLinkBeforeAudit: hooks?.afterSidecarSourceLinkBeforeAudit,
    });
    publishedBindings.push(sidecarBinding);
    await runHook(hooks, "afterSidecarLink", { parent, paths, staging, claim });

    const operationalBinding = await publishBoundFileCreateNew({
      sourcePath: stagedOutput,
      outputPath: paths.output,
      expectedIdentity: stagedFileIdentities[OPERATIONAL_FILE],
      expectedProof: stagedOutputProof,
      label: "Kanonisches Operational-v2-Ziel",
      parent,
      registerOwned: (entry) => publishedEntries.push(entry),
      afterLinkBeforeAudit: hooks?.afterOperationalSourceLinkBeforeAudit,
    });
    publishedBindings.push(operationalBinding);
    await runHook(hooks, "afterOperationalLink", { parent, paths, staging, claim });

    await assertPinnedParent(parent);
    const [
      publishedOutputProof,
      publishedMovementProof,
      finalCandidateProof,
      finalMovementProof,
      finalReportProof,
      finalSpecificationProof,
      finalCaptureProof,
      finalExecutionInventory,
    ] = await Promise.all([
      regularFileProof(paths.output, "Publiziertes Operational-v2-Artefakt"),
      regularFileProof(paths.movementRouteTemplates, "Publiziertes Movement-Sidecar"),
      regularFileProof(candidatePath, "Nativer Operational-v2-Candidate"),
      regularFileProof(candidateMovementRouteTemplatesPath, "Natives Candidate-Movement-Sidecar"),
      regularFileProof(reportPath, "Nativer Operational-v2-Ableitungsbericht"),
      regularFileProof(specificationPath, "Operational-v2-Spezifikation"),
      regularFileProof(nativeReceiptPath, "Native-Receipt-Capture"),
      publisherExecutionInventoryProof(root, capture.capture.producer.executable),
    ]);
    proofMatches(publishedOutputProof, stagedOutputProof, "Publiziertes Operational-v2-Artefakt");
    proofMatches(publishedMovementProof, streamedMovementProof, "Publiziertes Movement-Sidecar");
    proofMatches(finalCandidateProof, capture.candidateProof, "Operational-v2-Candidate nach Publikation");
    proofMatches(finalMovementProof, capture.movementProof, "Candidate-Movement-Sidecar nach Publikation");
    proofMatches(finalReportProof, capture.reportSource.proof, "Operational-v2-Ableitungsbericht nach Publikation");
    proofMatches(finalSpecificationProof, capture.specificationSource.proof, "Operational-v2-Spezifikation nach Publikation");
    proofMatches(finalCaptureProof, capture.captureSource.proof, "Native-Receipt-Capture nach Publikation");
    executionInventoryMatches(
      finalExecutionInventory,
      executionInventoryBefore,
      "Operational-v2-Ausfuehrungsinventar nach Publikation",
    );

    const receipt = validatePublicationReceipt({
      schema: GERMANY_OPERATIONAL_PUBLICATION_RECEIPT_SCHEMA,
      status: "published",
      publicationMode: "create-new-recovery-v1",
      infraReleaseId: capture.capture.infraReleaseId,
      specification: { file: capture.expectedFiles.specification, ...finalSpecificationProof },
      nativeReceipt: { file: capture.expectedFiles.nativeReceipt, ...finalCaptureProof, schema: capture.capture.schema },
      validatorRebuild: capture.capture.validatorRebuild,
      sources: {
        candidate: { ...capture.capture.sources.candidate, ...finalCandidateProof },
        movementRouteTemplates: { ...capture.capture.sources.movementRouteTemplates, ...finalMovementProof },
        report: { ...capture.capture.sources.report, ...finalReportProof },
      },
      published: {
        operationalInfrastructure: {
          file: portableRelativePath(root, paths.output, "Publiziertes Operational-v2-Artefakt"),
          ...publishedOutputProof,
          stateHash: materialization.stateHash,
        },
        movementRouteTemplates: {
          file: portableRelativePath(root, paths.movementRouteTemplates, "Publiziertes Movement-Sidecar"),
          ...publishedMovementProof,
          stateHash: capture.capture.sources.movementRouteTemplates.stateHash,
          operationalStateHash: capture.capture.sources.movementRouteTemplates.operationalStateHash,
          timetableTransferSetSha256: capture.capture.sources.movementRouteTemplates.timetableTransferSetSha256,
        },
      },
      state: {
        operationalStateHash: materialization.stateHash,
        movementRouteTemplatesStateHash: capture.capture.sources.movementRouteTemplates.stateHash,
        timetableTransferSetSha256: capture.capture.sources.movementRouteTemplates.timetableTransferSetSha256,
      },
      publisher: { entrypoint: publisherEntrypoint, executionInventory: finalExecutionInventory },
    }, capture.capture.infraReleaseId);
    await runHook(hooks, "beforeReceiptWrite", { parent, paths, staging, claim, receipt });
    await assertPinnedParent(parent);
    await assertHeldOwnedRegularFile(
      stagedReceipt,
      receiptHandle,
      stagedFileIdentities[PUBLICATION_RECEIPT_FILE],
      "Reserviertes Operational-v2-Publication-Receipt vor dem Schreiben",
    );
    const receiptBytes = serializeGermanyOperationalPublicationJson(receipt);
    const split = Math.max(1, Math.floor(receiptBytes.length / 2));
    await writeHandleBytes(receiptHandle, receiptBytes.subarray(0, split), 0);
    await runHook(hooks, "duringReceiptWrite", { parent, paths, staging, claim, receipt, writtenBytes: split });
    await assertPinnedParent(parent);
    await assertHeldOwnedRegularFile(
      stagedReceipt,
      receiptHandle,
      stagedFileIdentities[PUBLICATION_RECEIPT_FILE],
      "Reserviertes Operational-v2-Publication-Receipt waehrend des Schreibens",
    );
    if (split < receiptBytes.length) {
      await writeHandleBytes(receiptHandle, receiptBytes.subarray(split), split);
    }
    await receiptHandle.sync();
    await runHook(hooks, "afterReceiptWrite", { parent, paths, staging, claim, receipt });
    await assertPinnedParent(parent);
    await assertHeldOwnedRegularFile(
      stagedReceipt,
      receiptHandle,
      stagedFileIdentities[PUBLICATION_RECEIPT_FILE],
      "Reserviertes Operational-v2-Publication-Receipt nach dem Schreiben",
    );
    await receiptHandle.close();
    receiptHandle = undefined;
    await runHook(hooks, "beforeReceiptLink", { parent, paths, staging, claim, receipt });
    await assertPinnedParent(parent);
    await assertOwnedRegularFile(
      stagedReceipt,
      stagedFileIdentities[PUBLICATION_RECEIPT_FILE],
      "Operational-v2-Publication-Receipt vor dem create-new Link",
    );
    const receiptProof = { bytes: receiptBytes.length, sha256: createHash("sha256").update(receiptBytes).digest("hex") };
    const receiptBinding = await publishBoundFileCreateNew({
      sourcePath: stagedReceipt,
      outputPath: paths.receipt,
      expectedIdentity: stagedFileIdentities[PUBLICATION_RECEIPT_FILE],
      expectedProof: receiptProof,
      label: "Operational-v2-Publication-Receipt",
      parent,
      registerOwned: (entry) => publishedEntries.push(entry),
      afterLinkBeforeAudit: hooks?.afterReceiptSourceLinkBeforeAudit,
    });
    publishedBindings.push(receiptBinding);
    await runHook(hooks, "afterReceiptLink", { parent, paths, staging, claim, receipt });
    await assertPinnedParent(parent);
    await verifyGermanyOperationalInfrastructureV2PublicationReceipt({
      workspaceRoot: root,
      publicationReceiptPath: paths.receipt,
      expectedReleaseId: capture.capture.infraReleaseId,
      verifyValidatorRebuildEvidence,
    });
    completed = true;
    return { receipt, paths: { output: paths.output, movementRouteTemplates: paths.movementRouteTemplates, publicationReceipt: paths.receipt } };
  } catch (error) {
    failure = error;
    if (receiptHandle !== undefined) {
      try {
        await receiptHandle.close();
      } catch (closeError) {
        failure = new AggregateError([failure, closeError], "Operational-v2-Publication-Receipt-Handle konnte nach Fehler nicht geschlossen werden.");
      }
      receiptHandle = undefined;
    }
    if (publishedBindings.length > 0) {
      try {
        await closeBoundPublications(publishedBindings);
      } catch (closeError) {
        failure = new AggregateError([failure, closeError], "Operational-v2-Zielhandles konnten vor Rollback nicht geschlossen werden.");
      }
    }
    if (publishedEntries.length > 0) {
      try {
        await rollbackOwnedPublishedEntries(parent, publishedEntries, hooks);
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          `Operational-v2-Publikation und owned-only Rollback sind fehlgeschlagen: ${errorDetail(error)}; ${errorDetail(rollbackError)}`,
        );
      }
    }
    throw failure;
  } finally {
    const cleanupErrors = [];
    if (receiptHandle !== undefined) {
      try {
        await receiptHandle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      receiptHandle = undefined;
    }
    let stagingRemoved = false;
    try {
      await removeOwnedStaging(parent, staging, stagingIdentity, stagedFileIdentities, hooks);
      stagingRemoved = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (claim !== undefined && stagingRemoved) {
      try {
        await removeOwnedClaim(parent, claim, hooks);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (claim?.binding !== undefined) {
      try {
        await claim.binding.handle.close();
        claim.binding = undefined;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      if (publishedBindings.length > 0) {
        try {
          await closeBoundPublications(publishedBindings);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      const cleanupDetail = cleanupErrors.map(errorDetail).join("; ");
      throw new AggregateError(
        failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
        completed
          ? `Operational-v2 wurde publiziert, aber Claim/Staging brauchen typisiertes Recovery: ${cleanupDetail}`
          : `Operational-v2-Publikation und owned-only Cleanup sind fehlgeschlagen: ${errorDetail(failure)}; ${cleanupDetail}`,
      );
    }
    if (completed) {
      let finalAuditError;
      try {
        await runHook(hooks, "afterPublicationCleanupBeforeFinalAudit", { parent, paths });
        await assertPinnedParent(parent);
        for (const binding of publishedBindings) {
          proofMatches(await proofFromBoundPublication(binding), binding.expectedProof, `${binding.label} nach Cleanup`);
        }
        const final = await inspectGermanyOperationalInfrastructureV2Publication({
          outputPath: paths.output,
          publicationReceiptPath: paths.receipt,
          workspaceRoot: root,
          verifyValidatorRebuildEvidence,
        });
        invariant(final.status === "complete", `Operational-v2-Publikation hinterliess nach Cleanup den Zustand ${final.status}.`);
        await assertPinnedParent(parent);
        for (const binding of publishedBindings) {
          proofMatches(await proofFromBoundPublication(binding), binding.expectedProof, `${binding.label} unmittelbar vor Success`);
        }
        invariant(await maybeMetadata(claimPath(parent.real)) === null, "Operational-v2-Publikationsclaim blieb nach Success sichtbar.");
      } catch (error) {
        finalAuditError = error;
      }
      let finalCloseError;
      try { await closeBoundPublications(publishedBindings); } catch (error) { finalCloseError = error; }
      if (finalAuditError && finalCloseError) throw new AggregateError([finalAuditError, finalCloseError], "Finaler Operational-v2-Audit und Handle-Close sind fehlgeschlagen.");
      if (finalAuditError) throw finalAuditError;
      if (finalCloseError) throw finalCloseError;
    } else if (publishedBindings.length > 0) {
      await closeBoundPublications(publishedBindings);
    }
  }
}

async function readClaim(parent) {
  const path = claimPath(parent.real);
  const metadata = await maybeMetadata(path);
  if (metadata === null) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0n || metadata.size > BigInt(MAX_SMALL_JSON_BYTES)) {
    return { path, metadata, error: "invalid-claim-file" };
  }
  try {
    const source = await smallJsonSource(path, "Operational-v2-Publikationsclaim");
    const value = validateClaim(source.value);
    invariant(source.bytes.equals(serializeGermanyOperationalPublicationJson(value)), "Operational-v2-Publikationsclaim ist nicht kanonisch serialisiert.");
    invariant(identityMatches(metadata, value.claim), "Operational-v2-Publikationsclaim bindet nicht seine eigene Dateisystemidentitaet.");
    invariant(identityMatches(parent.identity, value.parent), "Operational-v2-Publikationsclaim bindet nicht das aktuelle Elternverzeichnis.");
    return { path, metadata, value };
  } catch (error) {
    return { path, metadata, error: error instanceof Error ? error.message : String(error) };
  }
}

async function targetState(paths) {
  const [movementRouteTemplates, operationalInfrastructure, publicationReceipt] = await Promise.all([
    maybeMetadata(paths.movementRouteTemplates),
    maybeMetadata(paths.output),
    maybeMetadata(paths.receipt),
  ]);
  return { movementRouteTemplates, operationalInfrastructure, publicationReceipt };
}

async function assertTargetStateStable(paths, expected, label) {
  const actual = await targetState(paths);
  for (const name of ["movementRouteTemplates", "operationalInfrastructure", "publicationReceipt"]) {
    invariant(
      expected[name] !== null
        && actual[name] !== null
        && actual[name].isFile()
        && !actual[name].isSymbolicLink()
        && sameStableMetadata(expected[name], actual[name]),
      `${label}.${name} wurde waehrend der finalen Inspektion ersetzt oder veraendert.`,
    );
  }
}

function existingTargetNames(targets) {
  return Object.entries(targets).filter(([, metadata]) => metadata !== null).map(([name]) => name);
}

export async function inspectGermanyOperationalInfrastructureV2Publication({
  outputPath,
  publicationReceiptPath,
  workspaceRoot = REPOSITORY_ROOT,
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence,
}) {
  const paths = publicationPaths(outputPath, publicationReceiptPath);
  const parent = await pinParentDirectory(paths.parent, { create: true });
  const [claim, targets, directoryEntries] = await Promise.all([readClaim(parent), targetState(paths), readdir(parent.real)]);
  const orphanStaging = directoryEntries.filter((name) => (
    name.startsWith(STAGING_PREFIX)
    || name.startsWith(OWNED_CLEANUP_PREFIX)
    || name.startsWith(CREATE_NEW_ROLLBACK_PREFIX)
  ));
  const existing = existingTargetNames(targets);
  if (claim === null) {
    if (orphanStaging.length > 0) return { status: "blocked-orphan-staging", paths, existing, staging: orphanStaging };
    if (existing.length === 0) return { status: "clean", paths };
    if (existing.length === 3) {
      try {
        const receiptSource = await smallJsonSource(paths.receipt, "Operational-v2-Publication-Receipt");
        const receipt = validatePublicationReceipt(receiptSource.value, receiptSource.value?.infraReleaseId);
        invariant(receiptSource.bytes.equals(serializeGermanyOperationalPublicationJson(receipt)), "Operational-v2-Publication-Receipt ist nicht kanonisch serialisiert.");
        await verifyGermanyOperationalInfrastructureV2PublicationReceipt({ workspaceRoot, publicationReceiptPath: paths.receipt, expectedReleaseId: receipt.infraReleaseId, verifyValidatorRebuildEvidence });
        await assertPinnedParent(parent);
        await assertTargetStateStable(paths, targets, "Operational-v2-Complete-Inspektion");
        return { status: "complete", paths, receipt };
      } catch (error) {
        return { status: "blocked-invalid-complete", paths, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { status: "blocked-unowned-partial", paths, existing, staging: orphanStaging };
  }
  if (claim.error !== undefined) return { status: "blocked-invalid-claim", paths, error: claim.error };
  const staging = join(parent.real, claim.value.staging.directory);
  const stagingMetadata = await maybeMetadata(staging);
  const staged = {
    movementRouteTemplates: join(staging, SIDECAR_FILE),
    operationalInfrastructure: join(staging, OPERATIONAL_FILE),
    publicationReceipt: join(staging, basename(paths.receipt)),
    publicationClaim: join(staging, CLAIM_FILE),
  };
  let stagedFileMetadata;
  if (stagingMetadata !== null
    && stagingMetadata.isDirectory()
    && !stagingMetadata.isSymbolicLink()
    && identityMatches(stagingMetadata, claim.value.staging.identity)) {
    const [movementRouteTemplates, operationalInfrastructure, publicationReceipt, publicationClaim] = await Promise.all([
      maybeMetadata(staged.movementRouteTemplates),
      maybeMetadata(staged.operationalInfrastructure),
      maybeMetadata(staged.publicationReceipt),
      maybeMetadata(staged.publicationClaim),
    ]);
    stagedFileMetadata = { movementRouteTemplates, operationalInfrastructure, publicationReceipt, publicationClaim };
    if (movementRouteTemplates === null
      || operationalInfrastructure === null
      || publicationReceipt === null
      || publicationClaim === null
      || !identityMatches(movementRouteTemplates, claim.value.staging.files[SIDECAR_FILE])
      || !identityMatches(operationalInfrastructure, claim.value.staging.files[OPERATIONAL_FILE])
      || !identityMatches(publicationReceipt, claim.value.staging.files[PUBLICATION_RECEIPT_FILE])
      || !identityMatches(publicationClaim, claim.value.staging.files[CLAIM_FILE])) {
      return { status: "blocked-replaced-staging-file", paths, parent, claim, staging, staged, existing };
    }
  }
  if (existing.length === 3) {
    try {
      const receiptSource = await smallJsonSource(paths.receipt, "Operational-v2-Publication-Receipt");
      const receipt = validatePublicationReceipt(receiptSource.value, receiptSource.value?.infraReleaseId);
      invariant(receiptSource.bytes.equals(serializeGermanyOperationalPublicationJson(receipt)), "Operational-v2-Publication-Receipt ist nicht kanonisch serialisiert.");
      await verifyGermanyOperationalInfrastructureV2PublicationReceipt({ workspaceRoot, publicationReceiptPath: paths.receipt, expectedReleaseId: receipt.infraReleaseId, verifyValidatorRebuildEvidence });
      await assertPinnedParent(parent);
      await assertTargetStateStable(paths, targets, "Operational-v2-Complete-Cleanup-Inspektion");
      if (stagingMetadata !== null && (
        !stagingMetadata.isDirectory()
        || stagingMetadata.isSymbolicLink()
        || !identityMatches(stagingMetadata, claim.value.staging.identity)
      )) {
        return { status: "blocked-missing-or-replaced-staging", paths, parent, claim, staging, existing };
      }
      invariant(stagedFileMetadata?.publicationReceipt !== null
        && sameIdentity(stagedFileMetadata.publicationReceipt, targets.publicationReceipt)
        && sameIdentity(stagedFileMetadata.movementRouteTemplates, targets.movementRouteTemplates)
        && sameIdentity(stagedFileMetadata.operationalInfrastructure, targets.operationalInfrastructure)
        && sameIdentity(stagedFileMetadata.publicationClaim, claim.metadata),
      "Operational-v2-Complete-Cleanup bindet nicht dieselben Staging- und Zielidentitaeten.");
      return { status: "complete-cleanup-required", paths, parent, claim, staging, stagingMetadata, staged, stagedFileMetadata, receipt };
    } catch (error) {
      return { status: "blocked-invalid-complete", paths, parent, claim, staging, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (stagingMetadata === null || !stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink() || !identityMatches(stagingMetadata, claim.value.staging.identity)) {
    return { status: "blocked-missing-or-replaced-staging", paths, parent, claim, staging, existing };
  }
  if (targets.publicationReceipt !== null) {
    return { status: "blocked-unowned-partial-receipt", paths, parent, claim, staging, staged, existing };
  }
  let owned = true;
  for (const [name, metadata] of Object.entries(targets)) {
    if (metadata === null) continue;
    const stagedMetadataForTarget = await maybeMetadata(staged[name]);
    if (stagedMetadataForTarget === null || !sameIdentity(metadata, stagedMetadataForTarget)) owned = false;
  }
  if (!owned) return { status: "blocked-foreign-replacement", paths, parent, claim, staging, staged, existing };
  return { status: existing.length === 0 ? "recoverable-prepublication" : "recoverable-partial", paths, parent, claim, staging, staged, stagedFileMetadata, existing };
}

export async function recoverGermanyOperationalInfrastructureV2Publication({
  outputPath,
  publicationReceiptPath,
  workspaceRoot = REPOSITORY_ROOT,
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence,
  hooks = {},
}) {
  const inspection = await inspectGermanyOperationalInfrastructureV2Publication({ outputPath, publicationReceiptPath, workspaceRoot, verifyValidatorRebuildEvidence });
  invariant(["recoverable-prepublication", "recoverable-partial", "complete-cleanup-required"].includes(inspection.status),
    `Operational-v2-Publikationszustand darf nicht automatisch bereinigt werden: ${inspection.status}.`);
  const { parent, claim, staging } = inspection;
  if (inspection.status === "recoverable-partial") {
    const entries = [];
    if (inspection.existing.includes("movementRouteTemplates")) entries.push({
      outputPath: inspection.paths.movementRouteTemplates,
      identity: inspection.stagedFileMetadata.movementRouteTemplates,
      label: "Kanonisches Movement-Route-Sidecar-Ziel",
    });
    if (inspection.existing.includes("operationalInfrastructure")) entries.push({
      outputPath: inspection.paths.output,
      identity: inspection.stagedFileMetadata.operationalInfrastructure,
      label: "Kanonisches Operational-v2-Ziel",
    });
    await rollbackOwnedPublishedEntries(parent, entries, hooks);
  }
  await runHook(hooks, "beforeRecoveryStagingCleanup", { inspection, parent, claim, staging });
  const stagingMetadata = await maybeMetadata(staging);
  let stagingCleared = stagingMetadata === null;
  if (stagingMetadata !== null) {
    invariant(
      stagingMetadata.isDirectory()
        && !stagingMetadata.isSymbolicLink()
        && identityMatches(stagingMetadata, claim.value.staging.identity),
      "Operational-v2-Recovery-Staging wurde vor Cleanup fremd ersetzt; Claim bleibt erhalten.",
    );
    await removeOwnedStaging(parent, staging, stagingMetadata, {
      [SIDECAR_FILE]: inspection.stagedFileMetadata.movementRouteTemplates,
      [OPERATIONAL_FILE]: inspection.stagedFileMetadata.operationalInfrastructure,
      [PUBLICATION_RECEIPT_FILE]: inspection.stagedFileMetadata.publicationReceipt,
      [CLAIM_FILE]: inspection.stagedFileMetadata.publicationClaim,
    }, hooks);
    stagingCleared = true;
  }
  invariant(stagingCleared, "Operational-v2-Recovery konnte das owned Staging nicht belegt bereinigen; Claim bleibt erhalten.");
  await assertPinnedParent(parent);
  await removeOwnedClaim(parent, { path: claim.path, identity: claim.metadata }, hooks);
  invariant(await maybeMetadata(claim.path) === null, "Operational-v2-Publikationsclaim blieb nach Recovery sichtbar.");
  await assertPinnedParent(parent);
  const final = await inspectGermanyOperationalInfrastructureV2Publication({ outputPath, publicationReceiptPath, workspaceRoot, verifyValidatorRebuildEvidence });
  invariant(final.status === (inspection.status === "complete-cleanup-required" ? "complete" : "clean"), "Operational-v2-Recovery hinterliess einen unerwarteten Zustand.");
  await assertPinnedParent(parent);
  return final;
}
