import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";

const SCHEMA = "zugfolge-legacy-schema29-write-probe/v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function required(name) {
  const value = process.env[name];
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

async function publishCreateNew(path, value) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const parentStatus = await lstat(parent);
  invariant(parentStatus.isDirectory() && !parentStatus.isSymbolicLink(), "Schema-29-Legacy-Probe-Evidence-Wurzel ist unsicher.");
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
const outputPath = required("PRODUCTION_SCHEMA29_GAME_LEGACY_PROBE_OUTPUT_PATH");
const requireFromDb = createRequire("/app/packages/db/package.json");
const postgresModule = requireFromDb("postgres");
const postgres = postgresModule.default ?? postgresModule;
const client = postgres(databaseUrl, { max: 1, connect_timeout: 15, idle_timeout: 5 });
const { drizzle } = requireFromDb("drizzle-orm/postgres-js");
const { and, eq } = requireFromDb("drizzle-orm");
const { regionalSimulationStates } = await import("/app/packages/db/dist/schema/index.js");
const db = drizzle(client, { schema: { regionalSimulationStates } });
try {
  const migrationRows = await client.unsafe("select count(*)::int as migration_count from drizzle.__drizzle_migrations");
  invariant(migrationRows.length === 1 && migrationRows[0].migration_count === 29, "Legacy-Game-Runtime-Probe erwartet exakt Schema 29.");
  const identityRows = await client.unsafe("select to_regclass('public.zugfolge_database_identity') is not null as present");
  invariant(identityRows.length === 1 && identityRows[0].present === false, "Legacy-Game-Runtime-Probe fand bereits die Schema-31-Datenbankidentitaet.");
  const beforeRows = await db.select().from(regionalSimulationStates).where(and(
    eq(regionalSimulationStates.worldId, previousWorldId),
    eq(regionalSimulationStates.stateSchema, "zugfolge-regional-simulation-state/v1"),
  )).orderBy(regionalSimulationStates.regionId).limit(1);
  invariant(beforeRows.length === 1, "Legacy-Game-Runtime-Probe findet keinen V1-Regionalzustand.");
  let transient;
  const expectedRollback = new Error("zugfolge-schema29-expected-rollback");
  try {
    await db.transaction(async (tx) => {
      const transientUpdatedAt = new Date(beforeRows[0].updatedAt.getTime() + 1_000);
      const changed = await tx.update(regionalSimulationStates).set({ updatedAt: transientUpdatedAt }).where(and(
        eq(regionalSimulationStates.worldId, previousWorldId),
        eq(regionalSimulationStates.regionId, beforeRows[0].regionId),
        eq(regionalSimulationStates.stateSchema, "zugfolge-regional-simulation-state/v1"),
      )).returning({ updatedAt: regionalSimulationStates.updatedAt });
      invariant(changed.length === 1 && changed[0].updatedAt.getTime() === transientUpdatedAt.getTime(), "Legacy-Game-Runtime konnte ueber den alten Drizzle-Adapter auf dem Schema-29-Restore nicht schreiben.");
      transient = changed[0].updatedAt.toISOString();
      throw expectedRollback;
    });
  } catch (error) {
    if (error !== expectedRollback) throw error;
  }
  const afterRows = await db.select({ updatedAt: regionalSimulationStates.updatedAt }).from(regionalSimulationStates).where(and(
    eq(regionalSimulationStates.worldId, previousWorldId),
    eq(regionalSimulationStates.regionId, beforeRows[0].regionId),
  )).limit(1);
  invariant(afterRows.length === 1 && afterRows[0].updatedAt.getTime() === beforeRows[0].updatedAt.getTime(), "Legacy-Game-Schema-29-Schreibprobe wurde nicht vollstaendig zurueckgerollt.");
  const payload = {
    afterUpdatedAt: afterRows[0].updatedAt.toISOString(),
    beforeUpdatedAt: beforeRows[0].updatedAt.toISOString(),
    legacyImageDigest,
    migrationCount: 29,
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
