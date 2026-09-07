import { sql } from "drizzle-orm";
import { bigint, foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { worlds } from "./worlds.js";

/** Weltweites Fahrzeuggedächtnis; auch öffentliche und ausgemusterte Assets bleiben erhalten. */
export const vehicleRegistryEntries = pgTable("vehicle_registry_entries", {
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  vehicleId: text("vehicle_id").notNull(),
  authorityReleaseId: text("authority_release_id").notNull(),
  classDesignation: text("class_designation").notNull(),
  ownerOperatorId: text("owner_operator_id").notNull(),
  holderOperatorId: text("holder_operator_id").notNull(),
  introducedAtS: bigint("introduced_at_s", { mode: "number" }).notNull(),
  retiredAtS: bigint("retired_at_s", { mode: "number" }).notNull(),
  dataAtS: bigint("data_at_s", { mode: "number" }).notNull(),
  fleetRevision: integer("fleet_revision").notNull(),
  sourceStateHash: text("source_state_hash").notNull(),
  facts: jsonb("facts").notNull(),
  factsHash: text("facts_hash").notNull(),
  historyHash: text("history_hash").notNull(),
}, (table) => [
  uniqueIndex("vehicle_registry_entries_world_vehicle_idx").on(table.worldId, table.vehicleId),
  index("vehicle_registry_entries_world_class_idx").on(table.worldId, table.classDesignation, table.vehicleId),
]);

/** Unveränderliche Originalfakten jeder entscheidungsrelevanten Fleet-Revision. */
export const vehicleRegistryEvents = pgTable("vehicle_registry_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  vehicleId: text("vehicle_id").notNull(),
  fleetRevision: integer("fleet_revision").notNull(),
  atS: bigint("at_s", { mode: "number" }).notNull(),
  eventType: text("event_type", { enum: ["registered", "condition-updated", "operator-exit"] }).notNull(),
  priorHistoryHash: text("prior_history_hash"),
  resultingHistoryHash: text("resulting_history_hash").notNull(),
  sourceStateHash: text("source_state_hash").notNull(),
  details: jsonb("details").notNull(),
}, (table) => [
  uniqueIndex("vehicle_registry_events_world_vehicle_revision_idx").on(table.worldId, table.vehicleId, table.fleetRevision),
  index("vehicle_registry_events_world_vehicle_time_idx").on(table.worldId, table.vehicleId, table.atS),
  foreignKey({ name: "vehicle_registry_events_world_vehicle_fk", columns: [table.worldId, table.vehicleId], foreignColumns: [vehicleRegistryEntries.worldId, vehicleRegistryEntries.vehicleId] }),
]);

export type VehicleRegistryEntry = typeof vehicleRegistryEntries.$inferSelect;
export type VehicleRegistryEvent = typeof vehicleRegistryEvents.$inferSelect;
