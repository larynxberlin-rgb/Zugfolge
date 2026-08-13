import { PGlite } from "@electric-sql/pglite";
import type { GameAdminCommandHandler } from "@zugfolge/commerce";
import { accounts, alphaWorldProfiles, MIGRATIONS_FOLDER, worldAccesses, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import type { IdentityDatabase, KeycloakAdminClient } from "@zugfolge/identity";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAlphaInvitationAdminHandlers } from "./alpha-invitation-admin.js";

const TARGET_WORLD_ID = "00000000-0000-4000-8000-000000000091";
const TUTORIAL_WORLD_ID = "00000000-0000-4000-8000-000000000092";
const SUBJECT = "kc-alpha-invited";

type HandlerContext = Parameters<GameAdminCommandHandler>[0];

function command(actionType: "alpha_invitation_create" | "alpha_invitation_resend"): HandlerContext {
  return {
    adminRequestId: `request-${actionType}`,
    commandId: `command-${actionType}`,
    eventId: `event-${actionType}`,
    correlationId: `correlation-${actionType}`,
    receivedAt: new Date(0),
    now: new Date(0),
    payload: {
      kind: actionType === "alpha_invitation_create"
        ? "admin.alpha_invitation_create"
        : "admin.alpha_invitation_resend",
      worldId: TARGET_WORLD_ID,
      actionType,
      riskClass: "standard",
      requesterReference: "odoo-admin",
      reason: "Geschlossene Alpha",
      effectPreview: {},
      invitation: {
        requestReference: "INV-91",
        email: "alpha@example.test",
        displayName: "Alpha Spieler",
        role: "player",
        keycloakSubject: SUBJECT,
      },
    },
  };
}

describe("Alpha-Einladungsgate", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let keycloak: KeycloakAdminClient;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([
      {
        id: TARGET_WORLD_ID,
        name: "Alpha",
        schedulePeriodWeeks: 3,
        epoch: new Date(0),
        worldKind: "public",
        rankingStatus: "ranked",
        lifecycleStatus: "active",
      },
      {
        id: TUTORIAL_WORLD_ID,
        name: "Tutorial",
        schedulePeriodWeeks: 3,
        epoch: new Date(0),
        worldKind: "private",
        rankingStatus: "unranked",
        lifecycleStatus: "active",
      },
    ]);
    await db.insert(alphaWorldProfiles).values([
      {
        worldId: TARGET_WORLD_ID,
        profileKind: "public",
        regionId: "lhe",
        regionVariant: "B",
        worldSeed: 91n,
        accelerationFactor: 1,
        infraReleaseHash: "a".repeat(64),
        timetableReleaseHash: "b".repeat(64),
        fleetReleaseHash: "c".repeat(64),
        economyReleaseHash: "d".repeat(64),
        blueprint: {},
        blueprintHash: "e".repeat(64),
        state: "running",
      },
      {
        worldId: TUTORIAL_WORLD_ID,
        profileKind: "tutorial",
        regionId: "lhe",
        regionVariant: "B",
        worldSeed: 92n,
        accelerationFactor: 60,
        infraReleaseHash: "a".repeat(64),
        timetableReleaseHash: "b".repeat(64),
        fleetReleaseHash: "c".repeat(64),
        economyReleaseHash: "d".repeat(64),
        blueprint: {},
        blueprintHash: "f".repeat(64),
        state: "running",
      },
    ]);
    keycloak = {
      invite: vi.fn(async () => SUBJECT),
      resend: vi.fn(async () => undefined),
      disable: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => client.close());

  it("legt Zugang und Konten erst nach erfolgreichem Doppelwelt-Gate an", async () => {
    const handlers = createAlphaInvitationAdminHandlers({
      db,
      keycloak,
      redirectUri: "https://game.test/",
      tutorialWorldId: TUTORIAL_WORLD_ID,
    });

    await expect(handlers.alpha_invitation_create(command("alpha_invitation_create"))).resolves.toMatchObject({
      state: "completed",
      result: { keycloakSubject: SUBJECT },
    });

    expect(keycloak.invite).toHaveBeenCalledTimes(1);
    expect(await db.select().from(accounts)).toHaveLength(2);
    expect(await db.select().from(worldAccesses)).toHaveLength(2);
  });

  it.each([
    ["Zielwelt provisioning", async (database: IdentityDatabase) => database.update(worlds).set({ lifecycleStatus: "provisioning" }).where(eq(worlds.id, TARGET_WORLD_ID))],
    ["Zielwelt archiviert", async (database: IdentityDatabase) => database.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, TARGET_WORLD_ID))],
    ["Zielprofil fehlt", async (database: IdentityDatabase) => database.delete(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, TARGET_WORLD_ID))],
    ["Zielprofil laeuft nicht", async (database: IdentityDatabase) => database.update(alphaWorldProfiles).set({ state: "draft" }).where(eq(alphaWorldProfiles.worldId, TARGET_WORLD_ID))],
    ["Zielprofil nicht oeffentlich ist", async (database: IdentityDatabase) => database.update(alphaWorldProfiles).set({ profileKind: "private" }).where(eq(alphaWorldProfiles.worldId, TARGET_WORLD_ID))],
    ["Tutorialwelt provisioning", async (database: IdentityDatabase) => database.update(worlds).set({ lifecycleStatus: "provisioning" }).where(eq(worlds.id, TUTORIAL_WORLD_ID))],
    ["Tutorialwelt archiviert", async (database: IdentityDatabase) => database.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, TUTORIAL_WORLD_ID))],
    ["Tutorialprofil fehlt", async (database: IdentityDatabase) => database.delete(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, TUTORIAL_WORLD_ID))],
    ["Tutorialprofil laeuft nicht", async (database: IdentityDatabase) => database.update(alphaWorldProfiles).set({ state: "draft" }).where(eq(alphaWorldProfiles.worldId, TUTORIAL_WORLD_ID))],
    ["Tutorialprofil nicht zum Tutorial passt", async (database: IdentityDatabase) => database.update(alphaWorldProfiles).set({ profileKind: "private" }).where(eq(alphaWorldProfiles.worldId, TUTORIAL_WORLD_ID))],
    ["Tutorialwelt fehlt", async (database: IdentityDatabase) => {
      await database.delete(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, TUTORIAL_WORLD_ID));
      return database.delete(worlds).where(eq(worlds.id, TUTORIAL_WORLD_ID));
    }],
  ])("sendet bei %s keine Einladung und erzeugt keine lokalen Identitaeten", async (_label, invalidate) => {
    // Testet das Einladungsgate auch gegen importierte/legacy inkonsistente
    // Daten. Der produktive Immutability-Trigger wird nur fuer den Aufbau
    // dieser Negativfixtur ausgesetzt und vor dem Handler wieder aktiviert.
    await db.execute(sql`alter table alpha_world_profiles disable trigger alpha_world_profiles_started_immutable`);
    try {
      await invalidate(db);
    } finally {
      await db.execute(sql`alter table alpha_world_profiles enable trigger alpha_world_profiles_started_immutable`);
    }
    const handlers = createAlphaInvitationAdminHandlers({
      db,
      keycloak,
      redirectUri: "https://game.test/",
      tutorialWorldId: TUTORIAL_WORLD_ID,
    });

    await expect(handlers.alpha_invitation_create(command("alpha_invitation_create"))).rejects.toThrow(
      "Alpha-Einladungen sind nur fuer eine aktive oeffentliche Zielwelt mit aktiver Tutorialwelt erlaubt.",
    );

    expect(keycloak.invite).not.toHaveBeenCalled();
    expect(await db.select().from(accounts)).toHaveLength(0);
    expect(await db.select().from(worldAccesses)).toHaveLength(0);
  });

  it("prueft dasselbe Gate unmittelbar vor einem erneuten Keycloak-Versand", async () => {
    await db.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, TUTORIAL_WORLD_ID));
    const handlers = createAlphaInvitationAdminHandlers({
      db,
      keycloak,
      redirectUri: "https://game.test/",
      tutorialWorldId: TUTORIAL_WORLD_ID,
    });

    await expect(handlers.alpha_invitation_resend(command("alpha_invitation_resend"))).rejects.toThrow();
    expect(keycloak.resend).not.toHaveBeenCalled();
  });

  it("scheitert ohne konfigurierte Tutorialwelt vor Keycloak und lokalen Writes", async () => {
    const handlers = createAlphaInvitationAdminHandlers({ db, keycloak, redirectUri: "https://game.test/" });

    await expect(handlers.alpha_invitation_create(command("alpha_invitation_create"))).rejects.toThrow();
    expect(keycloak.invite).not.toHaveBeenCalled();
    expect(await db.select().from(accounts)).toHaveLength(0);
    expect(await db.select().from(worldAccesses)).toHaveLength(0);
  });
});
