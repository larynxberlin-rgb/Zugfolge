import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildMapDeliveryRelease,
  inventoryMapDeliveryPackageArtifacts,
  serializeDeliveryJson,
  signMapDeliveryRelease,
  deliveryReleaseHash,
} from "./map-delivery-release.mjs";
import { buildMapAssetTreeProof } from "./map-asset-notices.mjs";
import {
  BASEMAP_VECTOR_LAYERS,
  expandMapPackagePlan,
  INFRASTRUCTURE_VECTOR_LAYERS,
} from "./map-package.mjs";
import {
  deriveSignedMapPackagePlan,
  deriveSignedReleaseSourceFile,
  writeSignedMapPackagePlan,
} from "./signed-map-package-plan.mjs";

const UNSIGNED_RELEASE = "release/delivery-unsigned/release.json";
const SIGNED_RELEASE = "release/public/release.json";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const QUALITY_LAYER_NAMES = [
  "rail_corridors", "operating_points", "stations", "tracks", "platforms",
  "switches", "signals", "blocks", "conflict_resources", "rail_context",
];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function withoutBytePins(spec) {
  const result = structuredClone(spec);
  for (const descriptor of [...result.artifacts, ...result.auxiliaryFiles]) {
    delete descriptor.expectedBytes;
    delete descriptor.expectedSha256;
  }
  return result;
}

function materialized(release) {
  return {
    release,
    releaseHash: digest(Buffer.from(JSON.stringify(sortedValue(release)), "utf8")),
  };
}

function notice(text) {
  return { text, bytes: Buffer.byteLength(text), sha256: digest(Buffer.from(text, "utf8")) };
}

function fixtureAssetNotices(artifacts) {
  const notoCopyright = "Copyright 2022 The Noto Project Authors (https://github.com/notofonts)";
  const spriteCopyright = "Copyright (c) 2017 Mapzen";
  return {
    schema: "zugfolge-map-asset-notices/v2",
    assets: [
      {
        id: "noto-glyphs", rightsSourceId: "noto-glyphs", kind: "glyph", license: "OFL-1.1", copyright: notoCopyright,
        modifications: "PBF-Glyphen werden unveraendert selbst gehostet.", source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "fonts" }, derivedFrom: null,
        notice: { url: `https://raw.githubusercontent.com/protomaps/basemaps-assets/${"a".repeat(40)}/fonts/OFL.txt`, ...notice(`${notoCopyright}\nSIL OPEN FONT LICENSE Version 1.1\n`) },
        tree: buildMapAssetTreeProof("glyph", "assets/fonts", artifacts),
      },
      {
        id: "protomaps-sprites", rightsSourceId: "protomaps-sprites", kind: "sprite", license: "MIT", copyright: spriteCopyright,
        modifications: "Dunkle Sprites werden unveraendert selbst gehostet.", source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "sprites/v4" }, derivedFrom: { repository: "https://github.com/tangrams/icons", commit: "b".repeat(40), license: "MIT" },
        notice: { url: `https://raw.githubusercontent.com/tangrams/icons/${"b".repeat(40)}/LICENSE.md`, ...notice(`The MIT License (MIT)\n${spriteCopyright}\n`) },
        tree: buildMapAssetTreeProof("sprite", "assets/sprites", artifacts),
      },
    ],
  };
}

function operationalQuality(operationalBytes, operationalSha256, stateHash, movementRoutesBytes, movementRoutesSha256, transferDemandsBytes, transferDemandsSha256) {
  return {
    schema: "zugfolge-operational-infrastructure-quality-report/v1",
    releaseId: "infra-test",
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
      mapReleaseId: "infra-test",
      infrastructureCorpusId: "infra-test",
      bytes: 4321,
      sha256: HASH_A,
      sourceReport: { schema: "zugfolge-final-infrastructure-quality-report/v1", bytes: 9876, sha256: HASH_B, shipped: false },
      visibleFeatures: 42,
      visibleLayers: QUALITY_LAYER_NAMES.length,
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
        bytes: movementRoutesBytes,
        sha256: movementRoutesSha256,
        stateHash: HASH_C,
        operationalStateHash: stateHash,
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
        transferDemandsBytes,
        transferDemandsSha256,
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
          lotCount: 1,
          journeyChainCount: 4,
          circulationCount: 2,
          rolloverAssignmentCount: 2,
          plannedTransitionCount: 4,
          turnaroundDemandCount: 3,
          transferDemandCount: 1,
          transferLotCount: 1,
        },
        transferRouteCount: 1,
        transferRouteLegCount: 2,
        transferRouteLengthMm: 1000,
        realGeometry: true,
        simulatedOperationalAssignment: true,
        realInterlockingFactsClaimed: false,
        externalOperationalNetworkProvenance: false,
      },
      operationalArtifact: { bytes: operationalBytes, sha256: operationalSha256, stateHash },
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

function plan(releaseBinding = {}) {
  return {
    schema: "zugfolge-map-package-plan/v2",
    packageId: "zugfolge-map-test",
    version: "2026.3",
    partBytes: 104857600,
    runtime: {
      schema: "zugfolge-map-runtime/v2",
      publicBasePath: "/artifacts/maps/infra-test",
      basemapStyleUrl: "/artifacts/maps/infra-test/style.json",
      infrastructurePmtilesUrl: "/artifacts/maps/infra-test/infra.pmtiles",
    },
    artifacts: [
      {
        id: "basemap",
        kind: "basemap",
        sourceFile: "artifacts/basemap.pmtiles",
        installPath: "basemap.pmtiles",
        expectedVectorLayers: BASEMAP_VECTOR_LAYERS,
      },
      {
        id: "infrastructure",
        kind: "infrastructure",
        sourceFile: "artifacts/infra.pmtiles",
        installPath: "infra.pmtiles",
        expectedVectorLayers: INFRASTRUCTURE_VECTOR_LAYERS,
      },
    ],
    auxiliaryFiles: [
      {
        id: "quality-manifest",
        kind: "quality-manifest",
        visibility: "public",
        sourceFile: "release/quality.json",
        installPath: "manifests/quality.json",
      },
      {
        id: "read-model",
        kind: "read-model",
        visibility: "public",
        sourceFile: "release/read-model.sqlite",
        installPath: "read-model.sqlite",
      },
      {
        id: "release-manifest",
        kind: "release-manifest",
        visibility: "public",
        sourceFile: UNSIGNED_RELEASE,
        installPath: "manifests/release.json",
        ...releaseBinding,
      },
      {
        id: "source-manifest",
        kind: "source-manifest",
        visibility: "public",
        sourceFile: "release/delivery-unsigned/sources.json",
        installPath: "manifests/sources.json",
      },
      {
        id: "operational-infrastructure-test",
        kind: "operational-infrastructure-v2",
        visibility: "public",
        sourceFile: "release/operational-infrastructure-v2.json",
        installPath: "operational-infrastructure-v2.json",
        artifactInventory: "release/release-artifacts.v2.json",
      },
      {
        id: "operational-movement-routes-test",
        kind: "movement-route-templates-v2",
        visibility: "public",
        sourceFile: "release/operational-infrastructure-v2.movement-route-templates-v2.json",
        installPath: "operational-infrastructure-v2.movement-route-templates-v2.json",
        artifactInventory: "release/release-artifacts.v2.json",
      },
      {
        id: "timetable-transfer-demands-test",
        kind: "timetable-transfer-demands-v2",
        visibility: "public",
        sourceFile: "release/timetable-routes-v2.transfer-demands-v2.json",
        installPath: "timetable-routes-v2.transfer-demands-v2.json",
        artifactInventory: "release/release-artifacts.v2.json",
      },
      {
        id: "style",
        kind: "style",
        visibility: "public",
        sourceFile: "release/style.json",
        installPath: "style.json",
      },
    ],
    auxiliaryTrees: [
      {
        idPrefix: "glyph",
        kind: "glyph",
        visibility: "public",
        sourceDirectory: "assets/fonts",
        installDirectory: "assets/fonts",
        expectedInventory: { "Test Font": 1 },
      },
      {
        idPrefix: "sprite",
        kind: "sprite",
        visibility: "public",
        sourceDirectory: "assets/sprites",
        installDirectory: "assets/sprites",
        expectedInventory: { "dark.json": 1, "dark.png": 1 },
      },
    ],
  };
}

async function fixture({ pinUnsigned = false, transformUnsigned, transformSigned } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-signed-plan-"));
  const unsignedPlan = plan();
  const operationalBytes = Buffer.from('{"schema":"zugfolge-operational-infrastructure/v2"}\n', "utf8");
  const movementRoutesBytes = Buffer.from('{"infraReleaseId":"infra-test","schema":"movement-route-templates-v2"}\n', "utf8");
  const transferDemandsBytes = Buffer.from('{"infraReleaseId":"infra-test","schema":"zugfolge-timetable-transfer-demands/v2"}\n', "utf8");
  const operationalStateHash = "b".repeat(64);
  const qualityReport = operationalQuality(
    operationalBytes.length,
    digest(operationalBytes),
    operationalStateHash,
    movementRoutesBytes.length,
    digest(movementRoutesBytes),
    transferDemandsBytes.length,
    digest(transferDemandsBytes),
  );
  const qualityBytes = serializeDeliveryJson(qualityReport);
  await Promise.all([
    mkdir(join(root, "artifacts"), { recursive: true }),
    mkdir(join(root, "release", "delivery-unsigned"), { recursive: true }),
    mkdir(join(root, "release", "public"), { recursive: true }),
    mkdir(join(root, "assets", "fonts", "Test Font"), { recursive: true }),
    mkdir(join(root, "assets", "sprites"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "artifacts", "basemap.pmtiles"), Buffer.alloc(256, 0x62)),
    writeFile(join(root, "artifacts", "infra.pmtiles"), Buffer.alloc(256, 0x69)),
    writeFile(join(root, "assets", "fonts", "Test Font", "0-255.pbf"), Buffer.from([1, 2, 3])),
    writeFile(join(root, "assets", "sprites", "dark.json"), "{}\n", "utf8"),
    writeFile(join(root, "assets", "sprites", "dark.png"), Buffer.from([137, 80, 78, 71])),
    writeFile(join(root, "release", "quality.json"), qualityBytes),
    writeFile(join(root, "release", "read-model.sqlite"), Buffer.from("SQLite format 3\0current", "utf8")),
    writeFile(join(root, "release", "operational-infrastructure-v2.json"), operationalBytes),
    writeFile(join(root, "release", "operational-infrastructure-v2.movement-route-templates-v2.json"), movementRoutesBytes),
    writeFile(join(root, "release", "timetable-routes-v2.transfer-demands-v2.json"), transferDemandsBytes),
    writeFile(join(root, "release", "style.json"), "{\"version\":8}\n", "utf8"),
    writeFile(join(root, "release", "release-artifacts.v2.json"), `${JSON.stringify({
      schema: "zugfolge-infra-release-artifacts/v2",
      artifacts: [{
        id: "operational-infrastructure-test",
        kind: "operational-infrastructure-v2",
        file: "operational-infrastructure-v2.json",
        infraReleaseId: "infra-test",
        bytes: operationalBytes.length,
        sha256: digest(operationalBytes),
        stateHash: operationalStateHash,
      }, {
        id: "operational-movement-routes-test",
        kind: "movement-route-templates-v2",
        file: "operational-infrastructure-v2.movement-route-templates-v2.json",
        bytes: movementRoutesBytes.length,
        sha256: digest(movementRoutesBytes),
      }, {
        id: "timetable-transfer-demands-test",
        kind: "timetable-transfer-demands-v2",
        file: "timetable-routes-v2.transfer-demands-v2.json",
        bytes: transferDemandsBytes.length,
        sha256: digest(transferDemandsBytes),
      }],
    }, null, 2)}\n`, "utf8"),
  ]);

  const expanded = await expandMapPackagePlan(unsignedPlan, root);
  const artifacts = await inventoryMapDeliveryPackageArtifacts({ packageSpec: expanded, sourceRoot: root });
  const current = (kind) => {
    const matches = artifacts.filter((artifact) => artifact.kind === kind);
    assert.equal(matches.length, 1, `Fixture braucht genau ein ${kind}-Artefakt.`);
    return matches[0];
  };
  const basemap = current("basemap");
  const infrastructure = current("infrastructure");
  const quality = current("quality-manifest");
  const readModel = current("read-model");
  const operational = current("operational-infrastructure-v2");
  const movementRoutes = current("movement-route-templates-v2");
  const transferDemands = current("timetable-transfer-demands-v2");
  const infraWrapper = materialized({
    schema: "zugfolge-infra-release/v2",
    releaseId: "infra-test",
    timetableYear: 2026,
    sources: [{
      id: "official-infrastructure",
      version: "2026-test",
      sourceLicense: "CC-BY-4.0",
      attribution: "Datenquelle DB InfraGO, CC BY 4.0; durch Zugfolge bearbeitet.",
      modifications: "Normalisiert und konservativ modelliert.",
    }],
    artifacts: [
      { id: "infra-release-infrastructure", kind: "infrastructure", file: "infra.pmtiles", bytes: infrastructure.bytes, sha256: infrastructure.sha256 },
      { id: "infra-release-read-model", kind: "read-model", file: "read-model.sqlite", bytes: readModel.bytes, sha256: readModel.sha256 },
      {
        id: operational.id,
        kind: operational.kind,
        file: "operational-infrastructure-v2.json",
        infraReleaseId: operational.infraReleaseId,
        stateHash: operational.stateHash,
        bytes: operational.bytes,
        sha256: operational.sha256,
      },
      {
        id: movementRoutes.id,
        kind: movementRoutes.kind,
        file: "operational-infrastructure-v2.movement-route-templates-v2.json",
        bytes: movementRoutes.bytes,
        sha256: movementRoutes.sha256,
      },
      {
        id: transferDemands.id,
        kind: transferDemands.kind,
        file: "timetable-routes-v2.transfer-demands-v2.json",
        bytes: transferDemands.bytes,
        sha256: transferDemands.sha256,
      },
      { id: "infra-release-quality", kind: "quality-report", file: "quality.json", bytes: quality.bytes, sha256: quality.sha256 },
    ],
    quality: {
      operationalClosure: {
        reportSha256: quality.sha256,
        policyId: qualityReport.operationalModel.policyId,
        policySha256: qualityReport.operationalModel.policySha256,
        closureReceiptSha256: qualityReport.operationalModel.closureReceiptSha256,
        qualityClass: "B",
        provenance: "derived",
        candidateBytes: qualityReport.operationalModel.operationalArtifact.bytes,
        candidateSha256: qualityReport.operationalModel.operationalArtifact.sha256,
        candidateStateHash: qualityReport.operationalModel.operationalArtifact.stateHash,
        staticMapQualityBytes: qualityReport.mapEvidence.bytes,
        staticMapQualitySha256: qualityReport.mapEvidence.sha256,
        staticMapSourceReportSha256: qualityReport.mapEvidence.sourceReport.sha256,
        realInterlockingFactsClaimed: false,
        syntheticOperationalDetailsShipped: true,
        objectLevelProvenanceShipped: false,
        observedAndSyntheticObjectsShareRuntimeCollections: true,
        movementRouteTemplates: structuredClone(qualityReport.operationalModel.movementRouteTemplates),
        timetableRouteEvidence: structuredClone(qualityReport.operationalModel.timetableRouteEvidence),
        operationalQualityEligible: true,
        signatureImplied: false,
        activationImplied: false,
        unresolvedRequired: 0,
      },
    },
  });
  const mapWrapper = materialized({
    schema: "zugfolge-map-release/v1",
    releaseId: "infra-test",
    sources: [{
      id: "protomaps-daily-basemap",
      version: "2026-test",
      sourceLicense: "ODbL-1.0 Produced Work",
      attribution: "OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps; weitere Bearbeitung durch Zugfolge.",
      modifications: "Welt und Deutschlanddetail zusammengefuehrt.",
    }],
    artifacts: [
      { id: "map-basemap", kind: "basemap", bytes: basemap.bytes, sha256: basemap.sha256 },
      { id: "map-infrastructure", kind: "infrastructure", bytes: infrastructure.bytes, sha256: infrastructure.sha256 },
    ],
    assetInventoryPlanSha256: HASH_C,
    assetNotices: fixtureAssetNotices(artifacts),
  });
  const built = await buildMapDeliveryRelease({
    releaseId: "infra-test",
    timetableYear: 2026,
    packageSpec: expanded,
    sourceRoot: root,
    infraRelease: infraWrapper,
    mapRelease: mapWrapper,
    auxiliaryArtifactProofs: [{ id: readModel.id, bytes: readModel.bytes, sha256: readModel.sha256 }],
  });
  const sourcesBytes = built.sourcesBytes;
  await Promise.all([
    writeFile(join(root, "release", "public", "infra-release.json"), serializeDeliveryJson(infraWrapper)),
    writeFile(join(root, "release", "public", "map-release.json"), serializeDeliveryJson(mapWrapper)),
    writeFile(join(root, "release", "delivery-unsigned", "sources.json"), sourcesBytes),
  ]);

  const unsignedSource = built.release;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { publicKey: alphaWorldPublicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
  const deliveryPublicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const alphaWorldPublicKeyPem = alphaWorldPublicKey.export({ format: "pem", type: "spki" });
  let signed = signMapDeliveryRelease(
    unsignedSource,
    privateKeyPem,
    "test-delivery-key",
  );
  const unsigned = transformUnsigned === undefined ? unsignedSource : transformUnsigned(unsignedSource);
  const unsignedBytes = serializeDeliveryJson(unsigned);
  if (transformSigned !== undefined) signed = transformSigned(signed);
  const signedBytes = serializeDeliveryJson(signed);
  await Promise.all([
    writeFile(join(root, ...UNSIGNED_RELEASE.split("/")), unsignedBytes),
    writeFile(join(root, ...SIGNED_RELEASE.split("/")), signedBytes),
    writeFile(join(root, "trusted-delivery-keys.json"), `${JSON.stringify({
      "test-alpha-world-key": alphaWorldPublicKeyPem,
      "test-delivery-key": deliveryPublicKeyPem,
    }, null, 2)}\n`, "utf8"),
    writeFile(join(root, "trusted-delivery-key-scopes.json"), `${JSON.stringify({
      alphaWorldDeployments: ["test-alpha-world-key"],
      mapInfraDeliveries: ["test-delivery-key"],
    }, null, 2)}\n`, "utf8"),
  ]);
  if (pinUnsigned) {
    Object.assign(unsignedPlan.auxiliaryFiles.find(({ kind }) => kind === "release-manifest"), {
      expectedBytes: unsignedBytes.length,
      expectedSha256: digest(unsignedBytes),
    });
  }
  return {
    root,
    unsignedPlan,
    unsignedBytes,
    signedBytes,
    trustedKeysSourceFile: "trusted-delivery-keys.json",
    trustedKeyScopesSourceFile: "trusted-delivery-key-scopes.json",
    alphaWorldPublicKeyPem,
    deliveryPublicKeyPem,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function rewriteSignedFixture(context, unsignedRelease) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signedRelease = signMapDeliveryRelease(
    unsignedRelease,
    privateKey.export({ format: "pem", type: "pkcs8" }),
    "test-delivery-key",
  );
  await Promise.all([
    writeFile(join(context.root, ...UNSIGNED_RELEASE.split("/")), serializeDeliveryJson(unsignedRelease)),
    writeFile(join(context.root, ...SIGNED_RELEASE.split("/")), serializeDeliveryJson(signedRelease)),
    writeFile(join(context.root, "trusted-delivery-keys.json"), `${JSON.stringify({
      "test-alpha-world-key": context.alphaWorldPublicKeyPem,
      "test-delivery-key": publicKey.export({ format: "pem", type: "spki" }),
    }, null, 2)}\n`, "utf8"),
  ]);
}

test("leitet den Signed-Plan reproduzierbar mit unveraendertem Runtime-v2-Vertrag ab", async () => {
  const context = await fixture();
  try {
    const derived = await deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile);
    assert.equal(derived.plan.schema, "zugfolge-map-package-spec/v2");
    assert.equal(derived.plan.runtime.schema, "zugfolge-map-runtime/v2");
    assert.equal(
      [...derived.plan.artifacts, ...derived.plan.auxiliaryFiles].every(({ expectedBytes, expectedSha256 }) => (
        Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && /^[a-f0-9]{64}$/.test(expectedSha256)
      )),
      true,
      "Der signierte Paketvertrag muss jede expandierte Datei bytegenau pinnen.",
    );
    const expandedUnsigned = await expandMapPackagePlan(context.unsignedPlan, context.root);
    const signedSemantics = withoutBytePins(derived.plan);
    signedSemantics.auxiliaryFiles.find(({ kind }) => kind === "release-manifest").sourceFile = UNSIGNED_RELEASE;
    assert.deepEqual(
      signedSemantics,
      withoutBytePins(expandedUnsigned),
      "Expansion und Vollpinnung duerfen neben der Releasequelle keinen fachlichen Inhalt aendern.",
    );
    const descriptor = derived.plan.auxiliaryFiles.find(({ kind }) => kind === "release-manifest");
    assert.equal(descriptor.sourceFile, SIGNED_RELEASE);
    assert.equal(descriptor.expectedBytes, context.signedBytes.length);
    assert.equal(descriptor.expectedSha256, digest(context.signedBytes));
    assert.equal(derived.signedReleaseBytes, context.signedBytes.length);
    assert.equal(derived.signedReleaseSha256, digest(context.signedBytes));
    const transferDescriptor = derived.plan.auxiliaryFiles.find(({ kind }) => kind === "timetable-transfer-demands-v2");
    const transferBytes = await readFile(join(context.root, "release", "timetable-routes-v2.transfer-demands-v2.json"));
    assert.equal(transferDescriptor?.installPath, "timetable-routes-v2.transfer-demands-v2.json");
    assert.equal(transferDescriptor?.sourceFile, "release/timetable-routes-v2.transfer-demands-v2.json");
    assert.equal(transferDescriptor?.expectedBytes, transferBytes.length);
    assert.equal(transferDescriptor?.expectedSha256, digest(transferBytes));
    assert.equal(JSON.parse(transferBytes).schema, "zugfolge-timetable-transfer-demands/v2");

    const output = join(context.root, "derived", "signed-package-plan.json");
    const first = await writeSignedMapPackagePlan(derived.plan, output);
    const second = await writeSignedMapPackagePlan(derived.plan, output);
    assert.equal(first.status, "written");
    assert.equal(second.status, "reused");
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), derived.plan);
    await writeFile(output, "{}\n", "utf8");
    await assert.rejects(writeSignedMapPackagePlan(derived.plan, output), /abweichendem Signed-Paketplan/u);
  } finally {
    await context.cleanup();
  }
});

test("verwirft Transfer-v1-Kind und -Datei im unsigned Plan ohne Fallback", async () => {
  const context = await fixture();
  try {
    const transfer = context.unsignedPlan.auxiliaryFiles.find(({ kind }) => kind === "timetable-transfer-demands-v2");
    transfer.kind = "timetable-transfer-demands-v1";
    transfer.sourceFile = "release/timetable-routes-v2.transfer-demands-v1.json";
    transfer.installPath = "timetable-routes-v2.transfer-demands-v1.json";
    await assert.rejects(
      deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile),
      /Timetable-Transfer-Demands-v2/u,
    );
  } finally {
    await context.cleanup();
  }
});

test("verwirft einen stale Deliveryvertrag gegen das aktuelle expandierte Paketinventar", async () => {
  const context = await fixture();
  try {
    await writeFile(join(context.root, "release", "quality.json"), "{\"quality\":\"changed-after-delivery\"}\n", "utf8");
    await assert.rejects(
      deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile),
      /aktuellen expandierten Paketinventar/u,
    );
  } finally {
    await context.cleanup();
  }
});

test("verwirft einen fremden Kartenrelease trotz konsistent aktualisierter Huelle und Delivery-Signatur", async () => {
  const context = await fixture();
  try {
    const mapPath = join(context.root, "release", "public", "map-release.json");
    const mapWrapper = JSON.parse(await readFile(mapPath, "utf8"));
    mapWrapper.release.releaseId = "infra-foreign";
    const rewrittenMapWrapper = materialized(mapWrapper.release);
    await writeFile(mapPath, serializeDeliveryJson(rewrittenMapWrapper));
    const unsigned = JSON.parse(await readFile(join(context.root, ...UNSIGNED_RELEASE.split("/")), "utf8"));
    unsigned.bindings.mapReleaseHash = rewrittenMapWrapper.releaseHash;
    await rewriteSignedFixture(context, unsigned);
    await assert.rejects(
      deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile),
      /keine gemeinsame Release-Identitaet|verschiedene Release-IDs/u,
    );
  } finally {
    await context.cleanup();
  }
});

test("verwirft frei ersetzte Sources- und Notice-Inhalte trotz nachgezogener Delivery-Signatur", async () => {
  const mutations = [
    ["Sources", (sources) => { sources.sources[0].attribution = `${sources.sources[0].attribution} manipuliert`; }],
    ["Notices", (sources) => {
      const noticeEntry = sources.assetNotices.assets[0].notice;
      noticeEntry.text = `${noticeEntry.text}manipuliert\n`;
      noticeEntry.bytes = Buffer.byteLength(noticeEntry.text);
      noticeEntry.sha256 = digest(Buffer.from(noticeEntry.text, "utf8"));
    }],
  ];
  for (const [label, mutate] of mutations) {
    const context = await fixture();
    try {
      const sourcesPath = join(context.root, "release", "delivery-unsigned", "sources.json");
      const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
      mutate(sources);
      const sourcesBytes = serializeDeliveryJson(sources);
      await writeFile(sourcesPath, sourcesBytes);
      const unsigned = JSON.parse(await readFile(join(context.root, ...UNSIGNED_RELEASE.split("/")), "utf8"));
      unsigned.bindings.sourcesSha256 = digest(sourcesBytes);
      await rewriteSignedFixture(context, unsigned);
      await assert.rejects(
        deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile),
        /nicht bytegleich aus dem strikten aktuellen Delivery-Builder/u,
        label,
      );
    } finally {
      await context.cleanup();
    }
  }
});

test("verwirft Quality-v1 mit fremder ID, falschem Jahr oder Aktivierungsbehauptung trotz nachgezogener Bindungen", async () => {
  const mutations = [
    ["Release-ID", (quality) => { quality.releaseId = "infra-foreign"; }],
    ["Fahrplanjahr", (quality) => { quality.timetableYear = 2027; }],
    ["Aktivierung", (quality) => { quality.qualityGate.activationImplied = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const context = await fixture();
    try {
      const qualityPath = join(context.root, "release", "quality.json");
      const quality = JSON.parse(await readFile(qualityPath, "utf8"));
      mutate(quality);
      const qualityBytes = serializeDeliveryJson(quality);
      const qualityProof = { bytes: qualityBytes.length, sha256: digest(qualityBytes) };
      await writeFile(qualityPath, qualityBytes);

      const infraPath = join(context.root, "release", "public", "infra-release.json");
      const infraWrapper = JSON.parse(await readFile(infraPath, "utf8"));
      Object.assign(infraWrapper.release.artifacts.find(({ kind }) => kind === "quality-report"), qualityProof);
      infraWrapper.release.quality.operationalClosure.reportSha256 = qualityProof.sha256;
      if (label === "Aktivierung") infraWrapper.release.quality.operationalClosure.activationImplied = true;
      const rewrittenInfraWrapper = materialized(infraWrapper.release);
      await writeFile(infraPath, serializeDeliveryJson(rewrittenInfraWrapper));

      const unsigned = JSON.parse(await readFile(join(context.root, ...UNSIGNED_RELEASE.split("/")), "utf8"));
      Object.assign(unsigned.artifacts.find(({ kind }) => kind === "quality-manifest"), qualityProof);
      unsigned.bindings.qualitySha256 = qualityProof.sha256;
      unsigned.bindings.infraReleaseHash = rewrittenInfraWrapper.releaseHash;
      await rewriteSignedFixture(context, unsigned);
      await assert.rejects(
        deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile),
        /Schema, Release, Jahr oder Scope|Qualitätsgate ist offen|Closure-Bindung/u,
        label,
      );
    } finally {
      await context.cleanup();
    }
  }
});

test("Signier-CLI prueft stale Delivery vor jedem Zugriff auf den privaten Schluessel", async () => {
  const context = await fixture();
  try {
    const input = join(context.root, "annual-plan.json");
    const output = join(context.root, ...SIGNED_RELEASE.split("/"));
    const missingPrivateKey = join(context.root, "private-key-must-not-be-read.pem");
    const previousSignedBytes = await readFile(output);
    await Promise.all([
      writeFile(input, `${JSON.stringify(context.unsignedPlan, null, 2)}\n`, "utf8"),
      writeFile(join(context.root, "release", "quality.json"), "{\"quality\":\"stale-before-signature\"}\n", "utf8"),
    ]);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./sign-map-delivery-release.mjs", import.meta.url)),
      input,
      context.root,
      missingPrivateKey,
      "test-delivery-key",
      output,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /aktuellen expandierten Paketinventar/u);
    assert.doesNotMatch(result.stderr, /private-key-must-not-be-read/u);
    assert.deepEqual(await readFile(output), previousSignedBytes);
  } finally {
    await context.cleanup();
  }
});

test("berechnet vorhandene Byte-SHA-Pins zwingend aus dem signierten Manifest neu", async () => {
  const context = await fixture({ pinUnsigned: true });
  try {
    const derived = await deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile);
    const descriptor = derived.plan.auxiliaryFiles.find(({ kind }) => kind === "release-manifest");
    assert.equal(descriptor.expectedBytes, context.signedBytes.length);
    assert.equal(descriptor.expectedSha256, digest(context.signedBytes));
    assert.notEqual(descriptor.expectedSha256, digest(context.unsignedBytes));
  } finally {
    await context.cleanup();
  }
});

test("CLI erzeugt denselben Plan und weist die gebundene Runtime aus", async () => {
  const context = await fixture();
  try {
    const input = join(context.root, "annual-plan.json");
    const output = join(context.root, "signed-plan.json");
    await writeFile(input, `${JSON.stringify(context.unsignedPlan, null, 2)}\n`, "utf8");
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./signed-map-package-plan-cli.mjs", import.meta.url)),
      input,
      context.root,
      context.trustedKeysSourceFile,
      context.trustedKeyScopesSourceFile,
      output,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.action, "written");
    assert.equal(receipt.runtimeSchema, "zugfolge-map-runtime/v2");
    assert.equal(receipt.signedReleaseSourceFile, SIGNED_RELEASE);
    assert.equal(receipt.trustedKeyScopesSourceFile, context.trustedKeyScopesSourceFile);
    assert.equal(JSON.parse(await readFile(output, "utf8")).runtime.schema, "zugfolge-map-runtime/v2");
  } finally {
    await context.cleanup();
  }
});

test("verwirft Runtime-v1, unzulaessige Quelle und abweichende unsigned Pins", async () => {
  const context = await fixture();
  try {
    const runtimeV1 = structuredClone(context.unsignedPlan);
    runtimeV1.runtime.schema = "zugfolge-map-runtime/v1";
    await assert.rejects(deriveSignedMapPackagePlan(runtimeV1, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile), /runtime\/v2/u);

    const wrongSource = structuredClone(context.unsignedPlan);
    wrongSource.auxiliaryFiles.find(({ kind }) => kind === "release-manifest").sourceFile = SIGNED_RELEASE;
    await assert.rejects(deriveSignedMapPackagePlan(wrongSource, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile), /delivery-unsigned/u);

    const wrongPin = structuredClone(context.unsignedPlan);
    Object.assign(wrongPin.auxiliaryFiles.find(({ kind }) => kind === "release-manifest"), {
      expectedBytes: context.unsignedBytes.length,
      expectedSha256: "f".repeat(64),
    });
    await assert.rejects(deriveSignedMapPackagePlan(wrongPin, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile), /realen Bytes/u);
  } finally {
    await context.cleanup();
  }
});

test("verwirft fachliche Aenderungen und inkonsistente Signaturhuellen", async () => {
  const changed = await fixture({
    transformSigned: (signed) => {
      const candidate = { ...signed, releaseId: "infra-other" };
      return { ...candidate, releaseHash: deliveryReleaseHash(candidate) };
    },
  });
  try {
    await assert.rejects(
      deriveSignedMapPackagePlan(changed.unsignedPlan, changed.root, changed.trustedKeysSourceFile, changed.trustedKeyScopesSourceFile),
      /weitere fachliche Felder/u,
    );
  } finally {
    await changed.cleanup();
  }

  const malformed = await fixture({
    transformSigned: (signed) => ({
      ...signed,
      signature: { ...signed.signature, valueBase64: Buffer.alloc(63).toString("base64") },
    }),
  });
  try {
    await assert.rejects(
      deriveSignedMapPackagePlan(malformed.unsignedPlan, malformed.root, malformed.trustedKeysSourceFile, malformed.trustedKeyScopesSourceFile),
      /kanonischen Ed25519-Signaturbytes/u,
    );
  } finally {
    await malformed.cleanup();
  }
});

test("verwirft einen fehlenden oder vorgefüllten unsigned Release-Hash", async () => {
  const missing = await fixture({
    transformUnsigned: (unsigned) => {
      const candidate = { ...unsigned };
      delete candidate.releaseHash;
      return candidate;
    },
  });
  try {
    await assert.rejects(
      deriveSignedMapPackagePlan(missing.unsignedPlan, missing.root, missing.trustedKeysSourceFile, missing.trustedKeyScopesSourceFile),
      /explizit freigegebenen, unsignierten Delivery-v2-Vertrag/u,
    );
  } finally {
    await missing.cleanup();
  }

  const prefilled = await fixture({
    transformUnsigned: (unsigned) => ({ ...unsigned, releaseHash: "f".repeat(64) }),
  });
  try {
    await assert.rejects(
      deriveSignedMapPackagePlan(prefilled.unsignedPlan, prefilled.root, prefilled.trustedKeysSourceFile, prefilled.trustedKeyScopesSourceFile),
      /explizit freigegebenen, unsignierten Delivery-v2-Vertrag/u,
    );
  } finally {
    await prefilled.cleanup();
  }
});

test("verwirft unbegründete oder um Zusatzfelder erweiterte Delivery-v2-Signaturhüllen", async () => {
  const cases = [
    {
      label: "fehlender unsigned Grund",
      fixtureOptions: {
        transformUnsigned: (unsigned) => ({
          ...unsigned,
          approvalGates: { ...unsigned.approvalGates, signature: { status: "missing" } },
        }),
      },
      error: /Unsigned Delivery-v2-Signaturgate besitzt unerwartete oder fehlende Felder/u,
    },
    {
      label: "leerer unsigned Grund",
      fixtureOptions: {
        transformUnsigned: (unsigned) => ({
          ...unsigned,
          approvalGates: { ...unsigned.approvalGates, signature: { status: "missing", reason: "   " } },
        }),
      },
      error: /explizit freigegebenen, unsignierten Delivery-v2-Vertrag/u,
    },
    {
      label: "zusaetzliches unsigned Gate-Feld",
      fixtureOptions: {
        transformUnsigned: (unsigned) => ({
          ...unsigned,
          approvalGates: {
            ...unsigned.approvalGates,
            signature: { ...unsigned.approvalGates.signature, unexpected: true },
          },
        }),
      },
      error: /Unsigned Delivery-v2-Signaturgate besitzt unerwartete oder fehlende Felder/u,
    },
    {
      label: "zusaetzliches signed Gate-Feld",
      fixtureOptions: {
        transformSigned: (signed) => ({
          ...signed,
          approvalGates: {
            ...signed.approvalGates,
            signature: { ...signed.approvalGates.signature, unexpected: true },
          },
        }),
      },
      error: /Signiertes Delivery-v2-Signaturgate besitzt unerwartete oder fehlende Felder/u,
    },
    {
      label: "zusaetzliches signed Signatur-Feld",
      fixtureOptions: {
        transformSigned: (signed) => ({ ...signed, signature: { ...signed.signature, unexpected: true } }),
      },
      error: /Signierte Delivery-v2-Signatur besitzt unerwartete oder fehlende Felder/u,
    },
  ];
  for (const { label, fixtureOptions, error } of cases) {
    const context = await fixture(fixtureOptions);
    try {
      await assert.rejects(
        deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile),
        error,
        label,
      );
    } finally {
      await context.cleanup();
    }
  }
});

test("verwirft einen unbekannten oder kryptografisch falschen Vertrauensanker", async () => {
  const context = await fixture();
  try {
    const { publicKey: unknownPublicKey } = generateKeyPairSync("ed25519");
    await Promise.all([
      writeFile(join(context.root, "unknown-keyring.json"), `${JSON.stringify({
        "test-alpha-world-key": context.alphaWorldPublicKeyPem,
        "test-other-delivery-key": unknownPublicKey.export({ format: "pem", type: "spki" }),
      })}\n`, "utf8"),
      writeFile(join(context.root, "unknown-scopes.json"), `${JSON.stringify({
        alphaWorldDeployments: ["test-alpha-world-key"],
        mapInfraDeliveries: ["test-other-delivery-key"],
      })}\n`, "utf8"),
    ]);
    await assert.rejects(
      deriveSignedMapPackagePlan(context.unsignedPlan, context.root, "unknown-keyring.json", "unknown-scopes.json"),
      /Map-\/Infra-Allow-list kennt test-delivery-key nicht/u,
    );

    const { publicKey } = generateKeyPairSync("ed25519");
    await writeFile(join(context.root, "wrong-keyring.json"), `${JSON.stringify({
      "test-alpha-world-key": context.alphaWorldPublicKeyPem,
      "test-delivery-key": publicKey.export({ format: "pem", type: "spki" }),
    })}\n`, "utf8");
    await assert.rejects(
      deriveSignedMapPackagePlan(context.unsignedPlan, context.root, "wrong-keyring.json", context.trustedKeyScopesSourceFile),
      /kryptografische Ed25519-Pruefung/u,
    );
  } finally {
    await context.cleanup();
  }
});

test("verwirft fehlenden Scope-Vertrag und Alpha-Weltschluessel fuer Delivery-v2", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, "missing-scopes.json"),
      /missing-scopes\.json|Delivery-Key-Scope-Vertrag/u,
    );

    const { privateKey: alphaPrivateKey, publicKey: alphaPublicKey } = generateKeyPairSync("ed25519");
    const unsigned = JSON.parse(await readFile(join(context.root, ...UNSIGNED_RELEASE.split("/")), "utf8"));
    const signedByAlpha = signMapDeliveryRelease(
      unsigned,
      alphaPrivateKey.export({ format: "pem", type: "pkcs8" }),
      "test-alpha-only-key",
    );
    await Promise.all([
      writeFile(join(context.root, ...SIGNED_RELEASE.split("/")), serializeDeliveryJson(signedByAlpha)),
      writeFile(join(context.root, context.trustedKeysSourceFile), `${JSON.stringify({
        "test-alpha-only-key": alphaPublicKey.export({ format: "pem", type: "spki" }),
        "test-delivery-key": context.deliveryPublicKeyPem,
      }, null, 2)}\n`, "utf8"),
      writeFile(join(context.root, context.trustedKeyScopesSourceFile), `${JSON.stringify({
        alphaWorldDeployments: ["test-alpha-only-key"],
        mapInfraDeliveries: ["test-delivery-key"],
      }, null, 2)}\n`, "utf8"),
    ]);
    await assert.rejects(
      deriveSignedMapPackagePlan(context.unsignedPlan, context.root, context.trustedKeysSourceFile, context.trustedKeyScopesSourceFile),
      /Map-\/Infra-Allow-list kennt test-alpha-only-key nicht/u,
    );
  } finally {
    await context.cleanup();
  }
});

test("verwirft private, RSA- und ungueltige Werte im Signed-Plan-Delivery-Keyring", async () => {
  const context = await fixture();
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    const { publicKey: rsaPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const invalidAnchors = [
      ["PKCS8-Private-Key", privateKey.export({ type: "pkcs8", format: "pem" }), /privates Schluesselmaterial/u],
      ["RSA-SPKI", rsaPublicKey.export({ type: "spki", format: "pem" }), /kein Ed25519-SPKI/u],
      ["ungueltiger Wert", "kein PEM", /kanonischer Ed25519-SPKI/u],
    ];
    for (const [label, value, expectedError] of invalidAnchors) {
      await writeFile(join(context.root, "invalid-keyring.json"), `${JSON.stringify({
        "test-alpha-world-key": context.alphaWorldPublicKeyPem,
        "test-delivery-key": value,
      })}\n`, "utf8");
      await assert.rejects(
        deriveSignedMapPackagePlan(context.unsignedPlan, context.root, "invalid-keyring.json", context.trustedKeyScopesSourceFile),
        expectedError,
        label,
      );
    }
  } finally {
    await context.cleanup();
  }
});

test("leitet nur den festen public-Releasepfad ab", () => {
  assert.equal(
    deriveSignedReleaseSourceFile("var/derived/release/map-release-free-v2/delivery-unsigned/release.json"),
    "var/derived/release/map-release-free-v2/public/release.json",
  );
  assert.throws(
    () => deriveSignedReleaseSourceFile("var/derived/release/public/release.json"),
    /delivery-unsigned/u,
  );
});
