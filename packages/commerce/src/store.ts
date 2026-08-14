import { randomUUID } from "node:crypto";

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
import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { entitlementChangeToStatus } from "./entitlements.js";
import {
  AUTHORITATIVE_WORLD_START_PROJECTION,
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
  if (input.payload["projectionKind"] === AUTHORITATIVE_WORLD_START_PROJECTION) {
    throw new Error("Autoritative Weltstartprojektionen brauchen den signierten, typisierten Enqueue-Pfad.");
  }
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
 * Einziger Game->Odoo-Pfad, der einen Deployment-Hash ersetzen darf. Der
 * Aufrufer reicht die bereits Ed25519-verifizierte Huelle ein; die Odoo-HMAC-
 * Grenze signiert anschliessend genau diesen welt- und revisionsgebundenen
 * Projektionsbeleg.
 */
export async function enqueueAuthoritativeWorldStartProjection(
  db: CommerceDatabase,
  input: {
    readonly worldId: string;
    readonly correlationId: string;
    readonly signedDeployment: {
      readonly deployment: {
        readonly worldId?: unknown;
        readonly deploymentRevision?: unknown;
      };
      readonly deploymentHash: string;
      readonly signature: {
        readonly algorithm: "Ed25519";
        readonly keyId: string;
        readonly valueBase64: string;
      };
    };
    readonly deploymentRevision: number;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly occurredAt?: Date;
  },
): Promise<void> {
  const signed = input.signedDeployment;
  const deploymentRevision = signed.deployment["deploymentRevision"] ?? 1;
  if (
    signed.deployment["worldId"] !== input.worldId
    || signed.deploymentHash.trim() === ""
    || signed.signature.algorithm !== "Ed25519"
    || signed.signature.keyId.trim() === ""
    || !Number.isSafeInteger(input.deploymentRevision)
    || input.deploymentRevision < 1
    || deploymentRevision !== input.deploymentRevision
  ) {
    throw new Error("Autoritative Weltstartprojektion verletzt Welt-, Signatur- oder Revisionsbindung.");
  }
  for (const reserved of ["projectionKind", "deploymentHash", "deploymentRevision", "deploymentAuthorization"] as const) {
    if (Object.hasOwn(input.payload, reserved)) {
      throw new Error(`Autoritative Weltstartprojektion darf das reservierte Feld '${reserved}' nicht ueberschreiben.`);
    }
  }
  const occurredAt = input.occurredAt ?? new Date();
  await db.insert(odooProjectionOutbox).values({
    worldId: input.worldId,
    messageType: "world.projection",
    schemaVersion: ODOO_CONTRACT_VERSION,
    correlationId: input.correlationId,
    payload: {
      ...input.payload,
      projectionKind: AUTHORITATIVE_WORLD_START_PROJECTION,
      authoritative: true,
      deploymentHash: signed.deploymentHash,
      deploymentRevision: input.deploymentRevision,
      deploymentAuthorization: {
        schemaVersion: AUTHORITATIVE_WORLD_START_PROJECTION,
        deploymentHash: signed.deploymentHash,
        deploymentRevision: input.deploymentRevision,
        algorithm: signed.signature.algorithm,
        keyId: signed.signature.keyId,
        valueBase64: signed.signature.valueBase64,
      },
    },
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
  /**
   * Markiert, dass die autoritative Fachwirkung bereits dauerhaft committen
   * konnte. Ein danach fehlschlagender prozesslokaler Callback oder eine
   * Folgeprojektion darf den Odoo-Befehl dann nur retrybar freigeben und nie
   * als fachlich abgelehnt quittieren. Der Worker stellt den Marker bereit;
   * direkte Handler-Tests duerfen ihn weglassen.
   */
  readonly markEffectApplied?: () => void;
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
  /** Autoritativer, weltgebundener Game-Handler fuer kommerzielle Teilnahmen. */
  readonly participationHandler?: WorldParticipationCommandHandler;
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
  let adminRequestPersisted = false;
  let adminPayload: AdminCommandPayload | undefined;
  let handlerCompleted = false;
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

    if (command.commandType === "world.participation.change") {
      const payload = asWorldParticipationPayload(command.payload);
      if (command.worldId === null || command.worldId !== payload.worldId) {
        throw new Error("Weltteilnahmebefehl besitzt keine passende Welt.");
      }
      if (options.participationHandler === undefined) throw new Error("Weltteilnahme-Handler ist nicht verfuegbar.");
      const result = await runWithClaimHeartbeat(
        db,
        command,
        claimToken,
        claimLeaseMs,
        claimHeartbeatMs,
        claimClock,
        () => options.participationHandler!({
          commandId: command.id,
          eventId: command.eventId,
          correlationId: command.correlationId,
          receivedAt: command.receivedAt,
          now,
          payload,
        }),
      );
      handlerCompleted = true;
      const outcome = result.state === "rejected" ? "rejected" : "accepted";
      await db.transaction(async (tx) => {
        const [owned] = await tx.select({ id: odooCommandQueue.id }).from(odooCommandQueue)
          .where(claimScope(command, claimToken)).limit(1).for("update");
        if (owned === undefined) throw new OdooCommandClaimLostError(command.id);
        const finalized = await tx.update(odooCommandQueue).set({
          status: result.state === "rejected" ? "rejected" : "completed",
          processedAt: now,
          claimToken: null,
          claimExpiresAt: null,
          failureCode: result.rejectionCode ?? null,
        }).where(claimScope(command, claimToken)).returning({ id: odooCommandQueue.id });
        if (finalized.length !== 1) throw new OdooCommandClaimLostError(command.id);
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
    adminPayload = payload;
    const worldId = command.worldId;
    if (worldId === null || worldId !== payload.worldId) throw new Error("Administrationsbefehl besitzt keine passende Welt.");
    validateAdminCommand(payload);
    const handler = options.adminHandlers?.[payload.actionType];
    const [existingAdminRequest] = await db.select({
      id: gameAdminRequests.id,
      actionType: gameAdminRequests.actionType,
      correlationId: gameAdminRequests.correlationId,
    }).from(gameAdminRequests).where(and(
      eq(gameAdminRequests.worldId, worldId),
      eq(gameAdminRequests.commandId, command.id),
    )).limit(1);
    if (existingAdminRequest !== undefined) {
      if (existingAdminRequest.actionType !== payload.actionType
        || existingAdminRequest.correlationId !== command.correlationId) {
        throw new Error("Persistierter Game-Administrationsantrag widerspricht dem Queue-Kommando.");
      }
      adminRequestId = existingAdminRequest.id;
      adminRequestPersisted = true;
    }

    // Die Kommando-ID ist fuer den pre-world-Pfad zugleich die deterministische
    // Antrag-ID. So bleibt der Wirkungs-Key selbst dann stabil, wenn die Welt
    // entsteht, aber der nachgelagerte FK-gebundene Antrag noch nicht committen
    // konnte.
    if (payload.actionType === "world_deploy") {
      adminRequestId ??= command.id;
    } else if (!adminRequestPersisted) {
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
      adminRequestId = adminRequest.id;
      adminRequestPersisted = true;
    }
    if (handler === undefined) throw new GameAdminCapabilityUnavailableError(payload.actionType);
    const requestId = adminRequestId!;
    if (adminRequestPersisted) {
      await db.update(gameAdminRequests).set({ state: "dispatched", changedAt: now }).where(and(
        eq(gameAdminRequests.worldId, worldId),
        eq(gameAdminRequests.id, requestId),
      ));
    }
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
        markEffectApplied: () => { handlerCompleted = true; },
        commandId: command.id,
        eventId: command.eventId,
        correlationId: command.correlationId,
        receivedAt: command.receivedAt,
        now,
        payload,
      }),
    );
    handlerCompleted = true;
    const state = gameResult.state ?? "accepted";
    const effectAuditReference = gameResult.gameAuditEventId ?? null;
    await db.transaction(async (tx) => {
      const [owned] = await tx.select({ id: odooCommandQueue.id }).from(odooCommandQueue).where(claimScope(command, claimToken)).limit(1).for("update");
      if (owned === undefined) throw new OdooCommandClaimLostError(command.id);
      await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
      if (!adminRequestPersisted) {
        const [createdAdminRequest] = await tx.insert(gameAdminRequests).values({
          id: requestId,
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
        const [persistedAdminRequest] = createdAdminRequest === undefined
          ? await tx.select({ id: gameAdminRequests.id }).from(gameAdminRequests).where(and(
              eq(gameAdminRequests.worldId, worldId),
              eq(gameAdminRequests.commandId, command.id),
            )).limit(1)
          : [createdAdminRequest];
        if (persistedAdminRequest?.id !== requestId) {
          throw new Error("Game-Administrationsantrag konnte nach Welterzeugung nicht stabil persistiert werden.");
        }
        adminRequestPersisted = true;
      }
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
    // Eine bereits vollzogene Fachwirkung darf bei einem nachgelagerten
    // Audit-/Outboxfehler niemals als abgelehnt gemeldet werden. Der Claim
    // wird nur vom aktuellen Besitzer freigegeben; der Handler muss denselben
    // stabilen Wirkungs-Key beim Retry idempotent wiederverwenden.
    if (handlerCompleted) {
      await db.transaction(async (tx) => {
        const released = await tx.update(odooCommandQueue).set({
          status: "pending",
          processedAt: null,
          claimToken: null,
          claimExpiresAt: null,
          failureCode: null,
        }).where(claimScope(command, claimToken)).returning({ id: odooCommandQueue.id });
        if (released.length !== 1) throw new OdooCommandClaimLostError(command.id);
      });
      throw error;
    }

    const retryAdminPayload = adminPayload;
    const retryAdminRequestId = adminRequestId;
    if (retryAdminPayload?.actionType === "world_deploy" && command.worldId !== null && retryAdminRequestId !== undefined) {
      const [partialWorld] = await db.select({ lifecycleStatus: worlds.lifecycleStatus })
        .from(worlds)
        .where(eq(worlds.id, command.worldId))
        .limit(1);
      if (partialWorld?.lifecycleStatus === "provisioning") {
        // Nach der signaturgeprueften Welterzeugung sind Fehler in Economy,
        // Fleet, Regionalstart oder Endverifikation retrybar. Antrag-ID und
        // Claim-Freigabe committen atomar, bevor ein anderer Worker fortsetzt.
        await db.transaction(async (tx) => {
          const [owned] = await tx.select({ id: odooCommandQueue.id }).from(odooCommandQueue)
            .where(claimScope(command, claimToken)).limit(1).for("update");
          if (owned === undefined) throw new OdooCommandClaimLostError(command.id);
          const [createdAdminRequest] = await tx.insert(gameAdminRequests).values({
            id: retryAdminRequestId,
            worldId: command.worldId!,
            commandId: command.id,
            actionType: retryAdminPayload.actionType,
            riskClass: retryAdminPayload.riskClass,
            requesterReference: retryAdminPayload.requesterReference,
            approverReference: retryAdminPayload.approverReference,
            reason: retryAdminPayload.reason,
            effectPreview: retryAdminPayload.effectPreview,
            state: "approved",
            correlationId: command.correlationId,
            changedAt: now,
          }).onConflictDoNothing({ target: [gameAdminRequests.worldId, gameAdminRequests.commandId] }).returning({ id: gameAdminRequests.id });
          const [persistedAdminRequest] = createdAdminRequest === undefined
            ? await tx.select({
                id: gameAdminRequests.id,
                actionType: gameAdminRequests.actionType,
                correlationId: gameAdminRequests.correlationId,
              }).from(gameAdminRequests).where(and(
                eq(gameAdminRequests.worldId, command.worldId!),
                eq(gameAdminRequests.commandId, command.id),
              )).limit(1)
            : [{
                id: createdAdminRequest.id,
                actionType: retryAdminPayload.actionType,
                correlationId: command.correlationId,
              }];
          if (persistedAdminRequest === undefined
            || persistedAdminRequest.id !== retryAdminRequestId
            || persistedAdminRequest.actionType !== retryAdminPayload.actionType
            || persistedAdminRequest.correlationId !== command.correlationId) {
            throw new Error("Retrybarer Weltstart besitzt keinen stabilen Game-Administrationsantrag.");
          }
          adminRequestPersisted = true;
          const released = await tx.update(odooCommandQueue).set({
            status: "pending",
            processedAt: null,
            claimToken: null,
            claimExpiresAt: null,
            failureCode: null,
          }).where(claimScope(command, claimToken)).returning({ id: odooCommandQueue.id });
          if (released.length !== 1) throw new OdooCommandClaimLostError(command.id);
        });
        throw error;
      }
    }

    const code = error instanceof Error ? error.name : "unknown_error";
    if (command.commandType === "world.participation.change" && command.worldId !== null) {
      const payload = asWorldParticipationPayload(command.payload);
      await db.transaction(async (tx) => {
        const [owned] = await tx.select({ id: odooCommandQueue.id }).from(odooCommandQueue)
          .where(claimScope(command, claimToken)).limit(1).for("update");
        if (owned === undefined) throw new OdooCommandClaimLostError(command.id);
        const finalized = await tx.update(odooCommandQueue).set({
          status: "rejected",
          processedAt: now,
          claimToken: null,
          claimExpiresAt: null,
          failureCode: code,
        }).where(claimScope(command, claimToken)).returning({ id: odooCommandQueue.id });
        if (finalized.length !== 1) throw new OdooCommandClaimLostError(command.id);
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
      const [owned] = await tx.select({ id: odooCommandQueue.id }).from(odooCommandQueue).where(claimScope(command, claimToken)).limit(1).for("update");
      if (owned === undefined) throw new OdooCommandClaimLostError(command.id);
      const existingWorld = command.worldId === null
        ? undefined
        : (await tx.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, command.worldId)).limit(1))[0];
      if (!adminRequestPersisted && adminRequestId !== undefined && adminPayload !== undefined && existingWorld !== undefined) {
        const [createdAdminRequest] = await tx.insert(gameAdminRequests).values({
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
        }).onConflictDoNothing({ target: [gameAdminRequests.worldId, gameAdminRequests.commandId] }).returning({ id: gameAdminRequests.id });
        const persistedAdminRequestId = createdAdminRequest?.id ?? (await tx.select({ id: gameAdminRequests.id })
          .from(gameAdminRequests)
          .where(and(
            eq(gameAdminRequests.worldId, existingWorld.id),
            eq(gameAdminRequests.commandId, command.id),
          ))
          .limit(1))[0]?.id;
        if (persistedAdminRequestId !== adminRequestId) {
          throw new Error("Abgelehnter Weltstart besitzt keinen stabilen Game-Administrationsantrag.");
        }
        adminRequestPersisted = true;
      }
      if (adminRequestPersisted && adminRequestId !== undefined && adminPayload !== undefined
        && command.worldId !== null && existingWorld !== undefined) {
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
      let globalAuditEventId: string | undefined;
      if (command.commandType === "admin.world_deploy" && command.worldId !== null && existingWorld === undefined) {
        const [auditEvent] = await tx.insert(globalAdminAuditEvents).values({
          targetWorldId: command.worldId,
          commandId: command.id,
          correlationId: command.correlationId,
          actionType: "world_deploy",
          outcome: "rejected",
          failureCode: code,
          occurredAt: now,
        }).onConflictDoNothing({ target: globalAdminAuditEvents.commandId }).returning({ id: globalAdminAuditEvents.id });
        // guards:allow world-id — Pre-world-Deploys besitzen absichtlich noch
        // keine referenzierbare Weltzeile; die globale Audit-Tabelle bindet
        // den unveraenderlichen Command stattdessen an target_world_id.
        globalAuditEventId = auditEvent?.id ?? (await tx.select({ id: globalAdminAuditEvents.id })
          .from(globalAdminAuditEvents)
          .where(and(
            eq(globalAdminAuditEvents.commandId, command.id),
            eq(globalAdminAuditEvents.targetWorldId, command.worldId),
          ))
          .limit(1))[0]?.id;
        if (globalAuditEventId === undefined) throw new Error("Globaler Game-Auditbeleg fuer die pre-world Ablehnung fehlt.");
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
  // guards:allow world-id — Entitlements sind globale kaufmaennische Subject-Vertraege; Weltbezug entsteht erst im separaten Claim.
  return db.select().from(commerceEntitlements).where(and(eq(commerceEntitlements.keycloakSubject, subject), eq(commerceEntitlements.status, "active"), lt(commerceEntitlements.validFrom, at)));
}

export async function listPendingOdooProjections(db: CommerceDatabase, worldId: string, limit = 50): Promise<readonly OdooProjectionOutboxRow[]> {
  return db.select().from(odooProjectionOutbox).where(and(
    eq(odooProjectionOutbox.worldId, worldId),
    isNull(odooProjectionOutbox.deliveredAt),
  )).orderBy(odooProjectionOutbox.enqueuedAt).limit(limit);
}

/**
 * Liefert alle Weltbindungen, fuer die die Odoo-Outbox tatsaechlich Arbeit
 * enthaelt. Dazu gehoeren bewusst auch global auditierte Ablehnungen eines
 * pre-world Deployments, deren Zielwelt nie in der aktiven Runtime erscheint.
 */
export async function listPendingOdooProjectionWorldIds(db: CommerceDatabase): Promise<readonly string[]> {
  // guards:allow world-id — Der globale Dispatcher enumeriert nur Weltbindungen wartender Outbox-Metadaten.
  const rows = await db
    .selectDistinct({ worldId: odooProjectionOutbox.worldId })
    .from(odooProjectionOutbox)
    .where(isNull(odooProjectionOutbox.deliveredAt))
    .orderBy(odooProjectionOutbox.worldId);
  return rows.map((row) => row.worldId);
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
