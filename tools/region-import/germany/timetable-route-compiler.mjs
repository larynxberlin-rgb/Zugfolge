import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { dirname, resolve } from "node:path";

import {
  gameTimetableJourneyId,
  gameTimetableLegId,
  gtfsBoundaryPlanningWindowId,
  gtfsExternalLegId,
  gtfsJourneyChainId,
  gtfsPlayableLegId,
} from "../../../packages/gtfs/dist/index.js";
import { validatePlayableArea } from "../playable-area.mjs";
import { createDeterministicTrackRouter } from "./deterministic-track-router.mjs";
import {
  buildGtfsTrackGraph,
  GTFS_SIMULATED_ROUTE_KEY,
  GTFS_TRACK_GRAPH_RULE,
} from "./operational-track-graph.mjs";
import {
  DAILY_CIRCULATION_MINIMUM_TURNAROUND_S,
  DAILY_CIRCULATION_PLAN_SCHEMA,
  DAILY_CIRCULATION_REPEAT_EVERY_S,
  DAILY_CIRCULATION_RULE,
  dailyPassengerRouteVersionId,
  deriveDailyCirculationPlan,
} from "../daily-circulation-v2.mjs";

export const GERMANY_TIMETABLE_ROUTE_SPEC_SCHEMA = "zugfolge-germany-timetable-route-compiler/v5";
export const GERMANY_TIMETABLE_ROUTE_REPORT_SCHEMA = "zugfolge-germany-timetable-route-report/v4";
export const GERMANY_TIMETABLE_TRANSFER_DEMAND_SCHEMA = "zugfolge-timetable-transfer-demands/v2";
export const TIMETABLE_ROUTE_DERIVATION_RULE = "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2";
export const TIMETABLE_ROUTE_SELECTION_RULE = "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2";
export const TIMETABLE_ROUTE_POLICY_ID = "synthetic-operational-b/v2";

const GTFS_SNAPSHOT_SCHEMA = "zugfolge-gtfs-region-snapshot/v2";
const JOURNEY_CHAIN_SCHEMA = "zugfolge-gtfs-journey-chain/v2";
const LEGACY_TIMETABLE_ROUTE_SPEC_SCHEMA = "zugfolge-germany-timetable-route-compiler/v2";
const LEGACY_TIMETABLE_ROUTE_SPEC_SCHEMA_V3 = "zugfolge-germany-timetable-route-compiler/v3";
const CANONICAL_PROTECTION_SYSTEMS = Object.freeze(["etcs-level1", "etcs-level2", "lzb", "pzb"]);
const SAMPLE_LIMIT = 10;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value, name) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${name} muss ein Objekt sein.`);
  return value;
}

function list(value, name) {
  invariant(Array.isArray(value), `${name} muss eine Liste sein.`);
  return value;
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value.trim() === value && value !== "", `${name} muss eine nichtleere, randfreie Zeichenkette sein.`);
  return value;
}

function boolean(value, name) {
  invariant(typeof value === "boolean", `${name} muss boolesch sein.`);
  return value;
}

function safeInteger(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} ist keine sichere Ganzzahl ab ${minimum}.`);
  return value;
}

function sha256(value, name) {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/u.test(value), `${name} muss ein kleingeschriebener SHA-256 sein.`);
  return value;
}

function exactKeys(value, keys, name) {
  const actual = Object.keys(record(value, name)).sort(compareText);
  const expected = [...keys].sort(compareText);
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `${name} besitzt unbekannte oder fehlende Felder.`);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return Object.freeze({ bytes, sha256: hash.digest("hex") });
}

async function readJson(path, name) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${name} ist kein gueltiges JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateSpecification(value) {
  const current = value?.schema === GERMANY_TIMETABLE_ROUTE_SPEC_SCHEMA;
  exactKeys(value, current
    ? ["schema", "infraReleaseId", "tracks", "corridors", "gtfsSnapshot", "selection", "dailyCirculation", "output", "transferOutput", "report"]
    : ["schema", "infraReleaseId", "tracks", "corridors", "gtfsSnapshot", "selection", "output", "report"], "Timetable-Route-Spezifikation");
  invariant(
    current || value.schema === LEGACY_TIMETABLE_ROUTE_SPEC_SCHEMA_V3 || value.schema === LEGACY_TIMETABLE_ROUTE_SPEC_SCHEMA,
    "Timetable-Route-Spezifikation besitzt weder das aktuelle v5- noch ein historisches v2/v3-Schema.",
  );
  for (const key of ["infraReleaseId", "tracks", "corridors", "output", "report"]) nonEmptyString(value[key], key);
  invariant(value.output !== value.report, "Timetable-Route-Ausgabe und Bericht muessen verschieden sein.");
  if (current) {
    nonEmptyString(value.transferOutput, "transferOutput");
    invariant(value.transferOutput !== value.output && value.transferOutput !== value.report, "Transfer-, Timetable-Route-Ausgabe und Bericht muessen verschieden sein.");
  }

  exactKeys(value.gtfsSnapshot, [
    "path", "expectedBytes", "expectedFileSha256", "expectedSnapshotHash", "expectedSchema", "expectedRegionId",
    "expectedRegionVariant", "expectedServiceDate", "expectedSourceId", "expectedArchiveSha256", "expectedSourceLicense",
  ], "gtfsSnapshot");
  nonEmptyString(value.gtfsSnapshot.path, "gtfsSnapshot.path");
  safeInteger(value.gtfsSnapshot.expectedBytes, "gtfsSnapshot.expectedBytes", 1);
  sha256(value.gtfsSnapshot.expectedFileSha256, "gtfsSnapshot.expectedFileSha256");
  sha256(value.gtfsSnapshot.expectedSnapshotHash, "gtfsSnapshot.expectedSnapshotHash");
  invariant(value.gtfsSnapshot.expectedSchema === GTFS_SNAPSHOT_SCHEMA, `gtfsSnapshot.expectedSchema muss ${GTFS_SNAPSHOT_SCHEMA} sein.`);
  for (const key of ["expectedRegionId", "expectedRegionVariant", "expectedServiceDate", "expectedSourceId", "expectedSourceLicense"]) {
    nonEmptyString(value.gtfsSnapshot[key], `gtfsSnapshot.${key}`);
  }
  sha256(value.gtfsSnapshot.expectedArchiveSha256, "gtfsSnapshot.expectedArchiveSha256");

  const supportsProtectionModes = value.schema !== LEGACY_TIMETABLE_ROUTE_SPEC_SCHEMA;
  exactKeys(value.selection, supportsProtectionModes
    ? ["rule", "qualityClass", "requireOrderable", "minimumStopCount", "expectedSnapshotSegmentCount", "expectedEligibleSegmentCount", "permittedProtectionModes"]
    : ["rule", "qualityClass", "requireOrderable", "minimumStopCount", "expectedSnapshotSegmentCount", "expectedEligibleSegmentCount"], "selection");
  invariant(value.selection.rule === TIMETABLE_ROUTE_SELECTION_RULE, "selection.rule ist nicht der geschlossene v2-Auswahlvertrag.");
  invariant(value.selection.qualityClass === "B", "selection.qualityClass muss B sein.");
  invariant(value.selection.requireOrderable === true, "selection.requireOrderable muss true sein.");
  invariant(value.selection.minimumStopCount === 2, "selection.minimumStopCount muss 2 sein.");
  safeInteger(value.selection.expectedSnapshotSegmentCount, "selection.expectedSnapshotSegmentCount", 1);
  safeInteger(value.selection.expectedEligibleSegmentCount, "selection.expectedEligibleSegmentCount", 1);
  invariant(value.selection.expectedEligibleSegmentCount <= value.selection.expectedSnapshotSegmentCount, "selection erwartet mehr geeignete als vorhandene Segmente.");
  const permittedProtectionModes = supportsProtectionModes ? value.selection.permittedProtectionModes : null;
  if (supportsProtectionModes) {
    invariant(Array.isArray(permittedProtectionModes) && permittedProtectionModes.length > 0, "selection.permittedProtectionModes muss eine nichtleere Alternativenmenge sein.");
    invariant(
      new Set(permittedProtectionModes).size === permittedProtectionModes.length
        && permittedProtectionModes.every((system) => CANONICAL_PROTECTION_SYSTEMS.includes(system)),
      "selection.permittedProtectionModes enthaelt doppelte oder nichtkanonische Systeme.",
    );
    invariant(
      JSON.stringify([...permittedProtectionModes].sort(compareText)) === JSON.stringify(permittedProtectionModes),
      "selection.permittedProtectionModes muss kanonisch sortiert sein.",
    );
  }
  let dailyCirculation = null;
  if (current) {
    exactKeys(value.dailyCirculation, [
      "rule", "repeatEveryS", "minimumTurnaroundS", "expectedLotCount", "expectedJourneyChainCount",
      "expectedCirculationCount", "expectedPlannedTransitionCount", "expectedTurnaroundDemandCount",
      "expectedTransferDemandCount", "expectedTransferLotCount", "formationLengthsMm",
      "unknownMainlineSpeedKmh", "unknownServiceSpeedKmh",
    ], "dailyCirculation");
    invariant(value.dailyCirculation.rule === DAILY_CIRCULATION_RULE, "dailyCirculation.rule ist nicht der geschlossene v1-Vertrag.");
    invariant(value.dailyCirculation.repeatEveryS === DAILY_CIRCULATION_REPEAT_EVERY_S, `dailyCirculation.repeatEveryS muss ${DAILY_CIRCULATION_REPEAT_EVERY_S} sein.`);
    invariant(value.dailyCirculation.minimumTurnaroundS === DAILY_CIRCULATION_MINIMUM_TURNAROUND_S, `dailyCirculation.minimumTurnaroundS muss ${DAILY_CIRCULATION_MINIMUM_TURNAROUND_S} sein.`);
    for (const key of ["expectedLotCount", "expectedJourneyChainCount", "expectedCirculationCount", "expectedPlannedTransitionCount"]) {
      safeInteger(value.dailyCirculation[key], `dailyCirculation.${key}`, 1);
    }
    for (const key of ["expectedTurnaroundDemandCount", "expectedTransferDemandCount", "expectedTransferLotCount"]) {
      safeInteger(value.dailyCirculation[key], `dailyCirculation.${key}`, 0);
    }
    safeInteger(value.dailyCirculation.unknownMainlineSpeedKmh, "dailyCirculation.unknownMainlineSpeedKmh", 1);
    safeInteger(value.dailyCirculation.unknownServiceSpeedKmh, "dailyCirculation.unknownServiceSpeedKmh", 1);
    invariant(
      value.dailyCirculation.expectedTurnaroundDemandCount + value.dailyCirculation.expectedTransferDemandCount
        === value.dailyCirculation.expectedPlannedTransitionCount,
      "dailyCirculation partitioniert die erwarteten geplanten Uebergaenge nicht vollstaendig.",
    );
    invariant(value.dailyCirculation.expectedTransferLotCount <= value.dailyCirculation.expectedLotCount, "dailyCirculation erwartet mehr Transfer-Lose als Lose.");
    invariant(Array.isArray(value.dailyCirculation.formationLengthsMm) && value.dailyCirculation.formationLengthsMm.length > 0, "dailyCirculation.formationLengthsMm muss eine nichtleere Liste sein.");
    for (const [index, length] of value.dailyCirculation.formationLengthsMm.entries()) safeInteger(length, `dailyCirculation.formationLengthsMm[${index}]`, 1);
    invariant(new Set(value.dailyCirculation.formationLengthsMm).size === value.dailyCirculation.formationLengthsMm.length, "dailyCirculation.formationLengthsMm enthaelt Duplikate.");
    invariant(value.dailyCirculation.formationLengthsMm.every((length, index, values) => index === 0 || values[index - 1] < length), "dailyCirculation.formationLengthsMm muss streng aufsteigend sein.");
    dailyCirculation = Object.freeze({ ...value.dailyCirculation, formationLengthsMm: Object.freeze([...value.dailyCirculation.formationLengthsMm]) });
  }
  return Object.freeze({
    ...value,
    selection: Object.freeze({ ...value.selection, permittedProtectionModes }),
    dailyCirculation,
  });
}

function validateStopTime(stop, name, stationById) {
  exactKeys(stop, ["stopId", "stopSequence", "arrivalS", "departureS"], name);
  const stopId = nonEmptyString(stop.stopId, `${name}.stopId`);
  invariant(stationById.has(stopId), `${name} verweist auf unbekannten Stop ${stopId}.`);
  safeInteger(stop.stopSequence, `${name}.stopSequence`, 0);
  safeInteger(stop.arrivalS, `${name}.arrivalS`, 0);
  safeInteger(stop.departureS, `${name}.departureS`, 0);
  invariant(stop.arrivalS <= stop.departureS, `${name} faehrt vor der Ankunft ab.`);
  return stop;
}

function validateStopSequence(stops, name, stationById, minimumStops) {
  list(stops, name);
  invariant(stops.length >= minimumStops, `${name} besitzt weniger als ${minimumStops} Halte.`);
  let previous = null;
  const identities = new Set();
  for (let index = 0; index < stops.length; index += 1) {
    const stop = validateStopTime(record(stops[index], `${name}[${index}]`), `${name}[${index}]`, stationById);
    if (previous !== null) {
      invariant(stop.stopSequence > previous.stopSequence, `${name} ist nicht streng nach stopSequence geordnet.`);
      invariant(stop.arrivalS >= previous.departureS, `${name} besitzt ruecklaeufige Fahrplanzeiten.`);
    }
    const identity = `${stop.stopSequence}|${stop.stopId}`;
    invariant(!identities.has(identity), `${name} besitzt einen doppelten Halt.`);
    identities.add(identity);
    previous = stop;
  }
  return stops;
}

export function validatePinnedGtfsSnapshot(envelopeValue, binding, selection) {
  exactKeys(envelopeValue, ["snapshot", "snapshotHash"], "GTFS-Snapshot-Datei");
  const envelope = record(envelopeValue, "GTFS-Snapshot-Datei");
  const snapshot = record(envelope.snapshot, "GTFS-Snapshot-Datei.snapshot");
  const envelopeHash = sha256(envelope.snapshotHash, "GTFS-Snapshot-Datei.snapshotHash");
  const computedSnapshotHash = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  invariant(envelopeHash === computedSnapshotHash, "GTFS-Snapshot-Datei.snapshotHash stimmt nicht mit dem kanonischen Snapshot ueberein.");
  invariant(envelopeHash === binding.expectedSnapshotHash, "GTFS-Snapshot-Datei besitzt nicht den erwarteten snapshotHash.");
  const generated = snapshot.timetableGeneration !== undefined;
  exactKeys(snapshot, [
    "schema", "regionId", "regionVariant", "serviceDate", "source", "metrics",
    ...(generated ? ["playableArea", "generationSeed", "timetableGeneration", "lines"] : ["externalLegSpecification"]),
    "serviceScopeSpecification", "serviceScopeReport", "stations", "journeyChains", "boundaryPlanningWindows", "segments",
  ], "GTFS-Snapshot");
  if (generated) {
    invariant(validatePlayableArea(snapshot.playableArea) !== undefined, "Spiel-Fahrplan besitzt keine Spielgebietsgrenze.");
    nonEmptyString(snapshot.generationSeed, "Spiel-Fahrplan.generationSeed");
    nonEmptyString(snapshot.timetableGeneration.version, "Spiel-Fahrplan.timetableGeneration.version");
    safeInteger(snapshot.timetableGeneration.departureGridSeconds, "Spiel-Fahrplan.departureGridSeconds", 1);
    safeInteger(snapshot.timetableGeneration.minimumRunningSeconds, "Spiel-Fahrplan.minimumRunningSeconds", 1);
    invariant(list(snapshot.boundaryPlanningWindows, "Spiel-Fahrplan.boundaryPlanningWindows").length === 0, "Spiel-Fahrplan darf keine Aussengrenzfenster enthalten.");
    if (snapshot.timetableGeneration.networkReference !== undefined || snapshot.timetableGeneration.requireEligibleTerminals === true) {
      const network = snapshot.timetableGeneration.networkReference;
      invariant(snapshot.timetableGeneration.requireEligibleTerminals === true && network?.schemaVersion === "zugfolge-game-timetable-network-reference/v1", "Finaler Spiel-Fahrplan braucht die Netzbindung und geeignete Endbahnhoefe.");
      sha256(network.terminalCatalog?.sha256, "Spiel-Fahrplan.Terminalkatalog.sha256");
      safeInteger(network.terminalCatalog?.bytes, "Spiel-Fahrplan.Terminalkatalog.bytes", 1);
      nonEmptyString(network.terminalCatalog?.sourceId, "Spiel-Fahrplan.Terminalkatalog.sourceId");
    }
  }
  const generatedLines = new Map(generated ? list(snapshot.lines, "Spiel-Fahrplan.lines").map((line) => [nonEmptyString(line.lineId, "Spiel-Fahrplan.lineId"), line]) : []);
  if (generated) invariant(generatedLines.size === snapshot.lines.length, "Spiel-Fahrplan enthaelt doppelte Linien.");
  invariant(snapshot.schema === binding.expectedSchema, "GTFS-Snapshot.schema weicht von der Bindung ab.");
  invariant(snapshot.regionId === binding.expectedRegionId, "GTFS-Snapshot.regionId weicht von der Bindung ab.");
  invariant(snapshot.regionVariant === binding.expectedRegionVariant, "GTFS-Snapshot.regionVariant weicht von der Bindung ab.");
  invariant(snapshot.serviceDate === binding.expectedServiceDate, "GTFS-Snapshot.serviceDate weicht von der Bindung ab.");
  exactKeys(snapshot.source, ["sourceId", "archive", "archiveSha256", "feedUrl", "sourceLicense", "attribution"], "GTFS-Snapshot.source");
  invariant(snapshot.source.sourceId === binding.expectedSourceId, "GTFS-Snapshot.sourceId weicht von der Bindung ab.");
  invariant(snapshot.source.archiveSha256 === binding.expectedArchiveSha256, "GTFS-Snapshot.archiveSha256 weicht von der Bindung ab.");
  invariant(snapshot.source.sourceLicense === binding.expectedSourceLicense, "GTFS-Snapshot.sourceLicense weicht von der Bindung ab.");
  nonEmptyString(snapshot.source.archive, "GTFS-Snapshot.source.archive");
  nonEmptyString(snapshot.source.feedUrl, "GTFS-Snapshot.source.feedUrl");
  nonEmptyString(snapshot.source.attribution, "GTFS-Snapshot.source.attribution");

  const stationById = new Map();
  for (const [index, value] of list(snapshot.stations, "GTFS-Snapshot.stations").entries()) {
    const station = record(value, `GTFS-Snapshot.stations[${index}]`);
    exactKeys(station, ["stopId", "parentStationId", "name", "latitudeE7", "longitudeE7", "inRegion"], `GTFS-Snapshot.stations[${index}]`);
    const stopId = nonEmptyString(station.stopId, `GTFS-Snapshot.stations[${index}].stopId`);
    invariant(!stationById.has(stopId), `GTFS-Stop ${stopId} ist doppelt.`);
    if (station.parentStationId !== null) nonEmptyString(station.parentStationId, `${stopId}.parentStationId`);
    nonEmptyString(station.name, `${stopId}.name`);
    safeInteger(station.latitudeE7, `${stopId}.latitudeE7`, -900_000_000);
    safeInteger(station.longitudeE7, `${stopId}.longitudeE7`, -1_800_000_000);
    invariant(station.latitudeE7 <= 900_000_000 && station.longitudeE7 <= 1_800_000_000, `${stopId} liegt ausserhalb E7.`);
    invariant(boolean(station.inRegion, `${stopId}.inRegion`) === true, `${stopId} liegt laut Snapshot nicht in der Region.`);
    stationById.set(stopId, station);
  }

  const chainById = new Map();
  const playableLegById = new Map();
  const allLegIds = new Set();
  let playableLegCount = 0;
  let oneStopPlayableLegCount = 0;
  let externalLegCount = 0;
  let orderableJourneyChainCount = 0;
  const journeyWorldIds = new Set();
  const journeyReleaseIds = new Set();
  for (const [chainIndex, value] of list(snapshot.journeyChains, "GTFS-Snapshot.journeyChains").entries()) {
    const chain = record(value, `GTFS-Snapshot.journeyChains[${chainIndex}]`);
    invariant(chain.schemaVersion === JOURNEY_CHAIN_SCHEMA, `${chain?.journeyChainId ?? chainIndex} besitzt nicht ${JOURNEY_CHAIN_SCHEMA}.`);
    const chainId = nonEmptyString(chain.journeyChainId, `GTFS-Snapshot.journeyChains[${chainIndex}].journeyChainId`);
    const chainWorldId = nonEmptyString(chain.worldId, `${chainId}.worldId`);
    const chainRegionId = nonEmptyString(chain.regionId, `${chainId}.regionId`);
    const chainReleaseId = nonEmptyString(chain.releaseId, `${chainId}.releaseId`);
    const chainSourceTripId = nonEmptyString(chain.sourceTripId, `${chainId}.sourceTripId`);
    invariant(chainRegionId === snapshot.regionId, `${chainId} verletzt die Regionsbindung des GTFS-Snapshots.`);
    invariant(
      chainId === (generated ? gameTimetableJourneyId({
        regionId: chainRegionId,
        lineId: nonEmptyString(chain.lineId, `${chainId}.lineId`),
        serviceDate: snapshot.serviceDate,
        seed: snapshot.generationSeed,
        index: safeInteger(chain.generationIndex, `${chainId}.generationIndex`, 0),
      }) : gtfsJourneyChainId({
        regionId: chainRegionId,
        releaseId: chainReleaseId,
        sourceTripId: chainSourceTripId,
      })),
      `${chainId} verletzt den releasegebundenen weltneutralen Journey-v2-Identitaetsvertrag.`,
    );
    journeyWorldIds.add(chainWorldId);
    journeyReleaseIds.add(chainReleaseId);
    invariant(!chainById.has(chainId), `GTFS-JourneyChain ${chainId} ist doppelt.`);
    boolean(chain.orderable, `${chainId}.orderable`);
    if (chain.orderable) orderableJourneyChainCount += 1;
    chainById.set(chainId, chain);
    if (generated) {
      const line = generatedLines.get(chain.lineId);
      invariant(chain.generation === "game-timetable/v1" && line !== undefined, `${chainId} besitzt keine generierte Spiel-Linie.`);
      invariant(chain.legs.length === 1 && chain.orderable === true, `${chainId} muss genau eine bestellbare Innenfahrt sein.`);
      invariant(chain.headsign === line.headsign && chain.routeId === line.lineId, `${chainId} besitzt fremde Linien- oder Zielangaben.`);
      invariant(canonicalJson(chain.legs[0].stops.map((stop) => stop.stopId)) === canonicalJson(line.stopIds), `${chainId} weicht vom inneren Linienlaufweg ab.`);
      const lastStop = stationById.get(line.stopIds.at(-1));
      invariant(lastStop !== undefined && chain.headsign === lastStop.name, `${chainId} zeigt nicht den tatsaechlichen inneren Endhalt.`);
      if (snapshot.timetableGeneration.requireEligibleTerminals === true) {
        const firstStop = stationById.get(line.stopIds[0]);
        const adjustment = line.adjustment;
        invariant(adjustment !== undefined && ["unchanged", "adapted-to-operational-stations"].includes(adjustment.reason)
          && adjustment.originName === firstStop?.name && adjustment.destinationName === lastStop.name
          && Array.isArray(adjustment.terminalEvidenceIds) && adjustment.terminalEvidenceIds.length === 2
          && adjustment.terminalEvidenceIds.every((id) => typeof id === "string" && id.trim() !== ""), `${chainId} besitzt keine passenden betrieblichen Endpunktbelege oder Endpunktnamen.`);
        nonEmptyString(adjustment.referenceOriginName, `${chainId}.referenceOriginName`);
        nonEmptyString(adjustment.referenceDestinationName, `${chainId}.referenceDestinationName`);
      }
    }
    for (const [legIndex, value] of list(chain.legs, `${chainId}.legs`).entries()) {
      const leg = record(value, `${chainId}.legs[${legIndex}]`);
      const legId = nonEmptyString(leg.legId, `${chainId}.legs[${legIndex}].legId`);
      invariant(!allLegIds.has(legId), `GTFS-Leg ${legId} ist doppelt.`);
      allLegIds.add(legId);
      safeInteger(leg.sequence, `${legId}.sequence`, 0);
      invariant(leg.sequence === legIndex, `${legId}.sequence ist nicht lueckenlos.`);
      if (leg.kind === "playable") {
        invariant(
          legId === (generated ? gameTimetableLegId(chainId) : gtfsPlayableLegId({ journeyChainId: chainId, sequence: leg.sequence })),
          `${legId} verletzt den PlayableLeg-v2-Identitaetsvertrag.`,
        );
        playableLegCount += 1;
        boolean(leg.orderable, `${legId}.orderable`);
        invariant(leg.qualityClass === "B" || leg.qualityClass === "C", `${legId}.qualityClass ist unbekannt.`);
        invariant((leg.qualityClass === "B") === leg.orderable, `${legId} verletzt B genau dann orderable.`);
        const stops = validateStopSequence(leg.stops, `${legId}.stops`, stationById, 1);
        if (generated) invariant(stops.length >= 2 && leg.entryPortalId === null && leg.exitPortalId === null && leg.planningWindows.length === 0,
          `${legId} darf weder Aussenportale noch Grenzfenster enthalten.`);
        for (const [windowIndex, windowValue] of list(leg.planningWindows, `${legId}.planningWindows`).entries()) {
          const window = record(windowValue, `${legId}.planningWindows[${windowIndex}]`);
          const portalId = nonEmptyString(window.portalId, `${legId}.planningWindows[${windowIndex}].portalId`);
          invariant(window.direction === "entry" || window.direction === "exit", `${legId}.planningWindows[${windowIndex}].direction ist ungueltig.`);
          invariant(
            window.windowId === gtfsBoundaryPlanningWindowId({
              playableLegId: legId,
              portalId,
              direction: window.direction,
            }),
            `${legId}.planningWindows[${windowIndex}] verletzt den BoundaryWindow-v2-Identitaetsvertrag.`,
          );
        }
        if (stops.length === 1) oneStopPlayableLegCount += 1;
        playableLegById.set(legId, Object.freeze({ chainId, chain, leg }));
      } else {
        invariant(!generated, `${legId}: Aussenlaeufe sind in Spiel-Fahrplaenen abgeschafft.`);
        invariant(leg.kind === "external", `${legId}.kind ist unbekannt.`);
        invariant(
          legId === gtfsExternalLegId({ journeyChainId: chainId, sequence: leg.sequence }),
          `${legId} verletzt den ExternalLeg-v2-Identitaetsvertrag.`,
        );
        externalLegCount += 1;
      }
    }
  }
  invariant(journeyWorldIds.size === 1, "GTFS-Snapshot mischt Fahrtketten verschiedener Welt-Payloads.");
  invariant(journeyReleaseIds.size === 1, "GTFS-Snapshot mischt verschiedene Journey-Release-Namespaces.");

  const segmentIds = new Set();
  const selectedSegments = [];
  const directedStopPairs = new Set();
  const routableDirectedStopPairs = new Set();
  let sameStopTransitionCount = 0;
  let excludedQualityCCount = 0;
  for (const [index, value] of list(snapshot.segments, "GTFS-Snapshot.segments").entries()) {
    const segment = record(value, `GTFS-Snapshot.segments[${index}]`);
    exactKeys(segment, [
      "segmentId", "journeyChainId", "sourceTripId", "serviceId", "routeId", "routeShortName", "headsign", "directionId",
      ...(generated ? ["lineId", "sourceTripIds", "sourceRouteIds"] : []),
      "qualityClass", "orderable", "entry", "exit", "planningWindows", "stops",
    ], `GTFS-Snapshot.segments[${index}]`);
    const segmentId = nonEmptyString(segment.segmentId, `GTFS-Snapshot.segments[${index}].segmentId`);
    invariant(!segmentIds.has(segmentId), `GTFS-Segment ${segmentId} ist doppelt.`);
    segmentIds.add(segmentId);
    const chain = chainById.get(nonEmptyString(segment.journeyChainId, `${segmentId}.journeyChainId`));
    invariant(chain !== undefined, `${segmentId} verweist auf eine unbekannte JourneyChain.`);
    invariant(segment.sourceTripId === chain.sourceTripId, `${segmentId} verletzt die SourceTrip-Bindung seiner JourneyChain.`);
    if (generated) invariant(segment.lineId === chain.lineId && segment.entry === null && segment.exit === null && segment.planningWindows.length === 0,
      `${segmentId} besitzt keine reine innere Spiel-Linienbindung.`);
    const playable = playableLegById.get(segmentId);
    invariant(playable !== undefined && playable.chainId === segment.journeyChainId, `${segmentId} bindet kein gleichnamiges PlayableLeg seiner JourneyChain.`);
    boolean(segment.orderable, `${segmentId}.orderable`);
    invariant(segment.qualityClass === "B" || segment.qualityClass === "C", `${segmentId}.qualityClass ist unbekannt.`);
    invariant((segment.qualityClass === "B") === segment.orderable, `${segmentId} verletzt B genau dann orderable.`);
    validateStopSequence(segment.stops, `${segmentId}.stops`, stationById, selection.minimumStopCount);
    invariant(canonicalJson(segment.stops) === canonicalJson(playable.leg.stops), `${segmentId}.stops weicht vom PlayableLeg ab.`);
    invariant(segment.qualityClass === playable.leg.qualityClass && segment.orderable === playable.leg.orderable, `${segmentId} weicht in der Qualifikation vom PlayableLeg ab.`);
    if (segment.orderable && segment.qualityClass === selection.qualityClass) {
      selectedSegments.push(segment);
      for (let stopIndex = 1; stopIndex < segment.stops.length; stopIndex += 1) {
        const originStopId = segment.stops[stopIndex - 1].stopId;
        const destinationStopId = segment.stops[stopIndex].stopId;
        directedStopPairs.add(`${originStopId}\u0000${destinationStopId}`);
        if (originStopId === destinationStopId) sameStopTransitionCount += 1;
        else routableDirectedStopPairs.add(`${originStopId}\u0000${destinationStopId}`);
      }
    } else excludedQualityCCount += 1;
  }

  invariant(segmentIds.size === selection.expectedSnapshotSegmentCount, `GTFS-Snapshot enthaelt ${segmentIds.size} statt ${selection.expectedSnapshotSegmentCount} Segmente.`);
  invariant(selectedSegments.length === selection.expectedEligibleSegmentCount, `GTFS-Snapshot enthaelt ${selectedSegments.length} statt ${selection.expectedEligibleSegmentCount} geeignete Segmente.`);
  const metrics = record(snapshot.metrics, "GTFS-Snapshot.metrics");
  invariant(metrics.playableSegmentCount === segmentIds.size, "GTFS-Snapshot.metrics.playableSegmentCount ist inkonsistent.");
  invariant(metrics.externalLegCount === externalLegCount, "GTFS-Snapshot.metrics.externalLegCount ist inkonsistent.");
  invariant(metrics.orderableJourneyChainCount === orderableJourneyChainCount, "GTFS-Snapshot.metrics.orderableJourneyChainCount ist inkonsistent.");

  return Object.freeze({
    snapshot,
    snapshotHash: envelopeHash,
    selectedSegments: Object.freeze([...selectedSegments].sort((left, right) => compareText(left.segmentId, right.segmentId))),
    metrics: Object.freeze({
      stationCount: stationById.size,
      journeyChainCount: chainById.size,
      playableLegCount,
      oneStopPlayableLegCount,
      externalLegCount,
      snapshotSegmentCount: segmentIds.size,
      eligibleSegmentCount: selectedSegments.length,
      excludedQualityCCount,
      uniqueDirectedStopPairCount: directedStopPairs.size,
      uniqueRoutableDirectedStopPairCount: routableDirectedStopPairs.size,
      sameStopTransitionCount,
    }),
  });
}

function findingState() {
  return { count: 0, samples: [], hash: createHash("sha256") };
}

function addFinding(findings, code, identity) {
  const state = findings.get(code) ?? findingState();
  state.count += 1;
  if (state.samples.length < SAMPLE_LIMIT) state.samples.push(identity);
  state.hash.update(`${Buffer.byteLength(identity)}:${identity}\n`);
  findings.set(code, state);
}

function finalizeFindings(findings) {
  return Object.fromEntries([...findings].sort(([left], [right]) => compareText(left, right)).map(([code, state]) => [code, {
    count: state.count,
    identitySetSha256: state.hash.digest("hex"),
    samples: state.samples,
  }]));
}

function publicAnchor(anchor) {
  return Object.freeze({ edgeId: anchor.edgeId, offsetMm: anchor.offsetMm });
}

function sameAnchor(left, right) {
  return left.edgeId === right.edgeId && left.offsetMm === right.offsetMm;
}

function mergeLegs(legs) {
  const merged = [];
  for (const leg of legs) {
    const previous = merged.at(-1);
    if (previous !== undefined && previous.edgeId === leg.edgeId && previous.direction === leg.direction && previous.edgeExitMm === leg.edgeEntryMm) previous.edgeExitMm = leg.edgeExitMm;
    else merged.push({ ...leg });
  }
  return merged;
}

function entryNode(track, leg) {
  if (leg.edgeEntryMm === 0) return track.fromNodeId;
  if (leg.edgeEntryMm === track.lengthMm) return track.toNodeId;
  return null;
}

function exitNode(track, leg) {
  if (leg.edgeExitMm === 0) return track.fromNodeId;
  if (leg.edgeExitMm === track.lengthMm) return track.toNodeId;
  return null;
}

function validateRouteContinuity(routeId, legs, tracksById) {
  invariant(legs.length > 0, `${routeId} besitzt keinen Gleislauf.`);
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];
    const track = tracksById.get(leg.edgeId);
    invariant(track !== undefined, `${routeId} verweist auf das unbekannte Gleis ${leg.edgeId}.`);
    invariant(Number.isSafeInteger(leg.edgeEntryMm) && Number.isSafeInteger(leg.edgeExitMm), `${routeId} besitzt unsichere Offsets.`);
    invariant(leg.edgeEntryMm >= 0 && leg.edgeEntryMm <= track.lengthMm && leg.edgeExitMm >= 0 && leg.edgeExitMm <= track.lengthMm, `${routeId} verlaesst ${leg.edgeId}.`);
    invariant((leg.direction === "along" && leg.edgeExitMm > leg.edgeEntryMm) || (leg.direction === "against" && leg.edgeExitMm < leg.edgeEntryMm), `${routeId} besitzt eine ungueltige Gleisrichtung.`);
    if (index === 0) continue;
    const previous = legs[index - 1];
    if (previous.edgeId === leg.edgeId) {
      invariant(previous.edgeExitMm === leg.edgeEntryMm, `${routeId} springt innerhalb ${leg.edgeId}.`);
      continue;
    }
    const previousTrack = tracksById.get(previous.edgeId);
    invariant(exitNode(previousTrack, previous) !== null && exitNode(previousTrack, previous) === entryNode(track, leg), `${routeId} springt zwischen ${previous.edgeId} und ${leg.edgeId}.`);
  }
}

function anchorsByComponent(graph, stopId) {
  const values = graph.anchors.get(stopId) ?? [];
  const result = new Map();
  for (const anchor of values) {
    const componentId = graph.componentByEdge.get(anchor.edgeId);
    invariant(componentId !== undefined, `${stopId} besitzt einen Anker ohne Graphkomponente.`);
    const anchors = result.get(componentId) ?? [];
    anchors.push(anchor);
    result.set(componentId, anchors);
  }
  return result;
}

function segmentComponents(graph, segment) {
  const byStop = new Map();
  let common = null;
  for (const stop of segment.stops) {
    if (!byStop.has(stop.stopId)) byStop.set(stop.stopId, anchorsByComponent(graph, stop.stopId));
    const components = new Set(byStop.get(stop.stopId).keys());
    common = common === null ? components : new Set([...common].filter((componentId) => components.has(componentId)));
  }
  if (common === null || common.size === 0) return [];
  const choices = [...common].map((componentId) => {
    const distances = segment.stops.map((stop) => Math.min(...byStop.get(stop.stopId).get(componentId).map((anchor) => anchor.distanceMm)));
    return {
      componentId,
      maximumAnchorDistanceMm: Math.max(...distances),
      anchorDistanceMm: distances.reduce((sum, distanceMm) => sum + distanceMm, 0),
      edgeCount: graph.edgeCountByComponent.get(componentId) ?? 0,
    };
  });
  choices.sort((left, right) => left.maximumAnchorDistanceMm - right.maximumAnchorDistanceMm
    || left.anchorDistanceMm - right.anchorDistanceMm
    || right.edgeCount - left.edgeCount
    || left.componentId - right.componentId);
  return choices.map(({ componentId }) => Object.freeze({ componentId, byStop }));
}

function anchorSetKey(anchors) {
  return anchors.map((anchor) => `${anchor.edgeId}:${anchor.offsetMm}`).sort(compareText).join("|");
}

function routePair(router, cache, origins, destinations) {
  const key = `${anchorSetKey(origins)}\u0000${anchorSetKey(destinations)}`;
  if (cache.has(key)) return cache.get(key);
  let route = router.route({ origins: origins.map(publicAnchor), destinations: destinations.map(publicAnchor), targetRouteNumber: GTFS_SIMULATED_ROUTE_KEY });
  if (route !== null && route.legs.length === 0) {
    const alternatives = [];
    for (const origin of origins) {
      const remaining = destinations.filter((destination) => !sameAnchor(origin, destination));
      if (remaining.length === 0) continue;
      const candidate = router.route({ origins: [publicAnchor(origin)], destinations: remaining.map(publicAnchor), targetRouteNumber: GTFS_SIMULATED_ROUTE_KEY });
      if (candidate !== null && candidate.legs.length > 0) alternatives.push(candidate);
    }
    alternatives.sort((left, right) => left.weightedCostMm - right.weightedCostMm
      || left.totalLengthMm - right.totalLengthMm
      || compareText(`${left.origin.edgeId}:${left.origin.offsetMm}`, `${right.origin.edgeId}:${right.origin.offsetMm}`)
      || compareText(`${left.destination.edgeId}:${left.destination.offsetMm}`, `${right.destination.edgeId}:${right.destination.offsetMm}`));
    route = alternatives[0] ?? null;
  }
  cache.set(key, route);
  return route;
}

function anchorEvidence(anchors, selected) {
  return anchors.find((anchor) => sameAnchor(anchor, selected));
}

/** Jeder erhaltene Anker erreicht auch alle folgenden Halte in ihrer Reihenfolge. */
function continuingAnchors(router, routeCache, component, stops) {
  const anchors = stops.map((stop) => component.byStop.get(stop.stopId).get(component.componentId));
  const viable = Array.from({ length: stops.length }, () => []);
  viable[stops.length - 1] = anchors.at(-1);
  for (let index = stops.length - 2; index >= 0; index -= 1) {
    if (stops[index].stopId === stops[index + 1].stopId) {
      viable[index] = viable[index + 1];
    } else if (viable[index + 1].length > 0) {
      viable[index] = anchors[index].filter((origin) => {
        const route = routePair(router, routeCache, [origin], viable[index + 1]);
        return route !== null && route.legs.length > 0;
      });
    }
  }
  return viable;
}

function deriveRoutes(graph, selectedSegments) {
  // Der allgemeine Router erhaelt weiterhin ausschliesslich seinen engen
  // Topologievertrag. Die streckenseitigen Zugsicherungsalternativen bleiben
  // am Operational-Graph und werden erst auf die ausgegebenen Legs gebunden.
  const routingEdges = new Map([...graph.edges].map(([edgeId, edge]) => [edgeId, Object.freeze({
    edgeId: edge.edgeId,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    lengthMm: edge.lengthMm,
    routeNumber: edge.routeNumber,
  })]));
  const router = createDeterministicTrackRouter(routingEdges, { allowedDirectionsByEdge: new Map([...graph.edges].map(([edgeId, edge]) => [edgeId, edge.allowedDirections ?? ["along", "against"]])) });
  const findings = new Map();
  const routes = [];
  const routeCache = new Map();
  const continuationCache = new Map();
  let routedStopPairCount = 0;
  let reusedStopPairRouteCount = 0;
  let maximumAnchorDistanceMm = 0;
  let totalRouteLengthMm = 0;
  let zeroMovementStopTransitionCount = 0;

  for (const segment of selectedSegments) {
    const components = segmentComponents(graph, segment);
    if (components.length === 0) {
      addFinding(findings, "segment-stops-share-no-real-track-component", segment.segmentId);
      continue;
    }
    let component;
    let viable;
    for (const candidate of components) {
      const key = canonicalJson([candidate.componentId, segment.stops.map((stop) => stop.stopId)]);
      if (!continuationCache.has(key)) continuationCache.set(key, continuingAnchors(router, routeCache, candidate, segment.stops));
      const continuations = continuationCache.get(key);
      if (continuations[0].length === 0) continue;
      component = candidate;
      viable = continuations;
      break;
    }
    if (component === undefined) {
      addFinding(findings, "gtfs-stop-pair-has-no-nonempty-real-track-path", segment.segmentId);
      continue;
    }
    const rawLegs = [];
    let previousDestination = null;
    let complete = true;
    for (let index = 1; index < segment.stops.length; index += 1) {
      const originStopId = segment.stops[index - 1].stopId;
      const destinationStopId = segment.stops[index].stopId;
      if (originStopId === destinationStopId) {
        zeroMovementStopTransitionCount += 1;
        continue;
      }
      const componentOrigins = viable[index - 1];
      const destinations = viable[index];
      const origins = previousDestination === null ? componentOrigins : [previousDestination];
      const cacheKey = `${anchorSetKey(origins)}\u0000${anchorSetKey(destinations)}`;
      const cached = routeCache.has(cacheKey);
      const routed = routePair(router, routeCache, origins, destinations);
      if (cached) reusedStopPairRouteCount += 1;
      if (routed === null || routed.legs.length === 0) {
        addFinding(findings, "gtfs-stop-pair-has-no-nonempty-real-track-path", `${segment.segmentId}:${originStopId}->${destinationStopId}`);
        complete = false;
        break;
      }
      routedStopPairCount += 1;
      const origin = anchorEvidence(componentOrigins, routed.origin);
      const destination = anchorEvidence(destinations, routed.destination);
      invariant(origin !== undefined && destination !== undefined, `${segment.segmentId} besitzt eine Route ausserhalb seiner Stop-Anker.`);
      maximumAnchorDistanceMm = Math.max(maximumAnchorDistanceMm, origin.distanceMm, destination.distanceMm);
      rawLegs.push(...routed.legs);
      previousDestination = destination;
    }
    if (!complete) continue;
    const legs = mergeLegs(rawLegs).map((leg) => {
      const track = graph.edges.get(leg.edgeId);
      invariant(track !== undefined, `${segment.segmentId} verweist auf eine unbekannte Gleiskante.`);
      return Object.freeze({
        ...leg,
        availableProtectionSystems: Object.freeze([...track.protectionSystems]),
        simultaneouslyRequiredProtectionSystems: Object.freeze([]),
      });
    });
    const routeVersionId = `route:gtfs:${segment.segmentId}:v1`;
    try {
      validateRouteContinuity(routeVersionId, legs, graph.edges);
      totalRouteLengthMm += legs.reduce((sum, leg) => sum + Math.abs(leg.edgeExitMm - leg.edgeEntryMm), 0);
      routes.push(Object.freeze({
        routeVersionId,
        templateId: `template:gtfs:${segment.segmentId}:v1`,
        predecessorId: null,
        transitionRouteMm: null,
        legs: Object.freeze(legs),
      }));
    } catch (error) {
      addFinding(findings, "segment-track-path-not-contiguous", `${segment.segmentId}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  routes.sort((left, right) => compareText(left.routeVersionId, right.routeVersionId));
  return Object.freeze({
    routes: Object.freeze(routes),
    findings: finalizeFindings(findings),
    metrics: Object.freeze({
      routedStopPairCount,
      reusedStopPairRouteCount,
      uniqueRouterQueryCount: routeCache.size,
      routeLegCount: routes.reduce((sum, route) => sum + route.legs.length, 0),
      totalRouteLengthMm,
      maximumAnchorDistanceMm,
      zeroMovementStopTransitionCount,
    }),
  });
}

function routingEdges(graph) {
  return new Map([...graph.edges].map(([edgeId, edge]) => [edgeId, Object.freeze({
    edgeId: edge.edgeId,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    lengthMm: edge.lengthMm,
    routeNumber: edge.routeNumber,
  })]));
}

function transferPairKey(sourcePassengerLegId, targetPassengerLegId) {
  return `${sourcePassengerLegId}\u0000${targetPassengerLegId}`;
}

function minimumTransferRuntimeMs(legs, graph, context) {
  let runtimeMs = 0;
  for (const leg of legs) {
    const track = graph.edges.get(leg.edgeId);
    invariant(track !== undefined, `${context} verweist auf eine unbekannte Laufzeitkante.`);
    const speedMmps = leg.direction === "along" ? track.speedAlongMmps : leg.direction === "against" ? track.speedAgainstMmps : null;
    invariant(Number.isSafeInteger(speedMmps) && speedMmps > 0, `${context} besitzt keine positive richtungsabhaengige Laufzeitgeschwindigkeit.`);
    const lengthMm = Math.abs(leg.edgeExitMm - leg.edgeEntryMm);
    const numerator = lengthMm * 1_000 + speedMmps - 1;
    invariant(Number.isSafeInteger(numerator), `${context} Laufzeit laeuft ueber.`);
    runtimeMs += Math.floor(numerator / speedMmps);
    invariant(Number.isSafeInteger(runtimeMs), `${context} Gesamtlaufzeit laeuft ueber.`);
  }
  invariant(runtimeMs > 0, `${context} besitzt keine positive Mindestlaufzeit.`);
  return runtimeMs;
}

function deriveDailyTransferRoutes(graph, snapshot, snapshotHash, passengerRoutes, specification) {
  const routeByPlayableLegId = new Map(passengerRoutes.map((route) => {
    const match = /^route:gtfs:(.+):v1$/u.exec(route.routeVersionId);
    invariant(match !== null, `${route.routeVersionId} besitzt keine GTFS-PlayableLeg-Identitaet.`);
    return [match[1], route];
  }));
  invariant(routeByPlayableLegId.size === passengerRoutes.length, "Passenger-Routen besitzen eine Identitaetskollision.");
  const orderableChains = snapshot.journeyChains.filter((chain) => chain.orderable === true);
  const releaseIds = new Set(orderableChains.map((chain) => chain.releaseId));
  invariant(releaseIds.size === 1, "Bestellbare JourneyChains mischen GTFS-Release-IDs.");
  const router = createDeterministicTrackRouter(routingEdges(graph), { allowedDirectionsByEdge: new Map([...graph.edges].map(([edgeId, edge]) => [edgeId, edge.allowedDirections ?? ["along", "against"]])) });
  const routedPairs = new Map();
  const routeTransferPair = ({ sourceEndpoint, targetEndpoint }) => {
    const key = transferPairKey(sourceEndpoint.legId, targetEndpoint.legId);
    if (routedPairs.has(key)) return routedPairs.get(key);
    const sourcePassenger = routeByPlayableLegId.get(sourceEndpoint.legId);
    const targetPassenger = routeByPlayableLegId.get(targetEndpoint.legId);
    invariant(sourcePassenger !== undefined, `${sourceEndpoint.legId} besitzt keine Passenger-Quellroute.`);
    invariant(targetPassenger !== undefined, `${targetEndpoint.legId} besitzt keine Passenger-Zielroute.`);
    invariant(sourcePassenger.routeVersionId === sourceEndpoint.passengerRouteVersionId, `${sourceEndpoint.legId} driftet von seiner Passenger-Routenidentitaet.`);
    invariant(targetPassenger.routeVersionId === targetEndpoint.passengerRouteVersionId, `${targetEndpoint.legId} driftet von seiner Passenger-Routenidentitaet.`);
    const sourceLeg = sourcePassenger.legs.at(-1);
    const targetLeg = targetPassenger.legs[0];
    invariant(sourceLeg !== undefined && targetLeg !== undefined, `${sourceEndpoint.legId}->${targetEndpoint.legId} besitzt eine leere Passenger-Route.`);
    const routed = router.route({
      origins: [publicAnchor({ edgeId: sourceLeg.edgeId, offsetMm: sourceLeg.edgeExitMm })],
      destinations: [publicAnchor({ edgeId: targetLeg.edgeId, offsetMm: targetLeg.edgeEntryMm })],
      targetRouteNumber: GTFS_SIMULATED_ROUTE_KEY,
    });
    const value = routed === null || routed.legs.length === 0 ? null : Object.freeze({
      routed,
      sourcePassenger,
      targetPassenger,
      minimumRuntimeMs: minimumTransferRuntimeMs(routed.legs, graph, `${sourceEndpoint.legId}->${targetEndpoint.legId}`),
    });
    routedPairs.set(key, value);
    return value;
  };
  const dailyPlan = deriveDailyCirculationPlan({
    journeyChains: orderableChains,
    stations: snapshot.stations,
    gtfsReleaseId: [...releaseIds][0],
    repeatEveryS: specification.dailyCirculation.repeatEveryS,
    minimumTurnaroundS: specification.dailyCirculation.minimumTurnaroundS,
    transferCost: ({ sourceEndpoint, targetEndpoint, earliestDepartureS, latestArrivalS }) => {
      const pair = routeTransferPair({ sourceEndpoint, targetEndpoint });
      if (pair === null || pair.minimumRuntimeMs > (latestArrivalS - earliestDepartureS) * 1_000) return null;
      return pair.routed.weightedCostMm;
    },
  });
  for (const [metric, expectedKey] of [
    ["lotCount", "expectedLotCount"],
    ["journeyChainCount", "expectedJourneyChainCount"],
    ["circulationCount", "expectedCirculationCount"],
    ["plannedTransitionCount", "expectedPlannedTransitionCount"],
    ["turnaroundDemandCount", "expectedTurnaroundDemandCount"],
    ["transferDemandCount", "expectedTransferDemandCount"],
    ["transferLotCount", "expectedTransferLotCount"],
  ]) invariant(
    dailyPlan.metrics[metric] === specification.dailyCirculation[expectedKey],
    `Daily-Circulation besitzt ${dailyPlan.metrics[metric]} statt ${specification.dailyCirculation[expectedKey]} fuer ${metric}.`,
  );
  const transferRoutes = dailyPlan.transferDemands.map((demand) => {
    const pair = routedPairs.get(transferPairKey(demand.sourcePassengerLegId, demand.targetPassengerLegId));
    invariant(pair !== undefined && pair !== null, `${demand.id} besitzt keinen nichtleeren realen OSM-Transferlaufweg.`);
    invariant(
      pair.sourcePassenger.routeVersionId === demand.sourcePassengerRouteVersionId
        && pair.targetPassenger.routeVersionId === demand.targetPassengerRouteVersionId
        && demand.sourcePassengerRouteVersionId === dailyPassengerRouteVersionId(demand.sourcePassengerLegId)
        && demand.targetPassengerRouteVersionId === dailyPassengerRouteVersionId(demand.targetPassengerLegId),
      `${demand.id} driftet von seinen Passenger-Routenidentitaeten.`,
    );
    invariant(pair.minimumRuntimeMs <= demand.availableWindowS * 1_000, `${demand.id} passt mit nativer Mindestlaufzeit nicht in sein Transferfenster.`);
    const legs = mergeLegs(pair.routed.legs).map((leg) => {
      const track = graph.edges.get(leg.edgeId);
      invariant(track !== undefined, `${demand.id} verweist auf eine unbekannte Transferkante.`);
      return Object.freeze({
        ...leg,
        availableProtectionSystems: Object.freeze([...track.protectionSystems]),
        simultaneouslyRequiredProtectionSystems: Object.freeze([]),
      });
    });
    const routeVersionId = `route:${demand.id}:movement:v1`;
    validateRouteContinuity(routeVersionId, legs, graph.edges);
    const totalLengthMm = legs.reduce((sum, leg) => sum + Math.abs(leg.edgeExitMm - leg.edgeEntryMm), 0);
    invariant(totalLengthMm === pair.routed.totalLengthMm && totalLengthMm > 0, `${demand.id} besitzt eine inkonsistente Transferlaenge.`);
    return Object.freeze({
      ...demand,
      formationLengthsMm: specification.dailyCirculation.formationLengthsMm,
      routeVersionId,
      templateId: `template:${demand.id}:movement:v1`,
      legs: Object.freeze(legs),
      totalLengthMm,
      weightedCostMm: pair.routed.weightedCostMm,
      minimumRuntimeMs: pair.minimumRuntimeMs,
    });
  }).sort((left, right) => compareText(left.id, right.id));
  const transferHasher = createHash("sha256");
  for (const route of transferRoutes) transferHasher.update(`${canonicalJson(route)}\n`);
  return Object.freeze({
    schema: GERMANY_TIMETABLE_TRANSFER_DEMAND_SCHEMA,
    infraReleaseId: specification.infraReleaseId,
    gtfsSnapshotHash: snapshotHash,
    dailyPlan,
    formationLengthsMm: specification.dailyCirculation.formationLengthsMm,
    transferRoutes: Object.freeze(transferRoutes),
    transferSetSha256: transferHasher.digest("hex"),
  });
}

async function resolveInputs(specification, root) {
  const base = resolve(root);
  const paths = Object.freeze({
    tracks: resolve(base, specification.tracks),
    corridors: resolve(base, specification.corridors),
    gtfsSnapshot: resolve(base, specification.gtfsSnapshot.path),
    output: resolve(base, specification.output),
    transferOutput: specification.transferOutput === undefined ? null : resolve(base, specification.transferOutput),
    report: resolve(base, specification.report),
  });
  invariant(paths.output !== paths.report, "Timetable-Route-Ausgabe und Bericht kollidieren.");
  invariant(paths.transferOutput === null || (paths.transferOutput !== paths.output && paths.transferOutput !== paths.report), "Transfer-, Timetable-Route-Ausgabe und Bericht kollidieren.");
  const [envelope, tracksProof, corridorsProof, gtfsProof] = await Promise.all([
    readJson(paths.gtfsSnapshot, "GTFS-Snapshot"),
    sha256File(paths.tracks),
    sha256File(paths.corridors),
    sha256File(paths.gtfsSnapshot),
  ]);
  invariant(gtfsProof.bytes === specification.gtfsSnapshot.expectedBytes, `GTFS-Snapshot besitzt ${gtfsProof.bytes} statt ${specification.gtfsSnapshot.expectedBytes} Bytes.`);
  invariant(gtfsProof.sha256 === specification.gtfsSnapshot.expectedFileSha256, "GTFS-Snapshot besitzt nicht den erwarteten Datei-SHA-256.");
  const validatedSnapshot = validatePinnedGtfsSnapshot(envelope, specification.gtfsSnapshot, specification.selection);
  const networkReference = validatedSnapshot.snapshot.timetableGeneration?.networkReference;
  if (networkReference !== undefined) {
    invariant(networkReference.schemaVersion === "zugfolge-game-timetable-network-reference/v1"
      && networkReference.tracks?.sha256 === tracksProof.sha256 && networkReference.tracks?.bytes === tracksProof.bytes
      && networkReference.corridors?.sha256 === corridorsProof.sha256 && networkReference.corridors?.bytes === corridorsProof.bytes
      && canonicalJson(networkReference.permittedProtectionModes) === canonicalJson(specification.selection.permittedProtectionModes),
    "Finaler Routecompiler muss exakt den fuer die Linienkuerzung gebundenen Binnen-Trackgraphen und seine Zugsicherungssysteme verwenden.");
  }
  return Object.freeze({ paths, proofs: Object.freeze({ tracks: tracksProof, corridors: corridorsProof, gtfsSnapshot: gtfsProof }), validatedSnapshot });
}

export async function analyzeGermanyTimetableRoutes(rawSpecification, root = ".") {
  const specification = validateSpecification(rawSpecification);
  const inputs = await resolveInputs(specification, root);
  const graph = await buildGtfsTrackGraph({
    snapshot: inputs.validatedSnapshot.snapshot,
    tracksPath: inputs.paths.tracks,
    corridorsPath: inputs.paths.corridors,
    permittedProtectionModes: specification.selection.permittedProtectionModes,
    unknownMainlineSpeedKmh: specification.dailyCirculation?.unknownMainlineSpeedKmh,
    unknownServiceSpeedKmh: specification.dailyCirculation?.unknownServiceSpeedKmh,
  });
  invariant(graph.eligibleSegments.length === inputs.validatedSnapshot.selectedSegments.length, "GTFS-Graph und validierte Auswahl besitzen verschiedene Segmentmengen.");
  const derived = deriveRoutes(graph, inputs.validatedSnapshot.selectedSegments);
  const passengerQualified = Object.keys(derived.findings).length === 0 && derived.routes.length === inputs.validatedSnapshot.selectedSegments.length;
  const transfers = specification.dailyCirculation === null || !passengerQualified
    ? null
    : deriveDailyTransferRoutes(graph, inputs.validatedSnapshot.snapshot, inputs.validatedSnapshot.snapshotHash, derived.routes, specification);
  const unresolvedRequired = Object.keys(derived.findings).length;
  const qualified = passengerQualified && (specification.dailyCirculation === null || transfers?.transferRoutes.length === specification.dailyCirculation.expectedTransferDemandCount);
  const routeHasher = createHash("sha256");
  for (const route of derived.routes) routeHasher.update(`${canonicalJson(route)}\n`);
  const report = Object.freeze({
    schema: GERMANY_TIMETABLE_ROUTE_REPORT_SCHEMA,
    infraReleaseId: specification.infraReleaseId,
    status: qualified ? "qualified" : "blocked",
    routesProduced: qualified,
    derivationRule: TIMETABLE_ROUTE_DERIVATION_RULE,
    selectionRule: TIMETABLE_ROUTE_SELECTION_RULE,
    policyId: TIMETABLE_ROUTE_POLICY_ID,
    gtfsBinding: Object.freeze({
      schema: inputs.validatedSnapshot.snapshot.schema,
      regionId: inputs.validatedSnapshot.snapshot.regionId,
      regionVariant: inputs.validatedSnapshot.snapshot.regionVariant,
      serviceDate: inputs.validatedSnapshot.snapshot.serviceDate,
      sourceId: inputs.validatedSnapshot.snapshot.source.sourceId,
      archive: inputs.validatedSnapshot.snapshot.source.archive,
      archiveSha256: inputs.validatedSnapshot.snapshot.source.archiveSha256,
      sourceLicense: "CC-BY-4.0",
      sourceLicenseAsPublished: inputs.validatedSnapshot.snapshot.source.sourceLicense,
      attribution: inputs.validatedSnapshot.snapshot.source.attribution,
      snapshotHash: inputs.validatedSnapshot.snapshotHash,
    }),
    metrics: Object.freeze({
      ...inputs.validatedSnapshot.metrics,
      completeRouteCount: derived.routes.length,
      incompleteRouteCount: inputs.validatedSnapshot.selectedSegments.length - derived.routes.length,
      routeRecordCount: derived.routes.length,
      ...derived.metrics,
      dailyCirculation: transfers?.dailyPlan.metrics ?? null,
      transferRouteCount: transfers?.transferRoutes.length ?? 0,
      transferRouteLegCount: transfers?.transferRoutes.reduce((sum, route) => sum + route.legs.length, 0) ?? 0,
      transferRouteLengthMm: transfers?.transferRoutes.reduce((sum, route) => sum + route.totalLengthMm, 0) ?? 0,
      retainedRoutingTrackCount: graph.edges.size,
    }),
    sourceProofs: inputs.proofs,
    sourceMetrics: Object.freeze({ gtfsSnapshot: inputs.validatedSnapshot.metrics, gtfsTrackGraph: graph.metrics }),
    provenance: Object.freeze({
      realGeometry: true,
      simulatedOperationalAssignment: true,
      realInterlockingFactsClaimed: false,
      operationalNetworkUsed: false,
      gtfsShapeGeometryUsed: false,
      inventedGeometryUsed: false,
      everyIntermediateStopUsedAsTrackAnchor: true,
      trackGraphRule: GTFS_TRACK_GRAPH_RULE,
      simulatedRouteKey: GTFS_SIMULATED_ROUTE_KEY,
    }),
    routeSetSha256: qualified ? routeHasher.digest("hex") : null,
    dailyCirculationPlanSha256: transfers?.dailyPlan.planSha256 ?? null,
    transferSetSha256: transfers?.transferSetSha256 ?? null,
    transferDemandsProduced: qualified && transfers !== null,
    findings: derived.findings,
    unresolvedRequired,
  });
  return Object.freeze({ report, routes: derived.routes, transfers, paths: inputs.paths });
}

async function writeJsonSequenceAtomic(path, routes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.building-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  const stream = createWriteStream(temporary, { fd: handle.fd, autoClose: false, encoding: "utf8" });
  try {
    for (const route of routes) {
      if (!stream.write(`${canonicalJson(route)}\n`)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    stream.destroy();
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.building-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function requireAbsent(path) {
  try {
    await stat(path);
    throw new Error(`Ziel ${path} existiert bereits.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function compileGermanyTimetableRoutes(rawSpecification, root = ".") {
  const specification = validateSpecification(rawSpecification);
  const output = resolve(root, specification.output);
  const transferOutput = specification.transferOutput === undefined ? null : resolve(root, specification.transferOutput);
  const reportPath = resolve(root, specification.report);
  await Promise.all([requireAbsent(output), requireAbsent(reportPath), ...(transferOutput === null ? [] : [requireAbsent(transferOutput)])]);
  const result = await analyzeGermanyTimetableRoutes(specification, root);
  if (!result.report.routesProduced) {
    await writeJsonAtomic(reportPath, result.report);
    return result.report;
  }
  const published = [];
  try {
    await writeJsonSequenceAtomic(output, result.routes);
    published.push(output);
    if (transferOutput !== null) {
      invariant(result.transfers !== null, "Qualifizierter v4-Timetable-Build besitzt keine Transferausgabe.");
      await writeJsonAtomic(transferOutput, result.transfers);
      published.push(transferOutput);
    }
    await writeJsonAtomic(reportPath, result.report);
  } catch (error) {
    await Promise.all(published.map((path) => rm(path, { force: true })));
    throw error;
  }
  return result.report;
}

export async function loadGermanyTimetableRouteSpecification(path) {
  return validateSpecification(await readJson(path, "Timetable-Route-Spezifikation"));
}
