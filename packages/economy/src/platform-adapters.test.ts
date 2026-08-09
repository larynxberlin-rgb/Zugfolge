import { PGlite } from "@electric-sql/pglite";
import { ledgerEntries, MIGRATIONS_FOLDER, mailboxMessages, schema, worlds } from "@zugfolge/db";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import { foundOperator } from "@zugfolge/operators";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CostType } from "./finance.js";
import { ledgerAccountBalance, listLedgerTransactions, openLedgerAccount, type EconomyDatabase } from "./ledger.js";
import { createEconomyPlatformAdapters } from "./platform-adapters.js";

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
    const cash = await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: "Kasse" });
    const revenue = await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: "Bestellerentgelt" });
    const costAccounts = Object.fromEntries(await Promise.all(COST_TYPES.map(async (type) => [type, (await openLedgerAccount(db, { worldId: WORLD_ID, operatorId: operator.id, name: `Kosten:${type}` })).id]))) as Record<CostType, string>;
    const adapters = createEconomyPlatformAdapters({ db, accountsByOperator: { [operator.id]: { cashAccountId: cash.id, revenueAccountId: revenue.id, costAccountIds: costAccounts } } });

    await adapters.postJournal({ worldId: WORLD_ID, operatorId: operator.id, idempotencyKey: "settlement:1", at: 1_800_000_000, description: "Periodenabrechnung", revenueCents: 10_000n, postings: [{ amountCents: 2_000n, costType: "energy", costCentreId: "lot-1", reference: "period-1" }] });
    await adapters.sendNotice({ worldId: WORLD_ID, recipientAccountId: account.id, type: "insolvency-stage-1", at: 1_800_000_000, payload: { forecast: "negative" } });

    expect(await listLedgerTransactions(db, { worldId: WORLD_ID, operatorId: operator.id })).toHaveLength(1);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_ID, ledgerAccountId: cash.id })).toBe(8_000n);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_ID, ledgerAccountId: revenue.id })).toBe(-10_000n);
    const classifiedEntries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.worldId, WORLD_ID));
    expect(classifiedEntries).toContainEqual(expect.objectContaining({ costType: "energy", costCentreId: "lot-1" }));
    const messages = await db.select().from(mailboxMessages).where(eq(mailboxMessages.worldId, WORLD_ID));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ recipientAccountId: account.id, messageType: "insolvency-stage-1" });

    await adapters.postJournal({ worldId: WORLD_ID, operatorId: operator.id, idempotencyKey: "settlement:1", at: 1_800_000_000, description: "Periodenabrechnung", revenueCents: 10_000n, postings: [{ amountCents: 2_000n, costType: "energy", costCentreId: "lot-1", reference: "period-1" }] });
    expect(await listLedgerTransactions(db, { worldId: WORLD_ID, operatorId: operator.id })).toHaveLength(1);
  });
});
