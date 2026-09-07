import { archivePrivacyRequests, archivePrivacyRows, mailboxMessages } from "@zugfolge/db";
import { type IdentityDatabase } from "@zugfolge/identity";
import { and, asc, eq, inArray, or } from "drizzle-orm";

/** Nur eigene bestehende Zuordnungen; Hashbelege rekonstruieren keine Altinhalte. */
export async function exportArchivePrivacyData(db: IdentityDatabase, worldId: string, accountId: string) {
  const ownMessageIds = db.select({ id: mailboxMessages.id }).from(mailboxMessages).where(and(
    eq(mailboxMessages.worldId, worldId), eq(mailboxMessages.recipientAccountId, accountId),
  ));
  const requests = await db.select().from(archivePrivacyRequests).where(and(
    eq(archivePrivacyRequests.worldId, worldId),
    or(
      and(inArray(archivePrivacyRequests.action, ["account-request", "account-purge"]), eq(archivePrivacyRequests.objectId, accountId)),
      and(eq(archivePrivacyRequests.action, "mailbox-purge"), inArray(archivePrivacyRequests.objectId, ownMessageIds)),
    ),
  )).orderBy(asc(archivePrivacyRequests.sequence));
  const rows = requests.length === 0 ? [] : await db.select().from(archivePrivacyRows).where(and(
    eq(archivePrivacyRows.worldId, worldId), inArray(archivePrivacyRows.requestId, requests.map((request) => request.requestId)),
  )).orderBy(asc(archivePrivacyRows.requestId), asc(archivePrivacyRows.rowSequence));
  return { requests: requests.map((request) => ({ ...request, rows: rows.filter((row) => row.requestId === request.requestId) })) };
}
