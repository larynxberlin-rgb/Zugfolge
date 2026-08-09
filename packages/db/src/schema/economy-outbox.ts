import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/** Transaktionale Outbox zwischen M6-Zustand und M2-Ledger/Postfach. */
export const economyOutbox = pgTable(
  "economy_outbox",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    effectId: text("effect_id").notNull(),
    effectType: text("effect_type", { enum: ["journal", "notice"] }).notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    uniqueIndex("economy_outbox_world_type_id_idx").on(table.worldId, table.effectType, table.effectId),
    index("economy_outbox_pending_idx").on(table.worldId, table.processedAt, table.enqueuedAt),
  ],
);

export type EconomyOutboxRow = typeof economyOutbox.$inferSelect;
