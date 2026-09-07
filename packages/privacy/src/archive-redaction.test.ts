import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { MIGRATIONS_FOLDER } from "@zugfolge/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { purgeExpiredMailboxMessages } from "@zugfolge/mailbox";
import { eraseAccountData, purgeExpiredAccountData } from "./erasure.js";
import { exportAccountData, PersonalDataNotFoundError } from "./export.js";

const WORLD = "11111111-1111-4111-8111-111111111520";
const ACCOUNT = "22222222-2222-4222-8222-222222222520";
const OTHER_WORLD = "33333333-3333-4333-8333-333333333520";
const OWNER = "44444444-4444-4444-8444-444444444520";

async function migrationsThrough(count: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `zugfolge-archive-schema${count}-`));
  await mkdir(join(folder, "meta"));
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const entries = journal.entries.slice(0, count);
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  await Promise.all(entries.map(({ tag }) => copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`))));
  return folder;
}
function adapter(client: PGlite) {
  return { unsafe: async (query: string, params: unknown[] = []) => (await client.query(query, params)).rows,
    begin: async (callback: (tx: unknown) => Promise<unknown>) => client.transaction(async (tx) => callback({
      unsafe: async (query: string, params: unknown[] = []) => (await tx.query(query, params)).rows,
    })),
  };
}

it.each([33, 36])("redigiert ein echtes Schema-%i-Archiv und restauriert alte Backupbytes ausschließlich mit unabhängig gepinntem Löschbeleg", async (schemaCount) => {
  const { worldFinalHistorySeal, worldCutoverReceiptHash, validateStoredWorldCutoverReceipt, inspectLiveDatabaseRollbackSnapshot } = await import(new URL("../../../tools/alpha-ops/database-rollback-binding.mjs", import.meta.url).href);
  const { keycloakStateInspectorFixture } = await import(new URL("../../../tools/alpha-ops/database-rollback-test-fixtures.mjs", import.meta.url).href);
  const { readArchivePrivacyRedactions, archivePrivacyRedactionHash, restoreArchivePrivacyRedactions } = await import(new URL("../../../tools/alpha-ops/archive-privacy-binding.mjs", import.meta.url).href);
  const { exportArchivePrivacyRecovery, readPinnedArchivePrivacyRecovery, applyArchivePrivacyRecovery, assertArchivePrivacyActivation } = await import(new URL("../../../tools/alpha-ops/archive-privacy-recovery.mjs", import.meta.url).href);
  const oldMigrations = await migrationsThrough(schemaCount);
  let client = new PGlite();
  const historySchema = `zugfolge-world-final-history-seal/v${schemaCount === 33 ? 1 : 4}`;
  try {
    let db = drizzle(client);
    await migrate(db, { migrationsFolder: oldMigrations });
    await client.query("insert into worlds(id,name,schedule_period_weeks,epoch) values($1,'Archiv',4,'2025-01-01Z'),($2,'Fremdwelt',4,'2025-01-01Z')", [WORLD, OTHER_WORLD]);
    await client.query("insert into accounts(id,world_id,keycloak_subject,display_name,erased_at) values($1,$2,'archive-subject','Archivperson','2025-01-01Z')", [ACCOUNT, WORLD]);
    await client.query("insert into world_accesses(world_id,keycloak_subject,status,revoked_at) values($1,'archive-subject','revoked','2025-01-01Z')", [WORLD]);
    await client.query("insert into account_roles(world_id,account_id,role) values($1,$2,'player')", [WORLD, ACCOUNT]);
    await client.query("insert into mailbox_messages(world_id,recipient_account_id,message_type,payload,sent_at,deadline_at) values($1,$2,'private.message','{\"privateText\":\"Nachricht einer Person\"}','2025-01-01Z',null),($1,$2,'held.message','{\"privateText\":\"Fachlich gehalten\"}','2025-01-01Z','2026-02-01Z')", [WORLD, ACCOUNT]);
    await client.query("insert into domain_events(world_id,sequence,event_type,payload,occurred_at) values($1,1,'test.operational-proof','{\"syntheticTrain\":\"retained\"}','2025-01-01Z')", [WORLD]);
    if (schemaCount === 36) {
      await client.query("insert into conductor_owners(world_id,account_id,owner_ref) values($1,$2,$3)", [WORLD, ACCOUNT, OWNER]);
      await client.query("insert into conductor_leases(world_id,account_id,owner_ref,train_run_id,session_id,lease_until_ms) values($1,$2,$3,'train','session',1000)", [WORLD, ACCOUNT, OWNER]);
      await client.query("insert into conductor_command_receipts(world_id,train_run_id,command_id,owner_ref,request_hash,receipt) values($1,'train','command',$2,$3,'{\"privateText\":\"Private Quittung\"}')", [WORLD, OWNER, "a".repeat(64)]);
      await client.query("insert into conductor_snapshots(world_id,train_run_id,session_id,owner_ref,sequence,snapshot) values($1,'train','session',$2,1,'{\"privateText\":\"Privater Snapshot\"}')", [WORLD, OWNER]);
      // Reiner Speicher-/Löschgrenzenbeweis; keine neue fachliche Kontrollsimulation.
      await client.query("insert into conductor_train_states(world_id,train_run_id,region_id,state,state_hash,revision,at_ms) values($1,'train','test',$2,$3,1,0)", [WORLD, JSON.stringify({ worldId: WORLD, trainRunId: "train", syntheticCase: "retained" }), "b".repeat(64)]);
    }
    await client.query("update worlds set lifecycle_status='archived' where id=$1", [WORLD]);
    const originalSeal = await worldFinalHistorySeal(adapter(client), WORLD, { schemaVersion: historySchema });
    const [{ database_id: databaseIdentity }] = (await client.query<{ database_id: string }>("select database_id from zugfolge_database_identity")).rows;
    const receipt = { schema: "zugfolge-world-cutover-receipt/v1", databaseIdentity, mode: "authorized-v1-to-v2-cutover",
      predecessorWorldId: WORLD, predecessorDeploymentHash: "1".repeat(64), predecessorFinalStateHash: originalSeal,
      candidateWorldId: OTHER_WORLD, candidateDeploymentHash: "2".repeat(64), beforeAuthoritativeHeadSha256: "3".repeat(64), afterAuthoritativeHeadSha256: "4".repeat(64) };
    const receiptHash = worldCutoverReceiptHash(receipt);
    await client.query("insert into world_cutover_receipts(candidate_world_id,database_id,mode,predecessor_world_id,predecessor_deployment_hash,predecessor_final_state_hash,candidate_deployment_hash,before_authoritative_head_sha256,after_authoritative_head_sha256,receipt_hash) values($1,$2,'authorized-v1-to-v2-cutover',$3,$4,$5,$6,$7,$8,$9)", [OTHER_WORLD,databaseIdentity,WORLD,receipt.predecessorDeploymentHash,originalSeal,receipt.candidateDeploymentHash,receipt.beforeAuthoritativeHeadSha256,receipt.afterAuthoritativeHeadSha256,receiptHash]);
    const backup = await client.dumpDataDir("none");
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const foreignSeal = await worldFinalHistorySeal(adapter(client), OTHER_WORLD);
    expect(await worldFinalHistorySeal(adapter(client), WORLD, { schemaVersion: historySchema })).toBe(originalSeal);
    expect((await purgeExpiredAccountData(db, new Date("2025-03-31T23:59:59.999Z"))).purgedAccountIds).toEqual([]);
    const purge = await purgeExpiredAccountData(db, new Date("2025-04-01Z"));
    expect(purge.failures).toBeUndefined(); expect(purge.purgedAccountIds).toEqual([ACCOUNT]);
    expect((await purgeExpiredMailboxMessages(db, { worldId: WORLD, asOf: new Date("2025-12-31T23:59:59.999Z") })).purgedMessageIds).toEqual([]);
    expect((await purgeExpiredMailboxMessages(db, { worldId: WORLD, asOf: new Date("2026-01-01Z") })).purgedMessageIds).toHaveLength(1);
    expect((await purgeExpiredMailboxMessages(db, { worldId: WORLD, asOf: new Date("2026-01-02Z") })).purgedMessageIds).toEqual([]);
    expect(await worldFinalHistorySeal(adapter(client), WORLD, { schemaVersion: historySchema })).toBe(originalSeal);
    expect(await worldFinalHistorySeal(adapter(client), OTHER_WORLD)).toBe(foreignSeal);
    const exportValue = await readArchivePrivacyRedactions(adapter(client), WORLD), expectedSha256 = archivePrivacyRedactionHash(exportValue);
    const completeRecovery = await exportArchivePrivacyRecovery(adapter(client));
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, item]) => [key, canonical(item)])) : value;
    const recoveryBytes = Buffer.from(JSON.stringify(canonical(completeRecovery)) + "\n");
    const recoveryPath = join(oldMigrations, "recovery.json");
    await writeFile(recoveryPath, recoveryBytes);
    const environment = { ARCHIVE_PRIVACY_RECOVERY_PATH: recoveryPath, ARCHIVE_PRIVACY_RECOVERY_SHA256: createHash("sha256").update(recoveryBytes).digest("hex") };
    await expect(assertArchivePrivacyActivation(adapter(client), {})).rejects.toThrow(/Pin/u);
    expect((await assertArchivePrivacyActivation(adapter(client), environment)).verified).toBe(true);
    expect(exportValue.requests).toHaveLength(2);
    expect(JSON.stringify(exportValue)).not.toMatch(/archive-subject|Archivperson|Nachricht einer Person|Private Quittung|Privater Snapshot/u);
    expect(JSON.stringify(exportValue)).not.toContain(OWNER);
    if (schemaCount === 36) {
      for (const table of ["conductor_owners", "conductor_leases", "conductor_command_receipts", "conductor_snapshots"]) {
        expect((await client.query(`select * from ${table} where world_id=$1`, [WORLD])).rows).toEqual([]);
      }
      expect((await client.query("select state from conductor_train_states where world_id=$1", [WORLD])).rows).toHaveLength(1);
    }
    await expect(client.query("delete from domain_events where world_id=$1", [WORLD])).rejects.toThrow();
    await expect(client.query("update world_cutover_receipts set predecessor_final_state_hash=$1 where candidate_world_id=$2", ["f".repeat(64), OTHER_WORLD])).rejects.toThrow();
    const [preservedReceipt] = (await client.query("select * from world_cutover_receipts where candidate_world_id=$1", [OTHER_WORLD])).rows;
    expect(validateStoredWorldCutoverReceipt(preservedReceipt).receiptHash).toBe(receiptHash);
    await client.close();
    client = new PGlite({ loadDataDir: backup }); db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    expect((await client.query("select keycloak_subject from accounts where world_id=$1", [WORLD])).rows[0]).toEqual({ keycloak_subject: "archive-subject" });
    const restorePin = { expectedSha256, expectedHistorySeal: originalSeal, historySchema };
    await expect(assertArchivePrivacyActivation(adapter(client), environment)).rejects.toThrow(/veraltet/u);
    await expect(restoreArchivePrivacyRedactions(adapter(client), exportValue, { ...restorePin, expectedSha256: "f".repeat(64) })).rejects.toThrow();
    const corruptTransitions = structuredClone(exportValue);
    corruptTransitions.requests[1].rows[0].beforeSha256 = "e".repeat(64);
    await expect(restoreArchivePrivacyRedactions(adapter(client), corruptTransitions, { ...restorePin, expectedSha256: archivePrivacyRedactionHash(corruptTransitions) })).rejects.toThrow();
    expect((await client.query("select keycloak_subject from accounts where world_id=$1", [WORLD])).rows[0]).toEqual({ keycloak_subject: "archive-subject" });
    expect((await client.query("select * from archive_privacy_requests where world_id=$1", [WORLD])).rows).toEqual([]);
    const pinned = await readPinnedArchivePrivacyRecovery(environment);
    const completeRestore = await applyArchivePrivacyRecovery(adapter(client), pinned);
    expect(completeRestore.verified).toBe(true);
    const restored = completeRestore.worlds[0];
    expect(restored.verified).toBe(true); expect(restored.requestCount).toBe(2);
    expect(await restoreArchivePrivacyRedactions(adapter(client), exportValue, restorePin)).toEqual(restored);
    expect(await applyArchivePrivacyRecovery(adapter(client), pinned)).toEqual(completeRestore);
    expect((await assertArchivePrivacyActivation(adapter(client), environment)).verified).toBe(true);
    expect((await client.query("select keycloak_subject from accounts where world_id=$1", [WORLD])).rows).toEqual([{ keycloak_subject: `erased:${ACCOUNT}` }]);
    expect((await client.query("select payload from mailbox_messages where world_id=$1 and purged_at is not null", [WORLD])).rows).toEqual([{ payload: {} }]);
    expect(await worldFinalHistorySeal(adapter(client), WORLD, { schemaVersion: historySchema })).toBe(originalSeal);
    expect(await worldFinalHistorySeal(adapter(client), OTHER_WORLD)).toBe(foreignSeal);
    // Neue bereinigte Sicherungsquelle: echter vollständiger Game-Katalog aus
    // PostgreSQL/PGlite, separat definierter leerer Keycloak-Testtenant.
    const inspectionOptions = { inspectKeycloakState: keycloakStateInspectorFixture() };
    const cleanSource = await inspectLiveDatabaseRollbackSnapshot(adapter(client), inspectionOptions);
    expect(cleanSource.migrationLedger).toHaveLength(37);
    const cleanBackup = await client.dumpDataDir("none");
    await client.close(); client = new PGlite({ loadDataDir: cleanBackup });
    expect(await inspectLiveDatabaseRollbackSnapshot(adapter(client), inspectionOptions)).toEqual(cleanSource);
    expect((await assertArchivePrivacyActivation(adapter(client), environment)).verified).toBe(true);
  } finally {
    await client.close(); expect(dirname(oldMigrations)).toBe(tmpdir()); await rm(oldMigrations, { recursive: true, force: true });
  }
}, 120_000);

it("führt den fälligen produktiven Kontopurge im Archiv aus, lässt gewöhnliche Archivschreibvorgänge aber gesperrt", async () => {
  const client = new PGlite(), db = drizzle(client);
  try {
    const { worldFinalHistorySeal } = await import(new URL("../../../tools/alpha-ops/database-rollback-binding.mjs", import.meta.url).href);
    const { readArchivePrivacyRedactions } = await import(new URL("../../../tools/alpha-ops/archive-privacy-binding.mjs", import.meta.url).href);
    const adapter = { unsafe: async (query: string, params: unknown[] = []) => (await client.query(query, params)).rows };
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await client.query("insert into worlds(id,name,schedule_period_weeks,epoch) values($1,'Archiv',4,'2025-01-01Z')", [WORLD]);
    await client.query("insert into accounts(id,world_id,keycloak_subject,display_name,erased_at) values($1,$2,'private-subject','Privater Name','2025-01-01Z')", [ACCOUNT, WORLD]);
    await client.query("update worlds set lifecycle_status='archived' where id=$1", [WORLD]);
    const originalSeal = await worldFinalHistorySeal(adapter, WORLD);
    await expect(client.query("update accounts set display_name='Manipulation' where world_id=$1", [WORLD])).rejects.toThrow();
    const result = await purgeExpiredAccountData(db, new Date("2026-01-02Z"));
    expect(result.failures).toBeUndefined(); expect(result.purgedAccountIds).toEqual([ACCOUNT]);
    expect((await client.query("select keycloak_subject,display_name from accounts where world_id=$1", [WORLD])).rows)
      .toEqual([{ keycloak_subject: `erased:${ACCOUNT}`, display_name: "Gelöschtes Konto" }]);
    const journal = (await client.query("select * from archive_privacy_rows where world_id=$1", [WORLD])).rows;
    expect(journal).toHaveLength(1);
    expect(await worldFinalHistorySeal(adapter, WORLD)).toBe(originalSeal);
    expect((await readArchivePrivacyRedactions(adapter, WORLD)).requests).toHaveLength(1);
    expect(JSON.stringify(journal)).not.toMatch(/private-subject|Privater Name/u);
    await expect(client.query("delete from archive_privacy_rows where world_id=$1", [WORLD])).rejects.toThrow();
    expect((await purgeExpiredAccountData(db, new Date("2026-01-03Z"))).purgedAccountIds).toEqual([]);
  } finally { await client.close(); }
}, 60_000);

it("exportiert vor der Subjectentkopplung nur eigene Konto- und Postfachredaktionen samt Hashzeilen", async () => {
  const client = new PGlite(), db = drizzle(client);
  const otherAccount = "55555555-5555-4555-8555-555555555520";
  const otherWorldAccount = "66666666-6666-4666-8666-666666666520";
  const ownMessage = "77777777-7777-4777-8777-777777777520";
  const otherMessage = "88888888-8888-4888-8888-888888888520";
  const otherWorldMessage = "99999999-9999-4999-8999-999999999520";
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await client.query("insert into worlds(id,name,schedule_period_weeks,epoch) values($1,'Eigenes Archiv',4,'2025-01-01Z'),($2,'Andere Welt',4,'2025-01-01Z')", [WORLD, OTHER_WORLD]);
    for (const [worldId, accountId, subject, messageId] of [
      [WORLD, ACCOUNT, "export-own", ownMessage],
      [WORLD, otherAccount, "export-other", otherMessage],
      [OTHER_WORLD, otherWorldAccount, "export-own", otherWorldMessage],
    ]) {
      await client.query("insert into accounts(id,world_id,keycloak_subject,display_name) values($1,$2,$3,'Exportperson')", [accountId, worldId, subject]);
      await client.query("insert into mailbox_messages(id,world_id,recipient_account_id,message_type,payload,sent_at) values($1,$2,$3,'private.message','{\"privateText\":\"Nicht wiederherstellbarer Altinhalt\"}','2025-01-01Z')", [messageId, worldId, accountId]);
    }
    await client.query("update worlds set lifecycle_status='archived' where id in ($1,$2)", [WORLD, OTHER_WORLD]);
    for (const [worldId, subject] of [[WORLD, "export-own"], [WORLD, "export-other"], [OTHER_WORLD, "export-own"]]) {
      await eraseAccountData(db, { worldId: worldId!, targetKeycloakSubject: subject!, actingKeycloakSubject: subject!, erasedAt: new Date("2026-01-01Z") });
    }
    for (const worldId of [WORLD, OTHER_WORLD]) {
      await purgeExpiredMailboxMessages(db, { worldId, asOf: new Date("2026-01-02Z") });
    }
    const input = { worldId: WORLD, keycloakSubject: "export-own", exportedAt: new Date("2026-01-02Z") };
    const own = await exportAccountData(db, input);
    expect(own.schemaVersion).toBe("zugfolge-personal-data-export/v4");
    expect(own.mailboxMessages).toEqual([]);
    expect(own.archivePrivacy.requests.map((request) => [request.action, request.objectId])).toEqual([
      ["account-request", ACCOUNT], ["mailbox-purge", ownMessage],
    ]);
    for (const request of own.archivePrivacy.requests) {
      expect(request.worldId).toBe(WORLD);
      expect(request.rows.length).toBeGreaterThan(0);
      for (const row of request.rows) {
        expect(row.worldId).toBe(WORLD); expect(row.requestId).toBe(request.requestId);
        expect(row.beforeSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(row.afterSha256).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
    const serialized = JSON.stringify(own.archivePrivacy);
    for (const foreign of [OTHER_WORLD, otherAccount, otherWorldAccount, otherMessage, otherWorldMessage, "Nicht wiederherstellbarer Altinhalt", "export-other"]) {
      expect(serialized).not.toContain(foreign);
    }
    const elsewhere = await exportAccountData(db, { ...input, worldId: OTHER_WORLD });
    expect(elsewhere.archivePrivacy.requests.map((request) => request.objectId)).toEqual([otherWorldAccount, otherWorldMessage]);
    await expect(exportAccountData(db, { ...input, worldId: OTHER_WORLD, keycloakSubject: "export-other" })).rejects.toBeInstanceOf(PersonalDataNotFoundError);
    expect((await purgeExpiredAccountData(db, new Date("2026-04-01Z"))).failures).toBeUndefined();
    await expect(exportAccountData(db, input)).rejects.toBeInstanceOf(PersonalDataNotFoundError);
    await expect(exportAccountData(db, { ...input, worldId: OTHER_WORLD })).rejects.toBeInstanceOf(PersonalDataNotFoundError);
  } finally { await client.close(); }
}, 60_000);

it("verweigert fremde Selbstlöschung und erkennt ersetzte Triggerfunktion sowie falsches Ereignis trotz identischem Triggernamen", async () => {
  const client = new PGlite(), db = drizzle(client);
  try {
    const { inspectArchivePrivacyContract } = await import(new URL("../../../tools/alpha-ops/archive-privacy-binding.mjs", import.meta.url).href);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await client.query("insert into worlds(id,name,schedule_period_weeks,epoch) values($1,'Archiv',4,'2025-01-01Z')", [WORLD]);
    await client.query("insert into accounts(id,world_id,keycloak_subject,display_name) values($1,$2,'private-subject','Privater Name')", [ACCOUNT, WORLD]);
    await client.query("insert into conductor_owners(world_id,account_id,owner_ref) values($1,$2,$3)", [WORLD, ACCOUNT, OWNER]);
    await client.query("update worlds set lifecycle_status='archived' where id=$1", [WORLD]);
    const input = { worldId: WORLD, targetKeycloakSubject: "private-subject", actingKeycloakSubject: "private-subject", erasedAt: new Date("2026-01-01Z") };
    await expect(eraseAccountData(db, { ...input, actingKeycloakSubject: "foreign-subject" })).rejects.toThrow();
    expect((await client.query("select owner_ref from conductor_owners where world_id=$1", [WORLD])).rows).toHaveLength(1);
    await eraseAccountData(db, input);
    expect((await client.query("select * from conductor_owners where world_id=$1", [WORLD])).rows).toEqual([]);
    await expect(client.query("insert into archive_privacy_rows(world_id,request_id,row_sequence,table_name,before_sha256,before_v1_sha256,before_v1_added_facts) select world_id,request_id,999,'accounts',$2,$2,false from archive_privacy_requests where world_id=$1", [WORLD,"a".repeat(64)])).rejects.toThrow();
    await inspectArchivePrivacyContract(adapter(client));
    for (const replacement of [
      "CREATE TRIGGER archive_privacy_requests_apply AFTER INSERT ON archive_privacy_requests FOR EACH ROW EXECUTE FUNCTION zugfolge_archive_privacy_request_guard()",
      "CREATE TRIGGER archive_privacy_requests_apply AFTER UPDATE ON archive_privacy_requests FOR EACH ROW EXECUTE FUNCTION zugfolge_archive_privacy_apply()",
    ]) {
      const rollback = new Error("Geprüfte Manipulation zurückrollen");
      await expect(client.transaction(async (tx) => {
        await tx.query("DROP TRIGGER archive_privacy_requests_apply ON archive_privacy_requests");
        await tx.query(replacement);
        await expect(inspectArchivePrivacyContract({ unsafe: async (query: string, params: unknown[] = []) => (await tx.query(query, params)).rows })).rejects.toThrow(/verdrahtet/u);
        throw rollback;
      })).rejects.toBe(rollback);
    }
    await inspectArchivePrivacyContract(adapter(client));
  } finally { await client.close(); }
}, 60_000);
