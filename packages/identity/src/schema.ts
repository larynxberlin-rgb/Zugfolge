/**
 * Datenbankschema für Konten, Rollen und Weltzugänge (M2.1).
 *
 * Keycloak bleibt Herr über die globale Identität (Subject, E-Mail, Login).
 * Dieses Schema hält ausschließlich das, wofür das Spielsystem selbst die
 * Quelle der Wahrheit ist (`architektur.md` 5): ob ein Keycloak-Subject
 * Zugang zu einer bestimmten Welt hat, welches Spielkonto daraus entsteht und
 * welche Rollen dieses Konto dort trägt. Jede Tabelle trägt `world_id` als
 * führende Spalte ihres Eindeutigkeitsindex (Invariante 4).
 */

import { sql } from "drizzle-orm";
import { pgTable, timestamp, uniqueIndex, uuid, text } from "drizzle-orm/pg-core";

/**
 * Weltzugang: das Recht eines Keycloak-Subjects, in einer Welt aufzutreten.
 * Getrennt vom Konto, damit ein Zugang entzogen werden kann, ohne die
 * Betriebshistorie des Kontos zu verlieren (vgl. E8: „Der Account bleibt
 * bestehen“).
 */
export const worldAccesses = pgTable(
  "world_accesses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull(),
    keycloakSubject: text("keycloak_subject").notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("world_accesses_world_subject_idx").on(table.worldId, table.keycloakSubject)],
);

/**
 * Konto: das Spielkonto, das ein Keycloak-Subject innerhalb einer Welt führt.
 * Entsteht aus einem gültigen Weltzugang; Anzeigename ist eine Angabe des
 * Spielsystems, nicht der Identität bei Keycloak.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull(),
    keycloakSubject: text("keycloak_subject").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("accounts_world_subject_idx").on(table.worldId, table.keycloakSubject)],
);

/**
 * Rolle eines Kontos innerhalb genau einer Welt. Ein Konto kann mehrere
 * Rollen gleichzeitig tragen (etwa `player` und `world_admin`).
 */
export const accountRoles = pgTable(
  "account_roles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    role: text("role", { enum: ["player", "world_admin"] }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("account_roles_world_account_role_idx").on(table.worldId, table.accountId, table.role)],
);

export const schema = { worldAccesses, accounts, accountRoles };
