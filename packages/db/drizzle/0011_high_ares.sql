CREATE TABLE "fleet_world_checkpoints" (
	"world_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"state_schema" text NOT NULL,
	"state" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"command_id" text,
	"command_schema" text,
	"command_json" text,
	"command_hash" text,
	"produced_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fleet_world_checkpoints_pk" PRIMARY KEY("world_id","revision"),
	CONSTRAINT "fleet_world_checkpoints_revision_nonnegative" CHECK ("fleet_world_checkpoints"."revision" >= 0),
	CONSTRAINT "fleet_world_checkpoints_sha256" CHECK ("fleet_world_checkpoints"."state_hash" ~ '^[a-f0-9]{64}$' and "fleet_world_checkpoints"."snapshot_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "fleet_world_checkpoints_command_shape" CHECK (("fleet_world_checkpoints"."revision" = 0 and "fleet_world_checkpoints"."command_id" is null and "fleet_world_checkpoints"."command_schema" is null and "fleet_world_checkpoints"."command_json" is null and "fleet_world_checkpoints"."command_hash" is null) or ("fleet_world_checkpoints"."revision" > 0 and "fleet_world_checkpoints"."command_id" is not null and "fleet_world_checkpoints"."command_schema" is not null and "fleet_world_checkpoints"."command_json" is not null and "fleet_world_checkpoints"."command_hash" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "fleet_world_checkpoints" ADD CONSTRAINT "fleet_world_checkpoints_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_world_checkpoints_world_state_hash_idx" ON "fleet_world_checkpoints" USING btree ("world_id","state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_world_checkpoints_world_command_idx" ON "fleet_world_checkpoints" USING btree ("world_id","command_id");--> statement-breakpoint
CREATE INDEX "fleet_world_checkpoints_latest_idx" ON "fleet_world_checkpoints" USING btree ("world_id","revision");