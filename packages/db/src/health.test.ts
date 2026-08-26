import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseHealthCheck, createEconomyOutboxHealthCheck, createEventLogHealthCheck } from "./health.js";
import { MIGRATIONS_FOLDER } from "./migrations.js";
import * as schema from "./schema/index.js";
import { domainEvents, economyOutbox, worlds } from "./schema/index.js";

const WORLD_ID = "44444444-4444-4444-4444-444444444444";

describe("createDatabaseHealthCheck", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(async () => {
    if (!client.closed) {
      await client.close();
    }
  });

  it("meldet 'ok', solange die Verbindung eine Abfrage beantwortet", async () => {
    const outcome = await createDatabaseHealthCheck(db).check();
    expect(outcome).toEqual({ status: "ok", code: "schema_current" });
  });

  it("wirft, wenn die Verbindung bereits geschlossen ist — die Registry fängt das auf", async () => {
    await client.close();
    await expect(createDatabaseHealthCheck(db).check()).rejects.toThrow();
  });

  it("meldet ein nicht migriertes Schema nicht als bereit", async () => {
    const emptyClient = new PGlite();
    const emptyDb = drizzle(emptyClient, { schema });
    try {
      await expect(createDatabaseHealthCheck(emptyDb).check()).rejects.toThrow();
    } finally {
      await emptyClient.close();
    }
  });

  it("unterscheidet idle, aktuellen und festhängenden Betriebsfortschritt", async () => {
    expect(await createEventLogHealthCheck(db, 1_000, () => 10_000).check()).toMatchObject({ code: "event_log_idle" });
    expect(await createEconomyOutboxHealthCheck(db, 1_000, () => 10_000).check()).toMatchObject({ code: "outbox_empty" });
    await db.insert(worlds).values({ id: WORLD_ID, name: "Health", schedulePeriodWeeks: 3, epoch: new Date(0) });
    await db.insert(domainEvents).values({ worldId: WORLD_ID, sequence: 1, eventType: "tick", payload: {}, occurredAt: new Date(9_500) });
    expect(await createEventLogHealthCheck(db, 1_000, () => 10_000).check()).toMatchObject({ status: "ok", code: "event_log_current" });
    expect(await createEventLogHealthCheck(db, 1_000, () => 12_000).check()).toEqual({ status: "ok", code: "event_log_idle" });
    await db.insert(economyOutbox).values({ worldId: WORLD_ID, effectId: "x", effectType: "notice", payload: {}, occurredAt: new Date(0), enqueuedAt: new Date(1_000) });
    expect(await createEconomyOutboxHealthCheck(db, 1_000, () => 10_000).check()).toMatchObject({ status: "degraded", code: "outbox_stalled" });
    await db.update(economyOutbox).set({ attempts: 3, lastErrorCode: "adapter_failed" }).where(eq(economyOutbox.worldId, WORLD_ID));
    expect(await createEconomyOutboxHealthCheck(db, 1_000, () => 10_000).check()).toMatchObject({ status: "down", code: "outbox_failures" });
  });
});
