import postgres from "postgres";
import {
  accountRoles,
  accounts,
  alphaWorldProfiles,
  MIGRATIONS_FOLDER,
  worldAccesses,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import {
  validateWorldBlueprint,
  type AlphaWorldBlueprint,
} from "@zugfolge/alpha";
import { encodeEconomyValue } from "@zugfolge/economy";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const WORLD_A = "8a55a001-0000-4000-8000-000000000001";
const WORLD_B = "8a55a001-0000-4000-8000-000000000002";
const SUBJECT = "postgres-parallel-public-slot";

const BLUEPRINT: AlphaWorldBlueprint = {
  schemaVersion: "zugfolge-alpha-world-blueprint/v1",
  regionId: "mitteldeutschland-b",
  regionVariant: "B",
  seed: 8_551n,
  profileKind: "public",
  accelerationFactor: 1,
  periodCount: 10,
  startingCapitalPolicy: { kind: "finite", amountCents: "0" },
  releases: {
    infra: "a".repeat(64),
    timetable: "b".repeat(64),
    fleet: "c".repeat(64),
    economy: "d".repeat(64),
  },
  lots: [{
    lotId: "slot-race-lot",
    contractEndsAtPeriod: 2,
    trainRunIds: ["slot-race-train"],
    pathReceiptIds: ["slot-race-path"],
    vehicleIds: ["slot-race-vehicle"],
    personnelDutyIds: ["slot-race-duty"],
    circulationIds: ["slot-race-circulation"],
    operatingProgramIds: ["slot-race-program"],
  }],
  conflictCheckHash: "e".repeat(64),
  tenderCalendarHash: "f".repeat(64),
};
const CONTRACT_HASH = validateWorldBlueprint(BLUEPRINT);

describe.skipIf(databaseUrl === undefined)("oeffentlicher Weltplatz auf echtem PostgreSQL", () => {
  const client = postgres(databaseUrl ?? "postgres://invalid", { max: 4 });
  const db = drizzle(client, { schema });
  let app: FastifyInstance;

  async function cleanFixture(): Promise<void> {
    await db.delete(accountRoles).where(inArray(accountRoles.worldId, [WORLD_A, WORLD_B]));
    await db.delete(accounts).where(inArray(accounts.worldId, [WORLD_A, WORLD_B]));
    await db.delete(worldAccesses).where(inArray(worldAccesses.worldId, [WORLD_A, WORLD_B]));
    await db.delete(alphaWorldProfiles).where(inArray(alphaWorldProfiles.worldId, [WORLD_A, WORLD_B]));
    await db.delete(worlds).where(inArray(worlds.id, [WORLD_A, WORLD_B]));
  }

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await cleanFixture();
    await db.insert(worlds).values([
      {
        id: WORLD_A,
        name: "Slot-Race A",
        schedulePeriodWeeks: 4,
        epoch: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: WORLD_B,
        name: "Slot-Race B",
        schedulePeriodWeeks: 4,
        epoch: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    await db.insert(alphaWorldProfiles).values([WORLD_A, WORLD_B].map((worldId) => ({
      worldId,
      profileKind: "public" as const,
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 8_551n,
      accelerationFactor: 1,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: encodeEconomyValue(BLUEPRINT),
      blueprintHash: CONTRACT_HASH,
      periodCount: 10,
      state: "running" as const,
      startedAtS: 0,
    })));

    // Ohne die subject-weite Transaktion sehen beide Requests vor diesem
    // absichtlichen Insert-Fenster den Zaehler 0 und legen je einen Zugang an.
    await client.unsafe("drop trigger if exists zugfolge_test_delay_parallel_slot on world_accesses");
    await client.unsafe("drop function if exists zugfolge_test_delay_parallel_slot()");
    await client.unsafe(`
      create or replace function zugfolge_test_delay_parallel_slot()
      returns trigger language plpgsql as $$
      begin
        if new.keycloak_subject = '${SUBJECT}' then
          perform pg_sleep(0.25);
        end if;
        return new;
      end
      $$
    `);
    await client.unsafe(`
      create trigger zugfolge_test_delay_parallel_slot
      before insert on world_accesses
      for each row execute function zugfolge_test_delay_parallel_slot()
    `);

    app = buildApp({
      db,
      verifyToken: async (token) => ({
        keycloakSubject: token,
        displayName: "Postgres Slot Race",
      }),
      logger: false,
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await client.unsafe("drop trigger if exists zugfolge_test_delay_parallel_slot on world_accesses");
    await client.unsafe("drop function if exists zugfolge_test_delay_parallel_slot()");
    await cleanFixture();
    await client.end();
  });

  it("laesst bei Limit 1 von zwei parallelen Welten exakt eine atomar gewinnen", async () => {
    const enter = (worldId: string) => app.inject({
      method: "POST",
      url: `/worlds/${worldId}/access`,
      headers: { authorization: `Bearer ${SUBJECT}` },
      payload: {
        displayName: "Postgres Slot Race",
        acceptedWorldContractHash: CONTRACT_HASH,
      },
    });

    const [first, second] = await Promise.all([enter(WORLD_A), enter(WORLD_B)]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 403]);
    const accesses = await db
      .select({ worldId: worldAccesses.worldId })
      .from(worldAccesses)
      .where(and(
        eq(worldAccesses.keycloakSubject, SUBJECT),
        eq(worldAccesses.status, "active"),
      ));
    expect(accesses).toHaveLength(1);

    const winner = accesses[0]!.worldId;
    const replay = await enter(winner);
    expect(replay.statusCode).toBe(201);
    await expect(db
      .select({ worldId: worldAccesses.worldId })
      .from(worldAccesses)
      .where(and(
        eq(worldAccesses.keycloakSubject, SUBJECT),
        eq(worldAccesses.status, "active"),
      )))
      .resolves.toEqual([{ worldId: winner }]);
  });
});
