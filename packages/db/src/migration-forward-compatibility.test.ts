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

async function currentMainMigrationsFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "zugfolge-db-current-main-"));
  const metaFolder = join(folder, "meta");
  await mkdir(metaFolder);

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.slice(0, 22);
  expect(entries.at(-1)?.tag).toBe("0022_contract_termination_authority");

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

it("migriert ein aktuelles 0022-Schema vorwaerts bis 0029 und erhaelt Legacy-Koepfe fail-closed", async () => {
  const previousMigrationsFolder = await currentMainMigrationsFolder();
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
    expect(before.rows[0]?.migration_count).toBe(22);

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const after = await client.query<{ migration_count: number }>(
      "select count(*)::int as migration_count from drizzle.__drizzle_migrations",
    );
    expect(after.rows[0]?.migration_count).toBe(EXPECTED_SCHEMA_MIGRATIONS);
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
      `insert into regional_simulation_states
        (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
       values ($1, 'new-without-binding', 'zugfolge-operational-simulation-state/v2', '{}', $2, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`,
      [legacyWorldId, "b".repeat(64)],
    )).rejects.toThrow();
    await expect(client.query<{ definition: string }>(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'planning_train_numbers_category_range_check'",
    )).resolves.toMatchObject({ rows: [{ definition: expect.stringContaining("34999") }] });
    await expect(client.query<{ constraint_count: number }>(
      "select count(*)::int as constraint_count from pg_constraint where conname = 'odoo_reconciliation_tasks_world_fk'",
    )).resolves.toMatchObject({ rows: [{ constraint_count: 0 }] });
  } finally {
    await client.close();
    await rm(previousMigrationsFolder, { recursive: true, force: true });
  }
});
