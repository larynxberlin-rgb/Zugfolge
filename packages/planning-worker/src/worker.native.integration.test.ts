import { PGlite } from "@electric-sql/pglite";
import {
  MIGRATIONS_FOLDER,
  accounts,
  domainEvents,
  operators,
  simulationCommands,
  worlds,
} from "@zugfolge/db";
import { parsePlanningProjection } from "@zugfolge/planning-projection";
import { loadPlanningRuntime } from "@zugfolge/planning-runtime-native";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "@zugfolge/db/schema";

import {
  PLANNING_COORDINATE_AUTHORITY_SCHEMA,
  PLANNING_INFRASTRUCTURE_RELEASE_SCHEMA,
  PLANNING_PATH_REQUEST_SCHEMA,
} from "./contract.js";
import {
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

const release = {
  schemaVersion: PLANNING_INFRASTRUCTURE_RELEASE_SCHEMA,
  worldId: WORLD,
  releaseId: "infra-release-lhe-2026",
  sourceId: "infra-source-lhe-2026",
  corridorId: "corridor-west-east",
  corridorName: "West-Ost",
  stations: [
    { numericId: 1, id: "west", code: "LWE", name: "West", distanceMm: 0, latitudeE7: 510_000_000, longitudeE7: 120_000_000, stationTrackNumericId: 101, stationTrackLengthMm: 400_000, stationMaximumSpeedKph: 80 },
    { numericId: 2, id: "east", code: "LOE", name: "Ost", distanceMm: 5_000_000, latitudeE7: 510_100_000, longitudeE7: 120_100_000, stationTrackNumericId: 201, stationTrackLengthMm: 400_000, stationMaximumSpeedKph: 80 },
  ],
  segments: [{ edgeNumericId: 1, trackNumericId: 1001, id: "west-east", label: "West-Ost", fromStationId: "west", toStationId: "east", lengthMm: 5_000_000, maximumSpeedKph: 120, mainSignalPositionsMm: [2_000_000, 4_000_000], maximumVirtualBlockLengthMm: 2_000_000 }],
};
const infrastructureReleases = planningInfrastructureReleaseCatalog([release]);

function requestBody(input: {
  readonly requestId: string;
  readonly trainId: string;
  readonly trainNumber: number;
  readonly reverse?: boolean;
}) {
  return {
    schemaVersion: PLANNING_PATH_REQUEST_SCHEMA,
    requestId: input.requestId,
    formationId: input.reverse ? "formation-west" : "formation-east",
    operatorId: input.reverse ? OPERATOR_B : OPERATOR_A,
    fleetRevision: 7,
    fleetStateHash: "f".repeat(64),
    fleetAuthorityReleaseId: "fleet-release-2026",
    trainId: input.trainId,
    trainCategory: "regional" as const,
    trainNumber: input.trainNumber,
    originStationId: input.reverse ? "east" : "west",
    destinationStationId: input.reverse ? "west" : "east",
    desiredDepartureS: 28_800,
    operatingDays: "daily" as const,
    stops: [],
    earlierS: 0,
    laterS: 1_800,
    stepS: 60,
    extraRunningTimeS: 0,
    maxOperationalStops: 0,
    train: {
      numericId: input.reverse ? 2 : 1,
      name: input.reverse ? "Regionaltriebwagen West" : "Regionaltriebwagen Ost",
      massKg: 120_000,
      lengthMm: 140_000,
      maximumSpeedMmps: 38_888,
      accelerationMmPerS2: 600,
      decelerationMmPerS2: 800,
    },
  };
}

async function runInitialPlanning(runtime: ReturnType<typeof loadPlanningRuntime>) {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
  const db: PlanningDatabase = database;
  await database.insert(worlds).values({ id: WORLD, name: "Native Testwelt", schedulePeriodWeeks: 4, epoch: new Date(0) });
  await database.insert(accounts).values([
    { id: ACCOUNT_A, worldId: WORLD, keycloakSubject: "native-a", displayName: "Native A" },
    { id: ACCOUNT_B, worldId: WORLD, keycloakSubject: "native-b", displayName: "Native B" },
    { id: AUTHORITY, worldId: WORLD, keycloakSubject: "native-authority", displayName: "Native Authority" },
  ]);
  await database.insert(operators).values([
    { id: OPERATOR_A, worldId: WORLD, foundingAccountId: ACCOUNT_A, name: "Native EVU A" },
    { id: OPERATOR_B, worldId: WORLD, foundingAccountId: ACCOUNT_B, name: "Native EVU B" },
  ]);
  const first = await queuePlanningPathRequest(db, {
    worldId: WORLD,
    requestingAccountId: ACCOUNT_A,
    body: requestBody({ requestId: "request-east", trainId: "train-east", trainNumber: 26_802 }),
    submittedAt: new Date(1_000),
  });
  const second = await queuePlanningPathRequest(db, {
    worldId: WORLD,
    requestingAccountId: ACCOUNT_B,
    body: requestBody({ requestId: "request-west", trainId: "train-west", trainNumber: 26_804, reverse: true }),
    submittedAt: new Date(1_001),
  });
  const coordinate = await queuePlanningCoordinate(db, {
    worldId: WORLD,
    authorityAccountId: AUTHORITY,
    body: {
      schemaVersion: PLANNING_COORDINATE_AUTHORITY_SCHEMA,
      runId: "period-2026-window-1",
      expectedProjectionRevision: null,
      seedWorld: "78193085935",
      seedPeriod: 1,
      infrastructureReleaseId: release.releaseId,
      requestCommandIds: [second.id, first.id],
    },
    submittedAt: new Date(2_000),
  });
  const result = await processPlanningCommand(db, runtime, infrastructureReleases, WORLD, coordinate.id, new Date(3_000));
  const events = await db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD)).orderBy(asc(domainEvents.sequence));
  expect(events.map((event) => event.eventType)).toEqual(["planning.runtime-state", "planning.diagram"]);
  const projection = parsePlanningProjection(events[1]!.payload);
  expect(projection.projectionRevision).toBe(1);
  expect(projection.occupations.map((occupation) => occupation.phase)).toEqual(expect.arrayContaining([
    "route-setting", "signal-sighting", "approach", "running", "clearing", "route-release",
  ]));
  expect(projection.conflicts.some((conflict) => conflict.kind === "opposing-move" && conflict.alternative !== null)).toBe(true);
  const replay = await processPlanningCommand(db, runtime, infrastructureReleases, WORLD, coordinate.id, new Date(4_000));
  expect(replay).toEqual({ ...result, idempotentReplay: true });
  expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD))).toHaveLength(2);
  return { client, db, result, projection };
}

const describeNative = process.env["ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH"] === undefined
  ? describe.skip
  : describe;

describeNative("real PlanningRun worker composition", () => {
  it("persists deterministic native coordination and applies only the offered alternative", async () => {
    const runtime = loadPlanningRuntime();
    const first = await runInitialPlanning(runtime);
    const second = await runInitialPlanning(runtime);
    try {
      expect(second.result.stateHash).toBe(first.result.stateHash);
      expect(second.projection).toEqual(first.projection);
      const conflict = first.projection.conflicts.find((candidate) => candidate.alternative !== null);
      expect(conflict?.alternative).not.toBeNull();
      const alternative = conflict!.alternative!;
      const [applyCommand] = await first.db.insert(simulationCommands).values({
        worldId: WORLD,
        requestingAccountId: ACCOUNT_A,
        idempotencyKey: `planning-alternative:1:${alternative.alternativeId}`,
        commandType: "planning.apply-alternative",
        payload: {
          schemaVersion: "planning-apply-alternative/v1",
          projectionRevision: 1,
          alternativeId: alternative.alternativeId,
          conflictId: conflict!.id,
          trainId: alternative.trainId,
          departureShiftS: alternative.departureShiftS,
        },
        submittedAt: new Date(5_000),
      }).returning();
      const applied = await processPlanningCommand(first.db, runtime, infrastructureReleases, WORLD, applyCommand!.id, new Date(6_000));
      expect(applied).toMatchObject({ projectionRevision: 2, resultEventSequence: 4, idempotentReplay: false });
      const replay = await processPlanningCommand(first.db, runtime, infrastructureReleases, WORLD, applyCommand!.id, new Date(7_000));
      expect(replay).toEqual({ ...applied, idempotentReplay: true });
      const events = await first.db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD)).orderBy(asc(domainEvents.sequence));
      expect(parsePlanningProjection(events[3]!.payload).conflicts).toEqual([]);
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });
});
