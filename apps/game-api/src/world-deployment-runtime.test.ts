import { PGlite } from "@electric-sql/pglite";
import { alphaWorldProfiles, MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import {
  OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE,
  OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV,
  OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  loadOperationalSimulationRuntime,
  operationalMovementContinuationsEvidence,
  operationalProtectionModeSelectionEvidence,
  type OperationalInitializationValidationReceipt,
  type OperationalSimulationInitialization,
} from "@zugfolge/runtime-native";
import { describe, expect, it, vi } from "vitest";

import {
  loadActiveAlphaWorldProjectionProfiles,
  type SignedAlphaWorldDeployment,
} from "./alpha-world-start.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";
import { ManualDisruptionCommandCatalog } from "./manual-disruption-catalog.js";
import { TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR } from "./tutorial-operational-infrastructure.js";
import {
  ActiveWorldDeploymentRuntime,
  type ActiveWorldRuntimeSeed,
} from "./world-deployment-runtime.js";

const WORLD_ID = "70000000-0000-4000-8000-000000000001";
const AUTHORITY_ID = "70000000-0000-4000-8000-000000000099";
const EPOCH = new Date("2026-12-13T00:00:00.000Z");
const ROUTE_VERSION_ID = "tutorial-minimal-2026.1:route:v1";
const INTERLOCKING_ROUTE_ID = "tutorial-minimal-2026.1:interlocking:v1";
const NATIVE_RECURRING_INFRASTRUCTURE_ROOT = fileURLToPath(new URL(
  "../tutorial-infrastructure/native-recurring-v1/",
  import.meta.url,
));
const NATIVE_RECURRING_ROUTE_A = "native-recurring-v1:route:a";
const NATIVE_RECURRING_ROUTE_B = "native-recurring-v1:route:b";
const NATIVE_RECURRING_INTERLOCKING_A = "native-recurring-v1:interlocking:a";
const NATIVE_RECURRING_INTERLOCKING_B = "native-recurring-v1:interlocking:b";
const NATIVE_RECURRING_INFRASTRUCTURE_BINDING = Object.freeze({
  schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
  infraReleaseId: "native-recurring-v1:operational-infra",
  file: "operational-infrastructure-v2.json",
  bytes: 4_235,
  sha256: "90cdb0efb4723ff70901a572f071b48a30f699995f026f1d4f92d949cafa80fa",
  stateHash: "fc5007da6d9350768c84637d43a7d31f52848ea85e8f6d57db3738e4d4b4cd17",
}) satisfies OperationalSimulationInitialization["infraRelease"];
const nativeAvailable = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined;

function nativeProgramReceipt(
  initialization: OperationalSimulationInitialization,
): OperationalInitializationValidationReceipt {
  const protectionEvidence = operationalProtectionModeSelectionEvidence(initialization);
  const continuationEvidence = operationalMovementContinuationsEvidence(initialization);
  return Object.freeze({
    schemaVersion: OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA,
    worldId: initialization.worldId,
    regionId: initialization.regionId,
    initializationHash: operationalSimulationInitializationHash(initialization),
    stateHash: "8".repeat(64),
    infraRelease: structuredClone(initialization.infraRelease),
    programTrainCount: initialization.trains.length,
    validatedProgramTemplateCount: initialization.trains.length,
    validatedRouteVersionCount: new Set(
      initialization.trains.map((train) => train.routeVersionId),
    ).size,
    validatedDispatchInterlockingRouteCount: new Set(
      initialization.trains.map((train) => train.dispatchInterlockingRouteId),
    ).size,
    validatedResourceBindingCount: initialization.trains.length * 3,
    validatedFormationBindingCount: new Set(
      initialization.trains.map((train) => train.formationVersionId),
    ).size,
    validatedTrainNumberCount: initialization.trains.length,
    validatedMovementContinuationCount: continuationEvidence.count,
    movementContinuationsSha256: continuationEvidence.sha256,
    protectionModeSelectionPolicy: initialization.protectionModeSelectionPolicy,
    validatedProtectionModeSelectionCount: protectionEvidence.count,
    protectionModeSelectionsSha256: protectionEvidence.sha256,
    protectionModeSelectionsValidated: true,
    dynamicTrainCount: 0,
    resourceBindingsValidated: true,
    formationBindingsValidated: true,
    trainNumbersValidated: true,
    validationMode: OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE,
  });
}

function deploymentRuntime(
  seed: Omit<ActiveWorldRuntimeSeed, "operationalProgramPreflight"> = { activeWorlds: [] },
  operationalProgramPreflight: ActiveWorldRuntimeSeed["operationalProgramPreflight"] = nativeProgramReceipt,
): ActiveWorldDeploymentRuntime {
  return new ActiveWorldDeploymentRuntime({ ...seed, operationalProgramPreflight });
}

function expectUnregistered(runtime: ActiveWorldDeploymentRuntime): void {
  expect(runtime.worldIds()).toEqual([]);
  expect(runtime.realtimeWorldIds()).toEqual([]);
  expect(runtime.realtimeRegions()).toEqual([]);
  expect(runtime.worldEpochs.size).toBe(0);
  expect(runtime.fleetAuthorityReleases[WORLD_ID]).toBeUndefined();
  expect(runtime.planningAuthorityAccountIds[WORLD_ID]).toBeUndefined();
  expect(runtime.planningInfrastructureReleases.get(WORLD_ID, "infra-test-v1")).toBeUndefined();
}

function signed(): SignedAlphaWorldDeployment {
  return {
    deploymentHash: "9".repeat(64),
    signature: { algorithm: "Ed25519", keyId: "test", valueBase64: "signature" },
    deployment: {
      worldId: WORLD_ID,
      worldDefinition: {
        name: "Runtime-Testwelt",
        kind: "public",
        rankingStatus: "ranked",
        schedulePeriodWeeks: 4,
        epoch: EPOCH.toISOString(),
      },
      fleet: {
        producedAt: 0,
        authorityRelease: {
          schemaVersion: "zugfolge-fleet-authority-release/v1",
          releaseId: "fleet-test",
        },
      },
      planning: {
        authority: {
          accountId: AUTHORITY_ID,
          keycloakSubject: `system:planning-authority:${WORLD_ID}`,
          displayName: "Aufgabentraeger Runtime-Testwelt",
        },
        infrastructureRelease: {
          schemaVersion: "planning.infrastructure-release/v1",
          worldId: WORLD_ID,
          releaseId: "infra-test-v1",
          sourceId: "a".repeat(64),
          corridorId: "lhe",
          corridorName: "Leipzig-Halle",
          stations: [
            { numericId: 1, id: "leipzig", code: "LL", name: "Leipzig", distanceMm: 0, latitudeE7: 513_454_000, longitudeE7: 123_827_000, stationTrackNumericId: 101, stationTrackLengthMm: 400_000, stationMaximumSpeedKph: 80 },
            { numericId: 2, id: "halle", code: "LH", name: "Halle", distanceMm: 35_000_000, latitudeE7: 514_780_000, longitudeE7: 119_860_000, stationTrackNumericId: 201, stationTrackLengthMm: 400_000, stationMaximumSpeedKph: 80 },
          ],
          segments: [{ edgeNumericId: 1, trackNumericId: 1_001, id: "leipzig-halle", label: "Leipzig-Halle", fromStationId: "leipzig", toStationId: "halle", lengthMm: 35_000_000, maximumSpeedKph: 160, mainSignalPositionsMm: [], maximumVirtualBlockLengthMm: 10_000_000 }],
        },
      },
      regionalSimulation: {
        schemaVersion: "zugfolge-operational-simulation-initialize/v2",
        worldId: WORLD_ID,
        regionId: "mitteldeutschland-b",
        nowMs: 0,
        repeatEveryMs: 86_400_000,
        protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
        infraRelease: TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR.binding,
        vehicleTypes: [{
          vehicleType: {
            id: "vehicle-type:1",
            lengthMm: 74_000,
            massKg: 118_000,
            maximumSpeedMmps: 38_888,
            powerWatts: 2_400_000,
            startingTractiveForceNewtons: 160_000,
            maximumAccelerationMmps2: 850,
            serviceBrakeMmps2: 900,
            emergencyBrakeMmps2: 1_300,
            protectionSystems: ["pzb"],
          },
          powered: true,
        }],
        vehicles: [{
          id: "vehicle:1",
          typeId: "vehicle-type:1",
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
        }],
        formations: [{
          id: "formation:1",
          predecessorId: null,
          vehicleIds: ["vehicle:1"],
        }],
        trains: [{
          id: "run-1",
          trainNumber: "RE 1",
          operatorId: "public",
          movementKind: "train",
          routeVersionId: ROUTE_VERSION_ID,
          formationVersionId: "formation:1",
          headRouteMm: 0,
          scheduledDepartureMs: 0,
          publicPassengerStop: true,
          dispatchInterlockingRouteId: INTERLOCKING_ROUTE_ID,
          protectionModeSelectionRuns: [{
            throughRouteLegIndex: 2,
            selectedProtectionSystem: "pzb",
          }],
        }],
        movementContinuations: [{
          id: "continuation:run-1:daily",
          predecessorTrainId: "run-1",
          predecessorBaseRouteVersionId: "route:base",
          successorTrainId: "run-1",
          successorDayOffset: 1,
          dailyBoundary: true,
          minimumDwellMs: 300_000,
          continuity: "reverse-direction",
          successorFormation: "inherit-predecessor",
        }],
      },
      repeatEveryS: 86_400,
    },
  } as unknown as SignedAlphaWorldDeployment;
}

function nativeRecurringSigned(): SignedAlphaWorldDeployment {
  const deployment = signed();
  const train = deployment.deployment.regionalSimulation.trains[0]!;
  return {
    ...deployment,
    deployment: {
      ...deployment.deployment,
      regionalSimulation: {
        ...deployment.deployment.regionalSimulation,
        infraRelease: NATIVE_RECURRING_INFRASTRUCTURE_BINDING,
        trains: [
          {
            ...train,
            id: "run-outbound",
            trainNumber: "RE 1",
            routeVersionId: NATIVE_RECURRING_ROUTE_A,
            headRouteMm: 74_000,
            scheduledDepartureMs: 0,
            dispatchInterlockingRouteId: NATIVE_RECURRING_INTERLOCKING_A,
            protectionModeSelectionRuns: [{
              throughRouteLegIndex: 1,
              selectedProtectionSystem: "pzb",
            }],
          },
          {
            ...train,
            id: "run-return",
            trainNumber: "RE 2",
            routeVersionId: NATIVE_RECURRING_ROUTE_B,
            headRouteMm: 74_000,
            scheduledDepartureMs: 43_200_000,
            dispatchInterlockingRouteId: NATIVE_RECURRING_INTERLOCKING_B,
            protectionModeSelectionRuns: [{
              throughRouteLegIndex: 1,
              selectedProtectionSystem: "pzb",
            }],
          },
        ],
        movementContinuations: [
          {
            id: "continuation:outbound-return",
            predecessorTrainId: "run-outbound",
            predecessorBaseRouteVersionId: NATIVE_RECURRING_ROUTE_A,
            successorTrainId: "run-return",
            successorDayOffset: 0,
            dailyBoundary: false,
            minimumDwellMs: 300_000,
            continuity: "reverse-direction",
            successorFormation: "inherit-predecessor",
          },
          {
            id: "continuation:return-outbound",
            predecessorTrainId: "run-return",
            predecessorBaseRouteVersionId: NATIVE_RECURRING_ROUTE_B,
            successorTrainId: "run-outbound",
            successorDayOffset: 1,
            dailyBoundary: true,
            minimumDwellMs: 300_000,
            continuity: "reverse-direction",
            successorFormation: "inherit-predecessor",
          },
        ],
      },
    },
  };
}

describe("aktive World-Deployment-Runtime", () => {
  it("bewahrt materialize vor Fortsetzung und dispatch auch im manuellen Schedulerkatalog", () => {
    const base = deploymentRuntime();
    base.register(signed(), EPOCH);
    const forbidden = () => { throw new Error("Lesender Katalog darf keinen Betriebs- oder DB-Aufruf ausloesen."); };
    const catalog = new ManualDisruptionCommandCatalog({ base, db: new Proxy({}, { get: forbidden }) as never,
      runtime: { restore: forbidden, apply: forbidden }, regions: () => base.realtimeRegions() });
    expect(base.at(WORLD_ID, "mitteldeutschland-b", 0).map(({ command }) => command.type)).toEqual([
      "materialize", "queue-movement-continuation", "dispatch",
    ]);
    expect(catalog.at(WORLD_ID, "mitteldeutschland-b", 0)).toEqual(base.at(WORLD_ID, "mitteldeutschland-b", 0));
    expect([...catalog.dueBoundaries(WORLD_ID, "mitteldeutschland-b", 0, 86_400_000)])
      .toEqual([...base.dueBoundaries(WORLD_ID, "mitteldeutschland-b", 0, 86_400_000)]);
  });

  it("registriert ein Live-Deployment sofort in Fleet, Planning und Scheduler-Welten", () => {
    const runtime = deploymentRuntime();

    runtime.register(signed(), EPOCH);
    expect(() => runtime.assertVehicleCatalogDeploymentBindings(new Map())).not.toThrow();

    expect(runtime.worldIds()).toEqual([WORLD_ID]);
    expect(runtime.worldEpochs.get(WORLD_ID)).toEqual(EPOCH);
    expect(runtime.realtimeRegions()).toEqual([
      {
        worldId: WORLD_ID,
        regionId: "mitteldeutschland-b",
        initializationHash: operationalSimulationInitializationHash(
          signed().deployment.regionalSimulation,
        ),
      },
    ]);
    expect(runtime.realtimeWorldIds()).toEqual([WORLD_ID]);
    expect(runtime.isRealtimeWorld(WORLD_ID)).toBe(true);
    expect(runtime.expectsLivemapFreshness(WORLD_ID, EPOCH.getTime() - 1)).toBe(false);
    expect(runtime.expectsLivemapFreshness(WORLD_ID, EPOCH.getTime())).toBe(true);
    expect(runtime.fleetAuthorityReleases[WORLD_ID]).toMatchObject({ releaseId: "fleet-test" });
    expect(runtime.planningAuthorityAccountIds[WORLD_ID]).toBe(AUTHORITY_ID);
    expect(runtime.planningInfrastructureReleases.get(WORLD_ID, "infra-test-v1")).toMatchObject({
      worldId: WORLD_ID,
      releaseId: "infra-test-v1",
    });
    expect("boundaryTransitions" in runtime).toBe(false);
    expect(runtime.at(WORLD_ID, "mitteldeutschland-b", 0)).toEqual([
      expect.objectContaining({
        atMs: 0,
        command: expect.objectContaining({
          type: "materialize",
          train: expect.objectContaining({ id: "run-1", scheduledDepartureMs: 0 }),
        }),
      }),
      expect.objectContaining({
        atMs: 0,
        command: expect.objectContaining({
          type: "queue-movement-continuation",
          continuation: expect.objectContaining({
            predecessorTrainId: "run-1",
            predecessorBaseRouteVersionId: "route:base",
            successor: expect.objectContaining({
              id: "run-1:day-1",
              formationVersionId: "formation:1",
              scheduledDepartureMs: 86_400_000,
            }),
            notBeforeMs: 86_400_000,
            minimumDwellMs: 300_000,
            continuity: "reverse-direction",
          }),
        }),
      }),
      expect.objectContaining({
        atMs: 0,
        command: expect.objectContaining({
          type: "dispatch",
          requests: [expect.objectContaining({
            trainId: "run-1",
            interlockingRouteId: INTERLOCKING_ROUTE_ID,
            waitingSinceMs: 0,
          })],
        }),
      }),
    ]);
    const streamedRecurrence = [...runtime.dueBoundaries(
      WORLD_ID,
      "mitteldeutschland-b",
      0,
      172_800_000,
    )];
    expect(streamedRecurrence.map(({ atMs, commands }) => ({
      atMs,
      commandCount: commands.length,
    }))).toEqual([
      { atMs: 86_400_000, commandCount: 1 },
      { atMs: 172_800_000, commandCount: 1 },
    ]);
    const recurrence = streamedRecurrence.flatMap(({ commands }) => commands);
    expect(recurrence.map((item) => item.command.type)).toEqual([
      "queue-movement-continuation",
      "queue-movement-continuation",
    ]);
    expect(recurrence.map((item) => item.atMs)).toEqual([
      86_400_000,
      172_800_000,
    ]);
    expect(recurrence[0]!.command).toMatchObject({
      type: "queue-movement-continuation",
      continuation: {
        predecessorTrainId: "run-1:day-1",
        predecessorBaseRouteVersionId: "route:base",
        successor: { id: "run-1:day-2", scheduledDepartureMs: 172_800_000 },
        successorDispatch: { trainId: "run-1:day-2", waitingSinceMs: 172_800_000 },
      },
    });
  });

  it("haelt genau eine private Zugvorlagenkopie unabhaengig vom Aufrufer", () => {
    const deployment = signed();
    const runtime = deploymentRuntime();
    runtime.register(deployment, EPOCH);
    const mutableSource = deployment.deployment.regionalSimulation.trains as Array<{
      id: string;
      scheduledDepartureMs: number;
    }>;
    mutableSource[0]!.id = "nach-registrierung-mutiert";
    mutableSource[0]!.scheduledDepartureMs = 1_000;

    expect(runtime.at(WORLD_ID, "mitteldeutschland-b", 0)).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          type: "materialize",
          train: expect.objectContaining({ id: "run-1", scheduledDepartureMs: 0 }),
        }),
      }),
      expect.objectContaining({
        command: expect.objectContaining({
          type: "queue-movement-continuation",
          continuation: expect.objectContaining({ predecessorTrainId: "run-1" }),
        }),
      }),
      expect.objectContaining({
        command: expect.objectContaining({
          type: "dispatch",
          requests: [expect.objectContaining({ trainId: "run-1" })],
        }),
      }),
    ]);
  });

  it("revalidiert beim Prozessneustart nur den identischen signierten Operational-v2-Kopf als No-op", () => {
    const deployment = signed();
    const preflight = vi.fn(nativeProgramReceipt);
    const restarted = deploymentRuntime({ activeWorlds: [] }, preflight);
    restarted.register(structuredClone(deployment), EPOCH);
    const original = deployment.deployment.regionalSimulation.infraRelease;
    const planningBefore = structuredClone(
      restarted.planningInfrastructureReleases.get(WORLD_ID, "infra-test-v1"),
    );
    const programBefore = restarted.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b");
    preflight.mockClear();

    restarted.revalidateOperationalInfrastructure(WORLD_ID, structuredClone(original));
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
      worldId: WORLD_ID,
      regionId: "mitteldeutschland-b",
      infraRelease: original,
      trains: deployment.deployment.regionalSimulation.trains,
    }));
    expect(restarted.operationalInfrastructureBinding(WORLD_ID, "mitteldeutschland-b")).toEqual(original);
    expect(restarted.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b")).toEqual(programBefore);
    expect(restarted.planningInfrastructureReleases.get(WORLD_ID, "infra-test-v1")).toEqual(planningBefore);
  });

  it("sperrt einen geaenderten Operational-v2-Kopf vor Preflight und verlangt Planning-/Livemap-Cutover", () => {
    const deployment = signed();
    const preflight = vi.fn(nativeProgramReceipt);
    const runtime = deploymentRuntime({ activeWorlds: [] }, preflight);
    runtime.register(deployment, EPOCH);
    const original = deployment.deployment.regionalSimulation.infraRelease;
    const target = Object.freeze({
      ...original,
      infraReleaseId: "infra-deutschland-2027.1",
      bytes: original.bytes + 1,
      sha256: "1".repeat(64),
      stateHash: "2".repeat(64),
    });
    const planningBefore = structuredClone(
      runtime.planningInfrastructureReleases.get(WORLD_ID, "infra-test-v1"),
    );
    const programBefore = runtime.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b");
    preflight.mockClear();

    expect(() => runtime.revalidateOperationalInfrastructure(WORLD_ID, target))
      .toThrow(/vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap/u);

    expect(preflight).not.toHaveBeenCalled();
    expect(runtime.operationalInfrastructureBinding(WORLD_ID, "mitteldeutschland-b")).toEqual(original);
    expect(runtime.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b")).toEqual(programBefore);
    expect(runtime.planningInfrastructureReleases.get(WORLD_ID, "infra-test-v1")).toEqual(planningBefore);
  });

  it("entfernt eine dauerhaft abgeschlossene Welt idempotent aus allen Scheduler- und Authority-Projektionen", () => {
    const deployment = signed();
    const runtime = deploymentRuntime({ activeWorlds: [] });
    runtime.register(deployment, EPOCH);

    expect(runtime.worldIds()).toEqual([WORLD_ID]);
    expect(runtime.realtimeWorldIds()).toEqual([WORLD_ID]);
    expect(runtime.realtimeRegions()).toHaveLength(1);
    expect(runtime.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b")).toBeDefined();
    expect(runtime.planningInfrastructureReleases.get(WORLD_ID, "infra-test-v1")).toBeDefined();

    runtime.releaseWorld(WORLD_ID);
    runtime.releaseWorld(WORLD_ID);

    expect(runtime.worldIds()).toEqual([]);
    expect(runtime.realtimeWorldIds()).toEqual([]);
    expect(runtime.realtimeRegions()).toEqual([]);
    expect(runtime.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b")).toBeUndefined();
    expect(runtime.operationalInfrastructureBinding(WORLD_ID, "mitteldeutschland-b")).toBeUndefined();
    expect(runtime.planningInfrastructureReleases.get(WORLD_ID, "infra-test-v1")).toBeUndefined();
    expect(runtime.worldEpochs.has(WORLD_ID)).toBe(false);
    expect(runtime.fleetAuthorityConfigurations[WORLD_ID]).toBeUndefined();
    expect(runtime.fleetAuthorityReleases[WORLD_ID]).toBeUndefined();
    expect(runtime.planningAuthorityAccountIds[WORLD_ID]).toBeUndefined();
    expect([...runtime.dueBoundaries(
      WORLD_ID,
      "mitteldeutschland-b",
      0,
      86_400_000,
    )]).toEqual([]);
  });

  it("stellt den Schedulervertrag vor dem Weltstart pruefbar bereit und rollt nur eine eigene Vorbereitung zurueck", () => {
    const deployment = signed();
    let preflightCalls = 0;
    const runtime = deploymentRuntime({ activeWorlds: [] }, (initialization) => {
      preflightCalls += 1;
      return nativeProgramReceipt(initialization);
    });
    expect(runtime.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b")).toBeUndefined();

    const aborted = runtime.prepareOperationalProgram(deployment);
    expect(preflightCalls).toBe(1);
    expect(runtime.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b")).toEqual({
      deploymentHash: deployment.deploymentHash,
      initializationHash: operationalSimulationInitializationHash(
        deployment.deployment.regionalSimulation,
      ),
      trainRunIds: ["run-1"],
    });
    expect(runtime.at(WORLD_ID, "mitteldeutschland-b", 0)).not.toEqual([]);
    expect(runtime.realtimeRegions()).toEqual([]);
    aborted.rollback();
    expect(runtime.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b")).toBeUndefined();
    expect(runtime.at(WORLD_ID, "mitteldeutschland-b", 0)).toEqual([]);

    const committed = runtime.prepareOperationalProgram(deployment);
    expect(preflightCalls).toBe(2);
    runtime.register(deployment, EPOCH);
    expect(preflightCalls).toBe(2);
    committed.rollback();
    expect(runtime.operationalProgramRegistration(WORLD_ID, "mitteldeutschland-b"))
      .toMatchObject({ trainRunIds: ["run-1"] });
    expect(runtime.realtimeRegions()).toHaveLength(1);
    runtime.prepareOperationalProgram(deployment);
    runtime.register(deployment, EPOCH);
    expect(preflightCalls).toBe(2);
  });

  it("instanziiert signierte Abschlussbindungen ueber Tagesgrenzen ohne die Basisfahrt umzubenennen", () => {
    const base = signed();
    const original = base.deployment.regionalSimulation.trains[0]!;
    const deployment = {
      ...base,
      deployment: { ...base.deployment, regionalSimulation: {
        ...base.deployment.regionalSimulation,
        serviceOutcomePolicy: { schemaVersion: "zugfolge-operational-service-outcome-policy/v1" as const, serviceIds: [original.id], vehicleCapacities: [] },
        trains: [{ ...original, serviceOutcome: {
          schemaVersion: "zugfolge-operational-service-outcome-binding/v1" as const,
          serviceId: original.id, serviceRunId: `${original.id}:service-day:2026-09-05`, lotId: "lot:1", serviceDay: "2026-09-05",
          scheduledArrivalMs: 90_000_000, requiredSeats: null, connectionAssessment: "unavailable" as const,
        } }],
      } },
    };
    const runtime = deploymentRuntime();
    runtime.register(deployment, EPOCH);
    const commands = runtime.at(WORLD_ID, "mitteldeutschland-b", 0);
    const queued = commands.find((entry) => entry.command.type === "queue-movement-continuation");
    expect(queued?.command).toMatchObject({ type: "queue-movement-continuation", continuation: { successor: { serviceOutcome: {
      serviceId: original.id, serviceRunId: `${original.id}:service-day:2026-09-06`, serviceDay: "2026-09-06",
      scheduledArrivalMs: 176_400_000, requiredSeats: null, connectionAssessment: "unavailable",
    } } } });
  });

  it("uebergibt eine Formation zwischen mehreren Tagesfahrten und ueber Mitternacht exakt", () => {
    const base = signed();
    const first = base.deployment.regionalSimulation.trains[0]!;
    const withTurn = {
      ...base,
      deployment: {
        ...base.deployment,
        regionalSimulation: {
          ...base.deployment.regionalSimulation,
          trains: [
            first,
            { ...first, id: "run-2", trainNumber: "RE 2", scheduledDepartureMs: 43_200_000 },
          ],
          movementContinuations: [
            {
              id: "continuation:run-1:run-2",
              predecessorTrainId: "run-1",
              predecessorBaseRouteVersionId: "route:base",
              successorTrainId: "run-2",
              successorDayOffset: 0,
              dailyBoundary: false,
              minimumDwellMs: 300_000,
              continuity: "reverse-direction",
              successorFormation: "inherit-predecessor",
            },
            {
              id: "continuation:run-2:run-1",
              predecessorTrainId: "run-2",
              predecessorBaseRouteVersionId: "route:base",
              successorTrainId: "run-1",
              successorDayOffset: 1,
              dailyBoundary: true,
              minimumDwellMs: 300_000,
              continuity: "reverse-direction",
              successorFormation: "inherit-predecessor",
            },
          ],
        },
      },
    } as SignedAlphaWorldDeployment;
    const runtime = deploymentRuntime();
    runtime.register(withTurn, EPOCH);

    expect(runtime.at(WORLD_ID, "mitteldeutschland-b", 43_200_000).map(({ command }) => command))
      .toEqual([
        expect.objectContaining({
          type: "queue-movement-continuation",
          continuation: expect.objectContaining({
            predecessorTrainId: "run-2",
            predecessorBaseRouteVersionId: "route:base",
            successor: expect.objectContaining({
              id: "run-1:day-1",
              scheduledDepartureMs: 86_400_000,
            }),
          }),
        }),
      ]);
    expect(runtime.at(WORLD_ID, "mitteldeutschland-b", 86_400_000).map(({ command }) => command))
      .toEqual([
        expect.objectContaining({
          type: "queue-movement-continuation",
          continuation: expect.objectContaining({
            predecessorTrainId: "run-1:day-1",
            predecessorBaseRouteVersionId: "route:base",
            successor: expect.objectContaining({
              id: "run-2:day-1",
              scheduledDepartureMs: 129_600_000,
            }),
          }),
        }),
      ]);
  });

  it("queued an der Personenfahrgrenze die vollstaendige physische Abstellkette vorab", () => {
    const deployment = structuredClone(signed());
    const passenger = deployment.deployment.regionalSimulation.trains[0]!;
    deployment.deployment.regionalSimulation.trains = [
      passenger,
      {
        ...passenger,
        id: "shunt-in",
        trainNumber: "R 2",
        movementKind: "shunting",
        scheduledDepartureMs: 0,
        publicPassengerStop: false,
      },
      {
        ...passenger,
        id: "shunt-out",
        trainNumber: "R 3",
        movementKind: "shunting",
        scheduledDepartureMs: 80_000_000,
        publicPassengerStop: false,
      },
      {
        ...passenger,
        id: "run-2",
        trainNumber: "RE 4",
        scheduledDepartureMs: 82_000_000,
      },
    ];
    deployment.deployment.regionalSimulation.movementContinuations = [
      {
        id: "continuation:passenger:shunt-in",
        predecessorTrainId: "run-1",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "shunt-in",
        successorDayOffset: 0,
        dailyBoundary: false,
        minimumDwellMs: 300_000,
        continuity: "same-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:shunt-in:shunt-out",
        predecessorTrainId: "shunt-in",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "shunt-out",
        successorDayOffset: 0,
        dailyBoundary: false,
        minimumDwellMs: 0,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:shunt-out:passenger",
        predecessorTrainId: "shunt-out",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "run-2",
        successorDayOffset: 0,
        dailyBoundary: false,
        minimumDwellMs: 0,
        continuity: "same-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:passenger:daily",
        predecessorTrainId: "run-2",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "run-1",
        successorDayOffset: 1,
        dailyBoundary: true,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
    ];

    const runtime = deploymentRuntime();
    runtime.register(deployment, EPOCH);
    const dayZero = runtime.at(WORLD_ID, "mitteldeutschland-b", 0);

    expect(dayZero.map(({ command }) => command.type)).toEqual([
      "materialize",
      "queue-movement-continuation",
      "queue-movement-continuation",
      "queue-movement-continuation",
      "dispatch",
    ]);
    expect(dayZero.slice(1, 4).map(({ command }) =>
      command.type === "queue-movement-continuation"
        ? [command.continuation.predecessorTrainId, command.continuation.successor.id]
        : undefined)).toEqual([
      ["run-1", "shunt-in"],
      ["shunt-in", "shunt-out"],
      ["shunt-out", "run-2"],
    ]);
    expect(runtime.at(WORLD_ID, "mitteldeutschland-b", 82_000_000)).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          type: "queue-movement-continuation",
          continuation: expect.objectContaining({
            predecessorTrainId: "run-2",
            predecessorBaseRouteVersionId: "route:base",
            successor: expect.objectContaining({ id: "run-1:day-1" }),
          }),
        }),
      }),
    ]);
    expect(dayZero.some(({ command }) => command.type === "retire")).toBe(false);
  });

  it("traegt eine Abstellkette kanonisch ueber Mitternacht und baut sie identisch wieder auf", () => {
    const deployment = structuredClone(signed());
    const passenger = deployment.deployment.regionalSimulation.trains[0]!;
    deployment.deployment.regionalSimulation.trains = [
      { ...passenger, id: "run-early", scheduledDepartureMs: 14_000_000 },
      { ...passenger, id: "run-late", trainNumber: "RE 2", scheduledDepartureMs: 80_000_000 },
      {
        ...passenger,
        id: "shunt-in-overnight",
        trainNumber: "R 3",
        movementKind: "shunting",
        scheduledDepartureMs: 80_100_000,
        publicPassengerStop: false,
      },
      {
        ...passenger,
        id: "shunt-out-overnight",
        trainNumber: "R 4",
        movementKind: "shunting",
        scheduledDepartureMs: 100_000_000,
        publicPassengerStop: false,
      },
    ];
    deployment.deployment.regionalSimulation.movementContinuations = [
      {
        id: "continuation:early:late",
        predecessorTrainId: "run-early",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "run-late",
        successorDayOffset: 0,
        dailyBoundary: false,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:late:shunt-in",
        predecessorTrainId: "run-late",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "shunt-in-overnight",
        successorDayOffset: 0,
        dailyBoundary: false,
        minimumDwellMs: 300_000,
        continuity: "same-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:shunt-in:shunt-out:overnight",
        predecessorTrainId: "shunt-in-overnight",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "shunt-out-overnight",
        successorDayOffset: 0,
        dailyBoundary: false,
        minimumDwellMs: 0,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:shunt-out:early:next-day",
        predecessorTrainId: "shunt-out-overnight",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "run-early",
        successorDayOffset: 1,
        dailyBoundary: true,
        minimumDwellMs: 0,
        continuity: "same-direction",
        successorFormation: "inherit-predecessor",
      },
    ];

    const first = deploymentRuntime();
    const rebuilt = deploymentRuntime();
    first.register(deployment, EPOCH);
    rebuilt.register(structuredClone(deployment), EPOCH);
    const firstCommands = first.at(WORLD_ID, "mitteldeutschland-b", 80_000_000);
    const rebuiltCommands = rebuilt.at(WORLD_ID, "mitteldeutschland-b", 80_000_000);
    expect(rebuiltCommands).toEqual(firstCommands);
    expect(firstCommands.map(({ command }) => command.type)).toEqual([
      "queue-movement-continuation",
      "queue-movement-continuation",
      "queue-movement-continuation",
    ]);
    expect(firstCommands.at(-2)?.command).toMatchObject({
      type: "queue-movement-continuation",
      continuation: {
        successor: {
          id: "shunt-out-overnight",
          scheduledDepartureMs: 100_000_000,
        },
      },
    });
    expect(firstCommands.at(-1)?.command).toMatchObject({
      type: "queue-movement-continuation",
      continuation: {
        predecessorTrainId: "shunt-out-overnight",
        predecessorBaseRouteVersionId: "route:base",
        successor: {
          id: "run-early:day-1",
          scheduledDepartureMs: 100_400_000,
        },
      },
    });

    const outsideSecondWindow = structuredClone(deployment);
    const shuntOut = outsideSecondWindow.deployment.regionalSimulation.trains
      .find((train) => train.id === "shunt-out-overnight")!;
    shuntOut.scheduledDepartureMs = 172_800_000;
    expect(() => deploymentRuntime().register(outsideSecondWindow, EPOCH))
      .toThrow(/Tageswiederholung ungueltig/u);

    const multipleDayOffsets = structuredClone(deployment);
    multipleDayOffsets.deployment.regionalSimulation.movementContinuations[0]!.successorDayOffset = 1;
    expect(() => deploymentRuntime().register(multipleDayOffsets, EPOCH))
      .toThrow(/nicht genau eine Periodenfortschaltung|ueberschreitet einen Betriebstag/u);
  });

  it("vererbt die reale Formation ueber eine mehrtaegige Rollover-Permutation", () => {
    const deployment = structuredClone(signed());
    const first = deployment.deployment.regionalSimulation.trains[0]!;
    deployment.deployment.regionalSimulation.formations = [
      ...deployment.deployment.regionalSimulation.formations,
      { id: "formation:2", predecessorId: null, vehicleIds: ["vehicle:1"] },
    ];
    deployment.deployment.regionalSimulation.trains = [
      first,
      {
        ...first,
        id: "run-2",
        trainNumber: "RE 2",
        formationVersionId: "formation:2",
        scheduledDepartureMs: 1_000,
      },
    ];
    deployment.deployment.regionalSimulation.movementContinuations = [
      {
        id: "continuation:run-1:run-2-next-day",
        predecessorTrainId: "run-1",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "run-2",
        successorDayOffset: 1,
        dailyBoundary: true,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:run-2:run-1-next-day",
        predecessorTrainId: "run-2",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "run-1",
        successorDayOffset: 1,
        dailyBoundary: true,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
    ];

    const runtime = deploymentRuntime();
    runtime.register(deployment, EPOCH);
    const dayZeroRunOne = runtime.at(WORLD_ID, "mitteldeutschland-b", 0)[1]!;
    const dayZeroRunTwo = runtime.at(WORLD_ID, "mitteldeutschland-b", 1_000)[1]!;
    const dayOneRunOne = runtime.at(WORLD_ID, "mitteldeutschland-b", 86_400_000)[0]!;

    expect(dayZeroRunOne.command).toMatchObject({
      type: "queue-movement-continuation",
      continuation: { successor: { id: "run-2:day-1", formationVersionId: "formation:1" } },
    });
    expect(dayZeroRunTwo.command).toMatchObject({
      type: "queue-movement-continuation",
      continuation: { successor: { id: "run-1:day-1", formationVersionId: "formation:2" } },
    });
    expect(dayOneRunOne.command).toMatchObject({
      type: "queue-movement-continuation",
      continuation: { successor: { id: "run-2:day-2", formationVersionId: "formation:2" } },
    });
  });

  it("trennt eine interne Mitternachtskante von einem Offset-0-DailyPlan-Rollover", () => {
    const deployment = structuredClone(signed());
    const seed = deployment.deployment.regionalSimulation.trains[0]!;
    deployment.deployment.regionalSimulation.formations = [
      ...deployment.deployment.regionalSimulation.formations,
      { id: "formation:2", predecessorId: null, vehicleIds: ["vehicle:1"] },
    ];
    deployment.deployment.regionalSimulation.trains = [
      { ...seed, id: "slot-1-late", trainNumber: "RE 11", scheduledDepartureMs: 80_000_000 },
      { ...seed, id: "slot-1-after-midnight", trainNumber: "RE 12", scheduledDepartureMs: 1_000_000 },
      { ...seed, id: "slot-2-early", trainNumber: "RE 21", formationVersionId: "formation:2", scheduledDepartureMs: 2_000_000 },
      { ...seed, id: "slot-2-late", trainNumber: "RE 22", formationVersionId: "formation:2", scheduledDepartureMs: 3_000_000 },
    ];
    deployment.deployment.regionalSimulation.movementContinuations = [
      {
        id: "continuation:slot-1:midnight",
        predecessorTrainId: "slot-1-late",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "slot-1-after-midnight",
        successorDayOffset: 1,
        dailyBoundary: false,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:slot-1:rollover-offset-0",
        predecessorTrainId: "slot-1-after-midnight",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "slot-2-early",
        successorDayOffset: 0,
        dailyBoundary: true,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:slot-2:internal",
        predecessorTrainId: "slot-2-early",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "slot-2-late",
        successorDayOffset: 0,
        dailyBoundary: false,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
      {
        id: "continuation:slot-2:rollover",
        predecessorTrainId: "slot-2-late",
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: "slot-1-late",
        successorDayOffset: 1,
        dailyBoundary: true,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction",
        successorFormation: "inherit-predecessor",
      },
    ];

    const runtime = deploymentRuntime();
    runtime.register(deployment, EPOCH);
    expect(runtime.at(WORLD_ID, "mitteldeutschland-b", 1_000_000)).toEqual([]);
    expect(runtime.at(WORLD_ID, "mitteldeutschland-b", 87_400_000)).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          type: "queue-movement-continuation",
          continuation: expect.objectContaining({
            predecessorTrainId: "slot-1-after-midnight:day-1",
            predecessorBaseRouteVersionId: "route:base",
            successor: expect.objectContaining({
              id: "slot-2-early:day-1",
              formationVersionId: "formation:1",
            }),
          }),
        }),
      }),
    ]);

    const mislabeled = structuredClone(deployment);
    mislabeled.deployment.regionalSimulation.movementContinuations[0]!.dailyBoundary = true;
    expect(() => deploymentRuntime().register(mislabeled, EPOCH))
      .toThrow(/nicht genau eine Periodenfortschaltung|statischen Slotpfad|DailyPlan-Grenzen|mehrere Day-0/u);
  });

  it("verweigert zwei gleichzeitige Fahrten derselben Formation", () => {
    const base = signed();
    const first = base.deployment.regionalSimulation.trains[0]!;
    const conflicting = {
      ...base,
      deployment: {
        ...base.deployment,
        regionalSimulation: {
          ...base.deployment.regionalSimulation,
          trains: [first, { ...first, id: "run-conflict", trainNumber: "RE 2" }],
        },
      },
    } as SignedAlphaWorldDeployment;

    expect(() => deploymentRuntime().register(conflicting, EPOCH))
      .toThrow(/mehrfach verplant/u);
  });

  it("verweigert eine signierte Zeitgrenze oberhalb des atomaren Schedulerlimits", () => {
    const deployment = structuredClone(signed());
    const first = deployment.deployment.regionalSimulation.trains[0]!;
    deployment.deployment.regionalSimulation.trains = Array.from(
      { length: 128 },
      (_, index) => ({
        ...first,
        id: `run-${index + 1}`,
        trainNumber: `RE ${index + 1}`,
        formationVersionId: `formation:${index + 1}`,
        scheduledDepartureMs: 0,
      }),
    );
    deployment.deployment.regionalSimulation.movementContinuations = Array.from(
      { length: 128 },
      (_, index) => ({
        id: `continuation:run-${index + 1}:daily`,
        predecessorTrainId: `run-${index + 1}`,
        predecessorBaseRouteVersionId: "route:base",
        successorTrainId: `run-${index + 1}`,
        successorDayOffset: 1 as const,
        dailyBoundary: true,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction" as const,
        successorFormation: "inherit-predecessor" as const,
      }),
    );

    expect(() => deploymentRuntime().register(deployment, EPOCH))
      .toThrow(/ueberschreitet mit 258 atomaren Kommandos das Limit 256/u);
  });

  it("registriert Authority-v2 nicht ohne signierten Fahrzeugkatalog-Beweis produktiv", () => {
    const runtime = deploymentRuntime({
      activeWorlds: [],
      fleetAuthorityConfigurations: {
        [WORLD_ID]: {
          producedAt: 100,
          authorityRelease: {
            schemaVersion: "zugfolge-fleet-authority-release/v2",
          } as never,
        },
      },
    });

    expect(() => runtime.assertVehicleCatalogDeploymentBindings(new Map())).toThrow(
      /kein verifiziertes signiertes Fahrzeugkatalog-Deployment/u,
    );
  });

  it("rekonstruiert nach Neustart exakt dieselben Capabilities und laesst nicht registrierte Provisionierung inert", () => {
    const first = deploymentRuntime();
    first.register(signed(), EPOCH);
    const restarted = deploymentRuntime({
      activeWorlds: [{
        worldId: "70000000-0000-4000-8000-000000000002",
        epoch: EPOCH,
      }],
    });

    restarted.register(signed(), EPOCH);
    restarted.register(signed(), EPOCH);

    expect(restarted.realtimeRegions()).toEqual(first.realtimeRegions());
    expect([...restarted.dueBoundaries(WORLD_ID, "mitteldeutschland-b", 0, 172_800_000)])
      .toEqual([...first.dueBoundaries(WORLD_ID, "mitteldeutschland-b", 0, 172_800_000)]);
    expect(restarted.planningAuthorityAccountIds).toEqual(first.planningAuthorityAccountIds);
    expect(restarted.fleetAuthorityReleases).toEqual(first.fleetAuthorityReleases);
    expect(restarted.worldIds()).toContain("70000000-0000-4000-8000-000000000002");
    expect(restarted.realtimeWorldIds()).toEqual([WORLD_ID]);
    expect(restarted.realtimeRegions()).not.toContainEqual({
      worldId: "70000000-0000-4000-8000-000000000002",
      regionId: "mitteldeutschland-b",
    });
    expect(restarted.isRealtimeWorld("70000000-0000-4000-8000-000000000002")).toBe(false);
    expect(restarted.expectsLivemapFreshness(
      "70000000-0000-4000-8000-000000000002",
      EPOCH.getTime(),
    )).toBe(false);
  });

  it("lehnt unvollstaendige oder nicht wiederholbare signierte Betriebsprogramme fail-closed ab", () => {
    const missingDeparture = structuredClone(signed()) as unknown as {
      deployment: { regionalSimulation: { trains: Array<{ scheduledDepartureMs: number | null }> } };
    };
    missingDeparture.deployment.regionalSimulation.trains[0]!.scheduledDepartureMs = null;
    expect(() => deploymentRuntime().register(
      missingDeparture as unknown as SignedAlphaWorldDeployment,
      EPOCH,
    )).toThrow(/Abfahrtsgrenze/u);

    const missingDispatchRoute = structuredClone(signed()) as unknown as {
      deployment: { regionalSimulation: { trains: Array<{ dispatchInterlockingRouteId: string }> } };
    };
    missingDispatchRoute.deployment.regionalSimulation.trains[0]!.dispatchInterlockingRouteId = "";
    expect(() => deploymentRuntime().register(
      missingDispatchRoute as unknown as SignedAlphaWorldDeployment,
      EPOCH,
    )).toThrow(/keine nativ validierte signierte Fahrstrasse/u);
  });

  it("prueft den nativen Streaming-Beleg streng und mutiert die Registry bei keinem Fehler", () => {
    const deployment = signed();
    const initialization = deployment.deployment.regionalSimulation;
    const valid = nativeProgramReceipt(initialization);
    const reorderedReceipt: OperationalInitializationValidationReceipt = {
      ...valid,
      infraRelease: {
        file: valid.infraRelease.file,
        bytes: valid.infraRelease.bytes,
        sha256: valid.infraRelease.sha256,
        stateHash: valid.infraRelease.stateHash,
        schemaVersion: valid.infraRelease.schemaVersion,
        infraReleaseId: valid.infraRelease.infraReleaseId,
      },
    };
    const reorderedRuntime = deploymentRuntime(
      { activeWorlds: [] },
      () => reorderedReceipt,
    );
    expect(() => reorderedRuntime.register(deployment, EPOCH)).not.toThrow();

    const missingBytes = { ...valid.infraRelease } as Partial<typeof valid.infraRelease>;
    delete missingBytes.bytes;
    const invalidReceipts: readonly OperationalInitializationValidationReceipt[] = [
      { ...valid, initializationHash: "0".repeat(64) },
      {
        ...valid,
        infraRelease: {
          ...valid.infraRelease,
          schemaVersion: "zugfolge-operational-infrastructure-binding/foreign",
        } as typeof valid.infraRelease,
      },
      { ...valid, infraRelease: { ...valid.infraRelease, infraReleaseId: "infra:foreign" } },
      {
        ...valid,
        infraRelease: { ...valid.infraRelease, file: "foreign.json" } as typeof valid.infraRelease,
      },
      { ...valid, infraRelease: { ...valid.infraRelease, bytes: valid.infraRelease.bytes + 1 } },
      { ...valid, infraRelease: { ...valid.infraRelease, sha256: "2".repeat(64) } },
      {
        ...valid,
        infraRelease: { ...valid.infraRelease, stateHash: "1".repeat(64) },
      },
      {
        ...valid,
        infraRelease: missingBytes as typeof valid.infraRelease,
      },
      {
        ...valid,
        infraRelease: {
          ...valid.infraRelease,
          additionalBinding: true,
        } as typeof valid.infraRelease,
      },
      { ...valid, programTrainCount: valid.programTrainCount + 1 },
      { ...valid, validatedProgramTemplateCount: valid.validatedProgramTemplateCount + 1 },
      { ...valid, validatedRouteVersionCount: valid.validatedRouteVersionCount + 1 },
      {
        ...valid,
        validatedDispatchInterlockingRouteCount:
          valid.validatedDispatchInterlockingRouteCount + 1,
      },
      { ...valid, validatedFormationBindingCount: valid.validatedFormationBindingCount + 1 },
      { ...valid, validatedTrainNumberCount: valid.validatedTrainNumberCount + 1 },
      {
        ...valid,
        validatedProtectionModeSelectionCount:
          valid.validatedProtectionModeSelectionCount + 1,
      },
      { ...valid, protectionModeSelectionsSha256: "0".repeat(64) },
      {
        ...valid,
        protectionModeSelectionPolicy:
          "zugfolge-protection-mode-selection/foreign-v1" as typeof valid.protectionModeSelectionPolicy,
      },
      { ...valid, protectionModeSelectionsValidated: false as true },
      { ...valid, trainNumbersValidated: false as true },
      { ...valid, stateHash: "ungueltig" },
    ];

    for (const receipt of invalidReceipts) {
      const runtime = deploymentRuntime(
        { activeWorlds: [] },
        () => receipt,
      );
      expect(() => runtime.register(deployment, EPOCH)).toThrow(/nativen Streaming-Pruefbeleg/u);
      expectUnregistered(runtime);
    }

    const missingExternalArtifact = deploymentRuntime(
      { activeWorlds: [] },
      () => { throw new Error("Operational-v2-Runtimeartefakt fehlt."); },
    );
    expect(() => missingExternalArtifact.register(deployment, EPOCH)).toThrow(/Runtimeartefakt fehlt/u);
    expectUnregistered(missingExternalArtifact);
  });

  (nativeAvailable ? it : it.skip)(
    "registriert ein serialisiertes kompaktes Binding nur nach echter externer NAPI-Hydrierung",
    async () => {
      const previousRoots = process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
      const temporaryRoots: string[] = [];
      const nativeRuntime = loadOperationalSimulationRuntime();
      const preflight: ActiveWorldRuntimeSeed["operationalProgramPreflight"] = (initialization) =>
        nativeRuntime.initialize(initialization).validationReceipt;
      const setRoot = (releaseId: string, root: string) => {
        process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = JSON.stringify({ [releaseId]: root });
      };
      const temporaryRoot = async () => {
        const root = await mkdtemp(join(tmpdir(), "zugfolge-world-program-"));
        temporaryRoots.push(root);
        return root;
      };

      try {
        const deployment = structuredClone(nativeRecurringSigned());
        expect(Object.keys(deployment.deployment.regionalSimulation.infraRelease).sort()).toEqual([
          "bytes",
          "file",
          "infraReleaseId",
          "schemaVersion",
          "sha256",
          "stateHash",
        ]);
        setRoot(
          NATIVE_RECURRING_INFRASTRUCTURE_BINDING.infraReleaseId,
          NATIVE_RECURRING_INFRASTRUCTURE_ROOT,
        );
        const registered = deploymentRuntime({ activeWorlds: [] }, preflight);
        registered.register(deployment, EPOCH);
        expect(registered.at(WORLD_ID, "mitteldeutschland-b", 0)).toEqual([
          expect.objectContaining({ command: expect.objectContaining({ type: "materialize" }) }),
          expect.objectContaining({
            command: expect.objectContaining({
              type: "queue-movement-continuation",
              continuation: expect.objectContaining({
                predecessorTrainId: "run-outbound",
                successor: expect.objectContaining({ id: "run-return" }),
              }),
            }),
          }),
          expect.objectContaining({
            command: expect.objectContaining({
              type: "dispatch",
              requests: [expect.objectContaining({
                interlockingRouteId: NATIVE_RECURRING_INTERLOCKING_A,
              })],
            }),
          }),
        ]);

        const missingRoot = await temporaryRoot();
        setRoot(NATIVE_RECURRING_INFRASTRUCTURE_BINDING.infraReleaseId, missingRoot);
        const missing = deploymentRuntime({ activeWorlds: [] }, preflight);
        expect(() => missing.register(structuredClone(nativeRecurringSigned()), EPOCH)).toThrow();
        expectUnregistered(missing);

        const tamperedRoot = await temporaryRoot();
        const source = join(
          NATIVE_RECURRING_INFRASTRUCTURE_ROOT,
          NATIVE_RECURRING_INFRASTRUCTURE_BINDING.file,
        );
        const tamperedPath = join(
          tamperedRoot,
          NATIVE_RECURRING_INFRASTRUCTURE_BINDING.file,
        );
        await cp(source, tamperedPath);
        const tamperedBytes = await readFile(tamperedPath);
        tamperedBytes[0] = tamperedBytes[0] === 0x7b ? 0x5b : 0x7b;
        await writeFile(tamperedPath, tamperedBytes);
        setRoot(NATIVE_RECURRING_INFRASTRUCTURE_BINDING.infraReleaseId, tamperedRoot);
        const tampered = deploymentRuntime({ activeWorlds: [] }, preflight);
        expect(() => tampered.register(structuredClone(nativeRecurringSigned()), EPOCH)).toThrow();
        expectUnregistered(tampered);

        const foreignRoot = await temporaryRoot();
        await cp(source, join(
          foreignRoot,
          NATIVE_RECURRING_INFRASTRUCTURE_BINDING.file,
        ));
        const foreignReleaseId = "native-recurring-v1:foreign-operational-infra";
        const foreign = structuredClone(nativeRecurringSigned()) as unknown as {
          deployment: {
            regionalSimulation: { infraRelease: { infraReleaseId: string } };
          };
        };
        foreign.deployment.regionalSimulation.infraRelease.infraReleaseId = foreignReleaseId;
        setRoot(foreignReleaseId, foreignRoot);
        const wrongRelease = deploymentRuntime({ activeWorlds: [] }, preflight);
        expect(() => wrongRelease.register(
          foreign as unknown as SignedAlphaWorldDeployment,
          EPOCH,
        )).toThrow();
        expectUnregistered(wrongRelease);

        const wrongStateHashDeployment = structuredClone(nativeRecurringSigned()) as unknown as {
          deployment: { regionalSimulation: { infraRelease: { stateHash: string } } };
        };
        wrongStateHashDeployment.deployment.regionalSimulation.infraRelease.stateHash = "1".repeat(64);
        setRoot(
          NATIVE_RECURRING_INFRASTRUCTURE_BINDING.infraReleaseId,
          NATIVE_RECURRING_INFRASTRUCTURE_ROOT,
        );
        const wrongStateHash = deploymentRuntime({ activeWorlds: [] }, preflight);
        expect(() => wrongStateHash.register(
          wrongStateHashDeployment as unknown as SignedAlphaWorldDeployment,
          EPOCH,
        )).toThrow();
        expectUnregistered(wrongStateHash);
      } finally {
        if (previousRoots === undefined) {
          delete process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
        } else {
          process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = previousRoots;
        }
        await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
      }
    },
    30_000,
  );

  it("laesst ein retrybares Provisioning-Profil nicht in den Odoo-Projektionszyklus", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const provisioningWorldId = "70000000-0000-4000-8000-000000000002";
      await db.insert(worlds).values([
        { id: WORLD_ID, name: "Aktiv", schedulePeriodWeeks: 4, epoch: EPOCH, lifecycleStatus: "active" },
        { id: provisioningWorldId, name: "Provisioning", schedulePeriodWeeks: 4, epoch: EPOCH, lifecycleStatus: "provisioning" },
      ]);
      const profile = (worldId: string, state: "draft" | "running", seed: bigint) => ({
        worldId,
        profileKind: "public" as const,
        regionId: "mitteldeutschland-b",
        regionVariant: "B",
        worldSeed: seed,
        accelerationFactor: 1,
        infraReleaseHash: "a".repeat(64),
        timetableReleaseHash: "b".repeat(64),
        fleetReleaseHash: "c".repeat(64),
        economyReleaseHash: "d".repeat(64),
        blueprint: { startingCapitalPolicy: { mode: "finite", amountCents: "0" } },
        blueprintHash: "e".repeat(64),
        deploymentHash: state === "running" ? "f".repeat(64) : null,
        state,
      });
      await db.insert(alphaWorldProfiles).values([
        profile(WORLD_ID, "running", 1n),
        profile(provisioningWorldId, "draft", 2n),
      ]);

      expect(await loadActiveAlphaWorldProjectionProfiles(db)).toEqual([
        expect.objectContaining({ worldId: WORLD_ID, profileKind: "public" }),
      ]);

      await db.update(worlds).set({ lifecycleStatus: "active" })
        .where(eq(worlds.id, provisioningWorldId));
      await db.update(alphaWorldProfiles).set({
        state: "running",
        deploymentHash: "f".repeat(64),
      }).where(eq(alphaWorldProfiles.worldId, provisioningWorldId));

      expect(await loadActiveAlphaWorldProjectionProfiles(db)).toEqual([
        expect.objectContaining({ worldId: WORLD_ID, profileKind: "public" }),
        expect.objectContaining({ worldId: provisioningWorldId, profileKind: "public" }),
      ]);
    } finally {
      await client.close();
    }
  });
});
