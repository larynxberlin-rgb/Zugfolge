/**
 * Auskunft (M2.6): ein vollständiges, maschinenlesbares Bündel aller
 * Personendaten, die das Spielsystem selbst über ein Konto in einer Welt
 * führt. Ledger und Event-Log bleiben außen vor — sie tragen EVU und
 * Weltverlauf, keine natürliche Person (`retention.ts`).
 */

import { operators, worldAccesses, mailboxMessages, commerceEntitlements, commerceWorldClaims, worldParticipations, type MailboxMessage, type Operator, type WorldAccess } from "@zugfolge/db";
import { getAccountIncludingRevoked, type AccountRecord, type IdentityDatabase } from "@zugfolge/identity";
import { and, eq, isNull } from "drizzle-orm";

/** Für dieses Keycloak-Subject existiert kein Konto in der angefragten Welt. */
export class PersonalDataNotFoundError extends Error {
  constructor(worldId: string, keycloakSubject: string) {
    super(`Kein Konto für Subject '${keycloakSubject}' in Welt '${worldId}' — keine Auskunft möglich.`);
    this.name = "PersonalDataNotFoundError";
  }
}

export interface PersonalDataExport {
  readonly schemaVersion: "zugfolge-personal-data-export/v3";
  readonly worldId: string;
  readonly account: AccountRecord;
  readonly worldAccessStatus: "active" | "revoked" | "none";
  readonly worldAccess: WorldAccess | null;
  readonly commerceEntitlements: readonly (typeof commerceEntitlements.$inferSelect)[];
  readonly commerceWorldClaims: readonly (typeof commerceWorldClaims.$inferSelect)[];
  readonly worldParticipations: readonly (typeof worldParticipations.$inferSelect)[];
  readonly operators: readonly Operator[];
  readonly mailboxMessages: readonly MailboxMessage[];
  readonly exportedAt: Date;
}

/** Baut die vollständige Auskunft für ein Konto in einer Welt. */
export async function exportAccountData(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly keycloakSubject: string; readonly exportedAt: Date },
): Promise<PersonalDataExport> {
  const account = await getAccountIncludingRevoked(db, { worldId: input.worldId, keycloakSubject: input.keycloakSubject });
  if (account === undefined) {
    throw new PersonalDataNotFoundError(input.worldId, input.keycloakSubject);
  }

  const [access] = await db
    .select()
    .from(worldAccesses)
    .where(and(eq(worldAccesses.worldId, input.worldId), eq(worldAccesses.keycloakSubject, input.keycloakSubject)))
    .limit(1);

  const ownedOperators = await db
    .select()
    .from(operators)
    .where(and(eq(operators.worldId, input.worldId), eq(operators.foundingAccountId, account.id)));

  // Die authentifizierte Selbst-Auskunft bleibt vom Spielzugang unabhaengig.
  const messages = await db.select().from(mailboxMessages).where(and(
    eq(mailboxMessages.worldId, input.worldId), eq(mailboxMessages.recipientAccountId, account.id), isNull(mailboxMessages.purgedAt),
  ));
  // guards:allow world-id — Eigene kaufmaennische Berechtigungen sind global und ausschliesslich an das authentifizierte Subject gebunden.
  const entitlements = await db.select().from(commerceEntitlements).where(eq(commerceEntitlements.keycloakSubject, input.keycloakSubject));
  const claims = (await Promise.all(entitlements.map((entitlement) => db.select().from(commerceWorldClaims).where(and(
    eq(commerceWorldClaims.worldId, input.worldId), eq(commerceWorldClaims.entitlementId, entitlement.id),
  ))))).flat();
  const participations = await db.select().from(worldParticipations).where(and(eq(worldParticipations.worldId, input.worldId), eq(worldParticipations.keycloakSubject, input.keycloakSubject)));

  return {
    schemaVersion: "zugfolge-personal-data-export/v3",
    worldId: input.worldId,
    account,
    worldAccessStatus: access?.status ?? "none",
    worldAccess: access ?? null,
    commerceEntitlements: entitlements,
    commerceWorldClaims: claims,
    worldParticipations: participations,
    operators: ownedOperators,
    mailboxMessages: messages,
    exportedAt: input.exportedAt,
  };
}
