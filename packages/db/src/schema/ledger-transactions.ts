import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
    operatorId: uuid("operator_id").notNull(),
    /** Fachlicher Schlüssel eines externen Effekts; `null` für interaktive Einzelbuchungen. */
    idempotencyKey: text("idempotency_key"),
    description: text("description").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("ledger_transactions_world_operator_idx").on(table.worldId, table.operatorId),
    uniqueIndex("ledger_transactions_world_id_idx").on(table.worldId, table.id),
    uniqueIndex("ledger_transactions_world_operator_idempotency_idx").on(
      table.worldId,
      table.operatorId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "ledger_transactions_world_operator_fk",
      columns: [table.worldId, table.operatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
  ],
);

export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;
export type NewLedgerTransaction = typeof ledgerTransactions.$inferInsert;
