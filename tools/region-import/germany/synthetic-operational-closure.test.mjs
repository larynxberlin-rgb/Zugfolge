import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
const annualClosureInputs = JSON.parse(await readFile(new URL("./synthetic-operational-closure.annual-2026.3.json", import.meta.url), "utf8"));
const annualOperationalSpecification = JSON.parse(await readFile(new URL("./operational-infrastructure.annual-2026.3.json", import.meta.url), "utf8"));
const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./run-synthetic-operational-closure.mjs", import.meta.url));
const roleLayers = Object.freeze([
  ["blocks", "blocks"],
  ["conflict-resources", "conflictResources"],
  ["platforms", "platforms"],
  ["signals", "signals"],
  ["switches", "switches"],
  ["timetable-routes", "timetableRoutes"],
  ["tracks", "tracks"],
]);
const requiredRoles = Object.freeze(["blocks", "conflict-resources", "gtfs-snapshot", "platforms", "signals", "switches", "timetable-route-report", "timetable-routes", "tracks"]);

test("eingecheckter Jahresvertrag bindet v2-Policy, freie GTFS-Quellen und timetableRoutes ohne manuelle Coverage oder Hashes", () => {
  assert.equal(annualClosureInputs.schema, "zugfolge-synthetic-operational-closure-inputs/v2");
  assert.equal(annualClosureInputs.releaseId, annualOperationalSpecification.infraReleaseId);
  assert.equal(annualClosureInputs.annualSpecificationFile, "tools/region-import/germany/operational-infrastructure.annual-2026.3.json");
  assert.equal(annualOperationalSpecification.layers.timetableRoutes, "var/derived/germany-2026.3/timetable-routes-v2.jsonseq");
  assert.equal(annualClosureInputs.timetableRouteReportFile, "timetable-routes-v2.derivation-report.json");
  assert.equal(annualClosureInputs.gtfsSnapshotFile, "gtfs-region-20260810-v2.json");
  assert.deepEqual(checkedPolicy.requiredInputRoles, requiredRoles);
  assert.equal(checkedPolicy.id, "synthetic-operational-b/v2");
  assert.equal(checkedPolicy.schema, "zugfolge-synthetic-operational-policy/v2");
  assert.deepEqual(checkedPolicy.compilerPolicy, annualOperationalSpecification.policy);
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
  const records = { blocks: 2, conflictResources: 3, platforms: 2, signals: 4, switches: 2, timetableRoutes: 3, tracks: 2 };
  for (const [, layer] of roleLayers) {
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
  await writeFile(annualPath, `${JSON.stringify(annualSpecification, null, 2)}\n`, "utf8");
  const annualProof = await syntheticOperationalFileProof(annualPath);

  const candidatePath = join(artifactRoot, "operational-infrastructure-v2.candidate.json");
  const artifactPath = join(artifactRoot, "operational-infrastructure-v2.json");
  const candidateBytes = `${JSON.stringify({ schema: "operational-infrastructure-v2", id: annualSpecification.infraReleaseId })}\n`;
  await Promise.all([writeFile(candidatePath, candidateBytes), writeFile(artifactPath, candidateBytes)]);
  const candidateProof = await syntheticOperationalFileProof(candidatePath);
  const stateHash = candidateProof.sha256 === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);

  const inputEvidence = {};
  for (const [, layer] of roleLayers) {
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
    schema: "zugfolge-germany-timetable-route-report/v2",
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
    findings: {},
    unresolvedRequired: 0,
  };
  const timetableRouteReportPath = join(artifactRoot, "timetable-routes-v2.derivation-report.json");
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
    },
    candidate: { ...candidateProof, stateHash, validationMode: "native-streaming-redb-v1" },
    counts: {
      source: { tracks: 2, orderableTracks: 2, platforms: 2, switches: 2, signals: 4, blocks: 2, conflictResources: 3, timetableRoutes: 3, timetableLegs: 4 },
      candidate: { directedEdges: 2, edgeGeometries: 2, routeVersions: 3, interlockingRoutes: 3, signals: 8, switches: 2, blockResources: 9, platformIntervals: 2, regionBoundaries: 1 },
      provenance: { observedForwardSpeeds: 1, observedBackwardSpeeds: 1, simulatedSpeeds: 1, observedProtectionAssignments: 0, simulatedProtectionAssignments: 2, matchedPlatformIntervals: 2, excludedPlatformEvidence: 0, syntheticBoundarySignals: 4 },
    },
    scope: { routeModel: "complete-pinned-timetable-routes", interlockingModel: "deterministic-full-route-node-stellzone-mutex-and-authority/v2", platformModel: "deterministic-nearest-observed-track-within-policy-radius/v1", capacityBias: "conservative-under-capacity", minimumOverlapMmPolicy: annualSpecification.policy.minimumOverlapMm },
    routeCoverage: "complete-pinned-timetable-routes",
    activationEligible: true,
    unresolvedRequired: 0,
    unresolvedRequiredDimensions: [],
    realInterlockingFactsClaimed: false,
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
    timetableRouteReportFile: "timetable-routes-v2.derivation-report.json",
    gtfsSnapshotFile: "gtfs-region-test-v2.json",
    operationalArtifactFile: "operational-infrastructure-v2.json",
  }, null, 2)}\n`, "utf8");
  const native = async (path, expectedReleaseId) => {
    const proof = await syntheticOperationalFileProof(path);
    return { schema: "operational-infrastructure-v2", infraReleaseId: expectedReleaseId, sourceBytes: proof.bytes, sourceSha256: proof.sha256, bytes: proof.bytes, sha256: proof.sha256, stateHash, validationMode: "native-streaming-redb-v1" };
  };
  return { artifactRoot, gtfsSnapshotPath, inputsPath, native, outputPath: join(artifactRoot, "synthetic-operational-closure-receipt.json"), reportPath, root, timetableRouteReportPath };
}

test("Jahres-CLI leitet neun Inputbindungen, freie GTFS-Evidence, Coverage und Native-Receipts ohne manuelle Zahlen ab", async (t) => {
  const value = await fixture(t);
  const result = await writeAnnualSyntheticOperationalClosure({ specificationPath: value.inputsPath, repositoryRoot: value.root, outputPath: value.outputPath, validateNative: value.native });
  assert.equal(result.receipt.schema, "zugfolge-synthetic-operational-closure-receipt/v2");
  assert.deepEqual(result.receipt.claims, checkedPolicy.publicClaims);
  assert.deepEqual(result.receipt.inputs.map(({ role }) => role), requiredRoles);
  assert.equal(result.receipt.inputs.find(({ role }) => role === "timetable-routes").records, 3);
  assert.equal(result.receipt.inputs.find(({ role }) => role === "timetable-route-report").records, 1);
  assert.equal(result.receipt.inputs.find(({ role }) => role === "gtfs-snapshot").records, 1);
  assert.deepEqual(result.receipt.timetableRouteEvidence, {
    reportSchema: "zugfolge-germany-timetable-route-report/v2",
    policyId: "synthetic-operational-b/v2",
    derivationRule: "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
    selectionRule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
    reportBytes: result.receipt.inputs.find(({ role }) => role === "timetable-route-report").bytes,
    reportSha256: result.receipt.inputs.find(({ role }) => role === "timetable-route-report").sha256,
    routesBytes: result.receipt.inputs.find(({ role }) => role === "timetable-routes").bytes,
    routesSha256: result.receipt.inputs.find(({ role }) => role === "timetable-routes").sha256,
    gtfsSnapshotBytes: result.receipt.inputs.find(({ role }) => role === "gtfs-snapshot").bytes,
    gtfsSnapshotSha256: result.receipt.inputs.find(({ role }) => role === "gtfs-snapshot").sha256,
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
    realGeometry: true,
    simulatedOperationalAssignment: true,
    realInterlockingFactsClaimed: false,
    externalOperationalNetworkProvenance: false,
  });
  assert.deepEqual(result.receipt.coverage, { blockResources: 9, directedEdges: 2, edgeGeometries: 2, interlockingRoutes: 3, platformIntervals: 2, regionBoundaries: 1, routeVersions: 3, rzueLayouts: 1, signals: 8, switches: 2 });
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
