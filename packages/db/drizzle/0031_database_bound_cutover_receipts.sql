ALTER TABLE "regional_simulation_states"
ADD COLUMN "legacy_writer_fenced" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "regional_simulation_states"
ADD CONSTRAINT "regional_simulation_states_legacy_writer_fence_shape" CHECK (
	NOT "legacy_writer_fenced" OR "state_schema" = 'zugfolge-regional-simulation-state/v1'
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_enforce_regional_writer_fence"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.legacy_writer_fenced THEN
			RAISE EXCEPTION 'legacy regional writer is fenced after operational v2 cutover';
		END IF;
		RETURN OLD;
	END IF;
	IF TG_OP = 'UPDATE' AND OLD.legacy_writer_fenced THEN
		RAISE EXCEPTION 'legacy regional writer is fenced after operational v2 cutover';
	END IF;
	IF NEW.legacy_writer_fenced THEN
		IF TG_OP <> 'UPDATE'
			OR OLD.legacy_writer_fenced
			OR NEW.state_schema <> 'zugfolge-regional-simulation-state/v1'
			OR NOT EXISTS (
				SELECT 1 FROM worlds
				WHERE id = NEW.world_id AND lifecycle_status = 'archived'
			) THEN
			RAISE EXCEPTION 'legacy regional writer fence requires an archived predecessor world';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.state_schema = 'zugfolge-regional-simulation-state/v1'
		AND NOT EXISTS (
			SELECT 1 FROM worlds
			WHERE id = NEW.world_id AND lifecycle_status = 'active'
		) THEN
		RAISE EXCEPTION 'legacy regional writer requires an active predecessor world';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "regional_simulation_states_legacy_writer_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "regional_simulation_states"
FOR EACH ROW EXECUTE FUNCTION "zugfolge_enforce_regional_writer_fence"();
--> statement-breakpoint
-- guards:allow world-id — DB-weite Singleton-Identitaet ohne fachliche Weltzuordnung.
CREATE TABLE "zugfolge_database_identity" (
	"singleton" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"database_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zugfolge_database_identity_singleton" CHECK ("singleton" = 1),
	CONSTRAINT "zugfolge_database_identity_database_id_unique" UNIQUE("database_id")
);
--> statement-breakpoint
INSERT INTO "zugfolge_database_identity" ("singleton") VALUES (1)
ON CONFLICT ("singleton") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_reject_immutable_audit_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "zugfolge_database_identity_immutable"
BEFORE UPDATE OR DELETE ON "zugfolge_database_identity"
FOR EACH ROW EXECUTE FUNCTION "zugfolge_reject_immutable_audit_mutation"();
--> statement-breakpoint
CREATE TRIGGER "domain_events_append_only"
BEFORE UPDATE OR DELETE ON "domain_events"
FOR EACH ROW EXECUTE FUNCTION "zugfolge_reject_immutable_audit_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_protect_alpha_world_final_state_hash"() RETURNS trigger AS $$
BEGIN
	IF OLD.final_state_hash IS NOT NULL AND NEW.final_state_hash IS DISTINCT FROM OLD.final_state_hash THEN
		RAISE EXCEPTION 'alpha world final state hash is immutable';
	END IF;
	IF NEW.final_state_hash IS DISTINCT FROM OLD.final_state_hash AND NOT (
		OLD.final_state_hash IS NULL
		AND (
			(OLD.state = 'running' AND NEW.state = 'closing')
			OR (OLD.state = 'closing' AND NEW.state = 'archived')
		)
		AND NEW.final_state_hash ~ '^[a-f0-9]{64}$'
	) THEN
		RAISE EXCEPTION 'alpha world final state hash requires the guarded closing transition';
	END IF;
	IF NEW.state = 'archived' AND NEW.final_state_hash IS NULL THEN
		RAISE EXCEPTION 'archived alpha world requires a final state hash';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "alpha_world_final_state_hash_immutable"
BEFORE UPDATE ON "alpha_world_profiles"
FOR EACH ROW EXECUTE FUNCTION "zugfolge_protect_alpha_world_final_state_hash"();
--> statement-breakpoint
CREATE TABLE "world_cutover_receipts" (
	"candidate_world_id" uuid PRIMARY KEY NOT NULL,
	"database_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"predecessor_world_id" uuid,
	"predecessor_deployment_hash" text,
	"predecessor_final_state_hash" text,
	"candidate_deployment_hash" text NOT NULL,
	"before_authoritative_head_sha256" text NOT NULL,
	"after_authoritative_head_sha256" text NOT NULL,
	"receipt_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "world_cutover_receipts_database_fk" FOREIGN KEY ("database_id") REFERENCES "zugfolge_database_identity"("database_id"),
	CONSTRAINT "world_cutover_receipts_candidate_world_fk" FOREIGN KEY ("candidate_world_id") REFERENCES "worlds"("id"),
	CONSTRAINT "world_cutover_receipts_predecessor_world_fk" FOREIGN KEY ("predecessor_world_id") REFERENCES "worlds"("id"),
	CONSTRAINT "world_cutover_receipts_mode" CHECK ("mode" IN ('authorized-v1-to-v2-cutover', 'new-v2-world')),
	CONSTRAINT "world_cutover_receipts_hash_format" CHECK (
		"candidate_deployment_hash" ~ '^[a-f0-9]{64}$'
		AND "before_authoritative_head_sha256" ~ '^[a-f0-9]{64}$'
		AND "after_authoritative_head_sha256" ~ '^[a-f0-9]{64}$'
		AND "receipt_hash" ~ '^[a-f0-9]{64}$'
		AND ("predecessor_deployment_hash" IS NULL OR "predecessor_deployment_hash" ~ '^[a-f0-9]{64}$')
		AND ("predecessor_final_state_hash" IS NULL OR "predecessor_final_state_hash" ~ '^[a-f0-9]{64}$')
	),
	CONSTRAINT "world_cutover_receipts_shape" CHECK (
		(
			"mode" = 'authorized-v1-to-v2-cutover'
			AND "predecessor_world_id" IS NOT NULL
			AND "predecessor_deployment_hash" IS NOT NULL
			AND "predecessor_final_state_hash" IS NOT NULL
		)
		OR (
			"mode" = 'new-v2-world'
			AND "predecessor_world_id" IS NULL
			AND "predecessor_deployment_hash" IS NULL
			AND "predecessor_final_state_hash" IS NULL
		)
	)
);
--> statement-breakpoint
-- guards:allow world-id — Receipt-Hash ist bewusst eine DB-weite Replay- und Kollisionsgrenze; candidate_world_id bleibt im Receipt gebunden.
CREATE UNIQUE INDEX "world_cutover_receipts_receipt_hash_unique" ON "world_cutover_receipts" ("receipt_hash");
--> statement-breakpoint
CREATE TRIGGER "world_cutover_receipts_immutable"
BEFORE UPDATE OR DELETE ON "world_cutover_receipts"
FOR EACH ROW EXECUTE FUNCTION "zugfolge_reject_immutable_audit_mutation"();
