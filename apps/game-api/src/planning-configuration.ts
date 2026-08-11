import { accounts } from "@zugfolge/db";
import { getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { and, eq } from "drizzle-orm";

import { compareUtf8 } from "./utf8.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJson(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new TypeError(`${name} ist kein gueltiges JSON.`, { cause: error });
  }
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
  }
  return Object.freeze(value);
}

/** Trusted releases stay immutable after their fail-closed startup parse. */
export function parsePlanningInfrastructureReleasesJson(
  raw: string,
): readonly unknown[] {
  const value = parseJson(raw, "PLANNING_INFRASTRUCTURE_RELEASES_JSON");
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      "PLANNING_INFRASTRUCTURE_RELEASES_JSON muss eine nichtleere Liste sein.",
    );
  }
  return deepFreeze(value) as readonly unknown[];
}

/** World-bound authority principals; the request body can never select one. */
export function parsePlanningAuthorityAccountIdsJson(
  raw: string,
): Readonly<Record<string, string>> {
  const value = parseJson(raw, "PLANNING_AUTHORITY_ACCOUNT_IDS_JSON");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      "PLANNING_AUTHORITY_ACCOUNT_IDS_JSON muss ein Welt-Konto-Objekt sein.",
    );
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareUtf8(left, right),
  );
  if (entries.length === 0) {
    throw new TypeError(
      "PLANNING_AUTHORITY_ACCOUNT_IDS_JSON darf nicht leer sein.",
    );
  }
  for (const [worldId, accountId] of entries) {
    if (!UUID_PATTERN.test(worldId) || typeof accountId !== "string" || !UUID_PATTERN.test(accountId)) {
      throw new TypeError(
        "Planning-Authority-Mapping braucht UUIDs fuer Welt und Konto.",
      );
    }
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, string>>;
}

/**
 * Startup integrity check: every database world has exactly one configured,
 * existing and active authority account in that same world.
 */
export async function verifyPlanningAuthorityAccounts(
  db: IdentityDatabase,
  worldIds: readonly string[],
  authorityAccountIds: Readonly<Record<string, string>>,
): Promise<void> {
  const orderedWorldIds = [...new Set(worldIds)].sort(compareUtf8);
  const configuredWorldIds = Object.keys(authorityAccountIds).sort(compareUtf8);
  if (
    orderedWorldIds.length !== configuredWorldIds.length ||
    orderedWorldIds.some((worldId, index) => worldId !== configuredWorldIds[index])
  ) {
    throw new Error(
      "Planning-Authority-Mapping muss genau alle Datenbankwelten abdecken.",
    );
  }
  for (const worldId of orderedWorldIds) {
    const accountId = authorityAccountIds[worldId];
    if (accountId === undefined) {
      throw new Error(`Planning-Authority fuer Welt '${worldId}' fehlt.`);
    }
    const [row] = await db
      .select({
        id: accounts.id,
        keycloakSubject: accounts.keycloakSubject,
        erasedAt: accounts.erasedAt,
      })
      .from(accounts)
      .where(and(eq(accounts.worldId, worldId), eq(accounts.id, accountId)))
      .limit(1);
    if (row === undefined || row.erasedAt !== null) {
      throw new Error(
        `Planning-Authority-Konto '${accountId}' existiert nicht aktiv in Welt '${worldId}'.`,
      );
    }
    let active;
    try {
      active = await getAccount(db, {
        worldId,
        keycloakSubject: row.keycloakSubject,
      });
    } catch (error) {
      throw new Error(
        `Planning-Authority-Konto '${accountId}' besitzt keinen aktiven Weltzugang.`,
        { cause: error },
      );
    }
    if (active?.id !== accountId) {
      throw new Error(
        `Planning-Authority-Konto '${accountId}' besitzt keinen aktiven Weltzugang.`,
      );
    }
  }
}
