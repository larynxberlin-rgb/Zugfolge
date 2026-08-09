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

import { accountRoles, accounts, worldAccesses } from "@zugfolge/db";
import {
  AuthorizationError,
  getAccount,
  getAccountIncludingRevoked,
  revokeWorldAccess,
  type AccountRecord,
  type IdentityDatabase,
} from "@zugfolge/identity";
import { and, eq, isNotNull, lte } from "drizzle-orm";

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

  const target = await getAccountIncludingRevoked(db, {
    worldId: input.worldId,
    keycloakSubject: input.targetKeycloakSubject,
  });
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

const ACCOUNT_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;

export interface RetentionPurgeResult {
  readonly purgedAccountIds: readonly string[];
}

/**
 * Vollzieht die Datenschutzlöschung nach der 90-Tage-Übergangsfrist. Die
 * fachliche Konto-ID bleibt für unveränderliche Betriebsbelege erhalten, der
 * externe Keycloak-Identifier wird jedoch irreversibel durch einen lokalen,
 * nicht weltübergreifend korrelierbaren Platzhalter ersetzt. Frühere Rollen
 * werden entfernt; der widerrufene Zugang bleibt als Sperrbeleg erhalten.
 */
export async function purgeExpiredAccountData(
  db: IdentityDatabase,
  asOf: Date,
): Promise<RetentionPurgeResult> {
  const cutoff = new Date(asOf.getTime() - ACCOUNT_RETENTION_MILLISECONDS);
  const candidates = await db
    .select({
      id: accounts.id,
      worldId: accounts.worldId,
      keycloakSubject: accounts.keycloakSubject,
    })
    .from(accounts)
    .where(and(isNotNull(accounts.erasedAt), lte(accounts.erasedAt, cutoff)));

  const purgedAccountIds: string[] = [];
  for (const candidate of candidates) {
    if (candidate.keycloakSubject.startsWith("erased:")) {
      continue;
    }
    const pseudonymousSubject = `erased:${candidate.id}`;
    await db.transaction(async (tx) => {
      await tx
        .update(worldAccesses)
        .set({ keycloakSubject: pseudonymousSubject })
        .where(
          and(
            eq(worldAccesses.worldId, candidate.worldId),
            eq(worldAccesses.keycloakSubject, candidate.keycloakSubject),
          ),
        );
      await tx
        .update(accounts)
        .set({ keycloakSubject: pseudonymousSubject })
        .where(and(eq(accounts.worldId, candidate.worldId), eq(accounts.id, candidate.id)));
      await tx
        .delete(accountRoles)
        .where(and(eq(accountRoles.worldId, candidate.worldId), eq(accountRoles.accountId, candidate.id)));
    });
    purgedAccountIds.push(candidate.id);
  }
  return { purgedAccountIds };
}
