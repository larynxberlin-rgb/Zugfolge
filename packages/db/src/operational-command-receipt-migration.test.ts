import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER } from "./migrations.js";

interface MigrationJournal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly {
    readonly idx: number;
    readonly version: string;
    readonly when: number;
    readonly tag: string;
    readonly breakpoints: boolean;
  }[];
}

interface Schema32Database {
  readonly client: PGlite;
  readonly migrationsFolder: string;
}

async function createSchema32Database(): Promise<Schema32Database> {
  const migrationsFolder = await mkdtemp(join(tmpdir(), "zugfolge-db-schema-32-"));
  const metaFolder = join(migrationsFolder, "meta");
  await mkdir(metaFolder);
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.slice(0, 32);
  if (entries.at(-1)?.tag !== "0032_world_writer_guard") {
    throw new Error("schema_32_migration_boundary_missing");
  }
  await writeFile(
    join(metaFolder, "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    "utf8",
  );
  await Promise.all(entries.map(({ tag }) => copyFile(
    join(MIGRATIONS_FOLDER, `${tag}.sql`),
    join(migrationsFolder, `${tag}.sql`),
  )));
  const client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder });
  return { client, migrationsFolder };
}

async function disposeSchema32Database(database: Schema32Database): Promise<void> {
  await database.client.close();
  await rm(database.migrationsFolder, { recursive: true, force: true });
}

async function insertOperationalState(
  client: PGlite,
  worldId: string,
  initializationHash: string,
  revision: number,
  commandReceipts: Readonly<Record<string, unknown>>,
): Promise<void> {
  await client.query(
    `insert into worlds (id, name, schedule_period_weeks, epoch)
     values ($1, 'Receipt migration', 4, '1970-01-01T00:00:00Z')`,
    [worldId],
  );
  await client.query(
    `insert into regional_simulation_states
      (world_id, region_id, state_schema, state, initialization_hash, state_hash,
       revision, publisher_sequence, created_at, updated_at)
     values (
       $1,
       'region',
       'zugfolge-operational-simulation-state/v2',
       $2::jsonb,
       $3,
       $4,
       $5,
       $5,
       '1970-01-01T00:00:00Z',
       '1970-01-01T00:00:00Z'
     )`,
    [
      worldId,
      JSON.stringify({ initializationHash, commandReceipts }),
      initializationHash,
      "f".repeat(64),
      revision,
    ],
  );
}

describe("0033 operational command receipt ledger", () => {
  it("migriert vollstaendige Schema-29-String-Receipts und aktuelle Objekt-Receipts", async () => {
    const database = await createSchema32Database();
    const legacyWorldId = "33000000-0000-4000-8000-000000000001";
    const currentWorldId = "33000000-0000-4000-8000-000000000002";
    const legacyInitializationHash = "a".repeat(64);
    const currentInitializationHash = "b".repeat(64);
    try {
      await insertOperationalState(database.client, legacyWorldId, legacyInitializationHash, 2, {
        "legacy-command-1": "1".repeat(64),
        "legacy-command-2": "2".repeat(64),
      });
      await database.client.query(
        "update worlds set lifecycle_status = 'archived' where id = $1",
        [legacyWorldId],
      );
      await insertOperationalState(database.client, currentWorldId, currentInitializationHash, 2, {
        "current-command-1": { commandHash: "3".repeat(64), appliedRevision: 1 },
        "current-command-2": { commandHash: "4".repeat(64), appliedRevision: 2 },
      });

      await migrate(drizzle(database.client), { migrationsFolder: MIGRATIONS_FOLDER });

      const receipts = await database.client.query<{
        world_id: string;
        initialization_hash: string;
        command_id: string;
        applied_revision: string | null;
      }>(
        `select world_id::text, initialization_hash, command_id,
                applied_revision::text
         from regional_simulation_command_receipts
         order by world_id, command_id`,
      );
      expect(receipts.rows).toEqual([
        {
          world_id: legacyWorldId,
          initialization_hash: legacyInitializationHash,
          command_id: "legacy-command-1",
          applied_revision: null,
        },
        {
          world_id: legacyWorldId,
          initialization_hash: legacyInitializationHash,
          command_id: "legacy-command-2",
          applied_revision: null,
        },
        {
          world_id: currentWorldId,
          initialization_hash: currentInitializationHash,
          command_id: "current-command-1",
          applied_revision: "1",
        },
        {
          world_id: currentWorldId,
          initialization_hash: currentInitializationHash,
          command_id: "current-command-2",
          applied_revision: "2",
        },
      ]);
    } finally {
      await disposeSchema32Database(database);
    }
  });

  it("haelt Schema-31-Writer-Receipts per Trigger fest und bindet sie an die Initialisierung", async () => {
    const database = await createSchema32Database();
    const worldId = "33000000-0000-4000-8000-000000000003";
    const initializationHash = "c".repeat(64);
    const replacementInitializationHash = "d".repeat(64);
    const firstReceipts = {
      "legacy-command-1": "5".repeat(64),
      "legacy-command-2": "6".repeat(64),
    };
    try {
      await insertOperationalState(database.client, worldId, initializationHash, 2, firstReceipts);
      await migrate(drizzle(database.client), { migrationsFolder: MIGRATIONS_FOLDER });

      await database.client.query(
        `update regional_simulation_states
         set state = $1::jsonb, state_hash = $2, revision = 3,
             publisher_sequence = 3, updated_at = '1970-01-01T00:00:03Z'
         where world_id = $3 and region_id = 'region'`,
        [
          JSON.stringify({
            initializationHash,
            commandReceipts: { ...firstReceipts, "legacy-command-3": "7".repeat(64) },
          }),
          "e".repeat(64),
          worldId,
        ],
      );
      const captured = await database.client.query<{ receipt_count: number }>(
        `select count(*)::int as receipt_count
         from regional_simulation_command_receipts
         where world_id = $1 and region_id = 'region' and initialization_hash = $2`,
        [worldId, initializationHash],
      );
      expect(captured.rows[0]?.receipt_count).toBe(3);

      await expect(database.client.query(
        `update regional_simulation_states
         set state_hash = $1, revision = 4, publisher_sequence = 4,
             updated_at = '1970-01-01T00:00:03.500Z'
         where world_id = $2 and region_id = 'region'`,
        ["d".repeat(64), worldId],
      )).rejects.toThrow(/operational command receipt ledger is incomplete/u);

      await expect(database.client.query(
        `update regional_simulation_states
         set state = $1::jsonb, state_hash = $2, revision = 4,
             publisher_sequence = 4, updated_at = '1970-01-01T00:00:03.750Z'
         where world_id = $3 and region_id = 'region'`,
        [
          JSON.stringify({
            initializationHash,
            commandReceipts: {
              ...firstReceipts,
              "legacy-command-3": "7".repeat(64),
              "current-command-without-revision": { commandHash: "8".repeat(64) },
            },
          }),
          "d".repeat(64),
          worldId,
        ],
      )).rejects.toThrow(/invalid operational command receipt checkpoint/u);

      await expect(database.client.query(
        `update regional_simulation_states
         set state = $1::jsonb, state_hash = $2, updated_at = '1970-01-01T00:00:04Z'
         where world_id = $3 and region_id = 'region'`,
        [
          JSON.stringify({
            initializationHash,
            commandReceipts: { ...firstReceipts, "legacy-command-3": "8".repeat(64) },
          }),
          "9".repeat(64),
          worldId,
        ],
      )).rejects.toThrow(/operational command receipt ledger conflict/u);

      await expect(database.client.query(
        `update regional_simulation_states
         set initialization_hash = $1
         where world_id = $2 and region_id = 'region'`,
        [replacementInitializationHash, worldId],
      )).rejects.toThrow(/operational initialization binding is immutable/u);

      await database.client.query(
        "delete from regional_simulation_states where world_id = $1 and region_id = 'region'",
        [worldId],
      );
      const afterDelete = await database.client.query<{ receipt_count: number }>(
        "select count(*)::int as receipt_count from regional_simulation_command_receipts where world_id = $1",
        [worldId],
      );
      expect(afterDelete.rows[0]?.receipt_count).toBe(0);
      await database.client.query(
        `insert into regional_simulation_states
          (world_id, region_id, state_schema, state, initialization_hash, state_hash,
           revision, publisher_sequence, created_at, updated_at)
         values ($1, 'region', 'zugfolge-operational-simulation-state/v2', $2::jsonb,
                 $3, $4, 0, 0, '1970-01-01T00:01:00Z', '1970-01-01T00:01:00Z')`,
        [
          worldId,
          JSON.stringify({ initializationHash: replacementInitializationHash, commandReceipts: {} }),
          replacementInitializationHash,
          "a".repeat(64),
        ],
      );
    } finally {
      await disposeSchema32Database(database);
    }
  });

  it("stoppt bei eviktierter, lueckenhafter oder beschaedigter Alt-Historie fail-closed", async () => {
    const scenarios = [
      {
        worldId: "33000000-0000-4000-8000-000000000004",
        revision: 3,
        receipts: { "legacy-command-1": "a".repeat(64), "legacy-command-2": "b".repeat(64) },
        error: /cannot establish complete operational command receipt ledger/u,
      },
      {
        worldId: "33000000-0000-4000-8000-000000000005",
        revision: 1,
        receipts: { "legacy-command-1": "not-a-sha256" },
        error: /invalid legacy operational command receipt/u,
      },
      {
        worldId: "33000000-0000-4000-8000-000000000006",
        revision: 2,
        receipts: {
          "mixed-command-1": "c".repeat(64),
          "mixed-command-2": { commandHash: "d".repeat(64), appliedRevision: 2 },
        },
        error: /mixed operational command receipt formats/u,
      },
    ] as const;

    for (const scenario of scenarios) {
      const database = await createSchema32Database();
      try {
        await insertOperationalState(
          database.client,
          scenario.worldId,
          "e".repeat(64),
          scenario.revision,
          scenario.receipts,
        );
        await expect(migrate(
          drizzle(database.client),
          { migrationsFolder: MIGRATIONS_FOLDER },
        )).rejects.toThrow(scenario.error);
      } finally {
        await disposeSchema32Database(database);
      }
    }
  });
});
