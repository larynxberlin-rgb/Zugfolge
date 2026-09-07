import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type ArchiveDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;
export type ArchivePrivacyAction = "account-request" | "account-purge" | "mailbox-purge";

function rows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result !== null && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows as Record<string, unknown>[];
  throw new Error("Archivredaktion erhält kein Datenbankergebnis.");
}

/** Nur nach der fachlichen Autorisierung aufrufen; die DB erlaubt ausschließlich feste Redaktionen. */
export async function redactArchivedPersonalData(db: ArchiveDatabase, input: {
  readonly worldId: string; readonly action: ArchivePrivacyAction; readonly objectId: string;
  readonly asOf: Date; readonly contentHash?: string;
}): Promise<boolean> {
  if (!Number.isFinite(input.asOf.getTime())) throw new Error("Archivredaktionszeit ist ungültig.");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(('x'||substr(md5(${input.worldId}),1,16))::bit(64)::bigint)`);
    const [world] = rows(await tx.execute(sql`select lifecycle_status from worlds where id=${input.worldId}::uuid for update`));
    if (world?.["lifecycle_status"] !== "archived") return false;
    const [schema] = rows(await tx.execute(sql`select to_regclass('public.archive_privacy_requests') is not null as available`));
    if (schema?.["available"] !== true) return false; // Historische Schema-Fences bleiben unverändert wirksam.
    const existing = rows(await tx.execute(sql`select completed from archive_privacy_requests
      where world_id=${input.worldId}::uuid and action=${input.action} and object_id=${input.objectId}::uuid`));
    if (existing.length > 0) {
      if (existing[0]?.["completed"] !== true) throw new Error("Archivredaktion besitzt keinen abgeschlossenen Beleg.");
      return true;
    }
    await tx.execute(sql`insert into archive_privacy_requests(world_id,request_id,sequence,action,object_id,as_of,content_hash)
      select ${input.worldId}::uuid,${randomUUID()}::uuid,coalesce(max(sequence),0)+1,${input.action},${input.objectId}::uuid,
        ${input.asOf.toISOString()}::timestamptz,${input.contentHash ?? null}
      from archive_privacy_requests where world_id=${input.worldId}::uuid`);
    return true;
  });
}
