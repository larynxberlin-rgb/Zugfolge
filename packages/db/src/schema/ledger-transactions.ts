import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { operators } from "./operators.js";
import { worlds } from "./worlds.js";

/**
 * Ledger-Transaktion: die unveränderliche Hülle einer doppelten Buchung
 * (M2.4). Trägt selbst keinen Betrag — der steckt in ihren `ledger_entries`,
 * deren Summe zwingend null ergibt. `postedAt` ist ein expliziter Wert, nie
 * aus der Systemuhr gelesen (`packages/economy` unterliegt `no-wallclock`).
 */
export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    description: text("description").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("ledger_transactions_world_operator_idx").on(table.worldId, table.operatorId)],
);

export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;
export type NewLedgerTransaction = typeof ledgerTransactions.$inferInsert;
