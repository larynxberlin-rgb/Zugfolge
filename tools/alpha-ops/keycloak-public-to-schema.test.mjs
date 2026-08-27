import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  KEYCLOAK_IDENTITY_HEAD_SCHEMA,
  KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT,
  KEYCLOAK_GAME_RESTORE_SCHEMA,
  KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_SCHEMA,
  KEYCLOAK_SCHEMA_RECOVER_RECEIPT_SCHEMA,
  KEYCLOAK_SCHEMA_RECEIPT_SCHEMA,
  assertCatalogSignature,
  canonicalSha256,
  canonicalJsonBytes,
  createBackupBinding,
  createMigrationPlan,
  executeMigration,
  inspectKeycloakSchemaState,
  keycloakColumnSignature,
  loadKeycloakObjectCatalog,
  postgresCatalogIdentifier,
  recoverMigrationReceipt,
  runKeycloakSchemaCommand,
  validateBootstrapReceipt,
  validateGameDatabaseCatalog,
  validateKeycloakObjectCatalog,
  validateKeycloakLockRows,
  validateKeycloakStateSnapshot,
  validateMigrationPlan,
  validatePublicExtensionContract,
  validateReceiptAgainstLive,
} from "./keycloak-public-to-schema.mjs";
import {
  DATABASE_AUTHORITATIVE_TABLES,
  DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32,
  DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32_SET_SHA256,
  DATABASE_AUTHORITATIVE_TABLES_SCHEMA_33_ADDITIONS,
} from "./database-cutover-schema-contract.mjs";

const DATABASE_URL = "postgresql://operator:secret@postgres:5432/zugfolge";
const RESTORED_DATABASE_URL = "postgresql://operator:secret@postgres:5432/zugfolge_restore_keycloak_schema";
const NOW = "2026-08-25T12:23:00.000Z";

test("Keycloak-26.7-Lockkatalog verlangt exakt DATABASE und KEYCLOAK_BOOT", () => {
  assert.deepEqual(
    validateKeycloakLockRows([{ id: 1, locked: false }, { id: 1000, locked: false }], "public"),
    [{ id: 1, locked: false }, { id: 1000, locked: false }],
  );
  assert.throws(
    () => validateKeycloakLockRows([{ id: 1, locked: false }], "public"),
    /Namespaces 1 und 1000/u,
  );
  assert.throws(
    () => validateKeycloakLockRows([{ id: 1, locked: false }, { id: 1000, locked: true }], "public"),
    /ist aktiv/u,
  );
});

test("OID-Belege bewahren gueltige zitierte PostgreSQL-Katalognamen", () => {
  assert.equal(postgresCatalogIdentifier("UK-Keycloak.Constraint", "OID-Name"), "UK-Keycloak.Constraint");
  assert.throws(() => postgresCatalogIdentifier("", "OID-Name"), /Katalogbezeichner/u);
  assert.throws(() => postgresCatalogIdentifier("x".repeat(64), "OID-Name"), /Katalogbezeichner/u);
  assert.throws(() => postgresCatalogIdentifier("unsafe\u0000name", "OID-Name"), /Katalogbezeichner/u);
});

function identityHead(catalog, { userCount = "1" } = {}) {
  const payload = Object.freeze({
    schema: KEYCLOAK_IDENTITY_HEAD_SCHEMA,
    objectCatalogSha256: catalog.catalogSha256,
    tableCount: 100,
    totalRowCount: userCount === "1" ? "8" : "9",
    realmCount: "1",
    userCount,
    clientCount: "2",
    credentialCount: "1",
    userSessionCount: "1",
    authenticationSessionCount: "1",
    tableStatesSha256: canonicalSha256([{ table: "realm", rowCount: "1" }, { table: "user_entity", rowCount: userCount }]),
  });
  return Object.freeze({ ...payload, stateHash: canonicalSha256(payload) });
}

function stateSnapshot(catalog, state, identity = identityHead(catalog), { targetSchemaComment = null } = {}) {
  const fixtureRelation = catalog.objects.tables[0];
  const objectOids = [
    ...Array.from({ length: 198 }, (_, index) => Object.freeze({ kind: "constraint", relation: fixtureRelation, name: `constraint_${String(index).padStart(3, "0")}`, oid: String(10_000 + index) })),
    ...Array.from({ length: 246 }, (_, index) => Object.freeze({ kind: "index", relation: fixtureRelation, name: `index_${String(index).padStart(3, "0")}`, oid: String(20_000 + index) })),
    ...catalog.objects.tables.map((table, index) => Object.freeze({ kind: "table", relation: table, name: table, oid: String(30_000 + index) })),
  ].sort((left, right) => left.kind.localeCompare(right.kind, "en") || left.relation.localeCompare(right.relation, "en") || left.name.localeCompare(right.name, "en"));
  return Object.freeze({
    schema: "keycloak-public-to-schema-state/v1",
    state,
    gameVariant: "schema-31-to-33",
    databaseMigrationCount: 33,
    sourceSchemaExists: true,
    targetSchemaExists: true,
    targetSchemaComment,
    objectCatalogSha256: catalog.catalogSha256,
    identityHead: identity,
    objectOids,
    objectOidsSha256: canonicalSha256(objectOids),
    activeSignatures: catalog.signatures,
  });
}

function bootstrapSnapshot(catalog) {
  return Object.freeze({
    schema: "keycloak-public-to-schema-state/v1",
    state: "bootstrap",
    gameVariant: "empty-database",
    databaseMigrationCount: 0,
    sourceSchemaExists: true,
    targetSchemaExists: true,
    targetSchemaComment: KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT,
    objectCatalogSha256: catalog.catalogSha256,
    identityHead: null,
    objectOids: [],
    objectOidsSha256: canonicalSha256([]),
    activeSignatures: null,
  });
}

function rehashReceipt(receipt, changes) {
  const { receiptHash: ignored, ...payload } = receipt;
  void ignored;
  const changed = { ...payload, ...changes };
  return { ...changed, receiptHash: canonicalSha256(changed) };
}

function backupBinding(catalog, snapshot) {
  const dumpBytes = Buffer.from("isolated-postgresql-custom-dump", "utf8");
  const manifest = {
    schema: "zugfolge-game-backup/v2",
    createdAt: NOW,
    bytes: dumpBytes.length,
    sha256: createHash("sha256").update(dumpBytes).digest("hex"),
    migrationCount: snapshot.databaseMigrationCount,
    rpoSeconds: 300,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const restoreReceiptBytes = canonicalJsonBytes({
    schema: KEYCLOAK_GAME_RESTORE_SCHEMA,
    database: "zugfolge_restore_keycloak_schema",
    migrationCount: snapshot.databaseMigrationCount,
    dumpSha256: manifest.sha256,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    identical: true,
  });
  return createBackupBinding({
    manifestBytes,
    dumpBytes,
    restoreReceiptBytes,
    snapshot,
    databaseUrl: DATABASE_URL,
    restoredDatabaseUrl: RESTORED_DATABASE_URL,
    writersQuiesced: true,
  });
}

function migrationClient({
  catalog,
  before,
  after,
  afterLock = before,
  events,
  migrationLockAcquired = true,
  lockSchema = "public",
  commitCommand = "COMMIT",
}) {
  let inspections = 0;
  let tablesLocked = false;
  let transactionOpen = false;
  const commandResult = (command) => Object.assign([], { command });
  const sql = {
    async unsafe(statement) {
      const normalized = statement.replace(/\s+/gu, " ").trim().toLowerCase();
      if (normalized.startsWith("set local lock_timeout")) events.push("set-lock-timeout");
      else if (normalized.startsWith("lock table ")) {
        tablesLocked = true;
        events.push("access-exclusive-lock");
        assert.match(normalized, / in access exclusive mode$/u);
        assert.equal(catalog.objects.tables.filter((table) => normalized.includes(`\"${lockSchema}\".\"${table}\"`)).length, 100);
      } else if (normalized.startsWith("select") && !tablesLocked) {
        throw new Error("SERIALIZABLE SELECT occurred before ACCESS EXCLUSIVE");
      } else {
        events.push(`sql:${normalized}`);
      }
      return [];
    },
  };
  const inspectState = async () => {
    events.push("inspect-state");
    inspections += 1;
    if (inspections === 1) return afterLock;
    return after;
  };
  const connection = {
    async unsafe(statement, parameters = []) {
      const normalized = statement.replace(/\s+/gu, " ").trim().toLowerCase();
      if (normalized === "begin isolation level serializable") {
        assert.equal(transactionOpen, false);
        transactionOpen = true;
        tablesLocked = false;
        events.push("transaction-begin");
        return commandResult("BEGIN");
      }
      if (normalized === "commit") {
        assert.equal(transactionOpen, true);
        transactionOpen = false;
        events.push("transaction-commit");
        return commandResult(commitCommand);
      }
      if (normalized === "rollback") {
        transactionOpen = false;
        events.push("transaction-rollback");
        return commandResult("ROLLBACK");
      }
      if (normalized.startsWith("select pg_try_advisory_lock")) {
        assert.equal(transactionOpen, false);
        events.push("session-advisory-lock");
        return [{ locked: migrationLockAcquired }];
      }
      if (normalized.startsWith("select pg_advisory_unlock")) {
        assert.equal(transactionOpen, false);
        events.push("session-advisory-unlock");
        return [{ unlocked: true }];
      }
      if (transactionOpen) return sql.unsafe(statement, parameters);
      throw new Error(`unexpected reserved-session SQL: ${normalized}`);
    },
    release() {
      events.push("session-release");
    },
  };
  return {
    connection,
    inspectState,
    client: {
      async reserve() {
        events.push("session-reserve");
        return connection;
      },
      async begin(options, callback) {
        throw new Error(`unreserved transaction attempted with ${options}: ${String(callback)}`);
      },
    },
  };
}

function catalogCollisionSql(catalog, {
  migrationCount = 28,
  targetRoutine = false,
  targetExtensionRelation = false,
  targetExtensionRoutine = false,
  publicExtensionRoutine = false,
  publicType = false,
} = {}) {
  const publicNames = [
    ...(migrationCount >= 33 ? DATABASE_AUTHORITATIVE_TABLES : DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32),
    ...(migrationCount >= 31 ? ["world_cutover_receipts", "zugfolge_database_identity"] : []),
    ...catalog.objects.tables,
  ].sort();
  const gameRoutines = [
    "zugfolge_enforce_global_admin_audit",
    "zugfolge_enforce_odoo_command_world",
    "zugfolge_enforce_odoo_outbox_world",
    "zugfolge_protect_started_alpha_world_profile",
    ...(migrationCount >= 31 ? [
      "zugfolge_enforce_regional_writer_fence",
      "zugfolge_protect_alpha_world_final_state_hash",
      "zugfolge_reject_immutable_audit_mutation",
    ] : []),
    ...(migrationCount >= 32 ? ["zugfolge_enforce_world_writer_guard"] : []),
    ...(migrationCount >= 33 ? ["zugfolge_capture_operational_command_receipts"] : []),
    ...(migrationCount >= 33 ? ["zugfolge_enforce_operational_initialization_immutability"] : []),
  ].sort();
  return {
    async unsafe(source, parameters = []) {
      const query = source.replace(/\s+/gu, " ").trim().toLowerCase();
      if (query === "show server_version_num") return [{ server_version_num: "160014" }];
      if (query.includes("from pg_namespace where nspname")) return [{ present: true }];
      if (query.includes("obj_description(to_regnamespace")) return [{ comment: null }];
      if (query.includes("to_regclass('drizzle.__drizzle_migrations')")) return [{ present: true }];
      if (query.includes("count(*)::int as count from drizzle.__drizzle_migrations")) return [{ count: migrationCount }];
      if (query.includes("from pg_class as relation") && query.includes("relation.relkind in")) {
        const names = parameters[0] === "public" ? publicNames : targetExtensionRelation ? ["foreign_extension_relation"] : [];
        return names.map((name, index) => ({
          kind: "r",
          name,
          oid: String(20_000 + index),
          partitioned: false,
          persistence: "p",
          partitionKey: null,
          extensionName: parameters[0] === "keycloak" ? "foreign_extension" : null,
        }));
      }
      if (query.includes("from pg_proc as procedure")) {
        if (parameters[0] === "keycloak") {
          if (targetExtensionRoutine) return [{ name: "shadow_extension_writer", arguments: "", extensionName: "foreign_extension" }];
          return targetRoutine ? [{ name: "shadow_keycloak_writer", arguments: "", extensionName: null }] : [];
        }
        return [
          ...gameRoutines.map((name) => ({ name, arguments: "", extensionName: null })),
          ...(publicExtensionRoutine ? [{ name: "shadow_public_extension_writer", arguments: "", extensionName: "foreign_extension" }] : []),
        ];
      }
      if (query.includes("from pg_type as type_row")) {
        return parameters[0] === "public" && publicType ? [{ name: "shadow_identity_kind", kind: "e", extensionName: null }] : [];
      }
      throw new Error(`unexpected SQL fixture query: ${query}`);
    },
  };
}

test("committed PG16 catalog pins the exact Keycloak 26.7.0 object contract", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  assert.equal(validateKeycloakObjectCatalog(catalog), catalog);
  assert.equal(catalog.keycloakVersion, "26.7.0");
  assert.equal(catalog.objects.tables.length, 100);
  assert.deepEqual(catalog.objects.sequences, []);
  assert.deepEqual(catalog.objects.views, []);
  assert.deepEqual(catalog.objects.types, []);
  assert.deepEqual(
    Object.fromEntries(Object.entries(catalog.signatures).map(([name, value]) => [name, value.count])),
    { relations: 100, columns: 614, constraints: 198, indexes: 246, triggers: 0, sequences: 0, views: 0, types: 0 },
  );
  const productionLegacy = { ...stateSnapshot(catalog, "legacy"), gameVariant: "schema-28-to-30", databaseMigrationCount: 28 };
  assert.equal(validateKeycloakStateSnapshot(productionLegacy), productionLegacy);
  assert.throws(
    () => validateKeycloakStateSnapshot({ ...productionLegacy, targetSchemaComment: "forged-bootstrap-origin" }),
    /unbekannten Zielschema-Ursprungsmarker/u,
  );
});

test("Spaltenvertrag neutralisiert nur tombstone-bedingte attnum-Luecken", () => {
  const column = (name, ordinal, type = "character varying(255)") => ({
    name,
    type,
    default: null,
    notNull: false,
    ordinal,
    identity: "",
    relation: "client",
    collation: "default",
    generated: "",
  });
  const productionHistory = [column("id", 1), column("enabled", 2), column("client_id", 3)];
  const freshHistoryWithDroppedSlots = [column("id", 2), column("enabled", 4), column("client_id", 7)];

  assert.deepEqual(keycloakColumnSignature(freshHistoryWithDroppedSlots), keycloakColumnSignature(productionHistory));
  assert.notEqual(
    keycloakColumnSignature([column("enabled", 2), column("id", 4), column("client_id", 7)]).sha256,
    keycloakColumnSignature(productionHistory).sha256,
  );
  assert.notEqual(
    keycloakColumnSignature([column("id", 2), column("enabled", 4, "boolean"), column("client_id", 7)]).sha256,
    keycloakColumnSignature(productionHistory).sha256,
  );
  assert.throws(
    () => keycloakColumnSignature([column("id", 4), column("enabled", 2)]),
    /nicht kanonisch nach physischer Spaltenposition/u,
  );
});

test("index catalog is search-path independent and mismatch diagnostics bind count plus hash", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const inspectorSource = await readFile(new URL("./keycloak-public-to-schema.mjs", import.meta.url), "utf8");
  assert.match(inspectorSource, /pg_get_indexdef\(index_row\.indexrelid, 0, false\) as definition/u);
  assert.doesNotMatch(inspectorSource, /pg_get_indexdef\(index_row\.indexrelid, 0, true\) as definition/u);

  const observed = {
    relationNames: catalog.objects.tables,
    signatures: {
      ...catalog.signatures,
      indexes: { count: 246, sha256: "0".repeat(64) },
    },
  };
  assert.throws(
    () => assertCatalogSignature(observed, catalog, "Keycloak-Schema 'public'"),
    /indexes.*ist count=246, sha256=0{64}; soll count=246, sha256=2524d8c395776aff44096c8918ca912d520be71fd49b3260e49effb6e43fdd6/u,
  );
});

test("Schema-31 bleibt ohne 0033-Ledger kompatibel und Schema-33 bindet Relation plus Capture-Routine", async () => {
  const schema31Relations = [
    ...DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32,
    "world_cutover_receipts",
    "zugfolge_database_identity",
  ].sort();
  const schema31Routines = [
    "zugfolge_enforce_global_admin_audit",
    "zugfolge_enforce_odoo_command_world",
    "zugfolge_enforce_odoo_outbox_world",
    "zugfolge_enforce_regional_writer_fence",
    "zugfolge_protect_alpha_world_final_state_hash",
    "zugfolge_protect_started_alpha_world_profile",
    "zugfolge_reject_immutable_audit_mutation",
  ].sort().map((name) => ({ name, arguments: "" }));
  const schema33Relations = [...DATABASE_AUTHORITATIVE_TABLES, "world_cutover_receipts", "zugfolge_database_identity"].sort();
  const schema33Routines = [
    ...schema31Routines,
    { name: "zugfolge_capture_operational_command_receipts", arguments: "" },
    { name: "zugfolge_enforce_operational_initialization_immutability", arguments: "" },
    { name: "zugfolge_enforce_world_writer_guard", arguments: "" },
  ].sort((left, right) => left.name.localeCompare(right.name, "en"));

  assert.equal(validateGameDatabaseCatalog(schema31Relations, schema31Routines, 31), "schema-31-to-33");
  assert.equal(validateGameDatabaseCatalog(schema33Relations, schema33Routines, 33), "schema-31-to-33");
  assert.equal(DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32.length, 51);
  assert.equal(DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32_SET_SHA256, "9a16cf2644ff1e457b0b77e8f42451d202bee48a2ebcf61e966708fd5dd952b3");
  assert.deepEqual(DATABASE_AUTHORITATIVE_TABLES_SCHEMA_33_ADDITIONS, ["regional_simulation_command_receipts"]);
  assert.deepEqual(
    DATABASE_AUTHORITATIVE_TABLES,
    [...DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32, ...DATABASE_AUTHORITATIVE_TABLES_SCHEMA_33_ADDITIONS].sort((left, right) => left.localeCompare(right, "en")),
  );
  assert.throws(
    () => validateGameDatabaseCatalog(schema31Relations, schema33Routines, 33),
    /Relationssatz|Routinenkatalog/u,
  );
  assert.throws(
    () => validateGameDatabaseCatalog(schema33Relations, schema31Routines, 33),
    /Routinenkatalog/u,
  );
});

test("backup and migration plans reject unquiesced, mismatched, and extended evidence", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const before = stateSnapshot(catalog, "legacy");
  const dumpBytes = Buffer.from("dump", "utf8");
  const manifestBytes = Buffer.from(JSON.stringify({
    schema: "zugfolge-game-backup/v2",
    createdAt: NOW,
    bytes: dumpBytes.length,
    sha256: "0".repeat(64),
    migrationCount: 33,
    rpoSeconds: 300,
  }), "utf8");
  assert.throws(
    () => createBackupBinding({ manifestBytes, dumpBytes, snapshot: before, databaseUrl: DATABASE_URL, writersQuiesced: true }),
    /stimmt nicht bytegenau/u,
  );
  assert.throws(
    () => createBackupBinding({ manifestBytes, dumpBytes, snapshot: before, databaseUrl: DATABASE_URL, writersQuiesced: false }),
    /gestoppte Keycloak-Writer/u,
  );

  const plan = createMigrationPlan({ action: "up", snapshot: before, backupBinding: backupBinding(catalog, before), databaseUrl: DATABASE_URL, createdAt: NOW });
  assert.throws(() => validateMigrationPlan({ ...plan, unexpected: true }), /fremde oder fehlende Felder/u);
  assert.throws(() => validateMigrationPlan({ ...plan, databaseEndpointSha256: "f".repeat(64) }), /kanonischen Hash/u);
});

test("a valid older dump with the same migration count cannot bind a newer live identity", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const restoredFromDump = stateSnapshot(catalog, "legacy", identityHead(catalog, { userCount: "1" }));
  const newerLive = stateSnapshot(catalog, "legacy", identityHead(catalog, { userCount: "2" }));
  const binding = backupBinding(catalog, restoredFromDump);

  assert.throws(
    () => createMigrationPlan({
      action: "up",
      snapshot: newerLive,
      backupBinding: binding,
      databaseUrl: DATABASE_URL,
      createdAt: NOW,
    }),
    /anderen Identitaetskopf/u,
  );
  const restoredMigrated = stateSnapshot(catalog, "migrated", identityHead(catalog, { userCount: "1" }));
  const newerMigrated = stateSnapshot(catalog, "migrated", identityHead(catalog, { userCount: "2" }));
  assert.throws(
    () => createMigrationPlan({
      action: "down",
      snapshot: newerMigrated,
      backupBinding: backupBinding(catalog, restoredMigrated),
      databaseUrl: DATABASE_URL,
      createdAt: NOW,
    }),
    /anderen Identitaetskopf/u,
  );
  const dumpBytes = Buffer.from("older-valid-dump", "utf8");
  const manifestBytes = Buffer.from(JSON.stringify({
    schema: "zugfolge-game-backup/v2",
    createdAt: NOW,
    bytes: dumpBytes.length,
    sha256: createHash("sha256").update(dumpBytes).digest("hex"),
    migrationCount: restoredFromDump.databaseMigrationCount,
    rpoSeconds: 300,
  }), "utf8");
  assert.throws(() => createBackupBinding({
    manifestBytes,
    dumpBytes,
    restoreReceiptBytes: canonicalJsonBytes({
      schema: KEYCLOAK_GAME_RESTORE_SCHEMA,
      database: "zugfolge_restore_keycloak_schema",
      migrationCount: restoredFromDump.databaseMigrationCount,
      dumpSha256: createHash("sha256").update(dumpBytes).digest("hex"),
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      identical: true,
      unexpected: true,
    }),
    snapshot: restoredFromDump,
    databaseUrl: DATABASE_URL,
    restoredDatabaseUrl: RESTORED_DATABASE_URL,
    writersQuiesced: true,
  }), /fremde oder fehlende Felder/u);
});

test("bind-backup derives its identity only from the separately restored dump database", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-keycloak-restore-binding-"));
  const dumpPath = join(directory, "game.dump");
  const manifestPath = join(directory, "game.manifest.json");
  const restoreReceiptPath = join(directory, "restore-receipt.json");
  const bindingPath = join(directory, "backup-binding.json");
  const dumpBytes = Buffer.from("restored-keycloak-snapshot", "utf8");
  const restored = stateSnapshot(catalog, "legacy", identityHead(catalog, { userCount: "1" }));
  const newerLive = stateSnapshot(catalog, "legacy", identityHead(catalog, { userCount: "2" }));
  const manifestBytes = Buffer.from(JSON.stringify({
    schema: "zugfolge-game-backup/v2",
    createdAt: NOW,
    bytes: dumpBytes.length,
    sha256: createHash("sha256").update(dumpBytes).digest("hex"),
    migrationCount: restored.databaseMigrationCount,
    rpoSeconds: 300,
  }), "utf8");
  const restoreReceiptBytes = canonicalJsonBytes({
    schema: KEYCLOAK_GAME_RESTORE_SCHEMA,
    database: "zugfolge_restore_keycloak_schema",
    migrationCount: restored.databaseMigrationCount,
    dumpSha256: createHash("sha256").update(dumpBytes).digest("hex"),
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    identical: true,
  });
  const opened = [];
  const createClient = async (url) => {
    opened.push(url);
    return {
      async begin(options, callback) {
        assert.equal(url, RESTORED_DATABASE_URL);
        assert.equal(options, "isolation level serializable read only deferrable");
        return callback({});
      },
      async end() {},
    };
  };

  try {
    await Promise.all([
      writeFile(dumpPath, dumpBytes),
      writeFile(manifestPath, manifestBytes),
      writeFile(restoreReceiptPath, restoreReceiptBytes),
    ]);
    const binding = await runKeycloakSchemaCommand("bind-backup", {
      environment: {
        DATABASE_URL,
        KEYCLOAK_SCHEMA_WRITERS_QUIESCED: "true",
        KEYCLOAK_SCHEMA_BACKUP_MANIFEST_PATH: manifestPath,
        KEYCLOAK_SCHEMA_BACKUP_DUMP_PATH: dumpPath,
        KEYCLOAK_SCHEMA_RESTORE_RECEIPT_PATH: restoreReceiptPath,
        KEYCLOAK_SCHEMA_RESTORED_DATABASE_URL: RESTORED_DATABASE_URL,
        KEYCLOAK_SCHEMA_BACKUP_BINDING_OUTPUT_PATH: bindingPath,
      },
      createClient,
      inspectState: async () => restored,
    });
    assert.deepEqual(opened, [DATABASE_URL, RESTORED_DATABASE_URL]);
    assert.equal(binding.keycloakIdentityHeadSha256, restored.identityHead.stateHash);
    assert.throws(() => createMigrationPlan({
      action: "up",
      snapshot: newerLive,
      backupBinding: binding,
      databaseUrl: DATABASE_URL,
      createdAt: NOW,
    }), /anderen Identitaetskopf/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state detection blocks non-relation target collisions and unknown public types", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  await assert.rejects(
    inspectKeycloakSchemaState(catalogCollisionSql(catalog, { targetRoutine: true }), catalog),
    /fremde Routinen/u,
  );
  await assert.rejects(
    inspectKeycloakSchemaState(catalogCollisionSql(catalog, { publicType: true }), catalog),
    /unbekannte Enums oder Domains/u,
  );
  await assert.rejects(
    inspectKeycloakSchemaState(catalogCollisionSql(catalog, { targetExtensionRelation: true }), catalog),
    /fremde Relationen/u,
  );
  await assert.rejects(
    inspectKeycloakSchemaState(catalogCollisionSql(catalog, { targetExtensionRoutine: true }), catalog),
    /fremde Routinen/u,
  );
  await assert.rejects(
    inspectKeycloakSchemaState(catalogCollisionSql(catalog, { publicExtensionRoutine: true }), catalog),
    /unbekannten Extension/u,
  );
});

test("public extension gate accepts only plain PG16 or the exact PostGIS relation footprint", () => {
  const postgisRelations = [
    { kind: "v", name: "geography_columns", extensionName: "postgis" },
    { kind: "v", name: "geometry_columns", extensionName: "postgis" },
    { kind: "r", name: "spatial_ref_sys", extensionName: "postgis" },
  ];
  const postgisRoutines = [{ name: "postgis_version", arguments: "", extensionName: "postgis" }];
  assert.equal(validatePublicExtensionContract([], []).variant, "plain-pg16");
  assert.equal(validatePublicExtensionContract(postgisRelations, postgisRoutines).variant, "postgis-3.4-production-footprint");
  assert.throws(
    () => validatePublicExtensionContract(postgisRelations.slice(1), postgisRoutines),
    /nicht exakt/u,
  );
  assert.throws(
    () => validatePublicExtensionContract(postgisRelations, [{ ...postgisRoutines[0], extensionName: "foreign_extension" }]),
    /unbekannten Extension/u,
  );
});

test("Migration nutzt einen realistischen postgres.js-ReservedSql ohne begin und sperrt vor dem ersten Read", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const before = stateSnapshot(catalog, "legacy");
  const after = stateSnapshot(catalog, "migrated", before.identityHead);
  const plan = createMigrationPlan({ action: "up", snapshot: before, backupBinding: backupBinding(catalog, before), databaseUrl: DATABASE_URL, createdAt: NOW });
  const events = [];
  const fixture = migrationClient({ catalog, before, after, events });
  const receipt = await executeMigration(fixture.client, plan, catalog, {
    now: () => "2026-08-25T12:24:00.000Z",
    inspectState: fixture.inspectState,
    verifyLiquibaseUnlocked: async () => events.push("liquibase-read"),
    moveTables: async () => events.push("alter-set-schema"),
  });

  assert.equal(typeof fixture.connection.begin, "undefined");
  assert.equal(receipt.schema, KEYCLOAK_SCHEMA_RECEIPT_SCHEMA);
  assert.deepEqual(events, [
    "session-reserve",
    "session-advisory-lock",
    "transaction-begin",
    "set-lock-timeout",
    "access-exclusive-lock",
    "inspect-state",
    "liquibase-read",
    "alter-set-schema",
    'sql:comment on schema "keycloak" is null',
    "inspect-state",
    "transaction-commit",
    "inspect-state",
    "session-advisory-unlock",
    "session-release",
  ]);
});

test("a writer committed while the migration waited for ACCESS EXCLUSIVE invalidates the plan before ALTER", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const before = stateSnapshot(catalog, "legacy");
  const after = stateSnapshot(catalog, "migrated", before.identityHead);
  const writerCommitted = stateSnapshot(catalog, "legacy", identityHead(catalog, { userCount: "2" }));
  const plan = createMigrationPlan({ action: "up", snapshot: before, backupBinding: backupBinding(catalog, before), databaseUrl: DATABASE_URL, createdAt: NOW });
  const events = [];
  const fixture = migrationClient({ catalog, before, after, afterLock: writerCommitted, events });

  await assert.rejects(
    executeMigration(fixture.client, plan, catalog, {
      inspectState: fixture.inspectState,
      verifyLiquibaseUnlocked: async () => events.push("liquibase-read"),
      moveTables: async () => events.push("alter-set-schema"),
    }),
    /stimmt nicht mehr/u,
  );
  assert.deepEqual(events, [
    "session-reserve",
    "session-advisory-lock",
    "transaction-begin",
    "set-lock-timeout",
    "access-exclusive-lock",
    "inspect-state",
    "transaction-rollback",
    "session-advisory-unlock",
    "session-release",
  ]);

  const markerEvents = [];
  const markerAfter = stateSnapshot(catalog, "migrated", before.identityHead, {
    targetSchemaComment: KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT,
  });
  const markerFixture = migrationClient({
    catalog,
    before,
    after: markerAfter,
    afterLock: markerAfter,
    events: markerEvents,
    lockSchema: "keycloak",
  });
  await assert.rejects(
    recoverMigrationReceipt(markerFixture.client, plan, catalog, {
      inspectState: markerFixture.inspectState,
    }),
    /keinen Fresh-Bootstrap-Ursprungsmarker/u,
  );
});

test("a concurrent migration lock fails closed before opening the serializable transaction", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const before = stateSnapshot(catalog, "legacy");
  const after = stateSnapshot(catalog, "migrated", before.identityHead);
  const plan = createMigrationPlan({ action: "up", snapshot: before, backupBinding: backupBinding(catalog, before), databaseUrl: DATABASE_URL, createdAt: NOW });
  const events = [];
  const fixture = migrationClient({ catalog, before, after, events, migrationLockAcquired: false });

  await assert.rejects(
    executeMigration(fixture.client, plan, catalog, { inspectState: fixture.inspectState }),
    /haelt bereits den Migrationslock/u,
  );
  assert.deepEqual(events, ["session-reserve", "session-advisory-lock", "session-release"]);
});

test("migration refuses a pool that cannot pin advisory lock and transaction to one session", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const before = stateSnapshot(catalog, "legacy");
  const plan = createMigrationPlan({ action: "up", snapshot: before, backupBinding: backupBinding(catalog, before), databaseUrl: DATABASE_URL, createdAt: NOW });
  await assert.rejects(
    executeMigration({ begin: async () => {} }, plan, catalog),
    /reservierbare PostgreSQL-Verbindung/u,
  );
});

test("Migration verweigert den Receipt, wenn PostgreSQL kein COMMIT auf der reservierten Sitzung bestaetigt", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const before = stateSnapshot(catalog, "legacy");
  const after = stateSnapshot(catalog, "migrated", before.identityHead);
  const plan = createMigrationPlan({ action: "up", snapshot: before, backupBinding: backupBinding(catalog, before), databaseUrl: DATABASE_URL, createdAt: NOW });
  const events = [];
  const fixture = migrationClient({ catalog, before, after, events, commitCommand: "ROLLBACK" });

  await assert.rejects(
    executeMigration(fixture.client, plan, catalog, {
      inspectState: fixture.inspectState,
      verifyLiquibaseUnlocked: async () => {},
      moveTables: async () => {},
    }),
    /nicht committed/u,
  );
  assert.deepEqual(events.slice(-4), [
    "transaction-commit",
    "transaction-rollback",
    "session-advisory-unlock",
    "session-release",
  ]);
});

test("recover reserves the session lock and locks all committed target tables before reading", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const before = stateSnapshot(catalog, "legacy");
  const after = stateSnapshot(catalog, "migrated", before.identityHead);
  const plan = createMigrationPlan({ action: "up", snapshot: before, backupBinding: backupBinding(catalog, before), databaseUrl: DATABASE_URL, createdAt: NOW });
  const events = [];
  const fixture = migrationClient({ catalog, before, after, afterLock: after, events, lockSchema: "keycloak" });

  const receipt = await recoverMigrationReceipt(fixture.client, plan, catalog, {
    now: () => "2026-08-25T12:26:00.000Z",
    inspectState: fixture.inspectState,
  });
  assert.equal(receipt.schema, KEYCLOAK_SCHEMA_RECOVER_RECEIPT_SCHEMA);
  assert.deepEqual(events, [
    "session-reserve",
    "session-advisory-lock",
    "transaction-begin",
    "set-lock-timeout",
    "access-exclusive-lock",
    "inspect-state",
    "transaction-commit",
    "session-advisory-unlock",
    "session-release",
  ]);
});

test("normal startup accepts mutable Keycloak rows but rejects endpoint, catalog, and down receipts", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const before = stateSnapshot(catalog, "legacy");
  const after = stateSnapshot(catalog, "migrated", before.identityHead);
  const plan = createMigrationPlan({ action: "up", snapshot: before, backupBinding: backupBinding(catalog, before), databaseUrl: DATABASE_URL, createdAt: NOW });
  const fixture = migrationClient({ catalog, before, after, events: [] });
  const receipt = await executeMigration(fixture.client, plan, catalog, {
    now: () => "2026-08-25T12:24:00.000Z",
    inspectState: fixture.inspectState,
    verifyLiquibaseUnlocked: async () => {},
    moveTables: async () => {},
  });
  const laterLive = stateSnapshot(catalog, "migrated", identityHead(catalog, { userCount: "2" }));

  assert.equal(validateReceiptAgainstLive(receipt, laterLive, DATABASE_URL, catalog), receipt);
  assert.throws(
    () => validateReceiptAgainstLive(receipt, laterLive, "postgresql://operator:secret@other-postgres:5432/zugfolge", catalog),
    /anderen Datenbankendpunkt/u,
  );
  assert.throws(
    () => validateReceiptAgainstLive(rehashReceipt(receipt, { objectCatalogSha256: "f".repeat(64) }), laterLive, DATABASE_URL, catalog),
    /anderen Objektkatalog|verschiedene Objektkataloge/u,
  );
  assert.throws(
    () => validateReceiptAgainstLive(rehashReceipt(receipt, { action: "down" }), laterLive, DATABASE_URL, catalog),
    /keinen Down-Receipt/u,
  );

  const directory = await mkdtemp(join(tmpdir(), "zugfolge-keycloak-up-preflight-"));
  const receiptPath = join(directory, "receipt.json");
  const createClient = async () => ({
    async begin(_options, callback) {
      return callback({});
    },
    async end() {},
  });
  try {
    await writeFile(receiptPath, canonicalJsonBytes(receipt));
    const verified = await runKeycloakSchemaCommand("preflight-up", {
      environment: {
        DATABASE_URL,
        KEYCLOAK_SCHEMA_RECEIPT_PATH: receiptPath,
      },
      createClient,
      inspectState: async () => laterLive,
    });
    assert.equal(verified.command, "preflight-up");
    assert.equal(verified.state, "migrated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh bootstrap writes one exact receipt and later starts without the bootstrap flag", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-keycloak-bootstrap-"));
  const receiptPath = join(directory, "receipt.json");
  let live = bootstrapSnapshot(catalog);
  const createClient = async () => ({
    async begin(_options, callback) {
      return callback({});
    },
    async end() {},
  });
  const environment = {
    DATABASE_URL,
    KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED: "true",
    KEYCLOAK_SCHEMA_RECEIPT_PATH: receiptPath,
    KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_OUTPUT_PATH: receiptPath,
  };

  try {
    const preflight = await runKeycloakSchemaCommand("preflight", {
      environment,
      createClient,
      inspectState: async () => live,
    });
    assert.equal(preflight.state, "bootstrap");

    live = stateSnapshot(catalog, "migrated", identityHead(catalog), { targetSchemaComment: KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT });
    await runKeycloakSchemaCommand("postflight", {
      environment,
      now: () => "2026-08-25T12:25:00.000Z",
      createClient,
      inspectState: async () => live,
    });
    const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(persisted.schema, KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_SCHEMA);
    assert.equal(validateBootstrapReceipt(persisted), persisted);

    live = stateSnapshot(catalog, "migrated", identityHead(catalog, { userCount: "2" }), { targetSchemaComment: KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT });
    const nextPreflight = await runKeycloakSchemaCommand("preflight", {
      environment: { ...environment, KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED: "false" },
      createClient,
      inspectState: async () => live,
    });
    assert.equal(nextPreflight.state, "migrated");
    await assert.rejects(
      runKeycloakSchemaCommand("preflight-up", {
        environment: { ...environment, KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED: "false" },
        createClient,
        inspectState: async () => live,
      }),
      /Fresh-Bootstrap-Receipt ist unzulaessig/u,
    );

    live = stateSnapshot(catalog, "migrated", identityHead(catalog, { userCount: "2" }));
    await assert.rejects(
      runKeycloakSchemaCommand("preflight", {
        environment: { ...environment, KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED: "false" },
        createClient,
        inspectState: async () => live,
      }),
      /ohne den expliziten Init-Hook-Ursprungsmarker veraltet/u,
    );

    live = stateSnapshot(catalog, "migrated", identityHead(catalog, { userCount: "2" }), { targetSchemaComment: KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT });
    await assert.rejects(
      runKeycloakSchemaCommand("postflight", {
        environment,
        createClient,
        inspectState: async () => live,
      }),
      /bereits installierten oder veralteten Receipt/u,
    );

    live = bootstrapSnapshot(catalog);
    await assert.rejects(
      runKeycloakSchemaCommand("preflight", {
        environment,
        createClient,
        inspectState: async () => live,
      }),
      /bereits installierten oder veralteten Receipt/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an up migration consumes the init-hook origin and cannot mint a fresh-bootstrap receipt", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-keycloak-up-origin-"));
  const receiptPath = join(directory, "receipt.json");
  const before = stateSnapshot(catalog, "legacy", identityHead(catalog), {
    targetSchemaComment: KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT,
  });
  const after = stateSnapshot(catalog, "migrated", before.identityHead);
  const plan = createMigrationPlan({
    action: "up",
    snapshot: before,
    backupBinding: backupBinding(catalog, before),
    databaseUrl: DATABASE_URL,
    createdAt: NOW,
  });
  const events = [];
  const fixture = migrationClient({ catalog, before, after, events });

  try {
    await executeMigration(fixture.client, plan, catalog, {
      inspectState: fixture.inspectState,
      verifyLiquibaseUnlocked: async () => {},
      moveTables: async () => {},
    });
    assert.equal(events.includes('sql:comment on schema "keycloak" is null'), true);

    const createClient = async () => ({
      async begin(_options, callback) {
        return callback({});
      },
      async end() {},
    });
    await assert.rejects(
      runKeycloakSchemaCommand("postflight", {
        environment: {
          DATABASE_URL,
          KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED: "true",
          KEYCLOAK_SCHEMA_RECEIPT_PATH: receiptPath,
          KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_OUTPUT_PATH: receiptPath,
        },
        createClient,
        inspectState: async () => after,
      }),
      /keinen Init-Hook-Ursprungsmarker/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap receipt rejects extra keys and a manipulated canonical hash", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-keycloak-bootstrap-negative-"));
  const receiptPath = join(directory, "receipt.json");
  let live = stateSnapshot(catalog, "migrated");
  const createClient = async () => ({
    async begin(_options, callback) {
      return callback({});
    },
    async end() {},
  });
  try {
    const environment = {
      DATABASE_URL,
      KEYCLOAK_SCHEMA_BOOTSTRAP_ALLOWED: "true",
      KEYCLOAK_SCHEMA_RECEIPT_PATH: receiptPath,
      KEYCLOAK_SCHEMA_BOOTSTRAP_RECEIPT_OUTPUT_PATH: receiptPath,
    };
    await assert.rejects(runKeycloakSchemaCommand("postflight", {
      environment,
      now: () => "2026-08-25T12:25:00.000Z",
      createClient,
      inspectState: async () => live,
    }), /keinen Init-Hook-Ursprungsmarker/u);

    live = bootstrapSnapshot(catalog);
    await runKeycloakSchemaCommand("preflight", {
      environment,
      createClient,
      inspectState: async () => live,
    });
    live = stateSnapshot(catalog, "migrated", identityHead(catalog), { targetSchemaComment: KEYCLOAK_BOOTSTRAP_SCHEMA_COMMENT });
    await runKeycloakSchemaCommand("postflight", {
      environment: {
        ...environment,
      },
      now: () => "2026-08-25T12:25:00.000Z",
      createClient,
      inspectState: async () => live,
    });
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.throws(() => validateBootstrapReceipt({ ...receipt, unexpected: true }), /fremde oder fehlende Felder/u);
    assert.throws(() => validateBootstrapReceipt({ ...receipt, receiptHash: "0".repeat(64) }), /kanonischen Hash/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
