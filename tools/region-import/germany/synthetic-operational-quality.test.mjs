import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildSyntheticOperationalClosureReceipt,
  validateSyntheticOperationalClosureReceipt,
  validateSyntheticOperationalPolicy,
} from "./synthetic-operational-quality.mjs";

const policy = JSON.parse(await readFile(new URL("./synthetic-operational-b.policy.json", import.meta.url), "utf8"));
const roles = ["blocks", "conflict-resources", "gtfs-snapshot", "platforms", "signals", "switches", "timetable-route-report", "timetable-routes", "timetable-transfer-demands", "tracks"];

function nativeReceipt(binding, stateHash) {
  return {
    schema: "operational-infrastructure-v2",
    infraReleaseId: "infra-deutschland-test.1",
    sourceBytes: binding.bytes,
    sourceSha256: binding.sha256,
    bytes: binding.bytes,
    sha256: binding.sha256,
    stateHash,
    validationMode: "native-streaming-redb-v1",
  };
}

function fixture() {
  const sha256 = "1".repeat(64);
  const stateHash = "2".repeat(64);
  const candidate = { file: "candidate.json", bytes: 123, sha256, stateHash };
  const artifact = { file: "operational-infrastructure-v2.json", bytes: 123, sha256, stateHash };
  const coverage = { blockResources: 8, directedEdges: 4, edgeGeometries: 4, interlockingRoutes: 6, platformIntervals: 1, regionBoundaries: 1, routeVersions: 5, rzueLayouts: 1, signals: 6, switches: 1 };
  const records = { blocks: 2, "conflict-resources": 3, "gtfs-snapshot": 1, platforms: 2, signals: 4, switches: 2, "timetable-route-report": 1, "timetable-routes": 5, "timetable-transfer-demands": 2, tracks: 2 };
  const inputs = roles.map((role, index) => ({ role, file: `${role}.jsonseq`, bytes: 100 + index, sha256: (index + 5).toString(16).repeat(64), records: records[role] }));
  const byRole = new Map(inputs.map((entry) => [entry.role, entry]));
  const routeReport = byRole.get("timetable-route-report");
  const timetableRoutes = byRole.get("timetable-routes");
  const gtfsSnapshot = byRole.get("gtfs-snapshot");
  const transferDemands = byRole.get("timetable-transfer-demands");
  const movementRouteTemplates = {
    file: "candidate.movement-route-templates-v2.json",
    bytes: 321,
    sha256: "c".repeat(64),
    stateHash: "f".repeat(64),
    operationalStateHash: stateHash,
    timetableTransferSetSha256: "b".repeat(64),
  };
  const receipt = buildSyntheticOperationalClosureReceipt({
    policy,
    releaseId: "infra-deutschland-test.1",
    annualSpecification: { file: "tools/annual.json", bytes: 456, sha256: "3".repeat(64) },
    candidate,
    operationalArtifact: artifact,
    derivationReport: {
      file: "derivation-report.json",
      bytes: 789,
      sha256: "4".repeat(64),
      schema: "germany-operational-v2-derivation-report-v1",
      mode: "deterministic-conservative-v1",
      routeCoverage: "complete-pinned-timetable-routes",
      activationEligible: true,
      unresolvedRequired: 0,
      realInterlockingFactsClaimed: false,
      realGeometry: true,
      simulatedOperationalAssignment: true,
      candidate: { bytes: candidate.bytes, sha256: candidate.sha256, stateHash, validationMode: "native-streaming-redb-v1", movementRouteTemplates },
      timetableRouteEvidence: {
        timetableRoutes: { path: timetableRoutes.file, bytes: timetableRoutes.bytes, sha256: timetableRoutes.sha256, records: timetableRoutes.records },
        transferDemands: { path: transferDemands.file, bytes: transferDemands.bytes, sha256: transferDemands.sha256, records: transferDemands.records },
        dailyPlanSha256: "a".repeat(64),
        transferSetSha256: "b".repeat(64),
        circulationCount: 2,
        transferDemandCount: 2,
        transferLotCount: 1,
        turnaroundDemandCount: 0,
        turnaroundPairCount: 0,
        movementRouteTemplates,
      },
    },
    inputs,
    timetableRouteEvidence: {
      reportSchema: "zugfolge-germany-timetable-route-report/v4",
      policyId: "synthetic-operational-b/v2",
      derivationRule: "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
      selectionRule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
      reportBytes: routeReport.bytes,
      reportSha256: routeReport.sha256,
      routesBytes: timetableRoutes.bytes,
      routesSha256: timetableRoutes.sha256,
      gtfsSnapshotBytes: gtfsSnapshot.bytes,
      gtfsSnapshotSha256: gtfsSnapshot.sha256,
      transferDemandsSchema: "zugfolge-timetable-transfer-demands/v2",
      transferDemandsBytes: transferDemands.bytes,
      transferDemandsSha256: transferDemands.sha256,
      snapshotHash: "d".repeat(64),
      archive: "free-gtfs.zip",
      archiveSha256: "e".repeat(64),
      sourceLicense: "CC-BY-4.0",
      sourceLicenseAsPublished: "CC BY 4.0",
      selectedSegmentCount: 5,
      completeRouteCount: 5,
      routeRecordCount: 5,
      sameStopTransitionCount: 0,
      routeSetSha256: timetableRoutes.sha256,
      dailyCirculationPlanSha256: "a".repeat(64),
      transferSetSha256: "b".repeat(64),
      transferDemandsProduced: true,
      dailyCirculation: {
        lotCount: 1,
        journeyChainCount: 5,
        circulationCount: 2,
        rolloverAssignmentCount: 2,
        plannedTransitionCount: 5,
        turnaroundDemandCount: 3,
        transferDemandCount: 2,
        transferLotCount: 1,
      },
      transferRouteCount: 2,
      transferRouteLegCount: 4,
      transferRouteLengthMm: 12_345,
      realGeometry: true,
      simulatedOperationalAssignment: true,
      realInterlockingFactsClaimed: false,
      externalOperationalNetworkProvenance: false,
    },
    coverage,
    nativeValidation: { candidate: nativeReceipt(candidate, stateHash), operationalArtifact: nativeReceipt(artifact, stateHash) },
  });
  return receipt;
}

test("Closure-v2 bindet Policy, zehn freie Inputs samt Transfer-Sidecar und beide Native-Receipts", () => {
  const receipt = fixture();
  assert.equal(receipt.schema, "zugfolge-synthetic-operational-closure-receipt/v2");
  assert.equal(receipt.policyId, "synthetic-operational-b/v2");
  assert.deepEqual(receipt.claims, {
    realGeometry: true,
    simulatedOperationalAssignment: true,
    realInterlockingFactsClaimed: false,
    syntheticOperationalDetailsShipped: true,
    objectLevelProvenanceShipped: false,
    observedAndSyntheticObjectsShareRuntimeCollections: true,
  });
  assert.deepEqual(receipt.inputs.map(({ role }) => role), roles);
  assert.equal(receipt.inputs.find(({ role }) => role === "timetable-routes").records, 5);
  assert.equal(receipt.timetableRouteEvidence.sourceLicense, "CC-BY-4.0");
  assert.equal(receipt.timetableRouteEvidence.externalOperationalNetworkProvenance, false);
  assert.equal(receipt.closure.derivedDimensions.includes("complete-pinned-timetable-routes"), true);
  assert.equal(receipt.nativeValidation.candidate.stateHash, receipt.operationalArtifact.stateHash);
  assert.equal(receipt.nativeValidation.operationalArtifact.stateHash, receipt.operationalArtifact.stateHash);
});

test("v1 oder eine fehlende timetableRoutes-Bindung koennen kein neues Closure erzeugen", () => {
  assert.throws(
    () => validateSyntheticOperationalPolicy({ ...policy, schema: "zugfolge-synthetic-operational-policy/v1" }),
    /kein v2-Schema mit timetableRoutes-Bindung/,
  );
  const missing = structuredClone(fixture());
  missing.inputs = missing.inputs.filter(({ role }) => role !== "timetable-routes");
  assert.throws(
    () => validateSyntheticOperationalClosureReceipt(missing, { policy, releaseId: "infra-deutschland-test.1" }),
    /nicht exakt alle zehn Pflichtinputs/,
  );
});

test("offene Dimensionen, gewoehnliche Annahmen und Karten-Umetikettierung bleiben ausgeschlossen", () => {
  const open = structuredClone(fixture());
  open.closure.unresolvedRequired = 1;
  assert.throws(() => validateSyntheticOperationalClosureReceipt(open, { policy, releaseId: "infra-deutschland-test.1" }), /offene Pflichtdimensionen/);
  const assumed = structuredClone(fixture());
  assumed.closure.ordinaryAssumptionsPromoted = 1;
  assert.throws(() => validateSyntheticOperationalClosureReceipt(assumed, { policy, releaseId: "infra-deutschland-test.1" }), /Gewoehnliche Annahmen/);
  const reclassified = structuredClone(fixture());
  reclassified.closure.mapClassCReclassified = 1;
  assert.throws(() => validateSyntheticOperationalClosureReceipt(reclassified, { policy, releaseId: "infra-deutschland-test.1" }), /Klasse-C-Kartenobjekte/);
});

test("das v2-Receipt kann keine realen Stellwerksfakten behaupten", () => {
  const claimed = structuredClone(fixture());
  claimed.claims.realInterlockingFactsClaimed = true;
  assert.throws(() => validateSyntheticOperationalClosureReceipt(claimed, { policy, releaseId: "infra-deutschland-test.1" }), /Geometrie, Simulation und ausgelieferte Provenienz/);
});

test("der v2-Vertrag verlangt ausgelieferte Synthetic-Details, getrennte Objektlineage und gemeinsame Runtime-Collections", () => {
  assert.equal(policy.id, "synthetic-operational-b/v2");
  assert.equal(policy.schema, "zugfolge-synthetic-operational-policy/v2");
  assert.deepEqual(policy.publicClaims, {
    realGeometry: true,
    simulatedOperationalAssignment: true,
    realInterlockingFactsClaimed: false,
    syntheticOperationalDetailsShipped: true,
    objectLevelProvenanceShipped: false,
    observedAndSyntheticObjectsShareRuntimeCollections: true,
  });
  for (const field of [
    "syntheticOperationalDetailsShipped",
    "objectLevelProvenanceShipped",
    "observedAndSyntheticObjectsShareRuntimeCollections",
  ]) {
    const invalid = structuredClone(policy);
    invalid.publicClaims[field] = !invalid.publicClaims[field];
    assert.throws(() => validateSyntheticOperationalPolicy(invalid), /oeffentliche Fakten und interne Simulation/);
  }
});

test("die Compilerpolicy bindet beide versionierten Stabling-Suchgrenzen fail-closed", () => {
  assert.equal(policy.compilerPolicy.maximumStablingPathEdges, 64);
  assert.equal(policy.compilerPolicy.maximumStablingPathLengthMm, 10_000_000);

  for (const field of ["maximumStablingPathEdges", "maximumStablingPathLengthMm"]) {
    const missing = structuredClone(policy);
    delete missing.compilerPolicy[field];
    assert.throws(
      () => validateSyntheticOperationalPolicy(missing),
      /compilerPolicy besitzt unerwartete oder fehlende Felder/,
    );

    const invalid = structuredClone(policy);
    invalid.compilerPolicy[field] = 0;
    assert.throws(
      () => validateSyntheticOperationalPolicy(invalid),
      new RegExp(`compilerPolicy\\.${field} ist keine positive sichere Ganzzahl`),
    );
  }

  const unknown = structuredClone(policy);
  unknown.compilerPolicy.maximumStablingPathHops = 8;
  assert.throws(
    () => validateSyntheticOperationalPolicy(unknown),
    /compilerPolicy besitzt unerwartete oder fehlende Felder/,
  );
});
