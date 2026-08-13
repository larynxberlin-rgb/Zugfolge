import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { worlds } from "./worlds.js";

/** Autoritativer Game-Zustand einer kommerziell freigegebenen Weltteilnahme. */
export const worldParticipations = pgTable("world_participations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  keycloakSubject: text("keycloak_subject").notNull(),
  displayName: text("display_name").notNull(),
  odooPartnerReference: text("odoo_partner_reference").notNull(),
  odooOrderReference: text("odoo_order_reference").notNull(),
  paymentReference: text("payment_reference").notNull(),
  state: text("state", { enum: ["provisioning", "active", "rejected", "cancelled", "refunded"] }).notNull(),
  rejectionCode: text("rejection_code"),
  lastIdempotencyKey: text("last_idempotency_key").notNull(),
  correlationId: text("correlation_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("world_participations_world_subject_idx").on(table.worldId, table.keycloakSubject),
  uniqueIndex("world_participations_world_id_idx").on(table.worldId, table.id),
  index("world_participations_world_state_idx").on(table.worldId, table.state),
]);

export type WorldParticipation = typeof worldParticipations.$inferSelect;
