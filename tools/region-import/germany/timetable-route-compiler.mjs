import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { dirname, resolve } from "node:path";

import {
  gtfsBoundaryPlanningWindowId,
  gtfsExternalLegId,
  gtfsJourneyChainId,
  gtfsPlayableLegId,
} from "../../../packages/gtfs/dist/index.js";
import { createDeterministicTrackRouter } from "./deterministic-track-router.mjs";
import {
  buildGtfsTrackGraph,
  GTFS_SIMULATED_ROUTE_KEY,
  GTFS_TRACK_GRAPH_RULE,
} from "./operational-track-graph.mjs";

export const GERMANY_TIMETABLE_ROUTE_SPEC_SCHEMA = "zugfolge-germany-timetable-route-compiler/v3";
export const GERMANY_TIMETABLE_ROUTE_REPORT_SCHEMA = "zugfolge-germany-timetable-route-report/v2";
export const TIMETABLE_ROUTE_DERIVATION_RULE = "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2";
export const TIMETABLE_ROUTE_SELECTION_RULE = "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2";
export const TIMETABLE_ROUTE_POLICY_ID = "synthetic-operational-b/v2";

const GTFS_SNAPSHOT_SCHEMA = "zugfolge-gtfs-region-snapshot/v2";
const JOURNEY_CHAIN_SCHEMA = "zugfolge-gtfs-journey-chain/v2";
const LEGACY_TIMETABLE_ROUTE_SPEC_SCHEMA = "zugfolge-germany-timetable-route-compiler/v2";
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
  exactKeys(value, ["schema", "infraReleaseId", "tracks", "corridors", "gtfsSnapshot", "selection", "output", "report"], "Timetable-Route-Spezifikation");
  invariant(
    value.schema === GERMANY_TIMETABLE_ROUTE_SPEC_SCHEMA || value.schema === LEGACY_TIMETABLE_ROUTE_SPEC_SCHEMA,
    "Timetable-Route-Spezifikation besitzt weder das aktuelle v3- noch das historische v2-Schema.",
  );
  for (const key of ["infraReleaseId", "tracks", "corridors", "output", "report"]) nonEmptyString(value[key], key);
  invariant(value.output !== value.report, "Timetable-Route-Ausgabe und Bericht muessen verschieden sein.");

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

  const current = value.schema === GERMANY_TIMETABLE_ROUTE_SPEC_SCHEMA;
  exactKeys(value.selection, current
    ? ["rule", "qualityClass", "requireOrderable", "minimumStopCount", "expectedSnapshotSegmentCount", "expectedEligibleSegmentCount", "permittedProtectionModes"]
    : ["rule", "qualityClass", "requireOrderable", "minimumStopCount", "expectedSnapshotSegmentCount", "expectedEligibleSegmentCount"], "selection");
  invariant(value.selection.rule === TIMETABLE_ROUTE_SELECTION_RULE, "selection.rule ist nicht der geschlossene v2-Auswahlvertrag.");
  invariant(value.selection.qualityClass === "B", "selection.qualityClass muss B sein.");
  invariant(value.selection.requireOrderable === true, "selection.requireOrderable muss true sein.");
  invariant(value.selection.minimumStopCount === 2, "selection.minimumStopCount muss 2 sein.");
  safeInteger(value.selection.expectedSnapshotSegmentCount, "selection.expectedSnapshotSegmentCount", 1);
  safeInteger(value.selection.expectedEligibleSegmentCount, "selection.expectedEligibleSegmentCount", 1);
  invariant(value.selection.expectedEligibleSegmentCount <= value.selection.expectedSnapshotSegmentCount, "selection erwartet mehr geeignete als vorhandene Segmente.");
  const permittedProtectionModes = current ? value.selection.permittedProtectionModes : null;
  if (current) {
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
  return Object.freeze({
    ...value,
    selection: Object.freeze({ ...value.selection, permittedProtectionModes }),
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
  exactKeys(snapshot, [
    "schema", "regionId", "regionVariant", "serviceDate", "source", "metrics", "externalLegSpecification",
    "serviceScopeSpecification", "serviceScopeReport", "stations", "journeyChains", "boundaryPlanningWindows", "segments",
  ], "GTFS-Snapshot");
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
    nonEmptyString(station.parentStationId, `${stopId}.parentStationId`);
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
      chainId === gtfsJourneyChainId({
        regionId: chainRegionId,
        releaseId: chainReleaseId,
        sourceTripId: chainSourceTripId,
      }),
      `${chainId} verletzt den releasegebundenen weltneutralen Journey-v2-Identitaetsvertrag.`,
    );
    journeyWorldIds.add(chainWorldId);
    journeyReleaseIds.add(chainReleaseId);
    invariant(!chainById.has(chainId), `GTFS-JourneyChain ${chainId} ist doppelt.`);
    boolean(chain.orderable, `${chainId}.orderable`);
    if (chain.orderable) orderableJourneyChainCount += 1;
    chainById.set(chainId, chain);
    for (const [legIndex, value] of list(chain.legs, `${chainId}.legs`).entries()) {
      const leg = record(value, `${chainId}.legs[${legIndex}]`);
      const legId = nonEmptyString(leg.legId, `${chainId}.legs[${legIndex}].legId`);
      invariant(!allLegIds.has(legId), `GTFS-Leg ${legId} ist doppelt.`);
      allLegIds.add(legId);
      safeInteger(leg.sequence, `${legId}.sequence`, 0);
      invariant(leg.sequence === legIndex, `${legId}.sequence ist nicht lueckenlos.`);
      if (leg.kind === "playable") {
        invariant(
          legId === gtfsPlayableLegId({ journeyChainId: chainId, sequence: leg.sequence }),
          `${legId} verletzt den PlayableLeg-v2-Identitaetsvertrag.`,
        );
        playableLegCount += 1;
        boolean(leg.orderable, `${legId}.orderable`);
        invariant(leg.qualityClass === "B" || leg.qualityClass === "C", `${legId}.qualityClass ist unbekannt.`);
        invariant((leg.qualityClass === "B") === leg.orderable, `${legId} verletzt B genau dann orderable.`);
        const stops = validateStopSequence(leg.stops, `${legId}.stops`, stationById, 1);
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
      "qualityClass", "orderable", "entry", "exit", "planningWindows", "stops",
    ], `GTFS-Snapshot.segments[${index}]`);
    const segmentId = nonEmptyString(segment.segmentId, `GTFS-Snapshot.segments[${index}].segmentId`);
    invariant(!segmentIds.has(segmentId), `GTFS-Segment ${segmentId} ist doppelt.`);
    segmentIds.add(segmentId);
    const chain = chainById.get(nonEmptyString(segment.journeyChainId, `${segmentId}.journeyChainId`));
    invariant(chain !== undefined, `${segmentId} verweist auf eine unbekannte JourneyChain.`);
    invariant(segment.sourceTripId === chain.sourceTripId, `${segmentId} verletzt die SourceTrip-Bindung seiner JourneyChain.`);
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

function selectSegmentComponent(graph, segment) {
  const byStop = new Map();
  let common = null;
  for (const stop of segment.stops) {
    if (!byStop.has(stop.stopId)) byStop.set(stop.stopId, anchorsByComponent(graph, stop.stopId));
    const components = new Set(byStop.get(stop.stopId).keys());
    common = common === null ? components : new Set([...common].filter((componentId) => components.has(componentId)));
  }
  if (common === null || common.size === 0) return null;
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
  return Object.freeze({ componentId: choices[0].componentId, byStop });
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
  const router = createDeterministicTrackRouter(routingEdges);
  const findings = new Map();
  const routes = [];
  const routeCache = new Map();
  let routedStopPairCount = 0;
  let reusedStopPairRouteCount = 0;
  let maximumAnchorDistanceMm = 0;
  let totalRouteLengthMm = 0;
  let zeroMovementStopTransitionCount = 0;

  for (const segment of selectedSegments) {
    const component = selectSegmentComponent(graph, segment);
    if (component === null) {
      addFinding(findings, "segment-stops-share-no-real-track-component", segment.segmentId);
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
      const componentOrigins = component.byStop.get(originStopId).get(component.componentId);
      const destinations = component.byStop.get(destinationStopId).get(component.componentId);
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

async function resolveInputs(specification, root) {
  const base = resolve(root);
  const paths = Object.freeze({
    tracks: resolve(base, specification.tracks),
    corridors: resolve(base, specification.corridors),
    gtfsSnapshot: resolve(base, specification.gtfsSnapshot.path),
    output: resolve(base, specification.output),
    report: resolve(base, specification.report),
  });
  invariant(paths.output !== paths.report, "Timetable-Route-Ausgabe und Bericht kollidieren.");
  const [envelope, tracksProof, corridorsProof, gtfsProof] = await Promise.all([
    readJson(paths.gtfsSnapshot, "GTFS-Snapshot"),
    sha256File(paths.tracks),
    sha256File(paths.corridors),
    sha256File(paths.gtfsSnapshot),
  ]);
  invariant(gtfsProof.bytes === specification.gtfsSnapshot.expectedBytes, `GTFS-Snapshot besitzt ${gtfsProof.bytes} statt ${specification.gtfsSnapshot.expectedBytes} Bytes.`);
  invariant(gtfsProof.sha256 === specification.gtfsSnapshot.expectedFileSha256, "GTFS-Snapshot besitzt nicht den erwarteten Datei-SHA-256.");
  const validatedSnapshot = validatePinnedGtfsSnapshot(envelope, specification.gtfsSnapshot, specification.selection);
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
  });
  invariant(graph.eligibleSegments.length === inputs.validatedSnapshot.selectedSegments.length, "GTFS-Graph und validierte Auswahl besitzen verschiedene Segmentmengen.");
  const derived = deriveRoutes(graph, inputs.validatedSnapshot.selectedSegments);
  const unresolvedRequired = Object.keys(derived.findings).length;
  const qualified = unresolvedRequired === 0 && derived.routes.length === inputs.validatedSnapshot.selectedSegments.length;
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
    findings: derived.findings,
    unresolvedRequired,
  });
  return Object.freeze({ report, routes: derived.routes, paths: inputs.paths });
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
  const reportPath = resolve(root, specification.report);
  await Promise.all([requireAbsent(output), requireAbsent(reportPath)]);
  const result = await analyzeGermanyTimetableRoutes(specification, root);
  await writeJsonAtomic(reportPath, result.report);
  if (result.report.routesProduced) await writeJsonSequenceAtomic(output, result.routes);
  return result.report;
}

export async function loadGermanyTimetableRouteSpecification(path) {
  return validateSpecification(await readJson(path, "Timetable-Route-Spezifikation"));
}
