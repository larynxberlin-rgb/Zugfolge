/**
 * Auskunft (M2.6): ein vollständiges, maschinenlesbares Bündel aller
 * Personendaten, die das Spielsystem selbst über ein Konto in einer Welt
 * führt. Ledger und Event-Log bleiben außen vor — sie tragen EVU und
 * Weltverlauf, keine natürliche Person (`retention.ts`).
 */

import { operators, worldAccesses, type MailboxMessage, type Operator } from "@zugfolge/db";
import { getAccount, type AccountRecord, type IdentityDatabase } from "@zugfolge/identity";
import { listInbox } from "@zugfolge/mailbox";
import { and, eq } from "drizzle-orm";

/** Für dieses Keycloak-Subject existiert kein Konto in der angefragten Welt. */
export class PersonalDataNotFoundError extends Error {
  constructor(worldId: string, keycloakSubject: string) {
    super(`Kein Konto für Subject '${keycloakSubject}' in Welt '${worldId}' — keine Auskunft möglich.`);
    this.name = "PersonalDataNotFoundError";
  }
}

export interface PersonalDataExport {
  readonly worldId: string;
  readonly account: AccountRecord;
  readonly worldAccessStatus: "active" | "revoked" | "none";
  readonly operators: readonly Operator[];
  readonly mailboxMessages: readonly MailboxMessage[];
  readonly exportedAt: Date;
}

/** Baut die vollständige Auskunft für ein Konto in einer Welt. */
export async function exportAccountData(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly keycloakSubject: string; readonly exportedAt: Date },
): Promise<PersonalDataExport> {
  const account = await getAccount(db, { worldId: input.worldId, keycloakSubject: input.keycloakSubject });
  if (account === undefined) {
    throw new PersonalDataNotFoundError(input.worldId, input.keycloakSubject);
  }

  const [access] = await db
    .select({ status: worldAccesses.status })
    .from(worldAccesses)
    .where(and(eq(worldAccesses.worldId, input.worldId), eq(worldAccesses.keycloakSubject, input.keycloakSubject)))
    .limit(1);

  const ownedOperators = await db
    .select()
    .from(operators)
    .where(and(eq(operators.worldId, input.worldId), eq(operators.foundingAccountId, account.id)));

  const mailboxMessages = await listInbox(db, {
    worldId: input.worldId,
    requestingKeycloakSubject: input.keycloakSubject,
  });

  return {
    worldId: input.worldId,
    account,
    worldAccessStatus: access?.status ?? "none",
    operators: ownedOperators,
    mailboxMessages,
    exportedAt: input.exportedAt,
  };
}
