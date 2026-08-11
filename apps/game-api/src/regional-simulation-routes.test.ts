import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import type { IdentityDatabase } from "@zugfolge/identity";
import {
  REGIONAL_LIVEMAP_DELTA_SCHEMA,
  REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZED_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
  REGIONAL_SIMULATION_RESULT_SCHEMA,
  REGIONAL_SIMULATION_STATE_SCHEMA,
  type RegionalSimulationInitialized,
  type RegionalSimulationResult,
} from "@zugfolge/runtime-native";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  RegionalSimulationConflictError,
  RegionalSimulationUnavailableError,
  type RegionalSimulationWorker,
} from "./regional-simulation-worker.js";

const token = "regional-simulation-test-token";
const worldA = "11111111-1111-4111-8111-111111111111";
const worldB = "22222222-2222-4222-8222-222222222222";
const regionId = "leipzig";

function initialized(worldId: string): RegionalSimulationInitialized {
  const state = {
    schemaVersion: REGIONAL_SIMULATION_STATE_SCHEMA,
    worldId,
    regionId,
    initialNowS: 0,
    nowS: 0,
    revision: 0,
    publisherSequence: 0,
    commands: [],
  } as const;
  return {
    schemaVersion: REGIONAL_SIMULATION_INITIALIZED_SCHEMA,
    state,
    stateHash: "a".repeat(64),
    snapshot: {
      schemaVersion: REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA,
      worldId,
      regionId,
      producerSequence: 0,
      atS: 0,
      trains: [],
    },
    events: [],
  };
}

function result(
  worldId: string,
  commandId: string,
  idempotentReplay: boolean,
): RegionalSimulationResult {
  const state = {
    schemaVersion: REGIONAL_SIMULATION_STATE_SCHEMA,
    worldId,
    regionId,
    initialNowS: 0,
    nowS: 1,
    revision: 1,
    publisherSequence: 1,
    commands: [{}],
  } as const;
  return {
    schemaVersion: REGIONAL_SIMULATION_RESULT_SCHEMA,
    state,
    stateHash: "b".repeat(64),
    events: [],
    delta: {
      schemaVersion: REGIONAL_LIVEMAP_DELTA_SCHEMA,
      worldId,
      regionId,
      producerSequence: 1,
      atS: 1,
      changed: [],
      removed: [],
    },
    appliedCommandId: commandId,
    idempotentReplay,
  };
}

const initializationBody = {
  materializationWindowHours: 48,
  nowS: 0,
  trains: [
    {
      trainRunId: "run-1",
      operator: "operator-1",
      trainNumber: "RE 1",
      category: "regional",
      route: [
        {
          operatingPoint: "Leipzig Hbf",
          positionMm: 0,
          arrivalS: 0,
          minimumDwellSeconds: 30,
          departureS: 30,
        },
      ],
    },
  ],
} as const;

describe("interne regionale M4-Routen", () => {
  let client: PGlite;
  let db: IdentityDatabase;

  beforeEach(async () => {
    client = new PGlite();
    const pgliteDb = drizzle(client, { schema });
    await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
    db = pgliteDb;
    await pgliteDb.insert(worlds).values([
      { id: worldA, name: "A", schedulePeriodWeeks: 4, epoch: new Date(0) },
      { id: worldB, name: "B", schedulePeriodWeeks: 4, epoch: new Date(0) },
    ]);
  });

  afterEach(async () => client.close());

  it("bindet Schema, Welt und Region serverseitig und validiert den Body exakt", async () => {
    const initialize = vi.fn(async (input) => initialized(input.worldId));
    const app = buildApp({
      db,
      verifyToken: async () => {
        throw new Error("nicht verwendet");
      },
      simulationIngestToken: token,
      regionalSimulation: {
        initialize,
        apply: vi.fn(),
      } as Pick<RegionalSimulationWorker, "initialize" | "apply">,
    });
    await app.ready();
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/regional-simulations/${regionId}/initialize`,
        payload: initializationBody,
      });
      expect(unauthorized).toMatchObject({ statusCode: 401 });
      expect(unauthorized.json()).toMatchObject({
        code: "regional_simulation_unauthorized",
      });

      const forged = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/regional-simulations/${regionId}/initialize`,
        headers: { authorization: `Bearer ${token}` },
        payload: { ...initializationBody, worldId: worldB },
      });
      expect(forged.statusCode).toBe(400);
      expect(forged.json()).toMatchObject({
        code: "regional_simulation_invalid_request",
      });

      const accepted = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/regional-simulations/${regionId}/initialize`,
        headers: { authorization: `Bearer ${token}` },
        payload: initializationBody,
      });
      expect(accepted.statusCode).toBe(201);
      expect(initialize).toHaveBeenCalledWith(
        {
          schemaVersion: REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
          worldId: worldA,
          regionId,
          ...initializationBody,
        },
        expect.any(Date),
      );
    } finally {
      await app.close();
    }
  });

  it("bindet die Kommando-ID an den Pfad und reicht idempotente Retries unveraendert weiter", async () => {
    let calls = 0;
    const apply = vi.fn(async (work) => {
      calls += 1;
      return result(work.worldId, work.commandId, calls > 1);
    });
    const app = buildApp({
      db,
      verifyToken: async () => {
        throw new Error("nicht verwendet");
      },
      simulationIngestToken: token,
      regionalSimulation: {
        initialize: vi.fn(),
        apply,
      } as Pick<RegionalSimulationWorker, "initialize" | "apply">,
    });
    await app.ready();
    const url =
      `/internal/worlds/${worldA}/regional-simulations/${regionId}/commands/advance-to:1`;
    try {
      const first = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atS: 1 },
      });
      const retry = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atS: 1 },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ idempotentReplay: false });
      expect(retry.json()).toMatchObject({ idempotentReplay: true });
      expect(apply).toHaveBeenNthCalledWith(
        1,
        {
          worldId: worldA,
          regionId,
          commandId: "advance-to:1",
          command: { type: "advance-to", atS: 1 },
        },
        expect.any(Date),
      );

      const foreignField = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atS: 1, regionId: "halle" },
      });
      expect(foreignField.statusCode).toBe(400);
      expect(apply).toHaveBeenCalledTimes(2);

      const missingWorld = await app.inject({
        method: "POST",
        url: `/internal/worlds/99999999-9999-4999-8999-999999999999/regional-simulations/${regionId}/commands/missing`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atS: 1 },
      });
      expect(missingWorld.statusCode).toBe(404);
      expect(missingWorld.json()).toMatchObject({ code: "world_not_found" });
      expect(apply).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("liefert stabile Konflikt- und Verfuegbarkeitscodes", async () => {
    const apply = vi.fn(async (work) => {
      if (work.commandId === "conflict") {
        throw new RegionalSimulationConflictError("bereits verarbeitet");
      }
      throw new RegionalSimulationUnavailableError(work.worldId, work.regionId);
    });
    const app = buildApp({
      db,
      verifyToken: async () => {
        throw new Error("nicht verwendet");
      },
      simulationIngestToken: token,
      regionalSimulation: {
        initialize: vi.fn(),
        apply,
      } as Pick<RegionalSimulationWorker, "initialize" | "apply">,
    });
    await app.ready();
    try {
      const conflict = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/regional-simulations/${regionId}/commands/conflict`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atS: 1 },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "regional_simulation_conflict" });

      const unavailable = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldB}/regional-simulations/${regionId}/commands/unavailable`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atS: 1 },
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({
        code: "regional_simulation_unavailable",
      });
    } finally {
      await app.close();
    }
  });
});
