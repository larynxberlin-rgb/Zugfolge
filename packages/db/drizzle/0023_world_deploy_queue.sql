-- Ein signierter world_deploy-Befehl adressiert seine Zielwelt, bevor deren
-- autoritative Zeile existiert. Queue und Rueckprojektion behalten world_id,
-- duerfen fuer diesen Vorbereitungszustand aber keinen FK voraussetzen.
ALTER TABLE "odoo_command_queue" DROP CONSTRAINT IF EXISTS "odoo_command_queue_world_fk";--> statement-breakpoint
ALTER TABLE "odoo_projection_outbox" DROP CONSTRAINT IF EXISTS "odoo_projection_outbox_world_fk";--> statement-breakpoint
ALTER TABLE "alpha_world_profiles" ADD COLUMN IF NOT EXISTS "deployment_hash" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alpha_world_deployments" (
	"world_id" uuid PRIMARY KEY NOT NULL,
	"deployment_hash" text NOT NULL,
	"signed_deployment" jsonb NOT NULL,
	"planning_authority_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "alpha_world_deployments" DROP CONSTRAINT IF EXISTS "alpha_world_deployments_deployment_hash_unique";--> statement-breakpoint
ALTER TABLE "alpha_world_deployments" ADD CONSTRAINT "alpha_world_deployments_deployment_hash_unique" UNIQUE("deployment_hash");--> statement-breakpoint
ALTER TABLE "alpha_world_deployments" DROP CONSTRAINT IF EXISTS "alpha_world_deployments_hash_format";--> statement-breakpoint
ALTER TABLE "alpha_world_deployments" ADD CONSTRAINT "alpha_world_deployments_hash_format" CHECK ("deployment_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "alpha_world_deployments" DROP CONSTRAINT IF EXISTS "alpha_world_deployments_world_id_worlds_id_fk";--> statement-breakpoint
ALTER TABLE "alpha_world_deployments" ADD CONSTRAINT "alpha_world_deployments_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alpha_world_deployments" DROP CONSTRAINT IF EXISTS "alpha_world_deployments_planning_authority_fk";--> statement-breakpoint
ALTER TABLE "alpha_world_deployments" ADD CONSTRAINT "alpha_world_deployments_planning_authority_fk" FOREIGN KEY ("world_id","planning_authority_account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "global_admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_world_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"action_type" text NOT NULL,
	"outcome" text NOT NULL,
	"failure_code" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "global_admin_audit_events" DROP CONSTRAINT IF EXISTS "global_admin_audit_events_outcome_check";--> statement-breakpoint
ALTER TABLE "global_admin_audit_events" ADD CONSTRAINT "global_admin_audit_events_outcome_check" CHECK ("outcome" = 'rejected');--> statement-breakpoint
ALTER TABLE "global_admin_audit_events" DROP CONSTRAINT IF EXISTS "global_admin_audit_events_command_id_odoo_command_queue_id_fk";--> statement-breakpoint
ALTER TABLE "global_admin_audit_events" ADD CONSTRAINT "global_admin_audit_events_command_id_odoo_command_queue_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."odoo_command_queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- guards:allow world-id — Kommando-ID ist der globale Replay-Schluessel eines pre-world Deploy-Audits.
CREATE UNIQUE INDEX IF NOT EXISTS "global_admin_audit_events_command_idx" ON "global_admin_audit_events" USING btree ("command_id");--> statement-breakpoint
-- guards:allow world-id — target_world_id ist die noch nicht erzeugte Zielwelt und daher bewusst kein world_id-FK.
CREATE INDEX IF NOT EXISTS "global_admin_audit_events_target_world_idx" ON "global_admin_audit_events" USING btree ("target_world_id","occurred_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_enforce_global_admin_audit"() RETURNS trigger AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM odoo_command_queue command
		WHERE command.id = NEW.command_id
		AND command.command_type = 'admin.world_deploy'
		AND command.world_id = NEW.target_world_id
		AND command.correlation_id = NEW.correlation_id
	) THEN RAISE EXCEPTION 'global admin audit is not bound to its world_deploy command'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "global_admin_audit_events_command_guard" ON "global_admin_audit_events";--> statement-breakpoint
CREATE TRIGGER "global_admin_audit_events_command_guard" BEFORE INSERT ON "global_admin_audit_events" FOR EACH ROW EXECUTE FUNCTION "zugfolge_enforce_global_admin_audit"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_enforce_odoo_command_world"() RETURNS trigger AS $$
BEGIN
	IF NEW.command_type = 'entitlement.change' THEN
		IF NEW.world_id IS NOT NULL THEN RAISE EXCEPTION 'entitlement.change must be global'; END IF;
		RETURN NEW;
	END IF;
	IF NEW.world_id IS NULL THEN RAISE EXCEPTION 'admin command requires world_id'; END IF;
	IF NEW.command_type <> 'admin.world_deploy' AND NOT EXISTS (SELECT 1 FROM worlds WHERE id = NEW.world_id) THEN
		RAISE EXCEPTION 'admin command references unknown world';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "odoo_command_queue_world_guard" ON "odoo_command_queue";--> statement-breakpoint
CREATE TRIGGER "odoo_command_queue_world_guard" BEFORE INSERT OR UPDATE OF world_id, command_type ON "odoo_command_queue" FOR EACH ROW EXECUTE FUNCTION "zugfolge_enforce_odoo_command_world"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_enforce_odoo_outbox_world"() RETURNS trigger AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM worlds WHERE id = NEW.world_id) THEN RETURN NEW; END IF;
	IF NEW.message_type = 'admin.capability.projection'
		AND NEW.world_id = '00000000-0000-0000-0000-000000000000'::uuid
		AND NEW.payload->>'actionType' = 'world_deploy' THEN RETURN NEW; END IF;
	IF NEW.message_type = 'admin.command.result'
		AND NEW.payload->>'outcome' = 'rejected'
		AND NEW.payload->>'authoritative' = 'true'
		AND NEW.payload->>'auditScope' = 'global'
		AND NEW.payload->>'gameAuditEventId' LIKE 'global-admin-audit:%'
		AND EXISTS (
			SELECT 1 FROM global_admin_audit_events audit
			WHERE audit.id::text = substring(NEW.payload->>'gameAuditEventId' from 20)
			AND audit.target_world_id = NEW.world_id
			AND audit.correlation_id = NEW.correlation_id
		) THEN RETURN NEW; END IF;
	RAISE EXCEPTION 'odoo outbox references unknown world without audited exception';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "odoo_projection_outbox_world_guard" ON "odoo_projection_outbox";--> statement-breakpoint
CREATE TRIGGER "odoo_projection_outbox_world_guard" BEFORE INSERT OR UPDATE OF world_id, message_type, correlation_id, payload ON "odoo_projection_outbox" FOR EACH ROW EXECUTE FUNCTION "zugfolge_enforce_odoo_outbox_world"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_protect_started_alpha_world_profile"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.state <> 'draft' THEN
			RAISE EXCEPTION 'started alpha world profile is immutable';
		END IF;
		RETURN OLD;
	END IF;
	IF OLD.state IN ('running', 'closing', 'archived') THEN
		IF NEW.world_id IS DISTINCT FROM OLD.world_id
			OR NEW.profile_kind IS DISTINCT FROM OLD.profile_kind
			OR NEW.region_id IS DISTINCT FROM OLD.region_id
			OR NEW.region_variant IS DISTINCT FROM OLD.region_variant
			OR NEW.world_seed IS DISTINCT FROM OLD.world_seed
			OR NEW.acceleration_factor IS DISTINCT FROM OLD.acceleration_factor
			OR NEW.timetable_release_hash IS DISTINCT FROM OLD.timetable_release_hash
			OR NEW.fleet_release_hash IS DISTINCT FROM OLD.fleet_release_hash
			OR NEW.economy_release_hash IS DISTINCT FROM OLD.economy_release_hash
			OR NEW.blueprint IS DISTINCT FROM OLD.blueprint
			OR NEW.blueprint_hash IS DISTINCT FROM OLD.blueprint_hash
			OR NEW.period_count IS DISTINCT FROM OLD.period_count
			OR NEW.started_at_s IS DISTINCT FROM OLD.started_at_s
			OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
			RAISE EXCEPTION 'signed alpha world profile fields are immutable after start';
		END IF;
		IF NEW.deployment_hash IS DISTINCT FROM OLD.deployment_hash
			AND NOT (
				OLD.deployment_hash IS NULL
				AND NEW.deployment_hash IS NOT NULL
				AND NEW.deployment_hash ~ '^[0-9a-f]{64}$'
			) THEN
			RAISE EXCEPTION 'alpha world deployment binding is immutable after start';
		END IF;
		IF (OLD.state = 'running' AND NEW.state NOT IN ('running', 'closing'))
			OR (OLD.state = 'closing' AND NEW.state NOT IN ('closing', 'archived'))
			OR (OLD.state = 'archived' AND NEW.state <> 'archived') THEN
			RAISE EXCEPTION 'alpha world lifecycle cannot move backwards';
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "alpha_world_profiles_started_immutable" ON "alpha_world_profiles";--> statement-breakpoint
CREATE TRIGGER "alpha_world_profiles_started_immutable" BEFORE UPDATE OR DELETE ON "alpha_world_profiles" FOR EACH ROW EXECUTE FUNCTION "zugfolge_protect_started_alpha_world_profile"();
