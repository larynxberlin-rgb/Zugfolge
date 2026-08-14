import { describe, expect, it, vi } from "vitest";

import {
  REGIONAL_LIVEMAP_DELTA_SCHEMA,
  REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA,
  REGIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
  REGIONAL_SIMULATION_COMMAND_BATCH_SCHEMA,
  REGIONAL_SIMULATION_COMMAND_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZED_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
  REGIONAL_SIMULATION_RESTORED_SCHEMA,
  REGIONAL_SIMULATION_RESULT_SCHEMA,
  REGIONAL_SIMULATION_MAX_BATCH_COMMANDS,
  REGIONAL_SIMULATION_STATE_SCHEMA,
  regionalSimulationRuntimeFromAddon,
  type RegionalSimulationState,
} from "./regional-simulation.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const regionId = "leipzig";
const state = (revision = 0, selectedWorldId = worldId): RegionalSimulationState =>
  ({
    schemaVersion: REGIONAL_SIMULATION_STATE_SCHEMA,
    worldId: selectedWorldId,
    regionId,
    materializationWindowHours: 48,
    initialNowS: 0,
    nowS: revision * 100,
    initialTrains: [],
    revision,
    publisherSequence: revision,
    commands: Array.from({ length: revision }, (_, index) => ({ commandId: `c-${index}` })),
  }) as RegionalSimulationState;

function snapshot(selectedState: RegionalSimulationState) {
  return {
    schemaVersion: REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA,
    worldId: selectedState.worldId,
    regionId: selectedState.regionId,
    producerSequence: selectedState.publisherSequence,
    atS: selectedState.nowS,
    trains: [],
    disruptions: [],
  };
}

describe("regionale native M4-Grenze", () => {
  it("dekodiert Aussenlaeufe als eigene Projektion ohne Kartenposition", () => {
    const externalTrain = {
      id: "run-1",
      operator: "operator-1",
      trainNumber: "RE 1",
      category: "regional",
      journeyChainId: "chain-re1",
      externalLegId: "chain-re1:external:1",
      fromPortalId: "portal-eisenach",
      toPortalId: "portal-eisenach",
      scheduledEndS: 4_000,
      reentryEarliestS: 3_700,
      reentryLatestS: 4_300,
      delaySeconds: 120,
      fixedCostCents: "25000",
      boundVehicleIds: ["vehicle-442-001"],
      boundPersonnelDutyIds: ["duty-re1"],
      status: "outside",
      progressBasisPoints: 4_000,
    } as const;
    const runtime = regionalSimulationRuntimeFromAddon({
      initializeRegionalSimulation: () => JSON.stringify({
        schemaVersion: REGIONAL_SIMULATION_INITIALIZED_SCHEMA,
        state: state(),
        stateHash: "a".repeat(64),
        snapshot: { ...snapshot(state()), externalTrains: [externalTrain] },
        events: [],
      }),
      restoreRegionalSimulation: () => "{}",
      applyRegionalSimulationCommand: () => "{}",
      applyRegionalSimulationCommandBatch: () => "{}",
    });

    const initialized = runtime.initialize({
      schemaVersion: REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
      worldId,
      regionId,
      materializationWindowHours: 48,
      nowS: 0,
      trains: [],
    });
    expect(initialized.snapshot.externalTrains).toEqual([externalTrain]);
    expect(initialized.snapshot.externalTrains?.[0]).not.toHaveProperty("positionMm");
  });

  it("bindet Initialize, Restore und Apply an denselben gehashten Zustand", () => {
    const applyNative = vi.fn(() =>
      JSON.stringify({
        schemaVersion: REGIONAL_SIMULATION_RESULT_SCHEMA,
        state: state(1),
        stateHash: "b".repeat(64),
        events: [
          {
            eventId: `simulation:${worldId}:${regionId}:1`,
            worldId,
            regionId,
            simulationSequence: 1,
            eventType: "simulation.train-materialized",
            atS: 100,
            payload: { trainRunId: "run-1" },
          },
        ],
        delta: {
          schemaVersion: REGIONAL_LIVEMAP_DELTA_SCHEMA,
          worldId,
          regionId,
          producerSequence: 1,
          atS: 100,
          changed: [],
          removed: [],
          changedDisruptions: [],
          removedDisruptionIds: [],
        },
        appliedCommandId: "advance-1",
        idempotentReplay: false,
      }),
    );
    const runtime = regionalSimulationRuntimeFromAddon({
      initializeRegionalSimulation: () =>
        JSON.stringify({
          schemaVersion: REGIONAL_SIMULATION_INITIALIZED_SCHEMA,
          state: state(),
          stateHash: "a".repeat(64),
          snapshot: snapshot(state()),
          events: [],
        }),
      restoreRegionalSimulation: () =>
        JSON.stringify({
          schemaVersion: REGIONAL_SIMULATION_RESTORED_SCHEMA,
          state: state(),
          stateHash: "a".repeat(64),
          snapshot: snapshot(state()),
        }),
      applyRegionalSimulationCommand: applyNative,
      applyRegionalSimulationCommandBatch: () => "{}",
    });

    const initialized = runtime.initialize({
      schemaVersion: REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
      worldId,
      regionId,
      materializationWindowHours: 48,
      nowS: 0,
      trains: [],
    });
    expect(runtime.restore(initialized.state).stateHash).toBe(initialized.stateHash);
    expect(
      runtime.apply(initialized.state, {
        schemaVersion: REGIONAL_SIMULATION_COMMAND_SCHEMA,
        worldId,
        regionId,
        commandId: "advance-1",
        expectedStateHash: initialized.stateHash,
        expectedRevision: 0,
        expectedPublisherSequence: 0,
        command: { type: "advance-to", atS: 100 },
      }),
    ).toMatchObject({
      state: { revision: 1, publisherSequence: 1 },
      delta: { producerSequence: 1 },
      appliedCommandId: "advance-1",
      idempotentReplay: false,
    });
    expect(applyNative).toHaveBeenCalledOnce();
  });

  it("bindet einen begrenzten Batch an denselben Kopf und dekodiert das Gesamtergebnis", () => {
    const applyBatchNative = vi.fn(() => JSON.stringify({
      schemaVersion: REGIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
      state: state(2),
      stateHash: "c".repeat(64),
      events: [],
      snapshot: snapshot(state(2)),
      commandResults: [
        { commandId: "advance-1", idempotentReplay: false },
        { commandId: "advance-2", idempotentReplay: false },
      ],
    }));
    const runtime = regionalSimulationRuntimeFromAddon({
      initializeRegionalSimulation: () => "{}",
      restoreRegionalSimulation: () => "{}",
      applyRegionalSimulationCommand: () => "{}",
      applyRegionalSimulationCommandBatch: applyBatchNative,
    });
    const batch = {
      schemaVersion: REGIONAL_SIMULATION_COMMAND_BATCH_SCHEMA,
      worldId,
      regionId,
      expectedStateHash: "a".repeat(64),
      expectedRevision: 0,
      expectedPublisherSequence: 0,
      commands: [
        { commandId: "advance-1", command: { type: "advance-to" as const, atS: 100 } },
        { commandId: "advance-2", command: { type: "advance-to" as const, atS: 200 } },
      ],
    } as const;

    expect(runtime.applyBatch(state(), batch)).toMatchObject({
      state: { revision: 2, publisherSequence: 2 },
      snapshot: { producerSequence: 2, atS: 200 },
      commandResults: [
        { commandId: "advance-1", idempotentReplay: false },
        { commandId: "advance-2", idempotentReplay: false },
      ],
    });
    expect(applyBatchNative).toHaveBeenCalledOnce();

    const oversized = {
      ...batch,
      commands: Array.from(
        { length: REGIONAL_SIMULATION_MAX_BATCH_COMMANDS + 1 },
        (_, index) => ({
          commandId: `oversized-${index}`,
          command: { type: "advance-to" as const, atS: 200 },
        }),
      ),
    };
    expect(() => runtime.applyBatch(state(), oversized)).toThrow(/hoechstens/);
    expect(applyBatchNative).toHaveBeenCalledOnce();
  });

  it("verwirft eine Sequenzluecke aus dem nativen Addon", () => {
    const runtime = regionalSimulationRuntimeFromAddon({
      initializeRegionalSimulation: () => "{}",
      restoreRegionalSimulation: () => "{}",
      applyRegionalSimulationCommand: () =>
        JSON.stringify({
          schemaVersion: REGIONAL_SIMULATION_RESULT_SCHEMA,
          state: state(2),
          stateHash: "b".repeat(64),
          events: [],
          delta: {
            schemaVersion: REGIONAL_LIVEMAP_DELTA_SCHEMA,
            worldId,
            regionId,
            producerSequence: 2,
            atS: 200,
            changed: [],
            removed: [],
            changedDisruptions: [],
            removedDisruptionIds: [],
          },
          appliedCommandId: "advance-1",
          idempotentReplay: false,
        }),
      applyRegionalSimulationCommandBatch: () => "{}",
    });
    expect(() =>
      runtime.apply(state(), {
        schemaVersion: REGIONAL_SIMULATION_COMMAND_SCHEMA,
        worldId,
        regionId,
        commandId: "advance-1",
        expectedStateHash: "a".repeat(64),
        expectedRevision: 0,
        expectedPublisherSequence: 0,
        command: { type: "advance-to", atS: 100 },
      }),
    ).toThrow(/Sequenzluecke/);
  });

  it("verwirft einen Restore-Snapshot aus einer anderen Welt", () => {
    const otherState = state(0, "22222222-2222-4222-8222-222222222222");
    const runtime = regionalSimulationRuntimeFromAddon({
      initializeRegionalSimulation: () => "{}",
      restoreRegionalSimulation: () =>
        JSON.stringify({
          schemaVersion: REGIONAL_SIMULATION_RESTORED_SCHEMA,
          state: otherState,
          stateHash: "a".repeat(64),
          snapshot: snapshot(otherState),
        }),
      applyRegionalSimulationCommand: () => "{}",
      applyRegionalSimulationCommandBatch: () => "{}",
    });
    expect(() => runtime.restore(state())).toThrow(/Welt- oder Regionsisolation/);
  });

  it("verwirft eine nichtkanonische Basisfahrtbindung aus dem nativen Addon", () => {
    const runtime = regionalSimulationRuntimeFromAddon({
      initializeRegionalSimulation: () => "{}",
      restoreRegionalSimulation: () => "{}",
      applyRegionalSimulationCommand: () => JSON.stringify({
        schemaVersion: REGIONAL_SIMULATION_RESULT_SCHEMA,
        state: state(1),
        stateHash: "b".repeat(64),
        events: [],
        delta: {
          schemaVersion: REGIONAL_LIVEMAP_DELTA_SCHEMA,
          worldId,
          regionId,
          producerSequence: 1,
          atS: 100,
          changed: [{
            id: "forged",
            baseTrainRunId: "run-1",
            operator: "operator-1",
            trainNumber: "RE 1",
            category: "regional",
            positionMm: 0,
            speedMmPerSecond: 0,
            delaySeconds: 0,
            nextOperatingPoint: "Leipzig Hbf",
            status: "planned",
          }],
          removed: [],
          changedDisruptions: [],
          removedDisruptionIds: [],
        },
        appliedCommandId: "advance-1",
        idempotentReplay: false,
      }),
      applyRegionalSimulationCommandBatch: () => "{}",
    });
    expect(() => runtime.apply(state(), {
      schemaVersion: REGIONAL_SIMULATION_COMMAND_SCHEMA,
      worldId,
      regionId,
      commandId: "advance-1",
      expectedStateHash: "a".repeat(64),
      expectedRevision: 0,
      expectedPublisherSequence: 0,
      command: { type: "advance-to", atS: 100 },
    })).toThrow(/kanonische Basisfahrtbindung/);
  });
});
