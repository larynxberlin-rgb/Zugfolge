CREATE TABLE "disruption_provider_snapshots" (
  "world_id" uuid NOT NULL,
  "provider_set_id" text NOT NULL,
  "snapshot_hash" text NOT NULL,
  "provider_revision" integer NOT NULL,
  "source_version" text NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "raw_snapshot" jsonb NOT NULL,
  "normalized_snapshot" jsonb NOT NULL,
  "accepted_count" integer NOT NULL,
  "discarded_count" integer NOT NULL,
  CONSTRAINT "disruption_provider_snapshots_pk" PRIMARY KEY("world_id","provider_set_id","snapshot_hash"),
  CONSTRAINT "disruption_provider_snapshots_hash" CHECK ("snapshot_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "disruption_provider_snapshots_revision_positive" CHECK ("provider_revision" > 0),
  CONSTRAINT "disruption_provider_snapshots_counts" CHECK ("accepted_count" >= 0 and "discarded_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "disruption_provider_snapshots" ADD CONSTRAINT "disruption_provider_snapshots_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "disruption_provider_snapshots_world_fetched_idx" ON "disruption_provider_snapshots" USING btree ("world_id","provider_set_id","fetched_at");
--> statement-breakpoint
CREATE TABLE "disruption_provider_applications" (
  "world_id" uuid NOT NULL,
  "provider_set_id" text NOT NULL,
  "region_id" text NOT NULL,
  "disruption_id" text NOT NULL,
  "snapshot_hash" text NOT NULL,
  "registration" jsonb NOT NULL,
  "applied_at" timestamp with time zone NOT NULL,
  CONSTRAINT "disruption_provider_applications_pk" PRIMARY KEY("world_id","provider_set_id","region_id","disruption_id"),
  CONSTRAINT "disruption_provider_applications_hash" CHECK ("snapshot_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "disruption_provider_applications_region_nonempty" CHECK (length(trim("region_id")) > 0),
  CONSTRAINT "disruption_provider_applications_disruption_nonempty" CHECK (length(trim("disruption_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "disruption_provider_applications" ADD CONSTRAINT "disruption_provider_applications_state_fk" FOREIGN KEY ("world_id","provider_set_id") REFERENCES "public"."disruption_provider_states"("world_id","provider_set_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "disruption_provider_applications_world_idx" ON "disruption_provider_applications" USING btree ("world_id","provider_set_id");
