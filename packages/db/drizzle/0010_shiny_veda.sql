CREATE TABLE "regional_simulation_states" (
	"world_id" uuid NOT NULL,
	"region_id" text NOT NULL,
	"state_schema" text NOT NULL,
	"state" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	"revision" bigint NOT NULL,
	"publisher_sequence" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "regional_simulation_states_pk" PRIMARY KEY("world_id","region_id"),
	CONSTRAINT "regional_simulation_states_revision_nonnegative" CHECK ("regional_simulation_states"."revision" >= 0),
	CONSTRAINT "regional_simulation_states_publisher_sequence_nonnegative" CHECK ("regional_simulation_states"."publisher_sequence" >= 0),
	CONSTRAINT "regional_simulation_states_sequences_equal" CHECK ("regional_simulation_states"."revision" = "regional_simulation_states"."publisher_sequence")
);
--> statement-breakpoint
ALTER TABLE "regional_simulation_states" ADD CONSTRAINT "regional_simulation_states_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "regional_simulation_states_world_sequence_idx" ON "regional_simulation_states" USING btree ("world_id","publisher_sequence");