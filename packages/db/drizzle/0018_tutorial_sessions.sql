CREATE TABLE "tutorial_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"public_world_id" uuid NOT NULL,
	"public_account_id" uuid NOT NULL,
	"world_id" uuid NOT NULL,
	"tutorial_account_id" uuid NOT NULL,
	"tutorial_operator_id" uuid NOT NULL,
	"template_version" text NOT NULL,
	"template_hash" text NOT NULL,
	"lifecycle" text DEFAULT 'provisioning' NOT NULL,
	"provisioning_step" text DEFAULT 'world-created' NOT NULL,
	"current_chapter" integer DEFAULT 1 NOT NULL,
	"scenario_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending_action" jsonb,
	"action_revision" integer DEFAULT 0 NOT NULL,
	"correction_attempts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hints_used" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"maximum_expires_at" timestamp with time zone NOT NULL,
	"summary_at" timestamp with time zone,
	"grace_expires_at" timestamp with time zone,
	"closing_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"closure_reason" text,
	"final_state_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tutorial_sessions_lifecycle_check" CHECK ("lifecycle" IN ('provisioning', 'running', 'summary', 'closing', 'archived', 'failed')),
	CONSTRAINT "tutorial_sessions_chapter_check" CHECK ("current_chapter" BETWEEN 1 AND 5),
	CONSTRAINT "tutorial_sessions_reference_check" CHECK ("reference" ~ '^tut_[a-z2-7]{20,52}$'),
	CONSTRAINT "tutorial_sessions_template_hash_check" CHECK ("template_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tutorial_telemetry_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"event_type" text NOT NULL,
	"template_version" text NOT NULL,
	"chapter" integer,
	"elapsed_milliseconds" bigint NOT NULL,
	"correction_attempts" integer DEFAULT 0 NOT NULL,
	"hint_used" boolean DEFAULT false NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tutorial_telemetry_event_type_check" CHECK ("event_type" IN ('tutorial_session_started', 'tutorial_chapter_started', 'tutorial_chapter_completed', 'tutorial_hint_opened', 'tutorial_dialogue_dismissed', 'tutorial_restarted', 'tutorial_abandoned', 'tutorial_completed', 'tutorial_world_closed')),
	CONSTRAINT "tutorial_telemetry_elapsed_check" CHECK ("elapsed_milliseconds" >= 0),
	CONSTRAINT "tutorial_telemetry_chapter_check" CHECK ("chapter" IS NULL OR "chapter" BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "tutorial_sessions" ADD CONSTRAINT "tutorial_sessions_public_world_fk" FOREIGN KEY ("public_world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutorial_sessions" ADD CONSTRAINT "tutorial_sessions_tutorial_world_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutorial_sessions" ADD CONSTRAINT "tutorial_sessions_public_account_fk" FOREIGN KEY ("public_world_id", "public_account_id") REFERENCES "public"."accounts"("world_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutorial_sessions" ADD CONSTRAINT "tutorial_sessions_tutorial_account_fk" FOREIGN KEY ("world_id", "tutorial_account_id") REFERENCES "public"."accounts"("world_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutorial_sessions" ADD CONSTRAINT "tutorial_sessions_tutorial_operator_fk" FOREIGN KEY ("world_id", "tutorial_operator_id") REFERENCES "public"."operators"("world_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutorial_telemetry_events" ADD CONSTRAINT "tutorial_telemetry_world_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tutorial_sessions_reference_idx" ON "tutorial_sessions" USING btree ("world_id", "reference");
--> statement-breakpoint
CREATE UNIQUE INDEX "tutorial_sessions_tutorial_world_idx" ON "tutorial_sessions" USING btree ("world_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tutorial_sessions_world_id_idx" ON "tutorial_sessions" USING btree ("world_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tutorial_sessions_one_active_per_public_account_idx" ON "tutorial_sessions" USING btree ("public_world_id", "public_account_id") WHERE "lifecycle" IN ('provisioning', 'running', 'summary', 'closing');
--> statement-breakpoint
CREATE INDEX "tutorial_sessions_reaper_idx" ON "tutorial_sessions" USING btree ("lifecycle", "idle_expires_at", "maximum_expires_at", "world_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tutorial_telemetry_world_idempotency_idx" ON "tutorial_telemetry_events" USING btree ("world_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "tutorial_telemetry_world_session_idx" ON "tutorial_telemetry_events" USING btree ("world_id", "session_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "tutorial_telemetry_aggregate_idx" ON "tutorial_telemetry_events" USING btree ("template_version", "chapter", "event_type", "world_id");
--> statement-breakpoint
ALTER TABLE "tutorial_telemetry_events" ADD CONSTRAINT "tutorial_telemetry_world_session_fk" FOREIGN KEY ("world_id", "session_id") REFERENCES "public"."tutorial_sessions"("world_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP TABLE "onboarding_grants";
