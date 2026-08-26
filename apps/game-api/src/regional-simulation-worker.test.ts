import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  domainEvents,
  mailboxMessages,
  MIGRATIONS_FOLDER,
  operators,
  regionalSimulationCommandReceipts,
  regionalSimulationStates,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { OperationsRegistry } from "@zugfolge/dispatch";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
import {
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  OPERATIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
  OPERATIONAL_SIMULATION_COMMAND_BATCH_LIMIT,
  OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
  OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
  OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  OPERATIONAL_SIMULATION_RESTORED_SCHEMA,
  OPERATIONAL_SIMULATION_RESULT_SCHEMA,
  OPERATIONAL_SIMULATION_STATE_SCHEMA,
  type OperationalProjectedTrain,
  type OperationalDisruption,
  type OperationalProjection,
  type OperationalSimulationCommand,
  type OperationalSimulationCommandBatch,
  type OperationalSimulationCommandPayload,
  type OperationalSimulationInitialization,
  type OperationalSimulationRuntime,
  type OperationalSimulationState,
  type OperationalTrainInitialization,
} from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";

import {
  RegionalSimulationConflictError,
  RegionalSimulationSequenceError,
  RegionalSimulationUnavailableError,
  RegionalSimulationWorker,
} from "./regional-simulation-worker.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";

const REGION_ID = "leipzig";
const INFRA_RELEASE_ID = "infra-operational-v2";
const EPOCH = new Date("2026-12-14T00:00:00.000Z");
const OPERATIONAL_COMMAND_RECEIPT_LIMIT = 4_096;

interface FakeCommandReceipt {
  readonly commandHash: string;
  readonly appliedRevision: number;
}

type FakeState = OperationalSimulationState & {
  readonly world: OperationalSimulationState["world"] & {
    readonly events: readonly unknown[];
    readonly activeDisruptions: Readonly<Record<string, OperationalDisruption>>;
  };
  readonly commandReceipts: Readonly<Record<string, FakeCommandReceipt>>;
  readonly projectedTrains: readonly OperationalProjectedTrain[];
};

interface FakeRuntimeOptions {
  readonly gap?: boolean;
  readonly failCommandId?: string;
  readonly onApply?: () => void;
}

function hash(revision: number): string {
  return revision.toString(16).padStart(64, "0");
}

function commandHash(command: OperationalSimulationCommandPayload): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

function addBoundedReceipt(
  receipts: Readonly<Record<string, FakeCommandReceipt>>,
  commandId: string,
  receipt: FakeCommandReceipt,
): Readonly<Record<string, FakeCommandReceipt>> {
  const entries = Object.entries({ ...receipts, [commandId]: receipt });
  entries.sort(([leftId, left], [rightId, right]) => {
    const revision = left.appliedRevision - right.appliedRevision;
    if (revision !== 0) return revision;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  return Object.fromEntries(entries.slice(-OPERATIONAL_COMMAND_RECEIPT_LIMIT));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function train(id: string): OperationalTrainInitialization {
  return {
    id,
    trainNumber: "RE 1",
    operatorId: "operator-1",
    movementKind: "train",
    routeVersionId: "route-v2",
    formationVersionId: "formation-v2",
    headRouteMm: 10_000,
    scheduledDepartureMs: 0,
    publicPassengerStop: true,
    dispatchInterlockingRouteId: "interlocking-v2",
    protectionModeSelectionRuns: [{
      throughRouteLegIndex: 0,
      selectedProtectionSystem: "pzb",
    }],
  };
}

function projectedTrain(input: OperationalTrainInitialization): OperationalProjectedTrain {
  const tailRouteMm = Math.max(0, input.headRouteMm - 2_000);
  return {
    trainId: input.id,
    trainNumber: input.trainNumber,
    operatorId: input.operatorId,
    movementKind: input.movementKind,
    motionState: "standing",
    direction: "along",
    routeVersionId: input.routeVersionId,
    formationVersionId: input.formationVersionId,
    headRouteMm: input.headRouteMm,
    tailRouteMm,
    speedMmps: 0,
    occupiedIntervals: [{
      edgeId: "edge-1",
      fromMm: tailRouteMm,
      toMm: input.headRouteMm,
      direction: "along",
    }],
    occupiedBlocks: ["block-1"],
    authorityEndRouteMm: null,
    motionSegment: null,
    headGeometry: {
      routeMm: input.headRouteMm,
      edgeId: "edge-1",
      edgeOffsetMm: input.headRouteMm,
      latitudeE7: 513_454_000,
      longitudeE7: 123_827_000,
      bearingMilliDegrees: 90_000,
    },
    tailGeometry: {
      routeMm: tailRouteMm,
      edgeId: "edge-1",
      edgeOffsetMm: tailRouteMm,
      latitudeE7: 513_453_800,
      longitudeE7: 123_826_800,
      bearingMilliDegrees: 90_000,
    },
    motionGeometry: [],
    waitingReason: null,
  };
}

function projection(
  state: FakeState,
  kind: OperationalProjection["kind"],
): OperationalProjection {
  return {
    kind,
    worldId: state.world.worldId,
    regionId: state.world.regionId,
    infraReleaseId: state.world.infraReleaseId,
    commitSequence: state.world.commitSequence,
    atMs: state.world.nowMs,
    staleAfterMs: state.world.nowMs + 75_000,
    trains: state.projectedTrains,
    routeLocks: [],
    signals: { "signal-1": "stop" },
    activeDisruptions: Object.entries(state.world.activeDisruptions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([disruptionId, effect]) => ({ disruptionId, effect })),
  };
}

function eventIdentity(
  command: OperationalSimulationCommandPayload,
  regionId: string,
): readonly [kind: string, subjectId: string] {
  switch (command.type) {
    case "materialize": return ["movement-materialized", command.train.id];
    case "retire": return ["movement-retired", command.trainId];
    case "advance-to": return ["time-advanced", regionId];
    case "dispatch": return ["dispatch-evaluated", regionId];
    case "plan-motion": return ["motion-planned", command.trainId];
    case "safe-stop": return ["safe-stop", command.trainId];
    case "change-formation": return ["formation-changed", command.trainId];
    case "reroute": return ["route-version-changed", command.trainId];
    case "automatic-shunting": return ["shunting-order-executed", command.need.id];
    case "activate-disruption": return ["disruption-activated", command.disruptionId];
    case "clear-disruption": return ["disruption-cleared", command.disruptionId];
  }
}

function applyTrainCommand(
  trains: readonly OperationalProjectedTrain[],
  command: OperationalSimulationCommandPayload,
): readonly OperationalProjectedTrain[] {
  switch (command.type) {
    case "materialize":
      return [...trains, projectedTrain(command.train)];
    case "retire":
      return trains.filter((item) => item.trainId !== command.trainId);
    case "safe-stop":
      return trains.map((item) => item.trainId === command.trainId
        ? {
            ...item,
            motionState: "safe-stop" as const,
            speedMmps: 0,
            authorityEndRouteMm: null,
            motionSegment: null,
            motionGeometry: [],
            waitingReason: command.reason,
          }
        : item);
    case "change-formation":
      return trains.map((item) => item.trainId === command.trainId
        ? { ...item, formationVersionId: command.formationId }
        : item);
    case "reroute":
      return trains.map((item) => item.trainId === command.trainId
        ? { ...item, routeVersionId: command.routeVersionId }
        : item);
    default:
      return trains;
  }
}

function fakeRuntime(options: FakeRuntimeOptions = {}): {
  readonly runtime: OperationalSimulationRuntime;
  readonly calls: OperationalSimulationCommand[];
  readonly batchCalls: OperationalSimulationCommandBatch[];
} {
  const calls: OperationalSimulationCommand[] = [];
  const batchCalls: OperationalSimulationCommandBatch[] = [];
  let insideBatch = false;
  const runtime: OperationalSimulationRuntime = {
    commandHash,
    initialize(input) {
      const releaseId = input.infraRelease["id"];
      if (typeof releaseId !== "string") throw new Error("invalid_operational_release");
      const state: FakeState = {
        schemaVersion: OPERATIONAL_SIMULATION_STATE_SCHEMA,
        initializationHash: operationalSimulationInitializationHash(input),
        world: {
          worldId: input.worldId,
          regionId: input.regionId,
          infraReleaseId: releaseId,
          nowMs: input.nowMs,
          commitSequence: 0,
          eventSequence: 0,
          events: [],
          activeDisruptions: {},
        },
        revision: 0,
        publisherSequence: 0,
        stateHash: hash(0),
        commandReceipts: {},
        projectedTrains: input.trains.map(projectedTrain),
      };
      return {
        schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
        state,
        initializationHash: state.initializationHash,
        stateHash: state.stateHash,
        liveMap: projection(state, "live-map"),
        rzue: projection(state, "rzue"),
        events: [],
      };
    },
    restore(inputState, expectedInitializationHash) {
      const state = inputState as FakeState;
      if (state.initializationHash !== expectedInitializationHash) {
        throw new Error("initialization_hash_mismatch");
      }
      return {
        schemaVersion: OPERATIONAL_SIMULATION_RESTORED_SCHEMA,
        state,
        initializationHash: state.initializationHash,
        stateHash: state.stateHash,
        liveMap: projection(state, "live-map"),
        rzue: projection(state, "rzue"),
      };
    },
    async apply(inputState, envelope) {
      options.onApply?.();
      const state = inputState as FakeState;
      if (!insideBatch) calls.push(envelope);
      const serializedCommandHash = commandHash(envelope.command);
      const receipt = state.commandReceipts[envelope.commandId];
      if (receipt !== undefined) {
        if (receipt.commandHash !== serializedCommandHash) throw new Error("idempotency_conflict");
        return {
          schemaVersion: OPERATIONAL_SIMULATION_RESULT_SCHEMA,
          state,
          initializationHash: state.initializationHash,
          stateHash: state.stateHash,
          liveMap: projection(state, "live-map"),
          rzue: projection(state, "rzue"),
          events: [],
          appliedCommandId: envelope.commandId,
          idempotentReplay: true,
        };
      }
      if (
        envelope.expectedStateHash !== state.stateHash
        || envelope.expectedRevision !== state.revision
        || envelope.expectedPublisherSequence !== state.publisherSequence
      ) {
        throw new Error("optimistic_concurrency_conflict");
      }
      if (options.failCommandId === envelope.commandId) {
        throw new Error(`command_rejected:${envelope.commandId}`);
      }
      const nowMs = envelope.command.type === "advance-to"
        ? envelope.command.atMs
        : state.world.nowMs;
      if (nowMs < state.world.nowMs) throw new Error("time_backwards");
      const nextRevision = state.revision + (options.gap === true ? 2 : 1);
      const [kind, subjectId] = eventIdentity(envelope.command, state.world.regionId);
      const activeDisruptions = { ...state.world.activeDisruptions };
      if (envelope.command.type === "activate-disruption") {
        activeDisruptions[envelope.command.disruptionId] = envelope.command.effect as OperationalDisruption;
      } else if (envelope.command.type === "clear-disruption") {
        delete activeDisruptions[envelope.command.disruptionId];
      }
      const nextState: FakeState = {
        ...state,
        world: {
          ...state.world,
          nowMs,
          commitSequence: state.world.commitSequence + 1,
          eventSequence: state.world.eventSequence + 1,
          events: [],
          activeDisruptions,
        },
        revision: nextRevision,
        publisherSequence: nextRevision,
        stateHash: hash(nextRevision),
        commandReceipts: addBoundedReceipt(
          state.commandReceipts,
          envelope.commandId,
          { commandHash: serializedCommandHash, appliedRevision: nextRevision },
        ),
        projectedTrains: applyTrainCommand(state.projectedTrains, envelope.command),
      };
      return {
        schemaVersion: OPERATIONAL_SIMULATION_RESULT_SCHEMA,
        state: nextState,
        initializationHash: nextState.initializationHash,
        stateHash: nextState.stateHash,
        liveMap: projection(nextState, "live-map"),
        rzue: projection(nextState, "rzue"),
        events: [{
          eventSequence: nextState.world.eventSequence,
          commitSequence: nextState.world.commitSequence,
          atMs: nowMs,
          kind,
          subjectId,
          detail: envelope.command.type === "clear-disruption"
            ? envelope.command.releaseReference
            : envelope.command.type === "activate-disruption"
              ? "concrete-resource-or-vehicle"
              : envelope.commandId,
        }],
        appliedCommandId: envelope.commandId,
        idempotentReplay: false,
      };
    },
    async applyBatch(inputState, batch) {
      batchCalls.push(batch);
      let state = inputState;
      let stateHash = inputState.stateHash;
      let liveMap = projection(inputState as FakeState, "live-map");
      let rzue = projection(inputState as FakeState, "rzue");
      const events: Readonly<Record<string, unknown>>[] = [];
      const commandResults: Array<{ commandId: string; idempotentReplay: boolean }> = [];
      const eventContexts: Array<{
        commandIndex: number;
        commandId: string;
        commitSequence: number;
        affectedTrainRunIds: readonly string[];
        disruptionEffectBefore?: OperationalDisruption;
      }> = [];
      insideBatch = true;
      try {
        for (const [commandIndex, item] of batch.commands.entries()) {
          const previousState = state as FakeState;
          const result = await runtime.apply(state, {
            schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
            worldId: batch.worldId,
            regionId: batch.regionId,
            commandId: item.commandId,
            expectedStateHash: stateHash,
            expectedRevision: state.revision,
            expectedPublisherSequence: state.publisherSequence,
            command: item.command,
          });
          commandResults.push({
            commandId: result.appliedCommandId,
            idempotentReplay: result.idempotentReplay,
          });
          if (
            !result.idempotentReplay
            && (item.command.type === "activate-disruption" || item.command.type === "clear-disruption")
          ) {
            const projectedTrainIds = new Set(result.liveMap.trains.map((train) => train.trainId));
            eventContexts.push({
              commandIndex,
              commandId: item.commandId,
              commitSequence: result.state.world.commitSequence,
              affectedTrainRunIds: [...new Set(result.events
                .map((event) => event["subjectId"])
                .filter((subjectId): subjectId is string =>
                  typeof subjectId === "string" && projectedTrainIds.has(subjectId)))].sort(),
              ...(item.command.type === "clear-disruption"
                ? {
                    disruptionEffectBefore:
                      previousState.world.activeDisruptions[item.command.disruptionId]!,
                  }
                : {}),
            });
          }
          state = result.state;
          stateHash = result.stateHash;
          liveMap = result.liveMap;
          rzue = result.rzue;
          events.push(...result.events);
        }
      } finally {
        insideBatch = false;
      }
      return {
        schemaVersion: OPERATIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
        state,
        initializationHash: state.initializationHash,
        stateHash,
        liveMap,
        rzue,
        events,
        commandResults,
        eventContexts,
      };
    },
  };
  return { runtime, calls, batchCalls };
}

function initialization(
  worldId: string,
  regionId = REGION_ID,
  nowMs = 0,
): OperationalSimulationInitialization {
  return {
    schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
    worldId,
    regionId,
    nowMs,
    protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
    infraRelease: { id: INFRA_RELEASE_ID },
    vehicleTypes: [],
    vehicles: [],
    formations: [],
    trains: [train(`${regionId}-train-1`)],
  };
}

async function testDatabase() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { client, db };
}

async function insertWorld(
  db: Awaited<ReturnType<typeof testDatabase>>["db"],
  worldId: string,
): Promise<void> {
  await db.insert(worlds).values({
    id: worldId,
    name: `Testwelt ${worldId}`,
    schedulePeriodWeeks: 4,
    epoch: EPOCH,
  });
}

describe("operativer v2-Regionalsimulationsworker", () => {
  it("persistiert v2-CAS, Millisekunden-Ereignis und LiveMap-Commit gemeinsam", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000001";
    const livemap = new LivemapRegistry();
    const { runtime } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);

      const result = await worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "advance-1234",
        command: { type: "advance-to", atMs: 1_234 },
      }, new Date(EPOCH.getTime() + 9_000));

      expect(result.state).toMatchObject({ revision: 1, publisherSequence: 1 });
      expect(result.liveMap).toMatchObject({
        kind: "live-map",
        commitSequence: 1,
        atMs: 1_234,
      });
      const [row] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      expect(row).toMatchObject({
        stateSchema: OPERATIONAL_SIMULATION_STATE_SCHEMA,
        revision: 1,
        publisherSequence: 1,
        stateHash: hash(1),
      });
      expect((row?.state as FakeState).world.nowMs).toBe(1_234);
      const [event] = await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId));
      expect(event).toMatchObject({
        eventType: "operational.time-advanced",
        occurredAt: new Date(EPOCH.getTime() + 1_234),
        payload: expect.objectContaining({
          schemaVersion: "zugfolge-operational-simulation-event/v2",
          regionId: REGION_ID,
          commitSequence: 1,
          simulationTimeMs: 1_234,
        }),
      });
      const snapshot = livemap.initializedWorld(worldId)?.snapshot();
      expect(snapshot?.operationalRegions).toEqual([expect.objectContaining({
        regionId: REGION_ID,
        commitSequence: 1,
        simulationTimeMs: 1_234,
      })]);
      expect(snapshot?.trains[0]).toMatchObject({
        id: `${REGION_ID}-train-1`,
        operatorId: "operator-1",
        mapPosition: expect.objectContaining({ infrastructureReleaseId: INFRA_RELEASE_ID }),
        operational: expect.objectContaining({
          commitSequence: 1,
          simulationTimeMs: 1_234,
        }),
      });
    } finally {
      await client.close();
    }
  }, 15_000);

  it("haelt waehrend nativer Einzel- und Batchberechnung keine DB-Transaktion offen", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000012";
    let transactionActive = false;
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation(async (callback, config) =>
      originalTransaction(async (tx) => {
        transactionActive = true;
        try {
          return await callback(tx);
        } finally {
          transactionActive = false;
        }
      }, config));
    const onApply = vi.fn(() => expect(transactionActive).toBe(false));
    const { runtime } = fakeRuntime({ onApply });
    const worker = new RegionalSimulationWorker(db, runtime, new LivemapRegistry());
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      await worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "outside-transaction-single",
        command: { type: "advance-to", atMs: 1_000 },
      }, EPOCH);
      await worker.applyBatch({
        worldId,
        regionId: REGION_ID,
        commands: [{
          commandId: "outside-transaction-batch",
          command: { type: "advance-to", atMs: 2_000 },
        }],
      }, EPOCH);

      expect(onApply).toHaveBeenCalledTimes(2);
      expect(transactionActive).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await client.close();
    }
  });

  it("verwirft ein ausserhalb der Sperre berechnetes Ergebnis, wenn ein anderer Writer den Kopf gewinnt", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000013";
    const entered = deferred<void>();
    const release = deferred<void>();
    const { runtime: baseRuntime } = fakeRuntime();
    const runtime: OperationalSimulationRuntime = {
      ...baseRuntime,
      async apply(state, command) {
        if (command.commandId === "slow-loser") {
          entered.resolve(undefined);
          await release.promise;
        }
        return baseRuntime.apply(state, command);
      },
    };
    const worker = new RegionalSimulationWorker(db, runtime, new LivemapRegistry());
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      const loser = worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "slow-loser",
        command: { type: "advance-to", atMs: 1_000 },
      }, EPOCH);
      await entered.promise;

      await expect(worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "fast-winner",
        command: { type: "advance-to", atMs: 2_000 },
      }, EPOCH)).resolves.toMatchObject({ state: { revision: 1 } });
      release.resolve(undefined);
      await expect(loser).rejects.toBeInstanceOf(RegionalSimulationConflictError);

      const [row] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      expect(row).toMatchObject({ revision: 1, publisherSequence: 1, stateHash: hash(1) });
      expect((row?.state as FakeState).world.nowMs).toBe(2_000);
    } finally {
      release.resolve(undefined);
      await client.close();
    }
  });

  it("committet Batchkopf und dauerhaftes Receipt-Ledger nur gemeinsam unter demselben CAS", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000016";
    const entered = deferred<void>();
    const release = deferred<void>();
    const { runtime: baseRuntime } = fakeRuntime();
    const runtime: OperationalSimulationRuntime = {
      ...baseRuntime,
      async applyBatch(state, batch) {
        if (batch.commands[0]?.commandId === "slow-batch-loser") {
          entered.resolve(undefined);
          await release.promise;
        }
        return baseRuntime.applyBatch(state, batch);
      },
    };
    const worker = new RegionalSimulationWorker(db, runtime, new LivemapRegistry());
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      const loser = worker.applyBatch({
        worldId,
        regionId: REGION_ID,
        commands: [{
          commandId: "slow-batch-loser",
          command: { type: "advance-to", atMs: 1_000 },
        }],
      }, EPOCH);
      await entered.promise;

      await expect(worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "fast-single-winner",
        command: { type: "advance-to", atMs: 2_000 },
      }, EPOCH)).resolves.toMatchObject({ state: { revision: 1 } });
      release.resolve(undefined);
      await expect(loser).rejects.toBeInstanceOf(RegionalSimulationConflictError);

      const [row] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      expect(row).toMatchObject({ revision: 1, publisherSequence: 1, stateHash: hash(1) });
      const receipts = await db.select().from(regionalSimulationCommandReceipts).where(and(
        eq(regionalSimulationCommandReceipts.worldId, worldId),
        eq(regionalSimulationCommandReceipts.regionId, REGION_ID),
      ));
      expect(receipts).toEqual([
        expect.objectContaining({ commandId: "fast-single-winner", appliedRevision: 1 }),
      ]);
    } finally {
      release.resolve(undefined);
      await client.close();
    }
  });

  it("wiederholt dieselbe Kommando-ID ohne DB-Event oder LiveMap-Sequenz", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000002";
    const livemap = new LivemapRegistry();
    const { runtime } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    const work = {
      worldId,
      regionId: REGION_ID,
      commandId: "advance-once",
      command: { type: "advance-to", atMs: 1_000 } as const,
    };
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      const first = await worker.apply(work, new Date(EPOCH.getTime() + 1_000));
      const firstSequence = livemap.initializedWorld(worldId)?.snapshot().sequence;
      const replay = await worker.apply(work, new Date(EPOCH.getTime() + 2_000));

      expect(first.idempotentReplay).toBe(false);
      expect(replay.idempotentReplay).toBe(true);
      expect(livemap.initializedWorld(worldId)?.snapshot().sequence).toBe(firstSequence);
      expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)))
        .toHaveLength(1);
      const [row] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      expect(row).toMatchObject({
        revision: 1,
        publisherSequence: 1,
        updatedAt: new Date(EPOCH.getTime() + 1_000),
      });
    } finally {
      await client.close();
    }
  });

  it("fuehrt Replay-Praefix und neuen Batchsuffix unter einem DB-Commit sequenziell aus", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000003";
    const livemap = new LivemapRegistry();
    const { runtime, calls, batchCalls } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      await worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "advance-prefix",
        command: { type: "advance-to", atMs: 2_000 },
      }, EPOCH);

      const batch = await worker.applyBatch({
        worldId,
        regionId: REGION_ID,
        commands: [{
          commandId: "advance-prefix",
          command: { type: "advance-to", atMs: 2_000 },
        }, {
          commandId: "safe-stop-suffix",
          command: {
            type: "safe-stop",
            trainId: `${REGION_ID}-train-1`,
            reason: "Testhalt",
          },
        }],
      }, new Date(EPOCH.getTime() + 2_000));

      expect(batch.commandResults).toEqual([
        { commandId: "advance-prefix", idempotentReplay: true },
        { commandId: "safe-stop-suffix", idempotentReplay: false },
      ]);
      // Nur der vorbereitende Einzelcommit verwendet apply. Der dauerhaft
      // belegte Praefix wird vor dem einzigen nativen Batchaufruf entfernt.
      expect(calls.map((call) => call.expectedRevision)).toEqual([0]);
      expect(batchCalls).toHaveLength(1);
      expect(batchCalls[0]?.commands).toEqual([{
        commandId: "safe-stop-suffix",
        command: {
          type: "safe-stop",
          trainId: `${REGION_ID}-train-1`,
          reason: "Testhalt",
        },
      }]);
      const [row] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      expect(row).toMatchObject({ revision: 2, publisherSequence: 2 });
      expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)))
        .toHaveLength(2);
      expect(livemap.initializedWorld(worldId)?.snapshot().trains[0]).toMatchObject({
        status: "waiting",
        operational: expect.objectContaining({ waitingReason: "Testhalt" }),
      });
    } finally {
      await client.close();
    }
  });

  it("setzt mehrere Batchcommits ohne native Wiederholung auf den finalen Vollsnapshot", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-00000000000a";
    const livemap = new LivemapRegistry();
    const { runtime, calls, batchCalls } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      const feed = livemap.initializedWorld(worldId)!;
      const before = feed.snapshot();
      const reset = vi.fn();
      expect(feed.subscribeAfter(
        { streamId: before.streamId, sequence: before.sequence },
        vi.fn(),
        reset,
      ).kind).toBe("resume");
      const publish = vi.spyOn(livemap, "publishOperationalRegionSnapshot");

      const batch = await worker.applyBatch({
        worldId,
        regionId: REGION_ID,
        commands: [{
          commandId: "batch-advance-1",
          command: { type: "advance-to", atMs: 1_000 },
        }, {
          commandId: "batch-safe-stop-2",
          command: {
            type: "safe-stop",
            trainId: `${REGION_ID}-train-1`,
            reason: "Batchhalt",
          },
        }, {
          commandId: "batch-advance-3",
          command: { type: "advance-to", atMs: 2_000 },
        }],
      }, new Date(EPOCH.getTime() + 2_000));

      expect(batch.state).toMatchObject({ revision: 3, publisherSequence: 3 });
      expect(calls).toHaveLength(0);
      expect(batchCalls).toHaveLength(1);
      expect(publish).not.toHaveBeenCalled();
      expect(reset).toHaveBeenCalledOnce();
      expect(livemap.initializedWorld(worldId)?.snapshot().operationalRegions)
        .toEqual([expect.objectContaining({ commitSequence: 3, simulationTimeMs: 2_000 })]);
      expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)))
        .toHaveLength(3);
    } finally {
      vi.restoreAllMocks();
      await client.close();
    }
  });

  it("setzt einen grossen atomaren Batch nach Commit speicherbegrenzt auf den finalen Vollsnapshot", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-00000000000b";
    const livemap = new LivemapRegistry();
    const { runtime, calls, batchCalls } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      const feed = livemap.initializedWorld(worldId)!;
      const before = feed.snapshot();
      const reset = vi.fn();
      expect(feed.subscribeAfter(
        { streamId: before.streamId, sequence: before.sequence },
        vi.fn(),
        reset,
      ).kind).toBe("resume");
      const publish = vi.spyOn(livemap, "publishOperationalRegionSnapshot");
      const commands = Array.from(
        { length: 65 },
        (_, index) => ({
          commandId: `large-boundary:${index}`,
          command: { type: "advance-to" as const, atMs: 1_000 },
        }),
      );

      const result = await worker.applyBatch({
        worldId,
        regionId: REGION_ID,
        commands,
      }, EPOCH);

      expect(result.state).toMatchObject({
        revision: commands.length,
        publisherSequence: commands.length,
        world: { commitSequence: commands.length, nowMs: 1_000 },
      });
      expect(calls).toHaveLength(0);
      expect(batchCalls).toHaveLength(1);
      expect(batchCalls[0]?.commands).toHaveLength(commands.length);
      expect(publish).not.toHaveBeenCalled();
      expect(reset).toHaveBeenCalledOnce();
      expect(livemap.initializedWorld(worldId)?.snapshot()).toMatchObject({
        sequence: before.sequence + 1,
        operationalRegions: [expect.objectContaining({
          commitSequence: commands.length,
          simulationTimeMs: 1_000,
        })],
      });
      expect(await db.select().from(regionalSimulationCommandReceipts).where(and(
        eq(regionalSimulationCommandReceipts.worldId, worldId),
        eq(regionalSimulationCommandReceipts.regionId, REGION_ID),
      ))).toHaveLength(commands.length);
    } finally {
      vi.restoreAllMocks();
      await client.close();
    }
  });

  it("verhindert per dauerhaftem Ledger auch nach nativer Receipt-Eviction eine zweite Wirkung", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-00000000000c";
    const { runtime, calls } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, new LivemapRegistry());
    const oldCommand = { type: "advance-to", atMs: 1_000 } as const;
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      const [row] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      const current = row!.state as FakeState;
      const evictedState: FakeState = {
        ...current,
        world: { ...current.world, nowMs: 1_000, commitSequence: 4_097 },
        revision: 4_097,
        publisherSequence: 4_097,
        stateHash: hash(4_097),
        commandReceipts: Object.fromEntries(Array.from({ length: 4_096 }, (_, index) => {
          const revision = index + 2;
          return [`recent:${revision}`, {
            commandHash: commandHash({ type: "advance-to", atMs: 1_000 }),
            appliedRevision: revision,
          }];
        })),
      };
      await client.query(
        `insert into regional_simulation_command_receipts
          (world_id, region_id, initialization_hash, command_id, command_hash,
           applied_revision, created_at)
         select $1, $2, $3,
                case when revision = 1 then 'evicted-command' else 'recent:' || revision::text end,
                $4, revision, $5
         from generate_series(1, 4097) as series(revision)`,
        [
          worldId,
          REGION_ID,
          current.initializationHash,
          commandHash(oldCommand),
          EPOCH.toISOString(),
        ],
      );
      await db.update(regionalSimulationStates).set({
        state: evictedState,
        stateHash: evictedState.stateHash,
        revision: evictedState.revision,
        publisherSequence: evictedState.publisherSequence,
      }).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      await expect(worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "evicted-command",
        command: oldCommand,
      }, EPOCH)).resolves.toMatchObject({
        idempotentReplay: true,
        state: { revision: 4_097, publisherSequence: 4_097 },
      });
      expect(calls).toHaveLength(0);
      await expect(worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "evicted-command",
        command: { type: "advance-to", atMs: 2_000 },
      }, EPOCH)).rejects.toBeInstanceOf(RegionalSimulationConflictError);
      expect(calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("rollt einen abgelehnten Batch ohne Zustand, Event oder Fanout zurueck", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000004";
    const livemap = new LivemapRegistry();
    const { runtime, calls, batchCalls } = fakeRuntime({ failCommandId: "reject" });
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      const sequence = livemap.initializedWorld(worldId)?.snapshot().sequence;

      await expect(worker.applyBatch({
        worldId,
        regionId: REGION_ID,
        commands: [{
          commandId: "advance-before-reject",
          command: { type: "advance-to", atMs: 3_000 },
        }, {
          commandId: "reject",
          command: {
            type: "safe-stop",
            trainId: `${REGION_ID}-train-1`,
            reason: "wird verworfen",
          },
        }],
      }, EPOCH)).rejects.toThrow("command_rejected:reject");

      expect(calls).toHaveLength(0);
      expect(batchCalls).toHaveLength(1);

      const [row] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      expect(row).toMatchObject({ revision: 0, publisherSequence: 0 });
      expect((row?.state as FakeState).world.nowMs).toBe(0);
      expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)))
        .toHaveLength(0);
      expect(livemap.initializedWorld(worldId)?.snapshot().sequence).toBe(sequence);
      expect(worker.isReady(worldId, REGION_ID)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("bindet Aktivierung und Freigabe im nativen Batch an den richtigen Stoerungskontext", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000015";
    const { runtime, batchCalls } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, new LivemapRegistry());
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      const result = await worker.applyBatch({
        worldId,
        regionId: REGION_ID,
        commands: [{
          commandId: "batch:disruption:activate",
          command: {
            type: "activate-disruption",
            disruptionId: "disruption:batch",
            effect: { "resource-closed": { resourceId: "block:batch" } },
          },
        }, {
          commandId: "batch:disruption:clear",
          command: {
            type: "clear-disruption",
            disruptionId: "disruption:batch",
            releaseReference: "release:batch-test",
          },
        }],
      }, EPOCH);

      expect(result.state).toMatchObject({ revision: 2, publisherSequence: 2 });
      expect(batchCalls).toHaveLength(1);
      const events = await db.select().from(domainEvents)
        .where(eq(domainEvents.worldId, worldId));
      expect(events.map(({ eventType }) => eventType)).toEqual([
        "disruption.applied",
        "disruption.cleared",
      ]);
      expect(events.map(({ payload }) => payload)).toEqual([
        expect.objectContaining({
          action: "apply_disruption",
          affectedResource: "block:batch",
        }),
        expect.objectContaining({
          action: "clear_disruption",
          affectedResource: "block:batch",
          releaseReference: "release:batch-test",
        }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("weist eine native Revisionsluecke vor DB-CAS und Fanout zurueck", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000005";
    const livemap = new LivemapRegistry();
    const { runtime } = fakeRuntime({ gap: true });
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      await expect(worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "gap",
        command: { type: "advance-to", atMs: 1_000 },
      }, EPOCH)).rejects.toBeInstanceOf(RegionalSimulationSequenceError);

      const [row] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      expect(row).toMatchObject({ revision: 0, publisherSequence: 0 });
      expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)))
        .toHaveLength(0);
      expect(livemap.initializedWorld(worldId)?.snapshot()).toMatchObject({
        operationalRegions: [expect.objectContaining({ commitSequence: 0 })],
      });
    } finally {
      await client.close();
    }
  });

  it("rekonstruiert nach verlorenem Post-Commit-Fanout exakt den persistierten v2-Kopf", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000006";
    const livemap = new LivemapRegistry();
    const { runtime } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      vi.spyOn(livemap, "publishOperationalRegionSnapshot")
        .mockImplementationOnce(() => { throw new Error("fanout-abgebrochen"); });

      await expect(worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "committed-safe-stop",
        command: {
          type: "safe-stop",
          trainId: `${REGION_ID}-train-1`,
          reason: "Sicherer Halt",
        },
      }, EPOCH)).rejects.toThrow("fanout-abgebrochen");

      expect(worker.isReady(worldId, REGION_ID)).toBe(false);
      expect(livemap.initializedWorld(worldId)).toBeUndefined();
      const [committed] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      expect(committed).toMatchObject({ revision: 1, publisherSequence: 1 });

      await expect(worker.recover(
        worldId,
        REGION_ID,
        operationalSimulationInitializationHash(initialization(worldId)),
      )).resolves.toMatchObject({
        worldId,
        regionId: REGION_ID,
        nowMs: 0,
      });
      expect(livemap.initializedWorld(worldId)?.snapshot().trains[0]).toMatchObject({
        status: "waiting",
        operational: expect.objectContaining({
          commitSequence: 1,
          waitingReason: "Sicherer Halt",
        }),
      });
      expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)))
        .toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await client.close();
    }
  });

  it("verhindert eine ruecklaeufige zweite Region vor Persistenz und LiveMap", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000007";
    const livemap = new LivemapRegistry();
    const { runtime } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId, "east", 2_000), EPOCH);
      await expect(worker.initialize(
        initialization(worldId, "west", 1_999),
        EPOCH,
      )).rejects.toBeInstanceOf(RegionalSimulationConflictError);

      expect(await db.select().from(regionalSimulationStates).where(
        eq(regionalSimulationStates.worldId, worldId),
      )).toEqual([expect.objectContaining({ regionId: "east" })]);
      expect(livemap.initializedWorld(worldId)?.snapshot().operationalRegions)
        .toEqual([expect.objectContaining({ regionId: "east", simulationTimeMs: 2_000 })]);
    } finally {
      await client.close();
    }
  });

  it("begrenzt transaktionale Batches vor Runtime- oder DB-Arbeit auf 256 Kommandos", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000008";
    const livemap = new LivemapRegistry();
    const { runtime, calls } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      await expect(worker.applyBatch({
        worldId,
        regionId: REGION_ID,
        commands: Array.from({ length: OPERATIONAL_SIMULATION_COMMAND_BATCH_LIMIT + 1 }, (_, index) => ({
          commandId: `too-many-${index}`,
          command: { type: "advance-to" as const, atMs: 0 },
        })),
      }, EPOCH)).rejects.toThrow(/256/);
      expect(calls).toHaveLength(0);
      const [row] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      expect(row).toMatchObject({ revision: 0, publisherSequence: 0 });
    } finally {
      await client.close();
    }
  });

  it("akzeptiert bei Revision 52697 nur das lueckenlose 4096er-Receiptfenster", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000014";
    const input = initialization(worldId);
    const expectedInitializationHash = operationalSimulationInitializationHash(input);
    const { runtime } = fakeRuntime();
    const revision = 52_697;
    const firstRetainedRevision = revision - OPERATIONAL_COMMAND_RECEIPT_LIMIT + 1;
    try {
      await insertWorld(db, worldId);
      await new RegionalSimulationWorker(db, runtime, new LivemapRegistry())
        .initialize(input, EPOCH);
      const [initial] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      if (initial === undefined) throw new Error("missing_test_checkpoint");
      const receipts = Object.fromEntries(Array.from(
        { length: OPERATIONAL_COMMAND_RECEIPT_LIMIT },
        (_, index) => {
          const appliedRevision = firstRetainedRevision + index;
          return [
            `command-${appliedRevision}`,
            { commandHash: hash(appliedRevision), appliedRevision },
          ];
        },
      ));
      const state: FakeState = {
        ...(initial.state as FakeState),
        world: {
          ...(initial.state as FakeState).world,
          commitSequence: revision,
          eventSequence: revision,
        },
        revision,
        publisherSequence: revision,
        stateHash: hash(revision),
        commandReceipts: receipts,
      };
      const persist = async (nextState: FakeState): Promise<void> => {
        await db.update(regionalSimulationStates).set({
          state: nextState,
          stateHash: nextState.stateHash,
          revision: nextState.revision,
          publisherSequence: nextState.publisherSequence,
        }).where(and(
          eq(regionalSimulationStates.worldId, worldId),
          eq(regionalSimulationStates.regionId, REGION_ID),
        ));
      };
      await client.query(
        `insert into regional_simulation_command_receipts
          (world_id, region_id, initialization_hash, command_id, command_hash,
           applied_revision, created_at)
         select $1, $2, $3, 'command-' || revision::text,
                lpad(to_hex(revision), 64, '0'), revision, $4
         from generate_series(1, $5::int) as series(revision)`,
        [worldId, REGION_ID, expectedInitializationHash, EPOCH.toISOString(), revision],
      );
      await persist(state);

      await expect(new RegionalSimulationWorker(db, runtime, new LivemapRegistry()).restore(
        worldId,
        REGION_ID,
        expectedInitializationHash,
      )).resolves.toMatchObject({
        state: { revision, publisherSequence: revision },
      });

      const gappedReceipts = { ...receipts };
      delete gappedReceipts[`command-${firstRetainedRevision}`];
      gappedReceipts["command-too-old"] = {
        commandHash: hash(firstRetainedRevision - 1),
        appliedRevision: firstRetainedRevision - 1,
      };
      await expect(persist({ ...state, commandReceipts: gappedReceipts }))
        .rejects.toThrow();

      await expect(persist({
        ...state,
        commandReceipts: {
          ...receipts,
          [`command-${revision}`]: { commandHash: "ungueltig", appliedRevision: revision },
        },
      })).rejects.toThrow();
    } finally {
      await client.close();
    }
  }, 30_000);

  it("verwirft einen DB-Kopf mit fremder Initialisierungsbindung vor Restore und LiveMap", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000010";
    const input = initialization(worldId);
    const expectedInitializationHash = operationalSimulationInitializationHash(input);
    const { runtime } = fakeRuntime();
    try {
      await insertWorld(db, worldId);
      await new RegionalSimulationWorker(db, runtime, new LivemapRegistry())
        .initialize(input, EPOCH);
      const [persisted] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      if (persisted === undefined) throw new Error("missing_test_checkpoint");
      await db.update(regionalSimulationStates).set({
        state: {
          ...(persisted.state as FakeState),
          initializationHash: "f".repeat(64),
        },
      }).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, REGION_ID),
      ));
      const restartedLivemap = new LivemapRegistry();
      const restarted = new RegionalSimulationWorker(db, runtime, restartedLivemap);

      await expect(restarted.restore(
        worldId,
        REGION_ID,
        expectedInitializationHash,
      )).rejects.toBeInstanceOf(RegionalSimulationSequenceError);
      expect(restarted.isReady(worldId, REGION_ID)).toBe(false);
      expect(restartedLivemap.initializedWorld(worldId)).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("projiziert Aktivierung und Freigabe dauerhaft in Eventlog, Mailbox, Operations und LiveMap", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000011";
    const accountIds = [
      "88100000-0000-4000-8000-000000000011",
      "88100000-0000-4000-8000-000000000012",
    ];
    const operatorIds = [
      "88200000-0000-4000-8000-000000000011",
      "88200000-0000-4000-8000-000000000012",
    ];
    const livemap = new LivemapRegistry();
    const operations = new OperationsRegistry();
    const { runtime } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap, operations);
    try {
      await insertWorld(db, worldId);
      await db.insert(accounts).values(accountIds.map((id, index) => ({
        id,
        worldId,
        keycloakSubject: `disruption-recipient-${index}`,
        displayName: `Empfaenger ${index}`,
      })));
      await db.insert(operators).values(operatorIds.map((id, index) => ({
        id,
        worldId,
        foundingAccountId: accountIds[index]!,
        name: `EVU ${index}`,
      })));
      await worker.initialize(initialization(worldId), EPOCH);

      await worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "activate-disruption-1",
        command: {
          type: "activate-disruption",
          disruptionId: "disruption:1",
          effect: { "resource-closed": { resourceId: "block-1" } },
        },
      }, EPOCH);

      const [applied] = await db.select().from(domainEvents)
        .where(eq(domainEvents.worldId, worldId));
      expect(applied).toMatchObject({
        eventType: "disruption.applied",
        payload: expect.objectContaining({
          disruptionId: "disruption:1",
          action: "apply_disruption",
          affectedResource: "block-1",
          operatorIds,
        }),
      });
      expect((await db.select().from(mailboxMessages)
        .where(eq(mailboxMessages.worldId, worldId))))
        .toEqual(expect.arrayContaining(accountIds.map((recipientAccountId) =>
          expect.objectContaining({ recipientAccountId, messageType: "disruption.applied" })
        )));
      for (const operatorId of operatorIds) {
        expect(operations.forOperator(worldId, operatorId).eventsAfter(0)?.[0]?.decision)
          .toMatchObject({ action: "apply_disruption", affectedResource: "block-1" });
      }
      expect(livemap.initializedWorld(worldId)?.snapshot().operationalRegions?.[0]?.activeDisruptions)
        .toEqual([{
          disruptionId: "disruption:1",
          effect: { "resource-closed": { resourceId: "block-1" } },
        }]);

      await worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "clear-disruption-1",
        command: {
          type: "clear-disruption",
          disruptionId: "disruption:1",
          releaseReference: "repair-order:42",
        },
      }, EPOCH);

      const logged = await db.select().from(domainEvents)
        .where(eq(domainEvents.worldId, worldId));
      expect(logged[1]).toMatchObject({
        eventType: "disruption.cleared",
        payload: expect.objectContaining({
          disruptionId: "disruption:1",
          action: "clear_disruption",
          operationalEffect: { "resource-closed": { resourceId: "block-1" } },
          releaseReference: "repair-order:42",
        }),
      });
      const messages = await db.select().from(mailboxMessages)
        .where(eq(mailboxMessages.worldId, worldId));
      expect(messages.filter((message) => message.messageType === "disruption.applied")).toHaveLength(2);
      expect(messages.filter((message) => message.messageType === "disruption.cleared")).toHaveLength(2);
      for (const operatorId of operatorIds) {
        expect(operations.forOperator(worldId, operatorId).eventsAfter(0)?.at(-1)?.decision)
          .toMatchObject({ action: "clear_disruption", affectedResource: "block-1" });
      }
      expect(livemap.initializedWorld(worldId)?.snapshot().operationalRegions?.[0]?.activeDisruptions)
        .toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("released eine Welt idempotent und verhindert Restore sowie weitere Kommandos", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000009";
    const livemap = new LivemapRegistry();
    const { runtime } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
      worker.releaseWorld(worldId);
      worker.releaseWorld(worldId);

      expect(worker.isReady(worldId, REGION_ID)).toBe(false);
      expect(livemap.peekWorld(worldId)).toBeUndefined();
      await expect(worker.restore(
        worldId,
        REGION_ID,
        operationalSimulationInitializationHash(initialization(worldId)),
      ))
        .rejects.toBeInstanceOf(RegionalSimulationUnavailableError);
      await expect(worker.apply({
        worldId,
        regionId: REGION_ID,
        commandId: "after-release",
        command: { type: "advance-to", atMs: 1_000 },
      }, EPOCH)).rejects.toBeInstanceOf(RegionalSimulationUnavailableError);
    } finally {
      await client.close();
    }
  });
});
