/**
 * Konten, Rollen und Weltzugänge (M2.1).
 *
 * Jede Abfrage hier ist nach `world_id` geschnitten (Invariante 4): Wer nach
 * einer Welt fragt, bekommt ausschließlich, was zu ihr gehört, und muss
 * selbst ein Konto in ihr haben, um ihre Kontoliste zu sehen. Das ist die
 * kleine, hier bereits nachgewiesene Vorstufe der automatisierten
 * Weltisolation aus M2.2.
 */

import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { accountRoles, accounts, schema, worldAccesses } from "./schema.js";
import type { Role } from "./roles.js";

/** Verbindungstyp, unabhängig vom Treiber (node-postgres im Betrieb, PGlite im Test). */
export type IdentityDatabase = PgDatabase<any, typeof schema>;

export interface AccountRecord {
  readonly id: string;
  readonly worldId: string;
  readonly keycloakSubject: string;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly roles: readonly Role[];
}

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
): Promise<AccountRecord | undefined> {
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
 * Selbstbedienter Weltzugang: legt bei Bedarf Zugang, Konto und die Rolle
 * `player` an. Ein zuvor entzogener Zugang wird **nicht** stillschweigend
 * reaktiviert — das bleibt einer bewussten administrativen Handlung
 * vorbehalten.
 */
export async function requestWorldAccess(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly keycloakSubject: string; readonly displayName: string },
): Promise<AccountRecord> {
  const { worldId, keycloakSubject, displayName } = input;

  const [existingAccess] = await db
    .select()
    .from(worldAccesses)
    .where(and(eq(worldAccesses.worldId, worldId), eq(worldAccesses.keycloakSubject, keycloakSubject)))
    .limit(1);

  if (existingAccess !== undefined && existingAccess.status === "revoked") {
    throw new AccessRevokedError(worldId);
  }

  if (existingAccess === undefined) {
    await db.insert(worldAccesses).values({ worldId, keycloakSubject }).onConflictDoNothing();
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
 */
export async function revokeWorldAccess(
  db: IdentityDatabase,
  input: {
    readonly worldId: string;
    readonly targetKeycloakSubject: string;
    readonly actingKeycloakSubject: string;
  },
): Promise<void> {
  await requireWorldAdmin(db, input.worldId, input.actingKeycloakSubject);
  await db
    .update(worldAccesses)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(
      and(
        eq(worldAccesses.worldId, input.worldId),
        eq(worldAccesses.keycloakSubject, input.targetKeycloakSubject),
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
  await requireWorldAdmin(db, input.worldId, input.actingKeycloakSubject, input.targetAccountId);

  const [target] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.targetAccountId), eq(accounts.worldId, input.worldId)))
    .limit(1);
  if (target === undefined) {
    throw new AccountNotFoundError(input.targetAccountId, input.worldId);
  }

  await db
    .insert(accountRoles)
    .values({ worldId: input.worldId, accountId: target.id, role: input.role })
    .onConflictDoNothing();

  return { ...target, roles: await rolesOf(db, input.worldId, target.id) };
}

/**
 * Kontoliste einer Welt. Nur wer selbst ein Konto in dieser Welt hat, darf
 * sie sehen — genau der Belegungstest aus dem Beweis von M2: zwei Konten
 * derselben Welt sehen einander, ein drittes aus einer anderen Welt nicht.
 */
export async function listAccountsInWorld(
  db: IdentityDatabase,
  input: { readonly worldId: string; readonly requestingKeycloakSubject: string },
): Promise<readonly AccountRecord[]> {
  const requester = await findAccount(db, input.worldId, input.requestingKeycloakSubject);
  if (requester === undefined) {
    throw new AuthorizationError(`Kein Konto in Welt '${input.worldId}' — Kontoliste nicht sichtbar.`);
  }

  const rows = await db.select().from(accounts).where(eq(accounts.worldId, input.worldId));
  return Promise.all(rows.map(async (row) => ({ ...row, roles: await rolesOf(db, input.worldId, row.id) })));
}

/** Alle Weltkonten eines Keycloak-Subjects, weltübergreifend — nur die eigenen. */
export async function listAccountsForSubject(
  db: IdentityDatabase,
  keycloakSubject: string,
): Promise<readonly AccountRecord[]> {
  const rows = await db.select().from(accounts).where(eq(accounts.keycloakSubject, keycloakSubject));
  return Promise.all(rows.map(async (row) => ({ ...row, roles: await rolesOf(db, row.worldId, row.id) })));
}
