import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { gameAdminRequests, MIGRATIONS_FOLDER, odooCommandQueue, odooProjectionOutbox, odooWebhookReceipts, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOdooWebhookReceiptStore, DEMAND_DATA_UPDATE_MAX_BYTES, processNextOdooCommand, receiveOdooWebhook, signPayload,
  validateDemandDataUpdate, WebhookSignatureError, type DemandDataUpdatePayload, type OdooWebhookEnvelope, type SigningKey } from "./index.js";

const NOW = new Date("2026-09-06T10:00:00Z");
const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER_WORLD = "22222222-2222-4222-8222-222222222222";
const KEY: SigningKey = { id: "demand-data-test", secret: "test-demand-data-hmac-secret", activeFrom: new Date("2026-01-01T00:00:00Z") };
const SOURCE_RELEASE = JSON.parse(readFileSync(new URL("../../../tools/population-demand/example/release.json", import.meta.url), "utf8")) as {
  readonly id: string; readonly populationModel: Readonly<Record<string, unknown>>;
  readonly zones: readonly { readonly id: string; readonly population: number }[];
};

function payload(): DemandDataUpdatePayload {
  return { kind: "demand.data.update", schemaVersion: "zugfolge-demand-data-update/v1", worldId: WORLD,
    baseReleaseId: SOURCE_RELEASE.id, sourceRevision: 1, populationModel: structuredClone(SOURCE_RELEASE.populationModel),
    zonePopulations: SOURCE_RELEASE.zones.map((zone) => ({ zoneId: zone.id, population: zone.population })) };
}

function envelope(eventId = "demand-data-event-0001"): OdooWebhookEnvelope {
  return { schemaVersion: "zugfolge-odoo/v1", eventId, eventType: "commerce.command", occurredAt: NOW.toISOString(),
    correlationId: `correlation-${eventId}`, tenantId: "demand-test", actorReference: "odoo-demand-editor", command: payload() };
}

const OPTIONS = { tenantId: "demand-test", keys: [KEY], authorizedActors: { "odoo-demand-editor": ["demand.data.update"] },
  assertWorldScope(worldId: string) { if (worldId !== WORLD) throw new Error("Foreign world"); } };

describe("bounded demand data transport", () => {
  it("validates the actual population model and rejects freeform or unsafe fields", () => {
    expect(() => validateDemandDataUpdate(payload())).not.toThrow();
    const invalid: unknown[] = [
      { ...payload(), sourceRevision: 1.5 }, { ...payload(), sourceRevision: 0 }, { ...payload(), sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload(), worldId: "not-a-world" }, { ...payload(), approverReference: "unneeded-approval" },
      { ...payload(), zonePopulations: [{ zoneId: "a", population: -1 }, { zoneId: "b", population: 1 }] },
      { ...payload(), populationModel: { ...SOURCE_RELEASE.populationModel, schemaVersion: "unknown" } },
      { ...payload(), baseReleaseId: "x".repeat(DEMAND_DATA_UPDATE_MAX_BYTES + 1) },
    ];
    let deep: unknown = 1;
    for (let index = 0; index < 18; index += 1) deep = { nested: deep };
    invalid.push({ ...payload(), populationModel: deep });
    for (const value of invalid) expect(() => validateDemandDataUpdate(value)).toThrow();
  });
});

describe("signed normal demand data saves", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeEach(async () => {
    client = new PGlite(); db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([
      { id: WORLD, name: "Before", schedulePeriodWeeks: 4, epoch: NOW },
      { id: OTHER_WORLD, name: "Other", schedulePeriodWeeks: 4, epoch: NOW },
    ]);
  }, 30_000);
  afterEach(async () => client.close());
  const queue = async (db: ReturnType<typeof drizzle<typeof schema>>, value = envelope()) => receiveOdooWebhook(
    createOdooWebhookReceiptStore(db), signPayload(value, KEY, NOW), OPTIONS, NOW);

  it("requires the HMAC, explicit actor capability and correct world before queuing", async () => {
    const signed = signPayload(envelope(), KEY, NOW);
    await expect(receiveOdooWebhook(createOdooWebhookReceiptStore(db), { ...signed, signature: "0".repeat(64) }, OPTIONS, NOW)).rejects.toBeInstanceOf(WebhookSignatureError);
    const wrongActor = { ...envelope(), actorReference: "commerce-service" };
    await expect(queue(db, wrongActor)).rejects.toMatchObject({ code: "authorization" });
    const foreign = { ...envelope(), command: { ...payload(), worldId: OTHER_WORLD } };
    await expect(queue(db, foreign)).rejects.toMatchObject({ code: "world_scope" });
    expect(await db.select().from(odooCommandQueue)).toHaveLength(0);
    expect(await db.select().from(odooWebhookReceipts)).toHaveLength(0);
  });

  it("commits the handler effect, queue completion and minimal private result together exactly once", async () => {
    expect(await queue(db)).toMatchObject({ accepted: true, duplicate: false });
    let calls = 0;
    const processing = { assertWorldScope: OPTIONS.assertWorldScope, demandDataHandler: async (context: import("./demand-data.js").DemandDataCommandContext) => {
      calls += 1;
      expect(context.db).not.toBe(db);
      expect(context.payload).toEqual(payload());
      expect(context.eventId).toBe(envelope().eventId);
      expect(context.correlationId).toBe(envelope().correlationId);
      expect(context.now).toEqual(NOW); expect(context.receivedAt).toEqual(NOW);
      const [claim] = await context.db.select().from(odooCommandQueue).where(eq(odooCommandQueue.worldId, WORLD));
      expect(claim).toMatchObject({ status: "processing" });
      await context.db.update(worlds).set({ name: "Saved atomically" }).where(eq(worlds.id, WORLD));
      return { outcome: "accepted" as const };
    } };
    await expect(processNextOdooCommand(db, NOW, processing)).resolves.toMatchObject({ outcome: "accepted" });
    expect(await queue(db)).toMatchObject({ accepted: true, duplicate: true });
    expect(await processNextOdooCommand(db, NOW, processing)).toBeUndefined();
    expect(calls).toBe(1);
    const [world] = await db.select().from(worlds).where(eq(worlds.id, WORLD));
    expect(world?.name).toBe("Saved atomically");
    expect(await db.select().from(gameAdminRequests)).toHaveLength(0);
    const rows = await db.select().from(odooProjectionOutbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ worldId: WORLD, messageType: "demand.data.result", correlationId: envelope().correlationId,
      payload: { baseReleaseId: SOURCE_RELEASE.id, sourceRevision: 1, outcome: "accepted" } });
    expect(Object.keys(rows[0]!.payload as object).sort()).toEqual(["baseReleaseId", "outcome", "sourceRevision"]);
    const changed = { ...envelope(), command: { ...payload(), sourceRevision: 2 } };
    await expect(queue(db, changed)).rejects.toMatchObject({ code: "command" });
  });

  it("returns a domain rejection without an admin approval request or model disclosure", async () => {
    await queue(db);
    await expect(processNextOdooCommand(db, NOW, { demandDataHandler: () => ({ outcome: "rejected", code: "stale_revision", detail: "Eine neuere Datenrevision ist bereits gespeichert." }) }))
      .resolves.toMatchObject({ outcome: "rejected", code: "stale_revision" });
    const [claim] = await db.select().from(odooCommandQueue);
    expect(claim).toMatchObject({ status: "rejected", claimToken: null, failureCode: "stale_revision" });
    const [reply] = await db.select().from(odooProjectionOutbox);
    expect(reply).toMatchObject({ messageType: "demand.data.result", payload: { outcome: "rejected", code: "stale_revision" } });
    expect(reply?.payload).not.toHaveProperty("populationModel");
    expect(await db.select().from(gameAdminRequests)).toHaveLength(0);
  });

  it("holds the queue claim through the transaction even when a second worker sees an expired lease", async () => {
    await queue(db);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const first = processNextOdooCommand(db, NOW, { claimLeaseMs: 1000, demandDataHandler: async () => {
      calls += 1; entered(); await gate; return { outcome: "accepted" };
    } });
    await started;
    const second = processNextOdooCommand(db, new Date(NOW.getTime() + 2000), { claimLeaseMs: 1000, demandDataHandler: () => {
      calls += 1; return { outcome: "accepted" };
    } });
    release();
    expect(await first).toMatchObject({ outcome: "accepted" });
    expect(await second).toBeUndefined();
    expect(calls).toBe(1);
    expect(await db.select().from(odooProjectionOutbox)).toHaveLength(1);
  });

  it("rolls back a completed callback when the result write fails and retries the whole transaction", async () => {
    await queue(db);
    await client.exec("alter table odoo_projection_outbox add constraint test_demand_result_failure check (message_type <> 'demand.data.result')");
    let calls = 0;
    const options = { demandDataHandler: async ({ db: tx }: import("./demand-data.js").DemandDataCommandContext) => {
      calls += 1;
      await tx.update(worlds).set({ name: "Transactional effect" }).where(eq(worlds.id, WORLD));
      return { outcome: "accepted" as const };
    } };
    await expect(processNextOdooCommand(db, NOW, options)).rejects.toThrow();
    const [world] = await db.select().from(worlds).where(eq(worlds.id, WORLD));
    expect(world?.name).toBe("Before");
    const [claim] = await db.select().from(odooCommandQueue);
    expect(claim).toMatchObject({ status: "pending", claimToken: null, processedAt: null });
    expect(await db.select().from(odooProjectionOutbox)).toHaveLength(0);
    await client.exec("alter table odoo_projection_outbox drop constraint test_demand_result_failure");
    await expect(processNextOdooCommand(db, NOW, options)).resolves.toMatchObject({ outcome: "accepted" });
    expect(calls).toBe(2);
    expect(await db.select().from(odooProjectionOutbox)).toHaveLength(1);
  });

  it("retries technical handler failure but never calls a handler for historical foreign-world commands", async () => {
    await queue(db);
    await expect(processNextOdooCommand(db, NOW, { demandDataHandler: async ({ db: tx }) => {
      await tx.update(worlds).set({ name: "Must roll back" }).where(eq(worlds.id, WORLD));
      throw new Error("Temporary store failure");
    } })).rejects.toThrow("Temporary store failure");
    expect((await db.select().from(worlds).where(eq(worlds.id, WORLD)))[0]?.name).toBe("Before");
    let calls = 0;
    await expect(processNextOdooCommand(db, NOW, { assertWorldScope() { throw new Error("wrong host"); }, demandDataHandler() { calls += 1; return { outcome: "accepted" }; } }))
      .resolves.toMatchObject({ outcome: "rejected" });
    expect(calls).toBe(0);
    expect(await db.select().from(odooProjectionOutbox)).toHaveLength(0);
    expect((await db.select().from(odooCommandQueue))[0]).toMatchObject({ status: "rejected", failureCode: "world_scope" });
  });
});
