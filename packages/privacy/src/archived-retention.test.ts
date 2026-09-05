import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER } from "@zugfolge/db";
import { purgeExpiredMailboxMessages } from "@zugfolge/mailbox";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";

import { purgeExpiredAccountData } from "./erasure.js";

const WORLD = "11111111-1111-4111-8111-111111111520";
const ACCOUNT = "22222222-2222-4222-8222-222222222520";
const NEXT_WORLD = "33333333-3333-4333-8333-333333333520";
const NOW = new Date("2026-01-02T00:00:00Z");

/** Ein echter alter Migrationsstand, kein umgeschriebener aktueller Sollvertrag. */
async function schema33Migrations(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "zugfolge-privacy-archive33-"));
  await mkdir(join(folder, "meta"));
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const entries = journal.entries.slice(0, 33);
  await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  await Promise.all(entries.map(({ tag }) => copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`))));
  return folder;
}

it("belegt #520: historische Cutover-PII laesst sich nicht gleichzeitig purgen und unter demselben Vollzeilenseal validieren", async () => {
  const bindingsUrl = new URL("../../../tools/alpha-ops/database-rollback-binding.mjs", import.meta.url);
  const { worldFinalHistorySeal, worldCutoverReceiptHash, validateStoredWorldCutoverReceipt } = await import(bindingsUrl.href);
  const historical = { schemaVersion: "zugfolge-world-final-history-seal/v1" };
  const client = new PGlite();
  const db = drizzle(client);
  const folder33 = await schema33Migrations();
  const adapter = { unsafe: async (source: string, parameters: unknown[] = []) => (await client.query(source, parameters)).rows };
  try {
    await migrate(db, { migrationsFolder: folder33 });
    await client.query("insert into worlds(id,name,schedule_period_weeks,epoch) values($1,'Archiv33',4,'2025-01-01Z'),($2,'Folgewelt',4,'2026-01-01Z')", [WORLD, NEXT_WORLD]);
    await client.query("insert into accounts(id,world_id,keycloak_subject,display_name,erased_at) values($1,$2,'personal-subject-520','Geloeschtes Konto','2025-01-01Z')", [ACCOUNT, WORLD]);
    await client.query("insert into world_accesses(world_id,keycloak_subject,status,revoked_at) values($1,'personal-subject-520','revoked','2025-01-01Z')", [WORLD]);
    await client.query("insert into mailbox_messages(world_id,recipient_account_id,message_type,payload,sent_at) values($1,$2,'personal.notice','{\"text\":\"Persoenlicher Altinhalt\"}','2025-01-01Z')", [WORLD, ACCOUNT]);
    await client.query("update worlds set lifecycle_status='archived' where id=$1", [WORLD]);
    const before = await worldFinalHistorySeal(adapter, WORLD, historical);
    const [{ database_id: databaseIdentity }] = (await client.query<{ database_id: string }>("select database_id from zugfolge_database_identity")).rows;
    const receiptPayload = { schema: "zugfolge-world-cutover-receipt/v1", databaseIdentity,
      mode: "authorized-v1-to-v2-cutover", predecessorWorldId: WORLD, predecessorDeploymentHash: "1".repeat(64),
      predecessorFinalStateHash: before, candidateWorldId: NEXT_WORLD, candidateDeploymentHash: "2".repeat(64),
      beforeAuthoritativeHeadSha256: "3".repeat(64), afterAuthoritativeHeadSha256: "4".repeat(64) };
    const receiptHash = worldCutoverReceiptHash(receiptPayload);
    await client.query(`insert into world_cutover_receipts(candidate_world_id,database_id,mode,predecessor_world_id,predecessor_deployment_hash,predecessor_final_state_hash,candidate_deployment_hash,before_authoritative_head_sha256,after_authoritative_head_sha256,receipt_hash)
      values($1,$2,'authorized-v1-to-v2-cutover',$3,$4,$5,$6,$7,$8,$9)`, [NEXT_WORLD, databaseIdentity, WORLD, receiptPayload.predecessorDeploymentHash, before, receiptPayload.candidateDeploymentHash, receiptPayload.beforeAuthoritativeHeadSha256, receiptPayload.afterAuthoritativeHeadSha256, receiptHash]);
    const [storedReceipt] = (await client.query("select * from world_cutover_receipts where candidate_world_id=$1", [NEXT_WORLD])).rows;
    expect(validateStoredWorldCutoverReceipt(storedReceipt).receiptHash).toBe(receiptHash);

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    expect(await worldFinalHistorySeal(adapter, WORLD, historical)).toBe(before);
    const blocked = await purgeExpiredAccountData(db, NOW);
    expect(blocked.purgedAccountIds).toEqual([]);
    expect(blocked.failures).toMatchObject([{ accountId: ACCOUNT, worldId: WORLD }]);
    await expect(purgeExpiredMailboxMessages(db, { worldId: WORLD, asOf: NOW })).rejects.toThrow();
    expect(await worldFinalHistorySeal(adapter, WORLD, historical)).toBe(before);
    await expect(client.query("update world_cutover_receipts set predecessor_final_state_hash=$1 where candidate_world_id=$2", ["5".repeat(64), NEXT_WORLD])).rejects.toThrow(/immutable|unveraenderlich/iu);

    const rollbackProbe = new Error("Nur der negative Integrationsbeweis wird zurueckgerollt.");
    await expect(db.transaction(async (tx) => {
      const transactionAdapter = { unsafe: async (source: string, parameters: unknown[] = []) => {
        const statement = sql.empty();
        source.split(/\$(\d+)/u).forEach((part, index) => statement.append(index % 2 === 0 ? sql.raw(part) : sql`${parameters[Number(part) - 1]}`));
        return (await tx.execute(statement)).rows;
      } };
      // Ausschliesslich diese wegwerfbare PGlite-Transaktion zeigt, warum das
      // Entfernen der Fence kein Fix ist. Produktiv gibt es keinen Bypass.
      for (const table of ["accounts", "world_accesses", "account_roles", "world_participations", "mailbox_messages"]) {
        await tx.execute(sql.raw(`alter table ${table} disable trigger zugfolge_world_guard_${table}`));
      }
      expect((await purgeExpiredAccountData(tx, NOW)).purgedAccountIds).toEqual([ACCOUNT]);
      expect(await worldFinalHistorySeal(transactionAdapter, WORLD, historical)).not.toBe(before);
      expect((await purgeExpiredMailboxMessages(tx, { worldId: WORLD, asOf: NOW })).purgedMessageIds).toHaveLength(1);
      // Der echte neue Postfachpurge schreibt zudem purged_at/content_hash;
      // die v1-Kompatibilitaetspruefung darf diese Fakten nicht wegprojizieren.
      await expect(worldFinalHistorySeal(transactionAdapter, WORLD, historical)).rejects.toThrow(/Schema-34-Fakten/u);
      expect(validateStoredWorldCutoverReceipt(storedReceipt).payload.predecessorFinalStateHash).toBe(before);
      throw rollbackProbe;
    })).rejects.toBe(rollbackProbe);
    expect(await worldFinalHistorySeal(adapter, WORLD, historical)).toBe(before);
    expect((await client.query("select keycloak_subject from accounts where world_id=$1", [WORLD])).rows).toEqual([{ keycloak_subject: "personal-subject-520" }]);
  } finally {
    await client.close();
    await rm(folder33, { recursive: true, force: true });
  }
}, 60_000);
