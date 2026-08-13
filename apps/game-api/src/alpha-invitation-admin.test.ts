import { PGlite } from "@electric-sql/pglite";
import { accounts, MIGRATIONS_FOLDER, tutorialSessions, worldAccesses, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import type { KeycloakAdminClient } from "@zugfolge/identity";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAlphaInvitationAdminHandlers } from "./alpha-invitation-admin.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000081";

describe("Odoo-Alpha-Einladung ohne statische Tutorialwelt", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD_ID, name: "Alpha", schedulePeriodWeeks: 4, epoch: new Date(0), worldKind: "public", rankingStatus: "ranked", lifecycleStatus: "active" });
  });

  afterEach(async () => client.close());

  it("provisioniert nur Identitaet, Konto, Rolle und Zugang der oeffentlichen Zielwelt", async () => {
    const keycloak: KeycloakAdminClient = { invite: vi.fn(async () => "kc-external"), resend: vi.fn(async () => undefined), disable: vi.fn(async () => undefined) };
    const handlers = createAlphaInvitationAdminHandlers({ db, keycloak, redirectUri: "https://game.test/" });
    const result = await handlers.alpha_invitation_create({
      adminRequestId: "request-1", effectIdempotencyKey: "request-1", commandId: "command-1", eventId: "event-1", correlationId: "correlation-1",
      receivedAt: new Date(0), now: new Date(0),
      payload: {
        kind: "admin.alpha_invitation_create", worldId: WORLD_ID, actionType: "alpha_invitation_create", riskClass: "standard",
        requesterReference: "odoo-admin", reason: "Geschlossene Alpha", effectPreview: {},
        invitation: { requestReference: "INV-1", email: "external@example.test", displayName: "Externer Spieler", role: "player" },
      },
    });
    expect(result.state).toBe("completed");
    expect(result.result).toHaveProperty("gameAccountReference");
    expect(result.result).not.toHaveProperty("tutorialAccountReference");
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(worldAccesses)).toEqual([expect.objectContaining({ worldId: WORLD_ID, keycloakSubject: "kc-external", status: "active" })]);
    expect(await db.select().from(tutorialSessions)).toHaveLength(0);
    expect(await db.select().from(worlds)).toHaveLength(1);
  });
});
