CREATE TABLE "alpha_world_profiles" (
  "world_id" uuid PRIMARY KEY NOT NULL REFERENCES "worlds"("id"),
  "profile_kind" text NOT NULL CHECK ("profile_kind" IN ('public','tutorial','private','test')),
  "region_id" text NOT NULL,
  "region_variant" text NOT NULL,
  "world_seed" bigint NOT NULL,
  "acceleration_factor" integer DEFAULT 1 NOT NULL CHECK ("acceleration_factor" BETWEEN 1 AND 3600),
  "infra_release_hash" text NOT NULL CHECK ("infra_release_hash" ~ '^[a-f0-9]{64}$'),
  "timetable_release_hash" text NOT NULL CHECK ("timetable_release_hash" ~ '^[a-f0-9]{64}$'),
  "fleet_release_hash" text NOT NULL CHECK ("fleet_release_hash" ~ '^[a-f0-9]{64}$'),
  "economy_release_hash" text NOT NULL CHECK ("economy_release_hash" ~ '^[a-f0-9]{64}$'),
  "blueprint" jsonb NOT NULL,
  "blueprint_hash" text NOT NULL CHECK ("blueprint_hash" ~ '^[a-f0-9]{64}$'),
  "period_count" integer,
  "current_period" integer DEFAULT 0 NOT NULL CHECK ("current_period" >= 0),
  "state" text DEFAULT 'draft' NOT NULL CHECK ("state" IN ('draft','running','closing','archived')),
  "started_at_s" bigint,
  "closing_at_s" bigint,
  "archived_at_s" bigint,
  "final_state_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "alpha_world_profiles_acceleration_check" CHECK (("profile_kind" = 'public' AND "acceleration_factor" = 1) OR ("profile_kind" IN ('tutorial','private','test'))),
  CONSTRAINT "alpha_world_profiles_period_check" CHECK ("period_count" IS NULL OR "period_count" > 0)
);
--> statement-breakpoint
CREATE INDEX "alpha_world_profiles_world_state_idx" ON "alpha_world_profiles" ("world_id","state");
--> statement-breakpoint
CREATE TABLE "tutorial_progress" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
  "account_id" uuid NOT NULL,
  "chapter" integer DEFAULT 1 NOT NULL CHECK ("chapter" BETWEEN 1 AND 5),
  "chapter_state" text DEFAULT 'ready' NOT NULL CHECK ("chapter_state" IN ('ready','in-progress','blocked','completed')),
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "explanation_code" text DEFAULT 'tutorial.welcome' NOT NULL,
  "checkpoint_hash" text NOT NULL CHECK ("checkpoint_hash" ~ '^[a-f0-9]{64}$'),
  "reset_count" integer DEFAULT 0 NOT NULL CHECK ("reset_count" BETWEEN 0 AND 20),
  "completed_at_s" bigint,
  "updated_at_s" bigint NOT NULL,
  CONSTRAINT "tutorial_progress_world_account_fk" FOREIGN KEY ("world_id","account_id") REFERENCES "accounts"("world_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tutorial_progress_world_account_idx" ON "tutorial_progress" ("world_id","account_id");
--> statement-breakpoint
CREATE TABLE "onboarding_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
  "account_id" uuid NOT NULL,
  "operator_id" uuid NOT NULL,
  "package_version" text NOT NULL,
  "emergency_lot_id" text NOT NULL,
  "vehicle_id" text NOT NULL,
  "path_receipt_id" text NOT NULL,
  "personnel_pool_id" text NOT NULL,
  "operating_program_id" text NOT NULL,
  "grant_hash" text NOT NULL CHECK ("grant_hash" ~ '^[a-f0-9]{64}$'),
  "granted_at_s" bigint NOT NULL,
  "expires_at_s" bigint NOT NULL,
  "revoked" boolean DEFAULT false NOT NULL,
  CONSTRAINT "onboarding_grants_window_check" CHECK ("expires_at_s" > "granted_at_s"),
  CONSTRAINT "onboarding_grants_world_account_fk" FOREIGN KEY ("world_id","account_id") REFERENCES "accounts"("world_id","id"),
  CONSTRAINT "onboarding_grants_world_operator_fk" FOREIGN KEY ("world_id","operator_id") REFERENCES "operators"("world_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_grants_world_account_idx" ON "onboarding_grants" ("world_id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_grants_world_operator_idx" ON "onboarding_grants" ("world_id","operator_id");
--> statement-breakpoint
CREATE TABLE "abuse_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
  "identity_hash" text NOT NULL,
  "endpoint_class" text NOT NULL,
  "action_class" text NOT NULL,
  "bucket_start_s" bigint NOT NULL,
  "request_count" integer NOT NULL CHECK ("request_count" >= 0),
  "distinct_target_count" integer NOT NULL CHECK ("distinct_target_count" >= 0),
  "replay_count" integer NOT NULL CHECK ("replay_count" >= 0),
  "coordinated_identity_count" integer NOT NULL CHECK ("coordinated_identity_count" >= 0),
  "score_basis_points" integer NOT NULL CHECK ("score_basis_points" BETWEEN 0 AND 10000),
  "rule_codes" jsonb NOT NULL,
  "response" text NOT NULL CHECK ("response" IN ('observe','delay','limit','block','manual-review')),
  "correlation_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "abuse_observations_world_id_unique" UNIQUE ("world_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "abuse_observations_world_id_idx" ON "abuse_observations" ("world_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "abuse_observations_world_correlation_idx" ON "abuse_observations" ("world_id","correlation_id");
--> statement-breakpoint
CREATE INDEX "abuse_observations_world_identity_bucket_idx" ON "abuse_observations" ("world_id","identity_hash","bucket_start_s");
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
  "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
  "identity_hash" text NOT NULL,
  "identity_class" text NOT NULL CHECK ("identity_class" IN ('anonymous','authenticated','administrative')),
  "endpoint_class" text NOT NULL,
  "action_class" text NOT NULL,
  "bucket_start_s" bigint NOT NULL,
  "request_count" integer DEFAULT 1 NOT NULL CHECK ("request_count" >= 0),
  "action_count" integer DEFAULT 1 NOT NULL CHECK ("action_count" >= 0),
  "target_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "replay_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "replay_count" integer DEFAULT 0 NOT NULL CHECK ("replay_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_buckets_scope_idx" ON "rate_limit_buckets" ("world_id","identity_hash","endpoint_class","action_class","bucket_start_s");
--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_world_action_bucket_idx" ON "rate_limit_buckets" ("world_id","action_class","bucket_start_s");
--> statement-breakpoint
CREATE TABLE "abuse_sanctions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
  "observation_id" uuid NOT NULL,
  "identity_hash" text NOT NULL,
  "sanction" text NOT NULL CHECK ("sanction" IN ('delay','limit','temporary-block','manual-review')),
  "status" text NOT NULL CHECK ("status" IN ('proposed','active','appealed','revoked','expired')),
  "starts_at_s" bigint NOT NULL,
  "ends_at_s" bigint,
  "explanation" jsonb NOT NULL,
  "odoo_admin_request_id" uuid,
  "appeal_reference" text,
  CONSTRAINT "abuse_sanctions_world_id_unique" UNIQUE ("world_id","id"),
  CONSTRAINT "abuse_sanctions_world_observation_fk" FOREIGN KEY ("world_id","observation_id") REFERENCES "abuse_observations"("world_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "abuse_sanctions_world_id_idx" ON "abuse_sanctions" ("world_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "abuse_sanctions_world_observation_idx" ON "abuse_sanctions" ("world_id","observation_id");
--> statement-breakpoint
CREATE INDEX "abuse_sanctions_world_identity_status_idx" ON "abuse_sanctions" ("world_id","identity_hash","status");
--> statement-breakpoint
CREATE TABLE "alpha_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
  "participant_pseudonym" text NOT NULL,
  "release_hash" text NOT NULL,
  "from_s" bigint NOT NULL,
  "until_s" bigint NOT NULL,
  "event_reference" text,
  "report_reference" text,
  "category" text NOT NULL,
  "message" text NOT NULL,
  "contact_allowed" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'new' NOT NULL CHECK ("status" IN ('new','triaged','resolved','rejected')),
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "alpha_feedback_window_check" CHECK ("until_s" >= "from_s")
);
--> statement-breakpoint
CREATE INDEX "alpha_feedback_world_status_idx" ON "alpha_feedback" ("world_id","status","submitted_at");
--> statement-breakpoint
CREATE TABLE "world_final_rankings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
  "ranking_type" text NOT NULL CHECK ("ranking_type" IN ('reliability','passenger-service','economy','resilience','cooperation')),
  "operator_id" uuid NOT NULL,
  "rank" integer NOT NULL CHECK ("rank" > 0),
  "score" bigint NOT NULL,
  "evidence_hash" text NOT NULL CHECK ("evidence_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "world_final_rankings_world_operator_fk" FOREIGN KEY ("world_id","operator_id") REFERENCES "operators"("world_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "world_final_rankings_world_type_operator_idx" ON "world_final_rankings" ("world_id","ranking_type","operator_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "world_final_rankings_world_type_rank_idx" ON "world_final_rankings" ("world_id","ranking_type","rank");
--> statement-breakpoint
CREATE TABLE "world_archives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
  "archive_schema" text NOT NULL,
  "event_from_sequence" integer NOT NULL,
  "event_until_sequence" integer NOT NULL,
  "state_hash" text NOT NULL,
  "replay_hash" text NOT NULL,
  "archive_hash" text NOT NULL,
  "retention_class" text NOT NULL CHECK ("retention_class" IN ('public-history','participant-data','audit')),
  "retain_until" timestamp with time zone,
  "authorized_roles" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "world_archives_sequence_check" CHECK ("event_until_sequence" >= "event_from_sequence")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "world_archives_world_class_idx" ON "world_archives" ("world_id","retention_class");
--> statement-breakpoint
CREATE TABLE "infra_release_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
  "release_id" text NOT NULL,
  "release_hash" text NOT NULL,
  "predecessor_hash" text NOT NULL,
  "timetable_year" integer NOT NULL,
  "valid_from" timestamp with time zone NOT NULL,
  "valid_until" timestamp with time zone NOT NULL,
  "coverage_report" jsonb NOT NULL,
  "rights_report" jsonb NOT NULL,
  "deviation_report" jsonb NOT NULL,
  "signature" jsonb NOT NULL,
  "impact_preview" jsonb NOT NULL,
	"requested_by_admin_request_id" uuid,
  "activate_at_period" integer NOT NULL CHECK ("activate_at_period" >= 1),
  "status" text NOT NULL CHECK ("status" IN ('proposed','validated','scheduled','activated','aborted','rolled-back')),
  "previous_activation_id" uuid,
  "activated_at_s" bigint,
  "activation_event_id" text,
  CONSTRAINT "infra_release_changes_window_check" CHECK ("valid_until" > "valid_from"),
  CONSTRAINT "infra_release_changes_release_hash_check" CHECK ("release_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "infra_release_changes_predecessor_hash_check" CHECK ("predecessor_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "infra_release_changes_world_release_idx" ON "infra_release_changes" ("world_id","release_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "infra_release_changes_world_hash_idx" ON "infra_release_changes" ("world_id","release_hash");
--> statement-breakpoint
CREATE INDEX "infra_release_changes_world_period_status_idx" ON "infra_release_changes" ("world_id","activate_at_period","status");
