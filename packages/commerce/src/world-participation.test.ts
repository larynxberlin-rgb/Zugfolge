import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, odooCommandQueue, odooProjectionOutbox, odooWebhookReceipts, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOdooWebhookReceiptStore,
  processNextOdooCommand,
  receiveOdooWebhook,
  signPayload,
  validateWorldParticipationChange,
  type OdooWebhookEnvelope,
  type SigningKey,
} from "./index.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-13T06:00:00Z");
const KEY: SigningKey = { id: "key-1", secret: "participation-secret", activeFrom: new Date("2026-01-01T00:00:00Z") };
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

function envelope(eventId: string, idempotencyKey = "payment-42:provision"): OdooWebhookEnvelope {
  return {
    schemaVersion: "zugfolge-odoo/v1", eventId, eventType: "commerce.command", occurredAt: NOW.toISOString(),
    correlationId: "participation-correlation-42", tenantId: "zugfolge", actorReference: "commerce-service",
    command: {
      kind: "world.participation.change", schemaVersion: "zugfolge-world-participation/v1", action: "provision",
      worldId: WORLD, keycloakSubject: "kc-player", displayName: "Spieler",
      odooPartnerReference: "partner-7", odooOrderReference: "SO042", paymentReference: "PAY042",
      idempotencyKey, requestedAt: NOW.toISOString(),
    },
  };
}

describe("Weltteilnahmevertrag", () => {
  it("enthaelt Welt-, Identitaets-, Bestell-, Zahlungs-, Zeit- und Idempotenzbindung", () => {
    expect(() => validateWorldParticipationChange(envelope("odoo-participation-1").command as never)).not.toThrow();
  });

  it("verwirft manipulierte oder unvollstaendige world_id", () => {
    const command = { ...envelope("odoo-participation-2").command, worldId: "../other-world" };
    expect(() => validateWorldParticipationChange(command as never)).toThrow(/world_id/);
  });
});

describe("Weltteilnahmeverarbeitung", () => {
  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD, name: "LHE", schedulePeriodWeeks: 4, epoch: NOW });
  }, 30_000);
  afterEach(async () => client.close());

  it("dedupliziert neue Event-IDs zusaetzlich ueber den fachlichen Payment-Key", async () => {
    const options = { tenantId: "zugfolge", keys: [KEY], authorizedActors: { "commerce-service": ["world.participation.change"] } } as const;
    const store = createOdooWebhookReceiptStore(db);
    await expect(receiveOdooWebhook(store, signPayload(envelope("odoo-participation-a"), KEY, NOW), options, NOW))
      .resolves.toEqual({ accepted: true, duplicate: false });
    await expect(receiveOdooWebhook(store, signPayload(envelope("odoo-participation-b"), KEY, NOW), options, NOW))
      .resolves.toEqual({ accepted: true, duplicate: true });
    expect(await db.select().from(odooWebhookReceipts)).toHaveLength(2);
    expect(await db.select().from(odooCommandQueue)).toHaveLength(1);
  });

  it("ruft den Game-Single-Writer genau einmal auf und projiziert das Ergebnis", async () => {
    const options = { tenantId: "zugfolge", keys: [KEY], authorizedActors: { "commerce-service": ["world.participation.change"] } } as const;
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(envelope("odoo-participation-c"), KEY, NOW), options, NOW);
    const handler = vi.fn(async () => ({ state: "active" as const, participationId: "game-participation", gameAccountReference: "game-account" }));
    await expect(processNextOdooCommand(db, NOW, { participationHandler: handler })).resolves.toMatchObject({ outcome: "accepted" });
    await expect(processNextOdooCommand(db, NOW, { participationHandler: handler })).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    const [queue] = await db.select().from(odooCommandQueue);
    expect(queue).toMatchObject({ status: "completed", claimToken: null, claimExpiresAt: null, failureCode: null });
    const [projection] = await db.select().from(odooProjectionOutbox);
    expect(projection).toMatchObject({ worldId: WORLD, messageType: "world.participation.result" });
    expect(projection?.payload).toMatchObject({ state: "active", idempotencyKey: "payment-42:provision", authoritative: true });
  });

  it("liefert eine sichere Ablehnungsprojektion, wenn der Game-Handler fehlt", async () => {
    const options = { tenantId: "zugfolge", keys: [KEY], authorizedActors: { "commerce-service": ["world.participation.change"] } } as const;
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(envelope("odoo-participation-d"), KEY, NOW), options, NOW);
    await expect(processNextOdooCommand(db, NOW)).resolves.toMatchObject({ outcome: "rejected" });
    const [queue] = await db.select().from(odooCommandQueue);
    expect(queue).toMatchObject({ status: "rejected", claimToken: null, claimExpiresAt: null });
    const [projection] = await db.select().from(odooProjectionOutbox);
    expect(projection?.payload).toMatchObject({
      action: "provision", idempotencyKey: "payment-42:provision", state: "rejected", authoritative: true,
    });
  });
});
