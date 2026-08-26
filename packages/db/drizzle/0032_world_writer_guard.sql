LOCK TABLE economy_outbox, odoo_projection_outbox, worlds IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_enforce_regional_writer_fence"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.legacy_writer_fenced THEN RAISE EXCEPTION 'legacy regional writer is fenced after operational v2 cutover'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.legacy_writer_fenced THEN RAISE EXCEPTION 'legacy regional writer is fenced after operational v2 cutover'; END IF;
  IF NEW.legacy_writer_fenced THEN
    IF TG_OP <> 'UPDATE' OR OLD.legacy_writer_fenced OR NEW.state_schema <> 'zugfolge-regional-simulation-state/v1'
      OR NOT EXISTS (SELECT 1 FROM worlds WHERE id = NEW.world_id AND lifecycle_status = 'archived') THEN
      RAISE EXCEPTION 'legacy regional writer fence requires an archived predecessor world';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state_schema = 'zugfolge-regional-simulation-state/v1'
    AND NOT EXISTS (SELECT 1 FROM worlds WHERE id = NEW.world_id AND lifecycle_status IN ('provisioning', 'active')) THEN
    RAISE EXCEPTION 'legacy regional writer requires a writable predecessor world';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_enforce_odoo_outbox_world"() RETURNS trigger AS $$
BEGIN
  IF NEW.message_type = 'admin.capability.projection'
    AND NEW.world_id = '00000000-0000-0000-0000-000000000000'::uuid
    AND NEW.payload->>'actionType' = 'world_deploy' THEN RETURN NEW; END IF;
  IF NEW.message_type = 'admin.command.result'
    AND NEW.world_id = '00000000-0000-0000-0000-000000000000'::uuid
    AND NEW.payload->>'projectionScope' = 'global-admin'
    AND NEW.payload->>'actionType' = 'world_close'
    AND NEW.payload->>'outcome' = 'accepted'
    AND NEW.payload->>'state' = 'completed'
    AND NEW.payload->>'authoritative' = 'true'
    AND EXISTS (
      SELECT 1 FROM game_admin_requests request
      JOIN odoo_command_queue command ON command.id = request.command_id
      JOIN domain_events audit ON audit.id::text = request.game_audit_event_id
      JOIN domain_events archived
        ON archived.world_id = request.world_id
        AND archived.sequence = audit.sequence - 1
        AND archived.event_type = 'alpha.world-archived'
      JOIN alpha_world_profiles profile ON profile.world_id = request.world_id
      WHERE request.id::text = NEW.payload->>'adminRequestId'
        AND request.world_id::text = NEW.payload->>'targetWorldId'
        AND NEW.payload->>'targetWorldId' <> '00000000-0000-0000-0000-000000000000'
        AND request.action_type = 'world_close'
        AND request.risk_class = 'high'
        AND request.state = 'completed'
        AND request.approver_reference IS NOT NULL
        AND request.requester_reference <> request.approver_reference
        AND request.game_audit_event_id = NEW.payload->>'gameAuditEventId'
        AND command.command_type = 'admin.world_close'
        AND command.world_id = request.world_id
        AND command.correlation_id = NEW.correlation_id
        AND command.status = 'completed'
        AND audit.world_id = request.world_id
        AND audit.event_type = 'admin.action-audited'
        AND audit.payload->>'adminRequestId' = request.id::text
        AND audit.payload->>'actionType' = 'world_close'
        AND audit.payload->>'correlationId' = NEW.correlation_id
        AND audit.payload->>'outcome' = 'completed'
        AND archived.payload->>'adminRequestId' = request.id::text
        AND archived.payload->>'finalStateHash' = NEW.payload->>'finalStateHash'
        AND archived.payload->>'evidenceHash' = NEW.payload->>'evidenceHash'
        AND archived.payload->>'replayHash' = NEW.payload->>'replayHash'
        AND profile.state = 'archived'
        AND profile.final_state_hash = NEW.payload->>'finalStateHash'
        AND profile.archived_at_s::text = NEW.payload->>'archivedAtS'
        AND NEW.payload->>'finalStateHash' ~ '^[0-9a-f]{64}$'
        AND NEW.payload->>'evidenceHash' ~ '^[0-9a-f]{64}$'
        AND NEW.payload->>'replayHash' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(NEW.payload->'archivedAtS') = 'number'
        AND NEW.payload->>'archivedAtS' ~ '^(0|[1-9][0-9]*)$'
    ) THEN RETURN NEW; END IF;
  IF NEW.world_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'global odoo outbox scope requires an exactly audited payload';
  END IF;
  IF EXISTS (SELECT 1 FROM worlds WHERE id = NEW.world_id) THEN RETURN NEW; END IF;
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
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM economy_outbox AS pending_economy
    JOIN worlds AS world ON world.id = pending_economy.world_id
    WHERE world.lifecycle_status = 'archived'
      AND pending_economy.processed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'world writer guard migration found an archived world with pending economy outbox effects';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM odoo_projection_outbox AS pending_projection
    JOIN worlds AS world ON world.id = pending_projection.world_id
    WHERE world.lifecycle_status = 'archived'
      AND pending_projection.delivered_at IS NULL
  ) THEN
    RAISE EXCEPTION 'world writer guard migration found an archived world with pending odoo projection outbox messages';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "zugfolge_enforce_world_writer_guard"() RETURNS trigger AS $$
DECLARE
  argument_index integer;
  binding_column text;
  old_payload jsonb;
  new_payload jsonb;
  world_id_text text;
  world_ids uuid[] := ARRAY[]::uuid[];
  locked_world_ids uuid[] := ARRAY[]::uuid[];
  locked_world_id uuid;
  lifecycle_status text;
  proposed_lifecycle_status text;
  exact_legacy_fence_transition boolean := false;
  fencing_world_lifecycle boolean := false;
  legacy_writer_fenced boolean;
BEGIN
  IF TG_NARGS < 1 THEN RAISE EXCEPTION 'world writer guard has no bound world column'; END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_payload := to_jsonb(OLD);
    FOR argument_index IN 0..TG_NARGS - 1 LOOP
      binding_column := TG_ARGV[argument_index]; world_id_text := old_payload ->> binding_column;
      IF world_id_text IS NOT NULL THEN world_ids := array_append(world_ids, world_id_text::uuid); END IF;
    END LOOP;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_payload := to_jsonb(NEW);
    FOR argument_index IN 0..TG_NARGS - 1 LOOP
      binding_column := TG_ARGV[argument_index]; world_id_text := new_payload ->> binding_column;
      IF world_id_text IS NOT NULL THEN world_ids := array_append(world_ids, world_id_text::uuid); END IF;
    END LOOP;
  END IF;
  SELECT coalesce(array_agg(candidate.world_id ORDER BY candidate.world_id::text), ARRAY[]::uuid[])
  INTO locked_world_ids
  FROM (SELECT DISTINCT values_to_lock.world_id FROM unnest(world_ids) AS values_to_lock(world_id)) AS candidate;
  IF TG_TABLE_NAME = 'regional_simulation_states' AND TG_OP = 'UPDATE' THEN
    exact_legacy_fence_transition :=
      coalesce((old_payload ->> 'legacy_writer_fenced')::boolean, false) = false
      AND coalesce((new_payload ->> 'legacy_writer_fenced')::boolean, false) = true
      AND (old_payload - 'legacy_writer_fenced') = (new_payload - 'legacy_writer_fenced');
  END IF;
  IF TG_TABLE_NAME = 'worlds' AND TG_OP = 'UPDATE' THEN
    fencing_world_lifecycle :=
      (old_payload ->> 'id')::uuid = (new_payload ->> 'id')::uuid
      AND (old_payload ->> 'lifecycle_status') IN ('provisioning', 'active')
      AND (new_payload ->> 'lifecycle_status') = 'archived';
  END IF;
  FOREACH locked_world_id IN ARRAY locked_world_ids LOOP
    IF fencing_world_lifecycle AND (new_payload ->> 'id')::uuid = locked_world_id THEN
      PERFORM pg_advisory_xact_lock(('x' || substr(md5(locked_world_id::text), 1, 16))::bit(64)::bigint);
    ELSE
      PERFORM pg_advisory_xact_lock_shared(('x' || substr(md5(locked_world_id::text), 1, 16))::bit(64)::bigint);
    END IF;
  END LOOP;
  IF fencing_world_lifecycle AND EXISTS (
    SELECT 1 FROM economy_outbox AS pending_economy
    WHERE pending_economy.world_id = (new_payload ->> 'id')::uuid
      AND pending_economy.processed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'world cannot be archived with pending economy outbox effects %', new_payload ->> 'id';
  END IF;
  IF fencing_world_lifecycle AND EXISTS (
    SELECT 1 FROM odoo_projection_outbox AS pending_projection
    WHERE pending_projection.world_id = (new_payload ->> 'id')::uuid
      AND pending_projection.delivered_at IS NULL
  ) THEN
    RAISE EXCEPTION 'world cannot be archived with pending odoo projection outbox messages %', new_payload ->> 'id';
  END IF;
  FOREACH locked_world_id IN ARRAY locked_world_ids LOOP
    IF exact_legacy_fence_transition AND (old_payload ->> 'world_id')::uuid = locked_world_id THEN CONTINUE; END IF;
    lifecycle_status := NULL;
    SELECT world.lifecycle_status INTO lifecycle_status
    FROM worlds AS world WHERE world.id = locked_world_id FOR KEY SHARE;
    IF FOUND THEN
      IF lifecycle_status NOT IN ('provisioning', 'active') THEN
        RAISE EXCEPTION 'world writer is fenced for non-writable world % (%)', locked_world_id, lifecycle_status;
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM regional_simulation_states AS regional
        WHERE regional.world_id = locked_world_id AND regional.legacy_writer_fenced
      ) INTO legacy_writer_fenced;
      IF legacy_writer_fenced THEN
        RAISE EXCEPTION 'world writer is fenced after operational v2 cutover for world %', locked_world_id;
      END IF;
      CONTINUE;
    END IF;
    IF TG_TABLE_NAME = 'worlds' AND TG_OP IN ('INSERT', 'UPDATE')
      AND (new_payload ->> 'id')::uuid = locked_world_id THEN
      proposed_lifecycle_status := new_payload ->> 'lifecycle_status';
      IF proposed_lifecycle_status IN ('provisioning', 'active') THEN CONTINUE; END IF;
    END IF;
    IF TG_TABLE_NAME IN ('global_admin_audit_events','odoo_command_queue','odoo_projection_outbox','odoo_reconciliation_tasks') THEN CONTINUE; END IF;
    RAISE EXCEPTION 'world writer references missing or non-writable world %', locked_world_id;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
DECLARE
  binding record;
  trigger_arguments text;
BEGIN
  FOR binding IN
    SELECT * FROM (VALUES
      ('abuse_observations', ARRAY['world_id']::text[]),
      ('abuse_sanctions', ARRAY['world_id']::text[]),
      ('account_roles', ARRAY['world_id']::text[]),
      ('accounts', ARRAY['world_id']::text[]),
      ('alpha_feedback', ARRAY['world_id']::text[]),
      ('alpha_world_deployments', ARRAY['world_id']::text[]),
      ('alpha_world_profiles', ARRAY['world_id']::text[]),
      ('commerce_world_claims', ARRAY['world_id']::text[]),
      ('daily_operation_reports', ARRAY['world_id']::text[]),
      ('disruption_policies', ARRAY['world_id']::text[]),
      ('disruption_provider_applications', ARRAY['world_id']::text[]),
      ('disruption_provider_snapshots', ARRAY['world_id']::text[]),
      ('disruption_provider_states', ARRAY['world_id']::text[]),
      ('domain_events', ARRAY['world_id']::text[]),
      ('economy_effects', ARRAY['world_id']::text[]),
      ('economy_outbox', ARRAY['world_id']::text[]),
      ('economy_world_states', ARRAY['world_id']::text[]),
      ('fleet_mobilization_snapshots', ARRAY['world_id']::text[]),
      ('fleet_world_checkpoints', ARRAY['world_id']::text[]),
      ('game_admin_requests', ARRAY['world_id']::text[]),
      ('global_admin_audit_events', ARRAY['target_world_id']::text[]),
      ('infra_release_changes', ARRAY['world_id']::text[]),
      ('ledger_accounts', ARRAY['world_id']::text[]),
      ('ledger_entries', ARRAY['world_id']::text[]),
      ('ledger_transactions', ARRAY['world_id']::text[]),
      ('mailbox_messages', ARRAY['world_id']::text[]),
      ('odoo_command_queue', ARRAY['world_id']::text[]),
      ('odoo_projection_outbox', ARRAY['world_id']::text[]),
      ('odoo_reconciliation_tasks', ARRAY['world_id']::text[]),
      ('operating_program_versions', ARRAY['world_id']::text[]),
      ('operator_contracts', ARRAY['world_id']::text[]),
      ('operator_starting_capital', ARRAY['world_id']::text[]),
      ('operators', ARRAY['world_id']::text[]),
      ('planning_train_numbers', ARRAY['world_id']::text[]),
      ('rate_limit_buckets', ARRAY['world_id']::text[]),
      ('regional_simulation_states', ARRAY['world_id']::text[]),
      ('simulation_commands', ARRAY['world_id']::text[]),
      ('tutorial_progress', ARRAY['world_id']::text[]),
      ('tutorial_sessions', ARRAY['public_world_id', 'world_id']::text[]),
      ('tutorial_telemetry_events', ARRAY['world_id']::text[]),
      ('vehicle_asset_history_events', ARRAY['world_id']::text[]),
      ('vehicle_assets', ARRAY['world_id']::text[]),
      ('vehicle_market_listings', ARRAY['world_id']::text[]),
      ('vehicle_market_transfers', ARRAY['world_id']::text[]),
      ('world_accesses', ARRAY['world_id']::text[]),
      ('world_archives', ARRAY['world_id']::text[]),
      ('world_final_rankings', ARRAY['world_id']::text[]),
      ('world_participations', ARRAY['world_id']::text[]),
      ('worlds', ARRAY['id']::text[])
    ) AS configured(table_name, world_columns)
  LOOP
    SELECT string_agg(quote_literal(column_name), ', ' ORDER BY ordinal)
    INTO trigger_arguments
    FROM unnest(binding.world_columns) WITH ORDINALITY AS columns(column_name, ordinal);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_world_writer_guard(%s)',
      'zugfolge_world_guard_' || binding.table_name,
      binding.table_name,
      trigger_arguments
    );
  END LOOP;
END;
$$;
