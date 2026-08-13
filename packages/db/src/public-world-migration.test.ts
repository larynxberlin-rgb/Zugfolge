import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "./schema/index.js";
import { MIGRATIONS_FOLDER } from "./migrations.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-13T06:00:00Z");
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(schema.worlds).values({ id: WORLD, name: "LHE", schedulePeriodWeeks: 4, epoch: NOW });
});
afterEach(async () => client.close());

describe("Migration 0024 Odoo-Weltauswahl", () => {
  it("backfillt bestehende EVU sicher als aktive Spieler-EVU", async () => {
    const [account] = await db.insert(schema.accounts).values({ worldId: WORLD, keycloakSubject: "kc", displayName: "Spieler" }).returning();
    const [operator] = await db.insert(schema.operators).values({ worldId: WORLD, foundingAccountId: account!.id, name: "EVU" }).returning();
    expect(operator).toMatchObject({ operatorKind: "player", lifecycle: "active" });
  });

  it("erzwingt fachliche Queue-Idempotenz auch bei neuer Event-ID", async () => {
    const base = {
      worldId: WORLD, commandType: "world.participation.change", idempotencyKey: "payment-1:provision",
      actorReference: "commerce-service", payload: {}, correlationId: "correlation", status: "pending" as const, receivedAt: NOW,
    };
    await db.insert(schema.odooCommandQueue).values({ ...base, eventId: "event-a" });
    await expect(db.insert(schema.odooCommandQueue).values({ ...base, eventId: "event-b" })).rejects.toThrow();
  });
});
