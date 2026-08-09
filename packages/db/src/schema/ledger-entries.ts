import { sql } from "drizzle-orm";
import { bigint, index, pgTable, uuid, varchar } from "drizzle-orm/pg-core";

import { ledgerAccounts } from "./ledger-accounts.js";
import { ledgerTransactions } from "./ledger-transactions.js";
import { worlds } from "./worlds.js";

/**
 * Ledger-Buchung: ein einzelner, unveränderlicher Posten einer
 * Ledger-Transaktion (M2.4). `amountCents` ist Integer-Cent (Invariante 3):
 * positiv mehrt, negativ mindert das Ledger-Konto. Innerhalb einer
 * Transaktion ist die Summe aller Buchungen zwingend null — geprüft von
 * `packages/economy`, nicht von einer Datenbankbedingung, damit der Fehler
 * mit einer erklärbaren Meldung statt einer SQL-Ausnahme entsteht.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    ledgerAccountId: uuid("ledger_account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    /** M6.2: fachliche Klassifikation bleibt am unveränderlichen Buchungssatz. */
    costType: varchar("cost_type", { length: 32 }),
    costCentreId: varchar("cost_centre_id", { length: 128 }),
  },
  (table) => [
    index("ledger_entries_world_transaction_idx").on(table.worldId, table.transactionId),
    index("ledger_entries_world_account_idx").on(table.worldId, table.ledgerAccountId),
    index("ledger_entries_world_cost_centre_idx").on(table.worldId, table.costCentreId, table.costType),
  ],
);

export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
