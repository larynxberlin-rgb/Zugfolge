import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const node = process.execPath;
const script = join(root, "tools/region-import/germany/build-germany-release.mjs");
const fixturePath = join(root, "crates/zugfolge-infra/tests/fixtures/release-manifest-input.json");

const layerNames = [
  "rail_corridors",
  "operating_points",
  "stations",
  "tracks",
  "platforms",
  "switches",
  "signals",
  "blocks",
  "conflict_resources",
  "rail_context",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function staticQuality(fixture) {
  const layers = layerNames.map((name) => ({
    name,
    features: 1,
    qualityClassFeatureCount: name === "platforms"
      ? { A: 0, B: 0, C: 1 }
      : { A: 0, B: 1, C: 0 },
    ...(name === "tracks"
      ? {
          totalLengthMm: 999,
          qualityClassLengthMm: { A: 100, B: 799, C: 100 },
        }
      : {}),
  }));
  return {
    schema: "zugfolge-static-map-quality/v2",
    releaseId: "karte-deutschland-2027.1-v2",
    infrastructureCorpusId: fixture.config.release.releaseId,
    timetableYear: fixture.config.release.timetableYear,
    scopeId: "deutschland-ebo-visible-corpus",
    purpose: "static-map-visible-quality",
    deterministic: true,
    claims: {
      detailedSourceReportShipped: false,
      operationalInfraRelease: false,
      productionActivationEligible: false,
    },
    classification: {
      A: "complete-evidence",
      B: "conservative-visible-model",
      C: "visible-not-operationally-orderable",
    },
    sourceReport: {
      content: "detailed-infrastructure-quality-report",
      binding: "sha256",
      bytes: 123,
      sha256: "6".repeat(64),
      shipped: false,
    },
    summary: {
      visibleLayers: layers.length,
      visibleFeatures: layers.length,
      qualityClassFeatureCount: { A: 0, B: 9, C: 1 },
    },
    layers,
  };
}

function operationalQuality(fixture, map, mapBytes) {
  const artifact = fixture.artifacts.find(({ kind }) => kind === "operational-infrastructure-v2");
  return {
    schema: "zugfolge-operational-infrastructure-quality-report/v1",
    releaseId: fixture.config.release.releaseId,
    timetableYear: fixture.config.release.timetableYear,
    scopeId: "deutschland-ebo-operational-v2",
    deterministic: true,
    separation: {
      mapEvidencePurpose: "visible-map-quality-evidence",
      operationalEvidencePurpose: "closed-operational-v2-model",
      mapClassCReclassified: false,
      mapClassCBlocksOperationalQualityGate: false,
      mapObjectsRemoved: false,
    },
    mapEvidence: {
      schema: map.schema,
      mapReleaseId: map.releaseId,
      infrastructureCorpusId: map.infrastructureCorpusId,
      bytes: Buffer.byteLength(mapBytes),
      sha256: sha256(mapBytes),
      sourceReport: {
        schema: "zugfolge-final-infrastructure-quality-report/v1",
        bytes: map.sourceReport.bytes,
        sha256: map.sourceReport.sha256,
        shipped: map.sourceReport.shipped,
      },
      visibleFeatures: map.summary.visibleFeatures,
      visibleLayers: map.summary.visibleLayers,
      qualityClassFeatureCount: map.summary.qualityClassFeatureCount,
      trackLengthMm: map.layers[3].totalLengthMm,
      trackQualityClassLengthMm: map.layers[3].qualityClassLengthMm,
    },
    operationalModel: {
      policyId: "synthetic-operational-b/v2",
      policySha256: "4".repeat(64),
      closureReceiptSha256: "3".repeat(64),
      qualityClass: "B",
      provenance: "derived",
      realGeometry: true,
      simulatedOperationalAssignment: true,
      realInterlockingFactsClaimed: false,
      syntheticOperationalDetailsShipped: true,
      objectLevelProvenanceShipped: false,
      observedAndSyntheticObjectsShareRuntimeCollections: true,
      movementRouteTemplates: {
        bytes: 1,
        sha256: "2".repeat(64),
        stateHash: "3".repeat(64),
        operationalStateHash: artifact.stateHash,
        timetableTransferSetSha256: "1".repeat(64),
      },
      timetableRouteEvidence: {
        reportSchema: "zugfolge-germany-timetable-route-report/v3",
        policyId: "synthetic-operational-b/v2",
        derivationRule: "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
        selectionRule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
        reportBytes: 1,
        reportSha256: "9".repeat(64),
        routesBytes: 1,
        routesSha256: "a".repeat(64),
        gtfsSnapshotBytes: 1,
        gtfsSnapshotSha256: "b".repeat(64),
        transferDemandsSchema: "zugfolge-timetable-transfer-demands/v1",
        transferDemandsBytes: 1,
        transferDemandsSha256: "e".repeat(64),
        snapshotHash: "c".repeat(64),
        archive: "gtfs-rv-free.zip",
        archiveSha256: "d".repeat(64),
        sourceLicense: "CC-BY-4.0",
        sourceLicenseAsPublished: "CC BY 4.0",
        selectedSegmentCount: 1,
        completeRouteCount: 1,
        routeRecordCount: 1,
        sameStopTransitionCount: 0,
        routeSetSha256: "a".repeat(64),
        dailyCirculationPlanSha256: "f".repeat(64),
        transferSetSha256: "1".repeat(64),
        transferDemandsProduced: true,
        dailyCirculation: { lotCount: 1, journeyChainCount: 1, circulationCount: 1, rolloverAssignmentCount: 1, transferDemandCount: 1, transferLotCount: 1 },
        transferRouteCount: 1,
        transferRouteLegCount: 1,
        transferRouteLengthMm: 1,
        realGeometry: true,
        simulatedOperationalAssignment: true,
        realInterlockingFactsClaimed: false,
        externalOperationalNetworkProvenance: false,
      },
      operationalArtifact: {
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        stateHash: artifact.stateHash,
      },
      coverage: {
        blockResources: 1,
        directedEdges: 1,
        edgeGeometries: 1,
        interlockingRoutes: 1,
        platformIntervals: 1,
        regionBoundaries: 1,
        routeVersions: 1,
        rzueLayouts: 1,
        signals: 1,
        switches: 1,
      },
    },
    summary: {
      operationalQualityClassArtifactCount: { A: 0, B: 1, C: 0 },
      unresolvedRequired: 0,
      visibleMapClassCFeatureCount: map.summary.qualityClassFeatureCount.C,
    },
    qualityGate: {
      closureReceiptVerified: true,
      nativeOperationalValidationVerified: true,
      operationalClassCZero: true,
      ordinaryAssumptionsPromoted: false,
      mapClassCReclassified: false,
      operationalQualityEligible: true,
      signatureImplied: false,
      activationImplied: false,
    },
  };
}

async function run(args, cwd = root) {
  await new Promise((accept, reject) => {
    const child = spawn(node, [script, ...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-65_536);
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? accept()
      : reject(new Error(`Orchestrator endete mit ${code}: ${stderr.trim() || "keine Fehlerausgabe"}`)));
  });
}

test("JavaScript-Orchestrator reicht den getrennten v2-Qualitaetsvertrag bytegenau an Rust weiter", { timeout: 120_000 }, async (context) => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-release-orchestrator-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(
    ["config", "catalog", "rights", "capture", "artifacts"].map(async (key) => {
      const path = join(directory, `${key}.json`);
      await writeFile(path, `${JSON.stringify(key === "artifacts" ? { artifacts: fixture[key] } : fixture[key], null, 2)}\n`);
    }),
  );
  const mapQuality = staticQuality(fixture);
  const mapQualityBytes = `${JSON.stringify(mapQuality, null, 2)}\n`;
  const operationalQualityReport = operationalQuality(fixture, mapQuality, mapQualityBytes);
  const operationalQualityBytes = `${JSON.stringify(operationalQualityReport, null, 2)}\n`;
  await Promise.all([
    writeFile(join(directory, "static-quality.json"), mapQualityBytes),
    writeFile(join(directory, "operational-quality.json"), operationalQualityBytes),
  ]);
  const output = join(directory, "release.json");
  await run(
    ["manifest", "config.json", "catalog.json", "rights.json", "capture.json", "artifacts.json", "static-quality.json", "operational-quality.json", "release.json"],
    directory,
  );
  const actual = JSON.parse(await readFile(output, "utf8"));
  assert.equal(actual.release.releaseId, fixture.config.release.releaseId);
  assert.equal(
    actual.release.quality.operationalClosure.staticMapQualitySha256,
    sha256(mapQualityBytes),
  );
  assert.equal(
    actual.release.quality.operationalClosure.reportSha256,
    sha256(operationalQualityBytes),
  );
  assert.equal(actual.release.quality.operationalClosure.operationalQualityEligible, true);
  assert.equal(actual.release.quality.operationalClosure.signatureImplied, false);
  assert.equal(actual.release.quality.operationalClosure.activationImplied, false);

  await run(
    ["manifest", "config.json", "catalog.json", "rights.json", "capture.json", "artifacts.json", "static-quality.json", "operational-quality.json", "release-second.json"],
    directory,
  );
  const repeated = JSON.parse(await readFile(join(directory, "release-second.json"), "utf8"));
  assert.deepEqual(repeated, actual);
});

test("JavaScript-Korpusbildung ist ohne sichtbare Nicht-Autoritativ-Freigabe fail-closed", async () => {
  await assert.rejects(
    run(["compile"]),
    /Orchestrator endete/,
  );
});
