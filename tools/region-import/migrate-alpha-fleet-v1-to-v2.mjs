import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { alphaCanonicalJson } from "../../packages/alpha/dist/index.js";
import { buildEconomyRelease } from "../../packages/economy/dist/index.js";
import { canonicalPlanningJson } from "../../packages/gtfs/dist/index.js";
import {
  ALPHA_MINIMUM_TURNAROUND_S,
  alphaServiceLotIdentifiers,
  assertSignedGtfsTimetableBinding,
  streamTimetableRouteBindings,
  unwrapInfraReleaseManifest,
  validateAlphaWorldBuildConfiguration,
} from "./build-alpha-world.mjs";
import { operationalInfrastructureV2Binding } from "./operational-infrastructure-binding.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTRACT_SPECIFICATION_SCHEMA = "zugfolge-alpha-fleet-v1-migration-contract-specification/v1";
const CONTRACT_SCHEMA = "zugfolge-alpha-fleet-v1-migration-contract/v2";
const RECEIPT_SCHEMA = "zugfolge-alpha-fleet-v1-migration-receipt/v2";
const SOURCE_SCHEMA = "zugfolge-vehicle-catalog-source/v2";
const SEED_SCHEMA = "zugfolge-vehicle-world-seed/v3";
const ECONOMY_PROJECTION_SCHEMA = "zugfolge-vehicle-economy-projection/v2";
const SOURCE_OUTPUT_FILE = "vehicle-catalog-source-v2.json";
const SEED_OUTPUT_FILE = "vehicle-world-seed-v3.json";
const COMPILER_OUTPUT_DIRECTORY = "compiled";
const MIGRATION_RECEIPT_FILE = "alpha-fleet-v1-migration-receipt-v2.json";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, name) {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${name} ist kein Objekt.`);
  return value;
}

function exactKeys(value, expected, name) {
  const keys = Object.keys(record(value, name)).sort();
  const wanted = [...expected].sort();
  invariant(keys.length === wanted.length && keys.every((key, index) => key === wanted[index]), `${name} besitzt fehlende oder unbekannte Felder.`);
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value.trim() !== "" && value.trim() === value, `${name} fehlt oder besitzt Rand-Leerzeichen.`);
  return value;
}

function positiveInteger(value, name) {
  invariant(Number.isSafeInteger(value) && value > 0, `${name} ist keine positive sichere Ganzzahl.`);
  return value;
}

function nonNegativeInteger(value, name) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${name} ist keine nichtnegative sichere Ganzzahl.`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value) {
  return sha256(alphaCanonicalJson(value));
}

function prettySha256(value) {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

function validateMigrationContractCore(value, name) {
  exactKeys(value.legacy, ["file", "bytes", "sha256", "worldId", "authorityReleaseId", "authorityReleaseSha256", "assetCount"], `${name}.legacy`);
  invariant(value.legacy.file === "alpha-world-deployment.json", "Fleet-v1-Migrationsvertrag bindet keinen kanonischen Legacy-Dateinamen.");
  positiveInteger(value.legacy.bytes, "Fleet-v1-Migrationsvertrag.legacy.bytes");
  invariant(SHA256.test(value.legacy.sha256) && SHA256.test(value.legacy.authorityReleaseSha256), "Fleet-v1-Migrationsvertrag besitzt keine vollstaendigen Legacy-Hashes.");
  nonEmptyString(value.legacy.worldId, "Fleet-v1-Migrationsvertrag.legacy.worldId");
  nonEmptyString(value.legacy.authorityReleaseId, "Fleet-v1-Migrationsvertrag.legacy.authorityReleaseId");
  positiveInteger(value.legacy.assetCount, "Fleet-v1-Migrationsvertrag.legacy.assetCount");
  exactKeys(value.target, ["sourceCatalogReleaseId", "seedId", "authorityReleaseId", "operationalReleaseId", "gtfsReleaseId", "worldId", "producedAt", "referenceYear"], "Fleet-v1-Migrationsvertrag.target");
  for (const field of ["sourceCatalogReleaseId", "seedId", "authorityReleaseId", "operationalReleaseId", "gtfsReleaseId"]) nonEmptyString(value.target[field], `Fleet-v1-Migrationsvertrag.target.${field}`);
  invariant(/^gtfs-de-rv-20[0-9]{6}-[a-f0-9]{16}$/u.test(value.target.gtfsReleaseId), "Fleet-v1-Migrationsvertrag.target.gtfsReleaseId besitzt keinen autoritativen GTFS-v2-Namespace.");
  invariant(UUID.test(value.target.worldId), "Fleet-v1-Migrationsvertrag.target.worldId ist keine UUID-v4.");
  nonNegativeInteger(value.target.producedAt, "Fleet-v1-Migrationsvertrag.target.producedAt");
  positiveInteger(value.target.referenceYear, "Fleet-v1-Migrationsvertrag.target.referenceYear");
  exactKeys(value.source, ["id", "title", "url", "license", "retrievedAt", "contentSha256", "rightsDecision"], "Fleet-v1-Migrationsvertrag.source");
  for (const field of ["id", "title", "license", "retrievedAt"]) nonEmptyString(value.source[field], `Fleet-v1-Migrationsvertrag.source.${field}`);
  invariant(/^https:\/\/\S+$/u.test(value.source.url), "Fleet-v1-Migrationsvertrag.source.url ist keine HTTPS-Fundstelle.");
  invariant(value.source.contentSha256 === value.legacy.authorityReleaseSha256, "Quellenbeleg bindet nicht den kanonischen Legacy-Authority-Inhalt.");
  exactKeys(value.source.rightsDecision, ["status", "decidedAt", "reviewer", "reference"], "Fleet-v1-Migrationsvertrag.source.rightsDecision");
  invariant(value.source.rightsDecision.status === "freigegeben", "Legacy-Authority ist nicht ausdruecklich freigegeben.");
  for (const field of ["decidedAt", "reviewer", "reference"]) nonEmptyString(value.source.rightsDecision[field], `Fleet-v1-Migrationsvertrag.source.rightsDecision.${field}`);
}

function validateJsonArtifactPin(value, name) {
  exactKeys(value, ["file", "bytes", "sha256", "canonicalSha256"], name);
  const file = nonEmptyString(value.file, `${name}.file`);
  invariant(basename(file) === file, `${name}.file ist kein einfacher Dateiname.`);
  positiveInteger(value.bytes, `${name}.bytes`);
  invariant(SHA256.test(value.sha256) && SHA256.test(value.canonicalSha256), `${name} besitzt keine vollstaendigen SHA-256-Bindungen.`);
}

export function validateAlphaFleetMigrationContractSpecification(value) {
  exactKeys(value, ["schemaVersion", "legacy", "target", "source"], "Fleet-v1-Migrationsvertragsspezifikation");
  invariant(value.schemaVersion === CONTRACT_SPECIFICATION_SCHEMA, "Fleet-v1-Migrationsvertragsspezifikation besitzt ein unbekanntes Schema.");
  validateMigrationContractCore(value, "Fleet-v1-Migrationsvertragsspezifikation");
  return structuredClone(value);
}

export function validateAlphaFleetMigrationContract(value) {
  exactKeys(value, ["schemaVersion", "legacy", "target", "source", "inputs"], "Fleet-v1-Migrationsvertrag");
  invariant(value.schemaVersion === CONTRACT_SCHEMA, "Fleet-v1-Migrationsvertrag besitzt ein unbekanntes Schema.");
  validateMigrationContractCore(value, "Fleet-v1-Migrationsvertrag");
  exactKeys(value.inputs, ["buildConfiguration", "gtfs", "economy", "infraReleaseWrapper", "operationalInfrastructure"], "Fleet-v1-Migrationsvertrag.inputs");
  validateJsonArtifactPin(value.inputs.buildConfiguration, "Fleet-v1-Migrationsvertrag.inputs.buildConfiguration");
  validateJsonArtifactPin(value.inputs.economy, "Fleet-v1-Migrationsvertrag.inputs.economy");
  exactKeys(value.inputs.gtfs, ["file", "bytes", "sha256", "canonicalSha256", "snapshotHash", "sourceArchiveSha256", "releaseId"], "Fleet-v1-Migrationsvertrag.inputs.gtfs");
  validateJsonArtifactPin({
    file: value.inputs.gtfs.file,
    bytes: value.inputs.gtfs.bytes,
    sha256: value.inputs.gtfs.sha256,
    canonicalSha256: value.inputs.gtfs.canonicalSha256,
  }, "Fleet-v1-Migrationsvertrag.inputs.gtfs");
  invariant(SHA256.test(value.inputs.gtfs.snapshotHash) && SHA256.test(value.inputs.gtfs.sourceArchiveSha256), "Fleet-v1-Migrationsvertrag.inputs.gtfs besitzt keine vollstaendigen Snapshot-/Quellhashes.");
  invariant(value.inputs.gtfs.releaseId === value.target.gtfsReleaseId, "Fleet-v1-Migrationsvertrag.inputs.gtfs besitzt einen fremden Zielnamespace.");
  exactKeys(value.inputs.infraReleaseWrapper, ["file", "bytes", "sha256", "canonicalSha256", "releaseHash"], "Fleet-v1-Migrationsvertrag.inputs.infraReleaseWrapper");
  validateJsonArtifactPin({
    file: value.inputs.infraReleaseWrapper.file,
    bytes: value.inputs.infraReleaseWrapper.bytes,
    sha256: value.inputs.infraReleaseWrapper.sha256,
    canonicalSha256: value.inputs.infraReleaseWrapper.canonicalSha256,
  }, "Fleet-v1-Migrationsvertrag.inputs.infraReleaseWrapper");
  invariant(SHA256.test(value.inputs.infraReleaseWrapper.releaseHash), "Fleet-v1-Migrationsvertrag.inputs.infraReleaseWrapper.releaseHash fehlt.");
  exactKeys(value.inputs.operationalInfrastructure, ["infraReleaseId", "file", "bytes", "sha256", "stateHash"], "Fleet-v1-Migrationsvertrag.inputs.operationalInfrastructure");
  nonEmptyString(value.inputs.operationalInfrastructure.infraReleaseId, "Fleet-v1-Migrationsvertrag.inputs.operationalInfrastructure.infraReleaseId");
  invariant(value.inputs.operationalInfrastructure.file === "operational-infrastructure-v2.json", "Fleet-v1-Migrationsvertrag bindet keine Operational-v2-Datei.");
  positiveInteger(value.inputs.operationalInfrastructure.bytes, "Fleet-v1-Migrationsvertrag.inputs.operationalInfrastructure.bytes");
  invariant(SHA256.test(value.inputs.operationalInfrastructure.sha256) && SHA256.test(value.inputs.operationalInfrastructure.stateHash), "Fleet-v1-Migrationsvertrag besitzt keine vollstaendige Operational-v2-Bindung.");
  return structuredClone(value);
}

function parseEconomySpecification(specification) {
  const bigintKeys = new Set([
    "trackPerTrainKmCents", "stationPerStopCents", "facilityPerHourCents", "energyPerKwhCents",
    "personnelPerHourCents", "administrationPerPeriodCents", "vehiclePerPeriodCents",
    "overnightStablingPerPeriodCents", "protectionEquipmentPerPeriodCents", "contractBonusCentsPerPeriod",
    "punctuality", "cancellation", "seats", "connections",
  ]);
  const convert = (value, key = "") => {
    if (bigintKeys.has(key)) return BigInt(value);
    if (Array.isArray(value)) return value.map((entry) => convert(entry));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, convert(entry, name)]));
    return value;
  };
  return convert(specification);
}

function fleetEconomyJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(fleetEconomyJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fleetEconomyJson(item)]));
  return value;
}

function parseJsonArtifact(bytes, name) {
  invariant(Buffer.isBuffer(bytes) && bytes.length > 0, `${name} besitzt keine Bytes.`);
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${name} ist kein gueltiges JSON: ${error.message}`);
  }
}

function jsonArtifactPin(file, bytes, value) {
  return Object.freeze({
    file: basename(nonEmptyString(file, "JSON-Artefaktdatei")),
    bytes: bytes.length,
    sha256: sha256(bytes),
    canonicalSha256: canonicalSha256(value),
  });
}

function verifyJsonArtifactPin(pin, bytes, file, name) {
  const value = parseJsonArtifact(bytes, name);
  invariant(
    basename(nonEmptyString(file, `${name}.Dateiname`)) === pin.file
      && bytes.length === pin.bytes
      && sha256(bytes) === pin.sha256
      && canonicalSha256(value) === pin.canonicalSha256,
    `${name} verletzt Dateiname, Bytezahl, Byte-SHA-256 oder kanonische SHA-256-Bindung.`,
  );
  return value;
}

function operationalContractBinding(value) {
  return Object.freeze({
    infraReleaseId: value.infraReleaseId,
    file: value.file,
    bytes: value.bytes,
    sha256: value.sha256,
    stateHash: value.stateHash,
  });
}

/** Prüft alle gepinnten Inputs und ihre gegenseitigen fachlichen Belege vor jeder Ableitung. */
export function validateAlphaFleetMigrationBoundInputs({
  contract: rawContract,
  buildConfigurationBytes,
  gtfsBytes,
  economyBytes,
  infraReleaseWrapperBytes,
  fileNames,
}) {
  const contract = validateAlphaFleetMigrationContract(rawContract);
  exactKeys(fileNames, ["buildConfiguration", "gtfs", "economy", "infraReleaseWrapper"], "Fleet-v1-Migration.Dateinamen");
  const buildConfiguration = validateAlphaWorldBuildConfiguration(verifyJsonArtifactPin(
    contract.inputs.buildConfiguration,
    buildConfigurationBytes,
    fileNames.buildConfiguration,
    "Alpha-Weltbuildkonfiguration",
  ));
  const gtfsEnvelope = verifyJsonArtifactPin(contract.inputs.gtfs, gtfsBytes, fileNames.gtfs, "GTFS-Envelope");
  const economySpecification = verifyJsonArtifactPin(contract.inputs.economy, economyBytes, fileNames.economy, "Economy-Spezifikation");
  const infraReleaseWrapper = verifyJsonArtifactPin(
    contract.inputs.infraReleaseWrapper,
    infraReleaseWrapperBytes,
    fileNames.infraReleaseWrapper,
    "InfraRelease-Wrapper",
  );
  const unwrapped = unwrapInfraReleaseManifest(infraReleaseWrapper);
  const operational = operationalInfrastructureV2Binding(unwrapped.release);
  invariant(unwrapped.releaseHash === contract.inputs.infraReleaseWrapper.releaseHash, "InfraRelease-Wrapper verletzt die gepinnte kanonische Releasebindung.");
  invariant(
    alphaCanonicalJson(operationalContractBinding(operational)) === alphaCanonicalJson(contract.inputs.operationalInfrastructure),
    "InfraRelease-Wrapper und Migrationsvertrag besitzen verschiedene Operational-v2-Release-, Byte- oder Zustandsbindungen.",
  );
  invariant(
    alphaCanonicalJson(buildConfiguration.operationalInfrastructure) === alphaCanonicalJson({
      file: operational.file,
      bytes: operational.bytes,
      sha256: operational.sha256,
      stateHash: operational.stateHash,
    }),
    "Buildkonfiguration und InfraRelease-Wrapper besitzen verschiedene Operational-v2-Byte- oder Zustandsbindungen.",
  );
  const gtfs = record(gtfsEnvelope.snapshot, "GTFS-Snapshot");
  invariant(
    gtfsEnvelope.snapshotHash === contract.inputs.gtfs.snapshotHash
      && gtfsEnvelope.snapshotHash === sha256(canonicalPlanningJson(gtfs))
      && gtfs.source?.archiveSha256 === contract.inputs.gtfs.sourceArchiveSha256,
    "GTFS-Envelope verletzt SnapshotHash oder gepinnten Quellbeleg.",
  );
  const gtfsBinding = assertSignedGtfsTimetableBinding({
    infraRelease: unwrapped.release,
    gtfsEnvelope,
    gtfsBytes,
    timetableRoutes: buildConfiguration.timetableRoutes,
    worldId: buildConfiguration.worldId,
  });
  invariant(gtfsBinding.releaseId === contract.inputs.gtfs.releaseId, "GTFS-Envelope besitzt einen fremden signierten Release-Namespace.");
  const parsedEconomy = parseEconomySpecification(economySpecification);
  buildEconomyRelease({
    version: parsedEconomy.version,
    rates: parsedEconomy.rates,
    rules: parsedEconomy.rules,
    tenderProfiles: parsedEconomy.tenderProfiles,
  });
  return Object.freeze({
    contract,
    buildConfiguration,
    gtfsEnvelope,
    economySpecification,
    infraReleaseWrapper,
    infraRelease: unwrapped.release,
    operationalInfrastructure: operational,
  });
}

/** Erzeugt die Jahres-Pins ausschliesslich aus den tatsaechlich gelesenen JSON-Bytes. */
export function createAlphaFleetMigrationContract({
  specification: rawSpecification,
  buildConfigurationBytes,
  gtfsBytes,
  economyBytes,
  infraReleaseWrapperBytes,
  fileNames,
}) {
  const specification = validateAlphaFleetMigrationContractSpecification(rawSpecification);
  const buildConfiguration = parseJsonArtifact(buildConfigurationBytes, "Alpha-Weltbuildkonfiguration");
  const gtfsEnvelope = parseJsonArtifact(gtfsBytes, "GTFS-Envelope");
  const economySpecification = parseJsonArtifact(economyBytes, "Economy-Spezifikation");
  const infraReleaseWrapper = parseJsonArtifact(infraReleaseWrapperBytes, "InfraRelease-Wrapper");
  const unwrapped = unwrapInfraReleaseManifest(infraReleaseWrapper);
  const operational = operationalInfrastructureV2Binding(unwrapped.release);
  const contract = {
    schemaVersion: CONTRACT_SCHEMA,
    legacy: structuredClone(specification.legacy),
    target: structuredClone(specification.target),
    source: structuredClone(specification.source),
    inputs: {
      buildConfiguration: jsonArtifactPin(fileNames.buildConfiguration, buildConfigurationBytes, buildConfiguration),
      gtfs: {
        ...jsonArtifactPin(fileNames.gtfs, gtfsBytes, gtfsEnvelope),
        snapshotHash: gtfsEnvelope.snapshotHash,
        sourceArchiveSha256: gtfsEnvelope.snapshot?.source?.archiveSha256,
        releaseId: specification.target.gtfsReleaseId,
      },
      economy: jsonArtifactPin(fileNames.economy, economyBytes, economySpecification),
      infraReleaseWrapper: {
        ...jsonArtifactPin(fileNames.infraReleaseWrapper, infraReleaseWrapperBytes, infraReleaseWrapper),
        releaseHash: unwrapped.releaseHash,
      },
      operationalInfrastructure: operationalContractBinding(operational),
    },
  };
  return validateAlphaFleetMigrationBoundInputs({
    contract,
    buildConfigurationBytes,
    gtfsBytes,
    economyBytes,
    infraReleaseWrapperBytes,
    fileNames,
  }).contract;
}

function playableLegs(chain) {
  return chain.legs.filter((leg) => leg.kind === "playable");
}

function legacySlug(value) {
  return String(value).normalize("NFKD").replaceAll(/\p{Diacritic}/gu, "").replaceAll(/[^a-zA-Z0-9]+/g, "-").replaceAll(/^-|-$/g, "").toLowerCase() || "linie";
}

function startS(chain) {
  const leg = chain.legs[0];
  return leg.kind === "playable" ? leg.stops[0].departureS : leg.scheduledStartS;
}

function endS(chain) {
  const leg = chain.legs.at(-1);
  return leg.kind === "playable" ? leg.stops.at(-1).arrivalS : leg.scheduledEndS;
}

function startLocation(chain) {
  const leg = chain.legs[0];
  if (leg.kind === "external") return `external-origin:${leg.legId}`;
  return leg.entryPortalId ?? leg.stops[0].stopId;
}

function endLocation(chain) {
  const leg = chain.legs.at(-1);
  if (leg.kind === "external") return `external-destination:${leg.legId}`;
  return leg.exitPortalId ?? leg.stops.at(-1).stopId;
}

function buildCirculations(chains, lotId) {
  const circulations = [];
  const assignment = new Map();
  for (const chain of [...chains].sort((left, right) => startS(left) - startS(right) || left.journeyChainId.localeCompare(right.journeyChainId, "en"))) {
    const location = startLocation(chain);
    const available = circulations
      .filter((circulation) => circulation.location === location && circulation.availableAt + ALPHA_MINIMUM_TURNAROUND_S <= startS(chain))
      .sort((left, right) => right.availableAt - left.availableAt || left.id.localeCompare(right.id, "en"))[0];
    const circulation = available ?? { id: `circulation-${lotId}-${String(circulations.length + 1).padStart(3, "0")}`, chains: [], location, availableAt: 0 };
    if (available === undefined) circulations.push(circulation);
    circulation.chains.push(chain.journeyChainId);
    circulation.location = endLocation(chain);
    circulation.availableAt = endS(chain);
    assignment.set(chain.journeyChainId, circulation.id);
  }
  return { circulations, assignment };
}

function alphaLotRecords(chains, gtfsReleaseId) {
  const grouped = new Map();
  for (const chain of chains) {
    const key = alphaCanonicalJson({ routeId: chain.routeId, routeShortName: chain.routeShortName });
    const group = grouped.get(key) ?? { routeId: chain.routeId, routeShortName: chain.routeShortName, chains: [] };
    group.chains.push(chain);
    grouped.set(key, group);
  }
  const records = [...grouped.values()].map(({ routeId, routeShortName, chains: values }) => {
    return {
      ...alphaServiceLotIdentifiers({ gtfsReleaseId, routeId, routeShortName }),
      legacyServiceLineId: `line-${legacySlug(routeId)}-${legacySlug(routeShortName)}`,
      routeId,
      routeShortName,
      chains: values,
    };
  }).sort((left, right) => left.lotId.localeCompare(right.lotId, "en"));
  invariant(new Set(records.map(({ lotId }) => lotId)).size === records.length, "GTFS-Loskennungen besitzen eine Identitaetskollision.");
  invariant(new Set(records.map(({ serviceLineId }) => serviceLineId)).size === records.length, "GTFS-Linienkennungen besitzen eine Identitaetskollision.");
  invariant(new Set(records.map(({ legacyServiceLineId }) => legacyServiceLineId)).size === records.length, "GTFS-Zielrouten besitzen eine mehrdeutige Legacy-Linienkennung; Altassets koennen nicht sicher zugeordnet werden.");
  return records;
}

function published(value, sourceId, method) {
  return { value, kind: "published-fact", confidenceBasisPoints: 10_000, method, sourceIds: [sourceId] };
}

function assumption(value, method) {
  return { value, kind: "game-assumption", confidenceBasisPoints: 10_000, method, sourceIds: [] };
}

const PROTECTION_ORDER = new Map(["pzb", "lzb", "etcs-level1", "etcs-level2"].map((value, index) => [value, index]));
function sortProtection(values) {
  return [...new Set(values)].sort((left, right) => (PROTECTION_ORDER.get(left) ?? 999) - (PROTECTION_ORDER.get(right) ?? 999) || left.localeCompare(right, "en"));
}

function assertUniform(values, name) {
  const serialized = new Set(values.map((value) => alphaCanonicalJson(value)));
  invariant(serialized.size === 1, `${name} ist innerhalb derselben Legacy-Typkennung widerspruechlich.`);
  return values[0];
}

function sourceVehicleType(numericTypeId, assets, sourceId, legacyReleaseId) {
  const first = assets[0];
  const method = `Byte-exakte Uebernahme aus dem freigegebenen Authority-v1-Release '${legacyReleaseId}'.`;
  const assumptionMethod = `Explizite Spielannahme des typisierten Authority-v1-zu-v2-Migrationsvertrags fuer '${legacyReleaseId}'.`;
  for (const field of ["classDesignation", "tradeName", "technical", "passenger"]) assertUniform(assets.map((asset) => asset[field]), `Legacy-Typ ${numericTypeId}.${field}`);
  const buildYears = assets.map((asset) => positiveInteger(asset.buildYear, `Legacy-Typ ${numericTypeId}.buildYear`));
  const acquisitionYears = assets.map((asset) => positiveInteger(asset.acquisitionYear, `Legacy-Typ ${numericTypeId}.acquisitionYear`));
  const technical = record(first.technical, `Legacy-Typ ${numericTypeId}.technical`);
  const passenger = record(first.passenger, `Legacy-Typ ${numericTypeId}.passenger`);
  const installedProtection = sortProtection(assets.flatMap((asset) => asset.installedProtection ?? []));
  invariant(installedProtection.length > 0, `Legacy-Typ ${numericTypeId} besitzt kein Zugsicherungssystem.`);
  const typeId = `alpha.authority-v1.type-${numericTypeId}`;
  const constructionYears = { from: Math.min(...buildYears), to: Math.max(...buildYears) };
  const marketYears = { from: Math.min(...buildYears), to: Math.max(2040, ...acquisitionYears) };
  return {
    typeId,
    numericId: numericTypeId,
    classDesignation: published(first.classDesignation, sourceId, method),
    tradeName: assumption(first.tradeName, "Fiktiver Zugfolge-Handelsname aus dem freigegebenen Alpha-Bestand gemaess E6."),
    constructionYears: published(constructionYears, sourceId, method),
    role: published(technical.role, sourceId, method),
    traction: published(technical.traction, sourceId, method),
    controlStands: published(technical.controlStands, sourceId, method),
    electricSystems: technical.traction === "battery"
      ? assumption(["ac15kv"], "Explizite Alpha-Spielannahme: BEMU laedt unter 15-kV-Oberleitung; Authority-v1 transportierte diese Ladesystemdimension noch nicht.")
      : published(technical.electricSystems ?? [], sourceId, method),
    standardProtection: published(installedProtection, sourceId, method),
    protectionOptions: [],
    markets: {
      newBuild: assumption(constructionYears, assumptionMethod),
      leasing: assumption(marketYears, assumptionMethod),
      used: assumption(marketYears, assumptionMethod),
    },
    technical: {
      lengthMm: published(technical.lengthMm, sourceId, method),
      massKg: published(technical.massKg, sourceId, method),
      maximumSpeedKph: published(technical.maximumSpeedKph, sourceId, method),
      continuousPowerKw: published(technical.continuousPowerKw, sourceId, method),
      startingTractiveEffortKn: published(technical.startingTractiveEffortKn, sourceId, method),
      brakeWeightKg: assumption(technical.massKg, "Konservative Alpha-Spielannahme: Bremsgewicht entspricht fuer die ganzzahlige v2-Ableitung der Fahrzeugmasse."),
    },
    operationalProfile: {
      schemaVersion: "zugfolge-derived-operational-profile/v2",
      maximumAccelerationCapMmps2: assumption(900, assumptionMethod),
      serviceBrakeCapMmps2: assumption(900, assumptionMethod),
      emergencyBrakeMultiplierBasisPoints: assumption(13_334, assumptionMethod),
    },
    passenger: {
      seats: published(passenger.seats, sourceId, method),
      firstClassSeats: published(passenger.firstClassSeats, sourceId, method),
      accessible: published(passenger.accessible, sourceId, method),
      bicyclePlaces: published(passenger.bicyclePlaces, sourceId, method),
      wheelchairPlaces: published(passenger.wheelchairPlaces, sourceId, method),
      equipment: published([...(passenger.equipment ?? [])].sort(), sourceId, method),
      replacementPlan: published(passenger.replacementPlan, sourceId, method),
    },
  };
}

function targetLots(gtfs, gtfsReleaseId) {
  const chains = gtfs.journeyChains.filter((chain) => chain.orderable === true);
  invariant(chains.length === gtfs.metrics?.orderableJourneyChainCount && chains.length > 0, "GTFS-Orderable-Zaehler und Fahrtketten laufen auseinander.");
  invariant(gtfs.journeyChains.every((chain) => chain.releaseId === gtfsReleaseId), "GTFS-Fahrtketten verletzen den releasegebundenen Zielnamespace.");
  invariant(chains.every((chain) => playableLegs(chain).length > 0 && playableLegs(chain).every((leg) => leg.orderable === true && leg.qualityClass === "B")), "GTFS enthaelt keine geschlossene Klasse-B-Fahrtkettenmenge.");
  return alphaLotRecords(chains, gtfsReleaseId).map((lot) => ({ ...lot, ...buildCirculations(lot.chains, lot.lotId) }));
}

function allocateAssets(legacyAssets, lots) {
  const byLine = new Map();
  for (const asset of [...legacyAssets].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
    invariant(Array.isArray(asset.approvedLineIds) && asset.approvedLineIds.length === 1, `Legacy-Fahrzeug '${asset.id}' besitzt keine eindeutige Linienbindung.`);
    const values = byLine.get(asset.approvedLineIds[0]) ?? [];
    values.push(asset);
    byLine.set(asset.approvedLineIds[0], values);
  }
  const assignments = new Map();
  const used = new Set();
  const shortages = [];
  for (const lot of lots) {
    const sameLine = (byLine.get(lot.legacyServiceLineId) ?? []).filter((asset) => !used.has(asset.id));
    const classes = new Set(sameLine.map((asset) => asset.classDesignation));
    invariant(classes.size <= 1, `Legacy-Linie '${lot.serviceLineId}' besitzt mehrere Fahrzeugklassen.`);
    const requiredClass = classes.size === 1 ? [...classes][0] : "563.0";
    const selected = sameLine.slice(0, lot.circulations.length);
    for (const asset of selected) used.add(asset.id);
    assignments.set(lot.lotId, { requiredClass, selected });
    if (selected.length < lot.circulations.length) shortages.push({ lot, requiredClass, count: lot.circulations.length - selected.length });
  }
  const surplus = legacyAssets
    .filter((asset) => !used.has(asset.id))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  for (const shortage of shortages) {
    const assignment = assignments.get(shortage.lot.lotId);
    const candidates = surplus.filter((asset) => !used.has(asset.id) && asset.classDesignation === shortage.requiredClass).slice(0, shortage.count);
    invariant(candidates.length === shortage.count, `Der freigegebene Legacy-Bestand deckt Los '${shortage.lot.lotId}' nicht mit Klasse '${shortage.requiredClass}'.`);
    for (const asset of candidates) used.add(asset.id);
    assignment.selected.push(...candidates);
  }
  return { assignments, reserve: legacyAssets.filter((asset) => !used.has(asset.id)).sort((left, right) => left.id.localeCompare(right.id, "en")) };
}

function seedAsset(asset, typeId, approvedLineIds, provenance) {
  return {
    id: asset.id,
    numericId: asset.numericId,
    operatorId: asset.operatorId,
    typeId,
    buildYear: asset.buildYear,
    acquisitionYear: asset.acquisitionYear,
    procurementChannel: asset.procurementChannel,
    approvedLineIds,
    maintenanceDeadlines: structuredClone(asset.maintenanceDeadlines ?? []),
    installedProtection: sortProtection(asset.installedProtection ?? []),
    deliveredAt: asset.deliveredAt,
    retiredAt: asset.retiredAt,
    orientation: asset.orientation ?? "along",
    condition: structuredClone(asset.condition ?? {
      mechanicsBasisPoints: 10_000,
      driveBasisPoints: 10_000,
      brakesBasisPoints: 10_000,
      kilometresSinceMaintenance: 0,
      operatingHoursSinceMaintenance: 0,
      openObservations: 0,
    }),
    restrictions: structuredClone(asset.restrictions ?? {}),
    history: [...(asset.history ?? []), provenance],
  };
}

export function migrateAlphaFleetV1ToV2({
  contract: rawContract,
  buildConfigurationBytes,
  gtfsBytes,
  legacyBytes,
  economyBytes,
  infraReleaseWrapperBytes,
  fileNames,
  timetableRouteBindings,
}) {
  const {
    contract,
    buildConfiguration,
    gtfsEnvelope,
    economySpecification,
  } = validateAlphaFleetMigrationBoundInputs({
    contract: rawContract,
    buildConfigurationBytes,
    gtfsBytes,
    economyBytes,
    infraReleaseWrapperBytes,
    fileNames,
  });
  invariant(buildConfiguration.worldId === contract.target.worldId, "Buildkonfiguration und Migrationsvertrag besitzen verschiedene Zielwelten.");
  invariant(buildConfiguration.fleetReleaseId === contract.target.authorityReleaseId, "Buildkonfiguration und Migrationsvertrag besitzen verschiedene Fleet-Releases.");
  invariant(Buffer.isBuffer(legacyBytes) && legacyBytes.length === contract.legacy.bytes && sha256(legacyBytes) === contract.legacy.sha256, "Legacy-Deployment verletzt Byte- oder SHA-256-Bindung.");
  let legacyEnvelope;
  try {
    legacyEnvelope = JSON.parse(legacyBytes);
  } catch (error) {
    throw new Error(`Legacy-Deployment ist kein JSON: ${error.message}`);
  }
  const deployment = record(legacyEnvelope.deployment, "Legacy-Deployment.deployment");
  const fleet = record(deployment.fleet, "Legacy-Deployment.fleet");
  const authority = record(fleet.authorityRelease, "Legacy-Deployment.fleet.authorityRelease");
  invariant(
    deployment.worldId === contract.legacy.worldId
      && authority.schemaVersion === "zugfolge-fleet-authority-release/v1"
      && authority.releaseId === contract.legacy.authorityReleaseId
      && canonicalSha256(authority) === contract.legacy.authorityReleaseSha256
      && Array.isArray(authority.assets)
      && authority.assets.length === contract.legacy.assetCount,
    "Legacy-Deployment verletzt Welt-, Authority- oder Bestandsbindung.",
  );
  const gtfs = record(gtfsEnvelope?.snapshot, "GTFS-Snapshot");
  invariant(gtfs.regionId === buildConfiguration.regionId && gtfs.regionVariant === buildConfiguration.regionVariant, "GTFS-Snapshot verletzt die Zielregionsbindung.");
  invariant(gtfs.journeyChains.every((chain) => chain.worldId === buildConfiguration.worldId), "GTFS-Fahrtketten verletzen die Zielweltisolation.");
  const serviceDate = nonEmptyString(gtfs.serviceDate, "GTFS-Snapshot.serviceDate");
  const archiveSha256 = nonEmptyString(gtfs.source?.archiveSha256, "GTFS-Snapshot.source.archiveSha256");
  invariant(/^20[0-9]{6}$/u.test(serviceDate) && SHA256.test(archiveSha256), "GTFS-Snapshot besitzt keine ableitbare Release-Identitaet.");
  const derivedGtfsReleaseId = `gtfs-de-rv-${serviceDate}-${archiveSha256.slice(0, 16)}`;
  invariant(contract.target.gtfsReleaseId === derivedGtfsReleaseId, "Migrationsvertrag und aus der GTFS-Quelle abgeleiteter Release-Namespace laufen auseinander.");
  const lots = targetLots(gtfs, contract.target.gtfsReleaseId);
  const allPlayableLegIds = new Set(lots.flatMap((lot) => lot.chains.flatMap((chain) => playableLegs(chain).map((leg) => leg.legId))));
  invariant(timetableRouteBindings instanceof Map && timetableRouteBindings.size === allPlayableLegIds.size && [...allPlayableLegIds].every((id) => timetableRouteBindings.has(id)), "Timetable-Route-Bindung deckt die Ziel-Fahrtketten nicht vollstaendig ab.");

  const assetsByType = new Map();
  for (const asset of authority.assets) {
    nonEmptyString(asset.id, "Legacy-Fahrzeug.id");
    positiveInteger(asset.numericId, `Legacy-Fahrzeug ${asset.id}.numericId`);
    positiveInteger(asset.vehicleTypeId, `Legacy-Fahrzeug ${asset.id}.vehicleTypeId`);
    const values = assetsByType.get(asset.vehicleTypeId) ?? [];
    values.push(asset);
    assetsByType.set(asset.vehicleTypeId, values);
  }
  invariant(new Set(authority.assets.map((asset) => asset.id)).size === authority.assets.length, "Legacy-Authority besitzt doppelte Fahrzeugkennungen.");
  const sourceTypes = [...assetsByType]
    .sort(([left], [right]) => left - right)
    .map(([numericTypeId, assets]) => sourceVehicleType(numericTypeId, assets, contract.source.id, authority.releaseId));
  const typeIdByNumericId = new Map(sourceTypes.map((type) => [type.numericId, type.typeId]));
  const sourceCatalog = {
    schemaVersion: SOURCE_SCHEMA,
    releaseId: contract.target.sourceCatalogReleaseId,
    referenceYear: contract.target.referenceYear,
    sources: [structuredClone(contract.source)],
    vehicleTypes: sourceTypes,
  };

  const { assignments, reserve } = allocateAssets(authority.assets, lots);
  const seedAssets = [];
  const formations = [];
  const personnelPools = [];
  const pathReceipts = [];
  const provenance = `migrated-from:${authority.releaseId}:${contract.legacy.authorityReleaseSha256}`;
  let numericPersonnelId = 20_000;
  let numericRouteId = 30_000;
  for (const lot of lots) {
    const assignment = assignments.get(lot.lotId);
    invariant(assignment.selected.length === lot.circulations.length, `Los '${lot.lotId}' besitzt keine vollstaendige Fahrzeugzuordnung.`);
    const lotRoutes = lot.chains.flatMap((chain) => playableLegs(chain).map((leg) => timetableRouteBindings.get(leg.legId)));
    const lotConflictCheckHash = canonicalSha256({
      operationalStateHash: buildConfiguration.operationalInfrastructure.stateHash,
      routes: lotRoutes.map(({ routeVersionId, dispatchInterlockingRouteId }) => ({ routeVersionId, dispatchInterlockingRouteId })),
    });
    const assetByCirculation = new Map();
    for (const [index, circulation] of lot.circulations.entries()) {
      numericPersonnelId += 1;
      numericRouteId += 1;
      const asset = assignment.selected[index];
      const suffix = circulation.id.slice("circulation-".length);
      const formationId = `formation-${suffix}`;
      const receiptId = `path-circulation-${suffix}`;
      const poolId = `personnel-pool-${suffix}`;
      const typeId = typeIdByNumericId.get(asset.vehicleTypeId);
      invariant(typeId !== undefined, `Legacy-Fahrzeug '${asset.id}' besitzt keine migrierte Typkennung.`);
      seedAssets.push(seedAsset(asset, typeId, [lot.serviceLineId], provenance));
      assetByCirculation.set(circulation.id, asset);
      const battery = asset.technical?.traction === "battery";
      invariant(battery || asset.technical?.traction === "electric", `Legacy-Fahrzeug '${asset.id}' besitzt keine zulaessige Alpha-Traktion.`);
      const electrifications = battery ? ["unelectrified", "overhead-ac15kv"] : ["overhead-ac15kv"];
      pathReceipts.push({
        id: receiptId,
        numericRouteId,
        operatorId: buildConfiguration.operatorId,
        serviceLineIds: [lot.serviceLineId],
        decision: "confirmed",
        validFrom: 0,
        validUntil: 366 * 86_400,
        platformLengthsMm: [120_000],
        electrifications,
        requiredProtection: ["pzb"],
        approvedClasses: [asset.classDesignation],
        plannerStateHash: buildConfiguration.operationalInfrastructure.stateHash,
        conflictCheckHash: lotConflictCheckHash,
      });
      personnelPools.push({
        id: poolId,
        numericId: numericPersonnelId,
        operatorId: buildConfiguration.operatorId,
        capacitySeconds: 365 * 86_400,
        minimumRestSeconds: 39_600,
        classDesignations: [asset.classDesignation],
        pathReceiptIds: [receiptId],
        qualificationHash: sha256(`${asset.classDesignation}\u0000${receiptId}\u0000${buildConfiguration.operationalInfrastructure.stateHash}`),
      });
      formations.push({ id: formationId, vehicleIds: [asset.id], pathReceiptId: receiptId });
    }
    for (const chain of [...lot.chains].sort((left, right) => left.journeyChainId.localeCompare(right.journeyChainId, "en"))) {
      numericRouteId += 1;
      const circulationId = lot.assignment.get(chain.journeyChainId);
      const asset = assetByCirculation.get(circulationId);
      invariant(asset !== undefined, `Fahrtkette '${chain.journeyChainId}' besitzt keine migrierte Umlaufflotte.`);
      const chainRoutes = playableLegs(chain).map((leg) => timetableRouteBindings.get(leg.legId));
      const battery = asset.technical?.traction === "battery";
      pathReceipts.push({
        id: `path-${chain.journeyChainId}`,
        numericRouteId,
        operatorId: buildConfiguration.operatorId,
        serviceLineIds: [lot.serviceLineId],
        decision: "confirmed",
        validFrom: 0,
        validUntil: 366 * 86_400,
        platformLengthsMm: [120_000],
        electrifications: battery ? ["unelectrified", "overhead-ac15kv"] : ["overhead-ac15kv"],
        requiredProtection: ["pzb"],
        approvedClasses: [asset.classDesignation],
        plannerStateHash: buildConfiguration.operationalInfrastructure.stateHash,
        conflictCheckHash: canonicalSha256({
          operationalStateHash: buildConfiguration.operationalInfrastructure.stateHash,
          routes: chainRoutes.map(({ routeVersionId, dispatchInterlockingRouteId }) => ({ routeVersionId, dispatchInterlockingRouteId })),
        }),
      });
    }
  }
  for (const asset of reserve) {
    const typeId = typeIdByNumericId.get(asset.vehicleTypeId);
    invariant(typeId !== undefined, `Reservefahrzeug '${asset.id}' besitzt keine migrierte Typkennung.`);
    seedAssets.push(seedAsset(asset, typeId, ["reserve-pool"], provenance));
  }

  const economyInput = parseEconomySpecification(economySpecification);
  const economyRelease = buildEconomyRelease({
    version: economyInput.version,
    rates: economyInput.rates,
    rules: economyInput.rules,
    tenderProfiles: economyInput.tenderProfiles,
  });
  const encodedEconomyRelease = fleetEconomyJson(economyRelease);
  const operatingCosts = sourceTypes.map((type) => {
    const legacyTypeAssets = assetsByType.get(type.numericId);
    const cost = assertUniform(legacyTypeAssets.map((asset) => asset.passenger.operatingCostCentsPerTrainKm), `Legacy-Typ ${type.numericId}.operatingCostCentsPerTrainKm`);
    return { typeId: type.typeId, centsPerTrainKm: cost };
  }).sort((left, right) => left.typeId.localeCompare(right.typeId, "en"));
  const projectionBody = {
    schemaVersion: ECONOMY_PROJECTION_SCHEMA,
    economyReleaseSchema: encodedEconomyRelease.schema,
    economyReleaseVersion: encodedEconomyRelease.version,
    economyReleaseChecksum: encodedEconomyRelease.checksum,
    operatingCosts,
  };
  const worldSeed = {
    schemaVersion: SEED_SCHEMA,
    seedId: contract.target.seedId,
    catalogReleaseId: contract.target.sourceCatalogReleaseId,
    authorityReleaseId: contract.target.authorityReleaseId,
    operationalReleaseId: contract.target.operationalReleaseId,
    worldId: contract.target.worldId,
    producedAt: contract.target.producedAt,
    economy: {
      schemaVersion: ECONOMY_PROJECTION_SCHEMA,
      release: encodedEconomyRelease,
      operatingCosts,
      projectionSha256: prettySha256(projectionBody),
    },
    assets: seedAssets.sort((left, right) => left.id.localeCompare(right.id, "en")),
    formations: formations.sort((left, right) => left.id.localeCompare(right.id, "en")),
    personnelPools: personnelPools.sort((left, right) => left.id.localeCompare(right.id, "en")),
    pathReceipts: pathReceipts.sort((left, right) => left.id.localeCompare(right.id, "en")),
  };
  return Object.freeze({
    sourceCatalog,
    worldSeed,
    allocation: Object.freeze({
      legacyAssetCount: authority.assets.length,
      activeAssetCount: formations.length,
      reserveAssetCount: reserve.length,
      formationCount: formations.length,
      minimumTurnaroundS: ALPHA_MINIMUM_TURNAROUND_S,
    }),
  });
}

async function assertMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} existiert bereits; die Migration ueberschreibt keine Artefakte.`);
}

/**
 * Erstellt einen vollstaendigen Migrationssatz ausserhalb des sichtbaren
 * Zielpfads. Erst nachdem Source, Seed, Rust-Compiler und Receipt erfolgreich
 * waren, wird das ganze Verzeichnis in einem Schritt create-new publiziert.
 */
export async function publishCreateNewMigrationBundle(outputDirectory, populate) {
  invariant(typeof outputDirectory === "string" && outputDirectory.trim() !== "", "Migrations-Ausgabeverzeichnis fehlt.");
  invariant(typeof populate === "function", "Migrations-Stagingfunktion fehlt.");
  const absoluteOutputDirectory = resolve(outputDirectory);
  const parentDirectory = dirname(absoluteOutputDirectory);
  const outputName = basename(absoluteOutputDirectory);
  const publishLockPath = join(parentDirectory, `.${outputName}.publish.lock`);
  let publishLock;
  try {
    publishLock = await open(publishLockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Eine parallele Migration besitzt bereits die atomare Publikationssperre fuer dieses Ziel.", { cause: error });
    }
    throw error;
  }
  try {
    await assertMissing(absoluteOutputDirectory, "Migrations-Ausgabeverzeichnis");
    const stagingDirectory = await mkdtemp(join(parentDirectory, `.${outputName}.staging-`));
    try {
      const result = await populate(stagingDirectory);
      // Unter der festen sibling-Sperre koennen parallele Toollaeufe nicht bis
      // zum POSIX-rename gelangen. Der zweite Check schuetzt zusaetzlich gegen
      // ein waehrend Populate extern angelegtes (auch leeres) Zielverzeichnis.
      await assertMissing(absoluteOutputDirectory, "Migrations-Ausgabeverzeichnis");
      await rename(stagingDirectory, absoluteOutputDirectory);
      return result;
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
        throw new Error("Migrations-Ausgabeverzeichnis wurde waehrend der Migration bereits veroeffentlicht; es wird nicht ueberschrieben.", { cause: error });
      }
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  } finally {
    try {
      await publishLock.close();
    } finally {
      await rm(publishLockPath, { force: true });
    }
  }
}

export async function runBuildAlphaFleetMigrationContract(argv = process.argv.slice(2)) {
  const [specificationPath, buildConfigurationPath, gtfsPath, legacyPath, economyPath, infraReleaseWrapperPath, outputPath] = argv;
  if (!outputPath || argv.length !== 7) throw new Error("Aufruf: node build-alpha-fleet-migration-contract.mjs SPECIFICATION.json BUILD-CONFIG.json GTFS.json LEGACY-ALPHA-DEPLOYMENT.json ECONOMY.json INFRA-RELEASE-WRAPPER.json OUTPUT-CONTRACT.json");
  const output = resolve(outputPath);
  await assertMissing(output, "Fleet-v1-Migrationsvertrag");
  const [specificationBytes, buildConfigurationBytes, gtfsBytes, legacyBytes, economyBytes, infraReleaseWrapperBytes] = await Promise.all([
    readFile(specificationPath),
    readFile(buildConfigurationPath),
    readFile(gtfsPath),
    readFile(legacyPath),
    readFile(economyPath),
    readFile(infraReleaseWrapperPath),
  ]);
  const specification = validateAlphaFleetMigrationContractSpecification(parseJsonArtifact(specificationBytes, "Fleet-v1-Migrationsvertragsspezifikation"));
  invariant(
    basename(resolve(legacyPath)) === specification.legacy.file
      && legacyBytes.length === specification.legacy.bytes
      && sha256(legacyBytes) === specification.legacy.sha256,
    "Legacy-Deployment verletzt die Jahres-Spezifikation; der gebundene Vertrag wird nicht erzeugt.",
  );
  const fileNames = Object.freeze({
    buildConfiguration: basename(resolve(buildConfigurationPath)),
    gtfs: basename(resolve(gtfsPath)),
    economy: basename(resolve(economyPath)),
    infraReleaseWrapper: basename(resolve(infraReleaseWrapperPath)),
  });
  const contract = createAlphaFleetMigrationContract({
    specification,
    buildConfigurationBytes,
    gtfsBytes,
    economyBytes,
    infraReleaseWrapperBytes,
    fileNames,
  });
  await writeFile(output, `${JSON.stringify(contract, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({
    schemaVersion: contract.schemaVersion,
    worldId: contract.target.worldId,
    gtfsReleaseId: contract.inputs.gtfs.releaseId,
    infraReleaseId: contract.inputs.operationalInfrastructure.infraReleaseId,
  }));
}

export async function runAlphaFleetV1Migration(argv = process.argv.slice(2)) {
  const [contractPath, buildConfigurationPath, gtfsPath, legacyPath, economyPath, infraReleaseWrapperPath, timetableRoutesPath, outputDirectory] = argv;
  if (!outputDirectory || argv.length !== 8) throw new Error("Aufruf: node migrate-alpha-fleet-v1-to-v2.mjs CONTRACT.json BUILD-CONFIG.json GTFS.json LEGACY-ALPHA-DEPLOYMENT.json ECONOMY.json INFRA-RELEASE-WRAPPER.json TIMETABLE-ROUTES-V2.jsonseq OUTPUT-DIRECTORY");
  await assertMissing(resolve(outputDirectory), "Migrations-Ausgabeverzeichnis");
  const [contractBytes, buildConfigurationBytes, gtfsBytes, legacyBytes, economyBytes, infraReleaseWrapperBytes] = await Promise.all([
    readFile(contractPath), readFile(buildConfigurationPath), readFile(gtfsPath), readFile(legacyPath), readFile(economyPath), readFile(infraReleaseWrapperPath),
  ]);
  const contract = validateAlphaFleetMigrationContract(JSON.parse(contractBytes));
  invariant(basename(resolve(legacyPath)) === contract.legacy.file, "Legacy-Dateipfad verletzt den gebundenen Dateinamen.");
  const fileNames = Object.freeze({
    buildConfiguration: basename(resolve(buildConfigurationPath)),
    gtfs: basename(resolve(gtfsPath)),
    economy: basename(resolve(economyPath)),
    infraReleaseWrapper: basename(resolve(infraReleaseWrapperPath)),
  });
  const validatedInputs = validateAlphaFleetMigrationBoundInputs({
    contract,
    buildConfigurationBytes,
    gtfsBytes,
    economyBytes,
    infraReleaseWrapperBytes,
    fileNames,
  });
  const { buildConfiguration, gtfsEnvelope } = validatedInputs;
  const requiredLegIds = new Set(gtfsEnvelope.snapshot.journeyChains
    .filter((chain) => chain.orderable === true)
    .flatMap((chain) => playableLegs(chain).map((leg) => leg.legId)));
  const timetableRouteBindings = await streamTimetableRouteBindings(timetableRoutesPath, buildConfiguration.timetableRoutes, requiredLegIds);
  const migrated = migrateAlphaFleetV1ToV2({
    contract,
    buildConfigurationBytes,
    gtfsBytes,
    legacyBytes,
    economyBytes,
    infraReleaseWrapperBytes,
    fileNames,
    timetableRouteBindings,
  });
  const result = await publishCreateNewMigrationBundle(outputDirectory, async (stagingDirectory) => {
    const sourceOutputPath = join(stagingDirectory, SOURCE_OUTPUT_FILE);
    const seedOutputPath = join(stagingDirectory, SEED_OUTPUT_FILE);
    const compilerOutputDirectory = join(stagingDirectory, COMPILER_OUTPUT_DIRECTORY);
    const migrationReceiptPath = join(stagingDirectory, MIGRATION_RECEIPT_FILE);
    await writeFile(sourceOutputPath, `${JSON.stringify(migrated.sourceCatalog, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(seedOutputPath, `${JSON.stringify(migrated.worldSeed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const compiled = spawnSync("cargo", ["run", "--quiet", "--locked", "-p", "zugfolge-fleet", "--bin", "zugfolge-vehicle-catalog", "--", sourceOutputPath, seedOutputPath, compilerOutputDirectory], { encoding: "utf8" });
    if (compiled.error !== undefined || compiled.status !== 0) throw new Error(`Fleet-Authority-v2-Rust-Compiler ist fehlgeschlagen:\n${compiled.stderr ?? ""}\n${compiled.stdout ?? ""}`, { cause: compiled.error });
    const compilerReceiptBytes = await readFile(join(compilerOutputDirectory, "vehicle-catalog-compile-receipt-v4.json"));
    const compilerReceipt = JSON.parse(compilerReceiptBytes);
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA,
      legacy: structuredClone(contract.legacy),
      target: structuredClone(contract.target),
      inputs: structuredClone(contract.inputs),
      allocation: migrated.allocation,
      outputs: {
        sourceCatalogSha256: sha256(await readFile(sourceOutputPath)),
        worldSeedSha256: sha256(await readFile(seedOutputPath)),
        compilerOutputSetSha256: compilerReceipt.outputSetSha256,
      },
    };
    await writeFile(migrationReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return Object.freeze({ ...migrated.allocation, outputSetSha256: compilerReceipt.outputSetSha256 });
  });
  console.log(JSON.stringify(result));
}

const mainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (mainModule) await runAlphaFleetV1Migration();
