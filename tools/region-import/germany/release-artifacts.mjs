import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  operationalInfrastructureV2StateHash,
  OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
} from "../operational-infrastructure-binding.mjs";
import {
  validateOperationalInfrastructureV2Native,
  validateOperationalInfrastructureV2NativeReceipt,
} from "../materialize-operational-infrastructure-v2.mjs";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const ARTIFACT_SPEC_V1 = "zugfolge-infra-release-artifact-spec/v1";
const ARTIFACT_SPEC_V2 = "zugfolge-infra-release-artifact-spec/v2";
const MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES = 64 * 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function contained(root, sourceFile, label) {
  invariant(typeof sourceFile === "string" && sourceFile !== "" && !isAbsolute(sourceFile), `${label} muss ein relativer Pfad sein.`);
  const path = resolve(root, sourceFile);
  const remainder = relative(resolve(root), path);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlässt die Quellwurzel.`);
  return path;
}

async function fileProof(path) {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${path} ist kein reguläres Releaseartefakt.`);
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === metadata.size, `${path} änderte sich während der Hashbildung.`);
  return { bytes, sha256: digest.digest("hex") };
}

async function operationalInfrastructureProof(path, expectedReleaseId, validateNative) {
  const before = await fileProof(path);
  const nativeReceipt = validateOperationalInfrastructureV2NativeReceipt(
    await validateNative(path, expectedReleaseId),
    expectedReleaseId,
  );
  const after = await fileProof(path);
  invariant(
    before.bytes === after.bytes && before.sha256 === after.sha256,
    `${path} änderte sich während der nativen Operational-v2-Validierung.`,
  );
  invariant(
    nativeReceipt.sourceBytes === after.bytes && nativeReceipt.sourceSha256 === after.sha256,
    "Native Operational-v2-Validierung ist nicht an die inventarisierten Quellbytes gebunden.",
  );
  invariant(
    nativeReceipt.bytes === after.bytes && nativeReceipt.sha256 === after.sha256,
    "Statische Operational-v2-Infrastruktur entspricht nicht den nativen kanonischen Ausgabe-Bytes.",
  );

  if (after.bytes <= MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES) {
    const bytes = await readFile(path);
    invariant(
      bytes.length === after.bytes && createHash("sha256").update(bytes).digest("hex") === after.sha256,
      `${path} änderte sich vor dem JavaScript-Gegenvergleich.`,
    );
    let infrastructure;
    try {
      infrastructure = JSON.parse(bytes);
    } catch (error) {
      throw new Error(`${path} ist kein gültiges statisches Operational-v2-JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    invariant(infrastructure.id === expectedReleaseId, "Statische Operational-v2-Infrastruktur verletzt die InfraRelease-ID-Bindung.");
    invariant(
      operationalInfrastructureV2StateHash(infrastructure) === nativeReceipt.stateHash,
      "JavaScript- und native Rust-Kanonisierung der Operational-v2-Infrastruktur laufen auseinander.",
    );
  }
  return { ...after, stateHash: nativeReceipt.stateHash };
}

export async function buildReleaseArtifactInventory(
  spec,
  sourceRoot,
  { validateOperationalInfrastructure = validateOperationalInfrastructureV2Native } = {},
) {
  invariant(spec?.schema === ARTIFACT_SPEC_V1 || spec?.schema === ARTIFACT_SPEC_V2, "Unbekanntes Releaseartefakt-Schema.");
  invariant(Array.isArray(spec.artifacts) && spec.artifacts.length > 0, "Releaseartefakt-Spezifikation ist leer.");
  const operationalDescriptors = spec.artifacts.filter((descriptor) => descriptor?.kind === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA);
  if (spec.schema === ARTIFACT_SPEC_V2) {
    invariant(operationalDescriptors.length === 1, "Releaseartefakt-Spezifikation v2 muss genau eine statische Operational-v2-Infrastruktur enthalten.");
  } else {
    invariant(operationalDescriptors.length === 0, "Operational-v2-Infrastruktur verlangt die Releaseartefakt-Spezifikation v2.");
  }
  const ids = new Set();
  const publicFiles = new Set();
  const artifacts = [];
  for (const descriptor of [...spec.artifacts].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
    if (spec.schema === ARTIFACT_SPEC_V2) {
      const expectedKeys = descriptor?.kind === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA
        ? ["file", "id", "infraReleaseId", "kind", "sourceFile"]
        : ["file", "id", "kind", "sourceFile"];
      invariant(
        Object.keys(descriptor).sort().join("\u0000") === expectedKeys.join("\u0000"),
        `Releaseartefakt ${String(descriptor?.id)} besitzt unbekannte oder manuell gesetzte Bindungsfelder.`,
      );
    }
    invariant(typeof descriptor?.id === "string" && SAFE_ID.test(descriptor.id) && !ids.has(descriptor.id), "Releaseartefakt-ID ist ungültig oder doppelt.");
    invariant(typeof descriptor.kind === "string" && descriptor.kind !== "", `Releaseartefakt ${descriptor.id} besitzt keine Art.`);
    if (spec.schema === ARTIFACT_SPEC_V2) {
      invariant(descriptor.kind !== "train-map-projection", "Weltbezogene Zugprojektionen gehören nicht in den statischen InfraRelease-Artefaktvertrag.");
    }
    invariant(typeof descriptor.file === "string" && descriptor.file !== "" && !descriptor.file.includes("/") && !descriptor.file.includes("\\") && !publicFiles.has(descriptor.file), `Releaseartefakt ${descriptor.id} besitzt keinen eindeutigen öffentlichen Dateinamen.`);
    if (descriptor.kind === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA) {
      invariant(descriptor.file === "operational-infrastructure-v2.json", "Statische Operational-v2-Infrastruktur besitzt keinen kanonischen Dateinamen.");
      invariant(typeof descriptor.infraReleaseId === "string" && SAFE_ID.test(descriptor.infraReleaseId), "Statische Operational-v2-Infrastruktur besitzt keine gültige InfraRelease-ID-Bindung.");
    }
    ids.add(descriptor.id);
    publicFiles.add(descriptor.file);
    const path = contained(sourceRoot, descriptor.sourceFile, `${descriptor.id}.sourceFile`);
    artifacts.push({
      id: descriptor.id,
      kind: descriptor.kind,
      file: descriptor.file,
      ...(descriptor.kind === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA
        ? { infraReleaseId: descriptor.infraReleaseId }
        : {}),
      ...await (descriptor.kind === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA
        ? operationalInfrastructureProof(path, descriptor.infraReleaseId, validateOperationalInfrastructure)
        : fileProof(path)),
    });
  }
  return {
    schema: spec.schema === ARTIFACT_SPEC_V2 ? "zugfolge-infra-release-artifacts/v2" : "zugfolge-infra-release-artifacts/v1",
    artifacts,
  };
}

export async function readReleaseArtifactSpec(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
