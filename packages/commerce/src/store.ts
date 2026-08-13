import {
  commerceEntitlements,
  domainEvents,
  gameAdminRequests,
  globalAdminAuditEvents,
  odooCommandQueue,
  odooProjectionOutbox,
  odooWebhookReceipts,
  worlds,
  type CommerceEntitlement,
  type OdooCommandQueueRow,
  type OdooProjectionOutboxRow,
} from "@zugfolge/db";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { entitlementChangeToStatus } from "./entitlements.js";
import {
  ODOO_CONTRACT_VERSION,
  validateWorldParticipationChange,
  type AdminActionType,
  type AdminCommandPayload,
  type EntitlementChangePayload,
  type GameAdminCapabilityProjection,
  type OdooProjectionEnvelope,
  type OdooWebhookEnvelope,
  type WorldParticipationChangePayload,
} from "./contracts.js";
import { validateAdminCommand } from "./admin-workflow.js";
import type { OdooWebhookReceiptStore } from "./receiver.js";
import { validatePublicWorldSnapshot, type PublicWorldSnapshotV1 } from "./public-world-snapshot.js";

/** Gemeinsamer Drizzle-Typ fuer Postgres und PGlite-Integrationstests. */
export type CommerceDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

function commandWorldId(command: OdooWebhookEnvelope["command"]): string | undefined {
  return command.kind === "entitlement.change" ? undefined : command.worldId;
}

function commandIdempotencyKey(command: OdooWebhookEnvelope["command"]): string | undefined {
  return command.kind === "world.participation.change" ? command.idempotencyKey : undefined;
}

/**
 * Schreibt Replay-Beleg und Queue-Eintrag in derselben DB-Transaktion. Ein
 * Neustart nach dem Commit kann daher nur erneut arbeiten, nie erneut wirken.
 */
export function createOdooWebhookReceiptStore(db: CommerceDatabase): OdooWebhookReceiptStore {
  return {
    async receive(envelope, signatureKeyId, receivedAt) {
      return db.transaction(async (tx) => {
        const receipt = await tx
          .insert(odooWebhookReceipts)
          .values({
            eventId: envelope.eventId,
            tenantId: envelope.tenantId,
            receivedAt,
            signatureKeyId,
            correlationId: envelope.correlationId,
          })
          .onConflictDoNothing()
          .returning({ eventId: odooWebhookReceipts.eventId });
        if (receipt.length === 0) return false;
        const worldId = commandWorldId(envelope.command);
        if (envelope.command.kind !== "entitlement.change" && envelope.command.kind !== "admin.world_deploy") {
          const [world] = await tx.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, envelope.command.worldId)).limit(1);
          if (world === undefined) throw new Error(`Administrationsbefehl referenziert die unbekannte Welt '${envelope.command.worldId}'.`);
        }
        const queued = await tx.insert(odooCommandQueue).values({
          eventId: envelope.eventId,
          worldId,
          commandType: envelope.command.kind,
          idempotencyKey: commandIdempotencyKey(envelope.command),
          actorReference: envelope.actorReference,
          payload: envelope.command,
          correlationId: envelope.correlationId,
          status: "pending",
          receivedAt,
        }).onConflictDoNothing().returning({ id: odooCommandQueue.id });
        // Auch ein zweites Event mit neuem eventId, aber identischem
        // fachlichem Idempotency-Key wird als Duplikat quittiert.
        return queued.length === 1;
      });
    },
  };
}

/**
 * Ein fachlicher Game-Handler veroeffentlicht seine Faehigkeit erst nach
 * erfolgreicher eigener Initialisierung. Die Outbox macht den Odoo-Status
 * nachvollziehbar und bleibt ausserhalb von Simulation und Login.
 */
export async function enqueueGameAdminCapabilityProjection(
  db: CommerceDatabase,
  input: {
    readonly worldId: string;
    readonly correlationId: string;
    readonly capability: GameAdminCapabilityProjection;
    readonly occurredAt?: Date;
  },
): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date();
  await db.insert(odooProjectionOutbox).values({
    worldId: input.worldId,
    messageType: "admin.capability.projection",
    schemaVersion: "zugfolge-odoo/v1",
    correlationId: input.correlationId,
    payload: input.capability,
    occurredAt,
    enqueuedAt: occurredAt,
  });
}

/** Read-only Welt-/Simulationsprojektion fuer das Odoo-Kontrollzentrum. */
export async function enqueueWorldProjection(
  db: CommerceDatabase,
  input: {
    readonly worldId: string;
    readonly correlationId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly occurredAt?: Date;
  },
): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date();
  await db.insert(odooProjectionOutbox).values({
    worldId: input.worldId,
    messageType: "world.projection",
    schemaVersion: "zugfolge-odoo/v1",
    correlationId: input.correlationId,
    payload: input.payload,
    occurredAt,
    enqueuedAt: occurredAt,
  });
}

/** Aggregierter, personenfreier Website-Cache; kein Besucherzugriff trifft das Game. */
export async function enqueuePublicWorldSnapshot(
  db: CommerceDatabase,
  input: {
    readonly snapshot: PublicWorldSnapshotV1;
    readonly correlationId: string;
    readonly occurredAt?: Date;
  },
): Promise<void> {
  validatePublicWorldSnapshot(input.snapshot);
  const occurredAt = input.occurredAt ?? new Date(input.snapshot.generatedAt);
  await db.insert(odooProjectionOutbox).values({
    worldId: input.snapshot.worldId,
    messageType: "public.world.snapshot",
    schemaVersion: ODOO_CONTRACT_VERSION,
    correlationId: input.correlationId,
    payload: input.snapshot,
    occurredAt,
    enqueuedAt: occurredAt,
  });
}

/**
 * Schreibt ausschliesslich das bereits pseudonymisierte Spielerfeedback in die
 * Odoo-Outbox. Der Aufrufer reicht seine laufende Fachtransaktion ein, damit
 * Feedback und Projektion nicht auseinanderfallen koennen.
 */
export async function enqueueAlphaFeedbackProjection(
  db: CommerceDatabase,
  input: {
    readonly worldId: string;
    readonly correlationId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await db.insert(odooProjectionOutbox).values({
    worldId: input.worldId,
    messageType: "alpha.feedback.projection",
    schemaVersion: ODOO_CONTRACT_VERSION,
    correlationId: input.correlationId,
    payload: input.payload,
    occurredAt: input.occurredAt,
    enqueuedAt: input.occurredAt,
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Persistierter Odoo-Befehl besitzt keine Objekt-Nutzdaten.");
  return value as Readonly<Record<string, unknown>>;
}

function asEntitlementPayload(value: unknown): EntitlementChangePayload {
  const payload = asRecord(value);
  if (payload["kind"] !== "entitlement.change" || typeof payload["subject"] !== "string" || typeof payload["productKind"] !== "string" || typeof payload["change"] !== "string" || typeof payload["validFrom"] !== "string" || typeof payload["quantity"] !== "number" || typeof payload["sourceReference"] !== "string") {
    throw new Error("Persistierter Entitlement-Befehl ist ungueltig.");
  }
  return payload as unknown as EntitlementChangePayload;
}

function asAdminPayload(value: unknown): AdminCommandPayload {
  const payload = asRecord(value);
  if (typeof payload["worldId"] !== "string" || typeof payload["actionType"] !== "string" || typeof payload["riskClass"] !== "string" || typeof payload["requesterReference"] !== "string" || typeof payload["reason"] !== "string") {
    throw new Error("Persistierter Administrationsbefehl ist ungueltig.");
  }
  return payload as unknown as AdminCommandPayload;
}

function asWorldParticipationPayload(value: unknown): WorldParticipationChangePayload {
  const payload = asRecord(value) as unknown as WorldParticipationChangePayload;
  validateWorldParticipationChange(payload);
  return payload;
}

export interface ProcessedOdooCommand {
  readonly id: string;
  readonly outcome: "accepted" | "rejected";
  readonly code?: string;
}

/** Das Game aktiviert eine Verwaltungsfaehigkeit erst mit einem echten fachlichen Handler. */
export class GameAdminCapabilityUnavailableError extends Error {
  constructor(readonly actionType: AdminActionType) {
    super(`Die Game-Verwaltungsfaehigkeit '${actionType}' ist noch nicht verfuegbar.`);
    this.name = "GameAdminCapabilityUnavailableError";
  }
}

/**
 * Anschluss an den jeweiligen fachlichen Single Writer. Der Odoo-Worker
 * validiert den Antrag erneut, darf die Wirkung aber nie selbst erzeugen.
 */
export interface GameAdminCommandContext {
  readonly adminRequestId: string;
  readonly commandId: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly receivedAt: Date;
  readonly now: Date;
  readonly payload: AdminCommandPayload;
}

export interface GameAdminCommandResult {
  readonly state?: "accepted" | "completed";
  readonly gameAuditEventId?: string;
  readonly result?: Readonly<Record<string, unknown>>;
}

export type GameAdminCommandHandler = (context: GameAdminCommandContext) => Promise<GameAdminCommandResult> | GameAdminCommandResult;

export interface WorldParticipationCommandContext {
  readonly commandId: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly receivedAt: Date;
  readonly now: Date;
  readonly payload: WorldParticipationChangePayload;
}

export interface WorldParticipationCommandResult {
  readonly state: "active" | "rejected" | "cancelled" | "refunded";
  readonly participationId?: string;
  readonly gameAccountReference?: string;
  readonly rejectionCode?: string;
}

export type WorldParticipationCommandHandler = (
  context: WorldParticipationCommandContext,
) => Promise<WorldParticipationCommandResult> | WorldParticipationCommandResult;

export interface OdooCommandProcessingOptions {
  /** Keine Standard-Handler: ein noch nicht implementierter Milestone bleibt vorbereitet, aber wirkungslos. */
  readonly adminHandlers?: Readonly<Partial<Record<AdminActionType, GameAdminCommandHandler>>>;
  readonly participationHandler?: WorldParticipationCommandHandler;
}

/**
 * Der Game-Worker persistiert jeden Antrag vor seiner Wirkung, laesst allein
 * den registrierten fachlichen Handler entscheiden und verknuepft Erfolg wie
 * Ablehnung unveraenderlich mit dem autoritativen Game-Eventlog.
 */
export async function processNextOdooCommand(
  db: CommerceDatabase,
  now = new Date(),
  options: OdooCommandProcessingOptions = {},
): Promise<ProcessedOdooCommand | undefined> {
  const [command] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.status, "pending")).orderBy(odooCommandQueue.receivedAt).limit(1);
  if (command === undefined) return undefined;
  let adminRequestId: string | undefined;
  let adminRequestPersisted = false;
  let adminPayload: AdminCommandPayload | undefined;
  let handlerCompleted = false;
  try {
    if (command.commandType === "entitlement.change") {
      const payload = asEntitlementPayload(command.payload);
      const status = entitlementChangeToStatus(payload.change);
      const validUntil = payload.validUntil === undefined ? undefined : new Date(payload.validUntil);
      await db.insert(commerceEntitlements).values({
        externalEventId: command.eventId,
        keycloakSubject: payload.subject,
        productKind: payload.productKind,
        status,
        validFrom: new Date(payload.validFrom),
        validUntil,
        quantity: String(payload.quantity),
        correlationId: command.correlationId,
        sourceReference: payload.sourceReference,
        metadata: {},
        changedAt: now,
      }).onConflictDoNothing();
      await db.update(odooCommandQueue).set({ status: "completed", processedAt: now }).where(and(eq(odooCommandQueue.id, command.id), eq(odooCommandQueue.status, "pending")));
      return { id: command.id, outcome: "accepted" };
    }

    if (command.commandType === "world.participation.change") {
      const payload = asWorldParticipationPayload(command.payload);
      if (command.worldId === null || command.worldId !== payload.worldId) {
        throw new Error("Weltteilnahmebefehl besitzt keine passende Welt.");
      }
      if (options.participationHandler === undefined) throw new Error("Weltteilnahme-Handler ist nicht verfuegbar.");
      const result = await options.participationHandler({
        commandId: command.id,
        eventId: command.eventId,
        correlationId: command.correlationId,
        receivedAt: command.receivedAt,
        now,
        payload,
      });
      const outcome = result.state === "rejected" ? "rejected" : "accepted";
      await db.transaction(async (tx) => {
        await tx.update(odooCommandQueue).set({
          status: result.state === "rejected" ? "rejected" : "completed",
          processedAt: now,
          failureCode: result.rejectionCode ?? null,
        }).where(and(eq(odooCommandQueue.id, command.id), eq(odooCommandQueue.status, "pending")));
        await tx.insert(odooProjectionOutbox).values({
          worldId: payload.worldId,
          messageType: "world.participation.result",
          schemaVersion: ODOO_CONTRACT_VERSION,
          correlationId: command.correlationId,
          payload: {
            schemaVersion: payload.schemaVersion,
            eventId: command.eventId,
            idempotencyKey: payload.idempotencyKey,
            action: payload.action,
            worldId: payload.worldId,
            state: result.state,
            authoritative: true,
            participationId: result.participationId,
            gameAccountReference: result.gameAccountReference,
            rejectionCode: result.rejectionCode,
          },
          occurredAt: now,
          enqueuedAt: now,
        });
      });
      return { id: command.id, outcome, code: result.rejectionCode };
    }

    const payload = asAdminPayload(command.payload);
    if (command.worldId === null || command.worldId !== payload.worldId) throw new Error("Administrationsbefehl besitzt keine passende Welt.");
    validateAdminCommand(payload);
    adminPayload = payload;
    const handler = options.adminHandlers?.[payload.actionType];
    const [existingAdminRequest] = await db.select({
      id: gameAdminRequests.id,
      actionType: gameAdminRequests.actionType,
      correlationId: gameAdminRequests.correlationId,
    }).from(gameAdminRequests).where(and(
      eq(gameAdminRequests.worldId, command.worldId),
      eq(gameAdminRequests.commandId, command.id),
    )).limit(1);
    if (existingAdminRequest !== undefined) {
      if (existingAdminRequest.actionType !== payload.actionType || existingAdminRequest.correlationId !== command.correlationId) {
        throw new Error("Persistierter Game-Administrationsantrag widerspricht dem Queue-Kommando.");
      }
      adminRequestId = existingAdminRequest.id;
      adminRequestPersisted = true;
    }
    // world_deploy ist die einzige Aktion, deren FK-gebundener Antrag erst
    // nach der signaturgeprueften Welterzeugung persistiert werden kann. Die
    // vorab erzeugte ID bleibt dabei der stabile Korrelationsbeleg des Handlers.
    if (payload.actionType === "world_deploy") {
      if (handler === undefined) throw new GameAdminCapabilityUnavailableError(payload.actionType);
      adminRequestId ??= randomUUID();
    } else {
      if (!adminRequestPersisted) {
        const [adminRequest] = await db.insert(gameAdminRequests).values({
          worldId: command.worldId,
          commandId: command.id,
          actionType: payload.actionType,
          riskClass: payload.riskClass,
          requesterReference: payload.requesterReference,
          approverReference: payload.approverReference,
          reason: payload.reason,
          effectPreview: payload.effectPreview,
          state: "approved",
          correlationId: command.correlationId,
          changedAt: now,
        }).returning({ id: gameAdminRequests.id });
        if (adminRequest === undefined) throw new Error("Game-Administrationsantrag konnte nicht persistiert werden.");
        adminRequestId = adminRequest.id;
        adminRequestPersisted = true;
      }
      if (handler === undefined) throw new GameAdminCapabilityUnavailableError(payload.actionType);
    }
    const gameResult = await handler!({
      adminRequestId: adminRequestId!,
      commandId: command.id,
      eventId: command.eventId,
      correlationId: command.correlationId,
      receivedAt: command.receivedAt,
      now,
      payload,
    });
    handlerCompleted = true;
    if (!adminRequestPersisted) {
      const [adminRequest] = await db.insert(gameAdminRequests).values({
        id: adminRequestId!,
        worldId: command.worldId,
        commandId: command.id,
        actionType: payload.actionType,
        riskClass: payload.riskClass,
        requesterReference: payload.requesterReference,
        approverReference: payload.approverReference,
        reason: payload.reason,
        effectPreview: payload.effectPreview,
        state: "approved",
        correlationId: command.correlationId,
        changedAt: now,
      }).returning({ id: gameAdminRequests.id });
      if (adminRequest === undefined) throw new Error("Game-Administrationsantrag konnte nach Welterzeugung nicht persistiert werden.");
      adminRequestPersisted = true;
    }
    const state = gameResult.state ?? "accepted";
    const effectAuditReference = gameResult.gameAuditEventId ?? null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${command.worldId!} for update`);
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, command.worldId!)).orderBy(desc(domainEvents.sequence)).limit(1);
      const [auditEvent] = await tx.insert(domainEvents).values({
        worldId: command.worldId!,
        sequence: (head?.sequence ?? 0) + 1,
        eventType: "admin.action-audited",
        payload: { adminRequestId, actionType: payload.actionType, riskClass: payload.riskClass, correlationId: command.correlationId, outcome: state, effectAuditReference },
        occurredAt: now,
      }).returning({ id: domainEvents.id });
      if (auditEvent === undefined) throw new Error("Autoritativer Game-Auditbeleg fehlt.");
      await tx.update(gameAdminRequests).set({
        state,
        gameAuditEventId: auditEvent.id,
        changedAt: now,
      }).where(and(eq(gameAdminRequests.id, adminRequestId!), eq(gameAdminRequests.worldId, command.worldId!)));
      await tx.update(odooCommandQueue).set({ status: state === "completed" ? "completed" : "accepted", processedAt: now }).where(and(eq(odooCommandQueue.id, command.id), eq(odooCommandQueue.status, "pending")));
      await tx.insert(odooProjectionOutbox).values({
        worldId: command.worldId!,
        messageType: "admin.command.result",
        schemaVersion: "zugfolge-odoo/v1",
        correlationId: command.correlationId,
        payload: { eventId: command.eventId, outcome: "accepted", state, authoritative: true, gameAuditEventId: auditEvent.id, effectAuditReference, ...gameResult.result },
        occurredAt: now,
        enqueuedAt: now,
      });
    });
    return { id: command.id, outcome: "accepted" };
  } catch (error) {
    // Eine bereits vollzogene Fachwirkung darf bei einem nachgelagerten
    // Audit-/Outboxfehler niemals als abgelehnt gemeldet werden. Pending bleibt
    // retrybar; der fachliche Handler muss idempotent sein.
    if (handlerCompleted) throw error;
    if (adminPayload?.actionType === "world_deploy" && command.worldId !== null && adminRequestId !== undefined) {
      const [partialWorld] = await db.select({ lifecycleStatus: worlds.lifecycleStatus })
        .from(worlds)
        .where(eq(worlds.id, command.worldId))
        .limit(1);
      if (partialWorld?.lifecycleStatus === "provisioning") {
        // Nach der signaturgeprueften Welterzeugung sind Fehler in Economy,
        // Fleet, Regionalstart oder Endverifikation retrybar. Der stabile
        // Antrag wird festgehalten; Queue und Odoo-Ergebnis bleiben pending.
        await db.insert(gameAdminRequests).values({
          id: adminRequestId,
          worldId: command.worldId,
          commandId: command.id,
          actionType: adminPayload.actionType,
          riskClass: adminPayload.riskClass,
          requesterReference: adminPayload.requesterReference,
          approverReference: adminPayload.approverReference,
          reason: adminPayload.reason,
          effectPreview: adminPayload.effectPreview,
          state: "approved",
          correlationId: command.correlationId,
          changedAt: now,
        }).onConflictDoNothing();
        throw error;
      }
    }
    const code = error instanceof Error ? error.name : "unknown_error";
    if (command.commandType === "world.participation.change" && command.worldId !== null) {
      const payload = asWorldParticipationPayload(command.payload);
      await db.transaction(async (tx) => {
        await tx.update(odooCommandQueue).set({ status: "rejected", processedAt: now, failureCode: code })
          .where(and(eq(odooCommandQueue.id, command.id), eq(odooCommandQueue.status, "pending")));
        await tx.insert(odooProjectionOutbox).values({
          worldId: command.worldId!,
          messageType: "world.participation.result",
          schemaVersion: ODOO_CONTRACT_VERSION,
          correlationId: command.correlationId,
          payload: { schemaVersion: payload.schemaVersion, eventId: command.eventId, idempotencyKey: payload.idempotencyKey, action: payload.action, worldId: payload.worldId, state: "rejected", authoritative: true, rejectionCode: code },
          occurredAt: now,
          enqueuedAt: now,
        });
      });
      return { id: command.id, outcome: "rejected", code };
    }
    await db.transaction(async (tx) => {
      const existingWorld = command.worldId === null
        ? undefined
        : (await tx.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, command.worldId)).limit(1))[0];
      if (
        !adminRequestPersisted
        && adminRequestId !== undefined
        && adminPayload?.actionType === "world_deploy"
        && existingWorld !== undefined
      ) {
        await tx.insert(gameAdminRequests).values({
          id: adminRequestId,
          worldId: existingWorld.id,
          commandId: command.id,
          actionType: adminPayload.actionType,
          riskClass: adminPayload.riskClass,
          requesterReference: adminPayload.requesterReference,
          approverReference: adminPayload.approverReference,
          reason: adminPayload.reason,
          effectPreview: adminPayload.effectPreview,
          state: "failed",
          correlationId: command.correlationId,
          changedAt: now,
        }).onConflictDoNothing();
        adminRequestPersisted = true;
      }
      if (adminRequestPersisted && adminRequestId !== undefined && command.worldId !== null && existingWorld !== undefined) {
        await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${command.worldId} for update`);
        const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, command.worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
        const [auditEvent] = await tx.insert(domainEvents).values({
          worldId: command.worldId,
          sequence: (head?.sequence ?? 0) + 1,
          eventType: "admin.action-audited",
          payload: {
            adminRequestId,
            actionType: asAdminPayload(command.payload).actionType,
            correlationId: command.correlationId,
            outcome: "failed",
            failureCode: code,
          },
          occurredAt: now,
        }).returning({ id: domainEvents.id });
        if (auditEvent === undefined) throw new Error("Autoritativer Game-Auditbeleg fuer die Ablehnung fehlt.");
        await tx.update(gameAdminRequests).set({ state: "failed", gameAuditEventId: auditEvent.id, changedAt: now }).where(and(eq(gameAdminRequests.id, adminRequestId), eq(gameAdminRequests.worldId, command.worldId)));
      }
      let globalAuditEventId: string | undefined;
      if (
        command.commandType === "admin.world_deploy"
        && command.worldId !== null
        && existingWorld === undefined
      ) {
        const [auditEvent] = await tx.insert(globalAdminAuditEvents).values({
          targetWorldId: command.worldId,
          commandId: command.id,
          correlationId: command.correlationId,
          actionType: "world_deploy",
          outcome: "rejected",
          failureCode: code,
          occurredAt: now,
        }).onConflictDoNothing({ target: globalAdminAuditEvents.commandId }).returning({ id: globalAdminAuditEvents.id });
        globalAuditEventId = auditEvent?.id ?? (await tx.select({ id: globalAdminAuditEvents.id })
          .from(globalAdminAuditEvents)
          .where(eq(globalAdminAuditEvents.commandId, command.id))
          .limit(1))[0]?.id;
        if (globalAuditEventId === undefined) throw new Error("Globaler Game-Auditbeleg fuer die pre-world Ablehnung fehlt.");
      }
      await tx.update(odooCommandQueue).set({ status: "rejected", processedAt: now, failureCode: code }).where(and(eq(odooCommandQueue.id, command.id), eq(odooCommandQueue.status, "pending")));
      if (command.commandType !== "entitlement.change" && command.worldId !== null) {
        await tx.insert(odooProjectionOutbox).values({
          worldId: command.worldId,
          messageType: "admin.command.result",
          schemaVersion: "zugfolge-odoo/v1",
          correlationId: command.correlationId,
          payload: {
            eventId: command.eventId,
            outcome: "rejected",
            authoritative: true,
            failureCode: code,
            ...(globalAuditEventId === undefined ? {} : {
              auditScope: "global",
              gameAuditEventId: `global-admin-audit:${globalAuditEventId}`,
            }),
            ...(adminRequestPersisted && adminRequestId !== undefined ? { adminRequestId } : {}),
          },
          occurredAt: now,
          enqueuedAt: now,
        });
      }
    });
    return { id: command.id, outcome: "rejected", code };
  }
}

export async function activeEntitlementsForSubject(db: CommerceDatabase, subject: string, at = new Date()): Promise<readonly CommerceEntitlement[]> {
  return db.select().from(commerceEntitlements).where(and(eq(commerceEntitlements.keycloakSubject, subject), eq(commerceEntitlements.status, "active"), lt(commerceEntitlements.validFrom, at)));
}

export async function listPendingOdooProjections(db: CommerceDatabase, limit = 50): Promise<readonly OdooProjectionOutboxRow[]> {
  return db.select().from(odooProjectionOutbox).where(isNull(odooProjectionOutbox.deliveredAt)).orderBy(odooProjectionOutbox.enqueuedAt).limit(limit);
}

export async function markOdooProjectionDelivered(db: CommerceDatabase, id: string, deliveredAt: Date): Promise<void> {
  await db.update(odooProjectionOutbox).set({ deliveredAt, lastErrorCode: null }).where(and(eq(odooProjectionOutbox.id, id), isNull(odooProjectionOutbox.deliveredAt)));
}

export async function recordOdooProjectionFailure(db: CommerceDatabase, id: string, code: string): Promise<void> {
  const [row] = await db.select({ attempts: odooProjectionOutbox.attempts }).from(odooProjectionOutbox).where(eq(odooProjectionOutbox.id, id)).limit(1);
  if (row === undefined) return;
  await db.update(odooProjectionOutbox).set({ attempts: String(Number(row.attempts) + 1), lastErrorCode: code }).where(and(eq(odooProjectionOutbox.id, id), isNull(odooProjectionOutbox.deliveredAt)));
}

export function projectionEnvelope(row: OdooProjectionOutboxRow): OdooProjectionEnvelope {
  return {
    schemaVersion: "zugfolge-odoo/v1",
    messageId: row.id,
    messageType: row.messageType as OdooProjectionEnvelope["messageType"],
    worldId: row.worldId,
    occurredAt: row.occurredAt.toISOString(),
    correlationId: row.correlationId,
    payload: row.payload as Readonly<Record<string, unknown>>,
  };
}

export type { OdooCommandQueueRow };
