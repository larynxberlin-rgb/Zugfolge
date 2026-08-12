import {
  commerceEntitlements,
  domainEvents,
  gameAdminRequests,
  odooCommandQueue,
  odooProjectionOutbox,
  odooWebhookReceipts,
  worlds,
  type CommerceEntitlement,
  type OdooCommandQueueRow,
  type OdooProjectionOutboxRow,
} from "@zugfolge/db";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { entitlementChangeToStatus } from "./entitlements.js";
import type { AdminActionType, AdminCommandPayload, EntitlementChangePayload, GameAdminCapabilityProjection, OdooProjectionEnvelope, OdooWebhookEnvelope } from "./contracts.js";
import { validateAdminCommand } from "./admin-workflow.js";
import type { OdooWebhookReceiptStore } from "./receiver.js";

/** Gemeinsamer Drizzle-Typ fuer Postgres und PGlite-Integrationstests. */
export type CommerceDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

function commandWorldId(command: OdooWebhookEnvelope["command"]): string | undefined {
  return command.kind === "entitlement.change" ? undefined : command.worldId;
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
        await tx.insert(odooCommandQueue).values({
          eventId: envelope.eventId,
          worldId: commandWorldId(envelope.command),
          commandType: envelope.command.kind,
          actorReference: envelope.actorReference,
          payload: envelope.command,
          correlationId: envelope.correlationId,
          status: "pending",
          receivedAt,
        });
        return true;
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

export interface OdooCommandProcessingOptions {
  /** Keine Standard-Handler: ein noch nicht implementierter Milestone bleibt vorbereitet, aber wirkungslos. */
  readonly adminHandlers?: Readonly<Partial<Record<AdminActionType, GameAdminCommandHandler>>>;
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

    const payload = asAdminPayload(command.payload);
    if (command.worldId === undefined || command.worldId !== payload.worldId) throw new Error("Administrationsbefehl besitzt keine passende Welt.");
    validateAdminCommand(payload);
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
    const handler = options.adminHandlers?.[payload.actionType];
    if (handler === undefined) throw new GameAdminCapabilityUnavailableError(payload.actionType);
    const gameResult = await handler({
      adminRequestId,
      commandId: command.id,
      eventId: command.eventId,
      correlationId: command.correlationId,
      receivedAt: command.receivedAt,
      now,
      payload,
    });
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
    const code = error instanceof Error ? error.name : "unknown_error";
    await db.transaction(async (tx) => {
      if (adminRequestId !== undefined && command.worldId !== null) {
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
      await tx.update(odooCommandQueue).set({ status: "rejected", processedAt: now, failureCode: code }).where(and(eq(odooCommandQueue.id, command.id), eq(odooCommandQueue.status, "pending")));
      if (command.commandType !== "entitlement.change" && command.worldId !== null) {
        await tx.insert(odooProjectionOutbox).values({
          worldId: command.worldId,
          messageType: "admin.command.result",
          schemaVersion: "zugfolge-odoo/v1",
          correlationId: command.correlationId,
          payload: { eventId: command.eventId, outcome: "rejected", authoritative: true, failureCode: code, adminRequestId },
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
