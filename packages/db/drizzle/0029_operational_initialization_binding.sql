ALTER TABLE "regional_simulation_states" ADD COLUMN "initialization_hash" text;
--> statement-breakpoint
ALTER TABLE "regional_simulation_states" ADD CONSTRAINT "regional_simulation_states_initialization_hash_sha256" CHECK ("initialization_hash" IS NULL OR "initialization_hash" ~ '^[a-f0-9]{64}$') NOT VALID;
--> statement-breakpoint
ALTER TABLE "regional_simulation_states" ADD CONSTRAINT "regional_simulation_states_initialization_hash_present" CHECK ("initialization_hash" IS NOT NULL) NOT VALID;
