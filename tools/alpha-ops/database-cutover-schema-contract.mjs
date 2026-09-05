import { createHash } from "node:crypto";

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

export function normalizeDatabaseDefinition(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\s+/gu, " ").trim();
}

function definitionSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(sortedValue(value)))
    .digest("hex");
}

function constraint(name, relation, type, definition) {
  const descriptor = Object.freeze({
    name,
    relation,
    type,
    definition: normalizeDatabaseDefinition(definition),
  });
  return Object.freeze({ ...descriptor, definitionSha256: definitionSha256(descriptor) });
}

function guard(name, relation, type, functionName, triggerDefinition, functionSource) {
  const descriptor = Object.freeze({
    name,
    relation,
    type,
    functionName,
    triggerDefinition: normalizeDatabaseDefinition(triggerDefinition),
    functionSource: normalizeDatabaseDefinition(functionSource),
  });
  return Object.freeze({ ...descriptor, definitionSha256: definitionSha256(descriptor) });
}

export const DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32 = Object.freeze([
  "abuse_observations",
  "abuse_sanctions",
  "account_roles",
  "accounts",
  "alpha_feedback",
  "alpha_world_deployments",
  "alpha_world_profiles",
  "commerce_entitlements",
  "commerce_world_claims",
  "daily_operation_reports",
  "disruption_policies",
  "disruption_provider_applications",
  "disruption_provider_snapshots",
  "disruption_provider_states",
  "domain_events",
  "economy_effects",
  "economy_outbox",
  "economy_world_states",
  "fleet_mobilization_snapshots",
  "fleet_world_checkpoints",
  "game_admin_requests",
  "global_admin_audit_events",
  "infra_release_changes",
  "ledger_accounts",
  "ledger_entries",
  "ledger_transactions",
  "mailbox_messages",
  "odoo_command_queue",
  "odoo_projection_outbox",
  "odoo_reconciliation_tasks",
  "odoo_webhook_receipts",
  "operating_program_versions",
  "operator_contracts",
  "operator_starting_capital",
  "operators",
  "planning_train_numbers",
  "rate_limit_buckets",
  "regional_simulation_states",
  "simulation_commands",
  "tutorial_progress",
  "tutorial_sessions",
  "tutorial_telemetry_events",
  "vehicle_asset_history_events",
  "vehicle_assets",
  "vehicle_market_listings",
  "vehicle_market_transfers",
  "world_accesses",
  "world_archives",
  "world_final_rankings",
  "world_participations",
  "worlds",
]);
export const DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32_SET_SHA256 = definitionSha256(
  DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32,
);

export const DATABASE_AUTHORITATIVE_TABLES_SCHEMA_33_ADDITIONS = Object.freeze([
  "regional_simulation_command_receipts",
]);

export const DATABASE_AUTHORITATIVE_TABLES = Object.freeze([
  ...DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32,
  ...DATABASE_AUTHORITATIVE_TABLES_SCHEMA_33_ADDITIONS,
].sort((left, right) => left.localeCompare(right, "en")));

export const DATABASE_AUTHORITATIVE_TABLE_SET_SHA256 = definitionSha256(DATABASE_AUTHORITATIVE_TABLES);

// Der Schema-33-Vertrag bleibt unveraendert fuer bereits signierte v3-Belege.
export const DATABASE_AUTHORITATIVE_TABLES_SCHEMA_34 = Object.freeze([
  ...DATABASE_AUTHORITATIVE_TABLES, "odoo_projection_quarantine",
].sort((left, right) => left.localeCompare(right, "en")));
export const DATABASE_AUTHORITATIVE_TABLE_SET_SHA256_SCHEMA_34 = definitionSha256(DATABASE_AUTHORITATIVE_TABLES_SCHEMA_34);

// Historische Signaturen behalten ihren Tabellenvertrag. Schema 35 entfernt die alten Lernweltdaten.
const RETIRED_TABLES = new Set(["tutorial_progress", "tutorial_sessions", "tutorial_telemetry_events"]);
export const DATABASE_AUTHORITATIVE_TABLES_SCHEMA_35 = Object.freeze(DATABASE_AUTHORITATIVE_TABLES_SCHEMA_34.filter((table) => !RETIRED_TABLES.has(table)));
export const DATABASE_AUTHORITATIVE_TABLE_SET_SHA256_SCHEMA_35 = definitionSha256(DATABASE_AUTHORITATIVE_TABLES_SCHEMA_35);

export function databaseWorldHistoryBindings(migrationCount) {
  databaseAuthoritativeCatalog(migrationCount);
  return migrationCount === 35 ? DATABASE_WORLD_HISTORY_BINDINGS.filter(({ table }) => !RETIRED_TABLES.has(table)) : DATABASE_WORLD_HISTORY_BINDINGS;
}

export function databaseCutoverGuards(migrationCount) {
  databaseAuthoritativeCatalog(migrationCount);
  return migrationCount === 35 ? DATABASE_CUTOVER_GUARDS.filter(({ relation }) => !RETIRED_TABLES.has(relation)) : DATABASE_CUTOVER_GUARDS;
}

export function databaseAuthoritativeCatalog(migrationCount) {
  if (migrationCount === 35) return Object.freeze({ tables: DATABASE_AUTHORITATIVE_TABLES_SCHEMA_35, tableSetSha256: DATABASE_AUTHORITATIVE_TABLE_SET_SHA256_SCHEMA_35 });
  if (migrationCount === 33) return Object.freeze({ tables: DATABASE_AUTHORITATIVE_TABLES, tableSetSha256: DATABASE_AUTHORITATIVE_TABLE_SET_SHA256 });
  if (migrationCount === 34) return Object.freeze({ tables: DATABASE_AUTHORITATIVE_TABLES_SCHEMA_34, tableSetSha256: DATABASE_AUTHORITATIVE_TABLE_SET_SHA256_SCHEMA_34 });
  throw new Error(`Schema ${migrationCount} besitzt keinen qualifizierten autoritativen Tabellenvertrag.`);
}

export const DATABASE_WORLD_HISTORY_BINDINGS = Object.freeze([
  ["abuse_observations", ["world_id"]],
  ["abuse_sanctions", ["world_id"]],
  ["account_roles", ["world_id"]],
  ["accounts", ["world_id"]],
  ["alpha_feedback", ["world_id"]],
  ["alpha_world_deployments", ["world_id"]],
  ["alpha_world_profiles", ["world_id"]],
  ["commerce_world_claims", ["world_id"]],
  ["daily_operation_reports", ["world_id"]],
  ["disruption_policies", ["world_id"]],
  ["disruption_provider_applications", ["world_id"]],
  ["disruption_provider_snapshots", ["world_id"]],
  ["disruption_provider_states", ["world_id"]],
  ["domain_events", ["world_id"]],
  ["economy_effects", ["world_id"]],
  ["economy_outbox", ["world_id"]],
  ["economy_world_states", ["world_id"]],
  ["fleet_mobilization_snapshots", ["world_id"]],
  ["fleet_world_checkpoints", ["world_id"]],
  ["game_admin_requests", ["world_id"]],
  ["global_admin_audit_events", ["target_world_id"]],
  ["infra_release_changes", ["world_id"]],
  ["ledger_accounts", ["world_id"]],
  ["ledger_entries", ["world_id"]],
  ["ledger_transactions", ["world_id"]],
  ["mailbox_messages", ["world_id"]],
  ["odoo_command_queue", ["world_id"]],
  ["odoo_projection_outbox", ["world_id"]],
  ["odoo_reconciliation_tasks", ["world_id"]],
  ["operating_program_versions", ["world_id"]],
  ["operator_contracts", ["world_id"]],
  ["operator_starting_capital", ["world_id"]],
  ["operators", ["world_id"]],
  ["planning_train_numbers", ["world_id"]],
  ["rate_limit_buckets", ["world_id"]],
  ["regional_simulation_command_receipts", ["world_id"]],
  ["regional_simulation_states", ["world_id"]],
  ["simulation_commands", ["world_id"]],
  ["tutorial_progress", ["world_id"]],
  ["tutorial_sessions", ["public_world_id", "world_id"]],
  ["tutorial_telemetry_events", ["world_id"]],
  ["vehicle_asset_history_events", ["world_id"]],
  ["vehicle_assets", ["world_id"]],
  ["vehicle_market_listings", ["world_id"]],
  ["vehicle_market_transfers", ["world_id"]],
  ["world_accesses", ["world_id"]],
  ["world_archives", ["world_id"]],
  ["world_final_rankings", ["world_id"]],
  ["world_participations", ["world_id"]],
  ["worlds", ["id"]],
].map(([table, columns]) => Object.freeze({ table, columns: Object.freeze(columns) })));

export const DATABASE_GLOBAL_AUTHORITATIVE_TABLES = Object.freeze([
  "commerce_entitlements",
  "odoo_webhook_receipts",
]);

// Drizzle fuehrt alle ausstehenden PostgreSQL-Migrationen in einer Transaktion
// aus. Der Schema-32-Altzustandscheck muss diese drei Relationen deshalb vor
// seinem ersten Snapshot sperren und die Sperren bis zum Migrations-Commit
// halten: Outbox-DML und Lifecycle-Archivierung koennen sonst zwischen Check
// und Triggerinstallation einen unquittierbaren Zustand erzeugen.
export const DATABASE_WORLD_WRITER_GUARD_MIGRATION_LOCK_SQL = normalizeDatabaseDefinition(
  "LOCK TABLE economy_outbox, odoo_projection_outbox, worlds IN SHARE ROW EXCLUSIVE MODE",
);

const classifiedAuthoritativeTables = [
  ...DATABASE_WORLD_HISTORY_BINDINGS.map(({ table }) => table),
  ...DATABASE_GLOBAL_AUTHORITATIVE_TABLES,
].sort((left, right) => left.localeCompare(right, "en"));
if (JSON.stringify(classifiedAuthoritativeTables) !== JSON.stringify(DATABASE_AUTHORITATIVE_TABLES)) {
  throw new Error("Der Schema-33-Vertrag klassifiziert nicht jede autoritative Tabelle exakt als weltgebunden oder global.");
}

export const DATABASE_CUTOVER_CONSTRAINTS = Object.freeze([
  constraint(
    "regional_simulation_command_receipts_command_hash_sha256",
    "regional_simulation_command_receipts",
    "c",
    "CHECK (command_hash ~ '^[a-f0-9]{64}$'::text)",
  ),
  constraint(
    "regional_simulation_command_receipts_command_id_present",
    "regional_simulation_command_receipts",
    "c",
    "CHECK (length(command_id) > 0)",
  ),
  constraint(
    "regional_simulation_command_receipts_initialization_hash_sha256",
    "regional_simulation_command_receipts",
    "c",
    "CHECK (initialization_hash ~ '^[a-f0-9]{64}$'::text)",
  ),
  constraint(
    "regional_simulation_command_receipts_pk",
    "regional_simulation_command_receipts",
    "p",
    "PRIMARY KEY (world_id, region_id, initialization_hash, command_id)",
  ),
  constraint(
    "regional_simulation_command_receipts_revision_positive",
    "regional_simulation_command_receipts",
    "c",
    "CHECK (applied_revision IS NULL OR applied_revision > 0)",
  ),
  constraint(
    "regional_simulation_command_receipts_state_fk",
    "regional_simulation_command_receipts",
    "f",
    "FOREIGN KEY (world_id, region_id, initialization_hash) REFERENCES regional_simulation_states(world_id, region_id, initialization_hash) ON DELETE CASCADE",
  ),
  constraint(
    "regional_simulation_states_initialization_hash_present",
    "regional_simulation_states",
    "c",
    "CHECK (state_schema = 'zugfolge-regional-simulation-state/v1'::text AND initialization_hash IS NULL OR state_schema = 'zugfolge-operational-simulation-state/v2'::text AND initialization_hash IS NOT NULL)",
  ),
  constraint(
    "regional_simulation_states_initialization_hash_sha256",
    "regional_simulation_states",
    "c",
    "CHECK (initialization_hash IS NULL OR initialization_hash ~ '^[a-f0-9]{64}$'::text)",
  ),
  constraint(
    "regional_simulation_states_legacy_writer_fence_shape",
    "regional_simulation_states",
    "c",
    "CHECK (NOT legacy_writer_fenced OR state_schema = 'zugfolge-regional-simulation-state/v1'::text)",
  ),
  constraint(
    "world_cutover_receipts_candidate_world_fk",
    "world_cutover_receipts",
    "f",
    "FOREIGN KEY (candidate_world_id) REFERENCES worlds(id)",
  ),
  constraint(
    "world_cutover_receipts_database_fk",
    "world_cutover_receipts",
    "f",
    "FOREIGN KEY (database_id) REFERENCES zugfolge_database_identity(database_id)",
  ),
  constraint(
    "world_cutover_receipts_hash_format",
    "world_cutover_receipts",
    "c",
    "CHECK (candidate_deployment_hash ~ '^[a-f0-9]{64}$'::text AND before_authoritative_head_sha256 ~ '^[a-f0-9]{64}$'::text AND after_authoritative_head_sha256 ~ '^[a-f0-9]{64}$'::text AND receipt_hash ~ '^[a-f0-9]{64}$'::text AND (predecessor_deployment_hash IS NULL OR predecessor_deployment_hash ~ '^[a-f0-9]{64}$'::text) AND (predecessor_final_state_hash IS NULL OR predecessor_final_state_hash ~ '^[a-f0-9]{64}$'::text))",
  ),
  constraint(
    "world_cutover_receipts_mode",
    "world_cutover_receipts",
    "c",
    "CHECK (mode = ANY (ARRAY['authorized-v1-to-v2-cutover'::text, 'new-v2-world'::text]))",
  ),
  constraint(
    "world_cutover_receipts_pkey",
    "world_cutover_receipts",
    "p",
    "PRIMARY KEY (candidate_world_id)",
  ),
  constraint(
    "world_cutover_receipts_predecessor_world_fk",
    "world_cutover_receipts",
    "f",
    "FOREIGN KEY (predecessor_world_id) REFERENCES worlds(id)",
  ),
  constraint(
    "world_cutover_receipts_shape",
    "world_cutover_receipts",
    "c",
    "CHECK (mode = 'authorized-v1-to-v2-cutover'::text AND predecessor_world_id IS NOT NULL AND predecessor_deployment_hash IS NOT NULL AND predecessor_final_state_hash IS NOT NULL OR mode = 'new-v2-world'::text AND predecessor_world_id IS NULL AND predecessor_deployment_hash IS NULL AND predecessor_final_state_hash IS NULL)",
  ),
  constraint(
    "zugfolge_database_identity_database_id_unique",
    "zugfolge_database_identity",
    "u",
    "UNIQUE (database_id)",
  ),
  constraint(
    "zugfolge_database_identity_pkey",
    "zugfolge_database_identity",
    "p",
    "PRIMARY KEY (singleton)",
  ),
  constraint(
    "zugfolge_database_identity_singleton",
    "zugfolge_database_identity",
    "c",
    "CHECK (singleton = 1)",
  ),
].sort((left, right) => left.name.localeCompare(right.name, "en")));

const IMMUTABLE_AUDIT_SOURCE = `
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
`;

const ODOO_OUTBOX_WORLD_GUARD_SOURCE = `
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
`;

const OPERATIONAL_COMMAND_RECEIPT_CAPTURE_SOURCE = `
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
`;

const OPERATIONAL_INITIALIZATION_IMMUTABILITY_SOURCE = `
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
`;

const DATABASE_BASE_CUTOVER_GUARDS = [
  guard(
    "alpha_world_final_state_hash_immutable",
    "alpha_world_profiles",
    19,
    "zugfolge_protect_alpha_world_final_state_hash",
    "CREATE TRIGGER alpha_world_final_state_hash_immutable BEFORE UPDATE ON alpha_world_profiles FOR EACH ROW EXECUTE FUNCTION zugfolge_protect_alpha_world_final_state_hash()",
    `
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
`,
  ),
  guard(
    "domain_events_append_only",
    "domain_events",
    27,
    "zugfolge_reject_immutable_audit_mutation",
    "CREATE TRIGGER domain_events_append_only BEFORE DELETE OR UPDATE ON domain_events FOR EACH ROW EXECUTE FUNCTION zugfolge_reject_immutable_audit_mutation()",
    IMMUTABLE_AUDIT_SOURCE,
  ),
  guard(
    "odoo_projection_outbox_world_guard",
    "odoo_projection_outbox",
    23,
    "zugfolge_enforce_odoo_outbox_world",
    "CREATE TRIGGER odoo_projection_outbox_world_guard BEFORE INSERT OR UPDATE OF world_id, message_type, correlation_id, payload ON odoo_projection_outbox FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_odoo_outbox_world()",
    ODOO_OUTBOX_WORLD_GUARD_SOURCE,
  ),
  guard(
    "zugfolge_capture_operational_command_receipts",
    "regional_simulation_states",
    21,
    "zugfolge_capture_operational_command_receipts",
    "CREATE TRIGGER zugfolge_capture_operational_command_receipts AFTER INSERT OR UPDATE OF state, state_schema, updated_at ON regional_simulation_states FOR EACH ROW EXECUTE FUNCTION zugfolge_capture_operational_command_receipts()",
    OPERATIONAL_COMMAND_RECEIPT_CAPTURE_SOURCE,
  ),
  guard(
    "zugfolge_enforce_operational_initialization_immutability",
    "regional_simulation_states",
    19,
    "zugfolge_enforce_operational_initialization_immutability",
    "CREATE TRIGGER zugfolge_enforce_operational_initialization_immutability BEFORE UPDATE OF state_schema, initialization_hash ON regional_simulation_states FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_operational_initialization_immutability()",
    OPERATIONAL_INITIALIZATION_IMMUTABILITY_SOURCE,
  ),
  guard(
    "regional_simulation_states_legacy_writer_fence",
    "regional_simulation_states",
    31,
    "zugfolge_enforce_regional_writer_fence",
    "CREATE TRIGGER regional_simulation_states_legacy_writer_fence BEFORE INSERT OR DELETE OR UPDATE ON regional_simulation_states FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_regional_writer_fence()",
    `
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
`,
  ),
  guard(
    "world_cutover_receipts_immutable",
    "world_cutover_receipts",
    27,
    "zugfolge_reject_immutable_audit_mutation",
    "CREATE TRIGGER world_cutover_receipts_immutable BEFORE DELETE OR UPDATE ON world_cutover_receipts FOR EACH ROW EXECUTE FUNCTION zugfolge_reject_immutable_audit_mutation()",
    IMMUTABLE_AUDIT_SOURCE,
  ),
  guard(
    "zugfolge_database_identity_immutable",
    "zugfolge_database_identity",
    27,
    "zugfolge_reject_immutable_audit_mutation",
    "CREATE TRIGGER zugfolge_database_identity_immutable BEFORE DELETE OR UPDATE ON zugfolge_database_identity FOR EACH ROW EXECUTE FUNCTION zugfolge_reject_immutable_audit_mutation()",
    IMMUTABLE_AUDIT_SOURCE,
  ),
];

const WORLD_WRITER_GUARD_SOURCE = `
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
  IF TG_NARGS < 1 THEN
    RAISE EXCEPTION 'world writer guard has no bound world column';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_payload := to_jsonb(OLD);
    FOR argument_index IN 0..TG_NARGS - 1 LOOP
      binding_column := TG_ARGV[argument_index];
      world_id_text := old_payload ->> binding_column;
      IF world_id_text IS NOT NULL THEN
        world_ids := array_append(world_ids, world_id_text::uuid);
      END IF;
    END LOOP;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_payload := to_jsonb(NEW);
    FOR argument_index IN 0..TG_NARGS - 1 LOOP
      binding_column := TG_ARGV[argument_index];
      world_id_text := new_payload ->> binding_column;
      IF world_id_text IS NOT NULL THEN
        world_ids := array_append(world_ids, world_id_text::uuid);
      END IF;
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
    IF exact_legacy_fence_transition
      AND (old_payload ->> 'world_id')::uuid = locked_world_id THEN
      CONTINUE;
    END IF;

    lifecycle_status := NULL;
    SELECT world.lifecycle_status
    INTO lifecycle_status
    FROM worlds AS world
    WHERE world.id = locked_world_id
    FOR KEY SHARE;

    IF FOUND THEN
      IF lifecycle_status NOT IN ('provisioning', 'active') THEN
        RAISE EXCEPTION 'world writer is fenced for non-writable world % (%)', locked_world_id, lifecycle_status;
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM regional_simulation_states AS regional
        WHERE regional.world_id = locked_world_id AND regional.legacy_writer_fenced
      )
      INTO legacy_writer_fenced;
      IF legacy_writer_fenced THEN
        RAISE EXCEPTION 'world writer is fenced after operational v2 cutover for world %', locked_world_id;
      END IF;
      CONTINUE;
    END IF;

    IF TG_TABLE_NAME = 'worlds' AND TG_OP IN ('INSERT', 'UPDATE')
      AND (new_payload ->> 'id')::uuid = locked_world_id THEN
      proposed_lifecycle_status := new_payload ->> 'lifecycle_status';
      IF proposed_lifecycle_status IN ('provisioning', 'active') THEN
        CONTINUE;
      END IF;
    END IF;

    IF TG_TABLE_NAME IN ('global_admin_audit_events','odoo_command_queue','odoo_projection_outbox','odoo_reconciliation_tasks') THEN
      CONTINUE;
    END IF;

    RAISE EXCEPTION 'world writer references missing or non-writable world %', locked_world_id;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
`;

export const DATABASE_WORLD_WRITER_GUARDS = Object.freeze(
  DATABASE_WORLD_HISTORY_BINDINGS.map(({ table, columns }) => guard(
    `zugfolge_world_guard_${table}`,
    table,
    31,
    "zugfolge_enforce_world_writer_guard",
    `CREATE TRIGGER zugfolge_world_guard_${table} BEFORE INSERT OR DELETE OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION zugfolge_enforce_world_writer_guard(${columns.map((column) => `'${column}'`).join(", ")})`,
    WORLD_WRITER_GUARD_SOURCE,
  )).sort((left, right) => left.name.localeCompare(right.name, "en")),
);

export const DATABASE_CUTOVER_GUARDS = Object.freeze([
  ...DATABASE_BASE_CUTOVER_GUARDS,
  ...DATABASE_WORLD_WRITER_GUARDS,
].sort((left, right) => left.name.localeCompare(right.name, "en")));

export const DATABASE_CUTOVER_SCHEMA_CONTRACT = Object.freeze({
  constraints: DATABASE_CUTOVER_CONSTRAINTS,
  guards: DATABASE_CUTOVER_GUARDS,
  worldWriterGuardMigrationLockSql: DATABASE_WORLD_WRITER_GUARD_MIGRATION_LOCK_SQL,
});
