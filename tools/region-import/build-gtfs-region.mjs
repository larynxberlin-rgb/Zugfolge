// zugfolge:quelle=gtfs-de-rv
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import {
  activeGtfsServiceIds,
  canonicalPlanningJson,
  compileGameTimetable,
  gtfsServiceSeconds,
  parseGtfsCsv,
} from "../../packages/gtfs/dist/index.js";
import { validateAlphaWorldBuildConfiguration } from "./build-alpha-world.mjs";
import { compileServiceScope } from "./service-scope.mjs";
import { trackInsidePlayableArea, validatePlayableArea } from "./playable-area.mjs";
import { refineGameTimetableTrips } from "./refine-game-timetable.mjs";

const [buildConfigurationPath, sourceDirectory, serviceDate, archiveSha256, outputPath, networkBindingPath] = process.argv.slice(2);
if (!buildConfigurationPath || !sourceDirectory || !/^20[0-9]{6}$/.test(serviceDate ?? "") || !/^[a-f0-9]{64}$/.test(archiveSha256 ?? "") || !outputPath) {
  throw new Error("usage: node build-gtfs-region.mjs BUILD-CONFIG.json SOURCE_DIRECTORY YYYYMMDD ARCHIVE_SHA256 OUTPUT_JSON [NETWORK-BINDING.json]");
}
const rawBuildConfiguration = JSON.parse(readFileSync(buildConfigurationPath, "utf8"));
const identityKeys = ["schemaVersion", "worldId", "regionId", "regionVariant", "operatorId", "seed", "fleetReleaseId", "planningAuthority"].sort();
const actualConfigurationKeys = typeof rawBuildConfiguration === "object" && rawBuildConfiguration !== null && !Array.isArray(rawBuildConfiguration)
  ? Object.keys(rawBuildConfiguration).sort()
  : [];
const planningAuthorityKeys = typeof rawBuildConfiguration?.planningAuthority === "object"
  && rawBuildConfiguration.planningAuthority !== null
  && !Array.isArray(rawBuildConfiguration.planningAuthority)
  ? Object.keys(rawBuildConfiguration.planningAuthority).sort()
  : [];
const retiredWorldId = "00000000-0000-4000-8000-000000000014";
const identityOnly = rawBuildConfiguration?.schemaVersion === "zugfolge-alpha-world-identity/v1";
let buildConfiguration;
try {
  buildConfiguration = identityOnly
    ? rawBuildConfiguration
    : validateAlphaWorldBuildConfiguration(rawBuildConfiguration);
} catch {
  throw new Error("BUILD-CONFIG besitzt keine explizite UUID-Welt- und Regionsbindung mit vollstaendig gebundenem V3-Artefaktsatz.");
}
if (
  (identityOnly && (
    actualConfigurationKeys.length !== identityKeys.length
    || actualConfigurationKeys.some((key, index) => key !== identityKeys[index])
  ))
  || !["zugfolge-alpha-world-identity/v1", "zugfolge-alpha-world-build-configuration/v3"].includes(buildConfiguration?.schemaVersion)
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(buildConfiguration.worldId ?? "")
  || buildConfiguration.worldId === retiredWorldId
  || typeof buildConfiguration.regionId !== "string"
  || buildConfiguration.regionId.trim() === ""
  || typeof buildConfiguration.regionVariant !== "string"
  || buildConfiguration.regionVariant.trim() === ""
  || typeof buildConfiguration.operatorId !== "string"
  || buildConfiguration.operatorId.trim() === ""
  || typeof buildConfiguration.seed !== "string"
  || !/^[1-9][0-9]*$/u.test(buildConfiguration.seed)
  || BigInt(buildConfiguration.seed) > 0xffff_ffff_ffff_ffffn
  || typeof buildConfiguration.fleetReleaseId !== "string"
  || buildConfiguration.fleetReleaseId.trim() === ""
  || planningAuthorityKeys.length !== 2
  || planningAuthorityKeys[0] !== "accountId"
  || planningAuthorityKeys[1] !== "displayName"
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(buildConfiguration.planningAuthority?.accountId ?? "")
  || typeof buildConfiguration.planningAuthority?.displayName !== "string"
  || buildConfiguration.planningAuthority.displayName.trim() === ""
) throw new Error("BUILD-CONFIG besitzt keine explizite UUID-Welt- und Regionsbindung mit vollstaendig gebundenem V3-Artefaktsatz.");
const WORLD_ID = buildConfiguration.worldId;
const REGION_ID = buildConfiguration.regionId;
const REGION_VARIANT = buildConfiguration.regionVariant;

const polygon = [
  [10.331974, 50.976894],
  [10.789252, 51.492924],
  [11.626963, 52.130512],
  [12.662285, 51.867810],
  [13.287734, 51.309654],
  [12.930877, 50.839695],
  [12.474716, 50.714670],
  [11.374546, 50.650490],
];
const playableArea = { polygonE7: polygon.map(([longitude, latitude]) => [Math.round(longitude * 10_000_000), Math.round(latitude * 10_000_000)]) };
const playablePolygon = validatePlayableArea(playableArea);
let timetableGeneration = JSON.parse(readFileSync(
  new URL("./specifications/game-timetable-v1.json", import.meta.url),
  "utf8",
));
const serviceScopeSpecification = JSON.parse(readFileSync(
  new URL("./specifications/spnv-service-scope-2026.1.json", import.meta.url),
  "utf8",
));
const serviceScope = compileServiceScope(serviceScopeSpecification);

function table(name, optional = false) {
  const path = `${sourceDirectory}/${name}`;
  return optional && !existsSync(path) ? [] : parseGtfsCsv(readFileSync(path, "utf8"));
}

function inside(longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  const point = { longitudeE7: Math.round(longitude * 10_000_000), latitudeE7: Math.round(latitude * 10_000_000) };
  return trackInsidePlayableArea(playablePolygon, [point, point]);
}

const stops = table("stops.txt");
const routes = table("routes.txt");
const trips = table("trips.txt");
const stopTimes = table("stop_times.txt");
const shapesById = new Map();
for (const point of table("shapes.txt", true)) {
  const values = shapesById.get(point.shape_id) ?? [];
  values.push(point);
  shapesById.set(point.shape_id, values);
}
for (const points of shapesById.values()) points.sort((left, right) => Number(left.shape_pt_sequence) - Number(right.shape_pt_sequence));
const calendar = table("calendar.txt", true);
const calendarDates = table("calendar_dates.txt", true);
if (calendar.length === 0 && calendarDates.length === 0) throw new Error("GTFS besitzt keinen Verkehrstagskalender.");
const frequenciesByTrip = new Map();
for (const frequency of table("frequencies.txt", true)) {
  const values = frequenciesByTrip.get(frequency.trip_id) ?? [];
  values.push({ startS: gtfsServiceSeconds(frequency.start_time), endS: gtfsServiceSeconds(frequency.end_time), headwayS: Number(frequency.headway_secs) });
  frequenciesByTrip.set(frequency.trip_id, values);
}
const activeServices = activeGtfsServiceIds({ calendar, calendarDates }, serviceDate);
const stopsById = new Map(stops.map((stop) => [stop.stop_id, {
  ...stop,
  inRegion: inside(Number(stop.stop_lon), Number(stop.stop_lat)),
}]));
const routesById = new Map(routes.map((route) => [route.route_id, route]));
const shapeConnectionsCache = new Map();

function shapeConnections(trip, values) {
  const points = shapesById.get(trip.shape_id);
  if (points === undefined) return values.map(() => undefined);
  const key = canonicalPlanningJson({ shapeId: trip.shape_id, stops: values.map((value) => [value.stop_id, value.shape_dist_traveled ?? ""]) });
  if (shapeConnectionsCache.has(key)) return shapeConnectionsCache.get(key);
  const coordinates = points.map((point) => [Math.round(Number(point.shape_pt_lon) * 10_000_000), Math.round(Number(point.shape_pt_lat) * 10_000_000)]);
  if (coordinates.length < 2 || coordinates.some((coordinate) => coordinate.some((value) => !Number.isSafeInteger(value)))) throw new Error(`GTFS-Shape '${trip.shape_id}' besitzt keine gueltigen Koordinaten.`);
  let cursor = 0;
  const positions = values.map((time) => {
    const stop = stopsById.get(time.stop_id);
    if (stop === undefined) return cursor;
    let best = cursor;
    let distance = Infinity;
    for (let index = cursor; index < points.length; index += 1) {
      const candidate = time.shape_dist_traveled !== undefined && time.shape_dist_traveled !== "" && points[index].shape_dist_traveled !== undefined && points[index].shape_dist_traveled !== ""
        ? Math.abs(Number(points[index].shape_dist_traveled) - Number(time.shape_dist_traveled))
        : (coordinates[index][0] - Math.round(Number(stop.stop_lon) * 10_000_000)) ** 2 + (coordinates[index][1] - Math.round(Number(stop.stop_lat) * 10_000_000)) ** 2;
      if (candidate < distance) { best = index; distance = candidate; }
    }
    cursor = best;
    return best;
  });
  const connections = values.map((_, index) => {
    if (index === values.length - 1) return undefined;
    const selected = coordinates.slice(positions[index], positions[index + 1] + 1);
    const first = stopsById.get(values[index].stop_id);
    const last = stopsById.get(values[index + 1].stop_id);
    if (first === undefined || last === undefined) return false;
    return trackInsidePlayableArea(playablePolygon, [
      [Math.round(Number(first.stop_lon) * 10_000_000), Math.round(Number(first.stop_lat) * 10_000_000)],
      ...selected,
      [Math.round(Number(last.stop_lon) * 10_000_000), Math.round(Number(last.stop_lat) * 10_000_000)],
    ].map(([longitudeE7, latitudeE7]) => ({ longitudeE7, latitudeE7 })));
  });
  shapeConnectionsCache.set(key, connections);
  return connections;
}
const activeTrips = trips.filter((trip) => activeServices.has(trip.service_id));
const activeTripsById = new Map(activeTrips.map((trip) => [trip.trip_id, trip]));
const serviceScopeDecisions = new Map(activeTrips.map((trip) => [trip.trip_id, serviceScope.decide(routesById.get(trip.route_id))]));
const tripsById = new Map(activeTrips
  .filter((trip) => serviceScopeDecisions.get(trip.trip_id)?.included === true)
  .map((trip) => [trip.trip_id, trip]));
const timesByTrip = new Map();
const excludedTimesByTrip = new Map();
for (const time of stopTimes) {
  if (!activeTripsById.has(time.trip_id)) continue;
  const target = tripsById.has(time.trip_id) ? timesByTrip : excludedTimesByTrip;
  const values = target.get(time.trip_id) ?? [];
  values.push(time);
  target.set(time.trip_id, values);
}

const chainTrips = [];
const excludedTouchedTrips = [];
for (const trip of activeTrips) {
  const decision = serviceScopeDecisions.get(trip.trip_id);
  if (decision?.included === true) continue;
  const values = excludedTimesByTrip.get(trip.trip_id) ?? [];
  if (!values.some((value) => stopsById.get(value.stop_id)?.inRegion === true)) continue;
  const route = routesById.get(trip.route_id);
  excludedTouchedTrips.push({
    sourceTripId: trip.trip_id,
    routeId: trip.route_id,
    routeShortName: route?.route_short_name ?? "",
    agencyId: route?.agency_id ?? "",
    category: decision?.category ?? "unclassified",
    reason: decision?.reason ?? "Keine Scopeentscheidung vorhanden.",
  });
}
excludedTouchedTrips.sort((left, right) => left.sourceTripId.localeCompare(right.sourceTripId));
for (const [tripId, values] of [...timesByTrip].sort(([left], [right]) => left.localeCompare(right))) {
  values.sort((left, right) => Number(left.stop_sequence) - Number(right.stop_sequence));
  if (!values.some((value) => stopsById.get(value.stop_id)?.inRegion === true)) continue;
  const trip = tripsById.get(tripId);
  const route = routesById.get(trip.route_id);
  const connections = shapeConnections(trip, values);
  chainTrips.push({
    sourceTripId: tripId,
    serviceId: trip.service_id,
    routeId: trip.route_id,
    routeShortName: route?.route_short_name ?? "",
    headsign: trip.trip_headsign ?? "",
    directionId: trip.direction_id ?? "",
    frequencies: frequenciesByTrip.get(tripId) ?? [],
    stops: values.map((value, index) => {
      const selectedStop = stopsById.get(value.stop_id);
      return {
        stopId: value.stop_id,
        stopName: selectedStop?.stop_name ?? value.stop_id,
        inRegion: selectedStop?.inRegion === true,
        nodeId: selectedStop?.parent_station || value.stop_id,
        pathToNextInRegion: connections[index],
        stopSequence: Number(value.stop_sequence),
        arrivalS: gtfsServiceSeconds(value.arrival_time),
        departureS: gtfsServiceSeconds(value.departure_time),
      };
    }),
  });
}

const compilationInput = {
  worldId: WORLD_ID,
  regionId: REGION_ID,
  releaseId: `gtfs-de-rv-${serviceDate}-${archiveSha256.slice(0, 16)}`,
  serviceDate,
  seed: buildConfiguration.seed,
  specification: timetableGeneration,
  trips: chainTrips,
};
let journeyChainCompilation = compileGameTimetable(compilationInput);
let refinementMetrics = {};
if (networkBindingPath !== undefined && journeyChainCompilation.chains.length > 0) {
  const refined = await refineGameTimetableTrips({
    trips: chainTrips,
    networkBindingPath,
    preliminarySnapshot: {
      playableArea,
      timetableGeneration,
      segments: journeyChainCompilation.chains.map((chain) => ({ segmentId: chain.legs[0].legId, orderable: true, qualityClass: "B", stops: chain.legs[0].stops })),
      stations: [...stopsById.values()].filter((stop) => stop.inRegion).map((stop) => ({ stopId: stop.stop_id, longitudeE7: Math.round(Number(stop.stop_lon) * 10_000_000), latitudeE7: Math.round(Number(stop.stop_lat) * 10_000_000) })),
    },
  });
  timetableGeneration = { ...timetableGeneration, requireEligibleTerminals: true, networkReference: refined.networkReference };
  refinementMetrics = refined.metrics;
  journeyChainCompilation = compileGameTimetable({ ...compilationInput, specification: timetableGeneration, trips: refined.trips });
}
const journeyChains = journeyChainCompilation.chains;
const usedStopIds = new Set(journeyChains.flatMap((chain) => chain.legs
  .filter((leg) => leg.kind === "playable")
  .flatMap((leg) => leg.stops.map((stop) => stop.stopId))));
const stations = [...usedStopIds]
  .map((stopId) => stopsById.get(stopId))
  .filter((stop) => stop !== undefined)
  .map((stop) => ({
    stopId: stop.stop_id,
    parentStationId: stop.parent_station || null,
    name: stop.stop_name,
    latitudeE7: Math.round(Number(stop.stop_lat) * 10_000_000),
    longitudeE7: Math.round(Number(stop.stop_lon) * 10_000_000),
    inRegion: stop.inRegion,
  }))
  .sort((left, right) => left.stopId.localeCompare(right.stopId));
const boundaryPlanningWindows = [];
const segments = journeyChains.flatMap((chain) => chain.legs
  .filter((leg) => leg.kind === "playable" && leg.stops.length >= 2)
  .map((leg) => ({
    segmentId: leg.legId,
    journeyChainId: chain.journeyChainId,
    lineId: chain.lineId,
    sourceTripId: chain.sourceTripId,
    serviceId: chain.serviceId,
    routeId: chain.routeId,
    routeShortName: chain.routeShortName,
    headsign: chain.headsign,
    directionId: chain.directionId,
    qualityClass: leg.qualityClass,
    orderable: leg.orderable,
    sourceTripIds: chain.sourceTripIds,
    sourceRouteIds: chain.sourceRouteIds,
    entry: null,
    exit: null,
    planningWindows: leg.planningWindows,
    stops: leg.stops,
    })));
segments.sort((left, right) => left.segmentId.localeCompare(right.segmentId));
const unresolvedEntryCount = segments.filter((segment) => segment.entry?.kind === "first-outside").length;
const unresolvedExitCount = segments.filter((segment) => segment.exit?.kind === "first-outside").length;
const snapshot = {
  schema: "zugfolge-gtfs-region-snapshot/v2",
  regionId: REGION_ID,
  regionVariant: REGION_VARIANT,
  serviceDate,
  playableArea,
  generationSeed: buildConfiguration.seed,
  timetableGeneration: { ...timetableGeneration, adjustments: journeyChainCompilation.adjustments },
  lines: journeyChainCompilation.lines,
  source: {
    sourceId: `gtfs-de-rv-free-${serviceDate}`,
    archive: basename(`${sourceDirectory}.zip`),
    archiveSha256,
    feedUrl: "https://download.gtfs.de/germany/rv_free/latest.zip",
    sourceLicense: "CC BY 4.0",
    attribution: "DELFI e.V.; GTFS.DE",
  },
  metrics: {
    ...refinementMetrics,
    activeServiceCount: activeServices.size,
    activeTripCount: activeTrips.length,
    eligibleActiveTripCount: tripsById.size,
    touchedTripCount: journeyChainCompilation.metrics.touchedTripCount,
    excludedTouchedTripCount: excludedTouchedTrips.length,
    playableSegmentCount: segments.length,
    generatedJourneyCount: journeyChains.length,
    generatedLineCount: journeyChainCompilation.lines.length,
    discardedSingleStopSectionCount: journeyChainCompilation.metrics.discardedSingleStopSectionCount,
    externalLegCount: 0,
    orderableJourneyChainCount: journeyChains.length,
    unresolvedBoundaryCount: 0,
    parentStationCount: new Set(stations.map((station) => station.parentStationId || station.stopId)).size,
    unresolvedEntryCount,
    unresolvedExitCount,
  },
  serviceScopeSpecification,
  serviceScopeReport: {
    excludedTouchedTrips,
    excludedCountsByCategory: Object.fromEntries([...new Set(excludedTouchedTrips.map((trip) => trip.category))]
      .sort()
      .map((category) => [category, excludedTouchedTrips.filter((trip) => trip.category === category).length])),
  },
  stations,
  journeyChains,
  boundaryPlanningWindows,
  segments,
};
const canonical = canonicalPlanningJson(snapshot);
const envelope = {
  snapshot,
  snapshotHash: createHash("sha256").update(canonical).digest("hex"),
};
writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...snapshot.metrics, snapshotHash: envelope.snapshotHash })}\n`);
