-- Enger Archiv-Datenschutzpfad: keine freie Tabellen-/Spaltenredaktion.
CREATE TABLE archive_privacy_requests (
  world_id uuid NOT NULL REFERENCES worlds(id), request_id uuid NOT NULL,
  sequence bigint NOT NULL, action text NOT NULL, object_id uuid NOT NULL,
  as_of timestamptz NOT NULL, content_hash text, completed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(world_id, request_id), UNIQUE(world_id, sequence), UNIQUE(world_id, action, object_id),
  CONSTRAINT archive_privacy_requests_shape CHECK(sequence > 0
    AND action IN ('account-request','account-purge','mailbox-purge')
    AND (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
CREATE TABLE archive_privacy_rows (
  world_id uuid NOT NULL, request_id uuid NOT NULL, row_sequence bigint NOT NULL,
  table_name text NOT NULL, before_sha256 text NOT NULL, before_v1_sha256 text NOT NULL,
  before_v1_added_facts boolean NOT NULL, after_sha256 text,
  PRIMARY KEY(world_id, request_id, row_sequence),
  FOREIGN KEY(world_id, request_id) REFERENCES archive_privacy_requests(world_id, request_id),
  CONSTRAINT archive_privacy_rows_hashes CHECK(before_sha256 ~ '^[a-f0-9]{64}$'
    AND before_v1_sha256 ~ '^[a-f0-9]{64}$' AND (after_sha256 IS NULL OR after_sha256 ~ '^[a-f0-9]{64}$')),
  CONSTRAINT archive_privacy_rows_tables CHECK(table_name IN
    ('accounts','world_accesses','account_roles','world_participations','mailbox_messages',
     'conductor_owners','conductor_leases','conductor_command_receipts','conductor_snapshots'))
);
--> statement-breakpoint
CREATE FUNCTION zugfolge_archive_privacy_allowed(target_table text, operation text, old_row jsonb, new_row jsonb)
RETURNS boolean AS $$
DECLARE
  request archive_privacy_requests%ROWTYPE;
  account accounts%ROWTYPE;
  allowed_columns text[];
BEGIN
  IF pg_trigger_depth() < 2 OR old_row IS NULL OR operation NOT IN ('UPDATE','DELETE') THEN RETURN false; END IF;
  SELECT * INTO request FROM archive_privacy_requests
    WHERE world_id = (old_row->>'world_id')::uuid AND NOT completed;
  IF NOT FOUND THEN RETURN false; END IF;
  IF request.action = 'mailbox-purge' THEN
    IF target_table <> 'mailbox_messages' OR operation <> 'UPDATE'
      OR old_row->>'id' <> request.object_id::text THEN RETURN false; END IF;
    RETURN (old_row - ARRAY['payload','message_type','content_hash','purged_at'])
        = (new_row - ARRAY['payload','message_type','content_hash','purged_at'])
      AND old_row->>'purged_at' IS NULL
      AND (old_row->>'sent_at')::timestamptz <= request.as_of - interval '365 days'
      AND (old_row->>'deadline_at' IS NULL OR (old_row->>'deadline_at')::timestamptz <= request.as_of)
      AND new_row->'payload' = '{}'::jsonb AND new_row->>'message_type' = 'system.retention-purged'
      AND new_row->>'content_hash' = coalesce(old_row->>'content_hash', request.content_hash)
      AND (new_row->>'purged_at')::timestamptz = request.as_of;
  END IF;
  SELECT * INTO account FROM accounts WHERE world_id = request.world_id AND id = request.object_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF request.action = 'account-purge' AND
    (account.erased_at IS NULL OR account.erased_at > request.as_of - interval '90 days') THEN RETURN false; END IF;
  IF target_table IN ('conductor_leases','conductor_owners') THEN
    RETURN operation = 'DELETE' AND old_row->>'account_id' = account.id::text;
  END IF;
  IF target_table IN ('conductor_command_receipts','conductor_snapshots') THEN
    RETURN operation = 'DELETE' AND EXISTS (SELECT 1 FROM conductor_owners
      WHERE world_id = request.world_id AND account_id = account.id AND owner_ref::text = old_row->>'owner_ref');
  END IF;
  IF target_table = 'account_roles' THEN
    RETURN request.action = 'account-purge' AND operation = 'DELETE' AND old_row->>'account_id' = account.id::text;
  END IF;
  IF operation <> 'UPDATE' THEN RETURN false; END IF;
  IF target_table = 'accounts' AND old_row->>'id' = account.id::text THEN
    IF request.action = 'account-request' THEN
      RETURN (old_row - ARRAY['display_name','erased_at']) = (new_row - ARRAY['display_name','erased_at'])
        AND new_row->>'display_name' = 'Gelöschtes Konto'
        AND (new_row->>'erased_at')::timestamptz = coalesce(account.erased_at, request.as_of);
    END IF;
    RETURN (old_row - ARRAY['display_name','keycloak_subject']) = (new_row - ARRAY['display_name','keycloak_subject'])
      AND new_row->>'display_name' = 'Gelöschtes Konto' AND new_row->>'keycloak_subject' = 'erased:' || account.id::text;
  END IF;
  IF target_table = 'world_accesses' AND old_row->>'keycloak_subject' = account.keycloak_subject THEN
    IF request.action = 'account-request' THEN
      RETURN (old_row - ARRAY['status','revoked_at']) = (new_row - ARRAY['status','revoked_at'])
        AND new_row->>'status' = 'revoked'
        AND (new_row->>'revoked_at')::timestamptz = coalesce((old_row->>'revoked_at')::timestamptz, request.as_of);
    END IF;
    RETURN (old_row - 'keycloak_subject') = (new_row - 'keycloak_subject')
      AND new_row->>'keycloak_subject' = 'erased:' || account.id::text;
  END IF;
  IF target_table = 'world_participations' AND request.action = 'account-purge'
    AND old_row->>'keycloak_subject' = account.keycloak_subject THEN
    RETURN (old_row - ARRAY['keycloak_subject','display_name']) = (new_row - ARRAY['keycloak_subject','display_name'])
      AND new_row->>'keycloak_subject' = 'erased:' || account.id::text AND new_row->>'display_name' = 'Gelöschtes Konto';
  END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION zugfolge_archive_privacy_capture() RETURNS trigger AS $$
DECLARE
  request archive_privacy_requests%ROWTYPE;
  old_json jsonb := to_jsonb(OLD);
  new_json jsonb;
  historical_json jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN new_json := to_jsonb(NEW); END IF;
  IF NOT zugfolge_archive_privacy_allowed(TG_TABLE_NAME, TG_OP, old_json, new_json) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT * INTO STRICT request FROM archive_privacy_requests
    WHERE world_id = (old_json->>'world_id')::uuid AND NOT completed;
  historical_json := old_json;
  IF TG_TABLE_NAME = 'mailbox_messages' THEN historical_json := old_json - ARRAY['content_hash','purged_at']; END IF;
  INSERT INTO archive_privacy_rows(world_id, request_id, row_sequence, table_name,
    before_sha256, before_v1_sha256, before_v1_added_facts, after_sha256)
  SELECT request.world_id, request.request_id, coalesce(max(row_sequence),0)+1, TG_TABLE_NAME,
    encode(sha256(convert_to(old_json::text,'UTF8')),'hex'),
    encode(sha256(convert_to(historical_json::text,'UTF8')),'hex'),
    TG_TABLE_NAME = 'mailbox_messages' AND (old_json->>'content_hash' IS NOT NULL OR old_json->>'purged_at' IS NOT NULL),
    CASE WHEN new_json IS NULL THEN NULL ELSE encode(sha256(convert_to(new_json::text,'UTF8')),'hex') END
  FROM archive_privacy_rows WHERE world_id = request.world_id AND request_id = request.request_id;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION zugfolge_archive_privacy_rows_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR pg_trigger_depth() <> 3 OR NOT EXISTS (
    SELECT 1 FROM archive_privacy_requests WHERE world_id = NEW.world_id AND request_id = NEW.request_id AND NOT completed
  ) THEN RAISE EXCEPTION 'Archivredaktionsbelege sind unveraenderlich und nur durch die feste Redaktion erzeugbar'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER archive_privacy_rows_immutable BEFORE INSERT OR UPDATE OR DELETE ON archive_privacy_rows
  FOR EACH ROW EXECUTE FUNCTION zugfolge_archive_privacy_rows_guard();
--> statement-breakpoint
CREATE FUNCTION zugfolge_archive_privacy_request_guard() RETURNS trigger AS $$
DECLARE
  lifecycle text;
  previous_sequence bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() <> 2 OR OLD.completed OR NOT NEW.completed
      OR (to_jsonb(OLD) - 'completed') <> (to_jsonb(NEW) - 'completed') THEN
      RAISE EXCEPTION 'Archivredaktionsauftrag ist unveraenderlich';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' OR NEW.completed THEN RAISE EXCEPTION 'Archivredaktionsauftrag ist unveraenderlich'; END IF;
  PERFORM pg_advisory_xact_lock(('x' || substr(md5(NEW.world_id::text),1,16))::bit(64)::bigint);
  SELECT lifecycle_status INTO lifecycle FROM worlds WHERE id = NEW.world_id FOR UPDATE;
  IF lifecycle IS DISTINCT FROM 'archived' THEN RAISE EXCEPTION 'Archivredaktion verlangt eine archivierte Welt'; END IF;
  IF EXISTS (SELECT 1 FROM archive_privacy_requests WHERE world_id=NEW.world_id AND NOT completed) THEN
    RAISE EXCEPTION 'Archivredaktion besitzt einen unvollstaendigen Vorgaenger';
  END IF;
  SELECT coalesce(max(sequence),0) INTO previous_sequence FROM archive_privacy_requests WHERE world_id=NEW.world_id;
  IF NEW.sequence <> previous_sequence + 1 THEN RAISE EXCEPTION 'Archivredaktionsfolge ist nicht lueckenlos'; END IF;
  IF NOT isfinite(NEW.as_of) THEN RAISE EXCEPTION 'Archivredaktionszeit ist ungueltig'; END IF;
  IF NEW.action IN ('account-request','account-purge') AND NOT EXISTS
    (SELECT 1 FROM accounts WHERE world_id=NEW.world_id AND id=NEW.object_id
      AND (NEW.action='account-request' OR (erased_at <= NEW.as_of-interval '90 days' AND keycloak_subject NOT LIKE 'erased:%'))) THEN
    RAISE EXCEPTION 'Archivkonto ist nicht fuer diese Redaktion freigegeben oder faellig';
  END IF;
  IF NEW.action='mailbox-purge' AND (NEW.content_hash IS NULL OR NOT EXISTS
    (SELECT 1 FROM mailbox_messages WHERE world_id=NEW.world_id AND id=NEW.object_id AND purged_at IS NULL
      AND sent_at <= NEW.as_of-interval '365 days' AND (deadline_at IS NULL OR deadline_at <= NEW.as_of))) THEN
    RAISE EXCEPTION 'Archivnachricht ist nicht faellig oder fachlich gehalten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER archive_privacy_requests_immutable BEFORE INSERT OR UPDATE OR DELETE ON archive_privacy_requests
  FOR EACH ROW EXECUTE FUNCTION zugfolge_archive_privacy_request_guard();
--> statement-breakpoint
CREATE FUNCTION zugfolge_archive_privacy_apply() RETURNS trigger AS $$
DECLARE
  subject text;
BEGIN
  IF NEW.action IN ('account-request','account-purge') THEN
    SELECT keycloak_subject INTO STRICT subject FROM accounts WHERE world_id=NEW.world_id AND id=NEW.object_id;
    DELETE FROM conductor_leases WHERE world_id=NEW.world_id AND account_id=NEW.object_id;
    DELETE FROM conductor_command_receipts WHERE world_id=NEW.world_id AND owner_ref IN
      (SELECT owner_ref FROM conductor_owners WHERE world_id=NEW.world_id AND account_id=NEW.object_id);
    DELETE FROM conductor_snapshots WHERE world_id=NEW.world_id AND owner_ref IN
      (SELECT owner_ref FROM conductor_owners WHERE world_id=NEW.world_id AND account_id=NEW.object_id);
    DELETE FROM conductor_owners WHERE world_id=NEW.world_id AND account_id=NEW.object_id;
    IF NEW.action='account-request' THEN
      UPDATE world_accesses SET status='revoked', revoked_at=coalesce(revoked_at,NEW.as_of)
        WHERE world_id=NEW.world_id AND keycloak_subject=subject;
      UPDATE accounts SET display_name='Gelöschtes Konto', erased_at=coalesce(erased_at,NEW.as_of)
        WHERE world_id=NEW.world_id AND id=NEW.object_id;
    ELSE
      UPDATE world_accesses SET keycloak_subject='erased:' || NEW.object_id::text
        WHERE world_id=NEW.world_id AND keycloak_subject=subject;
      UPDATE world_participations SET keycloak_subject='erased:' || NEW.object_id::text, display_name='Gelöschtes Konto'
        WHERE world_id=NEW.world_id AND keycloak_subject=subject;
      DELETE FROM account_roles WHERE world_id=NEW.world_id AND account_id=NEW.object_id;
      UPDATE accounts SET keycloak_subject='erased:' || NEW.object_id::text, display_name='Gelöschtes Konto'
        WHERE world_id=NEW.world_id AND id=NEW.object_id;
    END IF;
  ELSE
    UPDATE mailbox_messages SET payload='{}'::jsonb, message_type='system.retention-purged',
      content_hash=coalesce(content_hash,NEW.content_hash), purged_at=NEW.as_of
      WHERE world_id=NEW.world_id AND id=NEW.object_id;
  END IF;
  UPDATE archive_privacy_requests SET completed=true WHERE world_id=NEW.world_id AND request_id=NEW.request_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER archive_privacy_requests_apply AFTER INSERT ON archive_privacy_requests
  FOR EACH ROW EXECUTE FUNCTION zugfolge_archive_privacy_apply();
--> statement-breakpoint
DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['accounts','world_accesses','account_roles','world_participations','mailbox_messages',
    'conductor_owners','conductor_leases','conductor_command_receipts','conductor_snapshots'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION zugfolge_archive_privacy_capture()', 'zugfolge_archive_privacy_capture_' || relation_name, relation_name);
  END LOOP;
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
  IF zugfolge_archive_privacy_allowed(TG_TABLE_NAME, TG_OP, CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END, CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
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
