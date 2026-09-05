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

import { accountRoles, accounts, worldAccesses, worldParticipations } from "@zugfolge/db";
import {
  AuthorizationError,
  getAccount,
  getAccountIncludingRevoked,
  revokeWorldAccess,
  type AccountRecord,
  type IdentityDatabase,
} from "@zugfolge/identity";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";

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
 * Wiederholte Löschung erhaelt atomar den ersten wirksamen Zeitpunkt.
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

  const [updated] = await db
    .update(accounts)
    .set({ displayName: ERASED_DISPLAY_NAME, erasedAt: sql`coalesce(${accounts.erasedAt}, ${input.erasedAt})` })
    .where(and(eq(accounts.worldId, input.worldId), eq(accounts.id, target.id)))
    .returning();

  if (updated === undefined) throw new PersonalDataNotFoundError(input.worldId, input.targetKeycloakSubject);
  return { ...updated, roles: target.roles };
}

const ACCOUNT_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;

export interface RetentionPurgeResult {
  readonly purgedAccountIds: readonly string[];
  readonly failures?: readonly { readonly accountId: string; readonly worldId: string; readonly error: unknown }[];
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
  // guards:allow world-id — Der globale Aufbewahrungs-Sweeper enumeriert Kandidaten und loescht anschliessend je Welt und Konto.
  const candidates = await db
    .select({
      id: accounts.id,
      worldId: accounts.worldId,
      keycloakSubject: accounts.keycloakSubject,
    })
    .from(accounts)
    .where(and(isNotNull(accounts.erasedAt), lte(accounts.erasedAt, cutoff)));

  const purgedAccountIds: string[] = [];
  const failures: { readonly accountId: string; readonly worldId: string; readonly error: unknown }[] = [];
  for (const candidate of candidates) {
    if (candidate.keycloakSubject.startsWith("erased:")) {
      continue;
    }
    const pseudonymousSubject = `erased:${candidate.id}`;
    try {
    const purged = await db.transaction(async (tx) => {
      await tx
        .update(worldAccesses)
        .set({ keycloakSubject: pseudonymousSubject })
        .where(
          and(
            eq(worldAccesses.worldId, candidate.worldId),
            eq(worldAccesses.keycloakSubject, candidate.keycloakSubject),
          ),
        );
      const [updated] = await tx
        .update(accounts)
        .set({ keycloakSubject: pseudonymousSubject })
        .where(and(eq(accounts.worldId, candidate.worldId), eq(accounts.id, candidate.id), eq(accounts.keycloakSubject, candidate.keycloakSubject)))
        .returning({ id: accounts.id });
      if (updated === undefined) return false;
      await tx.update(worldParticipations).set({ keycloakSubject: pseudonymousSubject, displayName: ERASED_DISPLAY_NAME })
        .where(and(eq(worldParticipations.worldId, candidate.worldId), eq(worldParticipations.keycloakSubject, candidate.keycloakSubject)));
      await tx
        .delete(accountRoles)
        .where(and(eq(accountRoles.worldId, candidate.worldId), eq(accountRoles.accountId, candidate.id)));
      return true;
    });
    if (purged) purgedAccountIds.push(candidate.id);
    } catch (error) {
      failures.push({ accountId: candidate.id, worldId: candidate.worldId, error });
    }
  }
  return { purgedAccountIds, ...(failures.length === 0 ? {} : { failures }) };
}
