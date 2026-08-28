import { smallint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Restaurierbare, einmalig erzeugte Identitaet genau dieser Zugfolge-Datenbank.
 * Migration 0031 schuetzt die Singleton-Zeile zusaetzlich gegen UPDATE/DELETE.
 */
// guards:allow world-id — DB-weite Singleton-Identitaet ohne fachliche Weltzuordnung.
export const zugfolgeDatabaseIdentity = pgTable("zugfolge_database_identity", {
  singleton: smallint("singleton").primaryKey().notNull().default(1),
  databaseId: uuid("database_id").notNull().defaultRandom().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Unveraenderlicher Beleg des atomaren V1-V2-Weltwechsels. Der kanonische
 * Receipt-Hash wird von der gesperrten Bootstrap-Transaktion berechnet.
 */
export const worldCutoverReceipts = pgTable("world_cutover_receipts", {
  candidateWorldId: uuid("candidate_world_id")
    .primaryKey()
    .notNull()
    .references(() => worlds.id),
  databaseId: uuid("database_id")
    .notNull()
    .references(() => zugfolgeDatabaseIdentity.databaseId),
  mode: text("mode", { enum: ["authorized-v1-to-v2-cutover", "new-v2-world"] }).notNull(),
  predecessorWorldId: uuid("predecessor_world_id").references(() => worlds.id),
  predecessorDeploymentHash: text("predecessor_deployment_hash"),
  predecessorFinalStateHash: text("predecessor_final_state_hash"),
  candidateDeploymentHash: text("candidate_deployment_hash").notNull(),
  beforeAuthoritativeHeadSha256: text("before_authoritative_head_sha256").notNull(),
  afterAuthoritativeHeadSha256: text("after_authoritative_head_sha256").notNull(),
  receiptHash: text("receipt_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ZugfolgeDatabaseIdentity = typeof zugfolgeDatabaseIdentity.$inferSelect;
export type WorldCutoverReceipt = typeof worldCutoverReceipts.$inferSelect;
