#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { link, lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalOperationalInfrastructureV2Json,
  operationalInfrastructureV2StateHash,
  OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
} from "./operational-infrastructure-binding.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const NATIVE_EXECUTABLE_ENV = "ZUGFOLGE_INFRA_RELEASE_VALIDATOR_PATH";
const NATIVE_RECEIPT_KEYS = Object.freeze([
  "bytes",
  "infraReleaseId",
  "schema",
  "sha256",
  "sourceBytes",
  "sourceSha256",
  "stateHash",
  "validationMode",
]);
const NATIVE_SEMANTIC_VALIDATION_KEYS = Object.freeze([
  "algorithm",
  "interlockingRecordsDeserialized",
  "routeRecordsDeserialized",
  "routeTemplateCartesianReads",
  "trainLegProfileReads",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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

function normalizedPath(path) {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

async function inspectRegularFile(path, label) {
  const pathBefore = await lstat(path, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n, `${label} ist keine nichtleere reguläre Datei.`);
  const handle = await open(path, "r");
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && sameStableMetadata(pathBefore, before), `${label} wurde vor der Hashbildung ausgetauscht.`);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    invariant(
      pathAfter.isFile()
        && !pathAfter.isSymbolicLink()
        && sameStableMetadata(before, after)
        && sameStableMetadata(after, pathAfter)
        && BigInt(bytes) === after.size,
      `${label} änderte sich während der Hashbildung.`,
    );
    return {
      identity: Object.freeze({ dev: after.dev, ino: after.ino }),
      proof: { bytes, sha256: digest.digest("hex") },
    };
  } finally {
    await handle.close();
  }
}

async function fileProof(path, label) {
  return (await inspectRegularFile(path, label)).proof;
}

async function pinParentDirectory(path) {
  const requested = resolve(path);
  const real = await realpath(requested);
  invariant(normalizedPath(requested) === normalizedPath(real), "Operational-v2-Ausgabeverzeichnis darf kein Dateisystemalias sein.");
  const identity = await lstat(real, { bigint: true });
  invariant(identity.isDirectory() && !identity.isSymbolicLink(), "Operational-v2-Ausgabeverzeichnis ist kein regulaeres Verzeichnis.");
  return Object.freeze({ requested, real, identity: Object.freeze({ dev: identity.dev, ino: identity.ino }) });
}

async function assertPinnedParent(parent) {
  const [real, metadata] = await Promise.all([
    realpath(parent.requested),
    lstat(parent.real, { bigint: true }),
  ]);
  invariant(
    normalizedPath(real) === normalizedPath(parent.real)
      && metadata.isDirectory()
      && !metadata.isSymbolicLink()
      && sameIdentity(metadata, parent.identity),
    "Operational-v2-Ausgabeverzeichnis wurde ausgetauscht.",
  );
}

async function restoreMismatchedQuarantinedFile({ originalPath, quarantinedPath, quarantinePath, label }) {
  try {
    await lstat(originalPath, { bigint: true });
    throw new Error(`${label}-Originalpfad wurde waehrend der Wiederherstellung erneut belegt.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename(quarantinedPath, originalPath);
  try {
    await rmdir(quarantinePath);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
  }
}

async function removeOwnedFileByQuarantine(parent, path, identity, label, hooks = {}) {
  await assertPinnedParent(parent);
  const current = await lstat(path, { bigint: true });
  invariant(current.isFile() && !current.isSymbolicLink() && sameIdentity(current, identity), `${label} wurde vor der Bereinigung fremd ersetzt; die fremde Datei bleibt unangetastet.`);
  const quarantine = resolve(parent.real, `.${basename(path)}.${process.pid}.${randomUUID()}.owned-cleanup`);
  invariant(relative(parent.real, quarantine) !== "" && !relative(parent.real, quarantine).startsWith(`..${sep}`), `${label}-Quarantaene verliess das gepinnte Elternverzeichnis.`);
  await mkdir(quarantine, { mode: 0o700 });
  const quarantineIdentity = await lstat(quarantine, { bigint: true });
  const quarantined = resolve(quarantine, "owned");
  try {
    await assertPinnedParent(parent);
    await hooks.beforeOwnedFileQuarantineRename?.({ label, originalPath: path, quarantinedPath: quarantined });
    await rename(path, quarantined);
    await hooks.afterOwnedFileQuarantine?.({ label, originalPath: path, quarantinedPath: quarantined });
    const moved = await lstat(quarantined, { bigint: true });
    if (!moved.isFile() || moved.isSymbolicLink() || !sameIdentity(moved, identity)) {
      await restoreMismatchedQuarantinedFile({ originalPath: path, quarantinedPath: quarantined, quarantinePath: quarantine, label });
      throw new Error(`${label}-Quarantaene enthielt eine fremde Ersatzdatei; sie wurde am Originalpfad wiederhergestellt.`);
    }
    await hooks.beforeOwnedFileUnlink?.({ label, originalPath: path, quarantinedPath: quarantined });
    const final = await lstat(quarantined, { bigint: true });
    if (!final.isFile() || final.isSymbolicLink() || !sameIdentity(final, identity)) {
      await restoreMismatchedQuarantinedFile({ originalPath: path, quarantinedPath: quarantined, quarantinePath: quarantine, label });
      throw new Error(`${label} wurde in der Quarantaene fremd ersetzt; die fremde Datei wurde am Originalpfad wiederhergestellt.`);
    }
    await hooks.afterOwnedFileFinalIdentityCheck?.({ label, originalPath: path, quarantinedPath: quarantined });
    const immediatelyBeforeUnlink = await lstat(quarantined, { bigint: true });
    if (!immediatelyBeforeUnlink.isFile() || immediatelyBeforeUnlink.isSymbolicLink() || !sameIdentity(immediatelyBeforeUnlink, identity)) {
      await restoreMismatchedQuarantinedFile({ originalPath: path, quarantinedPath: quarantined, quarantinePath: quarantine, label });
      throw new Error(`${label} wurde unmittelbar vor dem Unlink fremd ersetzt; die fremde Datei wurde am Originalpfad wiederhergestellt.`);
    }
    await unlink(quarantined);
    const directoryNow = await lstat(quarantine, { bigint: true });
    invariant(directoryNow.isDirectory() && sameIdentity(directoryNow, quarantineIdentity), `${label}-Quarantaeneverzeichnis wurde ausgetauscht.`);
    await rmdir(quarantine);
    await assertPinnedParent(parent);
  } catch (error) {
    throw new Error(`${label} konnte nicht identitaetsgebunden bereinigt werden: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function validateOperationalInfrastructureV2NativeReceipt(receipt, expectedReleaseId) {
  const expectedKeys = receipt !== null
      && typeof receipt === "object"
      && !Array.isArray(receipt)
      && Object.hasOwn(receipt, "semanticValidation")
    ? [...NATIVE_RECEIPT_KEYS, "semanticValidation"].sort()
    : NATIVE_RECEIPT_KEYS;
  invariant(
    receipt !== null
      && typeof receipt === "object"
      && !Array.isArray(receipt)
      && Object.keys(receipt).sort().join("\u0000") === expectedKeys.join("\u0000"),
    "Native Operational-v2-Validierung lieferte keinen vollständigen Bindungsbeleg.",
  );
  invariant(
    receipt.schema === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA
      && receipt.infraReleaseId === expectedReleaseId
      && receipt.validationMode === "native-streaming-redb-v1",
    "Native Operational-v2-Validierung lieferte keine gültige Schema-, Release- und Modusbindung.",
  );
  invariant(
    Number.isSafeInteger(receipt.sourceBytes)
      && receipt.sourceBytes > 0
      && SHA256.test(receipt.sourceSha256),
    "Native Operational-v2-Validierung lieferte keinen gültigen Quellbyte-Beleg.",
  );
  invariant(
    Number.isSafeInteger(receipt.bytes)
      && receipt.bytes > 0
      && SHA256.test(receipt.sha256)
      && SHA256.test(receipt.stateHash)
      && receipt.sha256 !== receipt.stateHash,
    "Native Operational-v2-Validierung lieferte keinen getrennten Ausgabe- und Zustandshash-Beleg.",
  );
  if (receipt.semanticValidation !== undefined) {
    invariant(
      receipt.semanticValidation !== null
        && typeof receipt.semanticValidation === "object"
        && !Array.isArray(receipt.semanticValidation)
        && Object.keys(receipt.semanticValidation).sort().join("\u0000") === NATIVE_SEMANTIC_VALIDATION_KEYS.join("\u0000")
        && receipt.semanticValidation.algorithm === "route-template-summary-linear-v2"
        && Number.isSafeInteger(receipt.semanticValidation.routeRecordsDeserialized)
        && receipt.semanticValidation.routeRecordsDeserialized > 0
        && Number.isSafeInteger(receipt.semanticValidation.interlockingRecordsDeserialized)
        && receipt.semanticValidation.interlockingRecordsDeserialized > 0
        && Number.isSafeInteger(receipt.semanticValidation.trainLegProfileReads)
        && receipt.semanticValidation.trainLegProfileReads >= 0
        && receipt.semanticValidation.routeTemplateCartesianReads === 0,
      "Native Operational-v2-Validierung lieferte keinen gueltigen linearen Semantikbeleg.",
    );
  }
  return receipt;
}

export function validateOperationalInfrastructureV2Native(
  candidatePath,
  expectedReleaseId,
  outputPath,
  { validatorExecutablePath } = {},
) {
  const explicitExecutable = validatorExecutablePath === undefined ? undefined : resolve(validatorExecutablePath);
  const configuredExecutable = explicitExecutable ?? (process.env[NATIVE_EXECUTABLE_ENV]?.trim() || undefined);
  const command = configuredExecutable ?? process.env.CARGO ?? "cargo";
  const arguments_ = configuredExecutable === undefined
    ? [
      "run",
      "--quiet",
      "--locked",
      "-p",
      "zugfolge-infra",
      "--bin",
      "zugfolge-infra-release",
      "--",
      "validate-operational-infrastructure-v2",
      candidatePath,
      expectedReleaseId,
    ]
    : ["validate-operational-infrastructure-v2", candidatePath, expectedReleaseId];
  if (outputPath !== undefined) arguments_.push(outputPath);
  const result = spawnSync(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Native Operational-v2-Validierung fehlgeschlagen:\n${result.stderr}\n${result.stdout}`);
  }
  const line = result.stdout.trim().split(/\r?\n/u).at(-1);
  let receipt;
  try {
    receipt = JSON.parse(line);
  } catch {
    throw new Error("Native Operational-v2-Validierung lieferte kein JSON-Receipt.");
  }
  return validateOperationalInfrastructureV2NativeReceipt(receipt, expectedReleaseId);
}

export async function materializeOperationalInfrastructureV2({
  candidatePath,
  expectedReleaseId,
  outputPath,
  validatorExecutablePath,
  validateNative = validateOperationalInfrastructureV2Native,
  hooks = {},
}) {
  invariant(typeof expectedReleaseId === "string" && expectedReleaseId !== "", "Erwartete InfraRelease-ID fehlt.");
  const candidate = resolve(candidatePath);
  const output = resolve(outputPath);
  invariant(candidate !== output, "Candidate und materialisiertes Operational-v2-Artefakt müssen getrennte Dateien sein.");
  invariant(basename(output) === "operational-infrastructure-v2.json", "Operational-v2-Ausgabe besitzt keinen kanonischen Dateinamen.");
  await mkdir(dirname(output), { recursive: true });
  const parent = await pinParentDirectory(dirname(output));
  invariant(normalizedPath(dirname(output)) === normalizedPath(parent.real), "Operational-v2-Ausgabe muss direkt im gepinnten Elternverzeichnis liegen.");
  const temporaryOutput = resolve(parent.real, `.${basename(output)}.${process.pid}.${randomUUID()}.native-building`);
  let temporaryIdentity;
  let outputIdentity;
  let result;
  let operationError;
  try {
    const sourceBefore = await fileProof(candidate, "Operational-v2-Candidate");
    const nativeReceipt = validateOperationalInfrastructureV2NativeReceipt(
      await validateNative(candidate, expectedReleaseId, temporaryOutput, { validatorExecutablePath }),
      expectedReleaseId,
    );
    const sourceAfter = await fileProof(candidate, "Operational-v2-Candidate");
    invariant(
      sourceBefore.bytes === sourceAfter.bytes && sourceBefore.sha256 === sourceAfter.sha256,
      "Operational-v2-Candidate änderte sich während der nativen Validierung.",
    );
    invariant(
      nativeReceipt.sourceBytes === sourceAfter.bytes && nativeReceipt.sourceSha256 === sourceAfter.sha256,
      "Native Operational-v2-Validierung ist nicht an die geprüften Candidate-Bytes gebunden.",
    );
    const inspectedOutput = await inspectRegularFile(temporaryOutput, "Native Operational-v2-Ausgabe");
    temporaryIdentity = inspectedOutput.identity;
    const outputProof = inspectedOutput.proof;
    invariant(
      nativeReceipt.bytes === outputProof.bytes && nativeReceipt.sha256 === outputProof.sha256,
      "Native Operational-v2-Validierung ist nicht an die materialisierten Ausgabe-Bytes gebunden.",
    );

    if (sourceAfter.bytes <= MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES) {
      const inputBytes = await readFile(candidate);
      invariant(
        inputBytes.length === sourceAfter.bytes && createHash("sha256").update(inputBytes).digest("hex") === sourceAfter.sha256,
        "Operational-v2-Candidate änderte sich vor dem JavaScript-Gegenvergleich.",
      );
      let infrastructure;
      try {
        infrastructure = JSON.parse(inputBytes);
      } catch (error) {
        throw new Error(`Operational-v2-Candidate ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      invariant(infrastructure.id === expectedReleaseId, "Operational-v2-Candidate verletzt die InfraRelease-ID-Bindung.");
      const stateHash = operationalInfrastructureV2StateHash(infrastructure);
      invariant(nativeReceipt.stateHash === stateHash, "JavaScript- und native Rust-Kanonisierung laufen auseinander.");
      const expectedOutput = Buffer.from(`${canonicalOperationalInfrastructureV2Json(infrastructure)}\n`, "utf8");
      const actualOutput = await readFile(temporaryOutput);
      invariant(actualOutput.equals(expectedOutput), "JavaScript- und native Rust-Materialisierung laufen auseinander.");
    }

    await assertPinnedParent(parent);
    try {
      await link(temporaryOutput, output);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("Operational-v2-Ausgabe existiert bereits; create-new verweigert jede Überschreibung.");
      throw error;
    }
    const linkedOutput = await lstat(output, { bigint: true });
    invariant(linkedOutput.isFile() && !linkedOutput.isSymbolicLink() && sameIdentity(linkedOutput, temporaryIdentity), "Operational-v2-Ausgabe wurde beim create-new-Link ausgetauscht.");
    outputIdentity = Object.freeze({ dev: linkedOutput.dev, ino: linkedOutput.ino });
    await hooks.beforeTemporaryCleanup?.({ output, temporaryOutput });
    result = validatorExecutablePath === undefined
      ? { ...nativeReceipt, output }
      : { ...nativeReceipt, output, validatorExecutablePath: resolve(validatorExecutablePath) };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];
  if (temporaryIdentity !== undefined) {
    try {
      await removeOwnedFileByQuarantine(parent, temporaryOutput, temporaryIdentity, "Native Operational-v2-Temporausgabe", hooks);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError !== undefined || cleanupErrors.length > 0) {
    if (outputIdentity !== undefined) {
      try {
        await removeOwnedFileByQuarantine(parent, output, outputIdentity, "Publizierte Operational-v2-Ausgabe", hooks);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const causes = operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors];
    if (causes.length === 1) throw causes[0];
    throw new AggregateError(causes, "Operational-v2-Materialisierung oder identitaetsgebundene Bereinigung ist fehlgeschlagen.");
  }
  await assertPinnedParent(parent);
  const finalOutput = await inspectRegularFile(output, "Finale Operational-v2-Ausgabe");
  invariant(sameIdentity(finalOutput.identity, outputIdentity), "Finale Operational-v2-Ausgabe wurde nach der Bereinigung ausgetauscht.");
  invariant(finalOutput.proof.bytes === result.bytes && finalOutput.proof.sha256 === result.sha256, "Finale Operational-v2-Ausgabe driftet vom nativen Receipt.");
  return result;
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [candidatePath, expectedReleaseId, outputPath, ...extra] = process.argv.slice(2);
  if (!candidatePath || !expectedReleaseId || !outputPath || extra.length > 0) {
    throw new Error("Aufruf: materialize-operational-infrastructure-v2.mjs CANDIDATE.json EXPECTED_RELEASE_ID OUTPUT/operational-infrastructure-v2.json");
  }
  materializeOperationalInfrastructureV2({ candidatePath, expectedReleaseId, outputPath })
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
