CREATE TABLE "simulation_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"requesting_account_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"result_event_sequence" integer,
	"failure_code" text
);
--> statement-breakpoint
ALTER TABLE "simulation_commands" ADD CONSTRAINT "simulation_commands_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_commands" ADD CONSTRAINT "simulation_commands_world_account_fk" FOREIGN KEY ("world_id","requesting_account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "simulation_commands_world_account_idempotency_idx" ON "simulation_commands" USING btree ("world_id","requesting_account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "simulation_commands_pending_idx" ON "simulation_commands" USING btree ("world_id","status","submitted_at");