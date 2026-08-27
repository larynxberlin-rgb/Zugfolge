import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import type { IdentityDatabase } from "@zugfolge/identity";
import {
  OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
  OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  OPERATIONAL_SIMULATION_RESULT_SCHEMA,
  OPERATIONAL_SIMULATION_STATE_SCHEMA,
  type OperationalProjection,
  type OperationalSimulationInitialized,
  type OperationalSimulationResult,
  type OperationalSimulationState,
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
const infraReleaseId = "infra-operational-v2";

function state(
  worldId: string,
  revision: number,
  nowMs: number,
): OperationalSimulationState {
  const stateHash = (revision + 10).toString(16).padStart(64, "0");
  return {
    schemaVersion: OPERATIONAL_SIMULATION_STATE_SCHEMA,
    world: {
      worldId,
      regionId,
      infraReleaseId,
      nowMs,
      commitSequence: revision,
      events: [],
    },
    revision,
    publisherSequence: revision,
    stateHash,
    commandReceipts: revision === 0 ? {} : { "advance-to-ms:1000": "receipt" },
  } as OperationalSimulationState;
}

function projection(
  source: OperationalSimulationState,
  kind: OperationalProjection["kind"],
): OperationalProjection {
  return {
    kind,
    worldId: source.world.worldId,
    regionId: source.world.regionId,
    infraReleaseId: source.world.infraReleaseId,
    commitSequence: source.world.commitSequence,
    atMs: source.world.nowMs,
    staleAfterMs: source.world.nowMs + 75_000,
    trains: [],
    routeLocks: [],
    signals: {},
  };
}

function initialized(worldId: string): OperationalSimulationInitialized {
  const initializedState = state(worldId, 0, 0);
  return {
    schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
    state: initializedState,
    stateHash: initializedState.stateHash,
    liveMap: projection(initializedState, "live-map"),
    rzue: projection(initializedState, "rzue"),
    events: [],
  };
}

function result(
  worldId: string,
  commandId: string,
  idempotentReplay: boolean,
): OperationalSimulationResult {
  const resultState = state(worldId, 1, 1_000);
  return {
    schemaVersion: OPERATIONAL_SIMULATION_RESULT_SCHEMA,
    state: resultState,
    stateHash: resultState.stateHash,
    liveMap: projection(resultState, "live-map"),
    rzue: projection(resultState, "rzue"),
    events: [],
    appliedCommandId: commandId,
    idempotentReplay,
  };
}

const initializationBody = {
  nowMs: 0,
  repeatEveryMs: null,
  protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  infraRelease: { id: infraReleaseId },
  vehicleTypes: [],
  vehicles: [],
  formations: [],
  trains: [
    {
      id: "run-1",
      operatorId: "operator-1",
      trainNumber: "RE 1",
      movementKind: "train",
      routeVersionId: "route-v2",
      formationVersionId: "formation-v2",
      headRouteMm: 10_000,
      scheduledDepartureMs: null,
      publicPassengerStop: true,
      dispatchInterlockingRouteId: "interlocking-v2",
      protectionModeSelectionRuns: [{
        throughRouteLegIndex: 0,
        selectedProtectionSystem: "pzb",
      }],
    },
  ],
  movementContinuations: [],
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
          schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
          worldId: worldA,
          regionId,
          ...initializationBody,
        },
        expect.any(Date),
      );

      const overlong = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/regional-simulations/${regionId}/initialize`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          ...initializationBody,
          trains: [{ ...initializationBody.trains[0], trainNumber: "S4-1667972" }],
        },
      });
      expect(overlong.statusCode).toBe(400);

      for (const trainNumber of ["0", "RB 00000"]) {
        const zero = await app.inject({
          method: "POST",
          url: `/internal/worlds/${worldA}/regional-simulations/${regionId}/initialize`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            ...initializationBody,
            trains: [{ ...initializationBody.trains[0], trainNumber }],
          },
        });
        expect(zero.statusCode).toBe(400);
      }

      const duplicate = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/regional-simulations/${regionId}/initialize`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          ...initializationBody,
          trains: [
            initializationBody.trains[0],
            { ...initializationBody.trains[0], id: "run-2", trainNumber: "IC-1" },
          ],
        },
      });
      expect(duplicate.statusCode).toBe(400);
      expect(duplicate.json()).toMatchObject({ code: "regional_simulation_invalid_request" });
      expect(initialize).toHaveBeenCalledTimes(1);
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
      `/internal/worlds/${worldA}/regional-simulations/${regionId}/commands/advance-to-ms:1000`;
    try {
      const first = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atMs: 1_000 },
      });
      const retry = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atMs: 1_000 },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ idempotentReplay: false });
      expect(retry.json()).toMatchObject({ idempotentReplay: true });
      expect(apply).toHaveBeenNthCalledWith(
        1,
        {
          worldId: worldA,
          regionId,
          commandId: "advance-to-ms:1000",
          command: { type: "advance-to", atMs: 1_000 },
        },
        expect.any(Date),
      );

      const foreignField = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atMs: 1_000, regionId: "halle" },
      });
      expect(foreignField.statusCode).toBe(400);
      expect(apply).toHaveBeenCalledTimes(2);

      const missingWorld = await app.inject({
        method: "POST",
        url: `/internal/worlds/99999999-9999-4999-8999-999999999999/regional-simulations/${regionId}/commands/missing`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atMs: 1_000 },
      });
      expect(missingWorld.statusCode).toBe(404);
      expect(missingWorld.json()).toMatchObject({ code: "world_not_found" });
      expect(apply).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("akzeptiert nur den minimalen physischen Fortsetzungsvertrag", async () => {
    const apply = vi.fn(async (work) => result(work.worldId, work.commandId, false));
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
    const continuation = {
      id: "continuation:run-1:run-2:day-0",
      predecessorTrainId: "run-1:day-0",
      predecessorBaseRouteVersionId: "route-v1",
      successor: {
        id: "run-2:day-0",
        trainNumber: "RE 2",
        operatorId: "operator-1",
        movementKind: "train",
        routeVersionId: "route-v2",
        formationVersionId: "formation-v2",
        headRouteMm: 10_000,
        scheduledDepartureMs: 2_000,
        publicPassengerStop: true,
      },
      successorDispatch: {
        trainId: "run-2:day-0",
        interlockingRouteId: "interlocking-v2",
        committedRank: 0,
        timetableDeviationMs: 0,
        passengerImpact: 0,
        contractualImpact: 0,
        networkImpact: 0,
        resourceConsequence: 0,
        recoveryRank: 0,
        waitingSinceMs: 2_000,
      },
      notBeforeMs: 2_000,
      minimumDwellMs: 300_000,
      continuity: "reverse-direction",
    } as const;
    const url = `/internal/worlds/${worldA}/regional-simulations/${regionId}/commands/${continuation.id}`;
    try {
      const accepted = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "queue-movement-continuation", continuation },
      });
      expect(accepted.statusCode).toBe(200);
      expect(apply).toHaveBeenCalledWith({
        worldId: worldA,
        regionId,
        commandId: continuation.id,
        command: { type: "queue-movement-continuation", continuation },
      }, expect.any(Date));

      const inventedSuccessorAuthority = await app.inject({
        method: "POST",
        url: `${url}:invalid`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          type: "queue-movement-continuation",
          continuation: {
            ...continuation,
            successor: {
              ...continuation.successor,
              dispatchInterlockingRouteId: "must-not-be-duplicated",
            },
          },
        },
      });
      expect(inventedSuccessorAuthority.statusCode).toBe(400);
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("weist AddDelay und alte Aussenlaufkommandos am harten v2-Vertrag zurueck", async () => {
    const apply = vi.fn(async (work) => result(work.worldId, work.commandId, false));
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
    const legacyExternalCommand = {
      type: "enter-external-zone",
      trainRunId: "run-1",
      externalLeg: {
        journeyChainId: "chain-re1",
        externalLegId: "chain-re1:external:1",
        fromPortalId: "portal-eisenach",
        toPortalId: "portal-eisenach",
        scheduledStartS: 1_000,
        scheduledEndS: 4_000,
        reentryEarliestS: 3_700,
        reentryLatestS: 4_300,
        fixedCostCents: "25000",
        boundVehicleIds: ["vehicle-442-001"],
        boundPersonnelDutyIds: ["duty-re1"],
        reentryRoute: [
          {
            operatingPoint: "Eisenach Hbf",
            positionMm: 0,
            arrivalS: 4_000,
            minimumDwellSeconds: 60,
            departureS: 4_060,
          },
        ],
        firstResources: ["block:eisenach:1"],
      },
    } as const;
    try {
      const addDelay = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/regional-simulations/${regionId}/commands/legacy-delay`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "add-delay", trainRunId: "run-1", seconds: 60 },
      });
      const external = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/regional-simulations/${regionId}/commands/external:run-1`,
        headers: { authorization: `Bearer ${token}` },
        payload: legacyExternalCommand,
      });
      expect(addDelay.statusCode).toBe(400);
      expect(addDelay.json()).toMatchObject({ code: "regional_simulation_invalid_request" });
      expect(external.statusCode).toBe(400);
      expect(external.json()).toMatchObject({ code: "regional_simulation_invalid_request" });
      expect(apply).not.toHaveBeenCalled();
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
        payload: { type: "advance-to", atMs: 1_000 },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "regional_simulation_conflict" });

      const unavailable = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldB}/regional-simulations/${regionId}/commands/unavailable`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "advance-to", atMs: 1_000 },
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
