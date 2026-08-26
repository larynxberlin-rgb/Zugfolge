#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function fileProof(path, label) {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${label} ist keine nichtleere reguläre Datei.`);
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === metadata.size, `${label} änderte sich während der Hashbildung.`);
  return { bytes, sha256: digest.digest("hex") };
}

export function validateOperationalInfrastructureV2NativeReceipt(receipt, expectedReleaseId) {
  invariant(
    receipt !== null
      && typeof receipt === "object"
      && !Array.isArray(receipt)
      && Object.keys(receipt).sort().join("\u0000") === NATIVE_RECEIPT_KEYS.join("\u0000"),
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
  return receipt;
}

export function validateOperationalInfrastructureV2Native(candidatePath, expectedReleaseId, outputPath) {
  const configuredExecutable = process.env[NATIVE_EXECUTABLE_ENV]?.trim() || undefined;
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
  validateNative = validateOperationalInfrastructureV2Native,
}) {
  invariant(typeof expectedReleaseId === "string" && expectedReleaseId !== "", "Erwartete InfraRelease-ID fehlt.");
  const candidate = resolve(candidatePath);
  const output = resolve(outputPath);
  invariant(candidate !== output, "Candidate und materialisiertes Operational-v2-Artefakt müssen getrennte Dateien sein.");
  invariant(basename(output) === "operational-infrastructure-v2.json", "Operational-v2-Ausgabe besitzt keinen kanonischen Dateinamen.");
  await mkdir(dirname(output), { recursive: true });
  const temporaryOutput = `${output}.${process.pid}.${randomUUID()}.native-building`;
  try {
    const sourceBefore = await fileProof(candidate, "Operational-v2-Candidate");
    const nativeReceipt = validateOperationalInfrastructureV2NativeReceipt(
      await validateNative(candidate, expectedReleaseId, temporaryOutput),
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
    const outputProof = await fileProof(temporaryOutput, "Native Operational-v2-Ausgabe");
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

    try {
      await link(temporaryOutput, output);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("Operational-v2-Ausgabe existiert bereits; create-new verweigert jede Überschreibung.");
      throw error;
    }
    return { ...nativeReceipt, output };
  } finally {
    await rm(temporaryOutput, { force: true });
  }
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
