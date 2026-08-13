import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DuplicateOperatorNameError,
  foundOperator,
  foundOperatorWithInitialization,
  getOperator,
  listOperatorsForAccount,
  listOperatorsInWorld,
  NoAccountInWorldError,
  OperatorNotFoundError,
  OperatorFoundationWorldInactiveError,
  PublicWorldOperatorLimitError,
} from "./operators.js";

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

describe("foundOperator", () => {
  it("gründet ein EVU für ein bestehendes Konto", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });

    const operator = await foundOperator(db, {
      worldId: WORLD_LHE,
      foundingKeycloakSubject: "kc-anna",
      name: "Mitteldeutsche Regiobahn",
    });

    expect(operator.worldId).toBe(WORLD_LHE);
    expect(operator.name).toBe("Mitteldeutsche Regiobahn");
  });

  it("lehnt die Gründung ohne Konto in der Welt ab", async () => {
    await expect(
      foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-fremd", name: "Phantom-Bahn" }),
    ).rejects.toBeInstanceOf(NoAccountInWorldError);
  });

  it("lehnt einen in der Welt bereits vergebenen Unternehmensnamen ab", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });
    await foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-anna", name: "Elbtalbahn" });

    await expect(
      foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-ben", name: "Elbtalbahn" }),
    ).rejects.toBeInstanceOf(DuplicateOperatorNameError);
  });

  it("erlaubt denselben Namen in zwei verschiedenen Welten", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await requestWorldAccess(db, { worldId: WORLD_MIDDLE_GERMANY, keycloakSubject: "kc-ben", displayName: "Ben" });
    await foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-anna", name: "Elbtalbahn" });

    await expect(
      foundOperator(db, { worldId: WORLD_MIDDLE_GERMANY, foundingKeycloakSubject: "kc-ben", name: "Elbtalbahn" }),
    ).resolves.toMatchObject({ worldId: WORLD_MIDDLE_GERMANY, name: "Elbtalbahn" });
  });

  it("lehnt ein zweites eigenes EVU in derselben öffentlichen Welt ab", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-anna", name: "Elbtalbahn" });
    await expect(
      foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-anna", name: "Saalebahn Cargo" }),
    ).rejects.toBeInstanceOf(PublicWorldOperatorLimitError);

    const eigene = await listOperatorsForAccount(db, "kc-anna");
    expect(eigene.map((operator) => operator.name).sort()).toEqual(["Elbtalbahn"]);
  });

  it("wiederholt dieselbe öffentliche EVU-Gründung idempotent samt Initialisierer", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    const calls: boolean[] = [];
    const input = { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-anna", name: "Elbtalbahn" } as const;
    const first = await foundOperatorWithInitialization(db, input, async (_tx, context) => {
      calls.push(context.idempotentReplay);
    });
    const replay = await foundOperatorWithInitialization(db, input, async (_tx, context) => {
      calls.push(context.idempotentReplay);
    });

    expect(replay.operator.id).toBe(first.operator.id);
    expect([first.idempotentReplay, replay.idempotentReplay]).toEqual([false, true]);
    expect(calls).toEqual([false, true]);
    expect(await listOperatorsForAccount(db, "kc-anna")).toHaveLength(1);
  });

  it.each(["provisioning", "archived"] as const)(
    "gruendet in einer Welt mit Lifecycle %s weder EVU noch Initialbestand",
    async (lifecycleStatus) => {
      await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
      await db.update(worlds).set({ lifecycleStatus }).where(eq(worlds.id, WORLD_LHE));
      const initialize = vi.fn(async () => undefined);

      await expect(foundOperatorWithInitialization(db, {
        worldId: WORLD_LHE,
        foundingKeycloakSubject: "kc-anna",
        name: "Elbtalbahn",
      }, initialize)).rejects.toBeInstanceOf(OperatorFoundationWorldInactiveError);

      expect(initialize).not.toHaveBeenCalled();
      expect(await listOperatorsForAccount(db, "kc-anna")).toHaveLength(0);
    },
  );

  it("erlaubt mehrere EVU nur in einer privaten ungewerteten Welt", async () => {
    await db.update(worlds).set({ worldKind: "private", rankingStatus: "unranked" }).where(eq(worlds.id, WORLD_LHE));
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-anna", name: "Elbtalbahn" });
    await foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-anna", name: "Saalebahn Cargo" });

    const eigene = await listOperatorsForAccount(db, "kc-anna");
    expect(eigene.map((operator) => operator.name).sort()).toEqual(["Elbtalbahn", "Saalebahn Cargo"]);
  });
});

describe("Weltisolation der EVU-Liste", () => {
  it("zeigt EVU nur innerhalb der eigenen Welt", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
    await requestWorldAccess(db, {
      worldId: WORLD_MIDDLE_GERMANY,
      keycloakSubject: "kc-clara",
      displayName: "Clara",
    });
    await foundOperator(db, { worldId: WORLD_LHE, foundingKeycloakSubject: "kc-anna", name: "Elbtalbahn" });
    await foundOperator(db, {
      worldId: WORLD_MIDDLE_GERMANY,
      foundingKeycloakSubject: "kc-clara",
      name: "Saalebahn Cargo",
    });

    const roster = await listOperatorsInWorld(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-anna" });

    expect(roster.map((operator) => operator.name)).toEqual(["Elbtalbahn"]);
  });

  it("wer selbst kein Konto in der Welt hat, sieht die EVU-Liste nicht", async () => {
    await requestWorldAccess(db, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });

    await expect(
      listOperatorsInWorld(db, { worldId: WORLD_LHE, requestingKeycloakSubject: "kc-fremd" }),
    ).rejects.toThrow();
  });
});

describe("getOperator", () => {
  it("meldet ein unbekanntes EVU", async () => {
    await expect(
      getOperator(db, { worldId: WORLD_LHE, operatorId: "33333333-3333-3333-3333-333333333333" }),
    ).rejects.toBeInstanceOf(OperatorNotFoundError);
  });
});
