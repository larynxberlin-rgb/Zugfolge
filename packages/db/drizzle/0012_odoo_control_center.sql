ALTER TABLE "worlds" ADD COLUMN "world_kind" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "ranking_status" text DEFAULT 'ranked' NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "lifecycle_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_private_unranked" CHECK (("world_kind" = 'public') OR ("world_kind" = 'private' AND "ranking_status" = 'unranked'));
--> statement-breakpoint
-- guards:allow world-id — globaler kaufmaennischer Vertrag; Weltbezug steht nur in commerce_world_claims.
CREATE TABLE "commerce_entitlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_event_id" text NOT NULL,
  "keycloak_subject" text NOT NULL,
  "product_kind" text NOT NULL,
  "status" text NOT NULL,
  "valid_from" timestamp with time zone NOT NULL,
  "valid_until" timestamp with time zone,
  "quantity" text DEFAULT '1' NOT NULL,
  "correlation_id" text NOT NULL,
  "source_reference" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_entitlements_kind" CHECK ("product_kind" IN ('zugfolge_plus','cosmetic','public_world_slot','private_unranked_world')),
  CONSTRAINT "commerce_entitlements_status" CHECK ("status" IN ('active','revoked','expired')),
  CONSTRAINT "commerce_entitlements_quantity" CHECK ("quantity" ~ '^[1-9][0-9]*$')
);--> statement-breakpoint
-- guards:allow world-id — globaler kaufmaennischer Vertrag.
CREATE UNIQUE INDEX "commerce_entitlements_external_event_idx" ON "commerce_entitlements" ("external_event_id");--> statement-breakpoint
-- guards:allow world-id — gezielte Entitlement-Leseabfrage nach Vertragsinhaber.
CREATE INDEX "commerce_entitlements_subject_status_idx" ON "commerce_entitlements" ("keycloak_subject", "status");--> statement-breakpoint
CREATE TABLE "commerce_world_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL,
  "entitlement_id" uuid NOT NULL,
  "claim_kind" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "commerce_world_claims_kind" CHECK ("claim_kind" IN ('public_slot','private_world','cosmetic')),
  CONSTRAINT "commerce_world_claims_status" CHECK ("status" IN ('active','revoked'))
);--> statement-breakpoint
ALTER TABLE "commerce_world_claims" ADD CONSTRAINT "commerce_world_claims_world_fk" FOREIGN KEY ("world_id") REFERENCES "worlds"("id");--> statement-breakpoint
ALTER TABLE "commerce_world_claims" ADD CONSTRAINT "commerce_world_claims_entitlement_fk" FOREIGN KEY ("entitlement_id") REFERENCES "commerce_entitlements"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_world_claims_world_entitlement_idx" ON "commerce_world_claims" ("world_id", "entitlement_id");--> statement-breakpoint
CREATE INDEX "commerce_world_claims_world_status_idx" ON "commerce_world_claims" ("world_id", "status");--> statement-breakpoint
CREATE TABLE "odoo_projection_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL,
  "message_type" text NOT NULL,
  "schema_version" text NOT NULL,
  "correlation_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "enqueued_at" timestamp with time zone NOT NULL,
  "delivered_at" timestamp with time zone,
  "attempts" text DEFAULT '0' NOT NULL,
  "last_error_code" text
);--> statement-breakpoint
ALTER TABLE "odoo_projection_outbox" ADD CONSTRAINT "odoo_projection_outbox_world_fk" FOREIGN KEY ("world_id") REFERENCES "worlds"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "odoo_projection_outbox_world_message_idx" ON "odoo_projection_outbox" ("world_id", "id");--> statement-breakpoint
CREATE INDEX "odoo_projection_outbox_world_pending_idx" ON "odoo_projection_outbox" ("world_id", "delivered_at", "enqueued_at");--> statement-breakpoint
-- guards:allow world-id — Replay-Schutz fuer global kaufmaennische Ereignisse; Fachzustand bleibt weltgebunden oder in commerce_entitlements.
CREATE TABLE "odoo_webhook_receipts" (
  "event_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "signature_key_id" text NOT NULL,
  "correlation_id" text NOT NULL
);--> statement-breakpoint
-- guards:allow world-id — Primärschluessel ist die globale Replay-ID.
CREATE INDEX "odoo_webhook_receipts_tenant_received_idx" ON "odoo_webhook_receipts" ("tenant_id", "received_at");--> statement-breakpoint
CREATE TABLE "odoo_command_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" text NOT NULL,
  "world_id" uuid,
  "command_type" text NOT NULL,
  "actor_reference" text NOT NULL,
  "payload" jsonb NOT NULL,
  "correlation_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "processed_at" timestamp with time zone,
  "failure_code" text,
  CONSTRAINT "odoo_command_queue_status" CHECK ("status" IN ('pending','accepted','rejected','completed','failed'))
);--> statement-breakpoint
ALTER TABLE "odoo_command_queue" ADD CONSTRAINT "odoo_command_queue_world_fk" FOREIGN KEY ("world_id") REFERENCES "worlds"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "odoo_command_queue_world_event_idx" ON "odoo_command_queue" ("world_id", "event_id");--> statement-breakpoint
CREATE INDEX "odoo_command_queue_world_pending_idx" ON "odoo_command_queue" ("world_id", "status", "received_at");--> statement-breakpoint
-- guards:allow world-id — Entitlement-Ereignisse sind bewusst global und haben keine Welt.
CREATE UNIQUE INDEX "odoo_command_queue_event_idx" ON "odoo_command_queue" ("event_id");--> statement-breakpoint
CREATE TABLE "game_admin_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL,
  "command_id" uuid NOT NULL,
  "action_type" text NOT NULL,
  "risk_class" text NOT NULL,
  "requester_reference" text NOT NULL,
  "approver_reference" text,
  "reason" text NOT NULL,
  "effect_preview" jsonb NOT NULL,
  "state" text NOT NULL,
  "correlation_id" text NOT NULL,
  "game_audit_event_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "game_admin_requests_risk" CHECK ("risk_class" IN ('standard','high')),
  CONSTRAINT "game_admin_requests_state" CHECK ("state" IN ('draft','submitted','approved','rejected','dispatched','accepted','completed','failed')),
  CONSTRAINT "game_admin_requests_reason" CHECK (length(trim("reason")) > 0),
  CONSTRAINT "game_admin_requests_four_eyes" CHECK ("risk_class" <> 'high' OR ("approver_reference" IS NOT NULL AND "approver_reference" <> "requester_reference"))
);--> statement-breakpoint
ALTER TABLE "game_admin_requests" ADD CONSTRAINT "game_admin_requests_world_fk" FOREIGN KEY ("world_id") REFERENCES "worlds"("id");--> statement-breakpoint
ALTER TABLE "game_admin_requests" ADD CONSTRAINT "game_admin_requests_command_fk" FOREIGN KEY ("command_id") REFERENCES "odoo_command_queue"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_admin_requests_world_command_idx" ON "game_admin_requests" ("world_id", "command_id");--> statement-breakpoint
CREATE INDEX "game_admin_requests_world_state_idx" ON "game_admin_requests" ("world_id", "state", "changed_at");
--> statement-breakpoint
CREATE TABLE "odoo_reconciliation_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "issue_kind" text NOT NULL,
  "correlation_id" text NOT NULL,
  "expected_hash" text NOT NULL,
  "observed_hash" text,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "odoo_reconciliation_tasks_kind" CHECK ("issue_kind" IN ('missing','duplicate','divergent')),
  CONSTRAINT "odoo_reconciliation_tasks_status" CHECK ("status" IN ('open','resolved'))
);--> statement-breakpoint
ALTER TABLE "odoo_reconciliation_tasks" ADD CONSTRAINT "odoo_reconciliation_tasks_world_fk" FOREIGN KEY ("world_id") REFERENCES "worlds"("id");--> statement-breakpoint
ALTER TABLE "odoo_reconciliation_tasks" ADD CONSTRAINT "odoo_reconciliation_tasks_message_fk" FOREIGN KEY ("message_id") REFERENCES "odoo_projection_outbox"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "odoo_reconciliation_tasks_world_message_issue_idx" ON "odoo_reconciliation_tasks" ("world_id", "message_id", "issue_kind");--> statement-breakpoint
CREATE INDEX "odoo_reconciliation_tasks_world_status_idx" ON "odoo_reconciliation_tasks" ("world_id", "status", "created_at");
