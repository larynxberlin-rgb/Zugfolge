import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import {
  canonicalFleetJson,
  fleetSnapshotHash,
  loadFleetProducerCheckpoint,
  type EconomyDatabase,
} from "@zugfolge/economy";
import {
  FLEET_AUTHORITY_RELEASE_SCHEMA,
  FLEET_COMMAND_RECEIPT_SCHEMA,
  FLEET_COMMAND_RESULT_SCHEMA,
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZED_SCHEMA,
  FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
  FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
  FLEET_STATE_SCHEMA,
  canonicalFleetCommandHash,
  canonicalFleetCommandJson,
  fleetCommandEntity,
  type FleetAuthorityRelease,
  type FleetCommandResult,
  type FleetRuntime,
  type FleetWorldInitialized,
  type FleetWorldInitialization,
  type NativeFleetCommand,
  type NativeFleetMobilizationSnapshot,
  type NativeFleetWorldState,
} from "@zugfolge/runtime-native";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER_WORLD = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_WORLD = "33333333-3333-4333-8333-333333333333";
const TOKEN = "test-only-fleet-command-token";

function authorityRelease(): FleetAuthorityRelease {
  const assets = ["vehicle-a", "vehicle-b"].map((id, index) => ({
    id,
    numericId: index + 1,
    operatorId: "operator-1",
    vehicleTypeId: 101,
    classDesignation: "ET1",
    tradeName: `Testzug ${index + 1}`,
    buildYear: 2025,
    acquisitionYear: 2026,
    procurementChannel: "leasing" as const,
    approvedLineIds: ["S1"],
    maintenanceDeadlines: [{ kind: "inspection", dueAt: 10_000 }],
    installedProtection: ["pzb" as const],
    technical: {
      lengthMm: 50_000,
      massKg: 80_000,
      maximumSpeedKph: 160,
      accelerationMmPerS2: 800,
      decelerationMmPerS2: 900,
      traction: "electric" as const,
      electricSystems: ["ac15kv" as const],
    },
    passenger: {
      seats: 50,
      firstClassSeats: 5,
      accessible: true,
      bicyclePlaces: 2,
      wheelchairPlaces: 1,
      equipment: ["pis"],
      operatingCostCentsPerTrainKm: 700,
      replacementPlan: true,
    },
    deliveredAt: 0,
    retiredAt: 10_000,
  }));
  return {
    schemaVersion: FLEET_AUTHORITY_RELEASE_SCHEMA,
    releaseId: "http-authority-v1",
    referenceYear: 2026,
    assets,
    personnelPools: [{
      id: "pool-1",
      numericId: 1,
      operatorId: "operator-1",
      capacitySeconds: 20_000,
      minimumRestSeconds: 600,
      classDesignations: ["ET1"],
      pathReceiptIds: ["path-1"],
      qualificationHash: "a".repeat(64),
    }],
    pathReceipts: [{
      id: "path-1",
      numericRouteId: 1,
      operatorId: "operator-1",
      serviceLineIds: ["S1"],
      decision: "confirmed",
      validFrom: 0,
      validUntil: 10_000,
      platformLengthsMm: [120_000],
      electrifications: ["overhead-ac15kv"],
      requiredProtection: ["pzb"],
      approvedClasses: ["ET1"],
      plannerStateHash: "b".repeat(64),
      conflictCheckHash: "c".repeat(64),
    }],
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalFleetJson(value), "utf8").digest("hex");
}

function snapshotFromState(state: NativeFleetWorldState): NativeFleetMobilizationSnapshot {
  const release = state.authorityRelease;
  const assets = new Map(release.assets.map((asset) => [asset.id, asset] as const));
  const receipts = new Map(release.pathReceipts.map((receipt) => [receipt.id, receipt] as const));
  const pools = new Map(release.personnelPools.map((pool) => [pool.id, pool] as const));
  return {
    schema: "zugfolge-fleet-mobilization/v1",
    worldId: state.worldId,
    revision: state.revision,
    producedAt: state.producedAt,
    formations: Object.values(state.formations).map((intent) => {
      const first = assets.get(intent.vehicleIds[0]!)!;
      const receipt = receipts.get(intent.pathReceiptId)!;
      const selected = intent.vehicleIds.map((vehicleId) => assets.get(vehicleId)!);
      return {
        id: intent.id,
        operatorId: first.operatorId,
        vehicleIds: intent.vehicleIds,
        serviceLineIds: receipt.serviceLineIds,
        availability: "available" as const,
        procurement: "delivered" as const,
        availableFrom: Math.max(...selected.map((asset) => asset.deliveredAt)),
        availableUntil: Math.min(...selected.map((asset) => asset.retiredAt)),
        characteristics: {
          seats: selected.reduce((sum, asset) => sum + asset.passenger.seats, 0),
          firstClassBasisPoints: 1_000,
          accessible: selected.every((asset) => asset.passenger.accessible),
          bicyclePlaces: selected.reduce((sum, asset) => sum + asset.passenger.bicyclePlaces, 0),
          wheelchairPlaces: selected.reduce((sum, asset) => sum + asset.passenger.wheelchairPlaces, 0),
          equipment: ["pis"],
          vehicleAgeYears: 1,
          maximumSpeedKph: 160,
          operatingCostCentsPerTrainKm: selected.reduce(
            (sum, asset) => sum + asset.passenger.operatingCostCentsPerTrainKm,
            0,
          ),
          homologatedLineIds: receipt.serviceLineIds,
          maintenanceValidUntil: 10_000,
          traction: "electric" as const,
          replacementPlan: selected.every((asset) => asset.passenger.replacementPlan),
        },
      };
    }),
    personnelDuties: Object.values(state.personnelDuties).map((intent) => ({
      id: intent.id,
      operatorId: pools.get(intent.personnelPoolId)!.operatorId,
      formationIds: intent.formationIds,
      status: "ready" as const,
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    })),
    pathReservations: Object.values(state.pathReservations).map((intent) => {
      const receipt = receipts.get(intent.pathReceiptId)!;
      return {
        id: intent.id,
        operatorId: receipt.operatorId,
        serviceLineIds: receipt.serviceLineIds,
        status: "confirmed" as const,
        validFrom: receipt.validFrom,
        validUntil: receipt.validUntil,
      };
    }),
  };
}

function initialized(input: FleetWorldInitialization): FleetWorldInitialized {
  const state: NativeFleetWorldState = {
    schemaVersion: FLEET_STATE_SCHEMA,
    worldId: input.worldId,
    revision: 0,
    producedAt: input.producedAt,
    authorityReleaseHash: hash(input.authorityRelease),
    authorityRelease: input.authorityRelease,
    formations: {},
    personnelDuties: {},
    pathReservations: {},
  };
  const snapshot = snapshotFromState(state);
  return {
    schemaVersion: FLEET_INITIALIZED_SCHEMA,
    state,
    stateHash: hash(state),
    snapshot,
    snapshotHash: fleetSnapshotHash(snapshot),
  };
}

function applyCommand(
  state: NativeFleetWorldState,
  command: NativeFleetCommand,
): NativeFleetWorldState {
  if (command.worldId !== state.worldId) throw new Error("world_mismatch: fremde Welt");
  if (command.expectedRevision !== state.revision) throw new Error("revision_conflict: falsche Revision");
  if (command.expectedStateHash !== hash(state)) throw new Error("state_hash_mismatch: falscher Hash");
  const common = { ...state, revision: state.revision + 1, producedAt: command.atS };
  switch (command.schemaVersion) {
    case FLEET_FORMATION_COMMAND_SCHEMA:
      return {
        ...common,
        formations: {
          ...state.formations,
          [command.formationId]: {
            id: command.formationId,
            vehicleIds: command.vehicleIds,
            pathReceiptId: command.pathReceiptId,
          },
        },
      };
    case FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA:
      return {
        ...common,
        personnelDuties: {
          ...state.personnelDuties,
          [command.personnelDutyId]: {
            id: command.personnelDutyId,
            personnelPoolId: command.personnelPoolId,
            formationIds: command.formationIds,
            pathReceiptId: command.pathReceiptId,
            validFrom: command.validFrom,
            validUntil: command.validUntil,
          },
        },
      };
    case FLEET_PATH_RESERVATION_COMMAND_SCHEMA:
      return {
        ...common,
        pathReservations: {
          ...state.pathReservations,
          [command.pathReservationId]: {
            id: command.pathReservationId,
            pathReceiptId: command.pathReceiptId,
          },
        },
      };
  }
}

function resultFor(
  state: NativeFleetWorldState,
  command: NativeFleetCommand,
  replay: boolean,
): FleetCommandResult {
  const snapshot = snapshotFromState(state);
  const stateHash = hash(state);
  const snapshotHash = fleetSnapshotHash(snapshot);
  const entity = fleetCommandEntity(command);
  return {
    schemaVersion: FLEET_COMMAND_RESULT_SCHEMA,
    state,
    stateHash,
    snapshot,
    snapshotHash,
    commandReceipt: {
      schemaVersion: FLEET_COMMAND_RECEIPT_SCHEMA,
      worldId: command.worldId,
      commandId: command.commandId,
      commandHash: canonicalFleetCommandHash(command),
      canonicalCommandJson: canonicalFleetCommandJson(command),
      resultingRevision: state.revision,
      ...entity,
      resultingStateHash: stateHash,
      resultingSnapshotHash: snapshotHash,
    },
    appliedCommandId: command.commandId,
    ...entity,
    idempotentReplay: replay,
  };
}

function testRuntime(): FleetRuntime {
  return {
    initializeFleet: initialized,
    applyFleetCommand(state, command, replayReceipt) {
      if (replayReceipt !== undefined) return resultFor(state, command, true);
      return resultFor(applyCommand(state, command), command, false);
    },
  };
}

type FleetView = Readonly<{
  revision: number;
  stateHash: string;
  snapshotHash: string;
  snapshot: NativeFleetMobilizationSnapshot;
  idempotentReplay?: boolean;
}>;

describe("produktive M5-HTTP-Single-Writer-Grenze", () => {
  let client: PGlite;
  let db: EconomyDatabase;
  let app: FastifyInstance;

  beforeEach(async () => {
    client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    await database.insert(worlds).values([
      { id: WORLD, name: "Fleet HTTP", schedulePeriodWeeks: 4, epoch: new Date(0) },
      { id: OTHER_WORLD, name: "Ohne Authority", schedulePeriodWeeks: 4, epoch: new Date(0) },
    ]);
    db = database;
    app = buildApp({
      db,
      verifyToken: async () => {
        throw new Error("Identitaetspruefung wird fuer interne Fleet-Routen nicht verwendet.");
      },
      fleetIngestToken: TOKEN,
      fleetRuntime: testRuntime(),
      fleetAuthorityReleases: { [WORLD]: authorityRelease() },
      fleetAuthorityConfigurations: {
        [WORLD]: { producedAt: 0, authorityRelease: authorityRelease() },
      },
      logger: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await client.close();
  });

  function post(worldId: string, suffix: string, payload: object, token = TOKEN) {
    return app.inject({
      method: "POST",
      url: `/internal/worlds/${worldId}/fleet/${suffix}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it("entfernt den Rohsnapshot-Pfad und bleibt bei Token, Welt und Runtime fail-closed", async () => {
    expect((await post(WORLD, "mobilization-snapshots", {
      snapshot: {},
      snapshotHash: "0".repeat(64),
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD}/fleet/initialize`,
      payload: { producedAt: 0 },
    })).statusCode).toBe(401);
    expect((await post(UNKNOWN_WORLD, "initialize", { producedAt: 0 })).statusCode).toBe(404);
    expect((await post(OTHER_WORLD, "initialize", { producedAt: 0 })).statusCode).toBe(404);

    const unavailable = buildApp({
      db,
      verifyToken: async () => {
        throw new Error("nicht verwendet");
      },
      fleetIngestToken: TOKEN,
      fleetAuthorityReleases: { [WORLD]: authorityRelease() },
      logger: false,
    });
    await unavailable.ready();
    expect((await unavailable.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD}/fleet/initialize`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { producedAt: 0 },
    })).statusCode).toBe(503);
    await unavailable.close();
  });

  it("verweigert Authority-, Welt-, State-, Snapshot- und alte DTO-Behauptungen im Body", async () => {
    expect((await post(WORLD, "initialize", {
      producedAt: 0,
      authorityRelease: authorityRelease(),
    })).statusCode).toBe(400);

    const base = {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      commandId: "formation-a",
      expectedStateHash: "0".repeat(64),
      expectedRevision: 0,
      atS: 1,
      formationId: "formation-1",
      vehicleIds: ["vehicle-a", "vehicle-b"],
      pathReceiptId: "path-1",
    };
    for (const forged of [
      { worldId: OTHER_WORLD },
      { authorityRelease: authorityRelease() },
      { state: {} },
      { snapshot: {} },
      { cursor: "revision-0" },
      { availability: "available" },
      { procurement: "delivered" },
      { characteristics: { seats: 999_999 } },
      { ready: true },
      { confirmed: true },
    ]) {
      const response = await post(WORLD, "commands", { ...base, ...forged });
      expect(response.statusCode, JSON.stringify(forged)).toBe(400);
      expect(response.json()).toMatchObject({ code: "fleet_invalid_request" });
    }
  });

  it("verweigert eine Initialisierungszeit abweichend von der Loader-Konfiguration", async () => {
    const response = await post(WORLD, "initialize", { producedAt: 1 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "fleet_seed_time_conflict" });
  });

  it("fuehrt Init, Formation, Dienst und Trasse atomar aus und replayt A nach B historisch", async () => {
    const initializedResponse = await post(WORLD, "initialize", { producedAt: 0 });
    expect(initializedResponse.statusCode).toBe(200);
    const initial = initializedResponse.json<FleetView>();
    expect(Object.keys(initial).sort()).toEqual([
      "revision",
      "snapshot",
      "snapshotHash",
      "stateHash",
    ]);
    expect(initial).toMatchObject({ revision: 0, snapshot: { worldId: WORLD, revision: 0 } });

    const commandA = {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      commandId: "formation-a",
      expectedStateHash: initial.stateHash,
      expectedRevision: initial.revision,
      atS: 1,
      formationId: "formation-1",
      vehicleIds: ["vehicle-b", "vehicle-a"],
      pathReceiptId: "path-1",
    } as const;
    const formationResponse = await post(WORLD, "commands", commandA);
    expect(formationResponse.statusCode).toBe(200);
    const formation = formationResponse.json<FleetView>();
    expect(formation).toMatchObject({
      revision: 1,
      idempotentReplay: false,
      snapshot: {
        worldId: WORLD,
        revision: 1,
        formations: [{
          id: "formation-1",
          availability: "available",
          procurement: "delivered",
          characteristics: { seats: 100 },
        }],
      },
    });
    expect(Object.keys(formation).sort()).toEqual([
      "idempotentReplay",
      "revision",
      "snapshot",
      "snapshotHash",
      "stateHash",
    ]);

    const dutyResponse = await post(WORLD, "commands", {
      schemaVersion: FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
      commandId: "duty-b",
      expectedStateHash: formation.stateHash,
      expectedRevision: formation.revision,
      atS: 2,
      personnelDutyId: "duty-1",
      personnelPoolId: "pool-1",
      formationIds: ["formation-1"],
      pathReceiptId: "path-1",
      validFrom: 10,
      validUntil: 1_000,
    });
    expect(dutyResponse.statusCode).toBe(200);
    const duty = dutyResponse.json<FleetView>();
    expect(duty).toMatchObject({
      revision: 2,
      snapshot: { personnelDuties: [{ id: "duty-1", status: "ready" }] },
    });

    const pathResponse = await post(WORLD, "commands", {
      schemaVersion: FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
      commandId: "path-c",
      expectedStateHash: duty.stateHash,
      expectedRevision: duty.revision,
      atS: 3,
      pathReservationId: "reservation-1",
      pathReceiptId: "path-1",
    });
    expect(pathResponse.statusCode).toBe(200);
    const path = pathResponse.json<FleetView>();
    expect(path).toMatchObject({
      revision: 3,
      snapshot: { pathReservations: [{ id: "reservation-1", status: "confirmed" }] },
    });

    const replayResponse = await post(WORLD, "commands", {
      ...commandA,
      vehicleIds: ["vehicle-a", "vehicle-b"],
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json<FleetView>()).toEqual({
      ...formation,
      idempotentReplay: true,
    });
    expect((await loadFleetProducerCheckpoint(db, WORLD))?.state.revision).toBe(3);

    const conflictingReplay = await post(WORLD, "commands", {
      ...commandA,
      pathReceiptId: "other-path",
    });
    expect(conflictingReplay.statusCode).toBe(409);

    const wrongHead = await post(WORLD, "commands", {
      schemaVersion: FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
      commandId: "path-wrong-head",
      expectedStateHash: "0".repeat(64),
      expectedRevision: 3,
      atS: 4,
      pathReservationId: "reservation-2",
      pathReceiptId: "path-1",
    });
    expect(wrongHead.statusCode).toBe(409);
  });
});
