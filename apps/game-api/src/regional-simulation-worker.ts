import {
  domainEvents,
  mailboxMessages,
  operators,
  regionalSimulationStates,
  worldEventLog,
  worlds,
  type RegionalSimulationStateRow,
} from "@zugfolge/db";
import {
  OPERATIONS_DECISION_EVENT_TYPES,
  operationsEventOperatorIds,
  projectOperations,
  type OperationsRegistry,
} from "@zugfolge/dispatch";
import type { LivemapRegistry } from "@zugfolge/livemap-stream";
import {
  OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
  OPERATIONAL_SIMULATION_STATE_SCHEMA,
  type OperationalProjection,
  type OperationalSimulationCommandPayload,
  type OperationalSimulationInitialization,
  type OperationalSimulationInitialized,
  type OperationalSimulationRestored,
  type OperationalSimulationResult,
  type OperationalSimulationRuntime,
  type OperationalSimulationState,
} from "@zugfolge/runtime-native";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  adaptOperationalDomainEvents,
  type OperationalCommitEventContext,
  type OperationalNativeEvent,
} from "./operational-domain-event-adapter.js";
import { projectOperationalLivemap } from "./operational-livemap-projection.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";
import { compareUtf8 } from "./utf8.js";

type AnyDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

const OPERATIONAL_COMMAND_BATCH_LIMIT = 4_096;

export interface RegionalSimulationWorkCommand {
  readonly worldId: string;
  readonly regionId: string;
  readonly commandId: string;
  readonly command: OperationalSimulationCommandPayload;
}

export interface RegionalSimulationWorkBatch {
  readonly worldId: string;
  readonly regionId: string;
  readonly commands: readonly Pick<RegionalSimulationWorkCommand, "commandId" | "command">[];
}

export interface RegionalSimulationReadyRegion {
  readonly worldId: string;
  readonly regionId: string;
  readonly nowMs: number;
  readonly initializationHash: string;
}

export interface OperationalSimulationBatchResult {
  readonly state: OperationalSimulationState;
  readonly stateHash: string;
  readonly liveMap: OperationalProjection;
  readonly rzue: OperationalProjection;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly commandResults: readonly Readonly<{
    commandId: string;
    idempotentReplay: boolean;
  }>[];
}

export class RegionalSimulationUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "regional_simulation_unavailable";

  constructor(worldId: string, regionId: string) {
    super(`Regionaler Simulationszustand '${worldId}/${regionId}' ist nicht initialisiert.`);
    this.name = "RegionalSimulationUnavailableError";
  }
}

export class RegionalSimulationConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "regional_simulation_conflict";

  constructor(detail: string) {
    super(detail);
    this.name = "RegionalSimulationConflictError";
  }
}

export class RegionalSimulationSequenceError extends Error {
  readonly statusCode = 503;
  readonly code = "regional_simulation_sequence_gap";

  constructor(detail: string) {
    super(detail);
    this.name = "RegionalSimulationSequenceError";
  }
}

function readyKey(worldId: string, regionId: string): string {
  return `${worldId}\u0000${regionId}`;
}

function validDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) throw new RangeError(`${name} ist ungueltig.`);
}

function record(value: unknown, detail: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RegionalSimulationSequenceError(detail);
  }
  return value as Readonly<Record<string, unknown>>;
}

function nonnegativeInteger(value: unknown, detail: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RegionalSimulationSequenceError(detail);
  }
  return value as number;
}

function operationalNowMs(state: OperationalSimulationState): number {
  return nonnegativeInteger(
    state.world["nowMs"],
    "Persistierter operativer Zustand besitzt keine gueltige Weltzeit.",
  );
}

function persistedState(row: RegionalSimulationStateRow): OperationalSimulationState {
  const state = record(row.state, "Persistierter operativer Rust-Zustand ist kein Objekt.");
  const world = record(
    state["world"],
    "Persistierter operativer Rust-Zustand besitzt keine Welt.",
  );
  if (
    row.stateSchema !== OPERATIONAL_SIMULATION_STATE_SCHEMA
    || state["schemaVersion"] !== OPERATIONAL_SIMULATION_STATE_SCHEMA
    || typeof row.initializationHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(row.initializationHash)
    || state["initializationHash"] !== row.initializationHash
    || world["worldId"] !== row.worldId
    || world["regionId"] !== row.regionId
  ) {
    throw new RegionalSimulationSequenceError(
      "Persistierter operativer Rust-Zustand verletzt Schema-, Welt- oder Regionsbindung.",
    );
  }
  nonnegativeInteger(world["nowMs"], "Persistierte operative Weltzeit ist ungueltig.");
  const commitSequence = nonnegativeInteger(
    world["commitSequence"],
    "Persistierter operativer Commit ist ungueltig.",
  );
  nonnegativeInteger(world["eventSequence"], "Persistierte operative Ereignissequenz ist ungueltig.");
  const revision = nonnegativeInteger(state["revision"], "Persistierte operative Revision ist ungueltig.");
  const publisherSequence = nonnegativeInteger(
    state["publisherSequence"],
    "Persistierte operative Publishersequenz ist ungueltig.",
  );
  if (
    !Number.isSafeInteger(row.revision)
    || !Number.isSafeInteger(row.publisherSequence)
    || row.revision < 0
    || row.publisherSequence < 0
    || revision !== row.revision
    || publisherSequence !== row.publisherSequence
    || revision !== publisherSequence
    || commitSequence !== revision
  ) {
    throw new RegionalSimulationSequenceError(
      "Persistierter operativer Rust-Zustand besitzt eine Revisions- oder Publisher-Luecke.",
    );
  }
  if (
    !/^[a-f0-9]{64}$/u.test(row.stateHash)
    || state["stateHash"] !== row.stateHash
  ) {
    throw new RegionalSimulationSequenceError("Persistierter operativer Zustandshash ist ungueltig.");
  }
  const receipts = record(
    state["commandReceipts"],
    "Persistierter operativer Zustand besitzt keine Kommandoquittungen.",
  );
  if (Object.keys(receipts).length !== revision) {
    throw new RegionalSimulationSequenceError(
      "Persistierter operativer Zustand besitzt keine lueckenlose Kommandohistorie.",
    );
  }
  if (!Array.isArray(world["events"]) || world["events"].length !== 0) {
    throw new RegionalSimulationSequenceError(
      "Persistierter operativer Zustand ist kein kompakter Checkpoint.",
    );
  }
  return state as OperationalSimulationState;
}

function assertProjectionPair(
  state: OperationalSimulationState,
  liveMap: OperationalProjection,
  rzue: OperationalProjection,
): void {
  if (
    liveMap.kind !== "live-map"
    || rzue.kind !== "rzue"
    || liveMap.worldId !== state.world.worldId
    || rzue.worldId !== state.world.worldId
    || liveMap.regionId !== state.world.regionId
    || rzue.regionId !== state.world.regionId
    || liveMap.commitSequence !== state.world.commitSequence
    || rzue.commitSequence !== state.world.commitSequence
    || liveMap.atMs !== operationalNowMs(state)
    || rzue.atMs !== operationalNowMs(state)
    || liveMap.atMs !== rzue.atMs
    || liveMap.staleAfterMs !== rzue.staleAfterMs
    || JSON.stringify(liveMap.trains) !== JSON.stringify(rzue.trains)
    || JSON.stringify(liveMap.routeLocks) !== JSON.stringify(rzue.routeLocks)
    || JSON.stringify(liveMap.signals) !== JSON.stringify(rzue.signals)
    || JSON.stringify(liveMap.activeDisruptions) !== JSON.stringify(rzue.activeDisruptions)
  ) {
    throw new RegionalSimulationSequenceError(
      "Operative LiveMap- und RZUE-Projektion stammen nicht aus demselben Commit.",
    );
  }
}

function operationalEvent(value: Readonly<Record<string, unknown>>): OperationalNativeEvent {
  const eventSequence = nonnegativeInteger(
    value["eventSequence"],
    "Operatives Ereignis besitzt keine gueltige Ereignissequenz.",
  );
  if (eventSequence === 0) {
    throw new RegionalSimulationSequenceError("Operative Ereignissequenz muss positiv sein.");
  }
  const commitSequence = nonnegativeInteger(
    value["commitSequence"],
    "Operatives Ereignis besitzt keine gueltige Commitsequenz.",
  );
  const atMs = nonnegativeInteger(
    value["atMs"],
    "Operatives Ereignis besitzt keine gueltige Weltzeit.",
  );
  if (
    typeof value["kind"] !== "string"
    || value["kind"].length === 0
    || typeof value["subjectId"] !== "string"
    || value["subjectId"].length === 0
    || typeof value["detail"] !== "string"
  ) {
    throw new RegionalSimulationSequenceError("Operatives Ereignis verletzt den v2-Vertrag.");
  }
  return {
    eventSequence,
    commitSequence,
    atMs,
    kind: value["kind"],
    subjectId: value["subjectId"],
    detail: value["detail"],
  };
}

function occurredAt(epoch: Date, atMs: number): Date {
  const result = new Date(epoch.getTime() + atMs);
  validDate(result, "Ereigniszeit");
  return result;
}

async function appendEvents(
  db: AnyDatabase,
  worldId: string,
  regionId: string,
  epoch: Date,
  values: readonly Readonly<Record<string, unknown>>[],
  maximumCommitSequence: number,
  contexts: readonly OperationalCommitEventContext[] = [],
) {
  const events = values.map(operationalEvent);
  if (events.length === 0) return [];
  if (
    events.some((event) => event.commitSequence > maximumCommitSequence)
    || events.some((event, index) =>
      index > 0 && event.eventSequence !== events[index - 1]!.eventSequence + 1)
    || events.some((event, index) =>
      index > 0 && event.commitSequence < events[index - 1]!.commitSequence)
  ) {
    throw new RegionalSimulationSequenceError(
      "Operative Fachereignisse verletzen Ereignis- oder Commitreihenfolge.",
    );
  }
  const [head] = await db
    .select({ sequence: domainEvents.sequence })
    .from(domainEvents)
    .where(eq(domainEvents.worldId, worldId))
    .orderBy(desc(domainEvents.sequence))
    .limit(1);
  const firstSequence = (head?.sequence ?? 0) + 1;
  if (
    !Number.isSafeInteger(firstSequence)
    || !Number.isSafeInteger(firstSequence + events.length - 1)
  ) {
    throw new RegionalSimulationSequenceError("Welt-Ereignissequenz ist erschoepft.");
  }
  const operatorIds = events.some((event) =>
    event.kind === "disruption-activated" || event.kind === "disruption-cleared"
  )
    ? (await db.select({ id: operators.id }).from(operators)
      .where(eq(operators.worldId, worldId)))
      .map(({ id }) => id)
      .sort(compareUtf8)
    : [];
  const adapted = adaptOperationalDomainEvents(events, contexts, operatorIds, regionId);
  const rows = events.map((event, index) => ({
    worldId,
    sequence: firstSequence + index,
    eventType: adapted[index]!.eventType,
    payload: adapted[index]!.payload,
    occurredAt: occurredAt(epoch, event.atMs),
  }));
  const appended: Array<typeof domainEvents.$inferSelect> = [];
  for (let offset = 0; offset < rows.length; offset += 500) {
    appended.push(
      ...await db.insert(domainEvents).values(rows.slice(offset, offset + 500)).returning(),
    );
  }
  appended.sort((left, right) => left.sequence - right.sequence);
  for (const event of appended.filter((item) =>
    item.eventType === "disruption.applied" || item.eventType === "disruption.cleared"
  )) {
    const payload = event.payload as Readonly<Record<string, unknown>>;
    const operatorIds = Array.isArray(payload["operatorIds"])
      ? payload["operatorIds"].filter((value): value is string => typeof value === "string")
      : [];
    if (operatorIds.length === 0) continue;
    const recipients = await db.select({ accountId: operators.foundingAccountId })
      .from(operators)
      .where(and(eq(operators.worldId, worldId), inArray(operators.id, operatorIds)));
    if (recipients.length === 0) continue;
    await db.insert(mailboxMessages).values(recipients.map(({ accountId }) => ({
      worldId,
      recipientAccountId: accountId,
      idempotencyKey: `disruption:${event.eventType}:${event.sequence}`,
      messageType: event.eventType,
      payload,
      sentAt: event.occurredAt,
    }))).onConflictDoNothing({
      target: [mailboxMessages.worldId, mailboxMessages.recipientAccountId, mailboxMessages.idempotencyKey],
    });
  }
  return appended;
}

/**
 * Persistenter operativer v2-Single-Writer vor LiveMap und RZUE.
 *
 * Native Simulation und DB-CAS laufen unter derselben Regionssperre. Beide
 * Projektionen werden erst nach dem erfolgreichen Commit gemeinsam sichtbar.
 */
export class RegionalSimulationWorker {
  readonly #db: AnyDatabase;
  readonly #runtime: OperationalSimulationRuntime;
  readonly #livemap: LivemapRegistry;
  readonly #operations: OperationsRegistry | undefined;
  readonly #readyRegions = new Map<string, RegionalSimulationReadyRegion>();
  readonly #expectedInitializationHashes = new Map<string, string>();
  readonly #releasedWorldIds = new Set<string>();

  constructor(
    db: AnyDatabase,
    runtime: OperationalSimulationRuntime,
    livemap: LivemapRegistry,
    operations?: OperationsRegistry,
  ) {
    this.#db = db;
    this.#runtime = runtime;
    this.#livemap = livemap;
    this.#operations = operations;
  }

  isReady(worldId: string, regionId: string, expectedInitializationHash?: string): boolean {
    const ready = this.#readyRegions.get(readyKey(worldId, regionId));
    return ready !== undefined
      && (expectedInitializationHash === undefined
        || ready.initializationHash === expectedInitializationHash);
  }

  readyRegions(): readonly RegionalSimulationReadyRegion[] {
    return [...this.#readyRegions.values()].sort(
      (left, right) =>
        compareUtf8(left.worldId, right.worldId)
        || compareUtf8(left.regionId, right.regionId),
    );
  }

  releaseWorld(worldId: string): void {
    this.#releasedWorldIds.add(worldId);
    this.#clearWorldReady(worldId);
    for (const key of this.#expectedInitializationHashes.keys()) {
      if (key.startsWith(`${worldId}\u0000`)) this.#expectedInitializationHashes.delete(key);
    }
    this.#livemap.releaseWorld(worldId);
    this.#operations?.releaseWorld(worldId);
  }

  #assertNotReleased(worldId: string, regionId: string): void {
    if (this.#releasedWorldIds.has(worldId)) {
      throw new RegionalSimulationUnavailableError(worldId, regionId);
    }
  }

  #markLivemapUnavailable(worldId: string): void {
    if (this.#releasedWorldIds.has(worldId)) this.#livemap.releaseWorld(worldId);
    else this.#livemap.markUnavailable(worldId);
  }

  #markReady(state: OperationalSimulationState): void {
    this.#assertNotReleased(state.world.worldId, state.world.regionId);
    this.#readyRegions.set(
      readyKey(state.world.worldId, state.world.regionId),
      Object.freeze({
        worldId: state.world.worldId,
        regionId: state.world.regionId,
        nowMs: operationalNowMs(state),
        initializationHash: state.initializationHash,
      }),
    );
  }

  #registerExpectedInitializationHash(
    worldId: string,
    regionId: string,
    expectedInitializationHash: string,
  ): void {
    if (!/^[a-f0-9]{64}$/u.test(expectedInitializationHash)) {
      throw new RegionalSimulationSequenceError(
        "Erwarteter operativer Initialisierungshash ist ungueltig.",
      );
    }
    const key = readyKey(worldId, regionId);
    const existing = this.#expectedInitializationHashes.get(key);
    if (existing !== undefined && existing !== expectedInitializationHash) {
      throw new RegionalSimulationSequenceError(
        `Operative Initialisierungsbindung fuer '${worldId}/${regionId}' steht im Konflikt.`,
      );
    }
    this.#expectedInitializationHashes.set(key, expectedInitializationHash);
  }

  #expectedInitializationHash(worldId: string, regionId: string): string {
    const expected = this.#expectedInitializationHashes.get(readyKey(worldId, regionId));
    if (expected === undefined) {
      throw new RegionalSimulationSequenceError(
        `Signierte operative Initialisierungsbindung fuer '${worldId}/${regionId}' fehlt.`,
      );
    }
    return expected;
  }

  #assertPersistedInitializationBinding(
    row: RegionalSimulationStateRow,
    expectedInitializationHash: string,
  ): void {
    if (row.initializationHash !== expectedInitializationHash) {
      throw new RegionalSimulationSequenceError(
        `Persistierter operativer Zustand '${row.worldId}/${row.regionId}' gehoert zu einer anderen Initialisierung.`,
      );
    }
  }

  #clearWorldReady(worldId: string): void {
    for (const [key, region] of this.#readyRegions) {
      if (region.worldId === worldId) this.#readyRegions.delete(key);
    }
  }

  async #replayOperations(worldId: string): Promise<void> {
    if (this.#operations === undefined) return;
    const events = await worldEventLog(this.#db, worldId).listOfTypes(
      OPERATIONS_DECISION_EVENT_TYPES,
    );
    for (const event of events) {
      for (const operatorId of operationsEventOperatorIds(event)) {
        const decision = projectOperations([event], operatorId).decisions[0];
        if (decision === undefined) continue;
        this.#operations.forOperator(worldId, operatorId).publish({
          worldId,
          operatorId,
          sequence: event.sequence,
          decision,
        });
      }
    }
  }

  #publishOperations(
    worldId: string,
    events: readonly (typeof domainEvents.$inferSelect)[],
  ): void {
    for (const event of events) {
      for (const operatorId of operationsEventOperatorIds(event)) {
        const decision = projectOperations([event], operatorId).decisions[0];
        if (decision === undefined) continue;
        this.#operations?.forOperator(worldId, operatorId).publish({
          worldId,
          operatorId,
          sequence: event.sequence,
          decision,
        });
      }
    }
  }

  async #rebuildWorldFeed(worldId: string): Promise<void> {
    this.#assertNotReleased(worldId, "*");
    this.#clearWorldReady(worldId);
    this.#livemap.markUnavailable(worldId);
    try {
      const rows = await this.#db
        .select()
        .from(regionalSimulationStates)
        .where(eq(regionalSimulationStates.worldId, worldId));
      if (rows.length === 0) {
        throw new RegionalSimulationUnavailableError(worldId, "*");
      }
      const restored = rows.map((row) => {
        const state = persistedState(row);
        const expectedInitializationHash = this.#expectedInitializationHash(
          row.worldId,
          row.regionId,
        );
        this.#assertPersistedInitializationBinding(row, expectedInitializationHash);
        const result = this.#runtime.restore(state, expectedInitializationHash);
        assertProjectionPair(result.state, result.liveMap, result.rzue);
        if (
          result.initializationHash !== expectedInitializationHash
          || result.state.initializationHash !== expectedInitializationHash
          || result.stateHash !== row.stateHash
          || result.state.revision !== row.revision
          || result.state.publisherSequence !== row.publisherSequence
        ) {
          throw new RegionalSimulationSequenceError(
            "Operativer Rust-Restore stimmt nicht mit dem persistierten Kopf ueberein.",
          );
        }
        return result;
      }).sort((left, right) => {
        const time = operationalNowMs(left.state) - operationalNowMs(right.state);
        return time || compareUtf8(left.state.world.regionId, right.state.world.regionId);
      });
      for (const result of restored) {
        this.#livemap.initializeRegion(
          worldId,
          result.state.world.regionId,
          projectOperationalLivemap(result.liveMap),
        );
      }
      await this.#replayOperations(worldId);
      for (const result of restored) this.#markReady(result.state);
    } catch (error) {
      this.#clearWorldReady(worldId);
      this.#markLivemapUnavailable(worldId);
      throw error;
    }
  }

  async initialize(
    input: OperationalSimulationInitialization,
    persistedAt: Date,
  ): Promise<OperationalSimulationInitialized> {
    validDate(persistedAt, "Persistenzzeit");
    this.#assertNotReleased(input.worldId, input.regionId);
    const expectedInitializationHash = operationalSimulationInitializationHash(input);
    const initialized = this.#runtime.initialize(input);
    assertProjectionPair(initialized.state, initialized.liveMap, initialized.rzue);
    if (
      initialized.initializationHash !== expectedInitializationHash
      || initialized.state.initializationHash !== expectedInitializationHash
    ) {
      throw new RegionalSimulationSequenceError(
        "Native operative Initialisierung stimmt nicht mit dem signierten Initialisierungsvertrag ueberein.",
      );
    }
    await this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${input.worldId} for update`,
      );
      const [world] = await tx
        .select({ epoch: worlds.epoch })
        .from(worlds)
        .where(eq(worlds.id, input.worldId))
        .limit(1);
      if (world === undefined) {
        throw new RegionalSimulationUnavailableError(input.worldId, input.regionId);
      }
      const existingRegions = await tx
        .select()
        .from(regionalSimulationStates)
        .where(eq(regionalSimulationStates.worldId, input.worldId));
      if (existingRegions.some((row) => row.regionId === input.regionId)) {
        throw new RegionalSimulationConflictError(
          `Region '${input.worldId}/${input.regionId}' ist bereits initialisiert.`,
        );
      }
      const latestWorldAtMs = existingRegions.reduce(
        (latest, row) => Math.max(latest, operationalNowMs(persistedState(row))),
        0,
      );
      if (initialized.liveMap.atMs < latestWorldAtMs) {
        throw new RegionalSimulationConflictError(
          `Regionsinitialisierung bei ${initialized.liveMap.atMs} ms liegt vor der LiveMap-Weltzeit ${latestWorldAtMs} ms.`,
        );
      }
      await tx.insert(regionalSimulationStates).values({
        worldId: input.worldId,
        regionId: input.regionId,
        stateSchema: OPERATIONAL_SIMULATION_STATE_SCHEMA,
        state: initialized.state,
        initializationHash: initialized.initializationHash,
        stateHash: initialized.stateHash,
        revision: initialized.state.revision,
        publisherSequence: initialized.state.publisherSequence,
        createdAt: persistedAt,
        updatedAt: persistedAt,
      });
      await appendEvents(
        tx,
        input.worldId,
        input.regionId,
        world.epoch,
        initialized.events,
        initialized.state.world.commitSequence,
      );
    });

    try {
      this.#registerExpectedInitializationHash(
        input.worldId,
        input.regionId,
        expectedInitializationHash,
      );
      this.#assertNotReleased(input.worldId, input.regionId);
      this.#livemap.initializeRegion(
        input.worldId,
        input.regionId,
        projectOperationalLivemap(initialized.liveMap),
      );
      this.#markReady(initialized.state);
      return initialized;
    } catch (error) {
      this.#readyRegions.delete(readyKey(input.worldId, input.regionId));
      this.#markLivemapUnavailable(input.worldId);
      throw error;
    }
  }

  async restore(
    worldId: string,
    regionId: string,
    expectedInitializationHash: string,
  ): Promise<OperationalSimulationRestored> {
    this.#assertNotReleased(worldId, regionId);
    try {
      this.#registerExpectedInitializationHash(worldId, regionId, expectedInitializationHash);
      const [row] = await this.#db
        .select()
        .from(regionalSimulationStates)
        .where(and(
          eq(regionalSimulationStates.worldId, worldId),
          eq(regionalSimulationStates.regionId, regionId),
        ))
        .limit(1);
      if (row === undefined) throw new RegionalSimulationUnavailableError(worldId, regionId);
      const state = persistedState(row);
      this.#assertPersistedInitializationBinding(row, expectedInitializationHash);
      const restored = this.#runtime.restore(state, expectedInitializationHash);
      assertProjectionPair(restored.state, restored.liveMap, restored.rzue);
      if (
        restored.initializationHash !== expectedInitializationHash
        || restored.state.initializationHash !== expectedInitializationHash
        || restored.stateHash !== row.stateHash
        || restored.state.revision !== row.revision
        || restored.state.publisherSequence !== row.publisherSequence
      ) {
        throw new RegionalSimulationSequenceError(
          "Operativer Rust-Restore stimmt nicht mit dem persistierten Kopf ueberein.",
        );
      }
      this.#assertNotReleased(worldId, regionId);
      this.#livemap.initializeRegion(
        worldId,
        regionId,
        projectOperationalLivemap(restored.liveMap),
      );
      await this.#replayOperations(worldId);
      this.#markReady(restored.state);
      return restored;
    } catch (error) {
      this.#readyRegions.delete(readyKey(worldId, regionId));
      this.#markLivemapUnavailable(worldId);
      throw error;
    }
  }

  async recover(
    worldId: string,
    regionId: string,
    expectedInitializationHash: string,
  ): Promise<RegionalSimulationReadyRegion> {
    this.#registerExpectedInitializationHash(worldId, regionId, expectedInitializationHash);
    await this.#rebuildWorldFeed(worldId);
    const recovered = this.#readyRegions.get(readyKey(worldId, regionId));
    if (recovered === undefined) {
      this.#clearWorldReady(worldId);
      this.#markLivemapUnavailable(worldId);
      throw new RegionalSimulationUnavailableError(worldId, regionId);
    }
    return recovered;
  }

  async apply(
    work: RegionalSimulationWorkCommand,
    persistedAt: Date,
  ): Promise<OperationalSimulationResult> {
    validDate(persistedAt, "Persistenzzeit");
    const key = readyKey(work.worldId, work.regionId);
    if (!this.#readyRegions.has(key)) {
      throw new RegionalSimulationUnavailableError(work.worldId, work.regionId);
    }

    const committed = await this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${work.worldId} for update`,
      );
      const [world] = await tx.select({ epoch: worlds.epoch }).from(worlds)
        .where(eq(worlds.id, work.worldId)).limit(1);
      if (world === undefined) {
        throw new RegionalSimulationUnavailableError(work.worldId, work.regionId);
      }
      await tx.execute(sql`
        select ${regionalSimulationStates.worldId}
        from ${regionalSimulationStates}
        where ${regionalSimulationStates.worldId} = ${work.worldId}
          and ${regionalSimulationStates.regionId} = ${work.regionId}
        for update
      `);
      const [row] = await tx.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, work.worldId),
        eq(regionalSimulationStates.regionId, work.regionId),
      )).limit(1);
      if (row === undefined) {
        throw new RegionalSimulationUnavailableError(work.worldId, work.regionId);
      }
      const state = persistedState(row);
      this.#assertPersistedInitializationBinding(
        row,
        this.#expectedInitializationHash(work.worldId, work.regionId),
      );
      const result = await this.#runtime.apply(state, {
        schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
        worldId: work.worldId,
        regionId: work.regionId,
        commandId: work.commandId,
        expectedStateHash: row.stateHash,
        expectedRevision: row.revision,
        expectedPublisherSequence: row.publisherSequence,
        command: work.command,
      });
      assertProjectionPair(result.state, result.liveMap, result.rzue);
      if (
        result.initializationHash !== row.initializationHash
        || result.state.initializationHash !== row.initializationHash
      ) {
        throw new RegionalSimulationSequenceError(
          "Operativer Rust-Uebergang wechselte seine Initialisierungsbindung.",
        );
      }
      if (result.idempotentReplay) {
        if (
          result.stateHash !== row.stateHash
          || result.state.revision !== row.revision
          || result.state.publisherSequence !== row.publisherSequence
          || result.events.length !== 0
        ) {
          throw new RegionalSimulationSequenceError(
            "Idempotenter operativer Rust-Replay veraenderte den persistierten Kopf.",
          );
        }
        return { result, fanout: false, appendedEvents: [] };
      }
      const worldRegions = await tx.select().from(regionalSimulationStates)
        .where(eq(regionalSimulationStates.worldId, work.worldId));
      const latestWorldAtMs = worldRegions.reduce(
        (latest, regionalRow) => Math.max(latest, operationalNowMs(persistedState(regionalRow))),
        0,
      );
      if (result.liveMap.atMs < latestWorldAtMs) {
        throw new RegionalSimulationConflictError(
          `Operativer Regionscommit bei ${result.liveMap.atMs} ms liegt vor der LiveMap-Weltzeit ${latestWorldAtMs} ms.`,
        );
      }
      if (
        result.state.revision !== row.revision + 1
        || result.state.publisherSequence !== row.publisherSequence + 1
        || result.state.world.commitSequence !== state.world.commitSequence + 1
      ) {
        throw new RegionalSimulationSequenceError(
          "Operativer Rust-Uebergang erzeugte eine Revisions- oder Publisher-Luecke.",
        );
      }
      const updated = await tx.update(regionalSimulationStates).set({
        stateSchema: OPERATIONAL_SIMULATION_STATE_SCHEMA,
        state: result.state,
        stateHash: result.stateHash,
        revision: result.state.revision,
        publisherSequence: result.state.publisherSequence,
        updatedAt: persistedAt,
      }).where(and(
        eq(regionalSimulationStates.worldId, work.worldId),
        eq(regionalSimulationStates.regionId, work.regionId),
        eq(regionalSimulationStates.initializationHash, row.initializationHash),
        eq(regionalSimulationStates.stateHash, row.stateHash),
        eq(regionalSimulationStates.revision, row.revision),
        eq(regionalSimulationStates.publisherSequence, row.publisherSequence),
      )).returning({ stateHash: regionalSimulationStates.stateHash });
      if (updated.length !== 1) {
        throw new RegionalSimulationConflictError(
          "Regionaler operativer Simulationskopf wurde gleichzeitig veraendert.",
        );
      }
      const appendedEvents = await appendEvents(
        tx,
        work.worldId,
        work.regionId,
        world.epoch,
        result.events,
        result.state.world.commitSequence,
        [{
          commitSequence: result.state.world.commitSequence,
          command: work.command,
          stateBefore: state,
          projectionAfter: result.liveMap,
        }],
      );
      return { result, fanout: true, appendedEvents };
    });

    this.#assertNotReleased(work.worldId, work.regionId);
    if (!committed.fanout) {
      this.#markReady(committed.result.state);
      return committed.result;
    }
    try {
      this.#publishOperations(work.worldId, committed.appendedEvents);
      const published = this.#livemap.publishOperationalRegionSnapshot(
        work.worldId,
        work.regionId,
        projectOperationalLivemap(committed.result.liveMap),
      );
      if (published === undefined) await this.#rebuildWorldFeed(work.worldId);
      else this.#markReady(committed.result.state);
      return committed.result;
    } catch (error) {
      this.#readyRegions.delete(key);
      this.#markLivemapUnavailable(work.worldId);
      throw error;
    }
  }

  /**
   * Fuehrt einen Scheduler-Chunk nativ sequenziell, aber unter genau einer
   * Welt-/Regionssperre und einem DB-Commit aus. Ein Fehler verwirft den ganzen
   * Chunk. Der Post-Commit-Fanout veroeffentlicht danach jeden nicht-idempotenten
   * Runtime-Commit lueckenlos mit genau einer Publishersequenz je Commit.
   */
  async applyBatch(
    work: RegionalSimulationWorkBatch,
    persistedAt: Date,
  ): Promise<OperationalSimulationBatchResult> {
    validDate(persistedAt, "Persistenzzeit");
    if (work.commands.length === 0) {
      throw new RangeError("Operative Simulationsgruppe darf nicht leer sein.");
    }
    if (work.commands.length > OPERATIONAL_COMMAND_BATCH_LIMIT) {
      throw new RangeError(
        `Operative Simulationsgruppe darf hoechstens ${OPERATIONAL_COMMAND_BATCH_LIMIT} Kommandos enthalten.`,
      );
    }
    const key = readyKey(work.worldId, work.regionId);
    if (!this.#readyRegions.has(key)) {
      throw new RegionalSimulationUnavailableError(work.worldId, work.regionId);
    }

    const committed = await this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${work.worldId} for update`,
      );
      const [world] = await tx.select({ epoch: worlds.epoch }).from(worlds)
        .where(eq(worlds.id, work.worldId)).limit(1);
      if (world === undefined) {
        throw new RegionalSimulationUnavailableError(work.worldId, work.regionId);
      }
      await tx.execute(sql`
        select ${regionalSimulationStates.worldId}
        from ${regionalSimulationStates}
        where ${regionalSimulationStates.worldId} = ${work.worldId}
          and ${regionalSimulationStates.regionId} = ${work.regionId}
        for update
      `);
      const [row] = await tx.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, work.worldId),
        eq(regionalSimulationStates.regionId, work.regionId),
      )).limit(1);
      if (row === undefined) {
        throw new RegionalSimulationUnavailableError(work.worldId, work.regionId);
      }

      let state = persistedState(row);
      this.#assertPersistedInitializationBinding(
        row,
        this.#expectedInitializationHash(work.worldId, work.regionId),
      );
      let stateHash = row.stateHash;
      let finalResult: OperationalSimulationResult | undefined;
      const events: Readonly<Record<string, unknown>>[] = [];
      const eventContexts: OperationalCommitEventContext[] = [];
      const commandResults: Array<{ commandId: string; idempotentReplay: boolean }> = [];
      const fanoutProjections: OperationalProjection[] = [];
      for (const item of work.commands) {
        const previousState = state;
        const previousStateHash = stateHash;
        const result = await this.#runtime.apply(state, {
          schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
          worldId: work.worldId,
          regionId: work.regionId,
          commandId: item.commandId,
          expectedStateHash: stateHash,
          expectedRevision: state.revision,
          expectedPublisherSequence: state.publisherSequence,
          command: item.command,
        });
        assertProjectionPair(result.state, result.liveMap, result.rzue);
        if (
          result.initializationHash !== row.initializationHash
          || result.state.initializationHash !== row.initializationHash
        ) {
          throw new RegionalSimulationSequenceError(
            "Operative Kommandogruppe wechselte ihre Initialisierungsbindung.",
          );
        }
        if (result.idempotentReplay) {
          if (
            result.stateHash !== previousStateHash
            || result.state.revision !== previousState.revision
            || result.state.publisherSequence !== previousState.publisherSequence
            || result.events.length !== 0
          ) {
            throw new RegionalSimulationSequenceError(
              "Idempotenter operativer Gruppenreplay veraenderte den Zwischenkopf.",
            );
          }
        } else {
          events.push(...result.events);
          eventContexts.push({
            commitSequence: result.state.world.commitSequence,
            command: item.command,
            stateBefore: previousState,
            projectionAfter: result.liveMap,
          });
          fanoutProjections.push(result.liveMap);
        }
        commandResults.push({
          commandId: item.commandId,
          idempotentReplay: result.idempotentReplay,
        });
        state = result.state;
        stateHash = result.stateHash;
        finalResult = result;
      }
      if (finalResult === undefined) {
        throw new RegionalSimulationSequenceError("Operative Kommandogruppe lieferte kein Ergebnis.");
      }
      const appliedCount = commandResults.filter((result) => !result.idempotentReplay).length;
      if (
        state.revision !== row.revision + appliedCount
        || state.publisherSequence !== row.publisherSequence + appliedCount
        || state.world.commitSequence
          !== (persistedState(row).world.commitSequence + appliedCount)
      ) {
        throw new RegionalSimulationSequenceError(
          "Operative Kommandogruppe erzeugte eine Revisions- oder Publisher-Luecke.",
        );
      }
      const result: OperationalSimulationBatchResult = {
        state,
        stateHash,
        liveMap: finalResult.liveMap,
        rzue: finalResult.rzue,
        events,
        commandResults,
      };
      if (appliedCount === 0) {
        if (stateHash !== row.stateHash || events.length !== 0) {
          throw new RegionalSimulationSequenceError(
            "Idempotenter operativer Gruppenreplay veraenderte den persistierten Kopf.",
          );
        }
        return { result, fanout: false, appendedEvents: [], fanoutProjections: [] };
      }

      const worldRegions = await tx.select().from(regionalSimulationStates)
        .where(eq(regionalSimulationStates.worldId, work.worldId));
      const latestWorldAtMs = worldRegions.reduce(
        (latest, regionalRow) => Math.max(latest, operationalNowMs(persistedState(regionalRow))),
        0,
      );
      if (result.liveMap.atMs < latestWorldAtMs) {
        throw new RegionalSimulationConflictError(
          `Operativer Regionssnapshot bei ${result.liveMap.atMs} ms liegt vor der LiveMap-Weltzeit ${latestWorldAtMs} ms.`,
        );
      }
      const updated = await tx.update(regionalSimulationStates).set({
        stateSchema: OPERATIONAL_SIMULATION_STATE_SCHEMA,
        state,
        stateHash,
        revision: state.revision,
        publisherSequence: state.publisherSequence,
        updatedAt: persistedAt,
      }).where(and(
        eq(regionalSimulationStates.worldId, work.worldId),
        eq(regionalSimulationStates.regionId, work.regionId),
        eq(regionalSimulationStates.initializationHash, row.initializationHash),
        eq(regionalSimulationStates.stateHash, row.stateHash),
        eq(regionalSimulationStates.revision, row.revision),
        eq(regionalSimulationStates.publisherSequence, row.publisherSequence),
      )).returning({ stateHash: regionalSimulationStates.stateHash });
      if (updated.length !== 1) {
        throw new RegionalSimulationConflictError(
          "Regionaler operativer Simulationskopf wurde gleichzeitig veraendert.",
        );
      }
      const appendedEvents = await appendEvents(
        tx,
        work.worldId,
        work.regionId,
        world.epoch,
        events,
        state.world.commitSequence,
        eventContexts,
      );
      return { result, fanout: true, appendedEvents, fanoutProjections };
    });

    this.#assertNotReleased(work.worldId, work.regionId);
    if (!committed.fanout) {
      this.#markReady(committed.result.state);
      return committed.result;
    }
    try {
      this.#publishOperations(work.worldId, committed.appendedEvents);
      let rebuilt = false;
      for (const projection of committed.fanoutProjections) {
        const published = this.#livemap.publishOperationalRegionSnapshot(
          work.worldId,
          work.regionId,
          projectOperationalLivemap(projection),
        );
        if (published === undefined) {
          await this.#rebuildWorldFeed(work.worldId);
          rebuilt = true;
          break;
        }
      }
      if (!rebuilt) this.#markReady(committed.result.state);
      return committed.result;
    } catch (error) {
      this.#readyRegions.delete(key);
      this.#markLivemapUnavailable(work.worldId);
      throw error;
    }
  }
}
