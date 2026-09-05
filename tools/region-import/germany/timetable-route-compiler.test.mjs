import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  gtfsJourneyChainId,
  gtfsPlayableLegId,
} from "../../../packages/gtfs/dist/index.js";
import {
  analyzeGermanyTimetableRoutes,
  compileGermanyTimetableRoutes,
  GERMANY_TIMETABLE_ROUTE_SPEC_SCHEMA,
  TIMETABLE_ROUTE_SELECTION_RULE,
  validatePinnedGtfsSnapshot,
} from "./timetable-route-compiler.mjs";
import {
  syntheticOperationalSha256,
  syntheticOperationalTimetableRoutesProof,
  validateSyntheticOperationalTimetableTransferDemands,
} from "./synthetic-operational-quality.mjs";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stop(stopId, stopSequence, time) {
  return { stopId, stopSequence, arrivalS: time, departureS: time };
}

function track(edgeId, fromNodeId, toNodeId, coordinates, lengthMm = 1_000_000, protectionTags = { "railway:pzb": "yes" }) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: {
      feature_id: edgeId,
      feature_type: "track",
      from_osm_node_id: fromNodeId,
      to_osm_node_id: toNodeId,
      length_mm: lengthMm,
      orderable: true,
      quality_class: "B",
      source_id: "osm-pbf-deutschland",
      model_state: "observed_osm_topology_enriched_official_route_segment",
      osm_tags_json: JSON.stringify(protectionTags),
    },
  };
}

function fixture({ disconnected = false, intermediate = false, sameStop = false } = {}) {
  const journeyWorldId = "00000000-0000-4000-8000-000000000315";
  const journeyRegionId = "test-region";
  const journeyReleaseId = "gtfs-test-release";
  const journeySourceTripId = "trip-1";
  const journeyChainId = gtfsJourneyChainId({
    regionId: journeyRegionId,
    releaseId: journeyReleaseId,
    sourceTripId: journeySourceTripId,
  });
  const playableLegId = gtfsPlayableLegId({ journeyChainId, sequence: 0 });
  const coordinates = disconnected
    ? [[13, 51], [13.001, 51], [13.1, 51], [13.101, 51]]
    : intermediate
      ? [[13, 51], [13.05, 51], [13.1, 51]]
      : [[13, 51], [13.1, 51]];
  const stations = (intermediate ? [coordinates[0], coordinates[1], coordinates[2]] : [coordinates[0], coordinates.at(-2) ?? coordinates[1]])
    .map(([longitude, latitude], index) => ({
      stopId: `S${index + 1}`,
      parentStationId: `P${index + 1}`,
      name: `Station ${index + 1}`,
      latitudeE7: Math.round(latitude * 10_000_000),
      longitudeE7: Math.round(longitude * 10_000_000),
      inRegion: true,
    }));
  if (!intermediate && !disconnected) stations[1] = {
    ...stations[1],
    latitudeE7: 510_000_000,
    longitudeE7: 131_000_000,
  };
  const stops = sameStop
    ? [stop(stations[0].stopId, 0, 0), stop(stations[0].stopId, 1, 60), stop(stations[1].stopId, 2, 300)]
    : stations.map((station, index) => stop(station.stopId, index, index * 300));
  const segment = {
    segmentId: playableLegId,
    journeyChainId,
    sourceTripId: journeySourceTripId,
    serviceId: "service-1",
    routeId: "route-1",
    routeShortName: "R1",
    headsign: "",
    directionId: "",
    qualityClass: "B",
    orderable: true,
    entry: { kind: "named-gateway", gatewayId: "g1", insideStopId: "S1", outsideStopId: null },
    exit: { kind: "named-gateway", gatewayId: "g2", insideStopId: stations.at(-1).stopId, outsideStopId: null },
    planningWindows: [],
    stops,
  };
  const snapshot = {
    schema: "zugfolge-gtfs-region-snapshot/v2",
    regionId: "test-region",
    regionVariant: "B",
    serviceDate: "20260812",
    source: {
      sourceId: "gtfs-test",
      archive: "gtfs-test.zip",
      archiveSha256: "a".repeat(64),
      feedUrl: "https://example.test/gtfs.zip",
      sourceLicense: "CC BY 4.0",
      attribution: "Test provider",
    },
    metrics: { playableSegmentCount: 1, externalLegCount: 0, orderableJourneyChainCount: 1 },
    externalLegSpecification: {},
    serviceScopeSpecification: {},
    serviceScopeReport: {},
    stations,
    journeyChains: [{
      schemaVersion: "zugfolge-gtfs-journey-chain/v2",
      journeyChainId,
      worldId: journeyWorldId,
      regionId: journeyRegionId,
      releaseId: journeyReleaseId,
      sourceTripId: journeySourceTripId,
      routeId: "route-1",
      routeShortName: "R1",
      orderable: true,
      legs: [{ kind: "playable", legId: playableLegId, sequence: 0, qualityClass: "B", orderable: true, planningWindows: [], stops }],
    }],
    boundaryPlanningWindows: [],
    segments: [segment],
  };
  const snapshotHash = sha256(canonicalJson(snapshot));
  const envelopeText = `${JSON.stringify({ snapshot, snapshotHash })}\n`;
  const tracks = disconnected
    ? [
      track("edge-west", 1, 2, coordinates.slice(0, 2), 100_000),
      track("edge-east", 3, 4, coordinates.slice(2), 100_000),
    ]
    : intermediate
      ? [
        track("edge-west", 1, 2, coordinates.slice(0, 2), 4_000_000),
        track("edge-east", 2, 3, coordinates.slice(1), 4_000_000),
      ]
      : [track("edge", 1, 2, coordinates, 8_000_000)];
  const corridor = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [coordinates[0], coordinates.at(-1)] },
    properties: { official_evidence_id: "official:test:1", route_number: 1 },
  };
  return { snapshot, snapshotHash, envelopeText, tracks, corridor };
}

async function materialize(root, options) {
  const value = fixture(options);
  await writeFile(join(root, "snapshot.json"), value.envelopeText);
  await writeFile(join(root, "tracks.geojsonseq"), `${value.tracks.map(JSON.stringify).join("\n")}\n`);
  await writeFile(join(root, "corridors.geojsonseq"), `${JSON.stringify(value.corridor)}\n`);
  const spec = {
    schema: GERMANY_TIMETABLE_ROUTE_SPEC_SCHEMA,
    infraReleaseId: "infra-test",
    tracks: "tracks.geojsonseq",
    corridors: "corridors.geojsonseq",
    gtfsSnapshot: {
      path: "snapshot.json",
      expectedBytes: Buffer.byteLength(value.envelopeText),
      expectedFileSha256: sha256(value.envelopeText),
      expectedSnapshotHash: value.snapshotHash,
      expectedSchema: "zugfolge-gtfs-region-snapshot/v2",
      expectedRegionId: "test-region",
      expectedRegionVariant: "B",
      expectedServiceDate: "20260812",
      expectedSourceId: "gtfs-test",
      expectedArchiveSha256: "a".repeat(64),
      expectedSourceLicense: "CC BY 4.0",
    },
    selection: {
      rule: TIMETABLE_ROUTE_SELECTION_RULE,
      qualityClass: "B",
      requireOrderable: true,
      minimumStopCount: 2,
      expectedSnapshotSegmentCount: 1,
      expectedEligibleSegmentCount: 1,
      permittedProtectionModes: ["pzb"],
    },
    dailyCirculation: {
      rule: "lot-local-playable-path-cover-with-explicit-physical-transition-partition/v2",
      repeatEveryS: 86_400,
      minimumTurnaroundS: 300,
      expectedLotCount: 1,
      expectedJourneyChainCount: 1,
      expectedCirculationCount: 1,
      expectedPlannedTransitionCount: 1,
      expectedTurnaroundDemandCount: 0,
      expectedTransferDemandCount: 1,
      expectedTransferLotCount: 1,
      formationLengthsMm: [100],
      unknownMainlineSpeedKmh: 20,
      unknownServiceSpeedKmh: 10,
    },
    output: "routes.jsonseq",
    transferOutput: "transfer-demands.json",
    report: "report.json",
  };
  return { ...value, spec };
}

async function materializeInternalPhysicalTransfer(root) {
  const base = await materialize(root, { intermediate: true });
  const snapshot = structuredClone(base.snapshot);
  const firstChain = snapshot.journeyChains[0];
  firstChain.legs[0].exitPortalId = "shared-chemnitz-location";
  const sourceTripId = "trip-2";
  const journeyChainId = gtfsJourneyChainId({
    regionId: snapshot.regionId,
    releaseId: firstChain.releaseId,
    sourceTripId,
  });
  const playableLegId = gtfsPlayableLegId({ journeyChainId, sequence: 0 });
  const secondStops = [
    stop("S2", 0, 3_000),
    stop("S1", 1, 3_300),
  ];
  snapshot.journeyChains.push({
    schemaVersion: "zugfolge-gtfs-journey-chain/v2",
    journeyChainId,
    worldId: firstChain.worldId,
    regionId: snapshot.regionId,
    releaseId: firstChain.releaseId,
    sourceTripId,
    routeId: firstChain.routeId,
    routeShortName: firstChain.routeShortName,
    orderable: true,
    legs: [{
      kind: "playable",
      legId: playableLegId,
      sequence: 0,
      qualityClass: "B",
      orderable: true,
      entryPortalId: "shared-chemnitz-location",
      exitPortalId: null,
      planningWindows: [],
      stops: secondStops,
    }],
  });
  snapshot.segments.push({
    segmentId: playableLegId,
    journeyChainId,
    sourceTripId,
    serviceId: "service-1",
    routeId: firstChain.routeId,
    routeShortName: firstChain.routeShortName,
    headsign: "",
    directionId: "",
    qualityClass: "B",
    orderable: true,
    entry: { kind: "named-gateway", gatewayId: "shared-chemnitz-location", insideStopId: "S2", outsideStopId: null },
    exit: { kind: "named-gateway", gatewayId: "g1", insideStopId: "S1", outsideStopId: null },
    planningWindows: [],
    stops: secondStops,
  });
  snapshot.metrics.playableSegmentCount = 2;
  snapshot.metrics.orderableJourneyChainCount = 2;
  const snapshotHash = sha256(canonicalJson(snapshot));
  const envelopeText = `${JSON.stringify({ snapshot, snapshotHash })}\n`;
  await writeFile(join(root, "snapshot.json"), envelopeText);
  return {
    snapshot,
    spec: {
      ...base.spec,
      gtfsSnapshot: {
        ...base.spec.gtfsSnapshot,
        expectedBytes: Buffer.byteLength(envelopeText),
        expectedFileSha256: sha256(envelopeText),
        expectedSnapshotHash: snapshotHash,
      },
      selection: {
        ...base.spec.selection,
        expectedSnapshotSegmentCount: 2,
        expectedEligibleSegmentCount: 2,
      },
      dailyCirculation: {
        ...base.spec.dailyCirculation,
        expectedJourneyChainCount: 2,
        expectedCirculationCount: 2,
        expectedPlannedTransitionCount: 2,
        expectedTurnaroundDemandCount: 1,
        expectedTransferDemandCount: 1,
      },
    },
  };
}

test("validiert den gepinnten Snapshot, seine Segmentmenge und seine GTFS-Querverweise", () => {
  const value = fixture();
  const binding = {
    expectedSnapshotHash: value.snapshotHash,
    expectedSchema: "zugfolge-gtfs-region-snapshot/v2",
    expectedRegionId: "test-region",
    expectedRegionVariant: "B",
    expectedServiceDate: "20260812",
    expectedSourceId: "gtfs-test",
    expectedArchiveSha256: "a".repeat(64),
    expectedSourceLicense: "CC BY 4.0",
  };
  const selection = { minimumStopCount: 2, expectedSnapshotSegmentCount: 1, expectedEligibleSegmentCount: 1, qualityClass: "B" };
  const validated = validatePinnedGtfsSnapshot(JSON.parse(value.envelopeText), binding, selection);
  assert.equal(validated.metrics.eligibleSegmentCount, 1);
  assert.equal(validated.metrics.uniqueDirectedStopPairCount, 1);
  assert.equal(validated.selectedSegments[0].segmentId, value.snapshot.segments[0].segmentId);

  const sameStop = fixture({ sameStop: true });
  const sameStopValidated = validatePinnedGtfsSnapshot(JSON.parse(sameStop.envelopeText), {
    ...binding,
    expectedSnapshotHash: sameStop.snapshotHash,
  }, selection);
  assert.equal(sameStopValidated.metrics.uniqueDirectedStopPairCount, 2);
  assert.equal(sameStopValidated.metrics.uniqueRoutableDirectedStopPairCount, 1);
  assert.equal(sameStopValidated.metrics.sameStopTransitionCount, 1);

  const changed = structuredClone(JSON.parse(value.envelopeText));
  changed.snapshot.segments[0].stops[1].stopId = "UNKNOWN";
  changed.snapshotHash = sha256(canonicalJson(changed.snapshot));
  assert.throws(() => validatePinnedGtfsSnapshot(changed, { ...binding, expectedSnapshotHash: changed.snapshotHash }, selection), /unbekannten Stop/u);
});

test("routet jede Zwischenstation deterministisch auf vorhandenen realen OSM-Kanten", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-gtfs-route-"));
  try {
    const { spec, snapshot } = await materialize(root, { intermediate: true });
    const report = await compileGermanyTimetableRoutes(spec, root);
    assert.equal(report.status, "qualified");
    assert.equal(report.metrics.eligibleSegmentCount, 1);
    assert.equal(report.metrics.completeRouteCount, 1);
    assert.equal(report.metrics.incompleteRouteCount, 0);
    assert.equal(report.metrics.routeRecordCount, 1);
    assert.equal(report.metrics.dailyCirculation.circulationCount, 1);
    assert.equal(report.metrics.transferRouteCount, 1);
    assert.equal(report.provenance.simulatedOperationalAssignment, true);
    assert.equal(report.provenance.realInterlockingFactsClaimed, false);
    assert.equal(report.provenance.operationalNetworkUsed, false);
    assert.equal(report.provenance.inventedGeometryUsed, false);
    const routes = (await readFile(join(root, "routes.jsonseq"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].routeVersionId, `route:gtfs:${snapshot.segments[0].segmentId}:v1`);
    assert.deepEqual(routes[0].legs.map((leg) => leg.edgeId), ["edge-west", "edge-east"]);
    assert.deepEqual(routes[0].legs.map((leg) => ({
      availableProtectionSystems: leg.availableProtectionSystems,
      simultaneouslyRequiredProtectionSystems: leg.simultaneouslyRequiredProtectionSystems,
    })), [
      { availableProtectionSystems: ["pzb"], simultaneouslyRequiredProtectionSystems: [] },
      { availableProtectionSystems: ["pzb"], simultaneouslyRequiredProtectionSystems: [] },
    ]);
    const transfers = JSON.parse(await readFile(join(root, "transfer-demands.json"), "utf8"));
    assert.equal(transfers.schema, "zugfolge-timetable-transfer-demands/v2");
    assert.equal(transfers.dailyPlan.schema, "zugfolge-daily-circulation-plan/v2");
    assert.equal(transfers.dailyPlan.metrics.plannedTransitionCount, 1);
    assert.equal(transfers.dailyPlan.metrics.turnaroundDemandCount, 0);
    assert.equal(transfers.dailyPlan.metrics.transferDemandCount, 1);
    assert.equal(transfers.transferRoutes.length, 1);
    assert.equal(transfers.transferRoutes[0].sourcePassengerRouteVersionId, routes[0].routeVersionId);
    assert.equal(transfers.transferRoutes[0].targetPassengerRouteVersionId, routes[0].routeVersionId);
    assert.deepEqual(transfers.transferRoutes[0].formationLengthsMm, [100]);
    assert.deepEqual(transfers.transferRoutes[0].legs.map((leg) => leg.edgeId), ["edge-east", "edge-west"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waehlt am Zwischenhalt einen weiterfahrbaren Anker statt der guenstigeren gerichteten Sackgasse", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-gtfs-continuing-anchor-"));
  try {
    const { spec } = await materialize(root, { intermediate: true });
    const tracks = [
      track("edge-dead-end", 1, 4, [[13, 51], [13.05, 51]], 1_000_000, { "railway:pzb": "yes", oneway: "yes" }),
      track("edge-west", 1, 2, [[13, 51], [13.05, 51.0001]], 4_000_000),
      track("edge-east", 2, 3, [[13.05, 51.0001], [13.1, 51]], 4_000_000),
    ];
    await writeFile(join(root, "tracks.geojsonseq"), `${tracks.map(JSON.stringify).join("\n")}\n`);
    const result = await analyzeGermanyTimetableRoutes(spec, root);
    assert.equal(result.report.status, "qualified");
    assert.equal(result.report.metrics.completeRouteCount, 1);
    assert.equal(result.report.metrics.routedStopPairCount, 2);
    assert.deepEqual(result.routes[0].legs.map((leg) => leg.edgeId), ["edge-west", "edge-east"]);
    assert.deepEqual(result.routes[0].legs.map((leg) => leg.direction), ["along", "along"]);
    assert.deepEqual((await analyzeGermanyTimetableRoutes(spec, root)).routes, result.routes);
    assert.deepEqual(result.transfers.transferRoutes[0].legs.map((leg) => leg.edgeId), ["edge-east", "edge-west"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trennt einen nicht fahrbaren internen Portalwechsel und routet ihn am Tagesrand als echten Transfer", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-gtfs-internal-transfer-"));
  try {
    const { spec, snapshot } = await materializeInternalPhysicalTransfer(root);
    const report = await compileGermanyTimetableRoutes(spec, root);
    assert.equal(report.status, "qualified");
    assert.deepEqual(report.metrics.dailyCirculation, {
      lotCount: 1,
      journeyChainCount: 2,
      circulationCount: 2,
      rolloverAssignmentCount: 2,
      plannedTransitionCount: 2,
      turnaroundDemandCount: 1,
      transferDemandCount: 1,
      transferLotCount: 1,
    });
    const sidecarBytes = await readFile(join(root, "transfer-demands.json"));
    const sidecar = JSON.parse(sidecarBytes.toString("utf8"));
    const internal = sidecar.dailyPlan.transferDemands[0];
    assert.equal(internal.dailyBoundary, true);
    assert.equal(internal.sourceLocationId, "shared-chemnitz-location");
    assert.equal(internal.targetLocationId, "shared-chemnitz-location");
    assert.equal(internal.sourcePhysicalStopId, "S3");
    assert.equal(internal.targetPhysicalStopId, "S2");
    assert.equal(sidecar.dailyPlan.turnaroundDemands[0].dailyBoundary, true);
    assert.equal(sidecar.transferRoutes.length, 1);
    assert.equal(sidecar.transferRoutes[0].id, internal.id);
    assert.equal(sidecar.transferRoutes[0].legs.length > 0, true);
    const timetableRoutesProof = await syntheticOperationalTimetableRoutesProof(join(root, "routes.jsonseq"));
    assert.equal(validateSyntheticOperationalTimetableTransferDemands({
      releaseId: "infra-test",
      transferDemands: sidecar,
      transferDemandsBinding: {
        file: "transfer-demands.json",
        bytes: sidecarBytes.length,
        sha256: sha256(sidecarBytes),
        role: "timetable-transfer-demands",
        records: sidecar.transferRoutes.length,
      },
      routeReport: { gtfsBinding: { snapshotHash: sidecar.gtfsSnapshotHash } },
      timetableRoutesProof,
      gtfsSnapshot: snapshot,
    }).dailyCirculation.plannedTransitionCount, 2);
    const unknown = structuredClone(sidecar);
    unknown.dailyPlan.turnaroundDemands[0].unknown = true;
    const unknownPlanBody = structuredClone(unknown.dailyPlan);
    delete unknownPlanBody.planSha256;
    unknown.dailyPlan.planSha256 = syntheticOperationalSha256({
      schema: "zugfolge-daily-circulation-plan/v2",
      value: unknownPlanBody,
    });
    assert.throws(() => validateSyntheticOperationalTimetableTransferDemands({
      releaseId: "infra-test",
      transferDemands: unknown,
      transferDemandsBinding: {
        file: "transfer-demands.json",
        bytes: sidecarBytes.length,
        sha256: sha256(sidecarBytes),
        role: "timetable-transfer-demands",
        records: unknown.transferRoutes.length,
      },
      routeReport: { gtfsBinding: { snapshotHash: unknown.gtfsSnapshotHash } },
      timetableRoutesProof,
      gtfsSnapshot: snapshot,
    }), /unerwartete oder fehlende Felder/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waehlt fuer PZB-Fahrten den kompatiblen PZB-ETCS-Laufweg statt der kuerzeren reinen ETCS-Kante", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-gtfs-route-protection-"));
  try {
    const { spec, snapshot } = await materialize(root);
    const [origin, destination] = snapshot.stations.map((station) => [
      station.longitudeE7 / 10_000_000,
      station.latitudeE7 / 10_000_000,
    ]);
    const middle = [(origin[0] + destination[0]) / 2, origin[1] + 0.01];
    const tracks = [
      track("edge-etcs-short", 1, 2, [origin, destination], 8_000_000, { "railway:etcs": "2" }),
      track("edge-pzb-west", 1, 3, [origin, middle], 6_000_000, { "railway:etcs": "2", "railway:pzb": "yes" }),
      track("edge-pzb-east", 3, 2, [middle, destination], 6_000_000, { "railway:etcs": "2", "railway:pzb": "yes" }),
    ];
    await writeFile(join(root, "tracks.geojsonseq"), `${tracks.map(JSON.stringify).join("\n")}\n`);

    const report = await compileGermanyTimetableRoutes(spec, root);
    assert.equal(report.status, "qualified");
    assert.deepEqual(report.sourceMetrics.gtfsTrackGraph.permittedProtectionModes, ["pzb"]);
    assert.equal(report.sourceMetrics.gtfsTrackGraph.incompatibleProtectionTrackCount, 1);
    const routes = (await readFile(join(root, "routes.jsonseq"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(routes[0].legs.map((leg) => leg.edgeId), ["edge-pzb-west", "edge-pzb-east"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blockiert eine reine ETCS-Verbindung ohne PZB-kompatible Alternative", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-gtfs-route-protection-blocked-"));
  try {
    const { spec, tracks } = await materialize(root, { disconnected: true });
    const connector = track(
      "edge-etcs-connector",
      2,
      3,
      [tracks[0].geometry.coordinates.at(-1), tracks[1].geometry.coordinates[0]],
      8_000_000,
      { "railway:etcs": "2" },
    );
    await writeFile(join(root, "tracks.geojsonseq"), `${[...tracks, connector].map(JSON.stringify).join("\n")}\n`);

    const report = await compileGermanyTimetableRoutes(spec, root);
    assert.equal(report.status, "blocked");
    assert.equal(report.routesProduced, false);
    assert.equal(report.sourceMetrics.gtfsTrackGraph.incompatibleProtectionTrackCount, 1);
    assert.equal(report.findings["segment-stops-share-no-real-track-component"].count, 1);
    await assert.rejects(access(join(root, "routes.jsonseq")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schreibt bei getrennten realen Gleiskomponenten nur einen blocked-Bericht und keinen Route-Layer", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-gtfs-route-blocked-"));
  try {
    const { spec } = await materialize(root, { disconnected: true });
    const report = await compileGermanyTimetableRoutes(spec, root);
    assert.equal(report.status, "blocked");
    assert.equal(report.routesProduced, false);
    assert.equal(report.metrics.completeRouteCount, 0);
    assert.equal(report.metrics.incompleteRouteCount, 1);
    assert.equal(report.routeSetSha256, null);
    assert.equal(report.findings["segment-stops-share-no-real-track-component"].count, 1);
    await assert.rejects(access(join(root, "routes.jsonseq")), /ENOENT/u);
    assert.equal(JSON.parse(await readFile(join(root, "report.json"), "utf8")).status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("weist unbekannte Compilerfelder und einen falschen gepinnten Datei-Hash fail-closed zurueck", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-gtfs-route-hash-"));
  try {
    const { spec } = await materialize(root);
    await assert.rejects(analyzeGermanyTimetableRoutes({ ...spec, operationalNetwork: "forbidden.json" }, root), /unbekannte oder fehlende Felder/u);
    await assert.rejects(analyzeGermanyTimetableRoutes({
      ...spec,
      gtfsSnapshot: { ...spec.gtfsSnapshot, expectedFileSha256: "0".repeat(64) },
    }, root), /Datei-SHA-256/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
