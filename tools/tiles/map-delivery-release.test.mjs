import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BASEMAP_VECTOR_LAYERS, expandMapPackagePlan, INFRASTRUCTURE_VECTOR_LAYERS } from "./map-package.mjs";
import { buildMapAssetTreeProof, validateMapAssetNoticeBindings } from "./map-asset-notices.mjs";
import {
  buildMapDeliveryRelease,
  buildMapDeliverySources,
  serializeDeliveryJson,
  signMapDeliveryRelease,
  verifyMapDeliveryReleaseSignature,
  writeMapDeliveryRelease,
  writeSignedMapDeliveryRelease,
} from "./map-delivery-release.mjs";
import { deriveSignedMapPackagePlan } from "./signed-map-package-plan.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const BASEMAP_BYTES = Buffer.from("basemap-proof!");
const BASEMAP_SHA256 = createHash("sha256").update(BASEMAP_BYTES).digest("hex");
const INFRASTRUCTURE_BYTES = Buffer.from("infra-proof!");
const INFRASTRUCTURE_SHA256 = createHash("sha256").update(INFRASTRUCTURE_BYTES).digest("hex");
const SQLITE_BYTES = Buffer.from("SQLite format 3\0");
const SQLITE_SHA256 = createHash("sha256").update(SQLITE_BYTES).digest("hex");
const OPERATIONAL_STATE_HASH = "d".repeat(64);
const OPERATIONAL_BYTES = Buffer.from('{"id":"infra-deutschland-2026.1","schema":"zugfolge-operational-infrastructure/v2"}\n');
const OPERATIONAL_SHA256 = createHash("sha256").update(OPERATIONAL_BYTES).digest("hex");
const MOVEMENT_ROUTES_BYTES = Buffer.from('{"infraReleaseId":"infra-deutschland-2026.1","schema":"movement-route-templates-v2"}\n');
const MOVEMENT_ROUTES_SHA256 = createHash("sha256").update(MOVEMENT_ROUTES_BYTES).digest("hex");
const TRANSFER_DEMANDS_BYTES = Buffer.from('{"infraReleaseId":"infra-deutschland-2026.1","schema":"zugfolge-timetable-transfer-demands/v2"}\n');
const TRANSFER_DEMANDS_SHA256 = createHash("sha256").update(TRANSFER_DEMANDS_BYTES).digest("hex");
const PRODUCER_GOLDEN_URL = new URL("../../odoo/addons/zugfolge_admin/tests/fixtures/delivery_v2_producer_golden.json", import.meta.url);
const QUALITY_LAYER_NAMES = [
  "rail_corridors", "operating_points", "stations", "tracks", "platforms",
  "switches", "signals", "blocks", "conflict_resources", "rail_context",
];

function notice(text) {
  return { text, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}

function mapAssetNotices() {
  const descriptors = [
    { kind: "glyph", installPath: "assets/fonts/font.pbf", bytes: 5, sha256: createHash("sha256").update("glyph").digest("hex") },
    { kind: "sprite", installPath: "assets/sprites/dark.json", bytes: 3, sha256: createHash("sha256").update("{}\n").digest("hex") },
    { kind: "sprite", installPath: "assets/sprites/dark.png", bytes: 4, sha256: createHash("sha256").update(Buffer.from([0x89, 0x50, 0x4e, 0x47])).digest("hex") },
  ];
  const notoCopyright = "Copyright 2022 The Noto Project Authors (https://github.com/notofonts)";
  const spriteCopyright = "Copyright (c) 2017 Mapzen";
  return {
    schema: "zugfolge-map-asset-notices/v2",
    assets: [
      {
        id: "noto-glyphs", rightsSourceId: "noto-glyphs", kind: "glyph", license: "OFL-1.1", copyright: notoCopyright,
        modifications: "PBF-Glyphen werden unveraendert selbst gehostet.", source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "fonts" }, derivedFrom: null,
        notice: { url: `https://raw.githubusercontent.com/protomaps/basemaps-assets/${"a".repeat(40)}/fonts/OFL.txt`, ...notice(`${notoCopyright}\nSIL OPEN FONT LICENSE Version 1.1\n`) },
        tree: buildMapAssetTreeProof("glyph", "assets/fonts", descriptors),
      },
      {
        id: "protomaps-sprites", rightsSourceId: "protomaps-sprites", kind: "sprite", license: "MIT", copyright: spriteCopyright,
        modifications: "Dunkle Sprites werden unveraendert selbst gehostet.", source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "sprites/v4" }, derivedFrom: { repository: "https://github.com/tangrams/icons", commit: "b".repeat(40), license: "MIT" },
        notice: { url: `https://raw.githubusercontent.com/tangrams/icons/${"b".repeat(40)}/LICENSE.md`, ...notice(`The MIT License (MIT)\n${spriteCopyright}\n`) },
        tree: buildMapAssetTreeProof("sprite", "assets/sprites", descriptors),
      },
    ],
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function packageSpec() {
  return {
    schema: "zugfolge-map-package-spec/v2",
    packageId: "zugfolge-map-deutschland",
    version: "2026.1",
    partBytes: 100 * 1024 * 1024,
    runtime: {
      schema: "zugfolge-map-runtime/v2",
      publicBasePath: "/artifacts/maps/infra-deutschland-2026.1",
      basemapStyleUrl: "/artifacts/maps/infra-deutschland-2026.1/style.json",
      infrastructurePmtilesUrl: "/artifacts/maps/infra-deutschland-2026.1/infra.pmtiles",
    },
    artifacts: [
      { id: "basemap", kind: "basemap", sourceFile: "basemap.pmtiles", installPath: "basemap.pmtiles", expectedVectorLayers: BASEMAP_VECTOR_LAYERS },
      { id: "infrastructure", kind: "infrastructure", sourceFile: "infra.pmtiles", installPath: "infra.pmtiles", expectedVectorLayers: INFRASTRUCTURE_VECTOR_LAYERS },
    ],
    auxiliaryFiles: [
      { id: "glyph", kind: "glyph", visibility: "public", sourceFile: "assets/font.pbf", installPath: "assets/fonts/font.pbf" },
      { id: "quality", kind: "quality-manifest", visibility: "public", sourceFile: "public/quality.json", installPath: "manifests/quality.json" },
      { id: "readmodel", kind: "read-model", visibility: "public", sourceFile: "public/read-model.sqlite", installPath: "read-model.sqlite" },
      { id: "release", kind: "release-manifest", visibility: "public", sourceFile: "public/release.json", installPath: "manifests/release.json" },
      { id: "sources", kind: "source-manifest", visibility: "public", sourceFile: "public/sources.json", installPath: "manifests/sources.json" },
      { id: "sprite-json", kind: "sprite", visibility: "public", sourceFile: "assets/dark.json", installPath: "assets/sprites/dark.json" },
      { id: "sprite-png", kind: "sprite", visibility: "public", sourceFile: "assets/dark.png", installPath: "assets/sprites/dark.png" },
      { id: "style", kind: "style", visibility: "public", sourceFile: "style.json", installPath: "style.json" },
      {
        id: "operational-infrastructure-2026.1",
        kind: "operational-infrastructure-v2",
        visibility: "public",
        sourceFile: "public/operational-infrastructure-v2.json",
        installPath: "operational-infrastructure-v2.json",
        infraReleaseId: "infra-deutschland-2026.1",
        stateHash: OPERATIONAL_STATE_HASH,
        expectedBytes: OPERATIONAL_BYTES.length,
        expectedSha256: OPERATIONAL_SHA256,
      },
      {
        id: "operational-movement-routes-2026.1",
        kind: "movement-route-templates-v2",
        visibility: "public",
        sourceFile: "public/operational-infrastructure-v2.movement-route-templates-v2.json",
        installPath: "operational-infrastructure-v2.movement-route-templates-v2.json",
        expectedBytes: MOVEMENT_ROUTES_BYTES.length,
        expectedSha256: MOVEMENT_ROUTES_SHA256,
      },
      {
        id: "timetable-transfer-demands-2026.1",
        kind: "timetable-transfer-demands-v2",
        visibility: "public",
        sourceFile: "public/timetable-routes-v2.transfer-demands-v2.json",
        installPath: "timetable-routes-v2.transfer-demands-v2.json",
        expectedBytes: TRANSFER_DEMANDS_BYTES.length,
        expectedSha256: TRANSFER_DEMANDS_SHA256,
      },
    ],
  };
}

function legacyPackageSpec() {
  const spec = packageSpec();
  spec.schema = "zugfolge-map-package-spec/v1";
  spec.runtime = { ...spec.runtime, schema: "zugfolge-map-runtime/v1" };
  spec.auxiliaryFiles = spec.auxiliaryFiles
    .filter(({ kind }) => ![
      "operational-infrastructure-v2",
      "movement-route-templates-v2",
      "timetable-transfer-demands-v2",
    ].includes(kind))
    .concat([{
      id: "train-projection",
      kind: "train-map-projection",
      visibility: "public",
      sourceFile: "public/train-map-projection.sqlite",
      installPath: "train-map-projection.sqlite",
    }]);
  return spec;
}

function infraRelease(report = operationalQuality()) {
  return {
    schema: "zugfolge-infra-release/v2",
    releaseId: "infra-deutschland-2026.1",
    timetableYear: 2026,
    sources: [{
      id: "official-infrastructure",
      version: "2026-08-12",
      sourceLicense: "CC-BY-4.0",
      attribution: "Datenquelle DB InfraGO, CC BY 4.0; durch Zugfolge bearbeitet.",
      modifications: "Normalisiert und konservativ modelliert.",
    }],
    artifacts: [
      {
        id: "operational-infrastructure-2026.1",
        kind: "operational-infrastructure-v2",
        file: "operational-infrastructure-v2.json",
        infraReleaseId: "infra-deutschland-2026.1",
        bytes: OPERATIONAL_BYTES.length,
        sha256: OPERATIONAL_SHA256,
        stateHash: OPERATIONAL_STATE_HASH,
      },
      {
        id: "operational-movement-routes-2026.1",
        kind: "movement-route-templates-v2",
        file: "operational-infrastructure-v2.movement-route-templates-v2.json",
        bytes: MOVEMENT_ROUTES_BYTES.length,
        sha256: MOVEMENT_ROUTES_SHA256,
      },
      {
        id: "timetable-transfer-demands-2026.1",
        kind: "timetable-transfer-demands-v2",
        file: "timetable-routes-v2.transfer-demands-v2.json",
        bytes: TRANSFER_DEMANDS_BYTES.length,
        sha256: TRANSFER_DEMANDS_SHA256,
      },
    ],
    quality: {
      operationalClosure: {
        reportSha256: createHash("sha256").update(serializeDeliveryJson(report)).digest("hex"),
        policyId: report.operationalModel.policyId,
        policySha256: report.operationalModel.policySha256,
        closureReceiptSha256: report.operationalModel.closureReceiptSha256,
        qualityClass: "B",
        provenance: "derived",
        candidateBytes: report.operationalModel.operationalArtifact.bytes,
        candidateSha256: report.operationalModel.operationalArtifact.sha256,
        candidateStateHash: report.operationalModel.operationalArtifact.stateHash,
        staticMapQualityBytes: report.mapEvidence.bytes,
        staticMapQualitySha256: report.mapEvidence.sha256,
        staticMapSourceReportSha256: report.mapEvidence.sourceReport.sha256,
        realInterlockingFactsClaimed: false,
        syntheticOperationalDetailsShipped: true,
        objectLevelProvenanceShipped: false,
        observedAndSyntheticObjectsShareRuntimeCollections: true,
        movementRouteTemplates: structuredClone(report.operationalModel.movementRouteTemplates),
        timetableRouteEvidence: structuredClone(report.operationalModel.timetableRouteEvidence),
        operationalQualityEligible: true,
        signatureImplied: false,
        activationImplied: false,
        unresolvedRequired: 0,
      },
    },
  };
}

function mapRelease() {
  return {
    schema: "zugfolge-map-release/v1",
    releaseId: "infra-deutschland-2026.1",
    sources: [{
      id: "protomaps-daily-basemap",
      version: "20260812",
      sourceLicense: "ODbL-1.0 Produced Work",
      attribution: "© OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps; weitere Bearbeitung durch Zugfolge",
      modifications: "Welt und Deutschlanddetail zusammengeführt.",
    }],
    artifacts: [
      { id: "map-basemap", kind: "basemap", bytes: BASEMAP_BYTES.length, sha256: BASEMAP_SHA256 },
      { id: "map-infra", kind: "infrastructure", bytes: INFRASTRUCTURE_BYTES.length, sha256: INFRASTRUCTURE_SHA256 },
    ],
    assetInventoryPlanSha256: "9".repeat(64),
    assetNotices: mapAssetNotices(),
  };
}

function materialized(release) {
  return { releaseHash: canonicalSha256(release), release };
}

function materializedInfraRelease() {
  return materialized(infraRelease());
}

function materializedMapRelease() {
  return materialized(mapRelease());
}

function quality() {
  const layers = QUALITY_LAYER_NAMES.map((name, index) => ({
    name,
    features: index === 0 ? 24 : 2,
    qualityClassFeatureCount: index === 0 ? { A: 12, B: 12, C: 0 } : { A: 0, B: 2, C: 0 },
    ...(name === "tracks" ? {
      totalLengthMm: 3_000,
      qualityClassLengthMm: { A: 1_000, B: 2_000, C: 0 },
    } : {}),
  }));
  return {
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId: "infra-deutschland-2026.1",
    timetableYear: 2026,
    deterministic: true,
    policy: {
      classC: "visible but not orderable",
      classAFromSingleSourceOrAutomatedInference: false,
      nonPublicSourceRawDataShipped: false,
    },
    summary: {
      visibleLayers: 10,
      visibleFeatures: 42,
      qualityClassFeatureCount: { A: 12, B: 30, C: 0 },
    },
    layers,
  };
}

function operationalQuality() {
  return {
    schema: "zugfolge-operational-infrastructure-quality-report/v1",
    releaseId: "infra-deutschland-2026.1",
    timetableYear: 2026,
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
      schema: "zugfolge-static-map-quality/v2",
      mapReleaseId: "karte-deutschland-2026.1-v2",
      infrastructureCorpusId: "infra-deutschland-2026.1",
      bytes: 4321,
      sha256: HASH_A,
      sourceReport: { schema: "zugfolge-final-infrastructure-quality-report/v1", bytes: 9876, sha256: HASH_B, shipped: false },
      visibleFeatures: 42,
      visibleLayers: 10,
      qualityClassFeatureCount: { A: 12, B: 28, C: 2 },
      trackLengthMm: 3_000,
      trackQualityClassLengthMm: { A: 1_000, B: 1_900, C: 100 },
    },
    operationalModel: {
      policyId: "synthetic-operational-b/v2",
      policySha256: HASH_A,
      closureReceiptSha256: HASH_B,
      qualityClass: "B",
      provenance: "derived",
      realGeometry: true,
      simulatedOperationalAssignment: true,
      realInterlockingFactsClaimed: false,
      syntheticOperationalDetailsShipped: true,
      objectLevelProvenanceShipped: false,
      observedAndSyntheticObjectsShareRuntimeCollections: true,
      movementRouteTemplates: {
        bytes: MOVEMENT_ROUTES_BYTES.length,
        sha256: MOVEMENT_ROUTES_SHA256,
        stateHash: HASH_B,
        operationalStateHash: OPERATIONAL_STATE_HASH,
        timetableTransferSetSha256: HASH_A,
      },
      timetableRouteEvidence: {
        reportSchema: "zugfolge-germany-timetable-route-report/v4",
        policyId: "synthetic-operational-b/v2",
        derivationRule: "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
        selectionRule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
        reportBytes: 1234,
        reportSha256: HASH_A,
        routesBytes: 5678,
        routesSha256: HASH_B,
        gtfsSnapshotBytes: 9012,
        gtfsSnapshotSha256: HASH_C,
        transferDemandsSchema: "zugfolge-timetable-transfer-demands/v2",
        transferDemandsBytes: TRANSFER_DEMANDS_BYTES.length,
        transferDemandsSha256: TRANSFER_DEMANDS_SHA256,
        snapshotHash: HASH_A,
        archive: "gtfs-free.zip",
        archiveSha256: HASH_B,
        sourceLicense: "CC-BY-4.0",
        sourceLicenseAsPublished: "CC BY 4.0",
        selectedSegmentCount: 4,
        completeRouteCount: 4,
        routeRecordCount: 4,
        sameStopTransitionCount: 1,
        routeSetSha256: HASH_B,
        dailyCirculationPlanSha256: HASH_C,
        transferSetSha256: HASH_A,
        transferDemandsProduced: true,
        dailyCirculation: {
          lotCount: 2,
          journeyChainCount: 4,
          circulationCount: 2,
          rolloverAssignmentCount: 2,
          plannedTransitionCount: 4,
          turnaroundDemandCount: 3,
          transferDemandCount: 1,
          transferLotCount: 1,
        },
        transferRouteCount: 1,
        transferRouteLegCount: 3,
        transferRouteLengthMm: 12_345,
        realGeometry: true,
        simulatedOperationalAssignment: true,
        realInterlockingFactsClaimed: false,
        externalOperationalNetworkProvenance: false,
      },
      operationalArtifact: { bytes: OPERATIONAL_BYTES.length, sha256: OPERATIONAL_SHA256, stateHash: OPERATIONAL_STATE_HASH },
      coverage: { blockResources: 3, directedEdges: 2, edgeGeometries: 2, interlockingRoutes: 2, platformIntervals: 1, regionBoundaries: 1, routeVersions: 4, rzueLayouts: 1, signals: 2, switches: 1 },
    },
    summary: {
      operationalQualityClassArtifactCount: { A: 0, B: 1, C: 0 },
      unresolvedRequired: 0,
      visibleMapClassCFeatureCount: 2,
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-delivery-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "public"), { recursive: true });
  const files = new Map([
    ["basemap.pmtiles", BASEMAP_BYTES],
    ["infra.pmtiles", INFRASTRUCTURE_BYTES],
    ["assets/font.pbf", Buffer.from("glyph")],
    ["public/read-model.sqlite", SQLITE_BYTES],
    ["public/train-map-projection.sqlite", SQLITE_BYTES],
    ["public/operational-infrastructure-v2.json", OPERATIONAL_BYTES],
    ["public/operational-infrastructure-v2.movement-route-templates-v2.json", MOVEMENT_ROUTES_BYTES],
    ["public/timetable-routes-v2.transfer-demands-v2.json", TRANSFER_DEMANDS_BYTES],
    ["assets/dark.json", Buffer.from("{}\n")],
    ["assets/dark.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["style.json", Buffer.from("{}\n")],
    ["public/quality.json", serializeDeliveryJson(operationalQuality())],
  ]);
  for (const [path, bytes] of files) await writeFile(join(root, ...path.split("/")), bytes);
  return root;
}

async function deliveryV2ProducerGolden(root, result) {
  const spec = packageSpec();
  const fileSpecs = [...spec.artifacts, ...spec.auxiliaryFiles];
  const files = [];
  for (const file of fileSpecs) {
    const bytes = file.kind === "release-manifest"
      ? result.releaseBytes
      : file.kind === "source-manifest"
        ? result.sourcesBytes
        : await readFile(join(root, ...file.sourceFile.split("/")));
    files.push({
      id: file.id,
      kind: file.kind,
      installPath: file.installPath,
      ...(file.kind === "operational-infrastructure-v2" ? {
        infraReleaseId: file.infraReleaseId,
        stateHash: file.stateHash,
      } : {}),
      bytes,
    });
  }
  const descriptors = files.map(({ bytes, ...file }) => ({
    ...file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    parts: [{
      path: `parts/${file.id}.part-00001`,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
  }));
  const manifestBytes = serializeDeliveryJson({
    schema: "zugfolge-map-package/v2",
    packageId: spec.packageId,
    version: spec.version,
    format: "directory-parts",
    partBytes: spec.partBytes,
    artifacts: descriptors.filter(({ kind }) => ["basemap", "infrastructure"].includes(kind)),
    auxiliaryFiles: descriptors.filter(({ kind }) => !["basemap", "infrastructure"].includes(kind)),
  });
  return {
    schema: "zugfolge-delivery-v2-producer-golden/v1",
    producer: {
      module: "tools/tiles/map-delivery-release.mjs",
      function: "buildMapDeliveryRelease",
    },
    release: result.release,
    sources: result.sources,
    manifestBase64: manifestBytes.toString("base64"),
    parts: files.map(({ id, bytes }) => ({
      id,
      path: `parts/${id}.part-00001`,
      contentBase64: bytes.toString("base64"),
    })),
  };
}

test("kombinierter Deliveryvertrag bindet Transfer-v2 lokal bytegenau ohne Signaturbehauptung", async () => {
  const root = await fixture();
  try {
    const result = await buildMapDeliveryRelease({
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      packageSpec: packageSpec(),
      sourceRoot: root,
      infraRelease: materializedInfraRelease(),
      mapRelease: materializedMapRelease(),
      auxiliaryArtifactProofs: [
        { id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 },
      ],
    });
    assert.equal(result.release.schema, "zugfolge-map-delivery-release/v2");
    assert.equal(result.release.releaseHash, null);
    assert.equal(result.release.signature, null);
    assert.equal(result.release.approvalGates.signature.status, "missing");
    assert.equal(result.release.approvalGates.quality.reportSchema, "zugfolge-operational-infrastructure-quality-report/v1");
    assert.equal(result.release.approvalGates.quality.visibleMapClassCFeatureCount, 2);
    assert.equal(result.release.approvalGates.quality.operationalClassCArtifactCount, 0);
    assert.equal(result.release.approvalGates.quality.classCOrderable, false);
    assert.equal(result.release.artifacts.length, 11);
    assert.equal(result.release.artifacts.find(({ id }) => id === "basemap").sha256, BASEMAP_SHA256);
    assert.equal(result.release.artifacts.find(({ id }) => id === "readmodel").sha256, SQLITE_SHA256);
    assert.deepEqual(
      result.release.artifacts.find(({ id }) => id === "operational-infrastructure-2026.1"),
      {
        id: "operational-infrastructure-2026.1",
        kind: "operational-infrastructure-v2",
        installPath: "operational-infrastructure-v2.json",
        infraReleaseId: "infra-deutschland-2026.1",
        stateHash: OPERATIONAL_STATE_HASH,
        bytes: OPERATIONAL_BYTES.length,
        sha256: OPERATIONAL_SHA256,
      },
    );
    assert.equal(result.release.bindings.sourcesSha256, result.sourcesSha256);
    assert.equal(result.release.bindings.infraReleaseHash, materializedInfraRelease().releaseHash);
    assert.equal(result.release.bindings.mapReleaseHash, materializedMapRelease().releaseHash);
    assert.deepEqual(result.sources.sources.map(({ id }) => id), ["basemap-protomaps-daily-basemap", "infrastructure-official-infrastructure"]);
    assert.equal(result.sources.schema, "zugfolge-map-delivery-sources/v2");
    assert.deepEqual(result.sources.assetNotices, mapAssetNotices());
    assert.equal(result.release.approvalGates.rights.assetGroupCount, 2);
    assert.equal(result.release.approvalGates.rights.assetFileCount, 3);
    assert.doesNotThrow(() => validateMapAssetNoticeBindings(
      JSON.parse(result.sourcesBytes).assetNotices,
      result.release.artifacts,
    ), "Kanonische Sources-v2-Keyordnung darf den feldweise identischen Assetbaum nicht veraendern.");

    const producerGolden = await deliveryV2ProducerGolden(root, result);
    const generatedManifest = JSON.parse(Buffer.from(producerGolden.manifestBase64, "base64").toString("utf8"));
    assert.deepEqual(
      generatedManifest.auxiliaryFiles.find(({ kind }) => kind === "timetable-transfer-demands-v2"),
      {
        id: "timetable-transfer-demands-2026.1",
        kind: "timetable-transfer-demands-v2",
        installPath: "timetable-routes-v2.transfer-demands-v2.json",
        bytes: TRANSFER_DEMANDS_BYTES.length,
        sha256: TRANSFER_DEMANDS_SHA256,
        parts: [{
          path: "parts/timetable-transfer-demands-2026.1.part-00001",
          bytes: TRANSFER_DEMANDS_BYTES.length,
          sha256: TRANSFER_DEMANDS_SHA256,
        }],
      },
    );
    if (process.env.UPDATE_DELIVERY_V2_PRODUCER_GOLDEN === "1") {
      await writeFile(PRODUCER_GOLDEN_URL, serializeDeliveryJson(producerGolden));
    }
    assert.deepEqual(
      JSON.parse(await readFile(PRODUCER_GOLDEN_URL, "utf8")),
      producerGolden,
      "Das gemeinsame Odoo/Game-API-Golden muss deterministisch dem aktuellen V2-Producer entsprechen.",
    );

    const output = join(root, "public-output");
    assert.equal((await writeMapDeliveryRelease(result, output)).releaseStatus, "written");
    assert.equal((await writeMapDeliveryRelease(result, output)).releaseStatus, "reused");
    assert.deepEqual(JSON.parse(await readFile(join(output, "release.json"), "utf8")), result.release);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("echter Delivery-v2-Builder speist Signatur und Signed-Paketplan mit explizitem null-Hash", async () => {
  const root = await fixture();
  try {
    const unsignedSourceFile = "delivery/delivery-unsigned/release.json";
    const sourcesSourceFile = "delivery/delivery-unsigned/sources.json";
    const signedSourceFile = "delivery/public/release.json";
    const inventorySourceFile = "public/release-artifacts.v2.json";
    await Promise.all([
      mkdir(join(root, "delivery", "delivery-unsigned"), { recursive: true }),
      mkdir(join(root, "delivery", "public"), { recursive: true }),
      mkdir(join(root, "assets", "fonts"), { recursive: true }),
      mkdir(join(root, "assets", "sprites"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "assets", "fonts", "font.pbf"), Buffer.from("glyph"), { flag: "wx" }),
      writeFile(join(root, "assets", "sprites", "dark.json"), Buffer.from("{}\n"), { flag: "wx" }),
      writeFile(join(root, "assets", "sprites", "dark.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]), { flag: "wx" }),
      writeFile(join(root, "basemap.pmtiles"), Buffer.alloc(256, 0x62)),
      writeFile(join(root, "infra.pmtiles"), Buffer.alloc(256, 0x69)),
    ]);
    await writeFile(join(root, ...inventorySourceFile.split("/")), `${JSON.stringify({
      schema: "zugfolge-infra-release-artifacts/v2",
      artifacts: infraRelease().artifacts,
    })}\n`, { encoding: "utf8", flag: "wx" });
    const plan = packageSpec();
    plan.schema = "zugfolge-map-package-plan/v2";
    const releaseDescriptor = plan.auxiliaryFiles.find(({ kind }) => kind === "release-manifest");
    const sourcesDescriptor = plan.auxiliaryFiles.find(({ kind }) => kind === "source-manifest");
    const operationalDescriptor = plan.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2");
    const movementDescriptor = plan.auxiliaryFiles.find(({ kind }) => kind === "movement-route-templates-v2");
    const transferDescriptor = plan.auxiliaryFiles.find(({ kind }) => kind === "timetable-transfer-demands-v2");
    releaseDescriptor.id = "release-manifest";
    releaseDescriptor.sourceFile = unsignedSourceFile;
    sourcesDescriptor.sourceFile = sourcesSourceFile;
    operationalDescriptor.artifactInventory = inventorySourceFile;
    movementDescriptor.artifactInventory = inventorySourceFile;
    transferDescriptor.artifactInventory = inventorySourceFile;
    plan.auxiliaryFiles = plan.auxiliaryFiles.filter(({ kind }) => !["glyph", "sprite"].includes(kind));
    plan.auxiliaryTrees = [
      {
        idPrefix: "glyph",
        kind: "glyph",
        visibility: "public",
        sourceDirectory: "assets/fonts",
        installDirectory: "assets/fonts",
        expectedInventory: { "font.pbf": 1 },
      },
      {
        idPrefix: "sprite",
        kind: "sprite",
        visibility: "public",
        sourceDirectory: "assets/sprites",
        installDirectory: "assets/sprites",
        expectedInventory: { "dark.json": 1, "dark.png": 1 },
      },
    ];
    const expandedPlan = await expandMapPackagePlan(plan, root);
    const matchingMapRelease = mapRelease();
    for (const [kind, path] of [["basemap", "basemap.pmtiles"], ["infrastructure", "infra.pmtiles"]]) {
      const bytes = await readFile(join(root, path));
      Object.assign(matchingMapRelease.artifacts.find((artifact) => artifact.kind === kind), {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const materializedMatchingMapRelease = materialized(matchingMapRelease);
    const built = await buildMapDeliveryRelease({
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      packageSpec: expandedPlan,
      sourceRoot: root,
      infraRelease: materializedInfraRelease(),
      mapRelease: materializedMatchingMapRelease,
      auxiliaryArtifactProofs: [
        { id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 },
      ],
    });
    assert.equal(built.release.releaseHash, null);
    assert.equal(built.release.signature, null);

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { publicKey: alphaWorldPublicKey } = generateKeyPairSync("ed25519");
    const signed = signMapDeliveryRelease(
      built.release,
      privateKey.export({ format: "pem", type: "pkcs8" }),
      "delivery-builder-plan-test",
    );
    await Promise.all([
      writeFile(join(root, ...unsignedSourceFile.split("/")), built.releaseBytes, { flag: "wx" }),
      writeFile(join(root, ...sourcesSourceFile.split("/")), built.sourcesBytes, { flag: "wx" }),
      writeFile(join(root, ...signedSourceFile.split("/")), serializeDeliveryJson(signed), { flag: "wx" }),
      writeFile(join(root, "delivery", "public", "infra-release.json"), serializeDeliveryJson(materializedInfraRelease()), { flag: "wx" }),
      writeFile(join(root, "delivery", "public", "map-release.json"), serializeDeliveryJson(materializedMatchingMapRelease), { flag: "wx" }),
      writeFile(join(root, "trusted-delivery-keys.json"), `${JSON.stringify({
        "alpha-world-builder-plan-test": alphaWorldPublicKey.export({ format: "pem", type: "spki" }),
        "delivery-builder-plan-test": publicKey.export({ format: "pem", type: "spki" }),
      })}\n`, { encoding: "utf8", flag: "wx" }),
      writeFile(join(root, "trusted-delivery-key-scopes.json"), `${JSON.stringify({
        alphaWorldDeployments: ["alpha-world-builder-plan-test"],
        mapInfraDeliveries: ["delivery-builder-plan-test"],
      })}\n`, { encoding: "utf8", flag: "wx" }),
    ]);

    const derived = await deriveSignedMapPackagePlan(
      plan,
      root,
      "trusted-delivery-keys.json",
      "trusted-delivery-key-scopes.json",
    );
    assert.equal(derived.releaseId, built.release.releaseId);
    assert.equal(derived.keyId, "delivery-builder-plan-test");
    assert.equal(derived.signedReleaseSourceFile, signedSourceFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Delivery-v2 lehnt fehlende Notices und vom Paketbestand abweichende Assetbaumbelege ab", async () => {
  const root = await fixture();
  try {
    const missing = mapRelease();
    delete missing.assetNotices;
    await assert.rejects(buildMapDeliveryRelease({
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      packageSpec: packageSpec(),
      sourceRoot: root,
      infraRelease: materializedInfraRelease(),
      mapRelease: materialized(missing),
      auxiliaryArtifactProofs: [{ id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 }],
    }), /Asset-Notices/);

    const forged = mapRelease();
    forged.assetNotices.assets[0].tree.sha256 = "0".repeat(64);
    await assert.rejects(buildMapDeliveryRelease({
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      packageSpec: packageSpec(),
      sourceRoot: root,
      infraRelease: materializedInfraRelease(),
      mapRelease: materialized(forged),
      auxiliaryArtifactProofs: [{ id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 }],
    }), /weicht vom lizenzierten und gepinnten Assetbaum/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Legacy-Delivery v1 bleibt explizit getrennt und verlangt die nicht bestellbare Zugprojektion", async () => {
  const root = await fixture();
  try {
    const legacyQuality = quality();
    legacyQuality.summary.qualityClassFeatureCount.C = 3;
    legacyQuality.layers.find(({ name }) => name === "tracks").qualityClassLengthMm.C = 500;
    await writeFile(join(root, "public", "quality.json"), serializeDeliveryJson(legacyQuality));
    const result = await buildMapDeliveryRelease({
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      packageSpec: legacyPackageSpec(),
      sourceRoot: root,
      infraRelease: infraRelease(),
      mapRelease: mapRelease(),
      auxiliaryArtifactProofs: [
        { id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 },
        { id: "train-projection", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 },
      ],
    });
    assert.equal(result.release.schema, "zugfolge-map-delivery-release/v1");
    assert.equal(result.release.artifacts.some(({ kind }) => kind === "operational-infrastructure-v2"), false);
    assert.equal(result.release.artifacts.filter(({ kind }) => kind === "train-map-projection").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("externer Ed25519-Signer bindet Deliverybytes und wird bei Mutation ungültig", async () => {
  const root = await fixture();
  try {
    const result = await buildMapDeliveryRelease({
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      packageSpec: packageSpec(),
      sourceRoot: root,
      infraRelease: materializedInfraRelease(),
      mapRelease: materializedMapRelease(),
      auxiliaryArtifactProofs: [
        { id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 },
      ],
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signMapDeliveryRelease(
      result.release,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      "delivery-2026",
    );
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    assert.equal(signed.approvalGates.signature.status, "passed");
    assert.equal(verifyMapDeliveryReleaseSignature(signed, publicKeyPem), true);
    assert.equal(
      verifyMapDeliveryReleaseSignature(signed, privateKey.export({ type: "pkcs8", format: "pem" })),
      false,
      "Ein PKCS8-Private-Key darf nie als Delivery-Vertrauensanker akzeptiert werden.",
    );
    const { publicKey: rsaPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    assert.equal(
      verifyMapDeliveryReleaseSignature(signed, rsaPublicKey.export({ type: "spki", format: "pem" })),
      false,
      "Ein RSA-SPKI darf nie als Ed25519-Delivery-Vertrauensanker akzeptiert werden.",
    );
    assert.equal(verifyMapDeliveryReleaseSignature(signed, "kein PEM"), false);
    assert.equal(verifyMapDeliveryReleaseSignature({ ...signed, timetableYear: 2027 }, publicKeyPem), false);
    assert.equal(verifyMapDeliveryReleaseSignature({
      ...signed,
      signature: { ...signed.signature, unexpected: true },
    }, publicKeyPem), false);
    assert.equal(verifyMapDeliveryReleaseSignature({
      ...signed,
      approvalGates: {
        ...signed.approvalGates,
        signature: { ...signed.approvalGates.signature, unexpected: true },
      },
    }, publicKeyPem), false);
    for (const invalidUnsigned of [
      { ...result.release, approvalGates: { ...result.release.approvalGates, signature: { status: "missing" } } },
      { ...result.release, approvalGates: { ...result.release.approvalGates, signature: { status: "missing", reason: "   " } } },
      { ...result.release, approvalGates: { ...result.release.approvalGates, signature: { ...result.release.approvalGates.signature, unexpected: true } } },
      (() => { const value = { ...result.release }; delete value.releaseHash; return value; })(),
      { ...result.release, releaseHash: HASH_A },
    ]) {
      assert.throws(
        () => signMapDeliveryRelease(invalidUnsigned, privateKey.export({ type: "pkcs8", format: "pem" }), "delivery-2026"),
        /Unsigniertes Delivery-v2-Signaturgate|Grund, null-Releasehash und null-Signatur/u,
      );
    }
    const output = join(root, "public-output", "release.signed.json");
    assert.equal(await writeSignedMapDeliveryRelease(signed, output), "written");
    assert.equal(await writeSignedMapDeliveryRelease(signed, output), "reused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("öffentlicher Quellenvertrag verwirft interne Validierungsnamen", () => {
  const unsafe = infraRelease();
  unsafe.sources[0].attribution = "interne APN Validierung";
  assert.throws(
    () => buildMapDeliverySources({ releaseId: unsafe.releaseId, infraRelease: unsafe, mapRelease: mapRelease() }),
    /interne Validierungsreferenz/,
  );
});

test("ReadModel-Beleg und gebundene Operational-v2-Datei werden bytegenau geprüft", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      buildMapDeliveryRelease({
        releaseId: "infra-deutschland-2026.1",
        timetableYear: 2026,
        packageSpec: packageSpec(),
        sourceRoot: root,
        infraRelease: materializedInfraRelease(),
        mapRelease: materializedMapRelease(),
        auxiliaryArtifactProofs: [
          { id: "readmodel", bytes: SQLITE_BYTES.length + 1, sha256: SQLITE_SHA256 },
        ],
      }),
      /belegten Bytezahl/,
    );

    await writeFile(join(root, "public", "read-model.sqlite"), Buffer.from("SQLite format 2\0"));
    await assert.rejects(
      buildMapDeliveryRelease({
        releaseId: "infra-deutschland-2026.1",
        timetableYear: 2026,
        packageSpec: packageSpec(),
        sourceRoot: root,
        infraRelease: materializedInfraRelease(),
        mapRelease: materializedMapRelease(),
        auxiliaryArtifactProofs: [
          { id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 },
        ],
      }),
      /belegten SHA-256/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Delivery verwirft eine gleich grosse Quelldateiaenderung nach dem Handle-Lesen", async (context) => {
  const root = await fixture();
  const target = join(root, "basemap.pmtiles");
  const probe = await open(target, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalRead = fileHandlePrototype.read;
  await probe.close();
  let changed = false;
  context.mock.method(fileHandlePrototype, "read", async function (...arguments_) {
    const result = await originalRead.apply(this, arguments_);
    if (!changed) {
      changed = true;
      await writeFile(target, Buffer.from("basemap-evil!!"));
      await utimes(target, new Date("2001-01-01T00:00:00.000Z"), new Date("2001-01-01T00:00:00.000Z"));
    }
    return result;
  });
  try {
    await assert.rejects(
      buildMapDeliveryRelease({
        releaseId: "infra-deutschland-2026.1",
        timetableYear: 2026,
        packageSpec: packageSpec(),
        sourceRoot: root,
        infraRelease: materializedInfraRelease(),
        mapRelease: materializedMapRelease(),
        auxiliaryArtifactProofs: [
          { id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 },
        ],
      }),
      /basemap\.sourceFile änderte sich während des Lesens/,
    );
    assert.equal(changed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Delivery verwirft eine gleich grosse Ersetzung zwischen Qualitaetsvalidierung und Inventar", async (context) => {
  const root = await fixture();
  const target = join(root, "public", "quality.json");
  const replacement = join(root, "public", "quality.replacement.json");
  const originalBytes = await readFile(target);
  const replacementBytes = Buffer.from(originalBytes);
  const releaseNeedle = Buffer.from("infra-deutschland-2026.1", "utf8");
  const releaseOffset = replacementBytes.indexOf(releaseNeedle);
  assert.notEqual(releaseOffset, -1);
  replacementBytes[releaseOffset + releaseNeedle.length - 1] = "2".charCodeAt(0);
  assert.equal(replacementBytes.length, originalBytes.length);
  await writeFile(replacement, replacementBytes);

  const probe = await open(target, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalReadFile = fileHandlePrototype.readFile;
  await probe.close();
  let replaced = false;
  context.mock.method(fileHandlePrototype, "readFile", async function (...arguments_) {
    const result = await originalReadFile.apply(this, arguments_);
    const originalClose = this.close.bind(this);
    this.close = async (...closeArguments) => {
      const closeResult = await originalClose(...closeArguments);
      if (!replaced) {
        replaced = true;
        await rm(target);
        await rename(replacement, target);
      }
      return closeResult;
    };
    return result;
  });

  try {
    await assert.rejects(
      buildMapDeliveryRelease({
        releaseId: "infra-deutschland-2026.1",
        timetableYear: 2026,
        packageSpec: packageSpec(),
        sourceRoot: root,
        infraRelease: materializedInfraRelease(),
        mapRelease: materializedMapRelease(),
        auxiliaryArtifactProofs: [
          { id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 },
        ],
      }),
      /zwischen Validierung und Inventarisierung/u,
    );
    assert.equal(replaced, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Delivery verwirft abweichende Operational-v2- und Sidecar-Bindungen des InfraRelease", async () => {
  const root = await fixture();
  try {
    const forgedPackage = packageSpec();
    forgedPackage.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2").stateHash = "e".repeat(64);
    await assert.rejects(
      buildMapDeliveryRelease({
        releaseId: "infra-deutschland-2026.1",
        timetableYear: 2026,
        packageSpec: forgedPackage,
        sourceRoot: root,
        infraRelease: materializedInfraRelease(),
        mapRelease: materializedMapRelease(),
        auxiliaryArtifactProofs: [{ id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 }],
      }),
      /Zustandsbindung des InfraRelease/,
    );

    const forgedMovementBinding = infraRelease();
    forgedMovementBinding.artifacts.find(({ kind }) => kind === "movement-route-templates-v2").file = "movement-routes-substituted.json";
    await assert.rejects(
      buildMapDeliveryRelease({
        releaseId: "infra-deutschland-2026.1",
        timetableYear: 2026,
        packageSpec: packageSpec(),
        sourceRoot: root,
        infraRelease: materialized(forgedMovementBinding),
        mapRelease: materializedMapRelease(),
        auxiliaryArtifactProofs: [{ id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 }],
      }),
      /Movement-Route-Templates-v2-Paketdatei weicht von der Bytebindung des InfraRelease/,
    );

    const forgedTransferPackage = packageSpec();
    forgedTransferPackage.auxiliaryFiles.find(({ kind }) => kind === "timetable-transfer-demands-v2").expectedSha256 = "e".repeat(64);
    await assert.rejects(
      buildMapDeliveryRelease({
        releaseId: "infra-deutschland-2026.1",
        timetableYear: 2026,
        packageSpec: forgedTransferPackage,
        sourceRoot: root,
        infraRelease: materializedInfraRelease(),
        mapRelease: materializedMapRelease(),
        auxiliaryArtifactProofs: [{ id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 }],
      }),
      /Timetable-Transfer-Demands-v2-Paketdatei weicht von der Bytebindung des InfraRelease/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Operational-v2-Delivery lässt sichtbare Karten-C ehrlich stehen und verwirft offene oder umdeklarierte Operational-Qualität", async () => {
  const root = await fixture();
  try {
    const qualityPath = join(root, "public", "quality.json");
    const build = (reportForClosure = operationalQuality()) => buildMapDeliveryRelease({
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      packageSpec: packageSpec(),
      sourceRoot: root,
      infraRelease: materialized(infraRelease(reportForClosure)),
      mapRelease: materializedMapRelease(),
      auxiliaryArtifactProofs: [{ id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 }],
    });

    const legacyDetail = quality();
    await writeFile(qualityPath, serializeDeliveryJson(legacyDetail));
    await assert.rejects(build(), /Operational-v2-Qualitätsbericht besitzt unerwartete oder fehlende Felder/);

    const operationalC = operationalQuality();
    operationalC.summary.operationalQualityClassArtifactCount.B = 0;
    operationalC.summary.operationalQualityClassArtifactCount.C = 1;
    await writeFile(qualityPath, serializeDeliveryJson(operationalC));
    await assert.rejects(build(operationalC), /keine getrennte geschlossene B=1\/C=0-Bilanz/);

    const hiddenMapC = operationalQuality();
    hiddenMapC.summary.visibleMapClassCFeatureCount = 0;
    await writeFile(qualityPath, serializeDeliveryJson(hiddenMapC));
    await assert.rejects(build(hiddenMapC), /verschweigt sichtbare Karten-C/);

    const reclassified = operationalQuality();
    reclassified.separation.mapClassCReclassified = true;
    await writeFile(qualityPath, serializeDeliveryJson(reclassified));
    await assert.rejects(build(reclassified), /deklariert sichtbare Karten-C um/);

    const unverified = operationalQuality();
    unverified.qualityGate.closureReceiptVerified = false;
    await writeFile(qualityPath, serializeDeliveryJson(unverified));
    await assert.rejects(build(unverified), /Qualitätsgate ist offen/);

    const externalNetwork = operationalQuality();
    externalNetwork.operationalModel.timetableRouteEvidence.externalOperationalNetworkProvenance = true;
    await writeFile(qualityPath, serializeDeliveryJson(externalNetwork));
    await assert.rejects(build(externalNetwork), /ehrliche Geometrie-\/Provenienzgrenze/);

    const incompleteTransfers = operationalQuality();
    incompleteTransfers.operationalModel.timetableRouteEvidence.transferRouteCount = 2;
    await writeFile(qualityPath, serializeDeliveryJson(incompleteTransfers));
    await assert.rejects(build(incompleteTransfers), /Tagesumlauf-\/Transferabdeckung/);

    const legacyTransferSchema = operationalQuality();
    legacyTransferSchema.operationalModel.timetableRouteEvidence.transferDemandsSchema = "zugfolge-timetable-transfer-demands/v1";
    await writeFile(qualityPath, serializeDeliveryJson(legacyTransferSchema));
    await assert.rejects(build(legacyTransferSchema), /v4-Fahrweg-\/V2-Transfervertrag/);

    const mismatchedJourneyChains = operationalQuality();
    mismatchedJourneyChains.operationalModel.timetableRouteEvidence.dailyCirculation.journeyChainCount = 5;
    await writeFile(qualityPath, serializeDeliveryJson(mismatchedJourneyChains));
    await assert.rejects(build(mismatchedJourneyChains), /Tagesumlauf-\/Transferabdeckung/);

    const mismatchedMovement = operationalQuality();
    mismatchedMovement.operationalModel.movementRouteTemplates.sha256 = "e".repeat(64);
    await writeFile(qualityPath, serializeDeliveryJson(mismatchedMovement));
    await assert.rejects(build(mismatchedMovement), /verschiedene Movement-Route-Templates-v2-Bytes/);

    const mismatchedArtifact = operationalQuality();
    mismatchedArtifact.operationalModel.operationalArtifact.stateHash = "e".repeat(64);
    mismatchedArtifact.operationalModel.movementRouteTemplates.operationalStateHash = "e".repeat(64);
    await writeFile(qualityPath, serializeDeliveryJson(mismatchedArtifact));
    await assert.rejects(build(mismatchedArtifact), /verschiedene Operational-Artefaktbytes oder Zustände/);

    const substitutedReport = operationalQuality();
    substitutedReport.mapEvidence.mapReleaseId = "karte-deutschland-substituiert-v2";
    await writeFile(qualityPath, serializeDeliveryJson(substitutedReport));
    await assert.rejects(build(), /kanonischen Rust-InfraRelease-Closure-Bindung/);

    const byteSubstitutedReport = operationalQuality();
    await writeFile(qualityPath, Buffer.concat([serializeDeliveryJson(byteSubstitutedReport), Buffer.from("\n")]));
    await assert.rejects(build(byteSubstitutedReport), /kanonischen Rust-InfraRelease-Closure-Bindung/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Operational-v2-Delivery verlangt kanonisch releaseHash-gebundene Infra- und Kartenrelease-Huellen", async () => {
  const root = await fixture();
  try {
    const common = {
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      packageSpec: packageSpec(),
      sourceRoot: root,
      auxiliaryArtifactProofs: [{ id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 }],
    };
    await assert.rejects(
      buildMapDeliveryRelease({ ...common, infraRelease: infraRelease(), mapRelease: materializedMapRelease() }),
      /releaseHash-gebundene Huelle/,
    );

    const forgedMap = materializedMapRelease();
    forgedMap.release.releaseId = "map-substituiert";
    await assert.rejects(
      buildMapDeliveryRelease({ ...common, infraRelease: materializedInfraRelease(), mapRelease: forgedMap }),
      /kanonischen Releaseinhalt nicht/,
    );

    const foreignMap = materialized({ ...mapRelease(), releaseId: "map-substituiert" });
    await assert.rejects(
      buildMapDeliveryRelease({ ...common, infraRelease: materializedInfraRelease(), mapRelease: foreignMap }),
      /Kartenrelease und Delivery-v2 nennen verschiedene Release-IDs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Delivery verwirft Quellwurzel- und Zwischenpfad-Symlinks plattformunabhaengig", async () => {
  const source = await fixture();
  const wrapper = await mkdtemp(join(tmpdir(), "zugfolge-delivery-link-wrapper-"));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    const linkedRoot = join(wrapper, "linked-root");
    await symlink(source, linkedRoot, linkType);
    const common = {
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      infraRelease: materializedInfraRelease(),
      mapRelease: materializedMapRelease(),
      auxiliaryArtifactProofs: [
        { id: "readmodel", bytes: SQLITE_BYTES.length, sha256: SQLITE_SHA256 },
      ],
    };
    await assert.rejects(
      buildMapDeliveryRelease({ ...common, packageSpec: packageSpec(), sourceRoot: linkedRoot }),
      /Quellwurzel muss ein reguläres Verzeichnis ohne symbolischen Link/,
    );

    const realParent = join(wrapper, "real-parent");
    await mkdir(join(realParent, "release"), { recursive: true });
    const linkedParent = join(wrapper, "linked-parent");
    await symlink(realParent, linkedParent, linkType);
    await assert.rejects(
      buildMapDeliveryRelease({
        ...common,
        packageSpec: packageSpec(),
        sourceRoot: join(linkedParent, "release"),
      }),
      /Pfadbestandteile duerfen keine Symlinks oder Junctions/,
    );

    const intermediate = join(source, "intermediate");
    await symlink(source, intermediate, linkType);
    const qualityLinkedSpec = packageSpec();
    const qualityDescriptor = qualityLinkedSpec.auxiliaryFiles.find(({ kind }) => kind === "quality-manifest");
    qualityDescriptor.sourceFile = `intermediate/${qualityDescriptor.sourceFile}`;
    await assert.rejects(
      buildMapDeliveryRelease({ ...common, packageSpec: qualityLinkedSpec, sourceRoot: source }),
      /darf keinen symbolischen Link enthalten/,
    );

    const inventoryLinkedSpec = packageSpec();
    inventoryLinkedSpec.artifacts[0].sourceFile = `intermediate/${inventoryLinkedSpec.artifacts[0].sourceFile}`;
    await assert.rejects(
      buildMapDeliveryRelease({ ...common, packageSpec: inventoryLinkedSpec, sourceRoot: source }),
      /darf keinen symbolischen Link enthalten/,
    );
  } finally {
    await rm(wrapper, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
