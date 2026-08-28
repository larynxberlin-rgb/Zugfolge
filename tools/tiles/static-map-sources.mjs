import { open, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { validateMapAssetNotices } from "./map-asset-notices.mjs";
import { assertCreateNewTarget, publishFileCreateNew } from "./create-new-output.mjs";

export const STATIC_MAP_SOURCES_MATERIALIZATION_SCHEMA = "zugfolge-static-map-sources-materialization/v3";
export const STATIC_MAP_SOURCES_SCHEMA = "zugfolge-static-map-sources/v3";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const FORBIDDEN_PUBLIC_TOKEN = /(?:stada|(?:^|[^a-z0-9])station-enrichment(?:$|[^a-z0-9])|internal-station-plan|(?:^|[^a-z0-9])apn(?:$|[^a-z0-9])|trassenfinder)/i;

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

function serialize(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function safeId(value, label) {
  invariant(typeof value === "string" && SAFE_ID.test(value), `${label} ist keine sichere ID.`);
  return value;
}

function sortedUniqueIds(values, label) {
  invariant(Array.isArray(values) && values.every((value) => typeof value === "string" && SAFE_ID.test(value)), `${label} ist keine ID-Liste.`);
  const sorted = [...values].sort((left, right) => left.localeCompare(right, "en"));
  invariant(new Set(sorted).size === sorted.length, `${label} enthaelt doppelte IDs.`);
  invariant(JSON.stringify(values) === JSON.stringify(sorted), `${label} muss stabil sortiert sein.`);
  return values;
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  invariant(Object.keys(value).sort().join(",") === [...expected].sort().join(","), `${label} besitzt unerwartete oder fehlende Felder.`);
}

function validateSpec(spec) {
  exactKeys(spec, ["schema", "releaseId", "infrastructure", "basemap"], "Sources-Materialisierung");
  invariant(spec.schema === STATIC_MAP_SOURCES_MATERIALIZATION_SCHEMA, "Unbekannte Sources-Materialisierung; nur v3 mit gebundenen Asset-Notices ist auslieferbar.");
  safeId(spec.releaseId, "releaseId");
  exactKeys(spec.infrastructure, ["forbiddenSourceIds"], "infrastructure");
  sortedUniqueIds(spec.infrastructure.forbiddenSourceIds, "infrastructure.forbiddenSourceIds");
  invariant(spec.infrastructure.forbiddenSourceIds.includes("station-enrichment"), "Der nie erfasste StaDa-Kandidat muss fuer den Deutschland-Jahrespatch explizit als Capturequelle verboten bleiben.");
  invariant(spec.infrastructure.forbiddenSourceIds.includes("internal-station-plan-evidence"), "Interne Stationsplanevidenz muss als Capturequelle verboten bleiben.");
  invariant(spec.infrastructure.forbiddenSourceIds.includes("annual-infrastructure-master"), "Der nicht lizenzierte historische Infrastruktur-Master muss fuer den Deutschland-Jahrespatch explizit als Capturequelle verboten bleiben.");
  exactKeys(spec.basemap, ["includedSourceIds", "excludedCapturedSourceIds"], "basemap");
  sortedUniqueIds(spec.basemap.includedSourceIds, "basemap.includedSourceIds");
  sortedUniqueIds(spec.basemap.excludedCapturedSourceIds, "basemap.excludedCapturedSourceIds");
  invariant(spec.basemap.includedSourceIds.length > 0, "Mindestens eine gepinnte Basemapquelle muss enthalten sein.");
  invariant(new Set([...spec.basemap.includedSourceIds, ...spec.basemap.excludedCapturedSourceIds]).size === spec.basemap.includedSourceIds.length + spec.basemap.excludedCapturedSourceIds.length, "Basemapquelle kann nicht zugleich enthalten und ausgeschlossen sein.");
  return spec;
}

function indexUnique(entries, label) {
  invariant(Array.isArray(entries), `${label} muss eine Liste sein.`);
  const byId = new Map();
  for (const entry of entries) {
    safeId(entry?.id, `${label}.id`);
    invariant(!byId.has(entry.id), `${label} enthaelt ${entry.id} doppelt.`);
    byId.set(entry.id, entry);
  }
  return byId;
}

function validateCaptureEntry(entry, label) {
  invariant(typeof entry.version === "string" && entry.version !== "", `${label} besitzt keine gepinnte Version.`);
  invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `${label} besitzt keinen Byte-SHA-Capturebeleg.`);
  return entry;
}

function approvedRights(rightsById, source, label) {
  const rights = rightsById.get(source.rightsSourceId);
  invariant(rights?.status === "freigegeben" && typeof rights.entscheidung?.datum === "string" && typeof rights.entscheidung?.pruefer === "string", `${label} besitzt keine vollstaendige Rechtefreigabe.`);
  invariant(typeof source.sourceLicense === "string" && source.sourceLicense !== "", `${label} besitzt keine Lizenz.`);
  invariant(typeof source.attribution === "string" && source.attribution !== "", `${label} besitzt keine Attribution.`);
  invariant(typeof source.modifications === "string" && source.modifications !== "", `${label} beschreibt die Bearbeitung nicht.`);
}

function publicSource(scope, source, capture) {
  const value = {
    id: `${scope}-${source.id}`,
    scope,
    approved: true,
    license: source.sourceLicense,
    attribution: source.attribution,
    modifications: source.modifications,
    version: capture.version,
    capture: { bytes: capture.bytes, sha256: capture.sha256 },
  };
  invariant(!FORBIDDEN_PUBLIC_TOKEN.test(JSON.stringify(value)), `${source.id} wuerde eine interne, nie erfasste oder nicht auslieferbare Quellenreferenz veroeffentlichen.`);
  return value;
}

export function buildStaticMapSources({ spec: specInput, infrastructureCatalog, infrastructureCapture, mapCatalog, mapCapture, rightsRegistry, assetNotices: assetNoticesInput }) {
  const spec = validateSpec(specInput);
  invariant(infrastructureCatalog?.schema === "zugfolge-germany-source-catalog/v1", "Unbekannter Deutschland-Quellkatalog.");
  invariant(infrastructureCapture?.schema === "zugfolge-source-capture/v2", "Der Deutschland-Jahrespatch verlangt ein frisches Source-Capture v2.");
  invariant(infrastructureCapture.releaseId === spec.releaseId && infrastructureCapture.timetableYear === 2026 && SHA256.test(infrastructureCapture.capturePlanSha256), "Deutschland-Source-Capture ist nicht an den aktuellen Jahresvertrag gebunden.");
  invariant(mapCatalog?.schema === "zugfolge-map-source-catalog/v2" && Array.isArray(mapCatalog.assetSources), "Unbekannter Karten-Quellkatalog; Sources-v3 verlangt die Asset-Provenienz aus v2.");
  invariant(mapCapture?.schema === "zugfolge-map-source-capture/v2", "Unbekanntes Karten-Source-Capture; Sources-v3 verlangt erfasste Assetbaeume aus v2.");
  invariant(SHA256.test(mapCapture.assetInventoryPlanSha256), "Karten-Source-Capture besitzt keinen Cache-Inventarplan-SHA fuer die Assetbaeume.");
  invariant(Number.isSafeInteger(rightsRegistry?.version), "Unbekanntes Rechte-Register.");

  const rightsById = indexUnique(rightsRegistry.quellen, "Rechte-Register");
  const assetNotices = validateMapAssetNotices(assetNoticesInput);
  const capturedAssetNotices = validateMapAssetNotices(mapCapture.assetNotices);
  invariant(JSON.stringify(sortedValue(assetNotices)) === JSON.stringify(sortedValue(capturedAssetNotices)), "Asset-Notices aus Karten-Capture und Materialisierungsvertrag weichen ab.");
  const infrastructureCatalogById = indexUnique(infrastructureCatalog.sources, "Deutschland-Quellkatalog");
  const infrastructureCaptureById = indexUnique(infrastructureCapture.sources, "Deutschland-Source-Capture");
  const mapCatalogById = indexUnique(mapCatalog.sources, "Karten-Quellkatalog");
  const mapCaptureById = indexUnique(mapCapture.sources, "Karten-Source-Capture");

  for (const forbiddenId of spec.infrastructure.forbiddenSourceIds) {
    const forbiddenCatalogSource = infrastructureCatalogById.get(forbiddenId);
    invariant(forbiddenCatalogSource === undefined || !["release-input", "optional-release-input"].includes(forbiddenCatalogSource.role), `Verbotene Quelle ${forbiddenId} darf im aktiven Katalog keine Releasequelle sein.`);
    invariant(!infrastructureCaptureById.has(forbiddenId), `Verbotene oder nie verwendete Quelle ${forbiddenId} darf nicht im Capture stehen.`);
  }
  for (const source of infrastructureCatalog.sources) {
    if (source.role === "release-input") invariant(infrastructureCaptureById.has(source.id), `Pflichtquelle ${source.id} fehlt im gepinnten Capture.`);
  }

  const sources = [];
  for (const capture of infrastructureCapture.sources) {
    validateCaptureEntry(capture, `Deutschland-Source-Capture.${capture.id}`);
    const source = infrastructureCatalogById.get(capture.id);
    invariant(source !== undefined, `Capturequelle ${capture.id} fehlt im Deutschland-Katalog.`);
    invariant(!spec.infrastructure.forbiddenSourceIds.includes(source.id), `Capturequelle ${source.id} ist fuer den Deutschland-Jahrespatch explizit verboten.`);
    invariant(["release-input", "optional-release-input"].includes(source.role), `Capturequelle ${source.id} ist keine auslieferbare Releasequelle.`);
    invariant(source.shipAttribution === true, `Capturequelle ${source.id} darf nicht oeffentlich attribuiert werden.`);
    approvedRights(rightsById, source, `Deutschland-Quelle ${source.id}`);
    sources.push(publicSource("infrastructure", source, capture));
  }

  const selectedMapIds = new Set(spec.basemap.includedSourceIds);
  const excludedMapIds = new Set(spec.basemap.excludedCapturedSourceIds);
  invariant(
    mapCaptureById.size === selectedMapIds.size + excludedMapIds.size
      && [...mapCaptureById.keys()].every((id) => selectedMapIds.has(id) || excludedMapIds.has(id)),
    "Karten-Source-Capture enthaelt eine weder ausgewaehlte noch explizit ausgeschlossene Quelle.",
  );
  for (const id of spec.basemap.includedSourceIds) {
    const source = mapCatalogById.get(id);
    const capture = mapCaptureById.get(id);
    invariant(source !== undefined && capture !== undefined, `Ausgewaehlte Basemapquelle ${id} fehlt in Katalog oder Capture.`);
    validateCaptureEntry(capture, `Karten-Source-Capture.${id}`);
    approvedRights(rightsById, source, `Basemapquelle ${id}`);
    sources.push(publicSource("basemap", source, capture));
  }
  for (const id of spec.basemap.excludedCapturedSourceIds) {
    invariant(mapCatalogById.has(id) && mapCaptureById.has(id), `Explizit ausgeschlossene Kartenquelle ${id} fehlt in Katalog oder Capture.`);
  }

  for (const asset of assetNotices.assets) {
    const rights = rightsById.get(asset.rightsSourceId);
    invariant(rights?.status === "freigegeben" && rights.lizenz === asset.license && typeof rights.entscheidung?.datum === "string" && typeof rights.entscheidung?.pruefer === "string", `Kartenasset ${asset.id} besitzt keine eigenstaendige, passende Rechtefreigabe.`);
    const catalogAsset = mapCatalog.assetSources.find(({ id }) => id === asset.id);
    invariant(catalogAsset !== undefined, `Kartenasset ${asset.id} fehlt im Karten-Quellkatalog.`);
    invariant(
      catalogAsset.kind === asset.kind
        && catalogAsset.rightsSourceId === asset.rightsSourceId
        && catalogAsset.sourceLicense === asset.license
        && catalogAsset.copyright === asset.copyright
        && catalogAsset.modifications === asset.modifications
        && typeof catalogAsset.attribution === "string"
        && catalogAsset.attribution !== ""
        && JSON.stringify(sortedValue(catalogAsset.source)) === JSON.stringify(sortedValue(asset.source))
        && JSON.stringify(sortedValue(catalogAsset.derivedFrom)) === JSON.stringify(sortedValue(asset.derivedFrom))
        && JSON.stringify(sortedValue(catalogAsset.notice)) === JSON.stringify(sortedValue({ url: asset.notice.url, bytes: asset.notice.bytes, sha256: asset.notice.sha256 })),
      `Kartenasset ${asset.id} weicht zwischen Karten-Katalog und Capture ab.`,
    );
  }
  invariant(mapCatalog.assetSources.length === assetNotices.assets.length, "Karten-Quellkatalog enthaelt ein nicht erfasstes Asset.");

  sources.sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(new Set(sources.map(({ id }) => id)).size === sources.length, "Oeffentliche Quellen-IDs sind doppelt.");
  invariant(sources.some(({ scope }) => scope === "basemap") && sources.some(({ scope }) => scope === "infrastructure"), "Sources-Manifest braucht Basemap- und Infrastrukturquellen.");
  const result = {
    schema: STATIC_MAP_SOURCES_SCHEMA,
    releaseId: spec.releaseId,
    sources,
    assetInventoryPlanSha256: mapCapture.assetInventoryPlanSha256,
    assetNotices,
  };
  invariant(!FORBIDDEN_PUBLIC_TOKEN.test(JSON.stringify(result)), "Sources-Manifest enthaelt StaDa oder eine interne Validierungsreferenz.");
  return result;
}

export function serializeStaticMapSources(value) {
  invariant(value?.schema === STATIC_MAP_SOURCES_SCHEMA && Array.isArray(value.sources) && value.sources.length > 0, "Unbekanntes statisches Sources-Manifest.");
  validateMapAssetNotices(value.assetNotices);
  return serialize(value);
}

async function writeDurable(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeStaticMapSources(value, outputPathInput) {
  const bytes = serializeStaticMapSources(value);
  const outputPath = resolve(outputPathInput);
  const outputParent = dirname(outputPath);
  await assertCreateNewTarget(outputPath, "Static-Map-Sources-Ziel");
  await mkdir(outputParent, { recursive: true });
  const temporaryRoot = await mkdtemp(join(outputParent, `.${basename(outputPath)}.materializing-`));
  const temporaryPath = join(temporaryRoot, basename(outputPath));
  try {
    await writeDurable(temporaryPath, bytes);
    await publishFileCreateNew(temporaryPath, outputPath, "Static-Map-Sources-Ziel");
    return { status: "materialized", outputPath, bytes: bytes.length };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
