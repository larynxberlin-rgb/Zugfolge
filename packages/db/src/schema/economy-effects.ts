import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Dauerhafter Versandnachweis für M6-Effekte. Die eigentliche At-most-once-
 * Garantie liegt zusätzlich auf dem jeweiligen Ledger- bzw. Postfachziel;
 * diese Tabelle macht abgearbeitete Effekte nach Neustarts beobachtbar.
 */
export const economyEffects = pgTable(
  "economy_effects",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    effectId: text("effect_id").notNull(),
    effectType: text("effect_type", { enum: ["journal", "notice"] }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("economy_effects_world_type_id_idx").on(table.worldId, table.effectType, table.effectId)],
);

export type EconomyEffect = typeof economyEffects.$inferSelect;
export type NewEconomyEffect = typeof economyEffects.$inferInsert;
