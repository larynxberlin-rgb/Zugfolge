import { PGlite } from "@electric-sql/pglite";
import {
  MIGRATIONS_FOLDER,
  accounts,
  domainEvents,
  operators,
  simulationCommands,
  worlds,
} from "@zugfolge/db";
import {
  type PlanningCoordinateCommand,
  type PlanningRuntime,
  type PlanningRuntimeResult,
  type PlanningRuntimeState,
} from "@zugfolge/planning-runtime-native";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@zugfolge/db/schema";

import {
  PLANNING_COORDINATE_AUTHORITY_SCHEMA,
  PLANNING_INFRASTRUCTURE_RELEASE_SCHEMA,
  PLANNING_PATH_REQUEST_SCHEMA,
} from "./contract.js";
import {
  consumePendingPlanningCommands,
  planningInfrastructureReleaseCatalog,
  processPlanningCommand,
  queuePlanningCoordinate,
  queuePlanningPathRequest,
  type PlanningDatabase,
} from "./worker.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTHORITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OPERATOR_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OPERATOR_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OPERATOR_B_SECOND = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function projection(revision: number, withConflict: boolean) {
  return {
    schemaVersion: "planning-projection/v1" as const,
    projectionRevision: revision,
    worldId: WORLD,
    corridor: { id: "corridor", name: "Korridor" },
    stations: [
      { id: "a", name: "A", distanceMm: 0 },
      { id: "b", name: "B", distanceMm: 1_000_000 },
    ],
    trains: [
      { id: "train-a", number: "R 26802", direction: "with-chainage" as const, calls: [{ stationId: "a", timeS: 100 }, { stationId: "b", timeS: 200 }] },
      { id: "train-b", number: "R 26804", direction: "against-chainage" as const, calls: [{ stationId: "b", timeS: withConflict ? 100 : 300 }, { stationId: "a", timeS: withConflict ? 200 : 400 }] },
    ],
    occupations: [],
    conflicts: withConflict ? [{
      id: "conflict-1",
      kind: "opposing-move" as const,
      resource: { id: "block-1", kind: "block" as const, label: "Block 1" },
      window: { startS: 120, endS: 180 },
      trainIds: ["train-a", "train-b"] as const,
      explanation: "Gegenfahrt im eingleisigen Block.",
      alternative: { alternativeId: "alt-1", trainId: "train-b", departureShiftS: 200, explanation: "Gepruefte spaetere Lage." },
    }] : [],
  };
}

function state(revision: number, withConflict: boolean): PlanningRuntimeState {
  return {
    schemaVersion: "zugfolge-planning-runtime-state/v1",
    worldId: WORLD,
    projectionRevision: revision,
    projection: projection(revision, withConflict),
    alternatives: withConflict ? { "alt-1": {} } : {},
    processedCommands: {},
  };
}

function result(revision: number, withConflict: boolean, hashByte: string): PlanningRuntimeResult {
  const runtimeState = state(revision, withConflict);
  return {
    schemaVersion: "zugfolge-planning-runtime-result/v1",
    state: runtimeState,
    stateHash: hashByte.repeat(64),
    projection: runtimeState.projection,
    idempotentReplay: false,
  };
}

let capturedCoordinate: PlanningCoordinateCommand | undefined;
const runtime: PlanningRuntime = {
  coordinate: (input) => {
    capturedCoordinate = input;
    return result(1, true, "a");
  },
  applyAlternative: () => result(2, false, "b"),
};

const release = {
  schemaVersion: PLANNING_INFRASTRUCTURE_RELEASE_SCHEMA,
  worldId: WORLD,
  releaseId: "infra-release-lhe-2026",
  sourceId: "infra-source-lhe-2026",
  corridorId: "corridor",
  corridorName: "Korridor",
  stations: [
    { numericId: 1, id: "a", code: "LAA", name: "A", distanceMm: 0, latitudeE7: 510000000, longitudeE7: 120000000, stationTrackNumericId: 101, stationTrackLengthMm: 400_000, stationMaximumSpeedKph: 80 },
    { numericId: 2, id: "b", code: "LBB", name: "B", distanceMm: 1_000_000, latitudeE7: 510100000, longitudeE7: 120100000, stationTrackNumericId: 201, stationTrackLengthMm: 400_000, stationMaximumSpeedKph: 80 },
  ],
  segments: [{ edgeNumericId: 1, trackNumericId: 1001, id: "a-b", label: "A-B", fromStationId: "a", toStationId: "b", lengthMm: 1_000_000, maximumSpeedKph: 120, mainSignalPositionsMm: [], maximumVirtualBlockLengthMm: 2_000_000 }],
  boundaryPlanningWindows: [{
    id: "boundary-a-b",
    playableLegId: "leg-a-b",
    originStationId: "a",
    destinationStationId: "b",
    qualityClass: "B",
    orderable: true,
    windows: [{ windowId: "bpw-exit-b", portalId: "east", direction: "exit", earliestS: 180, targetS: 200, latestS: 240 }],
  }],
};
const infrastructureReleases = planningInfrastructureReleaseCatalog([release]);

function requestBody(input: { readonly requestId: string; readonly trainId: string; readonly trainNumber: number; readonly reverse?: boolean }) {
  return {
    schemaVersion: PLANNING_PATH_REQUEST_SCHEMA,
    requestId: input.requestId,
    formationId: input.reverse ? "formation-b" : "formation-a",
    operatorId: input.reverse ? OPERATOR_B : OPERATOR_A,
    fleetRevision: 7,
    fleetStateHash: "f".repeat(64),
    fleetAuthorityReleaseId: "fleet-release-2026",
    trainId: input.trainId,
    trainCategory: "regional" as const,
    trainNumber: input.trainNumber,
    originStationId: input.reverse ? "b" : "a",
    destinationStationId: input.reverse ? "a" : "b",
    desiredDepartureS: 100,
    operatingDays: "daily" as const,
    stops: [],
    earlierS: 0,
    laterS: 600,
    stepS: 60,
    extraRunningTimeS: 0,
    maxOperationalStops: 0,
    train: {
      numericId: input.reverse ? 2 : 1,
      name: input.reverse ? "B" : "A",
      massKg: 100_000,
      lengthMm: 100_000,
      maximumSpeedKph: 120,
      accelerationMmPerS2: 600,
      decelerationMmPerS2: 800,
    },
  };
}

function coordinateBody(requestCommandIds: readonly [string, string]) {
  return {
    schemaVersion: PLANNING_COORDINATE_AUTHORITY_SCHEMA,
    runId: "run-1",
    expectedProjectionRevision: null,
    seedWorld: "1",
    seedPeriod: 1,
    infrastructureReleaseId: release.releaseId,
    requestCommandIds,
  };
}

let client: PGlite;
let db: PlanningDatabase;

beforeEach(async () => {
  capturedCoordinate = undefined;
  client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
  db = database;
  await database.insert(worlds).values({ id: WORLD, name: "Testwelt", schedulePeriodWeeks: 4, epoch: new Date(0) });
  await database.insert(accounts).values([
    { id: ACCOUNT_A, worldId: WORLD, keycloakSubject: "planner-a", displayName: "Planner A" },
    { id: ACCOUNT_B, worldId: WORLD, keycloakSubject: "planner-b", displayName: "Planner B" },
    { id: AUTHORITY, worldId: WORLD, keycloakSubject: "planning-authority", displayName: "Planning Authority" },
  ]);
  await database.insert(operators).values([
    { id: OPERATOR_A, worldId: WORLD, foundingAccountId: ACCOUNT_A, name: "EVU A" },
    { id: OPERATOR_B, worldId: WORLD, foundingAccountId: ACCOUNT_B, name: "EVU B" },
    { id: OPERATOR_B_SECOND, worldId: WORLD, foundingAccountId: ACCOUNT_B, name: "EVU B Zweig" },
  ]);
});

afterEach(async () => {
  await client.close();
});

async function queueTwoPathRequests() {
  const first = await queuePlanningPathRequest(db, {
    worldId: WORLD,
    requestingAccountId: ACCOUNT_A,
    body: requestBody({ requestId: "request-a", trainId: "train-a", trainNumber: 26802 }),
    submittedAt: new Date(1_000),
  });
  const second = await queuePlanningPathRequest(db, {
    worldId: WORLD,
    requestingAccountId: ACCOUNT_B,
    body: requestBody({ requestId: "request-b", trainId: "train-b", trainNumber: 26804, reverse: true }),
    submittedAt: new Date(1_001),
  });
  return [first, second] as const;
}

describe("planning worker transaction", () => {
  it("binds one request to each authenticated account and keeps each retry idempotent", async () => {
    const [first, second] = await queueTwoPathRequests();
    const retry = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_A,
      body: requestBody({ requestId: "request-a", trainId: "train-a", trainNumber: 26802 }),
      submittedAt: new Date(2_000),
    });
    expect(retry.id).toBe(first.id);
    expect(first.idempotencyKey).toBe("planning-path-request:request-a");
    expect(first.payload).toMatchObject({ worldId: WORLD, requestingAccountId: ACCOUNT_A, operatorId: OPERATOR_A, requestId: "request-a", trainId: "train-a" });
    expect(second.payload).toMatchObject({ worldId: WORLD, requestingAccountId: ACCOUNT_B, operatorId: OPERATOR_B, requestId: "request-b", trainId: "train-b" });
    await expect(queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_A,
      body: { ...requestBody({ requestId: "request-c", trainId: "train-c", trainNumber: 1 }), worldId: "foreign" },
      submittedAt: new Date(3_000),
    })).rejects.toThrow(/exakt die Felder/);
  });

  it("derives Rust infrastructure server-side and consumes two accounts atomically", async () => {
    const [first, second] = await queueTwoPathRequests();
    const coordinate = await queuePlanningCoordinate(db, {
      worldId: WORLD,
      authorityAccountId: AUTHORITY,
      body: coordinateBody([second.id, first.id]),
      submittedAt: new Date(2_000),
    });
    expect(coordinate.payload).toEqual({ worldId: WORLD, ...coordinateBody([second.id, first.id]) });
    expect(coordinate.payload).not.toHaveProperty("stations");
    expect(coordinate.payload).not.toHaveProperty("requests");

    const coordinated = await processPlanningCommand(db, runtime, infrastructureReleases, WORLD, coordinate.id, new Date(3_000));
    expect(coordinated).toMatchObject({ projectionRevision: 1, resultEventSequence: 2, idempotentReplay: false });
    expect(capturedCoordinate).toMatchObject({
      schemaVersion: "planning-coordinate/v1",
      worldId: WORLD,
      sourceId: release.sourceId,
      stations: release.stations,
      segments: release.segments,
      requests: [
        expect.objectContaining({ requestNumericId: 1, trainId: "train-a" }),
        expect.objectContaining({ requestNumericId: 2, trainId: "train-b" }),
      ],
    });

    const persisted = await db
      .select()
      .from(simulationCommands)
      .where(inArray(simulationCommands.id, [first.id, second.id, coordinate.id]));
    expect(persisted).toHaveLength(3);
    expect(persisted.every((command) => command.status === "processed" && command.resultEventSequence === 2)).toBe(true);
    const initialEvents = await db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD)).orderBy(asc(domainEvents.sequence));
    expect(initialEvents.map((event) => [event.sequence, event.eventType])).toEqual([[1, "planning.runtime-state"], [2, "planning.diagram"]]);

    const [foreignApply] = await db.insert(simulationCommands).values({
      worldId: WORLD,
      requestingAccountId: ACCOUNT_A,
      idempotencyKey: "alternative:1:alt-1:foreign",
      commandType: "planning.apply-alternative",
      payload: { schemaVersion: "planning-apply-alternative/v1", projectionRevision: 1, alternativeId: "alt-1", conflictId: "conflict-1", trainId: "train-b", departureShiftS: 200 },
      submittedAt: new Date(3_500),
    }).returning();
    await expect(processPlanningCommand(db, runtime, infrastructureReleases, WORLD, foreignApply!.id, new Date(3_600))).rejects.toThrow(/nicht fuer den betroffenen Zug autorisiert/);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD))).toHaveLength(2);

    const [tamperedAlternative] = await db.insert(simulationCommands).values({
      worldId: WORLD,
      requestingAccountId: ACCOUNT_B,
      idempotencyKey: "alternative:1:foreign-id",
      commandType: "planning.apply-alternative",
      payload: { schemaVersion: "planning-apply-alternative/v1", projectionRevision: 1, alternativeId: "foreign-alt", conflictId: "conflict-1", trainId: "train-b", departureShiftS: 200 },
      submittedAt: new Date(3_700),
    }).returning();
    await expect(processPlanningCommand(db, runtime, infrastructureReleases, WORLD, tamperedAlternative!.id, new Date(3_800))).rejects.toThrow(/nicht fuer den betroffenen Zug autorisiert/);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD))).toHaveLength(2);

    const [applyCommand] = await db.insert(simulationCommands).values({
      worldId: WORLD,
      requestingAccountId: ACCOUNT_B,
      idempotencyKey: "alternative:1:alt-1",
      commandType: "planning.apply-alternative",
      payload: { schemaVersion: "planning-apply-alternative/v1", projectionRevision: 1, alternativeId: "alt-1", conflictId: "conflict-1", trainId: "train-b", departureShiftS: 200 },
      submittedAt: new Date(4_000),
    }).returning();
    const applied = await processPlanningCommand(db, runtime, infrastructureReleases, WORLD, applyCommand!.id, new Date(5_000));
    expect(applied).toMatchObject({ projectionRevision: 2, stateHash: "b".repeat(64), resultEventSequence: 4, idempotentReplay: false });
    const applyReplay = await processPlanningCommand(db, runtime, infrastructureReleases, WORLD, applyCommand!.id, new Date(6_000));
    expect(applyReplay).toMatchObject({ projectionRevision: 2, stateHash: "b".repeat(64), resultEventSequence: 4, idempotentReplay: true });
    const coordinateReplay = await processPlanningCommand(db, runtime, infrastructureReleases, WORLD, coordinate.id, new Date(7_000));
    expect(coordinateReplay).toMatchObject({ projectionRevision: 1, stateHash: "a".repeat(64), resultEventSequence: 2, idempotentReplay: true });
    expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD))).toHaveLength(4);
  });

  it("findet ein Kommando nur mit der explizit gebundenen Welt", async () => {
    const [first, second] = await queueTwoPathRequests();
    const coordinate = await queuePlanningCoordinate(db, {
      worldId: WORLD,
      authorityAccountId: AUTHORITY,
      body: coordinateBody([first.id, second.id]),
      submittedAt: new Date(2_000),
    });

    await expect(processPlanningCommand(
      db,
      runtime,
      infrastructureReleases,
      "22222222-2222-4222-8222-222222222222",
      coordinate.id,
      new Date(3_000),
    )).rejects.toThrow(/in Welt .* unbekannt/);
    const [persisted] = await db.select().from(simulationCommands).where(and(
      eq(simulationCommands.worldId, WORLD),
      eq(simulationCommands.id, coordinate.id),
    ));
    expect(persisted?.status).toBe("pending");
  });

  it("resolves only an opaque player boundary reference to server-owned time windows", async () => {
    const first = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_A,
      body: {
        ...requestBody({ requestId: "boundary-a", trainId: "train-a", trainNumber: 26_802 }),
        boundaryPlanningWindowId: "boundary-a-b",
      },
      submittedAt: new Date(1_000),
    });
    const second = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_B,
      body: requestBody({ requestId: "boundary-b", trainId: "train-b", trainNumber: 26_804, reverse: true }),
      submittedAt: new Date(1_001),
    });
    const coordinate = await queuePlanningCoordinate(db, {
      worldId: WORLD,
      authorityAccountId: AUTHORITY,
      body: coordinateBody([first.id, second.id]),
      submittedAt: new Date(2_000),
    });

    await processPlanningCommand(db, runtime, infrastructureReleases, WORLD, coordinate.id, new Date(3_000));

    expect(capturedCoordinate?.requests[0]).toMatchObject({
      trainId: "train-a",
      boundaryWindows: [{
        windowId: "bpw-exit-b",
        portalId: "east",
        direction: "exit",
        earliestS: 180,
        targetS: 200,
        latestS: 240,
      }],
    });
    expect(capturedCoordinate?.requests[0]).not.toHaveProperty("boundaryPlanningWindowId");
  });

  it("assigns requestNumericId by stable UTF-8 bytes instead of platform locale", async () => {
    const umlaut = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_A,
      body: requestBody({ requestId: "antrag-ä", trainId: "train-umlaut", trainNumber: 26802 }),
      submittedAt: new Date(1_000),
    });
    const ascii = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_B,
      body: requestBody({ requestId: "antrag-z", trainId: "train-ascii", trainNumber: 26804, reverse: true }),
      submittedAt: new Date(1_001),
    });
    const coordinate = await queuePlanningCoordinate(db, {
      worldId: WORLD,
      authorityAccountId: AUTHORITY,
      body: coordinateBody([umlaut.id, ascii.id]),
      submittedAt: new Date(2_000),
    });

    await processPlanningCommand(db, runtime, infrastructureReleases, WORLD, coordinate.id, new Date(3_000));

    expect(capturedCoordinate?.requests.map((request) => [request.requestNumericId, request.trainId])).toEqual([
      [1, "train-ascii"],
      [2, "train-umlaut"],
    ]);
  });

  it("fails a deterministic poison command so the following poll can progress", async () => {
    const staleFirst = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_A,
      body: requestBody({ requestId: "stale-a", trainId: "stale-train-a", trainNumber: 26802 }),
      submittedAt: new Date(1_000),
    });
    const staleSecond = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_B,
      body: requestBody({ requestId: "stale-b", trainId: "stale-train-b", trainNumber: 26804, reverse: true }),
      submittedAt: new Date(1_001),
    });
    const validFirst = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_A,
      body: requestBody({ requestId: "valid-a", trainId: "valid-train-a", trainNumber: 26806 }),
      submittedAt: new Date(1_002),
    });
    const validSecond = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_B,
      body: requestBody({ requestId: "valid-b", trainId: "valid-train-b", trainNumber: 26808, reverse: true }),
      submittedAt: new Date(1_003),
    });
    const stale = await queuePlanningCoordinate(db, {
      worldId: WORLD,
      authorityAccountId: AUTHORITY,
      body: {
        ...coordinateBody([staleFirst.id, staleSecond.id]),
        runId: "stale-run",
        expectedProjectionRevision: 1,
      },
      submittedAt: new Date(2_000),
    });
    const valid = await queuePlanningCoordinate(db, {
      worldId: WORLD,
      authorityAccountId: AUTHORITY,
      body: { ...coordinateBody([validFirst.id, validSecond.id]), runId: "valid-run" },
      submittedAt: new Date(2_001),
    });

    await expect(consumePendingPlanningCommands(db, runtime, infrastructureReleases, WORLD, {
      committedAt: () => new Date(3_000),
    })).rejects.toThrow(/keinen Ausgangszustand/);

    const [failed] = await db.select().from(simulationCommands).where(eq(simulationCommands.id, stale.id));
    expect(failed).toMatchObject({
      status: "failed",
      failureCode: "planning_worker_conflict",
      processedAt: new Date(3_000),
      resultEventSequence: null,
    });
    const [stillPending] = await db.select().from(simulationCommands).where(eq(simulationCommands.id, valid.id));
    expect(stillPending?.status).toBe("pending");
    expect(await db.select().from(domainEvents)).toEqual([]);

    const nextPoll = await consumePendingPlanningCommands(db, runtime, infrastructureReleases, WORLD, {
      committedAt: () => new Date(4_000),
    });
    expect(nextPoll).toEqual([expect.objectContaining({ commandId: valid.id, projectionRevision: 1 })]);
    expect(await db.select().from(domainEvents)).toHaveLength(2);
  });

  it("rejects coordination when both path requests belong to one account", async () => {
    const first = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_A,
      body: requestBody({ requestId: "request-a", trainId: "train-a", trainNumber: 26802 }),
      submittedAt: new Date(1_000),
    });
    const second = await queuePlanningPathRequest(db, {
      worldId: WORLD,
      requestingAccountId: ACCOUNT_A,
      body: requestBody({ requestId: "request-b", trainId: "train-b", trainNumber: 26804, reverse: true }),
      submittedAt: new Date(1_001),
    });
    const coordinate = await queuePlanningCoordinate(db, {
      worldId: WORLD,
      authorityAccountId: AUTHORITY,
      body: coordinateBody([first.id, second.id]),
      submittedAt: new Date(2_000),
    });
    await expect(processPlanningCommand(db, runtime, infrastructureReleases, WORLD, coordinate.id, new Date(3_000))).rejects.toThrow(/verschiedener Konten/);
    expect(await db.select().from(domainEvents)).toEqual([]);
  });

  it("rolls back state, diagram, coordinate and both requests when Rust returns a foreign world", async () => {
    const [first, second] = await queueTwoPathRequests();
    const coordinate = await queuePlanningCoordinate(db, {
      worldId: WORLD,
      authorityAccountId: AUTHORITY,
      body: coordinateBody([first.id, second.id]),
      submittedAt: new Date(2_000),
    });
    const foreignRuntime: PlanningRuntime = {
      ...runtime,
      coordinate: () => ({ ...result(1, true, "a"), state: { ...state(1, true), worldId: "foreign" } }),
    };
    await expect(consumePendingPlanningCommands(db, foreignRuntime, infrastructureReleases, WORLD, {
      committedAt: () => new Date(3_000),
    })).rejects.toThrow(/Weltisolation/);
    expect(await db.select().from(domainEvents)).toEqual([]);
    const pending = await db.select().from(simulationCommands).where(inArray(simulationCommands.id, [first.id, second.id, coordinate.id]));
    expect(pending.every((command) => command.status === "pending" && command.resultEventSequence === null)).toBe(true);
  });
});
