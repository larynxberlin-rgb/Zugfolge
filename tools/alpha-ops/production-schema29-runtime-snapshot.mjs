import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertProductionColdBackupReceiptUnchanged,
  inspectColdDatabase,
  inspectFilestoreTree,
  readProductionColdBackupReceipt,
} from "./production-cold-backup.mjs";

const RECEIPT_SCHEMA = "zugfolge-production-schema29-runtime-before/v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const SAFE_DATABASE = /^[a-z0-9_]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} besitzt fremde oder fehlende Felder.`);
  return value;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

function databaseNameFromUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Schema-29-Runtime-Datenbank ist keine PostgreSQL-URL."); }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  invariant((parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") && SAFE_DATABASE.test(database), "Schema-29-Runtime-Datenbankname ist unsicher.");
  return database;
}

async function stableJson(path, label) {
  const absolute = resolve(path);
  let before;
  try { before = await lstat(absolute, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} fehlt.`);
    throw error;
  }
  invariant(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= 4_194_304n, `${label} ist keine sichere JSON-Datei.`);
  const bytes = await readFile(absolute);
  const after = await lstat(absolute, { bigint: true });
  invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs, `${label} aenderte sich beim Lesen.`);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} ist kein JSON.`); }
  return Object.freeze({ absolute, bytes, identity: before, sha256: createHash("sha256").update(bytes).digest("hex"), value });
}

async function assertJsonUnchanged(artifact, label) {
  const current = await stableJson(artifact.absolute, label);
  invariant(current.identity.dev === artifact.identity.dev && current.identity.ino === artifact.identity.ino && current.sha256 === artifact.sha256, `${label} wurde ausgetauscht.`);
}

async function containedOutput(rootPath, outputPath) {
  const root = await realpath(rootPath);
  const status = await lstat(root);
  invariant(status.isDirectory() && !status.isSymbolicLink() && root !== resolve(sep), "Schema-29-Runtime-Snapshot-Wurzel ist unsicher.");
  const output = resolve(outputPath);
  invariant(await realpath(dirname(output)) === root && /^[a-z0-9][a-z0-9._-]*\.json$/u.test(basename(output)), "Schema-29-Runtime-Snapshot liegt nicht direkt in der Evidence-Wurzel.");
  try { await lstat(output); } catch (error) { if (error?.code === "ENOENT") return output; throw error; }
  throw new Error("Schema-29-Runtime-Vorher-Snapshot existiert bereits; der Beleg ist create-new.");
}

async function publishCreateNew(path, value) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let linked = false;
  try {
    await handle.writeFile(`${JSON.stringify(sortedValue(value), null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await link(temporary, path);
    linked = true;
    await unlink(temporary);
  } catch (error) {
    try { await handle.close(); } catch { /* ursprünglicher Fehler bleibt maßgeblich */ }
    if (linked) { try { await unlink(path); } catch { /* nur eigene Datei */ } }
    try { await unlink(temporary); } catch { /* ursprünglicher Fehler bleibt maßgeblich */ }
    throw error;
  }
}

export async function inspectSchema29GameRuntimeHeads(databaseUrl, previousWorldId) {
  invariant(UUID.test(previousWorldId), "Schema-29-Runtime-Snapshot braucht eine kanonische Vorgaengerwelt.");
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const postgresModule = requireFromDb("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 15, idle_timeout: 5 });
  try {
    const [migration] = await client.unsafe("select count(*)::int as count from drizzle.__drizzle_migrations");
    invariant(migration?.count === 29, "Schema-29-Runtime-Snapshot erwartet exakt 29 Migrationen.");
    const [identity] = await client.unsafe("select to_regclass('public.zugfolge_database_identity') is not null as present");
    invariant(identity?.present === false, "Schema-29-Runtime-Snapshot fand bereits Schema 31.");
    const rows = await client.unsafe(`
      select world_id::text as world_id, region_id, revision::text as revision,
             publisher_sequence::text as publisher_sequence, state_hash,
             to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
      from regional_simulation_states
      where world_id = $1::uuid and state_schema = 'zugfolge-regional-simulation-state/v1'
      order by region_id
    `, [previousWorldId]);
    invariant(rows.length > 0 && rows.length <= 10_000, "Schema-29-Runtime-Snapshot fand keine begrenzte V1-Regionalmenge.");
    return Object.freeze(rows.map((row) => Object.freeze({
      publisherSequence: row.publisher_sequence,
      regionId: row.region_id,
      revision: row.revision,
      stateHash: row.state_hash,
      updatedAt: new Date(row.updated_at).toISOString(),
      worldId: row.world_id,
    })));
  } finally {
    await client.end({ timeout: 5 });
  }
}

function validateHeads(heads, previousWorldId) {
  invariant(Array.isArray(heads) && heads.length > 0 && heads.length <= 10_000, "Schema-29-Runtime-Vorher-Snapshot besitzt keine V1-Koepfe.");
  let previousRegion = "";
  for (const head of heads) {
    exactKeys(head, ["publisherSequence", "regionId", "revision", "stateHash", "updatedAt", "worldId"], "Schema-29-Runtime-Kopf");
    invariant(head.worldId === previousWorldId && typeof head.regionId === "string" && head.regionId > previousRegion, "Schema-29-Runtime-Koepfe sind nicht eindeutig kanonisch sortiert.");
    invariant(/^(?:0|[1-9][0-9]*)$/u.test(head.revision) && head.publisherSequence === head.revision && SHA256.test(head.stateHash), "Schema-29-Runtime-Kopf besitzt keine konsistente Sequenzbindung.");
    invariant(new Date(head.updatedAt).toISOString() === head.updatedAt, "Schema-29-Runtime-Kopf besitzt keinen UTC-Zeitpunkt.");
    previousRegion = head.regionId;
  }
  return heads;
}

export function validateProductionSchema29RuntimeBeforeReceipt(value, expected = {}) {
  exactKeys(value, [
    "baselineReceiptHash", "baselineReceiptSha256", "candidateReleaseId", "capturedAt", "gameRestoreBackendSha256",
    "gameRestoreEndpointSha256", "gameRestoreReceiptSha256", "gameRestoreStateSha256", "heads", "headsSha256", "odooRestoreReceiptSha256",
    "odooRestoreEndpointSha256", "odooRestoreStateSha256", "odooFilestoreTreeSha256", "previousReleaseId",
    "previousWorldId", "receiptHash", "recoveryId", "schema",
  ], "Schema-29-Runtime-Vorher-Snapshot");
  invariant(value.schema === RECEIPT_SCHEMA && SAFE_ID.test(value.recoveryId), "Schema-29-Runtime-Vorher-Snapshot besitzt keinen gueltigen Vertrag.");
  validateHeads(value.heads, value.previousWorldId);
  invariant(value.headsSha256 === canonicalSha256(value.heads), "Schema-29-Runtime-Vorher-Snapshot besitzt keinen kanonischen Kopfhash.");
  for (const hash of [
    value.baselineReceiptHash, value.baselineReceiptSha256, value.gameRestoreBackendSha256,
    value.gameRestoreEndpointSha256, value.gameRestoreReceiptSha256, value.gameRestoreStateSha256, value.headsSha256,
    value.odooRestoreReceiptSha256, value.odooRestoreEndpointSha256, value.odooRestoreStateSha256,
    value.odooFilestoreTreeSha256, value.receiptHash,
  ]) {
    invariant(SHA256.test(hash), "Schema-29-Runtime-Vorher-Snapshot besitzt einen ungueltigen SHA-256.");
  }
  invariant(new Date(value.capturedAt).toISOString() === value.capturedAt, "Schema-29-Runtime-Vorher-Snapshot besitzt keinen UTC-Zeitpunkt.");
  for (const key of ["recoveryId", "candidateReleaseId", "previousReleaseId", "previousWorldId", "baselineReceiptHash", "baselineReceiptSha256", "gameRestoreReceiptSha256", "odooRestoreReceiptSha256"]) {
    if (expected[key] !== undefined) invariant(value[key] === expected[key], `Schema-29-Runtime-Vorher-Snapshot bindet ${key} nicht.`);
  }
  const { receiptHash, ...payload } = value;
  invariant(receiptHash === canonicalSha256(payload), "Schema-29-Runtime-Vorher-Snapshot besitzt keinen kanonischen Receipt-Hash.");
  return value;
}

export async function readProductionSchema29RuntimeBeforeReceipt(path, expected = {}) {
  const artifact = await stableJson(path, "Schema-29-Runtime-Vorher-Snapshot");
  return Object.freeze({ artifact, receipt: validateProductionSchema29RuntimeBeforeReceipt(artifact.value, expected) });
}

export async function assertProductionSchema29RuntimeBeforeReceiptUnchanged(artifact) {
  await assertJsonUnchanged(artifact, "Schema-29-Runtime-Vorher-Snapshot");
}

export async function createProductionSchema29RuntimeBeforeReceipt({
  environment = process.env,
  inspectDatabase = inspectColdDatabase,
  inspectFilestore = inspectFilestoreTree,
  inspectHeads = inspectSchema29GameRuntimeHeads,
  now = () => new Date(),
} = {}) {
  const recoveryId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID");
  const candidateReleaseId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID");
  const previousReleaseId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID");
  const previousWorldId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID");
  const gameUrl = requiredEnvironment(environment, "DATABASE_URL");
  const odooUrl = requiredEnvironment(environment, "ODOO_DATABASE_URL");
  const outputPath = await containedOutput(requiredEnvironment(environment, "PRODUCTION_RECOVERY_EVIDENCE_ROOT"), requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_BEFORE_OUTPUT_PATH"));
  const { artifact: baselineArtifact, receipt: baseline } = await readProductionColdBackupReceipt(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_COLD_RECEIPT_PATH"), {
    recoveryId, candidateReleaseId, previousReleaseId, migrationCount: 29,
  });
  const [gameRestoreArtifact, pristineOdooRestoreArtifact, odooRestoreArtifact, gameRestore, odooRestore, filestore, heads] = await Promise.all([
    stableJson(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_RECEIPT_PATH"), "Schema-29-Game-Runtime-Restore-Receipt"),
    stableJson(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORE_RECEIPT_PATH"), "Schema-29-Odoo-Pristine-Restore-Receipt"),
    stableJson(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_RECEIPT_PATH"), "Schema-29-Odoo-Runtime-Restore-Receipt"),
    inspectDatabase(gameUrl, { game: true }),
    inspectDatabase(odooUrl, { game: false }),
    inspectFilestore(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH")),
    inspectHeads(gameUrl, previousWorldId),
  ]);
  invariant(gameRestore.state.migrationLedger.length === 29 && gameRestore.state.databaseIdentity === null, "Schema-29-Runtime-Vorher-Snapshot adressiert nicht Schema 29.");
  invariant(
    gameRestore.backendSha256 === baseline.game.restoreBackendSha256
      && gameRestore.endpointSha256 !== baseline.game.restoreEndpointSha256
      && gameRestore.stateSha256 === baseline.game.stateSha256,
    "Schema-29-Runtime-Vorher-Snapshot adressiert keinen getrennten, unveraenderten create-new-Game-Restore.",
  );
  exactKeys(gameRestoreArtifact.value, ["database", "dumpSha256", "identical", "manifestSha256", "migrationCount", "recoveryId", "schema"], "Schema-29-Game-Runtime-Restore-Receipt");
  invariant(
    gameRestoreArtifact.value.schema === "zugfolge-production-game-restore/v1"
      && gameRestoreArtifact.value.database === databaseNameFromUrl(gameUrl)
      && gameRestoreArtifact.value.recoveryId === recoveryId
      && gameRestoreArtifact.value.identical === true
      && gameRestoreArtifact.value.migrationCount === 29
      && gameRestoreArtifact.value.dumpSha256 === baseline.game.dumpSha256
      && gameRestoreArtifact.value.manifestSha256 === baseline.game.manifestSha256,
    "Schema-29-Game-Runtime-Restore-Receipt passt nicht zum Vorher-Snapshot.",
  );
  exactKeys(pristineOdooRestoreArtifact.value, ["authoritativeStateSha256", "database", "databaseSha256", "filestoreArchiveSha256", "filestoreTreeSha256", "identical", "recoveryId", "schema"], "Schema-29-Odoo-Pristine-Restore-Receipt");
  invariant(
    pristineOdooRestoreArtifact.sha256 === baseline.odoo.restoreReceiptSha256
      && pristineOdooRestoreArtifact.value.schema === "zugfolge-production-odoo-restore/v1"
      && pristineOdooRestoreArtifact.value.recoveryId === recoveryId
      && pristineOdooRestoreArtifact.value.identical === true,
    "Schema-29-Odoo-Pristine-Restore-Receipt passt nicht zum qualifizierten Kalt-Restore.",
  );
  exactKeys(odooRestoreArtifact.value, ["authoritativeStateSha256", "database", "databaseSha256", "filestoreArchiveSha256", "filestoreTreeSha256", "identical", "recoveryId", "schema"], "Schema-29-Odoo-Runtime-Restore-Receipt");
  invariant(
    odooRestoreArtifact.value.schema === "zugfolge-production-odoo-restore/v1"
      && odooRestoreArtifact.value.database === databaseNameFromUrl(odooUrl)
      && odooRestoreArtifact.value.recoveryId === recoveryId
      && odooRestoreArtifact.value.identical === true
      && odooRestoreArtifact.value.databaseSha256 === baseline.odoo.databaseDumpSha256
      && odooRestoreArtifact.value.filestoreArchiveSha256 === baseline.odoo.filestoreArchiveSha256
      && odooRestoreArtifact.value.authoritativeStateSha256 === pristineOdooRestoreArtifact.value.authoritativeStateSha256
      && odooRestoreArtifact.value.filestoreTreeSha256 === baseline.odoo.filestoreTreeSha256,
    "Schema-29-Odoo-Runtime-Restore-Receipt passt nicht zum Vorher-Snapshot.",
  );
  invariant(
    odooRestore.endpointSha256 !== baseline.odoo.restoreEndpointSha256
      && odooRestore.stateSha256 === baseline.odoo.stateSha256
      && filestore.treeSha256 === baseline.odoo.filestoreTreeSha256,
    "Schema-29-Runtime-Vorher-Snapshot adressiert keinen getrennten, unveraenderten Odoo-DB-/Filestore-Restore.",
  );
  const payload = {
    baselineReceiptHash: baseline.receiptHash,
    baselineReceiptSha256: baselineArtifact.sha256,
    candidateReleaseId,
    capturedAt: now().toISOString(),
    gameRestoreBackendSha256: gameRestore.backendSha256,
    gameRestoreEndpointSha256: gameRestore.endpointSha256,
    gameRestoreReceiptSha256: gameRestoreArtifact.sha256,
    gameRestoreStateSha256: gameRestore.stateSha256,
    heads,
    headsSha256: canonicalSha256(heads),
    odooFilestoreTreeSha256: filestore.treeSha256,
    odooRestoreEndpointSha256: odooRestore.endpointSha256,
    odooRestoreReceiptSha256: odooRestoreArtifact.sha256,
    odooRestoreStateSha256: odooRestore.stateSha256,
    previousReleaseId,
    previousWorldId,
    recoveryId,
    schema: RECEIPT_SCHEMA,
  };
  const receipt = validateProductionSchema29RuntimeBeforeReceipt({ ...payload, receiptHash: canonicalSha256(payload) });
  await Promise.all([
    assertProductionColdBackupReceiptUnchanged(baselineArtifact),
    assertJsonUnchanged(gameRestoreArtifact, "Schema-29-Game-Runtime-Restore-Receipt"),
    assertJsonUnchanged(pristineOdooRestoreArtifact, "Schema-29-Odoo-Pristine-Restore-Receipt"),
    assertJsonUnchanged(odooRestoreArtifact, "Schema-29-Odoo-Runtime-Restore-Receipt"),
  ]);
  await publishCreateNew(outputPath, receipt);
  return Object.freeze({ outputPath, receiptHash: receipt.receiptHash });
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    if (process.argv[2] !== "create" || process.argv.length !== 3) throw new Error("Aufruf: production-schema29-runtime-snapshot.mjs create");
    process.stdout.write(`${JSON.stringify(await createProductionSchema29RuntimeBeforeReceipt())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}
