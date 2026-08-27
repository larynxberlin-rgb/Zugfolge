import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DATABASE_AUTHORITATIVE_TABLES } from "./database-cutover-schema-contract.mjs";

export const KEYCLOAK_SCHEMA_MIGRATION_SCHEMA = "keycloak-public-to-schema/v1";
export const KEYCLOAK_SCHEMA_STATE_SCHEMA = "keycloak-public-to-schema-state/v1";
export const KEYCLOAK_SCHEMA_BACKUP_BINDING_SCHEMA = "keycloak-public-to-schema-backup-binding/v1";
export const KEYCLOAK_SCHEMA_RECEIPT_SCHEMA = "keycloak-public-to-schema-receipt/v1";
export const KEYCLOAK_SCHEMA_RECOVER_RECEIPT_SCHEMA = "keycloak-public-to-schema-recover-receipt/v1";
export const KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_SCHEMA = "keycloak-public-to-schema-bootstrap-receipt/v1";
export const KEYCLOAK_IDENTITY_HEAD_SCHEMA = "keycloak-identity-head/v1";
export const KEYCLOAK_GAME_RESTORE_SCHEMA = "zugfolge-game-restore/v2";
export const KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT = "zugfolge:keycloak-bootstrap-origin/v1";
export const KEYCLOAK_SOURCE_SCHEMA = "public";
export const KEYCLOAK_TARGET_SCHEMA = "keycloak";
const KEYCLOAK_LOCK_NAMESPACE_IDS = Object.freeze([1, 1000]);
export const KEYCLOAK_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../ops/alpha/keycloak/keycloak-pg16-object-catalog.26.7.0.json",
);

const SHA256 = /^[a-f0-9]{64}$/u;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE_NAME = /^[a-z_][a-z0-9_]*$/u;
const GAME_SUPPORT_RELATIONS = Object.freeze(["world_cutover_receipts", "zugfolge_database_identity"]);
const PUBLIC_EXTENSION_NAME = "postgis";
const PUBLIC_EXTENSION_RELATIONS = Object.freeze([
  Object.freeze({ kind: "v", name: "geography_columns" }),
  Object.freeze({ kind: "v", name: "geometry_columns" }),
  Object.freeze({ kind: "r", name: "spatial_ref_sys" }),
]);
const GAME_ROUTINES_28_TO_30 = Object.freeze([
  "zugfolge_enforce_global_admin_audit",
  "zugfolge_enforce_odoo_command_world",
  "zugfolge_enforce_odoo_outbox_world",
  "zugfolge_protect_started_alpha_world_profile",
]);
const GAME_ROUTINES_31 = Object.freeze([...GAME_ROUTINES_28_TO_30,
  "zugfolge_enforce_regional_writer_fence",
  "zugfolge_protect_alpha_world_final_state_hash",
  "zugfolge_reject_immutable_audit_mutation",
].sort());
const GAME_ROUTINES_32 = Object.freeze([...GAME_ROUTINES_31, "zugfolge_enforce_world_writer_guard"].sort());
const GAME_ROUTINES_33 = Object.freeze([
  ...GAME_ROUTINES_32,
  "zugfolge_capture_operational_command_receipts",
  "zugfolge_enforce_operational_initialization_immutability",
].sort());
const OPERATIONAL_COMMAND_RECEIPT_RELATION = "regional_simulation_command_receipts";
const EMPTY_ARRAY_SHA256 = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const ADVISORY_LOCK_KEY = "keycloak-public-to-schema/v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactObjectKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${label} besitzt fremde oder fehlende Felder.`);
  return value;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function schemaNeutralValue(value) {
  if (Array.isArray(value)) return value.map(schemaNeutralValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, schemaNeutralValue(value[key])]));
  }
  if (typeof value === "string") {
    return value
      .replace(/\b(?:public|keycloak)\./gu, "<schema>.")
      .replace(/\s+/gu, " ")
      .trim();
  }
  return value;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value))}\n`, "utf8");
}

export function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

function schemaNeutralSha256(value) {
  return createHash("sha256").update(JSON.stringify(schemaNeutralValue(value))).digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInstant(value, label) {
  invariant(typeof value === "string" && Number.isFinite(Date.parse(value)), `${label} ist kein UTC-Zeitpunkt.`);
  invariant(new Date(value).toISOString() === value, `${label} ist nicht kanonisch als UTC-Zeitpunkt serialisiert.`);
  return value;
}

function safeName(value, label) {
  invariant(typeof value === "string" && SAFE_NAME.test(value), `${label} ist kein sicherer PostgreSQL-Bezeichner.`);
  return value;
}

export function postgresCatalogIdentifier(value, label) {
  invariant(
    typeof value === "string"
      && value.length > 0
      && !value.includes("\u0000")
      && Buffer.byteLength(value, "utf8") <= 63,
    `${label} ist kein gueltiger PostgreSQL-Katalogbezeichner.`,
  );
  return value;
}

function quoteName(value) {
  return `"${safeName(value, "PostgreSQL-Bezeichner")}"`;
}

function safeInteger(value, label, { positive = false } = {}) {
  const number = Number(value);
  invariant(Number.isSafeInteger(number) && number >= (positive ? 1 : 0), `${label} ist keine sichere Ganzzahl.`);
  return number;
}

function decimalCount(value, label) {
  const text = String(value);
  invariant(/^(?:0|[1-9][0-9]*)$/u.test(text), `${label} ist keine exakte nichtnegative Dezimalzahl.`);
  return text;
}

function sortedUniqueNames(value, label) {
  invariant(Array.isArray(value), `${label} ist keine Liste.`);
  const names = value.map((entry, index) => safeName(entry, `${label}[${index}]`));
  invariant(new Set(names).size === names.length, `${label} besitzt doppelte Namen.`);
  invariant(JSON.stringify(names) === JSON.stringify([...names].sort()), `${label} ist nicht kanonisch sortiert.`);
  return names;
}

function validateSignature(value, label, { empty = false } = {}) {
  exactObjectKeys(value, ["count", "sha256"], label);
  safeInteger(value.count, `${label}.count`);
  invariant(SHA256.test(value.sha256), `${label}.sha256 ist kein SHA-256.`);
  if (empty) {
    invariant(value.count === 0 && value.sha256 === EMPTY_ARRAY_SHA256, `${label} bindet keinen exakten leeren Katalog.`);
  }
  return value;
}

export function validateKeycloakObjectCatalog(catalog) {
  exactObjectKeys(catalog, [
    "schema",
    "keycloakVersion",
    "keycloakImage",
    "postgresMajor",
    "productionSnapshot",
    "officialInputs",
    "objects",
    "signatures",
    "catalogSha256",
  ], "Keycloak-PG16-Objektkatalog");
  invariant(catalog.schema === "keycloak-pg16-object-catalog/v1", "Keycloak-Objektkatalog besitzt ein unbekanntes Schema.");
  invariant(catalog.keycloakVersion === "26.7.0", "Keycloak-Objektkatalog bindet nicht Version 26.7.0.");
  invariant(
    catalog.keycloakImage === "quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13",
    "Keycloak-Objektkatalog bindet nicht das freigegebene unveraenderliche OCI-Image.",
  );
  invariant(catalog.postgresMajor === 16, "Keycloak-Objektkatalog gilt nicht fuer PostgreSQL 16.");
  exactObjectKeys(catalog.productionSnapshot, [
    "capturedAt",
    "canonicalJsonBytes",
    "canonicalJsonSha256",
    "gzipSha256",
    "observedRuntimeImageId",
  ], "Keycloak-Objektkatalog.productionSnapshot");
  invariant(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/u.test(catalog.productionSnapshot.capturedAt), "Produktionskatalog besitzt kein Erfassungsdatum.");
  safeInteger(catalog.productionSnapshot.canonicalJsonBytes, "Keycloak-Objektkatalog.productionSnapshot.canonicalJsonBytes", { positive: true });
  invariant(SHA256.test(catalog.productionSnapshot.canonicalJsonSha256) && SHA256.test(catalog.productionSnapshot.gzipSha256), "Produktionskatalog ist nicht bytegenau gebunden.");
  invariant(OCI_DIGEST.test(catalog.productionSnapshot.observedRuntimeImageId), "Produktionskatalog bindet keine beobachtete Image-ID.");
  exactObjectKeys(catalog.officialInputs, [
    "keycloakModelJpaSha256",
    "keycloakSourceArchiveSha256",
    "ociIndexDigest",
    "linuxAmd64ManifestDigest",
  ], "Keycloak-Objektkatalog.officialInputs");
  invariant(SHA256.test(catalog.officialInputs.keycloakModelJpaSha256), "Keycloak-JPA-Artefakt ist nicht gehasht.");
  invariant(SHA256.test(catalog.officialInputs.keycloakSourceArchiveSha256), "Keycloak-Quellarchiv ist nicht gehasht.");
  invariant(OCI_DIGEST.test(catalog.officialInputs.ociIndexDigest) && OCI_DIGEST.test(catalog.officialInputs.linuxAmd64ManifestDigest), "Keycloak-OCI-Manifeste sind nicht unveraenderlich gebunden.");
  exactObjectKeys(catalog.objects, ["tables", "sequences", "views", "types"], "Keycloak-Objektkatalog.objects");
  const tables = sortedUniqueNames(catalog.objects.tables, "Keycloak-Objektkatalog.objects.tables");
  invariant(tables.length === 100, "Keycloak-26.7.0-Katalog besitzt nicht exakt 100 Tabellen.");
  invariant(tables.includes("databasechangelog") && tables.includes("databasechangeloglock"), "Keycloak-Katalog laesst das Liquibase-Ledger aus.");
  invariant(tables.includes("realm") && tables.includes("user_entity") && tables.includes("credential"), "Keycloak-Katalog laesst Identitaetsobjekte aus.");
  for (const name of ["sequences", "views", "types"]) {
    invariant(sortedUniqueNames(catalog.objects[name], `Keycloak-Objektkatalog.objects.${name}`).length === 0, `Keycloak-26.7.0-Katalog erwartet unerlaubte ${name}.`);
  }
  exactObjectKeys(catalog.signatures, ["relations", "columns", "constraints", "indexes", "triggers", "sequences", "views", "types"], "Keycloak-Objektkatalog.signatures");
  for (const name of ["relations", "columns", "constraints", "indexes"]) validateSignature(catalog.signatures[name], `Keycloak-Objektkatalog.signatures.${name}`);
  invariant(catalog.signatures.relations.count === tables.length, "Keycloak-Relationssignatur zaehlt nicht den Tabellenkatalog.");
  for (const name of ["triggers", "sequences", "views", "types"]) validateSignature(catalog.signatures[name], `Keycloak-Objektkatalog.signatures.${name}`, { empty: true });
  const { catalogSha256, ...payload } = catalog;
  invariant(SHA256.test(catalogSha256) && catalogSha256 === canonicalSha256(payload), "Keycloak-Objektkatalog besitzt keinen gueltigen kanonischen Hash.");
  return catalog;
}

export async function loadKeycloakObjectCatalog(path = KEYCLOAK_CATALOG_PATH) {
  const bytes = await readFile(resolve(path));
  let catalog;
  try {
    catalog = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Keycloak-PG16-Objektkatalog ist kein gueltiges JSON-Artefakt.");
  }
  return validateKeycloakObjectCatalog(catalog);
}

async function postgresMajor(sql) {
  const rows = await sql.unsafe("show server_version_num");
  invariant(Array.isArray(rows) && rows.length === 1, "PostgreSQL-Version ist nicht eindeutig lesbar.");
  const raw = Object.values(rows[0])[0];
  const version = safeInteger(raw, "PostgreSQL server_version_num", { positive: true });
  return Math.trunc(version / 10000);
}

async function schemaExists(sql, schema) {
  const rows = await sql.unsafe("select exists(select 1 from pg_namespace where nspname = $1) as present", [schema]);
  return rows.length === 1 && rows[0].present === true;
}

async function schemaComment(sql, schema) {
  const rows = await sql.unsafe("select obj_description(to_regnamespace($1), 'pg_namespace') as comment", [schema]);
  invariant(rows.length === 1, `PostgreSQL-Schemakommentar fuer '${schema}' ist nicht eindeutig lesbar.`);
  return rows[0].comment == null ? null : String(rows[0].comment);
}

async function drizzleMigrationCount(sql) {
  const presence = await sql.unsafe("select to_regclass('drizzle.__drizzle_migrations') is not null as present");
  invariant(presence.length === 1, "Drizzle-Migrationsledger ist nicht eindeutig auffindbar.");
  if (presence[0].present !== true) return 0;
  const rows = await sql.unsafe("select count(*)::int as count from drizzle.__drizzle_migrations");
  invariant(rows.length === 1, "Drizzle-Migrationsstand ist nicht eindeutig lesbar.");
  return safeInteger(rows[0].count, "Drizzle-Migrationsstand");
}

async function userRelations(sql, schema) {
  const rows = await sql.unsafe(`
    select
      relation.relkind::text as kind,
      relation.relname as name,
      relation.oid::text as oid,
      (relation.relkind = 'p') as partitioned,
      relation.relpersistence::text as persistence,
      pg_get_partkeydef(relation.oid) as "partitionKey",
      (
        select extension_row.extname
        from pg_depend as dependency
        join pg_extension as extension_row on extension_row.oid = dependency.refobjid
        where dependency.classid = 'pg_class'::regclass
          and dependency.objid = relation.oid
          and dependency.refclassid = 'pg_extension'::regclass
          and dependency.deptype = 'e'
      ) as "extensionName"
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = $1
      and relation.relkind in ('r', 'p', 'S', 'v', 'm')
    order by relation.relkind, relation.relname
  `, [schema]);
  return rows.map(({ oid, extensionName, ...descriptor }) => ({
    ...descriptor,
    oid: decimalCount(oid, `${schema}.${descriptor.name}.oid`),
    extensionName: extensionName == null ? null : safeName(extensionName, `${schema}.${descriptor.name}.extensionName`),
  }));
}

async function userRoutines(sql, schema) {
  const rows = await sql.unsafe(`
    select
      procedure.proname as name,
      pg_get_function_identity_arguments(procedure.oid) as arguments,
      (
        select extension_row.extname
        from pg_depend as dependency
        join pg_extension as extension_row on extension_row.oid = dependency.refobjid
        where dependency.classid = 'pg_proc'::regclass
          and dependency.objid = procedure.oid
          and dependency.refclassid = 'pg_extension'::regclass
          and dependency.deptype = 'e'
      ) as "extensionName"
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = $1
      and procedure.prokind in ('f', 'p')
    order by procedure.proname, pg_get_function_identity_arguments(procedure.oid)
  `, [schema]);
  return rows.map((row) => Object.freeze({
    name: safeName(row.name, `${schema}-Routine`),
    arguments: String(row.arguments),
    extensionName: row.extensionName == null ? null : safeName(row.extensionName, `${schema}.${row.name}.extensionName`),
  }));
}

async function userEnumAndDomainTypes(sql, schema) {
  const rows = await sql.unsafe(`
    select
      type_row.typname as name,
      type_row.typtype::text as kind,
      (
        select extension_row.extname
        from pg_depend as dependency
        join pg_extension as extension_row on extension_row.oid = dependency.refobjid
        where dependency.classid = 'pg_type'::regclass
          and dependency.objid = type_row.oid
          and dependency.refclassid = 'pg_extension'::regclass
          and dependency.deptype = 'e'
      ) as "extensionName"
    from pg_type as type_row
    join pg_namespace as namespace on namespace.oid = type_row.typnamespace
    where namespace.nspname = $1
      and type_row.typtype in ('d', 'e')
    order by type_row.typname
  `, [schema]);
  return rows.map((row) => Object.freeze({
    name: safeName(row.name, `${schema}-Typ`),
    kind: String(row.kind),
    extensionName: row.extensionName == null ? null : safeName(row.extensionName, `${schema}.${row.name}.extensionName`),
  }));
}

async function catalogColumns(sql, schema, names) {
  if (names.length === 0) return [];
  return sql.unsafe(`
    select
      attribute.attname as name,
      format_type(attribute.atttypid, attribute.atttypmod) as type,
      pg_get_expr(default_value.adbin, default_value.adrelid, true) as "default",
      attribute.attnotnull as "notNull",
      attribute.attnum::int as ordinal,
      attribute.attidentity::text as identity,
      relation.relname as relation,
      collation_row.collname as "collation",
      attribute.attgenerated::text as generated
    from pg_attribute as attribute
    join pg_class as relation on relation.oid = attribute.attrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    left join pg_attrdef as default_value
      on default_value.adrelid = attribute.attrelid and default_value.adnum = attribute.attnum
    left join pg_collation as collation_row on collation_row.oid = attribute.attcollation
    where namespace.nspname = $1
      and relation.relname = any($2::text[])
      and attribute.attnum > 0
      and not attribute.attisdropped
    order by relation.relname, attribute.attnum
  `, [schema, names]);
}

async function catalogConstraints(sql, schema, names) {
  if (names.length === 0) return [];
  return sql.unsafe(`
    select
      constraint_row.conname as name,
      constraint_row.contype::text as type,
      relation.relname as relation,
      constraint_row.convalidated as validated,
      constraint_row.condeferrable as deferrable,
      pg_get_constraintdef(constraint_row.oid, true) as definition,
      constraint_row.condeferred as "initiallyDeferred"
    from pg_constraint as constraint_row
    join pg_class as relation on relation.oid = constraint_row.conrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = $1
      and relation.relname = any($2::text[])
    order by relation.relname, constraint_row.conname
  `, [schema, names]);
}

async function catalogIndexes(sql, schema, names) {
  if (names.length === 0) return [];
  return sql.unsafe(`
    select
      index_relation.relname as name,
      index_row.indisready as ready,
      index_row.indisvalid as valid,
      index_row.indisunique as unique,
      index_row.indisprimary as primary,
      relation.relname as relation,
      pg_get_indexdef(index_row.indexrelid, 0, false) as definition
    from pg_index as index_row
    join pg_class as relation on relation.oid = index_row.indrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    join pg_class as index_relation on index_relation.oid = index_row.indexrelid
    where namespace.nspname = $1
      and relation.relname = any($2::text[])
    order by relation.relname, index_relation.relname
  `, [schema, names]);
}

async function catalogTriggers(sql, schema, names) {
  if (names.length === 0) return [];
  return sql.unsafe(`
    select
      trigger.tgname as name,
      trigger.tgenabled::text as enabled,
      relation.relname as relation,
      pg_get_triggerdef(trigger.oid, true) as definition
    from pg_trigger as trigger
    join pg_class as relation on relation.oid = trigger.tgrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = $1
      and relation.relname = any($2::text[])
      and not trigger.tgisinternal
    order by relation.relname, trigger.tgname
  `, [schema, names]);
}

function signature(values) {
  return Object.freeze({ count: values.length, sha256: schemaNeutralSha256(values) });
}

export function canonicalizeKeycloakColumnOrdinals(values) {
  invariant(Array.isArray(values), "Keycloak-Spaltenkatalog ist keine Liste.");
  let previousRelation = null;
  let previousPhysicalOrdinal = 0;
  let liveOrdinal = 0;
  return values.map((value, index) => {
    invariant(value !== null && typeof value === "object" && !Array.isArray(value), `Keycloak-Spaltenkatalog[${index}] ist kein Objekt.`);
    const relation = safeName(value.relation, `Keycloak-Spaltenkatalog[${index}].relation`);
    safeName(value.name, `Keycloak-Spaltenkatalog[${index}].name`);
    const physicalOrdinal = safeInteger(value.ordinal, `Keycloak-Spaltenkatalog[${index}].ordinal`, { positive: true });
    if (relation !== previousRelation) {
      invariant(previousRelation === null || relation > previousRelation, "Keycloak-Spaltenkatalog ist nicht kanonisch nach Relation sortiert.");
      previousRelation = relation;
      previousPhysicalOrdinal = 0;
      liveOrdinal = 0;
    }
    invariant(physicalOrdinal > previousPhysicalOrdinal, `Keycloak-Spaltenkatalog fuer '${relation}' ist nicht kanonisch nach physischer Spaltenposition sortiert.`);
    previousPhysicalOrdinal = physicalOrdinal;
    liveOrdinal += 1;
    return Object.freeze({ ...value, ordinal: liveOrdinal });
  });
}

export function keycloakColumnSignature(values) {
  return signature(canonicalizeKeycloakColumnOrdinals(values));
}

async function inspectCatalogAtSchema(sql, schema, catalog, relations) {
  const expected = catalog.objects.tables;
  const selectedRelations = relations.filter(({ name }) => expected.includes(name));
  invariant(selectedRelations.every(({ extensionName }) => extensionName === null), `Keycloak-Schema '${schema}' enthaelt extension-owned Keycloak-Relationen.`);
  const selected = selectedRelations.map(({ oid, extensionName, ...value }) => {
    void extensionName;
    return value;
  });
  const names = selected.map(({ name }) => name).sort();
  const [columns, constraints, indexes, triggers] = await Promise.all([
    catalogColumns(sql, schema, names),
    catalogConstraints(sql, schema, names),
    catalogIndexes(sql, schema, names),
    catalogTriggers(sql, schema, names),
  ]);
  return Object.freeze({
    relationNames: names,
    signatures: Object.freeze({
      relations: signature(selected),
      columns: keycloakColumnSignature(columns),
      constraints: signature(constraints),
      indexes: signature(indexes),
      triggers: signature(triggers),
      sequences: signature([]),
      views: signature([]),
      types: signature([]),
    }),
  });
}

export function assertCatalogSignature(actual, catalog, label) {
  invariant(JSON.stringify(actual.relationNames) === JSON.stringify(catalog.objects.tables), `${label} besitzt nicht exakt den Keycloak-26.7.0-Relationssatz.`);
  for (const name of Object.keys(catalog.signatures)) {
    const observed = actual.signatures[name];
    const expected = catalog.signatures[name];
    invariant(
      observed.count === expected.count && observed.sha256 === expected.sha256,
      `${label}.${name} weicht vom eingecheckten PG16-Keycloak-26.7.0-Objektvertrag ab `
        + `(ist count=${observed.count}, sha256=${observed.sha256}; `
        + `soll count=${expected.count}, sha256=${expected.sha256}).`,
    );
  }
  return actual;
}

function gameRelationVariant(names, migrationCount) {
  invariant([28, 29, 30, 31, 32, 33].includes(migrationCount), `Drizzle-Stand ${migrationCount} ist fuer den Keycloak-Cutover nicht freigegeben.`);
  const authoritative = DATABASE_AUTHORITATIVE_TABLES.filter(
    (name) => migrationCount >= 33 || name !== OPERATIONAL_COMMAND_RECEIPT_RELATION,
  );
  const expected = [
    ...authoritative,
    ...(migrationCount >= 31 ? GAME_SUPPORT_RELATIONS : []),
  ].sort();
  invariant(JSON.stringify(names) === JSON.stringify(expected), `Der public-Game-Relationssatz passt nicht zum Drizzle-Stand ${migrationCount}.`);
  return migrationCount >= 31 ? "schema-31-to-33" : "schema-28-to-30";
}

function assertGameRoutines(routines, migrationCount) {
  const expectedNames = migrationCount <= 30
    ? GAME_ROUTINES_28_TO_30
    : migrationCount === 31
      ? GAME_ROUTINES_31
      : migrationCount === 32
        ? GAME_ROUTINES_32
        : GAME_ROUTINES_33;
  const expected = expectedNames.map((name) => ({ name, arguments: "" }));
  invariant(JSON.stringify(routines) === JSON.stringify(expected), `Der public-Game-Routinenkatalog passt nicht zum Drizzle-Stand ${migrationCount}.`);
}

export function validateGameDatabaseCatalog(names, routines, migrationCount) {
  invariant(Array.isArray(names) && Array.isArray(routines), "Game-Datenbankkatalog besitzt keine Relations-/Routinenlisten.");
  const variant = gameRelationVariant(names, migrationCount);
  assertGameRoutines(routines, migrationCount);
  return variant;
}

export function validatePublicExtensionContract(relations, routines) {
  invariant(Array.isArray(relations) && Array.isArray(routines), "Public-Extension-Vertrag besitzt keine Objektlisten.");
  const extensionRelations = relations
    .filter(({ extensionName }) => extensionName !== null)
    .map(({ kind, name, extensionName }) => ({ kind, name, extensionName }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const expectedRelations = PUBLIC_EXTENSION_RELATIONS
    .map((entry) => ({ ...entry, extensionName: PUBLIC_EXTENSION_NAME }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  invariant(
    extensionRelations.length === 0 || JSON.stringify(extensionRelations) === JSON.stringify(expectedRelations),
    "Public-Schema besitzt nicht exakt den freigegebenen PostGIS-Relationssatz.",
  );
  const extensionRoutines = routines.filter(({ extensionName }) => extensionName !== null);
  invariant(
    extensionRoutines.every(({ extensionName }) => extensionName === PUBLIC_EXTENSION_NAME),
    "Public-Schema besitzt Routinen einer unbekannten Extension.",
  );
  invariant(
    (extensionRelations.length === 0) === (extensionRoutines.length === 0),
    "Public-Schema besitzt einen partiellen PostGIS-Extensionvertrag.",
  );
  return Object.freeze({
    variant: extensionRelations.length === 0 ? "plain-pg16" : "postgis-3.4-production-footprint",
    applicationRoutines: routines
      .filter(({ extensionName }) => extensionName === null)
      .map(({ extensionName, ...routine }) => {
        void extensionName;
        return Object.freeze(routine);
      }),
  });
}

export function validateKeycloakLockRows(rows, schema) {
  invariant(Array.isArray(rows), `Keycloak-Liquibase-Locks in '${schema}' sind nicht lesbar.`);
  const locks = rows.map((row, index) => {
    exactObjectKeys(row, ["id", "locked"], `Keycloak-Liquibase-Lock[${index}]`);
    return Object.freeze({
      id: safeInteger(row.id, `Keycloak-Liquibase-Lock[${index}].id`, { positive: true }),
      locked: row.locked,
    });
  });
  invariant(
    locks.length === KEYCLOAK_LOCK_NAMESPACE_IDS.length
      && locks.every(({ id }, index) => id === KEYCLOAK_LOCK_NAMESPACE_IDS[index]),
    `Keycloak-Liquibase-Locks in '${schema}' besitzen nicht exakt die freigegebenen Namespaces 1 und 1000.`,
  );
  invariant(
    locks.every(({ locked }) => locked === false),
    `Keycloak-Liquibase-Lock in '${schema}' ist aktiv; Keycloak ist nicht quiesziert.`,
  );
  return Object.freeze(locks);
}

async function ensureLiquibaseUnlocked(sql, schema) {
  const rows = await sql.unsafe(`select id::int as id, locked from ${quoteName(schema)}."databasechangeloglock" order by id`);
  validateKeycloakLockRows(rows, schema);
}

async function tableFingerprint(sql, schema, table) {
  const rows = await sql.unsafe(`
    select
      count(*)::text as "rowCount",
      encode(sha256(convert_to(coalesce(string_agg(row_sha256, '' order by row_sha256), ''), 'UTF8')), 'hex') as "rowsSha256"
    from (
      select encode(sha256(convert_to(to_jsonb(source_row)::text, 'UTF8')), 'hex') as row_sha256
      from ${quoteName(schema)}.${quoteName(table)} as source_row
    ) as canonical_rows
  `);
  invariant(rows.length === 1, `${schema}.${table} besitzt keinen eindeutigen Reihenfingerprint.`);
  invariant(SHA256.test(rows[0].rowsSha256), `${schema}.${table} besitzt keinen SHA-256-Reihenfingerprint.`);
  return Object.freeze({ table, rowCount: decimalCount(rows[0].rowCount, `${schema}.${table}.rowCount`), rowsSha256: rows[0].rowsSha256 });
}

async function inspectObjectOids(sql, schema, catalog, relations) {
  const tableOids = relations
    .filter(({ name }) => catalog.objects.tables.includes(name))
    .map(({ name, oid }) => Object.freeze({ kind: "table", relation: name, name, oid }));
  const [indexRows, constraintRows] = await Promise.all([
    sql.unsafe(`
      select relation.relname as relation, index_relation.relname as name, index_relation.oid::text as oid
      from pg_index as index_row
      join pg_class as relation on relation.oid = index_row.indrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      join pg_class as index_relation on index_relation.oid = index_row.indexrelid
      where namespace.nspname = $1 and relation.relname = any($2::text[])
      order by relation.relname, index_relation.relname
    `, [schema, catalog.objects.tables]),
    sql.unsafe(`
      select relation.relname as relation, constraint_row.conname as name, constraint_row.oid::text as oid
      from pg_constraint as constraint_row
      join pg_class as relation on relation.oid = constraint_row.conrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = $1 and relation.relname = any($2::text[])
      order by relation.relname, constraint_row.conname
    `, [schema, catalog.objects.tables]),
  ]);
  const values = [
    ...tableOids,
    ...indexRows.map(({ relation, name, oid }) => Object.freeze({ kind: "index", relation, name, oid: decimalCount(oid, `${schema}.${relation}.${name}.oid`) })),
    ...constraintRows.map(({ relation, name, oid }) => Object.freeze({ kind: "constraint", relation, name, oid: decimalCount(oid, `${schema}.${relation}.${name}.oid`) })),
  ].sort((left, right) => left.kind.localeCompare(right.kind, "en") || left.relation.localeCompare(right.relation, "en") || left.name.localeCompare(right.name, "en"));
  invariant(tableOids.length === 100 && indexRows.length === 246 && constraintRows.length === 198, "Keycloak-OID-Katalog besitzt nicht exakt 100 Tabellen, 246 Indizes und 198 Constraints.");
  return values;
}

async function inspectIdentityHead(sql, schema, catalog, relations) {
  await ensureLiquibaseUnlocked(sql, schema);
  const oidRows = await inspectObjectOids(sql, schema, catalog, relations);
  const tableStates = [];
  for (const table of catalog.objects.tables) tableStates.push(await tableFingerprint(sql, schema, table));
  const rowCount = (table) => tableStates.find((entry) => entry.table === table).rowCount;
  const payload = Object.freeze({
    schema: KEYCLOAK_IDENTITY_HEAD_SCHEMA,
    objectCatalogSha256: catalog.catalogSha256,
    tableCount: tableStates.length,
    totalRowCount: tableStates.reduce((sum, entry) => sum + BigInt(entry.rowCount), 0n).toString(),
    realmCount: rowCount("realm"),
    userCount: rowCount("user_entity"),
    clientCount: rowCount("client"),
    credentialCount: rowCount("credential"),
    userSessionCount: rowCount("offline_user_session"),
    authenticationSessionCount: rowCount("auth_session"),
    tableStatesSha256: canonicalSha256(tableStates),
  });
  return Object.freeze({
    identityHead: Object.freeze({ ...payload, stateHash: canonicalSha256(payload) }),
    objectOids: oidRows,
    objectOidsSha256: canonicalSha256(oidRows),
  });
}

export function validateKeycloakIdentityHead(head) {
  exactObjectKeys(head, [
    "schema",
    "objectCatalogSha256",
    "tableCount",
    "totalRowCount",
    "realmCount",
    "userCount",
    "clientCount",
    "credentialCount",
    "userSessionCount",
    "authenticationSessionCount",
    "tableStatesSha256",
    "stateHash",
  ], "Keycloak-Identitaetskopf");
  invariant(head.schema === KEYCLOAK_IDENTITY_HEAD_SCHEMA, "Keycloak-Identitaetskopf besitzt ein unbekanntes Schema.");
  invariant(SHA256.test(head.objectCatalogSha256) && SHA256.test(head.tableStatesSha256), "Keycloak-Identitaetskopf bindet Katalog und Reihen nicht per SHA-256.");
  invariant(head.tableCount === 100, "Keycloak-Identitaetskopf bindet nicht exakt 100 Tabellen.");
  for (const name of ["totalRowCount", "realmCount", "userCount", "clientCount", "credentialCount", "userSessionCount", "authenticationSessionCount"]) {
    decimalCount(head[name], `Keycloak-Identitaetskopf.${name}`);
  }
  const { stateHash, ...payload } = head;
  invariant(SHA256.test(stateHash) && stateHash === canonicalSha256(payload), "Keycloak-Identitaetskopf besitzt keinen gueltigen kanonischen Hash.");
  return head;
}

export function validateKeycloakStateSnapshot(snapshot) {
  exactObjectKeys(snapshot, [
    "schema",
    "state",
    "gameVariant",
    "databaseMigrationCount",
    "sourceSchemaExists",
    "targetSchemaExists",
    "targetSchemaComment",
    "objectCatalogSha256",
    "identityHead",
    "objectOids",
    "objectOidsSha256",
    "activeSignatures",
  ], "Keycloak-Schema-Zustand");
  invariant(snapshot.schema === KEYCLOAK_SCHEMA_STATE_SCHEMA, "Keycloak-Schema-Zustand besitzt ein unbekanntes Schema.");
  invariant(["legacy", "migrated", "bootstrap"].includes(snapshot.state), "Keycloak-Schema-Zustand besitzt einen unbekannten Status.");
  safeInteger(snapshot.databaseMigrationCount, "Keycloak-Schema-Zustand.databaseMigrationCount");
  invariant(snapshot.sourceSchemaExists === true && typeof snapshot.targetSchemaExists === "boolean", "Keycloak-Schema-Zustand besitzt keinen exakten Schemaexistenzbeleg.");
  invariant(
    snapshot.targetSchemaComment === null || snapshot.targetSchemaComment === KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT,
    "Keycloak-Schema-Zustand besitzt einen unbekannten Zielschema-Ursprungsmarker.",
  );
  invariant(SHA256.test(snapshot.objectCatalogSha256), "Keycloak-Schema-Zustand bindet keinen Objektkatalog.");
  invariant(Array.isArray(snapshot.objectOids), "Keycloak-Schema-Zustand besitzt keinen OID-Katalog.");
  invariant(SHA256.test(snapshot.objectOidsSha256) && snapshot.objectOidsSha256 === canonicalSha256(snapshot.objectOids), "Keycloak-Schema-Zustand besitzt keinen exakten OID-Hash.");
  if (snapshot.state === "bootstrap") {
    invariant(snapshot.gameVariant === "empty-database" && snapshot.databaseMigrationCount === 0, "Keycloak-Bootstrap ist nicht an eine leere Datenbank gebunden.");
    invariant(snapshot.identityHead === null && snapshot.activeSignatures === null && snapshot.objectOids.length === 0, "Keycloak-Bootstrap behauptet bereits Identitaetsobjekte.");
    invariant(snapshot.targetSchemaComment === KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT, "Keycloak-Bootstrap besitzt keinen Init-Hook-Ursprungsmarker.");
    return snapshot;
  }
  invariant(["schema-28-to-30", "schema-31-to-33"].includes(snapshot.gameVariant), "Keycloak-Schema-Zustand besitzt keinen bekannten Game-Katalog.");
  validateKeycloakIdentityHead(snapshot.identityHead);
  invariant(snapshot.identityHead.objectCatalogSha256 === snapshot.objectCatalogSha256, "Keycloak-Schema-Zustand bindet widerspruechliche Objektkataloge.");
  invariant(snapshot.objectOids.length === 544, "Keycloak-Schema-Zustand bindet nicht exakt 544 Tabellen-, Index- und Constraint-OIDs.");
  const oidNames = snapshot.objectOids.map((entry, index) => {
    exactObjectKeys(entry, ["kind", "relation", "name", "oid"], `Keycloak-Schema-Zustand.objectOids[${index}]`);
    invariant(["constraint", "index", "table"].includes(entry.kind), `Keycloak-Schema-Zustand.objectOids[${index}].kind ist unbekannt.`);
    const relation = safeName(entry.relation, `Keycloak-Schema-Zustand.objectOids[${index}].relation`);
    const name = postgresCatalogIdentifier(entry.name, `Keycloak-Schema-Zustand.objectOids[${index}].name`);
    if (entry.kind === "table") invariant(name === relation, `Keycloak-Schema-Zustand.objectOids[${index}] bindet eine widerspruechliche Tabelle.`);
    decimalCount(entry.oid, `Keycloak-Schema-Zustand.objectOids[${index}].oid`);
    return `${entry.kind}:${relation}:${name}`;
  });
  const sortedOids = [...snapshot.objectOids].sort((left, right) => left.kind.localeCompare(right.kind, "en") || left.relation.localeCompare(right.relation, "en") || left.name.localeCompare(right.name, "en"));
  invariant(new Set(oidNames).size === 544 && JSON.stringify(snapshot.objectOids) === JSON.stringify(sortedOids), "Keycloak-Schema-Zustand besitzt einen doppelten oder unsortierten OID-Katalog.");
  exactObjectKeys(snapshot.activeSignatures, ["relations", "columns", "constraints", "indexes", "triggers", "sequences", "views", "types"], "Keycloak-Schema-Zustand.activeSignatures");
  for (const [name, value] of Object.entries(snapshot.activeSignatures)) validateSignature(value, `Keycloak-Schema-Zustand.activeSignatures.${name}`);
  return snapshot;
}

function relationNamesWithoutKeycloak(relations, catalog) {
  const keycloakNames = new Set(catalog.objects.tables);
  return relations.filter(({ name, extensionName }) => !keycloakNames.has(name) && extensionName === null).map(({ name }) => name).sort();
}

export async function inspectKeycloakSchemaState(sql, catalog) {
  validateKeycloakObjectCatalog(catalog);
  invariant(await postgresMajor(sql) === catalog.postgresMajor, "Keycloak-Schema-Migration laeuft nicht auf PostgreSQL 16.");
  const [
    sourceSchemaExists,
    targetSchemaExists,
    targetSchemaComment,
    migrationCount,
    publicRelations,
    targetRelations,
    publicRoutines,
    targetRoutines,
    publicTypes,
    targetTypes,
  ] = await Promise.all([
    schemaExists(sql, KEYCLOAK_SOURCE_SCHEMA),
    schemaExists(sql, KEYCLOAK_TARGET_SCHEMA),
    schemaComment(sql, KEYCLOAK_TARGET_SCHEMA),
    drizzleMigrationCount(sql),
    userRelations(sql, KEYCLOAK_SOURCE_SCHEMA),
    userRelations(sql, KEYCLOAK_TARGET_SCHEMA),
    userRoutines(sql, KEYCLOAK_SOURCE_SCHEMA),
    userRoutines(sql, KEYCLOAK_TARGET_SCHEMA),
    userEnumAndDomainTypes(sql, KEYCLOAK_SOURCE_SCHEMA),
    userEnumAndDomainTypes(sql, KEYCLOAK_TARGET_SCHEMA),
  ]);
  invariant(sourceSchemaExists, "PostgreSQL-public-Schema fehlt.");
  const sourceKeycloak = publicRelations.filter(({ name }) => catalog.objects.tables.includes(name));
  const targetKeycloak = targetRelations.filter(({ name }) => catalog.objects.tables.includes(name));
  const unexpectedTarget = targetRelations.filter(({ name }) => !catalog.objects.tables.includes(name));
  invariant(unexpectedTarget.length === 0, "Das keycloak-Schema enthaelt fremde Relationen.");
  invariant(sourceKeycloak.every(({ extensionName }) => extensionName === null), "Public-Schema besitzt extension-owned Keycloak-Relationen.");
  invariant(targetKeycloak.every(({ extensionName }) => extensionName === null), "Das keycloak-Schema besitzt extension-owned Keycloak-Relationen.");
  invariant(targetRoutines.length === 0 && targetTypes.length === 0, "Das keycloak-Schema enthaelt fremde Routinen, Enums oder Domains.");
  invariant(publicTypes.length === 0, "Das public-Schema enthaelt unbekannte Enums oder Domains.");
  const publicExtension = validatePublicExtensionContract(publicRelations, publicRoutines);
  const publicApplicationRoutines = publicExtension.applicationRoutines;
  const publicGameNames = relationNamesWithoutKeycloak(publicRelations, catalog);

  let state;
  let gameVariant;
  if (sourceKeycloak.length === catalog.objects.tables.length && targetKeycloak.length === 0) {
    state = "legacy";
    gameVariant = validateGameDatabaseCatalog(publicGameNames, publicApplicationRoutines, migrationCount);
  } else if (sourceKeycloak.length === 0 && targetKeycloak.length === catalog.objects.tables.length) {
    state = "migrated";
    gameVariant = validateGameDatabaseCatalog(publicGameNames, publicApplicationRoutines, migrationCount);
  } else if (sourceKeycloak.length === 0 && targetKeycloak.length === 0) {
    invariant(migrationCount === 0 && publicGameNames.length === 0, "Leerer Keycloak-Zustand ist kein sauberer Bootstrapzustand.");
    invariant(publicApplicationRoutines.length === 0, "Leerer Keycloak-Bootstrap besitzt bereits unbekannte Routinen.");
    invariant(targetSchemaExists, "Bootstrapzustand besitzt kein vorab angelegtes leeres keycloak-Schema.");
    state = "bootstrap";
    gameVariant = "empty-database";
  } else {
    throw new Error("Keycloak-Relationen liegen in einem gemischten oder partiellen public/keycloak-Zustand.");
  }

  const activeSchema = state === "legacy" ? KEYCLOAK_SOURCE_SCHEMA : state === "migrated" ? KEYCLOAK_TARGET_SCHEMA : null;
  let activeCatalog = null;
  let identity = null;
  if (activeSchema !== null) {
    const activeRelations = activeSchema === KEYCLOAK_SOURCE_SCHEMA ? publicRelations : targetRelations;
    activeCatalog = assertCatalogSignature(
      await inspectCatalogAtSchema(sql, activeSchema, catalog, activeRelations),
      catalog,
      `Keycloak-Schema '${activeSchema}'`,
    );
    identity = await inspectIdentityHead(sql, activeSchema, catalog, activeRelations);
  }
  return validateKeycloakStateSnapshot(Object.freeze({
    schema: KEYCLOAK_SCHEMA_STATE_SCHEMA,
    state,
    gameVariant,
    databaseMigrationCount: migrationCount,
    sourceSchemaExists,
    targetSchemaExists,
    targetSchemaComment,
    objectCatalogSha256: catalog.catalogSha256,
    identityHead: identity?.identityHead ?? null,
    objectOids: identity?.objectOids ?? [],
    objectOidsSha256: identity?.objectOidsSha256 ?? EMPTY_ARRAY_SHA256,
    activeSignatures: activeCatalog?.signatures ?? null,
  }));
}

export function databaseEndpointSha256(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("PostgreSQL-Endpunkt ist keine gueltige URL.");
  }
  invariant(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:", "PostgreSQL-Endpunkt verwendet kein postgres/postgresql-Schema.");
  return canonicalSha256({
    protocol: "postgresql:",
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port === "" ? "5432" : parsed.port,
    database: decodeURIComponent(parsed.pathname.replace(/^\//u, "")),
    socketHost: parsed.searchParams.get("host") ?? null,
  });
}

function databaseName(databaseUrl, label) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${label} ist keine gueltige PostgreSQL-URL.`);
  }
  invariant(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:", `${label} verwendet kein postgres/postgresql-Schema.`);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  invariant(SAFE_NAME.test(name), `${label} besitzt keinen sicheren Datenbanknamen.`);
  return name;
}

export function validateGameRestoreReceipt(receipt) {
  exactObjectKeys(receipt, [
    "schema",
    "database",
    "migrationCount",
    "dumpSha256",
    "manifestSha256",
    "identical",
  ], "Keycloak-Migrations-Restore-Receipt");
  invariant(receipt.schema === KEYCLOAK_GAME_RESTORE_SCHEMA, "Keycloak-Migrations-Restore-Receipt besitzt ein unbekanntes Schema.");
  invariant(/^zugfolge_restore_[a-z0-9_]+$/u.test(receipt.database), "Keycloak-Migrations-Restore-Receipt bindet keine isolierte Restore-Datenbank.");
  safeInteger(receipt.migrationCount, "Keycloak-Migrations-Restore-Receipt.migrationCount");
  invariant(SHA256.test(receipt.dumpSha256) && SHA256.test(receipt.manifestSha256), "Keycloak-Migrations-Restore-Receipt bindet Dump und Manifest nicht per SHA-256.");
  invariant(receipt.identical === true, "Keycloak-Migrations-Restore-Receipt belegt keinen erfolgreichen Restore.");
  return receipt;
}

function parseGameRestoreReceipt(bytes) {
  invariant(Buffer.isBuffer(bytes) && bytes.length > 0, "Keycloak-Migrations-Restore-Receipt fehlt.");
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Keycloak-Migrations-Restore-Receipt ist kein JSON-Artefakt.");
  }
  validateGameRestoreReceipt(receipt);
  invariant(bytes.equals(canonicalJsonBytes(receipt)), "Keycloak-Migrations-Restore-Receipt ist nicht kanonisch serialisiert.");
  return receipt;
}

export function createBackupBinding({
  manifestBytes,
  dumpBytes,
  restoreReceiptBytes,
  snapshot,
  databaseUrl,
  restoredDatabaseUrl,
  writersQuiesced,
}) {
  invariant(Buffer.isBuffer(manifestBytes) && manifestBytes.length > 0, "Keycloak-Migrations-Backup-Manifest fehlt.");
  invariant(Buffer.isBuffer(dumpBytes) && dumpBytes.length > 0, "Keycloak-Migrations-Backup-Dump fehlt.");
  return createBackupBindingFromProof({
    manifestBytes,
    dumpProof: { bytes: dumpBytes.length, sha256: sha256Bytes(dumpBytes) },
    restoreReceiptBytes,
    snapshot,
    databaseUrl,
    restoredDatabaseUrl,
    writersQuiesced,
  });
}

function createBackupBindingFromProof({
  manifestBytes,
  dumpProof,
  restoreReceiptBytes,
  snapshot,
  databaseUrl,
  restoredDatabaseUrl,
  writersQuiesced,
}) {
  invariant(Buffer.isBuffer(manifestBytes) && manifestBytes.length > 0, "Keycloak-Migrations-Backup-Manifest fehlt.");
  invariant(dumpProof !== null && typeof dumpProof === "object", "Keycloak-Migrations-Backup-Dumpbeleg fehlt.");
  safeInteger(dumpProof.bytes, "Keycloak-Migrations-Backup-Dumpbeleg.bytes", { positive: true });
  invariant(SHA256.test(dumpProof.sha256), "Keycloak-Migrations-Backup-Dumpbeleg.sha256 ist kein SHA-256.");
  invariant(snapshot?.state === "legacy" || snapshot?.state === "migrated", "Backup-Bindung besitzt keinen vollstaendigen Keycloak-Zustand.");
  invariant(writersQuiesced === true, "Backup-Bindung erfordert nachweislich gestoppte Keycloak-Writer.");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Keycloak-Migrations-Backup-Manifest ist kein JSON.");
  }
  exactObjectKeys(manifest, ["schema", "createdAt", "bytes", "sha256", "migrationCount", "rpoSeconds"], "Keycloak-Migrations-Backup-Manifest");
  invariant(manifest.schema === "zugfolge-game-backup/v2", "Keycloak-Migration bindet keinen vollstaendigen PostgreSQL-Custom-Dump.");
  invariant(typeof manifest.createdAt === "string" && Number.isFinite(Date.parse(manifest.createdAt)), "Backup-Manifest besitzt keinen Erstellungszeitpunkt.");
  safeInteger(manifest.bytes, "Backup-Manifest.bytes", { positive: true });
  safeInteger(manifest.migrationCount, "Backup-Manifest.migrationCount");
  invariant(manifest.rpoSeconds === 300, "Backup-Manifest besitzt nicht den freigegebenen RPO-Vertrag.");
  invariant(SHA256.test(manifest.sha256), "Backup-Manifest besitzt keinen Dump-SHA-256.");
  invariant(manifest.bytes === dumpProof.bytes && manifest.sha256 === dumpProof.sha256, "Backup-Dump stimmt nicht bytegenau mit seinem Manifest ueberein.");
  invariant(manifest.migrationCount === snapshot.databaseMigrationCount, "Backup-Manifest bindet einen anderen Drizzle-Migrationsstand.");
  const restoreReceipt = parseGameRestoreReceipt(restoreReceiptBytes);
  invariant(restoreReceipt.database === databaseName(restoredDatabaseUrl, "Keycloak-Migrations-Restore-Endpunkt"), "Restore-Receipt und isolierter Restore-Endpunkt binden verschiedene Datenbanken.");
  invariant(restoreReceipt.migrationCount === snapshot.databaseMigrationCount, "Restore-Receipt bindet einen anderen Drizzle-Migrationsstand als der isolierte Restore.");
  invariant(restoreReceipt.dumpSha256 === dumpProof.sha256, "Restore-Receipt bindet einen anderen Backup-Dump.");
  invariant(restoreReceipt.manifestSha256 === sha256Bytes(manifestBytes), "Restore-Receipt bindet ein anderes Backup-Manifest.");
  const sourceEndpointSha256 = databaseEndpointSha256(databaseUrl);
  const restoredEndpointSha256 = databaseEndpointSha256(restoredDatabaseUrl);
  invariant(sourceEndpointSha256 !== restoredEndpointSha256, "Backup-Bindung erfordert eine getrennte isolierte Restore-Datenbank.");
  const binding = Object.freeze({
    schema: KEYCLOAK_SCHEMA_BACKUP_BINDING_SCHEMA,
    manifestSchema: manifest.schema,
    manifestBytes: manifestBytes.length,
    manifestSha256: sha256Bytes(manifestBytes),
    dumpBytes: dumpProof.bytes,
    dumpSha256: manifest.sha256,
    createdAt: new Date(manifest.createdAt).toISOString(),
    databaseMigrationCount: manifest.migrationCount,
    databaseEndpointSha256: sourceEndpointSha256,
    restoredDatabaseEndpointSha256: restoredEndpointSha256,
    restoreReceiptSchema: restoreReceipt.schema,
    restoreReceiptSha256: sha256Bytes(restoreReceiptBytes),
    keycloakIdentityHeadSha256: snapshot.identityHead.stateHash,
    objectCatalogSha256: snapshot.objectCatalogSha256,
    writersQuiesced: true,
  });
  return validateBackupBinding(binding);
}

export function validateBackupBinding(binding) {
  exactObjectKeys(binding, [
    "schema",
    "manifestSchema",
    "manifestBytes",
    "manifestSha256",
    "dumpBytes",
    "dumpSha256",
    "createdAt",
    "databaseMigrationCount",
    "databaseEndpointSha256",
    "restoredDatabaseEndpointSha256",
    "restoreReceiptSchema",
    "restoreReceiptSha256",
    "keycloakIdentityHeadSha256",
    "objectCatalogSha256",
    "writersQuiesced",
  ], "Keycloak-Schema-Backup-Bindung");
  invariant(binding.schema === KEYCLOAK_SCHEMA_BACKUP_BINDING_SCHEMA, "Keycloak-Schema-Backup-Bindung besitzt ein unbekanntes Schema.");
  invariant(binding.manifestSchema === "zugfolge-game-backup/v2", "Keycloak-Schema-Backup-Bindung besitzt kein Vollbackup-Manifest.");
  safeInteger(binding.manifestBytes, "Keycloak-Schema-Backup-Bindung.manifestBytes", { positive: true });
  safeInteger(binding.dumpBytes, "Keycloak-Schema-Backup-Bindung.dumpBytes", { positive: true });
  safeInteger(binding.databaseMigrationCount, "Keycloak-Schema-Backup-Bindung.databaseMigrationCount");
  for (const name of ["manifestSha256", "dumpSha256", "databaseEndpointSha256", "restoredDatabaseEndpointSha256", "restoreReceiptSha256", "keycloakIdentityHeadSha256", "objectCatalogSha256"]) {
    invariant(SHA256.test(binding[name]), `Keycloak-Schema-Backup-Bindung.${name} ist kein SHA-256.`);
  }
  canonicalInstant(binding.createdAt, "Keycloak-Schema-Backup-Bindung.createdAt");
  invariant(binding.restoreReceiptSchema === KEYCLOAK_GAME_RESTORE_SCHEMA, "Keycloak-Schema-Backup-Bindung besitzt keinen isolierten Restore-Receipt.");
  invariant(binding.databaseEndpointSha256 !== binding.restoredDatabaseEndpointSha256, "Keycloak-Schema-Backup-Bindung verwendet die Quelldatenbank als Restore-Ziel.");
  invariant(binding.writersQuiesced === true, "Keycloak-Schema-Backup-Bindung wurde nicht quiesziert erzeugt.");
  return binding;
}

function planHash(plan) {
  const { planHash: ignored, ...payload } = plan;
  void ignored;
  return canonicalSha256(payload);
}

export function createMigrationPlan({ action, snapshot, backupBinding, databaseUrl, createdAt }) {
  invariant(action === "up" || action === "down", "Keycloak-Schema-Migrationsplan besitzt keine bekannte Aktion.");
  const expectedState = action === "up" ? "legacy" : "migrated";
  invariant(snapshot?.state === expectedState, `Keycloak-Schema-Migrationsplan '${action}' erwartet Zustand '${expectedState}'.`);
  validateBackupBinding(backupBinding);
  const endpointSha256 = databaseEndpointSha256(databaseUrl);
  invariant(backupBinding.databaseEndpointSha256 === endpointSha256, "Keycloak-Schema-Backup stammt von einem anderen Datenbankendpunkt.");
  invariant(backupBinding.databaseMigrationCount === snapshot.databaseMigrationCount, "Keycloak-Schema-Backup bindet einen anderen Drizzle-Stand.");
  invariant(backupBinding.keycloakIdentityHeadSha256 === snapshot.identityHead.stateHash, "Keycloak-Schema-Backup bindet einen anderen Identitaetskopf.");
  invariant(backupBinding.objectCatalogSha256 === snapshot.objectCatalogSha256, "Keycloak-Schema-Backup bindet einen anderen Objektkatalog.");
  const candidate = Object.freeze({
    schema: KEYCLOAK_SCHEMA_MIGRATION_SCHEMA,
    action,
    sourceSchema: action === "up" ? KEYCLOAK_SOURCE_SCHEMA : KEYCLOAK_TARGET_SCHEMA,
    targetSchema: action === "up" ? KEYCLOAK_TARGET_SCHEMA : KEYCLOAK_SOURCE_SCHEMA,
    expectedBeforeState: expectedState,
    expectedAfterState: action === "up" ? "migrated" : "legacy",
    databaseEndpointSha256: endpointSha256,
    databaseMigrationCount: snapshot.databaseMigrationCount,
    objectCatalogSha256: snapshot.objectCatalogSha256,
    writersQuiesced: true,
    backupBinding,
    before: snapshot,
    createdAt: canonicalInstant(createdAt, "Keycloak-Schema-Migrationsplan.createdAt"),
  });
  return validateMigrationPlan(Object.freeze({ ...candidate, planHash: canonicalSha256(candidate) }));
}

export function validateMigrationPlan(plan) {
  exactObjectKeys(plan, [
    "schema",
    "action",
    "sourceSchema",
    "targetSchema",
    "expectedBeforeState",
    "expectedAfterState",
    "databaseEndpointSha256",
    "databaseMigrationCount",
    "objectCatalogSha256",
    "writersQuiesced",
    "backupBinding",
    "before",
    "createdAt",
    "planHash",
  ], "Keycloak-Schema-Migrationsplan");
  invariant(plan.schema === KEYCLOAK_SCHEMA_MIGRATION_SCHEMA, "Keycloak-Schema-Migrationsplan besitzt ein unbekanntes Schema.");
  invariant(plan.action === "up" || plan.action === "down", "Keycloak-Schema-Migrationsplan besitzt eine unbekannte Aktion.");
  const up = plan.action === "up";
  invariant(plan.sourceSchema === (up ? KEYCLOAK_SOURCE_SCHEMA : KEYCLOAK_TARGET_SCHEMA), "Keycloak-Schema-Migrationsplan besitzt ein falsches Quellschema.");
  invariant(plan.targetSchema === (up ? KEYCLOAK_TARGET_SCHEMA : KEYCLOAK_SOURCE_SCHEMA), "Keycloak-Schema-Migrationsplan besitzt ein falsches Zielschema.");
  invariant(plan.expectedBeforeState === (up ? "legacy" : "migrated") && plan.expectedAfterState === (up ? "migrated" : "legacy"), "Keycloak-Schema-Migrationsplan besitzt widerspruechliche Zustaende.");
  invariant(SHA256.test(plan.databaseEndpointSha256) && SHA256.test(plan.objectCatalogSha256), "Keycloak-Schema-Migrationsplan ist nicht an Endpunkt und Katalog gebunden.");
  safeInteger(plan.databaseMigrationCount, "Keycloak-Schema-Migrationsplan.databaseMigrationCount");
  invariant(plan.writersQuiesced === true, "Keycloak-Schema-Migrationsplan ist nicht quiesziert.");
  validateBackupBinding(plan.backupBinding);
  validateKeycloakStateSnapshot(plan.before);
  invariant(plan.before.state === plan.expectedBeforeState, "Keycloak-Schema-Migrationsplan bindet keinen exakten Vorzustand.");
  invariant(plan.before.identityHead?.stateHash === plan.backupBinding.keycloakIdentityHeadSha256, "Keycloak-Schema-Migrationsplan und Backup binden verschiedene Identitaetskoepfe.");
  invariant(plan.before.objectOidsSha256 === canonicalSha256(plan.before.objectOids), "Keycloak-Schema-Migrationsplan bindet keine exakten Objekt-OIDs.");
  canonicalInstant(plan.createdAt, "Keycloak-Schema-Migrationsplan.createdAt");
  invariant(SHA256.test(plan.planHash) && plan.planHash === planHash(plan), "Keycloak-Schema-Migrationsplan besitzt keinen gueltigen kanonischen Hash.");
  return plan;
}

function sameSnapshot(expected, actual) {
  invariant(canonicalSha256(expected) === canonicalSha256(actual), "Live-Keycloak-Zustand stimmt nicht mehr mit dem freigegebenen Migrationsplan ueberein.");
}

export async function lockKeycloakCatalogTables(sql, schema, catalog, { mode = "access-exclusive" } = {}) {
  validateKeycloakObjectCatalog(catalog);
  const lockMode = mode === "access-exclusive" ? "access exclusive" : mode === "share" ? "share" : undefined;
  invariant(lockMode !== undefined, "Keycloak-Katalogsperre besitzt einen unbekannten Modus.");
  const names = catalog.objects.tables.map((table) => `${quoteName(schema)}.${quoteName(table)}`).join(", ");
  await sql.unsafe(`lock table ${names} in ${lockMode} mode`);
}

async function lockKeycloakTables(sql, schema, catalog) {
  await lockKeycloakCatalogTables(sql, schema, catalog, { mode: "access-exclusive" });
}

async function withMigrationSessionLock(client, work) {
  invariant(typeof client?.reserve === "function", "Keycloak-Schema-Migration erfordert eine reservierbare PostgreSQL-Verbindung.");
  const connection = await client.reserve();
  invariant(typeof connection?.release === "function", "Reservierte PostgreSQL-Verbindung besitzt keine sichere Freigabe.");
  let locked = false;
  try {
    const lockRows = await connection.unsafe("select pg_try_advisory_lock(hashtextextended($1, 0)) as locked", [ADVISORY_LOCK_KEY]);
    invariant(lockRows.length === 1 && lockRows[0].locked === true, "Eine andere Keycloak-Schema-Migration haelt bereits den Migrationslock.");
    locked = true;
    return await work(connection);
  } finally {
    try {
      if (locked) {
        const rows = await connection.unsafe("select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked", [ADVISORY_LOCK_KEY]);
        invariant(rows.length === 1 && rows[0].unlocked === true, "Keycloak-Schema-Migrationslock konnte nicht freigegeben werden.");
      }
    } finally {
      connection.release();
    }
  }
}

async function moveCatalog(sql, sourceSchema, targetSchema, catalog) {
  for (const table of catalog.objects.tables) {
    await sql.unsafe(`alter table ${quoteName(sourceSchema)}.${quoteName(table)} set schema ${quoteName(targetSchema)}`);
  }
}

function assertMovePreserved(before, after) {
  invariant(before.identityHead.stateHash === after.identityHead.stateHash, "Keycloak-Schema-Migration veraenderte Identitaeten, Realms, Clients, Sitzungen oder Credentials.");
  invariant(before.objectOidsSha256 === after.objectOidsSha256, "Keycloak-Schema-Migration ersetzte Relationen statt ihre OIDs zu erhalten.");
  invariant(canonicalSha256(before.objectOids) === canonicalSha256(after.objectOids), "Keycloak-Schema-Migration veraenderte den exakten OID-Katalog.");
  if (after.state === "migrated") {
    invariant(
      after.targetSchemaComment === null,
      "Keycloak-Up-Migration darf keinen Fresh-Bootstrap-Ursprungsmarker tragen.",
    );
  }
}

function receiptHash(receipt) {
  const { receiptHash: ignored, ...payload } = receipt;
  void ignored;
  return canonicalSha256(payload);
}

function createReceipt({ plan, after, completedAt, recovered }) {
  const schema = recovered ? KEYCLOAK_SCHEMA_RECOVER_RECEIPT_SCHEMA : KEYCLOAK_SCHEMA_RECEIPT_SCHEMA;
  const candidate = Object.freeze({
    schema,
    migrationSchema: KEYCLOAK_SCHEMA_MIGRATION_SCHEMA,
    action: plan.action,
    completion: recovered ? "recovered-after-commit" : "committed",
    planHash: plan.planHash,
    databaseEndpointSha256: plan.databaseEndpointSha256,
    objectCatalogSha256: plan.objectCatalogSha256,
    backupBinding: plan.backupBinding,
    beforeIdentityHead: plan.before.identityHead,
    afterIdentityHead: after.identityHead,
    beforeObjectOidsSha256: plan.before.objectOidsSha256,
    afterObjectOidsSha256: after.objectOidsSha256,
    completedAt: canonicalInstant(completedAt, "Keycloak-Schema-Migrationsreceipt.completedAt"),
  });
  return validateMigrationReceipt(Object.freeze({ ...candidate, receiptHash: canonicalSha256(candidate) }));
}

export function validateMigrationReceipt(receipt) {
  exactObjectKeys(receipt, [
    "schema",
    "migrationSchema",
    "action",
    "completion",
    "planHash",
    "databaseEndpointSha256",
    "objectCatalogSha256",
    "backupBinding",
    "beforeIdentityHead",
    "afterIdentityHead",
    "beforeObjectOidsSha256",
    "afterObjectOidsSha256",
    "completedAt",
    "receiptHash",
  ], "Keycloak-Schema-Migrationsreceipt");
  const recovered = receipt.schema === KEYCLOAK_SCHEMA_RECOVER_RECEIPT_SCHEMA;
  invariant(recovered || receipt.schema === KEYCLOAK_SCHEMA_RECEIPT_SCHEMA, "Keycloak-Schema-Migrationsreceipt besitzt ein unbekanntes Schema.");
  invariant(receipt.migrationSchema === KEYCLOAK_SCHEMA_MIGRATION_SCHEMA, "Keycloak-Schema-Migrationsreceipt bindet eine andere Migration.");
  invariant(receipt.action === "up" || receipt.action === "down", "Keycloak-Schema-Migrationsreceipt besitzt eine unbekannte Aktion.");
  invariant(receipt.completion === (recovered ? "recovered-after-commit" : "committed"), "Keycloak-Schema-Migrationsreceipt besitzt einen widerspruechlichen Abschlussmodus.");
  for (const name of ["planHash", "databaseEndpointSha256", "objectCatalogSha256", "beforeObjectOidsSha256", "afterObjectOidsSha256"]) {
    invariant(SHA256.test(receipt[name]), `Keycloak-Schema-Migrationsreceipt.${name} ist kein SHA-256.`);
  }
  validateBackupBinding(receipt.backupBinding);
  validateKeycloakIdentityHead(receipt.beforeIdentityHead);
  validateKeycloakIdentityHead(receipt.afterIdentityHead);
  invariant(receipt.beforeIdentityHead.objectCatalogSha256 === receipt.objectCatalogSha256, "Keycloak-Schema-Migrationsreceipt bindet vor der Migration einen anderen Objektkatalog.");
  invariant(receipt.afterIdentityHead.objectCatalogSha256 === receipt.objectCatalogSha256, "Keycloak-Schema-Migrationsreceipt bindet nach der Migration einen anderen Objektkatalog.");
  invariant(receipt.backupBinding.databaseEndpointSha256 === receipt.databaseEndpointSha256, "Keycloak-Schema-Migrationsreceipt und Backup binden verschiedene Datenbankendpunkte.");
  invariant(receipt.backupBinding.objectCatalogSha256 === receipt.objectCatalogSha256, "Keycloak-Schema-Migrationsreceipt und Backup binden verschiedene Objektkataloge.");
  invariant(receipt.backupBinding.keycloakIdentityHeadSha256 === receipt.beforeIdentityHead.stateHash, "Keycloak-Schema-Migrationsreceipt und Backup binden verschiedene Identitaetskoepfe.");
  invariant(receipt.beforeIdentityHead.stateHash === receipt.afterIdentityHead.stateHash, "Keycloak-Schema-Migrationsreceipt belegt keine verlustfreie Identitaetsmigration.");
  invariant(receipt.beforeObjectOidsSha256 === receipt.afterObjectOidsSha256, "Keycloak-Schema-Migrationsreceipt belegt keine OID-erhaltende Migration.");
  canonicalInstant(receipt.completedAt, "Keycloak-Schema-Migrationsreceipt.completedAt");
  invariant(SHA256.test(receipt.receiptHash) && receipt.receiptHash === receiptHash(receipt), "Keycloak-Schema-Migrationsreceipt besitzt keinen gueltigen kanonischen Hash.");
  return receipt;
}

export function createBootstrapReceipt({ live, databaseUrl, catalog, completedAt }) {
  assertLiveMigratedStructure(live, catalog);
  const candidate = Object.freeze({
    schema: KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_SCHEMA,
    action: "bootstrap",
    completion: "initialized",
    databaseEndpointSha256: databaseEndpointSha256(databaseUrl),
    objectCatalogSha256: catalog.catalogSha256,
    initialIdentityHead: live.identityHead,
    initialObjectOidsSha256: live.objectOidsSha256,
    completedAt: canonicalInstant(completedAt, "Keycloak-Schema-Bootstrapreceipt.completedAt"),
  });
  return validateBootstrapReceipt(Object.freeze({ ...candidate, receiptHash: canonicalSha256(candidate) }));
}

export function validateBootstrapReceipt(receipt) {
  exactObjectKeys(receipt, [
    "schema",
    "action",
    "completion",
    "databaseEndpointSha256",
    "objectCatalogSha256",
    "initialIdentityHead",
    "initialObjectOidsSha256",
    "completedAt",
    "receiptHash",
  ], "Keycloak-Schema-Bootstrapreceipt");
  invariant(receipt.schema === KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_SCHEMA, "Keycloak-Schema-Bootstrapreceipt besitzt ein unbekanntes Schema.");
  invariant(receipt.action === "bootstrap" && receipt.completion === "initialized", "Keycloak-Schema-Bootstrapreceipt besitzt einen widerspruechlichen Abschlussmodus.");
  for (const name of ["databaseEndpointSha256", "objectCatalogSha256", "initialObjectOidsSha256"]) {
    invariant(SHA256.test(receipt[name]), `Keycloak-Schema-Bootstrapreceipt.${name} ist kein SHA-256.`);
  }
  validateKeycloakIdentityHead(receipt.initialIdentityHead);
  invariant(receipt.initialIdentityHead.objectCatalogSha256 === receipt.objectCatalogSha256, "Keycloak-Schema-Bootstrapreceipt bindet einen widerspruechlichen Objektkatalog.");
  canonicalInstant(receipt.completedAt, "Keycloak-Schema-Bootstrapreceipt.completedAt");
  invariant(SHA256.test(receipt.receiptHash) && receipt.receiptHash === receiptHash(receipt), "Keycloak-Schema-Bootstrapreceipt besitzt keinen gueltigen kanonischen Hash.");
  return receipt;
}

export function validateInstalledKeycloakSchemaReceipt(receipt) {
  invariant(receipt !== null && typeof receipt === "object" && !Array.isArray(receipt), "Installierter Keycloak-Schema-Receipt fehlt.");
  if (receipt.schema === KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_SCHEMA) return validateBootstrapReceipt(receipt);
  if (receipt.schema === KEYCLOAK_SCHEMA_RECEIPT_SCHEMA || receipt.schema === KEYCLOAK_SCHEMA_RECOVER_RECEIPT_SCHEMA) {
    return validateMigrationReceipt(receipt);
  }
  throw new Error("Installierter Keycloak-Schema-Receipt besitzt ein unbekanntes Schema.");
}

function assertLiveMigratedStructure(live, catalog) {
  validateKeycloakObjectCatalog(catalog);
  validateKeycloakStateSnapshot(live);
  invariant(live.state === "migrated", "Keycloak-Start erwartet ausschliesslich den migrierten Zustand.");
  invariant(live.targetSchemaExists === true, "Keycloak-Start besitzt kein keycloak-Zielschema.");
  invariant(live.objectCatalogSha256 === catalog.catalogSha256, "Live-Keycloak-Zustand bindet einen anderen Objektkatalog.");
  invariant(live.identityHead.objectCatalogSha256 === catalog.catalogSha256, "Live-Keycloak-Identitaetskopf bindet einen anderen Objektkatalog.");
  invariant(
    canonicalSha256(live.activeSignatures) === canonicalSha256(catalog.signatures),
    "Live-Keycloak-Struktur stimmt nicht mit dem freigegebenen Objektkatalog ueberein.",
  );
  return live;
}

export async function executeMigration(client, plan, catalog, {
  now = () => new Date().toISOString(),
  inspectState = inspectKeycloakSchemaState,
  lockTables = lockKeycloakTables,
  verifyLiquibaseUnlocked = ensureLiquibaseUnlocked,
  moveTables = moveCatalog,
} = {}) {
  validateMigrationPlan(plan);
  validateKeycloakObjectCatalog(catalog);
  invariant(plan.objectCatalogSha256 === catalog.catalogSha256, "Keycloak-Schema-Migrationsplan bindet einen anderen Objektkatalog als die Laufzeit.");
  return withMigrationSessionLock(client, async (connection) => {
    const after = await connection.begin("isolation level serializable", async (sql) => {
      await sql.unsafe("set local lock_timeout = '10s'");
      // PostgreSQL freezes a SERIALIZABLE view at its first SELECT. The
      // advisory lock therefore lives on this reserved session outside the
      // transaction; ACCESS EXCLUSIVE remains the first snapshot-relevant
      // command inside it and observes writers that committed while waiting.
      await lockTables(sql, plan.sourceSchema, catalog);
      const beforeLocked = await inspectState(sql, catalog);
      sameSnapshot(plan.before, beforeLocked);
      await verifyLiquibaseUnlocked(sql, plan.sourceSchema);
      if (plan.action === "up" && !beforeLocked.targetSchemaExists) {
        await sql.unsafe(`create schema ${quoteName(KEYCLOAK_TARGET_SCHEMA)}`);
      }
      await moveTables(sql, plan.sourceSchema, plan.targetSchema, catalog);
      if (plan.action === "up") {
        // Der Init-Hook-Marker belegt ausschliesslich den leeren Fresh-Bootstrap.
        // Ein Up-Cutover darf ihn nicht in den migrierten Zustand mitnehmen,
        // sonst koennte ein fehlender Receipt spaeter als Fresh attestiert werden.
        await sql.unsafe(`comment on schema ${quoteName(KEYCLOAK_TARGET_SCHEMA)} is null`);
      } else {
        await sql.unsafe(`drop schema ${quoteName(KEYCLOAK_TARGET_SCHEMA)}`);
      }
      const next = await inspectState(sql, catalog);
      invariant(next.state === plan.expectedAfterState, "Keycloak-Schema-Migration erreichte nicht den geplanten Zielzustand.");
      assertMovePreserved(plan.before, next);
      return next;
    });
    const committed = await inspectState(connection, catalog);
    invariant(committed.state === plan.expectedAfterState, "Keycloak-Schema-Migration ist nach Commit nicht sichtbar.");
    assertMovePreserved(plan.before, committed);
    invariant(canonicalSha256(after.identityHead) === canonicalSha256(committed.identityHead), "Keycloak-Zustand aenderte sich zwischen Commit und Receipt.");
    return createReceipt({ plan, after: committed, completedAt: now(), recovered: false });
  });
}

export async function recoverMigrationReceipt(client, plan, catalog, {
  now = () => new Date().toISOString(),
  inspectState = inspectKeycloakSchemaState,
  lockTables = lockKeycloakTables,
} = {}) {
  validateMigrationPlan(plan);
  validateKeycloakObjectCatalog(catalog);
  invariant(plan.objectCatalogSha256 === catalog.catalogSha256, "Recover-Receipt bindet einen anderen Objektkatalog als die Laufzeit.");
  return withMigrationSessionLock(client, async (connection) => {
    const live = await connection.begin("isolation level serializable", async (sql) => {
      await sql.unsafe("set local lock_timeout = '10s'");
      await lockTables(sql, plan.targetSchema, catalog);
      return inspectState(sql, catalog);
    });
    invariant(live.state === plan.expectedAfterState, "Recover-Receipt verweigert: Migration ist nicht vollstaendig committed.");
    assertMovePreserved(plan.before, live);
    return createReceipt({ plan, after: live, completedAt: now(), recovered: true });
  });
}

async function regularFileBytes(path, label) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${label} ist keine regulaere, nichtleere Datei.`);
  const bytes = await readFile(absolute);
  invariant(bytes.length === metadata.size, `${label} aenderte sich waehrend des Lesens.`);
  return bytes;
}

async function regularFileProof(path, label) {
  const absolute = resolve(path);
  const before = await lstat(absolute);
  invariant(before.isFile() && !before.isSymbolicLink() && before.size > 0, `${label} ist keine regulaere, nichtleere Datei.`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(absolute)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  const after = await lstat(absolute);
  invariant(
    bytes === before.size
      && after.size === before.size
      && after.mtimeMs === before.mtimeMs,
    `${label} aenderte sich waehrend der Hashbildung.`,
  );
  return Object.freeze({ bytes, sha256: hash.digest("hex") });
}

async function canonicalArtifact(path, validator, label) {
  const bytes = await regularFileBytes(path, label);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} ist kein JSON-Artefakt.`);
  }
  validator(value);
  invariant(bytes.equals(canonicalJsonBytes(value)), `${label} ist nicht kanonisch serialisiert.`);
  return value;
}

async function canonicalArtifactIfExists(path, validator, label) {
  try {
    return await canonicalArtifact(path, validator, label);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCreateNew(path, value) {
  const handle = await open(resolve(path), "wx", 0o600);
  try {
    await handle.writeFile(canonicalJsonBytes(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value;
}

async function postgresClient(databaseUrl) {
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const postgresModule = requireFromDb("postgres");
  const factory = postgresModule.default ?? postgresModule;
  return factory(databaseUrl, { max: 1 });
}

export function validateReceiptAgainstLive(receipt, live, databaseUrl, catalog) {
  validateInstalledKeycloakSchemaReceipt(receipt);
  assertLiveMigratedStructure(live, catalog);
  if (receipt.schema === KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_SCHEMA) {
    invariant(
      live.targetSchemaComment === KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT,
      "Bootstrap-Receipt ist ohne den expliziten Init-Hook-Ursprungsmarker veraltet.",
    );
  } else {
    invariant(receipt.action === "up", "Normaler Keycloak-Start akzeptiert keinen Down-Receipt.");
  }
  invariant(receipt.databaseEndpointSha256 === databaseEndpointSha256(databaseUrl), "Keycloak-Schema-Receipt gehoert zu einem anderen Datenbankendpunkt.");
  invariant(receipt.objectCatalogSha256 === catalog.catalogSha256, "Keycloak-Schema-Receipt bindet einen anderen Objektkatalog.");
  return receipt;
}

export async function runKeycloakSchemaCommand(command, {
  environment = process.env,
  now = () => new Date().toISOString(),
  createClient = postgresClient,
  inspectState = inspectKeycloakSchemaState,
} = {}) {
  const databaseUrl = requiredEnvironment(environment, "DATABASE_URL");
  const catalog = await loadKeycloakObjectCatalog(environment.KEYCLOAK_SCHEMA_CATALOG_PATH ?? KEYCLOAK_CATALOG_PATH);
  const client = await createClient(databaseUrl);
  try {
    if (command === "inspect") {
      return client.begin("isolation level serializable read only deferrable", (sql) => inspectState(sql, catalog));
    }
    if (command === "preflight" || command === "preflight-up" || command === "postflight") {
      const live = await client.begin("isolation level serializable read only", (sql) => inspectState(sql, catalog));
      const bootstrapAllowed = environment.KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED === "true";
      const receiptPath = requiredEnvironment(environment, "KEYCLOAK_SCHEMA_RECEIPT_PATH");
      let receipt = await canonicalArtifactIfExists(
        receiptPath,
        validateInstalledKeycloakSchemaReceipt,
        "Installierter Keycloak-Schema-Receipt",
      );
      if (command === "preflight" && live.state === "bootstrap") {
        invariant(bootstrapAllowed, "Leerer Keycloak-Bootstrap ist nicht explizit freigegeben.");
        invariant(receipt === null, "Leerer Keycloak-Bootstrap verweigert einen bereits installierten oder veralteten Receipt.");
        return Object.freeze({ command, state: live.state, catalogSha256: catalog.catalogSha256 });
      }
      assertLiveMigratedStructure(live, catalog);
      if (command === "postflight" && bootstrapAllowed) {
        invariant(live.targetSchemaComment === KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT, "Bootstrap-Postflight besitzt keinen Init-Hook-Ursprungsmarker.");
        invariant(receipt === null, "Bootstrap-Postflight verweigert einen bereits installierten oder veralteten Receipt.");
        const outputPath = requiredEnvironment(environment, "KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_OUTPUT_PATH");
        invariant(resolve(outputPath) === resolve(receiptPath), "Bootstrap-Receipt-Ausgabe muss exakt dem installierten Receipt-Pfad entsprechen.");
        receipt = createBootstrapReceipt({ live, databaseUrl, catalog, completedAt: now() });
        await writeCreateNew(outputPath, receipt);
      }
      invariant(receipt !== null, "Migriertes Keycloak-Schema besitzt keinen installierten Receipt.");
      if (command === "preflight-up") {
        invariant(
          receipt.schema === KEYCLOAK_SCHEMA_RECEIPT_SCHEMA || receipt.schema === KEYCLOAK_SCHEMA_RECOVER_RECEIPT_SCHEMA,
          "Der V2-Hot-Drill verlangt einen installierten Keycloak-Up- oder Up-Recover-Receipt; ein Fresh-Bootstrap-Receipt ist unzulaessig.",
        );
        invariant(receipt.action === "up", "Der V2-Hot-Drill verlangt einen Keycloak-Up-Receipt.");
      }
      validateReceiptAgainstLive(receipt, live, databaseUrl, catalog);
      return Object.freeze({ command, state: live.state, identityHead: live.identityHead, catalogSha256: catalog.catalogSha256 });
    }

    invariant(environment.KEYCLOAK_SCHEMA_WRITERS_QUIESCED === "true", "KEYCLOAK_SCHEMA_WRITERS_QUIESCED muss exakt 'true' sein.");
    if (command === "bind-backup") {
      const manifestBytes = await regularFileBytes(requiredEnvironment(environment, "KEYCLOAK_SCHEMA_BACKUP_MANIFEST_PATH"), "Keycloak-Migrations-Backup-Manifest");
      const dumpProof = await regularFileProof(requiredEnvironment(environment, "KEYCLOAK_SCHEMA_BACKUP_DUMP_PATH"), "Keycloak-Migrations-Backup-Dump");
      const restoreReceiptBytes = await regularFileBytes(requiredEnvironment(environment, "KEYCLOAK_SCHEMA_RESTORE_RECEIPT_PATH"), "Keycloak-Migrations-Restore-Receipt");
      const restoredDatabaseUrl = requiredEnvironment(environment, "KEYCLOAK_SCHEMA_RESTORED_DATABASE_URL");
      invariant(databaseEndpointSha256(databaseUrl) !== databaseEndpointSha256(restoredDatabaseUrl), "Backup-Bindung erfordert eine getrennte isolierte Restore-Datenbank.");
      const restoredClient = await createClient(restoredDatabaseUrl);
      let snapshot;
      try {
        snapshot = await restoredClient.begin("isolation level serializable read only deferrable", (sql) => inspectState(sql, catalog));
      } finally {
        await restoredClient.end({ timeout: 5 });
      }
      const binding = createBackupBindingFromProof({
        manifestBytes,
        dumpProof,
        restoreReceiptBytes,
        snapshot,
        databaseUrl,
        restoredDatabaseUrl,
        writersQuiesced: true,
      });
      await writeCreateNew(requiredEnvironment(environment, "KEYCLOAK_SCHEMA_BACKUP_BINDING_OUTPUT_PATH"), binding);
      return binding;
    }
    if (command === "plan-up" || command === "plan-down") {
      const snapshot = await client.begin("isolation level serializable read only", (sql) => inspectState(sql, catalog));
      const binding = await canonicalArtifact(requiredEnvironment(environment, "KEYCLOAK_SCHEMA_BACKUP_BINDING_PATH"), validateBackupBinding, "Keycloak-Schema-Backup-Bindung");
      const plan = createMigrationPlan({ action: command === "plan-up" ? "up" : "down", snapshot, backupBinding: binding, databaseUrl, createdAt: now() });
      await writeCreateNew(requiredEnvironment(environment, "KEYCLOAK_SCHEMA_PLAN_OUTPUT_PATH"), plan);
      return plan;
    }
    if (command === "up" || command === "down" || command === "recover") {
      const plan = await canonicalArtifact(requiredEnvironment(environment, "KEYCLOAK_SCHEMA_PLAN_PATH"), validateMigrationPlan, "Keycloak-Schema-Migrationsplan");
      invariant(command === "recover" || plan.action === command, "Keycloak-Schema-Migrationsplan besitzt eine andere Aktion als der CLI-Aufruf.");
      invariant(plan.databaseEndpointSha256 === databaseEndpointSha256(databaseUrl), "Keycloak-Schema-Migrationsplan gehoert zu einem anderen Datenbankendpunkt.");
      const receipt = command === "recover"
        ? await recoverMigrationReceipt(client, plan, catalog, { now })
        : await executeMigration(client, plan, catalog, { now });
      await writeCreateNew(requiredEnvironment(environment, "KEYCLOAK_SCHEMA_RECEIPT_OUTPUT_PATH"), receipt);
      return receipt;
    }
    throw new Error(`Unbekannter Keycloak-Schema-Befehl '${command}'.`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const result = await runKeycloakSchemaCommand(process.argv[2] ?? "");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}
