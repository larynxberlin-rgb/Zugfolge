#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalOperationalInfrastructureV2Json,
  operationalInfrastructureV2StateHash,
  OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
} from "./operational-infrastructure-binding.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateOperationalInfrastructureV2Native(candidatePath, expectedReleaseId) {
  const cargo = process.env.CARGO ?? "cargo";
  const result = spawnSync(cargo, [
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
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Native Operational-v2-Validierung fehlgeschlagen:\n${result.stderr}\n${result.stdout}`);
  }
  const line = result.stdout.trim().split(/\r?\n/u).at(-1);
  const receipt = JSON.parse(line);
  invariant(
    receipt?.schema === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA
      && receipt.infraReleaseId === expectedReleaseId
      && typeof receipt.stateHash === "string"
      && /^[a-f0-9]{64}$/u.test(receipt.stateHash),
    "Native Operational-v2-Validierung lieferte keinen gültigen Bindungsbeleg.",
  );
  return receipt;
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
  const candidateMetadata = await lstat(candidate);
  invariant(
    candidateMetadata.isFile() && !candidateMetadata.isSymbolicLink() && candidateMetadata.size > 0,
    "Operational-v2-Candidate ist keine nichtleere reguläre Datei.",
  );
  const inputBytes = await readFile(candidate);
  invariant(inputBytes.length === candidateMetadata.size, "Operational-v2-Candidate änderte sich während des Lesens.");
  const infrastructure = JSON.parse(inputBytes);
  invariant(infrastructure.id === expectedReleaseId, "Operational-v2-Candidate verletzt die InfraRelease-ID-Bindung.");
  const stateHash = operationalInfrastructureV2StateHash(infrastructure);
  const nativeReceipt = await validateNative(candidate, expectedReleaseId);
  invariant(nativeReceipt.stateHash === stateHash, "JavaScript- und native Rust-Kanonisierung laufen auseinander.");
  const unchangedBytes = await readFile(candidate);
  invariant(inputBytes.equals(unchangedBytes), "Operational-v2-Candidate änderte sich während der Validierung.");

  const materializedBytes = Buffer.from(`${canonicalOperationalInfrastructureV2Json(infrastructure)}\n`, "utf8");
  const sha256 = createHash("sha256").update(materializedBytes).digest("hex");
  invariant(sha256 !== stateHash, "Byte-SHA-256 und kanonischer Operational-v2-Zustandshash dürfen nicht gleichgesetzt werden.");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, materializedBytes, { flag: "wx" });
  return {
    schema: OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
    infraReleaseId: expectedReleaseId,
    output,
    bytes: materializedBytes.length,
    sha256,
    stateHash,
  };
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
