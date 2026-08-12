import {
  domainEvents,
  simulationCommands,
  worldEventLog,
  worlds,
} from "@zugfolge/db";
import { parsePlanningProjection } from "@zugfolge/planning-projection";
import {
  PLANNING_COORDINATE_SCHEMA,
  PLANNING_RUNTIME_STATE_SCHEMA,
  type PlanningCoordinateCommand,
  type PlanningCoordinateRequest,
  type PlanningRuntime,
  type PlanningRuntimeResult,
  type PlanningRuntimeState,
} from "@zugfolge/planning-runtime-native";
import { Buffer } from "node:buffer";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  bindPlanningCoordinateAuthorityCommand,
  bindPlanningPathRequest,
  parsePlanningApplyAlternativePayload,
  parsePlanningInfrastructureRelease,
  type BoundPlanningPathRequest,
  type PlanningCoordinateAuthorityBody,
  type PlanningCoordinateAuthorityCommand,
  type PlanningInfrastructureRelease,
  type PlanningPathRequestBody,
} from "./contract.js";

export type PlanningDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

const STATE_EVENT_SCHEMA = "planning-runtime-state-event/v1" as const;
const PATH_REQUEST_COMMAND_TYPE = "planning.path-request" as const;
const PROCESSABLE_COMMAND_TYPES = ["planning.coordinate", "planning.apply-alternative"] as const;
export const PLANNING_WORKER_CONFLICT_FAILURE_CODE = "planning_worker_conflict" as const;

export interface PlanningRuntimeStateEvent {
  readonly schemaVersion: typeof STATE_EVENT_SCHEMA;
  readonly worldId: string;
  readonly projectionRevision: number;
  readonly stateHash: string;
  readonly state: PlanningRuntimeState;
}

export interface PlanningCommandResult {
  readonly commandId: string;
  readonly worldId: string;
  readonly projectionRevision: number;
  readonly stateHash: string;
  readonly resultEventSequence: number;
  readonly idempotentReplay: boolean;
}

/** Synchronous by design: immutable release configuration is never an external hot-path service. */
export interface PlanningInfrastructureReleaseCatalog {
  readonly get: (worldId: string, releaseId: string) => PlanningInfrastructureRelease | undefined;
}

export class PlanningWorkerConflictError extends Error {
  readonly failureCode: typeof PLANNING_WORKER_CONFLICT_FAILURE_CODE;

  constructor(message: string) {
    super(message);
    this.name = "PlanningWorkerConflictError";
    this.failureCode = PLANNING_WORKER_CONFLICT_FAILURE_CODE;
  }
}

class PlanningWorkerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningWorkerInvariantError";
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PlanningWorkerConflictError(message);
}

function systemInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PlanningWorkerInvariantError(message);
}

/** Rust-compatible lexicographic ordering of the actual UTF-8 bytes, without ICU. */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Builds the production catalog from trusted startup configuration and rejects duplicate release IDs. */
export function planningInfrastructureReleaseCatalog(
  values: readonly unknown[],
): PlanningInfrastructureReleaseCatalog {
  const releases = new Map<string, PlanningInfrastructureRelease>();
  for (const value of values) {
    const release = parsePlanningInfrastructureRelease(value);
    const key = `${release.worldId}\u0000${release.releaseId}`;
    invariant(!releases.has(key), `Planning-Infrastrukturrelease '${release.releaseId}' ist fuer die Welt doppelt.`);
    releases.set(key, release);
  }
  return Object.freeze({
    get(worldId: string, releaseId: string) {
      return releases.get(`${worldId}\u0000${releaseId}`);
    },
  });
}

function parseStateEvent(value: unknown, worldId: string): PlanningRuntimeStateEvent {
  systemInvariant(typeof value === "object" && value !== null && !Array.isArray(value), "planning.runtime-state ist kein Objekt.");
  const event = value as Record<string, unknown>;
  systemInvariant(
    Object.keys(event).length === 5
      && ["schemaVersion", "worldId", "projectionRevision", "stateHash", "state"].every((key) => key in event),
    "planning.runtime-state hat kein exaktes v1-Schema.",
  );
  systemInvariant(event["schemaVersion"] === STATE_EVENT_SCHEMA, "planning.runtime-state hat ein unbekanntes Schema.");
  systemInvariant(event["worldId"] === worldId, "planning.runtime-state verletzt die Weltisolation.");
  systemInvariant(Number.isSafeInteger(event["projectionRevision"]) && (event["projectionRevision"] as number) >= 0, "planning.runtime-state hat keine sichere Revision.");
  systemInvariant(typeof event["stateHash"] === "string" && /^[a-f0-9]{64}$/.test(event["stateHash"]), "planning.runtime-state hat keinen SHA-256.");
  systemInvariant(typeof event["state"] === "object" && event["state"] !== null && !Array.isArray(event["state"]), "planning.runtime-state enthaelt keinen Rust-Zustand.");
  const state = event["state"] as unknown as PlanningRuntimeState;
  systemInvariant(state.schemaVersion === PLANNING_RUNTIME_STATE_SCHEMA, "planning.runtime-state enthaelt ein unbekanntes Rust-Schema.");
  systemInvariant(state.worldId === worldId, "Rust-Planning-Zustand verletzt die Weltisolation.");
  systemInvariant(state.projectionRevision === event["projectionRevision"], "Rust-Zustand und Zustandsevent haben verschiedene Revisionen.");
  const projection = parsePlanningProjection(state.projection);
  systemInvariant(projection.worldId === worldId && projection.projectionRevision === state.projectionRevision, "Rust-Zustand enthaelt eine fremde Projektion.");
  return event as unknown as PlanningRuntimeStateEvent;
}

function stateEvent(result: PlanningRuntimeResult): PlanningRuntimeStateEvent {
  return {
    schemaVersion: STATE_EVENT_SCHEMA,
    worldId: result.state.worldId,
    projectionRevision: result.state.projectionRevision,
    stateHash: result.stateHash,
    state: result.state,
  };
}

function assertDiagramMatchesState(value: unknown, worldId: string, state: PlanningRuntimeStateEvent): void {
  const projection = parsePlanningProjection(value);
  systemInvariant(
    projection.worldId === worldId
      && projection.projectionRevision === state.projectionRevision
      && sameJson(projection, state.state.projection),
    "planning.diagram und Rust-Zustand sind nicht derselbe Commit.",
  );
}

async function latestState(
  db: PlanningDatabase,
  worldId: string,
): Promise<{ readonly event: PlanningRuntimeStateEvent; readonly sequence: number } | undefined> {
  const [row] = await db
    .select({ sequence: domainEvents.sequence, payload: domainEvents.payload })
    .from(domainEvents)
    .where(and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "planning.runtime-state")))
    .orderBy(desc(domainEvents.sequence))
    .limit(1);
  return row === undefined ? undefined : { sequence: row.sequence, event: parseStateEvent(row.payload, worldId) };
}

async function assertLatestDiagramMatchesState(
  db: PlanningDatabase,
  worldId: string,
  state: PlanningRuntimeStateEvent,
): Promise<void> {
  const [row] = await db
    .select({ payload: domainEvents.payload })
    .from(domainEvents)
    .where(and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "planning.diagram")))
    .orderBy(desc(domainEvents.sequence))
    .limit(1);
  systemInvariant(row !== undefined, "planning.runtime-state besitzt keine atomar veroeffentlichte Projektion.");
  assertDiagramMatchesState(row.payload, worldId, state);
}

async function committedStateForCommand(
  db: PlanningDatabase,
  worldId: string,
  resultEventSequence: number | null,
): Promise<PlanningRuntimeStateEvent> {
  systemInvariant(
    Number.isSafeInteger(resultEventSequence) && (resultEventSequence as number) >= 2,
    "Verarbeitetes Planning-Kommando besitzt keine gueltige Ergebnisereignissequenz.",
  );
  const diagramSequence = resultEventSequence as number;
  const rows = await db
    .select({ sequence: domainEvents.sequence, eventType: domainEvents.eventType, payload: domainEvents.payload })
    .from(domainEvents)
    .where(and(
      eq(domainEvents.worldId, worldId),
      inArray(domainEvents.sequence, [diagramSequence - 1, diagramSequence]),
    ))
    .orderBy(asc(domainEvents.sequence));
  systemInvariant(
    rows.length === 2
      && rows[0]?.sequence === diagramSequence - 1
      && rows[0].eventType === "planning.runtime-state"
      && rows[1]?.sequence === diagramSequence
      && rows[1].eventType === "planning.diagram",
    "Planning-Kommando referenziert keinen atomaren State/Diagram-Commit.",
  );
  const state = parseStateEvent(rows[0].payload, worldId);
  assertDiagramMatchesState(rows[1].payload, worldId, state);
  return state;
}

async function insertIdempotentCommand(
  db: PlanningDatabase,
  values: {
    readonly worldId: string;
    readonly requestingAccountId: string;
    readonly idempotencyKey: string;
    readonly commandType: string;
    readonly payload: unknown;
    readonly submittedAt: Date;
  },
  collisionMessage: string,
) {
  let [command] = await db
    .insert(simulationCommands)
    .values(values)
    .onConflictDoNothing({
      target: [simulationCommands.worldId, simulationCommands.requestingAccountId, simulationCommands.idempotencyKey],
    })
    .returning();
  if (command === undefined) {
    [command] = await db
      .select()
      .from(simulationCommands)
      .where(and(
        eq(simulationCommands.worldId, values.worldId),
        eq(simulationCommands.requestingAccountId, values.requestingAccountId),
        eq(simulationCommands.idempotencyKey, values.idempotencyKey),
      ))
      .limit(1);
  }
  invariant(
    command !== undefined && command.commandType === values.commandType && sameJson(command.payload, values.payload),
    collisionMessage,
  );
  return command;
}

/** Queues exactly one authenticated player's request; world/account cannot be supplied in the body. */
export async function queuePlanningPathRequest(
  db: PlanningDatabase,
  input: {
    readonly worldId: string;
    readonly requestingAccountId: string;
    readonly body: PlanningPathRequestBody | unknown;
    readonly submittedAt: Date;
  },
) {
  const payload = bindPlanningPathRequest(input.worldId, input.requestingAccountId, input.body);
  return insertIdempotentCommand(db, {
    worldId: input.worldId,
    requestingAccountId: input.requestingAccountId,
    idempotencyKey: `planning-path-request:${payload.requestId}`,
    commandType: PATH_REQUEST_COMMAND_TYPE,
    payload,
    submittedAt: input.submittedAt,
  }, "Trassenantrags-ID ist fuer dieses Konto bereits mit anderen Fakten belegt.");
}

/**
 * Queues an authority-only coordination command. The required account ID is an
 * internal audit principal for the existing command table, never a player who
 * gets to submit infrastructure or both requests.
 */
export async function queuePlanningCoordinate(
  db: PlanningDatabase,
  input: {
    readonly worldId: string;
    readonly authorityAccountId: string;
    readonly body: PlanningCoordinateAuthorityBody | unknown;
    readonly submittedAt: Date;
  },
) {
  const payload = bindPlanningCoordinateAuthorityCommand(input.worldId, input.body);
  return insertIdempotentCommand(db, {
    worldId: input.worldId,
    requestingAccountId: input.authorityAccountId,
    idempotencyKey: `planning-coordinate:${payload.runId}`,
    commandType: "planning.coordinate",
    payload,
    submittedAt: input.submittedAt,
  }, "PlanningRun-ID ist bereits mit einem anderen Koordinierungslauf belegt.");
}

interface ResolvedPathRequests {
  readonly commandIds: readonly [string, string];
  readonly requests: readonly [PlanningCoordinateRequest, PlanningCoordinateRequest];
}

function parsePersistedPathRequest(row: {
  readonly worldId: string;
  readonly requestingAccountId: string;
  readonly payload: unknown;
}): BoundPlanningPathRequest {
  invariant(typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload), "Persistierter Trassenantrag ist kein Objekt.");
  const body = Object.fromEntries(
    Object.entries(row.payload).filter(([key]) => key !== "worldId" && key !== "requestingAccountId"),
  );
  let rebound: BoundPlanningPathRequest;
  try {
    rebound = bindPlanningPathRequest(row.worldId, row.requestingAccountId, body);
  } catch (error) {
    if (error instanceof TypeError) throw new PlanningWorkerConflictError(error.message);
    throw error;
  }
  invariant(sameJson(rebound, row.payload), "Persistierter Trassenantrag verletzt die Welt- oder Kontobindung.");
  return rebound;
}

function parsePersistedCoordinate(worldId: string, payload: unknown): PlanningCoordinateAuthorityCommand {
  invariant(typeof payload === "object" && payload !== null && !Array.isArray(payload), "Persistiertes planning.coordinate ist kein Objekt.");
  const body = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "worldId"));
  let coordinate: PlanningCoordinateAuthorityCommand;
  try {
    coordinate = bindPlanningCoordinateAuthorityCommand(worldId, body);
  } catch (error) {
    if (error instanceof TypeError) throw new PlanningWorkerConflictError(error.message);
    throw error;
  }
  invariant(sameJson(coordinate, payload), "Persistiertes planning.coordinate verletzt die Weltbindung.");
  return coordinate;
}

async function resolvePathRequests(
  db: PlanningDatabase,
  coordinate: PlanningCoordinateAuthorityCommand,
  release: PlanningInfrastructureRelease,
  expectedStatus: "pending" | "processed",
  expectedResultEventSequence?: number,
): Promise<ResolvedPathRequests> {
  const commandIds = [...coordinate.requestCommandIds];
  const rows = await db
    .select({
      id: simulationCommands.id,
      worldId: simulationCommands.worldId,
      requestingAccountId: simulationCommands.requestingAccountId,
      commandType: simulationCommands.commandType,
      payload: simulationCommands.payload,
      status: simulationCommands.status,
      resultEventSequence: simulationCommands.resultEventSequence,
    })
    .from(simulationCommands)
    .where(and(eq(simulationCommands.worldId, coordinate.worldId), inArray(simulationCommands.id, commandIds)));
  invariant(rows.length === 2, "planning.coordinate referenziert nicht exakt zwei Antraege derselben Welt.");
  invariant(rows.every((row) => commandIds.includes(row.id)), "planning.coordinate referenziert fremde Antraege.");
  invariant(rows.every((row) => row.commandType === PATH_REQUEST_COMMAND_TYPE), "planning.coordinate referenziert ein Nicht-Antragskommando.");
  invariant(rows.every((row) => row.status === expectedStatus), `planning.coordinate braucht zwei ${expectedStatus === "pending" ? "offene" : "verarbeitete"} Antraege.`);
  if (expectedResultEventSequence !== undefined) {
    invariant(
      rows.every((row) => row.resultEventSequence === expectedResultEventSequence),
      "Verarbeitete Trassenantraege referenzieren nicht denselben State/Diagram-Commit.",
    );
  }
  invariant(
    new Set(rows.map((row) => row.requestingAccountId)).size === 2,
    "planning.coordinate braucht zwei Trassenantraege verschiedener Konten.",
  );
  const parsed = rows.map((row) => ({ row, request: parsePersistedPathRequest(row) }));
  invariant(new Set(parsed.map(({ request }) => request.requestId)).size === 2, "planning.coordinate besitzt doppelte fachliche Antrags-IDs.");
  invariant(new Set(parsed.map(({ request }) => request.trainId)).size === 2, "planning.coordinate besitzt doppelte Zug-IDs.");
  parsed.sort((left, right) => compareUtf8(left.request.requestId, right.request.requestId));
  const requests = parsed.map(({ request }, index) => {
    const {
      schemaVersion: _schemaVersion,
      worldId: _worldId,
      requestingAccountId: _accountId,
      requestId: _requestId,
      boundaryPlanningWindowId,
      ...facts
    } = request;
    if (boundaryPlanningWindowId === undefined) {
      return { requestNumericId: index + 1, ...facts };
    }
    const boundary = release.boundaryPlanningWindows?.find((item) => item.id === boundaryPlanningWindowId);
    invariant(boundary !== undefined, `Grenzfenster '${boundaryPlanningWindowId}' gehoert nicht zum gepinnten Infrastrukturrelease.`);
    invariant(boundary.orderable && boundary.qualityClass !== "C", `Grenzfenster '${boundaryPlanningWindowId}' ist sichtbar, aber nicht bestellbar.`);
    invariant(
      boundary.originStationId === facts.originStationId && boundary.destinationStationId === facts.destinationStationId,
      `Grenzfenster '${boundaryPlanningWindowId}' gehoert zu einem anderen regionalen Fahrtabschnitt.`,
    );
    return { requestNumericId: index + 1, ...facts, boundaryWindows: boundary.windows };
  }) as [PlanningCoordinateRequest, PlanningCoordinateRequest];
  return { commandIds: commandIds as [string, string], requests };
}

function resolveInfrastructureRelease(
  catalog: PlanningInfrastructureReleaseCatalog,
  coordinate: PlanningCoordinateAuthorityCommand,
): PlanningInfrastructureRelease {
  const release = catalog.get(coordinate.worldId, coordinate.infrastructureReleaseId);
  invariant(release !== undefined, `Planning-Infrastrukturrelease '${coordinate.infrastructureReleaseId}' ist serverseitig nicht konfiguriert.`);
  return parsePlanningInfrastructureRelease(release, coordinate.worldId, coordinate.infrastructureReleaseId);
}

function runtimeCoordinate(
  coordinate: PlanningCoordinateAuthorityCommand,
  release: PlanningInfrastructureRelease,
  requests: ResolvedPathRequests["requests"],
): PlanningCoordinateCommand {
  return {
    schemaVersion: PLANNING_COORDINATE_SCHEMA,
    worldId: coordinate.worldId,
    runId: coordinate.runId,
    expectedProjectionRevision: coordinate.expectedProjectionRevision,
    seedWorld: coordinate.seedWorld,
    seedPeriod: coordinate.seedPeriod,
    sourceId: release.sourceId,
    corridorId: release.corridorId,
    corridorName: release.corridorName,
    stations: release.stations,
    segments: release.segments,
    requests,
  };
}

/** Processes one persisted planning command in one world-locked transaction. */
export async function processPlanningCommand(
  db: PlanningDatabase,
  runtime: PlanningRuntime,
  infrastructureReleases: PlanningInfrastructureReleaseCatalog,
  commandId: string,
  committedAt: Date,
): Promise<PlanningCommandResult> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ worldId: simulationCommands.worldId })
      .from(simulationCommands)
      .where(eq(simulationCommands.id, commandId))
      .limit(1);
    systemInvariant(candidate !== undefined, `Planning-Kommando '${commandId}' ist unbekannt.`);
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${candidate.worldId} for update`);
    const [command] = await tx
      .select()
      .from(simulationCommands)
      .where(and(eq(simulationCommands.id, commandId), eq(simulationCommands.worldId, candidate.worldId)))
      .limit(1);
    systemInvariant(command !== undefined, `Planning-Kommando '${commandId}' ist verschwunden.`);
    systemInvariant(
      PROCESSABLE_COMMAND_TYPES.includes(command.commandType as (typeof PROCESSABLE_COMMAND_TYPES)[number]),
      `Kommando '${commandId}' ist kein verarbeitbares Planning-Kommando.`,
    );
    systemInvariant(command.status !== "failed", `Planning-Kommando '${commandId}' ist bereits fehlgeschlagen.`);
    if (command.status === "processed") {
      const committed = await committedStateForCommand(tx, command.worldId, command.resultEventSequence);
      if (command.commandType === "planning.coordinate") {
        const coordinate = parsePersistedCoordinate(command.worldId, command.payload);
        const release = resolveInfrastructureRelease(infrastructureReleases, coordinate);
        await resolvePathRequests(tx, coordinate, release, "processed", command.resultEventSequence ?? undefined);
      }
      return {
        commandId: command.id,
        worldId: command.worldId,
        projectionRevision: committed.projectionRevision,
        stateHash: committed.stateHash,
        resultEventSequence: command.resultEventSequence as number,
        idempotentReplay: true,
      };
    }

    const current = await latestState(tx, command.worldId);
    let result: PlanningRuntimeResult;
    let consumedPathRequestIds: readonly [string, string] | undefined;
    if (command.commandType === "planning.coordinate") {
      const coordinate = parsePersistedCoordinate(command.worldId, command.payload);
      if (coordinate.expectedProjectionRevision === null) {
        invariant(current === undefined, "Initialer PlanningRun trifft auf eine bestehende Projektion.");
      } else {
        invariant(current !== undefined, "Fortschreibender PlanningRun besitzt keinen Ausgangszustand.");
        invariant(current.event.projectionRevision === coordinate.expectedProjectionRevision, "PlanningRun erwartet eine veraltete Fachrevision.");
        await assertLatestDiagramMatchesState(tx, command.worldId, current.event);
      }
      const release = resolveInfrastructureRelease(infrastructureReleases, coordinate);
      const resolved = await resolvePathRequests(tx, coordinate, release, "pending");
      consumedPathRequestIds = resolved.commandIds;
      result = runtime.coordinate(runtimeCoordinate(coordinate, release, resolved.requests));
    } else {
      invariant(current !== undefined, "Alternativkommando besitzt keinen PlanningRun-Zustand.");
      await assertLatestDiagramMatchesState(tx, command.worldId, current.event);
      let payload;
      try {
        payload = parsePlanningApplyAlternativePayload(command.payload);
      } catch (error) {
        if (error instanceof TypeError) throw new PlanningWorkerConflictError(error.message);
        throw error;
      }
      invariant(payload.projectionRevision === current.event.projectionRevision, "Alternativkommando erwartet eine veraltete Fachrevision.");
      result = runtime.applyAlternative(current.event.state, command.id, payload);
      systemInvariant(!result.idempotentReplay, "Ausstehendes Kommando war im Rust-Zustand bereits verarbeitet.");
    }
    systemInvariant(result.state.worldId === command.worldId, "Rust-Ergebnis verletzt die Weltisolation.");
    systemInvariant(result.projection.worldId === command.worldId, "Rust-Projektion verletzt die Weltisolation.");
    systemInvariant(result.state.projectionRevision === result.projection.projectionRevision, "Rust-Ergebnis besitzt zwei Revisionen.");

    const [last] = await tx
      .select({ sequence: domainEvents.sequence })
      .from(domainEvents)
      .where(eq(domainEvents.worldId, command.worldId))
      .orderBy(desc(domainEvents.sequence))
      .limit(1);
    const stateSequence = (last?.sequence ?? 0) + 1;
    const diagramSequence = stateSequence + 1;
    systemInvariant(Number.isSafeInteger(diagramSequence), "Domain-Ereignissequenz ist erschoepft.");
    await worldEventLog(tx, command.worldId).appendBatch([
      { sequence: stateSequence, eventType: "planning.runtime-state", payload: stateEvent(result), occurredAt: committedAt },
      { sequence: diagramSequence, eventType: "planning.diagram", payload: result.projection, occurredAt: committedAt },
    ]);
    if (consumedPathRequestIds !== undefined) {
      const consumed = await tx
        .update(simulationCommands)
        .set({ status: "processed", processedAt: committedAt, resultEventSequence: diagramSequence, failureCode: null })
        .where(and(
          eq(simulationCommands.worldId, command.worldId),
          eq(simulationCommands.commandType, PATH_REQUEST_COMMAND_TYPE),
          eq(simulationCommands.status, "pending"),
          inArray(simulationCommands.id, [...consumedPathRequestIds]),
        ))
        .returning({ id: simulationCommands.id });
      systemInvariant(consumed.length === 2, "Trassenantraege wurden waehrend der Welttransaktion veraendert.");
    }
    const updated = await tx
      .update(simulationCommands)
      .set({ status: "processed", processedAt: committedAt, resultEventSequence: diagramSequence, failureCode: null })
      .where(and(
        eq(simulationCommands.id, command.id),
        eq(simulationCommands.worldId, command.worldId),
        eq(simulationCommands.status, "pending"),
      ))
      .returning({ id: simulationCommands.id });
    systemInvariant(updated.length === 1, "Planning-Kommando wurde waehrend der Welttransaktion veraendert.");
    return {
      commandId: command.id,
      worldId: command.worldId,
      projectionRevision: result.projection.projectionRevision,
      stateHash: result.stateHash,
      resultEventSequence: diagramSequence,
      idempotentReplay: false,
    };
  });
}

async function markPlanningCommandFailed(
  db: PlanningDatabase,
  input: {
    readonly commandId: string;
    readonly worldId: string;
    readonly failedAt: Date;
    readonly failureCode: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${input.worldId} for update`);
    await tx
      .update(simulationCommands)
      .set({
        status: "failed",
        processedAt: input.failedAt,
        failureCode: input.failureCode,
      })
      .where(and(
        eq(simulationCommands.id, input.commandId),
        eq(simulationCommands.worldId, input.worldId),
        eq(simulationCommands.status, "pending"),
        inArray(simulationCommands.commandType, [...PROCESSABLE_COMMAND_TYPES]),
      ));
  });
}

/** Productive bounded consumer loop; scheduling and shutdown stay with game-api. */
export async function consumePendingPlanningCommands(
  db: PlanningDatabase,
  runtime: PlanningRuntime,
  infrastructureReleases: PlanningInfrastructureReleaseCatalog,
  worldId: string,
  input: { readonly committedAt: () => Date; readonly limit?: number },
): Promise<readonly PlanningCommandResult[]> {
  const limit = input.limit ?? 100;
  invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1_000, "Planning-Consumer-Limit ist ungueltig.");
  const commands = await db
    .select({ id: simulationCommands.id })
    .from(simulationCommands)
    .where(and(
      eq(simulationCommands.worldId, worldId),
      eq(simulationCommands.status, "pending"),
      inArray(simulationCommands.commandType, [...PROCESSABLE_COMMAND_TYPES]),
    ))
    .orderBy(asc(simulationCommands.submittedAt), asc(simulationCommands.id))
    .limit(limit);
  const results: PlanningCommandResult[] = [];
  for (const command of commands) {
    const committedAt = input.committedAt();
    try {
      results.push(await processPlanningCommand(db, runtime, infrastructureReleases, command.id, committedAt));
    } catch (error) {
      if (error instanceof PlanningWorkerConflictError) {
        await markPlanningCommandFailed(db, {
          commandId: command.id,
          worldId,
          failedAt: committedAt,
          failureCode: error.failureCode,
        });
      }
      throw error;
    }
  }
  return results;
}
