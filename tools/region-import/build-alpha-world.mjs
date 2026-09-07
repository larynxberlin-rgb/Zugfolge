import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

import { alphaCanonicalJson, alphaHash } from "../../packages/alpha/dist/index.js";
import { buildEconomyRelease, deriveTenderAuthorityBudgetCents, encodeEconomyValue, lotsFromGtfsPlanning, parseStartingCapitalPolicy, serializeStartingCapitalPolicy, startEconomyWorld, TENDER_GENERATION_SCHEMA } from "../../packages/economy/dist/index.js";
import { buildRegionalServicePlanning, canonicalPlanningJson } from "../../packages/gtfs/dist/index.js";
import { allocatePublicRegionalTrainNumbers, publicRegionalTrainNumber } from "../../packages/livemap/dist/index.js";
import {
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  assertOperationalTrainNumbers,
  operationalMovementContinuationsEvidence,
  operationalProtectionModeSelectionEvidence,
} from "../../packages/runtime-native/dist/index.js";
import { assertEmbeddedWorldIds } from "./world-binding.mjs";
import {
  DAILY_CIRCULATION_PLAN_SCHEMA,
  dailyMovementContinuities,
  dailyRolloverCycles,
  deriveDailyCirculationPlan,
  dailyServiceLotIdentifiers,
} from "./daily-circulation-v2.mjs";
import { allocateMovementRoutePlanV2, bindMovementPassengerStopPlansV1 } from "./movement-route-allocation-v2.mjs";
import { bindPassengerStopPlan, streamPassengerStopInfrastructure, validatePassengerStopAnchors } from "./passenger-stop-binding-v1.mjs";
import { validateMovementRouteTemplatesV2 } from "./movement-route-templates-v2.mjs";
import {
  assertNormalizedScheduleTimeContract,
  NORMALIZED_SCHEDULE_REPEAT_EVERY_S,
  NORMALIZED_SCHEDULE_TIME_ZONE,
} from "./regional-release-contract.mjs";
import {
  assertOperationalInfrastructureV2ReleaseBinding,
  operationalInfrastructureV2Binding,
} from "./operational-infrastructure-binding.mjs";
import {
  alphaWorldGenerationSourcesSha256,
  assertVehicleCatalogProofInputs,
  bindVehicleCatalogDeploymentArtifacts,
  compilerFleetFormations,
  selectVehicleCatalogAuthority,
  verifyVehicleCatalogCompilerReplay,
} from "./vehicle-catalog-deployment-binding.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RETIRED_ALPHA_WORLD_IDS = new Set(["00000000-0000-4000-8000-000000000014"]);
const ALPHA_WORLD_BUILD_CONFIGURATION_SCHEMA = "zugfolge-alpha-world-build-configuration/v3";
const OPERATIONAL_INITIALIZATION_HASH_SCHEMA = "zugfolge-operational-simulation-initialization/v2";
const OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA = "zugfolge-operational-initialization-validation-receipt/v1";
const MAX_TIMETABLE_ROUTE_RECORD_BYTES = 16 * 1024 * 1024;
export const ALPHA_MINIMUM_TURNAROUND_S = 300;
const CANONICAL_PROTECTION_SYSTEMS = Object.freeze(["etcs-level1", "etcs-level2", "lzb", "pzb"]);
const CONSERVATIVE_PROTECTION_MODE_PRIORITY_V1 = Object.freeze(["pzb", "lzb", "etcs-level1", "etcs-level2"]);

/** Ausschliesslich generierte Binnenfahrten duerfen einen neuen Weltvertrag bilden. */
export function assertPlayableGameTimetable(snapshot, worldId) {
  invariant(snapshot?.timetableGeneration?.schemaVersion === "zugfolge-game-timetable-generation/v1", "Neuer Weltstart braucht einen generierten Spiel-Fahrplan; den alten GTFS-Datenstand zuerst neu bauen.");
  const networkReference = snapshot.timetableGeneration.networkReference;
  invariant(snapshot.timetableGeneration.requireEligibleTerminals === true && networkReference?.schemaVersion === "zugfolge-game-timetable-network-reference/v1" && SHA256.test(networkReference.terminalCatalog?.sha256 ?? "") && Number.isSafeInteger(networkReference.terminalCatalog?.bytes) && networkReference.terminalCatalog.bytes > 0 && typeof networkReference.terminalCatalog?.sourceId === "string" && networkReference.terminalCatalog.sourceId.trim() !== "", "Neuer Weltstart braucht belegte Endbahnhoefe mit Wendemoeglichkeit aus einem gebundenen Terminalkatalog.");
  invariant(Array.isArray(snapshot.journeyChains) && snapshot.journeyChains.length > 0, "Spiel-Fahrplan besitzt keine Fahrten.");
  const stations = new Map((snapshot.stations ?? []).map((station) => [station.stopId, station]));
  const lineById = new Map((snapshot.lines ?? []).map((line) => [line.lineId, line]));
  for (const chain of snapshot.journeyChains) {
    invariant(chain.generation === "game-timetable/v1" && chain.journeyChainId?.startsWith("game-trip-"), "Spiel-Fahrplan besitzt keine generierten Fahrtidentitaeten.");
    invariant(chain.worldId === worldId && chain.orderable === true && chain.legs?.length === 1, "Spiel-Fahrplan besitzt eine fremde, nicht bestellbare oder gebietsueberschreitende Fahrt.");
    const leg = chain.legs[0];
    invariant(leg.kind === "playable" && leg.orderable === true && leg.qualityClass === "B" && leg.entryPortalId === null && leg.exitPortalId === null && leg.stops?.length >= 2, "Spiel-Fahrplan enthaelt einen Aussenlauf, ein Portal oder weniger als zwei Binnenhalte.");
    invariant(leg.stops.every((stop) => stations.get(stop.stopId)?.inRegion === true), "Spiel-Fahrplan enthaelt einen Halt ausserhalb der spielbaren Karte.");
    const line = lineById.get(chain.lineId);
    invariant(line?.adjustment?.terminalEvidenceIds?.length === 2 && line.adjustment.terminalEvidenceIds.every((id) => typeof id === "string" && id.trim() !== ""), "Spiel-Fahrplan besitzt keinen Wendenachweis fuer beide Endbahnhoefe.");
    invariant((leg.planningWindows ?? []).length === 0, "Spiel-Fahrplan enthaelt noch Aussenlauf-Planungsfenster.");
  }
}

export function buildAlphaServicePlanning({ worldId, infraReleaseId, gtfsEnvelope, lotRecords, timetableRouteBindings, assets, circulations, rules }) {
  const snapshot = gtfsEnvelope.snapshot;
  assertPlayableGameTimetable(snapshot, worldId);
  const stations = new Map(snapshot.stations.map((station) => [station.stopId, station]));
  const rulesVersion = `${rules.version}:${sha256(canonicalPlanningJson(rules))}`;
  return buildRegionalServicePlanning({
    worldId,
    revision: 1,
    producedAt: 0,
    source: {
      sourceId: "gtfs-de-regional-rail",
      feedUrl: snapshot.source.feedUrl ?? `artifact:${snapshot.source.archive}`,
      archiveSha256: snapshot.source.archiveSha256,
      capturedAt: snapshot.source.capturedAt ?? "unknown",
      timeZone: NORMALIZED_SCHEDULE_TIME_ZONE,
      sourceLicense: snapshot.source.sourceLicense,
      attribution: snapshot.source.attribution ?? snapshot.source.archive,
    },
    sourceTimetableHash: gtfsEnvelope.snapshotHash,
    timetableGeneration: { seed: snapshot.generationSeed, specification: snapshot.timetableGeneration },
    infrastructureVersion: infraReleaseId,
    rulesVersion,
    serviceDate: snapshot.serviceDate,
    smallLotMaximumTrainKmPerDay: rules.smallLotMaximumTrainKmPerDay,
    lines: lotRecords.map((lot) => {
      const assigned = assets.filter((asset) => asset.approvedLineIds.includes(lot.serviceLineId));
      invariant(assigned.length > 0, `Linie '${lot.serviceLineId}' besitzt keine signierte Fahrzeuggrundlage.`);
      const minimum = (read) => Math.min(...assigned.map(read));
      const peakVehicles = circulations.filter((circulation) => circulation.lotId === lot.lotId).length;
      return {
        peakVehicles,
        policy: {
          lineId: lot.serviceLineId,
          energyWhPerTrainKm: rules.energyWhPerTrainKm,
          facilityMinutesPerVehicleDay: rules.facilityMinutesPerVehicleDay,
          minimumTurnaroundSeconds: rules.minimumTurnaroundSeconds,
          overnightBasisPoints: rules.overnightBasisPoints,
          requiredProtection: [...new Set(assigned.flatMap((asset) => asset.installedProtection))].sort(),
          requirements: {
            minimumSeats: minimum((asset) => asset.passenger.seats),
            minimumMaximumSpeedKph: minimum((asset) => asset.technical.maximumSpeedKph),
            firstClassBasisPoints: minimum((asset) => Math.floor(asset.passenger.firstClassSeats * 10_000 / Math.max(1, asset.passenger.seats))),
            accessible: assigned.every((asset) => asset.passenger.accessible),
            bicyclePlaces: minimum((asset) => asset.passenger.bicyclePlaces),
            wheelchairPlaces: minimum((asset) => asset.passenger.wheelchairPlaces),
            requiredEquipment: assigned[0].passenger.equipment.filter((equipment) => assigned.every((asset) => asset.passenger.equipment.includes(equipment))).sort(),
          },
        },
        journeys: lot.chains.map((chain) => {
          const leg = chain.legs[0];
          const route = timetableRouteBindings.get(leg.legId);
          invariant(route !== undefined, `Spiel-Fahrt '${chain.journeyChainId}' besitzt keinen releasegebundenen Laufweg.`);
          return {
            id: chain.journeyChainId,
            directionId: String(chain.directionId ?? ""),
            sourceRouteId: chain.sourceRouteIds?.[0] ?? chain.routeId,
            sourceRouteIds: chain.sourceRouteIds,
            sourceTripIds: chain.sourceTripIds,
            presentation: {
              designation: chain.routeShortName,
              origin: stations.get(leg.stops[0].stopId).name,
              destination: stations.get(leg.stops.at(-1).stopId).name,
            },
            routeLengthMm: route.routeLengthMm,
            edgeIds: route.edgeIds,
            stops: leg.stops.map((stop) => {
              const station = stations.get(stop.stopId);
              invariant(station !== undefined, `Binnenhalt '${stop.stopId}' fehlt im regionalen Stationsbestand.`);
              return { ...stop, name: station.name };
            }),
          };
        }),
      };
    }),
  });
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, name) {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${name} ist kein Objekt.`);
  return value;
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(record(value, name)).sort();
  const sortedExpected = [...expected].sort();
  invariant(
    actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]),
    `${name} besitzt fehlende oder unbekannte Felder.`,
  );
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value;
}

function safePositiveInteger(value, name) {
  invariant(Number.isSafeInteger(value) && value > 0, `${name} ist keine positive sichere Ganzzahl.`);
  return value;
}

/**
 * Welt-, Regions- und Authority-Kennungen sind Build-Eingaben. Der Generator
 * darf keine bekannte Produktionswelt stillschweigend wiederverwenden.
 */
export function validateAlphaWorldBuildConfiguration(value) {
  exactKeys(value, [
    "schemaVersion",
    "worldId",
    "regionId",
    "regionVariant",
    "operatorId",
    "seed",
    "fleetReleaseId",
    "planningAuthority",
    "operationalInfrastructure",
    "timetableRoutes",
    "timetableTransferDemands",
    "movementRouteTemplates",
  ], "Alpha-Weltbuildkonfiguration");
  invariant(value.schemaVersion === ALPHA_WORLD_BUILD_CONFIGURATION_SCHEMA, "Alpha-Weltbuildkonfiguration besitzt ein unbekanntes Schema.");
  invariant(UUID.test(value.worldId), "Alpha-Weltbuildkonfiguration besitzt keine neue UUID-v4-Weltkennung.");
  invariant(!RETIRED_ALPHA_WORLD_IDS.has(value.worldId), "Alpha-Weltbuildkonfiguration darf keine abgeloeste Alpha-Welt wiederverwenden.");
  nonEmptyString(value.regionId, "Alpha-Weltbuildkonfiguration.regionId");
  nonEmptyString(value.regionVariant, "Alpha-Weltbuildkonfiguration.regionVariant");
  nonEmptyString(value.operatorId, "Alpha-Weltbuildkonfiguration.operatorId");
  invariant(typeof value.seed === "string" && /^[1-9][0-9]*$/u.test(value.seed), "Alpha-Weltbuildkonfiguration.seed muss eine positive Dezimalzeichenfolge sein.");
  nonEmptyString(value.fleetReleaseId, "Alpha-Weltbuildkonfiguration.fleetReleaseId");
  exactKeys(value.planningAuthority, ["accountId", "displayName"], "Alpha-Weltbuildkonfiguration.planningAuthority");
  invariant(UUID.test(value.planningAuthority.accountId), "Planning-Authority besitzt keine UUID-v4-Kennung.");
  nonEmptyString(value.planningAuthority.displayName, "Alpha-Weltbuildkonfiguration.planningAuthority.displayName");
  exactKeys(value.operationalInfrastructure, ["file", "bytes", "sha256", "stateHash"], "Alpha-Weltbuildkonfiguration.operationalInfrastructure");
  invariant(
    value.operationalInfrastructure.file === "operational-infrastructure-v2.json"
      && safePositiveInteger(value.operationalInfrastructure.bytes, "Alpha-Weltbuildkonfiguration.operationalInfrastructure.bytes")
      && SHA256.test(value.operationalInfrastructure.sha256)
      && SHA256.test(value.operationalInfrastructure.stateHash),
    "Alpha-Weltbuildkonfiguration besitzt keine byte- und zustandsgebundene Operational-v2-Eingabe.",
  );
  exactKeys(value.timetableRoutes, ["file", "bytes", "sha256"], "Alpha-Weltbuildkonfiguration.timetableRoutes");
  invariant(
    value.timetableRoutes.file === "timetable-routes-v2.jsonseq"
      && safePositiveInteger(value.timetableRoutes.bytes, "Alpha-Weltbuildkonfiguration.timetableRoutes.bytes")
      && SHA256.test(value.timetableRoutes.sha256),
    "Alpha-Weltbuildkonfiguration besitzt keine unveraenderliche Timetable-Route-Bindung.",
  );
  exactKeys(
    value.timetableTransferDemands,
    ["file", "bytes", "sha256", "dailyPlanSha256", "transferSetSha256"],
    "Alpha-Weltbuildkonfiguration.timetableTransferDemands",
  );
  invariant(
    value.timetableTransferDemands.file === "timetable-routes-v2.transfer-demands-v2.json"
      && safePositiveInteger(value.timetableTransferDemands.bytes, "Alpha-Weltbuildkonfiguration.timetableTransferDemands.bytes")
      && SHA256.test(value.timetableTransferDemands.sha256)
      && SHA256.test(value.timetableTransferDemands.dailyPlanSha256)
      && SHA256.test(value.timetableTransferDemands.transferSetSha256),
    "Alpha-Weltbuildkonfiguration besitzt keine vollstaendige Timetable-Transfer-Bindung.",
  );
  exactKeys(
    value.movementRouteTemplates,
    ["file", "bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256"],
    "Alpha-Weltbuildkonfiguration.movementRouteTemplates",
  );
  invariant(
    value.movementRouteTemplates.file === "operational-infrastructure-v2.movement-route-templates-v2.json"
      && safePositiveInteger(value.movementRouteTemplates.bytes, "Alpha-Weltbuildkonfiguration.movementRouteTemplates.bytes")
      && SHA256.test(value.movementRouteTemplates.sha256)
      && SHA256.test(value.movementRouteTemplates.stateHash)
      && value.movementRouteTemplates.operationalStateHash === value.operationalInfrastructure.stateHash
      && value.movementRouteTemplates.timetableTransferSetSha256 === value.timetableTransferDemands.transferSetSha256,
    "Alpha-Weltbuildkonfiguration bindet die Movement-Route-Vorlagen nicht an Operational-v2 und den Transferplan.",
  );
  const seed = BigInt(value.seed);
  invariant(seed <= 0xffff_ffff_ffff_ffffn, "Alpha-Weltbuildkonfiguration.seed liegt ausserhalb von u64.");
  return Object.freeze({
    ...value,
    planningAuthority: Object.freeze({ ...value.planningAuthority }),
    operationalInfrastructure: Object.freeze({ ...value.operationalInfrastructure }),
    timetableRoutes: Object.freeze({ ...value.timetableRoutes }),
    timetableTransferDemands: Object.freeze({ ...value.timetableTransferDemands }),
    movementRouteTemplates: Object.freeze({ ...value.movementRouteTemplates }),
  });
}

function canonicalSha256(value) {
  return createHash("sha256").update(alphaCanonicalJson(value)).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Fachliche Los- und Linienkennungen sind weltneutral, aber an den exakten
 * signierten GTFS-Release gebunden. Der vollstaendige SHA-256-Anteil wird aus
 * den unverkuerzten Werten gebildet; der Slug ist nur eine lesbare Anzeige und
 * kann daher keine Identitaetskollision verursachen.
 */
export function alphaServiceLotIdentifiers({ gtfsReleaseId, routeId, routeShortName }) {
  return dailyServiceLotIdentifiers({ gtfsReleaseId, routeId, routeShortName });
}

async function assertCreateNewTargetMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} existiert bereits; vorhandene Artefakte werden nicht ueberschrieben.`);
}

/**
 * Baut alle Zwischenartefakte in einem eindeutigen Verzeichnis neben dem Ziel
 * und veroeffentlicht erst die fertig geschriebene Datei ueber einen atomaren
 * Create-new-Hardlink. Ein fehlgeschlagener Versuch hinterlaesst kein Ziel und
 * kann deshalb mit denselben Eingaben sicher wiederholt werden.
 */
export async function publishCreateNewFileFromStaging(outputPath, populate) {
  invariant(typeof outputPath === "string" && outputPath.trim() !== "", "Create-new-Ausgabepfad fehlt.");
  invariant(typeof populate === "function", "Create-new-Stagingfunktion fehlt.");
  const absoluteOutputPath = resolve(outputPath);
  await assertCreateNewTargetMissing(absoluteOutputPath, "Create-new-Ausgabe");
  const stagingDirectory = await mkdtemp(join(dirname(absoluteOutputPath), `.${basename(absoluteOutputPath)}.staging-`));
  const stagedOutputPath = join(stagingDirectory, basename(absoluteOutputPath));
  try {
    const result = await populate(Object.freeze({ stagingDirectory, stagedOutputPath }));
    await link(stagedOutputPath, absoluteOutputPath);
    return result;
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Create-new-Ausgabe wurde waehrend des Builds bereits veroeffentlicht; sie wird nicht ueberschrieben.", { cause: error });
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export function unwrapInfraReleaseManifest(value) {
  exactKeys(value, ["release", "releaseHash"], "InfraRelease-Huelle");
  const release = record(value.release, "InfraRelease-Huelle.release");
  invariant(release.schema === "zugfolge-infra-release/v2", "InfraRelease-Huelle besitzt kein v2-Release.");
  invariant(SHA256.test(value.releaseHash) && value.releaseHash === canonicalSha256(release), "InfraRelease-Huelle bindet den kanonischen Releaseinhalt nicht.");
  operationalInfrastructureV2Binding(release);
  return Object.freeze({ release, releaseHash: value.releaseHash });
}

/**
 * Bindet die fachlichen GTFS-IDs und die abgeleiteten Laufwege an die im
 * Deutschland-Release signierten Quell- und Qualitaetsbelege. Eine fremde
 * JourneyChain-Namespace- oder nachtraeglich ersetzte Routendatei faellt damit
 * vor dem Weltbuild geschlossen aus.
 */
export function assertSignedGtfsTimetableBinding({
  infraRelease,
  gtfsEnvelope,
  gtfsBytes,
  timetableRoutes,
  worldId,
}) {
  const release = record(infraRelease, "Deutschland-InfraRelease");
  const gtfs = record(gtfsEnvelope?.snapshot, "GTFS-Snapshot");
  invariant(Buffer.isBuffer(gtfsBytes) && gtfsBytes.length > 0, "GTFS-Snapshot besitzt keine bytegenaue Quelldatei.");
  exactKeys(timetableRoutes, ["file", "bytes", "sha256"], "Timetable-Route-Bindung");
  const serviceDate = nonEmptyString(gtfs.serviceDate, "GTFS-Snapshot.serviceDate");
  invariant(/^20[0-9]{6}$/u.test(serviceDate), "GTFS-Snapshot.serviceDate ist ungueltig.");
  const timetableYear = Number(serviceDate.slice(0, 4));
  nonEmptyString(worldId, "Alpha-Welt.worldId");
  const sources = Array.isArray(release.sources)
    ? release.sources.filter((source) => source?.id === "gtfs-de-regional-rail")
    : [];
  invariant(sources.length === 1, "Deutschland-InfraRelease bindet die GTFS-Quelle nicht eindeutig.");
  const gtfsSource = sources[0];
  const closure = record(release.quality?.operationalClosure, "Deutschland-InfraRelease.quality.operationalClosure");
  const evidence = record(closure.timetableRouteEvidence, "Deutschland-InfraRelease.quality.operationalClosure.timetableRouteEvidence");
  const expectedReleaseId = `gtfs-de-rv-${serviceDate}-${gtfs.source?.archiveSha256?.slice(0, 16)}`;
  invariant(
    release.schema === "zugfolge-infra-release/v2"
      && release.timetableYear === timetableYear
      && gtfsSource.sha256 === gtfs.source?.archiveSha256
      && evidence.archive === gtfs.source?.archive
      && evidence.archiveSha256 === gtfs.source?.archiveSha256
      && evidence.sourceLicenseAsPublished === gtfs.source?.sourceLicense
      && evidence.gtfsSnapshotBytes === gtfsBytes.length
      && evidence.gtfsSnapshotSha256 === sha256(gtfsBytes)
      && evidence.snapshotHash === gtfsEnvelope.snapshotHash
      && gtfsEnvelope.snapshotHash === sha256(canonicalPlanningJson(gtfs))
      && timetableRoutes.file === "timetable-routes-v2.jsonseq"
      && evidence.routesBytes === timetableRoutes.bytes
      && evidence.routesSha256 === timetableRoutes.sha256
      && evidence.routeSetSha256 === timetableRoutes.sha256
      && evidence.routeRecordCount === evidence.completeRouteCount
      && evidence.completeRouteCount === evidence.selectedSegmentCount
      && Array.isArray(gtfs.segments)
      && evidence.selectedSegmentCount === gtfs.segments.filter(
        (segment) => segment?.orderable === true && segment?.qualityClass === "B",
      ).length
      && closure.unresolvedRequired === 0
      && closure.operationalQualityEligible === true
      && Array.isArray(gtfs.journeyChains)
      && gtfs.journeyChains.length > 0
      && gtfs.journeyChains.every((chain) => chain?.releaseId === expectedReleaseId && chain?.worldId === worldId),
    "Deutschland-InfraRelease, GTFS-JourneyChain-Namespace und Timetable-Routen sind nicht identisch signiert gebunden.",
  );
  return Object.freeze({
    releaseId: expectedReleaseId,
    snapshotHash: gtfsEnvelope.snapshotHash,
    routesSha256: timetableRoutes.sha256,
    routeRecordCount: evidence.routeRecordCount,
  });
}

async function regularFile(path, name) {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${name} ist keine regulaere, symlinkfreie Datei.`);
  return metadata;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    invariant(Number.isSafeInteger(bytes), "Dateigroesse liegt ausserhalb des sicheren Ganzzahlbereichs.");
    hash.update(chunk);
  }
  return Object.freeze({ bytes, sha256: hash.digest("hex") });
}

async function assertBoundSmallArtifact(path, bytes, binding, name) {
  const absolute = resolve(path);
  invariant(basename(absolute) === binding.file, `${name}-Dateipfad verletzt die signierte Dateibindung.`);
  const metadata = await regularFile(absolute, name);
  invariant(
    metadata.size === binding.bytes
      && bytes.length === binding.bytes
      && sha256(bytes) === binding.sha256,
    `${name} verletzt die Byte- oder SHA-256-Bindung.`,
  );
}

/** Verifiziert die 1,46-GB-Datei ausschliesslich als Stream gegen das signierte Manifest. */
export async function verifyOperationalInfrastructureArtifact(path, infraReleaseManifest) {
  invariant(typeof path === "string" && path !== "", "Operational-v2-Dateipfad fehlt.");
  const binding = operationalInfrastructureV2Binding(infraReleaseManifest);
  const absolute = resolve(path);
  invariant(basename(absolute) === binding.file, "Operational-v2-Dateipfad verletzt die signierte Dateibindung.");
  const metadata = await regularFile(absolute, "Operational-v2-Infrastruktur");
  invariant(metadata.size === binding.bytes, "Operational-v2-Infrastruktur besitzt eine fremde Bytezahl.");
  const proof = await hashFile(absolute);
  invariant(proof.bytes === binding.bytes && proof.sha256 === binding.sha256, "Operational-v2-Infrastruktur verletzt die signierte Byte- oder SHA-256-Bindung.");
  return binding;
}

export function validateOperationalInitializationPreflightReceipt(receipt, initialization) {
  exactKeys(receipt, [
    "schemaVersion",
    "worldId",
    "regionId",
    "initializationHash",
    "stateHash",
    "infraRelease",
    "programTrainCount",
    "validatedProgramTemplateCount",
    "validatedRouteVersionCount",
    "validatedDispatchInterlockingRouteCount",
    "validatedResourceBindingCount",
    "validatedFormationBindingCount",
    "validatedTrainNumberCount",
    "validatedMovementContinuationCount",
    "movementContinuationsSha256",
    "protectionModeSelectionPolicy",
    "validatedProtectionModeSelectionCount",
    "protectionModeSelectionsSha256",
    "protectionModeSelectionsValidated",
    "dynamicTrainCount",
    "resourceBindingsValidated",
    "formationBindingsValidated",
    "trainNumbersValidated",
    "validationMode",
  ], "Nativer Operational-v2-Initialisierungsbeleg");
  const binding = record(initialization?.infraRelease, "Operational-v2-Initialisierung.infraRelease");
  exactKeys(receipt.infraRelease, [
    "schemaVersion",
    "infraReleaseId",
    "file",
    "bytes",
    "sha256",
    "stateHash",
  ], "Nativer Operational-v2-Initialisierungsbeleg.infraRelease");
  const programTrainCount = Array.isArray(initialization?.trains) ? initialization.trains.length : -1;
  assertOperationalTrainNumbers(initialization?.trains ?? [], "Operational-v2-Preflight");
  const routeVersionCount = new Set(initialization?.trains?.map((train) => train.routeVersionId) ?? []).size;
  const dispatchInterlockingRouteCount = new Set(initialization?.trains?.map((train) => train.dispatchInterlockingRouteId) ?? []).size;
  const formationBindingCount = new Set(initialization?.trains?.map((train) => train.formationVersionId) ?? []).size;
  const protectionModeSelectionEvidence = operationalProtectionModeSelectionEvidence(initialization);
  const movementContinuationsEvidence = operationalMovementContinuationsEvidence(initialization);
  invariant(
    receipt.schemaVersion === OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA
      && receipt.worldId === initialization.worldId
      && receipt.regionId === initialization.regionId
      && alphaCanonicalJson(receipt.infraRelease) === alphaCanonicalJson(binding)
      && receipt.initializationHash === alphaHash(OPERATIONAL_INITIALIZATION_HASH_SCHEMA, initialization)
      && SHA256.test(receipt.stateHash ?? "")
      && receipt.dynamicTrainCount === 0
      && receipt.programTrainCount === programTrainCount
      && receipt.validatedProgramTemplateCount === programTrainCount
      && receipt.validatedRouteVersionCount === routeVersionCount
      && receipt.validatedDispatchInterlockingRouteCount === dispatchInterlockingRouteCount
      && receipt.validatedFormationBindingCount === formationBindingCount
      && receipt.validatedTrainNumberCount === programTrainCount
      && receipt.validatedMovementContinuationCount === movementContinuationsEvidence.count
      && receipt.movementContinuationsSha256 === movementContinuationsEvidence.sha256
      && receipt.protectionModeSelectionPolicy === initialization.protectionModeSelectionPolicy
      && receipt.validatedProtectionModeSelectionCount === protectionModeSelectionEvidence.count
      && receipt.protectionModeSelectionsSha256 === protectionModeSelectionEvidence.sha256
      && receipt.protectionModeSelectionsValidated === true
      && Number.isSafeInteger(receipt.validatedResourceBindingCount)
      && receipt.validatedResourceBindingCount >= 0
      && (programTrainCount === 0 || receipt.validatedResourceBindingCount > 0)
      && receipt.resourceBindingsValidated === true
      && receipt.formationBindingsValidated === true
      && receipt.trainNumbersValidated === true
      && receipt.validationMode === "native-streaming-redb-v1",
    "Nativer Operational-v2-Preflight lieferte keinen leeren, byte- und zustandsgebundenen Startbeleg.",
  );
  return Object.freeze({ ...receipt });
}

/** Source-bound nativer Streaming-Preflight; kein frei waehlbares Addon wird geladen. */
export async function runOperationalInitializationPreflight({ initialization, infrastructurePath, inputPath }) {
  const absoluteInfrastructurePath = resolve(infrastructurePath);
  const absoluteInputPath = resolve(inputPath);
  invariant(basename(absoluteInfrastructurePath) === initialization?.infraRelease?.file, "Nativer Operational-v2-Preflight verletzt die Infrastruktur-Dateibindung.");
  await writeFile(absoluteInputPath, `${JSON.stringify(initialization)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    const probe = spawnSync("cargo", [
      "run",
      "--quiet",
      "-p",
      "zugfolge-sim-runtime",
      "--example",
      "operational_initialization_preflight",
      "--",
      absoluteInputPath,
      absoluteInfrastructurePath,
    ], { encoding: "utf8" });
    if (probe.status !== 0) throw new Error(`Nativer Operational-v2-Streaming-Preflight fehlgeschlagen:\n${probe.stderr}\n${probe.stdout}`);
    let receipt;
    try {
      receipt = JSON.parse(probe.stdout.trim().split(/\r?\n/u).at(-1));
    } catch (error) {
      throw new Error(`Nativer Operational-v2-Streaming-Preflight lieferte kein Receipt: ${error.message}`);
    }
    return validateOperationalInitializationPreflightReceipt(receipt, initialization);
  } finally {
    await rm(absoluteInputPath, { force: true });
  }
}

/** Exakte Portierung von `stable_id` aus dem nativen Deutschland-Compiler. */
export function germanyOperationalStableId(prefix, parts) {
  nonEmptyString(prefix, "Stable-ID-Praefix");
  invariant(Array.isArray(parts) && parts.length > 0, "Stable-ID braucht mindestens einen Bestandteil.");
  const hash = createHash("sha256");
  for (const [index, part] of parts.entries()) {
    nonEmptyString(part, `Stable-ID-Bestandteil ${index}`);
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return `${prefix}${hash.digest("hex")}`;
}

function canonicalProtectionSystems(value, name, allowEmpty) {
  invariant(Array.isArray(value) && (allowEmpty || value.length > 0), `${name} ist keine zulaessige Systemliste.`);
  invariant(
    value.every((system) => typeof system === "string" && CANONICAL_PROTECTION_SYSTEMS.includes(system))
      && new Set(value).size === value.length
      && value.every((system, index) => index === 0 || value[index - 1] < system),
    `${name} muss eindeutig, bekannt und kanonisch sortiert sein.`,
  );
  return Object.freeze([...value]);
}

/**
 * Waehlt ohne Leg-Expansion den konservativen v1-Modus und gibt eine
 * kanonische RLE zurueck. Jeder Eingabe-Lauf deckt einen zusammenhaengenden
 * Bereich identischer Infrastrukturbedingungen ab.
 */
export function selectProtectionModeRuns({
  protectionContractRuns,
  routeLegCount,
  installedProtection,
  context = "Operational-v2-Programmzug",
}) {
  safePositiveInteger(routeLegCount, `${context}.routeLegCount`);
  invariant(Array.isArray(protectionContractRuns) && protectionContractRuns.length > 0, `${context} besitzt keinen Zugsicherungsvertrag.`);
  invariant(Array.isArray(installedProtection) && installedProtection.length > 0, `${context} besitzt kein installiertes Zugsicherungssystem.`);
  invariant(
    new Set(installedProtection).size === installedProtection.length
      && installedProtection.every((system) => CANONICAL_PROTECTION_SYSTEMS.includes(system)),
    `${context}.installedProtection enthaelt doppelte oder unbekannte Systeme.`,
  );
  const installed = new Set(installedProtection);
  const selections = [];
  let firstRouteLegIndex = 0;
  for (const [runIndex, rawRun] of protectionContractRuns.entries()) {
    const run = record(rawRun, `${context}.protectionContractRuns[${runIndex}]`);
    exactKeys(run, [
      "throughRouteLegIndex",
      "availableProtectionSystems",
      "simultaneouslyRequiredProtectionSystems",
    ], `${context}.protectionContractRuns[${runIndex}]`);
    invariant(
      Number.isSafeInteger(run.throughRouteLegIndex)
        && run.throughRouteLegIndex >= firstRouteLegIndex
        && run.throughRouteLegIndex < routeLegCount,
      `${context} besitzt ueberlappende, leere oder ueberlange Zugsicherungslaeufe.`,
    );
    const available = canonicalProtectionSystems(
      run.availableProtectionSystems,
      `${context}.protectionContractRuns[${runIndex}].availableProtectionSystems`,
      false,
    );
    const simultaneouslyRequired = canonicalProtectionSystems(
      run.simultaneouslyRequiredProtectionSystems,
      `${context}.protectionContractRuns[${runIndex}].simultaneouslyRequiredProtectionSystems`,
      true,
    );
    invariant(
      simultaneouslyRequired.every((system) => available.includes(system)),
      `${context} besitzt eine gleichzeitige Pflicht ausserhalb seiner verfuegbaren Modi.`,
    );
    invariant(
      simultaneouslyRequired.every((system) => installed.has(system)),
      `${context} kann die gleichzeitig zwingenden Zugsicherungssysteme nicht erfuellen.`,
    );
    const selectedProtectionSystem = CONSERVATIVE_PROTECTION_MODE_PRIORITY_V1.find(
      (system) => installed.has(system) && available.includes(system),
    );
    invariant(selectedProtectionSystem !== undefined, `${context} besitzt auf Leg ${firstRouteLegIndex} keinen kompatiblen Zugsicherungsmodus.`);
    const previous = selections.at(-1);
    if (previous !== undefined && previous.selectedProtectionSystem === selectedProtectionSystem) {
      previous.throughRouteLegIndex = run.throughRouteLegIndex;
    } else {
      selections.push({
        throughRouteLegIndex: run.throughRouteLegIndex,
        selectedProtectionSystem,
      });
    }
    firstRouteLegIndex = run.throughRouteLegIndex + 1;
  }
  invariant(firstRouteLegIndex === routeLegCount, `${context} deckt nicht alle RouteLegs mit einer Zugsicherungsmodus-Auswahl ab.`);
  return Object.freeze(selections.map((run) => Object.freeze(run)));
}

function timetableRouteSummary(value, requiredPlayableLegIds, seen) {
  const route = record(value, "Timetable-Route");
  nonEmptyString(route.routeVersionId, "Timetable-Route.routeVersionId");
  const match = /^route:gtfs:(.+):v1$/u.exec(route.routeVersionId);
  if (match === null || !requiredPlayableLegIds.has(match[1])) return undefined;
  const playableLegId = match[1];
  invariant(!seen.has(playableLegId), `Timetable-Route fuer '${playableLegId}' ist doppelt.`);
  invariant(route.templateId === `template:gtfs:${playableLegId}:v1`, `Timetable-Route fuer '${playableLegId}' besitzt eine fremde Template-Bindung.`);
  invariant(route.predecessorId === null && route.transitionRouteMm === null, `Timetable-Route fuer '${playableLegId}' besitzt einen unerlaubten Uebergang.`);
  invariant(Array.isArray(route.legs) && route.legs.length > 0, `Timetable-Route fuer '${playableLegId}' besitzt keinen vollstaendigen Laufweg.`);
  let routeLengthMm = 0;
  const protectionContractRuns = [];
  for (const [index, rawLeg] of route.legs.entries()) {
    const leg = record(rawLeg, `Timetable-Route ${playableLegId}.legs[${index}]`);
    exactKeys(leg, [
      "edgeId",
      "direction",
      "edgeEntryMm",
      "edgeExitMm",
      "availableProtectionSystems",
      "simultaneouslyRequiredProtectionSystems",
    ], `Timetable-Route ${playableLegId}.legs[${index}]`);
    nonEmptyString(leg.edgeId, `Timetable-Route ${playableLegId}.legs[${index}].edgeId`);
    invariant(leg.direction === "along" || leg.direction === "against", `Timetable-Route ${playableLegId}.legs[${index}] besitzt eine fremde Richtung.`);
    invariant(Number.isSafeInteger(leg.edgeEntryMm) && Number.isSafeInteger(leg.edgeExitMm) && leg.edgeEntryMm >= 0 && leg.edgeExitMm >= 0 && leg.edgeEntryMm !== leg.edgeExitMm, `Timetable-Route ${playableLegId}.legs[${index}] besitzt ungueltige Offsets.`);
    routeLengthMm += Math.abs(leg.edgeExitMm - leg.edgeEntryMm);
    invariant(Number.isSafeInteger(routeLengthMm), `Timetable-Route fuer '${playableLegId}' ist zu lang.`);
    const availableProtectionSystems = canonicalProtectionSystems(
      leg.availableProtectionSystems,
      `Timetable-Route ${playableLegId}.legs[${index}].availableProtectionSystems`,
      false,
    );
    const simultaneouslyRequiredProtectionSystems = canonicalProtectionSystems(
      leg.simultaneouslyRequiredProtectionSystems,
      `Timetable-Route ${playableLegId}.legs[${index}].simultaneouslyRequiredProtectionSystems`,
      true,
    );
    invariant(
      simultaneouslyRequiredProtectionSystems.every((system) => availableProtectionSystems.includes(system)),
      `Timetable-Route ${playableLegId}.legs[${index}] besitzt eine unmoegliche gleichzeitige Zugsicherungspflicht.`,
    );
    const previous = protectionContractRuns.at(-1);
    if (
      previous !== undefined
      && alphaCanonicalJson(previous.availableProtectionSystems) === alphaCanonicalJson(availableProtectionSystems)
      && alphaCanonicalJson(previous.simultaneouslyRequiredProtectionSystems) === alphaCanonicalJson(simultaneouslyRequiredProtectionSystems)
    ) {
      previous.throughRouteLegIndex = index;
    } else {
      protectionContractRuns.push({
        throughRouteLegIndex: index,
        availableProtectionSystems,
        simultaneouslyRequiredProtectionSystems,
      });
    }
  }
  invariant(routeLengthMm > 0, `Timetable-Route fuer '${playableLegId}' ist leer.`);
  const passengerStopAnchors = validatePassengerStopAnchors(route);
  const dispatchInterlockingRouteId = germanyOperationalStableId(
    "interlocking:synthetic-segment:",
    [route.routeVersionId, "0"],
  );
  seen.add(playableLegId);
  return Object.freeze({
    playableLegId,
    routeVersionId: route.routeVersionId,
    templateId: route.templateId,
    dispatchInterlockingRouteId,
    routeLengthMm,
    edgeIds: Object.freeze([...new Set(route.legs.map((leg) => leg.edgeId))]),
    routeLegCount: route.legs.length,
    protectionContractRuns: Object.freeze(protectionContractRuns.map((run) => Object.freeze(run))),
    ...(passengerStopAnchors === undefined ? {} : {passengerStopAnchors, legs: Object.freeze(route.legs)}),
  });
}

/**
 * Liest JSONSeq begrenzt auf jeweils einen Fahrwegdatensatz. Weder das
 * 83-MB-Routenartefakt noch die Deutschland-Infrastruktur werden materialisiert.
 */
export async function streamTimetableRouteBindings(path, proof, requiredPlayableLegIds) {
  invariant(typeof path === "string" && path !== "", "Timetable-Route-Dateipfad fehlt.");
  exactKeys(proof, ["file", "bytes", "sha256"], "Timetable-Route-Proof");
  invariant(proof.file === "timetable-routes-v2.jsonseq" && safePositiveInteger(proof.bytes, "Timetable-Route-Proof.bytes") && SHA256.test(proof.sha256), "Timetable-Route-Proof ist ungueltig.");
  invariant(requiredPlayableLegIds instanceof Set && requiredPlayableLegIds.size > 0, "Timetable-Route-Auswahl ist leer.");
  for (const id of requiredPlayableLegIds) nonEmptyString(id, "PlayableLeg-ID");
  const absolute = resolve(path);
  invariant(basename(absolute) === proof.file, "Timetable-Route-Dateipfad verletzt die signierte Dateibindung.");
  const metadata = await regularFile(absolute, "Timetable-Route-Artefakt");
  invariant(metadata.size === proof.bytes, "Timetable-Route-Artefakt besitzt eine fremde Bytezahl.");

  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const found = new Map();
  const seen = new Set();
  let carry = "";
  let bytes = 0;
  let lineNumber = 0;
  const consume = (line) => {
    lineNumber += 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() === "") return;
    invariant(Buffer.byteLength(line, "utf8") <= MAX_TIMETABLE_ROUTE_RECORD_BYTES, `Timetable-Route-Zeile ${lineNumber} ueberschreitet die Speichergrenze.`);
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Timetable-Route-Zeile ${lineNumber} ist kein gueltiges JSON: ${error.message}`);
    }
    const summary = timetableRouteSummary(value, requiredPlayableLegIds, seen);
    if (summary !== undefined) found.set(summary.playableLegId, summary);
  };

  for await (const chunk of createReadStream(absolute)) {
    bytes += chunk.length;
    invariant(Number.isSafeInteger(bytes), "Timetable-Route-Dateigroesse liegt ausserhalb des sicheren Ganzzahlbereichs.");
    hash.update(chunk);
    const text = carry + decoder.write(chunk);
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    invariant(Buffer.byteLength(carry, "utf8") <= MAX_TIMETABLE_ROUTE_RECORD_BYTES, "Timetable-Route-Datensatz ueberschreitet die Speichergrenze.");
    for (const line of lines) consume(line);
  }
  carry += decoder.end();
  if (carry !== "") consume(carry);
  invariant(bytes === proof.bytes && hash.digest("hex") === proof.sha256, "Timetable-Route-Artefakt verletzt die Byte- oder SHA-256-Bindung.");
  const missing = [...requiredPlayableLegIds].filter((id) => !found.has(id)).sort();
  invariant(missing.length === 0, `Timetable-Route-Artefakt fehlt fuer: ${missing.join(", ")}.`);
  return Object.freeze(new Map([...found].sort(([left], [right]) => left.localeCompare(right, "en"))));
}

/** Reale Startfakten; GTFS enthaelt keine bestellte Kapazitaet oder Anschlussgarantie. */
export function passengerOutcomeBinding({ trainRunId, lotId, epoch, scheduledDepartureMs, departureS, arrivalS }) {
  nonEmptyString(trainRunId, "Fahrtenabschluss.trainRunId");
  nonEmptyString(lotId, "Fahrtenabschluss.lotId");
  const epochMs = Date.parse(epoch);
  invariant(Number.isSafeInteger(epochMs) && epochMs % 86_400_000 === 0, "Fahrtenabschluss braucht die explizite Mitternachts-Weltepoche.");
  invariant(
    [scheduledDepartureMs, departureS, arrivalS].every((value) => Number.isSafeInteger(value) && value >= 0)
      && arrivalS >= departureS
      && scheduledDepartureMs === departureS % NORMALIZED_SCHEDULE_REPEAT_EVERY_S * 1_000,
    "Fahrtenabschluss besitzt keine konsistente GTFS-Sollzeit.",
  );
  const scheduledArrivalMs = scheduledDepartureMs + (arrivalS - departureS) * 1_000;
  invariant(Number.isSafeInteger(scheduledArrivalMs), "Fahrtenabschluss-Sollankunft liegt ausserhalb des sicheren Bereichs.");
  return Object.freeze({
    schemaVersion: "zugfolge-operational-service-outcome-binding/v1",
    serviceId: trainRunId,
    serviceRunId: `${trainRunId}:service-day:${new Date(epochMs).toISOString().slice(0, 10)}`,
    lotId,
    serviceDay: new Date(epochMs).toISOString().slice(0, 10),
    scheduledArrivalMs,
    requiredSeats: null,
    connectionAssessment: "unavailable",
  });
}

/** Kapazitaet stammt aus denselben signierten Fahrzeugassets wie die physische Formation. */
export function serviceOutcomePolicy({ vehicles, authorityAssets, authorityReleaseHash, serviceIds }) {
  invariant(SHA256.test(authorityReleaseHash), "Fahrtenabschluss besitzt keinen Fleet-Authority-Hash.");
  invariant(Array.isArray(serviceIds) && serviceIds.length > 0 && new Set(serviceIds).size === serviceIds.length
    && serviceIds.every((id) => typeof id === "string" && id.trim() !== ""), "Fahrtenabschluss braucht eindeutige signierte Basisfahrten.");
  const assetsById = new Map(authorityAssets.map((asset) => [asset.id, asset]));
  invariant(assetsById.size === authorityAssets.length, "Fahrtenabschluss-Fahrzeugquelle enthaelt doppelte Kennungen.");
  const vehicleIds = new Set();
  const vehicleCapacities = vehicles.map((vehicle) => {
    const asset = assetsById.get(vehicle.id);
    invariant(!vehicleIds.has(vehicle.id) && asset !== undefined, "Fahrtenabschluss besitzt keine eindeutige Fahrzeugquellenbindung.");
    vehicleIds.add(vehicle.id);
    invariant(Number.isSafeInteger(asset.passenger?.seats) && asset.passenger.seats >= 0, "Fahrtenabschluss besitzt keinen realen Sitzplatznachweis.");
    return Object.freeze({
      vehicleId: vehicle.id,
      seats: asset.passenger.seats,
      sourceReference: `fleet-authority:${authorityReleaseHash}:vehicle:${vehicle.id}`,
    });
  }).sort((left, right) => left.vehicleId < right.vehicleId ? -1 : left.vehicleId > right.vehicleId ? 1 : 0);
  return Object.freeze({ schemaVersion: "zugfolge-operational-service-outcome-policy/v1", serviceIds: Object.freeze([...serviceIds].sort()), vehicleCapacities: Object.freeze(vehicleCapacities) });
}

export async function buildAlphaWorld(argv = process.argv.slice(2)) {
const [
  buildConfigurationPath,
  gtfsPath,
  fleetCatalogPath,
  infraReleasePath,
  economySpecPath,
  outputPath,
  publicConfigurationPath,
  operationalV2Path,
  timetableRoutesPath,
  timetableTransferDemandsPath,
  movementRouteTemplatesPath,
  vehicleReceiptPath,
  vehicleInventoryPath,
  vehicleSourceCatalogPath,
  vehicleWorldSeedPath,
  vehicleCompiledCatalogPath,
] = argv;
if (!buildConfigurationPath || !gtfsPath || !fleetCatalogPath || !infraReleasePath || !economySpecPath || !outputPath || !publicConfigurationPath || !operationalV2Path || !timetableRoutesPath || !timetableTransferDemandsPath || !movementRouteTemplatesPath) {
  throw new Error("Aufruf: node build-alpha-world.mjs BUILD-CONFIG.json GTFS.json FLEET-CATALOG-V2.json INFRA-RELEASE-WRAPPER.json ECONOMY.json OUTPUT.json PUBLIC-ODOO-CONFIG.json OPERATIONAL-INFRASTRUCTURE-V2.json TIMETABLE-ROUTES-V2.jsonseq TIMETABLE-TRANSFER-DEMANDS-V2.json MOVEMENT-ROUTE-TEMPLATES-V2.json VEHICLE-RECEIPT-V4.json VEHICLE-INVENTORY-V2.json VEHICLE-SOURCE-V2.json VEHICLE-WORLD-SEED-V3.json VEHICLE-CATALOG-V3.json");
}
await assertCreateNewTargetMissing(resolve(outputPath), "Alpha-Weltdeployment");

const buildConfiguration = validateAlphaWorldBuildConfiguration(JSON.parse(await readFile(buildConfigurationPath, "utf8")));
const WORLD_ID = buildConfiguration.worldId;
const REGION_ID = buildConfiguration.regionId;
const REGION_VARIANT = buildConfiguration.regionVariant;
const OPERATOR_ID = buildConfiguration.operatorId;
const PUBLIC_WORLD_SEED = BigInt(buildConfiguration.seed);
const PUBLIC_PLANNING_AUTHORITY_ACCOUNT_ID = buildConfiguration.planningAuthority.accountId;
const WORLD_DURATION_S = 365 * 86_400;
const RELEASE_VALID_UNTIL_S = WORLD_DURATION_S + 86_400;

async function loadDeployConfiguration(path, expectedWorldId, expectedKind) {
  if (path === undefined) throw new Error("Produktiver Weltbuild braucht eine explizite Odoo-Signierkonfiguration mit Weltepoche.");
  const configuration = JSON.parse(await readFile(path, "utf8"));
  const definition = configuration?.worldDefinition;
  const epoch = new Date(definition?.epoch);
  if (
    configuration?.schemaVersion !== "zugfolge-alpha-world-deploy-configuration/v1"
    || Object.keys(configuration).length !== 5
    || configuration.worldId !== expectedWorldId
    || !Number.isSafeInteger(configuration.deploymentRevision)
    || configuration.deploymentRevision < 1
    || typeof definition !== "object"
    || definition === null
    || Array.isArray(definition)
    || Object.keys(definition).length !== 5
    || typeof definition.name !== "string"
    || definition.name.trim() === ""
    || definition.kind !== expectedKind
    || definition.rankingStatus !== (expectedKind === "public" ? "ranked" : "unranked")
    || !Number.isSafeInteger(definition.schedulePeriodWeeks)
    || definition.schedulePeriodWeeks < 3
    || definition.schedulePeriodWeeks > 8
    || typeof definition.epoch !== "string"
    || Number.isNaN(epoch.getTime())
    || epoch.getUTCDay() !== 1
    || epoch.getUTCHours() !== 0
    || epoch.getUTCMinutes() !== 0
    || epoch.getUTCSeconds() !== 0
    || epoch.getUTCMilliseconds() !== 0
  ) throw new Error(`Odoo-Signierkonfiguration fuer '${expectedWorldId}' ist ungueltig.`);
  return {
    ...configuration,
    worldDefinition: { ...definition, epoch: epoch.toISOString() },
    startingCapitalPolicy: serializeStartingCapitalPolicy(parseStartingCapitalPolicy(configuration.startingCapitalPolicy)),
  };
}

const publicDeployConfiguration = await loadDeployConfiguration(publicConfigurationPath, WORLD_ID, "public");

function playableLegs(chain) {
  return chain.legs.filter((leg) => leg.kind === "playable");
}

function alphaLotRecords(chains, gtfsReleaseId) {
  const lotsByRoute = new Map();
  for (const chain of chains) {
    const key = alphaCanonicalJson({ routeId: chain.routeId, routeShortName: chain.routeShortName });
    const group = lotsByRoute.get(key) ?? { routeId: chain.routeId, routeShortName: chain.routeShortName, chains: [] };
    group.chains.push(chain);
    lotsByRoute.set(key, group);
  }
  const records = [...lotsByRoute.values()].map(({ routeId, routeShortName, chains: values }) => {
    return { ...alphaServiceLotIdentifiers({ gtfsReleaseId, routeId, routeShortName }), routeId, routeShortName, chains: values };
  }).sort((left, right) => left.lotId.localeCompare(right.lotId, "en"));
  invariant(new Set(records.map(({ lotId }) => lotId)).size === records.length, "GTFS-Loskennungen besitzen eine Identitaetskollision.");
  invariant(new Set(records.map(({ serviceLineId }) => serviceLineId)).size === records.length, "GTFS-Linienkennungen besitzen eine Identitaetskollision.");
  return records;
}

function validateTimetableTransferDemandsArtifact({
  artifact,
  binding,
  infraReleaseId,
  gtfsSnapshotHash,
  journeyChains,
  stations,
  gtfsReleaseId,
}) {
  exactKeys(artifact, [
    "schema",
    "infraReleaseId",
    "gtfsSnapshotHash",
    "dailyPlan",
    "formationLengthsMm",
    "transferRoutes",
    "transferSetSha256",
  ], "Timetable-Transferplan");
  invariant(
    artifact.schema === "zugfolge-timetable-transfer-demands/v2"
      && artifact.infraReleaseId === infraReleaseId
      && artifact.gtfsSnapshotHash === gtfsSnapshotHash
      && artifact.transferSetSha256 === binding.transferSetSha256
      && artifact.dailyPlan?.planSha256 === binding.dailyPlanSha256,
    "Timetable-Transferplan verletzt seine Release- oder Hashbindung.",
  );
  invariant(
    artifact.dailyPlan?.schema === DAILY_CIRCULATION_PLAN_SCHEMA
      && Array.isArray(artifact.dailyPlan.rolloverAssignments)
      && Array.isArray(artifact.dailyPlan.transferDemands),
    "Timetable-Transferplan besitzt keinen vollstaendigen DailyPlan.",
  );
  const transferPairs = new Set(artifact.dailyPlan.rolloverAssignments
    .filter((assignment) => assignment?.kind === "transfer")
    .map((assignment) => `${assignment.sourceCirculationId}\u0000${assignment.targetCirculationId}`));
  const reproduced = deriveDailyCirculationPlan({
    journeyChains,
    stations,
    gtfsReleaseId,
    repeatEveryS: artifact.dailyPlan.repeatEveryS,
    minimumTurnaroundS: artifact.dailyPlan.minimumTurnaroundS,
    transferCost: ({ sourceCirculation, targetCirculation }) => (
      transferPairs.has(`${sourceCirculation.id}\u0000${targetCirculation.id}`) ? 0 : null
    ),
  });
  invariant(
    reproduced.planSha256 === binding.dailyPlanSha256
      && alphaCanonicalJson(reproduced) === alphaCanonicalJson(artifact.dailyPlan),
    "Timetable-Transferplan laesst sich aus dem signierten Fahrplan nicht identisch reproduzieren.",
  );
  invariant(
    Array.isArray(artifact.formationLengthsMm)
      && artifact.formationLengthsMm.length > 0
      && artifact.formationLengthsMm.every((lengthMm) => Number.isSafeInteger(lengthMm) && lengthMm > 0)
      && new Set(artifact.formationLengthsMm).size === artifact.formationLengthsMm.length
      && Array.isArray(artifact.transferRoutes),
    "Timetable-Transferplan besitzt keine eindeutigen Formationslaengen oder Transferwege.",
  );
  const demandById = new Map(reproduced.transferDemands.map((demand) => [demand.id, demand]));
  const seen = new Set();
  for (const [index, route] of artifact.transferRoutes.entries()) {
    exactKeys(route, [
      "id", "lotId", "assetCompatibilityKey", "sourceCirculationId", "targetCirculationId",
      "sourcePassengerLegId", "targetPassengerLegId", "sourceLocationId", "targetLocationId",
      "sourcePhysicalStopId", "targetPhysicalStopId", "earliestDepartureS", "latestArrivalS",
      "availableWindowS", "dailyBoundary", "movementKind", "sourcePassengerRouteVersionId",
      "targetPassengerRouteVersionId", "formationLengthsMm", "routeVersionId", "templateId",
      "legs", "totalLengthMm", "weightedCostMm", "minimumRuntimeMs",
    ], `Timetable-Transferweg[${index}]`);
    const demand = demandById.get(route?.id);
    if (
      demand === undefined
      || seen.has(route.id)
      || alphaCanonicalJson(Object.fromEntries(Object.keys(demand).map((key) => [key, route[key]])))
        !== alphaCanonicalJson(demand)
      || alphaCanonicalJson(route.formationLengthsMm) !== alphaCanonicalJson(artifact.formationLengthsMm)
      || !nonEmptyString(route.sourcePassengerRouteVersionId, `Transferweg[${index}].sourcePassengerRouteVersionId`)
      || !nonEmptyString(route.targetPassengerRouteVersionId, `Transferweg[${index}].targetPassengerRouteVersionId`)
      || !nonEmptyString(route.routeVersionId, `Transferweg[${index}].routeVersionId`)
      || !nonEmptyString(route.templateId, `Transferweg[${index}].templateId`)
      || !Array.isArray(route.legs)
      || route.legs.length === 0
      || !Number.isSafeInteger(route.minimumRuntimeMs)
      || route.minimumRuntimeMs <= 0
      || route.minimumRuntimeMs > demand.availableWindowS * 1_000
    ) throw new Error(`Timetable-Transferweg '${route?.id ?? index}' ist nicht vollstaendig releasegebunden.`);
    seen.add(route.id);
  }
  invariant(
    seen.size === demandById.size,
    "Timetable-Transferplan bildet nicht jede Transferanforderung genau einmal ab.",
  );
  const transferHasher = createHash("sha256");
  for (const route of artifact.transferRoutes) transferHasher.update(`${alphaCanonicalJson(route)}\n`);
  invariant(
    transferHasher.digest("hex") === binding.transferSetSha256,
    "Timetable-Transferwege verletzen ihren kanonischen Set-Hash.",
  );
  return Object.freeze({
    dailyPlan: reproduced,
    formationLengthsMm: Object.freeze([...artifact.formationLengthsMm]),
    transferRoutes: Object.freeze([...artifact.transferRoutes]),
    transferSetSha256: artifact.transferSetSha256,
  });
}

function parseEconomySpec(specification) {
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

const [
  gtfsBytes,
  fleetBytes,
  infraBytes,
  economyBytes,
  generatorBytes,
  vehicleBinderBytes,
  vehicleMigrationBytes,
  vehicleReceiptBytes,
  vehicleInventoryBytes,
  vehicleSourceCatalogBytes,
  vehicleWorldSeedBytes,
  vehicleCompiledCatalogBytes,
  timetableTransferDemandsBytes,
  movementRouteTemplatesBytes,
  passengerStopBinderBytes,
  movementAllocatorBytes,
] = await Promise.all([
  readFile(gtfsPath),
  readFile(fleetCatalogPath),
  readFile(infraReleasePath),
  readFile(economySpecPath),
  readFile(new URL(import.meta.url)),
  readFile(new URL("./vehicle-catalog-deployment-binding.mjs", import.meta.url)),
  readFile(new URL("./migrate-alpha-fleet-v1-to-v2.mjs", import.meta.url)),
  vehicleReceiptPath === undefined ? undefined : readFile(vehicleReceiptPath),
  vehicleInventoryPath === undefined ? undefined : readFile(vehicleInventoryPath),
  vehicleSourceCatalogPath === undefined ? undefined : readFile(vehicleSourceCatalogPath),
  vehicleWorldSeedPath === undefined ? undefined : readFile(vehicleWorldSeedPath),
  vehicleCompiledCatalogPath === undefined ? undefined : readFile(vehicleCompiledCatalogPath),
  readFile(timetableTransferDemandsPath),
  readFile(movementRouteTemplatesPath),
  readFile(new URL("./passenger-stop-binding-v1.mjs", import.meta.url)),
  readFile(new URL("./movement-route-allocation-v2.mjs", import.meta.url)),
]);
const gtfsEnvelope = JSON.parse(gtfsBytes);
const fleetCatalog = JSON.parse(fleetBytes);
const infraReleaseWrapper = unwrapInfraReleaseManifest(JSON.parse(infraBytes));
const infraRelease = infraReleaseWrapper.release;
const economySpecification = parseEconomySpec(JSON.parse(economyBytes));
const timetableTransferDemands = JSON.parse(timetableTransferDemandsBytes);
const movementRouteTemplates = JSON.parse(movementRouteTemplatesBytes);
await Promise.all([
  assertBoundSmallArtifact(
    timetableTransferDemandsPath,
    timetableTransferDemandsBytes,
    buildConfiguration.timetableTransferDemands,
    "Timetable-Transferplan",
  ),
  assertBoundSmallArtifact(
    movementRouteTemplatesPath,
    movementRouteTemplatesBytes,
    buildConfiguration.movementRouteTemplates,
    "Movement-Route-Vorlagen",
  ),
]);
const operationalInfrastructureBinding = await verifyOperationalInfrastructureArtifact(operationalV2Path, infraRelease);
const {
  schemaVersion: fleetAuthoritySchema,
  entry: fleetCatalogEntry,
} = selectVehicleCatalogAuthority(fleetCatalog, WORLD_ID);
const vehicleCatalogV2 = assertVehicleCatalogProofInputs(
  fleetAuthoritySchema,
  vehicleReceiptBytes,
  vehicleInventoryBytes,
  vehicleSourceCatalogBytes,
  vehicleWorldSeedBytes,
  vehicleCompiledCatalogBytes,
);
if (!vehicleCatalogV2) {
  throw new Error("Alpha-v2 akzeptiert ausschliesslich einen reproduzierbar kompilierten Fleet-Authority-v2-Artefaktsatz; Authority-v1 ist nur Eingabe des getrennten Offline-Migrationscompilers.");
}
const vehicleReceipt = vehicleReceiptBytes === undefined ? undefined : JSON.parse(vehicleReceiptBytes);
const vehicleInventory = vehicleInventoryBytes === undefined ? undefined : JSON.parse(vehicleInventoryBytes);
const gtfs = gtfsEnvelope.snapshot;
if (gtfs?.generationSeed !== buildConfiguration.seed) throw new Error("Spiel-Fahrplan und Weltbuild besitzen unterschiedliche Weltseeds.");

const serviceDate = gtfs?.serviceDate;
const timetableYear = Number(serviceDate?.slice(0, 4));
const gtfsReleaseBinding = assertSignedGtfsTimetableBinding({
  infraRelease,
  gtfsEnvelope,
  gtfsBytes,
  timetableRoutes: buildConfiguration.timetableRoutes,
  worldId: WORLD_ID,
});
if (
  infraRelease.releaseId !== operationalInfrastructureBinding.infraReleaseId
  || alphaCanonicalJson(buildConfiguration.operationalInfrastructure) !== alphaCanonicalJson({
    file: operationalInfrastructureBinding.file,
    bytes: operationalInfrastructureBinding.bytes,
    sha256: operationalInfrastructureBinding.sha256,
    stateHash: operationalInfrastructureBinding.stateHash,
  })
  || !/^20[0-9]{6}$/u.test(serviceDate ?? "")
  || gtfs?.regionId !== REGION_ID
  || gtfs?.regionVariant !== REGION_VARIANT
) throw new Error("Deutschland-InfraRelease, GTFS-Snapshot und explizite Regionsbindung laufen auseinander.");
const regionalReleaseContract = Object.freeze({
  fleetReleaseId: buildConfiguration.fleetReleaseId,
  serviceDate,
  timetableYear,
});
const scheduleTimeContract = assertNormalizedScheduleTimeContract({
  worldEpoch: publicDeployConfiguration.worldDefinition.epoch,
  serviceDate: regionalReleaseContract.serviceDate,
  timeZone: NORMALIZED_SCHEDULE_TIME_ZONE,
  serviceStartOffsetS: 0,
  repeatEveryS: NORMALIZED_SCHEDULE_REPEAT_EVERY_S,
});
if (gtfs.journeyChains.some((chain) => chain.worldId !== WORLD_ID)) throw new Error("GTFS-Fahrtketten verletzen die UUID-Weltbindung.");
const stationById = new Map();
for (const station of gtfs.stations ?? []) {
  nonEmptyString(station?.stopId, "GTFS-Betriebsstelle.stopId");
  if (stationById.has(station.stopId)) throw new Error(`GTFS-Betriebsstelle '${station.stopId}' ist doppelt.`);
  stationById.set(station.stopId, station);
}
const chains = gtfs.journeyChains.filter((chain) => chain.orderable === true);
if (chains.some((chain) => playableLegs(chain).length === 0 || playableLegs(chain).some((leg) => leg.orderable !== true || leg.qualityClass !== "B"))) {
  throw new Error("Bestellbarer GTFS-Fahrplan enthaelt keine vollstaendig qualifizierten Klasse-B-Segmente.");
}
const timetableTransferPlan = validateTimetableTransferDemandsArtifact({
  artifact: timetableTransferDemands,
  binding: buildConfiguration.timetableTransferDemands,
  infraReleaseId: infraRelease.releaseId,
  gtfsSnapshotHash: gtfsEnvelope.snapshotHash,
  journeyChains: chains,
  stations: gtfs.stations,
  gtfsReleaseId: gtfsReleaseBinding.releaseId,
});
invariant(
  timetableTransferPlan.transferSetSha256
    === buildConfiguration.movementRouteTemplates.timetableTransferSetSha256,
  "Timetable-Transferplan und Movement-Route-Vorlagen besitzen verschiedene Transfermengen.",
);
const movementRoutePlan = validateMovementRouteTemplatesV2({
  artifact: movementRouteTemplates,
  binding: buildConfiguration.movementRouteTemplates,
  infraReleaseId: infraRelease.releaseId,
  operationalStateHash: operationalInfrastructureBinding.stateHash,
  timetableTransferPlan,
});
const timetableRouteBindings = await streamTimetableRouteBindings(
  timetableRoutesPath,
  buildConfiguration.timetableRoutes,
  new Set(chains.flatMap((chain) => playableLegs(chain).map((leg) => leg.legId))),
);
const operationalTrainRunId = (chain, leg, playableIndex) => (
  playableIndex === 0 ? chain.journeyChainId : `${chain.journeyChainId}:${leg.legId}`
);
const publicTrainNumbers = allocatePublicRegionalTrainNumbers(chains.flatMap((chain) => (
  playableLegs(chain).map((leg, playableIndex) => operationalTrainRunId(chain, leg, playableIndex))
)));
if (chains.length !== gtfs.metrics?.orderableJourneyChainCount || chains.length === 0) throw new Error("Bestellbarer Fahrplan und signierter GTFS-Zaehler laufen auseinander.");

const sourceLotRecords = alphaLotRecords(chains, gtfsReleaseBinding.releaseId);
const servicePlanningRules = JSON.parse(await readFile(new URL("./specifications/regional-service-planning-alpha-2026.1.json", import.meta.url), "utf8"));
const servicePlanning = buildAlphaServicePlanning({
  worldId: WORLD_ID,
  infraReleaseId: infraRelease.releaseId,
  gtfsEnvelope,
  lotRecords: sourceLotRecords,
  timetableRouteBindings,
  assets: fleetCatalogEntry.authorityRelease.assets,
  circulations: timetableTransferPlan.dailyPlan.circulations,
  rules: servicePlanningRules,
});
const planningLotByLine = new Map(servicePlanning.snapshot.lots.flatMap((lot) => lot.lineIds.map((lineId) => [lineId, lot])));
const lotRecords = sourceLotRecords.map((lot) => ({ ...lot, sourceLotId: lot.lotId, lotId: planningLotByLine.get(lot.serviceLineId).id }));
if (lotRecords.length < 8) throw new Error("Der Vergabekalender braucht mindestens acht getrennte SPNV-Lose.");

const catalogAssets = fleetCatalogEntry.authorityRelease.assets;
const authorityAssetById = new Map(catalogAssets.map((asset) => [asset.id, asset]));
const compilerFormationById = new Map(compilerFleetFormations(vehicleInventory).map((formation) => [formation.id, formation]));
if (authorityAssetById.size !== catalogAssets.length) throw new Error("Fleet-Authority-v2 besitzt doppelte Fahrzeugkennungen.");

const assets = [];
const personnelPools = [];
const pathReceipts = [];
const formations = [];
const personnelDuties = [];
const pathReservations = [];
const regionalTrains = [];
const passengerStopInputs = new Map();
const blueprintLots = [];
const publicVehiclePoolByLot = {};
let numericPersonnelId = 20_000;
let numericRouteId = 30_000;
const circulationsByLot = new Map();
const circulationAssignmentByJourney = new Map();
for (const circulation of timetableTransferPlan.dailyPlan.circulations) {
  const lotCirculations = circulationsByLot.get(circulation.lotId) ?? [];
  lotCirculations.push(circulation);
  circulationsByLot.set(circulation.lotId, lotCirculations);
  for (const journeyChainId of circulation.journeyChainIds) {
    invariant(
      !circulationAssignmentByJourney.has(journeyChainId),
      `JourneyChain '${journeyChainId}' ist mehreren Daily-Circulations zugeordnet.`,
    );
    circulationAssignmentByJourney.set(journeyChainId, circulation.id);
  }
}
invariant(
  circulationAssignmentByJourney.size === chains.length,
  "Daily-Circulation-Plan bildet nicht jede bestellbare JourneyChain genau einmal ab.",
);

function routeForLeg(leg, timetableRoute) {
  if (leg?.orderable !== true || leg.qualityClass !== "B") throw new Error(`Spielbares Segment ${leg.legId} ist nicht bestellbar.`);
  const routeLengthMm = safePositiveInteger(timetableRoute?.routeLengthMm, `Timetable-Route ${leg.legId}.routeLengthMm`);
  return leg.stops.map((stop, index) => {
    if (!stationById.has(stop.stopId)) throw new Error(`Haltestelle ${stop.stopId} fehlt im signierten GTFS-Betriebsstellenkorpus.`);
    const anchor = timetableRoute.passengerStopAnchors?.[index];
    if (timetableRoute.passengerStopAnchors !== undefined)
      invariant(timetableRoute.passengerStopAnchors.length === leg.stops.length && anchor?.stationId === stop.stopId
        && anchor.stopSequence === stop.stopSequence, `Halteanker ${leg.legId} widerspricht den geordneten Fahrplanhalten.`);
    const operatingPoint = index === 0 && leg.entryPortalId !== null
      ? leg.entryPortalId
      : index === leg.stops.length - 1 && leg.exitPortalId !== null
        ? leg.exitPortalId
        : stop.stopId;
    return {
      operatingPoint,
      positionMm: anchor?.routeMm ?? (leg.stops.length === 1 ? 0 : Math.floor(routeLengthMm * index / (leg.stops.length - 1))),
      arrivalS: stop.arrivalS,
      minimumDwellSeconds: stop.departureS - stop.arrivalS,
      departureS: stop.departureS,
    };
  });
}

for (const [lotIndex, lot] of lotRecords.entries()) {
  const circulations = circulationsByLot.get(lot.sourceLotId) ?? [];
  invariant(circulations.length > 0, `Los '${lot.lotId}' besitzt keinen Daily-Circulation-Slot.`);
  const lotRouteBindings = lot.chains.flatMap((chain) => playableLegs(chain).map((leg) => {
    const binding = timetableRouteBindings.get(leg.legId);
    if (binding === undefined) throw new Error(`Los '${lot.lotId}' besitzt keine signierte Timetable-Route fuer '${leg.legId}'.`);
    return binding;
  }));
  const lotConflictCheckHash = canonicalSha256({
    operationalStateHash: operationalInfrastructureBinding.stateHash,
    routes: lotRouteBindings.map(({ routeVersionId, dispatchInterlockingRouteId }) => ({ routeVersionId, dispatchInterlockingRouteId })),
  });
  const vehicleIds = [];
  const dutyIds = [];
  const circulationIds = [];
  const formationByCirculation = new Map();
  const dutyByCirculation = new Map();

  for (const circulation of circulations) {
    numericPersonnelId += 1;
    numericRouteId += 1;
    const suffix = circulation.id.slice("circulation-".length);
    const formationId = `formation-${suffix}`;
    const dutyId = `personnel-allocation-${suffix}`;
    const poolId = `personnel-pool-${suffix}`;
    const receiptId = `path-circulation-${suffix}`;
    const compiledFormation = compilerFormationById.get(formationId);
    if (compiledFormation === undefined || compiledFormation.vehicleIds.length !== 1 || compiledFormation.pathReceiptId !== receiptId) {
      throw new Error(`Fleet-Authority-v2 besitzt keine eindeutige kompilierte Formation fuer '${circulation.id}'.`);
    }
    const assetId = compiledFormation.vehicleIds[0];
    const asset = authorityAssetById.get(assetId);
    if (
      asset === undefined
      || asset.operatorId !== OPERATOR_ID
      || alphaCanonicalJson(asset.approvedLineIds) !== alphaCanonicalJson([lot.serviceLineId])
    ) throw new Error(`Fleet-Authority-v2 bindet Formation '${formationId}' nicht an das Ziel-Los.`);
    const battery = asset.technical?.traction === "battery";
    const electric = asset.technical?.traction === "electric";
    if (!battery && !electric) throw new Error(`Alpha-Fahrzeug '${assetId}' besitzt keine freigegebene elektrische oder Batterie-Traktion.`);
    const electrifications = battery ? ["unelectrified", "overhead-ac15kv"] : ["overhead-ac15kv"];
    assets.push(asset);
    pathReceipts.push({
      id: receiptId,
      numericRouteId,
      operatorId: OPERATOR_ID,
      serviceLineIds: [lot.serviceLineId],
      decision: "confirmed",
      validFrom: 0,
      validUntil: RELEASE_VALID_UNTIL_S,
      platformLengthsMm: [120_000],
      electrifications,
      requiredProtection: ["pzb"],
      approvedClasses: [asset.classDesignation],
      plannerStateHash: operationalInfrastructureBinding.stateHash,
      conflictCheckHash: lotConflictCheckHash,
    });
    personnelPools.push({
      id: poolId,
      numericId: numericPersonnelId,
      operatorId: OPERATOR_ID,
      capacitySeconds: WORLD_DURATION_S,
      minimumRestSeconds: 39_600,
      classDesignations: [asset.classDesignation],
      pathReceiptIds: [receiptId],
      qualificationHash: sha256(`${asset.classDesignation}\u0000${receiptId}\u0000${operationalInfrastructureBinding.stateHash}`),
    });
    formations.push({ id: formationId, vehicleIds: [assetId], pathReceiptId: receiptId });
    personnelDuties.push({ id: dutyId, personnelPoolId: poolId, formationIds: [formationId], pathReceiptId: receiptId, validFrom: 0, validUntil: WORLD_DURATION_S });
    formationByCirculation.set(circulation.id, formationId);
    dutyByCirculation.set(circulation.id, dutyId);
    vehicleIds.push(assetId);
    dutyIds.push(dutyId);
    circulationIds.push(circulation.id);
  }

  const pathReceiptIds = [];
  const lotTrainRunIds = [];
  for (const chain of [...lot.chains].sort((left, right) => left.journeyChainId.localeCompare(right.journeyChainId))) {
    numericRouteId += 1;
    const circulationId = circulationAssignmentByJourney.get(chain.journeyChainId);
    const formationId = formationByCirculation.get(circulationId);
    const dutyId = dutyByCirculation.get(circulationId);
    const assetId = formations.find((formation) => formation.id === formationId)?.vehicleIds[0];
    if (!formationId || !dutyId || !assetId) throw new Error(`Umlaufbindung fuer ${chain.journeyChainId} fehlt.`);
    const assignedAsset = authorityAssetById.get(assetId);
    if (assignedAsset === undefined) throw new Error(`Umlaufbindung fuer ${chain.journeyChainId} verweist auf ein fremdes Fahrzeug.`);
    const electrifications = assignedAsset.technical?.traction === "battery"
      ? ["unelectrified", "overhead-ac15kv"]
      : ["overhead-ac15kv"];
    const receiptId = `path-${chain.journeyChainId}`;
    const chainRouteBindings = playableLegs(chain).map((leg) => {
      const binding = timetableRouteBindings.get(leg.legId);
      if (binding === undefined) throw new Error(`Fahrtkette '${chain.journeyChainId}' besitzt keine signierte Timetable-Route fuer '${leg.legId}'.`);
      return binding;
    });
    pathReceipts.push({
      id: receiptId,
      numericRouteId,
      operatorId: OPERATOR_ID,
      serviceLineIds: [lot.serviceLineId],
      decision: "confirmed",
      validFrom: 0,
      validUntil: RELEASE_VALID_UNTIL_S,
      platformLengthsMm: [120_000],
      electrifications,
      requiredProtection: ["pzb"],
      approvedClasses: [assignedAsset.classDesignation],
      plannerStateHash: operationalInfrastructureBinding.stateHash,
      conflictCheckHash: canonicalSha256({
        operationalStateHash: operationalInfrastructureBinding.stateHash,
        routes: chainRouteBindings.map(({ routeVersionId, dispatchInterlockingRouteId }) => ({ routeVersionId, dispatchInterlockingRouteId })),
      }),
    });
    pathReservations.push({ id: `reservation-${chain.journeyChainId}`, pathReceiptId: receiptId });
    pathReceiptIds.push(receiptId);

    const chainPlayableLegs = playableLegs(chain);
    for (const [playableIndex, leg] of chainPlayableLegs.entries()) {
      const timetableRoute = timetableRouteBindings.get(leg.legId);
      if (timetableRoute === undefined) throw new Error(`Fahrtkette '${chain.journeyChainId}' besitzt keine signierte Timetable-Route fuer '${leg.legId}'.`);
      const trainRunId = operationalTrainRunId(chain, leg, playableIndex);
      const trainNumber = publicRegionalTrainNumber(chain.routeShortName, trainRunId, publicTrainNumbers);
      const scheduledDepartureS = leg.stops[0].departureS % NORMALIZED_SCHEDULE_REPEAT_EVERY_S;
      if (!Number.isSafeInteger(scheduledDepartureS) || scheduledDepartureS < 0) throw new Error(`Fahrtkette '${chain.journeyChainId}' besitzt keine normalisierbare Tagesabfahrt.`);
      if (timetableRoute.passengerStopAnchors !== undefined) passengerStopInputs.set(trainRunId, {timetableRoute, timetableStops: leg.stops});
      regionalTrains.push({
        trainRunId,
        journeyChainId: chain.journeyChainId,
        operator: OPERATOR_ID,
        trainNumber,
        category: "regional",
        route: routeForLeg(leg, timetableRoute),
        baseRouteVersionId: timetableRoute.routeVersionId,
        routeVersionId: timetableRoute.routeVersionId,
        dispatchInterlockingRouteId: timetableRoute.dispatchInterlockingRouteId,
        routeLengthMm: timetableRoute.routeLengthMm,
        formationVersionId: formationId,
        formationLengthMm: safePositiveInteger(assignedAsset.technical?.lengthMm, `Fahrt '${trainRunId}'.formationLengthMm`),
        installedProtection: Object.freeze([...assignedAsset.installedProtection]),
        protectionModeSelectionRuns: selectProtectionModeRuns({
          protectionContractRuns: timetableRoute.protectionContractRuns,
          routeLegCount: timetableRoute.routeLegCount,
          installedProtection: assignedAsset.installedProtection,
          context: `Fahrt '${trainRunId}' (${assignedAsset.classDesignation})`,
        }),
        scheduledDepartureMs: scheduledDepartureS * 1_000,
        serviceOutcome: passengerOutcomeBinding({
          trainRunId,
          lotId: lot.lotId,
          epoch: publicDeployConfiguration.worldDefinition.epoch,
          scheduledDepartureMs: scheduledDepartureS * 1_000,
          departureS: leg.stops[0].departureS,
          arrivalS: leg.stops.at(-1).arrivalS,
        }),
      });
      lotTrainRunIds.push(trainRunId);
    }

  }
  publicVehiclePoolByLot[lot.lotId] = vehicleIds;
  blueprintLots.push({
    lotId: lot.lotId,
    contractEndsAtPeriod: 2 + (lotIndex % 9),
    trainRunIds: lotTrainRunIds.sort(),
    pathReceiptIds: pathReceiptIds.sort(),
    vehicleIds: vehicleIds.sort(),
    personnelDutyIds: dutyIds.sort(),
    circulationIds: circulationIds.sort(),
    operatingProgramIds: [`operating-program-${lot.lotId}-daily`],
  });
}

const sortedAssets = assets.sort((left, right) => left.id.localeCompare(right.id));
const sortedPersonnelPools = personnelPools.sort((left, right) => left.id.localeCompare(right.id));
const sortedPathReceipts = pathReceipts.sort((left, right) => left.id.localeCompare(right.id));
const sortedFormations = formations.sort((left, right) => left.id.localeCompare(right.id));
const sortedPersonnelDuties = personnelDuties.sort((left, right) => left.id.localeCompare(right.id));
const sortedPathReservations = pathReservations.sort((left, right) => left.id.localeCompare(right.id));
const activeAssetIds = new Set(sortedAssets.map((asset) => asset.id));
const authorityActiveAssets = fleetCatalogEntry.authorityRelease.assets
  .filter((asset) => activeAssetIds.has(asset.id))
  .sort((left, right) => left.id.localeCompare(right.id));
const reserveAssets = fleetCatalogEntry.authorityRelease.assets
  .filter((asset) => !activeAssetIds.has(asset.id))
  .sort((left, right) => left.id.localeCompare(right.id));
if (
  alphaCanonicalJson(sortedAssets) !== alphaCanonicalJson(authorityActiveAssets)
  || alphaCanonicalJson(sortedPersonnelPools) !== alphaCanonicalJson(fleetCatalogEntry.authorityRelease.personnelPools)
  || alphaCanonicalJson(sortedPathReceipts) !== alphaCanonicalJson(fleetCatalogEntry.authorityRelease.pathReceipts)
) {
  throw new Error("Authority-v2 stammt nicht aus demselben Welt-Seed wie der deterministische Alpha-Build.");
}
if (reserveAssets.some((asset) => alphaCanonicalJson(asset.approvedLineIds) !== alphaCanonicalJson(["reserve-pool"]))) {
  throw new Error("Nicht eingesetzte Authority-v2-Fahrzeuge muessen explizit und ausschliesslich dem Reservepool zugeordnet sein.");
}
const compiledFormations = compilerFleetFormations(vehicleInventory);
const generatedFormationBindings = sortedFormations.map(({ id, vehicleIds, pathReceiptId }) => ({ id, vehicleIds, pathReceiptId }));
const compiledFormationBindings = compiledFormations.map(({ id, vehicleIds, pathReceiptId }) => ({ id, vehicleIds, pathReceiptId }));
if (alphaCanonicalJson(generatedFormationBindings) !== alphaCanonicalJson(compiledFormationBindings)) {
  throw new Error("Authority-v2 und Alpha-Build besitzen verschiedene initiale Formationen.");
}
const fleet = {
  schemaVersion: "zugfolge-fleet-world-initialize/v2",
  worldId: WORLD_ID,
  producedAt: fleetCatalogEntry.producedAt,
  authorityRelease: fleetCatalogEntry.authorityRelease,
  formations: compiledFormations,
  personnelDuties: sortedPersonnelDuties,
  pathReservations: sortedPathReservations,
};
const repeatEveryMs = safePositiveInteger(
  scheduleTimeContract.repeatEveryS * 1_000,
  "Operational-v2-Wiederholungszeit",
);
const dailyContinuities = dailyMovementContinuities({
  dailyPlan: timetableTransferPlan.dailyPlan,
  journeyChains: chains,
});
const rolloverCycles = dailyRolloverCycles(timetableTransferPlan.dailyPlan);
let movementAllocation = allocateMovementRoutePlanV2({
  dailyPlan: timetableTransferPlan.dailyPlan,
  continuities: dailyContinuities,
  passengerTrains: regionalTrains,
  movementRoutePlan,
  repeatEveryMs,
  selectProtectionModeRuns,
});
if (passengerStopInputs.size > 0) {
  const infrastructure = await streamPassengerStopInfrastructure(operationalV2Path, operationalInfrastructureBinding,
    new Set(movementAllocation.programTrains.filter((train) => passengerStopInputs.has(train.id)).map((train) => train.routeVersionId)),
    new Set([...passengerStopInputs.values()].flatMap(({timetableRoute}) => timetableRoute.passengerStopAnchors.map((anchor) => anchor.edgeId))));
  movementAllocation = bindMovementPassengerStopPlansV1(movementAllocation, regionalTrains, ({passenger, materialization}) => {
    const input = passengerStopInputs.get(passenger.trainRunId);
    if (input === undefined) return undefined;
    return bindPassengerStopPlan({...input, passenger, materialization, infrastructure,
      worldId: WORLD_ID, infrastructureReleaseId: infraRelease.releaseId, timetableReleaseId: gtfsReleaseBinding.releaseId,
      sourcePins: {gtfsSnapshotSha256: gtfsEnvelope.snapshotHash, timetableRoutesSha256: buildConfiguration.timetableRoutes.sha256,
        infrastructureStateHash: operationalInfrastructureBinding.stateHash, movementRouteStateHash: movementRoutePlan.stateHash}});
  });
  console.error(JSON.stringify({passengerStopPlans: movementAllocation.programTrains.filter((train) => train.stopPlan !== undefined).length,
    passengerRoutesWithAnchors: passengerStopInputs.size, passengerRoutesWithoutCompleteStopEvidence:
      passengerStopInputs.size - movementAllocation.programTrains.filter((train) => train.stopPlan !== undefined).length}));
}
invariant(
  movementAllocation.metrics.passengerTrainCount === regionalTrains.length
    && movementAllocation.metrics.dailyBoundaryCount === timetableTransferPlan.dailyPlan.circulations.length
    && movementAllocation.metrics.transferCount === timetableTransferPlan.dailyPlan.transferDemands.length
    && rolloverCycles.flat().length === timetableTransferPlan.dailyPlan.circulations.length,
  "Physische Movement-Zuweisung driftet vom vollstaendigen DailyPlan ab.",
);
const buildResult = await publishCreateNewFileFromStaging(outputPath, async ({ stagingDirectory, stagedOutputPath }) => {
const fleetPath = join(stagingDirectory, "fleet-world-initialize-v2.json");
await writeFile(fleetPath, `${JSON.stringify(fleet, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
const fleetProbe = spawnSync("cargo", ["run", "-q", "-p", "zugfolge-runtime", "--example", "fleet_release_hash", "--", fleetPath], { encoding: "utf8" });
if (fleetProbe.status !== 0) throw new Error(`Rust-Fleet-Validierung fehlgeschlagen:\n${fleetProbe.stderr}\n${fleetProbe.stdout}`);
const fleetEvidence = JSON.parse(fleetProbe.stdout.trim().split(/\r?\n/).at(-1));
const operationalFleet = Object.freeze({
  vehicleTypes: Object.freeze(structuredClone(vehicleInventory.vehicleTypes)),
  vehicles: Object.freeze(structuredClone(vehicleInventory.vehicles)),
  formations: Object.freeze(vehicleInventory.formations.map((formation) => Object.freeze({
    id: formation.id,
    predecessorId: formation.predecessorId ?? null,
    vehicleIds: Object.freeze([...formation.vehicleIds]),
  }))),
});
const passengerOutcomes = new Map(regionalTrains.map((train) => [train.trainRunId, train.serviceOutcome]));
const operationalProgramTrains = movementAllocation.programTrains.map((train) => Object.freeze({
  ...train,
  ...(train.publicPassengerStop ? { serviceOutcome: passengerOutcomes.get(train.id) } : {}),
}));
invariant(operationalProgramTrains.every((train) => !train.publicPassengerStop || train.serviceOutcome !== undefined), "Fahrtenabschluss bildet nicht jede Personenfahrt ab.");
const operationalSimulation = Object.freeze({
  schemaVersion: "zugfolge-operational-simulation-initialize/v2",
  worldId: WORLD_ID,
  regionId: REGION_ID,
  nowMs: 0,
  repeatEveryMs,
  protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  infraRelease: operationalInfrastructureBinding,
  vehicleTypes: operationalFleet.vehicleTypes,
  vehicles: operationalFleet.vehicles,
  formations: operationalFleet.formations,
  trains: Object.freeze(operationalProgramTrains),
  movementContinuations: movementAllocation.movementContinuations,
  serviceOutcomePolicy: serviceOutcomePolicy({
    vehicles: operationalFleet.vehicles,
    authorityAssets: fleet.authorityRelease.assets,
    authorityReleaseHash: fleetEvidence.authorityReleaseHash,
    serviceIds: regionalTrains.map((train) => train.serviceOutcome.serviceId),
  }),
});

const economyRelease = buildEconomyRelease({
  version: economySpecification.version,
  rates: economySpecification.rates,
  rules: economySpecification.rules,
  tenderProfiles: economySpecification.tenderProfiles,
});
const economyLots = lotsFromGtfsPlanning(servicePlanning, WORLD_ID);
const tenderGeneration = {
  schemaVersion: TENDER_GENERATION_SCHEMA,
  authorityId: PUBLIC_PLANNING_AUTHORITY_ACCOUNT_ID,
  failurePenaltyCents: 0n,
  authorityBudgetCentsPerPeriod: deriveTenderAuthorityBudgetCents(servicePlanning, WORLD_ID, economyRelease, 12),
};
const economyStarted = startEconomyWorld({
  worldId: WORLD_ID,
  seed: PUBLIC_WORLD_SEED,
  durationMonths: 12,
  release: economyRelease,
  planning: servicePlanning,
  tenderGeneration,
  authorityBudgets: [],
  accounts: [],
  publicVehiclePoolByLot,
});
const tenderCalendarHash = alphaHash("zugfolge-alpha-tender-calendar/v1", economyStarted.state.calendar);
const planningRoute = regionalTrains
  .map((train) => train.route.filter((waypoint) => {
    const station = stationById.get(waypoint.operatingPoint);
    return station?.latitudeE7 !== null
      && station?.latitudeE7 !== undefined
      && station.longitudeE7 !== null
      && station.longitudeE7 !== undefined;
  }))
  .find((route) => route.length >= 2 && route.every((waypoint, index) => (
    index === 0 || route[index - 1].positionMm < waypoint.positionMm
  )));
if (planningRoute === undefined) throw new Error("Signiertes Planning-Release braucht einen linearen Alpha-Korridor mit Koordinaten.");
const planningInfrastructureRelease = {
  schemaVersion: "planning.infrastructure-release/v1",
  worldId: WORLD_ID,
  releaseId: infraRelease.releaseId,
  sourceId: infraReleaseWrapper.releaseHash,
  corridorId: `${REGION_ID}-alpha-corridor`,
  corridorName: `${REGION_ID} Alpha-Korridor`,
  stations: planningRoute.map((waypoint, index) => {
    const station = stationById.get(waypoint.operatingPoint);
    if (
      station?.latitudeE7 === null
      || station?.latitudeE7 === undefined
      || station.longitudeE7 === null
      || station.longitudeE7 === undefined
    ) {
      throw new Error(`Planning-Betriebsstelle '${waypoint.operatingPoint}' besitzt keine Koordinaten.`);
    }
    return {
      numericId: index + 1,
      id: station.stopId,
      code: station.stopId,
      name: station.name,
      distanceMm: waypoint.positionMm,
      latitudeE7: station.latitudeE7,
      longitudeE7: station.longitudeE7,
      stationTrackNumericId: 1_000_000 + index,
      stationTrackLengthMm: 400_000,
      stationMaximumSpeedKph: 80,
    };
  }),
  segments: planningRoute.slice(1).map((waypoint, index) => {
    const previous = planningRoute[index];
    const lengthMm = waypoint.positionMm - previous.positionMm;
    return {
      edgeNumericId: 2_000_000 + index,
      trackNumericId: 3_000_000 + index,
      id: `planning-${previous.operatingPoint}-${waypoint.operatingPoint}-${index + 1}`,
      label: `${previous.operatingPoint}–${waypoint.operatingPoint}`,
      fromStationId: previous.operatingPoint,
      toStationId: waypoint.operatingPoint,
      lengthMm,
      maximumSpeedKph: 160,
      mainSignalPositionsMm: [],
      maximumVirtualBlockLengthMm: Math.min(lengthMm, 10_000_000),
    };
  }),
};

function assertOperationalV2Initialization(value, receipt) {
  const expectedTrains = new Map(operationalProgramTrains.map((train) => [train.id, train]));
  if (
    value?.schemaVersion !== "zugfolge-operational-simulation-initialize/v2"
    || value.worldId !== WORLD_ID
    || value.regionId !== REGION_ID
    || value.nowMs !== 0
    || value.repeatEveryMs !== repeatEveryMs
    || value.protectionModeSelectionPolicy !== OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY
    || !Array.isArray(value.vehicleTypes)
    || value.vehicleTypes.length === 0
    || !Array.isArray(value.vehicles)
    || value.vehicles.length === 0
    || !Array.isArray(value.formations)
    || value.formations.length === 0
    || !Array.isArray(value.trains)
    || value.trains.length !== expectedTrains.size
    || alphaCanonicalJson(value.movementContinuations) !== alphaCanonicalJson(movementAllocation.movementContinuations)
    || alphaCanonicalJson(value.serviceOutcomePolicy) !== alphaCanonicalJson(operationalSimulation.serviceOutcomePolicy)
  ) throw new Error("Operatives v2-Initialisierungsartefakt ist unvollstaendig oder nicht releasegebunden.");
  assertOperationalInfrastructureV2ReleaseBinding({
    initialization: value,
    infraReleaseManifest: infraRelease,
    expectedWorldId: WORLD_ID,
    expectedRegionId: REGION_ID,
  });
  validateOperationalInitializationPreflightReceipt(receipt, value);
  const seen = new Set();
  for (const train of value.trains) {
    const expected = expectedTrains.get(train?.id);
    if (
      expected === undefined
      || seen.has(train.id)
      || train.operatorId !== expected.operatorId
      || train.trainNumber !== expected.trainNumber
      || train.movementKind !== expected.movementKind
      || train.routeVersionId !== expected.routeVersionId
      || train.dispatchInterlockingRouteId !== expected.dispatchInterlockingRouteId
      || train.formationVersionId !== expected.formationVersionId
      || train.scheduledDepartureMs !== expected.scheduledDepartureMs
      || train.headRouteMm !== expected.headRouteMm
      || train.publicPassengerStop !== expected.publicPassengerStop
      || alphaCanonicalJson(train.protectionModeSelectionRuns) !== alphaCanonicalJson(expected.protectionModeSelectionRuns)
      || alphaCanonicalJson(train.serviceOutcome ?? null) !== alphaCanonicalJson(expected.serviceOutcome ?? null)
      || alphaCanonicalJson(train.stopPlan ?? null) !== alphaCanonicalJson(expected.stopPlan ?? null)
    ) throw new Error("Operatives v2-Artefakt verletzt Fahrt-, Betreiber- oder Laufwegbindung.");
    seen.add(train.id);
  }
  if (seen.size !== expectedTrains.size) throw new Error("Operatives v2-Artefakt bildet nicht alle signierten Programmfahrten exakt ab.");
}

const operationalPreflightReceipt = await runOperationalInitializationPreflight({
  initialization: operationalSimulation,
  infrastructurePath: operationalV2Path,
  inputPath: join(stagingDirectory, "operational-initialization-preflight.json"),
});
assertOperationalV2Initialization(operationalSimulation, operationalPreflightReceipt);
const operationalSimulationSourceSha256 = sha256(alphaCanonicalJson(operationalSimulation));
const vehicleCompilerEvidence = await verifyVehicleCatalogCompilerReplay({
  sourceCatalogPath: vehicleSourceCatalogPath,
  worldSeedPath: vehicleWorldSeedPath,
  compiledCatalogPath: vehicleCompiledCatalogPath,
  fleetCatalogPath,
  operationalInventoryPath: vehicleInventoryPath,
  receiptPath: vehicleReceiptPath,
  fleetAuthority: fleet.authorityRelease,
});
const vehicleCatalogBinding = bindVehicleCatalogDeploymentArtifacts({
  fleetCatalog,
  receipt: vehicleReceipt,
  operationalInventory: vehicleInventory,
  fleet,
  regionalSimulation: operationalSimulation,
  economyRelease,
  blueprintFleetHash: fleetEvidence.authorityReleaseHash,
  compilerEvidence: vehicleCompilerEvidence,
});
const deployment = {
  schema: "zugfolge-alpha-world-deployment/v2",
  worldId: WORLD_ID,
  deploymentRevision: publicDeployConfiguration.deploymentRevision,
  worldDefinition: publicDeployConfiguration.worldDefinition,
  infraReleaseHash: infraReleaseWrapper.releaseHash,
  blueprint: {
    schemaVersion: "zugfolge-alpha-world-blueprint/v2",
    regionId: REGION_ID,
    regionVariant: REGION_VARIANT,
    seed: PUBLIC_WORLD_SEED,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 10,
    startingCapitalPolicy: publicDeployConfiguration.startingCapitalPolicy,
    entryFacilityPolicy: {
      schemaVersion: "zugfolge-public-entry-facility/v1",
      mode: "award-contingent-wet-lease",
      providerOperatorId: OPERATOR_ID,
      costBasis: "formation-operating-cost",
    },
    releases: { infra: infraReleaseWrapper.releaseHash, timetable: gtfsEnvelope.snapshotHash, fleet: fleetEvidence.authorityReleaseHash, economy: economyRelease.checksum },
    lots: blueprintLots,
    conflictCheckHash: operationalInfrastructureBinding.stateHash,
    tenderCalendarHash,
  },
  economy: {
    durationMonths: 12,
    release: { schema: economyRelease.schema, version: economyRelease.version, rates: economyRelease.rates, rules: economyRelease.rules, tenderProfiles: economyRelease.tenderProfiles },
    lots: economyLots,
    planning: servicePlanning,
    tenderGeneration,
    authorityBudgets: [],
    accounts: [],
    publicVehiclePoolByLot,
  },
  fleet,
  vehicleCatalogBinding,
  regionalSimulation: operationalSimulation,
  repeatEveryS: scheduleTimeContract.repeatEveryS,
  planning: {
    authority: {
      accountId: PUBLIC_PLANNING_AUTHORITY_ACCOUNT_ID,
      keycloakSubject: `system:planning-authority:${WORLD_ID}`,
      displayName: buildConfiguration.planningAuthority.displayName,
    },
    infrastructureRelease: planningInfrastructureRelease,
  },
  provenance: {
    infraReleaseId: infraRelease.releaseId,
    operationalInfrastructureSha256: operationalInfrastructureBinding.sha256,
    operationalInfrastructureStateHash: operationalInfrastructureBinding.stateHash,
    gtfsSnapshotHash: gtfsEnvelope.snapshotHash,
    fleetSourceSha256: sha256(fleetBytes),
    operationalSimulationSourceSha256,
    generationScriptSha256: alphaWorldGenerationSourcesSha256(generatorBytes, vehicleBinderBytes, vehicleMigrationBytes, passengerStopBinderBytes, movementAllocatorBytes),
  },
};
assertEmbeddedWorldIds(deployment, WORLD_ID);

await writeFile(stagedOutputPath, `${JSON.stringify({ deployment: encodeEconomyValue(deployment) }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
return Object.freeze({
  worldId: WORLD_ID,
  lotCount: blueprintLots.length,
  trainRunCount: regionalTrains.length,
  circulationCount: circulationsCount(blueprintLots),
  vehicleCount: fleet.authorityRelease.assets.length,
  personnelDutyCount: fleet.personnelDuties.length,
  pathReservationCount: fleet.pathReservations.length,
  operationalTrainCount: operationalSimulation.trains.length,
  operationalInitializationHash: operationalPreflightReceipt.initializationHash,
  operationalStateHash: operationalPreflightReceipt.stateHash,
  fleetReleaseHash: fleetEvidence.authorityReleaseHash,
  economyReleaseHash: economyRelease.checksum,
  timetableReleaseHash: gtfsEnvelope.snapshotHash,
  tenderCalendarHash,
});
});
console.log(JSON.stringify(buildResult));

function circulationsCount(lots) {
  return lots.reduce((sum, lot) => sum + lot.circulationIds.length, 0);
}
}

const mainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (mainModule) await buildAlphaWorld();
