import { PGlite } from "@electric-sql/pglite";
import { alphaWorldProfiles, MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  loadActiveAlphaWorldProjectionProfiles,
  type SignedAlphaWorldDeployment,
} from "./alpha-world-start.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";
import { ActiveWorldDeploymentRuntime } from "./world-deployment-runtime.js";

const WORLD_ID = "70000000-0000-4000-8000-000000000001";
const AUTHORITY_ID = "70000000-0000-4000-8000-000000000099";
const EPOCH = new Date("2026-12-13T00:00:00.000Z");

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
      fleet: { authorityRelease: { releaseId: "fleet-test" } },
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
        infraRelease: {
          id: "infra-test-v1",
          directedEdges: { "edge:1": 100_000 },
          edgeGeometries: {
            "edge:1": [
              { edgeOffsetMm: 0, latitudeE7: 513_454_000, longitudeE7: 123_827_000, bearingMilliDegrees: 90_000 },
              { edgeOffsetMm: 100_000, latitudeE7: 513_454_000, longitudeE7: 123_837_000, bearingMilliDegrees: null },
            ],
          },
          routeVersions: {
            "route:1": {
              id: "route:1",
              templateId: "route-template:1",
              predecessorId: null,
              transitionRouteMm: null,
              legs: [{
                edgeId: "edge:1",
                direction: "along",
                edgeEntryMm: 0,
                edgeExitMm: 100_000,
                routeStartMm: 0,
                blockIds: ["block:1"],
                speedLimitMmps: 20_000,
                gradientPerMille: 0,
                requiredProtectionSystems: ["pzb"],
              }],
            },
          },
          interlockingRoutes: {
            "interlocking:1": {
              id: "interlocking:1",
              routeTemplateId: "route-template:1",
              signalId: "signal:1",
              movementKind: "train",
              pathResources: ["block:1"],
              overlapResources: [],
              flankResources: [],
              switchPositions: {},
              authorityEndRouteMm: 100_000,
              releaseAfterTailRouteMm: 90_000,
            },
          },
          signals: ["signal:1"],
          switches: [],
          blockResources: ["block:1"],
          platformIntervals: {},
          regionBoundaries: [],
          rzueLayoutId: "rzue:1",
        },
        vehicleTypes: [{
          vehicleType: {
            id: "vehicle-type:1",
            lengthMm: 10_000,
            massKg: 10_000,
            maximumSpeedMmps: 20_000,
            powerWatts: 1_000_000,
            startingTractiveForceNewtons: 100_000,
            maximumAccelerationMmps2: 1_000,
            serviceBrakeMmps2: 1_000,
            emergencyBrakeMmps2: 1_500,
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
            mechanicsBasisPoints: 10_000,
            driveBasisPoints: 10_000,
            brakesBasisPoints: 10_000,
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
          routeVersionId: "route:1",
          formationVersionId: "formation:1",
          headRouteMm: 0,
          scheduledDepartureMs: 0,
          publicPassengerStop: true,
        }],
      },
      repeatEveryS: 86_400,
    },
  } as unknown as SignedAlphaWorldDeployment;
}

describe("aktive World-Deployment-Runtime", () => {
  it("registriert ein Live-Deployment sofort in Fleet, Planning und Scheduler-Welten", () => {
    const runtime = new ActiveWorldDeploymentRuntime({ activeWorlds: [] });

    runtime.register(signed(), EPOCH);

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
          type: "dispatch",
          requests: [expect.objectContaining({ trainId: "run-1", waitingSinceMs: 0 })],
        }),
      }),
    ]);
    const recurrence = runtime.due(WORLD_ID, "mitteldeutschland-b", 0, 172_800_000);
    expect(recurrence.map((item) => item.command.type)).toEqual([
      "retire", "materialize", "dispatch",
      "retire", "materialize", "dispatch",
    ]);
    expect(recurrence.map((item) => item.atMs)).toEqual([
      86_400_000, 86_400_000, 86_400_000,
      172_800_000, 172_800_000, 172_800_000,
    ]);
    expect(recurrence[0]!.command).toEqual({ type: "retire", trainId: "run-1" });
    expect(recurrence[1]!.command).toMatchObject({
      type: "materialize",
      train: { id: "run-1:day-1", scheduledDepartureMs: 86_400_000 },
    });
    expect(recurrence[2]!.command).toMatchObject({
      type: "dispatch",
      requests: [{ trainId: "run-1:day-1", waitingSinceMs: 86_400_000 }],
    });
  });

  it("rekonstruiert nach Neustart exakt dieselben Capabilities und laesst nicht registrierte Provisionierung inert", () => {
    const first = new ActiveWorldDeploymentRuntime({ activeWorlds: [] });
    first.register(signed(), EPOCH);
    const restarted = new ActiveWorldDeploymentRuntime({
      activeWorlds: [{
        worldId: "70000000-0000-4000-8000-000000000002",
        epoch: EPOCH,
      }],
    });

    restarted.register(signed(), EPOCH);
    restarted.register(signed(), EPOCH);

    expect(restarted.realtimeRegions()).toEqual(first.realtimeRegions());
    expect(restarted.due(WORLD_ID, "mitteldeutschland-b", 0, 172_800_000))
      .toEqual(first.due(WORLD_ID, "mitteldeutschland-b", 0, 172_800_000));
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
    expect(() => new ActiveWorldDeploymentRuntime({ activeWorlds: [] }).register(
      missingDeparture as unknown as SignedAlphaWorldDeployment,
      EPOCH,
    )).toThrow(/Abfahrtsgrenze/u);

    const incompleteAuthority = structuredClone(signed()) as unknown as {
      deployment: {
        regionalSimulation: {
          infraRelease: { interlockingRoutes: Record<string, { authorityEndRouteMm: number }> };
        };
      };
    };
    incompleteAuthority.deployment.regionalSimulation.infraRelease
      .interlockingRoutes["interlocking:1"]!.authorityEndRouteMm = 90_000;
    expect(() => new ActiveWorldDeploymentRuntime({ activeWorlds: [] }).register(
      incompleteAuthority as unknown as SignedAlphaWorldDeployment,
      EPOCH,
    )).toThrow(/Laufwegende/u);

    const unreleasableFormation = structuredClone(signed()) as unknown as {
      deployment: {
        regionalSimulation: {
          infraRelease: { interlockingRoutes: Record<string, { releaseAfterTailRouteMm: number }> };
        };
      };
    };
    unreleasableFormation.deployment.regionalSimulation.infraRelease
      .interlockingRoutes["interlocking:1"]!.releaseAfterTailRouteMm = 90_001;
    expect(() => new ActiveWorldDeploymentRuntime({ activeWorlds: [] }).register(
      unreleasableFormation as unknown as SignedAlphaWorldDeployment,
      EPOCH,
    )).toThrow(/Formation nicht freigeben/u);
  });

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
