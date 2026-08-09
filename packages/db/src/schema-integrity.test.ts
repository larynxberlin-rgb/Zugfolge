import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  accountRoles,
  accounts,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  mailboxMessages,
  operators,
  worlds,
} from "./schema/index.js";
import * as schema from "./schema/index.js";

describe("weltgebundene Datenbank-Referenzen", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, "..", "drizzle") });
  });

  afterEach(async () => client.close());

  it("weist Cross-World-Referenzen auch bei direkten Inserts zurück", async () => {
    const worldA = randomUUID();
    const worldB = randomUUID();
    await db.insert(worlds).values([
      { id: worldA, name: "A", schedulePeriodWeeks: 3, epoch: new Date(0) },
      { id: worldB, name: "B", schedulePeriodWeeks: 3, epoch: new Date(0) },
    ]);

    const [accountA] = await db
      .insert(accounts)
      .values({ worldId: worldA, keycloakSubject: "a", displayName: "A" })
      .returning();
    const [accountB] = await db
      .insert(accounts)
      .values({ worldId: worldB, keycloakSubject: "b", displayName: "B" })
      .returning();
    expect(accountA).toBeDefined();
    expect(accountB).toBeDefined();

    await expect(
      db.insert(accountRoles).values({ worldId: worldB, accountId: accountA!.id, role: "player" }),
    ).rejects.toThrow();
    await expect(
      db.insert(operators).values({ worldId: worldB, foundingAccountId: accountA!.id, name: "Falsch" }),
    ).rejects.toThrow();
    await expect(
      db.insert(mailboxMessages).values({
        worldId: worldA,
        recipientAccountId: accountB!.id,
        messageType: "falsch",
        payload: {},
      }),
    ).rejects.toThrow();

    const [operatorB] = await db
      .insert(operators)
      .values({ worldId: worldB, foundingAccountId: accountB!.id, name: "Bahn B" })
      .returning();
    await expect(
      db.insert(ledgerAccounts).values({ worldId: worldA, operatorId: operatorB!.id, name: "Falsch" }),
    ).rejects.toThrow();

    const [ledgerAccountB] = await db
      .insert(ledgerAccounts)
      .values({ worldId: worldB, operatorId: operatorB!.id, name: "Kasse" })
      .returning();
    const [transactionB] = await db
      .insert(ledgerTransactions)
      .values({
        worldId: worldB,
        operatorId: operatorB!.id,
        description: "B",
        postedAt: new Date(0),
      })
      .returning();
    await expect(
      db.insert(ledgerEntries).values({
        worldId: worldA,
        transactionId: transactionB!.id,
        ledgerAccountId: ledgerAccountB!.id,
        amountCents: 0n,
      }),
    ).rejects.toThrow();
  });
});
