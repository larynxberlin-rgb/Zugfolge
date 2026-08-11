import {
  domainEvents,
  mailboxMessages,
  operators,
  regionalSimulationStates,
  worlds,
  type RegionalSimulationStateRow,
} from "@zugfolge/db";
import { projectOperations, type OperationsRegistry } from "@zugfolge/dispatch";
import type { LivemapRegistry } from "@zugfolge/livemap-stream";
import {
  REGIONAL_SIMULATION_COMMAND_SCHEMA,
  REGIONAL_SIMULATION_STATE_SCHEMA,
  type RegionalSimulationCommandPayload,
  type RegionalSimulationInitialization,
  type RegionalSimulationInitialized,
  type RegionalSimulationRestored,
  type RegionalSimulationRuntime,
  type RegionalSimulationState,
  type RegionalSimulationEvent,
  type RegionalSimulationResult,
} from "@zugfolge/runtime-native";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { compareUtf8 } from "./utf8.js";

type AnyDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

export interface RegionalSimulationWorkCommand {
  readonly worldId: string;
  readonly regionId: string;
  readonly commandId: string;
  readonly command: RegionalSimulationCommandPayload;
}

export interface RegionalSimulationReadyRegion {
  readonly worldId: string;
  readonly regionId: string;
  readonly nowS: number;
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

function persistedState(row: RegionalSimulationStateRow): RegionalSimulationState {
  const value = row.state;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RegionalSimulationSequenceError("Persistierter Rust-Zustand ist kein Objekt.");
  }
  const state = value as Readonly<Record<string, unknown>>;
  if (
    row.stateSchema !== REGIONAL_SIMULATION_STATE_SCHEMA ||
    state["schemaVersion"] !== REGIONAL_SIMULATION_STATE_SCHEMA ||
    state["worldId"] !== row.worldId ||
    state["regionId"] !== row.regionId
  ) {
    throw new RegionalSimulationSequenceError(
      "Persistierter Rust-Zustand verletzt Schema-, Welt- oder Regionsbindung.",
    );
  }
  if (
    !Number.isSafeInteger(row.revision) ||
    !Number.isSafeInteger(row.publisherSequence) ||
    row.revision < 0 ||
    row.publisherSequence < 0 ||
    state["revision"] !== row.revision ||
    state["publisherSequence"] !== row.publisherSequence ||
    !Array.isArray(state["commands"]) ||
    state["commands"].length !== row.revision
  ) {
    throw new RegionalSimulationSequenceError(
      "Persistierter Rust-Zustand besitzt eine Sequenzluecke.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(row.stateHash)) {
    throw new RegionalSimulationSequenceError("Persistierter Zustandshash ist ungueltig.");
  }
  return state as RegionalSimulationState;
}

function occurredAt(epoch: Date, atS: number): Date {
  const result = new Date(epoch.getTime() + atS * 1_000);
  validDate(result, "Ereigniszeit");
  return result;
}

async function appendEvents(
  db: AnyDatabase,
  worldId: string,
  epoch: Date,
  events: readonly RegionalSimulationEvent[],
){
  if (events.length === 0) return [];
  const [head] = await db
    .select({ sequence: domainEvents.sequence })
    .from(domainEvents)
    .where(eq(domainEvents.worldId, worldId))
    .orderBy(desc(domainEvents.sequence))
    .limit(1);
  const firstSequence = (head?.sequence ?? 0) + 1;
  if (
    !Number.isSafeInteger(firstSequence) ||
    !Number.isSafeInteger(firstSequence + events.length - 1)
  ) {
    throw new RegionalSimulationSequenceError("Welt-Ereignissequenz ist erschoepft.");
  }
  const appended = await db.insert(domainEvents).values(
    events.map((event, index) => ({
      worldId,
      sequence: firstSequence + index,
      eventType: event.eventType,
      payload: {
        ...event.payload,
        schemaVersion: "zugfolge-regional-simulation-event/v1",
        nativeEventId: event.eventId,
        regionId: event.regionId,
        simulationSequence: event.simulationSequence,
      },
      occurredAt: occurredAt(epoch, event.atS),
    })),
  ).returning();
  for (const event of appended.filter((item) => item.eventType === "disruption.applied")) {
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
      idempotencyKey: `disruption:${event.sequence}`,
      messageType: "disruption.applied",
      payload,
      sentAt: event.occurredAt,
    }))).onConflictDoNothing({
      target: [mailboxMessages.worldId, mailboxMessages.recipientAccountId, mailboxMessages.idempotencyKey],
    });
  }
  return appended;
}

/**
 * Persistenter M4-Single-Writer vor der oeffentlichen Livemap.
 *
 * Native Simulation und DB-Update laufen unter derselben Regionssperre. Der
 * In-Process-Fanout liegt absichtlich hinter dem erfolgreichen Commit.
 */
export class RegionalSimulationWorker {
  readonly #db: AnyDatabase;
  readonly #runtime: RegionalSimulationRuntime;
  readonly #livemap: LivemapRegistry;
  readonly #operations: OperationsRegistry | undefined;
  readonly #readyRegions = new Map<string, RegionalSimulationReadyRegion>();

  constructor(
    db: AnyDatabase,
    runtime: RegionalSimulationRuntime,
    livemap: LivemapRegistry,
    operations?: OperationsRegistry,
  ) {
    this.#db = db;
    this.#runtime = runtime;
    this.#livemap = livemap;
    this.#operations = operations;
  }

  isReady(worldId: string, regionId: string): boolean {
    return this.#readyRegions.has(readyKey(worldId, regionId));
  }

  readyRegions(): readonly RegionalSimulationReadyRegion[] {
    return [...this.#readyRegions.values()].sort(
      (left, right) =>
        compareUtf8(left.worldId, right.worldId) ||
        compareUtf8(left.regionId, right.regionId),
    );
  }

  #markReady(state: RegionalSimulationState): void {
    this.#readyRegions.set(
      readyKey(state.worldId, state.regionId),
      Object.freeze({
        worldId: state.worldId,
        regionId: state.regionId,
        nowS: state.nowS,
      }),
    );
  }

  #clearWorldReady(worldId: string): void {
    for (const [key, region] of this.#readyRegions) {
      if (region.worldId === worldId) this.#readyRegions.delete(key);
    }
  }

  async #rebuildWorldFeed(worldId: string): Promise<void> {
    const rows = await this.#db
      .select()
      .from(regionalSimulationStates)
      .where(eq(regionalSimulationStates.worldId, worldId));
    if (rows.length === 0) {
      throw new RegionalSimulationUnavailableError(worldId, "*");
    }
    const restored = rows.map((row) => {
      const state = persistedState(row);
      const result = this.#runtime.restore(state);
      if (
        result.stateHash !== row.stateHash ||
        result.state.revision !== row.revision ||
        result.state.publisherSequence !== row.publisherSequence
      ) {
        throw new RegionalSimulationSequenceError(
          "Rust-Restore stimmt nicht mit dem persistierten Kopf ueberein.",
        );
      }
      return result;
    }).sort((left, right) => {
      if (left.snapshot.atS !== right.snapshot.atS) {
        return left.snapshot.atS < right.snapshot.atS ? -1 : 1;
      }
      return compareUtf8(left.state.regionId, right.state.regionId);
    });
    try {
      this.#livemap.markUnavailable(worldId);
      for (const result of restored) {
        this.#livemap.initializeRegion(worldId, result.state.regionId, {
          at: result.snapshot.atS,
          trains: result.snapshot.trains,
          disruptions: result.snapshot.disruptions,
        });
        this.#markReady(result.state);
      }
    } catch (error) {
      this.#clearWorldReady(worldId);
      this.#livemap.markUnavailable(worldId);
      throw error;
    }
  }

  async initialize(
    input: RegionalSimulationInitialization,
    persistedAt: Date,
  ): Promise<RegionalSimulationInitialized> {
    validDate(persistedAt, "Persistenzzeit");
    const initialized = this.#runtime.initialize(input);
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
      const existing = existingRegions.find((row) => row.regionId === input.regionId);
      if (existing !== undefined) {
        throw new RegionalSimulationConflictError(
          `Region '${input.worldId}/${input.regionId}' ist bereits initialisiert.`,
        );
      }
      const latestWorldAtS = existingRegions.reduce(
        (latest, row) => Math.max(latest, persistedState(row).nowS),
        0,
      );
      if (initialized.snapshot.atS < latestWorldAtS) {
        throw new RegionalSimulationConflictError(
          `Regionsinitialisierung bei ${initialized.snapshot.atS} liegt vor der Livemap-Weltzeit ${latestWorldAtS}.`,
        );
      }
      await tx.insert(regionalSimulationStates).values({
        worldId: input.worldId,
        regionId: input.regionId,
        stateSchema: REGIONAL_SIMULATION_STATE_SCHEMA,
        state: initialized.state,
        stateHash: initialized.stateHash,
        revision: initialized.state.revision,
        publisherSequence: initialized.state.publisherSequence,
        createdAt: persistedAt,
        updatedAt: persistedAt,
      });
      await appendEvents(tx, input.worldId, world.epoch, initialized.events);
    });

    try {
      this.#livemap.initializeRegion(input.worldId, input.regionId, {
        at: initialized.snapshot.atS,
        trains: initialized.snapshot.trains,
        disruptions: initialized.snapshot.disruptions,
      });
      this.#markReady(initialized.state);
      return initialized;
    } catch (error) {
      this.#readyRegions.delete(readyKey(input.worldId, input.regionId));
      this.#livemap.markUnavailable(input.worldId);
      throw error;
    }
  }

  async restore(worldId: string, regionId: string): Promise<RegionalSimulationRestored> {
    const [row] = await this.#db
      .select()
      .from(regionalSimulationStates)
      .where(
        and(
          eq(regionalSimulationStates.worldId, worldId),
          eq(regionalSimulationStates.regionId, regionId),
        ),
      )
      .limit(1);
    if (row === undefined) throw new RegionalSimulationUnavailableError(worldId, regionId);
    const state = persistedState(row);
    const restored = this.#runtime.restore(state);
    if (
      restored.stateHash !== row.stateHash ||
      restored.state.revision !== row.revision ||
      restored.state.publisherSequence !== row.publisherSequence
    ) {
      throw new RegionalSimulationSequenceError(
        "Rust-Restore stimmt nicht mit dem persistierten Kopf ueberein.",
      );
    }
    try {
      this.#livemap.initializeRegion(worldId, regionId, {
        at: restored.snapshot.atS,
        trains: restored.snapshot.trains,
        disruptions: restored.snapshot.disruptions,
      });
      this.#markReady(restored.state);
      return restored;
    } catch (error) {
      this.#readyRegions.delete(readyKey(worldId, regionId));
      this.#livemap.markUnavailable(worldId);
      throw error;
    }
  }

  async apply(
    work: RegionalSimulationWorkCommand,
    persistedAt: Date,
  ): Promise<RegionalSimulationResult> {
    validDate(persistedAt, "Persistenzzeit");
    const key = readyKey(work.worldId, work.regionId);
    if (!this.#readyRegions.has(key)) {
      throw new RegionalSimulationUnavailableError(work.worldId, work.regionId);
    }

    const committed = await this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${work.worldId} for update`,
      );
      const [world] = await tx
        .select({ epoch: worlds.epoch })
        .from(worlds)
        .where(eq(worlds.id, work.worldId))
        .limit(1);
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
      const [row] = await tx
        .select()
        .from(regionalSimulationStates)
        .where(
          and(
            eq(regionalSimulationStates.worldId, work.worldId),
            eq(regionalSimulationStates.regionId, work.regionId),
          ),
        )
        .limit(1);
      if (row === undefined) {
        throw new RegionalSimulationUnavailableError(work.worldId, work.regionId);
      }
      const state = persistedState(row);
      const result = this.#runtime.apply(state, {
        schemaVersion: REGIONAL_SIMULATION_COMMAND_SCHEMA,
        worldId: work.worldId,
        regionId: work.regionId,
        commandId: work.commandId,
        expectedStateHash: row.stateHash,
        expectedRevision: row.revision,
        expectedPublisherSequence: row.publisherSequence,
        command: work.command,
      });

      if (result.idempotentReplay) {
        if (
          result.stateHash !== row.stateHash ||
          result.state.revision !== row.revision ||
          result.state.publisherSequence !== row.publisherSequence
        ) {
          throw new RegionalSimulationSequenceError(
            "Idempotenter Rust-Replay veraenderte den persistierten Kopf.",
          );
        }
        return { result, fanout: false, appendedEvents: [] };
      }
      const worldRegions = await tx
        .select()
        .from(regionalSimulationStates)
        .where(eq(regionalSimulationStates.worldId, work.worldId));
      const latestWorldAtS = worldRegions.reduce(
        (latest, regionalRow) => Math.max(latest, persistedState(regionalRow).nowS),
        0,
      );
      if (result.delta.atS < latestWorldAtS) {
        throw new RegionalSimulationConflictError(
          `Regionsdelta bei ${result.delta.atS} liegt vor der Livemap-Weltzeit ${latestWorldAtS}.`,
        );
      }
      if (
        result.state.revision !== row.revision + 1 ||
        result.state.publisherSequence !== row.publisherSequence + 1 ||
        result.delta.producerSequence !== result.state.publisherSequence
      ) {
        throw new RegionalSimulationSequenceError(
          "Rust-Uebergang erzeugte eine Revisions- oder Publisher-Luecke.",
        );
      }
      const updated = await tx
        .update(regionalSimulationStates)
        .set({
          stateSchema: REGIONAL_SIMULATION_STATE_SCHEMA,
          state: result.state,
          stateHash: result.stateHash,
          revision: result.state.revision,
          publisherSequence: result.state.publisherSequence,
          updatedAt: persistedAt,
        })
        .where(
          and(
            eq(regionalSimulationStates.worldId, work.worldId),
            eq(regionalSimulationStates.regionId, work.regionId),
            eq(regionalSimulationStates.stateHash, row.stateHash),
            eq(regionalSimulationStates.revision, row.revision),
            eq(regionalSimulationStates.publisherSequence, row.publisherSequence),
          ),
        )
        .returning({ stateHash: regionalSimulationStates.stateHash });
      if (updated.length !== 1) {
        throw new RegionalSimulationConflictError(
          "Regionaler Simulationskopf wurde gleichzeitig veraendert.",
        );
      }
      const appendedEvents = await appendEvents(tx, work.worldId, world.epoch, result.events);
      return { result, fanout: true, appendedEvents };
    });

    if (!committed.fanout) {
      this.#markReady(committed.result.state);
      return committed.result;
    }
    try {
      for (const event of committed.appendedEvents) {
        const payload = event.payload as Readonly<Record<string, unknown>>;
        const operatorIds = Array.isArray(payload["operatorIds"])
          ? payload["operatorIds"].filter((value): value is string => typeof value === "string")
          : [];
        for (const operatorId of operatorIds) {
          const decision = projectOperations([event], operatorId).decisions[0];
          if (decision !== undefined) {
            this.#operations?.forOperator(work.worldId, operatorId).publish({
              worldId: work.worldId,
              operatorId,
              sequence: event.sequence,
              decision,
            });
          }
        }
      }
      const published = this.#livemap.publishRegionDelta(work.worldId, work.regionId, {
        at: committed.result.delta.atS,
        changed: committed.result.delta.changed,
        removed: committed.result.delta.removed,
        changedDisruptions: committed.result.delta.changedDisruptions,
        removedDisruptionIds: committed.result.delta.removedDisruptionIds,
      });
      if (published === undefined) {
        await this.#rebuildWorldFeed(work.worldId);
      } else {
        this.#markReady(committed.result.state);
      }
      return committed.result;
    } catch (error) {
      this.#readyRegions.delete(key);
      this.#livemap.markUnavailable(work.worldId);
      throw error;
    }
  }
}
