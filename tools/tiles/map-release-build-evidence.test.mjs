import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createDatabaseRollbackProof,
  createMapRollbackAttestation,
  materializeCurrentAnnualOperationalAuthority,
  materializeOperationalBuildAuthorityFromBuildEvidenceSpec,
  materializeMapReleaseBuildEvidence,
  preflightMapReleaseActivation,
  prepareEmptyBuildCacheRestore,
  proveBuildCacheRestore,
  serializeMapReleaseBuildEvidence,
  signMapRollbackAttestation,
  validateCurrentAnnualBuildCachePlanBinding,
  validateCurrentAnnualOperationalPublicationBinding,
  validateCurrentAnnualValidatorRebuildCacheArtifacts,
  validateDatabaseRollbackProof,
  validateFirstClassOperationalSidecarEvidence,
  validateMapReleaseBuildEvidence,
  validateMapReleaseBuildEvidenceSpec,
  validateCurrentAnnualOperationalAuthority,
  verifyGithubAttestationSubject,
  verifyCurrentAnnualOperationalAuthorityLocal,
  verifyMapReleaseBuildEvidence,
  writeBuildCacheRestoreProof,
  writeMapReleaseBuildEvidence,
} from "./map-release-build-evidence.mjs";
import { alphaHash } from "../../packages/alpha/dist/index.js";
import {
  LIVEMAP_READ_MODEL_APPLICATION_ID,
  LIVEMAP_READ_MODEL_USER_VERSION,
  PUBLIC_READ_MODEL_TABLES,
} from "./livemap-read-model.mjs";
import { buildMapAssetTreeProof } from "./map-asset-notices.mjs";
import { serializeDeliveryJson, signMapDeliveryRelease } from "./map-delivery-release.mjs";
import {
  BASEMAP_VECTOR_LAYERS,
  expandMapPackagePlan,
  INFRASTRUCTURE_VECTOR_LAYERS,
  serializeMapPackageManifest,
} from "./map-package.mjs";
import {
  TRAIN_MAP_PROJECTION_SCHEMA,
  TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID,
  TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION,
} from "./train-map-projection.mjs";
import {
  canonicalOperationalInfrastructureV2Json,
  operationalInfrastructureV2StateHash,
} from "../region-import/operational-infrastructure-binding.mjs";
import { movementResourceSetSha256 } from "../region-import/movement-route-templates-v2.mjs";
import { canonicalSyntheticOperationalValue } from "../region-import/germany/synthetic-operational-quality.mjs";
import {
  DATABASE_AUTHORITATIVE_TABLE_COUNT,
  DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
  databaseCutoverConstraintProofs,
  databaseCutoverGuardProofs,
  databaseRollbackEvidenceFixtures,
  keycloakIdentityHeadFixture,
} from "../alpha-ops/database-rollback-test-fixtures.mjs";

const RELEASE_ID = "infra-deutschland-2026.2";
const PREVIOUS_RELEASE_ID = "infra-deutschland-2026.1";
const V2_RELEASE_ID = "infra-deutschland-2026.3";
const V2_PREVIOUS_RELEASE_ID = RELEASE_ID;
const DATABASE_ID = "00000000-0000-4000-8000-000000000031";
const EBO_SIGNAL = "signal:osm-node-42";
const UNSIGNED_SIGNATURE_REASON = "Kein produktiver privater Signaturschluessel vorhanden; Aktivierung bleibt gesperrt.";
const LAYERS = [
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

function databaseRollbackSnapshot() {
  return {
    databaseIdentity: DATABASE_ID,
    migrationLedger: [
      { id: 29, hash: "9".repeat(64), createdAt: 1_787_551_200_000 },
      { id: 30, hash: "a".repeat(64), createdAt: 1_787_637_600_000 },
      { id: 31, hash: "1".repeat(64), createdAt: 1_787_641_200_000 },
      { id: 32, hash: "2".repeat(64), createdAt: 1_787_644_800_000 },
      { id: 33, hash: "3".repeat(64), createdAt: 1_787_648_400_000 },
    ],
    constraints: databaseCutoverConstraintProofs(),
    guards: databaseCutoverGuardProofs(),
    heads: {
      total: 4,
      v2: 0,
      nonNullInitializationHash: 0,
      incompatible: 0,
    },
    authoritativeHead: {
      schema: "zugfolge-database-authoritative-head/v1",
      tableCount: DATABASE_AUTHORITATIVE_TABLE_COUNT,
      tableSetSha256: DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
      worldCount: 2,
      regionalStateCount: 4,
      domainEventCount: "19",
      stateHash: "8".repeat(64),
    },
    keycloakIdentityHead: keycloakIdentityHeadFixture(),
  };
}

function databaseRollbackProof(overrides = {}) {
  const {
    source = databaseRollbackSnapshot(),
    restored = structuredClone(source),
    restoreSeparation,
    ...proofOverrides
  } = overrides;
  const evidence = databaseRollbackEvidenceFixtures(source, {
    restored,
    ...(restoreSeparation === undefined ? {} : { restoreSeparation }),
  });
  return createDatabaseRollbackProof({
    releaseId: RELEASE_ID,
    previousReleaseId: PREVIOUS_RELEASE_ID,
    source,
    ...evidence,
    writersQuiesced: true,
    rollbackWindow: "pre-activation-only",
    ...proofOverrides,
  });
}

function operationalInfrastructureV2(releaseId = RELEASE_ID) {
  return {
    id: releaseId,
    directedEdges: { "edge:fixture": 1_000 },
    edgeGeometries: {
      "edge:fixture": [
        { edgeOffsetMm: 0, latitudeE7: 510_000_000, longitudeE7: 120_000_000, bearingMilliDegrees: 90_000 },
        { edgeOffsetMm: 1_000, latitudeE7: 510_000_000, longitudeE7: 120_001_000, bearingMilliDegrees: null },
      ],
    },
    routeVersions: {
      "route:fixture": {
        id: "route:fixture",
        templateId: "template:fixture",
        predecessorId: null,
        transitionRouteMm: null,
        legs: [{
          edgeId: "edge:fixture",
          direction: "along",
          edgeEntryMm: 0,
          edgeExitMm: 1_000,
          routeStartMm: 0,
          blockIds: ["resource:path"],
          speedLimitMmps: 20_000,
          gradientPerMille: 0,
          availableProtectionSystems: ["pzb"],
          simultaneouslyRequiredProtectionSystems: [],
        }],
      },
    },
    interlockingRoutes: {
      "interlocking:fixture": {
        id: "interlocking:fixture",
        routeTemplateId: "template:fixture",
        signalId: "signal:fixture",
        movementKind: "train",
        pathResources: ["resource:path"],
        overlapResources: ["resource:overlap"],
        flankResources: ["resource:flank"],
        switchPositions: {},
        authorityStartRouteMm: 0,
        authorityEndRouteMm: 1_000,
        releaseAfterTailRouteMm: 1_000,
      },
    },
    signals: ["signal:fixture"],
    switches: [],
    blockResources: ["resource:flank", "resource:overlap", "resource:path"],
    platformIntervals: {},
    regionBoundaries: ["region:deutschland-ebo"],
    rzueLayoutId: "rzue-fixture-2026.2",
  };
}

function movementDispatch(id, predecessorBaseRouteVersionId, resourceIds, continuity) {
  return {
    routeVersionId: `route:${id}`,
    predecessorBaseRouteVersionId,
    dispatchInterlockingRouteId: `interlocking:${id}`,
    headRouteMm: 100,
    minimumRuntimeMs: 1_000,
    resourceIds,
    routeLegCount: 1,
    protectionContractRuns: [{
      throughRouteLegIndex: 0,
      availableProtectionSystems: ["pzb"],
      simultaneouslyRequiredProtectionSystems: [],
    }],
    continuity,
  };
}

function operationalSidecars(stateHash, releaseId = RELEASE_ID) {
  const dailyPlanBody = {
    schema: "zugfolge-daily-circulation-plan/v2",
    rule: "lot-local-playable-path-cover-with-explicit-physical-transition-partition/v2",
    gtfsReleaseId: "gtfs-fixture-2026.2",
    repeatEveryS: 86_400,
    minimumTurnaroundS: 300,
    metrics: {
      lotCount: 1,
      journeyChainCount: 4,
      circulationCount: 2,
      rolloverAssignmentCount: 2,
      plannedTransitionCount: 4,
      turnaroundDemandCount: 3,
      transferDemandCount: 1,
      transferLotCount: 1,
    },
    circulations: [
      {
        id: "circulation:a",
        lotId: "lot:fixture",
        serviceLineId: "line:fixture",
        assetCompatibilityKey: "lot:fixture",
        journeyChainIds: ["chain:a:1", "chain:a:2"],
        passengerLegIds: ["leg:a"],
        passengerTrainRunIds: ["run:a"],
        start: { legId: "leg:a", passengerRouteVersionId: "route:gtfs:leg:a:v1", locationId: "location:a", physicalStopId: "stop:a", timeS: 0 },
        end: { legId: "leg:a", passengerRouteVersionId: "route:gtfs:leg:a:v1", locationId: "location:a", physicalStopId: "stop:a", timeS: 1_000 },
      },
      {
        id: "circulation:b",
        lotId: "lot:fixture",
        serviceLineId: "line:fixture",
        assetCompatibilityKey: "lot:fixture",
        journeyChainIds: ["chain:b:1", "chain:b:2"],
        passengerLegIds: ["leg:b"],
        passengerTrainRunIds: ["run:b"],
        start: { legId: "leg:b", passengerRouteVersionId: "route:gtfs:leg:b:v1", locationId: "location:b", physicalStopId: "stop:b", timeS: 2_000 },
        end: { legId: "leg:b", passengerRouteVersionId: "route:gtfs:leg:b:v1", locationId: "location:a", physicalStopId: "stop:a", timeS: 3_000 },
      },
    ],
    rolloverAssignments: [
      { sourceCirculationId: "circulation:a", targetCirculationId: "circulation:b", kind: "transfer" },
      { sourceCirculationId: "circulation:b", targetCirculationId: "circulation:a", kind: "same-location" },
    ],
    turnaroundDemands: [
      {
        id: `turnaround-${"1".repeat(64)}`,
        lotId: "lot:fixture",
        assetCompatibilityKey: "lot:fixture",
        sourceCirculationId: "circulation:a",
        targetCirculationId: "circulation:a",
        sourcePassengerLegId: "leg:a",
        targetPassengerLegId: "leg:a",
        sourcePassengerRouteVersionId: "route:gtfs:leg:a:v1",
        targetPassengerRouteVersionId: "route:gtfs:leg:a:v1",
        sourceLocationId: "location:a",
        targetLocationId: "location:a",
        sourcePhysicalStopId: "stop:a",
        targetPhysicalStopId: "stop:a",
        earliestDepartureS: 1_000,
        latestArrivalS: 1_300,
        availableWindowS: 300,
        dailyBoundary: false,
      },
      {
        id: `turnaround-${"2".repeat(64)}`,
        lotId: "lot:fixture",
        assetCompatibilityKey: "lot:fixture",
        sourceCirculationId: "circulation:b",
        targetCirculationId: "circulation:b",
        sourcePassengerLegId: "leg:b",
        targetPassengerLegId: "leg:b",
        sourcePassengerRouteVersionId: "route:gtfs:leg:b:v1",
        targetPassengerRouteVersionId: "route:gtfs:leg:b:v1",
        sourceLocationId: "location:b",
        targetLocationId: "location:b",
        sourcePhysicalStopId: "stop:b",
        targetPhysicalStopId: "stop:b",
        earliestDepartureS: 3_000,
        latestArrivalS: 3_300,
        availableWindowS: 300,
        dailyBoundary: false,
      },
      {
        id: `turnaround-${"3".repeat(64)}`,
        lotId: "lot:fixture",
        assetCompatibilityKey: "lot:fixture",
        sourceCirculationId: "circulation:b",
        targetCirculationId: "circulation:a",
        sourcePassengerLegId: "leg:b",
        targetPassengerLegId: "leg:a",
        sourcePassengerRouteVersionId: "route:gtfs:leg:b:v1",
        targetPassengerRouteVersionId: "route:gtfs:leg:a:v1",
        sourceLocationId: "location:a",
        targetLocationId: "location:a",
        sourcePhysicalStopId: "stop:a",
        targetPhysicalStopId: "stop:a",
        earliestDepartureS: 3_000,
        latestArrivalS: 86_400,
        availableWindowS: 83_400,
        dailyBoundary: true,
      },
    ],
    transferDemands: [],
  };
  const demand = {
    id: `transfer-${"1".repeat(64)}`,
    lotId: "lot:fixture",
    assetCompatibilityKey: "lot:fixture",
    sourceCirculationId: "circulation:a",
    targetCirculationId: "circulation:b",
    sourcePassengerLegId: "leg:a",
    targetPassengerLegId: "leg:b",
    sourcePassengerRouteVersionId: "route:gtfs:leg:a:v1",
    targetPassengerRouteVersionId: "route:gtfs:leg:b:v1",
    sourceLocationId: "location:a",
    targetLocationId: "location:b",
    sourcePhysicalStopId: "stop:a",
    targetPhysicalStopId: "stop:b",
    earliestDepartureS: 1_300,
    latestArrivalS: 88_100,
    availableWindowS: 86_800,
    dailyBoundary: true,
    movementKind: "train",
  };
  dailyPlanBody.transferDemands.push(demand);
  const directDemand = dailyPlanBody.turnaroundDemands[2];
  const dailyPlanSha256 = alphaHash(dailyPlanBody.schema, dailyPlanBody);
  const dailyPlan = { ...dailyPlanBody, planSha256: dailyPlanSha256 };
  const transferRoute = {
    ...demand,
    formationLengthsMm: [100],
    routeVersionId: `route:${demand.id}:movement:v1`,
    templateId: `template:${demand.id}:movement:v1`,
    legs: [
      {
        edgeId: "edge:transfer:a",
        direction: "along",
        edgeEntryMm: 0,
        edgeExitMm: 400,
        availableProtectionSystems: ["pzb"],
        simultaneouslyRequiredProtectionSystems: [],
      },
      {
        edgeId: "edge:transfer:b",
        direction: "along",
        edgeEntryMm: 0,
        edgeExitMm: 600,
        availableProtectionSystems: ["pzb"],
        simultaneouslyRequiredProtectionSystems: [],
      },
    ],
    totalLengthMm: 1_000,
    weightedCostMm: 1_000,
    minimumRuntimeMs: 1_000,
  };
  const transferSetSha256 = createHash("sha256")
    .update(`${canonicalSyntheticOperationalValue(transferRoute)}\n`)
    .digest("hex");
  const transfers = {
    schema: "zugfolge-timetable-transfer-demands/v2",
    infraReleaseId: releaseId,
    gtfsSnapshotHash: "a".repeat(64),
    dailyPlan,
    formationLengthsMm: [100],
    transferRoutes: [transferRoute],
    transferSetSha256,
  };
  const timetableRoutes = ["leg:a", "leg:b"].map((legId) => ({
    routeVersionId: `route:gtfs:${legId}:v1`,
    templateId: `template:gtfs:${legId}:v1`,
    predecessorId: null,
    transitionRouteMm: null,
    legs: [{
      edgeId: `edge:passenger:${legId}`,
      direction: "along",
      edgeEntryMm: 0,
      edgeExitMm: 100,
    }],
  }));
  const timetableRoutesBytes = Buffer.from(
    `${timetableRoutes.map(canonicalSyntheticOperationalValue).join("\n")}\n`,
    "utf8",
  );

  const directResources = ["resource:direct"];
  const transferResources = ["resource:transfer"];
  const transferDispatch = movementDispatch(
    "fixture-transfer",
    transferRoute.sourcePassengerRouteVersionId,
    transferResources,
    "same-direction",
  );
  const movementBody = {
    schema: "movement-route-templates-v2",
    infraReleaseId: releaseId,
    operationalStateHash: stateHash,
    timetableTransferSetSha256: transferSetSha256,
    directTemplates: [{
      id: "direct:fixture",
      demandId: directDemand.id,
      inboundRouteVersionId: "route:gtfs:leg:b:v1",
      outboundRouteVersionId: "route:gtfs:leg:a:v1",
      locationId: directDemand.sourceLocationId,
      physicalStopId: directDemand.sourcePhysicalStopId,
      formationLengthMm: 100,
      earliestDepartureS: directDemand.earliestDepartureS,
      latestArrivalS: directDemand.latestArrivalS,
      availableWindowS: directDemand.availableWindowS,
      dailyBoundary: directDemand.dailyBoundary,
      terminalIntervals: [{ edgeId: "edge:terminal", fromMm: 0, toMm: 100 }],
      movementKind: "train",
      continuity: "reverse-direction",
      maximumDwellMs: 1_200_000,
      resourceIds: directResources,
      resourceSetSha256: movementResourceSetSha256(directResources),
      through: null,
      outbound: movementDispatch(
        "fixture-direct-outbound",
        "route:gtfs:leg:b:v1",
        directResources,
        "reverse-direction",
      ),
    }],
    templates: [],
    transferTemplates: [{
      id: "transfer-template:fixture",
      demandId: demand.id,
      formationLengthMm: 100,
      sourcePassengerRouteVersionId: transferRoute.sourcePassengerRouteVersionId,
      targetPassengerRouteVersionId: transferRoute.targetPassengerRouteVersionId,
      sourceLocationId: demand.sourceLocationId,
      targetLocationId: demand.targetLocationId,
      earliestDepartureS: demand.earliestDepartureS,
      latestArrivalS: demand.latestArrivalS,
      availableWindowS: demand.availableWindowS,
      dailyBoundary: demand.dailyBoundary,
      movementKind: demand.movementKind,
      transfer: transferDispatch,
      targetOutbound: movementDispatch(
        "fixture-target-outbound",
        transferDispatch.routeVersionId,
        ["resource:target-outbound"],
        "same-direction",
      ),
      resourceIds: transferResources,
      resourceSetSha256: movementResourceSetSha256(transferResources),
    }],
    metrics: {
      directTemplateCount: 1,
      stablingTemplateCount: 0,
      transferTemplateCount: 1,
      transferDemandCount: 1,
      turnaroundDemandCount: dailyPlan.metrics.turnaroundDemandCount,
      plannedTransitionCount: dailyPlan.metrics.plannedTransitionCount,
      turnaroundPairCount: 1,
      observedStablingTemplateCount: 0,
      simulatedOperationalStablingTemplateCount: 0,
      berthAssignmentCounts: {
        observedOsmServiceSiding: 0,
        simulatedOperationalOsmServiceYard: 0,
        simulatedOperationalOsmServiceSpur: 0,
        simulatedOperationalOsmUnclassifiedRail: 0,
      },
      crossBerthTemplateCount: 0,
    },
  };
  const movementStateHash = alphaHash(movementBody.schema, movementBody);
  return {
    movement: { ...movementBody, stateHash: movementStateHash },
    transfers,
    timetableRoutesBytes,
    movementStateHash,
    transferSetSha256,
    dailyPlanSha256,
  };
}

function operationalV2Quality(
  operationalProof,
  stateHash,
  movementProof,
  movementStateHash,
  transferProof,
  timetableRoutesProof,
  transferSetSha256,
  dailyPlanSha256,
  releaseId = RELEASE_ID,
) {
  return {
    schema: "zugfolge-operational-infrastructure-quality-report/v1",
    releaseId,
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
      mapReleaseId: "karte-deutschland-2026.2-v2",
      infrastructureCorpusId: releaseId,
      bytes: 4_321,
      sha256: "a".repeat(64),
      sourceReport: { schema: "zugfolge-final-infrastructure-quality-report/v1", bytes: 9_876, sha256: "b".repeat(64), shipped: false },
      visibleFeatures: 12,
      visibleLayers: LAYERS.length,
      qualityClassFeatureCount: { A: 4, B: 6, C: 2 },
      trackLengthMm: 1_000,
      trackQualityClassLengthMm: { A: 400, B: 500, C: 100 },
    },
    operationalModel: {
      policyId: "synthetic-operational-b/v2",
      policySha256: "a".repeat(64),
      closureReceiptSha256: "b".repeat(64),
      qualityClass: "B",
      provenance: "derived",
      realGeometry: true,
      simulatedOperationalAssignment: true,
      realInterlockingFactsClaimed: false,
      syntheticOperationalDetailsShipped: true,
      objectLevelProvenanceShipped: false,
      observedAndSyntheticObjectsShareRuntimeCollections: true,
      movementRouteTemplates: {
        ...movementProof,
        stateHash: movementStateHash,
        operationalStateHash: stateHash,
        timetableTransferSetSha256: transferSetSha256,
      },
      timetableRouteEvidence: {
      reportSchema: "zugfolge-germany-timetable-route-report/v4",
        policyId: "synthetic-operational-b/v2",
        derivationRule: "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
        selectionRule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
        reportBytes: 1_234,
        reportSha256: "a".repeat(64),
        routesBytes: timetableRoutesProof.bytes,
        routesSha256: timetableRoutesProof.sha256,
        gtfsSnapshotBytes: 9_012,
        gtfsSnapshotSha256: "c".repeat(64),
        transferDemandsSchema: "zugfolge-timetable-transfer-demands/v2",
        transferDemandsBytes: transferProof.bytes,
        transferDemandsSha256: transferProof.sha256,
        snapshotHash: "a".repeat(64),
        archive: "gtfs-free.zip",
        archiveSha256: "b".repeat(64),
        sourceLicense: "CC-BY-4.0",
        sourceLicenseAsPublished: "CC BY 4.0",
        selectedSegmentCount: 2,
        completeRouteCount: 2,
        routeRecordCount: 2,
        sameStopTransitionCount: 1,
        routeSetSha256: timetableRoutesProof.sha256,
        dailyCirculationPlanSha256: dailyPlanSha256,
        transferSetSha256,
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
      operationalArtifact: { ...operationalProof, stateHash },
      coverage: { blockResources: 3, directedEdges: 1, edgeGeometries: 1, interlockingRoutes: 1, platformIntervals: 1, regionBoundaries: 1, routeVersions: 1, rzueLayouts: 1, signals: 1, switches: 1 },
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

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function releaseWrapper(release) {
  return { releaseHash: sha256(Buffer.from(JSON.stringify(sortedValue(release)), "utf8")), release };
}

function fixtureAssetNotices(descriptors) {
  const upstreamCommit = "1".repeat(40);
  const tangramsCommit = "2".repeat(40);
  const glyphCopyright = "Copyright 2012 Google Inc.";
  const glyphText = `${glyphCopyright}\nSIL OPEN FONT LICENSE Version 1.1\nFixture terms.\n`;
  const spriteCopyright = "Copyright 2016 Tangrams contributors";
  const spriteText = `${spriteCopyright}\nThe MIT License (MIT)\nFixture terms.\n`;
  return {
    schema: "zugfolge-map-asset-notices/v2",
    assets: [
      {
        id: "noto-glyphs",
        rightsSourceId: "noto-glyphs",
        kind: "glyph",
        license: "OFL-1.1",
        copyright: glyphCopyright,
        modifications: "Subsetted and converted into deterministic glyph ranges.",
        source: { repository: "https://github.com/protomaps/basemaps-assets", commit: upstreamCommit, path: "fonts" },
        derivedFrom: null,
        notice: {
          url: `https://raw.githubusercontent.com/protomaps/basemaps-assets/${upstreamCommit}/fonts/OFL.txt`,
          bytes: Buffer.byteLength(glyphText),
          sha256: sha256(Buffer.from(glyphText)),
          text: glyphText,
        },
        tree: buildMapAssetTreeProof("glyph", "assets/fonts", descriptors),
      },
      {
        id: "protomaps-sprites",
        rightsSourceId: "protomaps-sprites",
        kind: "sprite",
        license: "MIT",
        copyright: spriteCopyright,
        modifications: "Packed and recolored for the deterministic dark map style.",
        source: { repository: "https://github.com/protomaps/basemaps-assets", commit: upstreamCommit, path: "sprites" },
        derivedFrom: { repository: "https://github.com/tangrams/icons", commit: tangramsCommit, license: "MIT" },
        notice: {
          url: `https://raw.githubusercontent.com/tangrams/icons/${tangramsCommit}/LICENSE.md`,
          bytes: Buffer.byteLength(spriteText),
          sha256: sha256(Buffer.from(spriteText)),
          text: spriteText,
        },
        tree: buildMapAssetTreeProof("sprite", "assets/sprites", descriptors),
      },
    ],
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function write(root, path, bytes) {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return absolute;
}

async function proof(root, path) {
  const bytes = await readFile(join(root, ...path.split("/")));
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function streamedProof(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function operationalReceipt(path, expectedReleaseId, mutate = (receipt) => receipt) {
  const source = await readFile(path);
  const infrastructure = JSON.parse(source);
  const canonical = Buffer.from(`${canonicalOperationalInfrastructureV2Json(infrastructure)}\n`, "utf8");
  return mutate({
    schema: "operational-infrastructure-v2",
    infraReleaseId: expectedReleaseId,
    sourceBytes: source.length,
    sourceSha256: sha256(source),
    bytes: canonical.length,
    sha256: sha256(canonical),
    stateHash: operationalInfrastructureV2StateHash(infrastructure),
    validationMode: "native-streaming-redb-v1",
  });
}

function createReadModel(path, infrastructureReleaseId = RELEASE_ID) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA application_id = ${LIVEMAP_READ_MODEL_APPLICATION_ID}; PRAGMA user_version = ${LIVEMAP_READ_MODEL_USER_VERSION}; PRAGMA foreign_keys = ON;`);
    for (const [table, columns] of Object.entries(PUBLIC_READ_MODEL_TABLES)) {
      database.exec(`CREATE TABLE ${table} (${columns.map((column) => `${column} TEXT NOT NULL`).join(", ")});`);
    }
    const metadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      schema: "zugfolge-livemap-read-model-sqlite/v2",
      world_id: "00000000-0000-4000-8000-000000000014",
      infrastructure_release_id: infrastructureReleaseId,
      gtfs_service_date: "20260810",
      world_epoch: "2026-08-10T00:00:00.000Z",
      time_zone: "Europe/Berlin",
      service_start_offset_s: "0",
      repeat_every_s: "86400",
    })) metadata.run(key, value);
    database.prepare("INSERT INTO world_config (world_id, infrastructure_release_id, config_json) VALUES (?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000014", infrastructureReleaseId, "{}");
    database.prepare("INSERT INTO object_details VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000014", infrastructureReleaseId, "signal", EBO_SIGNAL, "EBO-Signal", "B", "[]");
  } finally {
    database.close();
  }
}

function createTrainProjection(path, infrastructureReleaseId = RELEASE_ID, deploymentHash = "d".repeat(64)) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA application_id = ${TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID};
      PRAGMA user_version = ${TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION};
      CREATE TABLE display_path_geometries (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        display_path_id TEXT NOT NULL,
        length_mm INTEGER NOT NULL CHECK (length_mm >= 0),
        geometry_json TEXT NOT NULL,
        PRIMARY KEY (world_id, infrastructure_release_id, display_path_id)
      ) WITHOUT ROWID;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE track_geometries (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        length_mm INTEGER NOT NULL CHECK (length_mm > 0),
        geometry_json TEXT NOT NULL,
        PRIMARY KEY (world_id, infrastructure_release_id, track_id)
      ) WITHOUT ROWID;
      CREATE TABLE resource_track_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_start_mm INTEGER NOT NULL CHECK (resource_start_mm >= 0),
        resource_end_mm INTEGER NOT NULL CHECK (resource_end_mm > resource_start_mm),
        track_id TEXT NOT NULL,
        track_start_offset_mm INTEGER NOT NULL CHECK (track_start_offset_mm >= 0),
        track_end_offset_mm INTEGER NOT NULL CHECK (track_end_offset_mm >= 0),
        is_resource_end INTEGER NOT NULL CHECK (is_resource_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm, track_id),
        FOREIGN KEY (world_id, infrastructure_release_id, track_id)
          REFERENCES track_geometries (world_id, infrastructure_release_id, track_id)
      ) WITHOUT ROWID;
      CREATE INDEX resource_track_lookup ON resource_track_spans
        (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm);
      CREATE TABLE resource_display_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_start_mm INTEGER NOT NULL CHECK (resource_start_mm >= 0),
        resource_end_mm INTEGER NOT NULL CHECK (resource_end_mm > resource_start_mm),
        method TEXT NOT NULL CHECK (method IN ('topological-track', 'route-corridor', 'anchor-hold')),
        display_path_id TEXT NOT NULL,
        display_start_offset_mm INTEGER NOT NULL CHECK (display_start_offset_mm >= 0),
        display_end_offset_mm INTEGER NOT NULL CHECK (display_end_offset_mm >= 0),
        uncertainty_start_mm INTEGER NOT NULL CHECK (uncertainty_start_mm >= 0),
        uncertainty_end_mm INTEGER NOT NULL CHECK (uncertainty_end_mm >= 0),
        is_resource_end INTEGER NOT NULL CHECK (is_resource_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm, method, display_path_id),
        FOREIGN KEY (world_id, infrastructure_release_id, display_path_id)
          REFERENCES display_path_geometries (world_id, infrastructure_release_id, display_path_id)
      ) WITHOUT ROWID;
      CREATE INDEX resource_display_lookup ON resource_display_spans
        (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm);
      CREATE TABLE train_resource_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        train_id TEXT NOT NULL,
        position_start_mm INTEGER NOT NULL CHECK (position_start_mm >= 0),
        position_end_mm INTEGER NOT NULL CHECK (position_end_mm > position_start_mm),
        resource_id TEXT NOT NULL,
        is_train_end INTEGER NOT NULL CHECK (is_train_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, train_id, position_start_mm, resource_id)
      ) WITHOUT ROWID;
      CREATE INDEX train_position_lookup ON train_resource_spans
        (world_id, infrastructure_release_id, train_id, position_start_mm, position_end_mm);
    `);
    const metadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      schema: TRAIN_MAP_PROJECTION_SCHEMA,
      world_id: "00000000-0000-4000-8000-000000000014",
      infrastructure_release_id: infrastructureReleaseId,
      timetable_year: "2026",
      tracks_sha256: "a".repeat(64),
      corridors_sha256: "b".repeat(64),
      operational_network_sha256: "c".repeat(64),
      deployment_sha256: deploymentHash,
    })) metadata.run(key, value);
  } finally {
    database.close();
  }
}

async function fixture({ releaseId = RELEASE_ID, previousReleaseId = PREVIOUS_RELEASE_ID } = {}) {
  const releaseVersion = releaseId.replace("infra-deutschland-", "");
  const previousReleaseVersion = previousReleaseId.replace("infra-deutschland-", "");
  const root = await mkdtemp(join(tmpdir(), "zugfolge-build-evidence-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { privateKey: rollbackPrivateKey, publicKey: rollbackPublicKey } = generateKeyPairSync("ed25519");
  const { privateKey: worldPrivateKey, publicKey: worldPublicKey } = generateKeyPairSync("ed25519");
  const deliveryKeyId = "map-delivery-test-2026";
  const rollbackKeyId = "map-rollback-test-2026";
  const worldKeyId = "alpha-world-test-2026";
  const trustedDeliveryKeys = {
    [deliveryKeyId]: publicKey.export({ type: "spki", format: "pem" }),
    [rollbackKeyId]: rollbackPublicKey.export({ type: "spki", format: "pem" }),
    [worldKeyId]: worldPublicKey.export({ type: "spki", format: "pem" }),
  };
  const cached = [
    ["inputs/deutschland-2026-08-12.osm.pbf", "cache/sources/deutschland-2026-08-12.osm.pbf", Buffer.from("pinned external archive")],
    [`inputs/map-source-capture-${releaseVersion}.json`, `cache/captures/map-source-capture-${releaseVersion}.json`, Buffer.from('{"schema":"capture/v1"}\n')],
    [`inputs/derived-station-evidence-${releaseVersion}.json`, `cache/derived/station-evidence-${releaseVersion}.json`, Buffer.from('{"schema":"derived/v1"}\n')],
    ["tools/bin/osmium-1.19.1", "cache/tools/osmium-1.19.1", Buffer.from("pinned osmium binary")],
  ];
  for (const [file, , bytes] of cached) await write(root, file, bytes);
  await write(root, `tools/region-import/germany/release-${releaseVersion}.json`, `${JSON.stringify({
    schema: "germany-release/v1",
    releaseId,
  })}\n`);

  const inventoryFiles = [];
  for (const [file, cacheFile] of cached) inventoryFiles.push({ path: cacheFile, ...(await proof(root, file)) });
  inventoryFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const inventory = { schema: "zugfolge-map-build-cache-inventory/v1", releaseId, files: inventoryFiles };
  await write(root, `cache/build-cache-inventory-${releaseVersion}.json`, `${JSON.stringify(inventory, null, 2)}\n`);

  const semanticLayers = [];
  for (const layer of LAYERS) {
    const file = `derived/semantic/${layer}.geojsonseq`;
    const featureId = layer === "signals" ? EBO_SIGNAL : `${layer}:fixture-1`;
    await write(root, file, `${JSON.stringify({ type: "Feature", properties: { feature_id: featureId }, geometry: null })}\n`);
    semanticLayers.push({ layer, file });
  }

  await write(root, "outputs/basemap.pmtiles", Buffer.concat([Buffer.from("PMTiles"), Buffer.alloc(256, 3)]));
  await write(root, `outputs/${releaseId}.pmtiles`, Buffer.concat([Buffer.from("PMTiles"), Buffer.alloc(256, 1)]));
  const readModelPath = join(root, "outputs", "read-model.sqlite");
  await mkdir(dirname(readModelPath), { recursive: true });
  createReadModel(readModelPath, releaseId);
  createTrainProjection(join(root, "outputs", "train-map-projection.sqlite"), releaseId);
  await write(root, "outputs/style.json", `${JSON.stringify({ version: 8, sources: {}, layers: [] })}\n`);
  await write(root, "outputs/quality.json", `${JSON.stringify({
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId,
    deterministic: true,
    summary: { visibleLayers: 10, visibleFeatures: 10 },
  })}\n`);
  await write(root, "outputs/assets/fonts/fixture.pbf", "pinned glyph bytes");
  await write(root, "outputs/assets/sprites/dark.json", '{"fixture":true}\n');
  await write(root, "outputs/assets/sprites/dark.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]));
  const sources = {
    schema: "zugfolge-map-delivery-sources/v1",
    releaseId,
    sources: [{ id: "fixture", approved: true, license: "ODbL-1.0", attribution: "OpenStreetMap; Protomaps", version: releaseVersion }],
  };
  const sourcesBytes = serializeDeliveryJson(sources);
  await write(root, "outputs/sources.json", sourcesBytes);
  const deliverySources = [
    { id: "welt-basiskarte", kind: "basemap", sourceFile: "outputs/basemap.pmtiles", installPath: "basemap.pmtiles" },
    { id: "deutschland-infrastruktur", kind: "infrastructure", sourceFile: `outputs/${releaseId}.pmtiles`, installPath: `${releaseId}.pmtiles` },
    { id: "public-read-model", kind: "read-model", sourceFile: "outputs/read-model.sqlite", installPath: "read-model.sqlite" },
    { id: "train-map-projection", kind: "train-map-projection", sourceFile: "outputs/train-map-projection.sqlite", installPath: "train-map-projection.sqlite" },
    { id: "style-dark", kind: "style", sourceFile: "outputs/style.json", installPath: "style.json" },
    { id: "quality-manifest", kind: "quality-manifest", sourceFile: "outputs/quality.json", installPath: "manifests/quality.json" },
    { id: "glyph-fixture", kind: "glyph", sourceFile: "outputs/assets/fonts/fixture.pbf", installPath: "assets/fonts/fixture.pbf" },
    { id: "sprite-dark-json", kind: "sprite", sourceFile: "outputs/assets/sprites/dark.json", installPath: "assets/sprites/dark.json" },
    { id: "sprite-dark-png", kind: "sprite", sourceFile: "outputs/assets/sprites/dark.png", installPath: "assets/sprites/dark.png" },
  ];
  const deliveryArtifacts = [];
  for (const descriptor of deliverySources) deliveryArtifacts.push({
    id: descriptor.id,
    kind: descriptor.kind,
    installPath: descriptor.installPath,
    ...(await proof(root, descriptor.sourceFile)),
  });
  deliveryArtifacts.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const unsignedDelivery = {
    schema: "zugfolge-map-delivery-release/v1",
    releaseId,
    timetableYear: 2026,
    packageId: "zugfolge-map-deutschland",
    packageVersion: releaseVersion,
    scope: {},
    artifacts: deliveryArtifacts,
    bindings: {
      packageManifestSchema: "zugfolge-map-package/v1",
      infraReleaseSchema: "zugfolge-infra-release/v2",
      mapReleaseSchema: "zugfolge-map-release/v1",
      sourcesSha256: sha256(sourcesBytes),
      qualitySha256: (await proof(root, "outputs/quality.json")).sha256,
    },
    approvalGates: {
      rights: { status: "passed" },
      quality: { status: "passed" },
      signature: { status: "missing" },
    },
    signature: null,
  };
  const signedDelivery = signMapDeliveryRelease(unsignedDelivery, privateKey.export({ type: "pkcs8", format: "pem" }), deliveryKeyId);
  await write(root, "outputs/release.json", serializeDeliveryJson(signedDelivery));

  const inputDescriptors = [
    { id: "osm-pbf-deutschland", kind: "source-archive", version: "2026-08-12", file: cached[0][0], cacheFile: cached[0][1] },
    { id: "map-source-capture", kind: "capture-manifest", version: releaseVersion, file: cached[1][0], cacheFile: cached[1][1] },
    { id: "germany-release-spec", kind: "specification", version: releaseVersion, file: `tools/region-import/germany/release-${releaseVersion}.json` },
    { id: "station-derived-input", kind: "derived-input", version: releaseVersion, file: cached[2][0], cacheFile: cached[2][1] },
    { id: "build-cache-inventory", kind: "build-cache-inventory", version: releaseVersion, file: `cache/build-cache-inventory-${releaseVersion}.json` },
  ];
  for (const descriptor of inputDescriptors) Object.assign(descriptor, await proof(root, descriptor.file), {
    expectedBytes: (await proof(root, descriptor.file)).bytes,
    expectedSha256: (await proof(root, descriptor.file)).sha256,
  });
  const toolProof = await proof(root, cached[3][0]);
  const spec = {
    schema: "zugfolge-map-release-build-evidence-spec/v1",
    releaseId,
    previousReleaseId,
    commits: { semanticExport: "1".repeat(40), mapBuild: "2".repeat(40) },
    inputs: inputDescriptors,
    tools: [
      {
        id: "osmium-tool",
        kind: "binary",
        version: "1.19.1",
        file: cached[3][0],
        cacheFile: cached[3][1],
        expectedBytes: toolProof.bytes,
        expectedSha256: toolProof.sha256,
      },
      {
        id: "gdal-pmtiles",
        kind: "oci-image",
        version: "3.13.2",
        reference: `ghcr.io/zugfolge/gdal-pmtiles@sha256:${"a".repeat(64)}`,
        digest: `sha256:${"a".repeat(64)}`,
      },
    ],
    outputs: [
      { id: "basemap", kind: "basemap-pmtiles", file: "outputs/basemap.pmtiles", installFile: "basemap.pmtiles" },
      { id: "semantic-pmtiles", kind: "semantic-pmtiles", file: `outputs/${releaseId}.pmtiles`, installFile: `${releaseId}.pmtiles` },
      { id: "read-model", kind: "read-model", file: "outputs/read-model.sqlite", installFile: "read-model.sqlite" },
      { id: "train-map-projection", kind: "train-map-projection", file: "outputs/train-map-projection.sqlite", installFile: "train-map-projection.sqlite" },
      { id: "style", kind: "style", file: "outputs/style.json", installFile: "style.json" },
      { id: "delivery", kind: "delivery-manifest", file: "outputs/release.json", installFile: "manifests/release.json" },
      { id: "quality", kind: "quality-report", file: "outputs/quality.json", installFile: "manifests/quality.json" },
    ],
    regressions: {
      semanticLayers,
      forbiddenPublicTokens: ["12472736971", "signal:osm-node-12472736971"],
      requiredEboSignalFeatureIds: [EBO_SIGNAL],
    },
    buildCache: {
      inventoryInputId: "build-cache-inventory",
      objectKey: `map-build-cache/${releaseId}/cache.tar.zst.age`,
      backupRequired: true,
      encrypted: true,
      encryptionScheme: "age-x25519",
      restoreVerification: "empty-path-full-inventory",
    },
    deployment: {
      candidateInstallPath: `releases/${releaseId}`,
      previousInstallPath: `releases/${previousReleaseId}`,
      activationPointer: "active/map-release.env",
      rollbackAttestationPath: `attestations/${previousReleaseId}.rollback.json`,
      activationMode: "atomic-config-swap",
      retainPreviousForRollback: true,
    },
  };
  const specFile = `tools/tiles/map-release-build-evidence.annual-${releaseVersion}.spec.json`;
  const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
  await write(root, specFile, specBytes);
  return {
    root,
    releaseId,
    previousReleaseId,
    releaseVersion,
    previousReleaseVersion,
    spec,
    specBytes,
    specFile,
    inventory,
    cached,
    deliverySources,
    deliveryKeyId,
    privateKey,
    rollbackPrivateKey,
    rollbackKeyId,
    worldPrivateKey,
    worldKeyId,
    signedDelivery,
    sources,
    trustedDeliveryKeys,
  };
}

async function fixtureV2({ releaseId = V2_RELEASE_ID, previousReleaseId = V2_PREVIOUS_RELEASE_ID } = {}) {
  const value = await fixture({ releaseId, previousReleaseId });
  const { releaseVersion } = value;
  const infrastructure = operationalInfrastructureV2(releaseId);
  const operationalFile = "outputs/operational-infrastructure-v2.json";
  await write(value.root, operationalFile, `${canonicalOperationalInfrastructureV2Json(infrastructure)}\n`);
  const operationalProof = await proof(value.root, operationalFile);
  const stateHash = operationalInfrastructureV2StateHash(infrastructure);
  const movementFile = "outputs/operational-infrastructure-v2.movement-route-templates-v2.json";
  const transferFile = "outputs/timetable-routes-v2.transfer-demands-v2.json";
  const {
    movement,
    transfers,
    timetableRoutesBytes,
    movementStateHash,
    transferSetSha256,
    dailyPlanSha256,
  } = operationalSidecars(stateHash, releaseId);
  await write(value.root, movementFile, `${JSON.stringify(movement)}\n`);
  await write(value.root, transferFile, `${JSON.stringify(transfers)}\n`);
  const timetableRoutesFile = "inputs/timetable-routes-v2.jsonseq";
  const timetableRoutesCacheFile = "cache/derived/timetable-routes-v2.jsonseq";
  await write(value.root, timetableRoutesFile, timetableRoutesBytes);
  const movementProof = await proof(value.root, movementFile);
  const transferProof = await proof(value.root, transferFile);
  const timetableRoutesProof = await proof(value.root, timetableRoutesFile);

  const artifactInventoryFile = "inputs/release-artifacts.v2.json";
  const artifactInventoryCacheFile = "cache/derived/release-artifacts.v2.json";
  const artifactInventory = {
    schema: "zugfolge-infra-release-artifacts/v2",
    artifacts: [
      {
        id: `operational-infrastructure-${releaseVersion}`,
        kind: "operational-infrastructure-v2",
        file: "operational-infrastructure-v2.json",
        infraReleaseId: releaseId,
        ...operationalProof,
        stateHash,
      },
      {
        id: `operational-movement-routes-${releaseVersion}`,
        kind: "movement-route-templates-v2",
        file: "operational-infrastructure-v2.movement-route-templates-v2.json",
        ...movementProof,
      },
      {
        id: `timetable-transfer-demands-${releaseVersion}`,
        kind: "timetable-transfer-demands-v2",
        file: "timetable-routes-v2.transfer-demands-v2.json",
        ...transferProof,
      },
    ],
  };
  await write(value.root, artifactInventoryFile, `${JSON.stringify(artifactInventory, null, 2)}\n`);
  const artifactInventoryProof = await proof(value.root, artifactInventoryFile);

  const cacheInventoryPath = `cache/build-cache-inventory-${releaseVersion}.json`;
  const cacheInventory = JSON.parse(await readFile(join(value.root, ...cacheInventoryPath.split("/")), "utf8"));
  cacheInventory.files.push(
    { path: artifactInventoryCacheFile, ...artifactInventoryProof },
    { path: timetableRoutesCacheFile, ...timetableRoutesProof },
  );
  cacheInventory.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  await write(value.root, cacheInventoryPath, `${JSON.stringify(cacheInventory, null, 2)}\n`);

  const qualityFile = "outputs/quality.json";
  const qualityReport = operationalV2Quality(
    operationalProof,
    stateHash,
    movementProof,
    movementStateHash,
    transferProof,
    timetableRoutesProof,
    transferSetSha256,
    dailyPlanSha256,
    releaseId,
  );
  await write(value.root, qualityFile, `${JSON.stringify(qualityReport, null, 2)}\n`);
  const qualityProof = await proof(value.root, qualityFile);

  const infraReleaseWrapperFile = "inputs/infra-release.json";
  const infraReleaseWrapperCacheFile = "cache/derived/infra-release.json";
  const infraRelease = {
    schema: "zugfolge-infra-release/v2",
    releaseId,
    timetableYear: 2026,
    artifacts: structuredClone(artifactInventory.artifacts),
    quality: {
      operationalClosure: {
        reportSha256: qualityProof.sha256,
        policyId: qualityReport.operationalModel.policyId,
        policySha256: qualityReport.operationalModel.policySha256,
        closureReceiptSha256: qualityReport.operationalModel.closureReceiptSha256,
        qualityClass: "B",
        provenance: "derived",
        candidateBytes: operationalProof.bytes,
        candidateSha256: operationalProof.sha256,
        candidateStateHash: stateHash,
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
  };
  const infraWrapper = releaseWrapper(infraRelease);
  await write(value.root, infraReleaseWrapperFile, `${JSON.stringify(infraWrapper, null, 2)}\n`);
  const infraWrapperProof = await proof(value.root, infraReleaseWrapperFile);

  const mapReleaseWrapperFile = "inputs/map-release.json";
  const mapReleaseWrapperCacheFile = "cache/derived/map-release.json";
  const mapWrapper = releaseWrapper({
    schema: "zugfolge-map-release/v1",
    releaseId: `map-${releaseVersion}`,
    assetInventoryPlanSha256: "9".repeat(64),
  });
  await write(value.root, mapReleaseWrapperFile, `${JSON.stringify(mapWrapper, null, 2)}\n`);
  const mapWrapperProof = await proof(value.root, mapReleaseWrapperFile);
  const deliverySourcesFile = "outputs/sources.json";
  const deliverySourcesCacheFile = "cache/derived/delivery-sources.json";

  const delivery = structuredClone(value.signedDelivery);
  const { releaseHash: ignoredReleaseHash, signature: ignoredSignature, ...deliveryPayload } = delivery;
  void ignoredReleaseHash;
  void ignoredSignature;
  deliveryPayload.schema = "zugfolge-map-delivery-release/v2";
  deliveryPayload.artifacts = deliveryPayload.artifacts
    .filter(({ kind }) => kind !== "train-map-projection")
    .map((artifact) => artifact.kind === "quality-manifest" ? { ...artifact, ...qualityProof } : artifact);
  deliveryPayload.artifacts.push({
    id: `operational-infrastructure-${releaseVersion}`,
    kind: "operational-infrastructure-v2",
    installPath: "operational-infrastructure-v2.json",
    infraReleaseId: releaseId,
    stateHash,
    ...operationalProof,
  });
  deliveryPayload.artifacts.push({
    id: `operational-movement-routes-${releaseVersion}`,
    kind: "movement-route-templates-v2",
    installPath: "operational-infrastructure-v2.movement-route-templates-v2.json",
    ...movementProof,
  });
  deliveryPayload.artifacts.push({
    id: `timetable-transfer-demands-${releaseVersion}`,
    kind: "timetable-transfer-demands-v2",
    installPath: "timetable-routes-v2.transfer-demands-v2.json",
    ...transferProof,
  });
  deliveryPayload.artifacts.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const v2Sources = {
    ...value.sources,
    schema: "zugfolge-map-delivery-sources/v2",
    assetInventoryPlanSha256: mapWrapper.release.assetInventoryPlanSha256,
    assetNotices: fixtureAssetNotices(deliveryPayload.artifacts),
  };
  value.sources = v2Sources;
  await write(value.root, deliverySourcesFile, serializeDeliveryJson(v2Sources));
  const deliverySourcesProof = await proof(value.root, deliverySourcesFile);
  cacheInventory.files.push(
    { path: infraReleaseWrapperCacheFile, ...infraWrapperProof },
    { path: mapReleaseWrapperCacheFile, ...mapWrapperProof },
    { path: deliverySourcesCacheFile, ...deliverySourcesProof },
  );
  cacheInventory.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  await write(value.root, cacheInventoryPath, `${JSON.stringify(cacheInventory, null, 2)}\n`);
  deliveryPayload.bindings = {
    ...deliveryPayload.bindings,
    packageManifestSchema: "zugfolge-map-package/v2",
    sourcesSha256: deliverySourcesProof.sha256,
    qualitySha256: qualityProof.sha256,
    infraReleaseHash: infraWrapper.releaseHash,
    mapReleaseHash: mapWrapper.releaseHash,
  };
  deliveryPayload.approvalGates = {
    ...deliveryPayload.approvalGates,
    rights: {
      status: "passed",
      sourceManifestSchema: "zugfolge-map-delivery-sources/v2",
      sourceCount: v2Sources.sources.length,
      assetGroupCount: v2Sources.assetNotices.assets.length,
      assetFileCount: deliveryPayload.artifacts.filter(({ kind }) => ["glyph", "sprite"].includes(kind)).length,
    },
    signature: { status: "missing", reason: UNSIGNED_SIGNATURE_REASON },
  };
  deliveryPayload.releaseHash = null;
  deliveryPayload.signature = null;
  const unsignedDeliveryFile = "outputs/delivery-unsigned/release.json";
  await write(value.root, unsignedDeliveryFile, serializeDeliveryJson(deliveryPayload));
  const signedDelivery = signMapDeliveryRelease(
    deliveryPayload,
    value.privateKey.export({ type: "pkcs8", format: "pem" }),
    value.deliveryKeyId,
  );
  const deliveryOutputFile = "outputs/public/release.json";
  await write(value.root, deliveryOutputFile, serializeDeliveryJson(signedDelivery));
  const deliveryOutputProof = await proof(value.root, deliveryOutputFile);

  const basePlanFile = `tools/tiles/map-package.base-${releaseVersion}.plan.json`;
  const signedPlanFile = "outputs/map-release-free-v2/signed-package-plan.json";
  const trustedKeysFile = "ops/keys/trusted-delivery-keys.json";
  const packageDescriptors = value.deliverySources.filter(({ kind }) => kind !== "train-map-projection");
  packageDescriptors.push({
    id: `operational-infrastructure-${releaseVersion}`,
    kind: "operational-infrastructure-v2",
    sourceFile: operationalFile,
    installPath: "operational-infrastructure-v2.json",
    artifactInventory: artifactInventoryFile,
  });
  packageDescriptors.push({
    id: `operational-movement-routes-${releaseVersion}`,
    kind: "movement-route-templates-v2",
    sourceFile: movementFile,
    installPath: "operational-infrastructure-v2.movement-route-templates-v2.json",
    artifactInventory: artifactInventoryFile,
  });
  packageDescriptors.push({
    id: `timetable-transfer-demands-${releaseVersion}`,
    kind: "timetable-transfer-demands-v2",
    sourceFile: transferFile,
    installPath: "timetable-routes-v2.transfer-demands-v2.json",
    artifactInventory: artifactInventoryFile,
  });
  const basePlan = {
    schema: "zugfolge-map-package-plan/v2",
    packageId: deliveryPayload.packageId,
    version: deliveryPayload.packageVersion,
    partBytes: 104857600,
    runtime: {
      schema: "zugfolge-map-runtime/v2",
      publicBasePath: `/artifacts/maps/${releaseId}`,
      basemapStyleUrl: `/artifacts/maps/${releaseId}/style.json`,
      infrastructurePmtilesUrl: `/artifacts/maps/${releaseId}/${releaseId}.pmtiles`,
    },
    artifacts: packageDescriptors
      .filter(({ kind }) => ["basemap", "infrastructure"].includes(kind))
      .map((descriptor) => ({
        ...descriptor,
        expectedVectorLayers: descriptor.kind === "basemap" ? BASEMAP_VECTOR_LAYERS : INFRASTRUCTURE_VECTOR_LAYERS,
      })),
    auxiliaryFiles: packageDescriptors
      .filter(({ kind }) => !["basemap", "infrastructure", "glyph", "sprite"].includes(kind))
      .map((descriptor) => ({ ...descriptor, visibility: "public" }))
      .concat([
        {
          id: "release-manifest",
          kind: "release-manifest",
          visibility: "public",
          sourceFile: unsignedDeliveryFile,
          installPath: "manifests/release.json",
        },
        {
          id: "source-manifest",
          kind: "source-manifest",
          visibility: "public",
          sourceFile: deliverySourcesFile,
          installPath: "manifests/sources.json",
        },
      ]),
    auxiliaryTrees: [
      {
        idPrefix: "glyph",
        kind: "glyph",
        visibility: "public",
        sourceDirectory: "outputs/assets/fonts",
        installDirectory: "assets/fonts",
        expectedInventory: { "fixture.pbf": 1 },
      },
      {
        idPrefix: "sprite",
        kind: "sprite",
        visibility: "public",
        sourceDirectory: "outputs/assets/sprites",
        installDirectory: "assets/sprites",
        expectedInventory: { "dark.json": 1, "dark.png": 1 },
      },
    ],
  };
  await write(value.root, basePlanFile, `${JSON.stringify(basePlan, null, 2)}\n`);
  const signedPlan = await expandMapPackagePlan(basePlan, value.root);
  for (const descriptor of [...signedPlan.artifacts, ...signedPlan.auxiliaryFiles]) {
    if (descriptor.kind === "release-manifest") descriptor.sourceFile = deliveryOutputFile;
    const descriptorProof = await proof(value.root, descriptor.sourceFile);
    descriptor.expectedBytes = descriptorProof.bytes;
    descriptor.expectedSha256 = descriptorProof.sha256;
  }
  await write(value.root, signedPlanFile, `${JSON.stringify(signedPlan, null, 2)}\n`);
  const trustedDeliveryKeysBytes = Buffer.from(`${JSON.stringify(value.trustedDeliveryKeys, null, 2)}\n`, "utf8");
  await write(value.root, trustedKeysFile, trustedDeliveryKeysBytes);

  const spec = structuredClone(value.spec);
  spec.schema = "zugfolge-map-release-build-evidence-spec/v2";
  delete spec.commits;
  spec.inputs = spec.inputs.map(({ expectedBytes: ignoredBytes, expectedSha256: ignoredSha256, ...input }) => {
    void ignoredBytes;
    void ignoredSha256;
    return input.kind === "specification" ? { ...input, version: releaseId } : input;
  });
  spec.inputs.push({
    id: "infra-release-artifact-inventory",
    kind: "derived-input",
    version: releaseVersion,
    file: artifactInventoryFile,
    cacheFile: artifactInventoryCacheFile,
  });
  spec.inputs.push({
    id: "timetable-routes-v2",
    kind: "derived-input",
    version: releaseId,
    file: timetableRoutesFile,
    cacheFile: timetableRoutesCacheFile,
  });
  spec.inputs.push(
    {
      id: "infra-release-wrapper",
      kind: "derived-input",
      version: releaseVersion,
      file: infraReleaseWrapperFile,
      cacheFile: infraReleaseWrapperCacheFile,
    },
    {
      id: "map-release-wrapper",
      kind: "derived-input",
      version: releaseVersion,
      file: mapReleaseWrapperFile,
      cacheFile: mapReleaseWrapperCacheFile,
    },
    {
      id: "delivery-sources",
      kind: "derived-input",
      version: releaseVersion,
      file: deliverySourcesFile,
      cacheFile: deliverySourcesCacheFile,
    },
  );
  spec.inputs.push({
    id: "map-package-base-plan",
    kind: "specification",
    version: releaseId,
    file: basePlanFile,
  });
  spec.outputs = spec.outputs.map((output) => {
    if (output.kind === "train-map-projection") return {
        id: "operational-infrastructure",
        kind: "operational-infrastructure-v2",
        file: operationalFile,
        installFile: "operational-infrastructure-v2.json",
      };
    if (output.kind === "delivery-manifest") return { ...output, file: deliveryOutputFile };
    return output;
  });
  spec.candidatePackage = {
    basePlanInputId: "map-package-base-plan",
    signedPlanFile,
    trustedKeysFile,
    retainedTrustedKeyIds: [value.rollbackKeyId, value.worldKeyId].sort(),
  };
  const specFile = "tools/tiles/map-release-build-evidence.operational-v2.spec.json";
  const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
  await write(value.root, specFile, specBytes);
  const deliverySources = value.deliverySources.filter(({ kind }) => kind !== "train-map-projection");
  deliverySources.push({
    id: `operational-infrastructure-${releaseVersion}`,
    kind: "operational-infrastructure-v2",
    sourceFile: operationalFile,
    installPath: "operational-infrastructure-v2.json",
    infraReleaseId: releaseId,
    stateHash,
  });
  deliverySources.push({
    id: `operational-movement-routes-${releaseVersion}`,
    kind: "movement-route-templates-v2",
    sourceFile: movementFile,
    installPath: "operational-infrastructure-v2.movement-route-templates-v2.json",
  });
  deliverySources.push({
    id: `timetable-transfer-demands-${releaseVersion}`,
    kind: "timetable-transfer-demands-v2",
    sourceFile: transferFile,
    installPath: "timetable-routes-v2.transfer-demands-v2.json",
  });
  return {
    ...value,
    spec,
    specBytes,
    specFile,
    signedDelivery,
    artifactInventoryFile,
    artifactInventoryCacheFile,
    infraReleaseWrapperFile,
    infraReleaseWrapperCacheFile,
    mapReleaseWrapperFile,
    mapReleaseWrapperCacheFile,
    deliverySourcesFile,
    deliverySourcesCacheFile,
    cacheInventoryPath,
    operationalFile,
    movementFile,
    transferFile,
    timetableRoutesFile,
    timetableRoutesCacheFile,
    basePlanFile,
    signedPlanFile,
    trustedKeysFile,
    trustedDeliveryKeysBytes,
    deliveryOutputFile,
    stateHash,
    inventory: cacheInventory,
    cached: [
      ...value.cached,
      [artifactInventoryFile, artifactInventoryCacheFile],
      [timetableRoutesFile, timetableRoutesCacheFile],
      [infraReleaseWrapperFile, infraReleaseWrapperCacheFile],
      [mapReleaseWrapperFile, mapReleaseWrapperCacheFile],
      [deliverySourcesFile, deliverySourcesCacheFile],
    ],
    legacyDeliverySources: value.deliverySources,
    deliverySources,
    commits: { semanticExport: "3".repeat(40), mapBuild: "4".repeat(40) },
  };
}

async function materialized(value) {
  return materializeMapReleaseBuildEvidence({
    spec: value.spec,
    specBytes: value.specBytes,
    specFile: value.specFile,
    artifactRoot: value.root,
    ...(value.commits === undefined ? {} : { commits: value.commits }),
    ...(value.validateOperationalInfrastructure === undefined
      ? {}
      : { validateOperationalInfrastructure: value.validateOperationalInfrastructure }),
  });
}

async function currentAnnualOperationalAuthorityFixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-authority-"));
  const releaseId = "infra-deutschland-2026.5";
  const mapBuildCommit = "4".repeat(40);
  const completionSuffix = ".zugfolge-complete.json";
  const completionSchema = "zugfolge-germany-annual-create-new-artifact-completion/v1";
  const customPredicateType = "https://zugfolge.de/attestations/operational-v2-execution-authority/v1";
  const paths = {
    config: "tools/region-import/germany/release.annual-2026.5.config.json",
    sourceCatalog: "tools/region-import/germany/source-catalog.json",
    rights: "tools/guards/quellenregister.json",
    context: "var/derived/germany-2026.5/toolchain/operational-launch-context.json",
    plan: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json",
    start: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json",
    outer: "var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json",
    rebuildBundle: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json",
    executionBundle: "var/derived/germany-2026.5/toolchain/zugfolge-operational-v2-execution-authority.sigstore.json",
    verifier: "var/derived/germany-2026.5/toolchain/gh-2.94.0-windows-amd64.exe",
    trustedRoot: "var/derived/germany-2026.5/toolchain/github-attestation-trusted-root.jsonl",
    executionPins: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
    specification: "tools/region-import/germany/operational-infrastructure.annual-2026.5.json",
    candidate: "var/derived/germany-2026.5/operational-infrastructure-v2.candidate.json",
    candidateSidecar: "var/derived/germany-2026.5/operational-infrastructure-v2.candidate.movement-route-templates-v2.json",
    report: "var/derived/germany-2026.5/operational-infrastructure-v2.derivation-report.json",
    nativeReceipt: "var/derived/germany-2026.5/operational-infrastructure-v2.native-receipt.json",
    published: "var/derived/germany-2026.5/operational-infrastructure-v2.json",
    publicationReceipt: "var/derived/germany-2026.5/operational-infrastructure-v2.publication-receipt.json",
  };
  const operationalBindings = {
    candidatePath: paths.candidate,
    candidateSidecarPath: paths.candidateSidecar,
    executionPinsPath: paths.executionPins,
    nativeReceiptPath: paths.nativeReceipt,
    outerExecutionReceiptPath: paths.outer,
    publicationReceiptPath: paths.publicationReceipt,
    publishedOutputPath: paths.published,
    reportPath: paths.report,
    schema: "zugfolge-operational-v2-annual-plan-bindings/v1",
    sourceRoot: ".",
    specificationPath: paths.specification,
  };
  const releaseConfig = {
    pipeline: {
      operationalDeriver: {
        candidate: paths.candidate,
        candidateMovementRouteTemplates: paths.candidateSidecar,
        executionPins: paths.executionPins,
        output: paths.published,
        report: paths.report,
        sourceRoot: ".",
        specification: paths.specification,
        recoveryPublisher: {
          nativeReceipt: paths.nativeReceipt,
          outerExecutionReceipt: paths.outer,
          publicationReceipt: paths.publicationReceipt,
        },
      },
    },
  };
  const context = {
    candidatePath: paths.candidate,
    candidateSidecarPath: paths.candidateSidecar,
    executionPinsPath: paths.executionPins,
    nativeReceiptPath: paths.nativeReceipt,
    reportPath: paths.report,
    runtimePath: "C:\\nodejs\\node.exe",
    schema: "zugfolge-operational-v2-direct-system-launch-context/v1",
    sourceRoot: ".",
    specificationPath: paths.specification,
  };
  const plan = {
    releaseId,
    schema: "zugfolge-annual-infra-plan/v1",
    stages: [{ id: "operational-v2-derivation", operationalBindings }],
  };
  const putJson = async (file, value) => {
    await write(root, file, serializeMapReleaseBuildEvidence(value));
    return { file, ...(await proof(root, file)) };
  };
  const putBytes = async (file, value) => {
    await write(root, file, Buffer.from(value));
    return { file, ...(await proof(root, file)) };
  };
  const configProof = await putJson(paths.config, releaseConfig);
  const sourceProof = await putJson(paths.sourceCatalog, { schema: "fixture-source-catalog/v1" });
  const rightsProof = await putJson(paths.rights, { schema: "fixture-rights/v1" });
  const contextProof = await putJson(paths.context, context);
  const planProof = await putJson(paths.plan, plan);
  const startProof = await putJson(paths.start, { releaseId, schema: "zugfolge-operational-validator-annual-executor-start-evidence/v1" });
  const outerProof = await putJson(paths.outer, { releaseId, schema: "fixture-outer/v1" });
  const completion = async (artifact) => putJson(`${artifact.file}${completionSuffix}`, {
    artifact,
    schema: completionSchema,
  });
  const planCompletionProof = await completion(planProof);
  const startCompletionProof = await completion(startProof);
  const outerCompletionProof = await completion(outerProof);
  const rebuildBundleProof = await putJson(paths.rebuildBundle, { bundle: "fixture-rebuild" });
  const executionBundleProof = await putJson(paths.executionBundle, { bundle: "fixture-execution" });
  const verifierProof = await putBytes(paths.verifier, "fixture-held-gh-verifier");
  const trustedRootProof = await putBytes(paths.trustedRoot, "fixture-held-github-trusted-root");
  const rebuildSubjectProofs = [];
  for (const [file, value] of [
    ["var/derived/germany-2026.5/toolchain/rebuilt.exe", "rebuilt"],
    ["var/derived/germany-2026.5/toolchain/rebuild-provenance.json", "provenance"],
    ["var/derived/germany-2026.5/toolchain/rebuild-evidence.json", "evidence"],
    ["var/derived/germany-2026.5/toolchain/preserved.exe", "preserved"],
    ["tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json", "contract"],
  ]) rebuildSubjectProofs.push(await putBytes(file, value));
  const rebuildSubjects = [
    ...rebuildSubjectProofs.map(({ file }) => file),
    paths.plan,
    `${paths.plan}${completionSuffix}`,
    paths.start,
    `${paths.start}${completionSuffix}`,
  ];
  const rebuildSpec = {
    authority: {
      annualExecutorPlan: { planFile: paths.plan, startEvidenceFile: paths.start },
      attestation: {
        bundleFile: paths.rebuildBundle,
        predicateType: "https://slsa.dev/provenance/v1",
        subjects: rebuildSubjects,
        verification: {
          command: "gh attestation verify",
          denySelfHostedRunners: true,
          signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml",
        },
      },
      repository: "larynxberlin-rgb/Zugfolge",
      requiredRef: "refs/heads/main",
    },
  };
  const input = (id, kind, value) => ({ id, kind, version: releaseId, ...value });
  const inputs = [
    input("germany-release-spec", "specification", configProof),
    input("germany-source-catalog", "repo-contract", sourceProof),
    input("rights-registry", "repo-contract", rightsProof),
    input("operational-outer-execution-receipt", "derived-input", outerProof),
    input("operational-outer-execution-receipt-completion", "derived-input", outerCompletionProof),
    input("operational-annual-plan", "derived-input", planProof),
    input("operational-annual-plan-completion", "derived-input", planCompletionProof),
    input("operational-annual-executor-start-evidence", "derived-input", startProof),
    input("operational-annual-executor-start-evidence-completion", "derived-input", startCompletionProof),
    input("operational-validator-rebuild-attestation", "derived-input", rebuildBundleProof),
    input("operational-execution-authority-attestation", "derived-input", executionBundleProof),
    input("operational-attestation-verifier", "derived-input", verifierProof),
    input("operational-attestation-trusted-root", "derived-input", trustedRootProof),
  ];
  const outerExecution = {
    proof: outerProof,
    receipt: {
      attestedPlan: planProof,
      attestedPlanStartEvidence: startProof,
      executionPins: { file: paths.executionPins },
      inputs: [configProof, sourceProof, rightsProof, contextProof, planProof, startProof],
      outputs: {
        candidate: { file: paths.candidate },
        movementRouteTemplates: { file: paths.candidateSidecar },
        nativeReceipt: { file: paths.nativeReceipt },
        report: { file: paths.report },
      },
    },
  };
  const predicate = {
    executionJob: {
      mode: "windows-kill-on-job-close-root-exit-bounded-io-v1",
      timeoutMilliseconds: 21_600_000,
    },
    origin: "local-held-runner",
    outerExecutionCompletion: outerCompletionProof,
    outerExecutionReceipt: outerProof,
    planAuthority: {
      artifact: { digest: `sha256:${"a".repeat(64)}`, id: 12_345, workflowRunId: 67_890 },
      bundle: rebuildBundleProof,
      plan: planProof,
      planCompletion: planCompletionProof,
      startEvidence: startProof,
      startEvidenceCompletion: startCompletionProof,
    },
    protectedEnvironment: "operational-release-approval",
    releaseId,
    requiredPhases: [
      "materialize-annual-plan-evidence-v1",
      "execute-annual-operational-v2-v1",
      "derive-and-capture-v1",
    ],
    schema: "zugfolge-operational-v2-execution-authority/v1",
    source: { commit: mapBuildCommit, ref: "refs/heads/main", repository: "larynxberlin-rgb/Zugfolge" },
    verificationScope: "operator-approved-hash-binding-not-source-reexecution-v1",
  };
  const calls = [];
  const verifier = async (request) => {
    calls.push(request);
    const bytes = await readFile(request.subjectPath);
    return [{
      verificationResult: {
        statement: {
          predicate: request.predicateType === customPredicateType ? predicate : { buildType: "fixture" },
          predicateType: request.predicateType,
          subject: [{ digest: { sha256: sha256(bytes) }, name: request.expectedSubjectName }],
        },
      },
    }];
  };
  return {
    root,
    releaseId,
    mapBuildCommit,
    inputs,
    releaseConfig,
    rebuildSpec,
    outerExecution,
    predicate,
    verifier,
    verifierProof,
    trustedRootProof,
    calls,
    paths,
  };
}

async function firstClassOperationalSidecarFixture(value) {
  const evidence = await materialized(value);
  const movement = JSON.parse(await readFile(join(value.root, ...value.movementFile.split("/")), "utf8"));
  const transfers = JSON.parse(await readFile(join(value.root, ...value.transferFile.split("/")), "utf8"));
  return {
    inputs: evidence.inputs,
    outputs: [
      evidence.outputs.find(({ kind }) => kind === "operational-infrastructure-v2"),
      {
        id: "operational-movement-routes",
        kind: "movement-route-templates-v2",
        file: value.movementFile,
        installFile: "operational-infrastructure-v2.movement-route-templates-v2.json",
        ...(await proof(value.root, value.movementFile)),
        infraReleaseId: movement.infraReleaseId,
        operationalStateHash: movement.operationalStateHash,
        timetableTransferSetSha256: movement.timetableTransferSetSha256,
        stateHash: movement.stateHash,
      },
      {
        id: "timetable-transfer-demands",
        kind: "timetable-transfer-demands-v2",
        file: value.transferFile,
        installFile: "timetable-routes-v2.transfer-demands-v2.json",
        ...(await proof(value.root, value.transferFile)),
        infraReleaseId: transfers.infraReleaseId,
        dailyPlanSha256: transfers.dailyPlan.planSha256,
        transferSetSha256: transfers.transferSetSha256,
      },
    ],
  };
}

async function rewriteEvidenceSpec(value) {
  value.specBytes = Buffer.from(`${JSON.stringify(value.spec, null, 2)}\n`);
  await write(value.root, value.specFile, value.specBytes);
}

async function configureReusableOfficialSpecification(value) {
  const descriptor = value.spec.inputs.find(({ id }) => id === "germany-release-spec");
  await write(value.root, descriptor.file, `${JSON.stringify({
    schema: "zugfolge-official-operating-points/v1",
    releaseId: value.previousReleaseId,
    sourceFile: `var/derived/germany-${value.previousReleaseVersion}/infrago-adapter/operating-points.jsonseq`,
    outputDirectory: `var/derived/germany-${value.previousReleaseVersion}/operating-points-open-data-v1`,
  })}\n`);
  const outputs = [
    ["official-operating-points-report.json", Buffer.from("reused report bytes\n")],
    ["operating-points.geojsonseq", Buffer.from("reused operating-point bytes\n")],
  ];
  const artifacts = [];
  for (const [file, bytes] of outputs) {
    const sourceFile = `var/derived/germany-${value.previousReleaseVersion}/operating-points-open-data-v1/${file}`;
    const targetFile = `var/derived/germany-${value.releaseVersion}/operating-points-open-data-v1/${file}`;
    await write(value.root, sourceFile, bytes);
    await write(value.root, targetFile, Buffer.from(bytes));
    artifacts.push({ sourceFile, targetFile, ...(await proof(value.root, sourceFile)) });
  }
  const specificationProof = await proof(value.root, descriptor.file);
  Object.assign(descriptor, {
    version: value.previousReleaseId,
    reuse: {
      mode: "byte-identical-cross-release",
      sourceReleaseId: value.previousReleaseId,
      targetReleaseId: value.releaseId,
      artifacts,
    },
    expectedBytes: specificationProof.bytes,
    expectedSha256: specificationProof.sha256,
  });
  return descriptor;
}

function resignDelivery(value, delivery) {
  const { releaseHash: ignoredHash, signature: ignoredSignature, ...unsigned } = delivery;
  void ignoredHash;
  void ignoredSignature;
  unsigned.approvalGates = {
    ...unsigned.approvalGates,
    signature: { status: "missing", reason: UNSIGNED_SIGNATURE_REASON },
  };
  unsigned.releaseHash = null;
  unsigned.signature = null;
  return signMapDeliveryRelease(unsigned, value.privateKey.export({ type: "pkcs8", format: "pem" }), value.deliveryKeyId);
}

async function writeLargeCanonicalOperationalInfrastructure(path, releaseId = RELEASE_ID) {
  const canonical = canonicalOperationalInfrastructureV2Json(operationalInfrastructureV2(releaseId));
  const marker = '"regionBoundaries":["region:deutschland-ebo"]';
  const markerOffset = canonical.indexOf(marker);
  assert.notEqual(markerOffset, -1);
  const prefix = `${canonical.slice(0, markerOffset)}"regionBoundaries":[`;
  const suffix = `${canonical.slice(markerOffset + marker.length)}\n`;
  const handle = await open(path, "w");
  try {
    await handle.write(prefix);
    for (let start = 0; start < 4_096; start += 128) {
      const values = [];
      for (let index = start; index < start + 128; index += 1) {
        values.push(`region-${String(index).padStart(4, "0")}-${"x".repeat(16_384)}`);
      }
      await handle.write(`${start === 0 ? "" : ","}${values.map((value) => JSON.stringify(value)).join(",")}`);
    }
    await handle.write(suffix);
  } finally {
    await handle.close();
  }
}

async function replaceOperationalBindings(value, operationalProof, stateHash) {
  const inventoryPath = join(value.root, ...value.artifactInventoryFile.split("/"));
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  Object.assign(inventory.artifacts.find(({ kind }) => kind === "operational-infrastructure-v2"), operationalProof, { stateHash });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const inventoryProof = await proof(value.root, value.artifactInventoryFile);

  const qualityPath = join(value.root, "outputs", "quality.json");
  const quality = JSON.parse(await readFile(qualityPath, "utf8"));
  quality.operationalModel.operationalArtifact = { ...operationalProof, stateHash };
  quality.operationalModel.movementRouteTemplates.operationalStateHash = stateHash;
  await writeFile(qualityPath, `${JSON.stringify(quality, null, 2)}\n`);
  const qualityProof = await proof(value.root, "outputs/quality.json");

  const infraWrapperPath = join(value.root, ...value.infraReleaseWrapperFile.split("/"));
  const infraWrapper = JSON.parse(await readFile(infraWrapperPath, "utf8"));
  Object.assign(infraWrapper.release.artifacts.find(({ kind }) => kind === "operational-infrastructure-v2"), operationalProof, { stateHash });
  Object.assign(infraWrapper.release.quality.operationalClosure, {
    reportSha256: qualityProof.sha256,
    candidateBytes: operationalProof.bytes,
    candidateSha256: operationalProof.sha256,
    candidateStateHash: stateHash,
    movementRouteTemplates: structuredClone(quality.operationalModel.movementRouteTemplates),
  });
  const updatedInfraWrapper = releaseWrapper(infraWrapper.release);
  await writeFile(infraWrapperPath, `${JSON.stringify(updatedInfraWrapper, null, 2)}\n`);
  const infraWrapperProof = await proof(value.root, value.infraReleaseWrapperFile);

  const cachePath = join(value.root, ...value.cacheInventoryPath.split("/"));
  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  Object.assign(cache.files.find(({ path }) => path === value.artifactInventoryCacheFile), inventoryProof);
  Object.assign(cache.files.find(({ path }) => path === value.infraReleaseWrapperCacheFile), infraWrapperProof);
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

  const deliveryPath = join(value.root, ...value.deliveryOutputFile.split("/"));
  const delivery = JSON.parse(await readFile(deliveryPath, "utf8"));
  Object.assign(delivery.artifacts.find(({ kind }) => kind === "operational-infrastructure-v2"), operationalProof, { stateHash });
  Object.assign(delivery.artifacts.find(({ kind }) => kind === "quality-manifest"), qualityProof);
  delivery.bindings.qualitySha256 = qualityProof.sha256;
  delivery.bindings.infraReleaseHash = updatedInfraWrapper.releaseHash;
  const signed = resignDelivery(value, delivery);
  value.signedDelivery = signed;
  await writeFile(deliveryPath, serializeDeliveryJson(signed));
  const deliveryProof = await proof(value.root, value.deliveryOutputFile);
  const signedPlanPath = join(value.root, ...value.signedPlanFile.split("/"));
  const signedPlan = JSON.parse(await readFile(signedPlanPath, "utf8"));
  Object.assign(signedPlan.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2"), {
    expectedBytes: operationalProof.bytes,
    expectedSha256: operationalProof.sha256,
    stateHash,
  });
  Object.assign(signedPlan.auxiliaryFiles.find(({ kind }) => kind === "quality-manifest"), {
    expectedBytes: qualityProof.bytes,
    expectedSha256: qualityProof.sha256,
  });
  Object.assign(signedPlan.auxiliaryFiles.find(({ kind }) => kind === "release-manifest"), {
    expectedBytes: deliveryProof.bytes,
    expectedSha256: deliveryProof.sha256,
  });
  await writeFile(signedPlanPath, `${JSON.stringify(signedPlan, null, 2)}\n`);
}

async function refreshSignedPlanPins(value, kinds) {
  const signedPlanPath = join(value.root, ...value.signedPlanFile.split("/"));
  const signedPlan = JSON.parse(await readFile(signedPlanPath, "utf8"));
  for (const kind of kinds) {
    const descriptor = signedPlan.auxiliaryFiles.find((entry) => entry.kind === kind);
    const descriptorProof = await proof(value.root, descriptor.sourceFile);
    descriptor.expectedBytes = descriptorProof.bytes;
    descriptor.expectedSha256 = descriptorProof.sha256;
  }
  await writeFile(signedPlanPath, `${JSON.stringify(signedPlan, null, 2)}\n`);
}

function manifestEntry(descriptor, observed) {
  const common = {
    id: descriptor.id,
    kind: descriptor.kind,
    installPath: descriptor.installPath,
    bytes: observed.bytes,
    sha256: observed.sha256,
  };
  if (["basemap", "infrastructure"].includes(descriptor.kind)) {
    return {
      ...common,
      minZoom: descriptor.kind === "basemap" ? 0 : 4,
      maxZoom: descriptor.kind === "basemap" ? 15 : 18,
      vectorLayers: descriptor.kind === "basemap" ? BASEMAP_VECTOR_LAYERS : INFRASTRUCTURE_VECTOR_LAYERS,
      parts: [{ path: `parts/${descriptor.id}.pmtiles.part-00001`, ...observed }],
    };
  }
  const mediaType = descriptor.kind === "glyph"
    ? "application/x-protobuf"
    : descriptor.kind === "sprite" && descriptor.installPath.endsWith(".png")
      ? "image/png"
      : ["read-model", "train-map-projection"].includes(descriptor.kind)
        ? "application/vnd.sqlite3"
        : "application/json";
  return {
    ...common,
    ...(descriptor.kind === "operational-infrastructure-v2"
      ? { infraReleaseId: descriptor.infraReleaseId, stateHash: descriptor.stateHash }
      : {}),
    visibility: "public",
    mediaType,
    parts: [{ path: `parts/${descriptor.id}.part-00001`, ...observed }],
  };
}

async function installPackageFixture(value, deploymentRoot, releaseId) {
  const installRoot = join(deploymentRoot, "releases", releaseId);
  const candidate = releaseId === value.releaseId;
  const packageVersion = releaseId.replace("infra-deutschland-", "");
  const sourceDescriptors = !candidate && value.legacyDeliverySources !== undefined
    ? value.legacyDeliverySources
    : value.deliverySources;
  const descriptors = sourceDescriptors.map((descriptor) => ({
    ...descriptor,
    installPath: descriptor.kind === "infrastructure" ? `${releaseId}.pmtiles` : descriptor.installPath,
  }));
  for (const descriptor of descriptors) {
    const target = join(installRoot, ...descriptor.installPath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    if (!candidate && descriptor.kind === "quality-manifest") {
      await writeFile(target, serializeDeliveryJson({
        schema: "zugfolge-final-infrastructure-quality-report/v1",
        releaseId,
        deterministic: true,
        summary: { visibleLayers: 10, visibleFeatures: 10 },
      }));
    } else {
      await copyFile(join(value.root, ...descriptor.sourceFile.split("/")), target);
    }
  }

  const sourceDescriptor = {
    id: "source-manifest",
    kind: "source-manifest",
    installPath: "manifests/sources.json",
  };
  const releaseDescriptor = {
    id: "release-manifest",
    kind: "release-manifest",
    installPath: "manifests/release.json",
  };
  const sourcesBytes = candidate
    ? serializeDeliveryJson(value.sources)
    : serializeDeliveryJson({ schema: "zugfolge-map-delivery-sources/v1", releaseId, sources: value.sources.sources });
  await write(installRoot, sourceDescriptor.installPath, sourcesBytes);
  if (candidate) {
    await write(installRoot, releaseDescriptor.installPath, serializeDeliveryJson(value.signedDelivery));
  } else {
    const artifacts = [];
    for (const descriptor of descriptors) artifacts.push({
      id: descriptor.id,
      kind: descriptor.kind,
      installPath: descriptor.installPath,
      ...(await proof(installRoot, descriptor.installPath)),
    });
    artifacts.sort((left, right) => left.id.localeCompare(right.id, "en"));
    const unsigned = {
      schema: "zugfolge-map-delivery-release/v1",
      releaseId,
      timetableYear: 2026,
      packageId: "zugfolge-map-deutschland",
      packageVersion,
      scope: {},
      artifacts,
      bindings: {
        packageManifestSchema: "zugfolge-map-package/v1",
        infraReleaseSchema: "zugfolge-infra-release/v2",
        mapReleaseSchema: "zugfolge-map-release/v1",
        sourcesSha256: sha256(sourcesBytes),
        qualitySha256: artifacts.find(({ kind }) => kind === "quality-manifest").sha256,
      },
      approvalGates: {
        rights: { status: "passed" },
        quality: { status: "passed" },
        signature: { status: "missing" },
      },
      signature: null,
    };
    await write(installRoot, releaseDescriptor.installPath, serializeDeliveryJson(unsigned));
  }

  const direct = [];
  for (const descriptor of [...descriptors, sourceDescriptor, releaseDescriptor]) {
    direct.push(manifestEntry(descriptor, await proof(installRoot, descriptor.installPath)));
  }
  const manifest = {
    schema: candidate && value.spec.schema !== "zugfolge-map-release-build-evidence-spec/v1"
      ? "zugfolge-map-package/v2"
      : "zugfolge-map-package/v1",
    packageId: "zugfolge-map-deutschland",
    version: packageVersion,
    format: "directory-parts",
    partBytes: 100 * 1024 * 1024,
    runtime: {
      schema: candidate && value.spec.schema !== "zugfolge-map-release-build-evidence-spec/v1"
        ? "zugfolge-map-runtime/v2"
        : "zugfolge-map-runtime/v1",
      publicBasePath: `/artifacts/maps/${releaseId}`,
      basemapStyleUrl: `/artifacts/maps/${releaseId}/style.json`,
      infrastructurePmtilesUrl: `/artifacts/maps/${releaseId}/${releaseId}.pmtiles`,
    },
    artifacts: direct.filter(({ kind }) => ["basemap", "infrastructure"].includes(kind)).sort((left, right) => left.id.localeCompare(right.id, "en")),
    auxiliaryFiles: direct.filter(({ kind }) => !["basemap", "infrastructure"].includes(kind)).sort((left, right) => left.id.localeCompare(right.id, "en")),
  };
  await write(installRoot, ".zugfolge-map-package.json", serializeMapPackageManifest(manifest));
  return { installRoot, manifest };
}

async function writeActivationPointer(value, deploymentRoot, releaseId = value.previousReleaseId) {
  const installPath = releaseId === value.previousReleaseId
    ? value.spec.deployment.previousInstallPath
    : value.spec.deployment.candidateInstallPath;
  return write(deploymentRoot, value.spec.deployment.activationPointer, [
    `MAP_RELEASE_ID=${releaseId}`,
    `MAP_RELEASE_HOST_DIR=${installPath}`,
    `MAP_BASEMAP_STYLE_URL=/artifacts/maps/${releaseId}/style.json`,
    `MAP_GERMANY_PMTILES_URL=/artifacts/maps/${releaseId}/${releaseId}.pmtiles`,
    "",
  ].join("\n"));
}

test("bindet vollständige Inputs, Werkzeuge, Commits, Ausgaben und die reale BOStrab-Regression", async () => {
  const value = await fixture();
  try {
    const evidence = await materialized(value);
    assert.equal(evidence.schema, "zugfolge-map-release-build-evidence/v1");
    assert.equal(evidence.releaseId, RELEASE_ID);
    assert.equal(evidence.inputs.length, 5);
    assert.equal(evidence.outputs.length, 7);
    assert.equal(evidence.deliveryInventory.length, 9);
    assert.equal(evidence.regressions.semanticLayers.length, 10);
    assert.equal(evidence.regressions.requiredEboSignalFeatureIds[0], EBO_SIGNAL);
    assert.equal((await verifyMapReleaseBuildEvidence(evidence, value.root)).semanticLayers, 10);
    assert.deepEqual(serializeMapReleaseBuildEvidence(evidence), serializeMapReleaseBuildEvidence(evidence));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bindet jedes Build-Evidence-Schema an seine explizit zugelassenen Jahresreleases", async () => {
  const legacy = await fixture();
  const operational = await fixtureV2();
  try {
    assert.doesNotThrow(() => validateMapReleaseBuildEvidenceSpec(legacy.spec));
    assert.doesNotThrow(() => validateMapReleaseBuildEvidenceSpec(operational.spec));

    const upgradedLegacy = structuredClone(legacy.spec);
    upgradedLegacy.schema = "zugfolge-map-release-build-evidence-spec/v2";
    assert.throws(
      () => validateMapReleaseBuildEvidenceSpec(upgradedLegacy),
      /Build-Evidence-v2 ist nicht fuer den Release infra-deutschland-2026\.2 zugelassen/u,
    );

    const downgradedOperational = structuredClone(operational.spec);
    downgradedOperational.schema = "zugfolge-map-release-build-evidence-spec/v1";
    assert.throws(
      () => validateMapReleaseBuildEvidenceSpec(downgradedOperational),
      /Build-Evidence-v1 ist nicht fuer den Release infra-deutschland-2026\.3 zugelassen/u,
    );

    for (const [releaseId, previousReleaseId] of [
      ["infra-deutschland-2026.6", "infra-deutschland-2026.5"],
      ["infra-deutschland-2027.2", "infra-deutschland-2027.1"],
      ["infra-deutschland-2026.05", "infra-deutschland-2026.4"],
    ]) {
      const future = structuredClone(operational.spec);
      future.releaseId = releaseId;
      future.previousReleaseId = previousReleaseId;
      assert.throws(
        () => validateMapReleaseBuildEvidenceSpec(future),
        /nicht fuer den Release|Jahres-Patchrelease/u,
      );
    }

    const futureV3 = structuredClone(operational.spec);
    futureV3.schema = "zugfolge-map-release-build-evidence-spec/v3";
    futureV3.releaseId = "infra-deutschland-2026.6";
    futureV3.previousReleaseId = "infra-deutschland-2026.5";
    assert.throws(
      () => validateMapReleaseBuildEvidenceSpec(futureV3),
      /Build-Evidence-v3 ist nicht fuer den Release infra-deutschland-2026\.6 zugelassen/u,
    );
  } finally {
    await rm(legacy.root, { recursive: true, force: true });
    await rm(operational.root, { recursive: true, force: true });
  }
});

test("bindet Operational-v2 statt Train-Projektion mit Laufzeit-Commits und typisiertem Artefaktinventar", async () => {
  const value = await fixtureV2();
  try {
    const evidence = await materialized(value);
    assert.equal(evidence.schema, "zugfolge-map-release-build-evidence/v2");
    assert.deepEqual(evidence.commits, value.commits);
    assert.equal(evidence.outputs.some(({ kind }) => kind === "train-map-projection"), false);
    const operational = evidence.outputs.find(({ kind }) => kind === "operational-infrastructure-v2");
    assert.equal(operational.installFile, "operational-infrastructure-v2.json");
    assert.equal(operational.infraReleaseId, value.releaseId);
    assert.equal(operational.stateHash, value.stateHash);
    assert.notEqual(operational.stateHash, operational.sha256);
    assert.equal(evidence.candidatePackage.packageVersion, value.releaseVersion);
    assert.equal(evidence.candidatePackage.planFile, value.signedPlanFile);
    assert.equal(evidence.candidatePackage.releaseManifestFile, value.deliveryOutputFile);
    assert.equal(evidence.candidatePackage.signatureKeyId, value.deliveryKeyId);
    assert.deepEqual(evidence.candidatePackage.retainedTrustedKeyIds, [value.rollbackKeyId, value.worldKeyId].sort());
    assert.deepEqual(evidence.candidatePackage.trustedKeyIds, [value.deliveryKeyId, value.rollbackKeyId, value.worldKeyId].sort());
    assert.equal(evidence.candidatePackage.releaseManifestSha256, (await proof(value.root, value.deliveryOutputFile)).sha256);
    assert.equal((await verifyMapReleaseBuildEvidence(evidence, value.root)).outputs, 7);

    const cli = fileURLToPath(new URL("./map-release-build-evidence-cli.mjs", import.meta.url));
    const evidencePath = join(value.root, "evidence", "map-release-build-evidence-operational-v2.json");
    const build = spawnSync(process.execPath, [
      cli,
      "build",
      join(value.root, ...value.specFile.split("/")),
      value.root,
      evidencePath,
      value.commits.semanticExport,
      value.commits.mapBuild,
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(build.status, 0, build.stderr);
    assert.equal(JSON.parse(build.stdout).outputs, 7);
    const cliEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(cliEvidence.schema, "zugfolge-map-release-build-evidence/v2");
    assert.deepEqual(cliEvidence.commits, value.commits);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Evidence-v3 ist ausschließlich an den echten aktuellen .5-Jahresvertrag gebunden", async () => {
  const annual = JSON.parse(await readFile(new URL("./map-release-build-evidence.annual-2026.5.spec.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateMapReleaseBuildEvidenceSpec(annual));

  const generic = await fixtureV2();
  try {
    generic.spec.schema = "zugfolge-map-release-build-evidence-spec/v3";
    assert.throws(
      () => validateMapReleaseBuildEvidenceSpec(generic.spec),
      /Build-Evidence-v3 ist nicht fuer den Release infra-deutschland-2026\.3 zugelassen/u,
    );
  } finally {
    await rm(generic.root, { recursive: true, force: true });
  }
});

test("der echte .5-Jahresvertrag pinnt den effektiven Validator und Rebuild getrennt und unveränderlich", async () => {
  const annual = JSON.parse(await readFile(new URL("./map-release-build-evidence.annual-2026.5.spec.json", import.meta.url), "utf8"));
  const validator = annual.tools.find(({ id }) => id === "operational-v2-validator");
  const rebuild = annual.tools.find(({ id }) => id === "operational-v2-validator-rebuild");
  assert.equal(validator.version, "operational-validator-build-commit");
  assert.equal(validator.expectedBytes, 8_382_277);
  assert.match(validator.expectedSha256, /^[a-f0-9]{64}$/u);
  assert.equal(rebuild.version, "operational-validator-rebuild-proof");
  assert.notEqual(rebuild.file, validator.file);

  const drifted = structuredClone(annual);
  drifted.tools.find(({ id }) => id === "operational-v2-validator").expectedSha256 = "f".repeat(64);
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(drifted), /Validator-Binary/u);
});

test("aktuelle Operational-Authority verifiziert zwei Sigstore-Bundles, alle Rebuild-Subjects und das kausale Outer-Predicate", async () => {
  const value = await currentAnnualOperationalAuthorityFixture();
  try {
    const authority = await materializeCurrentAnnualOperationalAuthority({
      artifactRoot: value.root,
      inputs: value.inputs,
      releaseConfig: value.releaseConfig,
      rebuildSpec: value.rebuildSpec,
      outerExecution: value.outerExecution,
      releaseId: value.releaseId,
      mapBuildCommit: value.mapBuildCommit,
      attestationVerifier: value.verifier,
    });
    assert.equal(authority.schema, "zugfolge-map-build-operational-authority/v1");
    assert.equal(authority.rebuild.subjects.length, value.rebuildSpec.authority.attestation.subjects.length);
    assert.equal(authority.execution.subjects.length, 2);
    assert.deepEqual(authority.execution.predicate, value.predicate);
    assert.match(authority.execution.predicateSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(authority.verifier, {
      bytes: value.verifierProof.bytes,
      file: value.paths.verifier,
      id: "operational-attestation-verifier",
      kind: "derived-input",
      sha256: value.verifierProof.sha256,
      version: value.releaseId,
    });
    assert.deepEqual(authority.trustedRoot, {
      bytes: value.trustedRootProof.bytes,
      file: value.paths.trustedRoot,
      id: "operational-attestation-trusted-root",
      kind: "derived-input",
      sha256: value.trustedRootProof.sha256,
      version: value.releaseId,
    });
    const callsPerVerification = value.rebuildSpec.authority.attestation.subjects.length + 2;
    assert.equal(value.calls.length, callsPerVerification);
    for (const call of value.calls) {
      assert.equal(call.repository, "larynxberlin-rgb/Zugfolge");
      assert.equal(call.sourceRef, "refs/heads/main");
      assert.equal(call.sourceDigest, value.mapBuildCommit);
      assert.equal(call.denySelfHostedRunners, true);
      assert.equal(call.verifierProof.sha256, value.verifierProof.sha256);
      assert.equal(call.verifierPath, join(value.root, ...value.paths.verifier.split("/")));
      assert.equal(call.trustedRootProof.sha256, value.trustedRootProof.sha256);
      assert.equal(call.trustedRootPath, join(value.root, ...value.paths.trustedRoot.split("/")));
      assert.equal(call.expectedSubjectName, call.predicateType.includes("operational-v2-execution-authority")
        ? call.subjectPath.slice(value.root.length + 1).replaceAll("\\", "/")
        : call.subjectPath.split(/[\\/]/u).at(-1));
      assert.match(call.signerWorkflow, /larynxberlin-rgb\/Zugfolge\/\.github\/workflows\/(?:operational-validator-rebuild-evidence|operational-v2-execution-authority)\.yml/u);
    }
    assert.doesNotThrow(() => validateCurrentAnnualOperationalAuthority(authority, value.inputs, value.mapBuildCommit));
    await assert.doesNotReject(verifyCurrentAnnualOperationalAuthorityLocal({
      artifactRoot: value.root,
      inputs: value.inputs,
      releaseConfig: value.releaseConfig,
      rebuildSpec: value.rebuildSpec,
      outerExecution: value.outerExecution,
      releaseId: value.releaseId,
      mapBuildCommit: value.mapBuildCommit,
      authority,
      attestationVerifier: value.verifier,
    }));
    assert.equal(value.calls.length, callsPerVerification * 2,
      "lokale Authority-Nachpruefung muss alle Sigstore-Subjects erneut verifizieren");

    const storedOnlyForgery = structuredClone(authority);
    storedOnlyForgery.execution.predicate.planAuthority.artifact.id += 1;
    storedOnlyForgery.execution.predicateSha256 = sha256(Buffer.from(
      JSON.stringify(sortedValue(storedOnlyForgery.execution.predicate)), "utf8",
    ));
    assert.doesNotThrow(() => validateCurrentAnnualOperationalAuthority(
      storedOnlyForgery,
      value.inputs,
      value.mapBuildCommit,
    ));
    await assert.rejects(verifyCurrentAnnualOperationalAuthorityLocal({
      artifactRoot: value.root,
      inputs: value.inputs,
      releaseConfig: value.releaseConfig,
      rebuildSpec: value.rebuildSpec,
      outerExecution: value.outerExecution,
      releaseId: value.releaseId,
      mapBuildCommit: value.mapBuildCommit,
      authority: storedOnlyForgery,
      attestationVerifier: value.verifier,
    }), /anderes Predicate als die gespeicherte Authority/u);

    const wrongSource = structuredClone(authority);
    wrongSource.execution.sourceDigest = "5".repeat(40);
    assert.throws(
      () => validateCurrentAnnualOperationalAuthority(wrongSource, value.inputs, value.mapBuildCommit),
      /geschuetzten GitHub-Sigstore-Authority/u,
    );
    const wrongPredicate = structuredClone(authority);
    wrongPredicate.execution.predicate.planAuthority.plan.sha256 = "f".repeat(64);
    assert.throws(
      () => validateCurrentAnnualOperationalAuthority(wrongPredicate, value.inputs, value.mapBuildCommit),
      /Predicate-Bindung|Predicate\.plan driftet/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Operational-Authority-Helper verlangt den externen Map-Build-Commit und hält die Spezifikation commitfrei", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  await assert.rejects(
    materializeOperationalBuildAuthorityFromBuildEvidenceSpec({ sourceRoot: repositoryRoot }),
    /mapBuildCommit/u,
  );

  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-authority-spec-"));
  try {
    const specFile = "tools/tiles/map-release-build-evidence.annual-2026.5.spec.json";
    const spec = JSON.parse(await readFile(new URL("./map-release-build-evidence.annual-2026.5.spec.json", import.meta.url), "utf8"));
    spec.commits = { mapBuild: "4".repeat(40) };
    await write(root, specFile, `${JSON.stringify(spec, null, 2)}\n`);
    await assert.rejects(
      materializeOperationalBuildAuthorityFromBuildEvidenceSpec({
        sourceRoot: root,
        buildEvidenceSpecFile: specFile,
        mapBuildCommit: "4".repeat(40),
      }),
      /keinen vorab erfundenen Commit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Operational-Authority verweigert falsches Custom Predicate, fehlende Phase-1-Subjects und fremde Completion-Bindungen", async () => {
  const value = await currentAnnualOperationalAuthorityFixture();
  try {
    const ambiguousSubjectVerifier = async (request) => {
      const bytes = await readFile(request.subjectPath);
      return [{ verificationResult: { statement: {
        predicate: request.predicateType.includes("operational-v2-execution-authority")
          ? value.predicate
          : { buildType: "fixture" },
        predicateType: request.predicateType,
        subject: [
          { digest: { sha256: sha256(bytes) }, name: request.expectedSubjectName },
          { digest: { sha256: sha256(bytes) }, name: `extra-${request.expectedSubjectName}` },
        ],
      } } }];
    };
    await assert.rejects(
      materializeCurrentAnnualOperationalAuthority({
        artifactRoot: value.root,
        inputs: value.inputs,
        releaseConfig: value.releaseConfig,
        rebuildSpec: value.rebuildSpec,
        outerExecution: value.outerExecution,
        releaseId: value.releaseId,
        mapBuildCommit: value.mapBuildCommit,
        attestationVerifier: ambiguousSubjectVerifier,
      }),
      /exakte einzelne Subject/u,
    );

    const wrongPredicateVerifier = async (request) => {
      const bytes = await readFile(request.subjectPath);
      return [{ verificationResult: { statement: {
        predicate: request.predicateType.includes("operational-v2-execution-authority")
          ? { ...value.predicate, releaseId: "infra-deutschland-2026.4" }
          : { buildType: "fixture" },
        predicateType: request.predicateType,
        subject: [{ digest: { sha256: sha256(bytes) }, name: request.expectedSubjectName }],
      } } }];
    };
    await assert.rejects(
      materializeCurrentAnnualOperationalAuthority({
        artifactRoot: value.root,
        inputs: value.inputs,
        releaseConfig: value.releaseConfig,
        rebuildSpec: value.rebuildSpec,
        outerExecution: value.outerExecution,
        releaseId: value.releaseId,
        mapBuildCommit: value.mapBuildCommit,
        attestationVerifier: wrongPredicateVerifier,
      }),
      /geschuetzten Authority-Kontext/u,
    );

    const missingPhaseOne = structuredClone(value.rebuildSpec);
    missingPhaseOne.authority.attestation.subjects = missingPhaseOne.authority.attestation.subjects
      .filter((file) => !file.endsWith(`executor-start-evidence.json.zugfolge-complete.json`));
    await assert.rejects(
      materializeCurrentAnnualOperationalAuthority({
        artifactRoot: value.root,
        inputs: value.inputs,
        releaseConfig: value.releaseConfig,
        rebuildSpec: missingPhaseOne,
        outerExecution: value.outerExecution,
        releaseId: value.releaseId,
        mapBuildCommit: value.mapBuildCommit,
        attestationVerifier: value.verifier,
      }),
      /bindet Phase-1-Subject/u,
    );

    const completionInput = value.inputs.find(({ id }) => id === "operational-annual-plan-completion");
    await write(value.root, completionInput.file, serializeMapReleaseBuildEvidence({
      artifact: { ...value.predicate.planAuthority.plan, sha256: "f".repeat(64) },
      schema: "zugfolge-germany-annual-create-new-artifact-completion/v1",
    }));
    Object.assign(completionInput, await proof(value.root, completionInput.file));
    await assert.rejects(
      materializeCurrentAnnualOperationalAuthority({
        artifactRoot: value.root,
        inputs: value.inputs,
        releaseConfig: value.releaseConfig,
        rebuildSpec: value.rebuildSpec,
        outerExecution: value.outerExecution,
        releaseId: value.releaseId,
        mapBuildCommit: value.mapBuildCommit,
        attestationVerifier: value.verifier,
      }),
      /bindet nicht den erwarteten Artefaktbeleg/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("gepinnter Attestierungsverifier ignoriert PATH und verweigert Byte- oder Dateiverweisdrift vor dem Prozessstart", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-held-gh-verifier-test-"));
  const verifierPath = join(root, "held-verifier.exe");
  const swappedVerifierPath = join(root, "swapped-verifier.exe");
  const trustedRootPath = join(root, "trusted-root.jsonl");
  const subjectPath = join(root, "subject.bin");
  const bundlePath = join(root, "bundle.jsonl");
  const fakePathDirectory = join(root, "fake-path");
  try {
    await mkdir(fakePathDirectory);
    await writeFile(join(fakePathDirectory, "gh.exe"), "PATH replacement must never execute");
    await writeFile(verifierPath, "held verifier fixture bytes");
    await writeFile(swappedVerifierPath, "different swapped verifier bytes");
    await writeFile(trustedRootPath, "held trusted root fixture bytes");
    await writeFile(subjectPath, "subject");
    await writeFile(bundlePath, "bundle");
    const verifierProof = { file: "held-verifier.exe", ...(await proof(root, "held-verifier.exe")) };
    const trustedRootProof = { file: "trusted-root.jsonl", ...(await proof(root, "trusted-root.jsonl")) };
    const subjectProof = { file: "subject.bin", ...(await proof(root, "subject.bin")) };
    const bundleProof = { file: "bundle.jsonl", ...(await proof(root, "bundle.jsonl")) };
    const previousPath = process.env.PATH;
    process.env.PATH = fakePathDirectory;
    let starts = 0;
    try {
      const result = await verifyGithubAttestationSubject({
        subjectPath,
        subjectProof,
        bundlePath,
        bundleProof,
        verifierPath,
        verifierProof,
        trustedRootPath,
        trustedRootProof,
        repository: "larynxberlin-rgb/Zugfolge",
        signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/fixture.yml",
        sourceRef: "refs/heads/main",
        sourceDigest: "7".repeat(40),
        predicateType: "https://slsa.dev/provenance/v1",
        denySelfHostedRunners: true,
        heldProcessRunner: async ({ executable, argumentsList, environment, inputFiles }) => {
          starts += 1;
          assert.equal(isAbsolute(executable), true);
          assert.notEqual(executable, verifierPath);
          assert.match(executable, /zugfolge-gh-attestation-[^\\/]+[\\/]gh\.exe$/u);
          assert.equal(environment.PATH, String.raw`C:\Windows\System32;C:\Windows`);
          assert.equal(Object.hasOwn(environment, "GH_TOKEN"), false);
          assert.equal(Object.hasOwn(environment, "GITHUB_TOKEN"), false);
          assert.equal(argumentsList[argumentsList.indexOf("--hostname") + 1], "github.com");
          const heldTrustedRoot = argumentsList[argumentsList.indexOf("--custom-trusted-root") + 1];
          assert.equal(dirname(heldTrustedRoot), dirname(executable));
          assert.deepEqual(inputFiles.map(({ file }) => file), ["subject.bin", "bundle.jsonl", "trusted-root.jsonl"]);
          return [];
        },
      });
      assert.deepEqual(result, []);
      assert.equal(starts, 1);

      const rejectBeforeStart = () => {
        starts += 1;
        throw new Error("process must not start");
      };
      await assert.rejects(verifyGithubAttestationSubject({
        subjectPath,
        subjectProof,
        bundlePath,
        bundleProof,
        verifierPath,
        verifierProof: { ...verifierProof, sha256: "f".repeat(64) },
        trustedRootPath,
        trustedRootProof,
        repository: "larynxberlin-rgb/Zugfolge",
        signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/fixture.yml",
        sourceRef: "refs/heads/main",
        sourceDigest: "7".repeat(40),
        predicateType: "https://slsa.dev/provenance/v1",
        denySelfHostedRunners: true,
        heldProcessRunner: rejectBeforeStart,
      }), /gepinnten SHA-256/u);
      assert.equal(starts, 1);
      await assert.rejects(verifyGithubAttestationSubject({
        subjectPath,
        subjectProof,
        bundlePath,
        bundleProof,
        verifierPath: swappedVerifierPath,
        verifierProof,
        trustedRootPath,
        trustedRootProof,
        repository: "larynxberlin-rgb/Zugfolge",
        signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/fixture.yml",
        sourceRef: "refs/heads/main",
        sourceDigest: "7".repeat(40),
        predicateType: "https://slsa.dev/provenance/v1",
        denySelfHostedRunners: true,
        heldProcessRunner: rejectBeforeStart,
      }), /gepinnte(?:n)? Bytezahl|gepinnten SHA-256/u);
      assert.equal(starts, 1);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows haelt Verifier, Subject, Bundle, Trust-Root und Pfad-Ahnen gegen Replace-Execute-Restore-ABA",
  { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-held-gh-verifier-aba-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const verifierPath = join(root, "fixture-gh.exe");
    const trustedRootPath = join(root, "trusted-root.jsonl");
    const subjectPath = join(root, "subject.bin");
    const bundlePath = join(root, "bundle.jsonl");
    const sourcePath = join(root, "fixture-gh.cs");
    const readyPath = `${subjectPath}.held-ready`;
    const resumePath = `${subjectPath}.held-resume`;
    await writeFile(sourcePath, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class HeldGhFixture {
  public static int Main(string[] arguments) {
    if (arguments.Length < 3 || arguments[0] != "attestation" || arguments[1] != "verify") return 40;
    string subject = arguments[2];
    File.WriteAllText(subject + ".held-ready", Process.GetCurrentProcess().MainModule.FileName);
    DateTime deadline = DateTime.UtcNow.AddSeconds(30);
    while (!File.Exists(subject + ".held-resume") && DateTime.UtcNow < deadline) Thread.Sleep(10);
    if (!File.Exists(subject + ".held-resume")) return 41;
    Console.Out.Write("[]");
    return 0;
  }
}
`, { flag: "wx" });
    const compile = spawnSync(String.raw`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, [
      "/nologo", "/target:exe", "/platform:x64", "/optimize+", "/debug-", `/out:${verifierPath}`, sourcePath,
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
    await Promise.all([
      writeFile(trustedRootPath, "held trusted root fixture bytes", { flag: "wx" }),
      writeFile(subjectPath, "held subject fixture bytes", { flag: "wx" }),
      writeFile(bundlePath, "held bundle fixture bytes", { flag: "wx" }),
    ]);
    const verifierProof = { file: "fixture-gh.exe", ...(await proof(root, "fixture-gh.exe")) };
    const trustedRootProof = { file: "trusted-root.jsonl", ...(await proof(root, "trusted-root.jsonl")) };
    const subjectProof = { file: "subject.bin", ...(await proof(root, "subject.bin")) };
    const bundleProof = { file: "bundle.jsonl", ...(await proof(root, "bundle.jsonl")) };
    const verification = verifyGithubAttestationSubject({
      subjectPath,
      subjectProof,
      bundlePath,
      bundleProof,
      verifierPath,
      verifierProof,
      trustedRootPath,
      trustedRootProof,
      repository: "larynxberlin-rgb/Zugfolge",
      signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/fixture.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: "7".repeat(40),
      predicateType: "https://slsa.dev/provenance/v1",
      denySelfHostedRunners: true,
    });
    const waitForReady = async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try { return await readFile(readyPath, "utf8"); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      throw new Error("Gehaltene gh-Fixture meldete keinen Prozessstart.");
    };
    const assertRenameDenied = async (source, destination, label) => {
      try {
        await rename(source, destination);
      } catch (error) {
        assert.match(error?.code ?? "", /^(?:EACCES|EBUSY|EPERM)$/u, `${label}: ${error}`);
        return;
      }
      await rename(destination, source);
      assert.fail(`${label} war trotz gehaltenem Pfad als Replace/Restore-ABA moeglich.`);
    };
    try {
      const isolatedVerifierPath = (await waitForReady()).trim();
      const isolatedTrustedRootPath = join(dirname(isolatedVerifierPath), "trusted-root.jsonl");
      await assertRenameDenied(isolatedVerifierPath, `${isolatedVerifierPath}.foreign`, "Private Verifierkopie");
      await assertRenameDenied(isolatedTrustedRootPath, `${isolatedTrustedRootPath}.foreign`, "Private Trust-Root-Kopie");
      await assertRenameDenied(subjectPath, `${subjectPath}.foreign`, "Attestierungs-Subject");
      await assertRenameDenied(bundlePath, `${bundlePath}.foreign`, "Attestierungsbundle");
      await assertRenameDenied(root, `${root}.foreign`, "Attestierungs-Pfadwurzel");
      await assert.rejects(writeFile(subjectPath, "foreign subject bytes"),
        (error) => /^(?:EACCES|EBUSY|EPERM)$/u.test(error?.code ?? ""));
      await assert.rejects(writeFile(bundlePath, "foreign bundle bytes"),
        (error) => /^(?:EACCES|EBUSY|EPERM)$/u.test(error?.code ?? ""));
    } finally {
      await writeFile(resumePath, "continue", { flag: "wx" }).catch(() => {});
    }
    assert.deepEqual(await verification, []);
  });

test("erstklassige Operational-v2-Sidecars sind bytegenau, schemageprüft und kausal gekoppelt", async () => {
  const positive = await fixtureV2();
  try {
    const sidecars = await firstClassOperationalSidecarFixture(positive);
    assert.deepEqual(
      await validateFirstClassOperationalSidecarEvidence({
        artifactRoot: positive.root,
        releaseId: positive.releaseId,
        ...sidecars,
      }),
      { inputs: sidecars.inputs.length, outputs: 3 },
    );

    const missing = structuredClone(sidecars);
    missing.outputs = missing.outputs.filter(({ kind }) => kind !== "timetable-transfer-demands-v2");
    await assert.rejects(
      validateFirstClassOperationalSidecarEvidence({ artifactRoot: positive.root, releaseId: positive.releaseId, ...missing }),
      /braucht Operational-v2, Movement-Route-Templates-v2 und Timetable-Transfer-Demands-v2/u,
    );

    const detached = structuredClone(sidecars);
    detached.outputs.find(({ kind }) => kind === "movement-route-templates-v2").timetableTransferSetSha256 = "f".repeat(64);
    await assert.rejects(
      validateFirstClassOperationalSidecarEvidence({ artifactRoot: positive.root, releaseId: positive.releaseId, ...detached }),
      /Release-, Zustands- oder Transferbindung/u,
    );
  } finally {
    await rm(positive.root, { recursive: true, force: true });
  }

  for (const mutation of [
    {
      file: "movementFile",
      mutate(value) { value.unvalidatedAlias = true; },
      error: /Movement-Route-Templates-v2 besitzt fehlende oder unbekannte Felder/u,
    },
    {
      file: "transferFile",
      mutate(value) { value.dailyPlan.planSha256 = "f".repeat(64); },
      error: /dailyPlan\.planSha256 ist nicht reproduzierbar/u,
    },
    {
      file: "transferFile",
      mutate(value) { value.schema = "zugfolge-timetable-transfer-demands/v1"; },
      error: /Timetable-Transfer-Demands verletzt Schema/u,
    },
  ]) {
    const value = await fixtureV2();
    try {
      const sidecars = await firstClassOperationalSidecarFixture(value);
      const file = value[mutation.file];
      const path = join(value.root, ...file.split("/"));
      const content = JSON.parse(await readFile(path, "utf8"));
      mutation.mutate(content);
      await writeFile(path, `${JSON.stringify(content)}\n`);
      Object.assign(sidecars.outputs.find(({ file: outputFile }) => outputFile === file), await proof(value.root, file));
      await assert.rejects(
        validateFirstClassOperationalSidecarEvidence({ artifactRoot: value.root, releaseId: value.releaseId, ...sidecars }),
        mutation.error,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }

  const drifted = await fixtureV2();
  try {
    const sidecars = await firstClassOperationalSidecarFixture(drifted);
    await writeFile(join(drifted.root, ...drifted.transferFile.split("/")), '{"changed":true}\n');
    await assert.rejects(
      validateFirstClassOperationalSidecarEvidence({ artifactRoot: drifted.root, releaseId: drifted.releaseId, ...sidecars }),
      /änderte sich zwischen Bytebeleg und semantischer Sidecar-Prüfung/u,
    );
  } finally {
    await rm(drifted.root, { recursive: true, force: true });
  }
});

test("Operational-v2-Evidence etikettiert wiederverwendete Spezifikationen ehrlich und bytegenau", async () => {
  const foreignReleaseValue = await fixtureV2();
  try {
    const descriptor = foreignReleaseValue.spec.inputs.find(({ id }) => id === "germany-release-spec");
    await write(foreignReleaseValue.root, descriptor.file, `${JSON.stringify({
      schema: "germany-release/v1",
      releaseId: PREVIOUS_RELEASE_ID,
    })}\n`);
    await assert.rejects(materialized(foreignReleaseValue), /fremde Release- oder Pfadbindung/u);
  } finally {
    await rm(foreignReleaseValue.root, { recursive: true, force: true });
  }

  const foreignPathValue = await fixtureV2();
  try {
    const descriptor = foreignPathValue.spec.inputs.find(({ id }) => id === "germany-release-spec");
    await write(foreignPathValue.root, descriptor.file, `${JSON.stringify({
      schema: "germany-release/v1",
      outputDirectory: "var/derived/germany-2026.1/output",
    })}\n`);
    await assert.rejects(materialized(foreignPathValue), /fremde Release- oder Pfadbindung/u);
  } finally {
    await rm(foreignPathValue.root, { recursive: true, force: true });
  }

  const unattestedValue = await fixtureV2();
  try {
    const descriptor = unattestedValue.spec.inputs.find(({ id }) => id === "germany-release-spec");
    descriptor.version = unattestedValue.previousReleaseId;
    await rewriteEvidenceSpec(unattestedValue);
    await assert.rejects(materialized(unattestedValue), /Cross-Release-Wiederverwendungsattestation/u);
  } finally {
    await rm(unattestedValue.root, { recursive: true, force: true });
  }

  const reusedValue = await fixtureV2();
  try {
    const descriptor = await configureReusableOfficialSpecification(reusedValue);
    await rewriteEvidenceSpec(reusedValue);
    const evidence = await materialized(reusedValue);
    const input = evidence.inputs.find(({ id }) => id === "germany-release-spec");
    assert.equal(input.version, reusedValue.previousReleaseId);
    assert.deepEqual(input.reuse, descriptor.reuse);
    assert.deepEqual(
      { bytes: input.bytes, sha256: input.sha256 },
      { bytes: descriptor.expectedBytes, sha256: descriptor.expectedSha256 },
    );
    assert.doesNotThrow(() => validateMapReleaseBuildEvidence(evidence));
    assert.equal((await verifyMapReleaseBuildEvidence(evidence, reusedValue.root)).inputs, evidence.inputs.length);
  } finally {
    await rm(reusedValue.root, { recursive: true, force: true });
  }

  const missingMappingValue = await fixtureV2();
  try {
    const descriptor = await configureReusableOfficialSpecification(missingMappingValue);
    descriptor.reuse.artifacts.pop();
    await rewriteEvidenceSpec(missingMappingValue);
    await assert.rejects(materialized(missingMappingValue), /inventarisiert nicht exakt alle/u);
  } finally {
    await rm(missingMappingValue.root, { recursive: true, force: true });
  }

  const tamperedSourceValue = await fixtureV2();
  try {
    const descriptor = await configureReusableOfficialSpecification(tamperedSourceValue);
    await rewriteEvidenceSpec(tamperedSourceValue);
    await write(tamperedSourceValue.root, descriptor.reuse.artifacts[0].sourceFile, "tampered source bytes\n");
    await assert.rejects(materialized(tamperedSourceValue), /gepinnten Byte-SHA-Beleg/u);
  } finally {
    await rm(tamperedSourceValue.root, { recursive: true, force: true });
  }

  const tamperedTargetValue = await fixtureV2();
  try {
    const descriptor = await configureReusableOfficialSpecification(tamperedTargetValue);
    await rewriteEvidenceSpec(tamperedTargetValue);
    await write(tamperedTargetValue.root, descriptor.reuse.artifacts[0].targetFile, "tampered target bytes\n");
    await assert.rejects(materialized(tamperedTargetValue), /gepinnten Byte-SHA-Beleg/u);
  } finally {
    await rm(tamperedTargetValue.root, { recursive: true, force: true });
  }

  const hardlinkContractValue = await fixtureV2();
  try {
    const descriptor = await configureReusableOfficialSpecification(hardlinkContractValue);
    descriptor.reuse.artifacts[0].hardlinkRequired = true;
    await rewriteEvidenceSpec(hardlinkContractValue);
    await assert.rejects(materialized(hardlinkContractValue), /fremde oder fehlende Felder/u);
  } finally {
    await rm(hardlinkContractValue.root, { recursive: true, force: true });
  }
});

test("Operational-v2-Evidence bindet Signed-Paketplan und additiven Delivery-Keyring fail-closed", async () => {
  const planValue = await fixtureV2();
  try {
    const planPath = join(planValue.root, ...planValue.signedPlanFile.split("/"));
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.version = "2026.4";
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    await assert.rejects(materialized(planValue), /Paketidentität oder Version|Jahres-Patchversion/u);
  } finally {
    await rm(planValue.root, { recursive: true, force: true });
  }

  const unpinnedValue = await fixtureV2();
  try {
    const planPath = join(unpinnedValue.root, ...unpinnedValue.signedPlanFile.split("/"));
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const style = plan.auxiliaryFiles.find(({ kind }) => kind === "style");
    delete style.expectedBytes;
    delete style.expectedSha256;
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    await assert.rejects(materialized(unpinnedValue), /jede expandierte Paketdatei bytegenau pinnen/u);
  } finally {
    await rm(unpinnedValue.root, { recursive: true, force: true });
  }

  const keyringValue = await fixtureV2();
  try {
    const keyringPath = join(keyringValue.root, ...keyringValue.trustedKeysFile.split("/"));
    await writeFile(keyringPath, `${JSON.stringify({
      [keyringValue.deliveryKeyId]: keyringValue.trustedDeliveryKeys[keyringValue.deliveryKeyId],
    }, null, 2)}\n`);
    await assert.rejects(materialized(keyringValue), /bisherigen Vertrauensanker.*entfernt/u);
  } finally {
    await rm(keyringValue.root, { recursive: true, force: true });
  }

  const deliveryValue = await fixtureV2();
  try {
    const planPath = join(deliveryValue.root, ...deliveryValue.signedPlanFile.split("/"));
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.auxiliaryFiles.find(({ kind }) => kind === "release-manifest").sourceFile = "outputs/delivery-unsigned/release.json";
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    await assert.rejects(materialized(deliveryValue), /public\/release\.json/u);
  } finally {
    await rm(deliveryValue.root, { recursive: true, force: true });
  }

  const privatePemValue = await fixtureV2();
  try {
    const keyringPath = join(privatePemValue.root, ...privatePemValue.trustedKeysFile.split("/"));
    const keyring = { ...privatePemValue.trustedDeliveryKeys };
    keyring[privatePemValue.deliveryKeyId] = privatePemValue.privateKey.export({ type: "pkcs8", format: "pem" });
    await writeFile(keyringPath, `${JSON.stringify(keyring, null, 2)}\n`);
    await assert.rejects(materialized(privatePemValue), /kein privates Schlüsselmaterial/u);
  } finally {
    await rm(privatePemValue.root, { recursive: true, force: true });
  }

  const rsaValue = await fixtureV2();
  try {
    const keyringPath = join(rsaValue.root, ...rsaValue.trustedKeysFile.split("/"));
    const keyring = { ...rsaValue.trustedDeliveryKeys };
    keyring[rsaValue.deliveryKeyId] = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
    await writeFile(keyringPath, `${JSON.stringify(keyring, null, 2)}\n`);
    await assert.rejects(materialized(rsaValue), /kein Ed25519-SPKI-Public-Key-PEM/u);
  } finally {
    await rm(rsaValue.root, { recursive: true, force: true });
  }

  const restBytesValue = await fixtureV2();
  try {
    const keyringPath = join(restBytesValue.root, ...restBytesValue.trustedKeysFile.split("/"));
    const keyring = { ...restBytesValue.trustedDeliveryKeys };
    keyring[restBytesValue.deliveryKeyId] = `${keyring[restBytesValue.deliveryKeyId]}ignored-rest-bytes`;
    await writeFile(keyringPath, `${JSON.stringify(keyring, null, 2)}\n`);
    await assert.rejects(materialized(restBytesValue), /ohne Restbytes serialisiert/u);
  } finally {
    await rm(restBytesValue.root, { recursive: true, force: true });
  }
});

test("Operational-v2-Evidence blockiert fehlende oder vorab erfundene Commitbindungen und Legacy-Ausgaben", async () => {
  const value = await fixtureV2();
  try {
    await assert.rejects(
      materializeMapReleaseBuildEvidence({
        spec: value.spec,
        specBytes: value.specBytes,
        specFile: value.specFile,
        artifactRoot: value.root,
      }),
      /commits\.semanticExport/,
    );

    const embedded = structuredClone(value.spec);
    embedded.commits = value.commits;
    const embeddedBytes = Buffer.from(`${JSON.stringify(embedded, null, 2)}\n`);
    await write(value.root, value.specFile, embeddedBytes);
    await assert.rejects(
      materializeMapReleaseBuildEvidence({
        spec: embedded,
        specBytes: embeddedBytes,
        specFile: value.specFile,
        artifactRoot: value.root,
        commits: value.commits,
      }),
      /vorab erfundenen Commitbindungen/,
    );

    const legacyOutput = structuredClone(value.spec);
    legacyOutput.outputs = legacyOutput.outputs.map((output) => output.kind === "operational-infrastructure-v2"
      ? {
          id: "train-map-projection",
          kind: "train-map-projection",
          file: "outputs/train-map-projection.sqlite",
          installFile: "train-map-projection.sqlite",
        }
      : output);
    const legacyBytes = Buffer.from(`${JSON.stringify(legacyOutput, null, 2)}\n`);
    await write(value.root, value.specFile, legacyBytes);
    await assert.rejects(
      materializeMapReleaseBuildEvidence({
        spec: legacyOutput,
        specBytes: legacyBytes,
        specFile: value.specFile,
        artifactRoot: value.root,
        commits: value.commits,
      }),
      /fehlende oder doppelte Art/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Operational-v2-Evidence blockiert abweichende Zustandshashes und offene Operational-Klasse-C-Qualität", async () => {
  const inventoryValue = await fixtureV2();
  try {
    const inventoryPath = join(inventoryValue.root, ...inventoryValue.artifactInventoryFile.split("/"));
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    inventory.artifacts[0].stateHash = "f".repeat(64);
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
    const updatedInventoryProof = await proof(inventoryValue.root, inventoryValue.artifactInventoryFile);
    const cachePath = join(inventoryValue.root, ...inventoryValue.cacheInventoryPath.split("/"));
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    Object.assign(
      cache.files.find(({ path }) => path === inventoryValue.artifactInventoryCacheFile),
      updatedInventoryProof,
    );
    await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    const signedPlanPath = join(inventoryValue.root, ...inventoryValue.signedPlanFile.split("/"));
    const signedPlan = JSON.parse(await readFile(signedPlanPath, "utf8"));
    signedPlan.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2").stateHash = "f".repeat(64);
    await writeFile(signedPlanPath, `${JSON.stringify(signedPlan, null, 2)}\n`);
    await assert.rejects(materialized(inventoryValue), /Byte-\/Zustandsbindung/);
  } finally {
    await rm(inventoryValue.root, { recursive: true, force: true });
  }

  const qualityValue = await fixtureV2();
  try {
    const qualityPath = join(qualityValue.root, "outputs", "quality.json");
    const quality = JSON.parse(await readFile(qualityPath, "utf8"));
    quality.summary.operationalQualityClassArtifactCount = { A: 0, B: 0, C: 1 };
    await writeFile(qualityPath, `${JSON.stringify(quality, null, 2)}\n`);
    await refreshSignedPlanPins(qualityValue, ["quality-manifest"]);
    await assert.rejects(materialized(qualityValue), /geschlossene B=1\/C=0-Bilanz/);
  } finally {
    await rm(qualityValue.root, { recursive: true, force: true });
  }
});

test("Operational-v2-Evidence verweigert manipulierte Wrapper, Quellen und Delivery-releaseHash-Bindungen", async () => {
  const wrapperValue = await fixtureV2();
  try {
    const wrapperPath = join(wrapperValue.root, ...wrapperValue.infraReleaseWrapperFile.split("/"));
    const wrapper = JSON.parse(await readFile(wrapperPath, "utf8"));
    wrapper.release.releaseId = "infra-deutschland-2026.9";
    await writeFile(wrapperPath, `${JSON.stringify(wrapper, null, 2)}\n`);
    const wrapperProof = await proof(wrapperValue.root, wrapperValue.infraReleaseWrapperFile);
    const cachePath = join(wrapperValue.root, ...wrapperValue.cacheInventoryPath.split("/"));
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    Object.assign(cache.files.find(({ path }) => path === wrapperValue.infraReleaseWrapperCacheFile), wrapperProof);
    await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    await assert.rejects(materialized(wrapperValue), /kanonischen Releaseinhalt nicht/);
  } finally {
    await rm(wrapperValue.root, { recursive: true, force: true });
  }

  const bindingValue = await fixtureV2();
  try {
    const deliveryPath = join(bindingValue.root, ...bindingValue.deliveryOutputFile.split("/"));
    const delivery = JSON.parse(await readFile(deliveryPath, "utf8"));
    delivery.bindings.mapReleaseHash = "f".repeat(64);
    await writeFile(deliveryPath, serializeDeliveryJson(resignDelivery(bindingValue, delivery)));
    await refreshSignedPlanPins(bindingValue, ["release-manifest"]);
    await assert.rejects(materialized(bindingValue), /belegten kanonischen InfraRelease-\/Kartenrelease-Hüllen/);
  } finally {
    await rm(bindingValue.root, { recursive: true, force: true });
  }

  const sourcesValue = await fixtureV2();
  try {
    const sourcesPath = join(sourcesValue.root, ...sourcesValue.deliverySourcesFile.split("/"));
    const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
    sources.releaseId = "infra-deutschland-2026.9";
    await writeFile(sourcesPath, serializeDeliveryJson(sources));
    const sourcesProof = await proof(sourcesValue.root, sourcesValue.deliverySourcesFile);
    const cachePath = join(sourcesValue.root, ...sourcesValue.cacheInventoryPath.split("/"));
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    Object.assign(cache.files.find(({ path }) => path === sourcesValue.deliverySourcesCacheFile), sourcesProof);
    await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    await refreshSignedPlanPins(sourcesValue, ["source-manifest"]);
    await assert.rejects(materialized(sourcesValue), /kanonischen Delivery-Quellenvertrag/);
  } finally {
    await rm(sourcesValue.root, { recursive: true, force: true });
  }

  const assetPlanValue = await fixtureV2();
  try {
    const sourcesPath = join(assetPlanValue.root, ...assetPlanValue.deliverySourcesFile.split("/"));
    const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
    sources.assetInventoryPlanSha256 = "f".repeat(64);
    await writeFile(sourcesPath, serializeDeliveryJson(sources));
    const sourcesProof = await proof(assetPlanValue.root, assetPlanValue.deliverySourcesFile);
    const cachePath = join(assetPlanValue.root, ...assetPlanValue.cacheInventoryPath.split("/"));
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    Object.assign(cache.files.find(({ path }) => path === assetPlanValue.deliverySourcesCacheFile), sourcesProof);
    await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

    const deliveryPath = join(assetPlanValue.root, ...assetPlanValue.deliveryOutputFile.split("/"));
    const delivery = JSON.parse(await readFile(deliveryPath, "utf8"));
    delivery.bindings.sourcesSha256 = sourcesProof.sha256;
    await writeFile(deliveryPath, serializeDeliveryJson(resignDelivery(assetPlanValue, delivery)));
    await refreshSignedPlanPins(assetPlanValue, ["source-manifest", "release-manifest"]);
    await assert.rejects(materialized(assetPlanValue), /kanonischen Delivery-Quellenvertrag/);
  } finally {
    await rm(assetPlanValue.root, { recursive: true, force: true });
  }
});

test("Operational-v2-Evidence materialisiert und verifiziert mehr als 64 MiB nur mit vollständigem nativen Receipt", { timeout: 120_000 }, async () => {
  const value = await fixtureV2();
  try {
    const path = join(value.root, ...value.operationalFile.split("/"));
    await writeLargeCanonicalOperationalInfrastructure(path, value.releaseId);
    const operationalProof = await streamedProof(path);
    assert.ok(operationalProof.bytes > 64 * 1024 * 1024);
    const stateHash = operationalProof.sha256 === "e".repeat(64) ? "d".repeat(64) : "e".repeat(64);
    await replaceOperationalBindings(value, operationalProof, stateHash);
    let validations = 0;
    const validateOperationalInfrastructure = async (candidatePath, expectedReleaseId) => {
      validations += 1;
      const source = await streamedProof(candidatePath);
      return {
        schema: "operational-infrastructure-v2",
        infraReleaseId: expectedReleaseId,
        sourceBytes: source.bytes,
        sourceSha256: source.sha256,
        bytes: source.bytes,
        sha256: source.sha256,
        stateHash,
        validationMode: "native-streaming-redb-v1",
      };
    };
    const evidence = await materializeMapReleaseBuildEvidence({
      spec: value.spec,
      specBytes: value.specBytes,
      specFile: value.specFile,
      artifactRoot: value.root,
      commits: value.commits,
      validateOperationalInfrastructure,
    });
    const operational = evidence.outputs.find(({ kind }) => kind === "operational-infrastructure-v2");
    assert.equal(operational.bytes, operationalProof.bytes);
    assert.equal(operational.stateHash, stateHash);
    await verifyMapReleaseBuildEvidence(evidence, value.root, { validateOperationalInfrastructure });
    assert.equal(validations, 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Operational-v2-Evidence verwirft manipulierte Receipts für Release-ID, Zustand, Quelle und Ausgabe", async () => {
  const value = await fixtureV2();
  try {
    const path = join(value.root, ...value.operationalFile.split("/"));
    const cases = [
      [(receipt) => ({ ...receipt, infraReleaseId: "infra-deutschland-foreign" }), /Schema-, Release- und Modusbindung/u],
      [(receipt) => ({ ...receipt, stateHash: "0".repeat(64) }), /Kanonisierung laufen auseinander/u],
      [(receipt) => ({ ...receipt, sourceSha256: "0".repeat(64) }), /Quellbytes gebunden/u],
      [(receipt) => ({ ...receipt, sha256: "0".repeat(64) }), /kanonischen Operational-v2-Ausgabe-Bytes/u],
    ];
    for (const [mutate, expectedError] of cases) {
      await assert.rejects(
        materializeMapReleaseBuildEvidence({
          spec: value.spec,
          specBytes: value.specBytes,
          specFile: value.specFile,
          artifactRoot: value.root,
          commits: value.commits,
          validateOperationalInfrastructure: (candidatePath, expectedReleaseId) =>
            operationalReceipt(candidatePath, expectedReleaseId, mutate),
        }),
        expectedError,
      );
    }

    await assert.rejects(
      materializeMapReleaseBuildEvidence({
        spec: value.spec,
        specBytes: value.specBytes,
        specFile: value.specFile,
        artifactRoot: value.root,
        commits: value.commits,
        validateOperationalInfrastructure: async (candidatePath, expectedReleaseId) => {
          const receipt = await operationalReceipt(candidatePath, expectedReleaseId);
          await writeFile(path, "manipuliert", { flag: "a" });
          return receipt;
        },
      }),
      /änderte sich während der nativen Operational-v2-Validierung/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bricht bei latest, unversioniertem Release, fehlendem Digest und Eingabeabweichung fail-closed ab", async () => {
  const value = await fixture();
  try {
    async function materializeMutatedSpec(spec) {
      const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
      await writeFile(join(value.root, ...value.specFile.split("/")), specBytes);
      return materializeMapReleaseBuildEvidence({ spec, specBytes, specFile: value.specFile, artifactRoot: value.root });
    }

    const latest = structuredClone(value.spec);
    latest.tools[1].reference = "ghcr.io/zugfolge/gdal-pmtiles:latest";
    latest.tools[1].digest = `sha256:${"a".repeat(64)}`;
    await assert.rejects(
      materializeMutatedSpec(latest),
      /latest|OCI-Digest/,
    );

    const unversioned = structuredClone(value.spec);
    unversioned.releaseId = "infra-deutschland-unversioned";
    await assert.rejects(
      materializeMutatedSpec(unversioned),
      /Jahres-Patchrelease/,
    );

    const mismatch = structuredClone(value.spec);
    mismatch.inputs[0].expectedSha256 = "f".repeat(64);
    const mismatchBytes = Buffer.from(`${JSON.stringify(mismatch, null, 2)}\n`);
    await writeFile(join(value.root, ...value.specFile.split("/")), mismatchBytes);
    await assert.rejects(
      materializeMapReleaseBuildEvidence({ spec: mismatch, specBytes: mismatchBytes, specFile: value.specFile, artifactRoot: value.root }),
      /gepinnten Byte-SHA-Beleg/,
    );

    for (const field of ["expectedBytes", "expectedSha256"]) {
      const missing = structuredClone(value.spec);
      delete missing.inputs[3][field];
      const missingBytes = Buffer.from(`${JSON.stringify(missing, null, 2)}\n`);
      await writeFile(join(value.root, ...value.specFile.split("/")), missingBytes);
      await assert.rejects(
        materializeMapReleaseBuildEvidence({ spec: missing, specBytes: missingBytes, specFile: value.specFile, artifactRoot: value.root }),
        /verpflichtende erwartete Bytezahl|verpflichtenden erwarteten SHA-256/,
      );
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert fremde oder unvollständige SQLite-Artefakte vor der Evidence-Materialisierung", async () => {
  const cases = [
    {
      label: "ReadModel application_id",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "read-model.sqlite"));
        database.exec("PRAGMA application_id = 0");
        database.close();
      },
      error: /application_id/,
    },
    {
      label: "ReadModel user_version",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "read-model.sqlite"));
        database.exec("PRAGMA user_version = 2");
        database.close();
      },
      error: /Schema-Version|user_version/,
    },
    {
      label: "ReadModel metadata",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "read-model.sqlite"));
        database.prepare("DELETE FROM metadata WHERE key = ?").run("repeat_every_s");
        database.close();
      },
      error: /Schedule-Zeitvertrag/,
    },
    {
      label: "ReadModel tables",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "read-model.sqlite"));
        database.exec("DROP TABLE passenger_information");
        database.close();
      },
      error: /Tabellen.*Allowlist/,
    },
    {
      label: "Train projection release",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "train-map-projection.sqlite"));
        database.prepare("UPDATE metadata SET value = ? WHERE key = ?").run("infra-deutschland-2026.9", "infrastructure_release_id");
        database.close();
      },
      error: /nicht an den Buildrelease gebunden/,
    },
    {
      label: "Train projection schema",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "train-map-projection.sqlite"));
        database.prepare("UPDATE metadata SET value = ? WHERE key = ?").run("zugfolge-train-map-projection/v1", "schema");
        database.close();
      },
      error: /unbekanntes Schema/,
    },
    {
      label: "Train projection row binding",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "train-map-projection.sqlite"));
        database.prepare(`
          INSERT INTO display_path_geometries
            (world_id, infrastructure_release_id, display_path_id, length_mm, geometry_json)
          VALUES (?, ?, ?, ?, ?)
        `).run("00000000-0000-4000-8000-000000000099", RELEASE_ID, "display-path:foreign", 1, "[]");
        database.close();
      },
      error: /Zeilen außerhalb seiner Welt- oder Releasebindung/,
    },
  ];

  for (const entry of cases) {
    const value = await fixture();
    try {
      entry.mutate(value.root);
      await assert.rejects(materialized(value), entry.error, entry.label);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("verweigert einen Delivery-Vertrag ohne signierte Freigabe bereits beim Evidence-Build", async () => {
  const value = await fixture();
  try {
    const { releaseHash: ignoredHash, signature: ignoredSignature, ...unsigned } = value.signedDelivery;
    void ignoredHash;
    void ignoredSignature;
    unsigned.approvalGates.signature = { status: "missing" };
    unsigned.signature = null;
    await writeFile(join(value.root, "outputs", "release.json"), serializeDeliveryJson(unsigned));
    await assert.rejects(materialized(value), /keine signierte Delivery-Freigabe/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("erkennt den bekannten BOStrab-Knoten in jedem Semantiklayer und im ReadModel", async () => {
  const layerValue = await fixture();
  try {
    await write(layerValue.root, "derived/semantic/blocks.geojsonseq", `${JSON.stringify({
      type: "Feature",
      properties: { feature_id: "block:1", boundary: "signal:osm-node-12472736971" },
      geometry: null,
    })}\n`);
    await assert.rejects(materialized(layerValue), /12472736971.*blocks/);
  } finally {
    await rm(layerValue.root, { recursive: true, force: true });
  }

  const readModelValue = await fixture();
  try {
    const database = new DatabaseSync(join(readModelValue.root, "outputs", "read-model.sqlite"));
    database.prepare("INSERT INTO object_details VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("world", RELEASE_ID, "signal", "signal:osm-node-12472736971", "BOStrab", "B", "[]");
    database.close();
    const releasePath = join(readModelValue.root, "outputs", "release.json");
    const release = JSON.parse(await readFile(releasePath, "utf8"));
    Object.assign(
      release.artifacts.find(({ kind }) => kind === "read-model"),
      await proof(readModelValue.root, "outputs/read-model.sqlite"),
    );
    await writeFile(releasePath, serializeDeliveryJson(resignDelivery(readModelValue, release)));
    await assert.rejects(materialized(readModelValue), /12472736971.*ReadModel/);
  } finally {
    await rm(readModelValue.root, { recursive: true, force: true });
  }
});

test("verweigert Evidence ohne bytegenau inventarisierte Basemap", async () => {
  const value = await fixture();
  try {
    const releasePath = join(value.root, "outputs", "release.json");
    const release = JSON.parse(await readFile(releasePath, "utf8"));
    release.artifacts = release.artifacts.filter(({ kind }) => kind !== "basemap");
    await writeFile(releasePath, serializeDeliveryJson(resignDelivery(value, release)));
    await assert.rejects(materialized(value), /genau eine Basemap|basemap.*fehlt/i);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Datenbank-Rollbackbeleg bindet DB-Identitaet, Schema, autoritativen Kopf, Backup, Restore und Quiescence fail-closed", () => {
  const proof = databaseRollbackProof();
  assert.equal(validateDatabaseRollbackProof(proof), proof);
  assert.match(proof.migrationLedgerPairSha256, /^[a-f0-9]{64}$/u);
  assert.match(proof.proofHash, /^[a-f0-9]{64}$/u);
  assert.equal(proof.schema, "zugfolge-database-rollback-proof/v3");
  assert.equal(proof.source.databaseIdentity, DATABASE_ID);
  assert.equal(proof.source.authoritativeHead.schema, "zugfolge-database-authoritative-head/v1");
  assert.equal(proof.source.keycloakIdentityHead.schema, "keycloak-identity-head/v1");

  assert.throws(
    () => databaseRollbackProof({ writersQuiesced: false }),
    /nicht bei angehaltenen Schreibern/u,
  );
  assert.throws(
    () => databaseRollbackProof({ rollbackWindow: "active-candidate" }),
    /Pre-Activation-Fenster/u,
  );

  const restoredWithForeignLedger = databaseRollbackSnapshot();
  restoredWithForeignLedger.migrationLedger[1].hash = "e".repeat(64);
  assert.throws(
    () => databaseRollbackProof({ restored: restoredWithForeignLedger }),
    /Restore weicht vom quieszierten Quellzustand/u,
  );

  const restoredWithForeignIdentity = databaseRollbackSnapshot();
  restoredWithForeignIdentity.keycloakIdentityHead = keycloakIdentityHeadFixture({ userCount: "2", totalRowCount: "9" });
  assert.throws(
    () => databaseRollbackProof({ restored: restoredWithForeignIdentity }),
    /Restore weicht vom quieszierten Quellzustand/u,
  );

  const extendedIdentityHead = databaseRollbackSnapshot();
  extendedIdentityHead.keycloakIdentityHead = { ...extendedIdentityHead.keycloakIdentityHead, extra: true };
  assert.throws(
    () => databaseRollbackProof({ source: extendedIdentityHead, restored: structuredClone(extendedIdentityHead) }),
    /fremde oder fehlende Felder/u,
  );

  const unvalidatedSource = databaseRollbackSnapshot();
  unvalidatedSource.constraints[0].validated = false;
  assert.throws(
    () => databaseRollbackProof({ source: unvalidatedSource, restored: structuredClone(unvalidatedSource) }),
    /ist nicht validiert/u,
  );

  const foreignDatabase = databaseRollbackSnapshot();
  foreignDatabase.databaseIdentity = "00000000-0000-4000-8000-000000000032";
  assert.throws(
    () => databaseRollbackProof({ restored: foreignDatabase }),
    /Restore weicht|selben persistenten Datenbankinstanz/u,
  );

  const incompleteSchema = databaseRollbackSnapshot();
  incompleteSchema.guards = incompleteSchema.guards.slice(1);
  assert.throws(
    () => databaseRollbackProof({ source: incompleteSchema, restored: structuredClone(incompleteSchema) }),
    /exakten Unveraenderlichkeitsvertrag/u,
  );

  const incompatibleSource = databaseRollbackSnapshot();
  incompatibleSource.heads = { total: 4, v2: 1, nonNullInitializationHash: 1, incompatible: 1 };
  assert.throws(
    () => databaseRollbackProof({ source: incompatibleSource, restored: structuredClone(incompatibleSource) }),
    /nicht mehr im ausschliesslichen Pre-Activation-Rollbackfenster/u,
  );

  const weakenedConstraintSource = databaseRollbackSnapshot();
  weakenedConstraintSource.constraints[0].definitionSha256 = "f".repeat(64);
  assert.throws(
    () => databaseRollbackProof({
      source: weakenedConstraintSource,
      restored: structuredClone(weakenedConstraintSource),
    }),
    /Constraint-Sollvertrag/u,
  );

  const separated = databaseRollbackEvidenceFixtures(databaseRollbackSnapshot()).restoreSeparation;
  assert.throws(
    () => databaseRollbackProof({
      restoreSeparation: { ...separated, restoredEndpointSha256: separated.sourceEndpointSha256 },
    }),
    /denselben Quell- und Restore-Endpunkt/u,
  );
  assert.throws(
    () => databaseRollbackProof({
      restoreSeparation: { ...separated, restoredBackendSha256: separated.sourceBackendSha256 },
    }),
    /dieselbe PostgreSQL-Backendinstanz/u,
  );

  const tampered = structuredClone(proof);
  tampered.backupManifestSha256 = "f".repeat(64);
  assert.throws(() => validateDatabaseRollbackProof(tampered), /semantische Backup-Manifest nicht kanonisch/u);
});

test("verweigert ein als .1 etikettiertes v2/v1-Mismatch vor der Runtime-Attestation", async () => {
  const value = await fixture();
  const deploymentRoot = join(value.root, "deployment");
  try {
    await installPackageFixture(value, deploymentRoot, PREVIOUS_RELEASE_ID);
    await assert.rejects(
      createMapRollbackAttestation({
        deploymentRoot,
        previousInstallPath: value.spec.deployment.previousInstallPath,
        previousReleaseId: PREVIOUS_RELEASE_ID,
        runtimeIdentity: {
          sourceCommit: "3".repeat(40),
          imageDigest: `sha256:${"4".repeat(64)}`,
          odooImageDigest: `sha256:${"5".repeat(64)}`,
          worldDeploymentPath: join(value.root, "runtime", "alpha-world-deployment.json"),
        },
      }),
      /Rollback-ReadModel ist nicht an das vorherige Kartenrelease/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("aktueller .5-Zielbaum bleibt ohne create-new-Completion auch fuer Rollback-Attestation unlesbar", async () => {
  const deploymentRoot = await mkdtemp(join(tmpdir(), "zugfolge-map-release-current-partial-"));
  try {
    const releaseId = "infra-deutschland-2026.5";
    await mkdir(join(deploymentRoot, "releases", releaseId), { recursive: true });
    await assert.rejects(
      createMapRollbackAttestation({
        deploymentRoot,
        previousInstallPath: `releases/${releaseId}`,
        previousReleaseId: releaseId,
      }),
      /keinen create-new-Completion-Marker/u,
    );
  } finally {
    await rm(deploymentRoot, { recursive: true, force: true });
  }
});

test("aktueller .5-Querbindungshelper verweigert ein vom Publication-Receipt entkoppeltes Operational-Ausgabepaar", () => {
  const releaseId = "infra-deutschland-2026.5";
  const operationalFile = "var/derived/germany-2026.5/operational-infrastructure-v2.json";
  const movementFile = "var/derived/germany-2026.5/operational-infrastructure-v2.movement-route-templates-v2.json";
  const candidateFile = "var/derived/germany-2026.5/operational-infrastructure-v2.candidate.json";
  const candidateMovementFile = "var/derived/germany-2026.5/operational-infrastructure-v2.candidate.movement-route-templates-v2.json";
  const reportFile = "var/derived/germany-2026.5/operational-infrastructure-v2.derivation-report.json";
  const operationalStateHash = "a".repeat(64);
  const movementStateHash = "b".repeat(64);
  const transferSetSha256 = "c".repeat(64);
  const outputs = [{
    id: "operational-infrastructure",
    kind: "operational-infrastructure-v2",
    file: operationalFile,
    infraReleaseId: releaseId,
    bytes: 101,
    sha256: "d".repeat(64),
    stateHash: operationalStateHash,
  }, {
    id: "operational-movement-routes",
    kind: "movement-route-templates-v2",
    file: movementFile,
    infraReleaseId: releaseId,
    bytes: 202,
    sha256: "e".repeat(64),
    stateHash: movementStateHash,
    operationalStateHash,
    timetableTransferSetSha256: transferSetSha256,
  }];
  const publicationReceipt = {
    infraReleaseId: releaseId,
    sources: {
      candidate: { file: candidateFile },
      movementRouteTemplates: { file: candidateMovementFile },
      report: { file: reportFile },
    },
    published: {
      operationalInfrastructure: {
        file: operationalFile,
        bytes: 101,
        sha256: "d".repeat(64),
        stateHash: operationalStateHash,
      },
      movementRouteTemplates: {
        file: movementFile,
        bytes: 202,
        sha256: "e".repeat(64),
        stateHash: movementStateHash,
        operationalStateHash,
        timetableTransferSetSha256: transferSetSha256,
      },
    },
  };
  const releaseConfig = {
    pipeline: {
      operationalDeriver: {
        candidate: candidateFile,
        candidateMovementRouteTemplates: candidateMovementFile,
        report: reportFile,
        output: operationalFile,
      },
    },
  };
  const binding = { releaseId, publicationReceipt, outputs, releaseConfig };
  assert.doesNotThrow(() => validateCurrentAnnualOperationalPublicationBinding(binding));

  for (const mutate of [
    (value) => { value.outputs[0].file = "var/derived/germany-2026.5/separates-operational-v2.json"; },
    (value) => { value.outputs[0].bytes += 1; },
    (value) => { value.outputs[0].sha256 = "f".repeat(64); },
    (value) => { value.outputs[0].stateHash = "f".repeat(64); },
    (value) => { value.outputs[1].file = "var/derived/germany-2026.5/separates-movement-v2.json"; },
    (value) => { value.outputs[1].bytes += 1; },
    (value) => { value.outputs[1].sha256 = "f".repeat(64); },
    (value) => { value.outputs[1].stateHash = "f".repeat(64); },
    (value) => { value.outputs[1].operationalStateHash = "f".repeat(64); },
    (value) => { value.outputs[1].timetableTransferSetSha256 = "f".repeat(64); },
    (value) => { value.releaseConfig.pipeline.operationalDeriver.candidateMovementRouteTemplates = "var/derived/germany-2026.5/fremdes-candidate-sidecar.json"; },
  ]) {
    const detached = structuredClone(binding);
    mutate(detached);
    assert.throws(
      () => validateCurrentAnnualOperationalPublicationBinding(detached),
      /Publication-Receipt|Jahresrelease/u,
    );
  }
});

test("aktueller .5-Buildcacheplan-Helper verweigert ein Inventar ohne Rebuild-TAR oder Provenienz", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-current-cache-plan-binding-"));
  try {
    const releaseId = "infra-deutschland-2026.5";
    const planFile = "tools/tiles/map-build-cache-inventory.annual-2026.5.plan.json";
    const files = [{
      sourceFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json",
      cacheFile: "derived/infra-deutschland-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json",
    }, {
      sourceFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-source-commit-sha.tar",
      cacheFile: "derived/infra-deutschland-2026.5/toolchain/zugfolge-infra-release-source-commit-sha.tar",
    }, {
      sourceFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-provenance-commit.json",
      cacheFile: "derived/infra-deutschland-2026.5/toolchain/zugfolge-infra-release-rebuild-provenance-commit.json",
    }, {
      sourceFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-commit-official.exe",
      cacheFile: "tools/zugfolge-infra-release/infra-deutschland-2026.5/commit/official/zugfolge-infra-release.exe",
    }];
    await write(root, planFile, `${JSON.stringify({
      schema: "zugfolge-map-build-cache-inventory-plan/v1",
      releaseId,
      files,
    }, null, 2)}\n`);
    const inputs = [{ id: "map-build-cache-inventory-plan", kind: "specification", file: planFile }];
    const inventory = files
      .map(({ cacheFile }) => ({ path: cacheFile, bytes: 1, sha256: "a".repeat(64) }))
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    await assert.doesNotReject(validateCurrentAnnualBuildCachePlanBinding(root, inputs, inventory, releaseId));
    for (const missingToken of ["-source-", "-provenance-"]) {
      await assert.rejects(
        validateCurrentAnnualBuildCachePlanBinding(
          root,
          inputs,
          inventory.filter(({ path }) => !path.includes(missingToken)),
          releaseId,
        ),
        /Inventarplan nicht vollstaendig und exakt/u,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aktueller .5-Rebuild-Cachehelper verweigert falsche TAR-/Provenienz-Bytes und -Hashes", () => {
  const archive = { file: "var/derived/germany-2026.5/toolchain/source.tar", bytes: 10, sha256: "a".repeat(64) };
  const provenance = { file: "var/derived/germany-2026.5/toolchain/provenance.json", bytes: 20, sha256: "b".repeat(64) };
  const receipt = { file: "var/derived/germany-2026.5/toolchain/receipt.json", bytes: 30, sha256: "c".repeat(64) };
  const binary = { file: "var/derived/germany-2026.5/toolchain/rebuilt.exe", bytes: 40, sha256: "d".repeat(64) };
  const bindings = [archive, provenance, receipt, binary].map((proof, index) => ({
    sourceFile: proof.file,
    cacheFile: `cache/rebuild/${index}`,
  }));
  const inventory = [archive, provenance, receipt, binary].map((proof, index) => ({
    path: `cache/rebuild/${index}`,
    bytes: proof.bytes,
    sha256: proof.sha256,
  }));
  const value = {
    mappings: bindings,
    inventory,
    rebuildSpec: { source: { archive } },
    rebuildReceipt: { provenance, binaries: { rebuilt: binary } },
    rebuildReceiptInput: receipt,
  };
  assert.doesNotThrow(() => validateCurrentAnnualValidatorRebuildCacheArtifacts(value));

  const wrongArchive = structuredClone(value);
  wrongArchive.inventory[0].bytes += 1;
  assert.throws(
    () => validateCurrentAnnualValidatorRebuildCacheArtifacts(wrongArchive),
    /Source-TAR driftet/u,
  );
  const wrongProvenance = structuredClone(value);
  wrongProvenance.inventory[1].sha256 = "f".repeat(64);
  assert.throws(
    () => validateCurrentAnnualValidatorRebuildCacheArtifacts(wrongProvenance),
    /Provenienz driftet/u,
  );
});

test("preflight qualifiziert den v2-Kartenkandidaten, blockiert aber volle Aktivierung mit v1-Rollbackrelease", async () => {
  const value = await fixtureV2();
  const deploymentRoot = join(value.root, "deployment");
  try {
    const evidence = await materialized(value);
    const restoreRoot = join(value.root, "restored-cache-v2");
    await prepareEmptyBuildCacheRestore(restoreRoot);
    for (const [sourceFile, cacheFile] of value.cached) {
      const target = join(restoreRoot, ...cacheFile.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(value.root, ...sourceFile.split("/")), target);
    }
    const restore = await proveBuildCacheRestore(evidence, restoreRoot);

    const candidate = await installPackageFixture(value, deploymentRoot, value.releaseId);
    const previous = await installPackageFixture(value, deploymentRoot, value.previousReleaseId);
    assert.equal(candidate.manifest.schema, "zugfolge-map-package/v2");
    assert.equal(candidate.manifest.runtime.schema, "zugfolge-map-runtime/v2");
    assert.equal(previous.manifest.schema, "zugfolge-map-package/v1");
    assert.equal(previous.manifest.runtime.schema, "zugfolge-map-runtime/v1");
    await writeActivationPointer(value, deploymentRoot);

    const unsignedRollback = await createMapRollbackAttestation({
      deploymentRoot,
      previousInstallPath: value.spec.deployment.previousInstallPath,
      previousReleaseId: value.previousReleaseId,
    });
    const signedRollback = signMapRollbackAttestation(
      unsignedRollback,
      value.rollbackPrivateKey.export({ type: "pkcs8", format: "pem" }),
      value.rollbackKeyId,
    );
    await write(
      deploymentRoot,
      value.spec.deployment.rollbackAttestationPath,
      serializeMapReleaseBuildEvidence(signedRollback),
    );

    const trustedAlphaWorldKeys = {
      [value.worldKeyId]: value.trustedDeliveryKeys[value.worldKeyId],
    };
    const trustedMapInfraKeys = {
      [value.deliveryKeyId]: value.trustedDeliveryKeys[value.deliveryKeyId],
      [value.rollbackKeyId]: value.trustedDeliveryKeys[value.rollbackKeyId],
    };
    await assert.rejects(
      preflightMapReleaseActivation({
        evidence,
        deploymentRoot,
        restoreProofBytes: restore.proofBytes,
        restoreRoot,
        trustedDeliveryKeys: value.trustedDeliveryKeys,
        trustedDeliveryKeysBytes: value.trustedDeliveryKeysBytes,
        expectedActiveReleaseId: value.previousReleaseId,
      }),
      /Operational-v2-Preflight benoetigt disjunkte Alpha-Welt- und Map-\/Infra-Key-Scopes/u,
    );

    const preflight = await preflightMapReleaseActivation({
      evidence,
      deploymentRoot,
      restoreProofBytes: restore.proofBytes,
      restoreRoot,
      trustedDeliveryKeys: value.trustedDeliveryKeys,
      trustedDeliveryKeysBytes: value.trustedDeliveryKeysBytes,
      trustedAlphaWorldKeys,
      trustedMapInfraKeys,
      expectedActiveReleaseId: value.previousReleaseId,
    });
    assert.equal(preflight.mapActivationEligible, true);
    assert.equal(preflight.activationEligible, false);
    assert.equal(preflight.activeReleaseId, value.previousReleaseId);
    assert.equal(preflight.verifiedDeliveryArtifacts, evidence.deliveryInventory.length);
    assert.equal(preflight.rollbackEligibilityReason, "runtime-tuple-unbound-v1");

    await assert.rejects(
      preflightMapReleaseActivation({
        evidence,
        deploymentRoot,
        restoreProofBytes: restore.proofBytes,
        restoreRoot,
        trustedDeliveryKeys: value.trustedDeliveryKeys,
        trustedDeliveryKeysBytes: value.trustedDeliveryKeysBytes,
        trustedAlphaWorldKeys: trustedMapInfraKeys,
        trustedMapInfraKeys: trustedAlphaWorldKeys,
        expectedActiveReleaseId: value.previousReleaseId,
      }),
      /Rollback-Attestation-Signaturschlüssel .* ist nicht vertrauenswürdig/u,
    );

    const preflightCli = fileURLToPath(new URL("./map-release-build-evidence-cli.mjs", import.meta.url));
    const cliEvidencePath = join(value.root, "operational-v2-preflight-evidence.json");
    const cliRestoreProofPath = join(value.root, "operational-v2-restore-proof.json");
    const cliScopePath = join(value.root, "operational-v2-trusted-key-scopes.json");
    const cliDatabaseProofPath = join(value.root, "operational-v2-unused-database-proof.json");
    const trustedKeysPath = join(value.root, ...value.trustedKeysFile.split("/"));
    await Promise.all([
      writeFile(cliEvidencePath, serializeMapReleaseBuildEvidence(evidence)),
      writeFile(cliRestoreProofPath, restore.proofBytes),
      writeFile(cliScopePath, `${JSON.stringify({
        alphaWorldDeployments: [value.worldKeyId],
        mapInfraDeliveries: [value.deliveryKeyId, value.rollbackKeyId].sort(),
      })}\n`),
      writeFile(cliDatabaseProofPath, "{}\n"),
    ]);
    const cliArguments = [
      preflightCli,
      "preflight",
      cliEvidencePath,
      deploymentRoot,
      cliRestoreProofPath,
      restoreRoot,
      trustedKeysPath,
      cliScopePath,
      value.previousReleaseId,
      "3".repeat(40),
      `sha256:${"4".repeat(64)}`,
      `sha256:${"5".repeat(64)}`,
      join(value.root, "unused-world-deployment.json"),
      cliDatabaseProofPath,
    ];
    const cliPreflight = spawnSync(process.execPath, cliArguments, { encoding: "utf8", windowsHide: true });
    assert.equal(cliPreflight.status, 0, cliPreflight.stderr);
    assert.equal(JSON.parse(cliPreflight.stdout).mapActivationEligible, true);
    const flatKeyringCliPreflight = spawnSync(
      process.execPath,
      cliArguments.filter((argument) => argument !== cliScopePath),
      { encoding: "utf8", windowsHide: true },
    );
    assert.notEqual(flatKeyringCliPreflight.status, 0);
    assert.match(flatKeyringCliPreflight.stderr, /TRUSTED_KEY_SCOPES\.json/u);

    const reducedKeyringBytes = Buffer.from(`${JSON.stringify({
      [value.deliveryKeyId]: value.trustedDeliveryKeys[value.deliveryKeyId],
    }, null, 2)}\n`, "utf8");
    await assert.rejects(
      preflightMapReleaseActivation({
        evidence,
        deploymentRoot,
        restoreProofBytes: restore.proofBytes,
        restoreRoot,
        trustedDeliveryKeysBytes: reducedKeyringBytes,
        expectedActiveReleaseId: value.previousReleaseId,
      }),
      /bytegenau gebundenen candidatePackage-Keyring/u,
    );

    await assert.rejects(
      preflightMapReleaseActivation({
        evidence,
        deploymentRoot,
        restoreProofBytes: restore.proofBytes,
        restoreRoot,
        trustedDeliveryKeys: {
          [value.deliveryKeyId]: value.trustedDeliveryKeys[value.deliveryKeyId],
        },
        trustedDeliveryKeysBytes: value.trustedDeliveryKeysBytes,
        expectedActiveReleaseId: value.previousReleaseId,
      }),
      /Keyring-Objekt weicht von seinen übergebenen Datei-Bytes/u,
    );

    const foreignIdEvidence = structuredClone(evidence);
    foreignIdEvidence.candidatePackage.trustedKeyIds.push("unexpected-runtime-key");
    foreignIdEvidence.candidatePackage.trustedKeyIds.sort();
    await assert.rejects(
      preflightMapReleaseActivation({
        evidence: foreignIdEvidence,
        deploymentRoot,
        restoreProofBytes: restore.proofBytes,
        restoreRoot,
        trustedDeliveryKeysBytes: value.trustedDeliveryKeysBytes,
        expectedActiveReleaseId: value.previousReleaseId,
      }),
      /nicht exakt die in candidatePackage gebundenen Vertrauensanker-IDs/u,
    );

    const changedKeyring = {
      ...value.trustedDeliveryKeys,
      [value.deliveryKeyId]: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }),
    };
    await assert.rejects(
      preflightMapReleaseActivation({
        evidence,
        deploymentRoot,
        restoreProofBytes: restore.proofBytes,
        restoreRoot,
        trustedDeliveryKeysBytes: Buffer.from(`${JSON.stringify(changedKeyring, null, 2)}\n`, "utf8"),
        expectedActiveReleaseId: value.previousReleaseId,
      }),
      /bytegenau gebundenen candidatePackage-Keyring/u,
    );

    await assert.rejects(
      preflightMapReleaseActivation({
        evidence,
        deploymentRoot,
        restoreProofBytes: restore.proofBytes,
        restoreRoot,
        trustedDeliveryKeysBytes: Buffer.from(`${JSON.stringify(value.trustedDeliveryKeys)}\n`, "utf8"),
        expectedActiveReleaseId: PREVIOUS_RELEASE_ID,
      }),
      /bytegenau gebundenen candidatePackage-Keyring/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verifiziert leeren Cache-Restore und verweigert Preflight bei fehlendem Rollback oder Bytesabweichung", async () => {
  const value = await fixture();
  const deploymentRoot = join(value.root, "deployment");
  try {
    const evidence = await materialized(value);
    const restoreRoot = join(value.root, "restored-cache");
    const prepared = await prepareEmptyBuildCacheRestore(restoreRoot);
    for (const [sourceFile, cacheFile] of value.cached) {
      const target = join(restoreRoot, ...cacheFile.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(value.root, ...sourceFile.split("/")), target);
    }
    const restore = await proveBuildCacheRestore(evidence, restoreRoot);
    assert.equal(restore.proof.verifiedFiles, value.inventory.files.length);
    assert.match(restore.proof.artifactBindingSha256, /^[a-f0-9]{64}$/);
    const restoreProofPath = join(value.root, "evidence", "restore-proof.json");
    await writeBuildCacheRestoreProof(restore, restoreProofPath);
    const restoreProofBytes = await readFile(restoreProofPath);
    const databaseProof = databaseRollbackProof();
    const databaseRollbackProofPath = join(value.root, "evidence", "database-rollback-proof.json");
    await writeFile(databaseRollbackProofPath, serializeMapReleaseBuildEvidence(databaseProof));
    const databaseRollbackProofBytes = await readFile(databaseRollbackProofPath);
    await write(restoreRoot, "cache/unexpected.bin", "not inventoried");
    await assert.rejects(proveBuildCacheRestore(evidence, restoreRoot), /vollständigen Evidence-Inventar/);
    await rm(join(restoreRoot, "cache", "unexpected.bin"));

    const candidatePackage = await installPackageFixture(value, deploymentRoot, RELEASE_ID);
    const previous = join(deploymentRoot, "releases", PREVIOUS_RELEASE_ID);
    await mkdir(previous, { recursive: true });
    await writeActivationPointer(value, deploymentRoot);
    const preflightArguments = {
      evidence,
      deploymentRoot,
      restoreProofBytes,
      restoreRoot,
      trustedDeliveryKeys: value.trustedDeliveryKeys,
      expectedActiveReleaseId: PREVIOUS_RELEASE_ID,
      databaseRollbackProofBytes,
    };
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /Rollbackrelease besitzt keinen \.zugfolge-map-package\.json-Paketmarker/,
    );
    let previousPackage = await installPackageFixture(value, deploymentRoot, PREVIOUS_RELEASE_ID);
    const previousRelease = JSON.parse(await readFile(join(previousPackage.installRoot, "manifests", "release.json"), "utf8"));
    assert.equal(previousRelease.approvalGates.signature.status, "missing");
    assert.equal(previousRelease.signature, null);
    const cli = fileURLToPath(new URL("./map-release-build-evidence-cli.mjs", import.meta.url));
    const rollbackPrivateKeyPath = join(value.root, "keys", "rollback-private.pem");
    await mkdir(dirname(rollbackPrivateKeyPath), { recursive: true });
    await writeFile(rollbackPrivateKeyPath, value.rollbackPrivateKey.export({ type: "pkcs8", format: "pem" }));
    const rollbackAttestationPath = join(deploymentRoot, ...value.spec.deployment.rollbackAttestationPath.split("/"));
    const cliAttestation = spawnSync(process.execPath, [
      cli,
      "attest-rollback",
      deploymentRoot,
      value.spec.deployment.previousInstallPath,
      PREVIOUS_RELEASE_ID,
      rollbackPrivateKeyPath,
      value.rollbackKeyId,
      rollbackAttestationPath,
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(cliAttestation.status, 0, cliAttestation.stderr);
    assert.equal(JSON.parse(cliAttestation.stdout).previousReleaseId, PREVIOUS_RELEASE_ID);
    let rollbackAttestation = {
      path: rollbackAttestationPath,
      signed: JSON.parse(await readFile(rollbackAttestationPath, "utf8")),
    };
    const preflight = await preflightMapReleaseActivation(preflightArguments);
    assert.equal(preflight.mapActivationEligible, true);
    assert.equal(preflight.activationEligible, false);
    assert.equal(preflight.rollbackEligible, false);
    assert.equal(preflight.rollbackEligibilityReason, "runtime-tuple-unbound-v1");
    assert.equal(preflight.rollbackAttestationSchema, "zugfolge-map-rollback-attestation/v1");
    assert.equal(preflight.deliveryKeyId, value.deliveryKeyId);
    assert.equal(preflight.rollbackAttestationKeyId, value.rollbackKeyId);
    assert.equal(preflight.activationState, "pre-activation");
    assert.equal(preflight.verifiedDeliveryArtifacts, evidence.deliveryInventory.length);
    const evidencePath = join(value.root, "evidence", "deployment-evidence.json");
    const trustedKeysPath = join(value.root, "evidence", "trusted-delivery-keys.json");
    const trustedKeyScopesPath = join(value.root, "evidence", "trusted-key-scopes.json");
    await writeMapReleaseBuildEvidence(evidence, evidencePath);
    await writeFile(trustedKeysPath, `${JSON.stringify(value.trustedDeliveryKeys)}\n`);
    await writeFile(trustedKeyScopesPath, `${JSON.stringify({
      alphaWorldDeployments: [value.worldKeyId],
      mapInfraDeliveries: [value.deliveryKeyId, value.rollbackKeyId].sort(),
    })}\n`);
    const cliPreflightWithoutFullStackIdentity = spawnSync(process.execPath, [
      cli,
      "preflight",
      evidencePath,
      deploymentRoot,
      restoreProofPath,
      restoreRoot,
      trustedKeysPath,
      trustedKeyScopesPath,
      PREVIOUS_RELEASE_ID,
    ], { encoding: "utf8", windowsHide: true });
    assert.notEqual(cliPreflightWithoutFullStackIdentity.status, 0);
    assert.match(cliPreflightWithoutFullStackIdentity.stderr, /DATABASE_ROLLBACK_PROOF\.json/u);

    const runtimeIdentity = {
      sourceCommit: "3".repeat(40),
      imageDigest: `sha256:${"4".repeat(64)}`,
      odooImageDigest: `sha256:${"5".repeat(64)}`,
      worldDeploymentPath: join(value.root, "runtime", "alpha-world-deployment.json"),
      databaseRollbackProofPath,
    };
    await assert.rejects(
      createMapRollbackAttestation({
        deploymentRoot,
        previousInstallPath: value.spec.deployment.previousInstallPath,
        previousReleaseId: PREVIOUS_RELEASE_ID,
        runtimeIdentity,
      }),
      /Rollback-ReadModel ist nicht an das vorherige Kartenrelease/u,
    );

    const deployment = {
      schema: "zugfolge-alpha-world-deployment/v2",
      worldId: "00000000-0000-4000-8000-000000000014",
      worldDefinition: { epoch: "2026-08-10T00:00:00.000Z" },
      repeatEveryS: 86400,
    };
    const deploymentHash = alphaHash(deployment.schema, deployment);
    const worldSignature = signEd25519(null, Buffer.from(deploymentHash, "hex"), value.worldPrivateKey);
    const signedWorldDeployment = {
      deployment,
      deploymentHash,
      signature: { algorithm: "Ed25519", keyId: value.worldKeyId, valueBase64: worldSignature.toString("base64") },
    };
    await write(value.root, "runtime/alpha-world-deployment.json", `${JSON.stringify(signedWorldDeployment, null, 2)}\n`);
    await rm(previousPackage.installRoot, { recursive: true, force: true });
    const previousReadModel = join(value.root, "outputs", "read-model.sqlite");
    const previousProjection = join(value.root, "outputs", "train-map-projection.sqlite");
    await rm(previousReadModel, { force: true });
    await rm(previousProjection, { force: true });
    createReadModel(previousReadModel, PREVIOUS_RELEASE_ID);
    createTrainProjection(previousProjection, PREVIOUS_RELEASE_ID, deploymentHash);
    previousPackage = await installPackageFixture(value, deploymentRoot, PREVIOUS_RELEASE_ID);
    await rm(rollbackAttestationPath);
    const unsignedRuntimeAttestationPath = join(value.root, "rollback-runtime-unsigned.json");
    const splitRuntimeAttestationPath = join(value.root, "rollback-runtime-split-signed.json");
    const prepareRuntimeAttestation = spawnSync(process.execPath, [
      cli,
      "prepare-runtime-rollback",
      deploymentRoot,
      value.spec.deployment.previousInstallPath,
      PREVIOUS_RELEASE_ID,
      runtimeIdentity.sourceCommit,
      runtimeIdentity.imageDigest,
      runtimeIdentity.odooImageDigest,
      runtimeIdentity.worldDeploymentPath,
      runtimeIdentity.databaseRollbackProofPath,
      unsignedRuntimeAttestationPath,
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(prepareRuntimeAttestation.status, 0, prepareRuntimeAttestation.stderr);
    const unsignedRuntimeAttestation = JSON.parse(await readFile(unsignedRuntimeAttestationPath, "utf8"));
    assert.equal(unsignedRuntimeAttestation.approvalGate.status, "missing");
    assert.equal(unsignedRuntimeAttestation.signature, null);
    assert.equal(unsignedRuntimeAttestation.attestationHash, undefined);
    const signPreparedRuntimeAttestation = spawnSync(process.execPath, [
      cli,
      "sign-runtime-rollback",
      unsignedRuntimeAttestationPath,
      rollbackPrivateKeyPath,
      value.rollbackKeyId,
      splitRuntimeAttestationPath,
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(signPreparedRuntimeAttestation.status, 0, signPreparedRuntimeAttestation.stderr);
    const splitRuntimeSigned = JSON.parse(await readFile(splitRuntimeAttestationPath, "utf8"));
    assert.equal(splitRuntimeSigned.schema, "zugfolge-map-rollback-attestation/v3");
    assert.equal(splitRuntimeSigned.runtimeTuple.databaseRollback.proofHash, databaseProof.proofHash);

    const cliRuntimeAttestation = spawnSync(process.execPath, [
      cli,
      "attest-runtime-rollback",
      deploymentRoot,
      value.spec.deployment.previousInstallPath,
      PREVIOUS_RELEASE_ID,
      runtimeIdentity.sourceCommit,
      runtimeIdentity.imageDigest,
      runtimeIdentity.odooImageDigest,
      runtimeIdentity.worldDeploymentPath,
      runtimeIdentity.databaseRollbackProofPath,
      rollbackPrivateKeyPath,
      value.rollbackKeyId,
      rollbackAttestationPath,
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(cliRuntimeAttestation.status, 0, cliRuntimeAttestation.stderr);
    const cliRuntimeAttestationResult = JSON.parse(cliRuntimeAttestation.stdout);
    assert.equal(cliRuntimeAttestationResult.runtimeTupleSchema, "zugfolge-runtime-rollback-tuple/v3");
    assert.equal(cliRuntimeAttestationResult.databaseRollbackProofHash, databaseProof.proofHash);
    const runtimeSigned = JSON.parse(await readFile(rollbackAttestationPath, "utf8"));
    assert.equal(runtimeSigned.schema, "zugfolge-map-rollback-attestation/v3");
    assert.equal(runtimeSigned.runtimeTuple.databaseRollback.sourceKeycloakIdentityHead.stateHash, databaseProof.source.keycloakIdentityHead.stateHash);
    assert.deepEqual(splitRuntimeSigned, runtimeSigned, "Getrennte Server-Vorbereitung und Offline-Signatur muessen dieselbe Attestation erzeugen.");
    rollbackAttestation = { path: rollbackAttestationPath, signed: runtimeSigned };
    const runtimePreflight = await preflightMapReleaseActivation({ ...preflightArguments, runtimeIdentity });
    assert.equal(runtimePreflight.mapActivationEligible, true);
    assert.equal(runtimePreflight.activationEligible, true);
    assert.equal(runtimePreflight.rollbackEligible, true);
    assert.equal(runtimePreflight.mapRollbackEligible, true);
    assert.equal(runtimePreflight.databaseRollbackEligible, true);
    assert.equal(runtimePreflight.writersQuiesced, true);
    assert.equal(runtimePreflight.rollbackWindow, "pre-activation-only");
    assert.equal(runtimePreflight.databaseRollbackProofHash, databaseProof.proofHash);
    assert.equal(runtimePreflight.databaseBackupManifestSha256, databaseProof.backupManifestSha256);
    assert.equal(runtimePreflight.databaseRestoreProofSha256, databaseProof.restoreProofSha256);
    assert.equal(runtimePreflight.rollbackEligibilityReason, "full-stack-runtime-tuple-v3-verified");
    assert.equal(runtimePreflight.rollbackAttestationSchema, "zugfolge-map-rollback-attestation/v3");
    const cliRuntimePreflight = spawnSync(process.execPath, [
      cli,
      "preflight",
      evidencePath,
      deploymentRoot,
      restoreProofPath,
      restoreRoot,
      trustedKeysPath,
      trustedKeyScopesPath,
      PREVIOUS_RELEASE_ID,
      runtimeIdentity.sourceCommit,
      runtimeIdentity.imageDigest,
      runtimeIdentity.odooImageDigest,
      runtimeIdentity.worldDeploymentPath,
      runtimeIdentity.databaseRollbackProofPath,
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(cliRuntimePreflight.status, 0, cliRuntimePreflight.stderr);
    const cliRuntimePreflightResult = JSON.parse(cliRuntimePreflight.stdout);
    assert.equal(cliRuntimePreflightResult.activationEligible, true);
    assert.equal(cliRuntimePreflightResult.rollbackEligible, true);
    assert.equal(cliRuntimePreflightResult.databaseRollbackEligible, true);
    assert.equal(cliRuntimePreflightResult.databaseRollbackProofHash, databaseProof.proofHash);
    const { databaseRollbackProofPath: omittedDatabaseRollbackProofPath, ...runtimeWithoutDatabasePath } = runtimeIdentity;
    assert.equal(omittedDatabaseRollbackProofPath, databaseRollbackProofPath);
    await assert.rejects(
      preflightMapReleaseActivation({ ...preflightArguments, runtimeIdentity: runtimeWithoutDatabasePath }),
      /keinen Datenbank-Rollbackbeleg-Pfad/u,
    );
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity,
        databaseRollbackProofBytes: undefined,
      }),
      /Datenbank-Rollbackbeleg fehlt/u,
    );
    const foreignDatabaseProofBytes = serializeMapReleaseBuildEvidence(databaseRollbackProof({
      restoreSeparation: {
        schema: "zugfolge-database-restore-separation/v1",
        sourceEndpointSha256: "5".repeat(64),
        restoredEndpointSha256: "6".repeat(64),
        sourceBackendSha256: "7".repeat(64),
        restoredBackendSha256: "8".repeat(64),
      },
    }));
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity,
        databaseRollbackProofBytes: foreignDatabaseProofBytes,
      }),
      /Map-\/Datenbank-Runtime-Tuple weicht/u,
    );
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity: { ...runtimeIdentity, sourceCommit: "5".repeat(40) },
      }),
      /Source-\/Image-\/Welt-\/Map-\/Datenbank-Runtime-Tuple weicht/u,
    );
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity: { ...runtimeIdentity, imageDigest: `sha256:${"6".repeat(64)}` },
      }),
      /Source-\/Image-\/Welt-\/Map-\/Datenbank-Runtime-Tuple weicht/u,
    );
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity: { ...runtimeIdentity, odooImageDigest: `sha256:${"6".repeat(64)}` },
      }),
      /Source-\/Image-\/Welt-\/Map-\/Datenbank-Runtime-Tuple weicht/u,
    );
    const alternateWorldPath = await write(value.root, "runtime/alpha-world-deployment-alternate.json", `${JSON.stringify(signedWorldDeployment)}\n`);
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity: { ...runtimeIdentity, worldDeploymentPath: alternateWorldPath },
      }),
      /Source-\/Image-\/Welt-\/Map-\/Datenbank-Runtime-Tuple weicht/u,
    );

    await assert.rejects(
      preflightMapReleaseActivation({ ...preflightArguments, restoreProofBytes: undefined, restoreProof: restore.proof }),
      /Datei-Artefakt/,
    );
    const forgedProof = structuredClone(restore.proof);
    forgedProof.artifactBindingSha256 = "f".repeat(64);
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        restoreProofBytes: serializeMapReleaseBuildEvidence(forgedProof),
      }),
      /aktuell verifizierten Restore-Artefakt/,
    );

    const restoredSource = join(restoreRoot, ...value.cached[0][1].split("/"));
    await writeFile(restoredSource, "nach Proof manipuliert");
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /vollständigen Evidence-Inventar/,
    );
    await copyFile(join(value.root, ...value.cached[0][0].split("/")), restoredSource);

    const markerBytes = await readFile(prepared.markerPath);
    const marker = JSON.parse(markerBytes.toString("utf8"));
    await writeFile(prepared.markerPath, serializeMapReleaseBuildEvidence({ ...marker, acceptedAfterRestore: true }));
    await assert.rejects(proveBuildCacheRestore(evidence, restoreRoot), /Leerpfadmarker besitzt unbekannte Felder/);
    await writeFile(prepared.markerPath, markerBytes);
    await writeFile(prepared.markerPath, serializeMapReleaseBuildEvidence({ schema: "zugfolge-map-build-cache-empty-root/v1", nonce: "00000000-0000-4000-8000-000000000000" }));
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /aktuell verifizierten Restore-Artefakt/,
    );
    await writeFile(prepared.markerPath, markerBytes);

    await writeActivationPointer(value, deploymentRoot, RELEASE_ID);
    const activeCandidate = await preflightMapReleaseActivation({
      ...preflightArguments,
      expectedActiveReleaseId: RELEASE_ID,
    });
    assert.equal(activeCandidate.activationState, "active-candidate");
    assert.equal(activeCandidate.activeReleaseId, RELEASE_ID);
    assert.equal(activeCandidate.rollbackEligible, false);
    assert.equal(activeCandidate.rollbackEligibilityReason, "runtime-identity-missing");
    const activeWithForeignRuntime = await preflightMapReleaseActivation({
      ...preflightArguments,
      expectedActiveReleaseId: RELEASE_ID,
      runtimeIdentity: { ...runtimeIdentity, sourceCommit: "5".repeat(40) },
    });
    assert.equal(activeWithForeignRuntime.rollbackEligible, false);
    assert.equal(activeWithForeignRuntime.rollbackEligibilityReason, "full-stack-runtime-tuple-mismatch");
    await writeActivationPointer(value, deploymentRoot);
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity: { ...runtimeIdentity, sourceCommit: "5".repeat(40) },
      }),
      /Source-\/Image-\/Welt-\/Map-\/Datenbank-Runtime-Tuple weicht/u,
    );
    await writeActivationPointer(value, deploymentRoot, RELEASE_ID);
    await assert.rejects(preflightMapReleaseActivation(preflightArguments), /explizit erwartete Release/);
    await writeActivationPointer(value, deploymentRoot);

    const otherKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        trustedDeliveryKeys: { ...value.trustedDeliveryKeys, [value.deliveryKeyId]: otherKey },
      }),
      /keine gültige vertrauenswürdige Ed25519-Signatur/,
    );
    await assert.rejects(
      preflightMapReleaseActivation({ ...preflightArguments, trustedDeliveryKeys: {} }),
      /Delivery-Keyring ist leer|nicht vertrauenswürdig/,
    );

    const previousMarkerPath = join(previousPackage.installRoot, ".zugfolge-map-package.json");
    const previousMarkerBytes = await readFile(previousMarkerPath);
    const attacker = generateKeyPairSync("ed25519");
    const { attestationHash: ignoredAttestationHash, signature: ignoredAttestationSignature, ...unsignedAttestation } = rollbackAttestation.signed;
    void ignoredAttestationHash;
    void ignoredAttestationSignature;
    unsignedAttestation.approvalGate = { status: "missing" };
    unsignedAttestation.signature = null;
    const forgedAttestation = signMapRollbackAttestation(
      unsignedAttestation,
      attacker.privateKey.export({ type: "pkcs8", format: "pem" }),
      value.rollbackKeyId,
    );
    const rollbackAttestationBytes = await readFile(rollbackAttestation.path);
    await writeFile(rollbackAttestation.path, serializeMapReleaseBuildEvidence(forgedAttestation));
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /Rollback-Attestation besitzt keine gültige vertrauenswürdige Ed25519-Signatur/,
    );
    await writeFile(rollbackAttestation.path, rollbackAttestationBytes);

    const markerMutation = structuredClone(previousPackage.manifest);
    markerMutation.partBytes += 1;
    await writeFile(previousMarkerPath, serializeMapPackageManifest(markerMutation));
    await assert.rejects(preflightMapReleaseActivation(preflightArguments), /Rollback-Attestation weicht vom installierten kanonischen Paketmarker ab/);
    await writeFile(previousMarkerPath, previousMarkerBytes);

    const withoutRollbackKey = { ...value.trustedDeliveryKeys };
    delete withoutRollbackKey[value.rollbackKeyId];
    await assert.rejects(
      preflightMapReleaseActivation({ ...preflightArguments, trustedDeliveryKeys: withoutRollbackKey }),
      /Rollback-Attestation-Signaturschlüssel .* ist nicht vertrauenswürdig/,
    );

    const previousBasemap = join(previousPackage.installRoot, "basemap.pmtiles");
    const previousBasemapBytes = await readFile(previousBasemap);
    await writeFile(previousBasemap, "manipulierter Vorgänger");
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /Rollbackrelease-Artefakt welt-basiskarte ist beschädigt/,
    );
    await writeFile(previousBasemap, previousBasemapBytes);

    const unexpected = join(candidatePackage.installRoot, "nicht-inventarisiert.bin");
    await writeFile(unexpected, "nicht erlaubt");
    await assert.rejects(preflightMapReleaseActivation(preflightArguments), /Kandidatenrelease enthält die unerwartete Datei/);
    await rm(unexpected);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("ein mutiertes Evidence-Manifest bleibt auch ohne erneuten Build ungültig", async () => {
  const value = await fixture();
  try {
    const evidence = await materialized(value);
    const mutable = structuredClone(evidence);
    mutable.tools[0].version = "latest";
    assert.throws(() => validateMapReleaseBuildEvidence(mutable), /latest|unversioniert/);

    await writeFile(join(value.root, "outputs", "style.json"), '{"version":8,"changed":true}\n');
    await assert.rejects(verifyMapReleaseBuildEvidence(evidence, value.root), /Ausgabe style weicht/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("schreibt Evidence auch bei zwei parallelen Erzeugern atomar create-new", async () => {
  const value = await fixture();
  try {
    const evidence = await materialized(value);
    const output = join(value.root, "evidence", "parallel.json");
    const attempts = await Promise.allSettled([
      writeMapReleaseBuildEvidence(evidence, output),
      writeMapReleaseBuildEvidence(evidence, output),
    ]);
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    assert.match(String(rejected.reason), /create-new|existiert bereits/);
    assert.deepEqual(await readFile(output), serializeMapReleaseBuildEvidence(evidence));
    assert.equal((await readdir(dirname(output))).some((name) => name.includes(".building")), false);
    await assert.rejects(writeMapReleaseBuildEvidence(evidence, output), /create-new|existiert bereits/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("CLI baut und verifiziert dasselbe kanonische Evidence-Manifest und belegt den Leerpfadmarker", async () => {
  const value = await fixture();
  try {
    const cli = fileURLToPath(new URL("./map-release-build-evidence-cli.mjs", import.meta.url));
    const evidencePath = join(value.root, "evidence", "map-release-build-evidence-2026.2.json");
    const build = spawnSync(process.execPath, [cli, "build", join(value.root, ...value.specFile.split("/")), value.root, evidencePath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(build.status, 0, build.stderr);
    assert.equal(JSON.parse(build.stdout).releaseId, RELEASE_ID);
    const verify = spawnSync(process.execPath, [cli, "verify", evidencePath, value.root], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).semanticLayers, 10);
    const prepare = spawnSync(process.execPath, [cli, "prepare-restore", join(value.root, "cli-restore")], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.match(JSON.parse(prepare.stdout).markerSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
