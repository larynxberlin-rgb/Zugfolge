import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worldAccesses, worlds } from "@zugfolge/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AccessRevokedError,
  AccountNotFoundError,
  AuthorizationError,
  getAccount,
  grantRole,
  listAccountsForSubject,
  listAccountsInWorld,
  requestWorldAccess,
  revokeWorldAccess,
  WorldContractAcceptanceConflictError,
} from "./accounts.js";
import type { IdentityDatabase } from "./accounts.js";

const WORLD_LHE = "11111111-1111-1111-1111-111111111111";
const WORLD_MIDDLE_GERMANY = "22222222-2222-2222-2222-222222222222";

let client: PGlite;
let db: IdentityDatabase;

beforeEach(async () => {
  client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb;

  await pgliteDb.insert(worlds).values([
    { id: WORLD_LHE, name: "Leipzig–Halle–Erfurt", schedulePeriodWeeks: 4, epoch: new Date("2026-01-01T00:00:00Z") },
    {
      id: WORLD_MIDDLE_GERMANY,
      name: "Mitteldeutschland",
      schedulePeriodWeeks: 4,
      epoch: new Date("2026-01-01T00:00:00Z"),
    },
  ]);
});

afterEach(async () => {
  await client.close();
});

describe("requestWorldAccess", () => {
  it("legt Zugang, Konto und die Rolle player an", async () => {
    const account = await requestWorldAccess(db, {
      worldId: WORLD_LHE,
      keycloakSubject: "kc-anna",
      displayName: "Anna",
    });

    expect(account.worldId).toBe(WORLD_LHE);
    expect(account.displayName).toBe("Anna");
    expect(account.roles).toEqual(["player"]);
  });

  it("ist wiederholbar ohne doppelte Rollen oder Fehler", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    const second = await requestWorldAccess(db, {
      worldId: WORLD_LHE,
      keycloakSubject: "kc-anna",
      displayName: "Anna (erneut)",
    });

    expect(second.roles).toEqual(["player"]);
    // Der beim ersten Zugang gewählte Anzeigename bleibt erhalten.
    expect(second.displayName).toBe("Anna");
  });

  it("bindet Hash und StartingCapitalPolicy beim ersten bestaetigten Zugang unveraenderlich", async () => {
    const acceptedWorldContract = {
      hash: "a".repeat(64),
      startingCapitalPolicy: { kind: "finite" as const, amountCents: "500000" },
    };
    await requestWorldAccess(db, {
      worldId: WORLD_LHE,
      keycloakSubject: "kc-contract",
      displayName: "Vertrag",
      acceptedWorldContract,
    });
    await expect(requestWorldAccess(db, {
      worldId: WORLD_LHE,
      keycloakSubject: "kc-contract",
      displayName: "Vertrag",
      acceptedWorldContract,
    })).resolves.toMatchObject({ worldId: WORLD_LHE });
    await expect(requestWorldAccess(db, {
      worldId: WORLD_LHE,
      keycloakSubject: "kc-contract",
      displayName: "Vertrag",
      acceptedWorldContract: {
        hash: "b".repeat(64),
        startingCapitalPolicy: { kind: "unlimited" },
      },
    })).rejects.toBeInstanceOf(WorldContractAcceptanceConflictError);
    const [access] = await (db as ReturnType<typeof drizzle<typeof schema>>).select().from(worldAccesses).where(and(
      eq(worldAccesses.worldId, WORLD_LHE),
      eq(worldAccesses.keycloakSubject, "kc-contract"),
    ));
    expect(access).toMatchObject({
      acceptedWorldContractHash: acceptedWorldContract.hash,
      acceptedStartingCapitalPolicy: acceptedWorldContract.startingCapitalPolicy,
    });
  });

  it("lehnt einen erneuten Zugang nach Entzug ab", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await grantRole(db, {
      worldId: WORLD_LHE,
      targetAccountId: (await listAccountsInWorld(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna" }))[0]!
        .id,
      role: "world_admin",
      actingKeycloakSubject: "kc-anna",
    });
    await revokeWorldAccess(db, {
      worldId: WORLD_LHE,
      targetKeycloakSubject: "kc-anna",
      actingKeycloakSubject: "kc-anna",
    });

    await expect(
      requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" }),
    ).rejects.toBeInstanceOf(AccessRevokedError);
    await expect(
      getAccount(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna" }),
    ).rejects.toBeInstanceOf(AccessRevokedError);
    await expect(
      listAccountsInWorld(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna" }),
    ).rejects.toBeInstanceOf(AccessRevokedError);
  });
});

describe("Weltisolation der Kontoliste (Beweis von M2)", () => {
  it("zwei Konten derselben Welt sehen einander", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });

    const roster = await listAccountsInWorld(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna" });

    expect(roster.map((account) => account.displayName).sort()).toEqual(["Anna", "Ben"]);
    expect(roster.every((account) => !("keycloakSubject" in account))).toBe(true);
  });

  it("ein Konto aus einer anderen Welt taucht in der Liste nicht auf", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await requestWorldAccess(db, {
      worldId: WORLD_MIDDLE_GERMANY,
      keycloakSubject: "kc-clara",
      displayName: "Clara",
    });

    const roster = await listAccountsInWorld(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna" });

    expect(roster.map((account) => account.displayName)).toEqual(["Anna"]);
  });

  it("wer selbst kein Konto in der Welt hat, sieht die Kontoliste nicht", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });

    await expect(
      listAccountsInWorld(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-fremd" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("grantRole", () => {
  it("erlaubt dem ersten Konto einer Welt, sich selbst zum Weltverwalter zu machen", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });

    const updated = await grantRole(db, {
      worldId: WORLD_LHE,
      targetAccountId: anna.id,
      role: "world_admin",
      actingKeycloakSubject: "kc-anna",
    });

    expect([...updated.roles].sort()).toEqual(["player", "world_admin"]);
  });

  it("verweigert die Rollenvergabe, wenn die Welt schon einen Weltverwalter hat", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await grantRole(db, {
      worldId: WORLD_LHE,
      targetAccountId: anna.id,
      role: "world_admin",
      actingKeycloakSubject: "kc-anna",
    });
    const ben = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });

    await expect(
      grantRole(db, {
        worldId: WORLD_LHE,
        targetAccountId: ben.id,
        role: "world_admin",
        actingKeycloakSubject: "kc-ben",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("verweigert die Rollenvergabe an ein Konto einer anderen Welt", async () => {
    const anna = await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await grantRole(db, {
      worldId: WORLD_LHE,
      targetAccountId: anna.id,
      role: "world_admin",
      actingKeycloakSubject: "kc-anna",
    });
    const clara = await requestWorldAccess(db, {
      worldId: WORLD_MIDDLE_GERMANY,
      keycloakSubject: "kc-clara",
      displayName: "Clara",
    });

    await expect(
      grantRole(db, {
        worldId: WORLD_LHE,
        targetAccountId: clara.id,
        role: "player",
        actingKeycloakSubject: "kc-anna",
      }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});

describe("listAccountsForSubject", () => {
  it("findet die Konten eines Subjects über mehrere Welten hinweg", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await requestWorldAccess(db, {
      worldId: WORLD_MIDDLE_GERMANY,
      keycloakSubject: "kc-anna",
      displayName: "Anna (Mitteldeutschland)",
    });

    const memberships = await listAccountsForSubject(db, "kc-anna");

    expect(memberships.map((account) => account.worldId).sort()).toEqual([WORLD_LHE, WORLD_MIDDLE_GERMANY].sort());
  });

  it("blendet einen widerrufenen Weltzugang aus", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await revokeWorldAccess(db, {
      worldId: WORLD_LHE,
      targetKeycloakSubject: "kc-anna",
      actingKeycloakSubject: "kc-anna",
    });

    await expect(listAccountsForSubject(db, "kc-anna")).resolves.toEqual([]);
  });
});
