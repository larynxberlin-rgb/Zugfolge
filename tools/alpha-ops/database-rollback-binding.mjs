import { createHash } from "node:crypto";

import { validateDatabaseRollbackProof } from "../tiles/map-release-build-evidence.mjs";
import {
  DATABASE_CUTOVER_CONSTRAINTS,
  DATABASE_CUTOVER_GUARDS,
  DATABASE_WORLD_HISTORY_BINDINGS,
  databaseAuthoritativeCatalog,
  normalizeDatabaseDefinition,
} from "./database-cutover-schema-contract.mjs";
import {
  inspectKeycloakSchemaState,
  loadKeycloakObjectCatalog,
  validateKeycloakIdentityHead,
} from "./keycloak-public-to-schema.mjs";

const AUTHORITATIVE_HEAD_SCHEMA = "zugfolge-database-authoritative-head/v1";
const WORLD_HISTORY_SEAL_SCHEMA = "zugfolge-world-final-history-seal/v1";
const CUTOVER_RECEIPT_SCHEMA = "zugfolge-world-cutover-receipt/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

function exactOne(rows, message) {
  invariant(Array.isArray(rows) && rows.length === 1, message);
  return rows[0];
}

function positiveInteger(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  invariant(Number.isSafeInteger(number) && number > 0, `${label} ist keine sichere positive Ganzzahl.`);
  return number;
}

function nonnegativeSafeInteger(value, label) {
  const number = Number(value);
  invariant(Number.isSafeInteger(number) && number >= 0, `${label} ist keine sichere nichtnegative Ganzzahl.`);
  return number;
}

function quotedTableName(value) {
  invariant(typeof value === "string" && /^[a-z_][a-z0-9_]*$/.test(value), "Der autoritative Tabellenkatalog enthaelt einen unsicheren Namen.");
  return `"${value}"`;
}

async function tableFingerprint(sql, table, filterColumns = [], parameters = []) {
  const quoted = quotedTableName(table);
  invariant(Array.isArray(filterColumns) && filterColumns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column)), "Der autoritative Tabellenfilter ist nicht fest verdrahtet.");
  const where = filterColumns.length === 0
    ? ""
    : ` where ${filterColumns.map((column) => `"${column}" = $1::uuid`).join(" or ")}`;
  const row = exactOne(await sql.unsafe(`
    select
      count(*)::text as row_count,
      encode(sha256(convert_to(coalesce(string_agg(row_sha256, '' order by row_sha256), ''), 'UTF8')), 'hex') as rows_sha256
    from (
      select encode(sha256(convert_to(to_jsonb(source_row)::text, 'UTF8')), 'hex') as row_sha256
      from "public".${quoted} as source_row${where}
    ) as canonical_rows
  `, parameters), `Tabelle '${table}' besitzt keinen kanonischen Fingerprint.`);
  invariant(/^(?:0|[1-9][0-9]*)$/.test(String(row.row_count)), `Tabelle '${table}' besitzt keinen exakten Row-Count.`);
  invariant(SHA256.test(row.rows_sha256), `Tabelle '${table}' besitzt keinen SHA-256 ueber alle kanonischen Reihen.`);
  return Object.freeze({ table, rowCount: String(row.row_count), rowsSha256: row.rows_sha256 });
}

async function inspectAuthoritativeDetails(sql, migrationCount) {
  const catalog = databaseAuthoritativeCatalog(migrationCount);
  const tableRows = await sql.unsafe(`
    select relation.relname as table_name
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relname not in ('zugfolge_database_identity', 'world_cutover_receipts')
      and not exists (
        select 1 from pg_depend as dependency
        where dependency.classid = 'pg_class'::regclass
          and dependency.objid = relation.oid
          and dependency.deptype = 'e'
      )
    order by relation.relname
  `);
  const names = tableRows.map((row) => row.table_name);
  invariant(
    JSON.stringify(names) === JSON.stringify(catalog.tables),
    `Der autoritative Tabellenkatalog weicht vom eingecheckten Schema-${migrationCount}-Sollvertrag ab.`,
  );
  const tableStates = [];
  for (const name of names) tableStates.push(await tableFingerprint(sql, name));
  return Object.freeze({ tableStates, migrationCount });
}

function rowCountFor(details, table) {
  const state = details.tableStates.find((value) => value.table === table);
  invariant(state !== undefined, `Der autoritative Kopf bindet Tabelle '${table}' nicht.`);
  return state.rowCount;
}

function authoritativeHead(details) {
  const { tableStates, migrationCount } = details;
  return Object.freeze({
    schema: AUTHORITATIVE_HEAD_SCHEMA,
    tableCount: details.tableStates.length,
    tableSetSha256: databaseAuthoritativeCatalog(migrationCount).tableSetSha256,
    worldCount: nonnegativeSafeInteger(rowCountFor(details, "worlds"), "authoritativeHead.worldCount"),
    regionalStateCount: nonnegativeSafeInteger(rowCountFor(details, "regional_simulation_states"), "authoritativeHead.regionalStateCount"),
    domainEventCount: rowCountFor(details, "domain_events"),
    stateHash: canonicalSha256({ schema: AUTHORITATIVE_HEAD_SCHEMA, tableStates }),
  });
}

/**
 * Liest den durch den exklusiven Welt-Lock stabilisierten Datenbankvertrag.
 * Weltfremde Aenderungen bleiben getrennt und werden durch ihren eigenen
 * Shared-Xact-Lock serialisiert.
 */
export async function inspectMigratedKeycloakState(sql, {
  environment = process.env,
  loadCatalog = loadKeycloakObjectCatalog,
  inspectState = inspectKeycloakSchemaState,
} = {}) {
  const catalog = await loadCatalog(environment.KEYCLOAK_SCHEMA_CATALOG_PATH);
  const state = await inspectState(sql, catalog);
  invariant(state.state === "migrated", "Rollback-Proof v3 erwartet Keycloak ausschliesslich im keycloak-Schema.");
  validateKeycloakIdentityHead(state.identityHead);
  return state;
}

export async function inspectLiveDatabaseRollbackSnapshot(sql, { inspectKeycloakState = inspectMigratedKeycloakState } = {}) {
  const migrationHeadRows = await sql.unsafe(`
    select id::int as id, hash, created_at::text as created_at
    from drizzle.__drizzle_migrations
    order by id
  `);
  const [identityRows, migrationRows, constraintRows, guardRows, details, regionalCountRows, keycloakState] = await Promise.all([
    sql.unsafe(`select database_id::text as database_id from zugfolge_database_identity where singleton = 1`),
    Promise.resolve(migrationHeadRows),
    sql.unsafe(`
      select
        con.conname as name,
        relation.relname as relation_name,
        con.contype::text as constraint_type,
        pg_get_constraintdef(con.oid, true) as definition,
        con.convalidated as validated
      from pg_constraint as con
      join pg_class as relation on relation.oid = con.conrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where con.conname in (
        'regional_simulation_command_receipts_command_hash_sha256',
        'regional_simulation_command_receipts_command_id_present',
        'regional_simulation_command_receipts_initialization_hash_sha256',
        'regional_simulation_command_receipts_pk',
        'regional_simulation_command_receipts_revision_positive',
        'regional_simulation_command_receipts_state_fk',
        'regional_simulation_states_initialization_hash_present',
        'regional_simulation_states_initialization_hash_sha256',
        'regional_simulation_states_legacy_writer_fence_shape',
        'world_cutover_receipts_candidate_world_fk',
        'world_cutover_receipts_database_fk',
        'world_cutover_receipts_mode',
        'world_cutover_receipts_pkey',
        'world_cutover_receipts_predecessor_world_fk',
        'zugfolge_database_identity_singleton',
        'zugfolge_database_identity_database_id_unique',
        'zugfolge_database_identity_pkey',
        'world_cutover_receipts_hash_format',
        'world_cutover_receipts_shape'
      ) and namespace.nspname = 'public'
      order by con.conname
    `),
    sql.unsafe(`
      select
        trigger.tgname as name,
        relation.relname as relation_name,
        trigger.tgtype::int as trigger_type,
        trigger.tgenabled,
        procedure.proname as function_name,
        pg_get_triggerdef(trigger.oid, true) as trigger_definition,
        procedure.prosrc as function_source
      from pg_trigger as trigger
      join pg_proc as procedure on procedure.oid = trigger.tgfoid
      join pg_class as relation on relation.oid = trigger.tgrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where not trigger.tgisinternal
        and namespace.nspname = 'public'
        and (
          trigger.tgname in (
            'alpha_world_final_state_hash_immutable',
            'domain_events_append_only',
            'odoo_projection_outbox_world_guard',
            'regional_simulation_states_legacy_writer_fence',
            'world_cutover_receipts_immutable',
            'zugfolge_database_identity_immutable',
            'zugfolge_capture_operational_command_receipts',
            'zugfolge_enforce_operational_initialization_immutability'
          )
          or left(trigger.tgname, length('zugfolge_world_guard_')) = 'zugfolge_world_guard_'
        )
      order by trigger.tgname
    `),
    inspectAuthoritativeDetails(sql, migrationHeadRows.length),
    sql.unsafe(`
      select
        count(*)::int as total,
        count(*) filter (where state_schema = 'zugfolge-operational-simulation-state/v2')::int as v2,
        count(*) filter (where initialization_hash is not null)::int as non_null_initialization_hash,
        count(*) filter (
          where state_schema <> 'zugfolge-regional-simulation-state/v1'
            or initialization_hash is not null
        )::int as incompatible
      from regional_simulation_states
    `),
    inspectKeycloakState(sql),
  ]);

  const identity = exactOne(identityRows, "Die Datenbank besitzt nicht genau eine persistente Instanzidentitaet.");
  invariant(constraintRows.length === DATABASE_CUTOVER_CONSTRAINTS.length, "Der Live-Stand besitzt nicht den exakten Cutover-Constraintvertrag.");
  invariant(guardRows.length === DATABASE_CUTOVER_GUARDS.length, "Der Live-Stand besitzt nicht den exakten Unveraenderlichkeitsvertrag.");

  const migrationLedger = migrationRows.map((row) => ({
    id: positiveInteger(row.id, "migration.id"),
    hash: row.hash,
    createdAt: positiveInteger(row.created_at, "migration.createdAt"),
  }));
  const constraints = DATABASE_CUTOVER_CONSTRAINTS.map((expected) => {
    const row = exactOne(
      constraintRows.filter(({ name }) => name === expected.name),
      `Constraint '${expected.name}' fehlt oder ist doppelt vorhanden.`,
    );
    invariant(row.relation_name === expected.relation, `Constraint '${expected.name}' liegt auf einer unerwarteten Relation.`);
    invariant(row.constraint_type === expected.type, `Constraint '${expected.name}' besitzt einen unerwarteten Typ.`);
    invariant(row.validated === true, `Constraint '${expected.name}' ist nicht validiert.`);
    invariant(
      normalizeDatabaseDefinition(row.definition) === expected.definition,
      `Constraint '${expected.name}' weicht vom eingecheckten Cutover-Sollvertrag ab.`,
    );
    return Object.freeze({
      name: expected.name,
      definitionSha256: expected.definitionSha256,
      validated: true,
    });
  });
  const guards = DATABASE_CUTOVER_GUARDS.map((expected) => {
    const row = exactOne(
      guardRows.filter(({ name }) => name === expected.name),
      `Guard '${expected.name}' fehlt oder ist doppelt vorhanden.`,
    );
    invariant(row.relation_name === expected.relation, `Guard '${expected.name}' liegt auf einer unerwarteten Relation.`);
    invariant(Number(row.trigger_type) === expected.type, `Guard '${expected.name}' besitzt unerwartete Triggerereignisse.`);
    invariant(row.function_name === expected.functionName, `Guard '${expected.name}' ruft eine unerwartete Funktion auf.`);
    invariant(row.tgenabled === "O", `Guard '${expected.name}' ist nicht im Origin-Modus aktiviert.`);
    invariant(
      normalizeDatabaseDefinition(row.trigger_definition) === expected.triggerDefinition,
      `Guard '${expected.name}' weicht in seiner Triggerdefinition vom eingecheckten Sollvertrag ab.`,
    );
    invariant(
      normalizeDatabaseDefinition(row.function_source) === expected.functionSource,
      `Guard '${expected.name}' weicht in seinem Funktionskoerper vom eingecheckten Sollvertrag ab.`,
    );
    return Object.freeze({
      name: expected.name,
      definitionSha256: expected.definitionSha256,
      enabled: true,
    });
  });
  const regionalCounts = exactOne(regionalCountRows, "Der Live-Stand besitzt keine exakten Regional-Head-Zaehlungen.");

  return Object.freeze({
    databaseIdentity: identity.database_id,
    migrationLedger,
    constraints,
    guards,
    heads: {
      total: nonnegativeSafeInteger(regionalCounts.total, "heads.total"),
      v2: nonnegativeSafeInteger(regionalCounts.v2, "heads.v2"),
      nonNullInitializationHash: nonnegativeSafeInteger(regionalCounts.non_null_initialization_hash, "heads.nonNullInitializationHash"),
      incompatible: nonnegativeSafeInteger(regionalCounts.incompatible, "heads.incompatible"),
    },
    authoritativeHead: authoritativeHead(details),
    keycloakIdentityHead: keycloakState.identityHead,
  });
}

export function assertDatabaseRollbackProofMatchesLive(proof, liveSnapshot, expected = {}) {
  validateDatabaseRollbackProof(proof, expected);
  if (proof.source.databaseIdentity !== liveSnapshot.databaseIdentity) {
    throw new Error("Datenbank-Rollbackbeleg stammt von einer anderen persistenten Datenbankinstanz.");
  }
  if (JSON.stringify(sortedValue(proof.source)) !== JSON.stringify(sortedValue(liveSnapshot))) {
    throw new Error("Datenbank-Rollbackbeleg stimmt nicht mit dem gesperrten autoritativen Live-Kopf ueberein.");
  }
  return proof;
}

export async function worldFinalHistorySeal(sql, worldId) {
  const worldBindingRows = await sql.unsafe(`
    select columns.table_name, columns.column_name
    from information_schema.columns as columns
    where columns.table_schema = 'public'
      and columns.data_type = 'uuid'
      and (
        (columns.table_name = 'worlds' and columns.column_name = 'id')
        or (
          columns.table_name <> 'world_cutover_receipts'
          and (columns.column_name = 'world_id' or columns.column_name like '%\\_world_id' escape '\\')
        )
      )
    order by columns.table_name, columns.column_name
  `);
  const expectedBindings = DATABASE_WORLD_HISTORY_BINDINGS
    .flatMap(({ table, columns }) => columns.map((column) => ({ table_name: table, column_name: column })))
    .sort((left, right) => left.table_name.localeCompare(right.table_name, "en") || left.column_name.localeCompare(right.column_name, "en"));
  invariant(
    JSON.stringify(worldBindingRows) === JSON.stringify(expectedBindings),
    "Der Welt-Historienvertrag weicht vom eingecheckten Schema-33-Sollvertrag ab.",
  );
  const tableStates = [];
  for (const binding of DATABASE_WORLD_HISTORY_BINDINGS) {
    tableStates.push(await tableFingerprint(sql, binding.table, binding.columns, [worldId]));
  }
  const worldsState = tableStates.find(({ table }) => table === "worlds");
  invariant(worldsState?.rowCount === "1", `Vorgaengerwelt '${worldId}' fehlt fuer die finale Historienversiegelung.`);
  return canonicalSha256({
    schema: WORLD_HISTORY_SEAL_SCHEMA,
    worldId,
    tableStates,
  });
}

export function worldCutoverReceiptHash(value) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Cutover-Receipt-Payload fehlt.");
  const keys = [
    "schema",
    "databaseIdentity",
    "mode",
    "predecessorWorldId",
    "predecessorDeploymentHash",
    "predecessorFinalStateHash",
    "candidateWorldId",
    "candidateDeploymentHash",
    "beforeAuthoritativeHeadSha256",
    "afterAuthoritativeHeadSha256",
  ];
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort()), "Cutover-Receipt-Payload besitzt fremde oder fehlende Felder.");
  invariant(value.schema === CUTOVER_RECEIPT_SCHEMA, "Cutover-Receipt-Payload besitzt ein unbekanntes Schema.");
  invariant(UUID_V4.test(value.databaseIdentity), "Cutover-Receipt-Payload bindet keine Datenbankidentitaet.");
  invariant(UUID_V4.test(value.candidateWorldId), "Cutover-Receipt-Payload bindet keine Kandidatenwelt.");
  invariant(SHA256.test(value.candidateDeploymentHash), "Cutover-Receipt-Payload bindet kein Kandidatendeployment.");
  invariant(SHA256.test(value.beforeAuthoritativeHeadSha256) && SHA256.test(value.afterAuthoritativeHeadSha256), "Cutover-Receipt-Payload bindet keine autoritativen Vorher-/Nachher-Koepfe.");
  if (value.mode === "authorized-v1-to-v2-cutover") {
    invariant(UUID_V4.test(value.predecessorWorldId), "Cutover-Receipt-Payload bindet keine Vorgaengerwelt.");
    invariant(SHA256.test(value.predecessorDeploymentHash), "Cutover-Receipt-Payload bindet kein Vorgaengerdeployment.");
    invariant(SHA256.test(value.predecessorFinalStateHash), "Cutover-Receipt-Payload bindet keine finale Vorgaengerhistorie.");
  } else {
    invariant(value.mode === "new-v2-world", "Cutover-Receipt-Payload besitzt einen unbekannten Modus.");
    invariant(
      value.predecessorWorldId === null
        && value.predecessorDeploymentHash === null
        && value.predecessorFinalStateHash === null,
      "Neue V2-Welt darf keinen Vorgaenger im Cutover-Receipt behaupten.",
    );
  }
  const hash = canonicalSha256(value);
  invariant(SHA256.test(hash), "Cutover-Receipt-Payload ist nicht kanonisch hashbar.");
  return hash;
}

export function validateStoredWorldCutoverReceipt(row, expected = {}) {
  invariant(row !== null && typeof row === "object" && !Array.isArray(row), "Gespeicherter Cutover-Receipt fehlt.");
  const payload = Object.freeze({
    schema: CUTOVER_RECEIPT_SCHEMA,
    databaseIdentity: row.database_id,
    mode: row.mode,
    predecessorWorldId: row.predecessor_world_id,
    predecessorDeploymentHash: row.predecessor_deployment_hash,
    predecessorFinalStateHash: row.predecessor_final_state_hash,
    candidateWorldId: row.candidate_world_id,
    candidateDeploymentHash: row.candidate_deployment_hash,
    beforeAuthoritativeHeadSha256: row.before_authoritative_head_sha256,
    afterAuthoritativeHeadSha256: row.after_authoritative_head_sha256,
  });
  const receiptHash = worldCutoverReceiptHash(payload);
  invariant(SHA256.test(row.receipt_hash) && row.receipt_hash === receiptHash, "Gespeicherter Cutover-Receipt besitzt keinen aus seinen Spalten rekonstruierten kanonischen Hash.");
  if (expected.databaseIdentity !== undefined) {
    invariant(payload.databaseIdentity === expected.databaseIdentity, "Gespeicherter Cutover-Receipt gehoert zu einer anderen Datenbankinstanz.");
  }
  if (expected.candidateWorldId !== undefined) {
    invariant(payload.candidateWorldId === expected.candidateWorldId, "Gespeicherter Cutover-Receipt gehoert zu einer anderen Kandidatenwelt.");
  }
  if (expected.candidateDeploymentHash !== undefined) {
    invariant(payload.candidateDeploymentHash === expected.candidateDeploymentHash, "Gespeicherter Cutover-Receipt bindet ein anderes Kandidatendeployment.");
  }
  return Object.freeze({ payload, receiptHash });
}

export const DATABASE_ROLLBACK_BINDING_SCHEMAS = Object.freeze({
  authoritativeHead: AUTHORITATIVE_HEAD_SCHEMA,
  worldHistorySeal: WORLD_HISTORY_SEAL_SCHEMA,
  cutoverReceipt: CUTOVER_RECEIPT_SCHEMA,
});
