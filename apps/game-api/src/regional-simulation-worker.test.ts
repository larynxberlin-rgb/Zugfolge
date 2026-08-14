import { PGlite } from "@electric-sql/pglite";
import { isDeepStrictEqual } from "node:util";
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
import { OperationsRegistry, operationsEventOperatorIds } from "@zugfolge/dispatch";
import {
  LivemapRegistry,
} from "@zugfolge/livemap-stream";
import {
  REGIONAL_LIVEMAP_DELTA_SCHEMA,
  REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA,
  REGIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
  REGIONAL_SIMULATION_COMMAND_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZED_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
  REGIONAL_SIMULATION_RESTORED_SCHEMA,
  REGIONAL_SIMULATION_RESULT_SCHEMA,
  REGIONAL_SIMULATION_STATE_SCHEMA,
  type RegionalLivemapDelta,
  type RegionalPublicDisruption,
  type RegionalPublicTrain,
  type RegionalSimulationCommand,
  type RegionalSimulationEvent,
  type RegionalSimulationInitialization,
  type RegionalSimulationRuntime,
  type RegionalSimulationState,
} from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  RegionalSimulationConflictError,
  RegionalSimulationSequenceError,
  RegionalSimulationUnavailableError,
  RegionalSimulationWorker,
} from "./regional-simulation-worker.js";

const regionId = "leipzig";

interface FakeStoredCommand {
  readonly id: string;
  readonly command: RegionalSimulationCommand["command"];
  readonly delta: RegionalLivemapDelta;
  readonly events: readonly RegionalSimulationEvent[];
}

type FakeState = RegionalSimulationState & {
  readonly materializationWindowHours: number;
  readonly initialTrains: readonly unknown[];
  readonly trains: readonly RegionalPublicTrain[];
  readonly disruptions: readonly RegionalPublicDisruption[];
  readonly commands: readonly FakeStoredCommand[];
};

function hash(revision: number): string {
  return revision.toString(16).padStart(64, "0");
}

function publicTrain(
  train: RegionalSimulationInitialization["trains"][number],
): RegionalPublicTrain {
  const runtime: RegionalSimulationRuntime = {
    id: train.trainRunId,
    operator: train.operator,
    trainNumber: train.trainNumber,
    category: train.category,
    positionMm: train.route[0]?.positionMm ?? 0,
    speedMmPerSecond: 0,
    delaySeconds: 0,
    nextOperatingPoint: train.route[0]?.operatingPoint ?? "unbekannt",
    status: "planned",
  };
  return runtime;
}

function fakeRuntime(gap = false): RegionalSimulationRuntime {
  function snapshot(state: FakeState) {
    return {
      schemaVersion: REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA,
      worldId: state.worldId,
      regionId: state.regionId,
      producerSequence: state.publisherSequence,
      atS: state.nowS,
      trains: state.trains,
      disruptions: state.disruptions,
    } as const;
  }

  const runtime: RegionalSimulationRuntime = {
    initialize(input) {
      const trains = input.trains.map(publicTrain);
      const state: FakeState = {
        schemaVersion: REGIONAL_SIMULATION_STATE_SCHEMA,
        worldId: input.worldId,
        regionId: input.regionId,
        materializationWindowHours: input.materializationWindowHours,
        initialNowS: input.nowS,
        nowS: input.nowS,
        initialTrains: input.trains,
        trains,
        disruptions: [],
        revision: 0,
        publisherSequence: 0,
        commands: [],
      };
      return {
        schemaVersion: REGIONAL_SIMULATION_INITIALIZED_SCHEMA,
        state,
        stateHash: hash(0),
        snapshot: snapshot(state),
        events: [],
      };
    },
    restore(inputState) {
      const state = inputState as FakeState;
      return {
        schemaVersion: REGIONAL_SIMULATION_RESTORED_SCHEMA,
        state,
        stateHash: hash(state.revision),
        snapshot: snapshot(state),
      };
    },
    apply(inputState, envelope) {
      const state = inputState as FakeState;
      const replay = state.commands.find((item) => item.id === envelope.commandId);
      if (replay !== undefined) {
        if (!isDeepStrictEqual(replay.command, envelope.command)) {
          throw new Error("idempotency_conflict");
        }
        return {
          schemaVersion: REGIONAL_SIMULATION_RESULT_SCHEMA,
          state,
          stateHash: hash(state.revision),
          events: replay.events,
          delta: replay.delta,
          appliedCommandId: envelope.commandId,
          idempotentReplay: true,
        };
      }

      let trains = [...state.trains];
      let disruptions = [...state.disruptions];
      let nowS = state.nowS;
      let changed: RegionalPublicTrain[] = [];
      let removed: string[] = [];
      let changedDisruptions: RegionalPublicDisruption[] = [];
      let removedDisruptionIds: string[] = [];
      let eventType = "simulation.time-advanced";
      let eventPayload: Readonly<Record<string, unknown>> = {};
      if (envelope.command.type === "materialize") {
        const train = publicTrain(envelope.command.train);
        trains.push(train);
        changed = [train];
        eventType = "simulation.train-materialized";
      } else if (envelope.command.type === "advance-to") {
        nowS = envelope.command.atS;
        trains = trains.map((train) => ({ ...train, status: "running" as const }));
        changed = trains;
      } else if (envelope.command.type === "add-delay") {
        trains = trains.map((train) =>
          train.id === envelope.command.trainRunId
            ? { ...train, delaySeconds: train.delaySeconds + envelope.command.seconds }
            : train,
        );
        changed = trains.filter((train) => train.id === envelope.command.trainRunId);
        eventType = "simulation.delay-changed";
      } else if (envelope.command.type === "register-disruption") {
        const input = envelope.command.disruption;
        const disruption: RegionalPublicDisruption = {
          schemaVersion: "zugfolge-livemap-disruption/v1",
          disruptionId: input.disruptionId,
          kind: input.kind,
          publishedAtS: input.publishedAtS,
          startsAtS: input.startsAtS,
          validUntilS: input.validUntilS,
          positionMm: input.positionMm,
          causeCode: input.causeCode,
          causeLabel: "Anlagen Leit- und Sicherungstechnik",
          fineCauseId: input.fineCauseId,
          fineCauseLabel: "Stellwerk gestört",
          effect: input.effect,
          affectedResource: input.affectedResource,
        };
        disruptions.push(disruption);
        changedDisruptions = [disruption];
        eventType = "disruption.registered";
      } else if (envelope.command.type === "activate-disruption") {
        const affectedOperators = trains
          .filter((train) => envelope.command.affectedTrainRunIds.includes(train.id))
          .map((train) => train.operator);
        trains = trains.map((train) =>
          envelope.command.affectedTrainRunIds.includes(train.id)
            ? { ...train, delaySeconds: train.delaySeconds + envelope.command.delaySeconds }
            : train,
        );
        changed = trains.filter((train) => envelope.command.affectedTrainRunIds.includes(train.id));
        eventType = "disruption.applied";
        eventPayload = {
          operatorIds: affectedOperators,
          affectedTrainRunIds: envelope.command.affectedTrainRunIds,
          action: "apply_disruption",
          causeCode: 25,
          causeLabel: "Anlagen Leit- und Sicherungstechnik",
          fineCauseId: "signalling.interlocking",
          fineCauseLabel: "Stellwerk gestört",
          affectedResource: "block:A:B:1",
          outcomeReason: "Betriebswirksame Einschränkung angewendet",
          impact: { affected_train_runs: envelope.command.affectedTrainRunIds.length, affected_resource: "block:A:B:1" },
        };
      } else {
        removed = trains.map((train) => train.id);
        trains = [];
        eventType = "simulation.train-dematerialized";
      }
      const nextRevision = state.revision + (gap ? 2 : 1);
      const delta: RegionalLivemapDelta = {
        schemaVersion: REGIONAL_LIVEMAP_DELTA_SCHEMA,
        worldId: state.worldId,
        regionId: state.regionId,
        producerSequence: nextRevision,
        atS: nowS,
        changed,
        removed,
        changedDisruptions,
        removedDisruptionIds,
      };
      const events: readonly RegionalSimulationEvent[] = [
        {
          eventId: `simulation:${state.worldId}:${state.regionId}:${nextRevision}`,
          worldId: state.worldId,
          regionId: state.regionId,
          simulationSequence: nextRevision,
          eventType,
          atS: nowS,
          payload: eventPayload,
        },
      ];
      const stored: FakeStoredCommand = {
        id: envelope.commandId,
        command: envelope.command,
        delta,
        events,
      };
      const commands = [...state.commands, stored];
      if (gap) commands.push({ ...stored, id: `${stored.id}-gap` });
      const nextState: FakeState = {
        ...state,
        nowS,
        trains,
        disruptions,
        revision: nextRevision,
        publisherSequence: nextRevision,
        commands,
      };
      return {
        schemaVersion: REGIONAL_SIMULATION_RESULT_SCHEMA,
        state: nextState,
        stateHash: hash(nextRevision),
        events,
        delta,
        appliedCommandId: envelope.commandId,
        idempotentReplay: false,
      };
    },
    applyBatch(inputState, batch) {
      let state = inputState as FakeState;
      const events: RegionalSimulationEvent[] = [];
      const commandResults: Array<{ commandId: string; idempotentReplay: boolean }> = [];
      for (const command of batch.commands) {
        const result = runtime.apply(state, {
          schemaVersion: REGIONAL_SIMULATION_COMMAND_SCHEMA,
          worldId: batch.worldId,
          regionId: batch.regionId,
          commandId: command.commandId,
          expectedStateHash: hash(state.revision),
          expectedRevision: state.revision,
          expectedPublisherSequence: state.publisherSequence,
          command: command.command,
        });
        commandResults.push({
          commandId: command.commandId,
          idempotentReplay: result.idempotentReplay,
        });
        if (!result.idempotentReplay) events.push(...result.events);
        state = result.state as FakeState;
      }
      return {
        schemaVersion: REGIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
        state,
        stateHash: hash(state.revision),
        events,
        snapshot: snapshot(state),
        commandResults,
      };
    },
  };
  return runtime;
}

function initialization(worldId: string): RegionalSimulationInitialization {
  return {
    schemaVersion: REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
    worldId,
    regionId,
    materializationWindowHours: 48,
    nowS: 0,
    trains: [],
  };
}

function train(id: string) {
  return {
    trainRunId: id,
    operator: "operator-1",
    trainNumber: "RE 1",
    category: "regional" as const,
    route: [
      {
        operatingPoint: "Leipzig Hbf",
        positionMm: 0,
        arrivalS: 0,
        minimumDwellSeconds: 30,
        departureS: 30,
      },
    ],
  };
}

async function testDatabase() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { client, db };
}

describe("regionaler M4-Simulationsworker", () => {
  it("liefert eine angewendete Störung atomar an Event-Log, EVU-Push und Postfach", async () => {
    const { client, db } = await testDatabase();
    const worldId = "88888888-8888-4888-8888-888888888888";
    const livemap = new LivemapRegistry();
    const operations = new OperationsRegistry();
    const worker = new RegionalSimulationWorker(db, fakeRuntime(), livemap, operations);
    try {
      await db.insert(worlds).values({
        id: worldId,
        name: "Störungszustellwelt",
        schedulePeriodWeeks: 4,
        epoch: new Date(0),
      });
      const [account] = await db.insert(accounts).values({
        worldId,
        keycloakSubject: "operator-owner",
        displayName: "Leitstelle",
      }).returning();
      const [operator] = await db.insert(operators).values({
        worldId,
        foundingAccountId: account!.id,
        name: "Testverkehr",
      }).returning();
      await worker.initialize(initialization(worldId), new Date(0));
      await worker.apply({
        worldId,
        regionId,
        commandId: "materialize-disrupted-run",
        command: { type: "materialize", train: { ...train("run-1"), operator: operator!.id } },
      }, new Date(1_000));
      await worker.apply({
        worldId,
        regionId,
        commandId: "register-unplanned-disruption",
        command: {
          type: "register-disruption",
          disruption: {
            disruptionId: "unplanned-1",
            kind: "unplanned",
            publishedAtS: 0,
            startsAtS: 0,
            validUntilS: 3_600,
            positionMm: 1_200_000,
            causeCode: 25,
            fineCauseId: "signalling.interlocking",
            effect: "closure",
            affectedResource: "block:A:B:1",
            affectedTrainRunIds: [],
            delaySeconds: 0,
          },
        },
      }, new Date(2_000));

      const pushed: unknown[] = [];
      operations.forOperator(worldId, operator!.id).subscribe((event) => pushed.push(event));
      const activationWork = {
        worldId,
        regionId,
        commandId: "activate-unplanned-disruption",
        command: {
          type: "activate-disruption" as const,
          disruptionId: "unplanned-1",
          affectedTrainRunIds: ["run-1"],
          delaySeconds: 300,
        },
      };
      await worker.apply(activationWork, new Date(3_000));

      expect(pushed).toEqual([
        expect.objectContaining({
          worldId,
          operatorId: operator!.id,
          decision: expect.objectContaining({
            action: "apply_disruption",
            fineCauseId: "signalling.interlocking",
          }),
        }),
      ]);
      expect(await db.select().from(mailboxMessages).where(eq(mailboxMessages.worldId, worldId))).toEqual([
        expect.objectContaining({
          recipientAccountId: account!.id,
          messageType: "disruption.applied",
        }),
      ]);
      const appliedEvents = await db.select().from(domainEvents).where(and(
        eq(domainEvents.worldId, worldId),
        eq(domainEvents.eventType, "disruption.applied"),
      ));
      expect(appliedEvents[0]?.payload).toMatchObject({
        operatorIds: [operator!.id],
        fineCauseId: "signalling.interlocking",
        affectedResource: "block:A:B:1",
      });

      expect(await db.select().from(mailboxMessages).where(eq(mailboxMessages.worldId, worldId))).toHaveLength(1);
      expect(pushed).toHaveLength(1);
    } finally {
      await client.close();
    }
  }, 15_000);

  it("holt nach Commit vor Operations-Publish den weltgebundenen Fanout ohne Livemap-Duplikat nach", async () => {
    const { client, db } = await testDatabase();
    const worldId = "89898989-8989-4989-8989-898989898989";
    const foreignWorldId = "90909090-9090-4090-8090-909090909090";
    const livemap = new LivemapRegistry();
    const operations = new OperationsRegistry();
    let failNextOperationsPublish = false;
    const crashableOperations = {
      forOperator(scopedWorldId: string, operatorId: string) {
        if (failNextOperationsPublish) {
          failNextOperationsPublish = false;
          throw new Error("Crash nach Commit vor Operations-Publish");
        }
        return operations.forOperator(scopedWorldId, operatorId);
      },
      releaseWorld(scopedWorldId: string) {
        operations.releaseWorld(scopedWorldId);
      },
    } as unknown as OperationsRegistry;
    const worker = new RegionalSimulationWorker(db, fakeRuntime(), livemap, crashableOperations);
    try {
      await db.insert(worlds).values([
        {
          id: worldId,
          name: "Operations-Recovery-Welt",
          schedulePeriodWeeks: 4,
          epoch: new Date(0),
        },
        {
          id: foreignWorldId,
          name: "Fremde Operations-Welt",
          schedulePeriodWeeks: 4,
          epoch: new Date(0),
        },
      ]);
      const [account] = await db.insert(accounts).values({
        worldId,
        keycloakSubject: "recovery-operator-owner",
        displayName: "Recovery-Leitstelle",
      }).returning();
      const [operator] = await db.insert(operators).values({
        worldId,
        foundingAccountId: account!.id,
        name: "Recovery-Verkehr",
      }).returning();
      await worker.initialize(initialization(worldId), new Date(0));
      await worker.apply({
        worldId,
        regionId,
        commandId: "materialize-recovery-run",
        command: { type: "materialize", train: { ...train("recovery-run"), operator: operator!.id } },
      }, new Date(1_000));
      await worker.apply({
        worldId,
        regionId,
        commandId: "register-recovery-disruption",
        command: {
          type: "register-disruption",
          disruption: {
            disruptionId: "recovery-disruption",
            kind: "unplanned",
            publishedAtS: 0,
            startsAtS: 0,
            validUntilS: 3_600,
            positionMm: 1_200_000,
            causeCode: 25,
            fineCauseId: "signalling.interlocking",
            effect: "closure",
            affectedResource: "block:A:B:1",
            affectedTrainRunIds: [],
            delaySeconds: 0,
          },
        },
      }, new Date(2_000));

      const pushed: unknown[] = [];
      operations.forOperator(worldId, operator!.id).subscribe((event) => pushed.push(event));
      const activationWork = {
        worldId,
        regionId,
        commandId: "activate-recovery-disruption",
        command: {
          type: "activate-disruption" as const,
          disruptionId: "recovery-disruption",
          affectedTrainRunIds: ["recovery-run"],
          delaySeconds: 300,
        },
      };
      failNextOperationsPublish = true;
      await expect(worker.apply(activationWork, new Date(3_000)))
        .rejects.toThrow("Crash nach Commit vor Operations-Publish");

      expect(pushed).toEqual([]);
      expect(worker.isReady(worldId, regionId)).toBe(false);
      expect(livemap.isInitialized(worldId)).toBe(false);
      const [committedEvent] = await db.select().from(domainEvents).where(and(
        eq(domainEvents.worldId, worldId),
        eq(domainEvents.eventType, "disruption.applied"),
      ));
      expect(committedEvent).toBeDefined();
      expect(committedEvent!.payload).toMatchObject({ operatorIds: [operator!.id] });
      expect(operationsEventOperatorIds(committedEvent!)).toEqual([operator!.id]);
      await db.insert(domainEvents).values({
        worldId: foreignWorldId,
        sequence: 1,
        eventType: "disruption.applied",
        payload: {
          operatorIds: [operator!.id],
          action: "foreign_action_must_not_leak",
          impact: {},
        },
        occurredAt: new Date(3_000),
      });

      await expect(worker.recover(worldId, regionId)).resolves.toMatchObject({ nowS: 0 });
      expect(operations.forOperator(worldId, operator!.id).eventsAfter(committedEvent!.sequence - 1)).toEqual([
        expect.objectContaining({
          worldId,
          operatorId: operator!.id,
          sequence: committedEvent!.sequence,
          decision: expect.objectContaining({ action: "apply_disruption" }),
        }),
      ]);
      expect(pushed).toEqual([
        expect.objectContaining({
          worldId,
          operatorId: operator!.id,
          sequence: committedEvent!.sequence,
          decision: expect.objectContaining({ action: "apply_disruption" }),
        }),
      ]);
      const recoveredSnapshot = livemap.forWorld(worldId).snapshot();
      await expect(worker.recover(worldId, regionId)).resolves.toMatchObject({ nowS: 0 });
      expect(pushed).toHaveLength(1);
      expect(livemap.forWorld(worldId).snapshot()).toMatchObject({
        at: recoveredSnapshot.at,
        trains: recoveredSnapshot.trains,
        externalTrains: recoveredSnapshot.externalTrains,
        disruptions: recoveredSnapshot.disruptions,
      });

      const restartedOperations = new OperationsRegistry();
      const restartedPushes: unknown[] = [];
      restartedOperations.forOperator(worldId, operator!.id)
        .subscribe((event) => restartedPushes.push(event));
      const restarted = new RegionalSimulationWorker(
        db,
        fakeRuntime(),
        new LivemapRegistry(),
        restartedOperations,
      );
      await expect(restarted.restore(worldId, regionId)).resolves.toMatchObject({
        state: expect.objectContaining({ worldId, regionId }),
      });
      expect(restartedPushes).toEqual([
        expect.objectContaining({
          worldId,
          operatorId: operator!.id,
          sequence: committedEvent!.sequence,
          decision: expect.objectContaining({ action: "apply_disruption" }),
        }),
      ]);
    } finally {
      await client.close();
    }
  }, 15_000);

  it("publiziert geplante Infrastrukturmarker getrennt von Zügen und restauriert sie", async () => {
    const { client, db } = await testDatabase();
    const worldId = "77777777-7777-4777-8777-777777777777";
    const livemap = new LivemapRegistry();
    const worker = new RegionalSimulationWorker(db, fakeRuntime(), livemap);
    try {
      await db.insert(worlds).values({
        id: worldId,
        name: "Störungskartenwelt",
        schedulePeriodWeeks: 4,
        epoch: new Date(0),
      });
      await worker.initialize(initialization(worldId), new Date(0));
      await worker.apply(
        {
          worldId,
          regionId,
          commandId: "register-planned-closure",
          command: {
            type: "register-disruption",
            disruption: {
              disruptionId: "planned-closure-1",
              kind: "planned",
              publishedAtS: 0,
              startsAtS: 86_400,
              validUntilS: 172_800,
              positionMm: 1_200_000,
              causeCode: 25,
              fineCauseId: "signalling.interlocking",
              effect: "closure",
              affectedResource: "block:A:B:1",
              affectedTrainRunIds: [],
              delaySeconds: 0,
            },
          },
        },
        new Date(1_000),
      );
      expect(livemap.forWorld(worldId).snapshot()).toMatchObject({
        trains: [],
        disruptions: [
          expect.objectContaining({
            disruptionId: "planned-closure-1",
            kind: "planned",
            effect: "closure",
          }),
        ],
      });

      const restartedLivemap = new LivemapRegistry();
      const restarted = new RegionalSimulationWorker(db, fakeRuntime(), restartedLivemap);
      await restarted.restore(worldId, regionId);
      expect(restartedLivemap.forWorld(worldId).snapshot().disruptions).toEqual([
        expect.objectContaining({ disruptionId: "planned-closure-1", kind: "planned" }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("persistiert Materialize/Advance/Remove vor Fanout und restauriert nach Neustart", async () => {
    const { client, db } = await testDatabase();
    const worldId = "11111111-1111-4111-8111-111111111111";
    const livemap = new LivemapRegistry();
    const worker = new RegionalSimulationWorker(db, fakeRuntime(), livemap);
    try {
      await db.insert(worlds).values({
        id: worldId,
        name: "M4-Testwelt",
        schedulePeriodWeeks: 4,
        epoch: new Date("2026-08-11T00:00:00Z"),
      });
      await worker.initialize(initialization(worldId), new Date("2026-08-11T00:00:00Z"));
      expect(livemap.isInitialized(worldId)).toBe(true);

      const persistedAtFanout: Promise<number>[] = [];
      livemap.forWorld(worldId).subscribe(() => {
        persistedAtFanout.push(
          db
            .select({ revision: regionalSimulationStates.revision })
            .from(regionalSimulationStates)
            .where(
              and(
                eq(regionalSimulationStates.worldId, worldId),
                eq(regionalSimulationStates.regionId, regionId),
              ),
            )
            .then((rows) => rows[0]!.revision),
        );
      });
      await worker.apply(
        {
          worldId,
          regionId,
          commandId: "materialize-1",
          command: { type: "materialize", train: train("run-1") },
        },
        new Date("2026-08-11T00:00:01Z"),
      );
      await worker.apply(
        {
          worldId,
          regionId,
          commandId: "advance-1",
          command: { type: "advance-to", atS: 100 },
        },
        new Date("2026-08-11T00:00:02Z"),
      );
      await worker.apply(
        {
          worldId,
          regionId,
          commandId: "remove-1",
          command: { type: "dematerialize-before", beforeS: 101 },
        },
        new Date("2026-08-11T00:00:03Z"),
      );

      await expect(Promise.all(persistedAtFanout)).resolves.toEqual([1, 2, 3]);
      expect(livemap.forWorld(worldId).snapshot()).toMatchObject({
        sequence: 4,
        at: 100,
        trains: [],
      });
      const [persisted] = await db
        .select()
        .from(regionalSimulationStates)
        .where(
          and(
            eq(regionalSimulationStates.worldId, worldId),
            eq(regionalSimulationStates.regionId, regionId),
          ),
        );
      expect(persisted).toMatchObject({ revision: 3, publisherSequence: 3 });
      expect(
        await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)),
      ).toHaveLength(3);

      const restartedLivemap = new LivemapRegistry();
      const restarted = new RegionalSimulationWorker(db, fakeRuntime(), restartedLivemap);
      expect(restartedLivemap.isInitialized(worldId)).toBe(false);
      await expect(restarted.recover(worldId, regionId)).resolves.toMatchObject({
        worldId,
        regionId,
        nowS: 100,
      });
      expect(restartedLivemap.isInitialized(worldId)).toBe(true);
      expect(restartedLivemap.forWorld(worldId).snapshot()).toMatchObject({
        sequence: 1,
        at: 100,
        trains: [],
      });
      const replay = await restarted.apply(
        {
          worldId,
          regionId,
          commandId: "remove-1",
          command: { type: "dematerialize-before", beforeS: 101 },
        },
        new Date("2026-08-11T00:00:04Z"),
      );
      expect(replay.idempotentReplay).toBe(true);
      expect(restartedLivemap.forWorld(worldId).snapshot().sequence).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("committet einen Scheduler-Batch atomar und erholt sich nach verlorenem Snapshot-Fanout", async () => {
    const { client, db } = await testDatabase();
    const worldId = "12121212-1212-4121-8121-121212121212";
    const livemap = new LivemapRegistry();
    let failNextInitialize = false;
    const crashableLivemap = new Proxy(livemap, {
      get(target, property) {
        if (property === "initializeRegion") {
          return (...args: Parameters<LivemapRegistry["initializeRegion"]>) => {
            if (failNextInitialize) {
              failNextInitialize = false;
              throw new Error("Crash nach Batch-Commit vor Snapshot-Fanout");
            }
            return target.initializeRegion(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LivemapRegistry;
    const worker = new RegionalSimulationWorker(db, fakeRuntime(), crashableLivemap);
    const work = {
      worldId,
      regionId,
      commands: [
        { commandId: "materialize-batch", command: { type: "materialize" as const, train: train("batch-run") } },
        { commandId: "advance-batch", command: { type: "advance-to" as const, atS: 100 } },
        { commandId: "remove-batch", command: { type: "dematerialize-before" as const, beforeS: 101 } },
      ],
    };
    try {
      await db.insert(worlds).values({
        id: worldId,
        name: "Atomare Batchwelt",
        schedulePeriodWeeks: 4,
        epoch: new Date("2026-08-11T00:00:00Z"),
      });
      await worker.initialize(initialization(worldId), new Date("2026-08-11T00:00:00Z"));

      failNextInitialize = true;
      await expect(
        worker.applyBatch(work, new Date("2026-08-11T00:00:01Z")),
      ).rejects.toThrow("Crash nach Batch-Commit vor Snapshot-Fanout");
      expect(worker.readyRegions()).toEqual([]);
      const [committed] = await db.select().from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, regionId),
      ));
      expect(committed).toMatchObject({ revision: 3, publisherSequence: 3 });
      expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId))).toHaveLength(3);

      await expect(worker.recover(worldId, regionId)).resolves.toMatchObject({ nowS: 100 });
      expect(livemap.forWorld(worldId).snapshot()).toMatchObject({ at: 100, trains: [] });
      const replay = await worker.applyBatch(work, new Date("2026-08-11T00:00:02Z"));
      expect(replay.commandResults).toEqual([
        { commandId: "materialize-batch", idempotentReplay: true },
        { commandId: "advance-batch", idempotentReplay: true },
        { commandId: "remove-batch", idempotentReplay: true },
      ]);
      expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId))).toHaveLength(3);
    } finally {
      await client.close();
    }
  }, 15_000);

  it("rollt eine native Publisher-Luecke ohne DB- oder Fanout-Aenderung zurueck", async () => {
    const { client, db } = await testDatabase();
    const worldId = "22222222-2222-4222-8222-222222222222";
    const livemap = new LivemapRegistry();
    const worker = new RegionalSimulationWorker(db, fakeRuntime(true), livemap);
    try {
      await db.insert(worlds).values({
        id: worldId,
        name: "Lueckenwelt",
        schedulePeriodWeeks: 4,
        epoch: new Date(0),
      });
      await worker.initialize(initialization(worldId), new Date(0));
      await expect(
        worker.apply(
          {
            worldId,
            regionId,
            commandId: "gap",
            command: { type: "advance-to", atS: 1 },
          },
          new Date(1_000),
        ),
      ).rejects.toBeInstanceOf(RegionalSimulationSequenceError);
      const [row] = await db
        .select()
        .from(regionalSimulationStates)
        .where(
          and(
            eq(regionalSimulationStates.worldId, worldId),
            eq(regionalSimulationStates.regionId, regionId),
          ),
        );
      expect(row).toMatchObject({ revision: 0, publisherSequence: 0 });
      expect(livemap.forWorld(worldId).snapshot().sequence).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("rekonstruiert nach TTL-Eviction einen vollstaendigen Rust-Snapshot", async () => {
    const { client, db } = await testDatabase();
    const worldId = "55555555-5555-4555-8555-555555555555";
    let clock = 0;
    const livemap = new LivemapRegistry({ idleTtlMs: 100, now: () => clock });
    const worker = new RegionalSimulationWorker(db, fakeRuntime(), livemap);
    try {
      await db.insert(worlds).values({
        id: worldId,
        name: "TTL-Welt",
        schedulePeriodWeeks: 4,
        epoch: new Date(0),
      });
      await worker.initialize(initialization(worldId), new Date(0));
      await worker.apply(
        {
          worldId,
          regionId,
          commandId: "materialize-before-ttl",
          command: { type: "materialize", train: train("run-after-ttl") },
        },
        new Date(1_000),
      );

      clock = 101;
      livemap.forWorld("andere-welt");
      expect(livemap.peekWorld(worldId)).toBeUndefined();
      await worker.apply(
        {
          worldId,
          regionId,
          commandId: "advance-after-ttl",
          command: { type: "advance-to", atS: 2 },
        },
        new Date(2_000),
      );

      expect(livemap.initializedWorld(worldId)?.snapshot()).toMatchObject({
        sequence: 1,
        at: 2,
        trains: [expect.objectContaining({ id: "run-after-ttl", status: "running" })],
      });
      expect(worker.readyRegions()).toEqual([
        { worldId, regionId, nowS: 2 },
      ]);
    } finally {
      await client.close();
    }
  });

  it("verhindert ruecklaeufige Regionskoepfe vor DB-Commit und Fanout", async () => {
    const { client, db } = await testDatabase();
    const worldId = "66666666-6666-4666-8666-666666666666";
    const livemap = new LivemapRegistry();
    const worker = new RegionalSimulationWorker(db, fakeRuntime(), livemap);
    try {
      await db.insert(worlds).values({
        id: worldId,
        name: "Zeitgebundene Welt",
        schedulePeriodWeeks: 4,
        epoch: new Date(0),
      });
      await worker.initialize(
        { ...initialization(worldId), nowS: 40 },
        new Date(40_000),
      );

      await expect(
        worker.initialize(
          { ...initialization(worldId), regionId: "halle", nowS: 30 },
          new Date(30_000),
        ),
      ).rejects.toBeInstanceOf(RegionalSimulationConflictError);
      expect(
        await db
          .select({ regionId: regionalSimulationStates.regionId })
          .from(regionalSimulationStates)
          .where(eq(regionalSimulationStates.worldId, worldId)),
      ).toEqual([{ regionId }]);
      expect(livemap.initializedWorld(worldId)?.snapshot()).toMatchObject({
        at: 40,
        sequence: 1,
        trains: [],
      });

      await worker.initialize(
        { ...initialization(worldId), regionId: "halle", nowS: 50 },
        new Date(50_000),
      );
      await expect(
        worker.apply(
          {
            worldId,
            regionId,
            commandId: "stale-materialize",
            command: { type: "materialize", train: train("stale-run") },
          },
          new Date(51_000),
        ),
      ).rejects.toBeInstanceOf(RegionalSimulationConflictError);
      const [leipzig] = await db
        .select()
        .from(regionalSimulationStates)
        .where(
          and(
            eq(regionalSimulationStates.worldId, worldId),
            eq(regionalSimulationStates.regionId, regionId),
          ),
        );
      expect(leipzig).toMatchObject({ revision: 0, publisherSequence: 0 });
      expect(livemap.initializedWorld(worldId)?.snapshot()).toMatchObject({
        at: 50,
        sequence: 2,
        trains: [],
      });
    } finally {
      await client.close();
    }
  });

  it("isoliert gleiche Regionen zweier Welten und bleibt ohne Restore nicht bereit", async () => {
    const { client, db } = await testDatabase();
    const worldA = "33333333-3333-4333-8333-333333333333";
    const worldB = "44444444-4444-4444-8444-444444444444";
    const livemap = new LivemapRegistry();
    const worker = new RegionalSimulationWorker(db, fakeRuntime(), livemap);
    try {
      await db.insert(worlds).values([
        { id: worldA, name: "A", schedulePeriodWeeks: 4, epoch: new Date(0) },
        { id: worldB, name: "B", schedulePeriodWeeks: 4, epoch: new Date(0) },
      ]);
      await worker.initialize(initialization(worldA), new Date(0));
      await worker.initialize(initialization(worldB), new Date(0));
      await worker.apply(
        {
          worldId: worldA,
          regionId,
          commandId: "materialize-a",
          command: { type: "materialize", train: train("run-a") },
        },
        new Date(1_000),
      );
      expect(livemap.forWorld(worldA).snapshot().trains.map((item) => item.id)).toEqual([
        "run-a",
      ]);
      expect(livemap.forWorld(worldB).snapshot().trains).toEqual([]);
      const rowsB = await db
        .select()
        .from(regionalSimulationStates)
        .where(
          and(
            eq(regionalSimulationStates.worldId, worldB),
            eq(regionalSimulationStates.regionId, regionId),
          ),
        );
      expect(rowsB).toEqual([expect.objectContaining({ revision: 0, publisherSequence: 0 })]);

      const coldWorker = new RegionalSimulationWorker(db, fakeRuntime(), new LivemapRegistry());
      await expect(
        coldWorker.apply(
          {
            worldId: worldA,
            regionId,
            commandId: "cold",
            command: { type: "advance-to", atS: 2 },
          },
          new Date(2_000),
        ),
      ).rejects.toBeInstanceOf(RegionalSimulationUnavailableError);
    } finally {
      await client.close();
    }
  });

  it("released eine archivierte Welt idempotent und verhindert Restore sowie weitere Deltas", async () => {
    const { client, db } = await testDatabase();
    const worldId = "55555555-5555-4555-8555-555555555555";
    const livemap = new LivemapRegistry();
    const operations = new OperationsRegistry();
    const publicOperations = operations.forOperator("public-world", "public-operator");
    operations.forOperator(worldId, "tutorial-operator");
    const worker = new RegionalSimulationWorker(db, fakeRuntime(), livemap, operations);
    try {
      await db.insert(worlds).values({
        id: worldId,
        name: "Archiviertes Tutorial",
        schedulePeriodWeeks: 4,
        epoch: new Date(0),
      });
      await worker.initialize(initialization(worldId), new Date(0));
      expect(worker.isReady(worldId, regionId)).toBe(true);
      expect(livemap.initializedWorld(worldId)).toBeDefined();

      worker.releaseWorld(worldId);
      worker.releaseWorld(worldId);

      expect(worker.isReady(worldId, regionId)).toBe(false);
      expect(worker.readyRegions()).not.toContainEqual(expect.objectContaining({ worldId }));
      expect(livemap.size).toBe(0);
      expect(livemap.peekWorld(worldId)).toBeUndefined();
      expect(operations.size).toBe(1);
      expect(operations.forOperator("public-world", "public-operator")).toBe(publicOperations);
      expect(operations.forOperator(worldId, "tutorial-operator")).not.toBe(publicOperations);
      await expect(worker.apply(
        {
          worldId,
          regionId,
          commandId: "post-archive",
          command: { type: "advance-to", atS: 2 },
        },
        new Date(2_000),
      )).rejects.toBeInstanceOf(RegionalSimulationUnavailableError);
      await expect(worker.restore(worldId, regionId))
        .rejects.toBeInstanceOf(RegionalSimulationUnavailableError);
      expect(await db.select().from(regionalSimulationStates).where(
        eq(regionalSimulationStates.worldId, worldId),
      )).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
