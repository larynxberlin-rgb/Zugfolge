import { PGlite } from "@electric-sql/pglite";
import {
  fleetMobilizationSnapshots,
  fleetWorldCheckpoints,
  MIGRATIONS_FOLDER,
  schema,
  worlds,
} from "@zugfolge/db";
import {
  FLEET_AUTHORITY_RELEASE_SCHEMA,
  FLEET_AUTHORITY_RELEASE_SCHEMA_V2,
  FLEET_COMMAND_RECEIPT_SCHEMA,
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  canonicalFleetCommandHash,
  canonicalFleetCommandJson,
  canonicalizeFleetCommandForState,
  type FleetAuthorityRelease,
  type FleetAuthorityReleaseV1,
  type FleetAuthorityReleaseV2,
  type FleetCommandResult,
  type FleetRuntime,
  type FleetWorldInitialized,
  type NativeFleetCommand,
} from "@zugfolge/runtime-native";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyFleetProducerCommand,
  initializeFleetProducer,
  loadFleetProducerCheckpoint,
} from "./fleet-native-producer.js";
import {
  fleetSnapshotHash,
  loadFleetMobilizationSnapshot,
  type FleetMobilizationSnapshot,
} from "./fleet-snapshot.js";
import type { EconomyDatabase } from "./ledger.js";

const WORLD = "55555555-5555-4555-8555-555555555555";
const AUTHORITY_HASH = "d".repeat(64);

function authorityRelease(): FleetAuthorityReleaseV1 {
  return {
    schemaVersion: FLEET_AUTHORITY_RELEASE_SCHEMA,
    releaseId: "producer-authority-v1",
    referenceYear: 2026,
    assets: ["vehicle-a", "vehicle-b"].map((id, index) => ({
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
      maintenanceDeadlines: [{ kind: "inspection", dueAt: 100 }],
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
        firstClassSeats: 0,
        accessible: true,
        bicyclePlaces: 1,
        wheelchairPlaces: 1,
        equipment: [],
        operatingCostCentsPerTrainKm: 1,
        replacementPlan: true,
      },
      deliveredAt: 0,
      retiredAt: 100,
    })),
    personnelPools: [],
    pathReceipts: [{
      id: "path-1",
      numericRouteId: 1,
      operatorId: "operator-1",
      serviceLineIds: ["S1"],
      decision: "confirmed",
      validFrom: 0,
      validUntil: 100,
      platformLengthsMm: [120_000],
      electrifications: ["overhead-ac15kv"],
      requiredProtection: ["pzb"],
      approvedClasses: ["ET1"],
      plannerStateHash: "a".repeat(64),
      conflictCheckHash: "b".repeat(64),
    }],
  };
}

function authorityReleaseV2(): FleetAuthorityReleaseV2 {
  const legacy = authorityRelease();
  return {
    ...legacy,
    schemaVersion: FLEET_AUTHORITY_RELEASE_SCHEMA_V2,
    releaseId: "producer-authority-v2",
    economyReleaseId: "economy-test-v1",
    economyReleaseSha256: "e".repeat(64),
    assets: legacy.assets.map((asset) => ({
      ...asset,
      orientation: "along",
      technical: {
        ...asset.technical,
        maximumSpeedMmps: 44_444,
        accelerationMmPerS2: 800,
        decelerationMmPerS2: 900,
        continuousPowerKw: 4_000,
        startingTractiveEffortKn: 200,
        brakeWeightKg: 80_000,
        maximumAccelerationCapMmps2: 800,
        serviceBrakeCapMmps2: 900,
        emergencyBrakeMultiplierBasisPoints: 15_000,
        role: "powered-unit",
        controlStands: { front: true, rear: true },
      },
    })),
  };
}

function snapshot(
  revision: number,
  vehicleIds: readonly string[] = ["vehicle-a", "vehicle-b"],
): FleetMobilizationSnapshot {
  return {
    schema: "zugfolge-fleet-mobilization/v1",
    worldId: WORLD,
    revision,
    producedAt: revision,
    formations: revision === 0 ? [] : [{
      id: "formation-1",
      operatorId: "operator-1",
      vehicleIds,
      serviceLineIds: ["S1"],
      availability: "available",
      procurement: "delivered",
      availableFrom: 0,
      availableUntil: 100,
      characteristics: {
        seats: 100,
        firstClassBasisPoints: 0,
        accessible: true,
        bicyclePlaces: 2,
        wheelchairPlaces: 2,
        equipment: [],
        vehicleAgeYears: 1,
        maximumSpeedKph: 160,
        operatingCostCentsPerTrainKm: 2,
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

function initialized(authority: FleetAuthorityRelease = authorityRelease()): FleetWorldInitialized {
  const projection = snapshot(0);
  return {
    schemaVersion: "zugfolge-fleet-world-initialized/v2",
    state: {
      schemaVersion: "zugfolge-fleet-world-state/v2",
      worldId: WORLD,
      revision: 0,
      producedAt: 0,
      authorityReleaseHash: AUTHORITY_HASH,
      authorityRelease: authority,
      formations: {},
      personnelDuties: {},
      pathReservations: {},
    },
    stateHash: "a".repeat(64),
    snapshot: projection,
    snapshotHash: fleetSnapshotHash(projection),
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
    formationId: "formation-1",
    vehicleIds: ["vehicle-b", "vehicle-a"],
    pathReceiptId: "path-1",
  };
}

function applied(
  input: NativeFleetCommand,
  current: FleetWorldInitialized = initialized(),
): FleetCommandResult {
  const exact = canonicalizeFleetCommandForState(current.state, input);
  const vehicleIds = exact.schemaVersion === FLEET_FORMATION_COMMAND_SCHEMA
    ? exact.vehicleIds
    : ["vehicle-a", "vehicle-b"];
  const projection = snapshot(1, vehicleIds);
  const stateHash = "c".repeat(64);
  const snapshotHash = fleetSnapshotHash(projection);
  return {
    schemaVersion: "zugfolge-fleet-command-result/v2",
    state: {
      schemaVersion: "zugfolge-fleet-world-state/v2",
      worldId: WORLD,
      revision: 1,
      producedAt: 1,
      authorityReleaseHash: AUTHORITY_HASH,
      authorityRelease: current.state.authorityRelease,
      formations: {
        "formation-1": { id: "formation-1", vehicleIds, pathReceiptId: "path-1" },
      },
      personnelDuties: {},
      pathReservations: {},
    },
    stateHash,
    snapshot: projection,
    snapshotHash,
    commandReceipt: {
      schemaVersion: FLEET_COMMAND_RECEIPT_SCHEMA,
      worldId: WORLD,
      commandId: exact.commandId,
      commandHash: canonicalFleetCommandHash(exact),
      canonicalCommandJson: canonicalFleetCommandJson(exact),
      resultingRevision: 1,
      entityKind: "formation",
      entityId: "formation-1",
      resultingStateHash: stateHash,
      resultingSnapshotHash: snapshotHash,
    },
    appliedCommandId: exact.commandId,
    entityKind: "formation",
    entityId: "formation-1",
    idempotentReplay: false,
  };
}

function appliedPath(
  current: FleetCommandResult,
  input: Extract<NativeFleetCommand, { schemaVersion: "zugfolge-fleet-attach-path-command/v2" }>,
): FleetCommandResult {
  const projection: FleetMobilizationSnapshot = {
    ...current.snapshot,
    revision: 2,
    producedAt: 2,
    pathReservations: [{
      id: input.pathReservationId,
      operatorId: "operator-1",
      serviceLineIds: ["S1"],
      status: "confirmed",
      validFrom: 0,
      validUntil: 100,
    }],
  };
  const stateHash = "e".repeat(64);
  const snapshotHash = fleetSnapshotHash(projection);
  return {
    schemaVersion: "zugfolge-fleet-command-result/v2",
    state: {
      ...current.state,
      revision: 2,
      producedAt: 2,
      pathReservations: {
        [input.pathReservationId]: { id: input.pathReservationId, pathReceiptId: input.pathReceiptId },
      },
    },
    stateHash,
    snapshot: projection,
    snapshotHash,
    commandReceipt: {
      schemaVersion: FLEET_COMMAND_RECEIPT_SCHEMA,
      worldId: WORLD,
      commandId: input.commandId,
      commandHash: canonicalFleetCommandHash(input),
      canonicalCommandJson: canonicalFleetCommandJson(input),
      resultingRevision: 2,
      entityKind: "path-reservation",
      entityId: input.pathReservationId,
      resultingStateHash: stateHash,
      resultingSnapshotHash: snapshotHash,
    },
    appliedCommandId: input.commandId,
    entityKind: "path-reservation",
    entityId: input.pathReservationId,
    idempotentReplay: false,
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

  it("laedt den Rust-State aus der DB und persistiert Kanonform, Receipt, Checkpoint und Snapshot atomar", async () => {
    const nativeInitialized = initialized();
    const versionedCommand = command(nativeInitialized);
    const nativeApplied = applied(versionedCommand);
    const initializeFleet = vi.fn(() => nativeInitialized);
    const applyFleetCommand = vi.fn((state, exactCommand, receipt) => receipt === undefined
      ? nativeApplied
      : { ...nativeApplied, state, commandReceipt: receipt, idempotentReplay: true });
    const runtime: FleetRuntime = { initializeFleet, applyFleetCommand };
    const initialization = {
      schemaVersion: FLEET_INITIALIZE_SCHEMA,
      worldId: WORLD,
      producedAt: 0,
      authorityRelease: authorityRelease(),
    } as const;

    const current = await initializeFleetProducer({ db, runtime, initialization, ingestedAt: new Date(0) });
    expect(await initializeFleetProducer({ db, runtime, initialization, ingestedAt: new Date(500) })).toEqual(current);
    expect(await db.select().from(fleetWorldCheckpoints)).toHaveLength(1);
    const result = await applyFleetProducerCommand({
      db,
      runtime,
      command: versionedCommand,
      ingestedAt: new Date(1_000),
    });

    const canonicalCommand = canonicalizeFleetCommandForState(nativeInitialized.state, versionedCommand);
    expect(result).toBe(nativeApplied);
    expect(applyFleetCommand).toHaveBeenCalledWith(nativeInitialized.state, canonicalCommand, undefined);
    expect(await loadFleetMobilizationSnapshot(db, WORLD, {
      fleetRevision: nativeApplied.snapshot.revision,
      snapshotHash: nativeApplied.snapshotHash,
    })).toEqual(nativeApplied.snapshot);
    expect(await loadFleetProducerCheckpoint(db, WORLD)).toMatchObject({
      stateHash: nativeApplied.stateHash,
      snapshotHash: nativeApplied.snapshotHash,
      commandId: versionedCommand.commandId,
      commandSchema: versionedCommand.schemaVersion,
      commandJson: canonicalFleetCommandJson(canonicalCommand),
      commandHash: canonicalFleetCommandHash(canonicalCommand),
    });

    const reorderedRetry = { ...versionedCommand, vehicleIds: ["vehicle-a", "vehicle-b"] } as const;
    const replay = await applyFleetProducerCommand({
      db,
      runtime,
      command: reorderedRetry,
      ingestedAt: new Date(2_000),
    });
    expect(replay).toMatchObject({ idempotentReplay: true, stateHash: nativeApplied.stateHash });
    expect(applyFleetCommand).toHaveBeenLastCalledWith(
      nativeApplied.state,
      canonicalCommand,
      nativeApplied.commandReceipt,
    );
    expect(await db.select().from(fleetWorldCheckpoints)).toHaveLength(2);
    expect(await db.select().from(fleetMobilizationSnapshots)).toHaveLength(2);
  });

  it("bewahrt fuer Authority v2 die nichtlexikographische Reihenfolge von Zugspitze bis Zugschluss", async () => {
    const authority = authorityReleaseV2();
    const nativeInitialized = initialized(authority);
    const versionedCommand = command(nativeInitialized);
    const nativeApplied = applied(versionedCommand, nativeInitialized);
    const applyFleetCommand = vi.fn((state, exactCommand, receipt) => receipt === undefined
      ? nativeApplied
      : { ...nativeApplied, state, commandReceipt: receipt, idempotentReplay: true });
    const runtime: FleetRuntime = { initializeFleet: () => nativeInitialized, applyFleetCommand };
    await initializeFleetProducer({
      db,
      runtime,
      initialization: {
        schemaVersion: FLEET_INITIALIZE_SCHEMA,
        worldId: WORLD,
        producedAt: 0,
        authorityRelease: authority,
      },
      ingestedAt: new Date(0),
    });

    const exact = canonicalizeFleetCommandForState(nativeInitialized.state, versionedCommand);
    const result = await applyFleetProducerCommand({
      db,
      runtime,
      command: versionedCommand,
      ingestedAt: new Date(1_000),
    });
    expect(exact).toMatchObject({ vehicleIds: ["vehicle-b", "vehicle-a"] });
    expect(applyFleetCommand).toHaveBeenCalledWith(nativeInitialized.state, exact, undefined);
    expect(result.state.formations["formation-1"]?.vehicleIds).toEqual(["vehicle-b", "vehicle-a"]);
    expect(result.snapshot.formations[0]?.vehicleIds).toEqual(["vehicle-b", "vehicle-a"]);
    expect(await loadFleetProducerCheckpoint(db, WORLD)).toMatchObject({
      commandJson: canonicalFleetCommandJson(exact),
      commandHash: canonicalFleetCommandHash(exact),
      state: {
        formations: {
          "formation-1": { vehicleIds: ["vehicle-b", "vehicle-a"] },
        },
      },
      snapshot: {
        formations: [{ vehicleIds: ["vehicle-b", "vehicle-a"] }],
      },
    });

    await expect(applyFleetProducerCommand({
      db,
      runtime,
      command: versionedCommand,
      ingestedAt: new Date(2_000),
    })).resolves.toMatchObject({ idempotentReplay: true });
    const callsAfterExactReplay = applyFleetCommand.mock.calls.length;
    await expect(applyFleetProducerCommand({
      db,
      runtime,
      command: { ...versionedCommand, vehicleIds: ["vehicle-a", "vehicle-b"] },
      ingestedAt: new Date(3_000),
    })).rejects.toThrow(/kanonisch persistierte/);
    expect(applyFleetCommand).toHaveBeenCalledTimes(callsAfterExactReplay);
    expect(await db.select().from(fleetWorldCheckpoints)).toHaveLength(2);
    expect(await db.select().from(fleetMobilizationSnapshots)).toHaveLength(2);
  });

  it("rollt den Checkpoint zurueck, wenn Rust-Snapshot und Receipt-Hash auseinanderfallen", async () => {
    const nativeInitialized = initialized();
    const versionedCommand = command(nativeInitialized);
    const nativeApplied = applied(versionedCommand);
    const tampered = {
      ...nativeApplied,
      commandReceipt: { ...nativeApplied.commandReceipt, resultingSnapshotHash: "0".repeat(64) },
    };
    const runtime: FleetRuntime = {
      initializeFleet: () => nativeInitialized,
      applyFleetCommand: () => tampered,
    };
    await initializeFleetProducer({
      db,
      runtime,
      initialization: {
        schemaVersion: FLEET_INITIALIZE_SCHEMA,
        worldId: WORLD,
        producedAt: 0,
        authorityRelease: authorityRelease(),
      },
      ingestedAt: new Date(0),
    });

    await expect(applyFleetProducerCommand({
      db,
      runtime,
      command: versionedCommand,
      ingestedAt: new Date(1_000),
    })).rejects.toThrow(/anderen Snapshothash/);
    expect(await db.select().from(fleetWorldCheckpoints)).toHaveLength(1);
    expect(await db.select().from(fleetMobilizationSnapshots)).toHaveLength(1);
  });

  it("weist dieselbe Kommando-ID mit anderen kanonischen Intents ohne neue Revision ab", async () => {
    const nativeInitialized = initialized();
    const versionedCommand = command(nativeInitialized);
    const nativeApplied = applied(versionedCommand);
    const runtime: FleetRuntime = {
      initializeFleet: () => nativeInitialized,
      applyFleetCommand: (state, exactCommand, receipt) => receipt === undefined
        ? nativeApplied
        : { ...nativeApplied, state, commandReceipt: receipt, idempotentReplay: true },
    };
    await initializeFleetProducer({
      db,
      runtime,
      initialization: {
        schemaVersion: FLEET_INITIALIZE_SCHEMA,
        worldId: WORLD,
        producedAt: 0,
        authorityRelease: authorityRelease(),
      },
      ingestedAt: new Date(0),
    });
    await applyFleetProducerCommand({ db, runtime, command: versionedCommand, ingestedAt: new Date(1_000) });

    await expect(applyFleetProducerCommand({
      db,
      runtime,
      command: { ...versionedCommand, pathReceiptId: "different-path" },
      ingestedAt: new Date(2_000),
    })).rejects.toThrow();
    expect(await db.select().from(fleetWorldCheckpoints)).toHaveLength(2);
  });

  it("laedt fuer Retry A nach B den exakten historischen A-Checkpoint statt einer gemischten Sicht", async () => {
    const nativeInitialized = initialized();
    const commandA = command(nativeInitialized);
    const resultA = applied(commandA);
    const commandB = {
      schemaVersion: "zugfolge-fleet-attach-path-command/v2",
      worldId: WORLD,
      commandId: "path:create",
      expectedStateHash: resultA.stateHash,
      expectedRevision: 1,
      atS: 2,
      pathReservationId: "path-reservation-1",
      pathReceiptId: "path-1",
    } as const satisfies NativeFleetCommand;
    const resultB = appliedPath(resultA, commandB);
    const applyFleetCommand = vi.fn((state, exactCommand: NativeFleetCommand, receipt) => {
      if (receipt !== undefined) return { ...resultA, state, commandReceipt: receipt, idempotentReplay: true };
      return exactCommand.schemaVersion === FLEET_FORMATION_COMMAND_SCHEMA ? resultA : resultB;
    });
    const runtime: FleetRuntime = { initializeFleet: () => nativeInitialized, applyFleetCommand };
    await initializeFleetProducer({
      db,
      runtime,
      initialization: {
        schemaVersion: FLEET_INITIALIZE_SCHEMA,
        worldId: WORLD,
        producedAt: 0,
        authorityRelease: authorityRelease(),
      },
      ingestedAt: new Date(0),
    });
    await applyFleetProducerCommand({ db, runtime, command: commandA, ingestedAt: new Date(1_000) });
    await applyFleetProducerCommand({ db, runtime, command: commandB, ingestedAt: new Date(2_000) });

    const replayA = await applyFleetProducerCommand({
      db,
      runtime,
      command: { ...commandA, vehicleIds: ["vehicle-a", "vehicle-b"] },
      ingestedAt: new Date(3_000),
    });
    expect(replayA).toMatchObject({
      idempotentReplay: true,
      stateHash: resultA.stateHash,
      snapshotHash: resultA.snapshotHash,
      state: { revision: 1 },
    });
    expect(applyFleetCommand.mock.calls.at(-1)?.[0]).toEqual(resultA.state);
    expect(await db.select().from(fleetWorldCheckpoints)).toHaveLength(3);
    expect((await loadFleetProducerCheckpoint(db, WORLD))?.state.revision).toBe(2);
  });

  it("weist eine manipulierte persistierte Receipt vor dem nativen Replay ab", async () => {
    const nativeInitialized = initialized();
    const commandA = command(nativeInitialized);
    const resultA = applied(commandA);
    const runtime: FleetRuntime = {
      initializeFleet: () => nativeInitialized,
      applyFleetCommand: (_state, _command, receipt) => receipt === undefined
        ? resultA
        : { ...resultA, commandReceipt: receipt, idempotentReplay: true },
    };
    await initializeFleetProducer({
      db,
      runtime,
      initialization: {
        schemaVersion: FLEET_INITIALIZE_SCHEMA,
        worldId: WORLD,
        producedAt: 0,
        authorityRelease: authorityRelease(),
      },
      ingestedAt: new Date(0),
    });
    await applyFleetProducerCommand({ db, runtime, command: commandA, ingestedAt: new Date(1_000) });
    await db
      .update(fleetWorldCheckpoints)
      .set({ commandHash: "0".repeat(64) })
      .where(and(
        eq(fleetWorldCheckpoints.worldId, WORLD),
        eq(fleetWorldCheckpoints.revision, 1),
      ));

    await expect(applyFleetProducerCommand({
      db,
      runtime,
      command: commandA,
      ingestedAt: new Date(2_000),
    })).rejects.toThrow(/persistierter Rust-Hash/);
    expect(await db.select().from(fleetWorldCheckpoints)).toHaveLength(2);
  });
});
