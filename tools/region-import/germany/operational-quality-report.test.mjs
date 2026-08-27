import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  gtfsJourneyChainId,
  gtfsPlayableLegId,
} from "../../../packages/gtfs/dist/index.js";
import { writeOperationalQualityReport } from "./operational-quality-report.mjs";
import {
  canonicalSyntheticOperationalValue,
  syntheticOperationalFileProof,
  syntheticOperationalSha256,
} from "./synthetic-operational-quality.mjs";
import { writeAnnualSyntheticOperationalClosure } from "./synthetic-operational-closure.mjs";
import {
  STATIC_MAP_QUALITY_LAYER_ORDER,
  buildStaticMapQuality,
} from "../../tiles/static-map-quality.mjs";

const policy = JSON.parse(await readFile(new URL("./synthetic-operational-b.policy.json", import.meta.url), "utf8"));
const roleLayers = [["blocks", "blocks"], ["conflict-resources", "conflictResources"], ["platforms", "platforms"], ["signals", "signals"], ["switches", "switches"], ["timetable-routes", "timetableRoutes"], ["timetable-transfer-demands", "transferDemands"], ["tracks", "tracks"]];
const featureTypes = Object.freeze({
  rail_corridors: "rail-corridor",
  operating_points: "operating-point",
  stations: "station",
  tracks: "track",
  platforms: "platform",
  switches: "switch",
  signals: "signal",
  blocks: "block",
  conflict_resources: "conflict_resource",
  rail_context: "rail_context",
});
const dimensions = ["topology", "maximumSpeed", "gradient", "electrification", "trackCount", "signals", "blocks", "conflictResources"];

function mapQualityReport() {
  const spec = {
    schema: "zugfolge-static-map-quality-materialization/v2",
    releaseId: "karte-deutschland-test.1-v2",
    infrastructureCorpusId: "infra-deutschland-test.1",
    timetableYear: 2026,
    scopeId: "deutschland-ebo-visible-corpus",
    visibleLayerOrder: [...STATIC_MAP_QUALITY_LAYER_ORDER],
  };
  const layers = STATIC_MAP_QUALITY_LAYER_ORDER.map((name, index) => {
    const features = name === "platforms" ? 2 : 1;
    const qualityClassFeatureCount = name === "platforms"
      ? { A: 0, B: 0, C: features }
      : { A: 0, B: features, C: 0 };
    const layer = {
      name,
      featureType: featureTypes[name],
      bytes: 100 + index,
      features,
      declaredQualityClassFeatureCount: { ...qualityClassFeatureCount },
      qualityClassFeatureCount: { ...qualityClassFeatureCount },
    };
    if (name === "tracks") Object.assign(layer, {
      totalLengthMm: 300_000,
      declaredQualityClassLengthMm: { A: 0, B: 300_000, C: 0 },
      qualityClassLengthMm: { A: 0, B: 300_000, C: 0 },
      qualityClassificationCorrections: {},
    });
    return layer;
  });
  const qualityClassFeatureCount = layers.reduce((total, layer) => ({
    A: total.A + layer.qualityClassFeatureCount.A,
    B: total.B + layer.qualityClassFeatureCount.B,
    C: total.C + layer.qualityClassFeatureCount.C,
  }), { A: 0, B: 0, C: 0 });
  const detailedReport = {
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId: spec.infrastructureCorpusId,
    timetableYear: spec.timetableYear,
    scopeId: spec.scopeId,
    purpose: "visible-map-quality-evidence",
    operationalReleaseGate: false,
    deterministic: true,
    policy: {
      classA: "complete evidence",
      classB: "conservative visible model",
      classC: "visible but not orderable",
      classAFromSingleSourceOrAutomatedInference: false,
      conservativeAssumptionsReportedSeparately: true,
      ordinaryAssumptionsOperationalClassBEligible: false,
      syntheticDerivedClosureRequiredForOperationalClassB: true,
      nonPublicSourceRawDataShipped: false,
    },
    summary: {
      visibleLayers: layers.length,
      visibleFeatures: layers.reduce((sum, layer) => sum + layer.features, 0),
      declaredQualityClassFeatureCount: { ...qualityClassFeatureCount },
      qualityClassFeatureCount: { ...qualityClassFeatureCount },
    },
    layers,
    trackDimensions: Object.fromEntries(dimensions.map((dimension) => [dimension, { policy: { ruleId: `${dimension}/v1` } }])),
  };
  return buildStaticMapQuality({
    spec,
    detailedReport,
    sourceProof: { bytes: 4321, sha256: "b".repeat(64) },
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-quality-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, "artifacts");
  await mkdir(artifactRoot);
  await writeFile(join(root, "policy.json"), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  const journeyWorldId = "00000000-0000-4000-8000-000000000315";
  const journeyRegionId = "test-region";
  const journeyReleaseId = "gtfs-test-release";
  const journeySourceTripId = "trip-test";
  const journeyChainId = gtfsJourneyChainId({ regionId: journeyRegionId, releaseId: journeyReleaseId, sourceTripId: journeySourceTripId });
  const segmentIds = Array.from({ length: 4 }, (_, sequence) => gtfsPlayableLegId({ journeyChainId, sequence }));
  const layers = {};
  const records = { blocks: 2, conflictResources: 2, platforms: 1, signals: 2, switches: 1, timetableRoutes: 4, transferDemands: 1, tracks: 3 };
  for (const [, layer] of roleLayers.filter(([, layer]) => layer !== "transferDemands")) {
    layers[layer] = `artifacts/${layer}.jsonseq`;
    if (layer !== "timetableRoutes") await writeFile(join(root, layers[layer]), Array.from({ length: records[layer] }, (_, index) => `${layer}-${index}\n`).join(""), "utf8");
  }
  const timetableRoutes = Array.from({ length: 4 }, (_, index) => ({
    routeVersionId: `route:gtfs:${segmentIds[index]}:v1`,
    templateId: `template:gtfs:${segmentIds[index]}:v1`,
    predecessorId: null,
    transitionRouteMm: null,
    legs: [{ edgeId: `track-${index}`, direction: "forward", edgeEntryMm: 0, edgeExitMm: 1000 }],
  })).sort((left, right) => left.routeVersionId.localeCompare(right.routeVersionId));
  await writeFile(join(root, layers.timetableRoutes), timetableRoutes.map((route) => `${canonicalSyntheticOperationalValue(route)}\n`).join(""), "utf8");
  const annualSpecification = {
    schema: "zugfolge-germany-operational-infrastructure-derivation/v2",
    mode: "deterministic-conservative-v1",
    infraReleaseId: "infra-deutschland-test.1",
    layers,
    policy: structuredClone(policy.compilerPolicy),
  };
  const annualPath = join(root, "annual.json");
  const candidatePath = join(artifactRoot, "operational-infrastructure-v2.candidate.json");
  const artifactPath = join(artifactRoot, "operational-infrastructure-v2.json");
  const canonicalBytes = `${JSON.stringify({ schema: "operational-infrastructure-v2", id: annualSpecification.infraReleaseId })}\n`;
  await Promise.all([writeFile(candidatePath, canonicalBytes), writeFile(artifactPath, canonicalBytes)]);
  const candidate = await syntheticOperationalFileProof(candidatePath);
  const stateHash = candidate.sha256 === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
  const evidence = {};
  for (const [, layer] of roleLayers.filter(([, layer]) => layer !== "transferDemands")) evidence[layer] = { path: layers[layer], ...await syntheticOperationalFileProof(join(root, layers[layer])), records: records[layer] };
  const stops = [{ stopId: "stop-a", stopSequence: 0, arrivalS: 0, departureS: 0 }, { stopId: "stop-b", stopSequence: 1, arrivalS: 60, departureS: 60 }];
  const segments = Array.from({ length: 4 }, (_, index) => ({
    segmentId: segmentIds[index],
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
    stops: structuredClone(stops),
  }));
  const snapshot = {
    schema: "zugfolge-gtfs-region-snapshot/v2",
    regionId: "test-region",
    regionVariant: "B",
    serviceDate: "20260812",
    source: { sourceId: "gtfs-test-free", archive: "gtfs-test-free.zip", archiveSha256: "c".repeat(64), feedUrl: "https://example.invalid/free-gtfs.zip", sourceLicense: "CC BY 4.0", attribution: "Test transport authority" },
    metrics: { playableSegmentCount: 4, externalLegCount: 0, orderableJourneyChainCount: 1 },
    externalLegSpecification: {},
    serviceScopeSpecification: {},
    serviceScopeReport: {},
    stations: [
      { stopId: "stop-a", parentStationId: "parent-a", name: "Stop A", latitudeE7: 510000000, longitudeE7: 120000000, inRegion: true },
      { stopId: "stop-b", parentStationId: "parent-b", name: "Stop B", latitudeE7: 510000001, longitudeE7: 120000001, inRegion: true },
    ],
    journeyChains: [{ schemaVersion: "zugfolge-gtfs-journey-chain/v2", journeyChainId, worldId: journeyWorldId, regionId: journeyRegionId, releaseId: journeyReleaseId, sourceTripId: journeySourceTripId, orderable: true, legs: segments.map((segment, index) => ({ legId: segment.segmentId, sequence: index, kind: "playable", orderable: true, qualityClass: "B", planningWindows: [], stops: structuredClone(stops) })) }],
    boundaryPlanningWindows: [],
    segments,
  };
  const snapshotHash = syntheticOperationalSha256(snapshot);
  const gtfsSnapshotPath = join(artifactRoot, "gtfs-region-test-v2.json");
  await writeFile(gtfsSnapshotPath, `${JSON.stringify({ snapshot, snapshotHash }, null, 2)}\n`, "utf8");
  const gtfsSnapshotProof = await syntheticOperationalFileProof(gtfsSnapshotPath);
  const circulationId = "circulation-lot-test-001";
  const lotId = "lot-test";
  const transferId = `transfer-${"1".repeat(64)}`;
  const formationLengthsMm = [...policy.compilerPolicy.terminalFormationLengthsMm];
  const circulation = {
    id: circulationId,
    lotId,
    serviceLineId: "line-test",
    assetCompatibilityKey: lotId,
    journeyChainIds: [journeyChainId],
    passengerLegIds: segmentIds,
    passengerTrainRunIds: segmentIds.map((segmentId, index) => index === 0 ? journeyChainId : `${journeyChainId}:${segmentId}`),
    start: { legId: segmentIds[0], passengerRouteVersionId: `route:gtfs:${segmentIds[0]}:v1`, locationId: "stop-a", physicalStopId: "stop-a", timeS: 0 },
    end: { legId: segmentIds[3], passengerRouteVersionId: `route:gtfs:${segmentIds[3]}:v1`, locationId: "stop-b", physicalStopId: "stop-b", timeS: 60 },
  };
  const transferDemand = {
    id: transferId,
    lotId,
    assetCompatibilityKey: lotId,
    sourceCirculationId: circulationId,
    targetCirculationId: circulationId,
    sourcePassengerLegId: segmentIds[3],
    targetPassengerLegId: segmentIds[0],
    sourcePassengerRouteVersionId: `route:gtfs:${segmentIds[3]}:v1`,
    targetPassengerRouteVersionId: `route:gtfs:${segmentIds[0]}:v1`,
    sourceLocationId: "stop-b",
    targetLocationId: "stop-a",
    sourcePhysicalStopId: "stop-b",
    targetPhysicalStopId: "stop-a",
    earliestDepartureS: 360,
    latestArrivalS: 86_100,
    availableWindowS: 85_740,
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
  const dailyPlan = { ...dailyPlanBody, planSha256: syntheticOperationalSha256({ schema: "zugfolge-daily-circulation-plan/v2", value: dailyPlanBody }) };
  const transferRoute = {
    ...transferDemand,
    formationLengthsMm,
    routeVersionId: `route:${transferId}:movement:v1`,
    templateId: `template:${transferId}:movement:v1`,
    legs: [{ edgeId: "track-transfer", direction: "along", edgeEntryMm: 0, edgeExitMm: 1_000, availableProtectionSystems: ["pzb"], simultaneouslyRequiredProtectionSystems: [] }],
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
  const transferProof = await syntheticOperationalFileProof(timetableTransferDemandsPath);
  const movementRouteTemplatesBody = {
    schema: "movement-route-templates-v2",
    infraReleaseId: annualSpecification.infraReleaseId,
    operationalStateHash: stateHash,
    timetableTransferSetSha256: transferSetSha256,
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
  };
  layers.transferDemands = { path: "artifacts/timetable-routes-v2.transfer-demands-v2.json", expectedBytes: transferProof.bytes, expectedSha256: transferProof.sha256 };
  evidence.transferDemands = { path: layers.transferDemands.path, ...transferProof, records: 1 };
  await writeFile(annualPath, `${JSON.stringify(annualSpecification, null, 2)}\n`, "utf8");
  const annualProof = await syntheticOperationalFileProof(annualPath);
  const gtfsMetrics = { stationCount: 2, journeyChainCount: 1, playableLegCount: 4, oneStopPlayableLegCount: 0, externalLegCount: 0, snapshotSegmentCount: 4, eligibleSegmentCount: 4, excludedQualityCCount: 0, uniqueDirectedStopPairCount: 1, uniqueRoutableDirectedStopPairCount: 1, sameStopTransitionCount: 0 };
  const timetableRouteReport = {
    schema: "zugfolge-germany-timetable-route-report/v4",
    infraReleaseId: annualSpecification.infraReleaseId,
    status: "qualified",
    routesProduced: true,
    derivationRule: "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
    selectionRule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
    policyId: "synthetic-operational-b/v2",
    gtfsBinding: { schema: snapshot.schema, regionId: snapshot.regionId, regionVariant: snapshot.regionVariant, serviceDate: snapshot.serviceDate, sourceId: snapshot.source.sourceId, archive: snapshot.source.archive, archiveSha256: snapshot.source.archiveSha256, sourceLicense: "CC-BY-4.0", sourceLicenseAsPublished: snapshot.source.sourceLicense, attribution: snapshot.source.attribution, snapshotHash },
    metrics: { ...gtfsMetrics, completeRouteCount: 4, incompleteRouteCount: 0, routeRecordCount: 4, routedStopPairCount: 4, reusedStopPairRouteCount: 3, uniqueRouterQueryCount: 1, routeLegCount: 4, totalRouteLengthMm: 4000, maximumAnchorDistanceMm: 0, zeroMovementStopTransitionCount: 0, dailyCirculation: structuredClone(dailyPlan.metrics), transferRouteCount: 1, transferRouteLegCount: 1, transferRouteLengthMm: 1_000, retainedRoutingTrackCount: 3 },
    sourceProofs: { tracks: { bytes: evidence.tracks.bytes, sha256: evidence.tracks.sha256 }, corridors: { bytes: 1, sha256: "d".repeat(64) }, gtfsSnapshot: gtfsSnapshotProof },
    sourceMetrics: { gtfsSnapshot: gtfsMetrics, gtfsTrackGraph: { retainedRoutingTrackCount: 3 } },
    provenance: { realGeometry: true, simulatedOperationalAssignment: true, realInterlockingFactsClaimed: false, operationalNetworkUsed: false, gtfsShapeGeometryUsed: false, inventedGeometryUsed: false, everyIntermediateStopUsedAsTrackAnchor: true, trackGraphRule: "real-osm-track-graph/v2", simulatedRouteKey: "gtfs-simulated/v2" },
    routeSetSha256: evidence.timetableRoutes.sha256,
    dailyCirculationPlanSha256: dailyPlan.planSha256,
    transferSetSha256,
    transferDemandsProduced: true,
    findings: {},
    unresolvedRequired: 0,
  };
  await writeFile(join(artifactRoot, "timetable-routes-v2.derivation-report-v4.json"), `${JSON.stringify(timetableRouteReport, null, 2)}\n`, "utf8");
  const report = {
    schema: "germany-operational-v2-derivation-report-v1",
    mode: "deterministic-conservative-v1",
    infraReleaseId: annualSpecification.infraReleaseId,
    policy: { id: policy.id, sha256: syntheticOperationalSha256(annualSpecification.policy), spec: structuredClone(annualSpecification.policy) },
    inputs: { spec: { path: "annual.json", ...annualProof, records: 1 }, tracks: evidence.tracks, platforms: evidence.platforms, switches: evidence.switches, signals: evidence.signals, blocks: evidence.blocks, conflictResources: evidence.conflictResources, timetableRoutes: evidence.timetableRoutes, transferDemands: evidence.transferDemands },
    candidate: { ...candidate, stateHash, validationMode: "native-streaming-redb-v1", movementRouteTemplates },
    timetableRouteEvidence: {
      timetableRoutes: evidence.timetableRoutes,
      transferDemands: evidence.transferDemands,
      dailyPlanSha256: dailyPlan.planSha256,
      transferSetSha256,
      circulationCount: 1,
      transferDemandCount: 1,
      transferLotCount: 1,
      turnaroundDemandCount: 0,
      turnaroundPairCount: 0,
      movementRouteTemplates,
    },
    counts: {
      source: { tracks: 3, orderableTracks: 3, platforms: 1, switches: 1, signals: 2, blocks: 2, conflictResources: 2, timetableRoutes: 4, timetableLegs: 4, transferDemands: 1, transferLots: 1, turnaroundDemands: 0, turnaroundPairs: 0 },
      candidate: { directedEdges: 3, edgeGeometries: 3, routeVersions: 5, interlockingRoutes: 5, signals: 5, switches: 1, blockResources: 8, platformIntervals: 1, regionBoundaries: 1, directTemplates: 0, stablingTemplates: 0, transferTemplates: 2 },
      provenance: { observedForwardSpeeds: 1, observedBackwardSpeeds: 1, simulatedSpeeds: 2, observedProtectionAssignments: 0, simulatedProtectionAssignments: 3, matchedPlatformIntervals: 1, excludedPlatformEvidence: 0, syntheticBoundarySignals: 4, turnaroundRouteVersions: 0, turnaroundInterlockingRoutes: 0, transferRouteVersions: 1, transferInterlockingRoutes: 1 },
    },
    scope: {
      routeModel: "complete-pinned-timetable-routes",
      interlockingModel: "deterministic-linear-segment-node-stellzone-mutex-and-progressive-authority/v3",
      platformModel: "deterministic-nearest-observed-track-within-policy-radius/v1",
      capacityBias: "conservative-under-capacity",
      minimumOverlapMmPolicy: annualSpecification.policy.minimumOverlapMm,
      turnaroundModel: "real-osm-simple-bidirectional-siding-path-with-centered-single-berth-per-target-edge/v1",
      minimumBerthEndClearanceMmPolicy: annualSpecification.policy.minimumBerthEndClearanceMm,
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
  await writeFile(join(artifactRoot, "derivation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const closureInputsPath = join(root, "closure-inputs.json");
  await writeFile(closureInputsPath, `${JSON.stringify({ schema: "zugfolge-synthetic-operational-closure-inputs/v2", releaseId: annualSpecification.infraReleaseId, artifactRoot: "artifacts", policyFile: "policy.json", annualSpecificationFile: "annual.json", candidateFile: "operational-infrastructure-v2.candidate.json", derivationReportFile: "derivation-report.json", timetableRouteReportFile: "timetable-routes-v2.derivation-report-v4.json", timetableTransferDemandsFile: "timetable-routes-v2.transfer-demands-v2.json", gtfsSnapshotFile: "gtfs-region-test-v2.json", operationalArtifactFile: "operational-infrastructure-v2.json" }, null, 2)}\n`, "utf8");
  const validateNative = async (path, expectedReleaseId) => {
    const proof = await syntheticOperationalFileProof(path);
    return { schema: "operational-infrastructure-v2", infraReleaseId: expectedReleaseId, sourceBytes: proof.bytes, sourceSha256: proof.sha256, bytes: proof.bytes, sha256: proof.sha256, stateHash, validationMode: "native-streaming-redb-v1" };
  };
  await writeAnnualSyntheticOperationalClosure({ specificationPath: closureInputsPath, repositoryRoot: root, outputPath: join(artifactRoot, "synthetic-operational-closure-receipt.json"), validateNative });
  await mkdir(join(artifactRoot, "map-release", "public"), { recursive: true });
  await writeFile(join(artifactRoot, "map-release", "public", "quality.json"), `${JSON.stringify(mapQualityReport(), null, 2)}\n`, "utf8");
  const specification = {
    schema: "zugfolge-operational-quality-inputs/v1",
    releaseId: "infra-deutschland-test.1",
    timetableYear: 2026,
    artifactRoot: "artifacts",
    policyFile: "policy.json",
    closureReceiptFile: "synthetic-operational-closure-receipt.json",
    mapQualityReportFile: "map-release/public/quality.json",
  };
  const specificationPath = join(root, "inputs.json");
  await writeFile(specificationPath, `${JSON.stringify(specification, null, 2)}\n`, "utf8");
  return { artifactRoot, root, specificationPath, movementRouteTemplates };
}

test("sichtbare Karten-C bleiben erhalten und blockieren den getrennten geschlossenen Operational-Beleg nicht", async (t) => {
  const { root, specificationPath, movementRouteTemplates } = await fixture(t);
  const result = await writeOperationalQualityReport({
    specificationPath,
    repositoryRoot: root,
    outputPath: join(root, "operational-quality.json"),
  });
  assert.deepEqual(result.report.summary.operationalQualityClassArtifactCount, { A: 0, B: 1, C: 0 });
  assert.equal(result.report.summary.visibleMapClassCFeatureCount, 2);
  assert.deepEqual(result.report.mapEvidence.qualityClassFeatureCount, { A: 0, B: 9, C: 2 });
  assert.deepEqual(Object.keys(result.report.mapEvidence).sort(), [
    "bytes",
    "infrastructureCorpusId",
    "mapReleaseId",
    "qualityClassFeatureCount",
    "schema",
    "sha256",
    "sourceReport",
    "trackLengthMm",
    "trackQualityClassLengthMm",
    "visibleFeatures",
    "visibleLayers",
  ]);
  assert.equal(result.report.mapEvidence.schema, "zugfolge-static-map-quality/v2");
  assert.equal(result.report.mapEvidence.mapReleaseId, "karte-deutschland-test.1-v2");
  assert.equal(result.report.mapEvidence.infrastructureCorpusId, "infra-deutschland-test.1");
  assert.deepEqual(result.report.mapEvidence.sourceReport, {
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    bytes: 4321,
    sha256: "b".repeat(64),
    shipped: false,
  });
  const mapBytes = await readFile(join(root, "artifacts", "map-release", "public", "quality.json"));
  assert.equal(result.report.mapEvidence.bytes, mapBytes.length);
  assert.equal(result.report.separation.mapClassCReclassified, false);
  assert.equal(result.report.separation.mapObjectsRemoved, false);
  assert.equal(result.report.qualityGate.operationalQualityEligible, true);
  assert.equal(result.report.qualityGate.signatureImplied, false);
  assert.equal(result.report.qualityGate.activationImplied, false);
  assert.equal(result.report.operationalModel.realGeometry, true);
  assert.equal(result.report.operationalModel.simulatedOperationalAssignment, true);
  assert.equal(result.report.operationalModel.realInterlockingFactsClaimed, false);
  assert.equal(result.report.operationalModel.syntheticOperationalDetailsShipped, true);
  assert.equal(result.report.operationalModel.objectLevelProvenanceShipped, false);
  assert.equal(result.report.operationalModel.observedAndSyntheticObjectsShareRuntimeCollections, true);
  assert.deepEqual(result.report.operationalModel.movementRouteTemplates, {
    bytes: movementRouteTemplates.bytes,
    sha256: movementRouteTemplates.sha256,
    stateHash: movementRouteTemplates.stateHash,
    operationalStateHash: movementRouteTemplates.operationalStateHash,
    timetableTransferSetSha256: movementRouteTemplates.timetableTransferSetSha256,
  });
  assert.equal(result.report.operationalModel.timetableRouteEvidence.sourceLicense, "CC-BY-4.0");
  assert.equal(result.report.operationalModel.timetableRouteEvidence.selectedSegmentCount, 4);
  assert.equal(result.report.operationalModel.timetableRouteEvidence.externalOperationalNetworkProvenance, false);
  assert.deepEqual(Object.keys(result.report.operationalModel).sort(), [
    "closureReceiptSha256",
    "coverage",
    "movementRouteTemplates",
    "objectLevelProvenanceShipped",
    "observedAndSyntheticObjectsShareRuntimeCollections",
    "operationalArtifact",
    "policyId",
    "policySha256",
    "provenance",
    "qualityClass",
    "realGeometry",
    "realInterlockingFactsClaimed",
    "simulatedOperationalAssignment",
    "syntheticOperationalDetailsShipped",
    "timetableRouteEvidence",
  ]);
  assert.equal(JSON.stringify(result.report).includes("candidate.json"), false);
  assert.equal(Object.hasOwn(result.report.operationalModel.movementRouteTemplates, "file"), false);
  assert.equal(JSON.stringify(result.report).includes("tracks.jsonseq"), false);
});

test("ein Kartenbericht, der selbst Operational-Freigabe beansprucht, wird abgewiesen", async (t) => {
  const { artifactRoot, root, specificationPath } = await fixture(t);
  const report = structuredClone(mapQualityReport());
  report.claims.operationalInfraRelease = true;
  await writeFile(join(artifactRoot, "map-release", "public", "quality.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => writeOperationalQualityReport({ specificationPath, repositoryRoot: root, outputPath: join(root, "invalid.json") }),
    /lockert die statische, nicht aktivierbare Auslieferungsgrenze/,
  );
});

test("gleiche Karten-, Policy-, Closure- und Artefaktbytes erzeugen denselben Operational-Qualitaetsbericht", async (t) => {
  const { root, specificationPath } = await fixture(t);
  const first = await writeOperationalQualityReport({ specificationPath, repositoryRoot: root, outputPath: join(root, "first.json") });
  const second = await writeOperationalQualityReport({ specificationPath, repositoryRoot: root, outputPath: join(root, "second.json") });
  assert.equal(await readFile(first.output, "utf8"), await readFile(second.output, "utf8"));
  assert.equal(first.sha256, second.sha256);
});
