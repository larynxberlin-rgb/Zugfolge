import { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  domainEvents,
  mailboxMessages,
  MIGRATIONS_FOLDER,
  operators,
  regionalSimulationStates,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { OperationsRegistry } from "@zugfolge/dispatch";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
import {
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

type FakeState = OperationalSimulationState & {
  readonly world: OperationalSimulationState["world"] & {
    readonly events: readonly unknown[];
    readonly activeDisruptions: Readonly<Record<string, OperationalDisruption>>;
  };
  readonly commandReceipts: Readonly<Record<string, string>>;
  readonly projectedTrains: readonly OperationalProjectedTrain[];
};

interface FakeRuntimeOptions {
  readonly gap?: boolean;
  readonly failCommandId?: string;
}

function hash(revision: number): string {
  return revision.toString(16).padStart(64, "0");
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
} {
  const calls: OperationalSimulationCommand[] = [];
  const runtime: OperationalSimulationRuntime = {
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
      const state = inputState as FakeState;
      calls.push(envelope);
      const serializedCommand = JSON.stringify(envelope.command);
      const receipt = state.commandReceipts[envelope.commandId];
      if (receipt !== undefined) {
        if (receipt !== serializedCommand) throw new Error("idempotency_conflict");
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
        commandReceipts: {
          ...state.commandReceipts,
          [envelope.commandId]: serializedCommand,
        },
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
  };
  return { runtime, calls };
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
    const { runtime, calls } = fakeRuntime();
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
      expect(calls.map((call) => call.expectedRevision)).toEqual([0, 1, 1]);
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

  it("publiziert jeden neuen Batchcommit lueckenlos einzeln an den LiveMap-Stream", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-00000000000a";
    const livemap = new LivemapRegistry();
    const { runtime } = fakeRuntime();
    const worker = new RegionalSimulationWorker(db, runtime, livemap);
    try {
      await insertWorld(db, worldId);
      await worker.initialize(initialization(worldId), EPOCH);
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
      expect(publish.mock.calls.map((call) =>
        call[2].operationalRegions[0]?.commitSequence)).toEqual([1, 2, 3]);
      expect(livemap.initializedWorld(worldId)?.snapshot().operationalRegions)
        .toEqual([expect.objectContaining({ commitSequence: 3, simulationTimeMs: 2_000 })]);
      expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)))
        .toHaveLength(3);
    } finally {
      vi.restoreAllMocks();
      await client.close();
    }
  });

  it("rollt einen abgelehnten Batch ohne Zustand, Event oder Fanout zurueck", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88000000-0000-4000-8000-000000000004";
    const livemap = new LivemapRegistry();
    const { runtime } = fakeRuntime({ failCommandId: "reject" });
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

  it("begrenzt transaktionale Batches vor Runtime- oder DB-Arbeit auf 4096 Kommandos", async () => {
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
        commands: Array.from({ length: 4_097 }, (_, index) => ({
          commandId: `too-many-${index}`,
          command: { type: "advance-to" as const, atMs: 0 },
        })),
      }, EPOCH)).rejects.toThrow(/4096/);
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
      await db.update(regionalSimulationStates).set({
        initializationHash: "f".repeat(64),
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
