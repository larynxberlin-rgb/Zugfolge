import { randomUUID } from "node:crypto";

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
import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { entitlementChangeToStatus } from "./entitlements.js";
import { ODOO_CONTRACT_VERSION, type AdminActionType, type AdminCommandPayload, type EntitlementChangePayload, type GameAdminCapabilityProjection, type OdooProjectionEnvelope, type OdooWebhookEnvelope } from "./contracts.js";
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

/** Der Worker darf nach Ablauf oder Uebernahme seines Claims nichts mehr quittieren. */
export class OdooCommandClaimLostError extends Error {
  constructor(readonly commandId: string) {
    super(`Der Odoo-Worker-Claim fuer Kommando '${commandId}' ist nicht mehr gueltig.`);
    this.name = "OdooCommandClaimLostError";
  }
}

/**
 * Geplanter oder simulierter Prozessabbruch nach moeglicher Fachwirkung. Der
 * Claim bleibt absichtlich `processing`; erst Lease-Ablauf erlaubt einen Retry
 * mit demselben stabilen Wirkungs-Idempotenzschluessel.
 */
export class OdooCommandWorkerInterruptedError extends Error {
  constructor(readonly commandId: string) {
    super(`Odoo-Worker wurde waehrend Kommando '${commandId}' unterbrochen.`);
    this.name = "OdooCommandWorkerInterruptedError";
  }
}

/**
 * Anschluss an den jeweiligen fachlichen Single Writer. Der Odoo-Worker
 * validiert den Antrag erneut, darf die Wirkung aber nie selbst erzeugen.
 */
export interface GameAdminCommandContext {
  readonly adminRequestId: string;
  /** Stabil ueber Claim-Uebernahme und Prozessneustart; jeder fachliche Writer muss ihn als Wirkungsschluessel verwenden. */
  readonly effectIdempotencyKey: string;
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
  /** Begrenzte Wiederanlaufzeit nach einem Prozessabbruch. */
  readonly claimLeaseMs?: number;
  /** Erneuerungsintervall waehrend eines externen Game-Handlers; muss kuerzer als der Lease sein. */
  readonly claimHeartbeatMs?: number;
  /** Injizierbare Betriebsuhr fuer reproduzierbare Claim-/Heartbeat-Tests. */
  readonly claimClock?: () => Date;
}

const DEFAULT_COMMAND_CLAIM_LEASE_MS = 5 * 60_000;

function claimScope(command: Pick<OdooCommandQueueRow, "id" | "worldId">, claimToken: string) {
  return and(
    eq(odooCommandQueue.id, command.id),
    command.worldId === null ? isNull(odooCommandQueue.worldId) : eq(odooCommandQueue.worldId, command.worldId),
    eq(odooCommandQueue.status, "processing"),
    eq(odooCommandQueue.claimToken, claimToken),
  );
}

async function runWithClaimHeartbeat<T>(
  db: CommerceDatabase,
  command: Pick<OdooCommandQueueRow, "id" | "worldId">,
  claimToken: string,
  claimLeaseMs: number,
  claimHeartbeatMs: number,
  claimClock: () => Date,
  operation: () => Promise<T> | T,
): Promise<T> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> = Promise.resolve();
  let heartbeatError: OdooCommandClaimLostError | undefined;

  const renew = async (): Promise<void> => {
    let heartbeatAt: Date;
    try {
      heartbeatAt = claimClock();
      if (!(heartbeatAt instanceof Date) || !Number.isFinite(heartbeatAt.getTime())) {
        throw new TypeError("Claim-Uhr lieferte keinen gueltigen Zeitpunkt.");
      }
      const renewed = await db.update(odooCommandQueue).set({
        claimExpiresAt: new Date(heartbeatAt.getTime() + claimLeaseMs),
      }).where(claimScope(command, claimToken)).returning({ id: odooCommandQueue.id });
      if (renewed.length !== 1) throw new OdooCommandClaimLostError(command.id);
    } catch (error) {
      heartbeatError = error instanceof OdooCommandClaimLostError
        ? error
        : new OdooCommandClaimLostError(command.id);
    }
  };

  const schedule = (): void => {
    if (stopped || heartbeatError !== undefined) return;
    timer = setTimeout(() => {
      renewal = renew().then(schedule);
    }, claimHeartbeatMs);
  };

  // Direkt vor der externen Wirkung verlaengern: selbst lange Vorpruefungen
  // verkleinern dadurch nicht das Zeitfenster des fachlichen Handlers.
  await renew();
  if (heartbeatError !== undefined) throw heartbeatError;
  schedule();

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await renewal;
    // Der Handler ist fertig, seine Quittierung aber noch nicht. Ein letzter
    // voller Lease verhindert eine Uebernahme zwischen externer Wirkung und
    // der unmittelbar folgenden atomaren Finalisierung.
    if (heartbeatError === undefined) await renew();
  }

  if (heartbeatError !== undefined) throw heartbeatError;
  if (operationError !== undefined) throw operationError;
  return result as T;
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
  const claimLeaseMs = options.claimLeaseMs ?? DEFAULT_COMMAND_CLAIM_LEASE_MS;
  if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 1_000 || claimLeaseMs > 60 * 60_000) {
    throw new RangeError("Odoo-Worker-Claim-Dauer ist ungueltig.");
  }
  const claimHeartbeatMs = options.claimHeartbeatMs ?? Math.max(250, Math.floor(claimLeaseMs / 3));
  if (!Number.isSafeInteger(claimHeartbeatMs) || claimHeartbeatMs < 10 || claimHeartbeatMs >= claimLeaseMs) {
    throw new RangeError("Odoo-Worker-Heartbeat-Intervall ist ungueltig.");
  }
  const claimClock = options.claimClock ?? (() => new Date());
  const claimToken = randomUUID();
  const claimExpiresAt = new Date(now.getTime() + claimLeaseMs);
  const command = await db.transaction(async (tx) => {
    const eligible = or(
      eq(odooCommandQueue.status, "pending"),
      and(
        eq(odooCommandQueue.status, "processing"),
        or(isNull(odooCommandQueue.claimExpiresAt), lte(odooCommandQueue.claimExpiresAt, now)),
      ),
    );
    // guards:allow world-id — Der globale Queue-Worker claimt genau einen Beleg und bindet dessen Welt in Claim und Wirkung.
    const [candidate] = await tx
      .select({ id: odooCommandQueue.id, worldId: odooCommandQueue.worldId })
      .from(odooCommandQueue)
      .where(eligible)
      .orderBy(odooCommandQueue.receivedAt, odooCommandQueue.id)
      .limit(1)
      .for("update", { skipLocked: true });
    if (candidate === undefined) return undefined;
    const [claimed] = await tx
      .update(odooCommandQueue)
      .set({
        status: "processing",
        processedAt: now,
        claimToken,
        claimExpiresAt,
        failureCode: null,
      })
      .where(and(
        eq(odooCommandQueue.id, candidate.id),
        candidate.worldId === null ? isNull(odooCommandQueue.worldId) : eq(odooCommandQueue.worldId, candidate.worldId),
        eligible,
      ))
      .returning();
    return claimed;
  });
  if (command === undefined) return undefined;
  let adminRequestId: string | undefined;
  let adminPayload: AdminCommandPayload | undefined;
  try {
    if (command.commandType === "entitlement.change") {
      const payload = asEntitlementPayload(command.payload);
      const status = entitlementChangeToStatus(payload.change);
      const validUntil = payload.validUntil === undefined ? undefined : new Date(payload.validUntil);
      await db.transaction(async (tx) => {
        const [owned] = await tx.select({ id: odooCommandQueue.id }).from(odooCommandQueue).where(claimScope(command, claimToken)).limit(1).for("update");
        if (owned === undefined) throw new OdooCommandClaimLostError(command.id);
        await tx.insert(commerceEntitlements).values({
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
        const completed = await tx.update(odooCommandQueue).set({
          status: "completed", processedAt: now, claimToken: null, claimExpiresAt: null, failureCode: null,
        }).where(claimScope(command, claimToken)).returning({ id: odooCommandQueue.id });
        if (completed.length !== 1) throw new OdooCommandClaimLostError(command.id);
      });
      return { id: command.id, outcome: "accepted" };
    }

    const payload = asAdminPayload(command.payload);
    adminPayload = payload;
    const worldId = command.worldId;
    if (worldId === null || worldId !== payload.worldId) throw new Error("Administrationsbefehl besitzt keine passende Welt.");
    validateAdminCommand(payload);
    const [createdAdminRequest] = await db.insert(gameAdminRequests).values({
      worldId,
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
    }).onConflictDoNothing({ target: [gameAdminRequests.worldId, gameAdminRequests.commandId] }).returning({ id: gameAdminRequests.id });
    const [adminRequest] = createdAdminRequest === undefined
      ? await db.select({ id: gameAdminRequests.id }).from(gameAdminRequests).where(and(
          eq(gameAdminRequests.worldId, worldId),
          eq(gameAdminRequests.commandId, command.id),
        )).limit(1)
      : [createdAdminRequest];
    if (adminRequest === undefined) throw new Error("Game-Administrationsantrag konnte nicht persistiert werden.");
    const requestId = adminRequest.id;
    adminRequestId = requestId;
    await db.update(gameAdminRequests).set({ state: "dispatched", changedAt: now }).where(and(
      eq(gameAdminRequests.worldId, worldId),
      eq(gameAdminRequests.id, requestId),
    ));
    const handler = options.adminHandlers?.[payload.actionType];
    if (handler === undefined) throw new GameAdminCapabilityUnavailableError(payload.actionType);
    const gameResult = await runWithClaimHeartbeat(
      db,
      command,
      claimToken,
      claimLeaseMs,
      claimHeartbeatMs,
      claimClock,
      () => handler({
        adminRequestId: requestId,
        effectIdempotencyKey: requestId,
        commandId: command.id,
        eventId: command.eventId,
        correlationId: command.correlationId,
        receivedAt: command.receivedAt,
        now,
        payload,
      }),
    );
    const state = gameResult.state ?? "accepted";
    const effectAuditReference = gameResult.gameAuditEventId ?? null;
    await db.transaction(async (tx) => {
      const [owned] = await tx.select({ id: odooCommandQueue.id }).from(odooCommandQueue).where(claimScope(command, claimToken)).limit(1).for("update");
      if (owned === undefined) throw new OdooCommandClaimLostError(command.id);
      await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      const [auditEvent] = await tx.insert(domainEvents).values({
        worldId,
        sequence: (head?.sequence ?? 0) + 1,
        eventType: "admin.action-audited",
        payload: { adminRequestId: requestId, actionType: payload.actionType, riskClass: payload.riskClass, correlationId: command.correlationId, outcome: state, effectAuditReference },
        occurredAt: now,
      }).returning({ id: domainEvents.id });
      if (auditEvent === undefined) throw new Error("Autoritativer Game-Auditbeleg fehlt.");
      await tx.update(gameAdminRequests).set({
        state,
        gameAuditEventId: auditEvent.id,
        changedAt: now,
      }).where(and(eq(gameAdminRequests.id, requestId), eq(gameAdminRequests.worldId, worldId)));
      const finalized = await tx.update(odooCommandQueue).set({
        status: state === "completed" ? "completed" : "accepted",
        processedAt: now,
        claimToken: null,
        claimExpiresAt: null,
        failureCode: null,
      }).where(claimScope(command, claimToken)).returning({ id: odooCommandQueue.id });
      if (finalized.length !== 1) throw new OdooCommandClaimLostError(command.id);
      await tx.insert(odooProjectionOutbox).values({
        worldId,
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
    if (error instanceof OdooCommandClaimLostError || error instanceof OdooCommandWorkerInterruptedError) throw error;
    const code = error instanceof Error ? error.name : "unknown_error";
    await db.transaction(async (tx) => {
      const [owned] = await tx.select({ id: odooCommandQueue.id }).from(odooCommandQueue).where(claimScope(command, claimToken)).limit(1).for("update");
      if (owned === undefined) throw new OdooCommandClaimLostError(command.id);
      if (adminRequestId !== undefined && adminPayload !== undefined && command.worldId !== null) {
        await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${command.worldId} for update`);
        const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, command.worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
        const [auditEvent] = await tx.insert(domainEvents).values({
          worldId: command.worldId,
          sequence: (head?.sequence ?? 0) + 1,
          eventType: "admin.action-audited",
          payload: {
            adminRequestId,
            actionType: adminPayload.actionType,
            correlationId: command.correlationId,
            outcome: "failed",
            failureCode: code,
          },
          occurredAt: now,
        }).returning({ id: domainEvents.id });
        if (auditEvent === undefined) throw new Error("Autoritativer Game-Auditbeleg fuer die Ablehnung fehlt.");
        await tx.update(gameAdminRequests).set({ state: "failed", gameAuditEventId: auditEvent.id, changedAt: now }).where(and(eq(gameAdminRequests.id, adminRequestId), eq(gameAdminRequests.worldId, command.worldId)));
      }
      const rejected = await tx.update(odooCommandQueue).set({
        status: "rejected", processedAt: now, claimToken: null, claimExpiresAt: null, failureCode: code,
      }).where(claimScope(command, claimToken)).returning({ id: odooCommandQueue.id });
      if (rejected.length !== 1) throw new OdooCommandClaimLostError(command.id);
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
  // guards:allow world-id — Entitlements sind globale kaufmaennische Subject-Vertraege; Weltbezug entsteht erst im separaten Claim.
  return db.select().from(commerceEntitlements).where(and(eq(commerceEntitlements.keycloakSubject, subject), eq(commerceEntitlements.status, "active"), lt(commerceEntitlements.validFrom, at)));
}

export async function listPendingOdooProjections(db: CommerceDatabase, worldId: string, limit = 50): Promise<readonly OdooProjectionOutboxRow[]> {
  return db.select().from(odooProjectionOutbox).where(and(
    eq(odooProjectionOutbox.worldId, worldId),
    isNull(odooProjectionOutbox.deliveredAt),
  )).orderBy(odooProjectionOutbox.enqueuedAt).limit(limit);
}

export async function markOdooProjectionDelivered(db: CommerceDatabase, worldId: string, id: string, deliveredAt: Date): Promise<boolean> {
  const delivered = await db.update(odooProjectionOutbox).set({ deliveredAt, lastErrorCode: null }).where(and(
    eq(odooProjectionOutbox.worldId, worldId),
    eq(odooProjectionOutbox.id, id),
    isNull(odooProjectionOutbox.deliveredAt),
  )).returning({ id: odooProjectionOutbox.id });
  return delivered.length === 1;
}

export async function recordOdooProjectionFailure(db: CommerceDatabase, worldId: string, id: string, code: string): Promise<void> {
  const [row] = await db.select({ attempts: odooProjectionOutbox.attempts }).from(odooProjectionOutbox).where(and(
    eq(odooProjectionOutbox.worldId, worldId),
    eq(odooProjectionOutbox.id, id),
  )).limit(1);
  if (row === undefined) return;
  await db.update(odooProjectionOutbox).set({ attempts: String(Number(row.attempts) + 1), lastErrorCode: code }).where(and(
    eq(odooProjectionOutbox.worldId, worldId),
    eq(odooProjectionOutbox.id, id),
    isNull(odooProjectionOutbox.deliveredAt),
  ));
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
