import { integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/** Letzter vollständig commiteter M6-Weltzustand, optimistisch über `revision` gesichert. */
export const economyWorldStates = pgTable("economy_world_states", {
  worldId: uuid("world_id")
    .primaryKey()
    .references(() => worlds.id),
  revision: integer("revision").notNull(),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export type EconomyWorldStateRow = typeof economyWorldStates.$inferSelect;
