ALTER TABLE "ledger_entries" ADD COLUMN "cost_type" varchar(32);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "cost_centre_id" varchar(128);--> statement-breakpoint
CREATE INDEX "ledger_entries_world_cost_centre_idx" ON "ledger_entries" USING btree ("world_id","cost_centre_id","cost_type");