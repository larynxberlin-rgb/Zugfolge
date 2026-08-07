import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { worlds } from "./worlds.js";

/**
 * EVU (`Operator`): das Unternehmen eines Spielers innerhalb einer Welt
 * (M2.3). Trägt später Fahrzeuge, Personal, Trassen und Verträge; hier nur
 * Gründung, Stammdaten und Zuordnung zu Welt und gründendem Konto.
 */
export const operators = pgTable(
  "operators",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    foundingAccountId: uuid("founding_account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    foundedAt: timestamp("founded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("operators_world_name_idx").on(table.worldId, table.name)],
);

export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;
