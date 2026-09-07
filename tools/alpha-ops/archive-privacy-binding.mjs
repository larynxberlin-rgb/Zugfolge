import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../../packages/db/drizzle/0037_archive_privacy_redaction.sql", import.meta.url), "utf8");
export const ARCHIVE_PRIVACY_TABLES = Object.freeze(["archive_privacy_requests", "archive_privacy_rows"]);
export const ARCHIVE_PRIVACY_REDACTABLE_TABLES = Object.freeze(["accounts", "world_accesses", "account_roles", "world_participations", "mailbox_messages",
  "conductor_owners", "conductor_leases", "conductor_command_receipts", "conductor_snapshots"]);
export const ARCHIVE_PRIVACY_FUNCTION_SOURCES = Object.freeze(Object.fromEntries(
  [...migration.matchAll(/CREATE(?: OR REPLACE)? FUNCTION "?([a-z_]+)"?\([\s\S]*?\)\s*RETURNS[\s\S]*?AS \$\$([\s\S]*?)\$\$ LANGUAGE plpgsql;/gu)]
    .map((match) => [match[1], match[2]])));
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const normalized = (value) => value.replace(/\s+/gu, " ").trim();
const canonical = (value) => JSON.stringify(sorted(value));
const sha = (value) => createHash("sha256").update(value).digest("hex");
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}
function need(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, keys) {
  need(value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), "Archivredaktionsbeleg besitzt fremde oder fehlende Felder.");
}
function integer(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

export async function inspectArchivePrivacyContract(sql) {
  const names = Object.keys(ARCHIVE_PRIVACY_FUNCTION_SOURCES).sort();
  need(names.length === 6, "Eingecheckter Archivredaktionsvertrag ist unvollständig.");
  const rows = await sql.unsafe("select p.proname,p.prosrc,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[]) order by p.proname", [names]);
  need(rows.length === names.length && rows.every((row, index) => row.proname === names[index] && !row.prosecdef
    && normalized(row.prosrc) === normalized(ARCHIVE_PRIVACY_FUNCTION_SOURCES[row.proname])), "Archivredaktionsfunktionen weichen vom qualifizierten Vertrag ab.");
  const guards = await sql.unsafe("select t.tgname,c.relname,t.tgenabled,t.tgtype::int as tgtype,p.proname,pn.nspname as function_schema,encode(t.tgargs,'hex') as arguments from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace where n.nspname='public' and not t.tgisinternal and (c.relname=any($1::text[]) or (c.relname=any($2::text[]) and (t.tgname='zugfolge_archive_privacy_capture_'||c.relname or t.tgname='zugfolge_world_guard_'||c.relname)))", [ARCHIVE_PRIVACY_TABLES, ARCHIVE_PRIVACY_REDACTABLE_TABLES]);
  const expected = [
    ...ARCHIVE_PRIVACY_REDACTABLE_TABLES.flatMap((table) => [
      { name: "zugfolge_archive_privacy_capture_" + table, relation: table, type: 27, function: "zugfolge_archive_privacy_capture", arguments: "" },
      { name: "zugfolge_world_guard_" + table, relation: table, type: 31, function: "zugfolge_enforce_world_writer_guard", arguments: Buffer.from("world_id\0").toString("hex") },
    ]),
    { name: "archive_privacy_requests_apply", relation: "archive_privacy_requests", type: 5, function: "zugfolge_archive_privacy_apply", arguments: "" },
    { name: "archive_privacy_requests_immutable", relation: "archive_privacy_requests", type: 31, function: "zugfolge_archive_privacy_request_guard", arguments: "" },
    { name: "archive_privacy_rows_immutable", relation: "archive_privacy_rows", type: 31, function: "zugfolge_archive_privacy_rows_guard", arguments: "" },
  ];
  need(guards.length === expected.length && expected.every((item) => guards.filter((row) => row.tgname === item.name
    && row.relname === item.relation && row.tgenabled === "O" && Number(row.tgtype) === item.type && row.proname === item.function
    && row.function_schema === "public" && row.arguments === item.arguments).length === 1), "Archivredaktionsschutz fehlt, ist deaktiviert oder falsch verdrahtet.");
}

export async function readArchivePrivacyRedactions(sql, worldId) {
  need(UUID.test(worldId), "Archivredaktion benötigt eine eindeutige Welt.");
  await inspectArchivePrivacyContract(sql);
  const identities = await sql.unsafe("select database_id::text as database_id from zugfolge_database_identity where singleton=1");
  need(identities.length === 1, "Archivredaktion benötigt die ursprüngliche Datenbankidentität.");
  const requests = await sql.unsafe("select request_id::text,sequence::text,action,object_id::text,as_of,content_hash,completed from archive_privacy_requests where world_id=$1::uuid order by sequence", [worldId]);
  const result = [];
  for (const [index, request] of requests.entries()) {
    need(request.completed === true && Number(request.sequence) === index + 1, "Archivredaktionsfolge ist unvollständig.");
    const rows = await sql.unsafe("select row_sequence::text,table_name,before_sha256,before_v1_sha256,before_v1_added_facts,after_sha256 from archive_privacy_rows where world_id=$1::uuid and request_id=$2::uuid order by row_sequence", [worldId, request.request_id]);
    need(rows.every((row, position) => Number(row.row_sequence) === position + 1), "Archivredaktionszeilen sind unvollständig.");
    // PostgreSQL garantiert bei UPDATE/DELETE keine Heap-Reihenfolge. Der Export
    // bindet dieselben Änderungen auch nach einem logischen pg_restore kanonisch.
    rows.sort((left, right) => (left.table_name + ":" + left.before_sha256).localeCompare(right.table_name + ":" + right.before_sha256, "en"));
    result.push({ requestId: request.request_id, sequence: index + 1, action: request.action, objectId: request.object_id,
      asOf: new Date(request.as_of).toISOString(), contentHash: request.content_hash, rows: rows.map((row, position) => ({
        sequence: position + 1, table: row.table_name, beforeSha256: row.before_sha256,
        beforeV1Sha256: row.before_v1_sha256, beforeV1AddedFacts: row.before_v1_added_facts, afterSha256: row.after_sha256,
      })) });
  }
  const document = { schema: "zugfolge-archive-privacy-redaction/v1", databaseIdentity: identities[0].database_id, worldId, requests: result };
  validateArchivePrivacyRedactions(document);
  return document;
}

export function validateArchivePrivacyRedactions(value) {
  exactKeys(value, ["schema", "databaseIdentity", "worldId", "requests"]);
  need(value.schema === "zugfolge-archive-privacy-redaction/v1" && UUID.test(value.databaseIdentity) && UUID.test(value.worldId)
    && Array.isArray(value.requests), "Archivredaktionsbeleg besitzt keine gültige Bindung.");
  const ids = new Set(), objects = new Set();
  for (const [index, request] of value.requests.entries()) {
    exactKeys(request, ["requestId", "sequence", "action", "objectId", "asOf", "contentHash", "rows"]);
    need(UUID.test(request.requestId) && UUID.test(request.objectId) && integer(request.sequence) && request.sequence === index + 1
      && ["account-request", "account-purge", "mailbox-purge"].includes(request.action)
      && typeof request.asOf === "string" && Number.isFinite(Date.parse(request.asOf)) && new Date(request.asOf).toISOString() === request.asOf
      && (request.contentHash === null || SHA.test(request.contentHash)) && Array.isArray(request.rows)
      && !ids.has(request.requestId) && !objects.has(request.action + ":" + request.objectId), "Archivredaktionsauftrag ist ungültig oder doppelt.");
    ids.add(request.requestId); objects.add(request.action + ":" + request.objectId);
    for (const [position, row] of request.rows.entries()) {
      exactKeys(row, ["sequence", "table", "beforeSha256", "beforeV1Sha256", "beforeV1AddedFacts", "afterSha256"]);
      need(row.sequence === position + 1 && ARCHIVE_PRIVACY_REDACTABLE_TABLES.includes(row.table)
        && SHA.test(row.beforeSha256) && SHA.test(row.beforeV1Sha256) && typeof row.beforeV1AddedFacts === "boolean"
        && (row.afterSha256 === null || SHA.test(row.afterSha256)), "Archivredaktionszeile ist ungültig.");
      need(request.action !== "mailbox-purge" || row.table === "mailbox_messages", "Postfachredaktion enthält fremde Tabellen.");
      need(request.action === "mailbox-purge" || row.table !== "mailbox_messages", "Kontoredaktion enthält fremde Postfachdaten.");
    }
  }
  return value;
}
export function archivePrivacyRedactionHash(value) { validateArchivePrivacyRedactions(value); return sha(canonical(value)); }

export async function redactedHistoryTableFingerprint(sql, table, worldId, document, historicalV1) {
  const transitions = document.requests.flatMap((request) => request.rows.filter((row) => row.table === table));
  if (transitions.length === 0) return null;
  need(ARCHIVE_PRIVACY_REDACTABLE_TABLES.includes(table), "Unzulässige Archivredaktionstabelle.");
  const v1 = table === "mailbox_messages" ? "(to_jsonb(r)-ARRAY['content_hash','purged_at'])" : "to_jsonb(r)";
  const added = table === "mailbox_messages" ? "(r.content_hash is not null or r.purged_at is not null)" : "false";
  const actual = await sql.unsafe("select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') as full_hash,"
    + "encode(sha256(convert_to(" + v1 + "::text,'UTF8')),'hex') as v1_hash," + added
    + " as added_facts from public.\"" + table + "\" r where world_id=$1::uuid", [worldId]);
  const hashes = new Map();
  for (const row of actual) {
    need(SHA.test(row.full_hash) && SHA.test(row.v1_hash) && !hashes.has(row.full_hash), "Archivzeilen sind nicht eindeutig.");
    hashes.set(row.full_hash, row);
  }
  for (const row of transitions.toReversed()) {
    if (row.afterSha256 !== null) {
      need(hashes.has(row.afterSha256), "Bereinigte Archivzeile fehlt oder wurde nachträglich verändert.");
      hashes.delete(row.afterSha256);
    }
    need(!hashes.has(row.beforeSha256), "Gelöschter Personenbezug wurde ohne Redaktionsfreigabe wiederhergestellt.");
    hashes.set(row.beforeSha256, { full_hash: row.beforeSha256, v1_hash: row.beforeV1Sha256, added_facts: row.beforeV1AddedFacts });
  }
  need(!historicalV1 || [...hashes.values()].every((row) => !row.added_facts), "Historischer v1-Seal darf keine nichtleeren Schema-34-Fakten ausblenden.");
  return { table, rowCount: String(hashes.size), rowsSha256: sha([...hashes.values()].map((row) => historicalV1 ? row.v1_hash : row.full_hash).sort().join("")) };
}

/** Erwarteter Exporthash und Originalseal stammen aus dem unabhängigen Recoveryauftrag. */
export async function restoreArchivePrivacyRedactions(sql, document, { expectedSha256, expectedHistorySeal, historySchema }) {
  validateArchivePrivacyRedactions(document);
  need(SHA.test(expectedSha256) && archivePrivacyRedactionHash(document) === expectedSha256 && SHA.test(expectedHistorySeal)
    && /^zugfolge-world-final-history-seal\/v[1-5]$/u.test(historySchema), "Unabhängige Archivredaktions-/Historienbindung fehlt oder weicht ab.");
  need(typeof sql.begin === "function", "Archivrestore verlangt eine atomare Datenbanktransaktion.");
  const { worldFinalHistorySeal } = await import("./database-rollback-binding.mjs");
  return sql.begin(async (tx) => {
    await tx.unsafe("select pg_advisory_xact_lock(('x'||substr(md5($1),1,16))::bit(64)::bigint)", [document.worldId]);
    const world = await tx.unsafe("select lifecycle_status from worlds where id=$1::uuid for update", [document.worldId]);
    need(world.length === 1 && world[0].lifecycle_status === "archived", "Archivrestore erwartet die ursprüngliche archivierte Welt.");
    const current = await readArchivePrivacyRedactions(tx, document.worldId);
    need(current.databaseIdentity === document.databaseIdentity && current.requests.length <= document.requests.length
      && canonical(current.requests) === canonical(document.requests.slice(0, current.requests.length)), "Archivrestore besitzt einen fremden oder widersprechenden Redaktionsstand.");
    need(await worldFinalHistorySeal(tx, document.worldId, { schemaVersion: historySchema }) === expectedHistorySeal, "Originalgeschichte des Archivrestores weicht ab.");
    for (const request of document.requests.slice(current.requests.length)) {
      await tx.unsafe("insert into archive_privacy_requests(world_id,request_id,sequence,action,object_id,as_of,content_hash) values($1::uuid,$2::uuid,$3::bigint,$4,$5::uuid,$6::timestamptz,$7)",
        [document.worldId, request.requestId, request.sequence, request.action, request.objectId, request.asOf, request.contentHash]);
      const applied = await readArchivePrivacyRedactions(tx, document.worldId);
      need(canonical(applied.requests) === canonical(document.requests.slice(0, request.sequence)), "Restore-Redaktion stimmt nicht mit dem unabhängig gepinnten Beleg überein.");
    }
    const result = await readArchivePrivacyRedactions(tx, document.worldId);
    need(archivePrivacyRedactionHash(result) === expectedSha256
      && await worldFinalHistorySeal(tx, document.worldId, { schemaVersion: historySchema }) === expectedHistorySeal,
    "Archivrestore hat Redaktionsstand oder Originalgeschichte verändert.");
    return { schema: "zugfolge-archive-privacy-restore/v1", worldId: document.worldId, redactionSha256: expectedSha256,
      originalHistorySeal: expectedHistorySeal, historySchema, requestCount: result.requests.length, verified: true };
  });
}
