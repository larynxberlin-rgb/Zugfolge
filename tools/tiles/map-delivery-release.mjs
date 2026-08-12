import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { validateMapPackageSpec, validatePortableRelativePath } from "./map-package.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const DELIVERY_SCHEMA = "zugfolge-map-delivery-release/v1";
const SOURCES_SCHEMA = "zugfolge-map-delivery-sources/v1";
const PACKAGE_SCHEMA = "zugfolge-map-package/v1";
const QUALITY_SCHEMA = "zugfolge-final-infrastructure-quality-report/v1";
const LARGE_AUXILIARY_KINDS = new Set(["read-model", "train-map-projection"]);
const FORBIDDEN_PUBLIC_REFERENCE = /(?:trassenfinder|(?:^|[\s/_.-])apn(?:$|[\s/_.-]))/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

export function serializeDeliveryJson(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

function releaseValue(value, schema, label) {
  const release = value?.release ?? value;
  invariant(release?.schema === schema, `${label} hat ein unbekanntes Schema.`);
  return release;
}

function publicSource(scope, source) {
  invariant(typeof source?.id === "string" && source.id !== "", `${scope}-Quelle ohne ID.`);
  invariant(typeof source.sourceLicense === "string" && source.sourceLicense !== "", `Quelle ${source.id} ohne Lizenz.`);
  invariant(typeof source.attribution === "string" && source.attribution !== "", `Quelle ${source.id} ohne Attribution.`);
  invariant(typeof source.version === "string" && source.version !== "", `Quelle ${source.id} ohne gepinnte Version.`);
  const entry = {
    id: `${scope}-${source.id}`,
    scope,
    approved: true,
    license: source.sourceLicense,
    version: source.version,
    attribution: source.attribution,
    modifications: typeof source.modifications === "string" ? source.modifications : "Keine weitere Bearbeitung deklariert.",
  };
  invariant(!FORBIDDEN_PUBLIC_REFERENCE.test(JSON.stringify(entry)), `Quelle ${source.id} enthält eine interne Validierungsreferenz.`);
  return entry;
}

export function buildMapDeliverySources({ releaseId, infraRelease: infraInput, mapRelease: mapInput }) {
  const infraRelease = releaseValue(infraInput, "zugfolge-infra-release/v2", "InfraRelease");
  const mapRelease = releaseValue(mapInput, "zugfolge-map-release/v1", "Kartenrelease");
  invariant(infraRelease.releaseId === releaseId, "InfraRelease und Delivery-Release nennen verschiedene Release-IDs.");
  invariant(Array.isArray(infraRelease.sources) && Array.isArray(mapRelease.sources), "Öffentlicher Quellenbeleg ist unvollständig.");
  const sources = [
    ...infraRelease.sources.map((source) => publicSource("infrastructure", source)),
    ...mapRelease.sources.map((source) => publicSource("basemap", source)),
  ].sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(new Set(sources.map(({ id }) => id)).size === sources.length, "Delivery-Quellen besitzen doppelte IDs.");
  invariant(sources.some(({ attribution }) => /openstreetmap/i.test(attribution)), "OpenStreetMap-Attribution fehlt.");
  invariant(sources.some(({ attribution }) => /protomaps/i.test(attribution)), "Protomaps-Attribution fehlt.");
  return { schema: SOURCES_SCHEMA, releaseId, sources };
}

function resolveContained(root, portablePath, label) {
  validatePortableRelativePath(portablePath, label);
  const absoluteRoot = resolve(root);
  const path = resolve(absoluteRoot, ...portablePath.split("/"));
  const remainder = relative(absoluteRoot, path);
  invariant(remainder !== "" && !remainder.startsWith(".."), `${label} verlässt die Quellwurzel.`);
  return path;
}

function normalizeProofs(proofs) {
  invariant(Array.isArray(proofs), "Großartefaktbelege müssen eine Liste sein.");
  const byId = new Map();
  for (const proof of proofs) {
    invariant(typeof proof?.id === "string" && proof.id !== "" && Number.isSafeInteger(proof.bytes) && proof.bytes > 0 && SHA256.test(proof.sha256), "Großartefaktbeleg ist unvollständig.");
    invariant(!byId.has(proof.id), `Großartefaktbeleg ${proof.id} ist doppelt.`);
    byId.set(proof.id, { bytes: proof.bytes, sha256: proof.sha256 });
  }
  return byId;
}

async function inventoryArtifact(descriptor, sourceRoot, trustedProof) {
  const sourcePath = resolveContained(sourceRoot, descriptor.sourceFile, `${descriptor.id}.sourceFile`);
  const metadata = await lstat(sourcePath);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${descriptor.id} ist keine reguläre Quelldatei.`);
  let proof;
  if (trustedProof !== undefined) {
    invariant(metadata.size === trustedProof.bytes, `${descriptor.id} weicht von der belegten Bytezahl ab.`);
    if (descriptor.expectedBytes !== undefined || descriptor.expectedSha256 !== undefined) {
      invariant(
        trustedProof.bytes === descriptor.expectedBytes && trustedProof.sha256 === descriptor.expectedSha256,
        `${descriptor.id} weicht vom freigegebenen Byte-SHA-Beleg des Paketplans ab.`,
      );
    }
    proof = trustedProof;
  } else {
    proof = await sha256File(sourcePath);
  }
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    installPath: descriptor.installPath,
    bytes: proof.bytes,
    sha256: proof.sha256,
  };
}

function validateQuality(qualityReport, releaseId) {
  invariant(qualityReport?.schema === QUALITY_SCHEMA && qualityReport.releaseId === releaseId, "Qualitätsbericht ist nicht an den Delivery-Release gebunden.");
  invariant(qualityReport.deterministic === true && qualityReport.policy?.classAFromSingleSourceOrAutomatedInference === false, "Qualitätsbericht besitzt keinen konservativen Nachweisvertrag.");
  invariant(qualityReport.policy?.nonPublicSourceRawDataShipped === false, "Qualitätsbericht erlaubt nichtöffentliche Rohdaten in der Auslieferung.");
  invariant(qualityReport.summary?.visibleLayers === 10 && Number.isSafeInteger(qualityReport.summary?.visibleFeatures) && qualityReport.summary.visibleFeatures > 0, "Qualitätsbericht besitzt keinen vollständigen sichtbaren Zehn-Layer-Korpus.");
  invariant(/not orderable/i.test(String(qualityReport.policy?.classC)), "Klasse C ist nicht ausdrücklich unbestellbar.");
}

function artifactProofsFromMapRelease(mapRelease, packageSpec) {
  invariant(Array.isArray(mapRelease.artifacts) && mapRelease.artifacts.length === 2, "Kartenrelease braucht genau zwei PMTiles-Belege.");
  const result = new Map();
  for (const descriptor of packageSpec.artifacts) {
    const proof = mapRelease.artifacts.find(({ kind }) => kind === descriptor.kind);
    invariant(proof !== undefined && Number.isSafeInteger(proof.bytes) && proof.bytes > 0 && SHA256.test(proof.sha256), `Kartenrelease belegt ${descriptor.kind} nicht bytegenau.`);
    result.set(descriptor.id, { bytes: proof.bytes, sha256: proof.sha256 });
  }
  return result;
}

export async function buildMapDeliveryRelease({
  releaseId,
  timetableYear,
  packageSpec: packageSpecInput,
  sourceRoot,
  infraRelease: infraInput,
  mapRelease: mapInput,
  auxiliaryArtifactProofs = [],
}) {
  invariant(typeof releaseId === "string" && releaseId !== "", "Delivery-Release ohne releaseId.");
  invariant(Number.isSafeInteger(timetableYear) && timetableYear >= 2026, "Delivery-Release ohne Fahrplanjahr.");
  const packageSpec = validateMapPackageSpec(packageSpecInput);
  const infraRelease = releaseValue(infraInput, "zugfolge-infra-release/v2", "InfraRelease");
  const mapRelease = releaseValue(mapInput, "zugfolge-map-release/v1", "Kartenrelease");
  invariant(infraRelease.releaseId === releaseId && infraRelease.timetableYear === timetableYear, "InfraRelease passt nicht zum Delivery-Jahr.");
  const sources = buildMapDeliverySources({ releaseId, infraRelease, mapRelease });
  const sourcesBytes = serializeDeliveryJson(sources);

  const qualityDescriptor = packageSpec.auxiliaryFiles.find(({ kind }) => kind === "quality-manifest");
  invariant(qualityDescriptor !== undefined, "Paketvertrag besitzt keinen Qualitätsbericht.");
  const qualityPath = resolveContained(sourceRoot, qualityDescriptor.sourceFile, `${qualityDescriptor.id}.sourceFile`);
  const qualityBytes = await readFile(qualityPath);
  invariant(qualityBytes.length <= 16 * 1024 * 1024, "Qualitätsbericht ist unerwartet groß.");
  const qualityReport = JSON.parse(qualityBytes.toString("utf8"));
  validateQuality(qualityReport, releaseId);

  const trustedProofs = normalizeProofs(auxiliaryArtifactProofs);
  for (const [id, proof] of artifactProofsFromMapRelease(mapRelease, packageSpec)) {
    invariant(!trustedProofs.has(id), `Großartefaktbeleg ${id} darf keinen PMTiles-Beleg überschreiben.`);
    trustedProofs.set(id, proof);
  }
  const largeAuxiliaries = packageSpec.auxiliaryFiles.filter(({ kind }) => LARGE_AUXILIARY_KINDS.has(kind));
  invariant(
    largeAuxiliaries.every(({ id }) => trustedProofs.has(id)),
    "ReadModel und Zugpositionsprojektion brauchen jeweils einen eigenen vorab geprüften Byte-SHA-Beleg.",
  );

  const inventoryDescriptors = [...packageSpec.artifacts, ...packageSpec.auxiliaryFiles]
    .filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const artifacts = [];
  for (const descriptor of inventoryDescriptors) {
    artifacts.push(await inventoryArtifact(descriptor, sourceRoot, trustedProofs.get(descriptor.id)));
  }
  invariant(trustedProofs.size === packageSpec.artifacts.length + largeAuxiliaries.length, "Großartefaktbelege enthalten eine unerwartete Datei.");

  const release = {
    schema: DELIVERY_SCHEMA,
    releaseId,
    timetableYear,
    packageId: packageSpec.packageId,
    packageVersion: packageSpec.version,
    scope: {
      basemap: "world-z0-10-and-germany-z11-15",
      infrastructure: "germany-ebo-complete-visible-corpus",
      playableArea: "configured-separately-by-world",
    },
    artifacts,
    bindings: {
      packageManifestSchema: PACKAGE_SCHEMA,
      infraReleaseSchema: infraRelease.schema,
      mapReleaseSchema: mapRelease.schema,
      sourcesSha256: sha256Bytes(sourcesBytes),
      qualitySha256: sha256Bytes(qualityBytes),
    },
    approvalGates: {
      rights: { status: "passed", sourceManifestSchema: SOURCES_SCHEMA, sourceCount: sources.sources.length },
      quality: {
        status: "passed",
        reportSchema: QUALITY_SCHEMA,
        visibleLayers: qualityReport.summary.visibleLayers,
        visibleFeatures: qualityReport.summary.visibleFeatures,
        classCOrderable: false,
      },
      signature: { status: "missing", reason: "Kein produktiver privater Signaturschlüssel vorhanden; Aktivierung bleibt gesperrt." },
    },
    signature: null,
  };
  const releaseBytes = serializeDeliveryJson(release);
  invariant(!FORBIDDEN_PUBLIC_REFERENCE.test(releaseBytes.toString("utf8")) && !FORBIDDEN_PUBLIC_REFERENCE.test(sourcesBytes.toString("utf8")), "Delivery-Vertrag enthält interne Validierungsreferenzen.");
  return {
    release,
    releaseBytes,
    releaseSha256: sha256Bytes(releaseBytes),
    sources,
    sourcesBytes,
    sourcesSha256: sha256Bytes(sourcesBytes),
  };
}

async function writeReproducible(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = await readFile(path);
    invariant(existing.equals(bytes), `${path} existiert mit abweichendem Inhalt.`);
    return "reused";
  } catch (error) {
    if (!(error !== null && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return "written";
}

export async function writeMapDeliveryRelease(result, outputDirectory) {
  const root = resolve(outputDirectory);
  const releasePath = join(root, "release.json");
  const sourcesPath = join(root, "sources.json");
  const [releaseStatus, sourcesStatus] = await Promise.all([
    writeReproducible(releasePath, result.releaseBytes),
    writeReproducible(sourcesPath, result.sourcesBytes),
  ]);
  return { releasePath, sourcesPath, releaseStatus, sourcesStatus };
}
