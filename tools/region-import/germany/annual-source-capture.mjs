import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const ANNUAL_SOURCE_CAPTURE_PLAN_SCHEMA = "zugfolge-germany-source-capture-plan/v1";
export const ANNUAL_SOURCE_CAPTURE_SCHEMA = "zugfolge-source-capture/v2";

const SHA256 = /^[a-f0-9]{64}$/u;
const GERMANY_2026_RELEASE_ID = /^infra-deutschland-(?<year>20\d{2})\.(?<patch>[1-9]\d*)$/u;
const REQUIRED_2026_SOURCES = [
  "copernicus-dem-germany",
  "db-infrago-infrastructure-open-data",
  "geofabrik-germany-pbf",
  "gtfs-de-regional-rail",
  "openstation-enrichment",
];
const REQUIRED_FORBIDDEN_SOURCES = [
  "annual-infrastructure-master",
  "internal-station-plan-evidence",
  "station-enrichment",
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  invariant(Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"), `${label} besitzt unerwartete oder fehlende Felder.`);
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value !== "" && !isAbsolute(value), `${label} muss ein relativer Pfad sein.`);
  const normalized = value.replaceAll("\\", "/");
  invariant(normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../"), `${label} verlaesst die Wurzel.`);
  return normalized;
}

function sortedUnique(values, label) {
  invariant(Array.isArray(values) && values.every((value) => typeof value === "string" && value !== ""), `${label} muss eine Textliste sein.`);
  const sorted = [...values].sort((left, right) => left.localeCompare(right, "en"));
  invariant(JSON.stringify(values) === JSON.stringify(sorted) && new Set(values).size === values.length, `${label} muss stabil sortiert und eindeutig sein.`);
  return values;
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

async function containedRegularFile(root, relativeFile, label) {
  const requested = resolve(root, portablePath(relativeFile, label));
  const remainder = relative(root, requested);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlaesst die Wurzel.`);
  const metadata = await lstat(requested);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${label} ist keine regulaere nichtleere Datei.`);
  const actual = await realpath(requested);
  const actualRemainder = relative(root, actual);
  invariant(actualRemainder !== "" && !actualRemainder.startsWith("..") && !isAbsolute(actualRemainder), `${label} verlaesst die Wurzel ueber einen Link.`);
  return actual;
}

function indexUnique(entries, label) {
  invariant(Array.isArray(entries), `${label} muss eine Liste sein.`);
  const result = new Map();
  for (const entry of entries) {
    invariant(typeof entry?.id === "string" && entry.id !== "" && !result.has(entry.id), `${label} besitzt eine fehlende oder doppelte ID.`);
    result.set(entry.id, entry);
  }
  return result;
}

export function validateAnnualSourceCapturePlan(plan, catalog, rightsRegistry) {
  exactKeys(plan, ["schema", "releaseId", "timetableYear", "notBefore", "forbiddenSourceIds", "sources"], "Jahres-Capture-Plan");
  invariant(plan.schema === ANNUAL_SOURCE_CAPTURE_PLAN_SCHEMA, "Jahres-Capture-Plan besitzt ein unbekanntes Schema.");
  const release = typeof plan.releaseId === "string" ? GERMANY_2026_RELEASE_ID.exec(plan.releaseId) : null;
  invariant(
    release !== null && Number(release.groups.year) === 2026 && Number(release.groups.patch) >= 3 && plan.timetableYear === 2026,
    "Jahres-Capture-Plan ist kein gueltiger Deutschland-2026-Jahrespatch ab Patch 3.",
  );
  const notBefore = Date.parse(plan.notBefore);
  invariant(Number.isFinite(notBefore) && plan.notBefore.endsWith("Z"), "notBefore ist kein UTC-Zeitpunkt.");
  sortedUnique(plan.forbiddenSourceIds, "forbiddenSourceIds");
  for (const id of REQUIRED_FORBIDDEN_SOURCES) invariant(plan.forbiddenSourceIds.includes(id), `${id} muss im Deutschland-2026-Capture explizit verboten sein.`);

  invariant(catalog?.schema === "zugfolge-germany-source-catalog/v1", "Unbekannter Deutschland-Quellkatalog.");
  invariant(Number.isSafeInteger(rightsRegistry?.version), "Unbekanntes Rechte-Register.");
  const catalogById = indexUnique(catalog.sources, "Deutschland-Quellkatalog");
  const rightsById = indexUnique(rightsRegistry.quellen, "Rechte-Register");
  invariant(Array.isArray(plan.sources), "Jahres-Capture-Plan besitzt keine Quellenliste.");
  const sourceIds = plan.sources.map(({ id }) => id);
  sortedUnique(sourceIds, "sources.id");
  invariant(JSON.stringify(sourceIds) === JSON.stringify(REQUIRED_2026_SOURCES), "Deutschland-2026-Capture muss exakt die fuenf freigegebenen Pflichtquellen binden.");
  const catalogRequired = catalog.sources.filter(({ role }) => role === "release-input").map(({ id }) => id).sort((left, right) => left.localeCompare(right, "en"));
  invariant(JSON.stringify(catalogRequired) === JSON.stringify(REQUIRED_2026_SOURCES), "Quellkatalog und Jahres-Capture nennen nicht exakt dieselben fuenf Pflichtquellen.");

  for (const source of plan.sources) {
    if (source.kind === "file") {
      exactKeys(source, ["id", "kind", "version", "input", "captureFile", "bytes", "sha256"], `Capturequelle ${source.id}`);
      source.input = portablePath(source.input, `${source.id}.input`);
    } else if (source.kind === "dem-tile-set") {
      exactKeys(source, ["id", "kind", "version", "manifest", "directory", "captureFile", "manifestBytes", "manifestSha256", "bytes", "sha256"], `Capturequelle ${source.id}`);
      source.manifest = portablePath(source.manifest, `${source.id}.manifest`);
      source.directory = portablePath(source.directory, `${source.id}.directory`);
    } else {
      throw new Error(`Capturequelle ${source.id} besitzt eine unbekannte Art.`);
    }
    source.captureFile = portablePath(source.captureFile, `${source.id}.captureFile`);
    invariant(typeof source.version === "string" && source.version !== "" && Number.isSafeInteger(source.bytes) && source.bytes > 0 && SHA256.test(source.sha256), `Capturequelle ${source.id} besitzt keine vollstaendige Version-/Byte-/SHA-Bindung.`);
    const catalogSource = catalogById.get(source.id);
    invariant(catalogSource?.role === "release-input" && catalogSource.shipAttribution === true, `Capturequelle ${source.id} ist keine auslieferbare Pflichtquelle.`);
    invariant(!plan.forbiddenSourceIds.includes(source.id), `Capturequelle ${source.id} ist zugleich verboten.`);
    const rights = rightsById.get(catalogSource.rightsSourceId);
    invariant(rights?.status === "freigegeben" && typeof rights.entscheidung?.datum === "string" && typeof rights.entscheidung?.pruefer === "string", `Capturequelle ${source.id} besitzt keine datierte Rechtefreigabe.`);
  }
  return plan;
}

async function verifyFileSource(root, source) {
  const path = await containedRegularFile(root, source.input, `${source.id}.input`);
  const proof = await sha256File(path);
  invariant(proof.bytes === source.bytes && proof.sha256 === source.sha256, `Capturequelle ${source.id} verletzt die gepinnte Byte-/SHA-Bindung.`);
  return { id: source.id, version: source.version, file: source.captureFile, ...proof };
}

function aggregateTileHash(tiles) {
  return createHash("sha256").update(tiles.map(({ tileId, sha256 }) => `${tileId}:${sha256}\n`).join("")).digest("hex");
}

async function verifyDemSource(root, source) {
  invariant(Number.isSafeInteger(source.manifestBytes) && source.manifestBytes > 0 && SHA256.test(source.manifestSha256), "DEM-Capture-Manifest besitzt keine Byte-/SHA-Bindung.");
  const manifestPath = await containedRegularFile(root, source.manifest, `${source.id}.manifest`);
  const manifestProof = await sha256File(manifestPath);
  invariant(manifestProof.bytes === source.manifestBytes && manifestProof.sha256 === source.manifestSha256, "DEM-Capture-Manifest verletzt die gepinnte Byte-/SHA-Bindung.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  invariant(manifest?.schema === "zugfolge-copernicus-dem-capture/v1" && manifest.source?.sourceId === source.id, "DEM-Capture-Manifest bindet eine fremde Quelle.");
  invariant(Array.isArray(manifest.tiles) && manifest.tiles.length > 0, "DEM-Capture-Manifest besitzt keine Kacheln.");
  const tileIds = manifest.tiles.map(({ tileId }) => tileId);
  sortedUnique(tileIds, "DEM-Kachel-IDs");
  const directory = resolve(root, portablePath(source.directory, `${source.id}.directory`));
  let bytes = 0;
  for (const tile of manifest.tiles) {
    invariant(typeof tile.file === "string" && tile.file !== "" && !tile.file.includes("/") && !tile.file.includes("\\"), `DEM-Kachel ${tile.tileId} besitzt keinen sicheren Dateinamen.`);
    invariant(Number.isSafeInteger(tile.bytes) && tile.bytes > 0 && SHA256.test(tile.sha256), `DEM-Kachel ${tile.tileId} besitzt keine Byte-/SHA-Bindung.`);
    const path = await containedRegularFile(directory, tile.file, `DEM-Kachel ${tile.tileId}`);
    const proof = await sha256File(path);
    invariant(proof.bytes === tile.bytes && proof.sha256 === tile.sha256, `DEM-Kachel ${tile.tileId} verletzt die Byte-/SHA-Bindung.`);
    bytes += proof.bytes;
  }
  invariant(bytes === source.bytes && manifest.aggregateTileSha256 === source.sha256 && aggregateTileHash(manifest.tiles) === source.sha256, "DEM-Kachelsatz verletzt die aggregierte Byte-/SHA-Bindung.");
  return { id: source.id, version: source.version, file: source.captureFile, bytes, sha256: source.sha256 };
}

export async function buildAnnualSourceCapture({ plan: planInput, catalog, rightsRegistry, sourceRoot, capturedAt, capturePlanSha256 }) {
  const plan = validateAnnualSourceCapturePlan(planInput, catalog, rightsRegistry);
  invariant(SHA256.test(capturePlanSha256), "Capture-Plan besitzt keinen Dateihash.");
  const captureTime = Date.parse(capturedAt);
  invariant(Number.isFinite(captureTime) && capturedAt.endsWith("Z") && captureTime >= Date.parse(plan.notBefore), "Capture-Zeitpunkt ist nicht frisch oder nicht UTC.");
  const root = await realpath(resolve(sourceRoot));
  const sources = [];
  for (const source of plan.sources) sources.push(source.kind === "file" ? await verifyFileSource(root, source) : await verifyDemSource(root, source));
  return {
    schema: ANNUAL_SOURCE_CAPTURE_SCHEMA,
    releaseId: plan.releaseId,
    timetableYear: plan.timetableYear,
    capturePlanSha256,
    capturedAt,
    sources,
  };
}

export async function sha256AnnualSourceCapturePlan(path) {
  return (await sha256File(path)).sha256;
}
