DROP INDEX "domain_events_world_sequence_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "domain_events_world_sequence_idx" ON "domain_events" USING btree ("world_id","sequence");