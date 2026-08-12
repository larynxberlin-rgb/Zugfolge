// zugfolge:quelle=gtfs-de-rv
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import {
  activeGtfsServiceIds,
  canonicalPlanningJson,
  compileJourneyChains,
  gtfsServiceSeconds,
  parseGtfsCsv,
} from "../../packages/gtfs/dist/index.js";
import { compileServiceScope } from "./service-scope.mjs";

const [sourceDirectory, serviceDate, archiveSha256, outputPath] = process.argv.slice(2);
if (!sourceDirectory || !/^20[0-9]{6}$/.test(serviceDate ?? "") || !/^[a-f0-9]{64}$/.test(archiveSha256 ?? "") || !outputPath) {
  throw new Error("usage: node build-gtfs-region.mjs SOURCE_DIRECTORY YYYYMMDD ARCHIVE_SHA256 OUTPUT_JSON");
}

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
const gateways = new Map([
  ["Eisenach Hbf", "eisenach-hbf"],
  ["Nordhausen", "nordhausen"],
  ["Magdeburg Hbf", "magdeburg-hbf"],
  ["Lutherstadt Wittenberg Hbf", "lutherstadt-wittenberg-hbf"],
  ["Riesa", "riesa"],
  ["Chemnitz Hbf", "chemnitz-hbf"],
  ["Zwickau(Sachs)Hbf", "zwickau-hbf"],
  ["Saalfeld (Saale)", "saalfeld-saale"],
  ["Saalfeld(Saale)", "saalfeld-saale"],
]);
const gatewayLabels = new Map([
  ["eisenach-hbf", "Eisenach Hbf"],
  ["nordhausen", "Nordhausen"],
  ["magdeburg-hbf", "Magdeburg Hbf"],
  ["lutherstadt-wittenberg-hbf", "Lutherstadt Wittenberg Hbf"],
  ["riesa", "Riesa"],
  ["chemnitz-hbf", "Chemnitz Hbf"],
  ["zwickau-hbf", "Zwickau(Sachs)Hbf"],
  ["saalfeld-saale", "Saalfeld (Saale)"],
]);
const externalLegSpecification = JSON.parse(readFileSync(
  new URL("./specifications/external-leg-v1.json", import.meta.url),
  "utf8",
));
const serviceScopeSpecification = JSON.parse(readFileSync(
  new URL("./specifications/spnv-service-scope-2026.1.json", import.meta.url),
  "utf8",
));
const serviceScope = compileServiceScope(serviceScopeSpecification);

function table(name) {
  return parseGtfsCsv(readFileSync(`${sourceDirectory}/${name}`, "utf8"));
}

function inside(longitude, latitude) {
  let result = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const [cx, cy] = polygon[current];
    const [px, py] = polygon[previous];
    if ((cy > latitude) !== (py > latitude) && longitude < (px - cx) * (latitude - cy) / (py - cy) + cx) result = !result;
  }
  return result;
}

function boundary(stop, outsideStop) {
  const gatewayId = gateways.get(stop.stop_name);
  return gatewayId === undefined
    ? { kind: "first-outside", insideStopId: stop.stop_id, outsideStopId: outsideStop?.stop_id ?? null }
    : { kind: "named-gateway", gatewayId, insideStopId: stop.stop_id, outsideStopId: outsideStop?.stop_id ?? null };
}

const stops = table("stops.txt");
const routes = table("routes.txt");
const trips = table("trips.txt");
const stopTimes = table("stop_times.txt");
const calendar = table("calendar.txt");
const calendarDates = table("calendar_dates.txt");
const activeServices = activeGtfsServiceIds({ calendar, calendarDates }, serviceDate);
const stopsById = new Map(stops.map((stop) => [stop.stop_id, {
  ...stop,
  inRegion: inside(Number(stop.stop_lon), Number(stop.stop_lat)),
}]));
const routesById = new Map(routes.map((route) => [route.route_id, route]));
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

const stationIds = new Set();
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
  chainTrips.push({
    sourceTripId: tripId,
    serviceId: trip.service_id,
    routeId: trip.route_id,
    routeShortName: route?.route_short_name ?? "",
    headsign: trip.trip_headsign ?? "",
    directionId: trip.direction_id ?? "",
    stops: values.map((value) => {
      const selectedStop = stopsById.get(value.stop_id);
      if (selectedStop?.inRegion === true) stationIds.add(selectedStop.parent_station || selectedStop.stop_id);
      return {
        stopId: value.stop_id,
        stopName: selectedStop?.stop_name ?? value.stop_id,
        inRegion: selectedStop?.inRegion === true,
        stopSequence: Number(value.stop_sequence),
        arrivalS: gtfsServiceSeconds(value.arrival_time),
        departureS: gtfsServiceSeconds(value.departure_time),
      };
    }),
  });
}

const journeyChainCompilation = compileJourneyChains({
  worldId: "00000000-0000-4000-8000-000000000014",
  regionId: "mitteldeutschland-b",
  releaseId: `gtfs-de-rv-${serviceDate}-${archiveSha256.slice(0, 16)}`,
  specificationVersion: externalLegSpecification.version,
  boundaryWindowToleranceS: externalLegSpecification.boundaryWindowToleranceS,
  fixedExternalCostCentsPerMinute: externalLegSpecification.fixedExternalCostCentsPerMinute,
  portals: stops.flatMap((stop) => {
    const portalId = gateways.get(stop.stop_name);
    return portalId === undefined ? [] : [{ portalId, stopId: stop.stop_id, label: gatewayLabels.get(portalId) }];
  }),
  trips: chainTrips,
});
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
const boundaryPlanningWindows = journeyChains.flatMap((chain) => chain.legs
  .filter((leg) => leg.kind === "playable" && leg.planningWindows.length > 0)
  .map((leg) => ({
    id: `boundary-${leg.legId}`,
    playableLegId: leg.legId,
    originStationId: leg.stops[0].stopId,
    destinationStationId: leg.stops.at(-1).stopId,
    qualityClass: leg.qualityClass,
    orderable: leg.orderable,
    windows: leg.planningWindows,
  })));
const segments = journeyChains.flatMap((chain) => chain.legs
  .filter((leg) => leg.kind === "playable" && leg.stops.length >= 2)
  .map((leg) => {
    const legIndex = chain.legs.findIndex((candidate) => candidate.legId === leg.legId);
    const entersFromExternal = legIndex > 0 && chain.legs[legIndex - 1]?.kind === "external";
    const exitsToExternal = legIndex + 1 < chain.legs.length && chain.legs[legIndex + 1]?.kind === "external";
    return ({
    segmentId: leg.legId,
    journeyChainId: chain.journeyChainId,
    sourceTripId: chain.sourceTripId,
    serviceId: chain.serviceId,
    routeId: chain.routeId,
    routeShortName: chain.routeShortName,
    headsign: chain.headsign,
    directionId: chain.directionId,
    qualityClass: leg.qualityClass,
    orderable: leg.orderable,
    entry: leg.entryPortalId === null
      ? (entersFromExternal ? boundary(stopsById.get(leg.stops[0].stopId)) : null)
      : { kind: "named-gateway", gatewayId: leg.entryPortalId, insideStopId: leg.stops[0].stopId, outsideStopId: null },
    exit: leg.exitPortalId === null
      ? (exitsToExternal ? boundary(stopsById.get(leg.stops.at(-1).stopId)) : null)
      : { kind: "named-gateway", gatewayId: leg.exitPortalId, insideStopId: leg.stops.at(-1).stopId, outsideStopId: null },
    planningWindows: leg.planningWindows,
    stops: leg.stops,
    });
  }));
segments.sort((left, right) => left.segmentId.localeCompare(right.segmentId));
const unresolvedEntryCount = segments.filter((segment) => segment.entry?.kind === "first-outside").length;
const unresolvedExitCount = segments.filter((segment) => segment.exit?.kind === "first-outside").length;
const snapshot = {
  schema: "zugfolge-gtfs-region-snapshot/v2",
  regionId: "mitteldeutschland-b",
  regionVariant: "B",
  serviceDate,
  source: {
    sourceId: `gtfs-de-rv-free-${serviceDate}`,
    archive: basename(`${sourceDirectory}.zip`),
    archiveSha256,
    feedUrl: "https://download.gtfs.de/germany/rv_free/latest.zip",
    sourceLicense: "CC BY 4.0",
    attribution: "DELFI e.V.; GTFS.DE",
  },
  metrics: {
    activeServiceCount: activeServices.size,
    activeTripCount: activeTrips.length,
    eligibleActiveTripCount: tripsById.size,
    touchedTripCount: journeyChainCompilation.metrics.touchedTripCount,
    excludedTouchedTripCount: excludedTouchedTrips.length,
    playableSegmentCount: segments.length,
    externalLegCount: journeyChainCompilation.metrics.externalLegCount,
    orderableJourneyChainCount: journeyChainCompilation.metrics.orderableJourneyChainCount,
    unresolvedBoundaryCount: journeyChainCompilation.metrics.unresolvedBoundaryCount,
    parentStationCount: stationIds.size,
    unresolvedEntryCount,
    unresolvedExitCount,
  },
  externalLegSpecification,
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
