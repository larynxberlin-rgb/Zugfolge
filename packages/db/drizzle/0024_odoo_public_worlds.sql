ALTER TABLE "operators" ADD COLUMN IF NOT EXISTS "operator_kind" text DEFAULT 'player' NOT NULL;
--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN IF NOT EXISTS "lifecycle" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "operators" DROP CONSTRAINT IF EXISTS "operators_kind_check";
--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_kind_check" CHECK ("operator_kind" IN ('player', 'system', 'bot'));
--> statement-breakpoint
ALTER TABLE "operators" DROP CONSTRAINT IF EXISTS "operators_lifecycle_check";
--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_lifecycle_check" CHECK ("lifecycle" IN ('active', 'exited', 'deleted'));
--> statement-breakpoint
ALTER TABLE "odoo_command_queue" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "odoo_command_queue" DROP CONSTRAINT IF EXISTS "odoo_command_queue_idempotency_check";
--> statement-breakpoint
ALTER TABLE "odoo_command_queue" ADD CONSTRAINT "odoo_command_queue_idempotency_check" CHECK ("idempotency_key" IS NULL OR length("idempotency_key") BETWEEN 8 AND 200);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "odoo_command_queue_world_type_idempotency_idx" ON "odoo_command_queue" USING btree ("world_id", "command_type", "idempotency_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "world_participations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"keycloak_subject" text NOT NULL,
	"display_name" text NOT NULL,
	"odoo_partner_reference" text NOT NULL,
	"odoo_order_reference" text NOT NULL,
	"payment_reference" text NOT NULL,
	"state" text NOT NULL,
	"rejection_code" text,
	"last_idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "world_participations" DROP CONSTRAINT IF EXISTS "world_participations_state_check";
--> statement-breakpoint
ALTER TABLE "world_participations" ADD CONSTRAINT "world_participations_state_check" CHECK ("state" IN ('provisioning', 'active', 'rejected', 'cancelled', 'refunded'));
--> statement-breakpoint
ALTER TABLE "world_participations" DROP CONSTRAINT IF EXISTS "world_participations_subject_check";
--> statement-breakpoint
ALTER TABLE "world_participations" ADD CONSTRAINT "world_participations_subject_check" CHECK (length("keycloak_subject") BETWEEN 1 AND 255);
--> statement-breakpoint
ALTER TABLE "world_participations" DROP CONSTRAINT IF EXISTS "world_participations_idempotency_check";
--> statement-breakpoint
ALTER TABLE "world_participations" ADD CONSTRAINT "world_participations_idempotency_check" CHECK (length("last_idempotency_key") BETWEEN 8 AND 200);
--> statement-breakpoint
ALTER TABLE "world_participations" DROP CONSTRAINT IF EXISTS "world_participations_world_fk";
--> statement-breakpoint
ALTER TABLE "world_participations" ADD CONSTRAINT "world_participations_world_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "world_participations_world_subject_idx" ON "world_participations" USING btree ("world_id", "keycloak_subject");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "world_participations_world_id_idx" ON "world_participations" USING btree ("world_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "world_participations_world_state_idx" ON "world_participations" USING btree ("world_id", "state");
