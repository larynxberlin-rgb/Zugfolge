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

it("migriert ein aktuelles 0022-Schema vorwaerts bis 0026", async () => {
  const previousMigrationsFolder = await currentMainMigrationsFolder();
  const client = new PGlite();
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder: previousMigrationsFolder });
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
    await expect(client.query<{ constraint_count: number }>(
      "select count(*)::int as constraint_count from pg_constraint where conname = 'odoo_reconciliation_tasks_world_fk'",
    )).resolves.toMatchObject({ rows: [{ constraint_count: 0 }] });
  } finally {
    await client.close();
    await rm(previousMigrationsFolder, { recursive: true, force: true });
  }
});
