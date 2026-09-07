import assert from "node:assert/strict";

export const NETWORK_SCENARIO = "conductor-network-acceptance/v1";
const clone = (value) => structuredClone(value);

/** Ausschließlich fiktive Quelldaten vor allen Releasepins; keine Istfakten. */
export function prepareConductorNetworkSource(source, inventory, authority) {
  assert.equal(source.testOnly, true);
  const infrastructure = source.infrastructure, leader = source.materialization;
  assert.equal(leader.stopPlan.stops.at(-1).scheduledArrivalMs, 3_000_000,
    "Der explizite Netzkorpus benötigt den vor Pins festgelegten 3.000.000-ms-Endhalt des Abnahmevertrags.");
  const route = infrastructure.routeVersions[leader.routeVersionId];
  assert.equal(route.legs.at(-1).routeStartMm + Math.abs(route.legs.at(-1).edgeExitMm - route.legs.at(-1).edgeEntryMm), 1_200_000);
  const formation = (vehicleId) => {
    const matches = inventory.formations.filter((row) => row.vehicleIds.length === 1 && row.vehicleIds[0] === vehicleId);
    assert.equal(matches.length, 1); return matches[0];
  };
  const followFormation = formation("fixture-interior-vehicle-3"), crossFormation = formation("fixture-interior-vehicle-2");
  const follower = clone(leader);
  follower.id = "regional-follow"; follower.trainNumber = "RB 2"; follower.formationVersionId = followFormation.id;
  follower.scheduledDepartureMs = 1_940_000;
  for (const stop of follower.stopPlan.stops) {
    stop.stopId = `follow:${stop.stopId}`;
    stop.scheduledArrivalMs += 1_340_000; stop.scheduledDepartureMs += 1_340_000;
  }

  const crossEdge = "test-network:cross-edge", yardEdge = "test-network:yard-edge";
  const crossRouteId = "test-network:cross-route", yardRouteId = "test-network:yard-route";
  const prototype = route.legs[0];
  const crossResources = ["test-network:cross-origin", "block:stop:2", "test-network:yard"];
  infrastructure.directedEdges[crossEdge] = 200_000; infrastructure.directedEdges[yardEdge] = 100_000;
  // Die orthogonale Prüfstrecke kreuzt die fiktive Hauptstrecke am Mittelhalt.
  infrastructure.edgeGeometries[crossEdge] = [
    { edgeOffsetMm: 0, latitudeE7: 509_990_000, longitudeE7: 120_040_000, bearingMilliDegrees: 0 },
    { edgeOffsetMm: 100_000, latitudeE7: 510_000_000, longitudeE7: 120_040_000, bearingMilliDegrees: 0 },
    { edgeOffsetMm: 200_000, latitudeE7: 510_010_000, longitudeE7: 120_040_000, bearingMilliDegrees: null },
  ];
  infrastructure.edgeGeometries[yardEdge] = [
    { edgeOffsetMm: 0, latitudeE7: 510_010_000, longitudeE7: 120_040_000, bearingMilliDegrees: 0 },
    { edgeOffsetMm: 100_000, latitudeE7: 510_020_000, longitudeE7: 120_040_000, bearingMilliDegrees: null },
  ];
  const leg = (edgeId, from, to, start, resource) => ({ ...clone(prototype), edgeId, direction: "along",
    edgeEntryMm: from, edgeExitMm: to, routeStartMm: start, blockIds: [resource], gradientPerMille: 0 });
  const crossLegs = [leg(crossEdge, 0, 70_000, 0, crossResources[0]), leg(crossEdge, 70_000, 100_000, 70_000, crossResources[0]),
    leg(crossEdge, 100_000, 200_000, 100_000, crossResources[1])];
  infrastructure.routeVersions[crossRouteId] = { id: crossRouteId, templateId: "test-network:cross-template", predecessorId: null, transitionRouteMm: null, legs: crossLegs };
  infrastructure.routeVersions[yardRouteId] = { id: yardRouteId, templateId: "test-network:yard-template", predecessorId: crossRouteId, transitionRouteMm: 200_000,
    legs: [...clone(crossLegs), leg(yardEdge, 0, 100_000, 200_000, crossResources[2])] };
  const lock = (id, templateId, start, end, resource, movementKind) => {
    const signalId = `${id}:signal`, overlap = `${id}:overlap`, flank = `${id}:flank`;
    infrastructure.interlockingRoutes[id] = { id, routeTemplateId: templateId, authorityStartRouteMm: start,
      signalId, movementKind, pathResources: [resource], overlapResources: [overlap], flankResources: [flank], switchPositions: {},
      authorityEndRouteMm: end, releaseAfterTailRouteMm: end };
    infrastructure.signals.push(signalId);
    infrastructure.blockResources.push(overlap, flank);
  };
  infrastructure.blockResources = [...new Set([...infrastructure.blockResources, ...crossResources])].sort();
  lock("test-network:cross-staging", "test-network:cross-template", 0, 70_000, crossResources[0], "train");
  lock("test-network:cross-entry", "test-network:cross-template", 70_000, 100_000, crossResources[0], "train");
  lock("test-network:cross-pass", "test-network:cross-template", 100_000, 200_000, crossResources[1], "train");
  lock("test-network:yard-entry", "test-network:yard-template", 200_000, 300_000, crossResources[2], "shunting");
  infrastructure.signals.sort();
  infrastructure.blockResources.sort();
  const movement = (id, trainNumber, routeVersionId, headRouteMm, movementKind, dispatchInterlockingRouteId) => {
    const train = { ...clone(leader), id, trainNumber, routeVersionId, headRouteMm, movementKind,
      formationVersionId: crossFormation.id, publicPassengerStop: false, stopPlan: null,
      scheduledDepartureMs: 1_940_000, dispatchInterlockingRouteId,
      protectionModeSelectionRuns: [{ throughRouteLegIndex: infrastructure.routeVersions[routeVersionId].legs.length - 1, selectedProtectionSystem: "pzb" }] };
    return train;
  };
  const crossing = movement("network-empty", "L 3", crossRouteId, 70_000, "train", "test-network:cross-entry");
  const shunting = movement("network-shunt", "R 4", yardRouteId, 200_000, "shunting", "test-network:yard-entry");
  const asset = authority.assets.find((row) => row.id === followFormation.vehicleIds[0]); assert.ok(asset?.vehicleConfiguration);
  const configuration = asset.vehicleConfiguration.interior;
  const followerCapacity = { standardSeats: configuration.secondClassSeats, standardStanding: configuration.multipurpose.standing,
    premiumSeats: configuration.firstClassSeats, wheelchairSpaces: configuration.multipurpose.wheelchairs,
    bicycleSpaces: configuration.multipurpose.bicycles, strollerSpaces: configuration.multipurpose.pushchairs };
  const onward = clone(source.demand.services[0]);
  onward.trainRunId = "network-onward";
  onward.stops = [
    { stopId: "network-transfer", stationId: leader.stopPlan.stops.at(-1).stationId, arrivalMs: 3_120_000, departureMs: 3_120_000, passengerStop: true },
    { stopId: "network-destination", stationId: "test-network:destination", arrivalMs: 3_720_000, departureMs: 3_720_000, passengerStop: true },
  ];
  const later = clone(onward); later.trainRunId = "network-later";
  for (const stop of later.stops) { stop.stopId = `later:${stop.stopId}`; stop.arrivalMs += 3_000_000; stop.departureMs += 3_000_000; }
  source.demand.release.zones.push({ id: "test-network:destination-zone", population: 0, workplaces: 20, poiWeight: 0,
    stations: [{ stationId: "test-network:destination", accessMs: 0, serviceIntervalMs: 0, stepFree: true }] });
  return { schemaVersion: NETWORK_SCENARIO, testOnly: true, follower, crossing, shunting, followerCapacity, forecastServices: [onward, later],
    evidence: { actualCompilerVehicleIds: ["fixture-interior-vehicle-1", ...followFormation.vehicleIds, ...crossFormation.vehicleIds],
      crossingResourceId: "block:stop:2", followingTrainId: follower.id, crossingTrainId: crossing.id, shuntingTrainId: shunting.id,
      forecastOnlyTrainIds: [onward.trainRunId, later.trainRunId], productiveWorldActivation: false } };
}
