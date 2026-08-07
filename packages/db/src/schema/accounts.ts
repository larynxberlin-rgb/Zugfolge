import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Konto: das Spielkonto, das ein Keycloak-Subject innerhalb einer Welt führt
 * (M2.1). Entsteht aus einem gültigen Weltzugang (`world_accesses`);
 * Anzeigename ist eine Angabe des Spielsystems, nicht der Identität bei
 * Keycloak.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    keycloakSubject: text("keycloak_subject").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Zeitpunkt der Löschung nach Datenschutzanfrage (M2.6); `null` heißt unangetastet. */
    erasedAt: timestamp("erased_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("accounts_world_subject_idx").on(table.worldId, table.keycloakSubject)],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
