import { PGlite } from "@electric-sql/pglite";
import {
  createOdooWebhookReceiptStore,
  processNextOdooCommand,
  receiveOdooWebhook,
  signPayload,
  type OdooWebhookEnvelope,
  type SigningKey,
} from "@zugfolge/commerce";
import { MIGRATIONS_FOLDER, domainEvents, gameAdminRequests, odooCommandQueue, odooProjectionOutbox, worldAccesses, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createManualDisruptionAdminHandler } from "./manual-disruption-admin.js";
import { createWorldAccessRevokeAdminHandler } from "./odoo-admin-handlers.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-11T12:00:00.000Z");
const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const KEY: SigningKey = { id: "2026-08", secret: "odoo-game-e2e-secret", activeFrom: EPOCH };

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values({ id: WORLD, name: "M8-M9 Odoo-E2E", schedulePeriodWeeks: 4, epoch: EPOCH });
});

afterEach(async () => client.close());

describe("PR 198/199 Odoo-Game-Produktionsgrenze", () => {
  it("verifiziert Signatur und Vier-Augen-Antrag, persistiert die Queue und ruft nur den M8-Single-Writer auf", async () => {
    const apply = vi.fn(async () => undefined);
    const handler = createManualDisruptionAdminHandler({ worker: { apply }, worldEpoch: () => EPOCH });
    const envelope: OdooWebhookEnvelope = {
      schemaVersion: "zugfolge-odoo/v1",
      eventId: "odoo-manual-disruption-e2e-0001",
      eventType: "commerce.command",
      occurredAt: NOW.toISOString(),
      correlationId: "odoo-game-e2e-correlation-0001",
      tenantId: "zugfolge-production",
      actorReference: "odoo-admin-service",
      command: {
        kind: "admin.manual_disruption_create",
        worldId: WORLD,
        actionType: "manual_disruption_create",
        riskClass: "high",
        requesterReference: "dispatcher-one",
        approverReference: "dispatcher-two",
        reason: "Bestaetigte Weichenstoerung mit erheblicher betrieblicher Wirkung",
        effectPreview: { affectedTrainRuns: 1, maximumDelaySeconds: 600 },
        manualDisruption: {
          startsAt: "2026-08-11T11:55:00.000Z",
          endsAt: "2026-08-11T13:00:00.000Z",
          cause: "Weichenantrieb gestoert",
          affectedResourceIds: ["track:4"],
          declaredEffect: {
            schemaVersion: "zugfolge-manual-disruption-effect/v1",
            kind: "traffic-hold",
            causeCode: 26,
            fineCauseId: "switch.drive",
            targets: [{
              resourceId: "track:4", regionId: "mitteldeutschland-b:leipzig",
            }],
          },
        },
      },
    };

    const receipt = await receiveOdooWebhook(
      createOdooWebhookReceiptStore(db),
      signPayload(envelope, KEY, NOW),
      { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "odoo-admin-service": ["admin.manual_disruption_create"] } },
      NOW,
    );
    expect(receipt).toEqual({ accepted: true, duplicate: false });
    await expect(processNextOdooCommand(db, NOW, { adminHandlers: { manual_disruption_create: handler } })).resolves.toMatchObject({ outcome: "accepted" });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      worldId: WORLD,
      regionId: "mitteldeutschland-b:leipzig",
      command: {
        type: "activate-disruption",
        disruptionId: expect.stringContaining("admin:"),
        effect: { "resource-closed": { resourceId: "track:4" } },
      },
    }), NOW);
    const [queue] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, envelope.eventId));
    expect(queue).toMatchObject({ status: "completed" });
    const [request] = await db.select().from(gameAdminRequests).where(eq(gameAdminRequests.commandId, queue!.id));
    expect(request).toMatchObject({ state: "completed", requesterReference: "dispatcher-one", approverReference: "dispatcher-two" });
    const [audit] = await db.select().from(domainEvents).where(eq(domainEvents.id, request!.gameAuditEventId!));
    expect(audit).toMatchObject({ eventType: "admin.action-audited", payload: { outcome: "completed", actionType: "manual_disruption_create" } });
    const [projection] = await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.correlationId, envelope.correlationId));
    expect(projection?.payload).toMatchObject({ outcome: "accepted", authoritative: true, gameAuditEventId: request!.gameAuditEventId });
  });

  it("entzieht einen Weltzugang ausschliesslich ueber signierten Odoo-Antrag und verknuepft den Game-Auditbeleg", async () => {
    await db.insert(worldAccesses).values({ worldId: WORLD, keycloakSubject: "player-to-revoke" });
    const keycloak = { disable: vi.fn(async () => undefined) };
    const envelope: OdooWebhookEnvelope = {
      schemaVersion: "zugfolge-odoo/v1", eventId: "odoo-world-access-revoke-0001",
      eventType: "commerce.command", occurredAt: NOW.toISOString(),
      correlationId: "odoo-game-e2e-correlation-0002", tenantId: "zugfolge-production",
      actorReference: "odoo-admin-service",
      command: {
        kind: "admin.world_access_revoke", worldId: WORLD, actionType: "world_access_revoke",
        riskClass: "high", requesterReference: "support-one", approverReference: "support-two",
        reason: "Bestaetigter Zugangsentzug nach abgeschlossenem Supportfall",
        effectPreview: { activeSessions: 1 }, targetReference: "player-to-revoke",
      },
    };
    await receiveOdooWebhook(
      createOdooWebhookReceiptStore(db), signPayload(envelope, KEY, NOW),
      { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "odoo-admin-service": ["admin.world_access_revoke"] } }, NOW,
    );
    await expect(processNextOdooCommand(db, NOW, { adminHandlers: { world_access_revoke: createWorldAccessRevokeAdminHandler({ db, keycloak }) } })).resolves.toMatchObject({ outcome: "accepted" });
    expect(keycloak.disable).toHaveBeenCalledWith("player-to-revoke");
    const [access] = await db.select().from(worldAccesses).where(eq(worldAccesses.keycloakSubject, "player-to-revoke"));
    expect(access).toMatchObject({ worldId: WORLD, status: "revoked", revokedAt: NOW });
    const [request] = await db.select().from(gameAdminRequests).where(eq(gameAdminRequests.actionType, "world_access_revoke"));
    const [audit] = await db.select().from(domainEvents).where(eq(domainEvents.id, request!.gameAuditEventId!));
    expect(audit).toMatchObject({ eventType: "admin.action-audited", payload: { actionType: "world_access_revoke", outcome: "completed" } });
    expect(request).toMatchObject({ requesterReference: "support-one", approverReference: "support-two" });
  });
});
