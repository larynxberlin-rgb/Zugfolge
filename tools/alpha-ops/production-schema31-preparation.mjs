import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertProductionColdBackupReceiptUnchanged,
  inspectColdDatabase,
  inspectFilestoreTree,
  readProductionColdBackupReceipt,
  runningServicesFromDockerSocket,
  validateRunningServices,
} from "./production-cold-backup.mjs";
import {
  assertProductionSchema29RuntimeDrillReceiptUnchanged,
  readProductionSchema29RuntimeDrillReceipt,
} from "./production-schema29-runtime-drill.mjs";

const INITIAL_MIGRATION_COUNT = 29;
const TARGET_MIGRATION_COUNT = 31;
const RECEIPT_SCHEMA = "zugfolge-production-schema31-preparation/v1";
const LEGACY_PROBE_SCHEMA = "zugfolge-legacy-schema31-write-probe/v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const MIGRATIONS_FOLDER = new URL("../../packages/db/drizzle/", import.meta.url);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

function sameValue(left, right) {
  return JSON.stringify(sortedValue(left)) === JSON.stringify(sortedValue(right));
}

async function expectedMigrationLedger(count) {
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", MIGRATIONS_FOLDER), "utf8"));
  invariant(Array.isArray(journal.entries) && journal.entries.length === 33, "Das digestgebundene Image besitzt nicht exakt den Schema-33-Journalvertrag.");
  invariant(journal.entries[28]?.tag === "0029_operational_initialization_binding", "Migrationskopf 29 ist nicht kanonisch.");
  invariant(journal.entries[29]?.tag === "0030_legacy_runtime_rollback_window", "Migration 0030 fehlt oder steht an falscher Position.");
  invariant(journal.entries[30]?.tag === "0031_database_bound_cutover_receipts", "Migration 0031 fehlt oder steht an falscher Position.");
  invariant(journal.entries[31]?.tag === "0032_world_writer_guard", "Migration 0032 fehlt oder steht an falscher Position.");
  invariant(journal.entries[32]?.tag === "0033_operational_command_receipt_ledger", "Migration 0033 fehlt oder steht an falscher Position.");
  const entries = journal.entries.slice(0, count);
  return Promise.all(entries.map(async (entry) => ({
    createdAt: String(entry.when),
    hash: createHash("sha256").update(await readFile(new URL(`${entry.tag}.sql`, MIGRATIONS_FOLDER), "utf8")).digest("hex"),
  })));
}

async function assertExactMigrationHead(snapshot, count) {
  const expected = await expectedMigrationLedger(count);
  invariant(snapshot.state.migrationLedger.length === count, `Game-Datenbank ist nicht exakt Schema ${count}.`);
  invariant(
    sameValue(snapshot.state.migrationLedger.map(({ hash, createdAt }) => ({ hash, createdAt })), expected),
    `Game-Migrationsledger weicht vom digestgebundenen Schema-${count}-Vertrag ab.`,
  );
}

function normalizedSchema31State(state) {
  return {
    ...state,
    databaseIdentity: null,
    tables: state.tables.filter(({ schema, table }) => !(schema === "public" && table === "zugfolge_database_identity")),
  };
}

async function migrateDatabaseToSchema31(databaseUrl) {
  const folder = await mkdtemp(join(tmpdir(), "zugfolge-schema31-migrations-"));
  const meta = join(folder, "meta");
  await mkdir(meta);
  try {
    const journal = JSON.parse(await readFile(new URL("meta/_journal.json", MIGRATIONS_FOLDER), "utf8"));
    const entries = journal.entries.slice(0, TARGET_MIGRATION_COUNT);
    invariant(entries.length === TARGET_MIGRATION_COUNT && entries.at(-1)?.tag === "0031_database_bound_cutover_receipts", "Schema-31-Teiljournal ist nicht kanonisch.");
    await writeFile(join(meta, "_journal.json"), `${JSON.stringify({ ...journal, entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await Promise.all(entries.map(({ tag }) => copyFile(new URL(`${tag}.sql`, MIGRATIONS_FOLDER), join(folder, `${tag}.sql`))));
    const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
    const postgresModule = requireFromDb("postgres");
    const postgres = postgresModule.default ?? postgresModule;
    const { drizzle } = requireFromDb("drizzle-orm/postgres-js");
    const { migrate } = requireFromDb("drizzle-orm/postgres-js/migrator");
    const client = postgres(databaseUrl, { max: 1, connect_timeout: 15, idle_timeout: 5 });
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
    } finally {
      await client.end({ timeout: 5 });
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function inspectPostSchema31Markers(databaseUrl) {
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const postgresModule = requireFromDb("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 15, idle_timeout: 5 });
  try {
    const rows = await client.unsafe(`
      select
        (select count(*)::int from pg_trigger where not tgisinternal and tgname like 'zugfolge_world_guard_%') as writer_guard_count,
        to_regprocedure('zugfolge_enforce_world_writer_guard()') is not null as writer_guard_function_present,
        to_regclass('public.regional_simulation_command_receipts') is not null as command_receipt_ledger_present,
        to_regprocedure('zugfolge_capture_operational_command_receipts()') is not null as command_receipt_capture_function_present,
        to_regprocedure('zugfolge_enforce_operational_initialization_immutability()') is not null as operational_initialization_immutability_function_present,
        exists (
          select 1 from pg_trigger
          where not tgisinternal
            and tgname = 'zugfolge_enforce_operational_initialization_immutability'
        ) as operational_initialization_immutability_trigger_present
    `);
    invariant(rows.length === 1, "Schema-32/33-Marker konnten nicht gelesen werden.");
    return rows[0];
  } finally {
    await client.end({ timeout: 5 });
  }
}

export function validatePreSchema33MarkersAbsent(markers) {
  invariant(markers !== null && typeof markers === "object" && !Array.isArray(markers), "Schema-32/33-Markerinventar fehlt.");
  invariant(
    markers.writer_guard_count === 0
      && markers.writer_guard_function_present === false
      && markers.command_receipt_ledger_present === false
      && markers.command_receipt_capture_function_present === false
      && markers.operational_initialization_immutability_function_present === false
      && markers.operational_initialization_immutability_trigger_present === false,
    "Schema 32/33 ist vor seinem kalten Gate bereits teilweise vorhanden.",
  );
  return markers;
}

async function stableJson(path, label) {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  invariant(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= 4_194_304n, `${label} ist keine sichere JSON-Datei.`);
  const bytes = await readFile(absolute);
  const after = await lstat(absolute, { bigint: true });
  invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs, `${label} aenderte sich beim Lesen.`);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} ist kein gueltiges JSON.`); }
  return { absolute, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), value };
}

async function publishCreateNew(path, value) {
  const absolute = resolve(path);
  const parentStatus = await lstat(dirname(absolute));
  invariant(parentStatus.isDirectory() && !parentStatus.isSymbolicLink(), "Schema-31-Evidence-Wurzel ist unsicher.");
  const temporary = join(dirname(absolute), `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let linked = false;
  try {
    await handle.writeFile(`${JSON.stringify(sortedValue(value), null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await link(temporary, absolute);
    linked = true;
    await unlink(temporary);
  } catch (error) {
    try { await handle.close(); } catch { /* ursprünglicher Fehler bleibt maßgeblich */ }
    if (linked) { try { await unlink(absolute); } catch { /* nur eigene Datei */ } }
    try { await unlink(temporary); } catch { /* ursprünglicher Fehler bleibt maßgeblich */ }
    throw error;
  }
}

function validateLegacyProbe(value, expected) {
  invariant(value?.schema === LEGACY_PROBE_SCHEMA && value.recoveryId === expected.recoveryId, "Legacy-Schreibprobe gehoert nicht zur Recovery.");
  invariant(value.previousWorldId === expected.previousWorldId && value.legacyImageDigest === expected.legacyImageDigest, "Legacy-Schreibprobe bindet nicht Welt und attestierten Runtime-Digest.");
  invariant(value.migrationCount === TARGET_MIGRATION_COUNT && UUID.test(value.databaseIdentity) && value.databaseIdentity === expected.databaseIdentity, "Legacy-Schreibprobe bindet nicht die Schema-31-Live-Datenbank.");
  invariant(value.rolledBack === true && value.beforeUpdatedAt === value.afterUpdatedAt && value.transientUpdatedAt !== value.beforeUpdatedAt, "Legacy-Schreibprobe belegt keinen vollstaendig zurueckgerollten Schreibzugriff.");
  const { receiptHash, ...payload } = value;
  invariant(SHA256.test(receiptHash) && receiptHash === canonicalSha256(payload), "Legacy-Schreibprobe besitzt keinen kanonischen Hash.");
  return value;
}

function environmentContract(environment) {
  const recoveryId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID");
  invariant(SAFE_ID.test(recoveryId), "PRODUCTION_RECOVERY_ID ist nicht kanonisch.");
  return {
    recoveryId,
    candidateReleaseId: requiredEnvironment(environment, "PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID"),
    previousReleaseId: requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID"),
    previousWorldId: requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID"),
    legacyImageDigest: requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST"),
    legacyOdooImageDigest: requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST"),
    gameUrl: requiredEnvironment(environment, "DATABASE_URL"),
    gameRestoreUrl: requiredEnvironment(environment, "PRODUCTION_SCHEMA29_GAME_RESTORED_DATABASE_URL"),
    odooUrl: requiredEnvironment(environment, "ODOO_DATABASE_URL"),
    odooRestoreUrl: requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_RESTORED_DATABASE_URL"),
    liveFilestorePath: requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_LIVE_FILESTORE_PATH"),
    restoredFilestorePath: requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH"),
    baselineReceiptPath: requiredEnvironment(environment, "PRODUCTION_SCHEMA29_COLD_RECEIPT_PATH"),
    runtimeReceiptPath: requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_RECEIPT_PATH"),
    legacyProbePath: requiredEnvironment(environment, "PRODUCTION_SCHEMA31_LEGACY_PROBE_PATH"),
    receiptOutputPath: requiredEnvironment(environment, "PRODUCTION_SCHEMA31_RECEIPT_OUTPUT_PATH"),
    dockerProject: requiredEnvironment(environment, "PRODUCTION_RECOVERY_DOCKER_PROJECT"),
  };
}

export async function prepareGameSchema31({
  environment = process.env,
  inspectDatabase = inspectColdDatabase,
  inspectRunningServices = runningServicesFromDockerSocket,
  inspectFilestore = inspectFilestoreTree,
  inspectMarkers = inspectPostSchema31Markers,
  migrateDatabase = migrateDatabaseToSchema31,
} = {}) {
  const expected = environmentContract(environment);
  const { artifact: baselineArtifact, receipt: baseline } = await readProductionColdBackupReceipt(expected.baselineReceiptPath, {
    recoveryId: expected.recoveryId,
    candidateReleaseId: expected.candidateReleaseId,
    previousReleaseId: expected.previousReleaseId,
    migrationCount: INITIAL_MIGRATION_COUNT,
  });
  const { artifact: runtimeArtifact } = await readProductionSchema29RuntimeDrillReceipt(expected.runtimeReceiptPath, {
    recoveryId: expected.recoveryId,
    candidateReleaseId: expected.candidateReleaseId,
    previousReleaseId: expected.previousReleaseId,
    previousWorldId: expected.previousWorldId,
    baselineReceiptHash: baseline.receiptHash,
    baselineReceiptSha256: baselineArtifact.sha256,
    gameImageDigest: expected.legacyImageDigest,
    odooImageDigest: expected.legacyOdooImageDigest,
  });
  const [services, odooSource, odooRestored, liveFilestore, restoredFilestore] = await Promise.all([
    inspectRunningServices(expected.dockerProject, environment).then(validateRunningServices),
    inspectDatabase(expected.odooUrl, { game: false }),
    inspectDatabase(expected.odooRestoreUrl, { game: false }),
    inspectFilestore(expected.liveFilestorePath),
    inspectFilestore(expected.restoredFilestorePath),
  ]);
  invariant(services.length === 4, "Schema-31-Vorbereitung besitzt kein writerfreies Vier-Datenbankinventar.");
  invariant(odooSource.endpointSha256 === baseline.odoo.endpointSha256 && odooSource.backendSha256 === baseline.odoo.backendSha256 && odooSource.stateSha256 === baseline.odoo.stateSha256, "Odoo-Live-Datenbank wich nach dem Schema-29-Vollrestore ab.");
  invariant(odooRestored.endpointSha256 === baseline.odoo.restoreEndpointSha256 && odooRestored.stateSha256 === baseline.odoo.stateSha256, "Isolierter Odoo-Restore wich nach dem Schema-29-Vollrestore ab.");
  invariant(liveFilestore.treeSha256 === baseline.odoo.filestoreTreeSha256 && restoredFilestore.treeSha256 === baseline.odoo.filestoreTreeSha256, "Odoo-Filestore-Paar wich nach dem Schema-29-Vollrestore ab.");

  let live = await inspectDatabase(expected.gameUrl, { game: true });
  let restored = await inspectDatabase(expected.gameRestoreUrl, { game: true });
  invariant(live.endpointSha256 === baseline.game.endpointSha256 && live.backendSha256 === baseline.game.backendSha256, "Schema-31-Liveziel ist nicht die belegte Schema-29-Datenbank.");
  invariant(restored.endpointSha256 === baseline.game.restoreEndpointSha256 && restored.backendSha256 === baseline.game.restoreBackendSha256, "Schema-31-Pruefziel ist nicht der belegte isolierte Schema-29-Restore.");

  for (const [label, snapshot] of [["Live", live], ["Restore", restored]]) {
    const count = snapshot.state.migrationLedger.length;
    invariant(count === INITIAL_MIGRATION_COUNT || count === TARGET_MIGRATION_COUNT, `${label}-Datenbank steht weder auf Schema 29 noch 31.`);
    await assertExactMigrationHead(snapshot, count);
    if (count === INITIAL_MIGRATION_COUNT) {
      invariant(snapshot.stateSha256 === baseline.game.stateSha256, `${label}-Schema-29-Datenbank wich vom kalten Ausgangsrestore ab.`);
    }
  }
  if (live.state.migrationLedger.length === INITIAL_MIGRATION_COUNT) await migrateDatabase(expected.gameUrl);
  if (restored.state.migrationLedger.length === INITIAL_MIGRATION_COUNT) await migrateDatabase(expected.gameRestoreUrl);

  [live, restored] = await Promise.all([
    inspectDatabase(expected.gameUrl, { game: true }),
    inspectDatabase(expected.gameRestoreUrl, { game: true }),
  ]);
  await Promise.all([assertExactMigrationHead(live, TARGET_MIGRATION_COUNT), assertExactMigrationHead(restored, TARGET_MIGRATION_COUNT)]);
  invariant(UUID.test(live.state.databaseIdentity) && UUID.test(restored.state.databaseIdentity) && live.state.databaseIdentity !== restored.state.databaseIdentity, "Schema 31 erzeugte keine getrennten persistenten Datenbankidentitaeten.");
  const normalizedLive = normalizedSchema31State(live.state);
  const normalizedRestored = normalizedSchema31State(restored.state);
  invariant(sameValue(normalizedLive, normalizedRestored), "Schema-31-Livezustand ist nicht aus demselben Schema-29-Ausgangsrestore reproduzierbar.");
  const [liveMarkers, restoredMarkers] = await Promise.all([inspectMarkers(expected.gameUrl), inspectMarkers(expected.gameRestoreUrl)]);
  for (const markers of [liveMarkers, restoredMarkers]) {
    validatePreSchema33MarkersAbsent(markers);
  }
  await assertProductionColdBackupReceiptUnchanged(baselineArtifact);
  await assertProductionSchema29RuntimeDrillReceiptUnchanged(runtimeArtifact);
  return Object.freeze({
    baselineReceiptHash: baseline.receiptHash,
    expected,
    live,
    normalizedStateSha256: canonicalSha256(normalizedLive),
    restored,
    runtimeReceiptSha256: runtimeArtifact.sha256,
  });
}

export async function qualifyGameSchema31(options = {}) {
  const prepared = await prepareGameSchema31(options);
  const probeArtifact = await stableJson(prepared.expected.legacyProbePath, "Legacy-Schema-31-Schreibprobe");
  const probe = validateLegacyProbe(probeArtifact.value, {
    recoveryId: prepared.expected.recoveryId,
    previousWorldId: prepared.expected.previousWorldId,
    legacyImageDigest: prepared.expected.legacyImageDigest,
    databaseIdentity: prepared.live.state.databaseIdentity,
  });
  const payload = {
    baselineReceiptHash: prepared.baselineReceiptHash,
    candidateReleaseId: prepared.expected.candidateReleaseId,
    legacyImageDigest: prepared.expected.legacyImageDigest,
    legacyProbeReceiptHash: probe.receiptHash,
    liveDatabaseIdentity: prepared.live.state.databaseIdentity,
    migrationHeadHash: prepared.live.state.migrationLedger.at(-1).hash,
    migrationCount: TARGET_MIGRATION_COUNT,
    normalizedStateSha256: prepared.normalizedStateSha256,
    previousReleaseId: prepared.expected.previousReleaseId,
    previousWorldId: prepared.expected.previousWorldId,
    recoveryId: prepared.expected.recoveryId,
    restoredDatabaseIdentity: prepared.restored.state.databaseIdentity,
    schema: RECEIPT_SCHEMA,
    schema29RuntimeDrillReceiptSha256: prepared.runtimeReceiptSha256,
  };
  const receipt = { ...payload, receiptHash: canonicalSha256(payload) };
  try {
    const existing = await stableJson(prepared.expected.receiptOutputPath, "Schema-31-Vorbereitungsbeleg");
    invariant(sameValue(existing.value, receipt), "Vorhandener Schema-31-Vorbereitungsbeleg bindet einen anderen Zustand.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await publishCreateNew(prepared.expected.receiptOutputPath, receipt);
  }
  return Object.freeze(receipt);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    if (process.argv[2] === "migrate" && process.argv.length === 3) {
      const result = await prepareGameSchema31();
      process.stdout.write(`${JSON.stringify({ migrationCount: TARGET_MIGRATION_COUNT, normalizedStateSha256: result.normalizedStateSha256 })}\n`);
    } else if (process.argv[2] === "qualify" && process.argv.length === 3) {
      process.stdout.write(`${JSON.stringify(await qualifyGameSchema31())}\n`);
    } else {
      throw new Error("Aufruf: production-schema31-preparation.mjs migrate | qualify");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}

export const PRODUCTION_SCHEMA31_PREPARATION_SCHEMA = RECEIPT_SCHEMA;
