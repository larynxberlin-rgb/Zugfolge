-- Nur die explizit als Tutorial markierten Altwelten werden entfernt.
-- Diese Migration läuft in der Transaktion des Migrators, bei gestopptem Game.
DO $$
DECLARE
  retired_world_ids text[];
  item record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM alpha_world_profiles profile JOIN worlds world ON world.id = profile.world_id
    WHERE profile.profile_kind = 'tutorial' AND world.world_kind <> 'private'
  ) THEN
    RAISE EXCEPTION 'retired profile points to a regular world; migration aborted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tutorial_sessions session
    JOIN worlds world ON world.id = session.world_id
    LEFT JOIN alpha_world_profiles profile ON profile.world_id = world.id
    WHERE world.world_kind <> 'private'
      OR (profile.profile_kind IS NOT NULL AND profile.profile_kind <> 'tutorial')
  ) THEN
    RAISE EXCEPTION 'retired session points to a regular world; migration aborted';
  END IF;
  SELECT coalesce(array_agg(world_id::text), ARRAY[]::text[]) INTO retired_world_ids
  FROM (
    SELECT world_id FROM alpha_world_profiles WHERE profile_kind = 'tutorial'
    UNION SELECT world_id FROM tutorial_sessions
  ) retired;

  DROP TABLE tutorial_telemetry_events, tutorial_sessions, tutorial_progress;

  IF cardinality(retired_world_ids) > 0 THEN
    -- Fremdschlüssel bleiben aktiv. Ihr Prüfzeitpunkt wird nur innerhalb dieser
    -- Transaktion verschoben, damit auch gegenseitige Referenzen löschbar sind.
    CREATE TEMP TABLE retired_world_foreign_keys ON COMMIT DROP AS
      SELECT conrelid::regclass AS relation, conname, condeferrable, condeferred
      FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace;
    FOR item IN SELECT * FROM retired_world_foreign_keys LOOP
      EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', item.relation, item.conname);
    END LOOP;
    SET CONSTRAINTS ALL DEFERRED;

    -- Append-only- und Archivschutz werden für die Löschung der aufgegebenen
    -- Welten ausgesetzt und anschließend exakt im ursprünglichen Modus gesetzt.
    CREATE TEMP TABLE retired_world_triggers ON COMMIT DROP AS
      SELECT trigger.tgrelid::regclass AS relation, trigger.tgname, trigger.tgenabled
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
      WHERE NOT trigger.tgisinternal AND trigger.tgenabled <> 'D'
        AND relation.relnamespace = 'public'::regnamespace;
    FOR item IN SELECT * FROM retired_world_triggers LOOP
      EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', item.relation, item.tgname);
    END LOOP;
    FOR item IN
      SELECT columns.table_schema, columns.table_name, columns.column_name FROM information_schema.columns columns
      JOIN information_schema.tables tables USING (table_schema, table_name)
      WHERE columns.table_schema = 'public' AND tables.table_type = 'BASE TABLE'
        AND (column_name = 'world_id' OR column_name LIKE '%\_world_id' ESCAPE '\')
      ORDER BY table_name, column_name
    LOOP
      EXECUTE format('DELETE FROM %I.%I WHERE %I::text = ANY($1)', item.table_schema, item.table_name, item.column_name)
        USING retired_world_ids;
    END LOOP;
    DELETE FROM worlds WHERE id::text = ANY(retired_world_ids);
    SET CONSTRAINTS ALL IMMEDIATE;
    FOR item IN SELECT * FROM retired_world_foreign_keys LOOP
      EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I %s %s', item.relation, item.conname,
        CASE WHEN item.condeferrable THEN 'DEFERRABLE' ELSE 'NOT DEFERRABLE' END,
        CASE WHEN item.condeferred THEN 'INITIALLY DEFERRED' ELSE 'INITIALLY IMMEDIATE' END);
    END LOOP;
    FOR item IN SELECT * FROM retired_world_triggers LOOP
      EXECUTE format('ALTER TABLE %s ENABLE %s TRIGGER %I', item.relation,
        CASE item.tgenabled WHEN 'A' THEN 'ALWAYS' WHEN 'R' THEN 'REPLICA' ELSE '' END, item.tgname);
    END LOOP;
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE alpha_world_profiles DROP CONSTRAINT alpha_world_profiles_profile_kind_check;
--> statement-breakpoint
ALTER TABLE alpha_world_profiles ADD CONSTRAINT alpha_world_profiles_profile_kind_check
  CHECK (profile_kind IN ('public', 'private', 'test'));
--> statement-breakpoint
ALTER TABLE alpha_world_profiles DROP CONSTRAINT alpha_world_profiles_acceleration_check;
--> statement-breakpoint
ALTER TABLE alpha_world_profiles ADD CONSTRAINT alpha_world_profiles_acceleration_check
  CHECK ((profile_kind = 'public' AND acceleration_factor = 1) OR profile_kind IN ('private', 'test'));
