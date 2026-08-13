import { PGlite } from "@electric-sql/pglite";
import { alphaWorldProfiles, MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  loadActiveAlphaWorldProjectionProfiles,
  type SignedAlphaWorldDeployment,
} from "./alpha-world-start.js";
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
        regionId: "mitteldeutschland-b",
        trains: [{
          trainRunId: "run-1",
          operator: "public",
          trainNumber: "RE 1",
          category: "regional",
          route: [
            { operatingPoint: "leipzig", positionMm: 0, arrivalS: 0, minimumDwellSeconds: 0, departureS: 0 },
            { operatingPoint: "halle", positionMm: 35_000_000, arrivalS: 1_800, minimumDwellSeconds: 60, departureS: 1_860 },
          ],
        }],
      },
      repeatEveryS: 86_400,
      boundaryTransitions: [],
    },
  } as unknown as SignedAlphaWorldDeployment;
}

describe("aktive World-Deployment-Runtime", () => {
  it("registriert ein Live-Deployment sofort in Fleet, Planning und Scheduler-Welten", () => {
    const runtime = new ActiveWorldDeploymentRuntime({ activeWorlds: [] });

    runtime.register(signed(), EPOCH);

    expect(runtime.worldIds()).toEqual([WORLD_ID]);
    expect(runtime.worldEpochs.get(WORLD_ID)).toEqual(EPOCH);
    expect(runtime.fleetAuthorityReleases[WORLD_ID]).toMatchObject({ releaseId: "fleet-test" });
    expect(runtime.planningAuthorityAccountIds[WORLD_ID]).toBe(AUTHORITY_ID);
    expect(runtime.planningInfrastructureReleases.get(WORLD_ID, "infra-test-v1")).toMatchObject({
      worldId: WORLD_ID,
      releaseId: "infra-test-v1",
    });
  });

  it("rekonstruiert nach Neustart exakt dieselben Capabilities und laesst nicht registrierte Provisionierung inert", () => {
    const first = new ActiveWorldDeploymentRuntime({ activeWorlds: [] });
    first.register(signed(), EPOCH);
    const restarted = new ActiveWorldDeploymentRuntime({ activeWorlds: [] });

    restarted.register(signed(), EPOCH);
    restarted.register(signed(), EPOCH);

    expect(restarted.worldIds()).toEqual(first.worldIds());
    expect(restarted.planningAuthorityAccountIds).toEqual(first.planningAuthorityAccountIds);
    expect(restarted.fleetAuthorityReleases).toEqual(first.fleetAuthorityReleases);
    expect(restarted.boundaryTransitions.due(WORLD_ID, "mitteldeutschland-b", 0, 86_400))
      .toEqual(first.boundaryTransitions.due(WORLD_ID, "mitteldeutschland-b", 0, 86_400));
    expect(restarted.worldIds()).not.toContain("70000000-0000-4000-8000-000000000002");
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
    } finally {
      await client.close();
    }
  });
});
