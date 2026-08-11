CREATE TABLE "disruption_policies" (
  "world_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" text NOT NULL,
  "planned_works_mode" text NOT NULL,
  "operational_incident_mode" text NOT NULL,
  "provider_set_id" text,
  "simulation_profile" jsonb NOT NULL,
  "ruleset_version" text NOT NULL,
  "valid_from_s" bigint NOT NULL,
  "valid_until_s" bigint,
  "requested_by_account_id" uuid NOT NULL,
  "change_reason" text NOT NULL,
  "published_at" timestamp with time zone NOT NULL,
  CONSTRAINT "disruption_policies_pk" PRIMARY KEY("world_id","version"),
  CONSTRAINT "disruption_policies_version_positive" CHECK ("version" > 0),
  CONSTRAINT "disruption_policies_valid_window" CHECK ("valid_from_s" >= 0 and ("valid_until_s" is null or "valid_until_s" > "valid_from_s")),
  CONSTRAINT "disruption_policies_reason_nonempty" CHECK (length(trim("change_reason")) >= 8),
  CONSTRAINT "disruption_policies_realistic_provider" CHECK ((("planned_works_mode" <> 'REALISTIC' and "operational_incident_mode" <> 'REALISTIC') or "provider_set_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "disruption_policies" ADD CONSTRAINT "disruption_policies_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "disruption_policies" ADD CONSTRAINT "disruption_policies_world_account_fk" FOREIGN KEY ("world_id","requested_by_account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "disruption_policies_world_status_valid_idx" ON "disruption_policies" USING btree ("world_id","status","valid_from_s");
--> statement-breakpoint
CREATE TABLE "disruption_provider_states" (
  "world_id" uuid NOT NULL,
  "provider_set_id" text NOT NULL,
  "rights_status" text NOT NULL,
  "enabled" text DEFAULT 'disabled' NOT NULL,
  "rights_reference" text,
  "last_safe_at_s" bigint,
  "last_safe_snapshot" jsonb,
  "last_failure" text,
  "checked_at" timestamp with time zone NOT NULL,
  CONSTRAINT "disruption_provider_states_pk" PRIMARY KEY("world_id","provider_set_id"),
  CONSTRAINT "disruption_provider_states_safe_pair" CHECK (("last_safe_at_s" is null) = ("last_safe_snapshot" is null)),
  CONSTRAINT "disruption_provider_states_rights_gate" CHECK ("enabled" = 'disabled' or ("rights_status" = 'approved' and "rights_reference" is not null))
);
--> statement-breakpoint
ALTER TABLE "disruption_provider_states" ADD CONSTRAINT "disruption_provider_states_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "disruption_provider_states_world_enabled_idx" ON "disruption_provider_states" USING btree ("world_id","enabled");
