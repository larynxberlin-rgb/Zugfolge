import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Append-only checkpoint log of the authoritative Rust M5 single writer.
 * A world-row lock serializes writes; each row and its materialized M6
 * snapshot are committed by the producer in the same database transaction.
 */
export const fleetWorldCheckpoints = pgTable(
  "fleet_world_checkpoints",
  {
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    revision: integer("revision").notNull(),
    stateSchema: text("state_schema").notNull(),
    state: jsonb("state").notNull(),
    stateHash: text("state_hash").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    commandId: text("command_id"),
    commandSchema: text("command_schema"),
    commandJson: text("command_json"),
    commandHash: text("command_hash"),
    producedAt: timestamp("produced_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.worldId, table.revision],
      name: "fleet_world_checkpoints_pk",
    }),
    uniqueIndex("fleet_world_checkpoints_world_state_hash_idx").on(
      table.worldId,
      table.stateHash,
    ),
    uniqueIndex("fleet_world_checkpoints_world_command_idx").on(
      table.worldId,
      table.commandId,
    ),
    index("fleet_world_checkpoints_latest_idx").on(table.worldId, table.revision),
    check("fleet_world_checkpoints_revision_nonnegative", sql`${table.revision} >= 0`),
    check(
      "fleet_world_checkpoints_sha256",
      sql`${table.stateHash} ~ '^[a-f0-9]{64}$' and ${table.snapshotHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "fleet_world_checkpoints_command_shape",
      sql`(${table.revision} = 0 and ${table.commandId} is null and ${table.commandSchema} is null and ${table.commandJson} is null and ${table.commandHash} is null) or (${table.revision} > 0 and ${table.commandId} is not null and ${table.commandSchema} is not null and ${table.commandJson} is not null and ${table.commandHash} ~ '^[a-f0-9]{64}$')`,
    ),
  ],
);

export type FleetWorldCheckpointRow = typeof fleetWorldCheckpoints.$inferSelect;
