CREATE TABLE "fleet_mobilization_snapshots" (
	"world_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"produced_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fleet_mobilization_snapshots_pk" PRIMARY KEY("world_id","revision")
);
--> statement-breakpoint
ALTER TABLE "fleet_mobilization_snapshots" ADD CONSTRAINT "fleet_mobilization_snapshots_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_mobilization_snapshots_world_hash_idx" ON "fleet_mobilization_snapshots" USING btree ("world_id","snapshot_hash");--> statement-breakpoint
CREATE INDEX "fleet_mobilization_snapshots_latest_idx" ON "fleet_mobilization_snapshots" USING btree ("world_id","revision");