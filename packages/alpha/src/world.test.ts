import { PGlite } from "@electric-sql/pglite";
import { alphaWorldProfiles, MIGRATIONS_FOLDER, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { decodeEconomyValue } from "@zugfolge/economy";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AlphaWorldService,
  type AlphaWorldBlueprint,
  type WorldStartPort,
} from "./world.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000014";

function blueprint(): AlphaWorldBlueprint {
  return {
    schemaVersion: "zugfolge-alpha-world-blueprint/v1",
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    seed: 42n,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 6,
    releases: {
      infra: "a".repeat(64),
      timetable: "b".repeat(64),
      fleet: "c".repeat(64),
      economy: "d".repeat(64),
    },
    lots: [{
      lotId: "lot-1",
      contractEndsAtPeriod: 2,
      trainRunIds: ["train-1"],
      pathReceiptIds: ["path-1"],
      vehicleIds: ["vehicle-1"],
      personnelDutyIds: ["duty-1"],
      circulationIds: ["circulation-1"],
      operatingProgramIds: ["program-1"],
    }],
    conflictCheckHash: "e".repeat(64),
    tenderCalendarHash: "f".repeat(64),
  };
}

describe("AlphaWorldService", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({
      id: WORLD_ID,
      name: "Alpha",
      schedulePeriodWeeks: 4,
      epoch: new Date(0),
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
  });

  afterEach(async () => client.close());

  it("persistiert den BigInt-Seed JSONB-sicher und startet idempotent", async () => {
    const port: WorldStartPort = {
      initializeEconomy: async () => {},
      initializeFleet: async () => {},
      initializeRegionalSimulation: async () => {},
      verify: async () => ({
        economyReady: true,
        fleetReady: true,
        regionalSimulationReady: true,
        livemapReady: true,
        operationsCenterReady: true,
        odooProjectionQueued: true,
        lotIds: ["lot-1"],
        runningTrainRunIds: ["train-1"],
      }),
    };
    const service = new AlphaWorldService(db, port);
    const expected = blueprint();

    const first = await service.start(WORLD_ID, expected, 0);
    const second = await service.start(WORLD_ID, expected, 0);
    const [stored] = await db.select().from(alphaWorldProfiles);

    expect(first.state).toBe("running");
    expect(second.blueprintHash).toBe(first.blueprintHash);
    expect(stored).toBeDefined();
    expect(decodeEconomyValue(stored?.blueprint)).toEqual(expected);
    expect(() => JSON.stringify(stored?.blueprint)).not.toThrow();
  });
});
