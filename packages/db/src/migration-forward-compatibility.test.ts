import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";

import { EXPECTED_SCHEMA_MIGRATIONS } from "./health.js";
import { MIGRATIONS_FOLDER } from "./migrations.js";

interface MigrationJournal {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

it("gibt zwei strukturell identischen Datenbanken verschiedene restaurierbare Identitaeten", async () => {
  const databaseA = new PGlite();
  const databaseB = new PGlite();
  try {
    await Promise.all([
      migrate(drizzle(databaseA), { migrationsFolder: MIGRATIONS_FOLDER }),
      migrate(drizzle(databaseB), { migrationsFolder: MIGRATIONS_FOLDER }),
    ]);
    const [identityA, identityB] = await Promise.all([
      databaseA.query<{ database_id: string }>("select database_id::text as database_id from zugfolge_database_identity where singleton = 1"),
      databaseB.query<{ database_id: string }>("select database_id::text as database_id from zugfolge_database_identity where singleton = 1"),
    ]);
    expect(identityA.rows[0]?.database_id).not.toBe(identityB.rows[0]?.database_id);
  } finally {
    await Promise.all([databaseA.close(), databaseB.close()]);
  }
});

async function schema28MigrationsFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "zugfolge-db-schema-28-"));
  const metaFolder = join(folder, "meta");
  await mkdir(metaFolder);

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.slice(0, 28);
  expect(entries.at(-1)?.tag).toBe("0028_public_train_number_capacity");

  await writeFile(
    join(metaFolder, "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    "utf8",
  );
  await Promise.all(entries.map(({ tag }) => copyFile(
    join(MIGRATIONS_FOLDER, `${tag}.sql`),
    join(folder, `${tag}.sql`),
  )));
  return folder;
}

async function schema31MigrationsFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "zugfolge-db-schema-31-"));
  const metaFolder = join(folder, "meta");
  await mkdir(metaFolder);

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.slice(0, 31);
  expect(entries.at(-1)?.tag).toBe("0031_database_bound_cutover_receipts");

  await writeFile(
    join(metaFolder, "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    "utf8",
  );
  await Promise.all(entries.map(({ tag }) => copyFile(
    join(MIGRATIONS_FOLDER, `${tag}.sql`),
    join(folder, `${tag}.sql`),
  )));
  return folder;
}

it("migriert Schema 28 atomar bis 33 und bindet alle Welt-Writer an die DB-Instanz", async () => {
  const previousMigrationsFolder = await schema28MigrationsFolder();
  const client = new PGlite();
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder: previousMigrationsFolder });
    const legacyWorldId = "00000000-0000-4000-8000-000000000029";
    await client.query(
      "insert into worlds (id, name, schedule_period_weeks, epoch) values ($1, 'Legacy', 4, '1970-01-01T00:00:00Z')",
      [legacyWorldId],
    );
    await client.query(
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'legacy', 'zugfolge-regional-simulation-state/v1', '{}', $2, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [legacyWorldId, "a".repeat(64)],
    );
    const before = await client.query<{ migration_count: number }>(
      "select count(*)::int as migration_count from drizzle.__drizzle_migrations",
    );
    expect(before.rows[0]?.migration_count).toBe(28);

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const after = await client.query<{ migration_count: number }>(
      "select count(*)::int as migration_count from drizzle.__drizzle_migrations",
    );
    expect(after.rows[0]?.migration_count).toBe(EXPECTED_SCHEMA_MIGRATIONS);
    await expect(client.query<{ trigger_count: number }>(
      `select count(*)::int as trigger_count
       from pg_trigger
       where not tgisinternal and tgname like 'zugfolge_world_guard_%'`,
    )).resolves.toMatchObject({ rows: [{ trigger_count: 50 }] });
    await expect(client.query<{ function_source: string }>(
      `select prosrc as function_source from pg_proc
       where proname = 'zugfolge_enforce_world_writer_guard'`,
    )).resolves.toMatchObject({
      rows: [{
        function_source: expect.stringMatching(
          /to_jsonb\(OLD\)[\s\S]*to_jsonb\(NEW\)[\s\S]*ORDER BY candidate\.world_id::text[\s\S]*SELECT DISTINCT[\s\S]*pg_advisory_xact_lock_shared[\s\S]*odoo_projection_outbox[\s\S]*delivered_at IS NULL[\s\S]*FOR KEY SHARE/iu,
        ),
      }],
    });
    await expect(client.query("select deployment_hash from alpha_world_profiles limit 0"))
      .resolves.toBeDefined();
    await expect(client.query("select world_id, keycloak_subject, state from world_participations limit 0"))
      .resolves.toBeDefined();
    await expect(client.query("select world_id, account_id, train_number from planning_train_numbers limit 0"))
      .resolves.toBeDefined();
    await expect(client.query<{ initialization_hash: string | null }>(
      "select initialization_hash from regional_simulation_states where world_id = $1 and region_id = 'legacy'",
      [legacyWorldId],
    )).resolves.toMatchObject({ rows: [{ initialization_hash: null }] });
    await expect(client.query(
      `update regional_simulation_states
       set state_schema = 'zugfolge-regional-simulation-state/v1',
           state = '{"legacyWorkerAdvanced":true}', revision = revision + 1,
           publisher_sequence = publisher_sequence + 1, updated_at = '1970-01-01T00:01:00Z'
       where world_id = $1 and region_id = 'legacy'`,
      [legacyWorldId],
    )).resolves.toBeDefined();
    await expect(client.query<{ initialization_hash: string | null; revision: number }>(
      "select initialization_hash, revision from regional_simulation_states where world_id = $1 and region_id = 'legacy'",
      [legacyWorldId],
    )).resolves.toMatchObject({ rows: [{ initialization_hash: null, revision: 1 }] });
    await expect(client.query(
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'new-without-binding', 'zugfolge-operational-simulation-state/v2', '{}', $2, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [legacyWorldId, "b".repeat(64)],
    )).rejects.toThrow();
    const provisioningWorldId = "00000000-0000-4000-8000-000000000030";
    const provisioningAccountId = "00000000-0000-4000-8000-000000000040";
    await client.query(
      `insert into worlds (id, name, schedule_period_weeks, epoch, lifecycle_status)
       values ($1, 'Provisioning writer', 4, '1970-01-01T00:00:00Z', 'provisioning')`,
      [provisioningWorldId],
    );
    await client.query(
      `insert into accounts (id, world_id, keycloak_subject, display_name)
       values ($1, $2, 'provisioning-writer', 'Provisioning')`,
      [provisioningAccountId, provisioningWorldId],
    );
    await client.query(
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'provisioning', 'zugfolge-regional-simulation-state/v1', '{}', $2, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [provisioningWorldId, "7".repeat(64)],
    );
    await expect(client.query(
      "update accounts set display_name = 'Provisioning updated' where id = $1",
      [provisioningAccountId],
    )).resolves.toBeDefined();
    await client.query(
      "delete from regional_simulation_states where world_id = $1 and region_id = 'provisioning'",
      [provisioningWorldId],
    );
    await client.query("delete from accounts where id = $1", [provisioningAccountId]);
    await client.query("delete from worlds where id = $1", [provisioningWorldId]);

    const activeAccountId = "00000000-0000-4000-8000-000000000041";
    await client.query(
      `insert into accounts (id, world_id, keycloak_subject, display_name)
       values ($1, $2, 'active-writer', 'Active')`,
      [activeAccountId, legacyWorldId],
    );
    await expect(client.query(
      "update accounts set display_name = 'Active updated' where id = $1",
      [activeAccountId],
    )).resolves.toBeDefined();
    await expect(client.query(
      `update regional_simulation_states
       set state_schema = 'zugfolge-operational-simulation-state/v2'
       where world_id = $1 and region_id = 'legacy'`,
      [legacyWorldId],
    )).rejects.toThrow();
    await client.query(
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, initialization_hash, state_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'v2', 'zugfolge-operational-simulation-state/v2', '{}', $2, $3, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [legacyWorldId, "c".repeat(64), "d".repeat(64)],
    );
    await expect(client.query(
      `update regional_simulation_states
       set state_schema = 'zugfolge-regional-simulation-state/v1',
           state = '{"oldWorkerTriedToDowngrade":true}', revision = revision + 1,
           publisher_sequence = publisher_sequence + 1, updated_at = '1970-01-01T00:01:00Z'
       where world_id = $1 and region_id = 'v2'`,
      [legacyWorldId],
    )).rejects.toThrow();
    await expect(client.query(
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, initialization_hash, state_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'v1-with-hash', 'zugfolge-regional-simulation-state/v1', '{}', $2, $3, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [legacyWorldId, "e".repeat(64), "f".repeat(64)],
    )).rejects.toThrow();
    await expect(client.query(
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'unknown', 'zugfolge-regional-simulation-state/v3', '{}', $2, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [legacyWorldId, "f".repeat(64)],
    )).rejects.toThrow();
    await client.query(
      `insert into economy_outbox
        (world_id, effect_id, effect_type, payload, occurred_at, enqueued_at)
       values ($1, 'archive-drain-proof', 'journal', '{}', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [legacyWorldId],
    );
    await client.query(
      `insert into odoo_projection_outbox
        (world_id, message_type, schema_version, correlation_id, payload, occurred_at, enqueued_at)
       values ($1, 'archive-drain-proof', 'zugfolge-odoo/v1', 'archive-drain-proof', '{}',
         '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [legacyWorldId],
    );
    await expect(client.query(
      "update worlds set lifecycle_status = 'archived' where id = $1",
      [legacyWorldId],
    )).rejects.toThrow(/pending economy outbox/u);
    await client.query(
      "update economy_outbox set processed_at = '1970-01-01T00:01:00Z' where world_id = $1 and effect_id = 'archive-drain-proof'",
      [legacyWorldId],
    );
    await expect(client.query(
      "update worlds set lifecycle_status = 'archived' where id = $1",
      [legacyWorldId],
    )).rejects.toThrow(/pending odoo projection outbox/u);
    await client.query(
      "update odoo_projection_outbox set delivered_at = '1970-01-01T00:01:00Z' where world_id = $1 and correlation_id = 'archive-drain-proof'",
      [legacyWorldId],
    );
    await client.query("update worlds set lifecycle_status = 'archived' where id = $1", [legacyWorldId]);
    await client.query(
      "update regional_simulation_states set legacy_writer_fenced = true where world_id = $1 and region_id = 'legacy'",
      [legacyWorldId],
    );
    await expect(client.query(
      `update regional_simulation_states
       set state = '{"staleLegacyWriter":true}', revision = revision + 1,
           publisher_sequence = publisher_sequence + 1, updated_at = '1970-01-01T00:02:00Z'
       where world_id = $1 and region_id = 'legacy'`,
      [legacyWorldId],
    )).rejects.toThrow(/legacy regional writer is fenced/u);
    await expect(client.query(
      "update regional_simulation_states set legacy_writer_fenced = true where world_id = $1 and region_id = 'v2'",
      [legacyWorldId],
    )).rejects.toThrow();
    await expect(client.query(
      "update accounts set display_name = 'Archived writer' where id = $1",
      [activeAccountId],
    )).rejects.toThrow(/world writer is fenced/u);
    await expect(client.query(
      "delete from accounts where id = $1",
      [activeAccountId],
    )).rejects.toThrow(/world writer is fenced/u);
    await expect(client.query(
      `insert into accounts (world_id, keycloak_subject, display_name)
       values ($1, 'archived-writer', 'Archived')`,
      [legacyWorldId],
    )).rejects.toThrow(/world writer is fenced/u);
    await expect(client.query<{ definition: string; validated: boolean }>(
      `select pg_get_constraintdef(oid) as definition, convalidated as validated
       from pg_constraint
       where conname = 'regional_simulation_states_initialization_hash_present'`,
    )).resolves.toMatchObject({
      rows: [{
        definition: expect.stringContaining("zugfolge-regional-simulation-state/v1"),
        validated: true,
      }],
    });
    await expect(client.query<{ definition: string }>(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'planning_train_numbers_category_range_check'",
    )).resolves.toMatchObject({ rows: [{ definition: expect.stringContaining("34999") }] });
    const identity = await client.query<{ database_id: string }>(
      "select database_id::text as database_id from zugfolge_database_identity where singleton = 1",
    );
    expect(identity.rows[0]?.database_id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(client.query("update zugfolge_database_identity set database_id = gen_random_uuid() where singleton = 1"))
      .rejects.toThrow(/immutable/u);
    await expect(client.query("delete from zugfolge_database_identity where singleton = 1"))
      .rejects.toThrow(/immutable/u);
    await expect(client.query<{ constraint_count: number }>(
      "select count(*)::int as constraint_count from pg_constraint where conname = 'odoo_reconciliation_tasks_world_fk'",
    )).resolves.toMatchObject({ rows: [{ constraint_count: 0 }] });
  } finally {
    await client.close();
    await rm(previousMigrationsFolder, { recursive: true, force: true });
  }
});

it("verweigert Schema 32 bei bereits archivierten unquittierten Odoo-Projektionen", async () => {
  const previousMigrationsFolder = await schema31MigrationsFolder();
  const client = new PGlite();
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder: previousMigrationsFolder });
    const archivedWorldId = "00000000-0000-4000-8000-000000000032";
    await client.query(
      `insert into worlds (id, name, schedule_period_weeks, epoch, lifecycle_status)
       values ($1, 'Archived pending Odoo', 4, '1970-01-01T00:00:00Z', 'archived')`,
      [archivedWorldId],
    );
    await client.query(
      `insert into odoo_projection_outbox
        (world_id, message_type, schema_version, correlation_id, payload, occurred_at, enqueued_at)
       values ($1, 'legacy.pending', 'zugfolge-odoo/v1', 'legacy-pending', '{}',
         '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [archivedWorldId],
    );

    await expect(migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }))
      .rejects.toThrow(/archived world with pending odoo projection outbox/u);
    await expect(client.query<{ migration_count: number }>(
      "select count(*)::int as migration_count from drizzle.__drizzle_migrations",
    )).resolves.toMatchObject({ rows: [{ migration_count: 31 }] });

    // Unter Schema 31 bleibt die eng begrenzte Ack-Mutation moeglich. Erst
    // danach darf Schema 32 die Welt-Historie dauerhaft einfrieren.
    await client.query(
      "update odoo_projection_outbox set delivered_at = '1970-01-01T00:01:00Z' where world_id = $1 and correlation_id = 'legacy-pending'",
      [archivedWorldId],
    );
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await expect(client.query<{ migration_count: number }>(
      "select count(*)::int as migration_count from drizzle.__drizzle_migrations",
    )).resolves.toMatchObject({ rows: [{ migration_count: EXPECTED_SCHEMA_MIGRATIONS }] });
  } finally {
    await client.close();
    await rm(previousMigrationsFolder, { recursive: true, force: true });
  }
});

it("rollt den Operational-/DB-Bindungsvertrag bei einem inkompatiblen Kopf gemeinsam auf Schema 28 zurueck", async () => {
  const previousMigrationsFolder = await schema28MigrationsFolder();
  const client = new PGlite();
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder: previousMigrationsFolder });
    const incompatibleWorldId = "00000000-0000-4000-8000-000000000031";
    await client.query(
      "insert into worlds (id, name, schedule_period_weeks, epoch) values ($1, 'Incompatible', 4, '1970-01-01T00:00:00Z')",
      [incompatibleWorldId],
    );
    await client.query(
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'unknown', 'zugfolge-regional-simulation-state/v3', '{}', $2, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [incompatibleWorldId, "a".repeat(64)],
    );
    await expect(client.query("select initialization_hash from regional_simulation_states limit 0"))
      .rejects.toThrow();

    await expect(migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })).rejects.toThrow();
    await expect(client.query<{ migration_count: number }>(
      "select count(*)::int as migration_count from drizzle.__drizzle_migrations",
    )).resolves.toMatchObject({ rows: [{ migration_count: 28 }] });
    await expect(client.query("select initialization_hash from regional_simulation_states limit 0"))
      .rejects.toThrow();
  } finally {
    await client.close();
    await rm(previousMigrationsFolder, { recursive: true, force: true });
  }
});
