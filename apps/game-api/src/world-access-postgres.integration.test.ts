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
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const WORLD_A = "8a55a001-0000-4000-8000-000000000001";
const SUBJECT = "postgres-parallel-access";

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
    lotId: "access-race-lot",
    contractEndsAtPeriod: 2,
    trainRunIds: ["access-race-train"],
    pathReceiptIds: ["access-race-path"],
    vehicleIds: ["access-race-vehicle"],
    personnelDutyIds: ["access-race-duty"],
    circulationIds: ["access-race-circulation"],
    operatingProgramIds: ["access-race-program"],
  }],
  conflictCheckHash: "e".repeat(64),
  tenderCalendarHash: "f".repeat(64),
};
const CONTRACT_HASH = validateWorldBlueprint(BLUEPRINT);

describe.skipIf(databaseUrl === undefined)("idempotenter Weltzugang auf echtem PostgreSQL", () => {
  const client = postgres(databaseUrl ?? "postgres://invalid", { max: 4 });
  const db = drizzle(client, { schema });
  let app: FastifyInstance;

  async function cleanFixture(): Promise<void> {
    await db.transaction(async (tx) => {
      // Der No-Wipe-Guard muss produktiv auch DELETE auf gestarteten Profilen
      // verhindern. Nur diese abgeschlossene Testtransaktion darf ihre
      // fest benannten Fixtures deshalb ohne Triggerwirkung entfernen.
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.delete(accountRoles).where(inArray(accountRoles.worldId, [WORLD_A]));
      await tx.delete(accounts).where(inArray(accounts.worldId, [WORLD_A]));
      await tx.delete(worldAccesses).where(inArray(worldAccesses.worldId, [WORLD_A]));
      await tx.delete(alphaWorldProfiles).where(inArray(alphaWorldProfiles.worldId, [WORLD_A]));
      await tx.delete(worlds).where(inArray(worlds.id, [WORLD_A]));
    });
  }

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await cleanFixture();
    await db.insert(worlds).values([
      {
        id: WORLD_A,
        name: "Zugangstest",
        schedulePeriodWeeks: 4,
        epoch: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    await db.insert(alphaWorldProfiles).values([WORLD_A].map((worldId) => ({
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

    // Das Insert-Fenster provoziert konkurrierende Wiederholungen derselben Anmeldung.
    await client.unsafe("drop trigger if exists zugfolge_test_delay_parallel_access on world_accesses");
    await client.unsafe("drop function if exists zugfolge_test_delay_parallel_access()");
    await client.unsafe(`
      create or replace function zugfolge_test_delay_parallel_access()
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
      create trigger zugfolge_test_delay_parallel_access
      before insert on world_accesses
      for each row execute function zugfolge_test_delay_parallel_access()
    `);

    app = buildApp({
      db,
      verifyToken: async (token) => ({
        keycloakSubject: token,
        displayName: "Postgres Zugang",
      }),
      logger: false,
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await client.unsafe("drop trigger if exists zugfolge_test_delay_parallel_access on world_accesses");
    await client.unsafe("drop function if exists zugfolge_test_delay_parallel_access()");
    await cleanFixture();
    await client.end();
  });

  it("legt bei parallelen Wiederholungen genau einen Zugang an", async () => {
    const enter = (worldId: string) => app.inject({
      method: "POST",
      url: `/worlds/${worldId}/access`,
      headers: { authorization: `Bearer ${SUBJECT}` },
      payload: {
        displayName: "Postgres Zugang",
        acceptedWorldContractHash: CONTRACT_HASH,
      },
    });

    const [first, second] = await Promise.all([enter(WORLD_A), enter(WORLD_A)]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 201]);
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
