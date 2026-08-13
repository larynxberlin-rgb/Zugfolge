import { PGlite } from "@electric-sql/pglite";
import { economyEffects, economyOutbox, ledgerEntries, MIGRATIONS_FOLDER, mailboxMessages, schema, worlds } from "@zugfolge/db";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import { foundOperator } from "@zugfolge/operators";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CostType } from "./finance.js";
import { ledgerAccountBalance, listLedgerTransactions, openLedgerAccount, type EconomyDatabase } from "./ledger.js";
import { createEconomyPlatformAdapters, STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN } from "./platform-adapters.js";
import { dispatchEconomyOutbox, encodeEconomyValue } from "./state-store.js";

const WORLD_ID = "11111111-1111-1111-1111-111111111111";
const COST_TYPES: readonly CostType[] = ["track", "station", "facility", "energy", "personnel", "administration", "vehicle", "penalty", "interest"];
let client: PGlite;
let db: EconomyDatabase;
let identityDb: IdentityDatabase;

beforeEach(async () => {
  client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb;
  identityDb = pgliteDb;
  await pgliteDb.insert(worlds).values({ id: WORLD_ID, name: "M6-Integration", schedulePeriodWeeks: 3, epoch: new Date("2026-01-01T00:00:00Z") });
});

afterEach(async () => client.close());

describe("M6-Plattformadapter", () => {
  it("bucht das Fachjournal doppelt und stellt die konkrete Postfachnachricht zu", async () => {
    const account = await requestWorldAccess(identityDb, { worldId: WORLD_ID, keycloakSubject: "kc-m6", displayName: "M6" });
    const operator = await foundOperator(identityDb, { worldId: WORLD_ID, foundingKeycloakSubject: "kc-m6", name: "M6-Bahn" });
    const cash = await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName });
    const revenue = await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.revenueAccountName });
    const costAccounts = Object.fromEntries(await Promise.all(COST_TYPES.map(async (type) => [type, (await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.costAccountNames[type] })).id]))) as Record<CostType, string>;
    const adapters = createEconomyPlatformAdapters({ db, accountsByOperator: { [operator.id]: { cashAccountId: cash.id, revenueAccountId: revenue.id, costAccountIds: costAccounts } } });

    await adapters.postJournal({ worldId: WORLD_ID, operatorId: operator.id, idempotencyKey: "settlement:1", at: 1_800_000_000, description: "Periodenabrechnung", revenueCents: 10_000n, postings: [{ amountCents: 2_000n, costType: "energy", costCentreId: "lot-1", reference: "period-1" }] });
    await adapters.sendNotice({ id: "insolvency:1:account", worldId: WORLD_ID, recipientAccountId: account.id, type: "insolvency-stage-1", at: 1_800_000_000, payload: { forecast: "negative" } });
    await adapters.sendNotice({ id: "insolvency:2:account", worldId: WORLD_ID, recipientAccountId: account.id, type: "insolvency-stage-1", at: 1_800_000_000, payload: { forecast: "still-negative" } });

    expect(await listLedgerTransactions(db, { worldId: WORLD_ID, operatorId: operator.id })).toHaveLength(1);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_ID, ledgerAccountId: cash.id })).toBe(8_000n);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_ID, ledgerAccountId: revenue.id })).toBe(-10_000n);
    const classifiedEntries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.worldId, WORLD_ID));
    expect(classifiedEntries).toContainEqual(expect.objectContaining({ costType: "energy", costCentreId: "lot-1" }));
    const messages = await db.select().from(mailboxMessages).where(eq(mailboxMessages.worldId, WORLD_ID));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ recipientAccountId: account.id, messageType: "insolvency-stage-1" });
    expect(messages[0]?.sentAt).toEqual(new Date(1_800_000_000 * 1_000));

    // Neustart: Eine neue Adapterinstanz muss dieselben fachlichen Effekte weiterhin erkennen.
    const restarted = createEconomyPlatformAdapters({ db, accountsByOperator: { [operator.id]: { cashAccountId: cash.id, revenueAccountId: revenue.id, costAccountIds: costAccounts } } });
    await restarted.postJournal({ worldId: WORLD_ID, operatorId: operator.id, idempotencyKey: "settlement:1", at: 1_800_000_000, description: "Periodenabrechnung", revenueCents: 10_000n, postings: [{ amountCents: 2_000n, costType: "energy", costCentreId: "lot-1", reference: "period-1" }] });
    await restarted.sendNotice({ id: "insolvency:1:account", worldId: WORLD_ID, recipientAccountId: account.id, type: "insolvency-stage-1", at: 1_800_000_000, payload: { forecast: "changed-on-retry" } });
    expect(await listLedgerTransactions(db, { worldId: WORLD_ID, operatorId: operator.id })).toHaveLength(1);
    expect(await db.select().from(mailboxMessages)).toHaveLength(2);
    expect(await db.select().from(economyEffects)).toHaveLength(3);
  });

  it("serialisiert parallelen Journal-Dispatch und bucht den Replay genau einmal", async () => {
    await requestWorldAccess(identityDb, { worldId: WORLD_ID, keycloakSubject: "kc-dispatch", displayName: "Dispatch" });
    const operator = await foundOperator(identityDb, { worldId: WORLD_ID, foundingKeycloakSubject: "kc-dispatch", name: "Dispatch-Bahn" });
    const cash = await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName });
    const revenue = await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.revenueAccountName });
    const costAccounts = Object.fromEntries(await Promise.all(COST_TYPES.map(async (type) => [type, (await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.costAccountNames[type] })).id]))) as Record<CostType, string>;
    const adapters = createEconomyPlatformAdapters({ db, accountsByOperator: { [operator.id]: { cashAccountId: cash.id, revenueAccountId: revenue.id, costAccountIds: costAccounts } } });
    const journal = {
      worldId: WORLD_ID,
      operatorId: operator.id,
      idempotencyKey: "parallel-journal:1",
      at: 1_800_000_000,
      description: "Paralleler Economy-Dispatch",
      revenueCents: 0n,
      postings: [{ amountCents: 500n, costType: "energy" as const, costCentreId: "lot-1", reference: "period-1" }],
    };
    await db.insert(economyOutbox).values({
      worldId: WORLD_ID,
      effectId: journal.idempotencyKey,
      effectType: "journal",
      payload: encodeEconomyValue(journal),
      occurredAt: new Date(journal.at * 1_000),
      enqueuedAt: new Date(journal.at * 1_000),
    });

    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => { releaseBoth = resolve; });
    let arrivals = 0;
    const racingAdapters = {
      sendNotice: adapters.sendNotice,
      async postJournal(entry: Parameters<typeof adapters.postJournal>[0]) {
        arrivals += 1;
        if (arrivals === 2) releaseBoth();
        await bothArrived;
        await adapters.postJournal(entry);
      },
    };
    const dispatched = await Promise.all([
      dispatchEconomyOutbox(db, WORLD_ID, racingAdapters, new Date(journal.at * 1_000 + 1)),
      dispatchEconomyOutbox(db, WORLD_ID, racingAdapters, new Date(journal.at * 1_000 + 2)),
    ]);

    expect(arrivals).toBe(2);
    expect([...dispatched].sort()).toEqual([0, 1]);
    expect(await listLedgerTransactions(db, { worldId: WORLD_ID, operatorId: operator.id })).toHaveLength(1);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_ID, ledgerAccountId: cash.id })).toBe(-500n);
    expect(await db.select().from(economyEffects)).toHaveLength(1);
    expect((await db.select().from(economyOutbox))[0]?.processedAt).not.toBeNull();
    expect(await dispatchEconomyOutbox(db, WORLD_ID, adapters, new Date(journal.at * 1_000 + 3))).toBe(0);
    expect(await listLedgerTransactions(db, { worldId: WORLD_ID, operatorId: operator.id })).toHaveLength(1);
    expect(await db.select().from(ledgerEntries)).toHaveLength(2);
  });

  it("weist eine formal ausgeglichene Buchung ueber ein Fantasiekonto vor dem Ledger-Writer ab", async () => {
    await requestWorldAccess(identityDb, { worldId: WORLD_ID, keycloakSubject: "kc-chart", displayName: "Kontenplan" });
    const operator = await foundOperator(identityDb, { worldId: WORLD_ID, foundingKeycloakSubject: "kc-chart", name: "Kontenplan-Bahn" });
    const cash = await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName });
    const fantasyRevenue = await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: "Fantasie-Erloes" });
    const costAccounts = Object.fromEntries(await Promise.all(COST_TYPES.map(async (type) => [type, (await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.costAccountNames[type] })).id]))) as Record<CostType, string>;
    const adapters = createEconomyPlatformAdapters({ db, accountsByOperator: { [operator.id]: { cashAccountId: cash.id, revenueAccountId: fantasyRevenue.id, costAccountIds: costAccounts } } });

    await expect(adapters.postJournal({
      worldId: WORLD_ID,
      operatorId: operator.id,
      idempotencyKey: "fantasy:settlement",
      at: 1_800_000_000,
      description: "Fantasiebuchung",
      revenueCents: 1_000_000n,
      postings: [],
    })).rejects.toThrow(/Kontenplan/);
    expect(await listLedgerTransactions(db, { worldId: WORLD_ID, operatorId: operator.id })).toHaveLength(0);
  });
});
