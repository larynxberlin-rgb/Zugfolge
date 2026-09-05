import { PGlite } from "@electric-sql/pglite";
import { accountRoles, accounts, MIGRATIONS_FOLDER, worldAccesses, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import {
  AccessRevokedError,
  AuthorizationError,
  grantRole,
  listAccountsInWorld,
  requestWorldAccess,
  revokeWorldAccess,
  type IdentityDatabase,
} from "@zugfolge/identity";
import { listInbox, sendMessage } from "@zugfolge/mailbox";
import { foundOperator, getOperator } from "@zugfolge/operators";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eraseAccountData, ERASED_DISPLAY_NAME, purgeExpiredAccountData } from "./erasure.js";
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
  it("exportiert den eigenen Vertragsstand auch nach Widerruf und Loeschvormerkung", async () => {
    const own = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-own", displayName: "Eigene Person", acceptedWorldContract: { hash: "a".repeat(64), startingCapitalPolicy: { kind: "finite", amountCents: "1000" } } });
    await sendMessage(db, { worldId: WORLD_LHE, recipientAccountId: own.id, messageType: "personal", payload: { own: true } });
    const query = { worldId: WORLD_LHE, keycloakSubject: "kc-own", exportedAt: new Date("2026-02-01Z") };
    const active = await exportAccountData(db, query);
    expect(active.worldAccess).toMatchObject({ acceptedWorldContractHash: "a".repeat(64), acceptedStartingCapitalPolicy: { amountCents: "1000" } });
    expect(active.worldAccess?.grantedAt).toBeInstanceOf(Date);
    expect(active.worldAccess?.worldContractAcceptedAt).toBeInstanceOf(Date);
    await revokeWorldAccess(db, { worldId: WORLD_LHE, targetKeycloakSubject: "kc-own", actingKeycloakSubject: "kc-own" });
    expect(await exportAccountData(db, query)).toMatchObject({ worldAccessStatus: "revoked", mailboxMessages: [{ payload: { own: true } }] });
    await eraseAccountData(db, { worldId: WORLD_LHE, targetKeycloakSubject: "kc-own", actingKeycloakSubject: "kc-own", erasedAt: query.exportedAt });
    expect((await exportAccountData(db, query)).account.erasedAt).toEqual(query.exportedAt);
    await purgeExpiredAccountData(db, new Date("2026-06-01Z"));
    await expect(exportAccountData(db, query)).rejects.toBeInstanceOf(PersonalDataNotFoundError);
  });

  it("exportiert eigene Tutorial- und globale Berechtigungsdaten ohne fremde Konten", async () => {
    const own = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-own", displayName: "Eigene Person" });
    const tutorialWorld = "22222222-2222-4222-8222-222222222222";
    await db.insert(worlds).values({ id: tutorialWorld, name: "Tutorial", schedulePeriodWeeks: 4, epoch: new Date("2026-01-01Z") });
    const tutorialAccount = await requestWorldAccess(db, { worldId: tutorialWorld, keycloakSubject: "tutorial-own", displayName: "Tutorial" });
    const operator = await foundOperator(db, { worldId: tutorialWorld, foundingKeycloakSubject: "tutorial-own", name: "Tutorialbahn" });
    const [session] = await db.insert(schema.tutorialSessions).values({ reference: `tut_${"a".repeat(20)}`, publicWorldId: WORLD_LHE, publicAccountId: own.id, tutorialWorldId: tutorialWorld, tutorialAccountId: tutorialAccount.id, tutorialOperatorId: operator.id, templateVersion: "v1", templateHash: "a".repeat(64), startedAt: new Date("2026-01-01Z"), lastActivityAt: new Date("2026-01-01Z"), idleExpiresAt: new Date("2026-01-02Z"), maximumExpiresAt: new Date("2026-01-03Z"), hintsUsed: { chapter1: 2 } }).returning();
    await db.insert(schema.tutorialTelemetryEvents).values({ worldId: tutorialWorld, sessionId: session!.id, idempotencyKey: "hint", eventType: "tutorial_hint_opened", templateVersion: "v1", chapter: 1, elapsedMilliseconds: 1_000, hintUsed: true, occurredAt: new Date("2026-01-01Z") });
    await db.insert(schema.tutorialProgress).values({ worldId: WORLD_LHE, accountId: own.id, checkpointHash: "a".repeat(64), updatedAtS: 1 });
    for (const subject of ["kc-own", "kc-other"]) {
      const [entitlement] = await db.insert(schema.commerceEntitlements).values({ keycloakSubject: subject, externalEventId: subject, productKind: "cosmetic", status: "active", validFrom: new Date("2026-01-01Z"), correlationId: subject, sourceReference: subject }).returning();
      await db.insert(schema.commerceWorldClaims).values({ worldId: WORLD_LHE, entitlementId: entitlement!.id, claimKind: "cosmetic" });
      await db.insert(schema.worldParticipations).values({ worldId: WORLD_LHE, keycloakSubject: subject, displayName: subject, odooPartnerReference: subject, odooOrderReference: subject, paymentReference: subject, state: "active", lastIdempotencyKey: `participation-${subject}`, correlationId: subject, createdAt: new Date("2026-01-01Z"), changedAt: new Date("2026-01-01Z") });
    }
    const exported = await exportAccountData(db, { worldId: WORLD_LHE, keycloakSubject: "kc-own", exportedAt: new Date("2026-02-01Z") });
    expect(exported.schemaVersion).toBe("zugfolge-personal-data-export/v2");
    expect(exported.tutorialSessions).toMatchObject([{ reference: `tut_${"a".repeat(20)}`, hintsUsed: { chapter1: 2 } }]);
    expect(exported.tutorialTelemetry).toMatchObject([{ eventType: "tutorial_hint_opened", hintUsed: true }]);
    expect(exported.tutorialProgress).toMatchObject([{ accountId: own.id }]);
    expect(exported.commerceWorldClaims).toHaveLength(1);
    expect(exported.worldParticipations).toMatchObject([{ keycloakSubject: "kc-own" }]);
    expect(exported.worldParticipations).toHaveLength(1);
    expect(exported.commerceEntitlements).toMatchObject([{ keycloakSubject: "kc-own" }]);
    expect(exported.commerceEntitlements).toHaveLength(1);
  });
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
  it("isoliert einen durch die Archiv-Fence verhinderten Purge von anderen Konten", async () => {
    const archived = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-archived", displayName: "Archiv" });
    await eraseAccountData(db, { worldId: WORLD_LHE, targetKeycloakSubject: "kc-archived", actingKeycloakSubject: "kc-archived", erasedAt: new Date("2026-01-01Z") });
    await db.update(worlds).set({ lifecycleStatus: "archived" });
    const activeWorld = "22222222-2222-4222-8222-222222222222";
    await db.insert(worlds).values({ id: activeWorld, name: "Aktiv", schedulePeriodWeeks: 4, epoch: new Date("2026-01-01Z") });
    const active = await requestWorldAccess(db, { worldId: activeWorld, keycloakSubject: "kc-active", displayName: "Aktiv" });
    await eraseAccountData(db, { worldId: activeWorld, targetKeycloakSubject: "kc-active", actingKeycloakSubject: "kc-active", erasedAt: new Date("2026-01-01Z") });
    const result = await purgeExpiredAccountData(db, new Date("2026-04-02Z"));
    expect(result.purgedAccountIds).toEqual([active.id]);
    expect(result.failures).toMatchObject([{ worldId: WORLD_LHE, accountId: archived.id }]);
  });
  it("erhaelt den ersten Loeschzeitpunkt bei zeitversetzten und parallelen Retries", async () => {
    const own = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-retry", displayName: "Retry" });
    const input = { worldId: WORLD_LHE, targetKeycloakSubject: "kc-retry", actingKeycloakSubject: "kc-retry", erasedAt: new Date("2026-01-01Z") };
    await eraseAccountData(db, input);
    const repeated = await Promise.all([eraseAccountData(db, { ...input, erasedAt: new Date("2026-03-31Z") }), eraseAccountData(db, { ...input, erasedAt: new Date("2026-04-01Z") })]);
    expect(repeated.map((account) => account.erasedAt)).toEqual([input.erasedAt, input.erasedAt]);
    expect((await purgeExpiredAccountData(db, new Date("2026-04-02Z"))).purgedAccountIds).toEqual([own.id]);
    expect((await purgeExpiredAccountData(db, new Date("2026-04-03Z"))).purgedAccountIds).toEqual([]);
  });
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

  it("entkoppelt die Keycloak-Kennung nach 90 Tagen endgültig und idempotent", async () => {
    const anna = await requestWorldAccess(db, {
      worldId: WORLD_LHE,
      keycloakSubject: "kc-anna",
      displayName: "Anna",
    });
    await eraseAccountData(db, {
      worldId: WORLD_LHE,
      targetKeycloakSubject: "kc-anna",
      actingKeycloakSubject: "kc-anna",
      erasedAt: new Date("2026-03-01T00:00:00Z"),
    });

    await expect(purgeExpiredAccountData(db, new Date("2026-05-29T23:59:59Z"))).resolves.toEqual({
      purgedAccountIds: [],
    });
    await expect(purgeExpiredAccountData(db, new Date("2026-05-30T00:00:00Z"))).resolves.toEqual({
      purgedAccountIds: [anna.id],
    });
    await expect(purgeExpiredAccountData(db, new Date("2026-06-01T00:00:00Z"))).resolves.toEqual({
      purgedAccountIds: [],
    });

    const [account] = await db.select().from(accounts);
    const [access] = await db.select().from(worldAccesses);
    expect(account?.keycloakSubject).toBe(`erased:${anna.id}`);
    expect(access?.keycloakSubject).toBe(`erased:${anna.id}`);
    expect(account?.keycloakSubject).not.toContain("kc-anna");
    expect(await db.select().from(accountRoles)).toEqual([]);
  });
});
