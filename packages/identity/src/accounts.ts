/**
 * Konten, Rollen und Weltzugänge (M2.1).
 *
 * Jede Abfrage hier ist nach `world_id` geschnitten (Invariante 4): Wer nach
 * einer Welt fragt, bekommt ausschließlich, was zu ihr gehört, und muss
 * selbst ein Konto in ihr haben, um ihre Kontoliste zu sehen. Das ist die
 * kleine, hier bereits nachgewiesene Vorstufe der automatisierten
 * Weltisolation aus M2.2.
 */

import { accountRoles, accounts, worldAccesses, worlds } from "@zugfolge/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Role } from "./roles.js";

/**
 * Verbindungstyp, unabhängig vom Treiber (`@zugfolge/db`s postgres-js im
 * Betrieb, PGlite im Test) — derselbe Schnitt wie `AnyDatabase` in
 * `packages/db/src/world-scope.ts`.
 */
export type IdentityDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

export interface AccountRecord {
  readonly id: string;
  readonly worldId: string;
  readonly keycloakSubject: string;
  readonly displayName: string;
  readonly createdAt: Date;
  /** Zeitpunkt einer Datenschutzlöschung (M2.6); `null` heißt unangetastet. */
  readonly erasedAt: Date | null;
  readonly roles: readonly Role[];
}

export type AcceptedStartingCapitalPolicy =
  | { readonly kind: "finite"; readonly amountCents: string }
  | { readonly kind: "unlimited" };

export interface AcceptedWorldContract {
  readonly hash: string;
  readonly startingCapitalPolicy: AcceptedStartingCapitalPolicy;
}

/** Ein bereits bestaetigter Weltvertrag darf nicht still ersetzt werden. */
export class WorldContractAcceptanceConflictError extends Error {
  constructor(worldId: string) {
    super(`Der bestaetigte Weltvertrag von '${worldId}' stimmt nicht mit dem aktuellen Vertrag ueberein.`);
    this.name = "WorldContractAcceptanceConflictError";
  }
}

function validateAcceptedWorldContract(contract: AcceptedWorldContract): void {
  if (!/^[a-f0-9]{64}$/.test(contract.hash)) throw new Error("Bestaetigter Weltvertrag besitzt keinen SHA-256-Hash.");
  if (contract.startingCapitalPolicy.kind === "unlimited") return;
  const amount = contract.startingCapitalPolicy.amountCents;
  if (!/^[0-9]+$/.test(amount) || BigInt(amount) > 9_223_372_036_854_775_807n) {
    throw new Error("Bestaetigte StartingCapitalPolicy besitzt keinen nichtnegativen i64-Centbetrag.");
  }
}

function sameStartingCapitalPolicy(left: unknown, right: AcceptedStartingCapitalPolicy): boolean {
  if (typeof left !== "object" || left === null || Array.isArray(left)) return false;
  const record = left as Readonly<Record<string, unknown>>;
  return right.kind === "unlimited"
    ? record["kind"] === "unlimited" && Object.keys(record).length === 1
    : record["kind"] === "finite" && record["amountCents"] === right.amountCents && Object.keys(record).length === 2;
}

/** Öffentliches Konto-DTO ohne den externen, korrelierbaren Keycloak-Identifier. */
export type PublicAccountRecord = Omit<AccountRecord, "keycloakSubject">;

/** Die anfragende Identität hat in dieser Welt (noch) keinen Zugang. */
export class AccessRevokedError extends Error {
  constructor(worldId: string) {
    super(`Der Weltzugang zu '${worldId}' wurde entzogen.`);
    this.name = "AccessRevokedError";
  }
}

/** Die anfragende Identität darf diese Aktion in dieser Welt nicht ausführen. */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Das angesprochene Konto existiert nicht — oder nicht in dieser Welt. */
export class AccountNotFoundError extends Error {
  constructor(accountId: string, worldId: string) {
    super(`Konto '${accountId}' existiert nicht in Welt '${worldId}'.`);
    this.name = "AccountNotFoundError";
  }
}

async function rolesOf(db: IdentityDatabase, worldId: string, accountId: string): Promise<Role[]> {
  const rows = await db
    .select({ role: accountRoles.role })
    .from(accountRoles)
    .where(and(eq(accountRoles.worldId, worldId), eq(accountRoles.accountId, accountId)));
  return rows.map((row) => row.role as Role);
}

async function findAccount(
  db: IdentityDatabase,
  worldId: string,
  keycloakSubject: string,
  requireActiveAccess = true,
): Promise<AccountRecord | undefined> {
  if (requireActiveAccess) {
    const [access] = await db
      .select({ status: worldAccesses.status })
      .from(worldAccesses)
      .where(and(eq(worldAccesses.worldId, worldId), eq(worldAccesses.keycloakSubject, keycloakSubject)))
      .limit(1);
    if (access?.status === "revoked") {
      throw new AccessRevokedError(worldId);
    }
    if (access === undefined || access.status !== "active") {
      return undefined;
    }
  }
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.worldId, worldId), eq(accounts.keycloakSubject, keycloakSubject)))
    .limit(1);
  if (row === undefined) {
    return undefined;
  }
  return { ...row, roles: await rolesOf(db, worldId, row.id) };
}

/**
 * Das Konto eines Keycloak-Subjects in genau einer Welt, samt Rollen — oder
 * `undefined`, wenn keins existiert. Grundlage für Pakete, die auf ein
 * bestehendes Konto aufbauen (`packages/operators`, `packages/privacy`),
 * ohne die interne Kontosuche zu duplizieren.
 */
export async function getAccount(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly keycloakSubject: string },
): Promise<AccountRecord | undefined> {
  return findAccount(db, input.worldId, input.keycloakSubject);
}

/**
 * Interner Verwaltungszugriff auf ein historisches Konto. Darf niemals als
 * Autorisierungsprüfung verwendet werden; er ist ausschließlich für
 * authentifizierte Datenschutz-Selbstauskunft, Datenschutz-Purge und
 * ausdruecklich administrative Historienpflege gedacht.
 */
export async function getAccountIncludingRevoked(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly keycloakSubject: string },
): Promise<AccountRecord | undefined> {
  return findAccount(db, input.worldId, input.keycloakSubject, false);
}

/**
 * Selbstbedienter Weltzugang: legt bei Bedarf Zugang, Konto und die Rolle
 * `player` an. Ein zuvor entzogener Zugang wird **nicht** stillschweigend
 * reaktiviert — das bleibt einer bewussten administrativen Handlung
 * vorbehalten.
 */
export async function requestWorldAccess(
  db: IdentityDatabase,
  input: {
    readonly worldId: string;
    readonly keycloakSubject: string;
    readonly displayName: string;
    readonly acceptedWorldContract?: AcceptedWorldContract;
  },
): Promise<AccountRecord> {
  const { worldId, keycloakSubject, displayName } = input;
  if (input.acceptedWorldContract !== undefined) validateAcceptedWorldContract(input.acceptedWorldContract);

  let [existingAccess] = await db
    .select()
    .from(worldAccesses)
    .where(and(eq(worldAccesses.worldId, worldId), eq(worldAccesses.keycloakSubject, keycloakSubject)))
    .limit(1);

  if (existingAccess !== undefined && existingAccess.status === "revoked") {
    throw new AccessRevokedError(worldId);
  }

  if (existingAccess === undefined) {
    await db.insert(worldAccesses).values({
      worldId,
      keycloakSubject,
      ...(input.acceptedWorldContract === undefined ? {} : {
        acceptedWorldContractHash: input.acceptedWorldContract.hash,
        acceptedStartingCapitalPolicy: input.acceptedWorldContract.startingCapitalPolicy,
        worldContractAcceptedAt: new Date(),
      }),
    }).onConflictDoNothing();
  } else if (input.acceptedWorldContract !== undefined && existingAccess.acceptedWorldContractHash === null) {
    await db.update(worldAccesses).set({
      acceptedWorldContractHash: input.acceptedWorldContract.hash,
      acceptedStartingCapitalPolicy: input.acceptedWorldContract.startingCapitalPolicy,
      worldContractAcceptedAt: new Date(),
    }).where(and(
      eq(worldAccesses.worldId, worldId),
      eq(worldAccesses.keycloakSubject, keycloakSubject),
      isNull(worldAccesses.acceptedWorldContractHash),
    ));
  }

  if (input.acceptedWorldContract !== undefined) {
    [existingAccess] = await db.select().from(worldAccesses).where(and(
      eq(worldAccesses.worldId, worldId),
      eq(worldAccesses.keycloakSubject, keycloakSubject),
    )).limit(1);
    if (existingAccess?.acceptedWorldContractHash !== input.acceptedWorldContract.hash
      || !sameStartingCapitalPolicy(existingAccess.acceptedStartingCapitalPolicy, input.acceptedWorldContract.startingCapitalPolicy)) {
      throw new WorldContractAcceptanceConflictError(worldId);
    }
  }

  await db.insert(accounts).values({ worldId, keycloakSubject, displayName }).onConflictDoNothing();

  const account = await findAccount(db, worldId, keycloakSubject);
  if (account === undefined) {
    throw new Error("Konto konnte nach dem Anlegen nicht gefunden werden.");
  }

  if (!account.roles.includes("player")) {
    await db.insert(accountRoles).values({ worldId, accountId: account.id, role: "player" }).onConflictDoNothing();
    return { ...account, roles: [...account.roles, "player"] };
  }

  return account;
}

/**
 * Entzieht einer Identität den Zugang zu einer Welt. Das Konto selbst und
 * seine Betriebshistorie bleiben bestehen (E8).
 *
 * Zwei Wege dorthin: die handelnde Identität ist Weltverwalter — oder sie
 * entzieht sich **ausschließlich sich selbst** den Zugang (Selbstbedienung,
 * genutzt von `packages/privacy` für die Löschung nach M2.6). Dritte kann nur
 * ein Weltverwalter abmelden.
 */
export async function revokeWorldAccess(
  db: IdentityDatabase,
  input: {
    readonly worldId: string;
    readonly targetKeycloakSubject: string;
    readonly actingKeycloakSubject: string;
  },
): Promise<void> {
  if (input.actingKeycloakSubject !== input.targetKeycloakSubject) {
    await requireWorldAdmin(db, input.worldId, input.actingKeycloakSubject);
  }
  await db
    .update(worldAccesses)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(
      and(
        eq(worldAccesses.worldId, input.worldId),
        eq(worldAccesses.keycloakSubject, input.targetKeycloakSubject),
        eq(worldAccesses.status, "active"),
      ),
    );
}

/**
 * Prüft, ob das handelnde Konto Weltverwalter ist.
 *
 * Bootstrap-Ausnahme: Trägt niemand in der Welt bislang `world_admin`, darf
 * sich das handelnde Konto **ausschließlich selbst** dazu machen
 * (`bootstrapTargetAccountId === actingAccount.id`) — sonst könnte ein
 * beliebiges frisches Konto irgendein anderes zum Verwalter ernennen, statt
 * nur den allerersten Verwalter zu ermöglichen.
 */
async function requireWorldAdmin(
  db: IdentityDatabase,
  worldId: string,
  keycloakSubject: string,
  bootstrapTargetAccountId?: string,
): Promise<void> {
  const actingAccount = await findAccount(db, worldId, keycloakSubject);
  if (actingAccount === undefined) {
    throw new AuthorizationError(`Kein Konto in Welt '${worldId}' — Handlung nicht erlaubt.`);
  }
  if (actingAccount.roles.includes("world_admin")) {
    return;
  }

  if (bootstrapTargetAccountId === actingAccount.id) {
    const existingAdmins = await db
      .select({ id: accountRoles.id })
      .from(accountRoles)
      .where(and(eq(accountRoles.worldId, worldId), eq(accountRoles.role, "world_admin")))
      .limit(1);
    if (existingAdmins.length === 0) {
      return;
    }
  }

  throw new AuthorizationError(`Konto '${actingAccount.id}' ist kein Weltverwalter von '${worldId}'.`);
}

/** Vergibt eine Rolle an ein Konto derselben Welt. */
export async function grantRole(
  db: IdentityDatabase,
  input: {
    readonly worldId: string;
    readonly targetAccountId: string;
    readonly role: Role;
    readonly actingKeycloakSubject: string;
  },
): Promise<AccountRecord> {
  return db.transaction(async (tx) => {
    // Bootstrap-Pruefung und Vergabe bilden eine einzige Entscheidung je Welt.
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${input.worldId} for update`);
    await requireWorldAdmin(tx, input.worldId, input.actingKeycloakSubject, input.targetAccountId);

    const [target] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, input.targetAccountId), eq(accounts.worldId, input.worldId)))
      .limit(1);
    if (target === undefined) {
      throw new AccountNotFoundError(input.targetAccountId, input.worldId);
    }

    await tx
      .insert(accountRoles)
      .values({ worldId: input.worldId, accountId: target.id, role: input.role })
      .onConflictDoNothing();

    return { ...target, roles: await rolesOf(tx, input.worldId, target.id) };
  });
}

function collectAccountRoles<T extends { readonly id: string; readonly worldId: string }>(
  rows: readonly { readonly account: T; readonly role: string | null }[],
): (T & { roles: Role[] })[] {
  const grouped = new Map<string, T & { roles: Role[] }>();
  for (const { account, role } of rows) {
    const key = `${account.worldId}:${account.id}`;
    let result = grouped.get(key);
    if (result === undefined) {
      result = { ...account, roles: [] };
      grouped.set(key, result);
    }
    if (role !== null) result.roles.push(role as Role);
  }
  return [...grouped.values()];
}

/**
 * Kontoliste einer Welt. Nur wer selbst ein Konto in dieser Welt hat, darf
 * sie sehen — genau der Belegungstest aus dem Beweis von M2: zwei Konten
 * derselben Welt sehen einander, ein drittes aus einer anderen Welt nicht.
 */
export async function listAccountsInWorld(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly requestingKeycloakSubject: string },
): Promise<readonly PublicAccountRecord[]> {
  const requester = await findAccount(db, input.worldId, input.requestingKeycloakSubject);
  if (requester === undefined) {
    throw new AuthorizationError(`Kein Konto in Welt '${input.worldId}' — Kontoliste nicht sichtbar.`);
  }

  const rows = await db
    .select({
      account: {
        id: accounts.id,
        worldId: accounts.worldId,
        displayName: accounts.displayName,
        createdAt: accounts.createdAt,
        erasedAt: accounts.erasedAt,
      },
      role: accountRoles.role,
    })
    .from(accounts)
    .innerJoin(
      worldAccesses,
      and(
        eq(worldAccesses.worldId, accounts.worldId),
        eq(worldAccesses.keycloakSubject, accounts.keycloakSubject),
        eq(worldAccesses.status, "active"),
      ),
    )
    .leftJoin(accountRoles, and(eq(accountRoles.worldId, accounts.worldId), eq(accountRoles.accountId, accounts.id)))
    .where(eq(accounts.worldId, input.worldId));
  return collectAccountRoles(rows);
}

/** Alle Weltkonten eines Keycloak-Subjects, weltübergreifend — nur die eigenen. */
export async function listAccountsForSubject(
  db: IdentityDatabase,
  keycloakSubject: string,
): Promise<readonly AccountRecord[]> {
  const rows = await db
    .select({ account: accounts, role: accountRoles.role })
    .from(accounts)
    .innerJoin(
      worldAccesses,
      and(
        eq(worldAccesses.worldId, accounts.worldId),
        eq(worldAccesses.keycloakSubject, accounts.keycloakSubject),
        eq(worldAccesses.status, "active"),
      ),
    )
    .leftJoin(accountRoles, and(eq(accountRoles.worldId, accounts.worldId), eq(accountRoles.accountId, accounts.id)))
    .where(eq(accounts.keycloakSubject, keycloakSubject));
  return collectAccountRoles(rows);
}
