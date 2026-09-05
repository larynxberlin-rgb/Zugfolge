import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";

import {
  inspectLiveDatabaseRollbackSnapshot as inspectSnapshotWithoutKeycloakFixture,
  worldFinalHistorySeal,
} from "./database-rollback-binding.mjs";
import { keycloakStateInspectorFixture } from "./database-rollback-test-fixtures.mjs";
import { databaseRollbackEvidenceFixtures } from "./database-rollback-test-fixtures.mjs";
import { createDatabaseRollbackProof, validateDatabaseRollbackProof } from "../tiles/map-release-build-evidence.mjs";

const sourceMigrationsFolder = resolve(import.meta.dirname, "../../packages/db/drizzle");
// Diese Suite attestiert den unveraenderlichen historischen Schema-33-Vertrag.
// Spaetere Vorwaertsmigrationen werden separat gegen ihren eigenen Vertrag geprueft.
let migrationsFolder;
before(async () => { migrationsFolder = await migrationsThrough(33); });
after(async () => { if (migrationsFolder !== undefined) await rm(migrationsFolder, { recursive: true, force: true }); });
const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { PGlite } = await import(pathToFileURL(requireFromDb.resolve("@electric-sql/pglite")).href);
const { drizzle } = await import(pathToFileURL(requireFromDb.resolve("drizzle-orm/pglite")).href);
const { migrate } = await import(pathToFileURL(requireFromDb.resolve("drizzle-orm/pglite/migrator")).href);

function adapter(client) {
  return {
    async unsafe(source, parameters = []) {
      return (await client.query(source, parameters)).rows;
    },
  };
}

function inspectLiveDatabaseRollbackSnapshot(sql) {
  return inspectSnapshotWithoutKeycloakFixture(sql, { inspectKeycloakState: keycloakStateInspectorFixture() });
}

async function migrationsThrough(count) {
  const folder = await mkdtemp(join(tmpdir(), `zugfolge-migrations-${count}-`));
  const meta = join(folder, "meta");
  await mkdir(meta);
  const journal = JSON.parse(await readFile(join(sourceMigrationsFolder, "meta", "_journal.json"), "utf8"));
  const entries = journal.entries.slice(0, count);
  await writeFile(join(meta, "_journal.json"), `${JSON.stringify({ ...journal, entries }, null, 2)}\n`, "utf8");
  await Promise.all(entries.map(({ tag }) => copyFile(join(sourceMigrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`))));
  return folder;
}

test("liest Identitaet, exaktes Schema und leeren autoritativen Kopf aus einer real migrierten DB", async () => {
  const databaseA = new PGlite();
  const databaseB = new PGlite();
  try {
    await Promise.all([
      migrate(drizzle(databaseA), { migrationsFolder }),
      migrate(drizzle(databaseB), { migrationsFolder }),
    ]);
    const [snapshotA, snapshotB] = await Promise.all([
      inspectLiveDatabaseRollbackSnapshot(adapter(databaseA)),
      inspectLiveDatabaseRollbackSnapshot(adapter(databaseB)),
    ]);
    assert.notEqual(snapshotA.databaseIdentity, snapshotB.databaseIdentity);
    assert.equal(snapshotA.migrationLedger.length, 33);
    assert.equal(snapshotA.migrationLedger.at(-1)?.id, 33);
    assert.equal(snapshotA.constraints.length, 19);
    assert.equal(snapshotA.guards.length, 58);
    assert.equal(snapshotA.guards.some(({ name }) => name === "odoo_projection_outbox_world_guard"), true);
    assert.equal(snapshotA.constraints.some(({ name }) => name === "regional_simulation_states_legacy_writer_fence_shape"), true);
    assert.equal(snapshotA.guards.some(({ name }) => name === "regional_simulation_states_legacy_writer_fence"), true);
    assert.equal(snapshotA.guards.some(({ name }) => name === "zugfolge_capture_operational_command_receipts"), true);
    assert.equal(snapshotA.guards.some(({ name }) => name === "zugfolge_enforce_operational_initialization_immutability"), true);
    assert.equal(snapshotA.guards.filter(({ name }) => name.startsWith("zugfolge_world_guard_")).length, 50);
    assert.deepEqual(snapshotA.heads, { total: 0, v2: 0, nonNullInitializationHash: 0, incompatible: 0 });
    assert.equal(snapshotA.authoritativeHead.worldCount, 0);
    assert.equal(snapshotA.authoritativeHead.domainEventCount, "0");
  } finally {
    await Promise.all([databaseA.close(), databaseB.close()]);
  }
});

test("Schema34 bindet Quarantaene und Datenschutzspalten im eigenen v4-Restorevertrag", async () => {
  const client = new PGlite();
  const schema34Folder = await migrationsThrough(34);
  try {
    await migrate(drizzle(client), { migrationsFolder: schema34Folder });
    const source = await inspectLiveDatabaseRollbackSnapshot(adapter(client));
    assert.equal(source.migrationLedger.length, 34);
    const evidence = databaseRollbackEvidenceFixtures(source);
    const proof = createDatabaseRollbackProof({ releaseId: "infra-deutschland-2026.4", previousReleaseId: "infra-deutschland-2026.2", source, ...evidence, writersQuiesced: true, rollbackWindow: "pre-activation-only" });
    assert.equal(proof.schema, "zugfolge-database-rollback-proof/v4");
    assert.equal(validateDatabaseRollbackProof(proof), proof);
    await client.exec("insert into odoo_projection_quarantine(world_id,message_id,correlation_id) values ('unknown-world','unknown-message','trace')");
    const after = await inspectLiveDatabaseRollbackSnapshot(adapter(client));
    assert.notEqual(after.authoritativeHead.stateHash, source.authoritativeHead.stateHash);
    const worldId = "11111111-1111-4111-8111-111111111111";
    await client.query("insert into worlds(id,name,schedule_period_weeks,epoch) values($1,'Schema34',4,'2026-01-01Z')", [worldId]);
    assert.match(await worldFinalHistorySeal(adapter(client), worldId), /^[a-f0-9]{64}$/u);
    assert.deepEqual((await client.query("select content_hash,purged_at from mailbox_messages limit 0")).rows, []);
  } finally { await client.close(); await rm(schema34Folder, { recursive: true, force: true }); }
});

test("Schema34 bewahrt explizite historische33-Siegel mit echten Postfach-/Abusedaten", async () => {
  const client = new PGlite();
  const schema34Folder = await migrationsThrough(34);
  const worldId = "11111111-1111-4111-8111-111111111133";
  const accountId = "11111111-1111-4111-8111-111111111134";
  const historical = { schemaVersion: "zugfolge-world-final-history-seal/v1" };
  try {
    await migrate(drizzle(client), { migrationsFolder });
    await client.query("insert into worlds(id,name,schedule_period_weeks,epoch) values($1,'Archiv33',4,'2026-01-01Z')", [worldId]);
    await client.query("insert into accounts(id,world_id,keycloak_subject,display_name) values($1,$2,'history-owner','Archiv')", [accountId, worldId]);
    await client.query("insert into mailbox_messages(world_id,recipient_account_id,message_type,payload) values($1,$2,'history','{\"text\":\"unveraendert\"}')", [worldId, accountId]);
    await client.query(`insert into abuse_observations(world_id,identity_hash,endpoint_class,action_class,bucket_start_s,request_count,distinct_target_count,replay_count,coordinated_identity_count,score_basis_points,rule_codes,response,correlation_id)
      values($1,'identity','api','read',0,1,1,0,0,0,'[]','observe','history-trace')`, [worldId]);
    await client.query("update worlds set lifecycle_status='archived' where id=$1", [worldId]);
    const before = await worldFinalHistorySeal(adapter(client), worldId, historical);
    await migrate(drizzle(client), { migrationsFolder: schema34Folder });
    assert.equal(await worldFinalHistorySeal(adapter(client), worldId, historical), before);
    assert.notEqual(await worldFinalHistorySeal(adapter(client), worldId), before);
    assert.equal(await worldFinalHistorySeal(adapter(client), worldId, historical), before);
    await assert.rejects(client.query("update mailbox_messages set content_hash='changed' where world_id=$1", [worldId]), /archiv|closed|writer/iu);

    const activeWorld = "11111111-1111-4111-8111-111111111135";
    await client.query("insert into worlds(id,name,schedule_period_weeks,epoch) values($1,'Aktiv34',4,'2026-01-01Z')", [activeWorld]);
    await client.query(`insert into abuse_observations(world_id,identity_hash,endpoint_class,action_class,bucket_start_s,request_count,distinct_target_count,replay_count,coordinated_identity_count,score_basis_points,rule_codes,response,correlation_id,facts_hash)
      values($1,'identity','api','read',0,1,1,0,0,0,'[]','observe','new-trace','new-facts')`, [activeWorld]);
    await assert.rejects(worldFinalHistorySeal(adapter(client), activeWorld, historical), /Schema-34-Fakten/u);
    const current = await worldFinalHistorySeal(adapter(client), activeWorld);
    await client.query("update abuse_observations set facts_hash='changed-facts' where world_id=$1", [activeWorld]);
    assert.notEqual(await worldFinalHistorySeal(adapter(client), activeWorld), current);
  } finally { await client.close(); await rm(schema34Folder, { recursive: true, force: true }); }
});

test("0032 und 0033 rollen bei unvollstaendigem Alt-Receipt gemeinsam atomar auf Schema 31 zurueck", async () => {
  const database = new PGlite();
  const schema31Folder = await migrationsThrough(31);
  const worldId = "00000000-0000-4000-8000-000000000033";
  try {
    await migrate(drizzle(database), { migrationsFolder: schema31Folder });
    await database.query(
      "insert into worlds (id, name, schedule_period_weeks, epoch) values ($1, 'Atomic migration', 4, '1970-01-01T00:00:00Z')",
      [worldId],
    );
    await database.query(
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, state_hash, initialization_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'de-test', 'zugfolge-operational-simulation-state/v2', '{"commandReceipts":{}}', $2, $3, 1, 1,
         '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [worldId, "a".repeat(64), "b".repeat(64)],
    );
    await assert.rejects(
      migrate(drizzle(database), { migrationsFolder }),
      /cannot establish complete operational command receipt ledger/u,
    );
    const state = (await database.query(`
      select
        (select count(*)::int from drizzle.__drizzle_migrations) as migration_count,
        to_regprocedure('zugfolge_enforce_world_writer_guard()') is not null as writer_guard_present,
        to_regclass('public.regional_simulation_command_receipts') is not null as command_receipt_ledger_present,
        to_regprocedure('zugfolge_capture_operational_command_receipts()') is not null as command_receipt_capture_present,
        to_regprocedure('zugfolge_enforce_operational_initialization_immutability()') is not null as initialization_guard_present
    `)).rows[0];
    assert.deepEqual(state, {
      command_receipt_capture_present: false,
      command_receipt_ledger_present: false,
      initialization_guard_present: false,
      migration_count: 31,
      writer_guard_present: false,
    });
  } finally {
    await Promise.all([database.close(), rm(schema31Folder, { recursive: true, force: true })]);
  }
});

test("alter v1-Writer scheitert nach atomarer Archivierung und persistentem Row-Fence", async () => {
  const database = new PGlite();
  const worldId = "00000000-0000-4000-8000-000000000035";
  try {
    await migrate(drizzle(database), { migrationsFolder });
    await database.query(
      "insert into worlds (id, name, schedule_period_weeks, epoch) values ($1, 'Fence', 4, '1970-01-01T00:00:00Z')",
      [worldId],
    );
    await database.query(
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'legacy', 'zugfolge-regional-simulation-state/v1', '{}', $2, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [worldId, "a".repeat(64)],
    );
    await database.transaction(async (tx) => {
      await tx.query("update worlds set lifecycle_status = 'archived' where id = $1", [worldId]);
      await tx.query(
        "update regional_simulation_states set legacy_writer_fenced = true where world_id = $1 and region_id = 'legacy'",
        [worldId],
      );
    });
    await assert.rejects(
      database.query(
        `update regional_simulation_states
         set state = '{"oldWriter":true}', state_hash = $2,
             revision = revision + 1, publisher_sequence = publisher_sequence + 1,
             updated_at = '1970-01-01T00:01:00Z'
         where world_id = $1 and region_id = 'legacy'`,
        [worldId, "b".repeat(64)],
      ),
      /legacy regional writer is fenced/u,
    );
    await assert.rejects(
      database.query(
        "delete from regional_simulation_states where world_id = $1 and region_id = 'legacy'",
        [worldId],
      ),
      /legacy regional writer is fenced/u,
    );
  } finally {
    await database.close();
  }
});

test("kanonischer Gesamtreihenhash erkennt manipuliertes mittleres Event bei gleichem Count und Head", async () => {
  const database = new PGlite();
  const worldId = "00000000-0000-4000-8000-000000000036";
  try {
    await migrate(drizzle(database), { migrationsFolder });
    await database.query(
      "insert into worlds (id, name, schedule_period_weeks, epoch) values ($1, 'Event hash', 4, '1970-01-01T00:00:00Z')",
      [worldId],
    );
    for (const sequence of [1, 2, 3]) {
      await database.query(
        `insert into domain_events (id, world_id, sequence, event_type, payload, occurred_at)
         values ($1, $2, $3, 'tick', $4::jsonb, '1970-01-01T00:00:00Z')`,
        [`00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, worldId, sequence, JSON.stringify({ sequence })],
      );
    }
    const before = await inspectLiveDatabaseRollbackSnapshot(adapter(database));
    await database.query("alter table domain_events disable trigger domain_events_append_only");
    await database.query(
      "update domain_events set payload = '{\"sequence\":2,\"corrupted\":true}' where world_id = $1 and sequence = 2",
      [worldId],
    );
    await database.query("alter table domain_events enable trigger domain_events_append_only");
    const after = await inspectLiveDatabaseRollbackSnapshot(adapter(database));
    assert.equal(before.authoritativeHead.domainEventCount, "3");
    assert.equal(after.authoritativeHead.domainEventCount, "3");
    assert.notEqual(before.authoritativeHead.stateHash, after.authoritativeHead.stateHash);
  } finally {
    await database.close();
  }
});

test("Welt-Historienseal bindet auch eine innere Kontenzeile ausserhalb Regionalzustand und Domain-Events", async () => {
  const database = new PGlite();
  const worldId = "00000000-0000-4000-8000-000000000037";
  const accountId = "00000000-0000-4000-8000-000000000038";
  try {
    await migrate(drizzle(database), { migrationsFolder });
    await database.query(
      "insert into worlds (id, name, schedule_period_weeks, epoch) values ($1, 'Seal', 4, '1970-01-01T00:00:00Z')",
      [worldId],
    );
    await database.query(
      "insert into accounts (id, world_id, keycloak_subject, display_name) values ($1, $2, 'seal-test', 'Vorher')",
      [accountId, worldId],
    );
    const before = await worldFinalHistorySeal(adapter(database), worldId);
    await database.query("update accounts set display_name = 'Nachher' where id = $1", [accountId]);
    const after = await worldFinalHistorySeal(adapter(database), worldId);
    assert.notEqual(before, after);
  } finally {
    await database.close();
  }
});
