import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Das append-only Event-Log einer Welt — die Wahrheit des Betriebsverlaufs,
 * Träger von Replay, Audit und Tagesbericht (`architektur.md` 2, 3).
 *
 * `world_id` steht hier nicht nur in der Tabelle, sondern führt beide
 * Indizes an: Jede Leseabfrage dieses Logs beginnt mit der Welt, nie mit der
 * Zeit oder dem Ereignistyp allein (Invariante 4).
 */
export const domainEvents = pgTable(
  "domain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    /** Fortlaufend je Welt, nicht global — vergeben vom schreibenden Dienst. */
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("domain_events_world_sequence_idx").on(table.worldId, table.sequence),
    index("domain_events_world_type_idx").on(table.worldId, table.eventType),
  ],
);

export type DomainEvent = typeof domainEvents.$inferSelect;
export type NewDomainEvent = typeof domainEvents.$inferInsert;
