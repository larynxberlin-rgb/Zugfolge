import { PGlite } from "@electric-sql/pglite";
import { commerceEntitlements, MIGRATIONS_FOLDER, odooCommandQueue, odooProjectionOutbox, odooReconciliationTasks, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminWorkflowError, assertPublicWorldSlot, createHttpOdooProjectionClient, createOdooWebhookReceiptStore, deriveReconciliationTasks, dispatchOdooProjectionOutbox, enqueueAlphaFeedbackProjection, enqueueGameAdminCapabilityProjection, entitlementFeatures, processNextOdooCommand, projectionEnvelope, receiveOdooWebhook, reconcileOdooProjectionSnapshot, signPayload, type AdminCommandPayload, type OdooWebhookEnvelope, type SigningKey, validateAdminCommand, WebhookSignatureError, WebhookValidationError } from "./index.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const WORLD = "11111111-1111-4111-8111-111111111111";
const NEW_WORLD = "22222222-2222-4222-8222-222222222222";
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

function worldDeployCommand(
  policy: unknown = { mode: "finite", amountCents: "1000000" },
  worldId = WORLD,
): AdminCommandPayload {
  return {
    kind: "admin.world_deploy",
    worldId,
    actionType: "world_deploy",
    riskClass: "high",
    requesterReference: "world-author-1",
    approverReference: "world-approver-2",
    reason: "Signierten Weltentwurf produktiv bereitstellen",
    effectPreview: { startingCapitalPolicy: policy },
    startingCapitalPolicy: policy as AdminCommandPayload["startingCapitalPolicy"],
    worldDefinition: {
      name: "Oeffentliche Testwelt",
      kind: "public",
      rankingStatus: "ranked",
      schedulePeriodWeeks: 4,
      epoch: "2026-12-13T00:00:00.000Z",
    },
    deploymentHash: "d".repeat(64),
    signedDeployment: {
      deploymentHash: "d".repeat(64),
      deployment: {
        worldId,
        worldDefinition: {
          name: "Oeffentliche Testwelt",
          kind: "public",
          rankingStatus: "ranked",
          schedulePeriodWeeks: 4,
          epoch: "2026-12-13T00:00:00.000Z",
        },
        blueprint: { profileKind: "public", startingCapitalPolicy: policy },
      },
      signature: { algorithm: "Ed25519", keyId: "alpha-release-2026", valueBase64: `${"A".repeat(86)}==` },
    },
  };
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values({ id: WORLD, name: "Testwelt", schedulePeriodWeeks: 4, epoch: NOW });
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
    const failed = await dispatchOdooProjectionOutbox(db, { project: async () => { throw new Error("offline"); } }, NOW);
    expect(failed).toEqual({ delivered: 0, failed: 1 });
    const delivered = await dispatchOdooProjectionOutbox(db, { project: async () => undefined }, new Date(NOW.getTime() + 1_000));
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
  it("akzeptiert endliches und unbegrenztes Startkapital nur als signierte, weltgebundene Policy", () => {
    expect(() => validateAdminCommand(worldDeployCommand())).not.toThrow();
    expect(() => validateAdminCommand(worldDeployCommand({ mode: "unlimited" }))).not.toThrow();
  });

  it("lehnt unbekannte Felder in Policy, Weltdefinition und Signaturhülle ab", () => {
    expect(() => validateAdminCommand(worldDeployCommand({ mode: "finite", amountCents: "1000000", currency: "EUR" }))).toThrow(AdminWorkflowError);
    const command = worldDeployCommand() as AdminCommandPayload & {
      signedDeployment: NonNullable<AdminCommandPayload["signedDeployment"]>;
      worldDefinition: NonNullable<AdminCommandPayload["worldDefinition"]>;
    };
    expect(() => validateAdminCommand({
      ...command,
      worldDefinition: { ...command.worldDefinition, unknown: true } as typeof command.worldDefinition,
    })).toThrow(AdminWorkflowError);
    expect(() => validateAdminCommand({
      ...command,
      signedDeployment: {
        ...command.signedDeployment,
        signature: { ...command.signedDeployment.signature, signedHash: command.deploymentHash } as typeof command.signedDeployment.signature,
      },
    })).toThrow(AdminWorkflowError);
  });

  it.each([
    { mode: "finite", amountCents: -1 },
    { mode: "finite", amountCents: 1_000_000 },
    { mode: "finite", amountCents: "-1" },
    { mode: "finite", amountCents: "1e6" },
    { mode: "finite", amountCents: "01" },
    { mode: "finite", amountCents: "1.00" },
    { mode: "finite", amountCents: "Infinity" },
    { mode: "finite", amountCents: "9223372036854775808" },
    { mode: "finite", amountCents: Number.POSITIVE_INFINITY },
    { mode: "unlimited", amountCents: "0" },
  ])("lehnt numerische, negative, exponentielle oder modalfremde Centwerte ab: $amountCents", (policy) => {
    expect(() => validateAdminCommand(worldDeployCommand(policy))).toThrow(AdminWorkflowError);
  });

  it("lehnt eine vom signierten Blueprint abweichende Policy sowie fremde Weltbindung ab", () => {
    const divergent = worldDeployCommand() as AdminCommandPayload & { signedDeployment: NonNullable<AdminCommandPayload["signedDeployment"]> };
    expect(() => validateAdminCommand({
      ...divergent,
      signedDeployment: {
        ...divergent.signedDeployment,
        deployment: { ...divergent.signedDeployment.deployment, worldId: WORLD, blueprint: { profileKind: "public", startingCapitalPolicy: { mode: "finite", amountCents: "0" } } },
      },
    })).toThrow(/weichen voneinander ab/);
    expect(() => validateAdminCommand({
      ...divergent,
      signedDeployment: {
        ...divergent.signedDeployment,
        deployment: { ...divergent.signedDeployment.deployment, worldId: "22222222-2222-2222-2222-222222222222", blueprint: { profileKind: "public", startingCapitalPolicy: divergent.startingCapitalPolicy } },
      },
    })).toThrow(/Weltbindung/);
    expect(() => validateAdminCommand({
      ...divergent,
      signedDeployment: {
        ...divergent.signedDeployment,
        deployment: { ...divergent.signedDeployment.deployment, worldId: WORLD, blueprint: { profileKind: "tutorial", startingCapitalPolicy: divergent.startingCapitalPolicy } },
      },
    })).toThrow(/Profilbindung/);
  });

  it("lehnt ein Startpaketfeld im Einladungsbefehl als fachfremde Ressourcenzuteilung ab", () => {
    const command = {
      kind: "admin.alpha_invitation_create",
      worldId: WORLD,
      actionType: "alpha_invitation_create",
      riskClass: "standard",
      requesterReference: "invite-requester",
      reason: "Alpha-Einladung",
      effectPreview: {},
      invitation: {
        requestReference: "INV-1",
        email: "alpha@example.test",
        displayName: "Alpha",
        role: "player",
        startPackage: "public-starter-must-not-exist",
      },
    } as unknown as AdminCommandPayload;
    expect(() => validateAdminCommand(command)).toThrow(/fachfremde Felder/);
  });

  it("persistiert world_deploy nur als autorisierte Queue-Nachricht und erzeugt ohne Game-Handler keine Wirkung", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-world-deploy"),
      actorReference: "admin-service",
      command: worldDeployCommand(),
    };
    const options = { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.world_deploy"] } } as const;
    await expect(receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), options, NOW))
      .resolves.toEqual({ accepted: true, duplicate: false });
    const [queued] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    expect(queued).toMatchObject({ worldId: WORLD, commandType: "admin.world_deploy", status: "pending" });
    await expect(processNextOdooCommand(db, NOW)).resolves.toMatchObject({ outcome: "rejected", code: "GameAdminCapabilityUnavailableError" });
  });

  it("lehnt Nicht-Deployment-Kommandos fuer unbekannte Welten atomar vor der Queue ab", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-unknown-world-admin"),
      correlationId: "correlation-unknown-world-admin",
      actorReference: "admin-service",
      command: {
        kind: "admin.infra_release_adoption",
        worldId: NEW_WORLD,
        actionType: "infra_release_adoption",
        riskClass: "high",
        requesterReference: "requester",
        approverReference: "approver",
        reason: "Release fuer unbekannte Welt darf nicht angenommen werden",
        effectPreview: { releaseHash: "a".repeat(64) },
        releaseHash: "a".repeat(64),
        requestedPeriodStart: "2026-12-13T00:00:00.000Z",
      },
    };
    await expect(receiveOdooWebhook(
      createOdooWebhookReceiptStore(db),
      signPayload(payload, KEY, NOW),
      { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.infra_release_adoption"] } },
      NOW,
    )).rejects.toThrow(/unbekannte Welt/);

    expect(await db.select().from(schema.odooWebhookReceipts).where(eq(schema.odooWebhookReceipts.eventId, payload.eventId))).toHaveLength(0);
    expect(await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId))).toHaveLength(0);
  });

  it("belegt eine pre-world Deploy-Ablehnung global und meldet erst dann autoritativ zurueck", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-pre-world-reject"),
      correlationId: "correlation-pre-world-reject",
      actorReference: "admin-service",
      command: worldDeployCommand({ mode: "finite", amountCents: "0" }, NEW_WORLD),
    };
    await receiveOdooWebhook(
      createOdooWebhookReceiptStore(db),
      signPayload(payload, KEY, NOW),
      { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.world_deploy"] } },
      NOW,
    );

    await expect(processNextOdooCommand(db, NOW)).resolves.toMatchObject({
      outcome: "rejected",
      code: "GameAdminCapabilityUnavailableError",
    });

    const [audit] = await db.select().from(schema.globalAdminAuditEvents);
    expect(audit).toMatchObject({
      targetWorldId: NEW_WORLD,
      correlationId: "correlation-pre-world-reject",
      actionType: "world_deploy",
      outcome: "rejected",
      failureCode: "GameAdminCapabilityUnavailableError",
    });
    const [result] = await db.select().from(odooProjectionOutbox).where(eq(
      odooProjectionOutbox.correlationId,
      "correlation-pre-world-reject",
    ));
    expect(result?.payload).toMatchObject({
      outcome: "rejected",
      authoritative: true,
      auditScope: "global",
      gameAuditEventId: `global-admin-audit:${audit?.id}`,
    });
  });

  it("queue't und auditiert ein signiertes Deployment, obwohl die Zielwelt erst im Game-Handler entsteht", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-new-world-deploy"),
      correlationId: "correlation-new-world-deploy",
      actorReference: "admin-service",
      command: worldDeployCommand({ mode: "finite", amountCents: "1000000" }, NEW_WORLD),
    };
    const options = { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.world_deploy"] } } as const;
    await expect(receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), options, NOW))
      .resolves.toEqual({ accepted: true, duplicate: false });
    expect(await db.select().from(worlds).where(eq(worlds.id, NEW_WORLD))).toHaveLength(0);

    await expect(processNextOdooCommand(db, NOW, {
      adminHandlers: {
        world_deploy: async ({ adminRequestId }) => {
          expect(adminRequestId).toMatch(/^[a-f0-9-]{36}$/);
          await db.insert(worlds).values({
            id: NEW_WORLD,
            name: "Oeffentliche Testwelt",
            schedulePeriodWeeks: 4,
            epoch: new Date("2026-12-13T00:00:00.000Z"),
          });
          return {
            state: "completed",
            gameAuditEventId: `world-deploy:${NEW_WORLD}`,
            result: { deploymentHash: "d".repeat(64), startingCapitalPolicy: { mode: "finite", amountCents: "1000000" } },
          };
        },
      },
    })).resolves.toMatchObject({ outcome: "accepted" });

    const [request] = await db.select().from(schema.gameAdminRequests).where(eq(schema.gameAdminRequests.worldId, NEW_WORLD));
    expect(request).toMatchObject({ actionType: "world_deploy", state: "completed" });
    const [audit] = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.worldId, NEW_WORLD));
    expect(audit).toMatchObject({ eventType: "admin.action-audited", payload: { outcome: "completed" } });
    const [result] = await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, NEW_WORLD));
    expect(result?.payload).toMatchObject({
      outcome: "accepted",
      state: "completed",
      deploymentHash: "d".repeat(64),
      startingCapitalPolicy: { mode: "finite", amountCents: "1000000" },
    });
  });

  it("haelt ein nach Welterzeugung transient gescheitertes Deployment mit stabiler Antrag-ID retrybar", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-world-deploy-retry"),
      correlationId: "correlation-world-deploy-retry",
      actorReference: "admin-service",
      command: worldDeployCommand({ mode: "finite", amountCents: "0" }, NEW_WORLD),
    };
    await receiveOdooWebhook(
      createOdooWebhookReceiptStore(db),
      signPayload(payload, KEY, NOW),
      { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.world_deploy"] } },
      NOW,
    );
    const requestIds: string[] = [];
    let attempts = 0;
    const processing = {
      adminHandlers: {
        world_deploy: async ({ adminRequestId }: { readonly adminRequestId: string }) => {
          requestIds.push(adminRequestId);
          attempts += 1;
          if (attempts === 1) {
            await db.insert(worlds).values({
              id: NEW_WORLD,
              name: "Oeffentliche Testwelt",
              schedulePeriodWeeks: 4,
              epoch: new Date("2026-12-13T00:00:00.000Z"),
              lifecycleStatus: "provisioning",
            });
            throw new Error("transienter Fleet-Startfehler");
          }
          await db.update(worlds).set({ lifecycleStatus: "active" }).where(eq(worlds.id, NEW_WORLD));
          return { state: "completed" as const, gameAuditEventId: `world-deploy:${NEW_WORLD}` };
        },
      },
    };

    await expect(processNextOdooCommand(db, NOW, processing)).rejects.toThrow(/Fleet-Startfehler/);
    const [pending] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    const [approved] = await db.select().from(schema.gameAdminRequests).where(eq(schema.gameAdminRequests.worldId, NEW_WORLD));
    expect(pending).toMatchObject({ status: "pending", processedAt: null, failureCode: null });
    expect(approved).toMatchObject({ state: "approved", commandId: pending!.id, gameAuditEventId: null });
    expect(await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, NEW_WORLD))).toHaveLength(0);

    await expect(processNextOdooCommand(db, new Date(NOW.getTime() + 1_000), processing)).resolves.toMatchObject({ outcome: "accepted" });
    expect(requestIds).toEqual([approved!.id, approved!.id]);
    expect(await db.select().from(schema.gameAdminRequests).where(eq(schema.gameAdminRequests.worldId, NEW_WORLD))).toEqual([
      expect.objectContaining({ id: approved!.id, state: "completed", gameAuditEventId: expect.any(String) }),
    ]);
  });

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

  it("verwendet den bestehenden Antrag beim Pending-Retry nach einem fehlgeschlagenen Outbox-Commit wieder", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-admin-retry"),
      correlationId: "correlation-admin-retry",
      actorReference: "admin-service",
      command: {
        kind: "admin.infra_release_adoption",
        worldId: WORLD,
        actionType: "infra_release_adoption",
        riskClass: "high",
        requesterReference: "requester",
        approverReference: "approver",
        reason: "Retry nach nachgelagertem Outboxfehler",
        effectPreview: { releaseHash: "a".repeat(64) },
        releaseHash: "a".repeat(64),
        requestedPeriodStart: "2026-12-13T00:00:00.000Z",
      },
    };
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), {
      tenantId: "zugfolge-production",
      keys: [KEY],
      authorizedActors: { "admin-service": ["admin.infra_release_adoption"] },
    }, NOW);
    const handlerRequestIds: string[] = [];
    let handlerCalls = 0;
    const circularResult: Record<string, unknown> = {};
    circularResult["self"] = circularResult;
    const options = {
      adminHandlers: {
        infra_release_adoption: ({ adminRequestId }: { readonly adminRequestId: string }) => {
          handlerCalls += 1;
          handlerRequestIds.push(adminRequestId);
          return handlerCalls === 1
            ? { gameAuditEventId: "game-audit-retry", result: circularResult }
            : { gameAuditEventId: "game-audit-retry", result: { releaseHash: "a".repeat(64) } };
        },
      },
    };

    await expect(processNextOdooCommand(db, NOW, options)).rejects.toThrow();
    const [pending] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    const [persistedRequest] = await db.select().from(schema.gameAdminRequests);
    expect(handlerCalls).toBe(1);
    expect(pending).toMatchObject({ status: "pending", processedAt: null });
    expect(persistedRequest).toMatchObject({ commandId: pending!.id, state: "approved", gameAuditEventId: null });
    expect(handlerRequestIds).toEqual([persistedRequest!.id]);
    expect(await db.select().from(schema.domainEvents)).toHaveLength(0);
    expect(await db.select().from(odooProjectionOutbox)).toHaveLength(0);

    await expect(processNextOdooCommand(db, new Date(NOW.getTime() + 1_000), options)).resolves.toMatchObject({ outcome: "accepted" });
    expect(handlerCalls).toBe(2);
    expect(handlerRequestIds).toEqual([persistedRequest!.id, persistedRequest!.id]);
    expect(await db.select().from(schema.gameAdminRequests)).toEqual([
      expect.objectContaining({ id: persistedRequest!.id, state: "accepted", gameAuditEventId: expect.any(String) }),
    ]);
    expect(await db.select().from(schema.domainEvents)).toHaveLength(1);
    expect(await db.select().from(odooProjectionOutbox)).toHaveLength(1);
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

  it("veroeffentlicht world_deploy als globale Capability, bevor eine Zielwelt existiert", async () => {
    const globalScope = "00000000-0000-0000-0000-000000000000";
    await enqueueGameAdminCapabilityProjection(db, {
      worldId: globalScope,
      correlationId: "capability-world-deploy-global",
      capability: { actionType: "world_deploy", availability: "available" },
      occurredAt: NOW,
    });
    const [projection] = await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, globalScope));
    expect(projectionEnvelope(projection!)).toMatchObject({
      worldId: globalScope,
      payload: { actionType: "world_deploy", availability: "available" },
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
