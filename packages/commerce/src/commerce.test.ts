import { PGlite } from "@electric-sql/pglite";
import { commerceEntitlements, MIGRATIONS_FOLDER, odooCommandQueue, odooProjectionOutbox, odooReconciliationTasks, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminWorkflowError, assertPublicWorldSlot, createHttpOdooProjectionClient, createOdooWebhookReceiptStore, deriveReconciliationTasks, dispatchOdooProjectionOutbox, enqueueAlphaFeedbackProjection, enqueueGameAdminCapabilityProjection, entitlementFeatures, OdooCommandWorkerInterruptedError, processNextOdooCommand, projectionEnvelope, receiveOdooWebhook, reconcileOdooProjectionSnapshot, signPayload, type OdooWebhookEnvelope, type SigningKey, WebhookSignatureError, WebhookValidationError } from "./index.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const WORLD = "11111111-1111-1111-1111-111111111111";
const OTHER_WORLD = "22222222-2222-4222-8222-222222222222";
const KEY: SigningKey = { id: "2026-08", secret: "test-webhook-secret", activeFrom: new Date("2026-01-01T00:00:00Z") };

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

function entitlementEnvelope(eventId = "odoo-event-0001"): OdooWebhookEnvelope {
  return {
    schemaVersion: "zugfolge-odoo/v1", eventId, eventType: "commerce.command", occurredAt: NOW.toISOString(),
    correlationId: "correlation-0001", tenantId: "zugfolge-production", actorReference: "commerce-service",
    command: { kind: "entitlement.change", subject: "kc-anna", productKind: "zugfolge_plus", change: "grant", validFrom: NOW.toISOString(), quantity: 1, sourceReference: "invoice-42" },
  };
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values([
    { id: WORLD, name: "Testwelt", schedulePeriodWeeks: 4, epoch: NOW },
    { id: OTHER_WORLD, name: "Andere Welt", schedulePeriodWeeks: 4, epoch: NOW },
  ]);
});
afterEach(async () => client.close());

describe("signierter Odoo-Receiver", () => {
  it("persistiert Empfang und Queue atomar und behandelt Doppelzustellung idempotent", async () => {
    const signed = signPayload(entitlementEnvelope(), KEY, NOW);
    const options = { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "commerce-service": ["entitlement.change"] } } as const;
    const store = createOdooWebhookReceiptStore(db);

    await expect(receiveOdooWebhook(store, signed, options, NOW)).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(receiveOdooWebhook(store, signed, options, NOW)).resolves.toEqual({ accepted: true, duplicate: true });
    const queued = await db.select().from(odooCommandQueue);
    expect(queued).toHaveLength(1);

    await processNextOdooCommand(db, NOW);
    const entitlements = await db.select().from(commerceEntitlements);
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]).toMatchObject({ keycloakSubject: "kc-anna", productKind: "zugfolge_plus", status: "active" });
  });

  it("weist abgelaufene Signaturen, falsche Mandanten und nicht autorisierte Akteure ab", async () => {
    const store = createOdooWebhookReceiptStore(db);
    const signed = signPayload(entitlementEnvelope(), KEY, NOW);
    const base = { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "commerce-service": ["entitlement.change"] } } as const;
    await expect(receiveOdooWebhook(store, signed, base, new Date(NOW.getTime() + 301_000))).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(receiveOdooWebhook(store, signPayload({ ...entitlementEnvelope(), tenantId: "other" }, KEY, NOW), base, NOW)).rejects.toMatchObject({ code: "tenant" } satisfies Partial<WebhookValidationError>);
    await expect(receiveOdooWebhook(store, signPayload({ ...entitlementEnvelope(), actorReference: "unknown" }, KEY, NOW), base, NOW)).rejects.toMatchObject({ code: "authorization" } satisfies Partial<WebhookValidationError>);
  });

  it("akzeptiert einen aktiven Rotationsschluessel", async () => {
    const next: SigningKey = { id: "2026-09", secret: "next-secret", activeFrom: new Date("2026-08-01T00:00:00Z") };
    const result = await receiveOdooWebhook(
      createOdooWebhookReceiptStore(db), signPayload(entitlementEnvelope("odoo-event-0002"), next, NOW),
      { tenantId: "zugfolge-production", keys: [KEY, next], authorizedActors: { "commerce-service": ["entitlement.change"] } }, NOW,
    );
    expect(result.duplicate).toBe(false);
  });
});

describe("Entitlement-Schutzgrenze", () => {
  it("liefert nur Weltplatz-, Kosmetik- und Privatweltrechte, nie Simulations- oder Plannerwerte", () => {
    const features = entitlementFeatures([
      { subject: "kc-anna", productKind: "zugfolge_plus", status: "active", validFrom: new Date("2026-01-01T00:00:00Z"), quantity: 1 },
      { subject: "kc-anna", productKind: "cosmetic", status: "active", validFrom: new Date("2026-01-01T00:00:00Z"), quantity: 1 },
    ], NOW);
    expect(features).toEqual({ activePublicWorldLimit: 3, cosmetics: true, mayCreatePrivateUnrankedWorld: false });
    expect(Object.keys(features)).not.toContain("plannerPriority");
    expect(() => assertPublicWorldSlot([], 1, NOW)).toThrow();
  });
});

describe("Bridge", () => {
  it("retryt eine fehlgeschlagene Projektion ohne den Queue-Fortschritt des Games zu blockieren", async () => {
    await db.insert(odooProjectionOutbox).values({ worldId: WORLD, messageType: "world.projection", schemaVersion: "zugfolge-odoo/v1", correlationId: "correlation-bridge", payload: { freshness: "delayed" }, occurredAt: NOW, enqueuedAt: NOW });
    const failed = await dispatchOdooProjectionOutbox(db, WORLD, { project: async () => { throw new Error("offline"); } }, NOW);
    expect(failed).toEqual({ delivered: 0, failed: 1 });
    const delivered = await dispatchOdooProjectionOutbox(db, WORLD, { project: async () => undefined }, new Date(NOW.getTime() + 1_000));
    expect(delivered).toEqual({ delivered: 1, failed: 0 });
    const [row] = await db.select().from(odooProjectionOutbox);
    expect(row?.deliveredAt).toBeDefined();
  });

  it("markiert eine fachlich abgelehnte Odoo-Projektion nicht als zugestellt", async () => {
    const project = createHttpOdooProjectionClient("https://odoo.test/zugfolge/projection", KEY, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", result: { accepted: false, code: "invalid_signature" } }),
    }));
    await expect(project.project({
      schemaVersion: "zugfolge-odoo/v1",
      messageId: "11111111-1111-4111-8111-111111111111",
      messageType: "world.projection",
      worldId: WORLD,
      occurredAt: NOW.toISOString(),
      correlationId: "projection-rejected-0001",
      payload: {},
    })).rejects.toThrow(/invalid_signature/);
  });

  it("liefert nur Projektionen der explizit gebundenen Welt aus", async () => {
    await db.insert(odooProjectionOutbox).values([
      { worldId: WORLD, messageType: "world.projection", schemaVersion: "zugfolge-odoo/v1", correlationId: "correlation-local", payload: {}, occurredAt: NOW, enqueuedAt: NOW },
      { worldId: OTHER_WORLD, messageType: "world.projection", schemaVersion: "zugfolge-odoo/v1", correlationId: "correlation-foreign", payload: {}, occurredAt: NOW, enqueuedAt: NOW },
    ]);
    const projectedWorlds: string[] = [];
    await expect(dispatchOdooProjectionOutbox(db, WORLD, {
      async project(message) { projectedWorlds.push(message.worldId); },
    }, NOW)).resolves.toEqual({ delivered: 1, failed: 0 });

    expect(projectedWorlds).toEqual([WORLD]);
    const [foreign] = await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, OTHER_WORLD));
    expect(foreign?.deliveredAt).toBeNull();
  });

  it("legt pseudonymisiertes Alpha-Feedback als weltgebundene Outbox-Projektion ab", async () => {
    await enqueueAlphaFeedbackProjection(db, {
      worldId: WORLD,
      correlationId: "alpha-feedback-0001",
      occurredAt: NOW,
      payload: {
        feedbackReference: "22222222-2222-4222-8222-222222222222",
        participantPseudonym: "pseudonym-42",
        category: "usability",
        message: "Die Kapazitaetsanzeige ist schwer verstaendlich.",
      },
    });
    const [row] = await db.select().from(odooProjectionOutbox);
    expect(projectionEnvelope(row!)).toMatchObject({
      messageType: "alpha.feedback.projection",
      worldId: WORLD,
      payload: { participantPseudonym: "pseudonym-42" },
    });
    expect(JSON.stringify(row?.payload)).not.toContain("keycloak");
  });
});

describe("Vier-Augen-Validierung", () => {
  it("behandelt jeden Weltzugangsentzug als Hochrisikoaktion", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-revoke-standard"), actorReference: "admin-service",
      command: {
        kind: "admin.world_access_revoke", worldId: WORLD, actionType: "world_access_revoke", riskClass: "standard",
        requesterReference: "requester", reason: "Zugang entziehen", effectPreview: {}, targetReference: "subject-1",
      },
    };
    await expect(receiveOdooWebhook(
      createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW),
      { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.world_access_revoke"] } }, NOW,
    )).rejects.toBeInstanceOf(AdminWorkflowError);
    expect(await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId))).toHaveLength(0);
  });

  it("lehnt Selbstfreigabe und fehlende Begruendung vor dem Queue-Commit ab", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-0003"), actorReference: "admin-service",
      command: { kind: "admin.infra_release_adoption", worldId: WORLD, actionType: "infra_release_adoption", riskClass: "high", requesterReference: "same", approverReference: "same", reason: "", effectPreview: {}, releaseHash: "a".repeat(64), requestedPeriodStart: NOW.toISOString() },
    };
    await expect(receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.infra_release_adoption"] } }, NOW)).rejects.toBeInstanceOf(AdminWorkflowError);
    expect(await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId))).toHaveLength(0);
  });

  it("materialisiert einen freigegebenen Hochrisikoantrag nur ueber einen registrierten Game-Handler als Audit und Odoo-Rueckprojektion", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-0004"), actorReference: "admin-service",
      command: { kind: "admin.infra_release_adoption", worldId: WORLD, actionType: "infra_release_adoption", riskClass: "high", requesterReference: "requester", approverReference: "approver", reason: "Jahreswechsel nach Abweichungsbericht", effectPreview: { releaseHash: "a".repeat(64) }, releaseHash: "a".repeat(64), requestedPeriodStart: "2026-12-13T00:00:00.000Z" },
    };
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.infra_release_adoption"] } }, NOW);
    await expect(processNextOdooCommand(db, NOW, {
      adminHandlers: {
        infra_release_adoption: () => ({ gameAuditEventId: "game-audit-infra-001" }),
      },
    })).resolves.toMatchObject({ outcome: "accepted" });
    const audit = await db.select().from(schema.gameAdminRequests);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ state: "accepted", requesterReference: "requester", approverReference: "approver" });
    const [auditEvent] = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.id, audit[0]!.gameAuditEventId!));
    expect(auditEvent).toMatchObject({ eventType: "admin.action-audited", payload: { outcome: "accepted", effectAuditReference: "game-audit-infra-001" } });
    const projections = await db.select().from(odooProjectionOutbox);
    expect(projections[0]?.payload).toMatchObject({ outcome: "accepted", gameAuditEventId: audit[0]?.gameAuditEventId, effectAuditReference: "game-audit-infra-001" });
  });

  it("claimt einen Administrationsbefehl atomar und fuehrt ihn bei parallelen Workern nur einmal aus", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-race"), actorReference: "admin-service", correlationId: "correlation-race",
      command: { kind: "admin.infra_release_adoption", worldId: WORLD, actionType: "infra_release_adoption", riskClass: "high", requesterReference: "requester", approverReference: "approver", reason: "Parallele Worker pruefen", effectPreview: { releaseHash: "c".repeat(64) }, releaseHash: "c".repeat(64), requestedPeriodStart: "2026-12-13T00:00:00.000Z" },
    };
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), {
      tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.infra_release_adoption"] },
    }, NOW);

    let handlerCalls = 0;
    let announceStarted!: () => void;
    let releaseHandler!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const options = {
      adminHandlers: {
        infra_release_adoption: async () => {
          handlerCalls += 1;
          announceStarted();
          await blocked;
          return { state: "completed" as const, gameAuditEventId: "game-audit-race" };
        },
      },
    };
    const firstWorker = processNextOdooCommand(db, NOW, options);
    await started;
    let secondResult;
    try {
      secondResult = await processNextOdooCommand(db, new Date(NOW.getTime() + 1_000), options);
    } finally {
      releaseHandler();
    }

    await expect(firstWorker).resolves.toMatchObject({ outcome: "accepted" });
    expect(secondResult).toBeUndefined();
    expect(handlerCalls).toBe(1);
    const [queue] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    expect(queue).toMatchObject({ status: "completed", claimToken: null, claimExpiresAt: null, failureCode: null });
    expect(await db.select().from(schema.gameAdminRequests).where(eq(schema.gameAdminRequests.worldId, WORLD))).toHaveLength(1);
  });

  it("erneuert den Claim waehrend eines ueberlangen Handlers und verhindert die zweite Geschaeftswirkung", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-heartbeat"), actorReference: "admin-service", correlationId: "correlation-heartbeat",
      command: { kind: "admin.infra_release_adoption", worldId: WORLD, actionType: "infra_release_adoption", riskClass: "high", requesterReference: "requester", approverReference: "approver", reason: "Lease-Ablauf mit zwei Workern pruefen", effectPreview: { releaseHash: "e".repeat(64) }, releaseHash: "e".repeat(64), requestedPeriodStart: "2026-12-13T00:00:00.000Z" },
    };
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), {
      tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.infra_release_adoption"] },
    }, NOW);

    let logicalNow = NOW;
    let handlerCalls = 0;
    let announceStarted!: () => void;
    let releaseHandler!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const options = {
      claimLeaseMs: 1_000,
      claimHeartbeatMs: 25,
      claimClock: () => logicalNow,
      adminHandlers: {
        infra_release_adoption: async () => {
          handlerCalls += 1;
          announceStarted();
          await blocked;
          return { state: "completed" as const, gameAuditEventId: "game-audit-heartbeat" };
        },
      },
    };

    const firstWorker = processNextOdooCommand(db, NOW, options);
    await started;
    logicalNow = new Date(NOW.getTime() + 1_500);

    let renewed = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [queue] = await db.select({ claimExpiresAt: odooCommandQueue.claimExpiresAt })
        .from(odooCommandQueue)
        .where(eq(odooCommandQueue.eventId, payload.eventId));
      if ((queue?.claimExpiresAt?.getTime() ?? 0) > logicalNow.getTime()) {
        renewed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(renewed).toBe(true);

    let secondResult;
    try {
      secondResult = await processNextOdooCommand(db, logicalNow, options);
    } finally {
      releaseHandler();
    }
    await expect(firstWorker).resolves.toMatchObject({ outcome: "accepted" });
    expect(secondResult).toBeUndefined();
    expect(handlerCalls).toBe(1);
  });

  it("uebernimmt einen abgelaufenen Worker-Claim nach einem Prozessabbruch", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-stale-claim"), actorReference: "admin-service", correlationId: "correlation-stale-claim",
      command: { kind: "admin.infra_release_adoption", worldId: WORLD, actionType: "infra_release_adoption", riskClass: "high", requesterReference: "requester", approverReference: "approver", reason: "Abgebrochenen Worker fortsetzen", effectPreview: { releaseHash: "d".repeat(64) }, releaseHash: "d".repeat(64), requestedPeriodStart: "2026-12-13T00:00:00.000Z" },
    };
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), {
      tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.infra_release_adoption"] },
    }, NOW);
    await db.update(odooCommandQueue).set({
      status: "processing",
      claimToken: "abandoned-worker",
      claimExpiresAt: new Date(NOW.getTime() - 1),
      processedAt: new Date(NOW.getTime() - 60_000),
    }).where(eq(odooCommandQueue.eventId, payload.eventId));

    await expect(processNextOdooCommand(db, NOW, {
      adminHandlers: { infra_release_adoption: () => ({ state: "completed", gameAuditEventId: "game-audit-recovered" }) },
    })).resolves.toMatchObject({ outcome: "accepted" });
    const [queue] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    expect(queue).toMatchObject({ status: "completed", claimToken: null, claimExpiresAt: null });
  });

  it("wiederholt nach Abbruch zwischen Wirkung und Finalisierung nur denselben idempotenten Facheffekt", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-effect-crash"), actorReference: "admin-service", correlationId: "correlation-effect-crash",
      command: { kind: "admin.infra_release_adoption", worldId: WORLD, actionType: "infra_release_adoption", riskClass: "high", requesterReference: "requester", approverReference: "approver", reason: "Abbruch nach Wirkung reproduzieren", effectPreview: { releaseHash: "f".repeat(64) }, releaseHash: "f".repeat(64), requestedPeriodStart: "2026-12-13T00:00:00.000Z" },
    };
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), {
      tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.infra_release_adoption"] },
    }, NOW);

    let calls = 0;
    const appliedEffects = new Set<string>();
    const handler = (context: { readonly commandId: string; readonly effectIdempotencyKey: string }) => {
      calls += 1;
      appliedEffects.add(context.effectIdempotencyKey);
      if (calls === 1) throw new OdooCommandWorkerInterruptedError(context.commandId);
      return { state: "completed" as const, gameAuditEventId: `game-audit:${context.effectIdempotencyKey}` };
    };
    const options = {
      claimLeaseMs: 1_000,
      claimHeartbeatMs: 100,
      claimClock: () => NOW,
      adminHandlers: { infra_release_adoption: handler },
    };

    await expect(processNextOdooCommand(db, NOW, options)).rejects.toBeInstanceOf(OdooCommandWorkerInterruptedError);
    const [interrupted] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    expect(interrupted).toMatchObject({ status: "processing", failureCode: null });

    await expect(processNextOdooCommand(db, new Date(NOW.getTime() + 1_001), options))
      .resolves.toMatchObject({ outcome: "accepted" });
    expect(calls).toBe(2);
    expect(appliedEffects.size).toBe(1);
    const [completed] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    expect(completed).toMatchObject({ status: "completed", claimToken: null, claimExpiresAt: null, failureCode: null });
  });

  it("haelt eine manuelle Stoerung ohne M8-Game-Handler vorbereitet und sichtbar wirkungslos", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-0005"), actorReference: "admin-service",
      command: {
        kind: "admin.manual_disruption_create", worldId: WORLD, actionType: "manual_disruption_create", riskClass: "high",
        requesterReference: "spielleitung-1", approverReference: "spielleitung-2", reason: "Gemeldete Weichenstoerung pruefen",
        effectPreview: { affectedTrains: "wird durch Game ermittelt" },
        manualDisruption: {
          startsAt: "2026-08-11T13:00:00.000Z", endsAt: "2026-08-11T15:00:00.000Z", cause: "Weichenstoerung",
          affectedResourceIds: ["switch:leipzig:42"], declaredEffect: { kind: "closure" },
        },
      },
    };
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), {
      tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.manual_disruption_create"] },
    }, NOW);

    await expect(processNextOdooCommand(db, NOW)).resolves.toMatchObject({ outcome: "rejected", code: "GameAdminCapabilityUnavailableError" });
    const [request] = await db.select().from(schema.gameAdminRequests);
    expect(request).toMatchObject({ state: "failed", actionType: "manual_disruption_create" });
    const [auditEvent] = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.id, request!.gameAuditEventId!));
    expect(auditEvent).toMatchObject({ eventType: "admin.action-audited", payload: { outcome: "failed", failureCode: "GameAdminCapabilityUnavailableError" } });
    const [queue] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    expect(queue).toMatchObject({ status: "rejected", failureCode: "GameAdminCapabilityUnavailableError" });
    const [result] = await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.correlationId, payload.correlationId));
    expect(result?.payload).toMatchObject({ outcome: "rejected", failureCode: "GameAdminCapabilityUnavailableError" });
  });

  it("veroeffentlicht eine Verwaltungsfaehigkeit nur als signierte Outbox-Projektion fuer die Odoo-Ansicht", async () => {
    await enqueueGameAdminCapabilityProjection(db, {
      worldId: WORLD,
      correlationId: "capability-m8-prepare-001",
      capability: { actionType: "manual_disruption_create", availability: "prepared", detail: "M8.3 ist noch nicht im Game aktiviert." },
      occurredAt: NOW,
    });
    const [projection] = await db.select().from(odooProjectionOutbox);
    expect(projectionEnvelope(projection!)).toMatchObject({
      messageType: "admin.capability.projection",
      worldId: WORLD,
      payload: { actionType: "manual_disruption_create", availability: "prepared" },
    });
  });
});

describe("nächtliche Reconciliation", () => {
  it("erstellt fehlende, doppelte und divergente Befunde statt Daten zu überschreiben", async () => {
    const [row] = await db.insert(odooProjectionOutbox).values({ worldId: WORLD, messageType: "world.projection", schemaVersion: "zugfolge-odoo/v1", correlationId: "correlation-reconcile", payload: { version: 1 }, occurredAt: NOW, enqueuedAt: NOW, deliveredAt: NOW }).returning();
    const expected = [{ id: row!.id, worldId: WORLD, correlationId: "correlation-reconcile", payload: { version: 1 } }];
    expect(deriveReconciliationTasks(expected, [])).toMatchObject([{ issueKind: "missing" }]);
    const tasks = await reconcileOdooProjectionSnapshot(db, [
      { messageId: row!.id, worldId: WORLD, correlationId: "wrong", payloadHash: "b".repeat(64) },
      { messageId: row!.id, worldId: WORLD, correlationId: "wrong", payloadHash: "b".repeat(64) },
    ], NOW);
    expect(tasks.map((task) => task.issueKind).sort()).toEqual(["divergent", "duplicate"]);
    expect(await db.select().from(odooReconciliationTasks)).toHaveLength(2);
    expect((await db.select().from(odooProjectionOutbox))[0]?.payload).toEqual({ version: 1 });
  });
});
