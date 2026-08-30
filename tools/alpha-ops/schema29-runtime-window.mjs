import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const CONSTRAINT = "regional_simulation_states_initialization_hash_present";
const EXPECTED_MIGRATION_COUNT = 29;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function inspectRuntimeWindow(sql) {
  const [migration] = await sql.unsafe("select count(*)::int as count from drizzle.__drizzle_migrations");
  invariant(migration?.count === EXPECTED_MIGRATION_COUNT, "Schema-29-Legacy-Fenster erwartet exakt 29 Migrationen.");
  const constraints = await sql.unsafe(`
    select convalidated as validated, pg_get_constraintdef(oid, true) as definition
    from pg_constraint
    where conrelid = 'public.regional_simulation_states'::regclass
      and conname = $1
  `, [CONSTRAINT]);
  invariant(constraints.length === 1 && typeof constraints[0].definition === "string", "Schema-29-Initialisierungsconstraint fehlt oder ist mehrdeutig.");
  const [rows] = await sql.unsafe(`
    select
      count(*) filter (where state_schema = 'zugfolge-regional-simulation-state/v1' and initialization_hash is null)::text as legacy_rows,
      count(*) filter (where state_schema = 'zugfolge-operational-simulation-state/v2' and initialization_hash is not null)::text as operational_rows,
      count(*) filter (where not (
        (state_schema = 'zugfolge-regional-simulation-state/v1' and initialization_hash is null)
        or (state_schema = 'zugfolge-operational-simulation-state/v2' and initialization_hash is not null)
      ))::text as invalid_rows
    from regional_simulation_states
  `);
  invariant(rows !== undefined && rows.invalid_rows === "0" && BigInt(rows.legacy_rows) > 0n, "Schema-29-Runtime-Restore besitzt keine ausschliesslich V1/V2-kompatiblen Initialisierungsbindungen.");
  return Object.freeze({
    constraintDefinition: constraints[0].definition,
    constraintValidated: constraints[0].validated === true,
    invalidRowCount: rows.invalid_rows,
    legacyRowCount: rows.legacy_rows,
    migrationCount: migration.count,
    operationalRowCount: rows.operational_rows,
  });
}

export async function prepareSchema29LegacyRuntimeWindowWithSql(sql) {
  const before = await inspectRuntimeWindow(sql);
  invariant(
    before.constraintValidated === false
      && /initialization_hash IS NOT NULL/iu.test(before.constraintDefinition)
      && !/state_schema/iu.test(before.constraintDefinition),
    "Schema-29-Runtime-Restore besitzt nicht die erwartete noch unvalidierte 0029-Initialisierungsconstraint.",
  );
  await sql.unsafe(`alter table regional_simulation_states drop constraint ${CONSTRAINT}`);
  await sql.unsafe(`
    alter table regional_simulation_states
    add constraint ${CONSTRAINT} check (
      (
        state_schema = 'zugfolge-regional-simulation-state/v1'
        and initialization_hash is null
      )
      or (
        state_schema = 'zugfolge-operational-simulation-state/v2'
        and initialization_hash is not null
      )
    ) not valid
  `);
  await sql.unsafe(`alter table regional_simulation_states validate constraint ${CONSTRAINT}`);
  const after = await inspectRuntimeWindow(sql);
  invariant(
    after.constraintValidated === true
      && /state_schema/iu.test(after.constraintDefinition)
      && /zugfolge-regional-simulation-state\/v1/iu.test(after.constraintDefinition)
      && /zugfolge-operational-simulation-state\/v2/iu.test(after.constraintDefinition),
    "Schema-29-Legacy-Fenster wurde nicht exakt auf den 0030-V1/V2-Formvertrag vorbereitet.",
  );
  invariant(
    before.legacyRowCount === after.legacyRowCount
      && before.operationalRowCount === after.operationalRowCount
      && after.invalidRowCount === "0",
    "Schema-29-Legacy-Fenster veraenderte autoritative Regionalzeilen.",
  );
  return Object.freeze({
    afterConstraintDefinitionSha256: sha256(after.constraintDefinition),
    afterConstraintValidated: after.constraintValidated,
    beforeConstraintDefinitionSha256: sha256(before.constraintDefinition),
    beforeConstraintValidated: before.constraintValidated,
    invalidRowCount: after.invalidRowCount,
    legacyRowCount: after.legacyRowCount,
    migrationCount: after.migrationCount,
    operationalRowCount: after.operationalRowCount,
  });
}

export async function prepareSchema29LegacyRuntimeWindow(databaseUrl) {
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const postgresModule = requireFromDb("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 15, idle_timeout: 5 });
  try {
    return await client.begin(async (transaction) => prepareSchema29LegacyRuntimeWindowWithSql(transaction));
  } finally {
    await client.end({ timeout: 5 });
  }
}
