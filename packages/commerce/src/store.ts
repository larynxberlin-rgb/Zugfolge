import {
  commerceEntitlements,
  gameAdminRequests,
  odooCommandQueue,
  odooProjectionOutbox,
  odooWebhookReceipts,
  type CommerceEntitlement,
  type OdooCommandQueueRow,
  type OdooProjectionOutboxRow,
} from "@zugfolge/db";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { entitlementChangeToStatus } from "./entitlements.js";
import type { AdminCommandPayload, EntitlementChangePayload, OdooProjectionEnvelope, OdooWebhookEnvelope } from "./contracts.js";
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

/**
 * Der Game-Worker materialisiert nur zugelassene Commerce-Zustaende und
 * Antraege. Eine Simulation, Trassen- oder Release-Aktivierung findet hier
 * bewusst nicht statt; ein spaeterer fachlicher Single Writer entscheidet
 * getrennt ueber einen angenommenen Antrag.
 */
export async function processNextOdooCommand(db: CommerceDatabase, now = new Date()): Promise<ProcessedOdooCommand | undefined> {
  const [command] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.status, "pending")).orderBy(odooCommandQueue.receivedAt).limit(1);
  if (command === undefined) return undefined;
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
    const [auditRequest] = await db.insert(gameAdminRequests).values({
      worldId: command.worldId,
      commandId: command.id,
      actionType: payload.actionType,
      riskClass: payload.riskClass,
      requesterReference: payload.requesterReference,
      approverReference: payload.approverReference,
      reason: payload.reason,
      effectPreview: payload.effectPreview,
      state: "accepted",
      correlationId: command.correlationId,
      gameAuditEventId: `game-admin-request:${command.id}`,
      changedAt: now,
    }).returning({ gameAuditEventId: gameAdminRequests.gameAuditEventId });
    await db.update(odooCommandQueue).set({ status: "accepted", processedAt: now }).where(and(eq(odooCommandQueue.id, command.id), eq(odooCommandQueue.status, "pending")));
    await db.insert(odooProjectionOutbox).values({
      worldId: command.worldId,
      messageType: "admin.command.result",
      schemaVersion: "zugfolge-odoo/v1",
      correlationId: command.correlationId,
      payload: { eventId: command.eventId, outcome: "accepted", authoritative: true, gameAuditEventId: auditRequest?.gameAuditEventId },
      occurredAt: now,
      enqueuedAt: now,
    });
    return { id: command.id, outcome: "accepted" };
  } catch (error) {
    const code = error instanceof Error ? error.name : "unknown_error";
    await db.update(odooCommandQueue).set({ status: "rejected", processedAt: now, failureCode: code }).where(and(eq(odooCommandQueue.id, command.id), eq(odooCommandQueue.status, "pending")));
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
