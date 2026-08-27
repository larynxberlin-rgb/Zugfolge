import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { alphaCanonicalJson } from "../../packages/alpha/dist/index.js";
import { canonicalPlanningJson } from "../../packages/gtfs/dist/index.js";
import { buildAlphaWorld, germanyOperationalStableId } from "./build-alpha-world.mjs";
import {
  runAlphaFleetV1Migration,
  runBuildAlphaFleetMigrationContract,
} from "./migrate-alpha-fleet-v1-to-v2.mjs";
import {
  canonicalOperationalInfrastructureV2Json,
  operationalInfrastructureV2StateHash,
} from "./operational-infrastructure-binding.mjs";

export const MINIMAL_BUILDER_WORLD_ID = "e2695e40-3e4c-4e8c-9481-98f6223538d0";
export const MINIMAL_BUILDER_REGION_ID = "mitteldeutschland-b";
export const MINIMAL_BUILDER_EPOCH = "2026-08-10T00:00:00.000Z";

const LEGACY_WORLD_ID = "00000000-0000-4000-8000-000000000014";
const PLANNING_AUTHORITY_ID = "a2a545d2-74f7-40af-908d-1901ba2220bb";
const INFRA_RELEASE_ID = "infra-alpha-builder-fixture-2026.1";
const ARCHIVE_SHA256 = "a".repeat(64);
const GTFS_RELEASE_ID = `gtfs-de-rv-20260810-${ARCHIVE_SHA256.slice(0, 16)}`;
const FLEET_RELEASE_ID = "fleet-alpha-builder-fixture-2026.1-v2";
const SOURCE_CATALOG_RELEASE_ID = "vehicle-source-alpha-builder-fixture-2026.1-v2";
const WORLD_SEED_ID = "vehicle-seed-alpha-builder-fixture-2026.1-v3";
const OPERATIONAL_FLEET_RELEASE_ID = "operational-fleet-alpha-builder-fixture-2026.1-v2";
const ROUTE_COUNT = 8;
const EDGE_ID = "alpha-builder-fixture-edge";
const EDGE_LENGTH_MM = 1_000_000;
const PATH_RESOURCE = "alpha-builder-fixture:resource:path";
const OVERLAP_RESOURCE = "alpha-builder-fixture:resource:overlap";
const FLANK_RESOURCE = "alpha-builder-fixture:resource:flank";
const SIGNAL_ID = "alpha-builder-fixture:signal:entry";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function routeIdentity(index) {
  const suffix = String(index + 1).padStart(2, "0");
  const playableLegId = `alpha-builder-leg-${suffix}`;
  const routeVersionId = `route:gtfs:${playableLegId}:v1`;
  return Object.freeze({
    suffix,
    playableLegId,
    routeVersionId,
    templateId: `template:gtfs:${playableLegId}:v1`,
    interlockingRouteId: germanyOperationalStableId(
      "interlocking:synthetic-segment:",
      [routeVersionId, "0"],
    ),
  });
}

function timetableRoute(index) {
  const identity = routeIdentity(index);
  return {
    routeVersionId: identity.routeVersionId,
    templateId: identity.templateId,
    predecessorId: null,
    transitionRouteMm: null,
    legs: [{
      edgeId: EDGE_ID,
      direction: "along",
      edgeEntryMm: 0,
      edgeExitMm: EDGE_LENGTH_MM,
      availableProtectionSystems: ["pzb"],
      simultaneouslyRequiredProtectionSystems: [],
    }],
  };
}

function operationalInfrastructure() {
  const routeVersions = {};
  const interlockingRoutes = {};
  for (let index = 0; index < ROUTE_COUNT; index += 1) {
    const identity = routeIdentity(index);
    routeVersions[identity.routeVersionId] = {
      id: identity.routeVersionId,
      templateId: identity.templateId,
      predecessorId: null,
      transitionRouteMm: null,
      legs: [{
        edgeId: EDGE_ID,
        direction: "along",
        edgeEntryMm: 0,
        edgeExitMm: EDGE_LENGTH_MM,
        routeStartMm: 0,
        speedLimitMmps: 33_333,
        gradientPerMille: 0,
        blockIds: [PATH_RESOURCE],
        availableProtectionSystems: ["pzb"],
        simultaneouslyRequiredProtectionSystems: [],
      }],
    };
    interlockingRoutes[identity.interlockingRouteId] = {
      id: identity.interlockingRouteId,
      routeTemplateId: identity.templateId,
      signalId: SIGNAL_ID,
      movementKind: "train",
      pathResources: [PATH_RESOURCE],
      overlapResources: [OVERLAP_RESOURCE],
      flankResources: [FLANK_RESOURCE],
      switchPositions: {},
      authorityStartRouteMm: 0,
      authorityEndRouteMm: EDGE_LENGTH_MM,
      releaseAfterTailRouteMm: EDGE_LENGTH_MM,
    };
  }
  return {
    blockResources: [FLANK_RESOURCE, OVERLAP_RESOURCE, PATH_RESOURCE],
    directedEdges: { [EDGE_ID]: EDGE_LENGTH_MM },
    edgeGeometries: {
      [EDGE_ID]: [
        { bearingMilliDegrees: 90_000, edgeOffsetMm: 0, latitudeE7: 510_000_000, longitudeE7: 100_000_000 },
        { bearingMilliDegrees: null, edgeOffsetMm: EDGE_LENGTH_MM, latitudeE7: 510_010_000, longitudeE7: 100_020_000 },
      ],
    },
    id: INFRA_RELEASE_ID,
    interlockingRoutes,
    platformIntervals: {},
    regionBoundaries: [],
    routeVersions,
    rzueLayoutId: "alpha-builder-fixture:rzue-layout:v1",
    signals: [SIGNAL_ID],
    switches: [],
  };
}

function gtfsEnvelope() {
  const journeyChains = [];
  const segments = [];
  for (let index = 0; index < ROUTE_COUNT; index += 1) {
    const identity = routeIdentity(index);
    const departureS = 3_600 + index * 600;
    journeyChains.push({
      worldId: MINIMAL_BUILDER_WORLD_ID,
      releaseId: GTFS_RELEASE_ID,
      journeyChainId: `alpha-builder-run-${identity.suffix}`,
      routeId: `alpha-builder-route-${identity.suffix}`,
      routeShortName: `RB ${index + 1}`,
      orderable: true,
      legs: [{
        kind: "playable",
        legId: identity.playableLegId,
        orderable: true,
        qualityClass: "B",
        entryPortalId: null,
        exitPortalId: null,
        stops: [
          { stopId: "alpha-builder-stop-a", arrivalS: departureS, departureS },
          { stopId: "alpha-builder-stop-b", arrivalS: departureS + 300, departureS: departureS + 300 },
        ],
      }],
    });
    segments.push({ id: `alpha-builder-segment-${identity.suffix}`, orderable: true, qualityClass: "B" });
  }
  const snapshot = {
    serviceDate: "20260810",
    source: {
      archive: "gtfs-alpha-builder-fixture.zip",
      archiveSha256: ARCHIVE_SHA256,
      sourceLicense: "CC BY 4.0",
    },
    regionId: MINIMAL_BUILDER_REGION_ID,
    regionVariant: "B",
    metrics: { orderableJourneyChainCount: ROUTE_COUNT },
    stations: [
      { stopId: "alpha-builder-stop-a", name: "Alpha Builder A", latitudeE7: 510_000_000, longitudeE7: 100_000_000 },
      { stopId: "alpha-builder-stop-b", name: "Alpha Builder B", latitudeE7: 510_010_000, longitudeE7: 100_020_000 },
    ],
    segments,
    journeyChains,
  };
  return { snapshot, snapshotHash: sha256(canonicalPlanningJson(snapshot)) };
}

function economySpecification() {
  return {
    version: "alpha-builder-economy-2026.1",
    rates: {
      trackPerTrainKmCents: "100", stationPerStopCents: "200", facilityPerHourCents: "300", energyPerKwhCents: "40",
      personnelPerHourCents: "4000", administrationPerPeriodCents: "50000", vehiclePerPeriodCents: "100000",
      overnightStablingPerPeriodCents: "20000", protectionEquipmentPerPeriodCents: "10000", lateInterestBasisPoints: 500,
    },
    rules: {
      qualityBaselinePunctualityBasisPoints: 8500, pointsPerExtraSeat: 40, pointsPerPunctualityBasisPoint: 1,
      pointsPerAdditionalStop: 300, requirementFocusMaximumPoints: 1500, contractBonusCentsPerPeriod: "100000",
      penaltyRates: { punctuality: "10", cancellation: "10000", seats: "100", connections: "1000" },
      penaltyFocusMultiplierBasisPoints: 20000, publicOperationSurchargeBasisPoints: 2000,
      failedPackageFeeStepBasisPoints: 500, failedPackageReductionStepBasisPoints: 400,
    },
    tenderProfiles: [
      { id: "price", weights: { price: 7000, quality: 3000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 1000 },
      { id: "quality", weights: { price: 3000, quality: 7000 }, requirementFocus: "accessibility", penaltyFocus: "connections", viabilitySurchargeBasisPoints: 1500 },
    ],
  };
}

function legacyAsset(index) {
  return {
    id: `alpha-builder-vehicle-${String(index + 1).padStart(2, "0")}`,
    numericId: 10_001 + index,
    operatorId: "public",
    vehicleTypeId: 1_101,
    classDesignation: "563.0",
    tradeName: "Alpha Builder BEMU",
    buildYear: 2024,
    acquisitionYear: 2026,
    procurementChannel: "used",
    approvedLineIds: ["legacy-line"],
    maintenanceDeadlines: [{ kind: "release-overhaul-validity", dueAt: 31_622_400 }],
    installedProtection: ["pzb"],
    technical: {
      lengthMm: 46_560, massKg: 93_000, maximumSpeedKph: 140, continuousPowerKw: 1_700,
      startingTractiveEffortKn: 130, traction: "battery", electricSystems: [], role: "powered-unit",
      controlStands: { front: true, rear: true },
    },
    passenger: {
      seats: 100, firstClassSeats: 0, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2,
      equipment: ["passenger-information"], operatingCostCentsPerTrainKm: 800, replacementPlan: true,
    },
    deliveredAt: 0,
    retiredAt: 31_622_400,
  };
}

function legacyDeployment() {
  return {
    deployment: {
      schema: "zugfolge-alpha-world-deployment/v1",
      worldId: LEGACY_WORLD_ID,
      fleet: {
        schemaVersion: "zugfolge-fleet-world-initialize/v2",
        worldId: LEGACY_WORLD_ID,
        authorityRelease: {
          schemaVersion: "zugfolge-fleet-authority-release/v1",
          releaseId: "fleet-alpha-builder-fixture-legacy-v1",
          referenceYear: 2026,
          assets: Array.from({ length: ROUTE_COUNT }, (_, index) => legacyAsset(index)),
          personnelPools: [],
          pathReceipts: [],
        },
        formations: [],
        personnelDuties: [],
        pathReservations: [],
      },
    },
  };
}

function migrationSpecification(legacyBytes, legacy) {
  const authority = legacy.deployment.fleet.authorityRelease;
  const authorityReleaseSha256 = sha256(alphaCanonicalJson(authority));
  return {
    schemaVersion: "zugfolge-alpha-fleet-v1-migration-contract-specification/v1",
    legacy: {
      file: "alpha-world-deployment.json",
      bytes: legacyBytes.length,
      sha256: sha256(legacyBytes),
      worldId: LEGACY_WORLD_ID,
      authorityReleaseId: authority.releaseId,
      authorityReleaseSha256,
      assetCount: authority.assets.length,
    },
    target: {
      sourceCatalogReleaseId: SOURCE_CATALOG_RELEASE_ID,
      seedId: WORLD_SEED_ID,
      authorityReleaseId: FLEET_RELEASE_ID,
      operationalReleaseId: OPERATIONAL_FLEET_RELEASE_ID,
      gtfsReleaseId: GTFS_RELEASE_ID,
      worldId: MINIMAL_BUILDER_WORLD_ID,
      producedAt: 0,
      referenceYear: 2026,
    },
    source: {
      id: "approved-alpha-builder-fleet-fixture",
      title: "Freigegebener kleiner Alpha-Builder-Testbestand",
      url: "https://example.invalid/approved-alpha-builder-fleet-fixture",
      license: "LicenseRef-Zugfolge-Approved-Game-Data",
      retrievedAt: "2026-08-25",
      contentSha256: authorityReleaseSha256,
      rightsDecision: {
        status: "freigegeben", decidedAt: "2026-08-25", reviewer: "fixture-owner",
        reference: "alpha-builder-runtime-integration",
      },
    },
  };
}

/** Materialisiert echte Inputs, migriert sie und ruft den produktiven Weltbuilder auf. */
export async function buildMinimalAlphaWorldRuntimeFixture(root) {
  await mkdir(root, { recursive: true });
  const legacyDirectory = join(root, "legacy");
  await mkdir(legacyDirectory, { recursive: true });
  const paths = {
    buildConfiguration: join(root, "alpha-world-build-configuration-v2.json"),
    gtfs: join(root, "gtfs-alpha-builder-fixture-v2.json"),
    economy: join(root, "economy-alpha-builder-fixture.json"),
    infraRelease: join(root, "infra-release-alpha-builder-fixture.json"),
    operationalInfrastructure: join(root, "operational-infrastructure-v2.json"),
    timetableRoutes: join(root, "timetable-routes-v2.jsonseq"),
    publicDeployConfiguration: join(root, "public-world-deploy-configuration.json"),
    legacyDeployment: join(legacyDirectory, "alpha-world-deployment.json"),
    migrationSpecification: join(root, "alpha-fleet-migration-specification.json"),
    migrationContract: join(root, "alpha-fleet-migration-contract.json"),
    migrationBundle: join(root, "alpha-fleet-migration-bundle"),
    deployment: join(root, "alpha-world-deployment.json"),
  };

  const infrastructure = operationalInfrastructure();
  const operationalBytes = Buffer.from(`${canonicalOperationalInfrastructureV2Json(infrastructure)}\n`, "utf8");
  const operationalProof = {
    file: "operational-infrastructure-v2.json",
    bytes: operationalBytes.length,
    sha256: sha256(operationalBytes),
    stateHash: operationalInfrastructureV2StateHash(infrastructure),
  };
  const timetableBytes = Buffer.from(
    `${Array.from({ length: ROUTE_COUNT }, (_, index) => JSON.stringify(timetableRoute(index))).join("\n")}\n`,
    "utf8",
  );
  const timetableProof = { file: "timetable-routes-v2.jsonseq", bytes: timetableBytes.length, sha256: sha256(timetableBytes) };
  const gtfs = gtfsEnvelope();
  const gtfsBytes = jsonBytes(gtfs);
  const economy = economySpecification();
  const economyBytes = jsonBytes(economy);
  const buildConfiguration = {
    schemaVersion: "zugfolge-alpha-world-build-configuration/v2",
    worldId: MINIMAL_BUILDER_WORLD_ID,
    regionId: MINIMAL_BUILDER_REGION_ID,
    regionVariant: "B",
    operatorId: "public",
    seed: "42",
    fleetReleaseId: FLEET_RELEASE_ID,
    planningAuthority: { accountId: PLANNING_AUTHORITY_ID, displayName: "Alpha Builder Fixture-Aufgabentraeger" },
    operationalInfrastructure: operationalProof,
    timetableRoutes: timetableProof,
  };
  const infraRelease = {
    schema: "zugfolge-infra-release/v2",
    releaseId: INFRA_RELEASE_ID,
    timetableYear: 2026,
    sources: [{ id: "gtfs-de-regional-rail", sha256: ARCHIVE_SHA256 }],
    artifacts: [{
      id: "operational-infrastructure-alpha-builder-fixture",
      kind: "operational-infrastructure-v2",
      infraReleaseId: INFRA_RELEASE_ID,
      ...operationalProof,
    }],
    quality: {
      operationalClosure: {
        operationalQualityEligible: true,
        unresolvedRequired: 0,
        timetableRouteEvidence: {
          archive: gtfs.snapshot.source.archive,
          archiveSha256: gtfs.snapshot.source.archiveSha256,
          sourceLicenseAsPublished: gtfs.snapshot.source.sourceLicense,
          gtfsSnapshotBytes: gtfsBytes.length,
          gtfsSnapshotSha256: sha256(gtfsBytes),
          snapshotHash: gtfs.snapshotHash,
          routesBytes: timetableProof.bytes,
          routesSha256: timetableProof.sha256,
          routeSetSha256: timetableProof.sha256,
          routeRecordCount: ROUTE_COUNT,
          completeRouteCount: ROUTE_COUNT,
          selectedSegmentCount: ROUTE_COUNT,
        },
      },
    },
  };
  const infraReleaseWrapper = { release: infraRelease, releaseHash: sha256(alphaCanonicalJson(infraRelease)) };
  const legacy = legacyDeployment();
  const legacyBytes = jsonBytes(legacy);

  await Promise.all([
    writeFile(paths.operationalInfrastructure, operationalBytes, { flag: "wx" }),
    writeFile(paths.timetableRoutes, timetableBytes, { flag: "wx" }),
    writeFile(paths.gtfs, gtfsBytes, { flag: "wx" }),
    writeFile(paths.economy, economyBytes, { flag: "wx" }),
    writeFile(paths.buildConfiguration, jsonBytes(buildConfiguration), { flag: "wx" }),
    writeFile(paths.infraRelease, jsonBytes(infraReleaseWrapper), { flag: "wx" }),
    writeFile(paths.legacyDeployment, legacyBytes, { flag: "wx" }),
    writeFile(paths.migrationSpecification, jsonBytes(migrationSpecification(legacyBytes, legacy)), { flag: "wx" }),
    writeFile(paths.publicDeployConfiguration, jsonBytes({
      schemaVersion: "zugfolge-alpha-world-deploy-configuration/v1",
      worldId: MINIMAL_BUILDER_WORLD_ID,
      deploymentRevision: 1,
      worldDefinition: {
        name: "Alpha Builder Runtime-Fixture",
        kind: "public",
        rankingStatus: "ranked",
        schedulePeriodWeeks: 4,
        epoch: MINIMAL_BUILDER_EPOCH,
      },
      startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    }), { flag: "wx" }),
  ]);

  await runBuildAlphaFleetMigrationContract([
    paths.migrationSpecification, paths.buildConfiguration, paths.gtfs, paths.legacyDeployment,
    paths.economy, paths.infraRelease, paths.migrationContract,
  ]);
  await runAlphaFleetV1Migration([
    paths.migrationContract, paths.buildConfiguration, paths.gtfs, paths.legacyDeployment,
    paths.economy, paths.infraRelease, paths.timetableRoutes, paths.migrationBundle,
  ]);

  const compiled = join(paths.migrationBundle, "compiled");
  await buildAlphaWorld([
    paths.buildConfiguration,
    paths.gtfs,
    join(compiled, "fleet-authority-release-catalog-v1.json"),
    paths.infraRelease,
    paths.economy,
    paths.deployment,
    paths.publicDeployConfiguration,
    paths.operationalInfrastructure,
    paths.timetableRoutes,
    join(compiled, "vehicle-catalog-compile-receipt-v4.json"),
    join(compiled, "operational-vehicle-inventory-v2.json"),
    join(paths.migrationBundle, "vehicle-catalog-source-v2.json"),
    join(paths.migrationBundle, "vehicle-world-seed-v3.json"),
    join(compiled, "vehicle-catalog-v3.json"),
  ]);

  return Object.freeze({
    ...paths,
    infrastructureRoot: root,
    infraReleaseId: INFRA_RELEASE_ID,
    routeCount: ROUTE_COUNT,
  });
}
