import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { normalize as normalizePosix } from "node:path/posix";
import { setTimeout as delay } from "node:timers/promises";
import * as zlib from "node:zlib";

import { inspectPublicReadModel } from "./livemap-read-model.mjs";
import { validateMapAssetNoticeBindings, validateMapAssetNotices } from "./map-asset-notices.mjs";
import { validateStaticMapQuality } from "./static-map-quality.mjs";
import { inspectTrainMapProjection } from "./train-map-projection.mjs";
import { validateOperationalInfrastructureV2NativeReceipt } from "../region-import/materialize-operational-infrastructure-v2.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const PACKAGE_PLAN_V1 = "zugfolge-map-package-plan/v1";
const PACKAGE_PLAN_V2 = "zugfolge-map-package-plan/v2";
const STATIC_MAP_PACKAGE_PLAN_V2 = "zugfolge-static-map-package-plan/v2";
const PACKAGE_SPEC_V1 = "zugfolge-map-package-spec/v1";
const PACKAGE_SPEC_V2 = "zugfolge-map-package-spec/v2";
const STATIC_MAP_PACKAGE_SPEC_V2 = "zugfolge-static-map-package-spec/v2";
const PACKAGE_MANIFEST_V1 = "zugfolge-map-package/v1";
const PACKAGE_MANIFEST_V2 = "zugfolge-map-package/v2";
const STATIC_MAP_PACKAGE_MANIFEST_V2 = "zugfolge-static-map-package/v2";
const STATIC_MAP_RELEASE_SCHEMA_V2 = "zugfolge-static-map-release/v2";
const DELIVERY_RELEASE_SCHEMA_V2 = "zugfolge-map-delivery-release/v2";
const OPERATIONAL_INFRASTRUCTURE_KIND = "operational-infrastructure-v2";
export const OPERATIONAL_INFRASTRUCTURE_V2_VALIDATOR_ENV = "ZUGFOLGE_INFRA_RELEASE_VALIDATOR_PATH";
const SECRET_KEY = /(api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;
const SECRET_VALUE = /(?:api[_-]?key|authorization|credential|password|private[_-]?key|secret|token)\s*[=:]/i;
const APN_REFERENCE = /(?:^|[\s/_.-])apn(?:$|[\s/_.-])/i;
const INTERNAL_VALIDATION_SOURCE_NAME = /trassenfinder/i;
const PMTILES_MAGIC = Buffer.from("PMTiles", "ascii");
const PMTILES_HEADER_BYTES = 127;
const MAX_PMTILES_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_PMTILES_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_IN_MEMORY_PUBLIC_JSON_BYTES = 32 * 1024 * 1024;
const AUXILIARY_KINDS = new Set([
  "style", "glyph", "sprite", "release-manifest", "source-manifest", "quality-manifest",
  "read-model", "train-map-projection", OPERATIONAL_INFRASTRUCTURE_KIND,
]);
const PRIVATE_READ_MODEL_KEY = /(account(?:id)?|e-?mail|fixedcost|owneroperator|password|personnel|private|secret|token)/i;
const RAW_SECRET_KEY = /"(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)"\s*:/i;
const RAW_PRIVATE_READ_MODEL_KEY = /"(?:account(?:id)?|e-?mail|fixedcost|owneroperator|password|personnel|private|secret|token)"\s*:/i;
const RAW_INTERNAL_EVIDENCE_DETAIL_KEY = /"[^"]*(?:internal|evidence|ledger)[^"]*(?:hash|sha(?:256)?|name|source|[_-]ids?|ids?)"\s*:/i;
const KNOWN_SECRET_VALUE = /(?:\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\bBearer\s+[A-Za-z0-9._~-]{12,})/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SQLITE_SIGNATURE = Buffer.from("SQLite format 3\0", "binary");
const INTERNAL_EVIDENCE_DETAIL_KEY = /(?:internal|evidence|ledger).*(?:hash|sha(?:256)?|name|source|[_-]ids?|ids?$)/i;

export const BASEMAP_VECTOR_LAYERS = Object.freeze([
  "boundaries", "buildings", "earth", "landcover", "landuse", "places", "pois", "roads", "water",
]);
export const INFRASTRUCTURE_VECTOR_LAYERS = Object.freeze([
  "blocks", "conflict_resources", "operating_points", "platforms", "rail_context",
  "rail_corridors", "signals", "stations", "switches", "tracks",
]);

export const MAX_MAP_PACKAGE_PART_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAP_PACKAGE_PART_BYTES = 100 * 1024 * 1024;
export const BASEMAP_ATTRIBUTION = "© OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps; weitere Bearbeitung durch Zugfolge";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isMissing(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}

function validateId(value, label) {
  invariant(typeof value === "string" && SAFE_ID.test(value), `${label} ist keine sichere, stabile ID.`);
  invariant(!APN_REFERENCE.test(value), `${label} darf keine APN-Rohdaten referenzieren.`);
  return value;
}

export function validatePortableRelativePath(value, label = "Pfad") {
  invariant(typeof value === "string" && value.length > 0, `${label} fehlt.`);
  invariant(!value.includes("\\") && !value.includes("\0"), `${label} ist nicht portabel.`);
  invariant(!isAbsolute(value) && !value.startsWith("/") && !/^[a-z]:/i.test(value), `${label} muss relativ sein.`);
  invariant(!value.includes("://"), `${label} darf keine URL sein.`);
  invariant(normalizePosix(value) === value, `${label} ist nicht normalisiert.`);
  invariant(value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), `${label} enthält ein unsicheres Segment.`);
  invariant(!APN_REFERENCE.test(value), `${label} darf keine APN-Rohdaten referenzieren.`);
  return value;
}

function validateSameOriginRuntimePath(value, label) {
  invariant(typeof value === "string" && value.startsWith("/") && !value.startsWith("//"), `${label} muss ein absoluter Same-Origin-Pfad sein.`);
  invariant(!value.includes("\\") && !value.includes("\0") && !value.includes("://") && !/[?#]/.test(value), `${label} ist kein unveränderlicher Same-Origin-Pfad.`);
  invariant(!value.endsWith("/") && normalizePosix(value) === value, `${label} ist nicht normalisiert.`);
  invariant(value.slice(1).split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), `${label} enthält ein unsicheres Segment.`);
  invariant(!APN_REFERENCE.test(value), `${label} darf keine APN-Rohdaten referenzieren.`);
  return value;
}

function sortedUniqueStrings(values, label) {
  invariant(Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string" && SAFE_ID.test(value)), `${label} ist keine gültige Layerliste.`);
  const sorted = [...values].sort((left, right) => left.localeCompare(right, "en"));
  invariant(new Set(sorted).size === sorted.length, `${label} enthält doppelte Layer.`);
  return sorted;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isStaticMapPackageSchema(schema) {
  return [
    STATIC_MAP_PACKAGE_PLAN_V2,
    STATIC_MAP_PACKAGE_SPEC_V2,
    STATIC_MAP_PACKAGE_MANIFEST_V2,
  ].includes(schema);
}

function isMapRuntimeV2PackageSchema(schema) {
  return isStaticMapPackageSchema(schema) || [
    PACKAGE_PLAN_V2,
    PACKAGE_SPEC_V2,
    PACKAGE_MANIFEST_V2,
  ].includes(schema);
}

function isAssetNoticePackageSchema(schema) {
  return isStaticMapPackageSchema(schema) || [PACKAGE_SPEC_V2, PACKAGE_MANIFEST_V2].includes(schema);
}

function validateStaticMapClaims(claims, label = "claims") {
  invariant(claims !== null && typeof claims === "object" && !Array.isArray(claims), `${label} fehlt.`);
  invariant(
    Object.keys(claims).sort().join(",") === "operationalInfraRelease,productionActivationEligible,signatureStatus",
    `${label} muss den exakten fail-closed Kartenrelease-Vertrag tragen.`,
  );
  invariant(claims.operationalInfraRelease === false, `${label}.operationalInfraRelease muss false sein.`);
  invariant(claims.productionActivationEligible === false, `${label}.productionActivationEligible muss false sein.`);
  invariant(claims.signatureStatus === "unsigned", `${label}.signatureStatus muss unsigned sein.`);
  return claims;
}

function validateStaticMapCutover(cutover, label = "cutover") {
  invariant(cutover !== null && typeof cutover === "object" && !Array.isArray(cutover), `${label} fehlt.`);
  invariant(
    Object.keys(cutover).sort().join(",") === "javascriptOperationalFallback,legacyTrainMapProjection,trainPositionEstimates,waypointFallback",
    `${label} muss den exakten harten Karten-Cutover tragen.`,
  );
  invariant(Object.values(cutover).every((value) => value === false), `${label} muss Legacy-Projektion, Waypoints, Estimates und JavaScript-Fallback vollstaendig abschalten.`);
  return cutover;
}

function expectedLayersForKind(kind) {
  return kind === "basemap" ? BASEMAP_VECTOR_LAYERS : INFRASTRUCTURE_VECTOR_LAYERS;
}

function validateRuntimeContract(runtime, artifacts, auxiliaryFiles, packageSchema) {
  const expectedRuntimeSchema = isMapRuntimeV2PackageSchema(packageSchema) ? "zugfolge-map-runtime/v2" : "zugfolge-map-runtime/v1";
  invariant(runtime?.schema === expectedRuntimeSchema, `Kartenpaket ${packageSchema} braucht den Runtime-Pfadvertrag ${expectedRuntimeSchema}.`);
  validateSameOriginRuntimePath(runtime.publicBasePath, "runtime.publicBasePath");
  validateSameOriginRuntimePath(runtime.basemapStyleUrl, "runtime.basemapStyleUrl");
  validateSameOriginRuntimePath(runtime.infrastructurePmtilesUrl, "runtime.infrastructurePmtilesUrl");
  const style = auxiliaryFiles.find(({ kind }) => kind === "style");
  const infrastructure = artifacts.find(({ kind }) => kind === "infrastructure");
  invariant(style !== undefined && infrastructure !== undefined, "Runtime-Pfadvertrag kann Style oder Infrastruktur nicht zuordnen.");
  invariant(runtime.basemapStyleUrl === `${runtime.publicBasePath}/${style.installPath}`, "Runtime-Stylepfad stimmt nicht mit der gemeinsamen Installationswurzel überein.");
  invariant(runtime.infrastructurePmtilesUrl === `${runtime.publicBasePath}/${infrastructure.installPath}`, "Runtime-Infrastrukturpfad stimmt nicht mit der gemeinsamen Installationswurzel überein.");
  invariant(Object.keys(runtime).sort().join(",") === "basemapStyleUrl,infrastructurePmtilesUrl,publicBasePath,schema", "Runtime-Pfadvertrag enthält unerwartete Felder.");
  return runtime;
}

function resolveContained(root, portablePath, label) {
  validatePortableRelativePath(portablePath, label);
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, ...portablePath.split("/"));
  const remainder = relative(absoluteRoot, absolutePath);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlässt die Paketwurzel.`);
  return absolutePath;
}

function assertNoPrivateMetadata(value, path = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateMetadata(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      invariant(!SECRET_KEY.test(key), `${path}.${key} ist ein verbotenes Geheimnisfeld.`);
      assertNoPrivateMetadata(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    invariant(!APN_REFERENCE.test(value), `${path} darf keine APN-Rohdaten referenzieren.`);
    invariant(!INTERNAL_VALIDATION_SOURCE_NAME.test(value), `${path} darf keinen internen Validierungsquellennamen referenzieren.`);
    invariant(!SECRET_VALUE.test(value) && !/:\/\/[^/\s:@]+:[^/\s@]+@/.test(value), `${path} darf keine Zugangsdaten enthalten.`);
  }
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function assertNoPrivateReadModel(value, path = "readModel") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateReadModel(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      invariant(!PRIVATE_READ_MODEL_KEY.test(key), `${path}.${key} ist kein öffentliches ReadModel-Feld.`);
      assertNoPrivateReadModel(entry, `${path}.${key}`);
    }
  }
}

function assertNoInternalEvidenceDetails(value, path = "publicManifest") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInternalEvidenceDetails(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      invariant(!INTERNAL_EVIDENCE_DETAIL_KEY.test(key), `${path}.${key} darf keine interne Evidenzkennung oder deren Hash ausliefern.`);
      assertNoInternalEvidenceDetails(entry, `${path}.${key}`);
    }
  }
}

function assertNoZugfolgeV1Schemas(value, path = "publicManifest") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoZugfolgeV1Schemas(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "schema" && typeof entry === "string") {
        invariant(!/^zugfolge-[^"\s]+\/v1$/i.test(entry), `${path}.${key} darf in einem statischen Karten-v2-Paket kein Zugfolge-v1-Schema tragen.`);
      }
      assertNoZugfolgeV1Schemas(entry, `${path}.${key}`);
    }
  }
}

function validateStaticAuxiliaryJson(contract, descriptor, value) {
  if (auxiliaryMediaType(descriptor) !== "application/json") return;
  if (isStaticMapPackageSchema(contract.schema)) {
    invariant(value !== undefined, `${descriptor.id} ist fuer die vollstaendige Zugfolge-v1-Schemapruefung zu gross.`);
    assertNoZugfolgeV1Schemas(value, descriptor.id);
    if (descriptor.kind === "quality-manifest") validateStaticMapQuality(value, { releaseId: contract.releaseId });
  }
  if (descriptor.kind === "source-manifest") {
    if (isStaticMapPackageSchema(contract.schema)) {
      invariant(value?.schema === "zugfolge-static-map-sources/v3", `${descriptor.id} muss das oeffentliche Sources-v3-Manifest mit Asset-Notices sein.`);
      invariant(SHA256.test(value.assetInventoryPlanSha256), `${descriptor.id} besitzt keinen Cache-Inventarplan-SHA fuer die Assets.`);
      validateMapAssetNotices(value.assetNotices);
    } else if ([PACKAGE_SPEC_V2, PACKAGE_MANIFEST_V2].includes(contract.schema)) {
      invariant(value?.schema === "zugfolge-map-delivery-sources/v2", `${descriptor.id} muss das Delivery-Sources-v2-Manifest mit Asset-Notices sein.`);
      invariant(SHA256.test(value.assetInventoryPlanSha256), `${descriptor.id} besitzt keinen Cache-Inventarplan-SHA fuer die Assets.`);
      validateMapAssetNotices(value.assetNotices);
    }
  }
}

function validateStaticAssetBindings(contract, sources) {
  if (!isAssetNoticePackageSchema(contract.schema)) return;
  invariant(sources !== undefined, "Kartenpaket v2 besitzt kein lesbares Sources-Manifest mit Asset-Notices.");
  validateMapAssetNoticeBindings(sources.assetNotices, contract.auxiliaryFiles);
}

function auxiliaryMediaType(descriptor) {
  if (descriptor.kind === "glyph") return "application/x-protobuf";
  if (descriptor.kind === "sprite" && descriptor.installPath.endsWith(".png")) return "image/png";
  if (["read-model", "train-map-projection"].includes(descriptor.kind) && descriptor.installPath.endsWith(".sqlite")) return "application/vnd.sqlite3";
  return "application/json";
}

function validateAuxiliaryExtension(descriptor) {
  if (["style", "release-manifest", "source-manifest", "quality-manifest", OPERATIONAL_INFRASTRUCTURE_KIND].includes(descriptor.kind)) {
    invariant(descriptor.sourceFile.endsWith(".json") && descriptor.installPath.endsWith(".json"), `${descriptor.id} muss eine JSON-Datei sein.`);
    if (descriptor.kind === OPERATIONAL_INFRASTRUCTURE_KIND) {
      invariant(descriptor.installPath === "operational-infrastructure-v2.json", `${descriptor.id} muss als operational-infrastructure-v2.json in der Releasewurzel liegen.`);
      validateId(descriptor.infraReleaseId, `${descriptor.id}.infraReleaseId`);
      invariant(SHA256.test(descriptor.stateHash), `${descriptor.id} besitzt keinen kanonischen Operational-v2-Zustandshash.`);
    }
  } else if (descriptor.kind === "glyph") {
    invariant(descriptor.sourceFile.endsWith(".pbf") && descriptor.installPath.endsWith(".pbf"), `${descriptor.id} muss ein lokales PBF-Glyphenpaket sein.`);
  } else if (descriptor.kind === "sprite") {
    const sourceExtension = descriptor.sourceFile.endsWith(".png") ? ".png" : descriptor.sourceFile.endsWith(".json") ? ".json" : "";
    const installExtension = descriptor.installPath.endsWith(".png") ? ".png" : descriptor.installPath.endsWith(".json") ? ".json" : "";
    invariant(sourceExtension !== "" && sourceExtension === installExtension, `${descriptor.id} muss eine lokale Sprite-PNG- oder Sprite-JSON-Datei sein.`);
  } else if (descriptor.kind === "read-model") {
    invariant(
      descriptor.sourceFile.endsWith(".sqlite") && descriptor.installPath === "read-model.sqlite",
      `${descriptor.id} muss als öffentliches read-model.sqlite in der gemeinsamen Releasewurzel liegen.`,
    );
  } else if (descriptor.kind === "train-map-projection") {
    invariant(
      descriptor.sourceFile.endsWith(".sqlite") && descriptor.installPath === "train-map-projection.sqlite",
      `${descriptor.id} muss als eigenständige train-map-projection.sqlite in der gemeinsamen Releasewurzel liegen.`,
    );
  }
}

function validateAuxiliaryComposition(auxiliaryFiles, schema) {
  invariant(Array.isArray(auxiliaryFiles) && auxiliaryFiles.length >= 6, "Vollständiges Kartenpaket braucht Style, Glyphen, Sprites und öffentliche Manifeste.");
  const count = (kind) => auxiliaryFiles.filter((entry) => entry.kind === kind).length;
  for (const kind of ["style", "release-manifest", "source-manifest", "quality-manifest"]) {
    invariant(count(kind) === 1, `Kartenpaket braucht genau eine ${kind}-Datei.`);
  }
  invariant(count("glyph") >= 1, "Kartenpaket braucht mindestens eine lokale Glyphendatei.");
  invariant(auxiliaryFiles.some((entry) => entry.kind === "sprite" && entry.installPath.endsWith(".png")), "Kartenpaket braucht mindestens eine lokale Sprite-PNG-Datei.");
  invariant(auxiliaryFiles.some((entry) => entry.kind === "sprite" && entry.installPath.endsWith(".json")), "Kartenpaket braucht mindestens eine lokale Sprite-JSON-Datei.");
  invariant(count("read-model") === 1, "Vollständiges Kartenpaket braucht genau ein öffentliches ReadModel.");
  if ([PACKAGE_SPEC_V2, PACKAGE_MANIFEST_V2].includes(schema)) {
    invariant(count(OPERATIONAL_INFRASTRUCTURE_KIND) === 1, "Operational-v2-Kartenpaket braucht genau eine statische operational-infrastructure-v2.json.");
    invariant(count("train-map-projection") === 0, "Operational-v2-Kartenpaket darf keine weltgebundene Zugpositionsprojektion als Paketvoraussetzung führen.");
  } else if (isStaticMapPackageSchema(schema)) {
    invariant(count(OPERATIONAL_INFRASTRUCTURE_KIND) === 0, "Statischer Kartenrelease darf kein Operational-v2-Artefakt vortaeuschen.");
    invariant(count("train-map-projection") === 0, "Statischer Kartenrelease darf keine Legacy-Zugpositionsprojektion enthalten.");
  } else {
    invariant(count("train-map-projection") === 1, "Legacy-Kartenpaket braucht genau eine eigenständige Zugpositionsprojektion.");
    invariant(count(OPERATIONAL_INFRASTRUCTURE_KIND) === 0, "Statische Operational-v2-Infrastruktur verlangt den expliziten Paketvertrag v2.");
  }
}

function sqliteAuxiliaryKind(descriptor) {
  return ["read-model", "train-map-projection"].includes(descriptor.kind)
    && auxiliaryMediaType(descriptor) === "application/vnd.sqlite3";
}

async function inspectSqliteAuxiliary(path, descriptor) {
  if (descriptor.kind === "read-model") return inspectPublicReadModel(path);
  if (descriptor.kind === "train-map-projection") return inspectTrainMapProjection(path);
  throw new Error(`${descriptor.id} besitzt keinen SQLite-Schemavertrag.`);
}

function registerDescriptorPaths(descriptor, ids, installPaths, label) {
  validateId(descriptor.id, `${label}-ID`);
  invariant(!ids.has(descriptor.id), `${label}-ID ${descriptor.id} ist doppelt.`);
  ids.add(descriptor.id);
  validatePortableRelativePath(descriptor.installPath, `${descriptor.id}.installPath`);
  invariant(descriptor.installPath !== ".zugfolge-map-package.json", `${descriptor.id} verwendet einen reservierten Installationspfad.`);
  const portableKey = descriptor.installPath.toLowerCase();
  invariant(!installPaths.has(portableKey), `Installationspfad ${descriptor.installPath} ist doppelt oder kollidiert bei Groß-/Kleinschreibung.`);
  installPaths.add(portableKey);
}

function validateManifestParts(entry, manifest, partPaths, suffix, minimumBytes) {
  invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > minimumBytes, `${entry.id} hat keine gültige Bytezahl.`);
  invariant(SHA256.test(entry.sha256), `${entry.id} hat keinen SHA-256.`);
  invariant(Array.isArray(entry.parts) && entry.parts.length > 0, `${entry.id} hat keine Teile.`);
  let byteSum = 0;
  for (const [index, part] of entry.parts.entries()) {
    validatePortableRelativePath(part.path, `${entry.id}.parts[${index}].path`);
    invariant(part.path === `parts/${entry.id}${suffix}.part-${String(index + 1).padStart(5, "0")}`, `${entry.id} hat eine unerwartete Teilreihenfolge.`);
    invariant(!partPaths.has(part.path), `Paketpfad ${part.path} ist doppelt.`);
    partPaths.add(part.path);
    invariant(Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= manifest.partBytes && part.bytes < MAX_MAP_PACKAGE_PART_BYTES, `${part.path} hat eine ungültige Bytezahl.`);
    invariant(SHA256.test(part.sha256), `${part.path} hat keinen SHA-256.`);
    byteSum += part.bytes;
    invariant(Number.isSafeInteger(byteSum), `${entry.id} ist zu groß.`);
  }
  invariant(byteSum === entry.bytes, `${entry.id}: Summe der Teile stimmt nicht mit der Dateigröße überein.`);
}

export function serializeMapPackageManifest(manifest) {
  validateMapPackageManifest(manifest);
  return `${JSON.stringify(sortedValue(manifest), null, 2)}\n`;
}

export function validateMapPackageSpec(spec) {
  invariant([PACKAGE_SPEC_V1, PACKAGE_SPEC_V2, STATIC_MAP_PACKAGE_SPEC_V2].includes(spec?.schema), "Unbekanntes Kartenpaket-Schema.");
  assertNoPrivateMetadata(spec);
  const normalized = {
    ...spec,
    partBytes: spec.partBytes ?? DEFAULT_MAP_PACKAGE_PART_BYTES,
    artifacts: Array.isArray(spec.artifacts) ? spec.artifacts.map((artifact) => ({
      ...artifact,
      expectedVectorLayers: sortedUniqueStrings(artifact.expectedVectorLayers, `${artifact.id}.expectedVectorLayers`),
    })) : spec.artifacts,
  };
  validateId(normalized.packageId, "Paket-ID");
  validateId(normalized.version, "Paketversion");
  if (isStaticMapPackageSchema(normalized.schema)) {
    validateId(normalized.releaseId, "Kartenrelease-ID");
    validateStaticMapClaims(normalized.claims);
    validateStaticMapCutover(normalized.cutover);
  } else {
    invariant(normalized.releaseId === undefined && normalized.claims === undefined && normalized.cutover === undefined, "Infra-/Legacy-Paketvertraege duerfen keine statischen Kartenrelease-Claims einschleusen.");
  }
  invariant(Number.isSafeInteger(normalized.partBytes) && normalized.partBytes > 0 && normalized.partBytes < MAX_MAP_PACKAGE_PART_BYTES, "Teilgröße muss positiv und kleiner als 2 GiB sein.");
  invariant(Array.isArray(normalized.artifacts) && normalized.artifacts.length === 2, "Kartenpaket braucht genau zwei PMTiles-Artefakte.");
  validateAuxiliaryComposition(normalized.auxiliaryFiles, normalized.schema);

  const ids = new Set();
  const installPaths = new Set();
  const kinds = new Set();
  for (const artifact of normalized.artifacts) {
    registerDescriptorPaths(artifact, ids, installPaths, "Artefakt");
    invariant(["basemap", "infrastructure"].includes(artifact.kind), `Unbekannte Kartenart ${artifact.kind}.`);
    invariant(!kinds.has(artifact.kind), `Kartenart ${artifact.kind} ist doppelt.`);
    kinds.add(artifact.kind);
    validatePortableRelativePath(artifact.sourceFile, `${artifact.id}.sourceFile`);
    invariant(artifact.sourceFile.endsWith(".pmtiles"), `${artifact.id} muss aus einer finalen PMTiles-Datei gebaut werden.`);
    invariant(artifact.installPath.endsWith(".pmtiles"), `${artifact.id} muss als PMTiles-Datei installiert werden.`);
    if (artifact.expectedBytes !== undefined || artifact.expectedSha256 !== undefined) {
      invariant(Number.isSafeInteger(artifact.expectedBytes) && artifact.expectedBytes > PMTILES_HEADER_BYTES && SHA256.test(artifact.expectedSha256), `${artifact.id} besitzt keinen vollständigen erwarteten Byte-SHA-Beleg.`);
    }
    if (isStaticMapPackageSchema(normalized.schema)) {
      invariant(Number.isSafeInteger(artifact.expectedBytes) && artifact.expectedBytes > PMTILES_HEADER_BYTES && SHA256.test(artifact.expectedSha256), `${artifact.id} muss im statischen Kartenrelease bytegenau gepinnt sein.`);
    }
    invariant(sameStrings(artifact.expectedVectorLayers, expectedLayersForKind(artifact.kind)), `${artifact.id} muss exakt den festgelegten ${artifact.kind}-Layervertrag enthalten.`);
  }
  for (const auxiliary of normalized.auxiliaryFiles) {
    registerDescriptorPaths(auxiliary, ids, installPaths, "Hilfsdatei");
    invariant(AUXILIARY_KINDS.has(auxiliary.kind), `Unbekannte Hilfsdateiart ${auxiliary.kind}.`);
    invariant(auxiliary.visibility === "public", `${auxiliary.id} muss ausdrücklich öffentlich sein.`);
    validatePortableRelativePath(auxiliary.sourceFile, `${auxiliary.id}.sourceFile`);
    validateAuxiliaryExtension(auxiliary);
    if (auxiliary.expectedBytes !== undefined || auxiliary.expectedSha256 !== undefined) {
      invariant(Number.isSafeInteger(auxiliary.expectedBytes) && auxiliary.expectedBytes > 0 && SHA256.test(auxiliary.expectedSha256), `${auxiliary.id} besitzt keinen vollständigen erwarteten Byte-SHA-Beleg.`);
    }
    if (isStaticMapPackageSchema(normalized.schema) && [
      "style", "release-manifest", "source-manifest", "quality-manifest", "read-model",
    ].includes(auxiliary.kind)) {
      invariant(Number.isSafeInteger(auxiliary.expectedBytes) && auxiliary.expectedBytes > 0 && SHA256.test(auxiliary.expectedSha256), `${auxiliary.id} muss im statischen Kartenrelease bytegenau gepinnt sein.`);
    }
    if (auxiliary.kind === OPERATIONAL_INFRASTRUCTURE_KIND) {
      invariant(
        Number.isSafeInteger(auxiliary.expectedBytes) && auxiliary.expectedBytes > 0 && SHA256.test(auxiliary.expectedSha256),
        `${auxiliary.id} braucht den aus dem InfraRelease-Inventar abgeleiteten Byte-SHA-Beleg.`,
      );
    }
  }
  validateRuntimeContract(normalized.runtime, normalized.artifacts, normalized.auxiliaryFiles, normalized.schema);
  return normalized;
}

async function assertContainedDirectory(root, portablePath, label) {
  const absoluteRoot = resolve(root);
  let current = absoluteRoot;
  for (const segment of portablePath.split("/")) {
    current = join(current, segment);
    const metadata = await lstat(current);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
  }
  const metadata = await lstat(resolveContained(absoluteRoot, portablePath, label));
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} muss ein reguläres Verzeichnis sein.`);
}

async function resolveSourceRoots(sourceRootOrRoots) {
  const requestedRoots = Array.isArray(sourceRootOrRoots) ? sourceRootOrRoots : [sourceRootOrRoots];
  invariant(requestedRoots.length > 0, "Mindestens eine Kartenpaket-Quellwurzel ist erforderlich.");
  const roots = [];
  const seen = new Set();
  for (const [index, requestedRoot] of requestedRoots.entries()) {
    invariant(typeof requestedRoot === "string" && requestedRoot.length > 0, `Quellwurzel[${index}] fehlt.`);
    const requested = resolve(requestedRoot);
    const metadata = await lstat(requested);
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `Quellwurzel[${index}] muss ein reguläres Verzeichnis ohne symbolischen Link sein.`);
    const root = await realpath(requested);
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    invariant(!seen.has(key), `Quellwurzel[${index}] ist doppelt.`);
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

async function resolveUniqueSourceEntry(sourceRoots, portablePath, label, expectedKind) {
  validatePortableRelativePath(portablePath, label);
  const matches = [];
  for (const root of sourceRoots) {
    let current = root;
    let missing = false;
    const parts = portablePath.split("/");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let metadata;
      try {
        metadata = await lstat(current);
      } catch (error) {
        if (isMissing(error)) {
          missing = true;
          break;
        }
        throw error;
      }
      invariant(!metadata.isSymbolicLink(), `${label} darf in keiner Quellwurzel einen symbolischen Link enthalten.`);
      if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen nicht auflösbaren Zwischenpfad.`);
    }
    if (missing) continue;
    const actual = await realpath(current);
    const remainder = relative(root, actual);
    invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlässt seine Quellwurzel.`);
    const metadata = await lstat(actual);
    invariant(
      expectedKind === "file" ? metadata.isFile() : metadata.isDirectory(),
      `${label} muss ${expectedKind === "file" ? "eine reguläre Datei" : "ein reguläres Verzeichnis"} sein.`,
    );
    matches.push(actual);
  }
  invariant(matches.length > 0, `${label} fehlt in allen Quellwurzeln.`);
  invariant(matches.length === 1, `${label} ist in mehreren Quellwurzeln vorhanden und deshalb mehrdeutig.`);
  return matches[0];
}

async function inventoryAuxiliaryTree(sourceRoots, tree) {
  validateId(tree.idPrefix, "Hilfsbaum-ID-Präfix");
  invariant(["glyph", "sprite"].includes(tree.kind), `${tree.idPrefix} darf nur Glyphen oder Sprites inventarisieren.`);
  invariant(tree.visibility === "public", `${tree.idPrefix} muss ausdrücklich öffentlich sein.`);
  validatePortableRelativePath(tree.sourceDirectory, `${tree.idPrefix}.sourceDirectory`);
  validatePortableRelativePath(tree.installDirectory, `${tree.idPrefix}.installDirectory`);
  invariant(tree.expectedInventory !== null && typeof tree.expectedInventory === "object" && !Array.isArray(tree.expectedInventory), `${tree.idPrefix} braucht ein exaktes Verzeichnisinventar.`);
  const expectedInventory = new Map();
  for (const [entry, count] of Object.entries(tree.expectedInventory)) {
    invariant(entry !== "" && !entry.includes("/") && !entry.includes("\\") && entry !== "." && entry !== ".." && !APN_REFERENCE.test(entry), `${tree.idPrefix}.expectedInventory enthält einen unsicheren Eintrag.`);
    invariant(Number.isSafeInteger(count) && count > 0, `${tree.idPrefix}.expectedInventory.${entry} hat keine gültige Dateizahl.`);
    expectedInventory.set(entry, count);
  }
  invariant(expectedInventory.size > 0, `${tree.idPrefix}.expectedInventory ist leer.`);
  invariant(Object.keys(tree).sort().join(",") === "expectedInventory,idPrefix,installDirectory,kind,sourceDirectory,visibility", `${tree.idPrefix} enthält unerwartete Felder.`);
  const sourceDirectory = await resolveUniqueSourceEntry(
    sourceRoots,
    tree.sourceDirectory,
    `${tree.idPrefix}.sourceDirectory`,
    "directory",
  );
  const files = [];
  const observedInventory = new Map();

  async function walk(directory, portablePrefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const portablePath = portablePrefix === "" ? entry.name : `${portablePrefix}/${entry.name}`;
      validatePortableRelativePath(portablePath, `${tree.idPrefix}.Dateipfad`);
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      invariant(!metadata.isSymbolicLink(), `${tree.idPrefix}/${portablePath} darf kein symbolischer Link sein.`);
      if (metadata.isDirectory()) {
        await walk(absolutePath, portablePath);
        continue;
      }
      invariant(metadata.isFile(), `${tree.idPrefix}/${portablePath} ist keine reguläre Datei.`);
      const extension = extname(entry.name).toLowerCase();
      invariant(tree.kind === "glyph" ? extension === ".pbf" : [".json", ".png"].includes(extension), `${tree.idPrefix}/${portablePath} hat einen unerwarteten Dateityp.`);
      const topLevelEntry = portablePath.split("/")[0];
      observedInventory.set(topLevelEntry, (observedInventory.get(topLevelEntry) ?? 0) + 1);
      const digest = createHash("sha256").update(portablePath, "utf8").digest("hex").slice(0, 24);
      files.push({
        id: `${tree.idPrefix}-${digest}`,
        kind: tree.kind,
        visibility: "public",
        sourceFile: `${tree.sourceDirectory}/${portablePath}`,
        installPath: `${tree.installDirectory}/${portablePath}`,
      });
    }
  }
  await walk(sourceDirectory);
  invariant(files.length > 0, `${tree.idPrefix} enthält keine auslieferbare Datei.`);
  invariant(observedInventory.size === expectedInventory.size && [...expectedInventory].every(([entry, count]) => observedInventory.get(entry) === count), `${tree.idPrefix} weicht vom exakt erwarteten Verzeichnisinventar ab.`);
  return files;
}

export async function expandMapPackagePlan(plan, sourceRoot) {
  invariant([PACKAGE_PLAN_V1, PACKAGE_PLAN_V2, STATIC_MAP_PACKAGE_PLAN_V2].includes(plan?.schema), "Unbekanntes Kartenpaket-Plan-Schema.");
  assertNoPrivateMetadata(plan);
  invariant(Array.isArray(plan.auxiliaryFiles), "Kartenpaket-Plan braucht direkte Hilfsdateien.");
  invariant(Array.isArray(plan.auxiliaryTrees) && plan.auxiliaryTrees.length > 0, "Kartenpaket-Plan braucht lokale Glyphen-/Sprite-Verzeichnisse.");
  const resolvedSourceRoots = await resolveSourceRoots(sourceRoot);
  const expandedTrees = [];
  for (const tree of [...plan.auxiliaryTrees].sort((left, right) => String(left.idPrefix).localeCompare(String(right.idPrefix), "en"))) {
    expandedTrees.push(...await inventoryAuxiliaryTree(resolvedSourceRoots, tree));
  }
  const directAuxiliaryFiles = [];
  for (const descriptor of plan.auxiliaryFiles) {
    if (descriptor?.kind !== OPERATIONAL_INFRASTRUCTURE_KIND) {
      directAuxiliaryFiles.push(descriptor);
      continue;
    }
    invariant(plan.schema === PACKAGE_PLAN_V2, "Statische Operational-v2-Infrastruktur verlangt den Paketplan v2.");
    const { artifactInventory, ...portableDescriptor } = descriptor;
    validatePortableRelativePath(artifactInventory, `${descriptor.id}.artifactInventory`);
    const inventoryPath = await resolveUniqueSourceEntry(
      resolvedSourceRoots,
      artifactInventory,
      `${descriptor.id}.artifactInventory`,
      "file",
    );
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    invariant(inventory?.schema === "zugfolge-infra-release-artifacts/v2" && Array.isArray(inventory.artifacts), `${descriptor.id} bindet kein Operational-v2-Artefaktinventar.`);
    const bindings = inventory.artifacts.filter((entry) => entry?.kind === OPERATIONAL_INFRASTRUCTURE_KIND);
    invariant(bindings.length === 1, "InfraRelease-Artefaktinventar muss genau eine statische Operational-v2-Infrastruktur enthalten.");
    const binding = bindings[0];
    invariant(binding.id === descriptor.id && binding.file === "operational-infrastructure-v2.json", `${descriptor.id} weicht vom Operational-v2-Inventar ab.`);
    invariant(typeof binding.infraReleaseId === "string" && Number.isSafeInteger(binding.bytes) && binding.bytes > 0 && SHA256.test(binding.sha256) && SHA256.test(binding.stateHash) && binding.sha256 !== binding.stateHash, `${descriptor.id} besitzt keine vollständige Byte-/Zustandsbindung.`);
    directAuxiliaryFiles.push({
      ...portableDescriptor,
      infraReleaseId: binding.infraReleaseId,
      stateHash: binding.stateHash,
      expectedBytes: binding.bytes,
      expectedSha256: binding.sha256,
    });
  }
  const spec = {
    schema: plan.schema === PACKAGE_PLAN_V2
      ? PACKAGE_SPEC_V2
      : plan.schema === STATIC_MAP_PACKAGE_PLAN_V2
        ? STATIC_MAP_PACKAGE_SPEC_V2
        : PACKAGE_SPEC_V1,
    packageId: plan.packageId,
    version: plan.version,
    ...(plan.schema === STATIC_MAP_PACKAGE_PLAN_V2 ? { releaseId: plan.releaseId, claims: plan.claims, cutover: plan.cutover } : {}),
    ...(plan.partBytes === undefined ? {} : { partBytes: plan.partBytes }),
    runtime: plan.runtime,
    artifacts: plan.artifacts,
    auxiliaryFiles: [...directAuxiliaryFiles, ...expandedTrees],
  };
  return validateMapPackageSpec(spec);
}

export function validateMapPackageManifest(manifest) {
  invariant([PACKAGE_MANIFEST_V1, PACKAGE_MANIFEST_V2, STATIC_MAP_PACKAGE_MANIFEST_V2].includes(manifest?.schema), "Unbekanntes Kartenpaket-Manifest.");
  assertNoPrivateMetadata(manifest);
  validateId(manifest.packageId, "Paket-ID");
  validateId(manifest.version, "Paketversion");
  if (isStaticMapPackageSchema(manifest.schema)) {
    validateId(manifest.releaseId, "Kartenrelease-ID");
    validateStaticMapClaims(manifest.claims);
    validateStaticMapCutover(manifest.cutover);
  } else {
    invariant(manifest.releaseId === undefined && manifest.claims === undefined && manifest.cutover === undefined, "Infra-/Legacy-Paketmanifeste duerfen keine statischen Kartenrelease-Claims einschleusen.");
  }
  invariant(manifest.format === "directory-parts", "Unbekanntes Kartenpaket-Format.");
  invariant(Number.isSafeInteger(manifest.partBytes) && manifest.partBytes > 0 && manifest.partBytes < MAX_MAP_PACKAGE_PART_BYTES, "Ungültige Teilgröße im Manifest.");
  invariant(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 2, "Kartenpaket-Manifest braucht genau zwei PMTiles-Artefakte.");
  validateAuxiliaryComposition(manifest.auxiliaryFiles, manifest.schema);

  const descriptorIds = new Set();
  const installPaths = new Set();
  const partPaths = new Set();
  const kinds = new Set();
  let previousArtifactId = "";
  for (const artifact of manifest.artifacts) {
    invariant(artifact.id.localeCompare(previousArtifactId, "en") > 0, "Artefakte müssen stabil nach ID sortiert sein.");
    previousArtifactId = artifact.id;
    registerDescriptorPaths(artifact, descriptorIds, installPaths, "Artefakt");
    invariant(["basemap", "infrastructure"].includes(artifact.kind), `Unbekannte Kartenart ${artifact.kind}.`);
    invariant(!kinds.has(artifact.kind), `Kartenart ${artifact.kind} ist doppelt.`);
    kinds.add(artifact.kind);
    invariant(artifact.installPath.endsWith(".pmtiles"), `${artifact.id} hat keinen PMTiles-Installationspfad.`);
    const vectorLayers = sortedUniqueStrings(artifact.vectorLayers, `${artifact.id}.vectorLayers`);
    invariant(sameStrings(vectorLayers, artifact.vectorLayers), `${artifact.id}.vectorLayers muss stabil sortiert sein.`);
    invariant(sameStrings(vectorLayers, expectedLayersForKind(artifact.kind)), `${artifact.id} verletzt den festen ${artifact.kind}-Layervertrag.`);
    invariant(Number.isInteger(artifact.minZoom) && Number.isInteger(artifact.maxZoom) && artifact.minZoom >= 0 && artifact.maxZoom >= artifact.minZoom && artifact.maxZoom <= 30, `${artifact.id} hat keinen gültigen Zoombereich.`);
    validateManifestParts(artifact, manifest, partPaths, ".pmtiles", PMTILES_HEADER_BYTES);
  }
  let previousAuxiliaryId = "";
  for (const auxiliary of manifest.auxiliaryFiles) {
    invariant(auxiliary.id.localeCompare(previousAuxiliaryId, "en") > 0, "Hilfsdateien müssen stabil nach ID sortiert sein.");
    previousAuxiliaryId = auxiliary.id;
    registerDescriptorPaths(auxiliary, descriptorIds, installPaths, "Hilfsdatei");
    invariant(AUXILIARY_KINDS.has(auxiliary.kind), `Unbekannte Hilfsdateiart ${auxiliary.kind}.`);
    invariant(auxiliary.visibility === "public", `${auxiliary.id} muss ausdrücklich öffentlich sein.`);
    invariant(auxiliary.mediaType === auxiliaryMediaType(auxiliary), `${auxiliary.id} hat einen unerwarteten Medientyp.`);
    validateAuxiliaryExtension({ ...auxiliary, sourceFile: auxiliary.installPath });
    validateManifestParts(auxiliary, manifest, partPaths, "", 0);
    if (auxiliary.kind === OPERATIONAL_INFRASTRUCTURE_KIND) {
      invariant(auxiliary.sha256 !== auxiliary.stateHash, `${auxiliary.id} setzt Byte- und Zustandshash unzulässig gleich.`);
    }
  }
  validateRuntimeContract(manifest.runtime, manifest.artifacts, manifest.auxiliaryFiles, manifest.schema);
  return manifest;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

export function createOperationalInfrastructureV2ExecutableVerifier(executablePath) {
  invariant(typeof executablePath === "string" && executablePath.trim() !== "", "Pfad zum nativen Operational-v2-Validator fehlt.");
  invariant(isAbsolute(executablePath.trim()), "Pfad zum nativen Operational-v2-Validator muss absolut sein.");
  const executable = resolve(executablePath.trim());
  return async (candidatePath, expectedReleaseId) => {
    await assertRegularFile(executable, "Nativer Operational-v2-Validator");
    const result = spawnSync(executable, [
      "validate-operational-infrastructure-v2",
      resolve(candidatePath),
      expectedReleaseId,
    ], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    if (result.error !== undefined) {
      throw new Error(`Nativer Operational-v2-Validator konnte nicht gestartet werden: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`Native Operational-v2-Dateipruefung fehlgeschlagen:\n${result.stderr}\n${result.stdout}`);
    }
    const line = result.stdout.trim().split(/\r?\n/u).at(-1);
    let receipt;
    try {
      receipt = JSON.parse(line);
    } catch {
      throw new Error("Nativer Operational-v2-Validator lieferte kein JSON-Receipt.");
    }
    return validateOperationalInfrastructureV2NativeReceipt(receipt, expectedReleaseId);
  };
}

function requireOperationalInfrastructureV2Verifier(schema, validateOperationalInfrastructure) {
  if ([PACKAGE_SPEC_V2, PACKAGE_MANIFEST_V2].includes(schema)) {
    invariant(
      typeof validateOperationalInfrastructure === "function",
      `Operational-v2-Kartenpakete verlangen einen nativen Dateiverifier; fuer die CLI muss ${OPERATIONAL_INFRASTRUCTURE_V2_VALIDATOR_ENV} auf das gebaute zugfolge-infra-release-Binary zeigen.`,
    );
  }
}

async function verifyOperationalInfrastructureV2File(path, binding, validateOperationalInfrastructure) {
  invariant(
    binding?.kind === OPERATIONAL_INFRASTRUCTURE_KIND
      && typeof binding.infraReleaseId === "string"
      && Number.isSafeInteger(binding.bytes)
      && SHA256.test(binding.sha256)
      && SHA256.test(binding.stateHash),
    "Operational-v2-Dateipruefung besitzt keine vollstaendige Release-, Byte- und Zustandsbindung.",
  );
  invariant(typeof validateOperationalInfrastructure === "function", "Nativer Operational-v2-Dateiverifier fehlt.");
  await assertRegularFile(path, binding.id);
  const before = await hashFile(path);
  const nativeReceipt = validateOperationalInfrastructureV2NativeReceipt(
    await validateOperationalInfrastructure(path, binding.infraReleaseId),
    binding.infraReleaseId,
  );
  const after = await hashFile(path);
  invariant(
    before.bytes === after.bytes && before.sha256 === after.sha256,
    `${binding.id} aenderte sich waehrend der nativen Operational-v2-Dateipruefung.`,
  );
  invariant(
    after.bytes === binding.bytes && after.sha256 === binding.sha256,
    `${binding.id} weicht waehrend der nativen Operational-v2-Dateipruefung von seiner Paketbindung ab.`,
  );
  invariant(
    nativeReceipt.sourceBytes === after.bytes && nativeReceipt.sourceSha256 === after.sha256,
    `${binding.id}: nativer Receipt ist nicht an die geprueften Quelldateibytes gebunden.`,
  );
  invariant(
    nativeReceipt.bytes === after.bytes && nativeReceipt.sha256 === after.sha256,
    `${binding.id}: Quelldatei entspricht nicht exakt den nativ kanonisierten Operational-v2-Bytes.`,
  );
  invariant(
    nativeReceipt.stateHash === binding.stateHash,
    `${binding.id}: nativer Operational-v2-Zustandshash weicht von der Releasebindung ab.`,
  );
  return nativeReceipt;
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} muss eine reguläre Datei sein.`);
  return metadata;
}

async function assertContainedRegularFile(root, portablePath, label) {
  const absoluteRoot = resolve(root);
  let current = absoluteRoot;
  for (const segment of portablePath.split("/")) {
    current = join(current, segment);
    const metadata = await lstat(current);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
  }
  return assertRegularFile(resolveContained(absoluteRoot, portablePath, label), label);
}

async function assertExactFileInventory(root, expectedPortableFiles, label) {
  const expected = new Set(expectedPortableFiles);
  const observed = new Set();
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const portablePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      invariant(!entry.isSymbolicLink(), `${label} enthält einen symbolischen Link: ${portablePath}.`);
      if (entry.isDirectory()) {
        invariant([...expected].some((path) => path.startsWith(`${portablePath}/`)), `${label} enthält ein unerwartetes Verzeichnis: ${portablePath}.`);
        await walk(join(directory, entry.name), portablePath);
      } else {
        invariant(entry.isFile() && expected.has(portablePath), `${label} enthält eine unerwartete Datei: ${portablePath}.`);
        observed.add(portablePath);
      }
    }
  }
  await walk(root);
  invariant(observed.size === expected.size && [...expected].every((path) => observed.has(path)), `${label} ist unvollständig.`);
}

function safeNumber(value, label) {
  invariant(typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), `${label} liegt außerhalb des sicheren Dateibereichs.`);
  return Number(value);
}

function parsePmtilesV3Header(buffer, fileBytes, label) {
  invariant(buffer.length === PMTILES_HEADER_BYTES, `${label}: PMTiles-v3-Header ist unvollständig.`);
  invariant(buffer.subarray(0, PMTILES_MAGIC.length).equals(PMTILES_MAGIC), `${label} ist keine PMTiles-Datei.`);
  invariant(buffer.readUInt8(7) === 3, `${label} verwendet nicht PMTiles v3.`);
  invariant(typeof fileBytes === "bigint" && fileBytes >= BigInt(PMTILES_HEADER_BYTES), `${label} ist zu klein.`);
  const header = {
    rootDirectoryOffset: buffer.readBigUInt64LE(8),
    rootDirectoryLength: buffer.readBigUInt64LE(16),
    jsonMetadataOffset: buffer.readBigUInt64LE(24),
    jsonMetadataLength: buffer.readBigUInt64LE(32),
    leafDirectoryOffset: buffer.readBigUInt64LE(40),
    leafDirectoryLength: buffer.readBigUInt64LE(48),
    tileDataOffset: buffer.readBigUInt64LE(56),
    tileDataLength: buffer.readBigUInt64LE(64),
    numAddressedTiles: buffer.readBigUInt64LE(72),
    numTileEntries: buffer.readBigUInt64LE(80),
    numTileContents: buffer.readBigUInt64LE(88),
    clustered: buffer.readUInt8(96),
    internalCompression: buffer.readUInt8(97),
    tileCompression: buffer.readUInt8(98),
    tileType: buffer.readUInt8(99),
    minZoom: buffer.readUInt8(100),
    maxZoom: buffer.readUInt8(101),
    minLonE7: buffer.readInt32LE(102),
    minLatE7: buffer.readInt32LE(106),
    maxLonE7: buffer.readInt32LE(110),
    maxLatE7: buffer.readInt32LE(114),
    centerZoom: buffer.readUInt8(118),
    centerLonE7: buffer.readInt32LE(119),
    centerLatE7: buffer.readInt32LE(123),
  };
  const ranges = [
    ["Wurzelverzeichnis", header.rootDirectoryOffset, header.rootDirectoryLength, true],
    ["JSON-Metadaten", header.jsonMetadataOffset, header.jsonMetadataLength, true],
    ["Blattverzeichnisse", header.leafDirectoryOffset, header.leafDirectoryLength, false],
    ["Kacheldaten", header.tileDataOffset, header.tileDataLength, true],
  ];
  for (const [rangeLabel, offset, length, required] of ranges) {
    invariant(!required || length > 0n, `${label}: ${rangeLabel} ist leer.`);
    if (length > 0n) {
      invariant(offset >= BigInt(PMTILES_HEADER_BYTES) && offset + length <= fileBytes, `${label}: ${rangeLabel} liegt außerhalb der Datei.`);
    }
  }
  const nonEmptyRanges = ranges.filter(([, , length]) => length > 0n);
  for (let leftIndex = 0; leftIndex < nonEmptyRanges.length; leftIndex += 1) {
    const [leftLabel, leftOffset, leftLength] = nonEmptyRanges[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < nonEmptyRanges.length; rightIndex += 1) {
      const [rightLabel, rightOffset, rightLength] = nonEmptyRanges[rightIndex];
      invariant(leftOffset + leftLength <= rightOffset || rightOffset + rightLength <= leftOffset, `${label}: ${leftLabel} und ${rightLabel} überlappen.`);
    }
  }
  invariant(header.rootDirectoryOffset + header.rootDirectoryLength <= 16_384n, `${label}: Wurzelverzeichnis liegt nicht vollständig in den ersten 16 KiB.`);
  invariant(header.jsonMetadataLength <= BigInt(MAX_PMTILES_METADATA_BYTES), `${label}: JSON-Metadaten sind komprimiert zu groß.`);
  invariant(header.clustered === 0 || header.clustered === 1, `${label}: ungültiges Cluster-Kennzeichen.`);
  invariant([1, 2, 3, 4].includes(header.internalCompression), `${label}: unbekannte interne Kompression.`);
  invariant([1, 2, 3, 4].includes(header.tileCompression), `${label}: unbekannte Kachelkompression.`);
  invariant([1, 6].includes(header.tileType), `${label}: Kartenpakete müssen MVT- oder MapLibre-Vektorkacheln enthalten.`);
  invariant(header.minZoom <= header.maxZoom && header.maxZoom <= 30, `${label}: ungültiger Zoombereich.`);
  invariant(header.centerZoom <= 30, `${label}: ungültiger Mittelpunkt-Zoom.`);
  invariant(header.minLonE7 >= -1_800_000_000 && header.maxLonE7 <= 1_800_000_000 && header.minLonE7 <= header.maxLonE7, `${label}: ungültige Längengrade.`);
  invariant(header.minLatE7 >= -900_000_000 && header.maxLatE7 <= 900_000_000 && header.minLatE7 <= header.maxLatE7, `${label}: ungültige Breitengrade.`);
  invariant(header.centerLonE7 >= header.minLonE7 && header.centerLonE7 <= header.maxLonE7, `${label}: Mittelpunkt liegt außerhalb der Längengrenzen.`);
  invariant(header.centerLatE7 >= header.minLatE7 && header.centerLatE7 <= header.maxLatE7, `${label}: Mittelpunkt liegt außerhalb der Breitengrenzen.`);
  return header;
}

function decompressPmtilesSection(buffer, compression, maximumBytes, label) {
  invariant(buffer.length <= maximumBytes, `${label} ist komprimiert zu groß.`);
  let output;
  try {
    if (compression === 1) output = buffer;
    else if (compression === 2) output = zlib.gunzipSync(buffer, { maxOutputLength: maximumBytes });
    else if (compression === 3) output = zlib.brotliDecompressSync(buffer, { maxOutputLength: maximumBytes });
    else if (compression === 4 && typeof zlib.zstdDecompressSync === "function") output = zlib.zstdDecompressSync(buffer, { maxOutputLength: maximumBytes });
    else throw new Error("nicht unterstützt");
  } catch (error) {
    throw new Error(`${label} kann nicht sicher dekomprimiert werden: ${error instanceof Error ? error.message : String(error)}.`);
  }
  invariant(output.length <= maximumBytes, `${label} ist dekomprimiert zu groß.`);
  return output;
}

function readVarint(buffer, state, label) {
  let value = 0n;
  let shift = 0n;
  while (state.offset < buffer.length) {
    const byte = buffer[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
    invariant(shift <= 63n, `${label} enthält einen zu großen Varint-Wert.`);
  }
  throw new Error(`${label} endet in einem unvollständigen Varint-Wert.`);
}

function parsePmtilesDirectory(buffer, label) {
  const state = { offset: 0 };
  const entryCount = safeNumber(readVarint(buffer, state, label), `${label}.entryCount`);
  invariant(entryCount > 0 && entryCount <= 1_000_000, `${label} hat eine unzulässige Eintragszahl.`);
  const entries = Array.from({ length: entryCount }, () => ({ tileId: 0n, runLength: 0n, length: 0n, offset: 0n }));
  let tileId = 0n;
  for (let index = 0; index < entryCount; index += 1) {
    const delta = readVarint(buffer, state, label);
    invariant(index === 0 || delta > 0n, `${label} enthält unsortierte oder doppelte Tile-IDs.`);
    tileId += delta;
    entries[index].tileId = tileId;
  }
  for (const entry of entries) entry.runLength = readVarint(buffer, state, label);
  for (const entry of entries) {
    entry.length = readVarint(buffer, state, label);
    invariant(entry.length > 0n, `${label} enthält einen leeren Verweiseintrag.`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const encodedOffset = readVarint(buffer, state, label);
    if (index > 0 && encodedOffset === 0n) {
      entries[index].offset = entries[index - 1].offset + entries[index - 1].length;
    } else {
      invariant(encodedOffset > 0n, `${label} enthält einen ungültigen ersten Offset.`);
      entries[index].offset = encodedOffset - 1n;
    }
  }
  invariant(state.offset === buffer.length, `${label} enthält unerwartete Restdaten.`);
  return entries;
}

async function inspectPmtiles(readRange, fileBytes, label) {
  invariant(typeof fileBytes === "bigint" && fileBytes >= BigInt(PMTILES_HEADER_BYTES), `${label}: PMTiles-v3-Header ist unvollständig.`);
  const headerBuffer = await readRange(0n, BigInt(PMTILES_HEADER_BYTES));
  const header = parsePmtilesV3Header(headerBuffer, fileBytes, label);
  const metadataCompressed = await readRange(header.jsonMetadataOffset, header.jsonMetadataLength);
  const metadataBuffer = decompressPmtilesSection(metadataCompressed, header.internalCompression, MAX_PMTILES_METADATA_BYTES, `${label}: JSON-Metadaten`);
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBuffer));
  } catch {
    throw new Error(`${label}: PMTiles-Metadaten sind kein gültiges UTF-8-JSON.`);
  }
  invariant(metadata !== null && typeof metadata === "object" && !Array.isArray(metadata), `${label}: PMTiles-Metadaten müssen ein Objekt sein.`);
  assertNoPrivateMetadata(metadata, `${label}.metadata`);
  assertNoInternalEvidenceDetails(metadata, `${label}.metadata`);
  invariant(Array.isArray(metadata.vector_layers) && metadata.vector_layers.length > 0, `${label}: PMTiles-Metadaten enthalten keine Vektorlayer.`);
  const layerIds = new Set();
  for (const layer of metadata.vector_layers) {
    invariant(layer !== null && typeof layer === "object" && typeof layer.id === "string" && layer.id.length > 0, `${label}: Vektorlayer ohne ID.`);
    invariant(!layerIds.has(layer.id), `${label}: doppelte Vektorlayer-ID ${layer.id}.`);
    layerIds.add(layer.id);
  }

  const rootCompressed = await readRange(header.rootDirectoryOffset, header.rootDirectoryLength);
  const rootBuffer = decompressPmtilesSection(rootCompressed, header.internalCompression, MAX_PMTILES_DIRECTORY_BYTES, `${label}: Wurzelverzeichnis`);
  const rootEntries = parsePmtilesDirectory(rootBuffer, `${label}: Wurzelverzeichnis`);
  const leafRanges = new Map();
  for (const entry of rootEntries) {
    const rangeLimit = entry.runLength === 0n ? header.leafDirectoryLength : header.tileDataLength;
    invariant(entry.offset + entry.length <= rangeLimit, `${label}: Wurzelverweis liegt außerhalb seines Datenbereichs.`);
    if (entry.runLength === 0n) leafRanges.set(`${entry.offset}:${entry.length}`, entry);
  }
  const sortedLeafRanges = [...leafRanges.values()].sort((left, right) => left.offset < right.offset ? -1 : left.offset > right.offset ? 1 : 0);
  let previousLeafEnd = 0n;
  for (const entry of sortedLeafRanges) {
    invariant(entry.offset >= previousLeafEnd, `${label}: Blattverzeichnisse überlappen.`);
    previousLeafEnd = entry.offset + entry.length;
    invariant(entry.length <= BigInt(MAX_PMTILES_DIRECTORY_BYTES), `${label}: Blattverzeichnis ist komprimiert zu groß.`);
    const compressed = await readRange(header.leafDirectoryOffset + entry.offset, entry.length);
    const directory = decompressPmtilesSection(compressed, header.internalCompression, MAX_PMTILES_DIRECTORY_BYTES, `${label}: Blattverzeichnis`);
    for (const leafEntry of parsePmtilesDirectory(directory, `${label}: Blattverzeichnis`)) {
      invariant(leafEntry.runLength > 0n, `${label}: Blattverzeichnis darf nicht auf ein weiteres Verzeichnis zeigen.`);
      invariant(leafEntry.offset + leafEntry.length <= header.tileDataLength, `${label}: Blattverweis liegt außerhalb der Kacheldaten.`);
    }
  }
  if (header.numTileEntries > 0n) {
    invariant(BigInt(rootEntries.filter((entry) => entry.runLength > 0n).length) <= header.numTileEntries, `${label}: Header zählt weniger Tile-Einträge als das Wurzelverzeichnis.`);
  }
  return { header, metadata, vectorLayerIds: [...layerIds].sort((left, right) => left.localeCompare(right, "en")) };
}

async function readFileRange(handle, start, length, label) {
  const byteLength = safeNumber(length, `${label}.length`);
  const position = safeNumber(start, `${label}.offset`);
  const buffer = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    invariant(bytesRead > 0, `${label} endet unerwartet.`);
    offset += bytesRead;
  }
  return buffer;
}

export async function inspectPmtilesFile(path, label = "PMTiles") {
  await assertRegularFile(path, label);
  const metadata = await stat(path, { bigint: true });
  const handle = await open(path, "r");
  try {
    return await inspectPmtiles((start, length) => readFileRange(handle, start, length, label), metadata.size, label);
  } finally {
    await handle.close();
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    invariant(bytesWritten > 0, "Kartenpaket konnte nicht vollständig geschrieben werden.");
    offset += bytesWritten;
  }
}

async function writeDurableFile(path, buffer) {
  const handle = await open(path, "wx");
  try {
    await writeAll(handle, buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicDirectoryRename(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const retryable = error !== null && typeof error === "object" && ["EACCES", "EBUSY", "EPERM"].includes(error.code);
      if (!retryable || attempt >= 5) throw error;
      await delay(25 * (2 ** attempt));
    }
  }
}

function assertNoExternalStyleUrls(value, allowedPmtilesUrl, path = "style") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoExternalStyleUrls(entry, allowedPmtilesUrl, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "attribution") continue;
      assertNoExternalStyleUrls(entry, allowedPmtilesUrl, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value)) {
    invariant(value === allowedPmtilesUrl, `${path} enthält eine externe oder nicht inventarisierte Runtimequelle.`);
  }
}

export function validateRuntimeStyle(style, contract) {
  invariant(style !== null && typeof style === "object" && !Array.isArray(style), "Runtime-Style muss ein JSON-Objekt sein.");
  invariant(style.version === 8 && Array.isArray(style.layers) && style.layers.length > 0, "Runtime-Style verletzt den MapLibre-v8-Vertrag.");
  const basemap = contract.artifacts.find(({ kind }) => kind === "basemap");
  const sources = style.sources;
  invariant(sources !== null && typeof sources === "object" && !Array.isArray(sources) && Object.keys(sources).length === 1 && sources.basemap !== undefined, "Runtime-Style muss genau die Basemapquelle `basemap` enthalten.");
  const expectedBasemapUrl = `pmtiles://${contract.runtime.publicBasePath}/${basemap.installPath}`;
  invariant(sources.basemap?.type === "vector" && sources.basemap.url === expectedBasemapUrl && sources.basemap.tiles === undefined, "Runtime-Style muss genau das selbst gehostete Basemap-PMTiles referenzieren.");
  invariant(sources.basemap.attribution === BASEMAP_ATTRIBUTION, "Basemap-Attribution muss exakt OpenStreetMap, Protomaps und die Zugfolge-Bearbeitung nennen.");
  for (const layer of style.layers) {
    invariant(layer !== null && typeof layer === "object" && typeof layer.id === "string", "Runtime-Style enthält einen ungültigen Layer.");
    invariant(layer.source === undefined || layer.source === "basemap", `Style-Layer ${layer.id} referenziert eine fremde oder doppelte Quelle.`);
    invariant(!INFRASTRUCTURE_VECTOR_LAYERS.includes(layer["source-layer"]), `Style-Layer ${layer.id} dupliziert einen semantischen Infrastruktur-Layer.`);
  }

  const glyphs = contract.auxiliaryFiles.filter(({ kind }) => kind === "glyph");
  invariant(typeof style.glyphs === "string" && style.glyphs.startsWith(`${contract.runtime.publicBasePath}/`) && style.glyphs.endsWith("/{fontstack}/{range}.pbf"), "Runtime-Style braucht eine lokale Glyphen-Vorlage.");
  const glyphPrefix = style.glyphs.slice(`${contract.runtime.publicBasePath}/`.length, -"/{fontstack}/{range}.pbf".length);
  invariant(glyphPrefix !== "" && glyphs.every(({ installPath }) => {
    const remainder = installPath.startsWith(`${glyphPrefix}/`) ? installPath.slice(glyphPrefix.length + 1) : "";
    const segments = remainder.split("/");
    return segments.length === 2 && segments[0] !== "" && /^\d+-\d+\.pbf$/.test(segments[1]);
  }), "Inventarisierte Glyphen stimmen nicht mit der Style-Vorlage überein.");

  invariant(typeof style.sprite === "string" && style.sprite.startsWith(`${contract.runtime.publicBasePath}/`), "Runtime-Style braucht ein lokales Sprite.");
  const spriteBase = style.sprite.slice(`${contract.runtime.publicBasePath}/`.length);
  const spritePaths = new Set(contract.auxiliaryFiles.filter(({ kind }) => kind === "sprite").map(({ installPath }) => installPath));
  const expectedSpritePaths = [`${spriteBase}.json`, `${spriteBase}.png`, `${spriteBase}@2x.json`, `${spriteBase}@2x.png`];
  invariant(spritePaths.size === expectedSpritePaths.length && expectedSpritePaths.every((path) => spritePaths.has(path)), "Sprite-Inventar und Style-Sprite stimmen nicht exakt überein.");
  assertNoExternalStyleUrls(style, expectedBasemapUrl);
  return style;
}

export function validatePublicMapPackageJson(value, label = "Oeffentliches Kartenartefakt") {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein JSON-Objekt sein.`);
  assertNoPrivateMetadata(value, label);
  assertNoInternalEvidenceDetails(value, label);
  return value;
}

export function validateStaticMapReleaseDocument(value, contract) {
  validatePublicMapPackageJson(value, "Statischer Kartenrelease");
  invariant(value.schema === STATIC_MAP_RELEASE_SCHEMA_V2, "Statischer Kartenrelease besitzt ein unbekanntes Schema.");
  invariant(value.releaseId === contract.releaseId, "Statischer Kartenrelease gehoert zu einer anderen Release-ID.");
  invariant(value.status === "unsigned", "Statischer Kartenrelease muss ausdruecklich unsigned bleiben.");
  invariant(
    JSON.stringify(sortedValue(value.claims)) === JSON.stringify(sortedValue(contract.claims)),
    "Statischer Kartenrelease und Paketmanifest tragen verschiedene Claims.",
  );
  validateStaticMapClaims(value.claims, "Statischer Kartenrelease.claims");
  validateStaticMapCutover(value.cutover, "Statischer Kartenrelease.cutover");
  invariant(JSON.stringify(sortedValue(value.cutover)) === JSON.stringify(sortedValue(contract.cutover)), "Statischer Kartenrelease und Paketmanifest tragen verschiedene Cutover-Vertraege.");
  invariant(Array.isArray(value.artifacts) && value.artifacts.length >= 6, "Statischer Kartenrelease besitzt kein vollstaendiges bytegenaues Artefaktinventar.");
  let previousId = "";
  const requiredKinds = new Set(["basemap", "infrastructure", "style", "read-model", "quality-manifest", "source-manifest"]);
  const observedKinds = new Set();
  for (const [index, artifact] of value.artifacts.entries()) {
    validateId(artifact?.id, `Statischer Kartenrelease.artifacts[${index}].id`);
    invariant(artifact.id.localeCompare(previousId, "en") > 0, "Statisches Kartenrelease-Inventar muss stabil nach ID sortiert sein.");
    invariant(typeof artifact.kind === "string" && requiredKinds.has(artifact.kind), `${artifact.id} besitzt eine unerwartete Kartenrelease-Art.`);
    invariant(!observedKinds.has(artifact.kind), `Statischer Kartenrelease enthaelt ${artifact.kind} doppelt.`);
    validatePortableRelativePath(artifact.installPath, `${artifact.id}.installPath`);
    invariant(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && SHA256.test(artifact.sha256), `${artifact.id} besitzt keinen Byte-SHA-Beleg.`);
    invariant(Object.keys(artifact).sort().join(",") === "bytes,id,installPath,kind,sha256", `${artifact.id} besitzt unerwartete Inventarfelder.`);
    previousId = artifact.id;
    observedKinds.add(artifact.kind);
  }
  invariant(observedKinds.size === requiredKinds.size && [...requiredKinds].every((kind) => observedKinds.has(kind)), "Statischer Kartenrelease bindet PMTiles, Style, ReadModel, Qualitaet und Quellen nicht vollstaendig.");
  invariant(
    Object.keys(value).sort().join(",") === "artifacts,claims,cutover,releaseId,schema,status",
    "Statischer Kartenrelease besitzt unerwartete Felder.",
  );
  return value;
}

function validateStaticMapReleaseBinding(contract, releaseDocument) {
  if (!isStaticMapPackageSchema(contract.schema)) return;
  validateStaticMapReleaseDocument(releaseDocument, contract);
  const packaged = [...contract.artifacts, ...contract.auxiliaryFiles]
    .filter(({ kind }) => ["basemap", "infrastructure", "style", "read-model", "quality-manifest", "source-manifest"].includes(kind))
    .map(({ id, kind, installPath, bytes, sha256, expectedBytes, expectedSha256 }) => ({
      id,
      kind,
      installPath,
      bytes: bytes ?? expectedBytes,
      sha256: sha256 ?? expectedSha256,
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(
    JSON.stringify(sortedValue(packaged)) === JSON.stringify(sortedValue(releaseDocument.artifacts)),
    "Statischer Kartenrelease weicht von den tatsaechlich gepackten Byte-SHA-Bindungen ab.",
  );
}

function validateDeliveryV2PackageBinding(contract, releaseDocument) {
  if (![PACKAGE_SPEC_V2, PACKAGE_MANIFEST_V2].includes(contract.schema)) return;
  invariant(releaseDocument?.schema === DELIVERY_RELEASE_SCHEMA_V2, "Integriertes Operational-v2-Paket braucht genau einen Delivery-v2-Releasevertrag.");
  invariant(
    releaseDocument.packageId === contract.packageId
      && releaseDocument.packageVersion === contract.version
      && releaseDocument.bindings?.packageManifestSchema === PACKAGE_MANIFEST_V2,
    "Delivery-v2 und integriertes Paket besitzen verschiedene Paketidentitaeten oder Schemas.",
  );
  const packaged = [...contract.artifacts, ...contract.auxiliaryFiles]
    .filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind))
    .map(({ id, kind, installPath, bytes, sha256, infraReleaseId, stateHash }) => ({
      id,
      kind,
      installPath,
      ...(kind === OPERATIONAL_INFRASTRUCTURE_KIND ? { infraReleaseId, stateHash } : {}),
      bytes,
      sha256,
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(
    JSON.stringify(sortedValue(packaged)) === JSON.stringify(sortedValue(releaseDocument.artifacts)),
    "Delivery-v2-Artefakte weichen vom tatsaechlich gepackten Operational-v2-Inventar ab.",
  );
  const sources = contract.auxiliaryFiles.filter(({ kind }) => kind === "source-manifest");
  const quality = contract.auxiliaryFiles.filter(({ kind }) => kind === "quality-manifest");
  const operational = contract.auxiliaryFiles.filter(({ kind }) => kind === OPERATIONAL_INFRASTRUCTURE_KIND);
  invariant(
    sources.length === 1
      && quality.length === 1
      && operational.length === 1
      && releaseDocument.bindings?.sourcesSha256 === sources[0].sha256
      && releaseDocument.bindings?.qualitySha256 === quality[0].sha256,
    "Delivery-v2 bindet nicht die tatsaechlich gepackten Sources-/Quality-Bytes.",
  );
  invariant(
    operational[0].infraReleaseId === releaseDocument.releaseId
      && SHA256.test(operational[0].stateHash)
      && SHA256.test(releaseDocument.bindings?.infraReleaseHash)
      && SHA256.test(releaseDocument.bindings?.mapReleaseHash),
    "Delivery-v2 bindet nicht denselben Operational-v2-Zustand oder keine Infra-/Kartenrelease-Hashes.",
  );
}

function createAuxiliaryContentValidator(descriptor) {
  const mediaType = auxiliaryMediaType(descriptor);
  const isJson = mediaType === "application/json";
  const decoder = isJson ? new TextDecoder("utf-8", { fatal: true }) : undefined;
  let totalBytes = 0;
  let prefix = Buffer.alloc(0);
  let collected = isJson ? [] : undefined;
  let collectedBytes = 0;
  let scanTail = "";
  let firstNonWhitespace = "";
  let lastNonWhitespace = "";
  let sawUnicodeEscape = false;

  function scanText(text) {
    const combined = `${scanTail}${text}`;
    invariant(!APN_REFERENCE.test(combined), `${descriptor.id} enthält eine APN-Rohreferenz.`);
    invariant(!INTERNAL_VALIDATION_SOURCE_NAME.test(combined), `${descriptor.id} enthält einen internen Validierungsquellennamen.`);
    invariant(!RAW_SECRET_KEY.test(combined) && !SECRET_VALUE.test(combined) && !KNOWN_SECRET_VALUE.test(combined), `${descriptor.id} enthält ein Geheimnis oder Zugangsdaten.`);
    invariant(!/:\/\/[^/\s:@]+:[^/\s@]+@/.test(combined), `${descriptor.id} enthält Zugangsdaten in einer URL.`);
    if (descriptor.kind === "read-model") {
      invariant(!RAW_PRIVATE_READ_MODEL_KEY.test(combined), `${descriptor.id} enthält kein rein öffentliches ReadModel.`);
    }
    if (["release-manifest", "source-manifest", "quality-manifest", "read-model", "train-map-projection", OPERATIONAL_INFRASTRUCTURE_KIND].includes(descriptor.kind)) {
      invariant(!RAW_INTERNAL_EVIDENCE_DETAIL_KEY.test(combined), `${descriptor.id} darf keine interne Evidenzkennung oder deren Hash ausliefern.`);
    }
    if (combined.includes("\\u") || combined.includes("\\U")) sawUnicodeEscape = true;
    for (const character of text) {
      if (!/\s/u.test(character)) {
        if (firstNonWhitespace === "") firstNonWhitespace = character;
        lastNonWhitespace = character;
      }
    }
    scanTail = combined.slice(-1024);
  }

  return {
    consume(chunk) {
      invariant(Buffer.isBuffer(chunk), `${descriptor.id} enthält einen ungültigen Datenblock.`);
      totalBytes += chunk.length;
      invariant(Number.isSafeInteger(totalBytes), `${descriptor.id} ist zu groß.`);
      const requiredPrefixBytes = mediaType === "application/vnd.sqlite3" ? SQLITE_SIGNATURE.length : PNG_SIGNATURE.length;
      if (prefix.length < requiredPrefixBytes) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, requiredPrefixBytes - prefix.length)]);
      }
      if (isJson) {
        if (collected !== undefined) {
          if (collectedBytes + chunk.length <= MAX_IN_MEMORY_PUBLIC_JSON_BYTES) {
            collected.push(Buffer.from(chunk));
            collectedBytes += chunk.length;
          } else {
            collected = undefined;
          }
        }
        let text;
        try {
          text = decoder.decode(chunk, { stream: true });
        } catch {
          throw new Error(`${descriptor.id} ist kein gültiges UTF-8.`);
        }
        scanText(text);
      }
    },
    finish() {
      invariant(totalBytes > 0, `${descriptor.id} ist leer.`);
      if (mediaType === "image/png") {
        invariant(prefix.length === PNG_SIGNATURE.length && prefix.equals(PNG_SIGNATURE), `${descriptor.id} ist keine PNG-Datei.`);
      }
      if (mediaType === "application/vnd.sqlite3") {
        invariant(prefix.length >= SQLITE_SIGNATURE.length && prefix.subarray(0, SQLITE_SIGNATURE.length).equals(SQLITE_SIGNATURE), `${descriptor.id} ist keine SQLite-Datei.`);
      }
      if (isJson) {
        let jsonValue;
        let ending;
        try {
          ending = decoder.decode();
        } catch {
          throw new Error(`${descriptor.id} ist kein gültiges UTF-8.`);
        }
        scanText(ending);
        invariant(["{", "["].includes(firstNonWhitespace) && ["}", "]"].includes(lastNonWhitespace), `${descriptor.id} ist kein vollständiger JSON-Container.`);
        if (collected !== undefined) {
          try {
            jsonValue = JSON.parse(Buffer.concat(collected, collectedBytes).toString("utf8"));
          } catch {
            throw new Error(`${descriptor.id} ist kein gültiges JSON.`);
          }
          assertNoPrivateMetadata(jsonValue, descriptor.id);
          if (["release-manifest", "source-manifest", "quality-manifest", "read-model", "train-map-projection", OPERATIONAL_INFRASTRUCTURE_KIND].includes(descriptor.kind)) {
            assertNoInternalEvidenceDetails(jsonValue, descriptor.id);
          }
          if (descriptor.kind === "read-model") assertNoPrivateReadModel(jsonValue, descriptor.id);
        } else {
          invariant(!sawUnicodeEscape, `${descriptor.id} ist für die große Streaming-Prüfung nicht kanonisch genug; Unicode-Escapes sind verboten.`);
        }
        return { bytes: totalBytes, mediaType, jsonValue };
      }
      return { bytes: totalBytes, mediaType };
    },
  };
}

async function splitPortableFile(sourcePath, temporaryPackageRoot, descriptor, partBytes, { pmtiles }) {
  await assertRegularFile(sourcePath, descriptor.id);
  const pmtilesInspection = pmtiles ? await inspectPmtilesFile(sourcePath, descriptor.id) : undefined;
  if (pmtiles) {
    invariant(sameStrings(pmtilesInspection.vectorLayerIds, descriptor.expectedVectorLayers), `${descriptor.id}: PMTiles-Vektorlayer stimmen nicht exakt mit dem Paketvertrag überein.`);
  }
  if (!pmtiles && sqliteAuxiliaryKind(descriptor)) {
    await inspectSqliteAuxiliary(sourcePath, descriptor);
  }
  const sourceMetadata = await stat(sourcePath);
  invariant(sourceMetadata.size > (pmtiles ? PMTILES_HEADER_BYTES : 0), `${descriptor.id} ist leer.`);

  const sourceHandle = await open(sourcePath, "r");
  const artifactHash = createHash("sha256");
  const contentValidator = pmtiles ? undefined : createAuxiliaryContentValidator(descriptor);
  const parts = [];
  let sourceOffset = 0;
  try {
    while (sourceOffset < sourceMetadata.size) {
      const partNumber = parts.length + 1;
      const partPath = `parts/${descriptor.id}${pmtiles ? ".pmtiles" : ""}.part-${String(partNumber).padStart(5, "0")}`;
      const outputPath = resolveContained(temporaryPackageRoot, partPath, "Paketteil");
      const outputHandle = await open(outputPath, "wx");
      const partHash = createHash("sha256");
      let currentPartBytes = 0;
      try {
        while (sourceOffset < sourceMetadata.size && currentPartBytes < partBytes) {
          const bytesToRead = Math.min(1024 * 1024, partBytes - currentPartBytes, sourceMetadata.size - sourceOffset);
          const buffer = Buffer.allocUnsafe(bytesToRead);
          const { bytesRead } = await sourceHandle.read(buffer, 0, bytesToRead, sourceOffset);
          invariant(bytesRead > 0, `${descriptor.id} endete unerwartet.`);
          const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
          await writeAll(outputHandle, chunk);
          contentValidator?.consume(chunk);
          artifactHash.update(chunk);
          partHash.update(chunk);
          sourceOffset += bytesRead;
          currentPartBytes += bytesRead;
        }
        await outputHandle.sync();
      } finally {
        await outputHandle.close();
      }
      parts.push({ path: partPath, bytes: currentPartBytes, sha256: partHash.digest("hex") });
    }
  } finally {
    await sourceHandle.close();
  }

  const validatedContent = contentValidator?.finish();

  const entry = {
    id: descriptor.id,
    kind: descriptor.kind,
    installPath: descriptor.installPath,
    ...(pmtiles ? {} : { visibility: "public", mediaType: validatedContent.mediaType }),
    ...(!pmtiles && descriptor.kind === OPERATIONAL_INFRASTRUCTURE_KIND
      ? { infraReleaseId: descriptor.infraReleaseId, stateHash: descriptor.stateHash }
      : {}),
    ...(pmtiles ? {
      vectorLayers: pmtilesInspection.vectorLayerIds,
      minZoom: pmtilesInspection.header.minZoom,
      maxZoom: pmtilesInspection.header.maxZoom,
    } : {}),
    bytes: sourceMetadata.size,
    sha256: artifactHash.digest("hex"),
    parts,
  };
  return { entry, validatedContent };
}

async function splitArtifact(sourcePath, temporaryPackageRoot, descriptor, partBytes) {
  const split = await splitPortableFile(sourcePath, temporaryPackageRoot, descriptor, partBytes, { pmtiles: true });
  if (descriptor.expectedBytes !== undefined || descriptor.expectedSha256 !== undefined) {
    invariant(split.entry.bytes === descriptor.expectedBytes && split.entry.sha256 === descriptor.expectedSha256, `${descriptor.id} weicht vom freigegebenen Byte-SHA-Beleg ab.`);
  }
  return split;
}

async function splitAuxiliaryFile(sourcePath, temporaryPackageRoot, descriptor, partBytes) {
  const split = await splitPortableFile(sourcePath, temporaryPackageRoot, descriptor, partBytes, { pmtiles: false });
  if (descriptor.expectedBytes !== undefined || descriptor.expectedSha256 !== undefined) {
    invariant(split.entry.bytes === descriptor.expectedBytes && split.entry.sha256 === descriptor.expectedSha256, `${descriptor.id} weicht vom freigegebenen Byte-SHA-Beleg ab.`);
  }
  return split;
}

function requireIntegratedV2PackPins(spec) {
  if (spec.schema !== PACKAGE_SPEC_V2) return;
  invariant(
    [...spec.artifacts, ...spec.auxiliaryFiles].every(({ expectedBytes, expectedSha256 }) => (
      Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && SHA256.test(expectedSha256)
    )),
    "Integriertes Operational-v2-Paket darf nur aus einem vollstaendig expandierten und bytegenau gepinnten Paketvertrag gebaut werden.",
  );
}

export async function packMapPackage(
  spec,
  sourceRoot,
  outputDirectory,
  { validateOperationalInfrastructure } = {},
) {
  const normalizedSpec = validateMapPackageSpec(spec);
  requireIntegratedV2PackPins(normalizedSpec);
  requireOperationalInfrastructureV2Verifier(normalizedSpec.schema, validateOperationalInfrastructure);
  const resolvedSourceRoots = await resolveSourceRoots(sourceRoot);
  const packageOutput = resolve(outputDirectory);
  try {
    await lstat(packageOutput);
    throw new Error(`Ausgabepfad existiert bereits: ${packageOutput}.`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const outputParent = dirname(packageOutput);
  await mkdir(outputParent, { recursive: true });
  const temporaryRoot = await mkdtemp(join(outputParent, `.${basename(packageOutput)}.tmp-`));
  let completed = false;
  try {
    await mkdir(join(temporaryRoot, "parts"), { recursive: false });
    const artifacts = [];
    for (const descriptor of [...normalizedSpec.artifacts].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
      const sourcePath = await resolveUniqueSourceEntry(
        resolvedSourceRoots,
        descriptor.sourceFile,
        `${descriptor.id}.sourceFile`,
        "file",
      );
      const split = await splitArtifact(sourcePath, temporaryRoot, descriptor, normalizedSpec.partBytes);
      artifacts.push(split.entry);
    }
    const auxiliaryFiles = [];
    let runtimeStyle;
    let staticReleaseDocument;
    let staticSourcesDocument;
    for (const descriptor of [...normalizedSpec.auxiliaryFiles].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
      const sourcePath = await resolveUniqueSourceEntry(
        resolvedSourceRoots,
        descriptor.sourceFile,
        `${descriptor.id}.sourceFile`,
        "file",
      );
      const split = await splitAuxiliaryFile(sourcePath, temporaryRoot, descriptor, normalizedSpec.partBytes);
      validateStaticAuxiliaryJson(normalizedSpec, descriptor, split.validatedContent.jsonValue);
      if (descriptor.kind === OPERATIONAL_INFRASTRUCTURE_KIND) {
        await verifyOperationalInfrastructureV2File(sourcePath, split.entry, validateOperationalInfrastructure);
      }
      auxiliaryFiles.push(split.entry);
      if (descriptor.kind === "style") runtimeStyle = split.validatedContent.jsonValue;
      if (descriptor.kind === "release-manifest") staticReleaseDocument = split.validatedContent.jsonValue;
      if (descriptor.kind === "source-manifest") staticSourcesDocument = split.validatedContent.jsonValue;
    }
    validateStaticAssetBindings({ ...normalizedSpec, auxiliaryFiles }, staticSourcesDocument);
    validateRuntimeStyle(runtimeStyle, normalizedSpec);
    validateStaticMapReleaseBinding({ ...normalizedSpec, artifacts, auxiliaryFiles }, staticReleaseDocument);
    validateDeliveryV2PackageBinding({ ...normalizedSpec, artifacts, auxiliaryFiles }, staticReleaseDocument);
    const manifest = {
      schema: normalizedSpec.schema === PACKAGE_SPEC_V2
        ? PACKAGE_MANIFEST_V2
        : normalizedSpec.schema === STATIC_MAP_PACKAGE_SPEC_V2
          ? STATIC_MAP_PACKAGE_MANIFEST_V2
          : PACKAGE_MANIFEST_V1,
      packageId: normalizedSpec.packageId,
      version: normalizedSpec.version,
      ...(normalizedSpec.schema === STATIC_MAP_PACKAGE_SPEC_V2
        ? { releaseId: normalizedSpec.releaseId, claims: normalizedSpec.claims, cutover: normalizedSpec.cutover }
        : {}),
      format: "directory-parts",
      partBytes: normalizedSpec.partBytes,
      runtime: normalizedSpec.runtime,
      artifacts,
      auxiliaryFiles,
    };
    const manifestText = serializeMapPackageManifest(manifest);
    const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
    await writeDurableFile(join(temporaryRoot, "manifest.json"), Buffer.from(manifestText, "utf8"));
    await writeDurableFile(join(temporaryRoot, "manifest.sha256"), Buffer.from(`${manifestSha256}  manifest.json\n`, "ascii"));
    await atomicDirectoryRename(temporaryRoot, packageOutput);
    completed = true;
    return { packageRoot: packageOutput, manifest, manifestSha256 };
  } finally {
    if (!completed) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readAndValidateManifest(packageRoot) {
  const requestedRoot = resolve(packageRoot);
  const rootMetadata = await lstat(requestedRoot);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Kartenpaketwurzel muss ein reguläres Verzeichnis sein.");
  const root = await realpath(requestedRoot);
  const manifestPath = resolveContained(root, "manifest.json", "Manifestpfad");
  const checksumPath = resolveContained(root, "manifest.sha256", "Manifest-Prüfsummenpfad");
  const [manifestMetadata, checksumMetadata] = await Promise.all([
    assertContainedRegularFile(root, "manifest.json", "manifest.json"),
    assertContainedRegularFile(root, "manifest.sha256", "manifest.sha256"),
  ]);
  invariant(manifestMetadata.size > 0 && manifestMetadata.size <= MAX_PACKAGE_MANIFEST_BYTES, "manifest.json hat eine unzulässige Größe.");
  invariant(checksumMetadata.size > 0 && checksumMetadata.size <= 256, "manifest.sha256 hat eine unzulässige Größe.");
  const [manifestBuffer, checksumText] = await Promise.all([readFile(manifestPath), readFile(checksumPath, "ascii")]);
  const expectedManifestSha256 = createHash("sha256").update(manifestBuffer).digest("hex");
  invariant(checksumText === `${expectedManifestSha256}  manifest.json\n`, "Manifest-Prüfsumme ist ungültig.");
  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString("utf8"));
  } catch {
    throw new Error("manifest.json ist kein gültiges JSON.");
  }
  validateMapPackageManifest(manifest);
  invariant(manifestBuffer.toString("utf8") === serializeMapPackageManifest(manifest), "manifest.json ist nicht kanonisch serialisiert.");
  return { root, manifest, manifestSha256: expectedManifestSha256 };
}

async function readArtifactRange(packageRoot, artifact, start, length) {
  invariant(start >= 0n && length >= 0n && start + length <= BigInt(artifact.bytes), `${artifact.id}: angeforderter PMTiles-Bereich liegt außerhalb des Artefakts.`);
  const output = Buffer.alloc(safeNumber(length, `${artifact.id}.rangeLength`));
  let partStart = 0n;
  let outputOffset = 0;
  for (const part of artifact.parts) {
    const partEnd = partStart + BigInt(part.bytes);
    const requestedEnd = start + length;
    const overlapStart = start > partStart ? start : partStart;
    const overlapEnd = requestedEnd < partEnd ? requestedEnd : partEnd;
    if (overlapStart < overlapEnd) {
      const partPath = resolveContained(packageRoot, part.path, "Paketteil");
      const metadata = await assertContainedRegularFile(packageRoot, part.path, part.path);
      invariant(metadata.size === part.bytes, `${part.path}: Bytezahl stimmt nicht.`);
      const handle = await open(partPath, "r");
      try {
        const chunk = await readFileRange(handle, overlapStart - partStart, overlapEnd - overlapStart, part.path);
        chunk.copy(output, outputOffset);
        outputOffset += chunk.length;
      } finally {
        await handle.close();
      }
    }
    partStart = partEnd;
  }
  invariant(outputOffset === output.length, `${artifact.id}: PMTiles-Bereich ist unvollständig.`);
  return output;
}

async function readAndValidatePackageLayout(packageRoot) {
  const result = await readAndValidateManifest(packageRoot);
  await assertExactFileInventory(result.root, [
    "manifest.json",
    "manifest.sha256",
    ...result.manifest.artifacts.flatMap((artifact) => artifact.parts.map((part) => part.path)),
    ...result.manifest.auxiliaryFiles.flatMap((auxiliary) => auxiliary.parts.map((part) => part.path)),
  ], "Kartenpaket");
  for (const artifact of result.manifest.artifacts) {
    const inspection = await inspectPmtiles(
      (start, length) => readArtifactRange(result.root, artifact, start, length),
      BigInt(artifact.bytes),
      artifact.id,
    );
    invariant(sameStrings(inspection.vectorLayerIds, artifact.vectorLayers), `${artifact.id}: PMTiles-Layer stimmen nicht mit dem Manifest überein.`);
    invariant(inspection.header.minZoom === artifact.minZoom && inspection.header.maxZoom === artifact.maxZoom, `${artifact.id}: PMTiles-Zoombereich stimmt nicht mit dem Manifest überein.`);
  }
  return result;
}

async function verifyPackagedFileParts(packageRoot, artifact, { auxiliary = false, materializePath } = {}) {
  const artifactHash = createHash("sha256");
  const contentValidator = auxiliary ? createAuxiliaryContentValidator(artifact) : undefined;
  const materialized = materializePath === undefined ? undefined : await open(materializePath, "wx");
  let artifactBytes = 0;
  try {
    for (const part of artifact.parts) {
      const partPath = resolveContained(packageRoot, part.path, "Paketteil");
      const metadata = await assertContainedRegularFile(packageRoot, part.path, part.path);
      invariant(metadata.size === part.bytes, `${part.path}: Bytezahl stimmt nicht.`);
      const partHash = createHash("sha256");
      let observedPartBytes = 0;
      for await (const chunk of createReadStream(partPath)) {
        if (materialized !== undefined) await writeAll(materialized, chunk);
        contentValidator?.consume(chunk);
        partHash.update(chunk);
        artifactHash.update(chunk);
        observedPartBytes += chunk.length;
        artifactBytes += chunk.length;
      }
      invariant(observedPartBytes === part.bytes && partHash.digest("hex") === part.sha256, `${part.path}: SHA-256 oder Bytezahl stimmt nicht.`);
    }
    invariant(artifactBytes === artifact.bytes, `${artifact.id}: Bytezahl stimmt nicht.`);
    invariant(artifactHash.digest("hex") === artifact.sha256, `${artifact.id}: Gesamt-SHA-256 stimmt nicht.`);
    const validated = contentValidator?.finish();
    if (materialized !== undefined) await materialized.sync();
    return validated;
  } finally {
    await materialized?.close();
  }
}

async function verifyMapPackageContents(packageRoot, validateOperationalInfrastructure, requireNativeOperationalValidation) {
  const result = await readAndValidatePackageLayout(packageRoot);
  if (requireNativeOperationalValidation) {
    requireOperationalInfrastructureV2Verifier(result.manifest.schema, validateOperationalInfrastructure);
  }
  for (const artifact of result.manifest.artifacts) {
    await verifyPackagedFileParts(result.root, artifact);
  }
  let runtimeStyle;
  let staticReleaseDocument;
  let staticSourcesDocument;
  const sqliteAuxiliaries = result.manifest.auxiliaryFiles.filter(sqliteAuxiliaryKind);
  const operationalAuxiliary = result.manifest.auxiliaryFiles.find(({ kind }) => kind === OPERATIONAL_INFRASTRUCTURE_KIND);
  const validateOperational = typeof validateOperationalInfrastructure === "function";
  const temporaryRoot = sqliteAuxiliaries.length === 0 && (!validateOperational || operationalAuxiliary === undefined)
    ? undefined
    : await mkdtemp(join(dirname(result.root), ".map-auxiliary-verifying-"));
  try {
    for (const auxiliary of result.manifest.auxiliaryFiles) {
      const materializePath = sqliteAuxiliaries.includes(auxiliary)
        ? join(temporaryRoot, `${auxiliary.id}.sqlite`)
        : auxiliary.kind === OPERATIONAL_INFRASTRUCTURE_KIND && validateOperational
          ? join(temporaryRoot, "operational-infrastructure-v2.json")
          : undefined;
      const validated = await verifyPackagedFileParts(result.root, auxiliary, { auxiliary: true, materializePath });
      validateStaticAuxiliaryJson(result.manifest, auxiliary, validated.jsonValue);
      const sqlitePath = sqliteAuxiliaries.includes(auxiliary) ? materializePath : undefined;
      if (sqlitePath !== undefined) await inspectSqliteAuxiliary(sqlitePath, auxiliary);
      if (auxiliary.kind === OPERATIONAL_INFRASTRUCTURE_KIND && validateOperational) {
        await verifyOperationalInfrastructureV2File(materializePath, auxiliary, validateOperationalInfrastructure);
      }
      if (auxiliary.kind === "style") runtimeStyle = validated.jsonValue;
      if (auxiliary.kind === "release-manifest") staticReleaseDocument = validated.jsonValue;
      if (auxiliary.kind === "source-manifest") staticSourcesDocument = validated.jsonValue;
    }
  } finally {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  }
  validateStaticAssetBindings(result.manifest, staticSourcesDocument);
  validateRuntimeStyle(runtimeStyle, result.manifest);
  validateStaticMapReleaseBinding(result.manifest, staticReleaseDocument);
  validateDeliveryV2PackageBinding(result.manifest, staticReleaseDocument);
  return result;
}

export async function verifyMapPackage(packageRoot, { validateOperationalInfrastructure } = {}) {
  return verifyMapPackageContents(packageRoot, validateOperationalInfrastructure, true);
}

/**
 * Vollstaendige asynchrone Transport-, Inventar- und Inhaltspruefung fuer den
 * Game-Stagingpfad. Die eine autoritative Operational-v2-Semantikpruefung
 * folgt dort separat ueber den gepinnten, begrenzten execFile-Adapter.
 */
export async function verifyMapPackageTransport(packageRoot) {
  return verifyMapPackageContents(packageRoot, undefined, false);
}

async function assemblePackagedFile(packageRoot, installTemporaryRoot, artifact, { auxiliary = false } = {}) {
  const destination = resolveContained(installTemporaryRoot, artifact.installPath, `${artifact.id}.installPath`);
  await mkdir(dirname(destination), { recursive: true });
  const handle = await open(destination, "wx");
  const hash = createHash("sha256");
  const contentValidator = auxiliary ? createAuxiliaryContentValidator(artifact) : undefined;
  let bytes = 0;
  try {
    for (const part of artifact.parts) {
      const partPath = resolveContained(packageRoot, part.path, "Paketteil");
      const metadata = await assertContainedRegularFile(packageRoot, part.path, part.path);
      invariant(metadata.size === part.bytes, `${part.path}: Bytezahl stimmt nicht.`);
      const partHash = createHash("sha256");
      let observedPartBytes = 0;
      for await (const chunk of createReadStream(partPath)) {
        await writeAll(handle, chunk);
        contentValidator?.consume(chunk);
        partHash.update(chunk);
        hash.update(chunk);
        observedPartBytes += chunk.length;
        bytes += chunk.length;
      }
      invariant(observedPartBytes === part.bytes && partHash.digest("hex") === part.sha256, `${part.path}: SHA-256 oder Bytezahl stimmt nicht.`);
    }
    invariant(bytes === artifact.bytes && hash.digest("hex") === artifact.sha256, `${artifact.id} konnte nicht korrekt zusammengesetzt werden.`);
    const validated = contentValidator?.finish();
    await handle.sync();
    return validated;
  } finally {
    await handle.close();
  }
}

async function verifyInstalledPackage(
  installRoot,
  manifest,
  manifestSha256,
  validateOperationalInfrastructure,
) {
  const root = await realpath(resolve(installRoot));
  const installedManifestPath = resolveContained(root, ".zugfolge-map-package.json", "Installiertes Manifest");
  const installedManifestMetadata = await assertContainedRegularFile(root, ".zugfolge-map-package.json", "Installiertes Manifest");
  invariant(installedManifestMetadata.size > 0 && installedManifestMetadata.size <= MAX_PACKAGE_MANIFEST_BYTES, "Installiertes Manifest hat eine unzulässige Größe.");
  const installedManifest = await readFile(installedManifestPath, "utf8");
  invariant(createHash("sha256").update(installedManifest).digest("hex") === manifestSha256, "Installiertes Kartenpaket gehört zu einer anderen Version.");
  invariant(installedManifest === serializeMapPackageManifest(manifest), "Installiertes Kartenpaket hat ein abweichendes Manifest.");
  await assertExactFileInventory(root, [
    ".zugfolge-map-package.json",
    ...manifest.artifacts.map((artifact) => artifact.installPath),
    ...manifest.auxiliaryFiles.map((auxiliary) => auxiliary.installPath),
  ], "Installiertes Kartenpaket");
  let staticReleaseDocument;
  let staticSourcesDocument;
  for (const artifact of [...manifest.artifacts, ...manifest.auxiliaryFiles]) {
    const artifactPath = resolveContained(root, artifact.installPath, `${artifact.id}.installPath`);
    await assertContainedRegularFile(root, artifact.installPath, artifact.installPath);
    const observed = await hashFile(artifactPath);
    invariant(observed.bytes === artifact.bytes && observed.sha256 === artifact.sha256, `Installiertes Artefakt ${artifact.id} ist beschädigt.`);
    if (sqliteAuxiliaryKind(artifact)) await inspectSqliteAuxiliary(artifactPath, artifact);
    if (artifact.kind === OPERATIONAL_INFRASTRUCTURE_KIND) {
      await verifyOperationalInfrastructureV2File(artifactPath, artifact, validateOperationalInfrastructure);
    }
    if (
      AUXILIARY_KINDS.has(artifact.kind)
        && auxiliaryMediaType(artifact) === "application/json"
        && (isStaticMapPackageSchema(manifest.schema) || ([PACKAGE_MANIFEST_V2].includes(manifest.schema) && ["release-manifest", "source-manifest"].includes(artifact.kind)))
    ) {
      const metadata = await lstat(artifactPath);
      invariant(metadata.size <= MAX_IN_MEMORY_PUBLIC_JSON_BYTES, `${artifact.id} ist fuer die vollstaendige Zugfolge-v1-Schemapruefung zu gross.`);
      let value;
      try {
        value = JSON.parse(await readFile(artifactPath, "utf8"));
      } catch {
        throw new Error(`${artifact.id} ist kein gueltiges JSON.`);
      }
      validateStaticAuxiliaryJson(manifest, artifact, value);
      if (artifact.kind === "release-manifest") staticReleaseDocument = value;
      if (artifact.kind === "source-manifest") staticSourcesDocument = value;
    }
  }
  validateStaticAssetBindings(manifest, staticSourcesDocument);
  validateDeliveryV2PackageBinding(manifest, staticReleaseDocument);
}

export async function installMapPackage(
  packageRoot,
  installDirectory,
  { validateOperationalInfrastructure } = {},
) {
  const verified = await readAndValidatePackageLayout(packageRoot);
  requireOperationalInfrastructureV2Verifier(verified.manifest.schema, validateOperationalInfrastructure);
  const destination = resolve(installDirectory);
  try {
    const destinationMetadata = await lstat(destination);
    invariant(destinationMetadata.isDirectory() && !destinationMetadata.isSymbolicLink(), "Installationsziel muss ein reguläres Verzeichnis sein.");
    await verifyInstalledPackage(
      destination,
      verified.manifest,
      verified.manifestSha256,
      validateOperationalInfrastructure,
    );
    return { status: "reused", installRoot: destination, manifest: verified.manifest };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const destinationParent = dirname(destination);
  await mkdir(destinationParent, { recursive: true });
  const parentRoot = await realpath(destinationParent);
  const temporaryRoot = await mkdtemp(join(parentRoot, `.${basename(destination)}.installing-`));
  let completed = false;
  try {
    for (const artifact of verified.manifest.artifacts) {
      await assemblePackagedFile(verified.root, temporaryRoot, artifact);
    }
    let runtimeStyle;
    let staticReleaseDocument;
    let staticSourcesDocument;
    for (const auxiliary of verified.manifest.auxiliaryFiles) {
      const validated = await assemblePackagedFile(verified.root, temporaryRoot, auxiliary, { auxiliary: true });
      validateStaticAuxiliaryJson(verified.manifest, auxiliary, validated.jsonValue);
      if (auxiliary.kind === "style") runtimeStyle = validated.jsonValue;
      if (auxiliary.kind === "release-manifest") staticReleaseDocument = validated.jsonValue;
      if (auxiliary.kind === "source-manifest") staticSourcesDocument = validated.jsonValue;
      if (sqliteAuxiliaryKind(auxiliary)) {
        await inspectSqliteAuxiliary(resolveContained(temporaryRoot, auxiliary.installPath, `${auxiliary.id}.installPath`), auxiliary);
      }
      if (auxiliary.kind === OPERATIONAL_INFRASTRUCTURE_KIND) {
        await verifyOperationalInfrastructureV2File(
          resolveContained(temporaryRoot, auxiliary.installPath, `${auxiliary.id}.installPath`),
          auxiliary,
          validateOperationalInfrastructure,
        );
      }
    }
    validateStaticAssetBindings(verified.manifest, staticSourcesDocument);
    validateRuntimeStyle(runtimeStyle, verified.manifest);
    validateStaticMapReleaseBinding(verified.manifest, staticReleaseDocument);
    validateDeliveryV2PackageBinding(verified.manifest, staticReleaseDocument);
    const manifestText = serializeMapPackageManifest(verified.manifest);
    await writeDurableFile(join(temporaryRoot, ".zugfolge-map-package.json"), Buffer.from(manifestText, "utf8"));
    await assertExactFileInventory(temporaryRoot, [
      ".zugfolge-map-package.json",
      ...verified.manifest.artifacts.map((artifact) => artifact.installPath),
      ...verified.manifest.auxiliaryFiles.map((auxiliary) => auxiliary.installPath),
    ], "Temporäre Karteninstallation");
    await atomicDirectoryRename(temporaryRoot, destination);
    completed = true;
    return { status: "installed", installRoot: destination, manifest: verified.manifest };
  } finally {
    if (!completed) await rm(temporaryRoot, { recursive: true, force: true });
  }
}
