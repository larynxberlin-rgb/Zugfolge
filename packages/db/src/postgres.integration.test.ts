import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";

import { createDatabaseHealthCheck, EXPECTED_SCHEMA_MIGRATIONS } from "./health.js";
import { MIGRATIONS_FOLDER } from "./migrations.js";
import { accounts, alphaWorldProfiles, operators, worlds } from "./schema/index.js";
import * as schema from "./schema/index.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];

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

async function schema28MigrationsFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "zugfolge-pg-schema-28-"));
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
  const folder = await mkdtemp(join(tmpdir(), "zugfolge-pg-schema-31-"));
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

async function schema32MigrationsFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "zugfolge-pg-schema-32-"));
  const metaFolder = join(folder, "meta");
  await mkdir(metaFolder);
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.slice(0, 32);
  expect(entries.at(-1)?.tag).toBe("0032_world_writer_guard");
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

let temporaryDatabaseSequence = 0;

async function withTemporaryDatabase(
  purpose: string,
  run: (client: ReturnType<typeof postgres>, targetUrl: string) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL fehlt.");
  temporaryDatabaseSequence += 1;
  const databaseName = `zf_${purpose}_${process.pid}_${temporaryDatabaseSequence}`;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.toString(), { max: 1 });
  let target: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(`create database "${databaseName}"`);
    target = postgres(targetUrl.toString(), { max: 1 });
    await run(target, targetUrl.toString());
  } finally {
    if (target !== undefined) await target.end();
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin.end();
  }
}

async function waitForAdvisoryLockWait(
  observer: ReturnType<typeof postgres>,
  backendPid: number,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const [waiting] = await observer<{ waiting: boolean }[]>`
      select exists (
        select 1 from pg_locks
        where pid = ${backendPid} and locktype = 'advisory' and not granted
      ) as waiting`;
    if (waiting?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${backendPid} wartete nicht sichtbar auf den exklusiven World-Lock.`);
}

async function waitForWorldGuardInstallLockWait(
  observer: ReturnType<typeof postgres>,
  backendPid: number,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const [waiting] = await observer<{ relation_name: string | null }[]>`
      select relation.relname as relation_name
      from pg_locks as held_lock
      left join pg_class as relation on relation.oid = held_lock.relation
      where held_lock.pid = ${backendPid}
        and held_lock.locktype = 'relation'
        and held_lock.mode = 'ShareRowExclusiveLock'
        and not held_lock.granted
        and relation.relname in ('economy_outbox', 'odoo_projection_outbox', 'worlds')
      limit 1`;
    if (waiting?.relation_name !== null && waiting?.relation_name !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${backendPid} wartete nicht sichtbar auf den Schema-32-Installationslock.`);
}

describe.skipIf(databaseUrl === undefined)("real PostgreSQL integration", () => {
  const client = postgres(databaseUrl ?? "postgres://invalid", { max: 4 });
  const db = drizzle(client, { schema });

  beforeAll(async () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }), 60_000);
  afterAll(async () => client.end());

  it("applies every migration and reports the real server ready", async () => {
    await expect(createDatabaseHealthCheck(db).check()).resolves.toEqual({ status: "ok", code: "schema_current" });
    const [version] = await client<{ version: string }[]>`select version()`;
    expect(version?.version).toMatch(/^PostgreSQL 1[6-9]\./);
  });

  it("enforces composite world isolation in PostgreSQL itself", async () => {
    await client`delete from accounts where world_id in (select id from worlds where name in ('PG A', 'PG B'))`;
    await client`delete from worlds where name in ('PG A', 'PG B')`;
    const [worldA, worldB] = await db.insert(worlds).values([
      { name: "PG A", epoch: new Date("2026-08-11T00:00:00Z"), schedulePeriodWeeks: 3 },
      { name: "PG B", epoch: new Date("2026-08-11T00:00:00Z"), schedulePeriodWeeks: 3 },
    ]).returning();
    const [account] = await db.insert(accounts).values({
      worldId: worldA!.id,
      keycloakSubject: "postgres-integration",
      displayName: "Postgres Integration",
    }).returning();

    await expect(db.insert(operators).values({
      worldId: worldB!.id,
      foundingAccountId: account!.id,
      name: "World leak",
    })).rejects.toMatchObject({ cause: { code: "23503", constraint_name: "operators_world_account_fk" } });

    await db.delete(accounts).where(eq(accounts.id, account!.id));
    await db.delete(worlds).where(eq(worlds.id, worldB!.id));
    await db.delete(worlds).where(eq(worlds.id, worldA!.id));
  });

  it("migriert vollstaendige Schema-29-Receipts in PostgreSQL und fenced unvollstaendige Historie", async () => {
    const schema32Folder = await schema32MigrationsFolder();
    const initializationHash = "a".repeat(64);
    try {
      await withTemporaryDatabase("receipt_ledger_ok", async (target) => {
        const targetDb = drizzle(target);
        const worldId = "00000000-0000-4000-8000-000000000035";
        await migrate(targetDb, { migrationsFolder: schema32Folder });
        await target`insert into worlds (id, name, schedule_period_weeks, epoch)
          values (${worldId}, 'PG legacy receipt history', 4, '1970-01-01T00:00:00Z')`;
        await target`insert into regional_simulation_states
          (world_id, region_id, state_schema, state, initialization_hash, state_hash,
           revision, publisher_sequence, created_at, updated_at)
          values (
            ${worldId}, 'legacy', 'zugfolge-operational-simulation-state/v2',
            jsonb_build_object(
              'initializationHash', ${initializationHash}::text,
              'commandReceipts', jsonb_build_object(
                'legacy-command-1', ${"1".repeat(64)}::text,
                'legacy-command-2', ${"2".repeat(64)}::text
              )
            ),
            ${initializationHash}, ${"f".repeat(64)}, 2, 2,
            '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'
          )`;

        await migrate(targetDb, { migrationsFolder: MIGRATIONS_FOLDER });
        await expect(target<{
          initialization_hash: string;
          command_id: string;
          command_hash: string;
          applied_revision: string | null;
        }[]>`select initialization_hash, command_id, command_hash, applied_revision::text
             from regional_simulation_command_receipts
             where world_id = ${worldId} and region_id = 'legacy'
             order by command_id`).resolves.toEqual([
          {
            initialization_hash: initializationHash,
            command_id: "legacy-command-1",
            command_hash: "1".repeat(64),
            applied_revision: null,
          },
          {
            initialization_hash: initializationHash,
            command_id: "legacy-command-2",
            command_hash: "2".repeat(64),
            applied_revision: null,
          },
        ]);

        await target`update regional_simulation_states
          set state = jsonb_set(
                state,
                '{commandReceipts,legacy-command-3}',
                to_jsonb(${"3".repeat(64)}::text),
                true
              ),
              state_hash = ${"e".repeat(64)}, revision = 3, publisher_sequence = 3,
              updated_at = '1970-01-01T00:00:03Z'
          where world_id = ${worldId} and region_id = 'legacy'`;
        const [captured] = await target<{ receipt_count: number }[]>`
          select count(*)::int as receipt_count
          from regional_simulation_command_receipts
          where world_id = ${worldId} and region_id = 'legacy'
            and initialization_hash = ${initializationHash}`;
        expect(captured?.receipt_count).toBe(3);

        await expect(target`update regional_simulation_states
          set initialization_hash = ${"b".repeat(64)}
          where world_id = ${worldId} and region_id = 'legacy'`)
          .rejects.toMatchObject({
            message: expect.stringContaining("operational initialization binding is immutable"),
          });

        await target`delete from regional_simulation_states
          where world_id = ${worldId} and region_id = 'legacy'`;
        const [afterDelete] = await target<{ receipt_count: number }[]>`
          select count(*)::int as receipt_count
          from regional_simulation_command_receipts where world_id = ${worldId}`;
        expect(afterDelete?.receipt_count).toBe(0);
      });

      await withTemporaryDatabase("receipt_ledger_fail", async (target) => {
        const targetDb = drizzle(target);
        const worldId = "00000000-0000-4000-8000-000000000036";
        await migrate(targetDb, { migrationsFolder: schema32Folder });
        await target`insert into worlds (id, name, schedule_period_weeks, epoch)
          values (${worldId}, 'PG incomplete receipt history', 4, '1970-01-01T00:00:00Z')`;
        await target`insert into regional_simulation_states
          (world_id, region_id, state_schema, state, initialization_hash, state_hash,
           revision, publisher_sequence, created_at, updated_at)
          values (
            ${worldId}, 'legacy', 'zugfolge-operational-simulation-state/v2',
            jsonb_build_object(
              'initializationHash', ${initializationHash}::text,
              'commandReceipts', jsonb_build_object(
                'legacy-command-1', ${"1".repeat(64)}::text,
                'legacy-command-2', ${"2".repeat(64)}::text
              )
            ),
            ${initializationHash}, ${"f".repeat(64)}, 3, 3,
            '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'
          )`;
        await expect(migrate(targetDb, { migrationsFolder: MIGRATIONS_FOLDER }))
          .rejects.toThrow(/cannot establish complete operational command receipt ledger/u);
        const [ledger] = await target<{ migration_count: number }[]>`
          select count(*)::int as migration_count from drizzle.__drizzle_migrations`;
        expect(ledger?.migration_count).toBe(32);
        const [receiptTable] = await target<{ receipt_table: string | null }[]>`
          select to_regclass('public.regional_simulation_command_receipts')::text as receipt_table`;
        expect(receiptTable?.receipt_table).toBeNull();
      });
    } finally {
      await rm(schema32Folder, { recursive: true, force: true });
    }
  }, 60_000);

  it("archives a running alpha profile only through the guarded closing transition", async () => {
    const worldId = randomUUID();
    await db.insert(worlds).values({
      id: worldId,
      name: "PG atomic cutover lifecycle",
      epoch: new Date("2026-08-25T00:00:00Z"),
      schedulePeriodWeeks: 4,
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
    await db.insert(alphaWorldProfiles).values({
      worldId,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 2026082501n,
      accelerationFactor: 1,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: { schemaVersion: "zugfolge-alpha-world-blueprint/v2" },
      blueprintHash: "e".repeat(64),
      deploymentHash: "f".repeat(64),
      periodCount: 6,
      state: "running",
      startedAtS: 0,
    });

    await expect(client`update alpha_world_profiles
      set state = 'archived', final_state_hash = ${"9".repeat(64)}
      where world_id = ${worldId}`)
      .rejects.toMatchObject({ message: expect.stringContaining("alpha world final state hash requires the guarded closing transition") });
    await client.begin("isolation level serializable", async (tx) => {
      const closing = await tx<{ state: string }[]>`
        update alpha_world_profiles set state = 'closing'
        where world_id = ${worldId} and state = 'running'
        returning state`;
      expect(closing).toEqual([{ state: "closing" }]);
      const archived = await tx<{ state: string }[]>`
        update alpha_world_profiles set state = 'archived', final_state_hash = ${"9".repeat(64)}
        where world_id = ${worldId} and state = 'closing'
        returning state`;
      expect(archived).toEqual([{ state: "archived" }]);
    });
    await expect(db.select({ state: alphaWorldProfiles.state }).from(alphaWorldProfiles)
      .where(eq(alphaWorldProfiles.worldId, worldId))).resolves.toEqual([{ state: "archived" }]);
    await expect(client`update alpha_world_profiles set final_state_hash = ${"8".repeat(64)} where world_id = ${worldId}`)
      .rejects.toMatchObject({ message: expect.stringContaining("final state hash is immutable") });

    await expect(client`delete from alpha_world_profiles where world_id = ${worldId}`)
      .rejects.toMatchObject({ message: expect.stringContaining("started alpha world profile is immutable") });
  });

  it("keeps only v1 writes compatible and rejects a v2-to-v1 downgrade", async () => {
    const legacyWorldId = "00000000-0000-4000-8000-000000000030";
    await client`delete from regional_simulation_states where world_id = ${legacyWorldId}`;
    await client`delete from worlds where id = ${legacyWorldId}`;
    await client`insert into worlds (id, name, schedule_period_weeks, epoch)
      values (${legacyWorldId}, 'PG rollback window', 4, '1970-01-01T00:00:00Z')`;
    await client`insert into regional_simulation_states
      (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
      values (${legacyWorldId}, 'legacy', 'zugfolge-regional-simulation-state/v1', '{}', ${"a".repeat(64)}, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;

    await expect(client`update regional_simulation_states
      set state_schema = 'zugfolge-regional-simulation-state/v1',
          state = '{"legacyWorkerAdvanced":true}', revision = revision + 1,
          publisher_sequence = publisher_sequence + 1, updated_at = '1970-01-01T00:01:00Z'
      where world_id = ${legacyWorldId} and region_id = 'legacy'`).resolves.toBeDefined();
    const [legacy] = await client<{ initialization_hash: string | null; revision: string }[]>`
      select initialization_hash, revision from regional_simulation_states
      where world_id = ${legacyWorldId} and region_id = 'legacy'`;
    expect(legacy).toEqual({ initialization_hash: null, revision: "1" });

    await client`insert into regional_simulation_states
      (world_id, region_id, state_schema, state, initialization_hash, state_hash, revision, publisher_sequence, created_at, updated_at)
      values (${legacyWorldId}, 'v2', 'zugfolge-operational-simulation-state/v2', '{}', ${"b".repeat(64)}, ${"c".repeat(64)}, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;
    await expect(client`update regional_simulation_states
      set state_schema = 'zugfolge-regional-simulation-state/v1',
          state = '{"oldWorkerTriedToDowngrade":true}', revision = revision + 1,
          publisher_sequence = publisher_sequence + 1, updated_at = '1970-01-01T00:01:00Z'
      where world_id = ${legacyWorldId} and region_id = 'v2'`).rejects.toMatchObject({
      code: "P0001",
      message: expect.stringContaining("operational initialization binding is immutable"),
    });

    await client`delete from regional_simulation_states where world_id = ${legacyWorldId}`;
    await client`delete from worlds where id = ${legacyWorldId}`;
  });

  it("wartet auf einen offenen Writer, nimmt seinen Commit in den Cutover-Kopf auf und fenced spaetere Writes", async () => {
    const legacyWorldId = randomUUID();
    const accountId = randomUUID();
    await client`insert into worlds (id, name, schedule_period_weeks, epoch)
      values (${legacyWorldId}, 'PG stale writer fence', 4, '1970-01-01T00:00:00Z')`;
    await client`insert into accounts (id, world_id, keycloak_subject, display_name)
      values (${accountId}, ${legacyWorldId}, 'writer-fence', 'Before writer')`;
    await client`insert into regional_simulation_states
      (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
      values (${legacyWorldId}, 'legacy', 'zugfolge-regional-simulation-state/v1', '{}', ${"a".repeat(64)}, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;

    const openWriter = postgres(databaseUrl!, { max: 1 });
    const cutoverWriter = postgres(databaseUrl!, { max: 1 });
    let signalWriterReady!: () => void;
    let releaseOpenWriter!: () => void;
    let signalCutoverRequested!: () => void;
    const writerReady = new Promise<void>((resolve) => { signalWriterReady = resolve; });
    const writerRelease = new Promise<void>((resolve) => { releaseOpenWriter = resolve; });
    const cutoverRequested = new Promise<void>((resolve) => { signalCutoverRequested = resolve; });
    try {
      const [cutoverBackend] = await cutoverWriter<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      if (cutoverBackend === undefined) throw new Error("Cutover-Backend besitzt keine PID.");
      const cutoverPid = cutoverBackend.pid;
      const openAttempt = openWriter.begin("isolation level read committed", async (tx) => {
        await tx`update accounts set display_name = 'Committed before cutover receipt'
          where id = ${accountId} and world_id = ${legacyWorldId}`;
        signalWriterReady();
        await writerRelease;
      });
      await writerReady;

      let cutoverAcquired = false;
      const cutoverAttempt = cutoverWriter.begin("isolation level read committed", async (tx) => {
        signalCutoverRequested();
        await tx`select pg_advisory_xact_lock(
          ('x' || substr(md5(${legacyWorldId}::uuid::text), 1, 16))::bit(64)::bigint
        )`;
        cutoverAcquired = true;
        const [included] = await tx<{ display_name: string }[]>`
          select display_name from accounts where id = ${accountId} and world_id = ${legacyWorldId}`;
        expect(included?.display_name).toBe("Committed before cutover receipt");
        await tx`update worlds set lifecycle_status = 'archived' where id = ${legacyWorldId}`;
        await tx`update regional_simulation_states set legacy_writer_fenced = true
          where world_id = ${legacyWorldId} and region_id = 'legacy'`;
      });
      await cutoverRequested;
      await waitForAdvisoryLockWait(client, cutoverPid);
      expect(cutoverAcquired).toBe(false);

      releaseOpenWriter();
      await openAttempt;
      await cutoverAttempt;
      expect(cutoverAcquired).toBe(true);

      await expect(openWriter`update accounts set display_name = 'Retried old writer'
        where id = ${accountId} and world_id = ${legacyWorldId}`).rejects.toMatchObject({
        message: expect.stringContaining("world writer is fenced"),
      });
      await expect(openWriter`delete from accounts
        where id = ${accountId} and world_id = ${legacyWorldId}`).rejects.toMatchObject({
        message: expect.stringContaining("world writer is fenced"),
      });
    } finally {
      releaseOpenWriter();
      await openWriter.end();
      await cutoverWriter.end();
    }
  }, 30_000);

  it("sieht nach dem triggerinternen Exclusive-Lock einen gerade committeten Economy-Outbox-Writer", async () => {
    const worldId = randomUUID();
    await client`insert into worlds (id, name, schedule_period_weeks, epoch)
      values (${worldId}, 'PG archive outbox race', 4, '1970-01-01T00:00:00Z')`;

    const openWriter = postgres(databaseUrl!, { max: 1 });
    const archiver = postgres(databaseUrl!, { max: 1 });
    let signalWriterReady!: () => void;
    let releaseOpenWriter!: () => void;
    const writerReady = new Promise<void>((resolve) => { signalWriterReady = resolve; });
    const writerRelease = new Promise<void>((resolve) => { releaseOpenWriter = resolve; });
    try {
      const [archiveBackend] = await archiver<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      if (archiveBackend === undefined) throw new Error("Archivierungs-Backend besitzt keine PID.");
      const openAttempt = openWriter.begin("isolation level read committed", async (tx) => {
        await tx`insert into economy_outbox
          (world_id, effect_id, effect_type, payload, occurred_at, enqueued_at)
          values (${worldId}, 'trigger-snapshot-race', 'journal', '{}',
            '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;
        signalWriterReady();
        await writerRelease;
      });
      await writerReady;

      const archiveAttempt = Promise.resolve(
        archiver`update worlds set lifecycle_status = 'archived' where id = ${worldId}`,
      );
      await waitForAdvisoryLockWait(client, archiveBackend.pid);
      releaseOpenWriter();
      await openAttempt;
      await expect(archiveAttempt).rejects.toMatchObject({
        message: expect.stringContaining("pending economy outbox"),
      });
      await expect(client<{ lifecycle_status: string }[]>`
        select lifecycle_status from worlds where id = ${worldId}`)
        .resolves.toEqual([{ lifecycle_status: "active" }]);

      await client`delete from economy_outbox where world_id = ${worldId}`;
      await client`delete from worlds where id = ${worldId}`;
    } finally {
      releaseOpenWriter();
      await openWriter.end();
      await archiver.end();
    }
  }, 30_000);

  it("sieht nach dem triggerinternen Exclusive-Lock eine gerade committete Odoo-Projektion", async () => {
    const worldId = randomUUID();
    await client`insert into worlds (id, name, schedule_period_weeks, epoch)
      values (${worldId}, 'PG archive Odoo outbox race', 4, '1970-01-01T00:00:00Z')`;

    const openWriter = postgres(databaseUrl!, { max: 1 });
    const archiver = postgres(databaseUrl!, { max: 1 });
    let signalWriterReady!: () => void;
    let releaseOpenWriter!: () => void;
    const writerReady = new Promise<void>((resolve) => { signalWriterReady = resolve; });
    const writerRelease = new Promise<void>((resolve) => { releaseOpenWriter = resolve; });
    try {
      const [archiveBackend] = await archiver<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      if (archiveBackend === undefined) throw new Error("Archivierungs-Backend besitzt keine PID.");
      const openAttempt = openWriter.begin("isolation level read committed", async (tx) => {
        await tx`insert into odoo_projection_outbox
          (world_id, message_type, schema_version, correlation_id, payload, occurred_at, enqueued_at)
          values (${worldId}, 'archive-race', 'zugfolge-odoo/v1', 'archive-race', '{}',
            '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;
        signalWriterReady();
        await writerRelease;
      });
      await writerReady;

      const archiveAttempt = Promise.resolve(
        archiver`update worlds set lifecycle_status = 'archived' where id = ${worldId}`,
      );
      await waitForAdvisoryLockWait(client, archiveBackend.pid);
      releaseOpenWriter();
      await openAttempt;
      await expect(archiveAttempt).rejects.toMatchObject({
        message: expect.stringContaining("pending odoo projection outbox"),
      });
      await expect(client<{ lifecycle_status: string }[]>`
        select lifecycle_status from worlds where id = ${worldId}`)
        .resolves.toEqual([{ lifecycle_status: "active" }]);

      await client`update odoo_projection_outbox
        set delivered_at = '1970-01-01T00:01:00Z'
        where world_id = ${worldId} and correlation_id = 'archive-race'`;
      await client`delete from odoo_projection_outbox where world_id = ${worldId}`;
      await client`delete from worlds where id = ${worldId}`;
    } finally {
      releaseOpenWriter();
      await openWriter.end();
      await archiver.end();
    }
  }, 30_000);

  it("sieht nach dem triggerinternen Shared-Lock die inzwischen archivierte Lifecycle-Version", async () => {
    const worldId = randomUUID();
    const accountId = randomUUID();
    await client`insert into worlds (id, name, schedule_period_weeks, epoch)
      values (${worldId}, 'PG archived lifecycle race', 4, '1970-01-01T00:00:00Z')`;
    await client`insert into accounts (id, world_id, keycloak_subject, display_name)
      values (${accountId}, ${worldId}, 'archived-lifecycle-race', 'Before archive')`;

    const archiver = postgres(databaseUrl!, { max: 1 });
    const waitingWriter = postgres(databaseUrl!, { max: 1 });
    let signalArchiveReady!: () => void;
    let releaseArchive!: () => void;
    const archiveReady = new Promise<void>((resolve) => { signalArchiveReady = resolve; });
    const archiveRelease = new Promise<void>((resolve) => { releaseArchive = resolve; });
    try {
      const [writerBackend] = await waitingWriter<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      if (writerBackend === undefined) throw new Error("Writer-Backend besitzt keine PID.");
      const archiveAttempt = archiver.begin("isolation level read committed", async (tx) => {
        await tx`update worlds set lifecycle_status = 'archived' where id = ${worldId}`;
        signalArchiveReady();
        await archiveRelease;
      });
      await archiveReady;

      const writerAttempt = Promise.resolve(
        waitingWriter`update accounts set display_name = 'Stale writer'
          where id = ${accountId} and world_id = ${worldId}`,
      );
      await waitForAdvisoryLockWait(client, writerBackend.pid);
      releaseArchive();
      await archiveAttempt;
      await expect(writerAttempt).rejects.toMatchObject({
        message: expect.stringContaining("world writer is fenced"),
      });
      await expect(client<{ display_name: string }[]>`
        select display_name from accounts where id = ${accountId} and world_id = ${worldId}`)
        .resolves.toEqual([{ display_name: "Before archive" }]);
    } finally {
      releaseArchive();
      await archiver.end();
      await waitingWriter.end();
    }
  }, 30_000);

  it("installiert den Schema-32-Guard vor Schema 33 erst nach offenen Economy-, Odoo- und Lifecycle-Writern", async () => {
    const schema31Folder = await schema31MigrationsFolder();
    const scenarios = [
      {
        purpose: "guard_economy_writer",
        kind: "economy-writer",
        initialLifecycle: "archived",
        expectedError: /archived world with pending economy outbox/u,
      },
      {
        purpose: "guard_odoo_writer",
        kind: "odoo-writer",
        initialLifecycle: "archived",
        expectedError: /archived world with pending odoo projection outbox/u,
      },
      {
        purpose: "guard_lifecycle_writer",
        kind: "lifecycle-writer",
        initialLifecycle: "active",
        expectedError: /archived world with pending economy outbox/u,
      },
    ] as const;

    try {
      for (const scenario of scenarios) {
        await withTemporaryDatabase(scenario.purpose, async (target, targetUrl) => {
          await migrate(drizzle(target), { migrationsFolder: schema31Folder });
          const worldId = randomUUID();
          await target`insert into worlds (id, name, schedule_period_weeks, epoch, lifecycle_status)
            values (${worldId}, ${`PG schema 32 ${scenario.kind}`}, 4,
              '1970-01-01T00:00:00Z', ${scenario.initialLifecycle})`;

          if (scenario.kind === "lifecycle-writer") {
            await target`insert into economy_outbox
              (world_id, effect_id, effect_type, payload, occurred_at, enqueued_at)
              values (${worldId}, 'migration-race', 'journal', '{}',
                '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;
          }

          const openWriter = postgres(targetUrl, { max: 1 });
          const migratingClient = postgres(targetUrl, { max: 1 });
          let signalWriterReady!: () => void;
          let releaseOpenWriter!: () => void;
          const writerReady = new Promise<void>((resolve) => { signalWriterReady = resolve; });
          const writerRelease = new Promise<void>((resolve) => { releaseOpenWriter = resolve; });
          try {
            const [migrationBackend] = await migratingClient<{ pid: number }[]>`
              select pg_backend_pid()::int as pid`;
            if (migrationBackend === undefined) throw new Error("Migrations-Backend besitzt keine PID.");

            const writerAttempt = openWriter.begin("isolation level read committed", async (tx) => {
              if (scenario.kind === "economy-writer") {
                await tx`insert into economy_outbox
                  (world_id, effect_id, effect_type, payload, occurred_at, enqueued_at)
                  values (${worldId}, 'migration-race', 'journal', '{}',
                    '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;
              } else if (scenario.kind === "odoo-writer") {
                await tx`insert into odoo_projection_outbox
                  (world_id, message_type, schema_version, correlation_id, payload, occurred_at, enqueued_at)
                  values (${worldId}, 'migration-race', 'zugfolge-odoo/v1', 'migration-race', '{}',
                    '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;
              } else {
                await tx`update worlds set lifecycle_status = 'archived' where id = ${worldId}`;
              }
              signalWriterReady();
              await writerRelease;
            });
            await writerReady;

            const migrationAttempt = migrate(drizzle(migratingClient), { migrationsFolder: MIGRATIONS_FOLDER });
            const migrationRejection = expect(migrationAttempt).rejects.toThrow(scenario.expectedError);
            await waitForWorldGuardInstallLockWait(target, migrationBackend.pid);

            releaseOpenWriter();
            await writerAttempt;
            await migrationRejection;
            const [failedLedger] = await target<{ migration_count: number }[]>`
              select count(*)::int as migration_count from drizzle.__drizzle_migrations`;
            expect(failedLedger?.migration_count).toBe(31);

            if (scenario.kind === "odoo-writer") {
              await target`update odoo_projection_outbox
                set delivered_at = '1970-01-01T00:01:00Z'
                where world_id = ${worldId} and correlation_id = 'migration-race'`;
            } else {
              await target`update economy_outbox
                set processed_at = '1970-01-01T00:01:00Z'
                where world_id = ${worldId} and effect_id = 'migration-race'`;
            }
            await migrate(drizzle(migratingClient), { migrationsFolder: MIGRATIONS_FOLDER });
            const [successfulLedger] = await target<{ migration_count: number }[]>`
              select count(*)::int as migration_count from drizzle.__drizzle_migrations`;
            expect(successfulLedger?.migration_count).toBe(EXPECTED_SCHEMA_MIGRATIONS);
          } finally {
            releaseOpenWriter();
            await openWriter.end();
            await migratingClient.end();
          }
        });
      }
    } finally {
      await rm(schema31Folder, { recursive: true, force: true });
    }
  }, 180_000);

  it("migrates a real PostgreSQL schema 28 atomically and preserves the exact old-worker write", async () => {
    const schema28Folder = await schema28MigrationsFolder();
    try {
      await withTemporaryDatabase("rollback_ok", async (target) => {
        const targetDb = drizzle(target);
        await migrate(targetDb, { migrationsFolder: schema28Folder });
        const legacyWorldId = "00000000-0000-4000-8000-000000000032";
        await target`insert into worlds (id, name, schedule_period_weeks, epoch)
          values (${legacyWorldId}, 'PG schema 28', 4, '1970-01-01T00:00:00Z')`;
        await target`insert into regional_simulation_states
          (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
          values (${legacyWorldId}, 'legacy', 'zugfolge-regional-simulation-state/v1', '{}', ${"a".repeat(64)}, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;

        await migrate(targetDb, { migrationsFolder: MIGRATIONS_FOLDER });
        await expect(target`update regional_simulation_states
          set state_schema = 'zugfolge-regional-simulation-state/v1',
              state = '{"legacyWorkerAdvanced":true}', state_hash = ${"b".repeat(64)},
              revision = revision + 1, publisher_sequence = publisher_sequence + 1,
              updated_at = '1970-01-01T00:01:00Z'
          where world_id = ${legacyWorldId} and region_id = 'legacy'`).resolves.toBeDefined();
        const [legacy] = await target<{ initialization_hash: string | null; revision: string; state_hash: string }[]>`
          select initialization_hash, revision, state_hash from regional_simulation_states
          where world_id = ${legacyWorldId} and region_id = 'legacy'`;
        expect(legacy).toEqual({
          initialization_hash: null,
          revision: "1",
          state_hash: "b".repeat(64),
        });
        const [ledger] = await target<{ migration_count: number }[]>`
          select count(*)::int as migration_count from drizzle.__drizzle_migrations`;
        expect(ledger?.migration_count).toBe(EXPECTED_SCHEMA_MIGRATIONS);
      });

      await withTemporaryDatabase("rollback_fail", async (target) => {
        const targetDb = drizzle(target);
        await migrate(targetDb, { migrationsFolder: schema28Folder });
        const incompatibleWorldId = "00000000-0000-4000-8000-000000000033";
        await target`insert into worlds (id, name, schedule_period_weeks, epoch)
          values (${incompatibleWorldId}, 'PG incompatible', 4, '1970-01-01T00:00:00Z')`;
        await target`insert into regional_simulation_states
          (world_id, region_id, state_schema, state, state_hash, revision, publisher_sequence, created_at, updated_at)
          values (${incompatibleWorldId}, 'unknown', 'zugfolge-regional-simulation-state/v3', '{}', ${"c".repeat(64)}, 0, 0, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')`;

        await expect(migrate(targetDb, { migrationsFolder: MIGRATIONS_FOLDER })).rejects.toThrow();
        const [ledger] = await target<{ migration_count: number }[]>`
          select count(*)::int as migration_count from drizzle.__drizzle_migrations`;
        expect(ledger?.migration_count).toBe(28);
        const [column] = await target<{ column_count: number }[]>`
          select count(*)::int as column_count
          from information_schema.columns
          where table_schema = 'public' and table_name = 'regional_simulation_states'
            and column_name = 'initialization_hash'`;
        expect(column?.column_count).toBe(0);
      });
    } finally {
      await rm(schema28Folder, { recursive: true, force: true });
    }
  }, 120_000);
});
