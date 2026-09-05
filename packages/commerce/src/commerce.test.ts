import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { commerceEntitlements, MIGRATIONS_FOLDER, odooCommandQueue, odooProjectionOutbox, odooReconciliationTasks, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeEntitlementsForSubject } from "./store.js";

import { ADMIN_ACTION_TYPES, AdminWorkflowError, assertPublicWorldSlot, canonicalJson, COMMAND_TYPES, createHttpOdooProjectionClient, createHttpOdooReconciliationClient, createOdooWebhookReceiptStore, deriveReconciliationTasks, dispatchOdooProjectionOutbox, enqueueAlphaFeedbackProjection, enqueueAuthoritativeWorldStartProjection, enqueueGameAdminCapabilityProjection, enqueueWorldProjection, entitlementFeatures, listPendingOdooProjectionWorldIds, ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA, OdooCommandWorkerInterruptedError, processNextOdooCommand, projectionEnvelope, projectionEnvelopeHash, receiveOdooWebhook, reconcileOdooProjectionSnapshot, signPayload, type AdminCommandPayload, type OdooProjectionEnvelope, type OdooWebhookEnvelope, type SigningKey, validateAdminCommand, WebhookSignatureError, WebhookValidationError } from "./index.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER_WORLD = "22222222-2222-4222-8222-222222222222";
const NEW_WORLD = "33333333-3333-4333-8333-333333333333";
const KEY: SigningKey = { id: "2026-08", secret: "test-webhook-secret", activeFrom: new Date("2026-01-01T00:00:00Z") };

interface V1V2PostgresOdooContract {
  readonly schema: string;
  readonly candidate: {
    readonly deployment: {
      readonly worldId: string;
      readonly deploymentRevision: number;
      readonly worldDefinition: {
        readonly name: string;
        readonly schedulePeriodWeeks: number;
        readonly epoch: string;
      };
    };
    readonly deploymentHash: string;
    readonly signature: {
      readonly algorithm: "Ed25519";
      readonly keyId: string;
      readonly valueBase64: string;
    };
  };
  readonly odooProjection: OdooProjectionEnvelope;
}

const V1_V2_POSTGRES_ODOO_CONTRACT = JSON.parse(readFileSync(
  new URL("../../../odoo/addons/zugfolge_admin/tests/fixtures/v1_v2_postgres_odoo_contract.json", import.meta.url),
  "utf8",
)) as V1V2PostgresOdooContract;

interface ProjectionEnvelopeUnicodeGolden {
  readonly envelope: OdooProjectionEnvelope;
  readonly canonical: string;
  readonly envelopeSha256: string;
  readonly timestamp: string;
  readonly secret: string;
  readonly hmacSha256: string;
}

const PROJECTION_ENVELOPE_UNICODE_GOLDEN = JSON.parse(readFileSync(
  new URL("../../../odoo/addons/zugfolge_admin/tests/fixtures/projection_envelope_unicode_golden.json", import.meta.url),
  "utf8",
)) as ProjectionEnvelopeUnicodeGolden;

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
      epoch: "2026-08-10T00:00:00.000Z",
    },
    deploymentHash: "d".repeat(64),
    deploymentRevision: 1,
    signedDeployment: {
      deploymentHash: "d".repeat(64),
      deployment: {
        worldId,
        deploymentRevision: 1,
        worldDefinition: {
          name: "Oeffentliche Testwelt",
          kind: "public",
          rankingStatus: "ranked",
          schedulePeriodWeeks: 4,
          epoch: "2026-08-10T00:00:00.000Z",
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
  await db.insert(worlds).values([
    { id: WORLD, name: "Testwelt", schedulePeriodWeeks: 4, epoch: NOW },
    { id: OTHER_WORLD, name: "Andere Welt", schedulePeriodWeeks: 4, epoch: NOW },
  ]);
}, 30_000);
afterEach(async () => client.close());

describe("signierter Odoo-Receiver", () => {
  it("reduziert Entitlement Grant, Revoke, Restore und verspätete Retries je Ursprungsbeleg", async () => {
    const send = async (eventId: string, sourceRevision: number, change: "grant" | "revoke" | "restore", offset: number, sourceReference = "invoice-42", validUntil?: string) => {
      const envelope = entitlementEnvelope(eventId);
      if (envelope.command.kind !== "entitlement.change") throw new Error("fixture");
      const payload = { ...envelope, command: { ...envelope.command, sourceRevision, change, sourceReference, validFrom: new Date(NOW.getTime() + offset).toISOString(), ...(validUntil === undefined ? {} : { validUntil }) } };
      await createOdooWebhookReceiptStore(db).receive(payload, KEY.id, NOW);
      expect(await processNextOdooCommand(db, NOW)).toMatchObject({ outcome: "accepted" });
      return payload;
    };
    const grant = await send("lifecycle-grant-1", 1, "grant", 0);
    await send("lifecycle-other-source", 1, "grant", 0, "invoice-99");
    expect(await activeEntitlementsForSubject(db, "kc-anna", NOW)).toHaveLength(2);
    await send("lifecycle-revoke-2", 2, "revoke", 1_000);
    const restarted = drizzle(client, { schema });
    expect((await activeEntitlementsForSubject(restarted, "kc-anna", new Date(NOW.getTime() + 1_000))).map((entry) => entry.sourceReference)).toEqual(["invoice-99"]);
    expect(await createOdooWebhookReceiptStore(restarted).receive(grant, KEY.id, new Date(NOW.getTime() + 2_000))).toBe(false);
    await send("lifecycle-late-grant-1", 1, "grant", 0);
    expect(await activeEntitlementsForSubject(restarted, "kc-anna", new Date(NOW.getTime() + 2_000))).toHaveLength(1);
    await send("lifecycle-restore-3", 3, "restore", 3_000, "invoice-42", new Date(NOW.getTime() + 4_000).toISOString());
    expect(await activeEntitlementsForSubject(restarted, "kc-anna", new Date(NOW.getTime() + 3_000))).toHaveLength(2);
    expect(await activeEntitlementsForSubject(restarted, "kc-anna", new Date(NOW.getTime() + 4_000))).toHaveLength(1);
    expect(await activeEntitlementsForSubject(restarted, "other-subject", new Date(NOW.getTime() + 4_000))).toHaveLength(0);
    expect(await db.select().from(commerceEntitlements)).toHaveLength(4);
  });

  it("weist widersprüchliche Entitlement-EventIDs und Quellenrevisionen ab", async () => {
    const base = entitlementEnvelope("lifecycle-replay-001");
    if (base.command.kind !== "entitlement.change") throw new Error("fixture");
    const payload = { ...base, command: { ...base.command, sourceRevision: 1 } };
    const store = createOdooWebhookReceiptStore(db);
    await store.receive(payload, KEY.id, NOW);
    await processNextOdooCommand(db, NOW);
    await expect(store.receive({ ...payload, command: { ...payload.command, change: "revoke" } }, KEY.id, NOW)).rejects.toBeInstanceOf(WebhookValidationError);
    await store.receive({ ...payload, eventId: "lifecycle-replay-002", command: { ...payload.command, quantity: 2 } }, KEY.id, NOW);
    expect(await processNextOdooCommand(db, NOW)).toMatchObject({ outcome: "rejected" });
    expect(await db.select().from(commerceEntitlements)).toHaveLength(1);
  });

  it("wertet historische v1-Revoke-Belege aus und laesst abgelaufene Erneuerungen nicht auf alte Grants zurueckfallen", async () => {
    const base = { keycloakSubject: "legacy-subject", productKind: "cosmetic" as const, correlationId: "legacy-correlation", sourceReference: "legacy-invoice" };
    await db.insert(commerceEntitlements).values([
      { ...base, externalEventId: "legacy-grant", status: "active", validFrom: NOW },
      { ...base, externalEventId: "legacy-revoke", status: "revoked", validFrom: new Date(NOW.getTime() + 1_000) },
    ]);
    expect(await activeEntitlementsForSubject(db, "legacy-subject", NOW)).toHaveLength(1);
    expect(await activeEntitlementsForSubject(db, "legacy-subject", new Date(NOW.getTime() + 1_000))).toHaveLength(0);
  });
  it("weist fremde Hauptwelten und Tutorials vor Queue-Commit sowie im Altbestand vor Wirkung ab", async () => {
    const assertWorldScope = (worldId: string) => { if (worldId !== WORLD) throw new Error("foreign_world"); };
    const options = { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "commerce-service": ["admin.world_deploy"] }, assertWorldScope };
    const payload = { ...entitlementEnvelope("scope-rejected-foreign"), command: worldDeployCommand(undefined, OTHER_WORLD) };
    await expect(receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), options, NOW)).rejects.toMatchObject({ code: "world_scope" });
    expect(await db.select().from(odooCommandQueue)).toHaveLength(0);
    await createOdooWebhookReceiptStore(db).receive(payload, KEY.id, NOW);
    let effects = 0;
    expect(await processNextOdooCommand(db, NOW, { assertWorldScope, adminHandlers: { world_deploy: () => { effects += 1; return { state: "completed" }; } } })).toMatchObject({ outcome: "rejected" });
    expect(effects).toBe(0);
    expect(await db.select().from(schema.domainEvents)).toHaveLength(0);
    expect(await db.select().from(odooProjectionOutbox)).toHaveLength(0);
    expect((await db.select().from(odooCommandQueue))[0]).toMatchObject({ status: "rejected", failureCode: "world_scope" });
    const own = { ...entitlementEnvelope("scope-accepted-own"), command: worldDeployCommand(undefined, WORLD) };
    await expect(receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(own, KEY, NOW), options, NOW)).resolves.toMatchObject({ accepted: true });
  });
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

  it("erzeugt Hashwechsel nur aus dem typisierten signierten Weltstart und haelt die Weltbindung", async () => {
    const command = worldDeployCommand();
    await enqueueAuthoritativeWorldStartProjection(db, {
      worldId: WORLD,
      correlationId: "authoritative-world-start-0001",
      signedDeployment: command.signedDeployment!,
      deploymentRevision: command.deploymentRevision!,
      occurredAt: NOW,
      payload: {
        worldName: "Oeffentliche Testwelt",
        projectionRevision: command.deploymentHash,
        profileKind: "public",
        blueprintHash: "b".repeat(64),
        freshness: "live",
      },
    });

    const [row] = await db.select().from(odooProjectionOutbox);
    expect(row).toMatchObject({
      worldId: WORLD,
      messageType: "world.projection",
      payload: {
        projectionKind: "zugfolge-authoritative-world-start-projection/v1",
        authoritative: true,
        deploymentHash: command.deploymentHash,
        deploymentRevision: 1,
        deploymentAuthorization: {
          algorithm: "Ed25519",
          keyId: "alpha-release-2026",
        },
      },
    });

    await expect(enqueueWorldProjection(db, {
      worldId: WORLD,
      correlationId: "forged-world-start-0001",
      payload: { projectionKind: "zugfolge-authoritative-world-start-projection/v1" },
    })).rejects.toThrow(/typisierten Enqueue-Pfad/);
    await expect(enqueueAuthoritativeWorldStartProjection(db, {
      worldId: OTHER_WORLD,
      correlationId: "foreign-world-start-0001",
      signedDeployment: command.signedDeployment!,
      deploymentRevision: 1,
      payload: {},
    })).rejects.toThrow(/Welt-/);
    expect(await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, OTHER_WORLD))).toHaveLength(0);
  });

  it("erzeugt fuer den gemeinsamen V1-V2-Postgres/Odoo-Vertrag exakt den Odoo-Weltstart", async () => {
    const contract = V1_V2_POSTGRES_ODOO_CONTRACT;
    const signed = contract.candidate;
    const expected = contract.odooProjection;
    expect(contract.schema).toBe("zugfolge-v1-v2-postgres-odoo-contract/v1");
    expect(signed.deployment.deploymentRevision).toBe(1);
    expect(expected.worldId).toBe(signed.deployment.worldId);

    await db.insert(worlds).values({
      id: signed.deployment.worldId,
      name: signed.deployment.worldDefinition.name,
      schedulePeriodWeeks: signed.deployment.worldDefinition.schedulePeriodWeeks,
      epoch: new Date(signed.deployment.worldDefinition.epoch),
    });
    const payload = structuredClone(expected.payload) as Record<string, unknown>;
    for (const reserved of ["projectionKind", "deploymentHash", "deploymentRevision", "deploymentAuthorization"]) {
      delete payload[reserved];
    }
    await enqueueAuthoritativeWorldStartProjection(db, {
      worldId: signed.deployment.worldId,
      correlationId: expected.correlationId,
      signedDeployment: signed,
      deploymentRevision: signed.deployment.deploymentRevision,
      occurredAt: new Date(expected.occurredAt),
      payload,
    });

    const [row] = await db.select().from(odooProjectionOutbox).where(
      eq(odooProjectionOutbox.worldId, signed.deployment.worldId),
    );
    expect({ ...projectionEnvelope(row!), messageId: expected.messageId }).toEqual(expected);
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
  it("haelt nur den signierten Weltstart im Admin-Katalog und keinen direkten Tutorial-Reset", () => {
    expect(COMMAND_TYPES).toContain("admin.world_deploy");
    expect(ADMIN_ACTION_TYPES).toContain("world_deploy");
    expect(COMMAND_TYPES).not.toContain("admin.tutorial_account_reset" as never);
    expect(ADMIN_ACTION_TYPES).not.toContain("tutorial_account_reset" as never);
  });

  it("akzeptiert endliches und unbegrenztes Startkapital nur als signierte, weltgebundene Policy", () => {
    expect(() => validateAdminCommand(worldDeployCommand())).not.toThrow();
    expect(() => validateAdminCommand(worldDeployCommand({ mode: "unlimited" }))).not.toThrow();
  });

  it.each([
    "2026-08-09T00:00:00.000Z",
    "2026-08-10T00:00:01.000Z",
  ])("lehnt eine Weltstart-Epoche ausserhalb Montag 00:00 UTC ab: %s", (epoch) => {
    const command = worldDeployCommand() as AdminCommandPayload & {
      signedDeployment: NonNullable<AdminCommandPayload["signedDeployment"]>;
      worldDefinition: NonNullable<AdminCommandPayload["worldDefinition"]>;
    };
    expect(() => validateAdminCommand({
      ...command,
      worldDefinition: { ...command.worldDefinition, epoch },
    })).toThrow(AdminWorkflowError);
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
    expect(await listPendingOdooProjectionWorldIds(db)).toContain(NEW_WORLD);
    const projected: OdooProjectionEnvelope[] = [];
    await expect(dispatchOdooProjectionOutbox(db, NEW_WORLD, {
      project: (message) => {
        projected.push(message);
        return Promise.resolve();
      },
    }, NOW)).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(projected).toEqual([
      expect.objectContaining({
        worldId: NEW_WORLD,
        messageType: "admin.command.result",
        correlationId: "correlation-pre-world-reject",
      }),
    ]);
    expect(await listPendingOdooProjectionWorldIds(db)).not.toContain(NEW_WORLD);
    const [rejected] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    expect(rejected).toMatchObject({
      status: "rejected",
      claimToken: null,
      claimExpiresAt: null,
      failureCode: "GameAdminCapabilityUnavailableError",
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
    expect(pending).toMatchObject({ status: "pending", processedAt: null, claimToken: null, claimExpiresAt: null, failureCode: null });
    expect(approved).toMatchObject({ state: "approved", commandId: pending!.id, gameAuditEventId: null });
    expect(approved?.id).toBe(pending?.id);
    expect(await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, NEW_WORLD))).toHaveLength(0);

    await expect(processNextOdooCommand(db, new Date(NOW.getTime() + 1_000), processing)).resolves.toMatchObject({ outcome: "accepted" });
    expect(requestIds).toEqual([approved!.id, approved!.id]);
    expect(await db.select().from(schema.gameAdminRequests).where(eq(schema.gameAdminRequests.worldId, NEW_WORLD))).toEqual([
      expect.objectContaining({ id: approved!.id, state: "completed", gameAuditEventId: expect.any(String) }),
    ]);
  });

  it("haelt einen Callbackfehler nach bereits aktivierter Welt retrybar und meldet ihn nie als abgelehnt", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-world-deploy-callback-retry"),
      correlationId: "correlation-world-deploy-callback-retry",
      actorReference: "admin-service",
      command: worldDeployCommand({ mode: "finite", amountCents: "0" }, NEW_WORLD),
    };
    await receiveOdooWebhook(
      createOdooWebhookReceiptStore(db),
      signPayload(payload, KEY, NOW),
      { tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.world_deploy"] } },
      NOW,
    );
    let attempts = 0;
    const processing = {
      adminHandlers: {
        world_deploy: async (context: {
          readonly markEffectApplied?: () => void;
        }) => {
          attempts += 1;
          if (attempts === 1) {
            await db.insert(worlds).values({
              id: NEW_WORLD,
              name: "Oeffentliche Testwelt",
              schedulePeriodWeeks: 4,
              epoch: new Date("2026-12-13T00:00:00.000Z"),
              lifecycleStatus: "active",
            });
          }
          context.markEffectApplied?.();
          if (attempts === 1) throw new Error("transienter Runtime-Callbackfehler");
          return { state: "completed" as const, gameAuditEventId: `world-deploy:${NEW_WORLD}` };
        },
      },
    };

    await expect(processNextOdooCommand(db, NOW, processing)).rejects.toThrow(/Runtime-Callbackfehler/);
    const [pending] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    expect(pending).toMatchObject({
      status: "pending",
      processedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      failureCode: null,
    });
    expect(await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.correlationId, payload.correlationId))).toHaveLength(0);
    expect(await db.select().from(schema.globalAdminAuditEvents).where(eq(schema.globalAdminAuditEvents.commandId, pending!.id))).toHaveLength(0);

    await expect(processNextOdooCommand(db, new Date(NOW.getTime() + 1), processing))
      .resolves.toMatchObject({ outcome: "accepted" });
    expect(attempts).toBe(2);
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

  it("meldet einen erfolgreichen Handler bei nachgelagertem Outboxfehler niemals als abgelehnt", async () => {
    const payload: OdooWebhookEnvelope = {
      ...entitlementEnvelope("odoo-event-finalization-retry"), actorReference: "admin-service", correlationId: "correlation-finalization-retry",
      command: { kind: "admin.infra_release_adoption", worldId: WORLD, actionType: "infra_release_adoption", riskClass: "high", requesterReference: "requester", approverReference: "approver", reason: "Finalisierung nach sicherer Wirkung wiederholen", effectPreview: { releaseHash: "9".repeat(64) }, releaseHash: "9".repeat(64), requestedPeriodStart: "2026-12-13T00:00:00.000Z" },
    };
    await receiveOdooWebhook(createOdooWebhookReceiptStore(db), signPayload(payload, KEY, NOW), {
      tenantId: "zugfolge-production", keys: [KEY], authorizedActors: { "admin-service": ["admin.infra_release_adoption"] },
    }, NOW);

    let calls = 0;
    const effectKeys = new Set<string>();
    const handler = (context: { readonly effectIdempotencyKey: string }) => {
      calls += 1;
      effectKeys.add(context.effectIdempotencyKey);
      return calls === 1
        ? { state: "completed" as const, gameAuditEventId: "game-audit-finalization", result: { unsupportedJson: 1n } }
        : { state: "completed" as const, gameAuditEventId: "game-audit-finalization" };
    };

    await expect(processNextOdooCommand(db, NOW, {
      adminHandlers: { infra_release_adoption: handler },
    })).rejects.toThrow();
    const [retryable] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.eventId, payload.eventId));
    expect(retryable).toMatchObject({
      status: "pending",
      processedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      failureCode: null,
    });
    expect(await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.worldId, WORLD))).toHaveLength(0);
    expect(await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.correlationId, payload.correlationId))).toHaveLength(0);

    await expect(processNextOdooCommand(db, new Date(NOW.getTime() + 1), {
      adminHandlers: { infra_release_adoption: handler },
    })).resolves.toMatchObject({ outcome: "accepted" });
    expect(calls).toBe(2);
    expect(effectKeys.size).toBe(1);
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
  it("vergleicht nur die Serverhauptwelt und eigene globale Belege gegen das zentrale Odoo", async () => {
    const globalScope = "00000000-0000-0000-0000-000000000000";
    const base = { messageType: "world.projection", schemaVersion: "zugfolge-odoo/v1", correlationId: "server-scope", payload: {}, occurredAt: NOW, enqueuedAt: NOW, deliveredAt: NOW };
    const [own, foreign, global] = await db.insert(odooProjectionOutbox).values([
      { ...base, worldId: WORLD }, { ...base, worldId: OTHER_WORLD }, { ...base, worldId: globalScope, messageType: "admin.capability.projection", payload: { actionType: "world_deploy", availability: "available" } },
    ]).returning();
    const observation = (worldId: string, messageId: string) => ({ worldId, messageId, correlationId: "server-scope", payloadHash: "a".repeat(64), envelopeHashSchema: ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA, envelopeHash: "b".repeat(64) });
    const result = await reconcileOdooProjectionSnapshot(db, [observation(WORLD, "unknown-local"), observation(OTHER_WORLD, foreign!.id), observation(globalScope, "global-other-server")], NOW, WORLD);
    expect(result.map((task) => task.messageId).sort()).toEqual([own!.id, global!.id, "unknown-local"].sort());
    expect(await db.select().from(schema.odooProjectionQuarantine)).toMatchObject([{ worldId: WORLD, messageId: "unknown-local" }]);
    let requestedScope: unknown;
    await createHttpOdooReconciliationClient("https://odoo.test/snapshot", KEY, async (_url, init) => {
      requestedScope = JSON.parse(init.body).worldId;
      return { ok: true, status: 200, json: async () => [] };
    }).snapshot(WORLD);
    expect(requestedScope).toBe(WORLD);
  });
  it("kanonisiert Unicode fuer Signatur und Voll-Envelope-Hash bytegleich mit Odoo", () => {
    const golden = PROJECTION_ENVELOPE_UNICODE_GOLDEN;
    const { messageId, ...envelopeWithoutMessageId } = golden.envelope;
    expect(canonicalJson(golden.envelope)).toBe(golden.canonical);
    expect(projectionEnvelopeHash({ id: messageId, ...envelopeWithoutMessageId })).toBe(golden.envelopeSha256);
    expect(signPayload(golden.envelope, {
      id: "unicode-golden",
      secret: golden.secret,
      activeFrom: new Date("2026-01-01T00:00:00.000Z"),
    }, new Date(golden.timestamp)).signature).toBe(golden.hmacSha256);
    expect(() => canonicalJson({ fraction: 1e-7 })).toThrow(/sichere Ganzzahlen/u);
    expect(() => canonicalJson({ unsafe: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/sichere Ganzzahlen/u);
  });

  it("verlangt im HTTP-Snapshot die explizite Envelope-Bindung und behaelt Legacy-null sichtbar", async () => {
    const legacyObservation = {
      messageId: "77777777-7777-4777-8777-777777777777",
      worldId: WORLD,
      correlationId: "legacy-reconciliation",
      payloadHash: "a".repeat(64),
      envelopeHashSchema: null,
      envelopeHash: null,
    };
    const legacyClient = createHttpOdooReconciliationClient("https://odoo.test/zugfolge/reconciliation/snapshot", KEY, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: [legacyObservation] }),
    }));
    await expect(legacyClient.snapshot(WORLD)).resolves.toEqual([legacyObservation]);

    const oldClient = createHttpOdooReconciliationClient("https://odoo.test/zugfolge/reconciliation/snapshot", KEY, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: [{
        messageId: legacyObservation.messageId,
        worldId: WORLD,
        correlationId: legacyObservation.correlationId,
        payloadHash: legacyObservation.payloadHash,
      }] }),
    }));
    await expect(oldClient.snapshot(WORLD)).rejects.toThrow(/ungueltiges Schema/u);
  });

  it("persistiert einen fehlenden globalen world_deploy-Beleg ohne erfundene Welt", async () => {
    const globalScope = "00000000-0000-0000-0000-000000000000";
    const [row] = await db.insert(odooProjectionOutbox).values({
      worldId: globalScope,
      messageType: "admin.capability.projection",
      schemaVersion: "zugfolge-odoo/v1",
      correlationId: "startup:global:world_deploy",
      payload: { actionType: "world_deploy", availability: "available" },
      occurredAt: NOW,
      enqueuedAt: NOW,
      deliveredAt: NOW,
    }).returning();

    await expect(reconcileOdooProjectionSnapshot(db, [], NOW)).resolves.toMatchObject([
      { messageId: row!.id, worldId: globalScope, issueKind: "missing" },
    ]);
    await expect(db.select().from(odooReconciliationTasks)).resolves.toContainEqual(
      expect.objectContaining({ messageId: row!.id, worldId: globalScope, issueKind: "missing", status: "open" }),
    );
  });

  it("erstellt fehlende, doppelte und divergente Befunde statt Daten zu überschreiben", async () => {
    const [row] = await db.insert(odooProjectionOutbox).values({ worldId: WORLD, messageType: "world.projection", schemaVersion: "zugfolge-odoo/v1", correlationId: "correlation-reconcile", payload: { version: 1 }, occurredAt: NOW, enqueuedAt: NOW, deliveredAt: NOW }).returning();
    const expected = [{
      id: row!.id,
      schemaVersion: row!.schemaVersion,
      messageType: row!.messageType,
      worldId: WORLD,
      correlationId: "correlation-reconcile",
      occurredAt: row!.occurredAt,
      payload: { version: 1 },
    }];
    expect(deriveReconciliationTasks(expected, [])).toMatchObject([{ issueKind: "missing" }]);
    const expectedEnvelopeHash = projectionEnvelopeHash(expected[0]!);
    expect(deriveReconciliationTasks(expected, [{
      messageId: row!.id,
      worldId: WORLD,
      correlationId: "correlation-reconcile",
      payloadHash: "a".repeat(64),
      envelopeHashSchema: ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA,
      envelopeHash: expectedEnvelopeHash,
    }])).toEqual([]);
    expect(deriveReconciliationTasks(expected, [{
      messageId: row!.id,
      worldId: WORLD,
      correlationId: "correlation-reconcile",
      payloadHash: "a".repeat(64),
      envelopeHashSchema: null,
      envelopeHash: null,
    }])).toMatchObject([{ issueKind: "divergent", expectedHash: expectedEnvelopeHash }]);
    for (const conflicting of [
      { ...expected[0]!, messageType: "public.world.snapshot" },
      { ...expected[0]!, occurredAt: new Date(NOW.getTime() + 1_000) },
    ]) {
      expect(deriveReconciliationTasks(expected, [{
        messageId: row!.id,
        worldId: WORLD,
        correlationId: "correlation-reconcile",
        payloadHash: "a".repeat(64),
        envelopeHashSchema: ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA,
        envelopeHash: projectionEnvelopeHash(conflicting),
      }])).toMatchObject([{ issueKind: "divergent", expectedHash: expectedEnvelopeHash }]);
    }
    const tasks = await reconcileOdooProjectionSnapshot(db, [
      { messageId: row!.id, worldId: WORLD, correlationId: "wrong", payloadHash: "b".repeat(64), envelopeHashSchema: ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA, envelopeHash: "c".repeat(64) },
      { messageId: row!.id, worldId: WORLD, correlationId: "wrong", payloadHash: "b".repeat(64), envelopeHashSchema: ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA, envelopeHash: "c".repeat(64) },
    ], NOW);
    expect(tasks.map((task) => task.issueKind).sort()).toEqual(["divergent", "duplicate"]);
    expect(await db.select().from(odooReconciliationTasks)).toHaveLength(2);
    expect((await db.select().from(odooProjectionOutbox))[0]?.payload).toEqual({ version: 1 });
  });

  it("quarantaenisiert unbekannte Restore-Belege idempotent und trennt verlorene Acks", async () => {
    const [known] = await db.insert(odooProjectionOutbox).values({ worldId: WORLD, messageType: "world.projection", schemaVersion: "zugfolge-odoo/v1", correlationId: "lost-ack", payload: { version: 1 }, occurredAt: NOW, enqueuedAt: NOW }).returning();
    const observed = [{ messageId: known!.id, worldId: WORLD, correlationId: known!.correlationId, payloadHash: "a".repeat(64), envelopeHashSchema: ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA, envelopeHash: projectionEnvelopeHash(known!) },
      { messageId: "unknown-outbox-id", worldId: "restored-away-world", correlationId: "unknown-correlation", payloadHash: "b".repeat(64), envelopeHashSchema: ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA, envelopeHash: "c".repeat(64) }];
    expect(await reconcileOdooProjectionSnapshot(db, observed, NOW)).toMatchObject([{ issueKind: "unknown", messageId: "unknown-outbox-id" }]);
    await reconcileOdooProjectionSnapshot(db, [...observed, observed[1]!], NOW);
    expect(await db.select().from(schema.odooProjectionQuarantine)).toHaveLength(1);
    expect(await db.select().from(odooReconciliationTasks)).toHaveLength(0);
    expect((await db.select().from(odooProjectionOutbox))[0]?.deliveredAt).toBeNull();
    await db.update(odooProjectionOutbox).set({ deliveredAt: new Date(NOW.getTime() + 1_000) }).where(eq(odooProjectionOutbox.id, known!.id));
    expect(await reconcileOdooProjectionSnapshot(db, [], NOW)).toEqual([]);
  });
});
