import { PGlite } from "@electric-sql/pglite";
import {
  MIGRATIONS_FOLDER,
  accounts,
  alphaWorldProfiles,
  gameAdminRequests,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  odooCommandQueue,
  operators,
  worldArchives,
  worldFinalRankings,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { and, eq } from "drizzle-orm";
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
});

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

async function closeRequest(worldId: string) {
  const [queue] = await db.insert(odooCommandQueue).values({
    eventId: `world-close-${worldId}`, worldId, commandType: "admin.world_close", actorReference: "odoo",
    payload: {}, correlationId: `close-${worldId}`, status: "accepted", receivedAt: EPOCH,
  }).returning();
  const [request] = await db.insert(gameAdminRequests).values({
    worldId, commandId: queue!.id, actionType: "world_close", riskClass: "high", requesterReference: "one",
    approverReference: "two", reason: "Geplanter Abschluss", effectPreview: {}, state: "approved", correlationId: queue!.correlationId,
  }).returning();
  return request!;
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
    await expect(service.beginClosure(id, 10)).resolves.toMatchObject({ state: "closing", closingAtS: 10 });
    const closed = await service.finalize(id, 20);
    expect(closed.finalStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(closed.rankings.map((entry) => entry.rankingType))).toEqual(new Set(["reliability", "passenger-service", "economy", "resilience", "cooperation"]));
    expect(closed.rankings.filter((entry) => entry.rankingType === "economy")).toEqual([
      expect.objectContaining({ operatorId: operator.id, rank: 1, score: 12_345n }),
      expect.objectContaining({ operatorId: expect.any(String), rank: 2, score: 5_000n }),
      expect.objectContaining({ operatorId: expect.any(String), rank: 2, score: 5_000n }),
    ]);
    expect(await db.select().from(worldFinalRankings).where(eq(worldFinalRankings.worldId, id))).toHaveLength(15);
    expect(await db.select().from(worldArchives).where(eq(worldArchives.worldId, id))).toHaveLength(3);
    expect(account.worldId).toBe(id);
    await expect(service.exportReplay(id, "world-participant")).resolves.toMatchObject({ worldId: id, stateHash: closed.finalStateHash, replayHash: closed.replayHash });
    await expect(service.exportReplay(id, "anonymous")).rejects.toThrow(/Rolle/);
  });

  it("sperrt ein langes Profil vor der letzten Periode und erlaubt danach den regulaeren Abschluss", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await world(id, 4, 2);
    const service = new WorldEndService(db);
    await expect(service.beginClosure(id, 10)).rejects.toThrow(/letzten Periode/);
    await db.update(alphaWorldProfiles).set({ currentPeriod: 3 }).where(eq(alphaWorldProfiles.worldId, id));
    await expect(service.beginClosure(id, 11)).resolves.toMatchObject({ state: "closing" });
  });

  it("laesst ein unbefristetes Profil nur nach freigegebenem Odoo-Vier-Augen-Antrag enden", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    await world(id, null, 7);
    const service = new WorldEndService(db);
    await expect(service.beginClosure(id, 10)).rejects.toThrow(/Odoo/);
    const request = await closeRequest(id);
    await expect(service.beginClosure(id, 10, request.id)).resolves.toMatchObject({ state: "closing" });
    const [stored] = await db.select().from(alphaWorldProfiles).where(and(eq(alphaWorldProfiles.worldId, id), eq(alphaWorldProfiles.state, "closing")));
    expect(stored?.closingAtS).toBe(10);
  });
});
