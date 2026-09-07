import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { archivePrivacyRedactionHash, readArchivePrivacyRedactions, restoreArchivePrivacyRedactions, validateArchivePrivacyRedactions } from "./archive-privacy-binding.mjs";
import { worldFinalHistorySeal } from "./database-rollback-binding.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function need(condition, message) { if (!condition) throw new Error(message); }
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}
const bytes = (value) => Buffer.from(JSON.stringify(sorted(value)) + "\n");
const hash = (value) => createHash("sha256").update(value).digest("hex");
function keys(value, expected) {
  need(value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort()), "Archiv-Recoverybeleg besitzt fremde oder fehlende Felder.");
}
export function validateArchivePrivacyRecovery(value) {
  keys(value, ["schema", "databaseIdentity", "worlds"]);
  need(value.schema === "zugfolge-archive-privacy-recovery/v1" && UUID.test(value.databaseIdentity)
    && Array.isArray(value.worlds) && value.worlds.length <= 10000, "Archiv-Recoverybeleg besitzt keine gültige Datenbankbindung.");
  let previous = "";
  for (const world of value.worlds) {
    keys(world, ["worldId", "historySchema", "originalHistorySeal", "redactions"]);
    need(UUID.test(world.worldId) && world.worldId > previous && SHA.test(world.originalHistorySeal)
      && /^zugfolge-world-final-history-seal\/v[1-4]$/u.test(world.historySchema), "Archiv-Recoverywelt ist ungültig oder doppelt.");
    validateArchivePrivacyRedactions(world.redactions);
    need(world.redactions.worldId === world.worldId && world.redactions.databaseIdentity === value.databaseIdentity, "Archiv-Recovery enthält eine fremde Welt oder Datenbank.");
    previous = world.worldId;
  }
  return value;
}

/** Exportiert nur den tatsächlichen vollständigen Archivstand; Originalreceipts bleiben unverändert. */
export async function exportArchivePrivacyRecovery(sql) {
  const [identity] = await sql.unsafe("select database_id::text from zugfolge_database_identity where singleton=1");
  need(identity !== undefined, "Archiv-Recovery benötigt eine ursprüngliche Datenbankidentität.");
  const archived = await sql.unsafe("select id::text as world_id from worlds where lifecycle_status='archived' order by id");
  const worlds = [];
  for (const { world_id: worldId } of archived) {
    const receipts = await sql.unsafe("select distinct predecessor_final_state_hash from world_cutover_receipts where predecessor_world_id=$1::uuid", [worldId]);
    need(receipts.length <= 1, "Archiv besitzt widersprechende originale Cutover-Siegel.");
    let chosen;
    for (const version of [4, 3, 2, 1]) {
      const historySchema = `zugfolge-world-final-history-seal/v${version}`;
      let originalHistorySeal;
      try { originalHistorySeal = await worldFinalHistorySeal(sql, worldId, { schemaVersion: historySchema }); } catch { continue; }
      if (receipts.length === 0 || originalHistorySeal === receipts[0].predecessor_final_state_hash) {
        chosen = { worldId, historySchema, originalHistorySeal, redactions: await readArchivePrivacyRedactions(sql, worldId) }; break;
      }
    }
    need(chosen !== undefined, "Originales Archiv-/Cutover-Siegel lässt sich nicht unverändert verifizieren.");
    worlds.push(chosen);
  }
  return validateArchivePrivacyRecovery({ schema: "zugfolge-archive-privacy-recovery/v1", databaseIdentity: identity.database_id, worlds });
}

/** Erwarteter SHA kommt aus dem Recoveryauftrag, niemals aus dem alten Backup. */
export async function readPinnedArchivePrivacyRecovery(environment) {
  const path = environment.ARCHIVE_PRIVACY_RECOVERY_PATH, expected = environment.ARCHIVE_PRIVACY_RECOVERY_SHA256;
  need(typeof path === "string" && path.length > 0 && SHA.test(expected), "Unabhängiger Archiv-Recoverypfad und SHA-256-Pin fehlen.");
  const before = await lstat(path, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= BigInt(MAX_BYTES), "Archiv-Recoverydatei ist keine begrenzte reguläre Datei.");
  const handle = await open(path, "r");
  let data;
  try {
    const opened = await handle.stat({ bigint: true });
    need(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, "Archiv-Recoverydatei wurde ausgetauscht.");
    data = await handle.readFile();
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    need(after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size && after.mtimeNs === opened.mtimeNs
      && current.dev === after.dev && current.ino === after.ino && !current.isSymbolicLink() && BigInt(data.length) === after.size,
    "Archiv-Recoverydatei wurde beim Lesen verändert.");
  } finally { await handle.close(); }
  need(hash(data) === expected, "Archiv-Recoverydatei widerspricht ihrem unabhängig vorgegebenen Pin.");
  let value;
  try { value = JSON.parse(data.toString("utf8")); } catch { throw new Error("Archiv-Recoverydatei ist kein gültiges JSON."); }
  validateArchivePrivacyRecovery(value);
  need(bytes(value).equals(data), "Archiv-Recoverydatei ist nicht kanonisch.");
  return { value, sha256: expected };
}

/** Produktions-Aktivierungsgrenze: ausschließlich lesen, niemals beiläufig redigieren. */
export async function assertArchivePrivacyActivation(sql, environment = process.env) {
  // Auch eine leere Archivliste braucht einen unabhängigen Pin: Ein älteres
  // Backup kann aus der Zeit vor einer inzwischen ausgeführten Archivierung stammen.
  const pinned = await readPinnedArchivePrivacyRecovery(environment);
  const actual = await exportArchivePrivacyRecovery(sql);
  need(bytes(actual).equals(bytes(pinned.value)), "Archiv-Recovery ist unvollständig oder veraltet; Aktivierung bleibt gesperrt.");
  return { schema: "zugfolge-archive-privacy-activation/v1", redactionSha256: pinned.sha256, worldCount: actual.worlds.length, verified: true };
}

/** Nur auf isolierter Recovery-DB, nach Forwardmigration; alle Welten atomar. */
export async function applyArchivePrivacyRecovery(sql, pinned) {
  validateArchivePrivacyRecovery(pinned.value);
  need(hash(bytes(pinned.value)) === pinned.sha256 && typeof sql.begin === "function", "Unabhängige Recoverybindung oder Transaktionsgrenze fehlt.");
  return sql.begin(async (tx) => {
    const archived = await tx.unsafe("select id::text as world_id from worlds where lifecycle_status='archived' order by id");
    need(JSON.stringify(archived.map((row) => row.world_id)) === JSON.stringify(pinned.value.worlds.map((world) => world.worldId)), "Recovery enthält andere archivierte Welten als der unabhängige Auftrag.");
    const results = [];
    for (const world of pinned.value.worlds) {
      // Der bestehende Einzelweltvertrag läuft innerhalb derselben äußeren Transaktion.
      const adapter = { unsafe: tx.unsafe.bind(tx), begin: async (callback) => callback(tx) };
      results.push(await restoreArchivePrivacyRedactions(adapter, world.redactions, { expectedSha256: archivePrivacyRedactionHash(world.redactions),
        expectedHistorySeal: world.originalHistorySeal, historySchema: world.historySchema }));
    }
    need(bytes(await exportArchivePrivacyRecovery(tx)).equals(bytes(pinned.value)), "Redigierter Restore weicht vom vollständigen Recoveryauftrag ab.");
    return { schema: "zugfolge-archive-privacy-recovery-result/v1", redactionSha256: pinned.sha256, worlds: results, verified: true };
  });
}

export async function archivePrivacyRecoveryCli(operation, environment = process.env) {
  need(["export", "restore", "verify"].includes(operation), "Archiv-Recovery erwartet export, restore oder verify.");
  const databaseUrl = environment.DATABASE_URL;
  need(typeof databaseUrl === "string" && databaseUrl.length > 0, "DATABASE_URL fehlt.");
  let url; try { url = new URL(databaseUrl); } catch { throw new Error("Recovery-Datenbankadresse ist ungültig."); }
  need(["postgres:", "postgresql:"].includes(url.protocol), "Recovery benötigt PostgreSQL.");
  if (operation === "restore") need(/^\/zugfolge_(?:restore_|recovery_v1_)[a-z0-9_]+$/u.test(url.pathname), "Redaktion ist ausschließlich auf einer isolierten Recoverydatenbank erlaubt.");
  const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const factory = require("postgres");
  const client = (factory.default ?? factory)(databaseUrl, { max: 1 });
  try {
    if (operation === "export") {
      const value = await client.begin("isolation level serializable read only deferrable", exportArchivePrivacyRecovery);
      const output = environment.ARCHIVE_PRIVACY_OUTPUT_PATH;
      need(typeof output === "string" && output.length > 0, "ARCHIVE_PRIVACY_OUTPUT_PATH fehlt.");
      const data = bytes(value); need(data.length <= MAX_BYTES, "Archiv-Recoveryexport überschreitet das Dateilimit.");
      const handle = await open(output, "wx", 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      return { schema: value.schema, sha256: hash(data), worldCount: value.worlds.length };
    }
    if (operation === "verify") return client.begin("isolation level serializable read only deferrable", (tx) => assertArchivePrivacyActivation(tx, environment));
    const pinned = await readPinnedArchivePrivacyRecovery(environment);
    const { drizzle } = require("drizzle-orm/postgres-js"), { migrate } = require("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(client), { migrationsFolder: resolve(import.meta.dirname, "../../packages/db/drizzle") });
    return await applyArchivePrivacyRecovery(client, pinned);
  } finally { await client.end({ timeout: 5 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  archivePrivacyRecoveryCli(process.argv[2]).then((result) => process.stdout.write(JSON.stringify(result ?? { verified: true, worldCount: 0 }) + "\n"))
    .catch(() => { process.stderr.write("Archiv-Recovery fehlgeschlagen; Datenbank, unabhängigen Pin, Schema und Originalbelege prüfen.\n"); process.exitCode = 1; });
}
