ALTER TABLE "regional_simulation_states" DROP CONSTRAINT IF EXISTS "regional_simulation_states_initialization_hash_present";
--> statement-breakpoint
ALTER TABLE "regional_simulation_states" ADD CONSTRAINT "regional_simulation_states_initialization_hash_present" CHECK (
  (
    "state_schema" = 'zugfolge-regional-simulation-state/v1'
    AND "initialization_hash" IS NULL
  )
  OR (
    "state_schema" = 'zugfolge-operational-simulation-state/v2'
    AND "initialization_hash" IS NOT NULL
  )
) NOT VALID;
--> statement-breakpoint
ALTER TABLE "regional_simulation_states" VALIDATE CONSTRAINT "regional_simulation_states_initialization_hash_sha256";
--> statement-breakpoint
ALTER TABLE "regional_simulation_states" VALIDATE CONSTRAINT "regional_simulation_states_initialization_hash_present";
