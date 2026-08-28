import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";

const SCHEMA = "zugfolge-legacy-schema31-write-probe/v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function required(name) {
  const value = process.env[name];
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value;
}

function sortedValue(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

async function publishCreateNew(path, value) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const parentStatus = await lstat(parent);
  invariant(parentStatus.isDirectory() && !parentStatus.isSymbolicLink(), "Legacy-Probe-Evidence-Wurzel ist unsicher.");
  const temporary = resolve(parent, `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`);
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

const databaseUrl = required("DATABASE_URL");
const recoveryId = required("PRODUCTION_RECOVERY_ID");
const previousWorldId = required("PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID");
const legacyImageDigest = required("MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST");
const outputPath = required("PRODUCTION_SCHEMA31_LEGACY_PROBE_OUTPUT_PATH");
const requireFromDb = createRequire("/app/packages/db/package.json");
const postgresModule = requireFromDb("postgres");
const postgres = postgresModule.default ?? postgresModule;
const client = postgres(databaseUrl, { max: 1, connect_timeout: 15, idle_timeout: 5 });
try {
  const migrationRows = await client.unsafe("select count(*)::int as migration_count from drizzle.__drizzle_migrations");
  invariant(migrationRows.length === 1 && migrationRows[0].migration_count === 31, "Legacy-Runtime-Probe erwartet exakt Schema 31.");
  const identityRows = await client.unsafe("select database_id::text as database_id from zugfolge_database_identity where singleton = 1");
  invariant(identityRows.length === 1, "Legacy-Runtime-Probe findet keine Datenbankidentitaet.");
  const beforeRows = await client.unsafe(`
    select world_id::text as world_id, region_id, updated_at::text as updated_at
    from regional_simulation_states
    where world_id = $1::uuid and state_schema = 'zugfolge-regional-simulation-state/v1' and legacy_writer_fenced = false
    order by region_id
    limit 1
  `, [previousWorldId]);
  invariant(beforeRows.length === 1, "Legacy-Runtime-Probe findet keinen schreibbaren V1-Regionalzustand.");
  await client.unsafe("begin");
  let transient;
  try {
    const changed = await client.unsafe(`
      update regional_simulation_states
      set updated_at = updated_at + interval '1 second'
      where world_id = $1::uuid and region_id = $2 and state_schema = 'zugfolge-regional-simulation-state/v1' and legacy_writer_fenced = false
      returning updated_at::text as updated_at
    `, [previousWorldId, beforeRows[0].region_id]);
    invariant(changed.length === 1 && changed[0].updated_at !== beforeRows[0].updated_at, "Legacy-Runtime konnte unter Schema 31 nicht schreiben.");
    transient = changed[0].updated_at;
  } finally {
    await client.unsafe("rollback");
  }
  const afterRows = await client.unsafe("select updated_at::text as updated_at from regional_simulation_states where world_id = $1::uuid and region_id = $2", [previousWorldId, beforeRows[0].region_id]);
  invariant(afterRows.length === 1 && afterRows[0].updated_at === beforeRows[0].updated_at, "Legacy-Schreibprobe wurde nicht vollstaendig zurueckgerollt.");
  const payload = {
    afterUpdatedAt: afterRows[0].updated_at,
    beforeUpdatedAt: beforeRows[0].updated_at,
    databaseIdentity: identityRows[0].database_id,
    legacyImageDigest,
    migrationCount: 31,
    previousWorldId,
    recoveryId,
    rolledBack: true,
    schema: SCHEMA,
    transientUpdatedAt: transient,
  };
  await publishCreateNew(outputPath, { ...payload, receiptHash: canonicalSha256(payload) });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 65;
} finally {
  await client.end({ timeout: 5 });
}
