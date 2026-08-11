import { describe, expect, it, vi } from "vitest";

import {
  REGIONAL_LIVEMAP_DELTA_SCHEMA,
  REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA,
  REGIONAL_SIMULATION_COMMAND_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZED_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
  REGIONAL_SIMULATION_RESTORED_SCHEMA,
  REGIONAL_SIMULATION_RESULT_SCHEMA,
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
  };
}

describe("regionale native M4-Grenze", () => {
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
          },
          appliedCommandId: "advance-1",
          idempotentReplay: false,
        }),
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
    });
    expect(() => runtime.restore(state())).toThrow(/Welt- oder Regionsisolation/);
  });
});
