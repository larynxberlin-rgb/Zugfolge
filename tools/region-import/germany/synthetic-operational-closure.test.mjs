import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  gtfsJourneyChainId,
  gtfsPlayableLegId,
} from "../../../packages/gtfs/dist/index.js";
import { writeAnnualSyntheticOperationalClosure } from "./synthetic-operational-closure.mjs";
import {
  canonicalSyntheticOperationalValue,
  syntheticOperationalFileProof,
  syntheticOperationalSha256,
} from "./synthetic-operational-quality.mjs";

const checkedPolicy = JSON.parse(await readFile(new URL("./synthetic-operational-b.policy.json", import.meta.url), "utf8"));
const historicalPolicy = JSON.parse(await readFile(new URL("./synthetic-operational-b.2026.4.policy.json", import.meta.url), "utf8"));
const annualClosureInputs = JSON.parse(await readFile(new URL("./synthetic-operational-closure.annual-2026.4.json", import.meta.url), "utf8"));
const annualOperationalSpecification = JSON.parse(await readFile(new URL("./operational-infrastructure.annual-2026.4.json", import.meta.url), "utf8"));
const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./run-synthetic-operational-closure.mjs", import.meta.url));
const roleLayers = Object.freeze([
  ["blocks", "blocks"],
  ["conflict-resources", "conflictResources"],
  ["platforms", "platforms"],
  ["signals", "signals"],
  ["switches", "switches"],
  ["timetable-routes", "timetableRoutes"],
  ["timetable-transfer-demands", "transferDemands"],
  ["tracks", "tracks"],
]);
const requiredRoles = Object.freeze(["blocks", "conflict-resources", "gtfs-snapshot", "platforms", "signals", "switches", "timetable-route-report", "timetable-routes", "timetable-transfer-demands", "tracks"]);

test("der forensische 2026.4-Vertrag bleibt unveraendert und wird nicht als aktueller Transition-v2-Beleg verwendet", () => {
  assert.equal(annualClosureInputs.schema, "zugfolge-synthetic-operational-closure-inputs/v2");
  assert.equal(annualClosureInputs.releaseId, annualOperationalSpecification.infraReleaseId);
  assert.equal(annualClosureInputs.annualSpecificationFile, "tools/region-import/germany/operational-infrastructure.annual-2026.4.json");
  assert.equal(annualOperationalSpecification.layers.timetableRoutes, "var/derived/germany-2026.4/timetable-routes-v2.jsonseq");
  assert.equal(annualClosureInputs.timetableRouteReportFile, "timetable-routes-v2.derivation-report.json");
  assert.equal(Object.hasOwn(annualClosureInputs, "timetableTransferDemandsFile"), false);
  assert.equal(annualClosureInputs.gtfsSnapshotFile, "gtfs-region-20260810-v2.json");
  assert.equal(historicalPolicy.requiredInputRoles.includes("timetable-transfer-demands"), false);
  assert.deepEqual(checkedPolicy.requiredInputRoles, requiredRoles);
  assert.equal(checkedPolicy.id, "synthetic-operational-b/v2");
  assert.equal(checkedPolicy.schema, "zugfolge-synthetic-operational-policy/v2");
  assert.notDeepEqual(checkedPolicy.compilerPolicy, annualOperationalSpecification.policy);
  assert.equal(checkedPolicy.rules.some(({ id }) => id === "daily-physical-circulation-and-transfer-coverage/v2"), true);
  assert.match(checkedPolicy.rules.find(({ id }) => id === "free-gtfs-route-provenance/v2").effect, /v4 derivation report/u);
  assert.equal(Object.hasOwn(annualClosureInputs, "coverage"), false);
  assert.equal(Object.hasOwn(annualClosureInputs, "nativeValidation"), false);
  assert.equal(JSON.stringify(annualClosureInputs).includes("sha256"), false);
});

test("Jahres-CLI verlangt exakt INPUTS und create-new OUTPUT", async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [cli]),
    (error) => error?.stderr?.includes("run-synthetic-operational-closure.mjs INPUTS.json OUTPUT.json"),
  );
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-synthetic-closure-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, "var", "derived", "test");
  const toolsRoot = join(root, "tools", "region-import", "germany");
  await Promise.all([mkdir(artifactRoot, { recursive: true }), mkdir(toolsRoot, { recursive: true })]);
  const policyPath = join(toolsRoot, "policy.json");
  await writeFile(policyPath, `${JSON.stringify(checkedPolicy, null, 2)}\n`, "utf8");
  const journeyWorldId = "00000000-0000-4000-8000-000000000315";
  const journeyRegionId = "test-region";
  const journeyReleaseId = "gtfs-test-release";
  const journeySourceTripId = "trip-test";
  const journeyChainId = gtfsJourneyChainId({ regionId: journeyRegionId, releaseId: journeyReleaseId, sourceTripId: journeySourceTripId });
  const segmentIds = Array.from({ length: 3 }, (_, sequence) => gtfsPlayableLegId({ journeyChainId, sequence }));

  const layers = {};
  const records = { blocks: 2, conflictResources: 3, platforms: 2, signals: 4, switches: 2, timetableRoutes: 3, transferDemands: 1, tracks: 2 };
  for (const [, layer] of roleLayers.filter(([, layer]) => layer !== "transferDemands")) {
    const relative = `var/derived/test/${layer}.jsonseq`;
    layers[layer] = relative;
    if (layer !== "timetableRoutes") await writeFile(join(root, relative), Array.from({ length: records[layer] }, (_, index) => `${layer}-${index}\n`).join(""), "utf8");
  }
  const route = (segmentId, legs) => ({
    routeVersionId: `route:gtfs:${segmentId}:v1`,
    templateId: `template:gtfs:${segmentId}:v1`,
    predecessorId: null,
    transitionRouteMm: null,
    legs,
  });
  const routes = [
    route(segmentIds[0], [{ edgeId: "track-a", direction: "forward", edgeEntryMm: 0, edgeExitMm: 1000 }]),
    route(segmentIds[1], [{ edgeId: "track-b", direction: "forward", edgeEntryMm: 0, edgeExitMm: 1000 }]),
    route(segmentIds[2], []),
  ].sort((left, right) => left.routeVersionId.localeCompare(right.routeVersionId));
  await writeFile(join(root, layers.timetableRoutes), routes.map((value) => `${canonicalSyntheticOperationalValue(value)}\n`).join(""), "utf8");
  const annualSpecification = {
    schema: "zugfolge-germany-operational-infrastructure-derivation/v2",
    mode: "deterministic-conservative-v1",
    infraReleaseId: "infra-deutschland-test.1",
    layers,
    policy: structuredClone(checkedPolicy.compilerPolicy),
  };
  const annualPath = join(toolsRoot, "annual.json");

  const candidatePath = join(artifactRoot, "operational-infrastructure-v2.candidate.json");
  const artifactPath = join(artifactRoot, "operational-infrastructure-v2.json");
  const candidateBytes = `${JSON.stringify({ schema: "operational-infrastructure-v2", id: annualSpecification.infraReleaseId })}\n`;
  await Promise.all([writeFile(candidatePath, candidateBytes), writeFile(artifactPath, candidateBytes)]);
  const candidateProof = await syntheticOperationalFileProof(candidatePath);
  const stateHash = candidateProof.sha256 === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);

  const inputEvidence = {};
  for (const [, layer] of roleLayers.filter(([, layer]) => layer !== "transferDemands")) {
    inputEvidence[layer] = {
      path: layers[layer],
      ...await syntheticOperationalFileProof(join(root, layers[layer])),
      records: records[layer],
    };
  }
  const stop = (stopId, stopSequence, arrivalS, departureS) => ({ stopId, stopSequence, arrivalS, departureS });
  const segmentStops = [
    [stop("stop-a", 0, 0, 0), stop("stop-b", 1, 60, 60)],
    [stop("stop-b", 0, 120, 120), stop("stop-c", 1, 180, 180)],
    [stop("stop-c", 0, 240, 240), stop("stop-c", 1, 300, 300)],
  ];
  const segments = segmentStops.map((stops, sequence) => ({
    segmentId: segmentIds[sequence],
    journeyChainId,
    sourceTripId: journeySourceTripId,
    serviceId: "service-1",
    routeId: "route-1",
    routeShortName: "R1",
    headsign: "Test",
    directionId: "0",
    qualityClass: "B",
    orderable: true,
    entry: { kind: "inside" },
    exit: { kind: "inside" },
    planningWindows: [],
    stops,
  }));
  const snapshot = {
    schema: "zugfolge-gtfs-region-snapshot/v2",
    regionId: "test-region",
    regionVariant: "B",
    serviceDate: "20260812",
    source: {
      sourceId: "gtfs-test-free",
      archive: "gtfs-test-free.zip",
      archiveSha256: "c".repeat(64),
      feedUrl: "https://example.invalid/free-gtfs.zip",
      sourceLicense: "CC BY 4.0",
      attribution: "Test transport authority",
    },
    metrics: { playableSegmentCount: 3, externalLegCount: 0, orderableJourneyChainCount: 1 },
    externalLegSpecification: {},
    serviceScopeSpecification: {},
    serviceScopeReport: {},
    stations: ["a", "b", "c"].map((id, index) => ({ stopId: `stop-${id}`, parentStationId: `parent-${id}`, name: `Stop ${id}`, latitudeE7: 510000000 + index, longitudeE7: 120000000 + index, inRegion: true })),
    journeyChains: [{
      schemaVersion: "zugfolge-gtfs-journey-chain/v2",
      journeyChainId,
      worldId: journeyWorldId,
      regionId: journeyRegionId,
      releaseId: journeyReleaseId,
      sourceTripId: journeySourceTripId,
      orderable: true,
      legs: segments.map((segment, index) => ({ legId: segment.segmentId, sequence: index, kind: "playable", orderable: true, qualityClass: "B", planningWindows: [], stops: structuredClone(segment.stops) })),
    }],
    boundaryPlanningWindows: [],
    segments,
  };
  const snapshotHash = syntheticOperationalSha256(snapshot);
  const gtfsSnapshotPath = join(artifactRoot, "gtfs-region-test-v2.json");
  await writeFile(gtfsSnapshotPath, `${JSON.stringify({ snapshot, snapshotHash }, null, 2)}\n`, "utf8");
  const gtfsSnapshotProof = await syntheticOperationalFileProof(gtfsSnapshotPath);
  const routeSetSha256 = (await syntheticOperationalFileProof(join(root, layers.timetableRoutes))).sha256;
  const circulationId = "circulation-lot-test-001";
  const lotId = "lot-test";
  const transferId = `transfer-${"1".repeat(64)}`;
  const formationLengthsMm = [...checkedPolicy.compilerPolicy.terminalFormationLengthsMm];
  const circulation = {
    id: circulationId,
    lotId,
    serviceLineId: "line-test",
    assetCompatibilityKey: lotId,
    journeyChainIds: [journeyChainId],
    passengerLegIds: segmentIds,
    passengerTrainRunIds: segmentIds.map((segmentId, index) => index === 0 ? journeyChainId : `${journeyChainId}:${segmentId}`),
    start: { legId: segmentIds[0], passengerRouteVersionId: `route:gtfs:${segmentIds[0]}:v1`, locationId: "stop-a", physicalStopId: "stop-a", timeS: 0 },
    end: { legId: segmentIds[2], passengerRouteVersionId: `route:gtfs:${segmentIds[2]}:v1`, locationId: "stop-c", physicalStopId: "stop-c", timeS: 300 },
  };
  const transferDemand = {
    id: transferId,
    lotId,
    assetCompatibilityKey: lotId,
    sourceCirculationId: circulationId,
    targetCirculationId: circulationId,
    sourcePassengerLegId: segmentIds[2],
    targetPassengerLegId: segmentIds[0],
    sourcePassengerRouteVersionId: `route:gtfs:${segmentIds[2]}:v1`,
    targetPassengerRouteVersionId: `route:gtfs:${segmentIds[0]}:v1`,
    sourceLocationId: "stop-c",
    targetLocationId: "stop-a",
    sourcePhysicalStopId: "stop-c",
    targetPhysicalStopId: "stop-a",
    earliestDepartureS: 600,
    latestArrivalS: 86_100,
    availableWindowS: 85_500,
    dailyBoundary: true,
    movementKind: "train",
  };
  const dailyPlanBody = {
    schema: "zugfolge-daily-circulation-plan/v2",
    rule: "lot-local-playable-path-cover-with-explicit-physical-transition-partition/v2",
    gtfsReleaseId: journeyReleaseId,
    repeatEveryS: 86_400,
    minimumTurnaroundS: 300,
    metrics: { lotCount: 1, journeyChainCount: 1, circulationCount: 1, rolloverAssignmentCount: 1, plannedTransitionCount: 1, turnaroundDemandCount: 0, transferDemandCount: 1, transferLotCount: 1 },
    circulations: [circulation],
    rolloverAssignments: [{ sourceCirculationId: circulationId, targetCirculationId: circulationId, kind: "transfer" }],
    turnaroundDemands: [],
    transferDemands: [transferDemand],
  };
  const dailyPlan = {
    ...dailyPlanBody,
    planSha256: syntheticOperationalSha256({ schema: "zugfolge-daily-circulation-plan/v2", value: dailyPlanBody }),
  };
  const transferRoute = {
    ...transferDemand,
    formationLengthsMm,
    routeVersionId: `route:${transferId}:movement:v1`,
    templateId: `template:${transferId}:movement:v1`,
    legs: [{
      edgeId: "track-transfer",
      direction: "along",
      edgeEntryMm: 0,
      edgeExitMm: 1_000,
      availableProtectionSystems: ["pzb"],
      simultaneouslyRequiredProtectionSystems: [],
    }],
    totalLengthMm: 1_000,
    weightedCostMm: 1_000,
    minimumRuntimeMs: 1_000,
  };
  const transferSetSha256 = createHash("sha256").update(`${canonicalSyntheticOperationalValue(transferRoute)}\n`).digest("hex");
  const timetableTransferDemands = {
    schema: "zugfolge-timetable-transfer-demands/v2",
    infraReleaseId: annualSpecification.infraReleaseId,
    gtfsSnapshotHash: snapshotHash,
    dailyPlan,
    formationLengthsMm,
    transferRoutes: [transferRoute],
    transferSetSha256,
  };
  const timetableTransferDemandsPath = join(artifactRoot, "timetable-routes-v2.transfer-demands-v2.json");
  await writeFile(timetableTransferDemandsPath, `${canonicalSyntheticOperationalValue(timetableTransferDemands)}\n`, "utf8");
  const timetableTransferDemandsProof = await syntheticOperationalFileProof(timetableTransferDemandsPath);
  const movementRouteTemplatesBody = {
    schema: "movement-route-templates-v2",
    infraReleaseId: annualSpecification.infraReleaseId,
    operationalStateHash: stateHash,
    timetableTransferSetSha256: transferSetSha256,
    directTemplates: [],
    templates: [],
    transferTemplates: [],
    metrics: {
      directTemplateCount: 0,
      stablingTemplateCount: 0,
      transferTemplateCount: 0,
      transferDemandCount: 1,
      turnaroundDemandCount: 0,
      plannedTransitionCount: 1,
      turnaroundPairCount: 0,
      observedStablingTemplateCount: 0,
      simulatedOperationalStablingTemplateCount: 0,
      berthAssignmentCounts: { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 },
      crossBerthTemplateCount: 0,
    },
  };
  const movementRouteTemplatesStateHash = syntheticOperationalSha256(movementRouteTemplatesBody);
  const movementRouteTemplatesFile = "operational-infrastructure-v2.candidate.movement-route-templates-v2.json";
  const movementRouteTemplatesPath = join(artifactRoot, movementRouteTemplatesFile);
  await writeFile(movementRouteTemplatesPath, `${canonicalSyntheticOperationalValue({ ...movementRouteTemplatesBody, stateHash: movementRouteTemplatesStateHash })}\n`, "utf8");
  const movementRouteTemplatesProof = await syntheticOperationalFileProof(movementRouteTemplatesPath);
  const movementRouteTemplates = {
    file: movementRouteTemplatesFile,
    ...movementRouteTemplatesProof,
    stateHash: movementRouteTemplatesStateHash,
    operationalStateHash: stateHash,
    timetableTransferSetSha256: transferSetSha256,
    berthAssignmentCounts: { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 },
    crossBerthTemplateCount: 0,
  };
  layers.transferDemands = {
    path: "var/derived/test/timetable-routes-v2.transfer-demands-v2.json",
    expectedBytes: timetableTransferDemandsProof.bytes,
    expectedSha256: timetableTransferDemandsProof.sha256,
  };
  inputEvidence.transferDemands = {
    path: layers.transferDemands.path,
    ...timetableTransferDemandsProof,
    records: 1,
  };
  await writeFile(annualPath, `${JSON.stringify(annualSpecification, null, 2)}\n`, "utf8");
  const annualProof = await syntheticOperationalFileProof(annualPath);
  const gtfsSnapshotMetrics = {
    stationCount: 3,
    journeyChainCount: 1,
    playableLegCount: 3,
    oneStopPlayableLegCount: 0,
    externalLegCount: 0,
    snapshotSegmentCount: 3,
    eligibleSegmentCount: 3,
    excludedQualityCCount: 0,
    uniqueDirectedStopPairCount: 3,
    uniqueRoutableDirectedStopPairCount: 2,
    sameStopTransitionCount: 1,
  };
  const timetableRouteReport = {
    schema: "zugfolge-germany-timetable-route-report/v4",
    infraReleaseId: annualSpecification.infraReleaseId,
    status: "qualified",
    routesProduced: true,
    derivationRule: "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
    selectionRule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
    policyId: "synthetic-operational-b/v2",
    gtfsBinding: {
      schema: snapshot.schema,
      regionId: snapshot.regionId,
      regionVariant: snapshot.regionVariant,
      serviceDate: snapshot.serviceDate,
      sourceId: snapshot.source.sourceId,
      archive: snapshot.source.archive,
      archiveSha256: snapshot.source.archiveSha256,
      sourceLicense: "CC-BY-4.0",
      sourceLicenseAsPublished: snapshot.source.sourceLicense,
      attribution: snapshot.source.attribution,
      snapshotHash,
    },
    metrics: {
      ...gtfsSnapshotMetrics,
      completeRouteCount: 3,
      incompleteRouteCount: 0,
      routeRecordCount: 3,
      routedStopPairCount: 2,
      reusedStopPairRouteCount: 0,
      uniqueRouterQueryCount: 2,
      routeLegCount: 2,
      totalRouteLengthMm: 2000,
      maximumAnchorDistanceMm: 0,
      zeroMovementStopTransitionCount: 1,
      dailyCirculation: structuredClone(dailyPlan.metrics),
      transferRouteCount: 1,
      transferRouteLegCount: 1,
      transferRouteLengthMm: 1_000,
      retainedRoutingTrackCount: 2,
    },
    sourceProofs: {
      tracks: { bytes: inputEvidence.tracks.bytes, sha256: inputEvidence.tracks.sha256 },
      corridors: { bytes: 1, sha256: "d".repeat(64) },
      gtfsSnapshot: gtfsSnapshotProof,
    },
    sourceMetrics: { gtfsSnapshot: gtfsSnapshotMetrics, gtfsTrackGraph: { retainedRoutingTrackCount: 2 } },
    provenance: {
      realGeometry: true,
      simulatedOperationalAssignment: true,
      realInterlockingFactsClaimed: false,
      operationalNetworkUsed: false,
      gtfsShapeGeometryUsed: false,
      inventedGeometryUsed: false,
      everyIntermediateStopUsedAsTrackAnchor: true,
      trackGraphRule: "real-osm-track-graph/v2",
      simulatedRouteKey: "gtfs-simulated/v2",
    },
    routeSetSha256,
    dailyCirculationPlanSha256: dailyPlan.planSha256,
    transferSetSha256,
    transferDemandsProduced: true,
    findings: {},
    unresolvedRequired: 0,
  };
  const timetableRouteReportPath = join(artifactRoot, "timetable-routes-v2.derivation-report-v4.json");
  await writeFile(timetableRouteReportPath, `${JSON.stringify(timetableRouteReport, null, 2)}\n`, "utf8");
  const report = {
    schema: "germany-operational-v2-derivation-report-v1",
    mode: "deterministic-conservative-v1",
    infraReleaseId: annualSpecification.infraReleaseId,
    policy: {
      id: checkedPolicy.id,
      sha256: syntheticOperationalSha256(annualSpecification.policy),
      spec: structuredClone(annualSpecification.policy),
    },
    inputs: {
      spec: { path: basename(annualPath), ...annualProof, records: 1 },
      tracks: inputEvidence.tracks,
      platforms: inputEvidence.platforms,
      switches: inputEvidence.switches,
      signals: inputEvidence.signals,
      blocks: inputEvidence.blocks,
      conflictResources: inputEvidence.conflictResources,
      timetableRoutes: inputEvidence.timetableRoutes,
      transferDemands: inputEvidence.transferDemands,
    },
    candidate: { ...candidateProof, stateHash, validationMode: "native-streaming-redb-v1", movementRouteTemplates },
    timetableRouteEvidence: {
      timetableRoutes: inputEvidence.timetableRoutes,
      transferDemands: inputEvidence.transferDemands,
      dailyPlanSha256: dailyPlan.planSha256,
      transferSetSha256,
      circulationCount: 1,
      plannedTransitionCount: 1,
      transferDemandCount: 1,
      transferLotCount: 1,
      turnaroundDemandCount: 0,
      turnaroundPairCount: 0,
      movementRouteTemplates,
    },
    counts: {
      source: { tracks: 2, orderableTracks: 2, platforms: 2, switches: 2, signals: 4, blocks: 2, conflictResources: 3, timetableRoutes: 3, timetableLegs: 2, transferDemands: 1, transferLots: 1, turnaroundDemands: 0, turnaroundPairs: 0 },
      candidate: { directedEdges: 2, edgeGeometries: 2, routeVersions: 4, interlockingRoutes: 3, signals: 8, switches: 2, blockResources: 9, platformIntervals: 2, regionBoundaries: 1, directTemplates: 0, stablingTemplates: 0, transferTemplates: 2 },
      provenance: { observedForwardSpeeds: 1, observedBackwardSpeeds: 1, simulatedSpeeds: 1, observedProtectionAssignments: 0, simulatedProtectionAssignments: 2, matchedPlatformIntervals: 2, excludedPlatformEvidence: 0, syntheticBoundarySignals: 2, turnaroundRouteVersions: 0, turnaroundInterlockingRoutes: 0, transferRouteVersions: 1, transferInterlockingRoutes: 1, observedStablingTemplates: 0, simulatedOperationalStablingTemplates: 0, berthAssignmentCounts: { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 }, crossBerthTemplates: 0 },
    },
    scope: {
      routeModel: "complete-pinned-timetable-routes",
      interlockingModel: "deterministic-linear-segment-node-stellzone-mutex-and-progressive-authority/v3",
      platformModel: "deterministic-nearest-observed-track-within-policy-radius/v1",
      capacityBias: "conservative-under-capacity",
      minimumOverlapMmPolicy: annualSpecification.policy.minimumOverlapMm,
      turnaroundModel: "real-osm-bounded-bidirectional-access-with-observed-siding-or-explicit-synthetic-operational-berth/v3",
      minimumBerthEndClearanceMmPolicy: annualSpecification.policy.minimumBerthEndClearanceMm,
      maximumStablingPathEdgesPolicy: annualSpecification.policy.maximumStablingPathEdges,
      maximumStablingPathLengthMmPolicy: annualSpecification.policy.maximumStablingPathLengthMm,
      simulatedOperationalBerthFallbackPolicy: annualSpecification.policy.simulatedOperationalBerthFallback,
      maximumDirectDwellMsPolicy: annualSpecification.policy.maximumDirectDwellMs,
      terminalFormationLengthsMm: [...annualSpecification.policy.terminalFormationLengthsMm],
      movementRouteTemplateModel: "daily-plan-scoped-direct-stabling-transfer-continuity/v2",
    },
    routeCoverage: "complete-pinned-timetable-routes",
    activationEligible: true,
    unresolvedRequired: 0,
    unresolvedRequiredDimensions: [],
    realInterlockingFactsClaimed: false,
    realGeometry: true,
    simulatedOperationalAssignment: true,
    candidateProduced: true,
  };
  const reportPath = join(artifactRoot, "operational-infrastructure-v2.derivation-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const inputsPath = join(toolsRoot, "closure-inputs.json");
  await writeFile(inputsPath, `${JSON.stringify({
    schema: "zugfolge-synthetic-operational-closure-inputs/v2",
    releaseId: annualSpecification.infraReleaseId,
    artifactRoot: "var/derived/test",
    policyFile: "tools/region-import/germany/policy.json",
    annualSpecificationFile: "tools/region-import/germany/annual.json",
    candidateFile: "operational-infrastructure-v2.candidate.json",
    derivationReportFile: "operational-infrastructure-v2.derivation-report.json",
    timetableRouteReportFile: "timetable-routes-v2.derivation-report-v4.json",
    timetableTransferDemandsFile: "timetable-routes-v2.transfer-demands-v2.json",
    gtfsSnapshotFile: "gtfs-region-test-v2.json",
    operationalArtifactFile: "operational-infrastructure-v2.json",
  }, null, 2)}\n`, "utf8");
  const native = async (path, expectedReleaseId) => {
    const proof = await syntheticOperationalFileProof(path);
    return { schema: "operational-infrastructure-v2", infraReleaseId: expectedReleaseId, sourceBytes: proof.bytes, sourceSha256: proof.sha256, bytes: proof.bytes, sha256: proof.sha256, stateHash, validationMode: "native-streaming-redb-v1" };
  };
  return { artifactRoot, gtfsSnapshotPath, inputsPath, native, outputPath: join(artifactRoot, "synthetic-operational-closure-receipt.json"), reportPath, root, timetableRouteReportPath, timetableTransferDemandsPath };
}

test("Jahres-CLI leitet zehn Inputbindungen samt Transfer-Evidence, Coverage und Native-Receipts ohne manuelle Zahlen ab", async (t) => {
  const value = await fixture(t);
  const result = await writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native });
  const derivationReport = JSON.parse(await readFile(value.reportPath, "utf8"));
  assert.deepEqual({
    turnaroundModel: derivationReport.scope.turnaroundModel,
    maximumStablingPathEdgesPolicy: derivationReport.scope.maximumStablingPathEdgesPolicy,
    maximumStablingPathLengthMmPolicy: derivationReport.scope.maximumStablingPathLengthMmPolicy,
  }, {
    turnaroundModel: "real-osm-bounded-bidirectional-access-with-observed-siding-or-explicit-synthetic-operational-berth/v3",
    maximumStablingPathEdgesPolicy: checkedPolicy.compilerPolicy.maximumStablingPathEdges,
    maximumStablingPathLengthMmPolicy: checkedPolicy.compilerPolicy.maximumStablingPathLengthMm,
  });
  assert.equal(result.receipt.schema, "zugfolge-synthetic-operational-closure-receipt/v2");
  assert.deepEqual(result.receipt.claims, checkedPolicy.publicClaims);
  assert.deepEqual(result.receipt.inputs.map(({ role }) => role), requiredRoles);
  assert.equal(result.receipt.inputs.find(({ role }) => role === "timetable-routes").records, 3);
  assert.equal(result.receipt.inputs.find(({ role }) => role === "timetable-route-report").records, 1);
  assert.equal(result.receipt.inputs.find(({ role }) => role === "gtfs-snapshot").records, 1);
  assert.equal(result.receipt.inputs.find(({ role }) => role === "timetable-transfer-demands").records, 1);
  assert.deepEqual(result.receipt.timetableRouteEvidence, {
    reportSchema: "zugfolge-germany-timetable-route-report/v4",
    policyId: "synthetic-operational-b/v2",
    derivationRule: "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
    selectionRule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
    reportBytes: result.receipt.inputs.find(({ role }) => role === "timetable-route-report").bytes,
    reportSha256: result.receipt.inputs.find(({ role }) => role === "timetable-route-report").sha256,
    routesBytes: result.receipt.inputs.find(({ role }) => role === "timetable-routes").bytes,
    routesSha256: result.receipt.inputs.find(({ role }) => role === "timetable-routes").sha256,
    gtfsSnapshotBytes: result.receipt.inputs.find(({ role }) => role === "gtfs-snapshot").bytes,
    gtfsSnapshotSha256: result.receipt.inputs.find(({ role }) => role === "gtfs-snapshot").sha256,
    transferDemandsSchema: "zugfolge-timetable-transfer-demands/v2",
    transferDemandsBytes: result.receipt.inputs.find(({ role }) => role === "timetable-transfer-demands").bytes,
    transferDemandsSha256: result.receipt.inputs.find(({ role }) => role === "timetable-transfer-demands").sha256,
    snapshotHash: result.receipt.timetableRouteEvidence.snapshotHash,
    archive: "gtfs-test-free.zip",
    archiveSha256: "c".repeat(64),
    sourceLicense: "CC-BY-4.0",
    sourceLicenseAsPublished: "CC BY 4.0",
    selectedSegmentCount: 3,
    completeRouteCount: 3,
    routeRecordCount: 3,
    sameStopTransitionCount: 1,
    routeSetSha256: result.receipt.inputs.find(({ role }) => role === "timetable-routes").sha256,
    dailyCirculationPlanSha256: result.receipt.timetableRouteEvidence.dailyCirculationPlanSha256,
    transferSetSha256: result.receipt.timetableRouteEvidence.transferSetSha256,
    transferDemandsProduced: true,
    dailyCirculation: { lotCount: 1, journeyChainCount: 1, circulationCount: 1, rolloverAssignmentCount: 1, plannedTransitionCount: 1, turnaroundDemandCount: 0, transferDemandCount: 1, transferLotCount: 1 },
    transferRouteCount: 1,
    transferRouteLegCount: 1,
    transferRouteLengthMm: 1_000,
    realGeometry: true,
    simulatedOperationalAssignment: true,
    realInterlockingFactsClaimed: false,
    externalOperationalNetworkProvenance: false,
  });
  assert.deepEqual(result.receipt.coverage, { blockResources: 9, directedEdges: 2, edgeGeometries: 2, interlockingRoutes: 3, platformIntervals: 2, regionBoundaries: 1, routeVersions: 4, rzueLayouts: 1, signals: 8, switches: 2 });
  assert.equal(result.receipt.derivationReport.routeCoverage, "complete-pinned-timetable-routes");
  assert.equal(result.receipt.nativeValidation.candidate.sha256, result.receipt.candidate.sha256);
  assert.equal(result.receipt.nativeValidation.operationalArtifact.sha256, result.receipt.operationalArtifact.sha256);
  await assert.rejects(
    () => writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native }),
    /create-new verweigert jede Ueberschreibung/,
  );
});

test("veraenderte timetableRoutes brechen die Reportbindung und erzeugen kein Receipt", async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.artifactRoot, "timetableRoutes.jsonseq"), "nachtraeglich veraendert\n", "utf8");
  await assert.rejects(
    () => writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native }),
    /kein gueltiges JSON|routeVersionId|kanonisch/,
  );
  await assert.rejects(readFile(value.outputPath), /ENOENT/);
});

test("manipulierte Transferroute bricht Plan-/Set- und Bytebindung und erzeugt kein Receipt", async (t) => {
  const value = await fixture(t);
  const transfers = JSON.parse(await readFile(value.timetableTransferDemandsPath, "utf8"));
  transfers.transferRoutes[0].minimumRuntimeMs += 1;
  await writeFile(value.timetableTransferDemandsPath, `${canonicalSyntheticOperationalValue(transfers)}\n`, "utf8");
  await assert.rejects(
    () => writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native }),
    /gepinnten|Hash|transferSetSha256|Bytes/i,
  );
  await assert.rejects(readFile(value.outputPath), /ENOENT/);
});

test("externe Operational-Network-Provenienz im freien Routenbericht bleibt fail-closed", async (t) => {
  const value = await fixture(t);
  const report = JSON.parse(await readFile(value.timetableRouteReportPath, "utf8"));
  report.sourceProofs.operationalNetwork = { bytes: 1, sha256: "f".repeat(64) };
  await writeFile(value.timetableRouteReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native }),
    /externe Operational-Network-Provenienz/,
  );
  await assert.rejects(readFile(value.outputPath), /ENOENT/);
});

test("unvollstaendige ausgewaehlte GTFS-Segmentabdeckung bleibt fail-closed", async (t) => {
  const value = await fixture(t);
  const report = JSON.parse(await readFile(value.timetableRouteReportPath, "utf8"));
  report.metrics.completeRouteCount = 2;
  report.metrics.incompleteRouteCount = 1;
  await writeFile(value.timetableRouteReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native }),
    /keine vollstaendige 1:1-Abdeckung/,
  );
});

test("veraenderter GTFS-Snapshot bricht Datei- und snapshotHash-Bindung", async (t) => {
  const value = await fixture(t);
  const envelope = JSON.parse(await readFile(value.gtfsSnapshotPath, "utf8"));
  envelope.snapshot.source.archiveSha256 = "e".repeat(64);
  await writeFile(value.gtfsSnapshotPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native }),
    /verschiedene GTFS-Snapshot-Bytes|snapshotHash stimmt nicht/,
  );
});

test("offener oder manuell aufgeweiteter Ableitungsbericht bleibt fail-closed", async (t) => {
  const value = await fixture(t);
  const report = JSON.parse(await readFile(value.reportPath, "utf8"));
  report.activationEligible = false;
  report.unresolvedRequired = 1;
  report.unresolvedRequiredDimensions = ["complete-pinned-timetable-route-versions"];
  await writeFile(value.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native }),
    /nicht vollstaendig geschlossen/,
  );
});

test("Turnaroundmodell und beide Stabling-Suchgrenzen bleiben im nativen Bericht exakt gebunden", async (t) => {
  const scenarios = [
    {
      mutate: (scope) => { scope.turnaroundModel = "real-osm-simple-bidirectional-siding-path-with-centered-single-berth-per-target-edge/v1"; },
      error: /abweichende Overlap-, Turnaround-Such- oder Movement-Template-Policies/,
    },
    {
      mutate: (scope) => { delete scope.maximumStablingPathEdgesPolicy; },
      error: /Nativer Bericht\.scope besitzt unerwartete oder fehlende Felder/,
    },
    {
      mutate: (scope) => { scope.maximumStablingPathLengthMmPolicy += 1; },
      error: /abweichende Overlap-, Turnaround-Such- oder Movement-Template-Policies/,
    },
    {
      mutate: (scope) => { scope.maximumStablingPathHopsPolicy = 8; },
      error: /Nativer Bericht\.scope besitzt unerwartete oder fehlende Felder/,
    },
  ];

  for (const scenario of scenarios) {
    const value = await fixture(t);
    const report = JSON.parse(await readFile(value.reportPath, "utf8"));
    scenario.mutate(report.scope);
    await writeFile(value.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native }),
      scenario.error,
    );
    await assert.rejects(readFile(value.outputPath), /ENOENT/);
  }
});

test("abweichender nativer Zustand zwischen Candidate und Artefakt wird verworfen", async (t) => {
  const value = await fixture(t);
  let invocation = 0;
  const mismatchedNative = async (path, expectedReleaseId) => {
    const receipt = await value.native(path, expectedReleaseId);
    invocation += 1;
    return invocation === 2 ? { ...receipt, stateHash: "c".repeat(64) } : receipt;
  };
  await assert.rejects(
    () => writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: mismatchedNative }),
    /Candidate und materialisiertes Operational-v2-Artefakt sind nicht kanonisch identisch/,
  );
});
