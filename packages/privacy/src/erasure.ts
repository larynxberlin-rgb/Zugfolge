/**
 * Löschung (M2.6): anonymisiert die Personendaten eines Kontos und entzieht
 * den Weltzugang. Das Konto selbst — seine `id` und seine Betriebshistorie —
 * bleibt bestehen, aus demselben Grund wie bei einer Insolvenz (E8): Fremde
 * Zeilen (EVU, Ledger, Ereignisprotokoll) verweisen auf die Konto-`id`, und
 * eine physische Löschung würde entweder diese Verweise zerstören oder eine
 * Historie unlesbar machen, die die Welt weiter braucht.
 *
 * Zwei Wege zur Löschung: die betroffene Identität löscht sich selbst, oder
 * ein Weltverwalter löscht auf Anfrage ein fremdes Konto. Jeder andere Weg
 * bleibt verboten.
 */

import { accounts } from "@zugfolge/db";
import { AuthorizationError, getAccount, revokeWorldAccess, type AccountRecord, type IdentityDatabase } from "@zugfolge/identity";
import { and, eq } from "drizzle-orm";

import { PersonalDataNotFoundError } from "./export.js";

/** Der im Konto sichtbare Anzeigename nach einer Löschung — trägt keine Personendaten mehr. */
export const ERASED_DISPLAY_NAME = "Gelöschtes Konto";

async function requireSelfOrWorldAdmin(
  db: IdentityDatabase,
  worldId: string,
  actingKeycloakSubject: string,
  targetKeycloakSubject: string,
): Promise<void> {
  if (actingKeycloakSubject === targetKeycloakSubject) {
    return;
  }
  const actingAccount = await getAccount(db, { worldId, keycloakSubject: actingKeycloakSubject });
  if (actingAccount === undefined || !actingAccount.roles.includes("world_admin")) {
    throw new AuthorizationError(
      `Konto ist kein Weltverwalter von '${worldId}' — Löschung eines fremden Kontos nicht erlaubt.`,
    );
  }
}

/**
 * Anonymisiert Anzeigename und Zeitstempel eines Kontos und entzieht den
 * Weltzugang (`revokeWorldAccess`, mit derselben Selbstbedienungs-Ausnahme).
 * Wiederholte Löschung ist unschädlich — sie überschreibt nur denselben Wert.
 */
export async function eraseAccountData(
  db: IdentityDatabase,
  input: {
    readonly worldId: string;
    readonly targetKeycloakSubject: string;
    readonly actingKeycloakSubject: string;
    readonly erasedAt: Date;
  },
): Promise<AccountRecord> {
  await requireSelfOrWorldAdmin(db, input.worldId, input.actingKeycloakSubject, input.targetKeycloakSubject);

  const target = await getAccount(db, { worldId: input.worldId, keycloakSubject: input.targetKeycloakSubject });
  if (target === undefined) {
    throw new PersonalDataNotFoundError(input.worldId, input.targetKeycloakSubject);
  }

  await revokeWorldAccess(db, {
    worldId: input.worldId,
    targetKeycloakSubject: input.targetKeycloakSubject,
    actingKeycloakSubject: input.actingKeycloakSubject,
  });

  await db
    .update(accounts)
    .set({ displayName: ERASED_DISPLAY_NAME, erasedAt: input.erasedAt })
    .where(and(eq(accounts.worldId, input.worldId), eq(accounts.id, target.id)));

  return { ...target, displayName: ERASED_DISPLAY_NAME, erasedAt: input.erasedAt };
}
