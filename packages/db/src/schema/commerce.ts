import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Kaufmaennische Entitlements sind eine schmale, weltuebergreifende Ausnahme
 * von Invariante 4: Ein Vertrag gehoert einem Keycloak-Subject und nicht einer
 * Welt. Weltbezogene Aktivierungen liegen ausschliesslich in
 * `commerce_world_claims`; weder Odoo noch diese Tabelle enthalten Simulation,
 * Wirtschaft oder Planungsdaten.
 */
// guards:allow world-id — globaler kaufmaennischer Vertrag; Weltbezug steht nur in commerce_world_claims.
export const commerceEntitlements = pgTable(
  "commerce_entitlements",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    externalEventId: text("external_event_id").notNull(),
    keycloakSubject: text("keycloak_subject").notNull(),
    productKind: text("product_kind", {
      enum: ["zugfolge_plus", "cosmetic", "public_world_slot", "private_unranked_world"],
    }).notNull(),
    status: text("status", { enum: ["active", "revoked", "expired"] }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    quantity: text("quantity").notNull().default("1"),
    correlationId: text("correlation_id").notNull(),
    sourceReference: text("source_reference").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // guards:allow world-id — globaler kaufmaennischer Vertrag.
    uniqueIndex("commerce_entitlements_external_event_idx").on(table.externalEventId),
    // guards:allow world-id — gezielte Entitlement-Leseabfrage nach Vertragsinhaber.
    index("commerce_entitlements_subject_status_idx").on(table.keycloakSubject, table.status),
  ],
);

/** Die konkrete, weltisolierte Verwendung eines weltuebergreifenden Entitlements. */
export const commerceWorldClaims = pgTable(
  "commerce_world_claims",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    entitlementId: uuid("entitlement_id").notNull().references(() => commerceEntitlements.id),
    claimKind: text("claim_kind", { enum: ["public_slot", "private_world", "cosmetic"] }).notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("commerce_world_claims_world_entitlement_idx").on(table.worldId, table.entitlementId),
    index("commerce_world_claims_world_status_idx").on(table.worldId, table.status),
  ],
);

/**
 * Outbox des Games fuer die minimal notwendige Odoo-Projektion. Der Eintrag
 * entsteht im selben Commit wie sein fachlicher Game-Zustand und wird nie vom
 * Simulationskern gelesen.
 */
export const odooProjectionOutbox = pgTable(
  "odoo_projection_outbox",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    messageType: text("message_type").notNull(),
    schemaVersion: text("schema_version").notNull(),
    correlationId: text("correlation_id").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    attempts: text("attempts").notNull().default("0"),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    uniqueIndex("odoo_projection_outbox_world_message_idx").on(table.worldId, table.id),
    index("odoo_projection_outbox_world_pending_idx").on(table.worldId, table.deliveredAt, table.enqueuedAt),
  ],
);

/**
 * Persistenter Replay-Schutz. Die Tabelle enthaelt nur die Odoo-Ereignis-ID,
 * keine Nutzdaten oder Odoo-Personaldaten.
 */
// guards:allow world-id — Replay-Schutz fuer global kaufmaennische Ereignisse; Fachzustand bleibt weltgebunden oder in commerce_entitlements.
export const odooWebhookReceipts = pgTable(
  "odoo_webhook_receipts",
  {
    eventId: text("event_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    signatureKeyId: text("signature_key_id").notNull(),
    correlationId: text("correlation_id").notNull(),
  },
  (table) => [
    // guards:allow world-id — Primärschluessel ist die globale Replay-ID.
    index("odoo_webhook_receipts_tenant_received_idx").on(table.tenantId, table.receivedAt),
  ],
);

/** Persistente, vom signierten Receiver angenommene Game-Kommandos. */
export const odooCommandQueue = pgTable(
  "odoo_command_queue",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: text("event_id").notNull(),
    worldId: uuid("world_id").references(() => worlds.id),
    commandType: text("command_type").notNull(),
    actorReference: text("actor_reference").notNull(),
    payload: jsonb("payload").notNull(),
    correlationId: text("correlation_id").notNull(),
    status: text("status", { enum: ["pending", "accepted", "rejected", "completed", "failed"] }).notNull().default("pending"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    failureCode: text("failure_code"),
  },
  (table) => [
    uniqueIndex("odoo_command_queue_world_event_idx").on(table.worldId, table.eventId),
    index("odoo_command_queue_world_pending_idx").on(table.worldId, table.status, table.receivedAt),
    // guards:allow world-id — Entitlement-Ereignisse sind bewusst global und haben keine Welt.
    uniqueIndex("odoo_command_queue_event_idx").on(table.eventId),
  ],
);

/** Autoritative, weltisolierte Antrags- und Auditspur fuer Odoo-Administration. */
export const gameAdminRequests = pgTable(
  "game_admin_requests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    commandId: uuid("command_id").notNull().references(() => odooCommandQueue.id),
    actionType: text("action_type").notNull(),
    riskClass: text("risk_class", { enum: ["standard", "high"] }).notNull(),
    requesterReference: text("requester_reference").notNull(),
    approverReference: text("approver_reference"),
    reason: text("reason").notNull(),
    effectPreview: jsonb("effect_preview").notNull(),
    state: text("state", {
      enum: ["draft", "submitted", "approved", "rejected", "dispatched", "accepted", "completed", "failed"],
    }).notNull(),
    correlationId: text("correlation_id").notNull(),
    gameAuditEventId: text("game_audit_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("game_admin_requests_world_command_idx").on(table.worldId, table.commandId),
    index("game_admin_requests_world_state_idx").on(table.worldId, table.state, table.changedAt),
  ],
);

/** Auditierte Befunde des nächtlichen Game↔Odoo-Abgleichs, nie stille Korrekturen. */
export const odooReconciliationTasks = pgTable(
  "odoo_reconciliation_tasks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    messageId: uuid("message_id").notNull().references(() => odooProjectionOutbox.id),
    issueKind: text("issue_kind", { enum: ["missing", "duplicate", "divergent"] }).notNull(),
    correlationId: text("correlation_id").notNull(),
    expectedHash: text("expected_hash").notNull(),
    observedHash: text("observed_hash"),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("odoo_reconciliation_tasks_world_message_issue_idx").on(table.worldId, table.messageId, table.issueKind),
    index("odoo_reconciliation_tasks_world_status_idx").on(table.worldId, table.status, table.createdAt),
  ],
);

export type CommerceEntitlement = typeof commerceEntitlements.$inferSelect;
export type OdooProjectionOutboxRow = typeof odooProjectionOutbox.$inferSelect;
export type OdooCommandQueueRow = typeof odooCommandQueue.$inferSelect;
export type GameAdminRequest = typeof gameAdminRequests.$inferSelect;
export type OdooReconciliationTask = typeof odooReconciliationTasks.$inferSelect;
