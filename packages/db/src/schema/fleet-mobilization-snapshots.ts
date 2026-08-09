import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Unveränderlicher Übergabepunkt vom M5-Single-Writer zur M6-Vergabe.
 * Jede Revision enthält ausschließlich aus dem kanonischen Flottenzustand
 * abgeleitete Fahrzeug-, Dienst- und Trassennachweise; M6 speichert nur
 * Referenz und Hash und übernimmt keine vom Client behaupteten Eigenschaften.
 */
export const fleetMobilizationSnapshots = pgTable(
  "fleet_mobilization_snapshots",
  {
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    revision: integer("revision").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    payload: jsonb("payload").notNull(),
    producedAt: timestamp("produced_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.worldId, table.revision], name: "fleet_mobilization_snapshots_pk" }),
    uniqueIndex("fleet_mobilization_snapshots_world_hash_idx").on(table.worldId, table.snapshotHash),
    index("fleet_mobilization_snapshots_latest_idx").on(table.worldId, table.revision),
  ],
);

export type FleetMobilizationSnapshotRow = typeof fleetMobilizationSnapshots.$inferSelect;
