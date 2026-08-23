import { PGlite } from "@electric-sql/pglite";
import {
  disruptionProviderApplications,
  disruptionProviderStates,
  MIGRATIONS_FOLDER,
  regionalSimulationStates,
  worlds,
  type Database,
} from "@zugfolge/db";
import type { ProviderSnapshot } from "@zugfolge/disruption-provider";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";

import type { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import {
  createProviderDisruptionConsumer,
  providerRegistrations,
} from "./provider-disruption-consumer.js";

const WORLD_ID = "77777777-7777-4777-8777-777777777777";

function operationalState(
  trainId: string,
  routeNumber: number,
  operatingPoint: string,
): Readonly<Record<string, unknown>> {
  const routeId = `route:${routeNumber}:${operatingPoint}`;
  const templateId = `route-template:${routeNumber}:${operatingPoint}`;
  const edgeId = `edge:${routeNumber}:${operatingPoint}`;
  const blockId = `block:${routeNumber}:${operatingPoint}`;
  const signalId = `signal:${routeNumber}:${operatingPoint}`;
  const switchId = `switch:${routeNumber}:${operatingPoint}`;
  return {
    schemaVersion: "zugfolge-operational-simulation-state/v2",
    world: {
      trains: {
        [trainId]: { id: trainId, routeVersionId: routeId },
      },
      infra: {
        blockResources: [blockId],
        signals: [signalId],
        switches: [switchId],
        routeVersions: {
          [routeId]: {
            id: routeId,
            templateId,
            legs: [{ edgeId, blockIds: [blockId] }],
          },
        },
        interlockingRoutes: {
          [`interlocking:${routeNumber}:${operatingPoint}`]: {
            routeTemplateId: templateId,
            signalId,
            switchPositions: { [switchId]: "normal" },
          },
        },
        platformIntervals: {
          [`platform:${routeNumber}:${operatingPoint}`]: { edgeId },
        },
      },
    },
  };
}

describe("Provider-Snapshot in regionalen Single-Writer", () => {
  it("bindet nur passende v2-Laufwege und erzeugt eine konkrete Infra-Wirkung", () => {
    const restrictions: ProviderSnapshot["restrictions"] = [{
      id: "restriction-a", kind: "unplanned", effect: "single-track", causeCode: 26, fineCauseId: "switch.drive", sourceRecordId: "source-a",
      location: { routeNumbers: [6053], operatingPointCodes: ["LL"], operatingPointNames: ["Leipzig Hbf"], coordinateMillimetres: [] },
      schedule: [], continuousInterval: { startsAtMs: Date.parse("2026-08-11T15:00:00Z"), endsAtMs: Date.parse("2026-08-11T17:00:00Z") },
    }];
    const result = providerRegistrations([
      { regionId: "leipzig", state: operationalState("train-1", 6053, "LL") },
      { regionId: "erfurt", state: operationalState("train-2", 6300, "UEF") },
    ], { restrictions }, new Date("2026-08-11T15:30:00Z"));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      regionId: "leipzig",
      disruptionId: expect.stringContaining("restriction-a"),
      effect: { "switch-failed": { switchId: "switch:6053:LL" } },
    });
    expect(JSON.stringify(result)).not.toContain("delaySeconds");
  });

  it("aktiviert weder künftige noch auf keine echte Infra-Ressource auflösbare Providerziele", () => {
    const base: ProviderSnapshot["restrictions"][number] = {
      id: "restriction-fail-closed", kind: "planned", effect: "closure", causeCode: 31, fineCauseId: "construction.temporary-speed", sourceRecordId: "source-fail-closed",
      location: { routeNumbers: [6053], operatingPointCodes: ["LL"], operatingPointNames: [], coordinateMillimetres: [] },
      schedule: [], continuousInterval: { startsAtMs: Date.parse("2026-08-11T16:00:00Z"), endsAtMs: Date.parse("2026-08-11T17:00:00Z") },
    };
    const rows = [{ regionId: "leipzig", state: operationalState("train-1", 6053, "LL") }];
    expect(providerRegistrations(rows, { restrictions: [base] }, new Date("2026-08-11T15:30:00Z"))).toEqual([]);
    expect(providerRegistrations(rows, {
      restrictions: [{
        ...base,
        location: { ...base.location, operatingPointCodes: ["ZZ"] },
        continuousInterval: { startsAtMs: Date.parse("2026-08-11T15:00:00Z"), endsAtMs: Date.parse("2026-08-11T17:00:00Z") },
      }],
    }, new Date("2026-08-11T15:30:00Z"))).toEqual([]);
  });

  it("schiebt ein unverändertes Snapshot-Fenster weiter und entfernt entfallene Einträge", async () => {
    const client = new PGlite();
    const pglite = drizzle(client);
    await migrate(pglite, { migrationsFolder: MIGRATIONS_FOLDER });
    const epoch = new Date("2026-01-01T00:00:00Z");
    const firstRun = new Date("2026-08-11T15:30:00Z");
    await pglite.insert(worlds).values({
      id: WORLD_ID,
      name: "Provider-Abgleich",
      schedulePeriodWeeks: 3,
      epoch,
    });
    await pglite.insert(disruptionProviderStates).values({
      worldId: WORLD_ID,
      providerSetId: "public-infrastructure-restrictions/de-v1",
      rightsStatus: "approved",
      enabled: "enabled",
      rightsReference: "decision:2026-08-11",
      checkedAt: firstRun,
    });
    await pglite.insert(regionalSimulationStates).values({
      worldId: WORLD_ID,
      regionId: "leipzig",
      stateSchema: "zugfolge-operational-simulation-state/v2",
      state: operationalState("train-1", 6053, "LL"),
      initializationHash: "f".repeat(64),
      stateHash: "0".repeat(64),
      revision: 0,
      publisherSequence: 0,
      createdAt: firstRun,
      updatedAt: firstRun,
    });
    const restriction: ProviderSnapshot["restrictions"][number] = {
      id: "restriction-window",
      kind: "planned",
      effect: "closure",
      causeCode: 31,
      fineCauseId: "construction.temporary-speed",
      sourceRecordId: "source-window",
      location: {
        routeNumbers: [6053],
        operatingPointCodes: ["LL"],
        operatingPointNames: ["Leipzig Hbf"],
        coordinateMillimetres: [],
      },
      schedule: [],
      continuousInterval: {
        startsAtMs: Date.parse("2026-08-11T15:00:00Z"),
        endsAtMs: Date.parse("2026-08-11T17:00:00Z"),
      },
    };
    const snapshot = (hash: string, restrictions: ProviderSnapshot["restrictions"]): ProviderSnapshot => ({
      schemaVersion: "zugfolge-provider-snapshot/v1",
      providerSetId: "public-infrastructure-restrictions/de-v1",
      fetchedAt: firstRun.toISOString(),
      revision: 1,
      sourceVersion: "test",
      sourceDataTimestamps: { planned: "test", unplanned: "test" },
      snapshotHash: hash,
      raw: { handshake: {}, plannedWorks: [], operationalIncidents: [], scheduledTrafficPauses: [] },
      restrictions,
      discarded: [],
    });
    const apply = vi.fn(async () => undefined);
    const consume = createProviderDisruptionConsumer(
      pglite as unknown as Database,
      { apply } as unknown as RegionalSimulationWorker,
    );

    try {
      await consume({ worldId: WORLD_ID, epoch }, snapshot("a".repeat(64), [restriction]), firstRun);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0]?.[0]).toMatchObject({
        command: {
          type: "activate-disruption",
          effect: { "resource-closed": { resourceId: "block:6053:LL" } },
        },
      });
      expect(await pglite.select().from(disruptionProviderApplications)).toHaveLength(1);

      await consume({ worldId: WORLD_ID, epoch }, snapshot("a".repeat(64), [restriction]), firstRun);
      expect(apply).toHaveBeenCalledTimes(1);

      await consume({ worldId: WORLD_ID, epoch }, snapshot("b".repeat(64), []), firstRun);
      expect(apply).toHaveBeenCalledTimes(2);
      expect(apply.mock.calls[1]?.[0]).toMatchObject({
        command: {
          type: "clear-disruption",
          releaseReference: `provider:public-infrastructure-restrictions/de-v1:${"b".repeat(64)}`,
        },
      });
      expect(await pglite.select().from(disruptionProviderApplications)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
