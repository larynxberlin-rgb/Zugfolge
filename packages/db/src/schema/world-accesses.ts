import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Weltzugang: das Recht eines Keycloak-Subjects, in einer Welt aufzutreten
 * (M2.1). Getrennt vom Konto (`accounts`), damit ein Zugang entzogen werden
 * kann, ohne die Betriebshistorie des Kontos zu verlieren (vgl. E8: „Der
 * Account bleibt bestehen“).
 */
export const worldAccesses = pgTable(
  "world_accesses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    keycloakSubject: text("keycloak_subject").notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("world_accesses_world_subject_idx").on(table.worldId, table.keycloakSubject)],
);

export type WorldAccess = typeof worldAccesses.$inferSelect;
export type NewWorldAccess = typeof worldAccesses.$inferInsert;
