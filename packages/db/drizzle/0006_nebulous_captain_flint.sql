CREATE TABLE "economy_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"effect_id" text NOT NULL,
	"effect_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text
);
--> statement-breakpoint
CREATE TABLE "economy_world_states" (
	"world_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "economy_outbox" ADD CONSTRAINT "economy_outbox_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_world_states" ADD CONSTRAINT "economy_world_states_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "economy_outbox_world_type_id_idx" ON "economy_outbox" USING btree ("world_id","effect_type","effect_id");--> statement-breakpoint
CREATE INDEX "economy_outbox_pending_idx" ON "economy_outbox" USING btree ("world_id","processed_at","enqueued_at");