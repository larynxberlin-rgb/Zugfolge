DO $$
DECLARE
  regional record;
  receipt record;
  receipt_count bigint;
  receipt_kind text;
  first_receipt_kind text;
  parsed_revision bigint;
  distinct_revision_count bigint;
  minimum_revision bigint;
  maximum_revision bigint;
BEGIN
  FOR regional IN
    SELECT world_id, region_id, revision, state
    FROM regional_simulation_states
    WHERE state_schema = 'zugfolge-operational-simulation-state/v2'
  LOOP
    SELECT count(*)
    INTO receipt_count
    FROM jsonb_each(coalesce(regional.state -> 'commandReceipts', '{}'::jsonb));

    -- Schema 29/31 schrieb eine unbegrenzte command_id -> command_hash Map.
    -- Die vor 0033 entstandene Historie ist nur dann beweisbar vollstaendig,
    -- wenn genau ein Receipt je bereits angewendeter Revision vorhanden ist.
    -- Ein schon begrenzter 4096er Suffix darf nicht stillschweigend zur
    -- dauerhaften Idempotenzhistorie erklaert werden.
    IF receipt_count <> regional.revision THEN
      RAISE EXCEPTION
        'cannot establish complete operational command receipt ledger for world % region %: revision %, receipt count %',
        regional.world_id, regional.region_id, regional.revision, receipt_count;
    END IF;

    first_receipt_kind := NULL;
    distinct_revision_count := 0;
    minimum_revision := NULL;
    maximum_revision := NULL;

    FOR receipt IN
      SELECT key AS command_id, value AS body
      FROM jsonb_each(coalesce(regional.state -> 'commandReceipts', '{}'::jsonb))
    LOOP
      IF length(receipt.command_id) = 0 THEN
        RAISE EXCEPTION
          'invalid empty operational command id for world % region %',
          regional.world_id, regional.region_id;
      END IF;

      receipt_kind := jsonb_typeof(receipt.body);
      IF first_receipt_kind IS NULL THEN
        first_receipt_kind := receipt_kind;
      ELSIF receipt_kind <> first_receipt_kind THEN
        RAISE EXCEPTION
          'mixed operational command receipt formats for world % region %',
          regional.world_id, regional.region_id;
      END IF;

      IF receipt_kind = 'string' THEN
        IF (receipt.body #>> '{}') !~ '^[a-f0-9]{64}$' THEN
          RAISE EXCEPTION
            'invalid legacy operational command receipt for world % region % command %',
            regional.world_id, regional.region_id, receipt.command_id;
        END IF;
      ELSIF receipt_kind = 'object' THEN
        IF coalesce(receipt.body ->> 'commandHash', '') !~ '^[a-f0-9]{64}$'
          OR coalesce(receipt.body ->> 'appliedRevision', '') !~ '^[1-9][0-9]*$'
        THEN
          RAISE EXCEPTION
            'invalid operational command receipt for world % region % command %',
            regional.world_id, regional.region_id, receipt.command_id;
        END IF;
        parsed_revision := (receipt.body ->> 'appliedRevision')::bigint;
        IF parsed_revision > regional.revision THEN
          RAISE EXCEPTION
            'future operational command receipt for world % region % command %',
            regional.world_id, regional.region_id, receipt.command_id;
        END IF;
      ELSE
        RAISE EXCEPTION
          'unsupported operational command receipt format for world % region % command %',
          regional.world_id, regional.region_id, receipt.command_id;
      END IF;
    END LOOP;

    IF first_receipt_kind = 'object' THEN
      SELECT
        count(DISTINCT (value ->> 'appliedRevision')::bigint),
        min((value ->> 'appliedRevision')::bigint),
        max((value ->> 'appliedRevision')::bigint)
      INTO distinct_revision_count, minimum_revision, maximum_revision
      FROM jsonb_each(coalesce(regional.state -> 'commandReceipts', '{}'::jsonb));

      IF distinct_revision_count <> regional.revision
        OR minimum_revision <> 1
        OR maximum_revision <> regional.revision
      THEN
        RAISE EXCEPTION
          'incomplete operational command receipt revisions for world % region %',
          regional.world_id, regional.region_id;
      END IF;
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "regional_simulation_states_initialization_key_idx"
  ON "regional_simulation_states" USING btree ("world_id", "region_id", "initialization_hash");
--> statement-breakpoint
CREATE TABLE "regional_simulation_command_receipts" (
  "world_id" uuid NOT NULL,
  "region_id" text NOT NULL,
  "initialization_hash" text NOT NULL,
  "command_id" text NOT NULL,
  "command_hash" text NOT NULL,
  -- Alte String-Receipts beweisen ID und Payload, enthalten aber keine
  -- rekonstruierbare Einzelrevision. NULL ist ausschliesslich dafuer gedacht.
  "applied_revision" bigint,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "regional_simulation_command_receipts_pk" PRIMARY KEY("world_id", "region_id", "initialization_hash", "command_id"),
  CONSTRAINT "regional_simulation_command_receipts_initialization_hash_sha256" CHECK ("initialization_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "regional_simulation_command_receipts_command_id_present" CHECK (length("command_id") > 0),
  CONSTRAINT "regional_simulation_command_receipts_command_hash_sha256" CHECK ("command_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "regional_simulation_command_receipts_revision_positive" CHECK ("applied_revision" IS NULL OR "applied_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "regional_simulation_command_receipts"
  ADD CONSTRAINT "regional_simulation_command_receipts_state_fk"
  FOREIGN KEY ("world_id", "region_id", "initialization_hash")
  REFERENCES "regional_simulation_states"("world_id", "region_id", "initialization_hash")
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "regional_simulation_command_receipts_revision_idx"
  ON "regional_simulation_command_receipts" USING btree ("world_id", "region_id", "initialization_hash", "applied_revision");
--> statement-breakpoint
-- Der Backfill laeuft bewusst vor dem World-Guard der neuen Tabelle. Damit
-- wird auch die vollstaendige Historie bereits archivierter/fenced Welten
-- materialisiert, ohne deren fachlichen Zustand zu mutieren.
INSERT INTO "regional_simulation_command_receipts" (
  "world_id", "region_id", "initialization_hash", "command_id", "command_hash", "applied_revision", "created_at"
)
SELECT
  regional.world_id,
  regional.region_id,
  regional.initialization_hash,
  receipt.command_id,
  CASE
    WHEN jsonb_typeof(receipt.body) = 'string' THEN receipt.body #>> '{}'
    ELSE receipt.body ->> 'commandHash'
  END,
  CASE
    WHEN jsonb_typeof(receipt.body) = 'object'
      THEN (receipt.body ->> 'appliedRevision')::bigint
    ELSE NULL
  END,
  regional.updated_at
FROM regional_simulation_states AS regional
CROSS JOIN LATERAL jsonb_each(
  coalesce(regional.state -> 'commandReceipts', '{}'::jsonb)
) AS receipt(command_id, body)
WHERE regional.state_schema = 'zugfolge-operational-simulation-state/v2';
--> statement-breakpoint
CREATE TRIGGER "zugfolge_world_guard_regional_simulation_command_receipts"
  BEFORE INSERT OR UPDATE OR DELETE ON "regional_simulation_command_receipts"
  FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_world_writer_guard('world_id');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zugfolge_capture_operational_command_receipts()
RETURNS trigger AS $$
DECLARE
  durable_receipt_count bigint;
BEGIN
  IF NEW.state_schema <> 'zugfolge-operational-simulation-state/v2' THEN
    RETURN NEW;
  END IF;

  -- String-Receipts sind ausschliesslich das vollstaendige Schema-29/31-
  -- Altformat. Objekt-Receipts muessen auch nach der Migration ihre exakte
  -- Einzelrevision tragen; ein fehlendes Feld darf nicht als Legacy-NULL in
  -- die dauerhafte Historie einsickern.
  IF EXISTS (
    SELECT 1
    FROM jsonb_each(
      coalesce(NEW.state -> 'commandReceipts', '{}'::jsonb)
    ) AS receipt(command_id, body)
    WHERE length(receipt.command_id) = 0
      OR CASE jsonb_typeof(receipt.body)
        WHEN 'string' THEN (receipt.body #>> '{}') !~ '^[a-f0-9]{64}$'
        WHEN 'object' THEN
          coalesce(receipt.body ->> 'commandHash', '') !~ '^[a-f0-9]{64}$'
          OR coalesce(receipt.body ->> 'appliedRevision', '') !~ '^[1-9][0-9]*$'
          OR (receipt.body ->> 'appliedRevision')::bigint > NEW.revision
        ELSE true
      END
  ) THEN
    RAISE EXCEPTION 'invalid operational command receipt checkpoint for world % region %',
      NEW.world_id, NEW.region_id;
  END IF;

  -- AFTER auf dem Checkpoint ist die gemeinsame Writer-Grenze: auch ein
  -- waehrend des Rollbackfensters laufendes Schema-31-Image, das 0033 nicht
  -- kennt, kann kein erfolgreiches Kommando ohne dauerhaftes Receipt committen.
  INSERT INTO regional_simulation_command_receipts (
    world_id, region_id, initialization_hash, command_id, command_hash, applied_revision, created_at
  )
  SELECT
    NEW.world_id,
    NEW.region_id,
    NEW.initialization_hash,
    receipt.command_id,
    CASE
      WHEN jsonb_typeof(receipt.body) = 'string' THEN receipt.body #>> '{}'
      ELSE receipt.body ->> 'commandHash'
    END,
    CASE
      WHEN jsonb_typeof(receipt.body) = 'object'
        THEN (receipt.body ->> 'appliedRevision')::bigint
      ELSE NULL
    END,
    NEW.updated_at
  FROM jsonb_each(
    coalesce(NEW.state -> 'commandReceipts', '{}'::jsonb)
  ) AS receipt(command_id, body)
  ON CONFLICT (world_id, region_id, initialization_hash, command_id) DO NOTHING;

  -- Ein nach 0033 wieder sichtbares Objekt-Receipt darf eine alte, bislang
  -- unbekannte Einzelrevision genau einmal anreichern. ID und Hash muessen
  -- bereits uebereinstimmen; der Unique-Index schuetzt die Revisionsfolge.
  UPDATE regional_simulation_command_receipts AS durable
  SET applied_revision = (receipt.body ->> 'appliedRevision')::bigint
  FROM jsonb_each(
    coalesce(NEW.state -> 'commandReceipts', '{}'::jsonb)
  ) AS receipt(command_id, body)
  WHERE durable.world_id = NEW.world_id
    AND durable.region_id = NEW.region_id
    AND durable.initialization_hash = NEW.initialization_hash
    AND durable.command_id = receipt.command_id
    AND durable.applied_revision IS NULL
    AND jsonb_typeof(receipt.body) = 'object'
    AND durable.command_hash = receipt.body ->> 'commandHash';

  IF EXISTS (
    SELECT 1
    FROM jsonb_each(
      coalesce(NEW.state -> 'commandReceipts', '{}'::jsonb)
    ) AS receipt(command_id, body)
    LEFT JOIN regional_simulation_command_receipts AS durable
      ON durable.world_id = NEW.world_id
      AND durable.region_id = NEW.region_id
      AND durable.initialization_hash = NEW.initialization_hash
      AND durable.command_id = receipt.command_id
    WHERE durable.command_id IS NULL
      OR durable.command_hash <> CASE
        WHEN jsonb_typeof(receipt.body) = 'string' THEN receipt.body #>> '{}'
        ELSE receipt.body ->> 'commandHash'
      END
      OR (
        jsonb_typeof(receipt.body) = 'object'
        AND durable.applied_revision IS DISTINCT FROM
          (receipt.body ->> 'appliedRevision')::bigint
      )
  ) THEN
    RAISE EXCEPTION 'operational command receipt ledger conflict for world % region %',
      NEW.world_id, NEW.region_id;
  END IF;

  SELECT count(*)
  INTO durable_receipt_count
  FROM regional_simulation_command_receipts AS durable
  WHERE durable.world_id = NEW.world_id
    AND durable.region_id = NEW.region_id
    AND durable.initialization_hash = NEW.initialization_hash;

  IF durable_receipt_count <> NEW.revision THEN
    RAISE EXCEPTION
      'operational command receipt ledger is incomplete for world % region %: revision %, receipt count %',
      NEW.world_id, NEW.region_id, NEW.revision, durable_receipt_count;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zugfolge_enforce_operational_initialization_immutability()
RETURNS trigger AS $$
BEGIN
  IF OLD.state_schema = 'zugfolge-operational-simulation-state/v2'
    AND (
      NEW.state_schema IS DISTINCT FROM OLD.state_schema
      OR NEW.initialization_hash IS DISTINCT FROM OLD.initialization_hash
    )
  THEN
    RAISE EXCEPTION
      'operational initialization binding is immutable for world % region %; delete and initialize a new head instead',
      OLD.world_id, OLD.region_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "zugfolge_enforce_operational_initialization_immutability"
  BEFORE UPDATE OF state_schema, initialization_hash
  ON "regional_simulation_states"
  FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_operational_initialization_immutability();
--> statement-breakpoint
CREATE TRIGGER "zugfolge_capture_operational_command_receipts"
  AFTER INSERT OR UPDATE OF state, state_schema, updated_at
  ON "regional_simulation_states"
  FOR EACH ROW EXECUTE FUNCTION zugfolge_capture_operational_command_receipts();
