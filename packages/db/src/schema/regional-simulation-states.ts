import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Letzter atomar persistierter Replay-Zustand eines regionalen M4-Single-Writers.
 * Der Rust-Zustand selbst bleibt versioniert und enthaelt das kanonische
 * Kommandolog; die Spalten daneben sind transaktionale Compare-and-set-Koepfe.
 */
export const regionalSimulationStates = pgTable(
  "regional_simulation_states",
  {
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    regionId: text("region_id").notNull(),
    stateSchema: text("state_schema").notNull(),
    state: jsonb("state").notNull(),
    stateHash: text("state_hash").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    publisherSequence: bigint("publisher_sequence", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.worldId, table.regionId],
      name: "regional_simulation_states_pk",
    }),
    index("regional_simulation_states_world_sequence_idx").on(
      table.worldId,
      table.publisherSequence,
    ),
    check(
      "regional_simulation_states_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
    check(
      "regional_simulation_states_publisher_sequence_nonnegative",
      sql`${table.publisherSequence} >= 0`,
    ),
    check(
      "regional_simulation_states_sequences_equal",
      sql`${table.revision} = ${table.publisherSequence}`,
    ),
  ],
);

export type RegionalSimulationStateRow = typeof regionalSimulationStates.$inferSelect;
