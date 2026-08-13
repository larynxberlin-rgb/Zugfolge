ALTER TABLE "odoo_command_queue" DROP CONSTRAINT "odoo_command_queue_status";--> statement-breakpoint
ALTER TABLE "odoo_command_queue" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "odoo_command_queue" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "odoo_command_queue" ADD CONSTRAINT "odoo_command_queue_status" CHECK ("status" IN ('pending','processing','accepted','rejected','completed','failed'));--> statement-breakpoint
CREATE INDEX "odoo_command_queue_world_claim_idx" ON "odoo_command_queue" ("world_id", "status", "claim_expires_at", "received_at");
