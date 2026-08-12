import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";

import { createDatabaseHealthCheck } from "./health.js";
import { MIGRATIONS_FOLDER } from "./migrations.js";
import { accounts, operators, worlds } from "./schema/index.js";
import * as schema from "./schema/index.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];

describe.skipIf(databaseUrl === undefined)("real PostgreSQL integration", () => {
  const client = postgres(databaseUrl ?? "postgres://invalid", { max: 4 });
  const db = drizzle(client, { schema });

  beforeAll(async () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }), 60_000);
  afterAll(async () => client.end());

  it("applies every migration and reports the real server ready", async () => {
    await expect(createDatabaseHealthCheck(db).check()).resolves.toEqual({ status: "ok", code: "schema_current" });
    const [version] = await client<{ version: string }[]>`select version()`;
    expect(version?.version).toMatch(/^PostgreSQL 1[6-9]\./);
  });

  it("enforces composite world isolation in PostgreSQL itself", async () => {
    await client`delete from accounts where world_id in (select id from worlds where name in ('PG A', 'PG B'))`;
    await client`delete from worlds where name in ('PG A', 'PG B')`;
    const [worldA, worldB] = await db.insert(worlds).values([
      { name: "PG A", epoch: new Date("2026-08-11T00:00:00Z"), schedulePeriodWeeks: 3 },
      { name: "PG B", epoch: new Date("2026-08-11T00:00:00Z"), schedulePeriodWeeks: 3 },
    ]).returning();
    const [account] = await db.insert(accounts).values({
      worldId: worldA!.id,
      keycloakSubject: "postgres-integration",
      displayName: "Postgres Integration",
    }).returning();

    await expect(db.insert(operators).values({
      worldId: worldB!.id,
      foundingAccountId: account!.id,
      name: "World leak",
    })).rejects.toMatchObject({ cause: { code: "23503", constraint_name: "operators_world_account_fk" } });

    await db.delete(accounts).where(eq(accounts.id, account!.id));
    await db.delete(worlds).where(eq(worlds.id, worldB!.id));
    await db.delete(worlds).where(eq(worlds.id, worldA!.id));
  });
});
