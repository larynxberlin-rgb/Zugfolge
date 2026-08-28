import { PGlite } from "@electric-sql/pglite";
import {
  MIGRATIONS_FOLDER,
  accounts,
  alphaWorldProfiles,
  domainEvents,
  gameAdminRequests,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  odooCommandQueue,
  odooProjectionOutbox,
  operators,
  worldArchives,
  worldFinalRankings,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorldEndService } from "./world-end.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const HASHES = { infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64), fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64), blueprintHash: "e".repeat(64) };

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 30_000);

afterEach(async () => client.close());

async function world(id: string, periodCount: number | null, currentPeriod: number) {
  await db.insert(worlds).values({ id, name: `Welt ${id.slice(0, 4)}`, schedulePeriodWeeks: periodCount === 1 ? 3 : 5, epoch: EPOCH });
  const [account] = await db.insert(accounts).values({ worldId: id, keycloakSubject: `subject-${id}`, displayName: "Alpha" }).returning();
  const [operator] = await db.insert(operators).values({ worldId: id, foundingAccountId: account!.id, name: `EVU ${id.slice(0, 4)}` }).returning();
  await db.insert(alphaWorldProfiles).values({
    worldId: id, profileKind: "public", regionId: "mitteldeutschland-b", regionVariant: "B", worldSeed: 7n,
    accelerationFactor: 1, ...HASHES, blueprint: { region: "B" }, periodCount, currentPeriod, state: "running", startedAtS: 0,
  });
  return { account: account!, operator: operator! };
}

async function closeRequest(worldId: string, atS: number) {
  const [queue] = await db.insert(odooCommandQueue).values({
    eventId: `world-close-${worldId}`, worldId, commandType: "admin.world_close", actorReference: "odoo",
    payload: { kind: "admin.world_close", actionType: "world_close", riskClass: "high", worldId, requestedAtS: atS },
    correlationId: `close-${worldId}`, status: "processing", receivedAt: EPOCH,
  }).returning();
  const [request] = await db.insert(gameAdminRequests).values({
    worldId, commandId: queue!.id, actionType: "world_close", riskClass: "high", requesterReference: "one",
    approverReference: "two", reason: "Geplanter Abschluss", effectPreview: {}, state: "dispatched", correlationId: queue!.correlationId,
  }).returning();
  return { queue: queue!, request: request! };
}

async function closeWorld(
  service: WorldEndService,
  worldId: string,
  atS: number,
  approval: Awaited<ReturnType<typeof closeRequest>>,
) {
  return db.transaction((tx) => service.close({
    db: tx,
    worldId,
    atS,
    adminRequestId: approval.request.id,
    beforeSeal: async (closed) => {
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
        .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      const effectAuditReference = `world-close:${worldId}:${closed.finalStateHash}`;
      const [audit] = await tx.insert(domainEvents).values({
        worldId,
        sequence: (head?.sequence ?? 0) + 1,
        eventType: "admin.action-audited",
        payload: {
          adminRequestId: approval.request.id,
          actionType: "world_close",
          riskClass: "high",
          correlationId: approval.queue.correlationId,
          outcome: "completed",
          effectAuditReference,
        },
        occurredAt: EPOCH,
      }).returning({ id: domainEvents.id });
      await tx.update(gameAdminRequests).set({
        state: "completed",
        gameAuditEventId: audit!.id,
        changedAt: EPOCH,
      }).where(and(
        eq(gameAdminRequests.worldId, worldId),
        eq(gameAdminRequests.id, approval.request.id),
      ));
      await tx.update(odooCommandQueue).set({ status: "completed", processedAt: EPOCH })
        .where(eq(odooCommandQueue.id, approval.queue.id));
      await tx.insert(odooProjectionOutbox).values({
        worldId: "00000000-0000-0000-0000-000000000000",
        messageType: "admin.command.result",
        schemaVersion: "zugfolge-odoo/v1",
        correlationId: approval.queue.correlationId,
        payload: {
          finalStateHash: closed.finalStateHash,
          evidenceHash: closed.evidenceHash,
          replayHash: closed.replayHash,
          archivedAtS: atS,
          eventId: approval.queue.eventId,
          outcome: "accepted",
          state: "completed",
          authoritative: true,
          projectionScope: "global-admin",
          actionType: "world_close",
          targetWorldId: worldId,
          adminRequestId: approval.request.id,
          gameAuditEventId: audit!.id,
          effectAuditReference,
        },
        occurredAt: EPOCH,
        enqueuedAt: EPOCH,
      });
    },
  }));
}

describe("M9.8 Weltende", () => {
  it("archiviert ein kurzes Profil mit fachlichem Wirtschaftsrang, echten Gleichstaenden und unveraenderlichem Replay", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { operator, account } = await world(id, 1, 0);
    const [secondAccount, thirdAccount] = await db.insert(accounts).values([
      { worldId: id, keycloakSubject: "subject-second", displayName: "Beta" },
      { worldId: id, keycloakSubject: "subject-third", displayName: "Gamma" },
    ]).returning();
    const [second, third] = await db.insert(operators).values([
      { worldId: id, foundingAccountId: secondAccount!.id, name: "EVU Beta" },
      { worldId: id, foundingAccountId: thirdAccount!.id, name: "EVU Gamma" },
    ]).returning();
    const postResult = async (operatorId: string, revenueCents: bigint, costCents: bigint, financingCents = 0n) => {
      const [cash, revenue, costs, financing] = await db.insert(ledgerAccounts).values([
        { worldId: id, operatorId, name: "Economy:Kasse" },
        { worldId: id, operatorId, name: "Economy:Bestellerentgelt" },
        { worldId: id, operatorId, name: "Economy:energy" },
        { worldId: id, operatorId, name: "Finanzierung:Kredit" },
      ]).returning();
      const [transaction] = await db.insert(ledgerTransactions).values({ worldId: id, operatorId, description: "Ergebnis", postedAt: EPOCH }).returning();
      await db.insert(ledgerEntries).values([
        { worldId: id, transactionId: transaction!.id, ledgerAccountId: cash!.id, amountCents: revenueCents - costCents + financingCents },
        { worldId: id, transactionId: transaction!.id, ledgerAccountId: revenue!.id, amountCents: -revenueCents },
        { worldId: id, transactionId: transaction!.id, ledgerAccountId: costs!.id, amountCents: costCents },
        { worldId: id, transactionId: transaction!.id, ledgerAccountId: financing!.id, amountCents: -financingCents },
      ]);
    };
    await postResult(operator.id, 20_000n, 7_655n);
    await postResult(second!.id, 8_000n, 3_000n, 1_000_000n);
    await postResult(third!.id, 12_000n, 7_000n);
    const service = new WorldEndService(db);
    const approval = await closeRequest(id, 20);
    const closed = await closeWorld(service, id, 20, approval);
    const retried = await closeWorld(service, id, 20, approval);
    expect(retried).toMatchObject({
      finalStateHash: closed.finalStateHash,
      evidenceHash: closed.evidenceHash,
      replayHash: closed.replayHash,
    });
    expect(closed.finalStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(closed.rankings.map((entry) => entry.rankingType))).toEqual(new Set(["reliability", "passenger-service", "economy", "resilience", "cooperation"]));
    expect(closed.rankings.filter((entry) => entry.rankingType === "economy")).toEqual([
      expect.objectContaining({ operatorId: operator.id, rank: 1, score: 12_345n }),
      expect.objectContaining({ operatorId: expect.any(String), rank: 2, score: 5_000n }),
      expect.objectContaining({ operatorId: expect.any(String), rank: 2, score: 5_000n }),
    ]);
    expect(await db.select().from(worldFinalRankings).where(eq(worldFinalRankings.worldId, id))).toHaveLength(15);
    expect(await db.select().from(worldArchives).where(eq(worldArchives.worldId, id))).toHaveLength(3);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, id))).toEqual([
      expect.objectContaining({ eventType: "alpha.world-archived", sequence: 1 }),
      expect.objectContaining({ eventType: "admin.action-audited", sequence: 2 }),
    ]);
    await expect(db.insert(domainEvents).values({
      worldId: id,
      sequence: 3,
      eventType: "alpha.after-archive",
      payload: {},
      occurredAt: EPOCH,
    })).rejects.toMatchObject({
      cause: { message: expect.stringContaining("world writer is fenced") },
    });
    expect(account.worldId).toBe(id);
    await expect(service.exportReplay(id, "world-participant")).resolves.toMatchObject({ worldId: id, stateHash: closed.finalStateHash, replayHash: closed.replayHash });
    await expect(service.exportReplay(id, "anonymous")).rejects.toThrow(/Rolle/);
    await expect(db.transaction((tx) => service.close({
      db: tx,
      worldId: id,
      atS: 20,
      adminRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      beforeSeal: async () => { throw new Error("Retry darf Callback nicht erreichen"); },
    }))).rejects.toThrow(/Odoo/);
  });

  it("sperrt ein langes Profil vor der letzten Periode und erlaubt danach den regulaeren Abschluss", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await world(id, 4, 2);
    const service = new WorldEndService(db);
    const approval = await closeRequest(id, 10);
    await expect(closeWorld(service, id, 10, approval)).rejects.toThrow(/letzten Periode/);
    await db.update(alphaWorldProfiles).set({ currentPeriod: 3 }).where(eq(alphaWorldProfiles.worldId, id));
    await expect(closeWorld(service, id, 10, approval)).resolves.toMatchObject({ finalStateHash: expect.any(String) });
  });

  it("laesst ein unbefristetes Profil nur nach freigegebenem Odoo-Vier-Augen-Antrag enden", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    await world(id, null, 7);
    const service = new WorldEndService(db);
    await expect(db.transaction((tx) => service.close({
      db: tx,
      worldId: id,
      atS: 10,
      adminRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      beforeSeal: async () => undefined,
    }))).rejects.toThrow(/Odoo/);
    const approval = await closeRequest(id, 10);
    await expect(closeWorld(service, id, 10, approval)).resolves.toMatchObject({ finalStateHash: expect.any(String) });
    const [stored] = await db.select().from(alphaWorldProfiles).where(and(
      eq(alphaWorldProfiles.worldId, id),
      eq(alphaWorldProfiles.state, "archived"),
    ));
    expect(stored).toMatchObject({ closingAtS: 10, archivedAtS: 10 });
  });

  it("rollt Ranking, Archiv und Closing-Zustand gemeinsam zurueck, wenn die Admin-Quittierung fehlt", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    await world(id, 1, 0);
    const approval = await closeRequest(id, 30);
    const service = new WorldEndService(db);

    await expect(db.transaction((tx) => service.close({
      db: tx,
      worldId: id,
      atS: 30,
      adminRequestId: approval.request.id,
      beforeSeal: async () => { throw new Error("Odoo-Projektion ausgefallen"); },
    }))).rejects.toThrow(/ausgefallen/);

    await expect(db.select({ state: alphaWorldProfiles.state, closingAtS: alphaWorldProfiles.closingAtS })
      .from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, id)))
      .resolves.toEqual([{ state: "running", closingAtS: null }]);
    await expect(db.select({ lifecycleStatus: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, id)))
      .resolves.toEqual([{ lifecycleStatus: "active" }]);
    await expect(db.select().from(worldFinalRankings).where(eq(worldFinalRankings.worldId, id))).resolves.toEqual([]);
    await expect(db.select().from(worldArchives).where(eq(worldArchives.worldId, id))).resolves.toEqual([]);
    await expect(db.select().from(domainEvents).where(eq(domainEvents.worldId, id))).resolves.toEqual([]);
  });
});
