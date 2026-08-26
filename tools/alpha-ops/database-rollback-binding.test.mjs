import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDatabaseRollbackProof } from "../tiles/map-release-build-evidence.mjs";
import {
  assertDatabaseRollbackProofMatchesLive,
  inspectMigratedKeycloakState,
  inspectLiveDatabaseRollbackSnapshot as inspectSnapshotWithoutKeycloakFixture,
  validateStoredWorldCutoverReceipt,
  worldCutoverReceiptHash,
  worldFinalHistorySeal,
} from "./database-rollback-binding.mjs";
import {
  DATABASE_AUTHORITATIVE_TABLES,
  DATABASE_CUTOVER_CONSTRAINTS,
  DATABASE_CUTOVER_GUARDS,
  DATABASE_WORLD_WRITER_GUARD_MIGRATION_LOCK_SQL,
  DATABASE_WORLD_WRITER_GUARDS,
  DATABASE_WORLD_HISTORY_BINDINGS,
  normalizeDatabaseDefinition,
} from "./database-cutover-schema-contract.mjs";
import {
  databaseRollbackEvidenceFixtures,
  keycloakIdentityHeadFixture,
  keycloakStateInspectorFixture,
} from "./database-rollback-test-fixtures.mjs";

const DATABASE_A = "00000000-0000-4000-8000-000000000031";
const DATABASE_B = "00000000-0000-4000-8000-000000000032";

test("Schema 32 sperrt Outbox- und Lifecycle-DML vor seinem ersten Altzustands-Snapshot", async () => {
  const migration = normalizeDatabaseDefinition(await readFile(
    new URL("../../packages/db/drizzle/0032_world_writer_guard.sql", import.meta.url),
    "utf8",
  ));
  const lockIndex = migration.indexOf(`${DATABASE_WORLD_WRITER_GUARD_MIGRATION_LOCK_SQL};`);
  const oldStateCheckIndex = migration.indexOf("DO $$ BEGIN IF EXISTS ( SELECT 1 FROM economy_outbox");

  assert.notEqual(lockIndex, -1, "Schema 32 muss den eingecheckten Migrations-Lock exakt enthalten");
  assert.notEqual(oldStateCheckIndex, -1, "Schema 32 muss den archivierten Outbox-Altzustand pruefen");
  assert.equal(lockIndex, 0, "Der Migrations-Lock muss die erste Schema-32-Anweisung sein");
  assert.ok(lockIndex < oldStateCheckIndex, "Der Migrations-Lock muss vor dem ersten Altzustands-Snapshot liegen");
});

function inspectLiveDatabaseRollbackSnapshot(sql, identityHead = keycloakIdentityHeadFixture()) {
  return inspectSnapshotWithoutKeycloakFixture(sql, { inspectKeycloakState: keycloakStateInspectorFixture(identityHead) });
}

function sqlFixture(databaseIdentity = DATABASE_A, domainRowsSha256 = "d".repeat(64), {
  changedConstraint,
  changedGuard,
  extraAuthoritativeTable,
} = {}) {
  return {
    async unsafe(source) {
      const query = source.replace(/\s+/gu, " ").trim().toLowerCase();
      if (query.includes("from zugfolge_database_identity")) return [{ database_id: databaseIdentity }];
      if (query.includes("from drizzle.__drizzle_migrations")) {
        return Array.from({ length: 33 }, (_, index) => index + 1).map((id) => ({
          id,
          hash: id.toString(16).padStart(64, "0"),
          created_at: String(1_787_000_000_000 + id),
        }));
      }
      if (query.includes("from pg_constraint")) {
        return DATABASE_CUTOVER_CONSTRAINTS.map((entry) => ({
          name: entry.name,
          relation_name: entry.relation,
          constraint_type: entry.type,
          definition: entry.name === changedConstraint ? "CHECK (true)" : entry.definition,
          validated: true,
        }));
      }
      if (query.includes("from pg_trigger")) {
        return DATABASE_CUTOVER_GUARDS.map((entry) => ({
          name: entry.name,
          relation_name: entry.relation,
          trigger_type: entry.type,
          tgenabled: "O",
          function_name: entry.functionName,
          trigger_definition: entry.triggerDefinition,
          function_source: entry.name === changedGuard ? "BEGIN RETURN NEW; END;" : entry.functionSource,
        }));
      }
      if (query.includes("select relation.relname as table_name")) {
        return [
          ...DATABASE_AUTHORITATIVE_TABLES,
          ...(extraAuthoritativeTable === undefined ? [] : [extraAuthoritativeTable]),
        ].sort().map((table_name) => ({ table_name }));
      }
      const tableMatch = /from "public"\."(?<table>[a-z0-9_]+)" as source_row/u.exec(query);
      if (tableMatch !== null) {
        const table = tableMatch.groups.table;
        if (table === "domain_events") return [{ row_count: "2", rows_sha256: domainRowsSha256 }];
        if (table === "regional_simulation_states") return [{ row_count: "1", rows_sha256: "b".repeat(64) }];
        if (table === "worlds") return [{ row_count: "1", rows_sha256: "a".repeat(64) }];
        return [{ row_count: "0", rows_sha256: "0".repeat(64) }];
      }
      if (query.includes("count(*)::int as total")) {
        return [{ total: 1, v2: 0, non_null_initialization_hash: 0, incompatible: 0 }];
      }
      throw new Error(`Unerwartete SQL-Abfrage: ${query}`);
    },
  };
}

function proof(source) {
  const evidence = databaseRollbackEvidenceFixtures(source);
  return createDatabaseRollbackProof({
    releaseId: "infra-deutschland-2026.4",
    previousReleaseId: "infra-deutschland-2026.2",
    source,
    ...evidence,
    writersQuiesced: true,
    rollbackWindow: "pre-activation-only",
  });
}

test("Keycloak-Rollback-Snapshot laedt den im Runtime-Image gemounteten Katalogpfad", async () => {
  const sql = Object.freeze({ connection: "fixture" });
  const catalog = Object.freeze({ catalog: "fixture" });
  const identityHead = keycloakIdentityHeadFixture();

  const state = await inspectMigratedKeycloakState(sql, {
    environment: { KEYCLOAK_SCHEMA_CATALOG_PATH: "/keycloak-schema-catalog.json" },
    loadCatalog: async (path) => {
      assert.equal(path, "/keycloak-schema-catalog.json");
      return catalog;
    },
    inspectState: async (connection, loadedCatalog) => {
      assert.equal(connection, sql);
      assert.equal(loadedCatalog, catalog);
      return Object.freeze({ state: "migrated", identityHead });
    },
  });

  assert.equal(state.identityHead, identityHead);
});

test("gesperrter Live-Kopf stimmt nur mit exakt derselben persistenten DB-Instanz ueberein", async () => {
  const source = await inspectLiveDatabaseRollbackSnapshot(sqlFixture(DATABASE_A));
  const rollbackProof = proof(source);
  assert.equal(assertDatabaseRollbackProofMatchesLive(rollbackProof, source), rollbackProof);
  assert.equal(source.authoritativeHead.domainEventCount, "2");
  assert.equal(source.authoritativeHead.regionalStateCount, 1);
  assert.equal(source.migrationLedger.length, 33);
  assert.equal(source.keycloakIdentityHead.stateHash, keycloakIdentityHeadFixture().stateHash);
  assert.equal(source.guards.length, 58);
  assert.equal(source.guards.some(({ name }) => name === "odoo_projection_outbox_world_guard"), true);
  assert.equal(source.guards.some(({ name }) => name === "zugfolge_capture_operational_command_receipts"), true);
  assert.equal(source.guards.some(({ name }) => name === "zugfolge_enforce_operational_initialization_immutability"), true);
  assert.equal(DATABASE_WORLD_WRITER_GUARDS.length, 50);

  const structurallyIdenticalDatabaseB = structuredClone(source);
  structurallyIdenticalDatabaseB.databaseIdentity = DATABASE_B;
  assert.throws(
    () => assertDatabaseRollbackProofMatchesLive(rollbackProof, structurallyIdenticalDatabaseB),
    /anderen persistenten Datenbankinstanz/u,
  );
});

test("gesperrter Live-Vergleich verweigert auch einen abweichenden Event-/Runtime-Kopf", async () => {
  const source = await inspectLiveDatabaseRollbackSnapshot(sqlFixture(DATABASE_A));
  const rollbackProof = proof(source);
  const advanced = structuredClone(source);
  advanced.authoritativeHead.stateHash = "e".repeat(64);
  assert.throws(
    () => assertDatabaseRollbackProofMatchesLive(rollbackProof, advanced),
    /autoritativen Live-Kopf/u,
  );
});

test("Rollback-Proof v3 verweigert einen abweichenden Keycloak-Identitaetskopf", async () => {
  const source = await inspectLiveDatabaseRollbackSnapshot(sqlFixture(DATABASE_A));
  const rollbackProof = proof(source);
  const changedKeycloak = keycloakIdentityHeadFixture({ userCount: "2", totalRowCount: "9" });
  const live = await inspectLiveDatabaseRollbackSnapshot(sqlFixture(DATABASE_A), changedKeycloak);
  assert.throws(
    () => assertDatabaseRollbackProofMatchesLive(rollbackProof, live),
    /autoritativen Live-Kopf/u,
  );
});

test("jede innere Domain-Event-Aenderung aendert den Kopf auch bei gleichem Count und letztem Event", async () => {
  const before = await inspectLiveDatabaseRollbackSnapshot(sqlFixture(DATABASE_A, "d".repeat(64)));
  const corruptedMiddleEvent = await inspectLiveDatabaseRollbackSnapshot(sqlFixture(DATABASE_A, "e".repeat(64)));
  assert.equal(before.authoritativeHead.domainEventCount, corruptedMiddleEvent.authoritativeHead.domainEventCount);
  assert.notEqual(before.authoritativeHead.stateHash, corruptedMiddleEvent.authoritativeHead.stateHash);
});

test("gleichnamiger CHECK und gleichnamiger aktivierter Trigger muessen dem eingecheckten Sollvertrag entsprechen", async () => {
  await assert.rejects(
    inspectLiveDatabaseRollbackSnapshot(sqlFixture(DATABASE_A, "d".repeat(64), {
      changedConstraint: "regional_simulation_states_legacy_writer_fence_shape",
    })),
    /Constraint.*Sollvertrag/u,
  );
  await assert.rejects(
    inspectLiveDatabaseRollbackSnapshot(sqlFixture(DATABASE_A, "d".repeat(64), {
      changedGuard: "zugfolge_world_guard_accounts",
    })),
    /Funktionskoerper.*Sollvertrag/u,
  );
});

test("autoritativer Tabellensatz ist unabhaengig vom Regionalzustand exakt an Schema 33 gepinnt", async () => {
  await assert.rejects(
    inspectLiveDatabaseRollbackSnapshot(sqlFixture(DATABASE_A, "d".repeat(64), {
      extraAuthoritativeTable: "shadow_game_state",
    })),
    /Tabellenkatalog.*Schema-33-Sollvertrag/u,
  );
});

test("preseeded Retry-Receipt wird aus allen gespeicherten Spalten rekonstruiert und fail-closed geprueft", () => {
  const payload = {
    schema: "zugfolge-world-cutover-receipt/v1",
    databaseIdentity: DATABASE_A,
    mode: "authorized-v1-to-v2-cutover",
    predecessorWorldId: "00000000-0000-4000-8000-000000000014",
    predecessorDeploymentHash: "a".repeat(64),
    predecessorFinalStateHash: "b".repeat(64),
    candidateWorldId: "00000000-0000-4000-8000-000000000315",
    candidateDeploymentHash: "c".repeat(64),
    beforeAuthoritativeHeadSha256: "d".repeat(64),
    afterAuthoritativeHeadSha256: "e".repeat(64),
  };
  const row = {
    database_id: payload.databaseIdentity,
    mode: payload.mode,
    predecessor_world_id: payload.predecessorWorldId,
    predecessor_deployment_hash: payload.predecessorDeploymentHash,
    predecessor_final_state_hash: payload.predecessorFinalStateHash,
    candidate_world_id: payload.candidateWorldId,
    candidate_deployment_hash: payload.candidateDeploymentHash,
    before_authoritative_head_sha256: payload.beforeAuthoritativeHeadSha256,
    after_authoritative_head_sha256: payload.afterAuthoritativeHeadSha256,
    receipt_hash: worldCutoverReceiptHash(payload),
  };
  assert.equal(validateStoredWorldCutoverReceipt(row).receiptHash, row.receipt_hash);
  assert.throws(
    () => validateStoredWorldCutoverReceipt({ ...row, receipt_hash: "f".repeat(64) }),
    /rekonstruierten kanonischen Hash/u,
  );
  assert.throws(
    () => validateStoredWorldCutoverReceipt({ ...row, before_authoritative_head_sha256: "0".repeat(64) }),
    /rekonstruierten kanonischen Hash/u,
  );
});

function worldSealSql(changedTable) {
  return {
    async unsafe(source) {
      const query = source.replace(/\s+/gu, " ").trim().toLowerCase();
      if (query.includes("from information_schema.columns as columns")) {
        return DATABASE_WORLD_HISTORY_BINDINGS
          .flatMap(({ table, columns }) => columns.map((column) => ({ table_name: table, column_name: column })))
          .sort((left, right) => left.table_name.localeCompare(right.table_name, "en") || left.column_name.localeCompare(right.column_name, "en"));
      }
      const tableMatch = /from "public"\."(?<table>[a-z0-9_]+)" as source_row/u.exec(query);
      if (tableMatch !== null) {
        const table = tableMatch.groups.table;
        return [{
          row_count: table === "worlds" ? "1" : "0",
          rows_sha256: table === changedTable ? "f".repeat(64) : "0".repeat(64),
        }];
      }
      throw new Error(`Unerwartete Seal-SQL-Abfrage: ${query}`);
    },
  };
}

test("finale Vorgaengerhistorie bindet Konten, Ledger, Fahrzeuge, Planung und Fleet schema-vollstaendig", async () => {
  const worldId = "00000000-0000-4000-8000-000000000014";
  const baseline = await worldFinalHistorySeal(worldSealSql(), worldId);
  for (const { table } of DATABASE_WORLD_HISTORY_BINDINGS.filter(({ table }) => table !== "worlds")) {
    assert.notEqual(
      await worldFinalHistorySeal(worldSealSql(table), worldId),
      baseline,
      `${table} muss die finale Vorgaengerhistorie beeinflussen`,
    );
  }
});

test("Command-Receipt-Ledger ist weltgebunden, writer-geschuetzt und Teil des finalen Historienhashes", async () => {
  const binding = DATABASE_WORLD_HISTORY_BINDINGS.find(({ table }) => table === "regional_simulation_command_receipts");
  assert.deepEqual(binding, { table: "regional_simulation_command_receipts", columns: ["world_id"] });
  assert.equal(
    DATABASE_WORLD_WRITER_GUARDS.some(({ name }) => name === "zugfolge_world_guard_regional_simulation_command_receipts"),
    true,
  );
  const worldId = "00000000-0000-4000-8000-000000000014";
  assert.notEqual(
    await worldFinalHistorySeal(worldSealSql("regional_simulation_command_receipts"), worldId),
    await worldFinalHistorySeal(worldSealSql(), worldId),
  );
});

test("Welt-Historienseal verweigert einen nicht eingecheckten world_id-Schemavertrag", async () => {
  const sql = worldSealSql();
  const originalUnsafe = sql.unsafe.bind(sql);
  sql.unsafe = async (source, parameters) => {
    if (source.includes("information_schema.columns")) {
      return [...await originalUnsafe(source, parameters), { table_name: "vehicle_assets", column_name: "foreign_world_id" }];
    }
    return originalUnsafe(source, parameters);
  };
  await assert.rejects(
    worldFinalHistorySeal(sql, "00000000-0000-4000-8000-000000000014"),
    /Welt-Historienvertrag.*Schema-33-Sollvertrag/u,
  );
});
