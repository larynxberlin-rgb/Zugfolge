import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import {
  AccessRevokedError,
  AuthorizationError,
  grantRole,
  listAccountsInWorld,
  requestWorldAccess,
  type IdentityDatabase,
} from "@zugfolge/identity";
import { listInbox, sendMessage } from "@zugfolge/mailbox";
import { foundOperator, getOperator } from "@zugfolge/operators";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eraseAccountData, ERASED_DISPLAY_NAME } from "./erasure.js";
import { exportAccountData, PersonalDataNotFoundError } from "./export.js";

const WORLD_LHE = "11111111-1111-1111-1111-111111111111";

let client: PGlite;
let db: IdentityDatabase;

beforeEach(async () => {
  client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb;

  await pgliteDb
    .insert(worlds)
    .values([
      { id: WORLD_LHE, name: "Leipzig–Halle–Erfurt", schedulePeriodWeeks: 4, epoch: new Date("2026-01-01T00:00:00Z") },
    ]);
});

afterEach(async () => {
  await client.close();
});

describe("exportAccountData (Auskunft)", () => {
  it("bündelt Konto, Weltzugang, EVU und Postfach", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-anna", name: "Elbtalbahn" });
    await sendMessage(db, {
      worldId: WORLD_LHE,
      recipientAccountId: anna.id,
      messageType: "system.willkommen",
      payload: { text: "Willkommen" },
    });

    const auskunft = await exportAccountData(db, {
      worldId: WORLD_LHE,
      keycloakSubject: "kc-anna",
      exportedAt: new Date("2026-02-01T00:00:00Z"),
    });

    expect(auskunft.account.displayName).toBe("Anna");
    expect(auskunft.worldAccessStatus).toBe("active");
    expect(auskunft.operators.map((operator) => operator.name)).toEqual(["Elbtalbahn"]);
    expect(auskunft.mailboxMessages).toHaveLength(1);
  });

  it("meldet, wenn kein Konto in der Welt existiert", async () => {
    await expect(
      exportAccountData(db, { worldId: WORLD_LHE, keycloakSubject: "kc-fremd", exportedAt: new Date("2026-02-01T00:00:00Z") }),
    ).rejects.toBeInstanceOf(PersonalDataNotFoundError);
  });
});

describe("eraseAccountData (Löschung)", () => {
  it("anonymisiert den Anzeigenamen und entzieht den Weltzugang bei Selbstlöschung", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });

    const geloescht = await eraseAccountData(db, {
      worldId: WORLD_LHE,
      targetKeycloakSubject: "kc-anna",
      actingKeycloakSubject: "kc-anna",
      erasedAt: new Date("2026-03-01T00:00:00Z"),
    });

    expect(geloescht.displayName).toBe(ERASED_DISPLAY_NAME);
    expect(geloescht.erasedAt).toEqual(new Date("2026-03-01T00:00:00Z"));

    // Zugang ist entzogen: ein erneuter Beitritt scheitert (E8-artige Sperre, M2.1).
    await expect(
      requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" }),
    ).rejects.toBeInstanceOf(AccessRevokedError);
  });

  it("erlaubt einem Weltverwalter, ein fremdes Konto zu löschen", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await grantRole(db, { worldId: WORLD_LHE, targetAccountId: anna.id, role: "world_admin", actingKeycloakSubject: "kc-anna" });
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });

    const geloescht = await eraseAccountData(db, {
      worldId: WORLD_LHE,
      targetKeycloakSubject: "kc-ben",
      actingKeycloakSubject: "kc-anna",
      erasedAt: new Date("2026-03-01T00:00:00Z"),
    });

    expect(geloescht.displayName).toBe(ERASED_DISPLAY_NAME);
  });

  it("lehnt die Löschung eines fremden Kontos ohne Weltverwalter-Rolle ab", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });

    await expect(
      eraseAccountData(db, {
        worldId: WORLD_LHE,
        targetKeycloakSubject: "kc-ben",
        actingKeycloakSubject: "kc-anna",
        erasedAt: new Date("2026-03-01T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("die Betriebshistorie eines gelöschten Kontos bleibt les- und zuordenbar", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    const operator = await foundOperator(db, {
      worldId: WORLD_LHE,
      foundingKeycloakSubject: "kc-anna",
      name: "Elbtalbahn",
    });

    await eraseAccountData(db, {
      worldId: WORLD_LHE,
      targetKeycloakSubject: "kc-anna",
      actingKeycloakSubject: "kc-anna",
      erasedAt: new Date("2026-03-01T00:00:00Z"),
    });

    const nochAuffindbar = await getOperator(db, { worldId: WORLD_LHE, operatorId: operator.id });
    expect(nochAuffindbar.foundingAccountId).toBe(anna.id);
  });
});
