import { sql } from "drizzle-orm";
import { foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { worlds } from "./worlds.js";

/** Persistente, vom Game-API angenommene Kommandos für den Rust-Single-Writer. */
export const simulationCommands = pgTable(
  "simulation_commands",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    requestingAccountId: uuid("requesting_account_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandType: text("command_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: ["pending", "processed", "failed"] }).notNull().default("pending"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    resultEventSequence: integer("result_event_sequence"),
    failureCode: text("failure_code"),
  },
  (table) => [
    uniqueIndex("simulation_commands_world_account_idempotency_idx").on(
      table.worldId,
      table.requestingAccountId,
      table.idempotencyKey,
    ),
    index("simulation_commands_pending_idx").on(table.worldId, table.status, table.submittedAt),
    foreignKey({
      name: "simulation_commands_world_account_fk",
      columns: [table.worldId, table.requestingAccountId],
      foreignColumns: [accounts.worldId, accounts.id],
    }),
  ],
);

export type SimulationCommand = typeof simulationCommands.$inferSelect;
