import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { operators } from "./operators.js";
import { worlds } from "./worlds.js";

/** Kanonische, unveränderliche Version eines EVU-Betriebsprogramms (M7.1/M7.3). */
export const operatingProgramVersions = pgTable(
  "operating_program_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    operatorId: uuid("operator_id").notNull(),
    version: integer("version").notNull(),
    schema: text("schema").notNull(),
    enabled: boolean("enabled").notNull(),
    canonicalProgram: jsonb("canonical_program").notNull(),
    checksum: text("checksum").notNull(),
    status: text("status", { enum: ["draft", "active", "superseded"] }).notNull().default("draft"),
    createdByAccountId: uuid("created_by_account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("operating_program_versions_world_operator_version_idx").on(table.worldId, table.operatorId, table.version),
    index("operating_program_versions_world_operator_status_idx").on(table.worldId, table.operatorId, table.status),
    foreignKey({
      name: "operating_program_versions_world_operator_fk",
      columns: [table.worldId, table.operatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
    foreignKey({
      name: "operating_program_versions_world_account_fk",
      columns: [table.worldId, table.createdByAccountId],
      foreignColumns: [accounts.worldId, accounts.id],
    }),
  ],
);

export type OperatingProgramVersion = typeof operatingProgramVersions.$inferSelect;

