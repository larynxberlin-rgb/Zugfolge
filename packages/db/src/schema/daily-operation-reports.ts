import { sql } from "drizzle-orm";
import { bigint, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { operators } from "./operators.js";
import { worlds } from "./worlds.js";

/** Persistierte Tagesprojektion aus dem append-only Event-Log (M7.7). */
export const dailyOperationReports = pgTable(
  "daily_operation_reports",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    operatorId: uuid("operator_id").notNull(),
    serviceDay: text("service_day").notNull(),
    sourceFromSequence: bigint("source_from_sequence", { mode: "number" }).notNull(),
    sourceThroughSequence: bigint("source_through_sequence", { mode: "number" }).notNull(),
    projection: jsonb("projection").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("daily_operation_reports_world_operator_day_idx").on(table.worldId, table.operatorId, table.serviceDay),
    index("daily_operation_reports_world_operator_generated_idx").on(table.worldId, table.operatorId, table.generatedAt),
    foreignKey({
      name: "daily_operation_reports_world_operator_fk",
      columns: [table.worldId, table.operatorId],
      foreignColumns: [operators.worldId, operators.id],
    }),
  ],
);

export type DailyOperationReport = typeof dailyOperationReports.$inferSelect;

