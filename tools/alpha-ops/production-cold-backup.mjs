import { createHash, randomUUID } from "node:crypto";
import { lstat, link, open, readdir, realpath, unlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { serializeMapReleaseBuildEvidence } from "../tiles/map-release-build-evidence.mjs";
import { databaseEndpointSha256, parseDockerRunningServices } from "./production-recovery-contract.mjs";

const RECEIPT_SCHEMA = "zugfolge-production-cold-backup/v1";
const INITIAL_PRODUCTION_MIGRATION_COUNT = 29;
const EXPECTED_PRE_MIGRATION_COUNT = 31;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const SAFE_DATABASE = /^[a-z0-9_]+$/u;
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/u;
const SAFE_FILESTORE_FILE = /^(?:[a-f0-9]{2}\/|[a-z0-9][a-z0-9._-]{0,79}\/[a-f0-9]{2}\/)[a-f0-9]{40}$/u;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;
const REQUIRED_DATABASE_SERVICES = Object.freeze(["odoo-postgres", "postgres", "recovery-verify-odoo-postgres", "recovery-verify-postgres"]);
const MAX_JSON_BYTES = 4 * 1_024 * 1_024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value;
}

function exactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} besitzt fremde oder fehlende Felder.`,
  );
  return value;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(sortedValue(left)) === JSON.stringify(sortedValue(right));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalSha256(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(sortedValue(value)), "utf8"));
}

function canonicalInstant(value, label) {
  invariant(typeof value === "string" && Number.isFinite(Date.parse(value)), `${label} ist kein UTC-Zeitpunkt.`);
  const canonical = new Date(value).toISOString();
  invariant(canonical === value, `${label} ist nicht kanonisch.`);
  return value;
}

function releaseId(value, label) {
  invariant(/^[a-z0-9][a-z0-9._-]*-20[0-9]{2}\.[1-9][0-9]*$/u.test(value), `${label} ist kein Jahres-Patchrelease.`);
  return value;
}

function safeDatabaseNameFromUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} ist keine PostgreSQL-URL.`);
  }
  invariant(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:", `${label} ist keine PostgreSQL-URL.`);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  invariant(SAFE_DATABASE.test(database), `${label} besitzt keinen sicheren Datenbanknamen.`);
  return database;
}

function quoteIdentifier(value) {
  invariant(SAFE_IDENTIFIER.test(value), `Unsicherer PostgreSQL-Bezeichner '${value}'.`);
  return `"${value.replaceAll('"', '""')}"`;
}

async function stableArtifact(path, label, { json = false } = {}) {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  invariant(before.isFile() && !before.isSymbolicLink() && before.size > 0n, `${label} ist keine regulaere, nichtleere Datei.`);
  invariant(!json || before.size <= BigInt(MAX_JSON_BYTES), `${label} ueberschreitet das JSON-Limit.`);
  const handle = await open(absolute, "r");
  const hash = createHash("sha256");
  const chunks = [];
  let byteLength = 0;
  try {
    const opened = await handle.stat({ bigint: true });
    invariant(opened.dev === before.dev && opened.ino === before.ino, `${label} wurde beim Oeffnen ausgetauscht.`);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      if (json) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absolute, { bigint: true });
    invariant(
      opened.dev === after.dev && opened.ino === after.ino
        && after.dev === pathAfter.dev && after.ino === pathAfter.ino
        && opened.size === after.size && opened.mtimeNs === after.mtimeNs
        && BigInt(byteLength) === after.size,
      `${label} aenderte sich waehrend des Lesens.`,
    );
    return Object.freeze({ path: absolute, byteLength, sha256: hash.digest("hex"), bytes: json ? Buffer.concat(chunks) : undefined, metadata: after });
  } finally {
    await handle.close();
  }
}

function parseJsonArtifact(artifact, label) {
  try {
    return JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} ist kein gueltiges JSON.`);
  }
}

async function assertArtifactUnchanged(artifact, label, { json = false } = {}) {
  const current = await stableArtifact(artifact.path, label, { json });
  invariant(
    current.metadata.dev === artifact.metadata.dev && current.metadata.ino === artifact.metadata.ino
      && current.metadata.size === artifact.metadata.size && current.metadata.mtimeNs === artifact.metadata.mtimeNs
      && current.sha256 === artifact.sha256,
    `${label} wurde nach der Qualifikation ausgetauscht.`,
  );
}

function validateGameArtifacts({ dump, manifestArtifact, operationArtifact, restoreArtifact }, expected) {
  const manifest = exactKeys(parseJsonArtifact(manifestArtifact, "Game-Backup-Manifest"), [
    "schema", "createdAt", "bytes", "sha256", "migrationCount", "rpoSeconds",
  ], "Game-Backup-Manifest");
  invariant(manifest.schema === "zugfolge-game-backup/v2", "Game-Backup-Manifest besitzt ein unbekanntes Schema.");
  invariant(manifest.bytes === dump.byteLength && manifest.sha256 === dump.sha256, "Game-Dump stimmt nicht mit seinem Manifest ueberein.");
  invariant(manifest.migrationCount === expected.migrationCount, `Kalter Game-Dump ist nicht Schema ${expected.migrationCount}.`);
  invariant(manifest.rpoSeconds === 300 && SHA256.test(manifest.sha256), "Game-Backup-Manifest besitzt keinen freigegebenen Hash-/RPO-Vertrag.");

  const operation = exactKeys(parseJsonArtifact(operationArtifact, "Game-Backup-Operationsbeleg"), [
    "backupCompletedWalLsn", "backupId", "backupStartedWalLsn", "completedAt", "dumpSha256", "gameBackupManifestSha256", "schema", "writersQuiesced",
  ], "Game-Backup-Operationsbeleg");
  invariant(operation.schema === "zugfolge-game-backup-operation/v1" && operation.writersQuiesced === true, "Game-Backup wurde nicht quiesziert belegt.");
  invariant(operation.dumpSha256 === dump.sha256 && operation.gameBackupManifestSha256 === manifestArtifact.sha256, "Game-Operationsbeleg ist nicht an Dump und Manifest gebunden.");

  const restore = exactKeys(parseJsonArtifact(restoreArtifact, "Game-Recovery-Receipt"), [
    "database", "dumpSha256", "identical", "manifestSha256", "migrationCount", "recoveryId", "schema",
  ], "Game-Recovery-Receipt");
  invariant(restore.schema === "zugfolge-production-game-restore/v1" && restore.identical === true, "Game-Recovery-Receipt meldet keinen erfolgreichen Restore.");
  invariant(restore.recoveryId === expected.recoveryId && restore.database === expected.restoreDatabase, "Game-Recovery-Receipt bindet ein falsches Recovery-Ziel.");
  invariant(restore.dumpSha256 === dump.sha256 && restore.manifestSha256 === manifestArtifact.sha256 && restore.migrationCount === manifest.migrationCount, "Game-Recovery-Receipt ist nicht an den kalten Dump gebunden.");
  return Object.freeze({ manifest, operation, restore });
}

function validateOdooArtifacts({ dump, archive, manifestArtifact, operationArtifact, restoreArtifact }, expected) {
  const manifest = exactKeys(parseJsonArtifact(manifestArtifact, "Odoo-Backup-Manifest"), [
    "schema", "createdAt", "databaseSha256", "filestoreSha256", "authoritativeStateSha256", "filestoreTreeSha256", "rpoSeconds",
  ], "Odoo-Backup-Manifest");
  invariant(manifest.schema === "zugfolge-odoo-backup/v2" && manifest.rpoSeconds === 900, "Odoo-Backup-Manifest besitzt keinen freigegebenen Vertrag.");
  invariant(manifest.databaseSha256 === dump.sha256 && manifest.filestoreSha256 === archive.sha256, "Odoo-Backupbytes stimmen nicht mit ihrem Manifest ueberein.");
  invariant(SHA256.test(manifest.authoritativeStateSha256) && SHA256.test(manifest.filestoreTreeSha256), "Odoo-Backup-Manifest besitzt ungueltige Zustands-Hashes.");

  const operation = exactKeys(parseJsonArtifact(operationArtifact, "Odoo-Backup-Operationsbeleg"), [
    "backupCompletedWalLsn", "backupId", "backupStartedWalLsn", "completedAt", "databaseSha256", "filestoreSha256", "manifestSha256", "schema", "stateSha256", "treeSha256", "writersQuiesced",
  ], "Odoo-Backup-Operationsbeleg");
  invariant(operation.schema === "zugfolge-odoo-backup-operation/v1" && operation.writersQuiesced === true, "Odoo-Backup wurde nicht quiesziert belegt.");
  invariant(
    operation.databaseSha256 === dump.sha256 && operation.filestoreSha256 === archive.sha256
      && operation.manifestSha256 === manifestArtifact.sha256
      && operation.stateSha256 === manifest.authoritativeStateSha256
      && operation.treeSha256 === manifest.filestoreTreeSha256,
    "Odoo-Operationsbeleg bindet nicht dasselbe DB-/Filestore-Paar.",
  );

  const restore = exactKeys(parseJsonArtifact(restoreArtifact, "Odoo-Recovery-Receipt"), [
    "authoritativeStateSha256", "database", "databaseSha256", "filestoreArchiveSha256", "filestoreTreeSha256", "identical", "recoveryId", "schema",
  ], "Odoo-Recovery-Receipt");
  invariant(restore.schema === "zugfolge-production-odoo-restore/v1" && restore.identical === true, "Odoo-Recovery-Receipt meldet keinen erfolgreichen Restore.");
  invariant(restore.recoveryId === expected.recoveryId && restore.database === expected.restoreDatabase, "Odoo-Recovery-Receipt bindet ein falsches Recovery-Ziel.");
  invariant(
    restore.databaseSha256 === dump.sha256 && restore.filestoreArchiveSha256 === archive.sha256
      && restore.authoritativeStateSha256 === manifest.authoritativeStateSha256
      && restore.filestoreTreeSha256 === manifest.filestoreTreeSha256,
    "Odoo-Recovery-Receipt ist nicht an dasselbe DB-/Filestore-Paar gebunden.",
  );
  return Object.freeze({ manifest, operation, restore });
}

function postgresFactoryDefault() {
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const module = requireFromDb("postgres");
  return module.default ?? module;
}

export async function inspectColdDatabase(databaseUrl, { game, postgresFactory } = {}) {
  const database = safeDatabaseNameFromUrl(databaseUrl, "Datenbankendpunkt");
  const factory = postgresFactory ?? postgresFactoryDefault();
  const client = factory(databaseUrl, { max: 1, connect_timeout: 15, idle_timeout: 5 });
  try {
    return await client.begin(async (sql) => {
      await sql.unsafe("set transaction isolation level repeatable read read only");
      const backendRows = await sql.unsafe("select system_identifier::text as system_identifier from pg_control_system()");
      invariant(backendRows.length === 1 && /^[0-9]+$/u.test(backendRows[0].system_identifier), "PostgreSQL-Backend besitzt keine Systemidentitaet.");
      const tableRows = await sql.unsafe(`
        select namespace.nspname as schema_name, relation.relname as table_name
        from pg_class as relation
        join pg_namespace as namespace on namespace.oid = relation.relnamespace
        where relation.relkind in ('r', 'p')
          and namespace.nspname <> 'information_schema'
          and namespace.nspname not like 'pg\\_%' escape '\\'
        order by namespace.nspname, relation.relname
      `);
      const tables = [];
      for (const row of tableRows) {
        const schema = quoteIdentifier(row.schema_name);
        const table = quoteIdentifier(row.table_name);
        const fingerprintRows = await sql.unsafe(`
          select count(*)::text as row_count,
            encode(sha256(convert_to(coalesce(string_agg(row_sha256, '' order by row_sha256), ''), 'UTF8')), 'hex') as rows_sha256
          from (
            select encode(sha256(convert_to(to_jsonb(source_row)::text, 'UTF8')), 'hex') as row_sha256
            from ${schema}.${table} as source_row
          ) as row_hashes
        `);
        invariant(fingerprintRows.length === 1 && /^(?:0|[1-9][0-9]*)$/u.test(fingerprintRows[0].row_count) && SHA256.test(fingerprintRows[0].rows_sha256), "Tabellenfingerprint ist ungueltig.");
        tables.push({ schema: row.schema_name, table: row.table_name, rowCount: fingerprintRows[0].row_count, rowsSha256: fingerprintRows[0].rows_sha256 });
      }
      const [columnRows, constraintRows, indexRows, sequenceRows] = await Promise.all([
        sql.unsafe(`select table_schema, table_name, ordinal_position::text, column_name, data_type, udt_schema, udt_name, is_nullable, coalesce(column_default, '') as column_default, is_generated, coalesce(generation_expression, '') as generation_expression from information_schema.columns where table_schema <> 'information_schema' and table_schema not like 'pg\\_%' escape '\\' order by table_schema, table_name, ordinal_position`),
        sql.unsafe(`select namespace.nspname as schema_name, relation.relname as table_name, constraint_record.conname as constraint_name, constraint_record.contype::text as constraint_type, pg_get_constraintdef(constraint_record.oid, true) as definition from pg_constraint as constraint_record join pg_class as relation on relation.oid = constraint_record.conrelid join pg_namespace as namespace on namespace.oid = relation.relnamespace where namespace.nspname <> 'information_schema' and namespace.nspname not like 'pg\\_%' escape '\\' order by namespace.nspname, relation.relname, constraint_record.conname`),
        sql.unsafe(`select namespace.nspname as schema_name, relation.relname as table_name, index_record.relname as index_name, pg_get_indexdef(index_record.oid) as definition from pg_index as binding join pg_class as relation on relation.oid = binding.indrelid join pg_namespace as namespace on namespace.oid = relation.relnamespace join pg_class as index_record on index_record.oid = binding.indexrelid where namespace.nspname <> 'information_schema' and namespace.nspname not like 'pg\\_%' escape '\\' order by namespace.nspname, relation.relname, index_record.relname`),
        sql.unsafe(`select schemaname, sequencename, start_value::text, min_value::text, max_value::text, increment_by::text, cycle, cache_size::text, coalesce(last_value::text, '') as last_value from pg_sequences where schemaname <> 'information_schema' and schemaname not like 'pg\\_%' escape '\\' order by schemaname, sequencename`),
      ]);
      let databaseIdentity = null;
      let migrationLedger = [];
      if (game) {
        const [identityTableRows, migrationRows] = await Promise.all([
          sql.unsafe("select to_regclass('public.zugfolge_database_identity') is not null as present"),
          sql.unsafe("select id::text as id, hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id"),
        ]);
        invariant(identityTableRows.length === 1 && typeof identityTableRows[0].present === "boolean", "Game-Datenbankidentitaet konnte nicht inventarisiert werden.");
        if (identityTableRows[0].present) {
          const identityRows = await sql.unsafe("select database_id::text as database_id from zugfolge_database_identity where singleton = 1");
          invariant(identityRows.length === 1 && UUID.test(identityRows[0].database_id), "Game-Datenbank besitzt keine persistente Identitaet.");
          databaseIdentity = identityRows[0].database_id;
        }
        invariant(
          migrationRows.length >= EXPECTED_PRE_MIGRATION_COUNT ? databaseIdentity !== null : databaseIdentity === null,
          "Game-Datenbankidentitaet passt nicht zum Migrationskopf.",
        );
        migrationLedger = migrationRows.map((row) => ({ id: row.id, hash: row.hash, createdAt: row.created_at }));
      }
      const state = Object.freeze({
        columnsSha256: canonicalSha256(normalizeColdColumnRows(columnRows)),
        constraintsSha256: canonicalSha256(constraintRows),
        databaseIdentity,
        indexesSha256: canonicalSha256(indexRows),
        migrationLedger,
        sequences: sequenceRows,
        tables,
      });
      return Object.freeze({
        backendSha256: canonicalSha256({ systemIdentifier: backendRows[0].system_identifier }),
        database,
        endpointSha256: databaseEndpointSha256(databaseUrl),
        state,
        stateSha256: canonicalSha256(state),
      });
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

export function normalizeColdColumnRows(rows) {
  invariant(Array.isArray(rows), "Spalteninventar ist keine Liste.");
  return rows.map((row) => {
    const column = { ...row };
    delete column.ordinal_position;
    return column;
  });
}

export function isColdFilestoreFileName(name) {
  return typeof name === "string" && SAFE_FILESTORE_FILE.test(name);
}

async function collectFilestoreFiles(root, directory = root, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const name = relative(root, path).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await collectFilestoreFiles(root, path, files);
    } else {
      invariant(entry.isFile() && isColdFilestoreFileName(name), `Odoo-Filestore enthaelt einen unsicheren Eintrag '${name}'.`);
      files.push({ name, path });
    }
  }
  return files;
}

export async function inspectFilestoreTree(rootPath) {
  const root = await realpath(rootPath);
  const rootStatus = await lstat(root);
  invariant(rootStatus.isDirectory() && !rootStatus.isSymbolicLink(), "Odoo-Filestore ist kein symlinkfreies Verzeichnis.");
  const files = (await collectFilestoreFiles(root)).sort((left, right) => left.name.localeCompare(right.name, "en"));
  const aggregate = createHash("sha256");
  for (const file of files) {
    const artifact = await stableArtifact(file.path, `Odoo-Filestoredatei '${file.name}'`);
    aggregate.update(`${artifact.sha256}  ./${file.name}\n`, "utf8");
  }
  return Object.freeze({ fileCount: files.length, treeSha256: aggregate.digest("hex") });
}

export async function runningServicesFromDockerSocket(project, environment) {
  const socketPath = requiredEnvironment(environment, "PRODUCTION_RECOVERY_DOCKER_SOCKET_PATH");
  invariant(socketPath === "/var/run/docker.sock", "Kalter Recovery-Gate adressiert nur den festen Docker-Socket.");
  const socket = await lstat(socketPath);
  invariant(socket.isSocket() && !socket.isSymbolicLink(), "Docker-Socket ist kein direkter Unix-Socket.");
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`], status: ["running"] }));
  const bytes = await new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({ socketPath, method: "GET", path: `/v1.43/containers/json?all=0&filters=${filters}`, headers: { Host: "docker", Accept: "application/json" } }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 1024 * 1024) request.destroy(new Error("Docker-Inventar ist zu gross."));
        else chunks.push(chunk);
      });
      response.on("end", () => response.statusCode === 200 ? resolvePromise(Buffer.concat(chunks)) : rejectPromise(new Error(`Docker-Inventar endete mit HTTP ${response.statusCode ?? "unbekannt"}.`)));
    });
    request.once("error", rejectPromise);
    request.end();
  });
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Docker-Inventar ist kein JSON."); }
  const services = parseDockerRunningServices(parsed, project);
  const controlService = requiredEnvironment(environment, "PRODUCTION_COLD_CONTROL_SERVICE");
  invariant([
    "production-recovery-schema29-cold-qualify",
    "production-recovery-cold-qualify",
    "game-schema31-migrate",
    "game-schema31-qualify",
    "game-schema33-migrate",
  ].includes(controlService), "Kalter Recovery-Control-Service ist nicht fest gebunden.");
  const hostname = requiredEnvironment(environment, "HOSTNAME");
  invariant(CONTAINER_ID.test(hostname), "Recovery-Control-Container besitzt keine Docker-ID als Hostname.");
  const self = services.filter(({ containerId, service }) => service === controlService && containerId.startsWith(hostname));
  invariant(self.length === 1, "Recovery-Control-Container ist nicht eindeutig im Docker-Inventar gebunden.");
  return services.filter(({ containerId }) => containerId !== self[0].containerId);
}

export function validateRunningServices(services) {
  const sorted = [...services].sort((left, right) => left.service.localeCompare(right.service, "en"));
  invariant(sameValue(sorted.map(({ service }) => service), REQUIRED_DATABASE_SERVICES), "Vor dem kalten Backup-Gate laufen Writer oder ein Datenbankdienst fehlt.");
  return sorted;
}

async function containedOutput(rootPath, outputPath) {
  const root = await realpath(rootPath);
  const status = await lstat(root);
  invariant(status.isDirectory() && !status.isSymbolicLink() && root !== resolve(sep), "Cold-Evidence-Wurzel ist ungueltig.");
  const absolute = resolve(outputPath);
  invariant(await realpath(dirname(absolute)) === root, "Cold-Backup-Receipt muss direkt in der Evidence-Wurzel liegen.");
  invariant(/^[a-z0-9][a-z0-9._-]*\.json$/u.test(basename(absolute)), "Cold-Backup-Receipt besitzt keinen sicheren Dateinamen.");
  try { await lstat(absolute); } catch (error) { if (error?.code === "ENOENT") return absolute; throw error; }
  throw new Error("Cold-Backup-Receipt existiert bereits; die Qualifikation ist create-new.");
}

async function publishCreateNew(path, bytes) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let linked = false;
  let identity;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    identity = await handle.stat({ bigint: true });
    await handle.close();
    await link(temporary, path);
    linked = true;
    const installed = await lstat(path, { bigint: true });
    invariant(installed.dev === identity.dev && installed.ino === identity.ino, "Cold-Backup-Receipt wurde beim Publizieren ausgetauscht.");
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    await unlink(temporary);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    try { await handle.close(); } catch { /* ursprünglicher Fehler bleibt maßgeblich */ }
    if (linked) {
      try {
        const installed = await lstat(path, { bigint: true });
        if (identity !== undefined && installed.dev === identity.dev && installed.ino === identity.ino) await unlink(path);
      } catch { /* fremde Ersatzdateien werden nie gelöscht */ }
    }
    try { await unlink(temporary); } catch { /* ursprünglicher Fehler bleibt maßgeblich */ }
    throw error;
  }
}

export function validateProductionColdBackupReceipt(value, expected = {}) {
  exactKeys(value, ["candidateReleaseId", "game", "observedRunningServices", "odoo", "previousReleaseId", "qualifiedAt", "receiptHash", "recoveryId", "schema", "schema31PreparationReceiptSha256", "writerContainersRunning"], "Cold-Backup-Receipt");
  invariant(value.schema === RECEIPT_SCHEMA && SAFE_ID.test(value.recoveryId), "Cold-Backup-Receipt besitzt keine gueltige Identitaet.");
  releaseId(value.candidateReleaseId, "Kandidatenrelease");
  releaseId(value.previousReleaseId, "Vorgaengerrelease");
  canonicalInstant(value.qualifiedAt, "Cold-Backup-Qualifikationszeit");
  invariant(value.writerContainersRunning === 0, "Cold-Backup-Receipt meldet laufende Writer.");
  invariant(sameValue(value.observedRunningServices.map(({ service }) => service), REQUIRED_DATABASE_SERVICES), "Cold-Backup-Receipt bindet nicht die vier writerfreien Live- und Restore-Datenbankdienste.");
  for (const service of value.observedRunningServices) {
    exactKeys(service, ["containerId", "service"], "Cold-Backup-Container");
    invariant(CONTAINER_ID.test(service.containerId), "Cold-Backup-Container besitzt keine Docker-ID.");
  }
  exactKeys(value.game, ["backendSha256", "databaseIdentity", "dumpSha256", "endpointSha256", "manifestSha256", "migrationCount", "operationSha256", "restoreBackendSha256", "restoreEndpointSha256", "restoreReceiptSha256", "stateSha256"], "Cold-Backup-Game-Bindung");
  exactKeys(value.odoo, ["backendSha256", "databaseDumpSha256", "endpointSha256", "filestoreArchiveSha256", "filestoreTreeSha256", "manifestSha256", "operationSha256", "restoreEndpointSha256", "restoreReceiptSha256", "stateSha256"], "Cold-Backup-Odoo-Bindung");
  const expectedMigrationCount = expected.migrationCount ?? EXPECTED_PRE_MIGRATION_COUNT;
  invariant(
    expectedMigrationCount === INITIAL_PRODUCTION_MIGRATION_COUNT || expectedMigrationCount === EXPECTED_PRE_MIGRATION_COUNT,
    "Cold-Backup erwartet keinen freigegebenen Migrationskopf.",
  );
  invariant(value.game.migrationCount === expectedMigrationCount, `Cold-Backup-Game-Bindung ist nicht der Schema-${expectedMigrationCount}-Kopf.`);
  invariant(
    expectedMigrationCount === INITIAL_PRODUCTION_MIGRATION_COUNT
      ? value.game.databaseIdentity === null
      : UUID.test(value.game.databaseIdentity),
    "Cold-Backup-Game-Bindung besitzt eine unpassende Datenbankidentitaet.",
  );
  invariant(
    expectedMigrationCount === INITIAL_PRODUCTION_MIGRATION_COUNT
      ? value.schema31PreparationReceiptSha256 === null
      : SHA256.test(value.schema31PreparationReceiptSha256),
    "Cold-Backup bindet keinen passenden Schema-31-Vorbereitungsbeleg.",
  );
  if (expected.schema31PreparationReceiptSha256 !== undefined) {
    invariant(value.schema31PreparationReceiptSha256 === expected.schema31PreparationReceiptSha256, "Cold-Backup bindet einen anderen Schema-31-Vorbereitungsbeleg.");
  }
  for (const hash of [
    value.game.backendSha256, value.game.dumpSha256, value.game.endpointSha256, value.game.manifestSha256,
    value.game.operationSha256, value.game.restoreBackendSha256, value.game.restoreEndpointSha256,
    value.game.restoreReceiptSha256, value.game.stateSha256, value.odoo.backendSha256,
    value.odoo.databaseDumpSha256, value.odoo.endpointSha256, value.odoo.filestoreArchiveSha256,
    value.odoo.filestoreTreeSha256, value.odoo.manifestSha256, value.odoo.operationSha256,
    value.odoo.restoreEndpointSha256, value.odoo.restoreReceiptSha256, value.odoo.stateSha256,
  ]) invariant(SHA256.test(hash), "Cold-Backup-Receipt enthaelt einen ungueltigen SHA-256.");
  invariant(value.game.endpointSha256 !== value.game.restoreEndpointSha256 && value.game.backendSha256 !== value.game.restoreBackendSha256, "Game-Restore ist nicht auf einer unabhaengigen PostgreSQL-Instanz isoliert.");
  invariant(value.odoo.endpointSha256 !== value.odoo.restoreEndpointSha256, "Odoo-Restore ist nicht in einer isolierten Datenbank erfolgt.");
  if (expected.recoveryId !== undefined) invariant(value.recoveryId === expected.recoveryId, "Cold-Backup-Receipt gehoert zu einer anderen Recovery.");
  if (expected.candidateReleaseId !== undefined) invariant(value.candidateReleaseId === expected.candidateReleaseId, "Cold-Backup-Receipt gehoert zu einem anderen Kandidatenrelease.");
  if (expected.previousReleaseId !== undefined) invariant(value.previousReleaseId === expected.previousReleaseId, "Cold-Backup-Receipt gehoert zu einem anderen Vorgaengerrelease.");
  const { receiptHash, ...payload } = value;
  invariant(SHA256.test(receiptHash) && receiptHash === canonicalSha256(payload), "Cold-Backup-Receipt besitzt keinen kanonischen Receipt-Hash.");
  return value;
}

export async function readProductionColdBackupReceipt(path, expected = {}) {
  const artifact = await stableArtifact(path, "Cold-Backup-Receipt", { json: true });
  const receipt = validateProductionColdBackupReceipt(parseJsonArtifact(artifact, "Cold-Backup-Receipt"), expected);
  return Object.freeze({ artifact, receipt });
}

export async function assertProductionColdBackupReceiptUnchanged(artifact) {
  await assertArtifactUnchanged(artifact, "Cold-Backup-Receipt", { json: true });
}

async function readSchema31PreparationReceipt(environment, expected) {
  if (expected.migrationCount === INITIAL_PRODUCTION_MIGRATION_COUNT) return null;
  const artifact = await stableArtifact(requiredEnvironment(environment, "PRODUCTION_SCHEMA31_RECEIPT_PATH"), "Schema-31-Vorbereitungsbeleg", { json: true });
  const value = exactKeys(parseJsonArtifact(artifact, "Schema-31-Vorbereitungsbeleg"), [
    "baselineReceiptHash", "candidateReleaseId", "legacyImageDigest", "legacyProbeReceiptHash",
    "liveDatabaseIdentity", "migrationHeadHash", "migrationCount", "normalizedStateSha256",
    "previousReleaseId", "previousWorldId", "receiptHash", "recoveryId",
    "restoredDatabaseIdentity", "schema", "schema29RuntimeDrillReceiptSha256",
  ], "Schema-31-Vorbereitungsbeleg");
  invariant(value.schema === "zugfolge-production-schema31-preparation/v1" && value.migrationCount === EXPECTED_PRE_MIGRATION_COUNT, "Schema-31-Vorbereitungsbeleg besitzt einen falschen Vertrag.");
  invariant(value.recoveryId === expected.recoveryId && value.candidateReleaseId === expected.candidateReleaseId && value.previousReleaseId === expected.previousReleaseId, "Schema-31-Vorbereitungsbeleg gehoert nicht zum kalten Recovery-Lauf.");
  invariant(UUID.test(value.liveDatabaseIdentity) && UUID.test(value.restoredDatabaseIdentity) && value.liveDatabaseIdentity !== value.restoredDatabaseIdentity, "Schema-31-Vorbereitungsbeleg besitzt keine getrennten Datenbankidentitaeten.");
  for (const hash of [value.baselineReceiptHash, value.legacyProbeReceiptHash, value.migrationHeadHash, value.normalizedStateSha256, value.schema29RuntimeDrillReceiptSha256, value.receiptHash]) {
    invariant(SHA256.test(hash), "Schema-31-Vorbereitungsbeleg besitzt einen ungueltigen SHA-256.");
  }
  const { receiptHash, ...payload } = value;
  invariant(receiptHash === canonicalSha256(payload), "Schema-31-Vorbereitungsbeleg besitzt keinen kanonischen Receipt-Hash.");
  return Object.freeze({ artifact, value });
}

function qualificationEnvironment(environment, expectedMigrationCount = EXPECTED_PRE_MIGRATION_COUNT) {
  invariant(
    expectedMigrationCount === INITIAL_PRODUCTION_MIGRATION_COUNT || expectedMigrationCount === EXPECTED_PRE_MIGRATION_COUNT,
    "Cold-Backup erwartet keinen freigegebenen Migrationskopf.",
  );
  const recoveryId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID");
  invariant(SAFE_ID.test(recoveryId), "PRODUCTION_RECOVERY_ID ist nicht kanonisch.");
  const gameRestoreUrl = requiredEnvironment(environment, "PRODUCTION_COLD_GAME_RESTORED_DATABASE_URL");
  const odooRestoreUrl = requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_RESTORED_DATABASE_URL");
  return Object.freeze({
    recoveryId,
    candidateReleaseId: releaseId(requiredEnvironment(environment, "PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID"), "Kandidatenrelease"),
    previousReleaseId: releaseId(requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID"), "Vorgaengerrelease"),
    migrationCount: expectedMigrationCount,
    gameUrl: requiredEnvironment(environment, "DATABASE_URL"),
    gameRestoreUrl,
    gameRestoreDatabase: safeDatabaseNameFromUrl(gameRestoreUrl, "Game-Restore-Endpunkt"),
    odooUrl: requiredEnvironment(environment, "ODOO_DATABASE_URL"),
    odooRestoreUrl,
    odooRestoreDatabase: safeDatabaseNameFromUrl(odooRestoreUrl, "Odoo-Restore-Endpunkt"),
  });
}

export async function createProductionColdBackupReceipt({
  environment = process.env,
  expectedMigrationCount = EXPECTED_PRE_MIGRATION_COUNT,
  inspectDatabase = inspectColdDatabase,
  inspectRunningServices = runningServicesFromDockerSocket,
  inspectFilestore = inspectFilestoreTree,
  now = () => new Date(),
} = {}) {
  const expected = qualificationEnvironment(environment, expectedMigrationCount);
  const schema31Preparation = await readSchema31PreparationReceipt(environment, expected);
  const outputPath = await containedOutput(requiredEnvironment(environment, "PRODUCTION_RECOVERY_EVIDENCE_ROOT"), requiredEnvironment(environment, "PRODUCTION_COLD_RECEIPT_OUTPUT_PATH"));
  const paths = {
    gameDump: requiredEnvironment(environment, "PRODUCTION_COLD_GAME_DUMP_PATH"),
    gameManifest: requiredEnvironment(environment, "PRODUCTION_COLD_GAME_MANIFEST_PATH"),
    gameOperation: requiredEnvironment(environment, "PRODUCTION_COLD_GAME_OPERATION_PATH"),
    gameRestore: requiredEnvironment(environment, "PRODUCTION_COLD_GAME_RESTORE_RECEIPT_PATH"),
    odooDump: requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_DATABASE_DUMP_PATH"),
    odooArchive: requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_FILESTORE_ARCHIVE_PATH"),
    odooManifest: requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_MANIFEST_PATH"),
    odooOperation: requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_OPERATION_PATH"),
    odooRestore: requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_RESTORE_RECEIPT_PATH"),
  };
  const [gameDump, gameManifest, gameOperation, gameRestore, odooDump, odooArchive, odooManifest, odooOperation, odooRestore] = await Promise.all([
    stableArtifact(paths.gameDump, "Kalter Game-Dump"), stableArtifact(paths.gameManifest, "Kaltes Game-Manifest", { json: true }),
    stableArtifact(paths.gameOperation, "Kalter Game-Operationsbeleg", { json: true }), stableArtifact(paths.gameRestore, "Kaltes Game-Restore-Receipt", { json: true }),
    stableArtifact(paths.odooDump, "Kalter Odoo-Dump"), stableArtifact(paths.odooArchive, "Kaltes Odoo-Filestorearchiv"),
    stableArtifact(paths.odooManifest, "Kaltes Odoo-Manifest", { json: true }), stableArtifact(paths.odooOperation, "Kalter Odoo-Operationsbeleg", { json: true }),
    stableArtifact(paths.odooRestore, "Kaltes Odoo-Restore-Receipt", { json: true }),
  ]);
  const artifacts = { gameDump, gameManifest, gameOperation, gameRestore, odooDump, odooArchive, odooManifest, odooOperation, odooRestore };
  const gameContract = validateGameArtifacts({ dump: gameDump, manifestArtifact: gameManifest, operationArtifact: gameOperation, restoreArtifact: gameRestore }, { recoveryId: expected.recoveryId, restoreDatabase: expected.gameRestoreDatabase, migrationCount: expected.migrationCount });
  const odooContract = validateOdooArtifacts({ dump: odooDump, archive: odooArchive, manifestArtifact: odooManifest, operationArtifact: odooOperation, restoreArtifact: odooRestore }, { recoveryId: expected.recoveryId, restoreDatabase: expected.odooRestoreDatabase });
  const [services, gameSource, gameRestored, odooSource, odooRestored, liveFilestore, restoredFilestore] = await Promise.all([
    inspectRunningServices(requiredEnvironment(environment, "PRODUCTION_RECOVERY_DOCKER_PROJECT"), environment).then(validateRunningServices),
    inspectDatabase(expected.gameUrl, { game: true }), inspectDatabase(expected.gameRestoreUrl, { game: true }),
    inspectDatabase(expected.odooUrl, { game: false }), inspectDatabase(expected.odooRestoreUrl, { game: false }),
    inspectFilestore(requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_LIVE_FILESTORE_PATH")),
    inspectFilestore(requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_RESTORED_FILESTORE_PATH")),
  ]);
  invariant(gameSource.state.migrationLedger.length === expected.migrationCount && gameRestored.state.migrationLedger.length === expected.migrationCount, `Quelle und Restore muessen exakt Schema ${expected.migrationCount} besitzen.`);
  invariant(sameValue(gameSource.state, gameRestored.state), "Kalter Game-Restore weicht vollstaendig vom Quellzustand ab.");
  invariant(gameSource.backendSha256 !== gameRestored.backendSha256, "Kalter Game-Restore lief nicht auf einer unabhaengigen PostgreSQL-Instanz.");
  invariant(sameValue(odooSource.state, odooRestored.state), "Kalter Odoo-Restore weicht vollstaendig vom Quellzustand ab.");
  invariant(liveFilestore.treeSha256 === restoredFilestore.treeSha256 && liveFilestore.treeSha256 === odooContract.manifest.filestoreTreeSha256, "Kalter Odoo-Filestore-Restore weicht vom gebundenen Live-Baum ab.");
  const payload = {
    candidateReleaseId: expected.candidateReleaseId,
    game: {
      backendSha256: gameSource.backendSha256, databaseIdentity: gameSource.state.databaseIdentity,
      dumpSha256: gameDump.sha256, endpointSha256: gameSource.endpointSha256, manifestSha256: gameManifest.sha256,
      migrationCount: gameContract.manifest.migrationCount, operationSha256: gameOperation.sha256,
      restoreBackendSha256: gameRestored.backendSha256, restoreEndpointSha256: gameRestored.endpointSha256,
      restoreReceiptSha256: gameRestore.sha256, stateSha256: gameSource.stateSha256,
    },
    observedRunningServices: services,
    odoo: {
      backendSha256: odooSource.backendSha256, databaseDumpSha256: odooDump.sha256,
      endpointSha256: odooSource.endpointSha256, filestoreArchiveSha256: odooArchive.sha256,
      filestoreTreeSha256: liveFilestore.treeSha256, manifestSha256: odooManifest.sha256,
      operationSha256: odooOperation.sha256, restoreEndpointSha256: odooRestored.endpointSha256,
      restoreReceiptSha256: odooRestore.sha256, stateSha256: odooSource.stateSha256,
    },
    previousReleaseId: expected.previousReleaseId,
    qualifiedAt: now().toISOString(),
    recoveryId: expected.recoveryId,
    schema: RECEIPT_SCHEMA,
    schema31PreparationReceiptSha256: schema31Preparation?.artifact.sha256 ?? null,
    writerContainersRunning: 0,
  };
  const receipt = validateProductionColdBackupReceipt({ ...payload, receiptHash: canonicalSha256(payload) }, {
    ...expected,
    schema31PreparationReceiptSha256: schema31Preparation?.artifact.sha256 ?? null,
  });
  await Promise.all(Object.entries(artifacts).map(([name, artifact]) => assertArtifactUnchanged(artifact, name, { json: artifact.bytes !== undefined })));
  if (schema31Preparation !== null) await assertArtifactUnchanged(schema31Preparation.artifact, "Schema-31-Vorbereitungsbeleg", { json: true });
  await publishCreateNew(outputPath, serializeMapReleaseBuildEvidence(receipt));
  return Object.freeze({ outputPath, receiptHash: receipt.receiptHash });
}

export async function assertProductionColdBackupPreflight({
  environment = process.env,
  expectedMigrationCount = EXPECTED_PRE_MIGRATION_COUNT,
  inspectDatabase = inspectColdDatabase,
  inspectRunningServices = runningServicesFromDockerSocket,
  inspectFilestore = inspectFilestoreTree,
} = {}) {
  const expected = qualificationEnvironment(environment, expectedMigrationCount);
  const schema31Preparation = await readSchema31PreparationReceipt(environment, expected);
  const { artifact: receiptArtifact, receipt } = await readProductionColdBackupReceipt(requiredEnvironment(environment, "PRODUCTION_COLD_RECEIPT_PATH"), {
    ...expected,
    schema31PreparationReceiptSha256: schema31Preparation?.artifact.sha256 ?? null,
  });
  const [services, gameSource, gameRestored, odooSource, odooRestored, liveFilestore, restoredFilestore] = await Promise.all([
    inspectRunningServices(requiredEnvironment(environment, "PRODUCTION_RECOVERY_DOCKER_PROJECT"), environment).then(validateRunningServices),
    inspectDatabase(expected.gameUrl, { game: true }), inspectDatabase(expected.gameRestoreUrl, { game: true }),
    inspectDatabase(expected.odooUrl, { game: false }), inspectDatabase(expected.odooRestoreUrl, { game: false }),
    inspectFilestore(requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_LIVE_FILESTORE_PATH")),
    inspectFilestore(requiredEnvironment(environment, "PRODUCTION_COLD_ODOO_RESTORED_FILESTORE_PATH")),
  ]);
  invariant(services.length === REQUIRED_DATABASE_SERVICES.length, "Schema-32/33-Gate besitzt kein stabiles Datenbankinventar.");
  invariant(gameSource.state.migrationLedger.length === expected.migrationCount && gameRestored.state.migrationLedger.length === expected.migrationCount, `Cold-Gate erwartet exakt den unveraenderten Schema-${expected.migrationCount}-Kopf.`);
  invariant(gameSource.endpointSha256 === receipt.game.endpointSha256 && gameSource.state.databaseIdentity === receipt.game.databaseIdentity && gameSource.backendSha256 === receipt.game.backendSha256 && gameSource.stateSha256 === receipt.game.stateSha256, "Game-Live-Datenbank hat sich seit dem kalten Vollrestore geaendert.");
  invariant(gameRestored.endpointSha256 === receipt.game.restoreEndpointSha256 && gameRestored.backendSha256 === receipt.game.restoreBackendSha256 && gameRestored.stateSha256 === receipt.game.stateSha256, "Isolierter Game-Restore hat sich seit dem kalten Vollrestore geaendert.");
  invariant(odooSource.endpointSha256 === receipt.odoo.endpointSha256 && odooSource.backendSha256 === receipt.odoo.backendSha256 && odooSource.stateSha256 === receipt.odoo.stateSha256, "Odoo-Live-Datenbank hat sich seit dem kalten Vollrestore geaendert.");
  invariant(odooRestored.endpointSha256 === receipt.odoo.restoreEndpointSha256 && odooRestored.stateSha256 === receipt.odoo.stateSha256, "Isolierter Odoo-Restore hat sich seit dem kalten Vollrestore geaendert.");
  invariant(liveFilestore.treeSha256 === receipt.odoo.filestoreTreeSha256, "Odoo-Live-Filestore hat sich seit dem kalten Vollrestore geaendert.");
  invariant(restoredFilestore.treeSha256 === receipt.odoo.filestoreTreeSha256, "Isolierter Odoo-Filestore hat sich seit dem kalten Vollrestore geaendert.");
  await assertArtifactUnchanged(receiptArtifact, "Cold-Backup-Receipt", { json: true });
  if (schema31Preparation !== null) await assertArtifactUnchanged(schema31Preparation.artifact, "Schema-31-Vorbereitungsbeleg", { json: true });
  return Object.freeze({ receiptHash: receipt.receiptHash, databaseIdentity: receipt.game.databaseIdentity });
}

export async function runAfterProductionColdBackupPreflight(command, options = {}) {
  invariant(Array.isArray(command) && command.length > 0 && command.every((value) => typeof value === "string" && value !== ""), "Schema-32/33-Gate braucht einen festen Folgebefehl.");
  await assertProductionColdBackupPreflight(options);
  const spawnProcess = options.spawnProcess ?? spawn;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess(command[0], command.slice(1), { stdio: "inherit", env: options.environment ?? process.env });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (signal !== null) rejectPromise(new Error(`Schema-32/33-Migration wurde durch ${signal} beendet.`));
      else if (code !== 0) rejectPromise(new Error(`Schema-32/33-Migration endete mit Status ${code}.`));
      else resolvePromise();
    });
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const mode = process.argv[2];
    if (mode === "qualify-schema29" && process.argv.length === 3) {
      process.stdout.write(`${JSON.stringify(await createProductionColdBackupReceipt({ expectedMigrationCount: INITIAL_PRODUCTION_MIGRATION_COUNT }))}\n`);
    } else if (mode === "qualify" && process.argv.length === 3) {
      process.stdout.write(`${JSON.stringify(await createProductionColdBackupReceipt())}\n`);
    } else if (mode === "preflight" && process.argv.length > 3) {
      await runAfterProductionColdBackupPreflight(process.argv.slice(3));
    } else {
      throw new Error("Aufruf: production-cold-backup.mjs qualify-schema29 | qualify | preflight BEFEHL [ARGUMENTE...]");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}

export const PRODUCTION_COLD_BACKUP_SCHEMA = RECEIPT_SCHEMA;
