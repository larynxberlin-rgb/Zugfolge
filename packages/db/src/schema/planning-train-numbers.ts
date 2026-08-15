import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { worlds } from "./worlds.js";

/**
 * Atomare, weltweite Zugnummernreservierung. Spieler liefern weder Nummer noch
 * technische Zug-ID; beide Werte werden einmalig an ihren idempotenten Antrag
 * gebunden.
 */
export const planningTrainNumbers = pgTable("planning_train_numbers", {
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  accountId: uuid("account_id").notNull(),
  requestId: text("request_id").notNull(),
  trainCategory: text("train_category", { enum: ["long-distance", "suburban", "regional", "freight", "supplementary"] }).notNull(),
  trainNumber: integer("train_number").notNull(),
  trainId: text("train_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "planning_train_numbers_pk", columns: [table.worldId, table.accountId, table.requestId] }),
  uniqueIndex("planning_train_numbers_world_number_idx").on(table.worldId, table.trainNumber),
  uniqueIndex("planning_train_numbers_world_train_idx").on(table.worldId, table.trainId),
  foreignKey({
    name: "planning_train_numbers_world_account_fk",
    columns: [table.worldId, table.accountId],
    foreignColumns: [accounts.worldId, accounts.id],
  }),
  check("planning_train_numbers_category_range_check", sql`(
    (${table.trainCategory} = 'long-distance' and ${table.trainNumber} between 1 and 9999)
    or (${table.trainCategory} = 'suburban' and ${table.trainNumber} between 10000 and 19999)
    or (${table.trainCategory} = 'regional' and ${table.trainNumber} between 20000 and 34999)
    or (${table.trainCategory} = 'freight' and ${table.trainNumber} between 40000 and 79999)
    or (${table.trainCategory} = 'supplementary' and ${table.trainNumber} between 80000 and 99999)
  )`),
]);

export type PlanningTrainNumber = typeof planningTrainNumbers.$inferSelect;
