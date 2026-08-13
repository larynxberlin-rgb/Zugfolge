import { PGlite } from "@electric-sql/pglite";
import type { GameAdminCommandHandler } from "@zugfolge/commerce";
import { accounts, alphaWorldProfiles, MIGRATIONS_FOLDER, tutorialSessions, worldAccesses, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import type { KeycloakAdminClient } from "@zugfolge/identity";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAlphaInvitationAdminHandlers } from "./alpha-invitation-admin.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000081";
const SUBJECT = "kc-external";

type HandlerContext = Parameters<GameAdminCommandHandler>[0];
type WorldFixtureOptions = {
  readonly lifecycleStatus?: "provisioning" | "active" | "archived";
  readonly worldKind?: "public" | "private";
  readonly rankingStatus?: "ranked" | "unranked";
  readonly includeProfile?: boolean;
  readonly profileKind?: "public" | "tutorial" | "private" | "test";
  readonly profileState?: "draft" | "running" | "closing" | "archived";
};

function command(actionType: "alpha_invitation_create" | "alpha_invitation_resend"): HandlerContext {
  return {
    adminRequestId: `request-${actionType}`,
    effectIdempotencyKey: `request-${actionType}`,
    commandId: `command-${actionType}`,
    eventId: `event-${actionType}`,
    correlationId: `correlation-${actionType}`,
    receivedAt: new Date(0),
    now: new Date(0),
    payload: {
      kind: actionType === "alpha_invitation_create"
        ? "admin.alpha_invitation_create"
        : "admin.alpha_invitation_resend",
      worldId: WORLD_ID,
      actionType,
      riskClass: "standard",
      requesterReference: "odoo-admin",
      reason: "Geschlossene Alpha",
      effectPreview: {},
      invitation: {
        requestReference: "INV-1",
        email: "external@example.test",
        displayName: "Externer Spieler",
        role: "player",
        keycloakSubject: SUBJECT,
      },
    },
  };
}

describe("Odoo-Alpha-Einladung ohne statische Tutorialwelt", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let keycloak: KeycloakAdminClient;

  async function seedTargetWorld(options: WorldFixtureOptions = {}): Promise<void> {
    await db.insert(worlds).values({
      id: WORLD_ID,
      name: "Alpha",
      schedulePeriodWeeks: 4,
      epoch: new Date(0),
      worldKind: options.worldKind ?? "public",
      rankingStatus: options.rankingStatus ?? "ranked",
      lifecycleStatus: options.lifecycleStatus ?? "active",
    });
    if (options.includeProfile === false) return;
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD_ID,
      profileKind: options.profileKind ?? "public",
      regionId: "lhe",
      regionVariant: "B",
      worldSeed: 81n,
      accelerationFactor: 1,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: {},
      blueprintHash: "e".repeat(64),
      state: options.profileState ?? "running",
    });
  }

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    keycloak = {
      invite: vi.fn(async () => SUBJECT),
      resend: vi.fn(async () => undefined),
      disable: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => client.close());

  it("provisioniert nur Identitaet, Konto, Rolle und Zugang der oeffentlichen Zielwelt", async () => {
    await seedTargetWorld();
    const handlers = createAlphaInvitationAdminHandlers({ db, keycloak, redirectUri: "https://game.test/" });
    const result = await handlers.alpha_invitation_create(command("alpha_invitation_create"));
    expect(result.state).toBe("completed");
    expect(result.result).toHaveProperty("gameAccountReference");
    expect(result.result).not.toHaveProperty("tutorialAccountReference");
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(worldAccesses)).toEqual([expect.objectContaining({ worldId: WORLD_ID, keycloakSubject: "kc-external", status: "active" })]);
    expect(await db.select().from(tutorialSessions)).toHaveLength(0);
    expect(await db.select().from(worlds)).toHaveLength(1);
  });

  it.each([
    ["inaktiv ist", { lifecycleStatus: "archived" }],
    ["nicht oeffentlich ist", { worldKind: "private", rankingStatus: "unranked" }],
    ["nicht gewertet ist", { rankingStatus: "unranked" }],
    ["kein Alpha-Profil besitzt", { includeProfile: false }],
    ["kein oeffentliches Profil besitzt", { profileKind: "private" }],
    ["kein laufendes Profil besitzt", { profileState: "draft" }],
  ] satisfies ReadonlyArray<readonly [string, WorldFixtureOptions]>)(
    "sendet keine Einladung, wenn die Zielwelt %s",
    async (_label, fixture) => {
      await seedTargetWorld(fixture);
      const handlers = createAlphaInvitationAdminHandlers({ db, keycloak, redirectUri: "https://game.test/" });

      await expect(handlers.alpha_invitation_create(command("alpha_invitation_create"))).rejects.toThrow(
        "Alpha-Einladungen sind nur fuer eine aktive oeffentliche Zielwelt erlaubt.",
      );

      expect(keycloak.invite).not.toHaveBeenCalled();
      expect(await db.select().from(accounts)).toHaveLength(0);
      expect(await db.select().from(worldAccesses)).toHaveLength(0);
      expect(await db.select().from(tutorialSessions)).toHaveLength(0);
    },
  );

  it("prueft das Zielwelt-Gate unmittelbar vor einem erneuten Keycloak-Versand", async () => {
    await seedTargetWorld({ lifecycleStatus: "archived" });
    const handlers = createAlphaInvitationAdminHandlers({ db, keycloak, redirectUri: "https://game.test/" });

    await expect(handlers.alpha_invitation_resend(command("alpha_invitation_resend"))).rejects.toThrow(
      "Alpha-Einladungen sind nur fuer eine aktive oeffentliche Zielwelt erlaubt.",
    );
    expect(keycloak.resend).not.toHaveBeenCalled();
  });
});
