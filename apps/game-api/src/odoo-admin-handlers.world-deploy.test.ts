import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  alphaWorldProfiles,
  alphaWorldDeployments,
  MIGRATIONS_FOLDER,
  odooProjectionOutbox,
  schema,
  worlds,
} from "@zugfolge/db";
import {
  ALPHA_WORLD_BLUEPRINT_SCHEMA,
  PUBLIC_ENTRY_FACILITY_SCHEMA,
  alphaHash,
  validateWorldBlueprint,
  type AlphaWorldBlueprint,
} from "@zugfolge/alpha";
import type {
  AdminCommandPayload,
  GameAdminCommandContext,
  SignedWorldDeployment,
} from "@zugfolge/commerce";
import {
  buildEconomyRelease,
  decodeEconomyValue,
  encodeEconomyValue,
  fleetSnapshotHash,
  startEconomyWorld,
  type FleetMobilizationSnapshot,
} from "@zugfolge/economy";
import type { IdentityDatabase } from "@zugfolge/identity";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
import { OperationsRegistry } from "@zugfolge/dispatch";
import {
  FLEET_AUTHORITY_RELEASE_SCHEMA,
  FLEET_INITIALIZED_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  FLEET_STATE_SCHEMA,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  type FleetRuntime,
  type FleetWorldInitialization,
} from "@zugfolge/runtime-native";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALPHA_WORLD_DEPLOYMENT_SCHEMA,
  assertActivePublicWorldDeploymentCoverage,
  loadPersistedActiveAlphaWorldDeployments,
  loadSignedRunningWorldDeployment,
  parseSignedAlphaWorldDeployment,
  resolveAlphaWorldStartupDeployments,
  serializeSignedAlphaWorldDeployment,
  type AlphaWorldDeployment,
  type SignedAlphaWorldDeployment,
} from "./alpha-world-start.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";
import type { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import { assertServerWorldDeployment, serverWorldScope, type ServerWorldScope } from "./server-world-scope.js";
import {
  WorldDeploymentAdminError,
  createWorldDeployAdminHandler,
  enqueueStartedWorldCapabilities,
  worldIdsForOdooProjectionDispatch,
} from "./odoo-admin-handlers.js";

const WORLD_ID = "70000000-0000-4000-8000-000000000001";
const REGION_ID = "mitteldeutschland-b";
const WORLD_EPOCH = "2026-12-14T00:00:00.000Z";
const KEY_ID = "world-deploy-test-2026";
const FLEET_RELEASE_HASH = "c".repeat(64);
const PLANNING_AUTHORITY_ACCOUNT_ID = "70000000-0000-4000-8000-000000000099";

const lotId = (index: number) => `lot-test-${index + 1}`;
const trainRunId = (index: number) => `train-test-${index + 1}`;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

const economyRelease = buildEconomyRelease({
  version: "world-deploy-test-v1",
  rates: {
    trackPerTrainKmCents: 1n,
    stationPerStopCents: 1n,
    facilityPerHourCents: 1n,
    energyPerKwhCents: 1n,
    personnelPerHourCents: 1n,
    administrationPerPeriodCents: 1n,
    vehiclePerPeriodCents: 1n,
    overnightStablingPerPeriodCents: 1n,
    protectionEquipmentPerPeriodCents: 1n,
    lateInterestBasisPoints: 1,
  },
  rules: {
    qualityBaselinePunctualityBasisPoints: 8_500,
    pointsPerExtraSeat: 1,
    pointsPerPunctualityBasisPoint: 1,
    pointsPerAdditionalStop: 1,
    requirementFocusMaximumPoints: 1_000,
    contractBonusCentsPerPeriod: 1n,
    penaltyRates: {
      punctuality: 1n,
      cancellation: 1n,
      seats: 1n,
      connections: 1n,
    },
    penaltyFocusMultiplierBasisPoints: 10_000,
    publicOperationSurchargeBasisPoints: 0,
    failedPackageFeeStepBasisPoints: 0,
    failedPackageReductionStepBasisPoints: 0,
  },
  tenderProfiles: [
    {
      id: "capacity",
      weights: { price: 5_000, quality: 5_000 },
      requirementFocus: "capacity",
      penaltyFocus: "punctuality",
      viabilitySurchargeBasisPoints: 10_000,
    },
    {
      id: "accessibility",
      weights: { price: 5_000, quality: 5_000 },
      requirementFocus: "accessibility",
      penaltyFocus: "connections",
      viabilitySurchargeBasisPoints: 10_000,
    },
  ],
});

const economyLots = Array.from({ length: 8 }, (_, index) => ({
  id: lotId(index),
  size: 100 - index,
  attractiveness: 50 - index,
}));

const publicVehiclePoolByLot = Object.fromEntries(
  economyLots.map((lot) => [lot.id, ["vehicle-1"]] as const),
);

function blueprint(
  startingCapitalPolicy: AlphaWorldBlueprint["startingCapitalPolicy"] = {
    mode: "finite",
    amountCents: "0",
  },
): AlphaWorldBlueprint {
  const seed = 17n;
  const started = startEconomyWorld({
    worldId: WORLD_ID,
    seed,
    durationMonths: 6,
    release: economyRelease,
    lots: economyLots,
    authorityBudgets: [],
    accounts: [],
    publicVehiclePoolByLot,
  });
  return {
    schemaVersion: ALPHA_WORLD_BLUEPRINT_SCHEMA,
    regionId: REGION_ID,
    regionVariant: "B",
    seed,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 6,
    startingCapitalPolicy,
    entryFacilityPolicy: {
      schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA,
      mode: "award-contingent-wet-lease",
      providerOperatorId: "public",
      costBasis: "formation-operating-cost",
    },
    releases: {
      infra: "a".repeat(64),
      timetable: "b".repeat(64),
      fleet: FLEET_RELEASE_HASH,
      economy: economyRelease.checksum,
    },
    lots: economyLots.map((lot, index) => ({
      lotId: lot.id,
      contractEndsAtPeriod: 2 + index % 2,
      trainRunIds: [trainRunId(index)],
      pathReceiptIds: ["path-1"],
      vehicleIds: ["vehicle-1"],
      personnelDutyIds: ["duty-1"],
      circulationIds: [`circulation-${index + 1}`],
      operatingProgramIds: [`program-${index + 1}`],
    })),
    conflictCheckHash: "d".repeat(64),
    tenderCalendarHash: alphaHash("zugfolge-alpha-tender-calendar/v1", started.state.calendar),
  };
}

function fleetInitialization(): FleetWorldInitialization {
  return {
    schemaVersion: FLEET_INITIALIZE_SCHEMA,
    worldId: WORLD_ID,
    producedAt: 0,
    authorityRelease: {
      schemaVersion: FLEET_AUTHORITY_RELEASE_SCHEMA,
      releaseId: "world-deploy-test-fleet-v1",
      referenceYear: 2026,
      assets: [{
        id: "vehicle-1",
        numericId: 1,
        operatorId: "public",
        vehicleTypeId: 101,
        classDesignation: "ET1",
        tradeName: "Testzug",
        buildYear: 2025,
        acquisitionYear: 2026,
        procurementChannel: "leasing",
        approvedLineIds: ["S1"],
        maintenanceDeadlines: [{ kind: "inspection", dueAt: 100_000 }],
        installedProtection: ["pzb"],
        technical: {
          lengthMm: 50_000,
          massKg: 80_000,
          maximumSpeedKph: 160,
          accelerationMmPerS2: 800,
          decelerationMmPerS2: 900,
          traction: "electric",
          electricSystems: ["ac15kv"],
        },
        passenger: {
          seats: 100,
          firstClassSeats: 0,
          accessible: true,
          bicyclePlaces: 4,
          wheelchairPlaces: 2,
          equipment: ["pis"],
          operatingCostCentsPerTrainKm: 700,
          replacementPlan: true,
        },
        deliveredAt: 0,
        retiredAt: 100_000,
      }],
      personnelPools: [{
        id: "pool-1",
        numericId: 1,
        operatorId: "public",
        qualificationHash: "e".repeat(64),
        validFrom: 0,
        validUntil: 100_000,
      }],
      pathReceipts: [{
        id: "path-1",
        numericRouteId: 1,
        operatorId: "public",
        serviceLineIds: ["S1"],
        decision: "confirmed",
        validFrom: 0,
        validUntil: 100_000,
        platformLengthsMm: [120_000],
        electrifications: ["overhead-ac15kv"],
        requiredProtection: ["pzb"],
        approvedClasses: ["ET1"],
        plannerStateHash: "f".repeat(64),
        conflictCheckHash: "d".repeat(64),
      }],
    },
    formations: [{ id: "formation-1", vehicleIds: ["vehicle-1"], pathReceiptId: "path-1" }],
    personnelDuties: [{
      id: "duty-1",
      personnelPoolId: "pool-1",
      formationIds: ["formation-1"],
      pathReceiptId: "path-1",
      validFrom: 0,
      validUntil: 100_000,
    }],
    pathReservations: [{ id: "reservation-1", pathReceiptId: "path-1" }],
  };
}

function deployment(
  startingCapitalPolicy: AlphaWorldBlueprint["startingCapitalPolicy"] = {
    mode: "finite",
    amountCents: "0",
  },
): AlphaWorldDeployment {
  return {
    schema: ALPHA_WORLD_DEPLOYMENT_SCHEMA,
    worldId: WORLD_ID,
    deploymentRevision: 1,
    worldDefinition: {
      name: "Signierte Testwelt",
      kind: "public",
      rankingStatus: "ranked",
      schedulePeriodWeeks: 4,
      epoch: WORLD_EPOCH,
    },
    infraReleaseHash: "a".repeat(64),
    blueprint: blueprint(startingCapitalPolicy),
    economy: {
      durationMonths: 6,
      release: {
        schema: economyRelease.schema,
        version: economyRelease.version,
        rates: economyRelease.rates,
        rules: economyRelease.rules,
        tenderProfiles: economyRelease.tenderProfiles,
      },
      lots: economyLots,
      authorityBudgets: [],
      accounts: [],
      publicVehiclePoolByLot,
    },
    fleet: fleetInitialization(),
    regionalSimulation: {
      schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
      worldId: WORLD_ID,
      regionId: REGION_ID,
      nowMs: 0,
      repeatEveryMs: 86_400_000,
      protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
      infraRelease: {
        id: "infra-test-v1",
        directedEdges: { "edge:leipzig-halle": 35_000_000 },
        edgeGeometries: {
          "edge:leipzig-halle": [
            { edgeOffsetMm: 0, latitudeE7: 513_454_000, longitudeE7: 123_827_000, bearingMilliDegrees: 300_000 },
            { edgeOffsetMm: 35_000_000, latitudeE7: 514_780_000, longitudeE7: 119_860_000, bearingMilliDegrees: null },
          ],
        },
        routeVersions: {
          "route:leipzig-halle": {
            id: "route:leipzig-halle",
            templateId: "route-template:leipzig-halle",
            predecessorId: null,
            transitionRouteMm: null,
            legs: [{
              edgeId: "edge:leipzig-halle",
              direction: "along",
              edgeEntryMm: 0,
              edgeExitMm: 35_000_000,
              routeStartMm: 0,
              blockIds: ["block:leipzig-halle"],
              speedLimitMmps: 44_444,
              gradientPerMille: 0,
              availableProtectionSystems: ["pzb"],
              simultaneouslyRequiredProtectionSystems: [],
            }],
          },
        },
        interlockingRoutes: {
          "interlocking:leipzig-halle": {
            id: "interlocking:leipzig-halle",
            routeTemplateId: "route-template:leipzig-halle",
            signalId: "signal:leipzig-exit",
            movementKind: "train",
            pathResources: ["block:leipzig-halle"],
            overlapResources: ["overlap:leipzig-halle"],
            flankResources: ["flank:leipzig-halle"],
            switchPositions: {},
            authorityStartRouteMm: 0,
            authorityEndRouteMm: 35_000_000,
            releaseAfterTailRouteMm: 35_000_000,
          },
        },
        signals: ["signal:leipzig-exit"],
        switches: [],
        blockResources: ["block:leipzig-halle", "overlap:leipzig-halle", "flank:leipzig-halle"],
        platformIntervals: {},
        regionBoundaries: [],
        rzueLayoutId: "rzue:test",
      },
      vehicleTypes: [{
        powered: true,
        vehicleType: {
          id: "vehicle-type:test",
          lengthMm: 80_000,
          massKg: 120_000,
          maximumSpeedMmps: 44_444,
          powerWatts: 2_500_000,
          startingTractiveForceNewtons: 180_000,
          maximumAccelerationMmps2: 900,
          serviceBrakeMmps2: 900,
          emergencyBrakeMmps2: 1_300,
          protectionSystems: ["pzb"],
        },
      }],
      vehicles: economyLots.map((_lot, index) => ({
        id: `regional-vehicle:${index}`,
        typeId: "vehicle-type:test",
        powered: true,
        orientation: "along",
        condition: {
          mechanicsBasisPoints: 9_500,
          driveBasisPoints: 9_500,
          brakesBasisPoints: 9_500,
          kilometresSinceMaintenance: 0,
          operatingHoursSinceMaintenance: 0,
          openObservations: 0,
        },
        restrictions: {},
        history: [],
      })),
      formations: economyLots.map((_lot, index) => ({
        id: `regional-formation:${index}`,
        predecessorId: null,
        vehicleIds: [`regional-vehicle:${index}`],
      })),
      trains: economyLots.map((_lot, index) => ({
        id: trainRunId(index),
        trainNumber: `RE ${index + 1}`,
        operatorId: "public",
        movementKind: "train",
        routeVersionId: "route:leipzig-halle",
        formationVersionId: `regional-formation:${index}`,
        headRouteMm: 0,
        scheduledDepartureMs: 0,
        publicPassengerStop: true,
        dispatchInterlockingRouteId: "interlocking:leipzig-halle",
        protectionModeSelectionRuns: [{
          throughRouteLegIndex: 0,
          selectedProtectionSystem: "pzb",
        }],
      })),
      movementContinuations: economyLots.map((_lot, index) => ({
        id: `continuation:${trainRunId(index)}:daily`,
        predecessorTrainId: trainRunId(index),
        predecessorBaseRouteVersionId: "route:leipzig-halle",
        successorTrainId: trainRunId(index),
        successorDayOffset: 1 as const,
        dailyBoundary: true,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction" as const,
        successorFormation: "inherit-predecessor" as const,
      })),
    },
    repeatEveryS: 86_400,
    planning: {
      authority: {
        accountId: PLANNING_AUTHORITY_ACCOUNT_ID,
        keycloakSubject: `system:planning-authority:${WORLD_ID}`,
        displayName: "Aufgabentraeger Signierte Testwelt",
      },
      infrastructureRelease: {
        schemaVersion: "planning.infrastructure-release/v1",
        worldId: WORLD_ID,
        releaseId: "infra-test-v1",
        sourceId: "a".repeat(64),
        corridorId: "lhe-test",
        corridorName: "Leipzig-Halle Test",
        stations: [
          {
            numericId: 1,
            id: "leipzig",
            code: "LL",
            name: "Leipzig Hbf",
            distanceMm: 0,
            latitudeE7: 513_454_000,
            longitudeE7: 123_827_000,
            stationTrackNumericId: 101,
            stationTrackLengthMm: 400_000,
            stationMaximumSpeedKph: 80,
          },
          {
            numericId: 2,
            id: "halle",
            code: "LH",
            name: "Halle (Saale) Hbf",
            distanceMm: 35_000_000,
            latitudeE7: 514_780_000,
            longitudeE7: 119_860_000,
            stationTrackNumericId: 201,
            stationTrackLengthMm: 400_000,
            stationMaximumSpeedKph: 80,
          },
        ],
        segments: [{
          edgeNumericId: 1,
          trackNumericId: 1_001,
          id: "leipzig-halle",
          label: "Leipzig-Halle",
          fromStationId: "leipzig",
          toStationId: "halle",
          lengthMm: 35_000_000,
          maximumSpeedKph: 160,
          mainSignalPositionsMm: [10_000_000, 20_000_000],
          maximumVirtualBlockLengthMm: 10_000_000,
        }],
      },
    },
    provenance: {
      infraReleaseId: "infra-test-v1",
      operationalNetworkHash: "d".repeat(64),
      gtfsSnapshotHash: "b".repeat(64),
      fleetSourceSha256: "3".repeat(64),
      operationalSimulationSourceSha256: "5".repeat(64),
      generationScriptSha256: "4".repeat(64),
    },
  };
}

function signedDeployment(unsigned: AlphaWorldDeployment): SignedWorldDeployment {
  const deploymentHash = alphaHash(ALPHA_WORLD_DEPLOYMENT_SCHEMA, unsigned);
  return {
    deployment: encodeEconomyValue(unsigned) as Readonly<Record<string, unknown>>,
    deploymentHash,
    signature: {
      algorithm: "Ed25519",
      keyId: KEY_ID,
      valueBase64: signEd25519(null, Buffer.from(deploymentHash, "hex"), privateKey).toString("base64"),
    },
  };
}

function deploymentForWorld(
  worldId: string,
  name: string,
  planningAuthorityAccountId: string,
): AlphaWorldDeployment {
  const original = deployment();
  return {
    ...original,
    worldId,
    worldDefinition: { ...original.worldDefinition, name },
    fleet: { ...original.fleet, worldId },
    regionalSimulation: { ...original.regionalSimulation, worldId },
    planning: {
      authority: {
        ...original.planning.authority,
        accountId: planningAuthorityAccountId,
        keycloakSubject: `system:planning-authority:${worldId}`,
      },
      infrastructureRelease: {
        ...original.planning.infrastructureRelease,
        worldId,
      },
    },
  };
}

function commandFor(
  signed: SignedWorldDeployment,
  overrides: Partial<AdminCommandPayload> = {},
): AdminCommandPayload {
  const parsed = decodeEconomyValue(signed.deployment) as AlphaWorldDeployment;
  return {
    kind: "admin.world_deploy",
    worldId: WORLD_ID,
    actionType: "world_deploy",
    riskClass: "high",
    requesterReference: "odoo-admin-1",
    approverReference: "odoo-admin-2",
    reason: "Signierten Weltstart pruefen",
    effectPreview: { worldId: WORLD_ID },
    startingCapitalPolicy: parsed.blueprint.startingCapitalPolicy,
    worldDefinition: parsed.worldDefinition,
    signedDeployment: signed,
    deploymentHash: signed.deploymentHash,
    deploymentRevision: parsed.deploymentRevision ?? 1,
    ...overrides,
  };
}

function context(
  payload: AdminCommandPayload,
  markEffectApplied?: () => void,
): GameAdminCommandContext {
  return {
    adminRequestId: "71000000-0000-4000-8000-000000000001",
    effectIdempotencyKey: "71000000-0000-4000-8000-000000000001",
    commandId: "72000000-0000-4000-8000-000000000001",
    eventId: "odoo-world-deploy-test-1",
    correlationId: "odoo-world-deploy-correlation-1",
    receivedAt: new Date("2026-08-12T09:00:00.000Z"),
    now: new Date("2026-08-12T09:00:01.000Z"),
    payload,
    ...(markEffectApplied === undefined ? {} : { markEffectApplied }),
  };
}

function mobilizationSnapshot(worldId: string): FleetMobilizationSnapshot {
  return {
    schema: "zugfolge-fleet-mobilization/v1",
    worldId,
    revision: 0,
    producedAt: 0,
    formations: [{
      id: "formation-1",
      operatorId: "public",
      vehicleIds: ["vehicle-1"],
      serviceLineIds: ["S1"],
      availability: "available",
      procurement: "delivered",
      availableFrom: 0,
      availableUntil: 100_000,
      characteristics: {
        seats: 100,
        firstClassBasisPoints: 0,
        accessible: true,
        bicyclePlaces: 4,
        wheelchairPlaces: 2,
        equipment: ["pis"],
        vehicleAgeYears: 1,
        maximumSpeedKph: 160,
        operatingCostCentsPerTrainKm: 700,
        homologatedLineIds: ["S1"],
        maintenanceValidUntil: 100_000,
        traction: "electric",
        replacementPlan: true,
      },
    }],
    personnelDuties: [{
      id: "duty-1",
      operatorId: "public",
      formationIds: ["formation-1"],
      status: "ready",
      validFrom: 0,
      validUntil: 100_000,
    }],
    pathReservations: [{
      id: "reservation-1",
      operatorId: "public",
      serviceLineIds: ["S1"],
      status: "confirmed",
      validFrom: 0,
      validUntil: 100_000,
    }],
  };
}

function fleetRuntime() {
  const initializeFleet = vi.fn((input: FleetWorldInitialization) => {
    const snapshot = mobilizationSnapshot(input.worldId);
    return {
      schemaVersion: FLEET_INITIALIZED_SCHEMA,
      state: {
        schemaVersion: FLEET_STATE_SCHEMA,
        worldId: input.worldId,
        revision: 0,
        producedAt: input.producedAt,
        authorityReleaseHash: FLEET_RELEASE_HASH,
        authorityRelease: input.authorityRelease,
        formations: Object.fromEntries((input.formations ?? []).map((item) => [item.id, item])),
        personnelDuties: Object.fromEntries((input.personnelDuties ?? []).map((item) => [item.id, item])),
        pathReservations: Object.fromEntries((input.pathReservations ?? []).map((item) => [item.id, item])),
      },
      stateHash: "5".repeat(64),
      snapshot,
      snapshotHash: fleetSnapshotHash(snapshot),
    };
  });
  return {
    runtime: {
      initializeFleet,
      applyFleetCommand: () => {
        throw new Error("Der Weltstart sendet keine Fleet-Kommandos.");
      },
    } satisfies FleetRuntime,
    initializeFleet,
  };
}

function readyRegionalSimulation() {
  return {
    isReady: vi.fn(() => true),
    initialize: vi.fn(),
    restore: vi.fn(),
    apply: vi.fn(),
  } as unknown as RegionalSimulationWorker;
}

function prepareLivemap(): LivemapRegistry {
  const livemap = new LivemapRegistry({ now: () => 0, createStreamId: () => "world-deploy-stream" });
  livemap.initializeRegion(WORLD_ID, REGION_ID, {
    at: 0,
    trains: economyLots.map((_lot, index) => ({
      id: trainRunId(index),
      operator: "public",
      trainNumber: `RE ${index + 1}`,
      category: "regional",
      positionMm: 0,
      speedMmPerSecond: 0,
      delaySeconds: 0,
      nextOperatingPoint: "Leipzig Hbf",
      status: "planned",
    })),
    externalTrains: [],
    disruptions: [],
  });
  return livemap;
}

describe("Game world_deploy: signierte Weltanlage", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(async () => client.close());

  function handler(registerStartedWorld = vi.fn(), registerOperationalProgram = true, scope?: ServerWorldScope) {
    const fleet = fleetRuntime();
    let prepared: SignedAlphaWorldDeployment | undefined;
    const rollback = vi.fn(() => { prepared = undefined; });
    const prepareWorldProgram = vi.fn((signed: SignedAlphaWorldDeployment) => {
      if (registerOperationalProgram) prepared = signed;
      return { rollback };
    });
    return {
      run: createWorldDeployAdminHandler({
        db: db as IdentityDatabase,
        trustedKeys: { [KEY_ID]: PUBLIC_KEY_PEM },
        fleetRuntime: fleet.runtime,
        regionalSimulation: readyRegionalSimulation(),
        livemap: prepareLivemap(),
        operations: new OperationsRegistry(),
        operationalPrograms: {
          operationalProgramRegistration(worldId, regionId) {
            if (
              prepared?.deployment.worldId !== worldId
              || prepared.deployment.regionalSimulation.regionId !== regionId
            ) return undefined;
            return {
              deploymentHash: prepared.deploymentHash,
              initializationHash: operationalSimulationInitializationHash(
                prepared.deployment.regionalSimulation,
              ),
              trainRunIds: prepared.deployment.regionalSimulation.trains.map(({ id }) => id),
            };
          },
        },
        prepareWorldProgram,
        ...(scope === undefined ? {} : { validateSignedDeployment: (signed: SignedAlphaWorldDeployment) => assertServerWorldDeployment(scope, signed.deployment) }),
        registerStartedWorld,
      }),
      fleet,
      prepareWorldProgram,
      rollback,
      registerStartedWorld,
    };
  }

  it("weist ein gueltig signiertes Tutorial-Hauptdeployment vor jeder DB- oder Runtimewirkung ab", async () => {
    const base = deployment();
    const signed = signedDeployment({ ...base,
      worldDefinition: { ...base.worldDefinition, kind: "tutorial", rankingStatus: "unranked" },
      blueprint: { ...base.blueprint, profileKind: "tutorial", accelerationFactor: 60, entryFacilityPolicy: { schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA, mode: "disabled" } },
    });
    const scope = serverWorldScope(WORLD_ID, "https://elbe.zugfolge.test");
    const { run, prepareWorldProgram, registerStartedWorld } = handler(vi.fn(), true, scope);
    expect(parseSignedAlphaWorldDeployment(signed, { [KEY_ID]: PUBLIC_KEY_PEM }).deployment.blueprint.profileKind).toBe("tutorial");
    await expect(run(context(commandFor(signed)))).rejects.toThrow("Serverhauptweltbindung");
    expect(await db.select().from(worlds)).toHaveLength(0);
    expect(await db.select().from(alphaWorldProfiles)).toHaveLength(0);
    expect(await db.select().from(alphaWorldDeployments)).toHaveLength(0);
    expect(prepareWorldProgram).not.toHaveBeenCalled();
    expect(registerStartedWorld).not.toHaveBeenCalled();
  });

  it("nimmt eine live gestartete Welt und den globalen Scope sofort in den Odoo-Dispatch auf", () => {
    expect(worldIdsForOdooProjectionDispatch([])).toEqual([
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(worldIdsForOdooProjectionDispatch([WORLD_ID, WORLD_ID])).toEqual([
      "00000000-0000-0000-0000-000000000000",
      WORLD_ID,
    ]);
    const rejectedPreWorldTarget = "70000000-0000-4000-8000-000000000002";
    expect(worldIdsForOdooProjectionDispatch([WORLD_ID], [rejectedPreWorldTarget])).toEqual([
      "00000000-0000-0000-0000-000000000000",
      WORLD_ID,
      rejectedPreWorldTarget,
    ]);
  });

  it("markiert die persistierte Weltwirkung vor dem nachgelagerten Runtime-Callback", async () => {
    const markEffectApplied = vi.fn();
    const registerStartedWorld = vi.fn(async () => {
      expect(markEffectApplied).toHaveBeenCalledTimes(1);
      throw new Error("simulierter Runtime-Callbackfehler");
    });
    const { run } = handler(registerStartedWorld);

    await expect(run(context(
      commandFor(signedDeployment(deployment())),
      markEffectApplied,
    ))).rejects.toThrow(/Runtime-Callbackfehler/);

    expect(markEffectApplied).toHaveBeenCalledTimes(1);
    expect(markEffectApplied.mock.invocationCallOrder[0])
      .toBeLessThan(registerStartedWorld.mock.invocationCallOrder[0]!);
    expect(await db.select({ lifecycleStatus: worlds.lifecycleStatus }).from(worlds))
      .toEqual([{ lifecycleStatus: "active" }]);
    expect(await db.select({ state: alphaWorldProfiles.state }).from(alphaWorldProfiles))
      .toEqual([{ state: "running" }]);
  });

  it("startet trotz leerem oder sichtbarem Livemap-Zustand nie ohne registriertes Schedulerprogramm", async () => {
    const registerStartedWorld = vi.fn();
    const { run, rollback } = handler(registerStartedWorld, false);

    await expect(run(context(commandFor(signedDeployment(deployment()))))).rejects.toMatchObject({
      code: "world_start_projection_incomplete",
    });

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(registerStartedWorld).not.toHaveBeenCalled();
    expect(await db.select({ lifecycleStatus: worlds.lifecycleStatus }).from(worlds))
      .toEqual([{ lifecycleStatus: "provisioning" }]);
    expect(await db.select({ state: alphaWorldProfiles.state }).from(alphaWorldProfiles))
      .toEqual([{ state: "draft" }]);
  });

  it("legt Live-Capabilities als atomaren idempotenten Outbox-Satz an", async () => {
    await db.insert(worlds).values({
      id: WORLD_ID,
      name: "Capability-Testwelt",
      schedulePeriodWeeks: 4,
      epoch: new Date(WORLD_EPOCH),
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
    const capabilities = [
      { actionType: "world_close" as const, availability: "available" as const, detail: "Weltabschluss ist aktiv." },
      { actionType: "world_access_revoke" as const, availability: "available" as const, detail: "Weltzugang kann entzogen werden." },
    ];
    const input = {
      worldId: WORLD_ID,
      deploymentHash: "9".repeat(64),
      capabilities,
      occurredAt: new Date("2026-08-12T09:00:01.000Z"),
    };

    await enqueueStartedWorldCapabilities(db, input);
    await enqueueStartedWorldCapabilities(db, input);

    expect(await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, WORLD_ID))).toEqual([
      expect.objectContaining({ messageType: "admin.capability.projection", payload: capabilities[0] }),
      expect.objectContaining({ messageType: "admin.capability.projection", payload: capabilities[1] }),
    ]);
  });

  it.each([
    {
      name: "fremde Startkapital-Policy",
      mutate: (signed: SignedWorldDeployment) => commandFor(signed, {
        startingCapitalPolicy: { mode: "unlimited" },
      }),
    },
    {
      name: "fremde Weltdefinition",
      mutate: (signed: SignedWorldDeployment) => commandFor(signed, {
        worldDefinition: {
          name: "Nicht signierter Name",
          kind: "public",
          rankingStatus: "ranked",
          schedulePeriodWeeks: 4,
          epoch: WORLD_EPOCH,
        },
      }),
    },
    {
      name: "fremder Odoo-Deployment-Hash",
      mutate: (signed: SignedWorldDeployment) => commandFor(signed, {
        deploymentHash: "6".repeat(64),
      }),
    },
    {
      name: "manipulierter eingebetteter Deployment-Hash",
      mutate: (signed: SignedWorldDeployment) => commandFor({
        ...signed,
        deploymentHash: "6".repeat(64),
      }),
    },
    {
      name: "ungueltige Ed25519-Signatur",
      mutate: (signed: SignedWorldDeployment) => commandFor({
        ...signed,
        signature: { ...signed.signature, valueBase64: Buffer.alloc(64).toString("base64") },
      }),
    },
  ])("weist $name vor jeder Weltmutation zurueck", async ({ mutate }) => {
    const signed = signedDeployment(deployment());
    const { run, fleet, registerStartedWorld } = handler();

    await expect(run(context(mutate(signed)))).rejects.toThrow();

    expect(await db.select().from(worlds)).toHaveLength(0);
    expect(await db.select().from(alphaWorldProfiles)).toHaveLength(0);
    expect(fleet.initializeFleet).not.toHaveBeenCalled();
    expect(registerStartedWorld).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "Infra-Release",
      mutate: (unsigned: AlphaWorldDeployment): AlphaWorldDeployment => ({
        ...unsigned,
        infraReleaseHash: "6".repeat(64),
      }),
    },
    {
      name: "Konfliktnetz",
      mutate: (unsigned: AlphaWorldDeployment): AlphaWorldDeployment => ({
        ...unsigned,
        provenance: { ...unsigned.provenance, operationalNetworkHash: "6".repeat(64) },
      }),
    },
    {
      name: "GTFS-Snapshot",
      mutate: (unsigned: AlphaWorldDeployment): AlphaWorldDeployment => ({
        ...unsigned,
        provenance: { ...unsigned.provenance, gtfsSnapshotHash: "6".repeat(64) },
      }),
    },
  ])("weist ein korrekt signiertes Deployment mit widerspruechlicher $name-Bindung vor jeder Weltmutation zurueck", async ({ mutate }) => {
    const signed = signedDeployment(mutate(deployment()));
    const { run, fleet, registerStartedWorld } = handler();

    await expect(run(context(commandFor(signed)))).rejects.toThrow(/Hashbindungen|InfraRelease-Hash/);

    expect(await db.select().from(worlds)).toHaveLength(0);
    expect(await db.select().from(alphaWorldProfiles)).toHaveLength(0);
    expect(fleet.initializeFleet).not.toHaveBeenCalled();
    expect(registerStartedWorld).not.toHaveBeenCalled();
  });

  it("registriert auch korrekt signierte Authority-v2 niemals ohne Compiler-Binding", async () => {
    const unsigned = deployment();
    const authorityV2WithoutBinding = {
      ...unsigned,
      fleet: {
        ...unsigned.fleet,
        authorityRelease: {
          ...unsigned.fleet.authorityRelease,
          schemaVersion: "zugfolge-fleet-authority-release/v2",
        },
      },
    } as unknown as AlphaWorldDeployment;
    const { run, fleet, registerStartedWorld } = handler();

    await expect(run(context(commandFor(signedDeployment(authorityV2WithoutBinding)))))
      .rejects.toThrow(/Compilerbeweis/);
    expect(await db.select().from(worlds)).toHaveLength(0);
    expect(fleet.initializeFleet).not.toHaveBeenCalled();
    expect(registerStartedWorld).not.toHaveBeenCalled();
  });

  it("erzeugt und startet eine vollstaendig gebundene Welt und wiederholt exakt idempotent", async () => {
    const unsigned = deployment();
    const signed = signedDeployment(unsigned);
    const { run, fleet, registerStartedWorld } = handler();

    const first = await run(context(commandFor(signed)));
    const fleetCallsAfterFirst = fleet.initializeFleet.mock.calls.length;
    const second = await run(context(commandFor(signed)));

    const [world] = await db.select().from(worlds).where(eq(worlds.id, WORLD_ID));
    const [profile] = await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD_ID));
    const projections = await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, WORLD_ID));
    expect(world).toMatchObject({
      name: unsigned.worldDefinition.name,
      schedulePeriodWeeks: 4,
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
    expect(world?.epoch.toISOString()).toBe(WORLD_EPOCH);
    expect(profile).toMatchObject({
      profileKind: "public",
      state: "running",
      deploymentHash: signed.deploymentHash,
    });
    expect(decodeEconomyValue(profile?.blueprint)).toMatchObject({
      startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    });
    expect(first).toMatchObject({
      state: "completed",
      gameAuditEventId: `world-deploy:${WORLD_ID}:${signed.deploymentHash}`,
      result: {
        deploymentHash: signed.deploymentHash,
        startingCapitalPolicy: { mode: "finite", amountCents: "0" },
      },
    });
    expect(second).toEqual(first);
    const worldProjections = projections.filter((item) => item.messageType === "world.projection");
    expect(worldProjections).toHaveLength(1);
    expect(worldProjections[0]).toMatchObject({
      worldId: signed.deployment.worldId,
      correlationId: `alpha-world-start:${signed.deployment.worldId}:${signed.deploymentHash}`,
      payload: {
        projectionKind: "zugfolge-authoritative-world-start-projection/v1",
        authoritative: true,
        deploymentHash: signed.deploymentHash,
        deploymentRevision: 1,
        deploymentAuthorization: {
          schemaVersion: "zugfolge-authoritative-world-start-projection/v1",
          deploymentHash: signed.deploymentHash,
          deploymentRevision: 1,
          algorithm: "Ed25519",
          keyId: signed.signature.keyId,
          valueBase64: signed.signature.valueBase64,
        },
      },
    });
    expect(await db.select().from(worlds)).toHaveLength(1);
    expect(await db.select().from(alphaWorldProfiles)).toHaveLength(1);
    expect(fleetCallsAfterFirst).toBeGreaterThan(0);
    expect(fleet.initializeFleet.mock.calls.length).toBeGreaterThan(fleetCallsAfterFirst);
    expect(registerStartedWorld).toHaveBeenCalledTimes(2);
    expect(registerStartedWorld).toHaveBeenLastCalledWith(expect.objectContaining({
      epoch: new Date(WORLD_EPOCH),
      signed: expect.objectContaining({ deploymentHash: signed.deploymentHash }),
    }));
    expect(await db.select().from(alphaWorldDeployments)).toEqual([
      expect.objectContaining({
        worldId: WORLD_ID,
        deploymentHash: signed.deploymentHash,
        planningAuthorityAccountId: PLANNING_AUTHORITY_ACCOUNT_ID,
      }),
    ]);
    const coldStart = await loadPersistedActiveAlphaWorldDeployments(db, { [KEY_ID]: PUBLIC_KEY_PEM });
    expect(coldStart).toEqual([
      expect.objectContaining({
        epoch: new Date(WORLD_EPOCH),
        signed: expect.objectContaining({ deploymentHash: signed.deploymentHash }),
      }),
    ]);
    await expect(assertActivePublicWorldDeploymentCoverage(db, { [KEY_ID]: PUBLIC_KEY_PEM }))
      .resolves.toEqual([WORLD_ID]);

    const tutorialWorldId = "70000000-0000-4000-8000-000000000003";
    const tutorialBlueprint = {
      ...(decodeEconomyValue(profile!.blueprint) as AlphaWorldBlueprint),
      profileKind: "tutorial" as const,
      accelerationFactor: 60,
      entryFacilityPolicy: {
        schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA,
        mode: "disabled" as const,
      },
    };
    await db.insert(worlds).values({
      id: tutorialWorldId,
      name: "Kurzlebige Tutorialwelt",
      schedulePeriodWeeks: 4,
      epoch: new Date(WORLD_EPOCH),
      worldKind: "private",
      rankingStatus: "unranked",
      lifecycleStatus: "active",
    });
    await db.insert(alphaWorldProfiles).values({
      ...profile!,
      worldId: tutorialWorldId,
      profileKind: "tutorial",
      worldSeed: 19n,
      accelerationFactor: 60,
      blueprint: encodeEconomyValue(tutorialBlueprint),
      blueprintHash: validateWorldBlueprint(tutorialBlueprint),
      deploymentHash: null,
    });
    await expect(assertActivePublicWorldDeploymentCoverage(db, { [KEY_ID]: PUBLIC_KEY_PEM }))
      .resolves.toEqual([WORLD_ID]);
  });

  it("stoppt den Neustart bei einer zusaetzlichen aktiven Public-Welt ohne verifiziertes Deployment", async () => {
    const signed = signedDeployment(deployment());
    const { run } = handler();
    await run(context(commandFor(signed)));
    const [profile] = await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD_ID));
    const orphanWorldId = "70000000-0000-4000-8000-000000000002";
    await db.insert(worlds).values({
      id: orphanWorldId,
      name: "Verwaiste Public-Welt",
      schedulePeriodWeeks: 4,
      epoch: new Date(WORLD_EPOCH),
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
    await db.insert(alphaWorldProfiles).values({
      ...profile!,
      worldId: orphanWorldId,
      worldSeed: 18n,
      deploymentHash: "8".repeat(64),
    });

    await expect(assertActivePublicWorldDeploymentCoverage(db, { [KEY_ID]: PUBLIC_KEY_PEM }))
      .rejects.toThrow(new RegExp(`ohne Deployment: ${orphanWorldId}`));
  });

  it("laesst im Mehrwelt-Restart einen exakt gebundenen Archivpfad aus, ohne die aktive Welt zu blockieren", async () => {
    const archivedWorldId = "70000000-0000-4000-8000-000000000011";
    const activeWorldId = "70000000-0000-4000-8000-000000000012";
    const archivedAuthorityAccountId = "70000000-0000-4000-8000-000000000091";
    const activeAuthorityAccountId = "70000000-0000-4000-8000-000000000092";
    const trustedKeys = { [KEY_ID]: PUBLIC_KEY_PEM };
    const archivedUnsigned = deploymentForWorld(
      archivedWorldId,
      "Archivierte Testwelt",
      archivedAuthorityAccountId,
    );
    const activeUnsigned = deploymentForWorld(
      activeWorldId,
      "Weiterlaufende Testwelt",
      activeAuthorityAccountId,
    );
    const archivedSigned = parseSignedAlphaWorldDeployment(signedDeployment(archivedUnsigned), trustedKeys);
    const activeSigned = parseSignedAlphaWorldDeployment(signedDeployment(activeUnsigned), trustedKeys);

    for (const [signed, lifecycleStatus] of [
      [archivedSigned, "archived"],
      [activeSigned, "active"],
    ] as const) {
      const definition = signed.deployment.worldDefinition;
      await db.insert(worlds).values({
        id: signed.deployment.worldId,
        name: definition.name,
        schedulePeriodWeeks: definition.schedulePeriodWeeks,
        epoch: new Date(definition.epoch),
        worldKind: definition.kind === "public" ? "public" : "private",
        rankingStatus: definition.rankingStatus,
        lifecycleStatus: "active",
      });
      await db.insert(accounts).values({
        id: signed.deployment.planning.authority.accountId,
        worldId: signed.deployment.worldId,
        keycloakSubject: signed.deployment.planning.authority.keycloakSubject,
        displayName: signed.deployment.planning.authority.displayName,
      });
      await db.insert(alphaWorldDeployments).values({
        worldId: signed.deployment.worldId,
        deploymentHash: signed.deploymentHash,
        planningAuthorityAccountId: signed.deployment.planning.authority.accountId,
        signedDeployment: serializeSignedAlphaWorldDeployment(signed),
      });
      if (lifecycleStatus === "archived") {
        await db.update(worlds).set({ lifecycleStatus }).where(eq(worlds.id, signed.deployment.worldId));
      }
    }

    const first = await resolveAlphaWorldStartupDeployments(
      db,
      trustedKeys,
      [archivedSigned, activeSigned],
    );
    expect(first.archivedWorldIds).toEqual([archivedWorldId]);
    expect(first.persistedActiveDeployments.map(({ signed }) => signed.deployment.worldId))
      .toEqual([activeWorldId]);
    expect([...first.signedDeployments.keys()]).toEqual([activeWorldId]);

    const retry = await resolveAlphaWorldStartupDeployments(
      db,
      trustedKeys,
      [archivedSigned, activeSigned],
    );
    expect([...retry.signedDeployments.keys()]).toEqual([activeWorldId]);

    const foreignArchivedHead = parseSignedAlphaWorldDeployment(signedDeployment({
      ...archivedUnsigned,
      deploymentRevision: 2,
    }), trustedKeys);
    await expect(resolveAlphaWorldStartupDeployments(
      db,
      trustedKeys,
      [foreignArchivedHead, activeSigned],
    )).rejects.toThrow(/archivierte Welt .* widerspricht dem autoritativen Deploymentkopf/u);

    const foreignActiveHead = parseSignedAlphaWorldDeployment(signedDeployment({
      ...activeUnsigned,
      deploymentRevision: 2,
    }), trustedKeys);
    await expect(resolveAlphaWorldStartupDeployments(
      db,
      trustedKeys,
      [archivedSigned, foreignActiveHead],
    )).rejects.toThrow(/widerspricht dem autoritativ persistierten Deployment/u);
  });

  it("haelt eine fehlgeschlagene Welt bis zum erfolgreichen Retry unsichtbar in Provisionierung", async () => {
    const signed = signedDeployment(deployment());
    const { run, fleet } = handler();
    fleet.initializeFleet.mockImplementationOnce(() => {
      throw new Error("simulierter Fleet-Startfehler");
    });

    await expect(run(context(commandFor(signed)))).rejects.toThrow(/Fleet-Startfehler/);
    const [failedWorld] = await db.select().from(worlds).where(eq(worlds.id, WORLD_ID));
    expect(failedWorld?.lifecycleStatus).toBe("provisioning");
    expect((await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD_ID)))[0]?.state).toBe("draft");

    await expect(run(context(commandFor(signed)))).resolves.toMatchObject({ state: "completed" });
    const [activeWorld] = await db.select().from(worlds).where(eq(worlds.id, WORLD_ID));
    expect(activeWorld?.lifecycleStatus).toBe("active");
    expect((await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD_ID)))[0]?.state).toBe("running");
  });

  it("lehnt ein selbstkonsistent manipuliertes Profil bereits an der DB-Grenze ab", async () => {
    const signed = signedDeployment(deployment());
    const { run } = handler();
    await run(context(commandFor(signed)));
    await expect(loadSignedRunningWorldDeployment(db, WORLD_ID, { [KEY_ID]: PUBLIC_KEY_PEM }))
      .resolves.toMatchObject({ deploymentHash: signed.deploymentHash });

    const tampered = blueprint({ mode: "unlimited" });
    await expect(db.update(alphaWorldProfiles).set({
      blueprint: encodeEconomyValue(tampered),
      blueprintHash: validateWorldBlueprint(tampered),
    }).where(eq(alphaWorldProfiles.worldId, WORLD_ID))).rejects.toThrow();

    await expect(loadSignedRunningWorldDeployment(db, WORLD_ID, { [KEY_ID]: PUBLIC_KEY_PEM }))
      .resolves.toMatchObject({ deploymentHash: signed.deploymentHash });
  });

  it("laesst eine bestehende abweichende Welt unveraendert", async () => {
    await db.insert(worlds).values({
      id: WORLD_ID,
      name: "Bereits vorhandene andere Welt",
      schedulePeriodWeeks: 3,
      epoch: new Date(WORLD_EPOCH),
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
    const { run, fleet } = handler();

    await expect(run(context(commandFor(signedDeployment(deployment())))))
      .rejects.toEqual(expect.objectContaining<Partial<WorldDeploymentAdminError>>({ code: "world_conflict" }));

    const [world] = await db.select().from(worlds).where(eq(worlds.id, WORLD_ID));
    expect(world).toMatchObject({ name: "Bereits vorhandene andere Welt", schedulePeriodWeeks: 3 });
    expect(await db.select().from(alphaWorldProfiles)).toHaveLength(0);
    expect(fleet.initializeFleet).not.toHaveBeenCalled();
  });

  it("weist ein anders signiertes Deployment gegen die laufende Welt fail-closed zurueck", async () => {
    const original = signedDeployment(deployment());
    const { run, fleet } = handler();
    await run(context(commandFor(original)));
    const fleetCallsAfterStart = fleet.initializeFleet.mock.calls.length;

    const divergent = signedDeployment(deployment({ mode: "unlimited" }));
    await expect(run(context(commandFor(divergent))))
      .rejects.toEqual(expect.objectContaining<Partial<WorldDeploymentAdminError>>({ code: "projection_conflict" }));

    const [profile] = await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD_ID));
    expect(profile?.deploymentHash).toBe(original.deploymentHash);
    expect(decodeEconomyValue(profile?.blueprint)).toMatchObject({
      startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    });
    expect(fleet.initializeFleet).toHaveBeenCalledTimes(fleetCallsAfterStart);
  });
});
