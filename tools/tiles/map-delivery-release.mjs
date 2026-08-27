import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { validateMapAssetNoticeBindings, validateMapAssetNotices } from "./map-asset-notices.mjs";
import { validateMapPackageSpec, validatePortableRelativePath } from "./map-package.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const DELIVERY_SCHEMA_V1 = "zugfolge-map-delivery-release/v1";
const DELIVERY_SCHEMA_V2 = "zugfolge-map-delivery-release/v2";
const SOURCES_SCHEMA = "zugfolge-map-delivery-sources/v2";
const PACKAGE_SCHEMA_V1 = "zugfolge-map-package/v1";
const PACKAGE_SCHEMA_V2 = "zugfolge-map-package/v2";
const PACKAGE_SPEC_V2 = "zugfolge-map-package-spec/v2";
const LEGACY_QUALITY_SCHEMA = "zugfolge-final-infrastructure-quality-report/v1";
const OPERATIONAL_QUALITY_SCHEMA = "zugfolge-operational-infrastructure-quality-report/v1";
const STATIC_MAP_QUALITY_SCHEMA = "zugfolge-static-map-quality/v2";
const OPERATIONAL_INFRASTRUCTURE_KIND = "operational-infrastructure-v2";
const MOVEMENT_ROUTE_TEMPLATES_KIND = "movement-route-templates-v2";
const TIMETABLE_TRANSFER_DEMANDS_KIND = "timetable-transfer-demands-v2";
const CANONICAL_PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PUBLIC KEY-----\n$/u;
const QUALITY_LAYER_NAMES = Object.freeze([
  "rail_corridors", "operating_points", "stations", "tracks", "platforms",
  "switches", "signals", "blocks", "conflict_resources", "rail_context",
]);
const LARGE_AUXILIARY_KINDS = new Set([
  "read-model",
  "train-map-projection",
  OPERATIONAL_INFRASTRUCTURE_KIND,
  MOVEMENT_ROUTE_TEMPLATES_KIND,
  TIMETABLE_TRANSFER_DEMANDS_KIND,
]);
const FORBIDDEN_PUBLIC_REFERENCE = /(?:trassenfinder|(?:^|[\s/_.-])apn(?:$|[\s/_.-]))/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} ist kein Objekt.`);
  invariant(
    Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000"),
    `${label} besitzt unerwartete oder fehlende Felder.`,
  );
}

function qualityClasses(value, label) {
  exactKeys(value, ["A", "B", "C"], label);
  invariant([value.A, value.B, value.C].every((count) => Number.isSafeInteger(count) && count >= 0), `${label} enthält keine nichtnegative sichere A/B/C-Bilanz.`);
  return value;
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

function canonicalValueSha256(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(sortedValue(value)), "utf8"));
}

export function deliveryReleaseHash(release) {
  invariant([DELIVERY_SCHEMA_V1, DELIVERY_SCHEMA_V2].includes(release?.schema), "Delivery-Signatur besitzt kein bekanntes Release-Schema.");
  const { releaseHash: ignoredHash, signature: ignoredSignature, ...payload } = release;
  void ignoredHash;
  void ignoredSignature;
  return sha256Bytes(serializeDeliveryJson(payload));
}

export function canonicalEd25519SpkiPublicKey(publicKeyPem, label = "Delivery-Vertrauensanker") {
  invariant(typeof publicKeyPem === "string" && publicKeyPem.length > 0, `${label} ist kein oeffentlicher PEM-Schluessel.`);
  invariant(!/PRIVATE KEY/u.test(publicKeyPem), `${label} enthaelt privates Schluesselmaterial.`);
  invariant(
    CANONICAL_PUBLIC_KEY_PEM.test(publicKeyPem),
    `${label} ist nicht exakt als kanonischer Ed25519-SPKI-Public-Key-PEM ohne Restbytes serialisiert.`,
  );
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new Error(`${label} ist kein gueltiger Ed25519-SPKI-Public-Key-PEM.`);
  }
  invariant(
    publicKey.type === "public" && publicKey.asymmetricKeyType === "ed25519",
    `${label} ist kein Ed25519-SPKI-Public-Key-PEM.`,
  );
  const canonical = publicKey.export({ type: "spki", format: "pem" });
  invariant(
    typeof canonical === "string" && publicKeyPem === canonical,
    `${label} ist nicht exakt als kanonischer Ed25519-SPKI-Public-Key-PEM ohne Restbytes serialisiert.`,
  );
  return publicKey;
}

export function signMapDeliveryRelease(release, privateKeyPem, keyId) {
  invariant(typeof keyId === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(keyId), "Delivery-Signaturschluessel besitzt keine stabile ID.");
  invariant(release?.approvalGates?.rights?.status === "passed" && release?.approvalGates?.quality?.status === "passed", "Delivery-Release darf ohne Rechte- und Qualitaetsfreigabe nicht signiert werden.");
  if (release?.schema === DELIVERY_SCHEMA_V2) {
    const signatureGate = release?.approvalGates?.signature;
    exactKeys(signatureGate, ["status", "reason"], "Unsigniertes Delivery-v2-Signaturgate");
    invariant(
      signatureGate.status === "missing"
        && typeof signatureGate.reason === "string"
        && signatureGate.reason.trim() !== ""
        && release.releaseHash === null
        && release.signature === null,
      "Unsignierter Delivery-v2-Release muss Grund, null-Releasehash und null-Signatur explizit ausweisen.",
    );
  } else {
    invariant(release?.approvalGates?.signature?.status === "missing" && release?.signature === null, "Nur ein explizit unsignierter Delivery-Release darf signiert werden.");
  }
  const privateKey = createPrivateKey(privateKeyPem);
  invariant(privateKey.asymmetricKeyType === "ed25519", "Delivery-Release verlangt einen Ed25519-Schluessel.");
  const candidate = {
    ...release,
    approvalGates: {
      ...release.approvalGates,
      signature: { status: "passed", algorithm: "Ed25519", keyId },
    },
    signature: null,
  };
  const releaseHash = deliveryReleaseHash(candidate);
  const signature = signEd25519(null, Buffer.from(releaseHash, "hex"), privateKey);
  return {
    ...candidate,
    releaseHash,
    signature: { algorithm: "Ed25519", keyId, valueBase64: signature.toString("base64") },
  };
}

export function verifyMapDeliveryReleaseSignature(release, publicKeyPem) {
  try {
    const publicKey = canonicalEd25519SpkiPublicKey(publicKeyPem);
    if (release?.schema === DELIVERY_SCHEMA_V2) {
      exactKeys(release?.approvalGates?.signature, ["status", "algorithm", "keyId"], "Signiertes Delivery-v2-Signaturgate");
      exactKeys(release?.signature, ["algorithm", "keyId", "valueBase64"], "Signierte Delivery-v2-Signatur");
    }
    const signature = Buffer.from(release?.signature?.valueBase64 ?? "", "base64");
    return publicKey.asymmetricKeyType === "ed25519"
      && release?.approvalGates?.signature?.status === "passed"
      && release.approvalGates.signature.algorithm === "Ed25519"
      && release.approvalGates.signature.keyId === release?.signature?.keyId
      && release?.signature?.algorithm === "Ed25519"
      && typeof release?.releaseHash === "string"
      && release.releaseHash === deliveryReleaseHash(release)
      && signature.length === 64
      && verifyEd25519(null, Buffer.from(release.releaseHash, "hex"), publicKey, signature);
  } catch {
    return false;
  }
}

function materializedRelease(value, schema, label, wrapperRequired = false) {
  const wrapped = value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.hasOwn(value, "release") || Object.hasOwn(value, "releaseHash"));
  invariant(!wrapperRequired || wrapped, `${label} muss fuer Delivery-v2 als releaseHash-gebundene Huelle vorliegen.`);
  if (wrapped) {
    exactKeys(value, ["release", "releaseHash"], `${label}-Huelle`);
    invariant(SHA256.test(value.releaseHash), `${label}-Huelle besitzt keinen gueltigen releaseHash.`);
    invariant(value.releaseHash === canonicalValueSha256(value.release), `${label}-Huelle bindet den kanonischen Releaseinhalt nicht.`);
  }
  const release = wrapped ? value.release : value;
  invariant(release?.schema === schema, `${label} hat ein unbekanntes Schema.`);
  return { release, releaseHash: wrapped ? value.releaseHash : null };
}

function releaseValue(value, schema, label) {
  return materializedRelease(value, schema, label).release;
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
  const assetNotices = validateMapAssetNotices(mapRelease.assetNotices);
  invariant(SHA256.test(mapRelease.assetInventoryPlanSha256), "Kartenrelease besitzt keinen Cache-Inventarplan-SHA fuer die Assets.");
  return {
    schema: SOURCES_SCHEMA,
    releaseId,
    sources,
    assetInventoryPlanSha256: mapRelease.assetInventoryPlanSha256,
    assetNotices,
  };
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileState(left, right) {
  return sameFilesystemIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertContainedRealPath(root, path, label) {
  const remainder = relative(root, path);
  invariant(
    remainder !== ""
      && remainder !== ".."
      && !remainder.startsWith(`..${sep}`)
      && !isAbsolute(remainder),
    `${label} verlässt die Quellwurzel.`,
  );
}

async function secureSourceRoot(root) {
  const requested = resolve(root);
  const requestedComponents = [];
  for (let current = requested; ; current = dirname(current)) {
    requestedComponents.push(current);
    if (dirname(current) === current) break;
  }
  let requestedMetadata;
  for (const component of requestedComponents.reverse()) {
    const metadata = await lstat(component, { bigint: true });
    invariant(
      metadata.isDirectory() && !metadata.isSymbolicLink(),
      "Delivery-Quellwurzel muss ein reguläres Verzeichnis ohne symbolischen Link sein; auch ihre Pfadbestandteile duerfen keine Symlinks oder Junctions sein.",
    );
    if (component === requested) requestedMetadata = metadata;
  }
  const canonical = await realpath(requested);
  const canonicalMetadata = await lstat(canonical, { bigint: true });
  invariant(
    canonicalMetadata.isDirectory()
      && !canonicalMetadata.isSymbolicLink()
      && sameFilesystemIdentity(requestedMetadata, canonicalMetadata),
    "Delivery-Quellwurzel änderte sich während der Auflösung.",
  );
  return Object.freeze({ canonical, identity: canonicalMetadata });
}

async function revalidateOpenedSourcePath(source, components, canonicalPath, handleMetadata, label) {
  const currentRoot = await lstat(source.canonical, { bigint: true });
  invariant(
    currentRoot.isDirectory()
      && !currentRoot.isSymbolicLink()
      && sameFilesystemIdentity(source.identity, currentRoot),
    "Delivery-Quellwurzel änderte sich während des Lesens.",
  );
  for (const component of components) {
    const metadata = await lstat(component.path, { bigint: true });
    invariant(
      !metadata.isSymbolicLink() && sameFilesystemIdentity(component.metadata, metadata),
      `${label} änderte einen Pfadbestandteil während des Lesens.`,
    );
  }
  const actual = await realpath(components.at(-1).path);
  assertContainedRealPath(source.canonical, actual, label);
  invariant(actual === canonicalPath, `${label} änderte sein reales Ziel während des Lesens.`);
  const pathMetadata = await lstat(actual, { bigint: true });
  invariant(
    pathMetadata.isFile()
      && !pathMetadata.isSymbolicLink()
      && sameFilesystemIdentity(pathMetadata, handleMetadata),
    `${label} verweist nicht mehr auf die geöffnete reguläre Datei.`,
  );
}

async function openContainedRegularFile(source, portablePath, label) {
  const portable = validatePortableRelativePath(portablePath, label);
  let current = source.canonical;
  const components = [];
  const parts = portable.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = await lstat(current, { bigint: true });
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
    invariant(
      index < parts.length - 1 ? metadata.isDirectory() : metadata.isFile(),
      index < parts.length - 1
        ? `${label} besitzt einen nicht auflösbaren Zwischenpfad.`
        : `${label} ist keine reguläre Datei.`,
    );
    components.push({ path: current, metadata });
  }
  const canonicalPath = await realpath(current);
  assertContainedRealPath(source.canonical, canonicalPath, label);
  const canonicalMetadata = await lstat(canonicalPath, { bigint: true });
  invariant(
    canonicalMetadata.isFile()
      && !canonicalMetadata.isSymbolicLink()
      && sameFilesystemIdentity(components.at(-1).metadata, canonicalMetadata),
    `${label} änderte sich während der Auflösung.`,
  );

  const handle = await open(canonicalPath, "r");
  try {
    const handleMetadata = await handle.stat({ bigint: true });
    invariant(
      handleMetadata.isFile() && sameFilesystemIdentity(canonicalMetadata, handleMetadata),
      `${label} öffnete nicht die zuvor geprüfte reguläre Datei.`,
    );
    await revalidateOpenedSourcePath(source, components, canonicalPath, handleMetadata, label);
    return { handle, handleMetadata, components, canonicalPath };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function finishContainedFileRead(source, opened, label) {
  const finalMetadata = await opened.handle.stat({ bigint: true });
  invariant(
    sameStableFileState(opened.handleMetadata, finalMetadata),
    `${label} änderte sich während des Lesens.`,
  );
  await revalidateOpenedSourcePath(
    source,
    opened.components,
    opened.canonicalPath,
    finalMetadata,
    label,
  );
  return finalMetadata;
}

async function containedFileProof(source, portablePath, label) {
  const opened = await openContainedRegularFile(source, portablePath, label);
  try {
    invariant(opened.handleMetadata.size > 0n, `${label} ist leer.`);
    invariant(opened.handleMetadata.size <= BigInt(Number.MAX_SAFE_INTEGER), `${label} ist für eine exakte Bytezählung zu groß.`);
    const expectedBytes = Number(opened.handleMetadata.size);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - offset);
      const { bytesRead } = await opened.handle.read(buffer, 0, length, offset);
      invariant(bytesRead > 0, `${label} endete unerwartet während der Hashbildung.`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await finishContainedFileRead(source, opened, label);
    return { bytes: offset, sha256: hash.digest("hex") };
  } finally {
    await opened.handle.close();
  }
}

async function readContainedFile(source, portablePath, label, maximumBytes) {
  const opened = await openContainedRegularFile(source, portablePath, label);
  try {
    invariant(opened.handleMetadata.size > 0n, `${label} ist leer.`);
    invariant(opened.handleMetadata.size <= BigInt(maximumBytes), `${label} ist unerwartet groß.`);
    const bytes = await opened.handle.readFile();
    invariant(BigInt(bytes.length) === opened.handleMetadata.size, `${label} änderte seine Bytezahl während des Lesens.`);
    await finishContainedFileRead(source, opened, label);
    return { bytes, sha256: sha256Bytes(bytes) };
  } finally {
    await opened.handle.close();
  }
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

async function inventoryArtifact(descriptor, source, trustedProof) {
  const proof = await containedFileProof(source, descriptor.sourceFile, `${descriptor.id}.sourceFile`);
  if (trustedProof !== undefined) {
    invariant(proof.bytes === trustedProof.bytes, `${descriptor.id} weicht von der belegten Bytezahl ab.`);
    invariant(proof.sha256 === trustedProof.sha256, `${descriptor.id} weicht vom belegten SHA-256 ab.`);
    if (descriptor.expectedBytes !== undefined || descriptor.expectedSha256 !== undefined) {
      invariant(
        trustedProof.bytes === descriptor.expectedBytes && trustedProof.sha256 === descriptor.expectedSha256,
        `${descriptor.id} weicht vom freigegebenen Byte-SHA-Beleg des Paketplans ab.`,
      );
    }
  }
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    installPath: descriptor.installPath,
    ...(descriptor.kind === OPERATIONAL_INFRASTRUCTURE_KIND
      ? { infraReleaseId: descriptor.infraReleaseId, stateHash: descriptor.stateHash }
      : {}),
    bytes: proof.bytes,
    sha256: proof.sha256,
  };
}

export async function inventoryMapDeliveryPackageArtifacts({ packageSpec: packageSpecInput, sourceRoot }) {
  const packageSpec = validateMapPackageSpec(packageSpecInput);
  const source = await secureSourceRoot(sourceRoot);
  const inventoryDescriptors = [...packageSpec.artifacts, ...packageSpec.auxiliaryFiles]
    .filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const artifacts = [];
  for (const descriptor of inventoryDescriptors) {
    const expectedProof = descriptor.expectedBytes === undefined
      ? undefined
      : { bytes: descriptor.expectedBytes, sha256: descriptor.expectedSha256 };
    artifacts.push(await inventoryArtifact(descriptor, source, expectedProof));
  }
  return artifacts;
}

function validateTimetableRouteEvidence(evidence) {
  exactKeys(evidence, [
    "reportSchema", "policyId", "derivationRule", "selectionRule", "reportBytes", "reportSha256",
    "routesBytes", "routesSha256", "gtfsSnapshotBytes", "gtfsSnapshotSha256", "snapshotHash", "archive",
    "archiveSha256", "sourceLicense", "sourceLicenseAsPublished", "selectedSegmentCount", "completeRouteCount",
    "routeRecordCount", "sameStopTransitionCount", "routeSetSha256", "realGeometry",
    "transferDemandsSchema", "transferDemandsBytes", "transferDemandsSha256", "dailyCirculationPlanSha256",
    "transferSetSha256", "transferDemandsProduced", "dailyCirculation", "transferRouteCount",
    "transferRouteLegCount", "transferRouteLengthMm",
    "simulatedOperationalAssignment", "realInterlockingFactsClaimed", "externalOperationalNetworkProvenance",
  ], "Operational-v2.timetableRouteEvidence");
  invariant(
    evidence.reportSchema === "zugfolge-germany-timetable-route-report/v4"
      && evidence.policyId === "synthetic-operational-b/v2"
      && evidence.derivationRule === "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2"
      && evidence.selectionRule === "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2"
      && evidence.transferDemandsSchema === "zugfolge-timetable-transfer-demands/v2",
    "Operational-v2.timetableRouteEvidence verletzt den freien v4-Fahrweg-/V2-Transfervertrag.",
  );
  invariant(
    [evidence.reportBytes, evidence.routesBytes, evidence.gtfsSnapshotBytes, evidence.transferDemandsBytes].every((bytes) => Number.isSafeInteger(bytes) && bytes > 0)
      && [evidence.reportSha256, evidence.routesSha256, evidence.gtfsSnapshotSha256, evidence.transferDemandsSha256, evidence.snapshotHash, evidence.archiveSha256, evidence.routeSetSha256, evidence.dailyCirculationPlanSha256, evidence.transferSetSha256].every((hash) => SHA256.test(hash))
      && evidence.routesSha256 === evidence.routeSetSha256,
    "Operational-v2.timetableRouteEvidence besitzt keine konsistente Datei-/RouteSet-Bindung.",
  );
  invariant(
    typeof evidence.archive === "string" && evidence.archive !== ""
      && evidence.sourceLicense === "CC-BY-4.0"
      && evidence.sourceLicenseAsPublished === "CC BY 4.0",
    "Operational-v2.timetableRouteEvidence besitzt keine freie GTFS-Lizenz- und Archivbindung.",
  );
  invariant(
    Number.isSafeInteger(evidence.selectedSegmentCount) && evidence.selectedSegmentCount > 0
      && evidence.selectedSegmentCount === evidence.completeRouteCount
      && evidence.completeRouteCount === evidence.routeRecordCount
      && Number.isSafeInteger(evidence.sameStopTransitionCount) && evidence.sameStopTransitionCount >= 0,
    "Operational-v2.timetableRouteEvidence schließt die ausgewählten Segmente nicht vollständig 1:1.",
  );
  exactKeys(evidence.dailyCirculation, [
    "lotCount", "journeyChainCount", "circulationCount", "rolloverAssignmentCount",
    "plannedTransitionCount", "turnaroundDemandCount", "transferDemandCount", "transferLotCount",
  ], "Operational-v2.timetableRouteEvidence.dailyCirculation");
  invariant(
    ["lotCount", "journeyChainCount", "circulationCount", "rolloverAssignmentCount", "plannedTransitionCount"].every((field) => Number.isSafeInteger(evidence.dailyCirculation[field]) && evidence.dailyCirculation[field] > 0)
      && ["turnaroundDemandCount", "transferDemandCount", "transferLotCount"].every((field) => Number.isSafeInteger(evidence.dailyCirculation[field]) && evidence.dailyCirculation[field] >= 0)
      && evidence.dailyCirculation.rolloverAssignmentCount === evidence.dailyCirculation.circulationCount
      && evidence.dailyCirculation.turnaroundDemandCount + evidence.dailyCirculation.transferDemandCount === evidence.dailyCirculation.plannedTransitionCount
      && evidence.dailyCirculation.transferLotCount <= evidence.dailyCirculation.lotCount
      && evidence.transferDemandsProduced === true
      && evidence.transferRouteCount === evidence.dailyCirculation.transferDemandCount
      && Number.isSafeInteger(evidence.transferRouteLegCount) && evidence.transferRouteLegCount > 0
      && Number.isSafeInteger(evidence.transferRouteLengthMm) && evidence.transferRouteLengthMm > 0,
    "Operational-v2.timetableRouteEvidence besitzt keine vollständige physische Tagesumlauf-/Transferabdeckung.",
  );
  invariant(
    evidence.realGeometry === true
      && evidence.simulatedOperationalAssignment === true
      && evidence.realInterlockingFactsClaimed === false
      && evidence.externalOperationalNetworkProvenance === false,
    "Operational-v2.timetableRouteEvidence verletzt die ehrliche Geometrie-/Provenienzgrenze.",
  );
}

function validateOperationalQuality(qualityReport, releaseId, timetableYear, infraRelease, qualitySha256) {
  exactKeys(qualityReport, ["schema", "releaseId", "timetableYear", "scopeId", "deterministic", "separation", "mapEvidence", "operationalModel", "summary", "qualityGate"], "Operational-v2-Qualitätsbericht");
  invariant(
    qualityReport.schema === OPERATIONAL_QUALITY_SCHEMA
      && qualityReport.releaseId === releaseId
      && qualityReport.timetableYear === timetableYear
      && qualityReport.scopeId === "deutschland-ebo-operational-v2"
      && qualityReport.deterministic === true,
    "Operational-v2-Qualitätsbericht verletzt Schema, Release, Jahr oder Scope.",
  );
  exactKeys(qualityReport.separation, ["mapEvidencePurpose", "operationalEvidencePurpose", "mapClassCReclassified", "mapClassCBlocksOperationalQualityGate", "mapObjectsRemoved"], "Operational-v2.separation");
  invariant(
    qualityReport.separation.mapEvidencePurpose === "visible-map-quality-evidence"
      && qualityReport.separation.operationalEvidencePurpose === "closed-operational-v2-model"
      && qualityReport.separation.mapClassCReclassified === false
      && qualityReport.separation.mapClassCBlocksOperationalQualityGate === false
      && qualityReport.separation.mapObjectsRemoved === false,
    "Operational-v2-Qualitätsbericht deklariert sichtbare Karten-C um oder entfernt Kartenobjekte.",
  );

  const map = qualityReport.mapEvidence;
  exactKeys(map, ["schema", "mapReleaseId", "infrastructureCorpusId", "bytes", "sha256", "sourceReport", "visibleFeatures", "visibleLayers", "qualityClassFeatureCount", "trackLengthMm", "trackQualityClassLengthMm"], "Operational-v2.mapEvidence");
  const mapClasses = qualityClasses(map.qualityClassFeatureCount, "Operational-v2.mapEvidence.qualityClassFeatureCount");
  const trackClasses = qualityClasses(map.trackQualityClassLengthMm, "Operational-v2.mapEvidence.trackQualityClassLengthMm");
  exactKeys(map.sourceReport, ["schema", "bytes", "sha256", "shipped"], "Operational-v2.mapEvidence.sourceReport");
  invariant(
    map.schema === STATIC_MAP_QUALITY_SCHEMA
      && typeof map.mapReleaseId === "string" && map.mapReleaseId !== ""
      && map.infrastructureCorpusId === releaseId
      && Number.isSafeInteger(map.bytes) && map.bytes > 0 && SHA256.test(map.sha256)
      && map.visibleLayers === QUALITY_LAYER_NAMES.length
      && Number.isSafeInteger(map.visibleFeatures) && map.visibleFeatures > 0
      && mapClasses.A + mapClasses.B + mapClasses.C === map.visibleFeatures
      && Number.isSafeInteger(map.trackLengthMm) && map.trackLengthMm > 0
      && trackClasses.A + trackClasses.B + trackClasses.C === map.trackLengthMm
      && map.sourceReport.schema === LEGACY_QUALITY_SCHEMA
      && Number.isSafeInteger(map.sourceReport.bytes) && map.sourceReport.bytes > 0
      && SHA256.test(map.sourceReport.sha256) && map.sourceReport.shipped === false,
    "Operational-v2.mapEvidence besitzt keine ehrliche sichtbare Static-Map-v2-Bindung.",
  );

  const model = qualityReport.operationalModel;
  exactKeys(model, ["policyId", "policySha256", "closureReceiptSha256", "qualityClass", "provenance", "realGeometry", "simulatedOperationalAssignment", "realInterlockingFactsClaimed", "syntheticOperationalDetailsShipped", "objectLevelProvenanceShipped", "observedAndSyntheticObjectsShareRuntimeCollections", "movementRouteTemplates", "timetableRouteEvidence", "operationalArtifact", "coverage"], "Operational-v2.operationalModel");
  invariant(
    model.policyId === "synthetic-operational-b/v2" && SHA256.test(model.policySha256) && SHA256.test(model.closureReceiptSha256)
      && model.qualityClass === "B" && model.provenance === "derived"
      && model.realGeometry === true && model.simulatedOperationalAssignment === true
      && model.realInterlockingFactsClaimed === false && model.syntheticOperationalDetailsShipped === true
      && model.objectLevelProvenanceShipped === false && model.observedAndSyntheticObjectsShareRuntimeCollections === true,
    "Operational-v2.operationalModel besitzt keine ehrliche geschlossene Derived/B-Provenienz.",
  );
  validateTimetableRouteEvidence(model.timetableRouteEvidence);
  invariant(model.timetableRouteEvidence.policyId === model.policyId, "Operational-v2-Fahrwegbeleg und Betriebsmodell binden verschiedene Policies.");
  exactKeys(model.movementRouteTemplates, ["bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256"], "Operational-v2.movementRouteTemplates");
  invariant(
    Number.isSafeInteger(model.movementRouteTemplates.bytes) && model.movementRouteTemplates.bytes > 0
      && [model.movementRouteTemplates.sha256, model.movementRouteTemplates.stateHash, model.movementRouteTemplates.operationalStateHash, model.movementRouteTemplates.timetableTransferSetSha256].every((hash) => SHA256.test(hash))
      && model.movementRouteTemplates.sha256 !== model.movementRouteTemplates.stateHash,
    "Operational-v2.movementRouteTemplates besitzt keine getrennte pfadfreie Byte-/Zustandsbindung.",
  );
  exactKeys(model.operationalArtifact, ["bytes", "sha256", "stateHash"], "Operational-v2.operationalArtifact");
  invariant(Number.isSafeInteger(model.operationalArtifact.bytes) && model.operationalArtifact.bytes > 0 && SHA256.test(model.operationalArtifact.sha256) && SHA256.test(model.operationalArtifact.stateHash) && model.operationalArtifact.sha256 !== model.operationalArtifact.stateHash, "Operational-v2-Qualität besitzt keine getrennte Operational-Artefakt-/Zustandsbindung.");
  invariant(
    model.movementRouteTemplates.operationalStateHash === model.operationalArtifact.stateHash
      && model.movementRouteTemplates.timetableTransferSetSha256 === model.timetableRouteEvidence.transferSetSha256,
    "Operational-v2.movementRouteTemplates weicht von Operational-State oder Timetable-Transfer-Set ab.",
  );
  if (infraRelease !== undefined) {
    invariant(SHA256.test(qualitySha256), "Operational-v2-Qualität besitzt keine Byte-SHA-Bindung an den ausgelieferten Bericht.");
    const operationalBindings = infraRelease.artifacts?.filter(({ kind }) => kind === OPERATIONAL_INFRASTRUCTURE_KIND) ?? [];
    const movementBindings = infraRelease.artifacts?.filter(({ kind }) => kind === MOVEMENT_ROUTE_TEMPLATES_KIND) ?? [];
    const transferBindings = infraRelease.artifacts?.filter(({ kind }) => kind === TIMETABLE_TRANSFER_DEMANDS_KIND) ?? [];
    invariant(
      operationalBindings.length === 1
        && model.operationalArtifact.bytes === operationalBindings[0].bytes
        && model.operationalArtifact.sha256 === operationalBindings[0].sha256
        && model.operationalArtifact.stateHash === operationalBindings[0].stateHash,
      "Operational-v2-Qualität und InfraRelease binden verschiedene Operational-Artefaktbytes oder Zustände.",
    );
    invariant(
      movementBindings.length === 1
        && model.movementRouteTemplates.bytes === movementBindings[0].bytes
        && model.movementRouteTemplates.sha256 === movementBindings[0].sha256,
      "Operational-v2-Qualität und InfraRelease binden verschiedene Movement-Route-Templates-v2-Bytes.",
    );
    invariant(
      transferBindings.length === 1
        && model.timetableRouteEvidence.transferDemandsBytes === transferBindings[0].bytes
        && model.timetableRouteEvidence.transferDemandsSha256 === transferBindings[0].sha256,
      "Operational-v2-Qualität und InfraRelease binden verschiedene Timetable-Transfer-Demands-Bytes.",
    );
    const closure = infraRelease.quality?.operationalClosure;
    exactKeys(closure, [
      "reportSha256", "policyId", "policySha256", "closureReceiptSha256", "qualityClass", "provenance",
      "candidateBytes", "candidateSha256", "candidateStateHash", "staticMapQualityBytes", "staticMapQualitySha256",
      "staticMapSourceReportSha256", "realInterlockingFactsClaimed", "syntheticOperationalDetailsShipped",
      "objectLevelProvenanceShipped", "observedAndSyntheticObjectsShareRuntimeCollections", "timetableRouteEvidence",
      "movementRouteTemplates",
      "operationalQualityEligible", "signatureImplied", "activationImplied", "unresolvedRequired",
    ], "InfraRelease.quality.operationalClosure");
    invariant(
      closure.reportSha256 === qualitySha256
        && closure.policyId === model.policyId
        && closure.policySha256 === model.policySha256
        && closure.closureReceiptSha256 === model.closureReceiptSha256
        && closure.qualityClass === "B" && closure.provenance === "derived"
        && closure.candidateBytes === model.operationalArtifact.bytes
        && closure.candidateSha256 === model.operationalArtifact.sha256
        && closure.candidateStateHash === model.operationalArtifact.stateHash
        && closure.staticMapQualityBytes === map.bytes
        && closure.staticMapQualitySha256 === map.sha256
        && closure.staticMapSourceReportSha256 === map.sourceReport.sha256
        && closure.realInterlockingFactsClaimed === false
        && closure.syntheticOperationalDetailsShipped === true
        && closure.objectLevelProvenanceShipped === false
        && closure.observedAndSyntheticObjectsShareRuntimeCollections === true
        && JSON.stringify(sortedValue(closure.movementRouteTemplates)) === JSON.stringify(sortedValue(model.movementRouteTemplates))
        && JSON.stringify(sortedValue(closure.timetableRouteEvidence)) === JSON.stringify(sortedValue(model.timetableRouteEvidence))
        && closure.operationalQualityEligible === true
        && closure.signatureImplied === false && closure.activationImplied === false
        && closure.unresolvedRequired === 0,
      "Operational-v2-Qualitätsbericht weicht von der kanonischen Rust-InfraRelease-Closure-Bindung ab.",
    );
  }
  const coverageFields = ["blockResources", "directedEdges", "edgeGeometries", "interlockingRoutes", "platformIntervals", "regionBoundaries", "routeVersions", "rzueLayouts", "signals", "switches"];
  exactKeys(model.coverage, coverageFields, "Operational-v2.coverage");
  invariant(coverageFields.every((field) => Number.isSafeInteger(model.coverage[field]) && model.coverage[field] > 0) && model.coverage.directedEdges === model.coverage.edgeGeometries && model.coverage.rzueLayouts === 1, "Operational-v2.coverage ist nicht vollständig geschlossen.");

  exactKeys(qualityReport.summary, ["operationalQualityClassArtifactCount", "unresolvedRequired", "visibleMapClassCFeatureCount"], "Operational-v2.summary");
  const operationalClasses = qualityClasses(qualityReport.summary.operationalQualityClassArtifactCount, "Operational-v2.summary.operationalQualityClassArtifactCount");
  invariant(
    operationalClasses.A === 0 && operationalClasses.B === 1 && operationalClasses.C === 0
      && qualityReport.summary.unresolvedRequired === 0
      && qualityReport.summary.visibleMapClassCFeatureCount === mapClasses.C,
    "Operational-v2-Qualität besitzt keine getrennte geschlossene B=1/C=0-Bilanz oder verschweigt sichtbare Karten-C.",
  );
  exactKeys(qualityReport.qualityGate, ["closureReceiptVerified", "nativeOperationalValidationVerified", "operationalClassCZero", "ordinaryAssumptionsPromoted", "mapClassCReclassified", "operationalQualityEligible", "signatureImplied", "activationImplied"], "Operational-v2.qualityGate");
  invariant(
    qualityReport.qualityGate.closureReceiptVerified === true
      && qualityReport.qualityGate.nativeOperationalValidationVerified === true
      && qualityReport.qualityGate.operationalClassCZero === true
      && qualityReport.qualityGate.ordinaryAssumptionsPromoted === false
      && qualityReport.qualityGate.mapClassCReclassified === false
      && qualityReport.qualityGate.operationalQualityEligible === true
      && qualityReport.qualityGate.signatureImplied === false
      && qualityReport.qualityGate.activationImplied === false,
    "Operational-v2-Qualitätsgate ist offen, umklassifiziert Karten-C oder behauptet Signatur/Aktivierung.",
  );
  return { reportSchema: OPERATIONAL_QUALITY_SCHEMA, visibleLayers: map.visibleLayers, visibleFeatures: map.visibleFeatures, visibleMapClassCFeatureCount: mapClasses.C, operationalClassCArtifactCount: operationalClasses.C };
}

function validateQuality(qualityReport, releaseId, timetableYear, operationalV2, infraRelease, qualitySha256) {
  if (operationalV2) return validateOperationalQuality(qualityReport, releaseId, timetableYear, infraRelease, qualitySha256);
  invariant(qualityReport?.schema === LEGACY_QUALITY_SCHEMA && qualityReport.releaseId === releaseId, "Qualitätsbericht ist nicht an den Delivery-Release gebunden.");
  invariant(qualityReport.deterministic === true && qualityReport.policy?.classAFromSingleSourceOrAutomatedInference === false, "Qualitätsbericht besitzt keinen konservativen Nachweisvertrag.");
  invariant(qualityReport.policy?.nonPublicSourceRawDataShipped === false, "Qualitätsbericht erlaubt nichtöffentliche Rohdaten in der Auslieferung.");
  invariant(qualityReport.summary?.visibleLayers === 10 && Number.isSafeInteger(qualityReport.summary?.visibleFeatures) && qualityReport.summary.visibleFeatures > 0, "Qualitätsbericht besitzt keinen vollständigen sichtbaren Zehn-Layer-Korpus.");
  invariant(typeof qualityReport.policy?.classC === "string" && /not orderable/i.test(qualityReport.policy.classC), "Legacy-Delivery muss Klasse C ausdrücklich als nicht bestellbar kennzeichnen.");
  const classes = qualityClasses(qualityReport.summary.qualityClassFeatureCount, "Legacy-Qualität.summary.qualityClassFeatureCount");
  return { reportSchema: LEGACY_QUALITY_SCHEMA, visibleLayers: qualityReport.summary.visibleLayers, visibleFeatures: qualityReport.summary.visibleFeatures, visibleMapClassCFeatureCount: classes.C };
}

export function validateMapDeliveryQualityReport({ qualityReport, releaseId, timetableYear, operationalV2, infraRelease, qualitySha256 }) {
  return validateQuality(qualityReport, releaseId, timetableYear, operationalV2, infraRelease, qualitySha256);
}

function bindInfraReleaseArtifacts(infraRelease, packageSpec, trustedProofs) {
  if (packageSpec.schema !== PACKAGE_SPEC_V2) return;
  invariant(Array.isArray(infraRelease.artifacts), "InfraRelease besitzt kein gebundenes Artefaktinventar.");
  const required = [
    {
      kind: OPERATIONAL_INFRASTRUCTURE_KIND,
      file: "operational-infrastructure-v2.json",
      label: "Operational-v2-Paketdatei",
      bindingKeys: ["id", "kind", "file", "infraReleaseId", "bytes", "sha256", "stateHash"],
    },
    {
      kind: MOVEMENT_ROUTE_TEMPLATES_KIND,
      file: "operational-infrastructure-v2.movement-route-templates-v2.json",
      label: "Movement-Route-Templates-v2-Paketdatei",
      bindingKeys: ["id", "kind", "file", "bytes", "sha256"],
    },
    {
      kind: TIMETABLE_TRANSFER_DEMANDS_KIND,
      file: "timetable-routes-v2.transfer-demands-v2.json",
      label: "Timetable-Transfer-Demands-v2-Paketdatei",
      bindingKeys: ["id", "kind", "file", "bytes", "sha256"],
    },
  ];
  for (const requirement of required) {
    const descriptors = packageSpec.auxiliaryFiles.filter(({ kind }) => kind === requirement.kind);
    const bindings = infraRelease.artifacts.filter(({ kind }) => kind === requirement.kind);
    invariant(descriptors.length === 1 && bindings.length === 1, `Paket und InfraRelease müssen genau ein ${requirement.kind}-Artefakt binden.`);
    const descriptor = descriptors[0];
    const binding = bindings[0];
    exactKeys(binding, requirement.bindingKeys, `InfraRelease.artifacts.${requirement.kind}`);
    invariant(
      binding.id === descriptor.id
        && binding.kind === descriptor.kind
        && binding.file === requirement.file
        && descriptor.installPath === binding.file
        && descriptor.expectedBytes === binding.bytes
        && descriptor.expectedSha256 === binding.sha256
        && Number.isSafeInteger(binding.bytes)
        && binding.bytes > 0
        && SHA256.test(binding.sha256),
      `${requirement.label} weicht von der Bytebindung des InfraRelease ab.`,
    );
    if (requirement.kind === OPERATIONAL_INFRASTRUCTURE_KIND) {
      invariant(
        binding.infraReleaseId === infraRelease.releaseId
          && descriptor.infraReleaseId === binding.infraReleaseId
          && descriptor.stateHash === binding.stateHash
          && SHA256.test(binding.stateHash)
          && binding.sha256 !== binding.stateHash,
        "Operational-v2-Paketdatei weicht von der Zustandsbindung des InfraRelease ab.",
      );
    }
    invariant(!trustedProofs.has(binding.id), `InfraRelease-Artefaktbeleg ${binding.id} ist doppelt.`);
    trustedProofs.set(binding.id, { bytes: binding.bytes, sha256: binding.sha256 });
  }
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
  const source = await secureSourceRoot(sourceRoot);
  const operationalV2 = packageSpec.schema === PACKAGE_SPEC_V2;
  const infraMaterialization = materializedRelease(infraInput, "zugfolge-infra-release/v2", "InfraRelease", operationalV2);
  const mapMaterialization = materializedRelease(mapInput, "zugfolge-map-release/v1", "Kartenrelease", operationalV2);
  const infraRelease = infraMaterialization.release;
  const mapRelease = mapMaterialization.release;
  invariant(infraRelease.releaseId === releaseId && infraRelease.timetableYear === timetableYear, "InfraRelease passt nicht zum Delivery-Jahr.");
  invariant(
    !operationalV2 || mapRelease.releaseId === releaseId,
    "Kartenrelease und Delivery-v2 nennen verschiedene Release-IDs.",
  );
  const sources = buildMapDeliverySources({ releaseId, infraRelease, mapRelease });
  const sourcesBytes = serializeDeliveryJson(sources);

  const qualityDescriptor = packageSpec.auxiliaryFiles.find(({ kind }) => kind === "quality-manifest");
  invariant(qualityDescriptor !== undefined, "Paketvertrag besitzt keinen Qualitätsbericht.");
  const qualityArtifact = await readContainedFile(
    source,
    qualityDescriptor.sourceFile,
    `${qualityDescriptor.id}.sourceFile`,
    16 * 1024 * 1024,
  );
  const qualityBytes = qualityArtifact.bytes;
  const qualityReport = JSON.parse(qualityBytes.toString("utf8"));
  const qualitySummary = validateQuality(
    qualityReport,
    releaseId,
    timetableYear,
    operationalV2,
    infraRelease,
    qualityArtifact.sha256,
  );

  const trustedProofs = normalizeProofs(auxiliaryArtifactProofs);
  bindInfraReleaseArtifacts(infraRelease, packageSpec, trustedProofs);
  for (const [id, proof] of artifactProofsFromMapRelease(mapRelease, packageSpec)) {
    invariant(!trustedProofs.has(id), `Großartefaktbeleg ${id} darf keinen PMTiles-Beleg überschreiben.`);
    trustedProofs.set(id, proof);
  }
  const largeAuxiliaries = packageSpec.auxiliaryFiles.filter(({ kind }) => LARGE_AUXILIARY_KINDS.has(kind));
  invariant(
    largeAuxiliaries.every(({ id }) => trustedProofs.has(id)),
    "Große SQLite- und Operational-v2-Artefakte brauchen jeweils einen eigenen vorab geprüften Byte-SHA-Beleg.",
  );

  const inventoryDescriptors = [...packageSpec.artifacts, ...packageSpec.auxiliaryFiles]
    .filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const artifacts = [];
  for (const descriptor of inventoryDescriptors) {
    artifacts.push(await inventoryArtifact(descriptor, source, trustedProofs.get(descriptor.id)));
  }
  const inventoriedQuality = artifacts.find(({ id }) => id === qualityDescriptor.id);
  invariant(
    inventoriedQuality !== undefined
      && inventoriedQuality.bytes === qualityBytes.length
      && inventoriedQuality.sha256 === qualityArtifact.sha256,
    "Qualitaetsbericht aenderte sich zwischen Validierung und Inventarisierung.",
  );
  validateMapAssetNoticeBindings(sources.assetNotices, artifacts);
  invariant(trustedProofs.size === packageSpec.artifacts.length + largeAuxiliaries.length, "Großartefaktbelege enthalten eine unerwartete Datei.");

  const release = {
    schema: packageSpec.schema === PACKAGE_SPEC_V2 ? DELIVERY_SCHEMA_V2 : DELIVERY_SCHEMA_V1,
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
      packageManifestSchema: packageSpec.schema === PACKAGE_SPEC_V2 ? PACKAGE_SCHEMA_V2 : PACKAGE_SCHEMA_V1,
      infraReleaseSchema: infraRelease.schema,
      mapReleaseSchema: mapRelease.schema,
      sourcesSha256: sha256Bytes(sourcesBytes),
      qualitySha256: sha256Bytes(qualityBytes),
      ...(operationalV2 ? {
        infraReleaseHash: infraMaterialization.releaseHash,
        mapReleaseHash: mapMaterialization.releaseHash,
      } : {}),
    },
    approvalGates: {
      rights: {
        status: "passed",
        sourceManifestSchema: SOURCES_SCHEMA,
        sourceCount: sources.sources.length,
        assetGroupCount: sources.assetNotices.assets.length,
        assetFileCount: artifacts.filter(({ kind }) => ["glyph", "sprite"].includes(kind)).length,
      },
      quality: {
        status: "passed",
        reportSchema: qualitySummary.reportSchema,
        visibleLayers: qualitySummary.visibleLayers,
        visibleFeatures: qualitySummary.visibleFeatures,
        ...(operationalV2 ? {
          visibleMapClassCFeatureCount: qualitySummary.visibleMapClassCFeatureCount,
          operationalClassCArtifactCount: qualitySummary.operationalClassCArtifactCount,
        } : {}),
        classCOrderable: false,
      },
      signature: { status: "missing", reason: "Kein produktiver privater Signaturschlüssel vorhanden; Aktivierung bleibt gesperrt." },
    },
    releaseHash: null,
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

export async function writeSignedMapDeliveryRelease(release, outputPath) {
  const signature = Buffer.from(release?.signature?.valueBase64 ?? "", "base64");
  invariant(
    release?.approvalGates?.signature?.status === "passed"
      && release?.signature?.algorithm === "Ed25519"
      && release?.signature?.keyId === release?.approvalGates?.signature?.keyId
      && release?.releaseHash === deliveryReleaseHash(release)
      && signature.length === 64,
    "Signierter Delivery-Release besitzt keinen konsistenten Hash-/Signaturvertrag.",
  );
  return writeReproducible(resolve(outputPath), serializeDeliveryJson(release));
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
