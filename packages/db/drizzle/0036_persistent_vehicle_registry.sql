ALTER TABLE "vehicle_assets" ALTER COLUMN "odometer_metres" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "vehicle_assets" ALTER COLUMN "condition_basis_points" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "vehicle_assets" ALTER COLUMN "valuation_spec_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "vehicle_assets" ALTER COLUMN "value_cents" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "vehicle_assets" ADD COLUMN "condition_profile" jsonb;
--> statement-breakpoint
ALTER TABLE "vehicle_assets" ADD COLUMN "valuation_basis" jsonb;
--> statement-breakpoint
CREATE TABLE "vehicle_registry_entries" (
 "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
 "vehicle_id" text NOT NULL,
 "authority_release_id" text NOT NULL,
 "class_designation" text NOT NULL,
 "owner_operator_id" text NOT NULL,
 "holder_operator_id" text NOT NULL,
 "introduced_at_s" bigint NOT NULL,
 "retired_at_s" bigint NOT NULL,
 "data_at_s" bigint NOT NULL,
 "fleet_revision" integer NOT NULL,
 "source_state_hash" text NOT NULL,
 "facts" jsonb NOT NULL,
 "facts_hash" text NOT NULL,
 "history_hash" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_registry_entries_world_vehicle_idx" ON "vehicle_registry_entries"("world_id","vehicle_id");
--> statement-breakpoint
CREATE INDEX "vehicle_registry_entries_world_class_idx" ON "vehicle_registry_entries"("world_id","class_designation","vehicle_id");
--> statement-breakpoint
CREATE TABLE "vehicle_registry_events" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "world_id" uuid NOT NULL REFERENCES "worlds"("id"),
 "vehicle_id" text NOT NULL,
 "fleet_revision" integer NOT NULL,
 "at_s" bigint NOT NULL,
 "event_type" text NOT NULL CHECK ("event_type" IN ('registered','condition-updated','operator-exit')),
 "prior_history_hash" text,
 "resulting_history_hash" text NOT NULL,
 "source_state_hash" text NOT NULL,
 "details" jsonb NOT NULL,
 CONSTRAINT "vehicle_registry_events_world_vehicle_fk" FOREIGN KEY ("world_id","vehicle_id") REFERENCES "vehicle_registry_entries"("world_id","vehicle_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_registry_events_world_vehicle_revision_idx" ON "vehicle_registry_events"("world_id","vehicle_id","fleet_revision");
--> statement-breakpoint
CREATE INDEX "vehicle_registry_events_world_vehicle_time_idx" ON "vehicle_registry_events"("world_id","vehicle_id","at_s");
--> statement-breakpoint
CREATE FUNCTION "protect_vehicle_registry_history"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Fahrzeugidentität und Lebenslauf bleiben während der Weltlaufzeit erhalten';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "vehicle_registry_entries_no_delete" BEFORE DELETE ON "vehicle_registry_entries" FOR EACH ROW EXECUTE FUNCTION "protect_vehicle_registry_history"();
--> statement-breakpoint
CREATE TRIGGER "vehicle_registry_events_append_only" BEFORE UPDATE OR DELETE ON "vehicle_registry_events" FOR EACH ROW EXECUTE FUNCTION "protect_vehicle_registry_history"();
--> statement-breakpoint
CREATE TRIGGER "vehicle_assets_no_delete" BEFORE DELETE ON "vehicle_assets" FOR EACH ROW EXECUTE FUNCTION "protect_vehicle_registry_history"();
--> statement-breakpoint
CREATE TRIGGER "vehicle_asset_history_events_append_only" BEFORE UPDATE OR DELETE ON "vehicle_asset_history_events" FOR EACH ROW EXECUTE FUNCTION "protect_vehicle_registry_history"();
