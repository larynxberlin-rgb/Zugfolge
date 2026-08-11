import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import {
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  type FleetCommandResult,
  type FleetRuntime,
  type FleetWorldInitialized,
  type NativeFleetCommand,
} from "@zugfolge/runtime-native";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyFleetProducerCommand,
  initializeFleetProducer,
} from "./fleet-native-producer.js";
import {
  fleetSnapshotHash,
  loadFleetMobilizationSnapshot,
  type FleetMobilizationSnapshot,
} from "./fleet-snapshot.js";
import type { EconomyDatabase } from "./ledger.js";

const WORLD = "55555555-5555-4555-8555-555555555555";

function snapshot(revision: number): FleetMobilizationSnapshot {
  return {
    schema: "zugfolge-fleet-mobilization/v1",
    worldId: WORLD,
    revision,
    producedAt: revision,
    formations: revision === 0 ? [] : [{
      id: "formation-1",
      operatorId: "operator-1",
      vehicleIds: ["vehicle-1"],
      serviceLineIds: ["S1"],
      availability: "available",
      procurement: "delivered",
      availableFrom: 0,
      availableUntil: 100,
      characteristics: {
        seats: 100,
        firstClassBasisPoints: 0,
        accessible: true,
        bicyclePlaces: 1,
        wheelchairPlaces: 1,
        equipment: [],
        vehicleAgeYears: 1,
        maximumSpeedKph: 160,
        operatingCostCentsPerTrainKm: 1,
        homologatedLineIds: ["S1"],
        maintenanceValidUntil: 100,
        traction: "electric",
        replacementPlan: true,
      },
    }],
    personnelDuties: [],
    pathReservations: [],
  };
}

function initialized(): FleetWorldInitialized {
  const projection = snapshot(0);
  return {
    schemaVersion: "zugfolge-fleet-world-initialized/v1",
    state: {
      schemaVersion: "zugfolge-fleet-world-state/v1",
      worldId: WORLD,
      revision: 0,
      producedAt: 0,
    },
    stateHash: "a".repeat(64),
    snapshot: projection,
    snapshotHash: fleetSnapshotHash(projection),
  };
}

function applied(): FleetCommandResult {
  const projection = snapshot(1);
  return {
    schemaVersion: "zugfolge-fleet-command-result/v1",
    state: {
      schemaVersion: "zugfolge-fleet-world-state/v1",
      worldId: WORLD,
      revision: 1,
      producedAt: 1,
    },
    stateHash: "b".repeat(64),
    snapshot: projection,
    snapshotHash: fleetSnapshotHash(projection),
    appliedCommandId: "formation:create",
    entityKind: "formation",
    entityId: "formation-1",
    idempotentReplay: false,
  };
}

function command(current: FleetWorldInitialized): NativeFleetCommand {
  return {
    schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
    worldId: WORLD,
    commandId: "formation:create",
    expectedStateHash: current.stateHash,
    expectedRevision: current.state.revision,
    atS: 1,
    formation: snapshot(1).formations[0]!,
  };
}

describe("Rust-autoritatives M5-Producer-Gateway", () => {
  let client: PGlite;
  let db: EconomyDatabase;

  beforeEach(async () => {
    client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    await database.insert(worlds).values({
      id: WORLD,
      name: "Fleet Producer",
      schedulePeriodWeeks: 3,
      epoch: new Date(0),
    });
    db = database;
  });

  afterEach(async () => client.close());

  it("sendet nur das versionierte Kommando und persistiert exakt Rust-Snapshot plus Rust-Hash", async () => {
    const nativeInitialized = initialized();
    const nativeApplied = applied();
    const initializeFleet = vi.fn(() => nativeInitialized);
    const applyFleetCommand = vi.fn(() => nativeApplied);
    const runtime: FleetRuntime = { initializeFleet, applyFleetCommand };

    const current = await initializeFleetProducer({
      db,
      runtime,
      initialization: { schemaVersion: FLEET_INITIALIZE_SCHEMA, worldId: WORLD, producedAt: 0 },
      ingestedAt: new Date(0),
    });
    const versionedCommand = command(current);
    const result = await applyFleetProducerCommand({
      db,
      runtime,
      current,
      command: versionedCommand,
      ingestedAt: new Date(1_000),
    });

    expect(result).toBe(nativeApplied);
    expect(applyFleetCommand).toHaveBeenCalledWith(nativeInitialized.state, versionedCommand);
    expect(await loadFleetMobilizationSnapshot(db, WORLD, {
      fleetRevision: nativeApplied.snapshot.revision,
      snapshotHash: nativeApplied.snapshotHash,
    })).toEqual(nativeApplied.snapshot);
  });

  it("verwirft einen manipulierten Rust-Hash, statt die angelieferten Nutzdaten neu zu hashen", async () => {
    const nativeInitialized = initialized();
    const tampered = { ...applied(), snapshotHash: "0".repeat(64) };
    const runtime: FleetRuntime = {
      initializeFleet: () => nativeInitialized,
      applyFleetCommand: () => tampered,
    };
    const current = await initializeFleetProducer({
      db,
      runtime,
      initialization: { schemaVersion: FLEET_INITIALIZE_SCHEMA, worldId: WORLD, producedAt: 0 },
      ingestedAt: new Date(0),
    });

    await expect(applyFleetProducerCommand({
      db,
      runtime,
      current,
      command: command(current),
      ingestedAt: new Date(1_000),
    })).rejects.toThrow();
  });
});
