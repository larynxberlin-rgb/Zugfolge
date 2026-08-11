CREATE TABLE "daily_operation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"service_day" text NOT NULL,
	"source_from_sequence" bigint NOT NULL,
	"source_through_sequence" bigint NOT NULL,
	"projection" jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operating_program_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema" text NOT NULL,
	"enabled" boolean NOT NULL,
	"canonical_program" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "daily_operation_reports" ADD CONSTRAINT "daily_operation_reports_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_operation_reports" ADD CONSTRAINT "daily_operation_reports_world_operator_fk" FOREIGN KEY ("world_id","operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_program_versions" ADD CONSTRAINT "operating_program_versions_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_program_versions" ADD CONSTRAINT "operating_program_versions_world_operator_fk" FOREIGN KEY ("world_id","operator_id") REFERENCES "public"."operators"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_program_versions" ADD CONSTRAINT "operating_program_versions_world_account_fk" FOREIGN KEY ("world_id","created_by_account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_operation_reports_world_operator_day_idx" ON "daily_operation_reports" USING btree ("world_id","operator_id","service_day");--> statement-breakpoint
CREATE INDEX "daily_operation_reports_world_operator_generated_idx" ON "daily_operation_reports" USING btree ("world_id","operator_id","generated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_program_versions_world_operator_version_idx" ON "operating_program_versions" USING btree ("world_id","operator_id","version");--> statement-breakpoint
CREATE INDEX "operating_program_versions_world_operator_status_idx" ON "operating_program_versions" USING btree ("world_id","operator_id","status");