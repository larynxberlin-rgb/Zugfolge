import { describe, expect, it } from "vitest";

import {
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  operatingRuntimeFromAddon,
} from "./index.js";

const worldId = "11111111-1111-4111-8111-111111111111";

const fleetAddon = {
  initializeFleetWorld: () => JSON.stringify({
    schemaVersion: "zugfolge-fleet-world-initialized/v1",
    state: { schemaVersion: "zugfolge-fleet-world-state/v1", worldId, revision: 0, producedAt: 0 },
    stateHash: "d".repeat(64),
    snapshot: { schema: "zugfolge-fleet-mobilization/v1", worldId, revision: 0, producedAt: 0, formations: [], personnelDuties: [], pathReservations: [] },
    snapshotHash: "e".repeat(64),
  }),
  applyFleetCommand: (_stateJson: string, commandJson: string) => {
    const command = JSON.parse(commandJson) as { commandId: string; formation: { id: string } };
    return JSON.stringify({
      schemaVersion: "zugfolge-fleet-command-result/v1",
      state: { schemaVersion: "zugfolge-fleet-world-state/v1", worldId, revision: 1, producedAt: 1 },
      stateHash: "f".repeat(64),
      snapshot: { schema: "zugfolge-fleet-mobilization/v1", worldId, revision: 1, producedAt: 1, formations: [command.formation], personnelDuties: [], pathReservations: [] },
      snapshotHash: "a".repeat(64),
      appliedCommandId: command.commandId,
      entityKind: "formation",
      entityId: command.formation.id,
      idempotentReplay: false,
    });
  },
};

describe("native runtime ABI contract", () => {
  it("initializes M5 and forwards only a versioned formation command to Rust", () => {
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    const initialized = runtime.initializeFleet({
      schemaVersion: FLEET_INITIALIZE_SCHEMA,
      worldId,
      producedAt: 0,
    });
    const result = runtime.applyFleetCommand(initialized.state, {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      worldId,
      commandId: "formation:create",
      expectedStateHash: initialized.stateHash,
      expectedRevision: initialized.state.revision,
      atS: 1,
      formation: {
        id: "formation-1",
        operatorId: "operator-1",
        vehicleIds: ["vehicle-1"],
        serviceLineIds: ["S1"],
        availability: "available",
        procurement: "delivered",
        availableFrom: 0,
        availableUntil: 10,
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
          maintenanceValidUntil: 10,
          traction: "electric",
          replacementPlan: true,
        },
      },
    });
    expect(initialized).toMatchObject({ state: { worldId, revision: 0 }, stateHash: "d".repeat(64) });
    expect(result).toMatchObject({
      state: { worldId, revision: 1, producedAt: 1 },
      appliedCommandId: "formation:create",
      entityKind: "formation",
      entityId: "formation-1",
      idempotentReplay: false,
    });
  });

  it("rejects a cross-world native result instead of trusting the addon", () => {
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      verifyFleetMobilizationSnapshot: () => JSON.stringify({
        schemaVersion: "zugfolge-fleet-mobilization-verification/v1",
        worldId,
        fleetRevision: 1,
        snapshotHash: "c".repeat(64),
      }),
      initializeOperatingWorld: () => JSON.stringify({
        schemaVersion: "zugfolge-operating-world-initialized/v1",
        state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId, revision: 0 },
        stateHash: "a".repeat(64),
      }),
      applyOperatingTransition: () => JSON.stringify({
        schemaVersion: "zugfolge-operating-transition-result/v1",
        state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId: "other", revision: 1 },
        stateHash: "b".repeat(64),
        outcome: { lotId: "lot", previousOperatorId: "old", operatorId: "new", kind: "operator-change", seamless: false, penaltyRequired: false, trainRunIds: ["train"], livemapMarker: null },
        events: [],
        idempotentReplay: false,
      }),
    });
    const initialized = runtime.initialize({
      schemaVersion: OPERATING_INITIALIZE_SCHEMA,
      worldId,
      lots: [{ lotId: "lot", incumbentOperatorId: "old", timetableBoundaryS: 10, trainRuns: [{ trainRunId: "train", formationId: "old-1" }] }],
    });
    expect(() => runtime.applyTransition(initialized.state, {
      schemaVersion: OPERATING_TRANSITION_SCHEMA,
      worldId,
      commandId: "transition",
      expectedStateHash: initialized.stateHash,
      expectedRevision: 0,
      lotId: "lot",
      atS: 10,
      winnerOperatorId: "new",
      mobilizationProof: null,
      publicVehiclePool: ["public-1"],
    })).toThrow(/Weltisolation/);
  });

  it("rejects malformed hashes at the ABI boundary", () => {
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      verifyFleetMobilizationSnapshot: () => JSON.stringify({
        schemaVersion: "zugfolge-fleet-mobilization-verification/v1",
        worldId,
        fleetRevision: 1,
        snapshotHash: "c".repeat(64),
      }),
      initializeOperatingWorld: () => JSON.stringify({
        schemaVersion: "zugfolge-operating-world-initialized/v1",
        state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId, revision: 0 },
        stateHash: "not-a-hash",
      }),
      applyOperatingTransition: () => "{}",
    });
    expect(() => runtime.initialize({ schemaVersion: OPERATING_INITIALIZE_SCHEMA, worldId, lots: [] })).toThrow(/SHA-256/);
  });

  it("binds native M5 verification to the supplied world and revision", () => {
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      verifyFleetMobilizationSnapshot: () => JSON.stringify({
        schemaVersion: "zugfolge-fleet-mobilization-verification/v1",
        worldId: "other",
        fleetRevision: 7,
        snapshotHash: "c".repeat(64),
      }),
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    expect(() => runtime.verifyFleetMobilizationSnapshot({ worldId, revision: 7 })).toThrow(/Weltisolation/);
  });
});
