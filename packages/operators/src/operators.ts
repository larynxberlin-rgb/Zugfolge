/**
 * EVU als Entität (M2.3): Gründung, Stammdaten, Zuordnung zu Welt und
 * gründendem Konto.
 *
 * Ein EVU braucht ein bestehendes Konto in der Welt — wer noch keins hat,
 * muss zuerst den Weltzugang beantragen (`requestWorldAccess`,
 * `packages/identity`). Die EVU-Liste einer Welt trägt denselben Belegungstest
 * wie die Kontoliste (M2.1): Nur wer selbst ein Konto in der Welt hat, sieht
 * sie. Die vollständige Transparenz der Livemap (E9) betrifft den laufenden
 * Verkehr, nicht die interne Verwaltungsschnittstelle — bis M4 tatsächlich
 * eine öffentliche EVU-Liste braucht, bleibt die engere Regel richtig.
 */

import { accounts, operators, worlds, type Operator } from "@zugfolge/db";
import { AuthorizationError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { and, eq, sql } from "drizzle-orm";

/** Die handelnde Identität hat kein Konto in dieser Welt und kann dort kein EVU gründen. */
export class NoAccountInWorldError extends Error {
  constructor(worldId: string) {
    super(`Kein Konto in Welt '${worldId}' — EVU-Gründung nicht möglich.`);
    this.name = "NoAccountInWorldError";
  }
}

/** Der Unternehmensname ist in dieser Welt bereits vergeben (E6: eigene Unternehmensmarke). */
export class DuplicateOperatorNameError extends Error {
  constructor(worldId: string, name: string) {
    super(`Unternehmensname '${name}' ist in Welt '${worldId}' bereits vergeben.`);
    this.name = "DuplicateOperatorNameError";
  }
}

/** In einer öffentlichen Welt darf ein Spieler genau ein eigenes EVU besitzen (M13.3). */
export class PublicWorldOperatorLimitError extends Error {
  constructor(worldId: string) {
    super(`In der öffentlichen Welt '${worldId}' ist nur ein eigenes EVU je Spieler erlaubt.`);
    this.name = "PublicWorldOperatorLimitError";
  }
}

/** In einer noch nicht gestarteten oder bereits archivierten Welt darf kein EVU entstehen. */
export class OperatorFoundationWorldInactiveError extends AuthorizationError {
  constructor(worldId: string) {
    super(`Welt '${worldId}' ist nicht aktiv - EVU-Gruendung nicht moeglich.`);
    this.name = "OperatorFoundationWorldInactiveError";
  }
}

/** Das angesprochene EVU existiert nicht — oder nicht in dieser Welt. */
export class OperatorNotFoundError extends Error {
  constructor(operatorId: string, worldId: string) {
    super(`EVU '${operatorId}' existiert nicht in Welt '${worldId}'.`);
    this.name = "OperatorNotFoundError";
  }
}

/**
 * Gründet ein EVU: legt Stammdaten an und ordnet sie der Welt und dem
 * gründenden Konto zu. Ein Konto kann mehrere EVU gründen — Kooperation
 * zwischen EVU (`wirtschaft.md` 6) setzt getrennte Rechtsträger voraus, keine
 * Beschränkung auf eines je Konto.
 */
export interface OperatorFoundationResult {
  readonly operator: Operator;
  /** Nur identische Wiederholungen der öffentlichen Ein-EVU-Gründung sind Replays. */
  readonly idempotentReplay: boolean;
}

export interface OperatorFoundationContext extends OperatorFoundationResult {
  readonly worldId: string;
  readonly worldKind: "public" | "private";
  readonly worldEpoch: Date;
}

/**
 * Atomare Gründungsgrenze für fachliche Initialisierer wie die Eröffnungsbilanz.
 * Die Weltzeile serialisiert konkurrierende Gründungen. In öffentlichen Welten
 * konvergiert derselbe Konto-/Namensaufruf auf das bereits gegründete EVU;
 * ein anderer Name bleibt wegen der Ein-EVU-Regel ein Konflikt.
 */
export async function foundOperatorWithInitialization(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly foundingKeycloakSubject: string; readonly name: string },
  initialize: (db: IdentityDatabase, context: OperatorFoundationContext) => Promise<void>,
): Promise<OperatorFoundationResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${input.worldId} for update`);
    const account = await getAccount(tx, { worldId: input.worldId, keycloakSubject: input.foundingKeycloakSubject });
    if (account === undefined) throw new NoAccountInWorldError(input.worldId);

    const [world] = await tx
      .select({ worldKind: worlds.worldKind, epoch: worlds.epoch, lifecycleStatus: worlds.lifecycleStatus })
      .from(worlds)
      .where(eq(worlds.id, input.worldId))
      .limit(1);
    if (world === undefined) throw new Error(`Welt '${input.worldId}' existiert nicht.`);
    if (world.lifecycleStatus !== "active") throw new OperatorFoundationWorldInactiveError(input.worldId);

    if (world.worldKind === "public") {
      const [owned] = await tx
        .select()
        .from(operators)
        .where(and(eq(operators.worldId, input.worldId), eq(operators.foundingAccountId, account.id)))
        .limit(1);
      if (owned !== undefined) {
        if (owned.name !== input.name) throw new PublicWorldOperatorLimitError(input.worldId);
        const context = {
          operator: owned,
          idempotentReplay: true,
          worldId: input.worldId,
          worldKind: world.worldKind,
          worldEpoch: world.epoch,
        } as const;
        await initialize(tx, context);
        return context;
      }
    }

    const [existing] = await tx
      .select({ id: operators.id })
      .from(operators)
      .where(and(eq(operators.worldId, input.worldId), eq(operators.name, input.name)))
      .limit(1);
    if (existing !== undefined) throw new DuplicateOperatorNameError(input.worldId, input.name);

    const [created] = await tx
      .insert(operators)
      .values({ worldId: input.worldId, foundingAccountId: account.id, name: input.name })
      .returning();
    if (created === undefined) throw new Error("EVU konnte nicht angelegt werden.");
    const context = {
      operator: created,
      idempotentReplay: false,
      worldId: input.worldId,
      worldKind: world.worldKind,
      worldEpoch: world.epoch,
    } as const;
    await initialize(tx, context);
    return context;
  });
}

export async function foundOperator(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly foundingKeycloakSubject: string; readonly name: string },
): Promise<Operator> {
  return (await foundOperatorWithInitialization(db, input, async () => {})).operator;
}

/**
 * Ein einzelnes EVU einer Welt, samt seines gründenden Kontos — Grundlage für
 * die Trägerprüfung des Ledger-Kerns (M2.4): Nur das gründende Konto darf die
 * Bücher seines EVU führen.
 */
export async function getOperator(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly operatorId: string },
): Promise<Operator> {
  const [found] = await db
    .select()
    .from(operators)
    .where(and(eq(operators.worldId, input.worldId), eq(operators.id, input.operatorId)))
    .limit(1);
  if (found === undefined) {
    throw new OperatorNotFoundError(input.operatorId, input.worldId);
  }
  return found;
}

/**
 * Alle EVU einer Welt. Verlangt wie die Kontoliste (M2.1) ein eigenes Konto
 * in dieser Welt — wer nicht Mitglied der Welt ist, sieht sie nicht.
 */
export async function listOperatorsInWorld(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly requestingKeycloakSubject: string },
): Promise<readonly Operator[]> {
  const requester = await getAccount(db, {
    worldId: input.worldId,
    keycloakSubject: input.requestingKeycloakSubject,
  });
  if (requester === undefined) {
    throw new AuthorizationError(`Kein Konto in Welt '${input.worldId}' — EVU-Liste nicht sichtbar.`);
  }
  return db.select().from(operators).where(eq(operators.worldId, input.worldId));
}

/**
 * Alle EVU, die ein Keycloak-Subject gegründet hat — weltübergreifend, über
 * jedes Konto hinweg, das dieses Subject je geführt hat. Spiegelt
 * `listAccountsForSubject` aus M2.1: nur die eigenen, keine fremden.
 */
export async function listOperatorsForAccount(
  db: IdentityDatabase,
  keycloakSubject: string,
): Promise<readonly Operator[]> {
  // guards:allow world-id — Die Identitaetsansicht listet nur eigene Betreiber des authentifizierten Subjects weltuebergreifend.
  return db
    .select({
      id: operators.id,
      worldId: operators.worldId,
      foundingAccountId: operators.foundingAccountId,
      name: operators.name,
      operatorKind: operators.operatorKind,
      lifecycle: operators.lifecycle,
      foundedAt: operators.foundedAt,
    })
    .from(operators)
    .innerJoin(accounts, eq(accounts.id, operators.foundingAccountId))
    .where(eq(accounts.keycloakSubject, keycloakSubject));
}
