import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { inspectPublicReadModel } from "./livemap-read-model.mjs";
import {
  deliveryReleaseHash,
  serializeDeliveryJson,
  verifyMapDeliveryReleaseSignature,
} from "./map-delivery-release.mjs";
import {
  serializeMapPackageManifest,
  validateMapPackageManifest,
} from "./map-package.mjs";
import { inspectTrainMapProjection } from "./train-map-projection.mjs";

const SPEC_SCHEMA = "zugfolge-map-release-build-evidence-spec/v1";
const EVIDENCE_SCHEMA = "zugfolge-map-release-build-evidence/v1";
const CACHE_INVENTORY_SCHEMA = "zugfolge-map-build-cache-inventory/v1";
const RESTORE_MARKER_SCHEMA = "zugfolge-map-build-cache-empty-root/v1";
const RESTORE_PROOF_SCHEMA = "zugfolge-map-build-cache-restore-proof/v1";
const ROLLBACK_ATTESTATION_SCHEMA = "zugfolge-map-rollback-attestation/v1";
const RUNTIME_ROLLBACK_ATTESTATION_SCHEMA = "zugfolge-map-rollback-attestation/v2";
const RUNTIME_ROLLBACK_TUPLE_SCHEMA = "zugfolge-runtime-rollback-tuple/v1";
const RESTORE_MARKER = ".zugfolge-empty-restore-root.json";
const INSTALLED_PACKAGE_MANIFEST = ".zugfolge-map-package.json";
const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MUTABLE_TOKEN = /(?:^|[./_:@-])(latest|unversioned|main|master|head)(?:$|[./_:@-])/i;
const RELEASE_ID = /^(?<family>[a-z0-9][a-z0-9._-]*-)(?<year>20\d{2})\.(?<patch>[1-9]\d*)$/;
const ACTIVATION_POINTER_KEYS = Object.freeze([
  "MAP_BASEMAP_STYLE_URL",
  "MAP_GERMANY_PMTILES_URL",
  "MAP_RELEASE_HOST_DIR",
  "MAP_RELEASE_ID",
]);
const INPUT_KINDS = new Set([
  "source-archive",
  "capture-manifest",
  "specification",
  "derived-input",
  "build-cache-inventory",
]);
const REQUIRED_INPUT_KINDS = Object.freeze([
  "source-archive",
  "capture-manifest",
  "specification",
  "build-cache-inventory",
]);
const OUTPUT_KINDS = Object.freeze([
  "basemap-pmtiles",
  "semantic-pmtiles",
  "read-model",
  "train-map-projection",
  "style",
  "delivery-manifest",
  "quality-report",
]);
const OUTPUT_TO_DELIVERY_KIND = Object.freeze({
  "basemap-pmtiles": "basemap",
  "semantic-pmtiles": "infrastructure",
  "read-model": "read-model",
  "train-map-projection": "train-map-projection",
  style: "style",
  "quality-report": "quality-manifest",
});
const ENCRYPTION_SCHEMES = new Set(["age-x25519", "gpg-aes256", "restic-repository-v2"]);
const SEMANTIC_LAYERS = Object.freeze([
  "rail_corridors",
  "operating_points",
  "stations",
  "tracks",
  "platforms",
  "switches",
  "signals",
  "blocks",
  "conflict_resources",
  "rail_context",
]);

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

export function serializeMapReleaseBuildEvidence(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeAlphaValue(value) {
  if (Array.isArray(value)) return value.map(decodeAlphaValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0][0] === "$bigint" && typeof entries[0][1] === "string" && /^(?:0|-?[1-9][0-9]*)$/.test(entries[0][1])) {
      return BigInt(entries[0][1]);
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, decodeAlphaValue(item)]));
  }
  return value;
}

function alphaCanonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
  if (typeof value === "number") {
    invariant(Number.isSafeInteger(value), "Alpha-Deployment enthaelt keine sichere Ganzzahl.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(alphaCanonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${alphaCanonical(item)}`).join(",")}}`;
  }
  throw new Error("Alpha-Deployment enthaelt einen nicht kanonisierbaren Wert.");
}

function alphaHash(schema, value) {
  return sha256Bytes(Buffer.from(alphaCanonical({ schema, value }), "utf8"));
}

function stableId(value, label) {
  invariant(typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(value), `${label} ist keine stabile ID.`);
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf weder latest noch unversioniert sein.`);
  return value;
}

function pinnedVersion(value, label) {
  invariant(typeof value === "string" && value.trim() === value && value.length > 0, `${label} besitzt keine gepinnte Version.`);
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf weder latest noch unversioniert sein.`);
  return value;
}

function encryptionScheme(value) {
  pinnedVersion(value, "buildCache.encryptionScheme");
  invariant(ENCRYPTION_SCHEMES.has(value), "Buildcache verwendet kein freigegebenes Verschlüsselungsverfahren.");
  return value;
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value.length > 0 && !isAbsolute(value), `${label} muss ein relativer Pfad sein.`);
  invariant(!value.includes("\\") && !value.includes("\0"), `${label} ist nicht portabel.`);
  const parts = value.split("/");
  invariant(parts.every((part) => part !== "" && part !== "." && part !== ".."), `${label} enthält einen unsicheren Pfadabschnitt.`);
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf weder latest noch unversioniert enthalten.`);
  return value;
}

function parseReleasePair(releaseId, previousReleaseId) {
  const candidate = RELEASE_ID.exec(releaseId);
  const previous = RELEASE_ID.exec(previousReleaseId);
  invariant(candidate !== null, "releaseId muss ein unveränderlicher Jahres-Patchrelease sein.");
  invariant(previous !== null, "previousReleaseId muss ein unveränderlicher Jahres-Patchrelease sein.");
  invariant(candidate.groups.family === previous.groups.family && candidate.groups.year === previous.groups.year, "Patch- und Vorgängerrelease gehören nicht zur selben Jahresfamilie.");
  invariant(Number(candidate.groups.patch) > Number(previous.groups.patch), "Patchrelease muss neuer als der Vorgänger sein.");
}

async function containedRealPath(root, relativePath, label) {
  const portable = portablePath(relativePath, label);
  const requestedRoot = resolve(root);
  const rootMetadata = await lstat(requestedRoot);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), `${label}: Wurzel ist kein reguläres Verzeichnis.`);
  const absoluteRoot = await realpath(requestedRoot);
  let path = absoluteRoot;
  const parts = portable.split("/");
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part);
    const metadata = await lstat(path);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
    if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen nicht auflösbaren Zwischenpfad.`);
  }
  const actual = await realpath(path);
  const remainder = relative(absoluteRoot, actual);
  invariant(remainder !== "" && !remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder), `${label} verlässt die Wurzel.`);
  return actual;
}

async function fileProof(root, descriptor, label) {
  const path = await containedRealPath(root, descriptor.file, `${label}.file`);
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${label} ist keine reguläre, nichtleere Datei.`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === metadata.size, `${label} änderte sich während der Hashbildung.`);
  const proof = { bytes, sha256: hash.digest("hex") };
  if (descriptor.expectedBytes !== undefined || descriptor.expectedSha256 !== undefined) {
    invariant(Number.isSafeInteger(descriptor.expectedBytes) && descriptor.expectedBytes > 0, `${label} besitzt keine erwartete Bytezahl.`);
    invariant(SHA256.test(descriptor.expectedSha256), `${label} besitzt keinen erwarteten SHA-256.`);
    invariant(proof.bytes === descriptor.expectedBytes && proof.sha256 === descriptor.expectedSha256, `${label} weicht vom gepinnten Byte-SHA-Beleg ab.`);
  }
  return proof;
}

function validateCommit(value, label) {
  invariant(GIT_COMMIT.test(value) && !/^0+$/.test(value), `${label} muss ein vollständiger Git-Commit sein.`);
  return value;
}

function validateOciTool(tool) {
  invariant(typeof tool.reference === "string" && !tool.reference.includes("://") && !/\s/.test(tool.reference), `Tool ${tool.id} besitzt keine OCI-Referenz.`);
  invariant(!MUTABLE_TOKEN.test(tool.reference), `Tool ${tool.id} verwendet latest oder eine unversionierte Referenz.`);
  const match = /@(?<digest>sha256:[a-f0-9]{64})$/.exec(tool.reference);
  invariant(match !== null && tool.reference.slice(0, match.index).includes("/"), `Tool ${tool.id} muss über einen vollständigen OCI-Digest gebunden sein.`);
  invariant(tool.digest === match.groups.digest, `Tool ${tool.id} nennt einen abweichenden OCI-Digest.`);
}

function validateCacheInventory(value, releaseId) {
  invariant(value?.schema === CACHE_INVENTORY_SCHEMA, "Buildcache-Inventar hat ein unbekanntes Schema.");
  invariant(value.releaseId === releaseId, "Buildcache-Inventar gehört zu einem anderen Release.");
  invariant(Array.isArray(value.files) && value.files.length > 0, "Buildcache-Inventar ist leer.");
  const files = value.files.map((entry, index) => {
    const path = portablePath(entry?.path, `buildCache.files[${index}].path`);
    invariant(path !== RESTORE_MARKER && !path.startsWith(".zugfolge-"), `Buildcache-Pfad ${path} ist reserviert.`);
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `Buildcache-Datei ${path} besitzt keinen Byte-SHA-Beleg.`);
    return { path, bytes: entry.bytes, sha256: entry.sha256 };
  });
  invariant(new Set(files.map(({ path }) => path)).size === files.length, "Buildcache-Inventar enthält doppelte Pfade.");
  invariant(JSON.stringify(files.map(({ path }) => path)) === JSON.stringify(files.map(({ path }) => path).sort()), "Buildcache-Inventar muss nach Pfad sortiert sein.");
  return files;
}

function inventoryEntry(inventory, cacheFile, label) {
  const entry = inventory.find(({ path }) => path === cacheFile);
  invariant(entry !== undefined, `${label} fehlt im wiederherstellbaren Buildcache-Inventar.`);
  return entry;
}

function validateSignedDeliveryContract(value, releaseId, label = "Delivery-Manifest") {
  invariant(value?.schema === "zugfolge-map-delivery-release/v1" && value.releaseId === releaseId, `${label} gehört nicht zum Buildrelease.`);
  invariant(value.approvalGates?.rights?.status === "passed" && value.approvalGates?.quality?.status === "passed", `${label} besitzt keine Rechte- und Qualitätsfreigabe.`);
  const gate = value.approvalGates?.signature;
  const signature = value.signature;
  invariant(gate?.status === "passed" && gate.algorithm === "Ed25519", `${label} besitzt keine signierte Delivery-Freigabe.`);
  const keyId = stableId(gate.keyId, `${label}.approvalGates.signature.keyId`);
  invariant(signature?.algorithm === "Ed25519" && signature.keyId === keyId, `${label} besitzt keine konsistente Ed25519-Signaturhülle.`);
  invariant(typeof signature.valueBase64 === "string", `${label} besitzt keine Ed25519-Signaturbytes.`);
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  invariant(signatureBytes.length === 64 && signatureBytes.toString("base64") === signature.valueBase64, `${label} besitzt keine kanonischen Ed25519-Signaturbytes.`);
  invariant(SHA256.test(value.releaseHash) && value.releaseHash === deliveryReleaseHash(value), `${label} besitzt keinen gültigen kanonischen Releasehash.`);
  return { keyId, releaseHash: value.releaseHash };
}

async function validateOutputShape(kind, path, releaseId, id) {
  if (["basemap-pmtiles", "semantic-pmtiles"].includes(kind)) {
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(7);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      invariant(bytesRead === header.length && header.toString("ascii") === "PMTiles", `${id} ist kein PMTiles-Artefakt.`);
    } finally {
      await handle.close();
    }
    return;
  }
  if (kind === "read-model") {
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      invariant(bytesRead === header.length && header.toString("binary") === "SQLite format 3\0", `${id} ist kein SQLite-Artefakt.`);
    } finally {
      await handle.close();
    }
    const inspected = await inspectPublicReadModel(path);
    invariant(inspected.infrastructureReleaseId === releaseId, `${id} ist nicht an den Buildrelease gebunden.`);
    return;
  }
  if (kind === "train-map-projection") {
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      invariant(bytesRead === header.length && header.toString("binary") === "SQLite format 3\0", `${id} ist kein SQLite-Artefakt.`);
    } finally {
      await handle.close();
    }
    const inspected = await inspectTrainMapProjection(path);
    invariant(inspected.infrastructureReleaseId === releaseId, `${id} ist nicht an den Buildrelease gebunden.`);
    const database = new DatabaseSync(path, { readOnly: true, allowExtension: false, defensive: true, timeout: 0 });
    try {
      const metadataRows = database.prepare("SELECT key, value FROM metadata ORDER BY key").all();
      const requiredKeys = [
        "corridors_sha256",
        "deployment_sha256",
        "infrastructure_release_id",
        "operational_network_sha256",
        "schema",
        "timetable_year",
        "tracks_sha256",
        "world_id",
      ];
      invariant(JSON.stringify(metadataRows.map(({ key }) => key)) === JSON.stringify(requiredKeys), `${id} besitzt keinen vollständigen Projektions-Metadatenvertrag.`);
      const metadata = Object.fromEntries(metadataRows.map(({ key, value }) => [key, value]));
      invariant(metadata.world_id === inspected.worldId && metadata.infrastructure_release_id === releaseId, `${id} verletzt seine Welt- oder Releasebindung.`);
      invariant(metadata.timetable_year === RELEASE_ID.exec(releaseId)?.groups.year, `${id} bindet ein falsches Fahrplanjahr.`);
      for (const key of ["corridors_sha256", "deployment_sha256", "operational_network_sha256", "tracks_sha256"]) {
        invariant(SHA256.test(metadata[key]), `${id} besitzt keinen gültigen ${key}-Beleg.`);
      }
      for (const table of Object.keys(inspected.tables).filter((table) => table !== "metadata")) {
        const foreign = database.prepare(`SELECT 1 AS found FROM ${table} WHERE world_id <> ? OR infrastructure_release_id <> ? LIMIT 1`)
          .get(inspected.worldId, releaseId);
        invariant(foreign === undefined, `${id} enthält Zeilen außerhalb seiner Welt- oder Releasebindung.`);
      }
    } finally {
      database.close();
    }
    return;
  }
  const metadata = await lstat(path);
  invariant(metadata.size <= 64 * 1024 * 1024, `${id} ist als JSON-Artefakt unerwartet groß.`);
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${id} ist kein gültiges JSON-Artefakt.`);
  }
  if (kind === "style") invariant(value?.version === 8, `${id} ist kein MapLibre-v8-Style.`);
  if (kind === "delivery-manifest") {
    validateSignedDeliveryContract(value, releaseId, id);
  }
  if (kind === "quality-report") {
    invariant(value?.schema === "zugfolge-final-infrastructure-quality-report/v1" && value.releaseId === releaseId, `${id} ist kein releasegebundener Qualitätsbericht.`);
    invariant(value.deterministic === true && value.summary?.visibleLayers === 10 && Number.isSafeInteger(value.summary?.visibleFeatures) && value.summary.visibleFeatures > 0, `${id} besitzt keinen vollständigen deterministischen Qualitätsnachweis.`);
  }
}

function normalizeDeliveryInventory(value, releaseId, { requireSignedContract = true } = {}) {
  if (requireSignedContract) validateSignedDeliveryContract(value, releaseId);
  else invariant(value?.schema === "zugfolge-map-delivery-release/v1" && value.releaseId === releaseId, "Delivery-Manifest gehört nicht zum Buildrelease.");
  invariant(Array.isArray(value.artifacts) && value.artifacts.length > 0, "Delivery-Manifest besitzt kein Artefaktinventar.");
  const ids = new Set();
  const installPaths = new Set();
  const inventory = value.artifacts.map((entry, index) => {
    const id = stableId(entry?.id, `Delivery-Artefakt[${index}].id`);
    invariant(!ids.has(id), `Delivery-Artefakt ${id} ist doppelt.`);
    ids.add(id);
    const kind = stableId(entry.kind, `Delivery-Artefakt ${id}.kind`);
    const installPath = portablePath(entry.installPath, `Delivery-Artefakt ${id}.installPath`);
    invariant(!installPaths.has(installPath), `Delivery-Installationspfad ${installPath} ist doppelt.`);
    installPaths.add(installPath);
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `Delivery-Artefakt ${id} besitzt keinen Byte-SHA-Beleg.`);
    return { id, kind, installPath, bytes: entry.bytes, sha256: entry.sha256 };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(inventory.filter(({ kind }) => kind === "basemap").length === 1, "Delivery-Manifest muss genau eine Basemap inventarisieren.");
  return inventory;
}

function bindOutputsToDeliveryInventory(outputs, inventory) {
  const byPath = new Map(inventory.map((entry) => [entry.installPath, entry]));
  for (const output of outputs) {
    if (output.kind === "delivery-manifest") continue;
    const artifact = byPath.get(output.installFile);
    invariant(artifact !== undefined, `Ausgabe ${output.id} fehlt im Delivery-Manifestinventar.`);
    invariant(artifact.kind === OUTPUT_TO_DELIVERY_KIND[output.kind], `Ausgabe ${output.id} besitzt im Delivery-Manifest die falsche Art.`);
    invariant(artifact.bytes === output.bytes && artifact.sha256 === output.sha256, `Ausgabe ${output.id} weicht vom Delivery-Manifestinventar ab.`);
  }
  return true;
}

async function deliveryInventoryFromOutput(root, outputs, releaseId) {
  const delivery = outputs.find(({ kind }) => kind === "delivery-manifest");
  invariant(delivery !== undefined, "Delivery-Manifest-Ausgabe fehlt.");
  const path = await containedRealPath(root, delivery.file, "Delivery-Manifest-Ausgabe");
  const value = JSON.parse(await readFile(path, "utf8"));
  const inventory = normalizeDeliveryInventory(value, releaseId);
  bindOutputsToDeliveryInventory(outputs, inventory);
  return inventory;
}

async function outputProof(root, descriptor, releaseId) {
  const proof = await fileProof(root, descriptor, `Ausgabe ${descriptor.id}`);
  const path = await containedRealPath(root, descriptor.file, `Ausgabe ${descriptor.id}.file`);
  await validateOutputShape(descriptor.kind, path, releaseId, descriptor.id);
  return proof;
}

async function* nonEmptyLines(path) {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1024 * 1024 });
  let remainder = "";
  for await (const chunk of stream) {
    remainder += chunk;
    let newline;
    while ((newline = remainder.indexOf("\n")) >= 0) {
      const line = remainder.slice(0, newline).replace(/\r$/, "");
      remainder = remainder.slice(newline + 1);
      if (line.trim().length > 0) yield line;
    }
  }
  if (remainder.trim().length > 0) yield remainder.replace(/\r$/, "");
}

async function inspectSemanticRegression(root, regression) {
  invariant(Array.isArray(regression?.semanticLayers) && regression.semanticLayers.length === SEMANTIC_LAYERS.length, "Regressionsbeleg muss exakt alle zehn öffentlichen Semantiklayer prüfen.");
  const layerNames = regression.semanticLayers.map(({ layer }) => layer);
  invariant(JSON.stringify(layerNames) === JSON.stringify(SEMANTIC_LAYERS), "Semantiklayer stehen nicht in der kanonischen Reihenfolge.");
  invariant(Array.isArray(regression.forbiddenPublicTokens) && regression.forbiddenPublicTokens.includes("12472736971"), "Der bekannte BOStrab-Knoten 12472736971 fehlt im negativen Regressionsvertrag.");
  invariant(regression.forbiddenPublicTokens.every((token) => typeof token === "string" && /^[-:a-z0-9]+$/i.test(token) && token.length >= 6), "Regressionsvertrag enthält ein ungültiges verbotenes Token.");
  invariant(Array.isArray(regression.requiredEboSignalFeatureIds) && regression.requiredEboSignalFeatureIds.length > 0, "Regressionsvertrag braucht mindestens ein positives EBO-Signal.");
  invariant(regression.requiredEboSignalFeatureIds.every((id) => /^signal:[-:a-z0-9]+$/i.test(id)), "Positiver EBO-Signalbeleg besitzt keine stabile Signal-ID.");
  const semanticLayers = [];
  const signalIds = new Set();
  for (const descriptor of regression.semanticLayers) {
    const normalized = { file: portablePath(descriptor.file, `Regressionslayer ${descriptor.layer}.file`) };
    const proof = await fileProof(root, normalized, `Regressionslayer ${descriptor.layer}`);
    const path = await containedRealPath(root, normalized.file, `Regressionslayer ${descriptor.layer}.file`);
    let features = 0;
    for await (const rawLine of nonEmptyLines(path)) {
      const line = rawLine.replace(/^\u001e/, "");
      for (const token of regression.forbiddenPublicTokens) invariant(!line.includes(token), `Verbotener öffentlicher Knotenbeleg ${token} steht im Layer ${descriptor.layer}.`);
      let feature;
      try {
        feature = JSON.parse(line);
      } catch {
        throw new Error(`Regressionslayer ${descriptor.layer} enthält ungültiges GeoJSONSeq.`);
      }
      invariant(feature?.type === "Feature" && typeof feature.properties?.feature_id === "string", `Regressionslayer ${descriptor.layer} enthält ein Feature ohne stabile ID.`);
      if (descriptor.layer === "signals") signalIds.add(feature.properties.feature_id);
      features += 1;
    }
    invariant(features > 0, `Regressionslayer ${descriptor.layer} ist leer.`);
    semanticLayers.push({ layer: descriptor.layer, file: normalized.file, features, ...proof });
  }
  for (const id of regression.requiredEboSignalFeatureIds) invariant(signalIds.has(id), `Positives EBO-Signal ${id} fehlt im Signallayer.`);
  return semanticLayers;
}

function inspectReadModelRegression(path, regression) {
  const database = new DatabaseSync(path, { readOnly: true, allowExtension: false, defensive: true, timeout: 0 });
  try {
    for (const token of regression.forbiddenPublicTokens) {
      const found = database.prepare(`SELECT object_id FROM object_details
        WHERE instr(object_id, ?) > 0 OR instr(name, ?) > 0 OR instr(facts_json, ?) > 0 LIMIT 1`).get(token, token, token);
      invariant(found === undefined, `Verbotener öffentlicher Knotenbeleg ${token} steht im ReadModel.`);
    }
    for (const id of regression.requiredEboSignalFeatureIds) {
      const found = database.prepare("SELECT 1 AS found FROM object_details WHERE kind = 'signal' AND object_id = ? LIMIT 1").get(id);
      invariant(found?.found === 1, `Positives EBO-Signal ${id} fehlt im ReadModel.`);
    }
  } finally {
    database.close();
  }
}

function validateSpecBasics(spec, { requireExpectedInputProofs = false } = {}) {
  invariant(spec?.schema === SPEC_SCHEMA, "Unbekanntes Build-Evidence-Spezifikationsschema.");
  parseReleasePair(spec.releaseId, spec.previousReleaseId);
  validateCommit(spec.commits?.semanticExport, "commits.semanticExport");
  validateCommit(spec.commits?.mapBuild, "commits.mapBuild");
  invariant(Array.isArray(spec.inputs) && spec.inputs.length >= REQUIRED_INPUT_KINDS.length, "Build-Evidence besitzt zu wenige Eingaben.");
  if (requireExpectedInputProofs) {
    for (const [index, input] of spec.inputs.entries()) {
      invariant(Number.isSafeInteger(input?.expectedBytes) && input.expectedBytes > 0, `Eingabe[${index}] besitzt keine verpflichtende erwartete Bytezahl.`);
      invariant(SHA256.test(input?.expectedSha256), `Eingabe[${index}] besitzt keinen verpflichtenden erwarteten SHA-256.`);
    }
  }
  invariant(Array.isArray(spec.tools) && spec.tools.length > 0, "Build-Evidence besitzt keine gepinnten Werkzeuge.");
  invariant(Array.isArray(spec.outputs) && spec.outputs.length === OUTPUT_KINDS.length, "Build-Evidence muss exakt die sieben aktivierungsrelevanten Ausgaben binden.");
  invariant(spec.deployment?.activationMode === "atomic-config-swap", "Deployment muss einen atomaren Konfigurationswechsel verlangen.");
  invariant(spec.deployment?.retainPreviousForRollback === true, "Deployment muss den Vorgänger für Rollback behalten.");
  invariant(spec.buildCache?.backupRequired === true && spec.buildCache?.encrypted === true, "Buildcache muss verschlüsselt gesichert werden.");
  invariant(spec.buildCache?.restoreVerification === "empty-path-full-inventory", "Buildcache muss auf einen leeren Pfad vollständig wiederhergestellt werden.");
  return spec;
}

export async function materializeMapReleaseBuildEvidence({ spec, specBytes, specFile, artifactRoot }) {
  validateSpecBasics(spec, { requireExpectedInputProofs: true });
  invariant(Buffer.isBuffer(specBytes) && specBytes.length > 0, "Rohbytes der Build-Evidence-Spezifikation fehlen.");
  let parsedSpec;
  try {
    parsedSpec = JSON.parse(specBytes.toString("utf8"));
  } catch {
    throw new Error("Build-Evidence-Spezifikation ist kein gültiges JSON-Artefakt.");
  }
  invariant(JSON.stringify(sortedValue(parsedSpec)) === JSON.stringify(sortedValue(spec)), "Übergebener Buildvertrag weicht von seinen Rohbytes ab.");
  const root = resolve(artifactRoot);
  const normalizedSpecFile = portablePath(specFile, "specFile");
  invariant(normalizedSpecFile.startsWith("tools/tiles/") && normalizedSpecFile.endsWith(".spec.json"), "Build-Evidence-Spezifikation muss versioniert unter tools/tiles eingecheckt sein.");
  const actualSpec = await fileProof(root, { file: normalizedSpecFile }, "Build-Evidence-Spezifikation");
  invariant(actualSpec.bytes === specBytes.length && actualSpec.sha256 === sha256Bytes(specBytes), "Übergebene Spezifikationsbytes stimmen nicht mit specFile überein.");

  const inputIds = new Set();
  const inputs = [];
  for (const descriptor of spec.inputs) {
    const id = stableId(descriptor?.id, "Eingabe-ID");
    invariant(!inputIds.has(id), `Eingabe ${id} ist doppelt.`);
    inputIds.add(id);
    invariant(INPUT_KINDS.has(descriptor.kind), `Eingabe ${id} besitzt eine unbekannte Art.`);
    const version = pinnedVersion(descriptor.version, `Eingabe ${id}`);
    const file = portablePath(descriptor.file, `Eingabe ${id}.file`);
    if (descriptor.kind === "specification") invariant(file.startsWith("tools/"), `Spezifikation ${id} muss im belegten Repository-Commit liegen.`);
    const proof = await fileProof(root, { ...descriptor, file }, `Eingabe ${id}`);
    inputs.push({ id, kind: descriptor.kind, version, file, ...(descriptor.cacheFile === undefined ? {} : { cacheFile: portablePath(descriptor.cacheFile, `Eingabe ${id}.cacheFile`) }), ...proof });
  }
  for (const kind of REQUIRED_INPUT_KINDS) invariant(inputs.some((entry) => entry.kind === kind), `Build-Evidence benötigt eine Eingabe vom Typ ${kind}.`);
  invariant(inputs.filter(({ kind }) => kind === "build-cache-inventory").length === 1, "Build-Evidence braucht genau ein Buildcache-Inventar.");

  const inventoryInput = inputs.find(({ id }) => id === spec.buildCache.inventoryInputId);
  invariant(inventoryInput?.kind === "build-cache-inventory", "buildCache.inventoryInputId verweist nicht auf das Buildcache-Inventar.");
  const inventoryPath = await containedRealPath(root, inventoryInput.file, "Buildcache-Inventar");
  const inventory = validateCacheInventory(JSON.parse(await readFile(inventoryPath, "utf8")), spec.releaseId);
  for (const input of inputs.filter(({ kind }) => ["source-archive", "capture-manifest", "derived-input"].includes(kind))) {
    invariant(input.cacheFile !== undefined, `Eingabe ${input.id} besitzt keinen wiederherstellbaren cacheFile-Pfad.`);
    const cached = inventoryEntry(inventory, input.cacheFile, `Eingabe ${input.id}`);
    invariant(cached.bytes === input.bytes && cached.sha256 === input.sha256, `Buildcache-Beleg für ${input.id} weicht von der Baueingabe ab.`);
  }

  const tools = [];
  const toolIds = new Set();
  for (const descriptor of spec.tools) {
    const id = stableId(descriptor?.id, "Werkzeug-ID");
    invariant(!toolIds.has(id), `Werkzeug ${id} ist doppelt.`);
    toolIds.add(id);
    const version = pinnedVersion(descriptor.version, `Werkzeug ${id}`);
    if (descriptor.kind === "oci-image") {
      validateOciTool({ ...descriptor, id });
      tools.push({ id, kind: "oci-image", version, reference: descriptor.reference, digest: descriptor.digest });
    } else if (descriptor.kind === "binary") {
      const file = portablePath(descriptor.file, `Werkzeug ${id}.file`);
      const cacheFile = portablePath(descriptor.cacheFile, `Werkzeug ${id}.cacheFile`);
      const proof = await fileProof(root, { ...descriptor, file }, `Werkzeug ${id}`);
      const cached = inventoryEntry(inventory, cacheFile, `Werkzeug ${id}`);
      invariant(cached.bytes === proof.bytes && cached.sha256 === proof.sha256, `Buildcache-Beleg für Werkzeug ${id} weicht ab.`);
      tools.push({ id, kind: "binary", version, file, cacheFile, ...proof });
    } else {
      throw new Error(`Werkzeug ${id} besitzt eine unbekannte Art.`);
    }
  }

  const outputs = [];
  const outputIds = new Set();
  const outputKinds = new Set();
  for (const descriptor of spec.outputs) {
    const id = stableId(descriptor?.id, "Ausgabe-ID");
    invariant(!outputIds.has(id), `Ausgabe ${id} ist doppelt.`);
    outputIds.add(id);
    invariant(OUTPUT_KINDS.includes(descriptor.kind) && !outputKinds.has(descriptor.kind), `Ausgabe ${id} besitzt eine fehlende oder doppelte Art.`);
    outputKinds.add(descriptor.kind);
    const file = portablePath(descriptor.file, `Ausgabe ${id}.file`);
    const installFile = portablePath(descriptor.installFile, `Ausgabe ${id}.installFile`);
    outputs.push({ id, kind: descriptor.kind, file, installFile, ...(await outputProof(root, { ...descriptor, id, file }, spec.releaseId)) });
  }
  invariant(OUTPUT_KINDS.every((kind) => outputKinds.has(kind)), "Build-Evidence besitzt kein vollständiges Ergebnisinventar.");
  invariant(new Set(outputs.map(({ installFile }) => installFile)).size === outputs.length, "Ausgaben besitzen doppelte Installationspfade.");
  const deliveryInventory = await deliveryInventoryFromOutput(root, outputs, spec.releaseId);

  const semanticLayers = await inspectSemanticRegression(root, spec.regressions);
  const readModel = outputs.find(({ kind }) => kind === "read-model");
  const readModelPath = await containedRealPath(root, readModel.file, "ReadModel-Regressionsprüfung");
  inspectReadModelRegression(readModelPath, spec.regressions);

  const candidateInstallPath = portablePath(spec.deployment.candidateInstallPath, "deployment.candidateInstallPath");
  const previousInstallPath = portablePath(spec.deployment.previousInstallPath, "deployment.previousInstallPath");
  invariant(candidateInstallPath.split("/").at(-1) === spec.releaseId, "Kandidatenpfad endet nicht auf der releaseId.");
  invariant(previousInstallPath.split("/").at(-1) === spec.previousReleaseId, "Rollbackpfad endet nicht auf der previousReleaseId.");
  invariant(candidateInstallPath !== previousInstallPath, "Patch- und Vorgängerrelease dürfen keinen Installationspfad teilen.");
  const activationPointer = portablePath(spec.deployment.activationPointer, "deployment.activationPointer");
  const rollbackAttestationPath = portablePath(spec.deployment.rollbackAttestationPath, "deployment.rollbackAttestationPath");
  invariant(
    ![candidateInstallPath, previousInstallPath].some((path) =>
      [activationPointer, rollbackAttestationPath].some((externalPath) => externalPath === path || externalPath.startsWith(`${path}/`))),
    "Aktivierungszeiger und Rollback-Attestation dürfen nicht in einem unveränderlichen Releaseverzeichnis liegen.",
  );
  invariant(rollbackAttestationPath !== activationPointer, "Aktivierungszeiger und Rollback-Attestation brauchen getrennte Pfade.");
  const objectKey = portablePath(spec.buildCache.objectKey, "buildCache.objectKey");
  invariant(objectKey.includes(spec.releaseId), "Buildcache-Objektschlüssel ist nicht an den Patchrelease gebunden.");
  const cacheEncryptionScheme = encryptionScheme(spec.buildCache.encryptionScheme);

  return {
    schema: EVIDENCE_SCHEMA,
    releaseId: spec.releaseId,
    previousReleaseId: spec.previousReleaseId,
    commits: { semanticExport: spec.commits.semanticExport, mapBuild: spec.commits.mapBuild },
    buildContract: { file: normalizedSpecFile, bytes: specBytes.length, sha256: sha256Bytes(specBytes) },
    inputs: inputs.sort((left, right) => left.id.localeCompare(right.id, "en")),
    tools: tools.sort((left, right) => left.id.localeCompare(right.id, "en")),
    outputs: outputs.sort((left, right) => left.id.localeCompare(right.id, "en")),
    deliveryInventory,
    regressions: {
      forbiddenPublicTokens: [...spec.regressions.forbiddenPublicTokens].sort(),
      requiredEboSignalFeatureIds: [...spec.regressions.requiredEboSignalFeatureIds].sort(),
      semanticLayers,
      readModelOutputId: readModel.id,
    },
    buildCache: {
      inventoryInputId: inventoryInput.id,
      inventory,
      objectKey,
      encrypted: true,
      encryptionScheme: cacheEncryptionScheme,
      backupRequired: true,
      restoreVerification: "empty-path-full-inventory",
    },
    deployment: {
      candidateInstallPath,
      previousInstallPath,
      activationPointer,
      rollbackAttestationPath,
      activationMode: "atomic-config-swap",
      retainPreviousForRollback: true,
    },
  };
}

function evidenceSpecForValidation(evidence) {
  return {
    schema: SPEC_SCHEMA,
    releaseId: evidence?.releaseId,
    previousReleaseId: evidence?.previousReleaseId,
    commits: evidence?.commits,
    inputs: evidence?.inputs,
    tools: evidence?.tools,
    outputs: evidence?.outputs,
    regressions: evidence?.regressions,
    buildCache: evidence?.buildCache,
    deployment: evidence?.deployment,
  };
}

export function validateMapReleaseBuildEvidence(evidence) {
  invariant(evidence?.schema === EVIDENCE_SCHEMA, "Unbekanntes Build-Evidence-Manifest.");
  validateSpecBasics(evidenceSpecForValidation(evidence));
  portablePath(evidence.buildContract?.file, "buildContract.file");
  invariant(evidence.buildContract.file.startsWith("tools/tiles/") && evidence.buildContract.file.endsWith(".spec.json"), "Build-Evidence-Spezifikation muss versioniert unter tools/tiles eingecheckt sein.");
  invariant(Number.isSafeInteger(evidence.buildContract.bytes) && evidence.buildContract.bytes > 0 && SHA256.test(evidence.buildContract.sha256), "Buildvertrag besitzt keinen Byte-SHA-Beleg.");
  const inputIds = new Set();
  for (const entry of evidence.inputs) {
    stableId(entry.id, "Eingabe-ID");
    invariant(!inputIds.has(entry.id), `Eingabe ${entry.id} ist doppelt.`);
    inputIds.add(entry.id);
    invariant(INPUT_KINDS.has(entry.kind), `Eingabe ${entry.id} besitzt eine unbekannte Art.`);
    pinnedVersion(entry.version, `Eingabe ${entry.id}`);
    portablePath(entry.file, `Eingabe ${entry.id}.file`);
    if (entry.kind === "specification") invariant(entry.file.startsWith("tools/"), `Spezifikation ${entry.id} muss im belegten Repository-Commit liegen.`);
    if (entry.cacheFile !== undefined) portablePath(entry.cacheFile, `Eingabe ${entry.id}.cacheFile`);
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `Eingabe ${entry.id} besitzt keinen Byte-SHA-Beleg.`);
  }
  for (const kind of REQUIRED_INPUT_KINDS) invariant(evidence.inputs.some((entry) => entry.kind === kind), `Build-Evidence benötigt eine Eingabe vom Typ ${kind}.`);
  invariant(evidence.inputs.filter(({ kind }) => kind === "build-cache-inventory").length === 1, "Build-Evidence braucht genau ein Buildcache-Inventar.");

  const toolIds = new Set();
  for (const tool of evidence.tools) {
    stableId(tool.id, "Werkzeug-ID");
    invariant(!toolIds.has(tool.id), `Werkzeug ${tool.id} ist doppelt.`);
    toolIds.add(tool.id);
    pinnedVersion(tool.version, `Werkzeug ${tool.id}`);
    if (tool.kind === "oci-image") validateOciTool(tool);
    else if (tool.kind === "binary") {
      portablePath(tool.file, `Werkzeug ${tool.id}.file`);
      portablePath(tool.cacheFile, `Werkzeug ${tool.id}.cacheFile`);
      invariant(Number.isSafeInteger(tool.bytes) && tool.bytes > 0 && SHA256.test(tool.sha256), `Werkzeug ${tool.id} besitzt keinen Byte-SHA-Beleg.`);
    } else throw new Error(`Werkzeug ${tool.id} besitzt eine unbekannte Art.`);
  }

  const outputIds = new Set();
  const outputKinds = new Set();
  for (const entry of evidence.outputs) {
    stableId(entry.id, "Ausgabe-ID");
    invariant(!outputIds.has(entry.id), `Ausgabe ${entry.id} ist doppelt.`);
    outputIds.add(entry.id);
    invariant(OUTPUT_KINDS.includes(entry.kind) && !outputKinds.has(entry.kind), `Ausgabe ${entry.id} besitzt eine fehlende oder doppelte Art.`);
    outputKinds.add(entry.kind);
    portablePath(entry.file, `Ausgabe ${entry.id}.file`);
    portablePath(entry.installFile, `Ausgabe ${entry.id}.installFile`);
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `Ausgabe ${entry.id} besitzt keinen Byte-SHA-Beleg.`);
  }
  invariant(OUTPUT_KINDS.every((kind) => outputKinds.has(kind)), "Build-Evidence besitzt kein vollständiges Ergebnisinventar.");
  invariant(new Set(evidence.outputs.map(({ installFile }) => installFile)).size === evidence.outputs.length, "Ausgaben besitzen doppelte Installationspfade.");
  const deliveryInventory = normalizeDeliveryInventory({
    schema: "zugfolge-map-delivery-release/v1",
    releaseId: evidence.releaseId,
    artifacts: evidence.deliveryInventory,
  }, evidence.releaseId, { requireSignedContract: false });
  invariant(JSON.stringify(sortedValue(deliveryInventory)) === JSON.stringify(sortedValue(evidence.deliveryInventory)), "Delivery-Manifestinventar ist nicht kanonisch nach ID geordnet.");
  bindOutputsToDeliveryInventory(evidence.outputs, deliveryInventory);

  const inventory = validateCacheInventory({ schema: CACHE_INVENTORY_SCHEMA, releaseId: evidence.releaseId, files: evidence.buildCache.inventory }, evidence.releaseId);
  const inventoryInput = evidence.inputs.find(({ id }) => id === evidence.buildCache.inventoryInputId);
  invariant(inventoryInput?.kind === "build-cache-inventory", "buildCache.inventoryInputId verweist nicht auf das Buildcache-Inventar.");
  for (const input of evidence.inputs.filter(({ kind }) => ["source-archive", "capture-manifest", "derived-input"].includes(kind))) {
    invariant(input.cacheFile !== undefined, `Eingabe ${input.id} besitzt keinen cacheFile-Pfad.`);
    const cached = inventoryEntry(inventory, input.cacheFile, `Eingabe ${input.id}`);
    invariant(cached.bytes === input.bytes && cached.sha256 === input.sha256, `Buildcache-Beleg für ${input.id} weicht ab.`);
  }
  for (const tool of evidence.tools.filter(({ kind }) => kind === "binary")) {
    const cached = inventoryEntry(inventory, tool.cacheFile, `Werkzeug ${tool.id}`);
    invariant(cached.bytes === tool.bytes && cached.sha256 === tool.sha256, `Buildcache-Beleg für Werkzeug ${tool.id} weicht ab.`);
  }
  portablePath(evidence.buildCache.objectKey, "buildCache.objectKey");
  invariant(evidence.buildCache.objectKey.includes(evidence.releaseId), "Buildcache-Objektschlüssel ist nicht releasegebunden.");
  encryptionScheme(evidence.buildCache.encryptionScheme);

  invariant(Array.isArray(evidence.regressions?.semanticLayers) && evidence.regressions.semanticLayers.length === SEMANTIC_LAYERS.length, "Regressionsbeleg enthält nicht alle zehn Semantiklayer.");
  invariant(JSON.stringify(evidence.regressions.semanticLayers.map(({ layer }) => layer)) === JSON.stringify(SEMANTIC_LAYERS), "Regressionslayer stehen nicht in kanonischer Reihenfolge.");
  for (const layer of evidence.regressions.semanticLayers) {
    portablePath(layer.file, `Regressionslayer ${layer.layer}.file`);
    invariant(Number.isSafeInteger(layer.features) && layer.features > 0 && Number.isSafeInteger(layer.bytes) && layer.bytes > 0 && SHA256.test(layer.sha256), `Regressionslayer ${layer.layer} besitzt keinen vollständigen Beleg.`);
  }
  invariant(evidence.regressions.forbiddenPublicTokens?.includes("12472736971"), "Bekannter BOStrab-Knoten fehlt im Regressionsbeleg.");
  invariant(Array.isArray(evidence.regressions.requiredEboSignalFeatureIds) && evidence.regressions.requiredEboSignalFeatureIds.length > 0, "Positiver EBO-Signalbeleg fehlt.");
  const readModel = evidence.outputs.find(({ id }) => id === evidence.regressions.readModelOutputId);
  invariant(readModel?.kind === "read-model", "ReadModel-Regressionsbeleg verweist auf eine falsche Ausgabe.");

  const candidateInstallPath = portablePath(evidence.deployment.candidateInstallPath, "deployment.candidateInstallPath");
  const previousInstallPath = portablePath(evidence.deployment.previousInstallPath, "deployment.previousInstallPath");
  invariant(candidateInstallPath.split("/").at(-1) === evidence.releaseId && previousInstallPath.split("/").at(-1) === evidence.previousReleaseId && candidateInstallPath !== previousInstallPath, "Deploymentpfade verletzen die unveränderliche Patch-/Rollbackbindung.");
  const activationPointer = portablePath(evidence.deployment.activationPointer, "deployment.activationPointer");
  const rollbackAttestationPath = portablePath(evidence.deployment.rollbackAttestationPath, "deployment.rollbackAttestationPath");
  invariant(
    ![candidateInstallPath, previousInstallPath].some((path) =>
      [activationPointer, rollbackAttestationPath].some((externalPath) => externalPath === path || externalPath.startsWith(`${path}/`))),
    "Aktivierungszeiger und Rollback-Attestation dürfen nicht in einem unveränderlichen Releaseverzeichnis liegen.",
  );
  invariant(rollbackAttestationPath !== activationPointer, "Aktivierungszeiger und Rollback-Attestation brauchen getrennte Pfade.");
  return evidence;
}

export async function verifyMapReleaseBuildEvidence(evidence, artifactRoot) {
  validateMapReleaseBuildEvidence(evidence);
  const root = resolve(artifactRoot);
  const contract = await fileProof(root, { file: evidence.buildContract.file }, "Buildvertrag");
  invariant(contract.bytes === evidence.buildContract.bytes && contract.sha256 === evidence.buildContract.sha256, "Buildvertrag weicht vom Evidence-Manifest ab.");
  for (const input of evidence.inputs) {
    const proof = await fileProof(root, { file: input.file }, `Eingabe ${input.id}`);
    invariant(proof.bytes === input.bytes && proof.sha256 === input.sha256, `Eingabe ${input.id} weicht vom Evidence-Manifest ab.`);
  }
  for (const tool of evidence.tools.filter(({ kind }) => kind === "binary")) {
    const proof = await fileProof(root, { file: tool.file }, `Werkzeug ${tool.id}`);
    invariant(proof.bytes === tool.bytes && proof.sha256 === tool.sha256, `Werkzeug ${tool.id} weicht vom Evidence-Manifest ab.`);
  }
  for (const output of evidence.outputs) {
    const proof = await outputProof(root, { ...output, expectedBytes: undefined, expectedSha256: undefined }, evidence.releaseId);
    invariant(proof.bytes === output.bytes && proof.sha256 === output.sha256, `Ausgabe ${output.id} weicht vom Evidence-Manifest ab.`);
  }
  const deliveryInventory = await deliveryInventoryFromOutput(root, evidence.outputs, evidence.releaseId);
  invariant(JSON.stringify(sortedValue(deliveryInventory)) === JSON.stringify(sortedValue(evidence.deliveryInventory)), "Delivery-Manifestinventar weicht vom Evidence-Manifest ab.");
  const regression = {
    semanticLayers: evidence.regressions.semanticLayers.map(({ layer, file }) => ({ layer, file })),
    forbiddenPublicTokens: evidence.regressions.forbiddenPublicTokens,
    requiredEboSignalFeatureIds: evidence.regressions.requiredEboSignalFeatureIds,
  };
  const semanticLayers = await inspectSemanticRegression(root, regression);
  for (const layer of semanticLayers) {
    const expected = evidence.regressions.semanticLayers.find(({ layer: name }) => name === layer.layer);
    invariant(layer.bytes === expected.bytes && layer.sha256 === expected.sha256 && layer.features === expected.features, `Regressionslayer ${layer.layer} weicht vom Evidence-Manifest ab.`);
  }
  const readModel = evidence.outputs.find(({ id }) => id === evidence.regressions.readModelOutputId);
  invariant(readModel?.kind === "read-model", "ReadModel-Regressionsbeleg verweist auf eine falsche Ausgabe.");
  inspectReadModelRegression(await containedRealPath(root, readModel.file, "ReadModel-Regressionsprüfung"), regression);
  return {
    releaseId: evidence.releaseId,
    evidenceSha256: sha256Bytes(serializeMapReleaseBuildEvidence(evidence)),
    inputs: evidence.inputs.length,
    tools: evidence.tools.length,
    outputs: evidence.outputs.length,
    deliveryArtifacts: evidence.deliveryInventory.length,
    semanticLayers: semanticLayers.length,
  };
}

async function writeAtomicCreateNew(path, bytes, label) {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.building`;
  let ownsTemporary = false;
  try {
    const handle = await open(temporary, "wx");
    ownsTemporary = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, output);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`${label} existiert bereits; create-new verweigert jede Überschreibung.`);
      throw error;
    }
    return { path: output, status: "written" };
  } finally {
    if (ownsTemporary) await rm(temporary, { force: true });
  }
}

export async function writeMapReleaseBuildEvidence(evidence, outputPath) {
  validateMapReleaseBuildEvidence(evidence);
  const bytes = serializeMapReleaseBuildEvidence(evidence);
  return { ...(await writeAtomicCreateNew(outputPath, bytes, "Build-Evidence-Manifest")), bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

export async function prepareEmptyBuildCacheRestore(restoreRoot) {
  const root = resolve(restoreRoot);
  try {
    await lstat(root);
    throw new Error(`Restore-Ziel muss vor der Vorbereitung fehlen: ${root}.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { recursive: false });
  const marker = { schema: RESTORE_MARKER_SCHEMA, nonce: randomUUID() };
  const markerBytes = serializeMapReleaseBuildEvidence(marker);
  const markerPath = resolve(root, RESTORE_MARKER);
  const handle = await open(markerPath, "wx");
  try {
    await handle.writeFile(markerBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { root, markerPath, nonce: marker.nonce, markerSha256: sha256Bytes(markerBytes) };
}

async function inventoryRestoredFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(resolve(root, ...prefix.split("/").filter(Boolean)), { withFileTypes: true })) {
    const portable = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (portable === RESTORE_MARKER) continue;
    invariant(!entry.isSymbolicLink(), `Restore enthält den symbolischen Link ${portable}.`);
    if (entry.isDirectory()) result.push(...(await inventoryRestoredFiles(root, portable)));
    else {
      invariant(entry.isFile(), `Restore enthält einen unbekannten Dateityp ${portable}.`);
      const proof = await fileProof(root, { file: portable }, `Restore-Datei ${portable}`);
      result.push({ path: portable, ...proof });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export async function proveBuildCacheRestore(evidence, restoreRoot) {
  validateMapReleaseBuildEvidence(evidence);
  const root = resolve(restoreRoot);
  const rootMetadata = await lstat(root);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Restore-Ziel ist kein reguläres Verzeichnis.");
  const markerPath = await containedRealPath(root, RESTORE_MARKER, "Restore-Leerpfadmarker");
  const markerMetadata = await lstat(markerPath);
  invariant(markerMetadata.isFile() && !markerMetadata.isSymbolicLink(), "Restore-Leerpfadmarker ist keine reguläre Datei.");
  const markerBytes = await readFile(markerPath);
  const marker = JSON.parse(markerBytes.toString("utf8"));
  invariant(markerBytes.equals(serializeMapReleaseBuildEvidence(marker)), "Restore-Leerpfadmarker ist nicht kanonisch serialisiert.");
  invariant(JSON.stringify(Object.keys(marker).sort()) === JSON.stringify(["nonce", "schema"]), "Restore-Leerpfadmarker besitzt unbekannte Felder.");
  invariant(marker?.schema === RESTORE_MARKER_SCHEMA && typeof marker.nonce === "string" && UUID_V4.test(marker.nonce), "Restore besitzt keinen gültigen Leerpfadmarker.");
  const restored = await inventoryRestoredFiles(root);
  invariant(
    JSON.stringify(sortedValue(restored)) === JSON.stringify(sortedValue(evidence.buildCache.inventory)),
    `Wiederhergestellter Buildcache weicht vom vollständigen Evidence-Inventar ab (ist: ${restored.map(({ path }) => path).join(", ")}; erwartet: ${evidence.buildCache.inventory.map(({ path }) => path).join(", ")}).`,
  );
  const evidenceSha256 = sha256Bytes(serializeMapReleaseBuildEvidence(evidence));
  const inventorySha256 = sha256Bytes(Buffer.from(`${JSON.stringify(sortedValue(evidence.buildCache.inventory))}\n`, "utf8"));
  const restoreRootSha256 = sha256Bytes(Buffer.from(await realpath(root), "utf8"));
  const emptyRootMarkerSha256 = sha256Bytes(markerBytes);
  const artifactBindingSha256 = sha256Bytes(serializeMapReleaseBuildEvidence({
    emptyRootMarkerSha256,
    evidenceSha256,
    inventorySha256,
    objectKey: evidence.buildCache.objectKey,
    restoreRootSha256,
  }));
  const proof = {
    schema: RESTORE_PROOF_SCHEMA,
    releaseId: evidence.releaseId,
    evidenceSha256,
    objectKey: evidence.buildCache.objectKey,
    encrypted: true,
    encryptionScheme: evidence.buildCache.encryptionScheme,
    restoredToPreparedEmptyPath: true,
    emptyRootNonce: marker.nonce,
    emptyRootMarkerBytes: markerBytes.length,
    emptyRootMarkerSha256,
    restoreRootSha256,
    verification: "full-byte-inventory",
    verifiedFiles: restored.length,
    verifiedBytes: restored.reduce((sum, entry) => sum + entry.bytes, 0),
    inventorySha256,
    artifactBindingSha256,
  };
  return { proof, proofBytes: serializeMapReleaseBuildEvidence(proof) };
}

export async function writeBuildCacheRestoreProof(result, outputPath) {
  return writeAtomicCreateNew(outputPath, result.proofBytes, "Buildcache-Restore-Beleg");
}

function parseCanonicalRestoreProof(bytes) {
  invariant(Buffer.isBuffer(bytes) && bytes.length > 0, "Buildcache-Restore-Beleg muss als unverändertes Datei-Artefakt übergeben werden.");
  let proof;
  try {
    proof = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Buildcache-Restore-Beleg ist kein gültiges JSON-Artefakt.");
  }
  invariant(bytes.equals(serializeMapReleaseBuildEvidence(proof)), "Buildcache-Restore-Beleg ist nicht kanonisch serialisiert.");
  return proof;
}

async function assertDirectory(root, relativePath, label) {
  let path;
  try {
    path = await containedRealPath(root, relativePath, label);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} fehlt.`);
    throw error;
  }
  const metadata = await lstat(path);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} ist kein unveränderliches Releaseverzeichnis.`);
  return path;
}

function releaseVersion(releaseId) {
  const parsed = RELEASE_ID.exec(releaseId);
  invariant(parsed !== null, `${releaseId} ist kein Jahres-Patchrelease.`);
  return `${parsed.groups.year}.${parsed.groups.patch}`;
}

async function assertExactInstalledInventory(root, expectedFiles, label) {
  const expected = new Set(expectedFiles);
  const observed = new Set();
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const portable = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      invariant(!entry.isSymbolicLink(), `${label} enthält den symbolischen Link ${portable}.`);
      if (entry.isDirectory()) {
        invariant([...expected].some((path) => path.startsWith(`${portable}/`)), `${label} enthält das unerwartete Verzeichnis ${portable}.`);
        await walk(resolve(directory, entry.name), portable);
      } else {
        invariant(entry.isFile() && expected.has(portable), `${label} enthält die unerwartete Datei ${portable}.`);
        observed.add(portable);
      }
    }
  }
  await walk(root);
  invariant(observed.size === expected.size && [...expected].every((path) => observed.has(path)), `${label} ist gegenüber seinem Paketmanifest unvollständig.`);
}

async function inspectInstalledMapPackage(deploymentRoot, installPath, releaseId, label) {
  const root = await assertDirectory(deploymentRoot, installPath, label);
  let markerPath;
  try {
    markerPath = await containedRealPath(root, INSTALLED_PACKAGE_MANIFEST, `${label}-Paketmarker`);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} besitzt keinen ${INSTALLED_PACKAGE_MANIFEST}-Paketmarker.`);
    throw error;
  }
  const markerBytes = await readFile(markerPath);
  invariant(markerBytes.length > 0 && markerBytes.length <= 16 * 1024 * 1024, `${label}-Paketmarker besitzt eine unzulässige Größe.`);
  let manifest;
  try {
    manifest = JSON.parse(markerBytes.toString("utf8"));
  } catch {
    throw new Error(`${label}-Paketmarker ist kein gültiges JSON-Artefakt.`);
  }
  validateMapPackageManifest(manifest);
  invariant(markerBytes.equals(Buffer.from(serializeMapPackageManifest(manifest), "utf8")), `${label}-Paketmarker ist nicht kanonisch serialisiert.`);
  invariant(manifest.version === releaseVersion(releaseId), `${label}-Paketmarker gehört nicht zum Release ${releaseId}.`);
  invariant(manifest.runtime?.publicBasePath === `/artifacts/maps/${releaseId}`, `${label}-Paketmarker besitzt eine fremde Releasewurzel.`);
  invariant(manifest.runtime.basemapStyleUrl === `/artifacts/maps/${releaseId}/style.json`, `${label}-Paketmarker besitzt einen fremden Stylepfad.`);
  invariant(manifest.runtime.infrastructurePmtilesUrl === `/artifacts/maps/${releaseId}/${releaseId}.pmtiles`, `${label}-Paketmarker besitzt einen fremden Infrastrukturpfad.`);
  const inventory = [...manifest.artifacts, ...manifest.auxiliaryFiles]
    .map(({ id, kind, installPath: file, bytes, sha256 }) => ({ id, kind, installPath: file, bytes, sha256 }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  await assertExactInstalledInventory(root, [INSTALLED_PACKAGE_MANIFEST, ...inventory.map(({ installPath: file }) => file)], label);
  for (const artifact of inventory) {
    const observed = await fileProof(root, { file: artifact.installPath }, `${label}-Artefakt ${artifact.id}`);
    invariant(observed.bytes === artifact.bytes && observed.sha256 === artifact.sha256, `${label}-Artefakt ${artifact.id} ist beschädigt.`);
  }
  const releaseEntry = inventory.find(({ kind }) => kind === "release-manifest");
  const sourcesEntry = inventory.find(({ kind }) => kind === "source-manifest");
  invariant(releaseEntry !== undefined && sourcesEntry !== undefined, `${label} besitzt keinen vollständigen Release-/Quellenvertrag.`);
  const releaseBytes = await readFile(await containedRealPath(root, releaseEntry.installPath, `${label}-Delivery-Manifest`));
  const sourcesBytes = await readFile(await containedRealPath(root, sourcesEntry.installPath, `${label}-Quellenmanifest`));
  let release;
  let sources;
  try {
    release = JSON.parse(releaseBytes.toString("utf8"));
    sources = JSON.parse(sourcesBytes.toString("utf8"));
  } catch {
    throw new Error(`${label} besitzt keinen gültigen Release-/Quellenvertrag.`);
  }
  invariant(releaseBytes.equals(serializeDeliveryJson(release)) && sourcesBytes.equals(serializeDeliveryJson(sources)), `${label} besitzt keinen kanonischen Release-/Quellenvertrag.`);
  invariant(release?.schema === "zugfolge-map-delivery-release/v1" && release.releaseId === releaseId, `${label}-Delivery-Manifest gehört nicht zum installierten Release.`);
  invariant(sources?.schema === "zugfolge-map-delivery-sources/v1" && sources.releaseId === releaseId, `${label}-Quellenmanifest gehört nicht zum installierten Release.`);
  invariant(release.packageId === manifest.packageId && release.packageVersion === manifest.version, `${label}-Paketmarker ist nicht an seinen Delivery-Vertrag gebunden.`);
  invariant(Array.isArray(release.artifacts), `${label}-Delivery-Manifest besitzt kein Artefaktinventar.`);
  const delivered = [...release.artifacts].map(({ id, kind, installPath: file, bytes, sha256 }) => ({ id, kind, installPath: file, bytes, sha256 }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const packaged = inventory.filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind));
  invariant(JSON.stringify(delivered) === JSON.stringify(packaged), `${label}-Paketmarker weicht vom Delivery-Inventar ab.`);
  invariant(release.bindings?.sourcesSha256 === sourcesEntry.sha256, `${label}-Delivery-Manifest bindet sein Quellenmanifest nicht bytegenau.`);
  return { root, manifest, markerBytes, inventory, release, releaseBytes, sources, sourcesBytes };
}

async function inspectSignedWorldDeployment(path, trustedKeys) {
  const bytes = await readFile(resolve(path));
  invariant(bytes.length > 0, "Signiertes Weltdeployment ist leer.");
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Signiertes Weltdeployment ist kein gueltiges JSON-Artefakt.");
  }
  const deployment = decodeAlphaValue(envelope?.deployment);
  invariant(deployment?.schema === "zugfolge-alpha-world-deployment/v1", "Weltdeployment besitzt kein freigegebenes Alpha-Deployment-Schema.");
  invariant(typeof deployment.worldId === "string" && deployment.worldId.length > 0, "Weltdeployment besitzt keine Weltbindung.");
  invariant(typeof deployment.worldDefinition?.epoch === "string", "Weltdeployment besitzt keine Epoch-Bindung.");
  const epoch = new Date(deployment.worldDefinition.epoch);
  invariant(!Number.isNaN(epoch.getTime()) && epoch.toISOString() === deployment.worldDefinition.epoch, "Weltdeployment besitzt keine kanonische Epoch-Bindung.");
  invariant(Number.isSafeInteger(deployment.repeatEveryS) && deployment.repeatEveryS > 0, "Weltdeployment besitzt keine Wiederholungsperiode.");
  const deploymentHash = alphaHash(deployment.schema, deployment);
  invariant(envelope.deploymentHash === deploymentHash, "Weltdeployment-Hash stimmt nicht mit dem signierten Inhalt ueberein.");
  const signature = envelope.signature;
  invariant(signature?.algorithm === "Ed25519" && typeof signature.keyId === "string" && typeof signature.valueBase64 === "string", "Weltdeployment besitzt keine Ed25519-Signaturhuelle.");
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  invariant(signatureBytes.length === 64 && signatureBytes.toString("base64") === signature.valueBase64, "Weltdeployment besitzt keine kanonischen Ed25519-Signaturbytes.");
  if (trustedKeys !== undefined) {
    const publicKey = trustedDeliveryPublicKey(trustedKeys, signature.keyId, "Weltdeployment");
    invariant(
      verifyEd25519(null, Buffer.from(deploymentHash, "hex"), createPublicKey(publicKey), signatureBytes),
      "Weltdeployment besitzt keine gueltige vertrauenswuerdige Ed25519-Signatur.",
    );
  }
  return {
    bytes,
    sha256: sha256Bytes(bytes),
    deploymentHash,
    worldId: deployment.worldId,
    worldEpoch: deployment.worldDefinition.epoch,
    repeatEveryS: deployment.repeatEveryS,
    keyId: signature.keyId,
  };
}

async function inspectInstalledRuntimeTuple(previous, previousReleaseId) {
  const readModelEntry = previous.inventory.find(({ kind }) => kind === "read-model");
  const projectionEntry = previous.inventory.find(({ kind }) => kind === "train-map-projection");
  invariant(readModelEntry !== undefined && projectionEntry !== undefined, "Rollbackrelease besitzt kein vollstaendiges ReadModel-/Projektions-Tuple.");
  const readModelPath = await containedRealPath(previous.root, readModelEntry.installPath, "Rollback-ReadModel");
  const projectionPath = await containedRealPath(previous.root, projectionEntry.installPath, "Rollback-Zugprojektion");
  const [readModel, projection] = await Promise.all([
    inspectPublicReadModel(readModelPath),
    inspectTrainMapProjection(projectionPath),
  ]);
  invariant(readModel.infrastructureReleaseId === previousReleaseId, "Rollback-ReadModel ist nicht an das vorherige Kartenrelease gebunden.");
  invariant(projection.infrastructureReleaseId === previousReleaseId, "Rollback-Zugprojektion ist nicht an das vorherige Kartenrelease gebunden.");
  invariant(readModel.worldId === projection.worldId, "Rollback-ReadModel und Zugprojektion gehoeren zu verschiedenen Welten.");
  return {
    schema: RUNTIME_ROLLBACK_TUPLE_SCHEMA,
    mapReleaseId: previousReleaseId,
    readModel: {
      file: readModelEntry.installPath,
      bytes: readModelEntry.bytes,
      sha256: readModelEntry.sha256,
      schema: "zugfolge-livemap-read-model-sqlite/v2",
      applicationId: readModel.applicationId,
      userVersion: readModel.userVersion,
      worldId: readModel.worldId,
      infrastructureReleaseId: readModel.infrastructureReleaseId,
      worldEpoch: readModel.scheduleTime.worldEpoch,
      serviceDate: readModel.scheduleTime.serviceDate,
      timeZone: readModel.scheduleTime.timeZone,
      serviceStartOffsetS: readModel.scheduleTime.serviceStartOffsetS,
      repeatEveryS: readModel.scheduleTime.repeatEveryS,
    },
    trainMapProjection: {
      file: projectionEntry.installPath,
      bytes: projectionEntry.bytes,
      sha256: projectionEntry.sha256,
      schema: projection.schema,
      applicationId: projection.sqliteApplicationId,
      userVersion: projection.sqliteUserVersion,
      schemaSqlSha256: projection.schemaSqlSha256,
      worldId: projection.worldId,
      infrastructureReleaseId: projection.infrastructureReleaseId,
      deploymentHash: projection.deploymentHash,
    },
  };
}

function validateRuntimeRollbackTuple(tuple, previousReleaseId) {
  invariant(tuple?.schema === RUNTIME_ROLLBACK_TUPLE_SCHEMA && tuple.mapReleaseId === previousReleaseId, "Rollback-Runtime-Tuple gehoert nicht zum Vorgaengerrelease.");
  invariant(GIT_COMMIT.test(tuple.sourceCommit) && !/^0+$/.test(tuple.sourceCommit), "Rollback-Runtime-Tuple besitzt keinen unveraenderlichen Source-Commit.");
  invariant(OCI_DIGEST.test(tuple.imageDigest), "Rollback-Runtime-Tuple besitzt keinen unveraenderlichen Image-Digest.");
  const world = tuple.worldDeployment;
  invariant(Number.isSafeInteger(world?.bytes) && world.bytes > 0 && SHA256.test(world?.sha256), "Rollback-Runtime-Tuple bindet das Weltdeployment nicht bytegenau.");
  invariant(world.schema === "zugfolge-alpha-world-deployment/v1" && typeof world.worldId === "string" && SHA256.test(world.deploymentHash), "Rollback-Runtime-Tuple besitzt keine gueltige Welt-/Deploymentbindung.");
  invariant(typeof world.worldEpoch === "string" && Number.isSafeInteger(world.repeatEveryS) && world.repeatEveryS > 0 && typeof world.keyId === "string", "Rollback-Runtime-Tuple besitzt keinen vollstaendigen Weltzeit-/Signaturvertrag.");
  const readModel = tuple.readModel;
  invariant(readModel?.schema === "zugfolge-livemap-read-model-sqlite/v2" && readModel.infrastructureReleaseId === previousReleaseId, "Rollback-Runtime-Tuple besitzt kein kompatibles ReadModel-Schema/Release.");
  invariant(Number.isSafeInteger(readModel.applicationId) && Number.isSafeInteger(readModel.userVersion) && Number.isSafeInteger(readModel.repeatEveryS), "Rollback-Runtime-Tuple besitzt keinen vollstaendigen ReadModel-Runtimevertrag.");
  invariant(Number.isSafeInteger(readModel.bytes) && readModel.bytes > 0 && SHA256.test(readModel.sha256), "Rollback-Runtime-Tuple bindet das ReadModel nicht bytegenau.");
  const projection = tuple.trainMapProjection;
  invariant(projection?.schema === "zugfolge-train-map-projection/v2" && projection.infrastructureReleaseId === previousReleaseId, "Rollback-Runtime-Tuple besitzt kein kompatibles Projektions-Schema/Release.");
  invariant(Number.isSafeInteger(projection.applicationId) && Number.isSafeInteger(projection.userVersion) && SHA256.test(projection.schemaSqlSha256), "Rollback-Runtime-Tuple besitzt keinen vollstaendigen Projektions-Runtimevertrag.");
  invariant(Number.isSafeInteger(projection.bytes) && projection.bytes > 0 && SHA256.test(projection.sha256), "Rollback-Runtime-Tuple bindet die Zugprojektion nicht bytegenau.");
  invariant(
    readModel.worldId === world.worldId
      && projection.worldId === world.worldId
      && projection.deploymentHash === world.deploymentHash
      && readModel.worldEpoch === world.worldEpoch
      && readModel.repeatEveryS === world.repeatEveryS,
    "Rollback-Runtime-Tuple koppelt Welt, Zeitvertrag und Zugprojektion nicht konsistent.",
  );
  return tuple;
}

function rollbackAttestationHash(attestation) {
  invariant(
    attestation?.schema === ROLLBACK_ATTESTATION_SCHEMA || attestation?.schema === RUNTIME_ROLLBACK_ATTESTATION_SCHEMA,
    "Rollback-Attestation besitzt kein bekanntes Schema.",
  );
  const { attestationHash: ignoredHash, signature: ignoredSignature, ...payload } = attestation;
  void ignoredHash;
  void ignoredSignature;
  return sha256Bytes(serializeMapReleaseBuildEvidence(payload));
}

function validateRollbackAttestation(attestation, previousReleaseId) {
  invariant(
    [ROLLBACK_ATTESTATION_SCHEMA, RUNTIME_ROLLBACK_ATTESTATION_SCHEMA].includes(attestation?.schema)
      && attestation.previousReleaseId === previousReleaseId,
    "Rollback-Attestation gehört nicht zum belegten Vorgänger.",
  );
  invariant(
    attestation.packageManifest?.file === INSTALLED_PACKAGE_MANIFEST
      && Number.isSafeInteger(attestation.packageManifest.bytes)
      && attestation.packageManifest.bytes > 0
      && SHA256.test(attestation.packageManifest.sha256),
    "Rollback-Attestation bindet keinen kanonischen Paketmarker bytegenau.",
  );
  const deliveryFile = portablePath(attestation.deliveryManifest?.file, "Rollback-Attestation.deliveryManifest.file");
  invariant(
    Number.isSafeInteger(attestation.deliveryManifest.bytes)
      && attestation.deliveryManifest.bytes > 0
      && SHA256.test(attestation.deliveryManifest.sha256),
    "Rollback-Attestation bindet kein Delivery-Manifest bytegenau.",
  );
  const gate = attestation.approvalGate;
  const signature = attestation.signature;
  invariant(gate?.status === "passed" && gate.algorithm === "Ed25519", "Rollback-Attestation besitzt keine signierte Freigabe.");
  const keyId = stableId(gate.keyId, "Rollback-Attestation.approvalGate.keyId");
  invariant(signature?.algorithm === "Ed25519" && signature.keyId === keyId, "Rollback-Attestation besitzt keine konsistente Ed25519-Signaturhülle.");
  invariant(typeof signature.valueBase64 === "string", "Rollback-Attestation besitzt keine Ed25519-Signaturbytes.");
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  invariant(signatureBytes.length === 64 && signatureBytes.toString("base64") === signature.valueBase64, "Rollback-Attestation besitzt keine kanonischen Ed25519-Signaturbytes.");
  invariant(SHA256.test(attestation.attestationHash) && attestation.attestationHash === rollbackAttestationHash(attestation), "Rollback-Attestation besitzt keinen gültigen kanonischen Hash.");
  if (attestation.schema === RUNTIME_ROLLBACK_ATTESTATION_SCHEMA) validateRuntimeRollbackTuple(attestation.runtimeTuple, previousReleaseId);
  else invariant(attestation.runtimeTuple === undefined, "Legacy-Rollback-Attestation darf kein ungebundenes Runtime-Tuple vortaeuschen.");
  return { deliveryFile, keyId, attestationHash: attestation.attestationHash, schema: attestation.schema };
}

export async function createMapRollbackAttestation({ deploymentRoot, previousInstallPath, previousReleaseId, runtimeIdentity }) {
  const previous = await inspectInstalledMapPackage(deploymentRoot, previousInstallPath, previousReleaseId, "Rollbackrelease");
  const releaseEntry = previous.inventory.find(({ kind }) => kind === "release-manifest");
  invariant(releaseEntry !== undefined, "Rollbackrelease besitzt kein Delivery-Manifest.");
  const common = {
    previousReleaseId,
    packageManifest: {
      file: INSTALLED_PACKAGE_MANIFEST,
      bytes: previous.markerBytes.length,
      sha256: sha256Bytes(previous.markerBytes),
    },
    deliveryManifest: {
      file: releaseEntry.installPath,
      bytes: previous.releaseBytes.length,
      sha256: sha256Bytes(previous.releaseBytes),
    },
    approvalGate: { status: "missing" },
    signature: null,
  };
  if (runtimeIdentity === undefined) return { schema: ROLLBACK_ATTESTATION_SCHEMA, ...common };
  invariant(GIT_COMMIT.test(runtimeIdentity.sourceCommit) && !/^0+$/.test(runtimeIdentity.sourceCommit), "Runtime-Identitaet besitzt keinen unveraenderlichen Source-Commit.");
  invariant(OCI_DIGEST.test(runtimeIdentity.imageDigest), "Runtime-Identitaet besitzt keinen unveraenderlichen Image-Digest.");
  const installed = await inspectInstalledRuntimeTuple(previous, previousReleaseId);
  const world = await inspectSignedWorldDeployment(runtimeIdentity.worldDeploymentPath);
  const runtimeTuple = validateRuntimeRollbackTuple({
    ...installed,
    sourceCommit: runtimeIdentity.sourceCommit,
    imageDigest: runtimeIdentity.imageDigest,
    worldDeployment: {
      bytes: world.bytes.length,
      sha256: world.sha256,
      schema: "zugfolge-alpha-world-deployment/v1",
      worldId: world.worldId,
      deploymentHash: world.deploymentHash,
      worldEpoch: world.worldEpoch,
      repeatEveryS: world.repeatEveryS,
      keyId: world.keyId,
    },
  }, previousReleaseId);
  return { schema: RUNTIME_ROLLBACK_ATTESTATION_SCHEMA, ...common, runtimeTuple };
}

export function signMapRollbackAttestation(attestation, privateKeyPem, keyId) {
  invariant(attestation?.approvalGate?.status === "missing" && attestation.signature === null, "Nur eine explizit unsignierte Rollback-Attestation darf signiert werden.");
  stableId(keyId, "Rollback-Attestation-Schlüssel-ID");
  const privateKey = createPrivateKey(privateKeyPem);
  invariant(privateKey.asymmetricKeyType === "ed25519", "Rollback-Attestation verlangt einen Ed25519-Schlüssel.");
  const candidate = {
    ...attestation,
    approvalGate: { status: "passed", algorithm: "Ed25519", keyId },
    signature: null,
  };
  const attestationHash = rollbackAttestationHash(candidate);
  const signature = signEd25519(null, Buffer.from(attestationHash, "hex"), privateKey);
  return {
    ...candidate,
    attestationHash,
    signature: { algorithm: "Ed25519", keyId, valueBase64: signature.toString("base64") },
  };
}

function verifyMapRollbackAttestation(attestation, publicKeyPem) {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const signature = Buffer.from(attestation?.signature?.valueBase64 ?? "", "base64");
    return publicKey.asymmetricKeyType === "ed25519"
      && attestation?.attestationHash === rollbackAttestationHash(attestation)
      && signature.length === 64
      && verifyEd25519(null, Buffer.from(attestation.attestationHash, "hex"), publicKey, signature);
  } catch {
    return false;
  }
}

async function assessRuntimeRollbackTuple({ attestation, previous, previousReleaseId, runtimeIdentity, trustedKeys }) {
  if (attestation.schema !== RUNTIME_ROLLBACK_ATTESTATION_SCHEMA) {
    return { eligible: false, reason: "runtime-tuple-unbound-v1" };
  }
  if (runtimeIdentity === undefined) {
    return { eligible: false, reason: "runtime-identity-missing" };
  }
  invariant(GIT_COMMIT.test(runtimeIdentity.sourceCommit) && !/^0+$/.test(runtimeIdentity.sourceCommit), "Aktuelle Runtime besitzt keinen unveraenderlichen Source-Commit.");
  invariant(OCI_DIGEST.test(runtimeIdentity.imageDigest), "Aktuelle Runtime besitzt keinen unveraenderlichen Image-Digest.");
  invariant(typeof runtimeIdentity.worldDeploymentPath === "string" && runtimeIdentity.worldDeploymentPath.length > 0, "Aktuelle Runtime besitzt keinen Weltdeployment-Pfad.");
  const [installed, world] = await Promise.all([
    inspectInstalledRuntimeTuple(previous, previousReleaseId),
    inspectSignedWorldDeployment(runtimeIdentity.worldDeploymentPath, trustedKeys),
  ]);
  const actual = validateRuntimeRollbackTuple({
    ...installed,
    sourceCommit: runtimeIdentity.sourceCommit,
    imageDigest: runtimeIdentity.imageDigest,
    worldDeployment: {
      bytes: world.bytes.length,
      sha256: world.sha256,
      schema: "zugfolge-alpha-world-deployment/v1",
      worldId: world.worldId,
      deploymentHash: world.deploymentHash,
      worldEpoch: world.worldEpoch,
      repeatEveryS: world.repeatEveryS,
      keyId: world.keyId,
    },
  }, previousReleaseId);
  invariant(
    JSON.stringify(sortedValue(actual)) === JSON.stringify(sortedValue(attestation.runtimeTuple)),
    "Aktuelles Source-/Image-/Welt-/Map-Runtime-Tuple weicht von der signierten Rollback-Attestation ab.",
  );
  return { eligible: true, reason: "runtime-tuple-v2-verified" };
}

export async function writeMapRollbackAttestation(attestation, outputPath) {
  validateRollbackAttestation(attestation, attestation?.previousReleaseId);
  const bytes = serializeMapReleaseBuildEvidence(attestation);
  return { ...(await writeAtomicCreateNew(outputPath, bytes, "Rollback-Attestation")), bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

async function inspectActivationPointer(deploymentRoot, evidence, expectedActiveReleaseId) {
  invariant(
    expectedActiveReleaseId === evidence.previousReleaseId || expectedActiveReleaseId === evidence.releaseId,
    "Erwartetes aktives Kartenrelease muss explizit Kandidat oder belegter Vorgänger sein.",
  );
  const pointer = await containedRealPath(deploymentRoot, evidence.deployment.activationPointer, "Aktivierungszeiger");
  const bytes = await readFile(pointer);
  invariant(bytes.length > 0 && bytes.length <= 64 * 1024, "Aktivierungszeiger besitzt eine unzulässige Größe.");
  const text = bytes.toString("utf8");
  invariant(!text.includes("\r") && text.endsWith("\n"), "Aktivierungszeiger ist nicht als kanonische LF-env-Datei serialisiert.");
  const entries = text.slice(0, -1).split("\n").map((line) => {
    const match = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>[^\s"']+)$/.exec(line);
    invariant(match !== null, "Aktivierungszeiger enthält keine kanonische KEY=VALUE-Zeile.");
    return [match.groups.key, match.groups.value];
  });
  invariant(entries.length === ACTIVATION_POINTER_KEYS.length && new Set(entries.map(([key]) => key)).size === entries.length, "Aktivierungszeiger muss genau vier eindeutige Kartenwerte enthalten.");
  invariant(JSON.stringify(entries.map(([key]) => key).sort()) === JSON.stringify(ACTIVATION_POINTER_KEYS), "Aktivierungszeiger enthält fremde oder fehlende Kartenwerte.");
  const values = Object.fromEntries(entries);
  const releaseId = expectedActiveReleaseId;
  const installPath = releaseId === evidence.previousReleaseId
    ? evidence.deployment.previousInstallPath
    : evidence.deployment.candidateInstallPath;
  const expected = {
    MAP_RELEASE_ID: releaseId,
    MAP_RELEASE_HOST_DIR: installPath,
    MAP_BASEMAP_STYLE_URL: `/artifacts/maps/${releaseId}/style.json`,
    MAP_GERMANY_PMTILES_URL: `/artifacts/maps/${releaseId}/${releaseId}.pmtiles`,
  };
  invariant(ACTIVATION_POINTER_KEYS.every((key) => values[key] === expected[key]), `Aktivierungszeiger verweist nicht vollständig auf das explizit erwartete Release ${releaseId}.`);
  return {
    path: pointer,
    values,
    activeReleaseId: releaseId,
    state: releaseId === evidence.previousReleaseId ? "pre-activation" : "active-candidate",
  };
}

function trustedDeliveryPublicKey(trustedDeliveryKeys, keyId, label = "Delivery") {
  invariant(trustedDeliveryKeys !== null && typeof trustedDeliveryKeys === "object" && !Array.isArray(trustedDeliveryKeys), "Vertrauensanker für Delivery-Signaturen fehlen.");
  for (const [id, pem] of Object.entries(trustedDeliveryKeys)) {
    stableId(id, "Delivery-Vertrauensanker-ID");
    invariant(typeof pem === "string" && pem.includes("BEGIN PUBLIC KEY") && pem.includes("END PUBLIC KEY"), `Delivery-Vertrauensanker ${id} ist kein öffentlicher PEM-Schlüssel.`);
  }
  const publicKey = trustedDeliveryKeys[keyId];
  invariant(typeof publicKey === "string", `${label}-Signaturschlüssel ${keyId} ist nicht vertrauenswürdig.`);
  return publicKey;
}

export async function preflightMapReleaseActivation({ evidence, deploymentRoot, restoreProofBytes, restoreRoot, trustedDeliveryKeys, expectedActiveReleaseId, runtimeIdentity }) {
  validateMapReleaseBuildEvidence(evidence);
  const evidenceSha256 = sha256Bytes(serializeMapReleaseBuildEvidence(evidence));
  const activation = await inspectActivationPointer(deploymentRoot, evidence, expectedActiveReleaseId);
  const restoreProof = parseCanonicalRestoreProof(restoreProofBytes);
  invariant(typeof restoreRoot === "string" && restoreRoot.length > 0, "Preflight benötigt den tatsächlich wiederhergestellten Cachepfad.");
  const actualRestore = await proveBuildCacheRestore(evidence, restoreRoot);
  invariant(actualRestore.proofBytes.equals(restoreProofBytes), "Buildcache-Restore-Beleg weicht vom aktuell verifizierten Restore-Artefakt ab.");
  invariant(restoreProof?.schema === RESTORE_PROOF_SCHEMA && restoreProof.releaseId === evidence.releaseId, "Buildcache-Restore-Beleg gehört nicht zum Kandidaten.");
  invariant(restoreProof.evidenceSha256 === evidenceSha256, "Buildcache-Restore-Beleg bindet ein anderes Evidence-Manifest.");
  invariant(restoreProof.objectKey === evidence.buildCache.objectKey && restoreProof.encrypted === true && restoreProof.encryptionScheme === evidence.buildCache.encryptionScheme, "Buildcache-Restore-Beleg bindet nicht das verschlüsselte Backup.");
  invariant(restoreProof.restoredToPreparedEmptyPath === true && restoreProof.verification === "full-byte-inventory", "Buildcache wurde nicht vollständig auf einen vorbereiteten leeren Pfad wiederhergestellt.");
  invariant(typeof restoreProof.emptyRootNonce === "string" && UUID_V4.test(restoreProof.emptyRootNonce), "Buildcache-Restore-Beleg besitzt keinen Leerpfadnachweis.");
  invariant(restoreProof.verifiedFiles === evidence.buildCache.inventory.length, "Buildcache-Restore-Beleg besitzt eine abweichende Dateizahl.");
  invariant(restoreProof.verifiedBytes === evidence.buildCache.inventory.reduce((sum, entry) => sum + entry.bytes, 0), "Buildcache-Restore-Beleg besitzt eine abweichende Bytezahl.");
  const expectedInventorySha256 = sha256Bytes(Buffer.from(`${JSON.stringify(sortedValue(evidence.buildCache.inventory))}\n`, "utf8"));
  invariant(restoreProof.inventorySha256 === expectedInventorySha256, "Buildcache-Restore-Beleg bindet ein anderes Inventar.");
  invariant(SHA256.test(restoreProof.emptyRootMarkerSha256) && Number.isSafeInteger(restoreProof.emptyRootMarkerBytes) && restoreProof.emptyRootMarkerBytes > 0, "Buildcache-Restore-Beleg bindet keinen Leerpfadmarker bytegenau.");
  invariant(SHA256.test(restoreProof.restoreRootSha256) && SHA256.test(restoreProof.artifactBindingSha256), "Buildcache-Restore-Beleg besitzt keine kryptografische Artefaktbindung.");

  const candidate = await inspectInstalledMapPackage(deploymentRoot, evidence.deployment.candidateInstallPath, evidence.releaseId, "Kandidatenrelease");
  const previous = await inspectInstalledMapPackage(deploymentRoot, evidence.deployment.previousInstallPath, evidence.previousReleaseId, "Rollbackrelease");
  invariant(candidate.root !== previous.root, "Kandidat und Rollbackziel dürfen nicht dasselbe Verzeichnis sein.");

  const rollbackAttestationPath = await containedRealPath(deploymentRoot, evidence.deployment.rollbackAttestationPath, "Rollback-Attestation");
  const rollbackAttestationBytes = await readFile(rollbackAttestationPath);
  let rollbackAttestation;
  try {
    rollbackAttestation = JSON.parse(rollbackAttestationBytes.toString("utf8"));
  } catch {
    throw new Error("Rollback-Attestation ist kein gültiges JSON-Artefakt.");
  }
  invariant(rollbackAttestationBytes.equals(serializeMapReleaseBuildEvidence(rollbackAttestation)), "Rollback-Attestation ist nicht kanonisch serialisiert.");
  const rollbackSigned = validateRollbackAttestation(rollbackAttestation, evidence.previousReleaseId);
  const rollbackPublicKey = trustedDeliveryPublicKey(trustedDeliveryKeys, rollbackSigned.keyId, "Rollback-Attestation");
  invariant(
    verifyMapRollbackAttestation(rollbackAttestation, rollbackPublicKey),
    "Rollback-Attestation besitzt keine gültige vertrauenswürdige Ed25519-Signatur.",
  );
  const previousReleaseEntry = previous.inventory.find(({ kind }) => kind === "release-manifest");
  invariant(
    rollbackAttestation.packageManifest.file === INSTALLED_PACKAGE_MANIFEST
      && rollbackAttestation.packageManifest.bytes === previous.markerBytes.length
      && rollbackAttestation.packageManifest.sha256 === sha256Bytes(previous.markerBytes),
    "Rollback-Attestation weicht vom installierten kanonischen Paketmarker ab.",
  );
  invariant(
    previousReleaseEntry !== undefined
      && rollbackSigned.deliveryFile === previousReleaseEntry.installPath
      && rollbackAttestation.deliveryManifest.bytes === previous.releaseBytes.length
      && rollbackAttestation.deliveryManifest.sha256 === sha256Bytes(previous.releaseBytes),
    "Rollback-Attestation weicht vom installierten Delivery-Manifest ab.",
  );
  let rollbackRuntime;
  try {
    rollbackRuntime = await assessRuntimeRollbackTuple({
      attestation: rollbackAttestation,
      previous,
      previousReleaseId: evidence.previousReleaseId,
      runtimeIdentity,
      trustedKeys: trustedDeliveryKeys,
    });
  } catch (error) {
    if (expectedActiveReleaseId !== evidence.releaseId) throw error;
    rollbackRuntime = { eligible: false, reason: "runtime-tuple-mismatch" };
  }
  const deliveryOutput = evidence.outputs.find(({ kind }) => kind === "delivery-manifest");
  const installedDelivery = await fileProof(candidate.root, { file: deliveryOutput.installFile }, "Installiertes Delivery-Manifest");
  invariant(installedDelivery.bytes === deliveryOutput.bytes && installedDelivery.sha256 === deliveryOutput.sha256, "Installiertes Delivery-Manifest weicht vom Buildbeleg ab.");
  const deliveryBytes = await readFile(await containedRealPath(candidate.root, deliveryOutput.installFile, "Installiertes Delivery-Manifest"));
  const delivery = JSON.parse(deliveryBytes.toString("utf8"));
  invariant(deliveryBytes.equals(serializeDeliveryJson(delivery)), "Installiertes Delivery-Manifest ist nicht kanonisch serialisiert.");
  const signed = validateSignedDeliveryContract(delivery, evidence.releaseId, "Installiertes Delivery-Manifest");
  const publicKey = trustedDeliveryPublicKey(trustedDeliveryKeys, signed.keyId);
  invariant(verifyMapDeliveryReleaseSignature(delivery, publicKey), "Installiertes Delivery-Manifest besitzt keine gültige vertrauenswürdige Ed25519-Signatur.");
  const packageInventory = candidate.inventory
    .filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(JSON.stringify(sortedValue(packageInventory)) === JSON.stringify(sortedValue(evidence.deliveryInventory)), "Kandidaten-Paketinventar weicht vom signierten Delivery-Manifest ab.");
  invariant(candidate.manifest.packageId === delivery.packageId && candidate.manifest.version === delivery.packageVersion, "Kandidaten-Paketmarker ist nicht an den signierten Delivery-Vertrag gebunden.");
  const releaseEntry = candidate.inventory.find(({ kind }) => kind === "release-manifest");
  invariant(releaseEntry?.installPath === deliveryOutput.installFile && releaseEntry.bytes === installedDelivery.bytes && releaseEntry.sha256 === installedDelivery.sha256, "Kandidaten-Paketmarker bindet das signierte Delivery-Manifest nicht bytegenau.");
  const sourcesEntry = candidate.inventory.find(({ kind }) => kind === "source-manifest");
  invariant(sourcesEntry !== undefined && sourcesEntry.sha256 === delivery.bindings?.sourcesSha256, "Kandidaten-Paketmarker bindet den signierten Quellenbeleg nicht bytegenau.");
  for (const artifact of evidence.deliveryInventory) {
    let proof;
    try {
      proof = await fileProof(candidate.root, { file: artifact.installPath }, `Installiertes Delivery-Artefakt ${artifact.id}`);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Installiertes Delivery-Artefakt ${artifact.id} fehlt.`);
      throw error;
    }
    invariant(proof.bytes === artifact.bytes && proof.sha256 === artifact.sha256, `Installiertes Delivery-Artefakt ${artifact.id} weicht vom Delivery-Manifest ab.`);
  }
  return {
    releaseId: evidence.releaseId,
    previousReleaseId: evidence.previousReleaseId,
    activationEligible: true,
    rollbackEligible: rollbackRuntime.eligible,
    rollbackEligibilityReason: rollbackRuntime.reason,
    activationMode: "atomic-config-swap",
    activationState: activation.state,
    activeReleaseId: activation.activeReleaseId,
    activationPointer: evidence.deployment.activationPointer,
    activationPointerPath: activation.path,
    candidateRoot: candidate.root,
    previousRoot: previous.root,
    deliveryKeyId: signed.keyId,
    deliveryReleaseHash: signed.releaseHash,
    rollbackAttestationPath,
    rollbackAttestationSchema: rollbackSigned.schema,
    rollbackAttestationKeyId: rollbackSigned.keyId,
    rollbackAttestationHash: rollbackSigned.attestationHash,
    evidenceSha256,
    verifiedDeliveryArtifacts: evidence.deliveryInventory.length,
  };
}

export const MAP_RELEASE_BUILD_EVIDENCE_SCHEMAS = Object.freeze({
  spec: SPEC_SCHEMA,
  evidence: EVIDENCE_SCHEMA,
  cacheInventory: CACHE_INVENTORY_SCHEMA,
  restoreProof: RESTORE_PROOF_SCHEMA,
  rollbackAttestation: ROLLBACK_ATTESTATION_SCHEMA,
  runtimeRollbackAttestation: RUNTIME_ROLLBACK_ATTESTATION_SCHEMA,
  runtimeRollbackTuple: RUNTIME_ROLLBACK_TUPLE_SCHEMA,
});
