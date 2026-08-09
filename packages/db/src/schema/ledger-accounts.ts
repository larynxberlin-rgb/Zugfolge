import { sql } from "drizzle-orm";
import { foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { operators } from "./operators.js";
import { worlds } from "./worlds.js";

/**
 * Ledger-Konto: ein benanntes Konto in den Büchern genau eines EVU (M2.4).
 * Die Kontoart (Kostenart, Kostenstelle) bleibt M6.2 vorbehalten — der
 * Ledger-Kern kennt nur benannte Konten und ausgeglichene Buchungen.
 */
export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    operatorId: uuid("operator_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ledger_accounts_world_operator_name_idx").on(table.worldId, table.operatorId, table.name),
    uniqueIndex("ledger_accounts_world_id_idx").on(table.worldId, table.id),
    foreignKey({
      name: "ledger_accounts_world_operator_fk",
      columns: [table.worldId, table.operatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
  ],
);

export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type NewLedgerAccount = typeof ledgerAccounts.$inferInsert;
