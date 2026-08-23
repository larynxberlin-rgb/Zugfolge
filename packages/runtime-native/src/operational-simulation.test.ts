import { describe, expect, it, vi } from "vitest";

import {
  OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
  OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
  OPERATIONAL_SIMULATION_RESTORED_SCHEMA,
  OPERATIONAL_SIMULATION_RESTORE_SCHEMA,
  OPERATIONAL_SIMULATION_RESULT_SCHEMA,
  OPERATIONAL_SIMULATION_STATE_SCHEMA,
  operationalSimulationRuntimeFromAddon,
  type OperationalSimulationInitialization,
  type OperationalSimulationNativeAddon,
  type OperationalSimulationState,
} from "./operational-simulation.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const INITIALIZATION_HASH = "c".repeat(64);

function state(hash = HASH_A, revision = 0, publisherSequence = 0): OperationalSimulationState {
  return {
    schemaVersion: OPERATIONAL_SIMULATION_STATE_SCHEMA,
    initializationHash: INITIALIZATION_HASH,
    world: {
      worldId: "world:1",
      regionId: "region:1",
      infraReleaseId: "infra:1",
      nowMs: 0,
      commitSequence: revision,
      eventSequence: 0,
    },
    revision,
    publisherSequence,
    stateHash: hash,
  };
}

function projection(kind: "live-map" | "rzue", commitSequence = 0) {
  return {
    kind,
    worldId: "world:1",
    regionId: "region:1",
    infraReleaseId: "infra:1",
    commitSequence,
    atMs: 0,
    staleAfterMs: 75_000,
    trains: [],
    routeLocks: [],
    signals: {},
    activeDisruptions: [],
  } as const;
}

const initialization: OperationalSimulationInitialization = {
  schemaVersion: "zugfolge-operational-simulation-initialize/v2",
  worldId: "world:1",
  regionId: "region:1",
  nowMs: 0,
  infraRelease: {},
  vehicleTypes: [],
  vehicles: [],
  formations: [],
  trains: [],
};

describe("operative native v2-Grenze", () => {
  it("erzwingt eine gemeinsame LiveMap-/RZUE-Commitwahrheit", () => {
    const addon: OperationalSimulationNativeAddon = {
      initializeOperationalSimulation: () => JSON.stringify({
        schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
        state: state(),
        initializationHash: INITIALIZATION_HASH,
        stateHash: HASH_A,
        liveMap: projection("live-map", 1),
        rzue: projection("rzue", 2),
        events: [],
      }),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
    };
    expect(() => operationalSimulationRuntimeFromAddon(addon).initialize(initialization)).toThrow(/trennt LiveMap- und RZUE-Zustand/);
  });

  it("verwendet die asynchrone native ABI und prueft Revision und Kommando-ID", async () => {
    const next = state(HASH_B, 1, 1);
    const asyncApply = vi.fn(async () => JSON.stringify({
      schemaVersion: OPERATIONAL_SIMULATION_RESULT_SCHEMA,
      state: next,
      initializationHash: INITIALIZATION_HASH,
      stateHash: HASH_B,
      liveMap: projection("live-map", 1),
      rzue: projection("rzue", 1),
      events: [],
      appliedCommandId: "command:1",
      idempotentReplay: false,
    }));
    const runtime = operationalSimulationRuntimeFromAddon({
      initializeOperationalSimulation: vi.fn(),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
      applyOperationalSimulationCommandAsync: asyncApply,
    });
    const result = await runtime.apply(state(), {
      schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
      worldId: "world:1",
      regionId: "region:1",
      commandId: "command:1",
      expectedStateHash: HASH_A,
      expectedRevision: 0,
      expectedPublisherSequence: 0,
      command: { type: "safe-stop", trainId: "train:1", reason: "test" },
    });
    expect(result.stateHash).toBe(HASH_B);
    expect(asyncApply).toHaveBeenCalledOnce();
  });

  it("verwirft eine schwach oder widerspruechlich typisierte Betriebsprojektion", () => {
    const malformed = {
      ...projection("live-map"),
      trains: [{ trainId: "train:1" }],
    };
    const addon: OperationalSimulationNativeAddon = {
      initializeOperationalSimulation: () => JSON.stringify({
        schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
        state: state(),
        initializationHash: INITIALIZATION_HASH,
        stateHash: HASH_A,
        liveMap: malformed,
        rzue: { ...malformed, kind: "rzue" },
        events: [],
      }),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
    };
    expect(() => operationalSimulationRuntimeFromAddon(addon).initialize(initialization)).toThrow(/trainNumber/);
  });

  it("akzeptiert die nullable Serde-Felder und Signalbegriffe des nativen Vertrags", () => {
    const exactTrain = {
      trainId: "train:1",
      trainNumber: "RB 1",
      operatorId: "operator:1",
      movementKind: "train",
      motionState: "standing",
      direction: "along",
      routeVersionId: "route:v1",
      formationVersionId: "formation:v1",
      headRouteMm: 0,
      tailRouteMm: -20_000,
      speedMmps: 0,
      occupiedIntervals: [],
      occupiedBlocks: [],
      authorityEndRouteMm: null,
      motionSegment: null,
      headGeometry: {
        routeMm: 0,
        edgeId: "edge:1",
        edgeOffsetMm: 0,
        latitudeE7: 510_000_000,
        longitudeE7: 120_000_000,
        bearingMilliDegrees: null,
      },
      tailGeometry: null,
      motionGeometry: [],
      waitingReason: null,
    } as const;
    const liveMap = {
      ...projection("live-map"),
      trains: [exactTrain],
      signals: { "signal:1": "failed" },
      activeDisruptions: [{
        disruptionId: "disruption:signal:1",
        effect: { "signal-failed": { signalId: "signal:1" } },
      }],
    } as const;
    const addon: OperationalSimulationNativeAddon = {
      initializeOperationalSimulation: () => JSON.stringify({
        schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
        state: state(),
        initializationHash: INITIALIZATION_HASH,
        stateHash: HASH_A,
        liveMap,
        rzue: { ...liveMap, kind: "rzue" },
        events: [],
      }),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
    };
    expect(operationalSimulationRuntimeFromAddon(addon).initialize(initialization).liveMap.trains)
      .toHaveLength(1);
    expect(operationalSimulationRuntimeFromAddon(addon).initialize(initialization)
      .liveMap.activeDisruptions).toEqual(liveMap.activeDisruptions);
  });

  it("verwirft eine untypisierte oder unvollstaendige aktive Stoerungswirkung", () => {
    const malformed = {
      ...projection("live-map"),
      activeDisruptions: [{
        disruptionId: "disruption:signal:1",
        effect: { "signal-failed": {} },
      }],
    };
    const addon: OperationalSimulationNativeAddon = {
      initializeOperationalSimulation: () => JSON.stringify({
        schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
        state: state(),
        initializationHash: INITIALIZATION_HASH,
        stateHash: HASH_A,
        liveMap: malformed,
        rzue: { ...malformed, kind: "rzue" },
        events: [],
      }),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
    };
    expect(() => operationalSimulationRuntimeFromAddon(addon).initialize(initialization))
      .toThrow(/signalId/);
  });

  it("verwirft getrennte Fahrstrassen- oder Signalwahrheiten trotz gleicher Zuege", () => {
    const addon: OperationalSimulationNativeAddon = {
      initializeOperationalSimulation: () => JSON.stringify({
        schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
        state: state(),
        initializationHash: INITIALIZATION_HASH,
        stateHash: HASH_A,
        liveMap: projection("live-map"),
        rzue: { ...projection("rzue"), signals: { "signal:1": "proceed" } },
        events: [],
      }),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
    };
    expect(() => operationalSimulationRuntimeFromAddon(addon).initialize(initialization)).toThrow(/trennt LiveMap- und RZUE-Zustand/);
  });

  it("verwirft getrennte aktive Stoerungswahrheiten trotz identischem Restzustand", () => {
    const liveMap = {
      ...projection("live-map"),
      activeDisruptions: [{
        disruptionId: "disruption:signal:1",
        effect: { "signal-failed": { signalId: "signal:1" } },
      }],
    } as const;
    const addon: OperationalSimulationNativeAddon = {
      initializeOperationalSimulation: () => JSON.stringify({
        schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
        state: state(),
        initializationHash: INITIALIZATION_HASH,
        stateHash: HASH_A,
        liveMap,
        rzue: { ...liveMap, kind: "rzue", activeDisruptions: [] },
        events: [],
      }),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
    };
    expect(() => operationalSimulationRuntimeFromAddon(addon).initialize(initialization))
      .toThrow(/trennt LiveMap- und RZUE-Stoerungszustand/);
  });

  it("bindet Restore explizit an den erwarteten Initialisierungshash", () => {
    const restore = vi.fn((inputJson: string) => {
      expect(JSON.parse(inputJson)).toMatchObject({
        schemaVersion: OPERATIONAL_SIMULATION_RESTORE_SCHEMA,
        expectedInitializationHash: INITIALIZATION_HASH,
      });
      return JSON.stringify({
        schemaVersion: OPERATIONAL_SIMULATION_RESTORED_SCHEMA,
        state: state(),
        initializationHash: INITIALIZATION_HASH,
        stateHash: HASH_A,
        liveMap: projection("live-map"),
        rzue: projection("rzue"),
      });
    });
    const runtime = operationalSimulationRuntimeFromAddon({
      initializeOperationalSimulation: vi.fn(),
      restoreOperationalSimulation: restore,
      applyOperationalSimulationCommand: vi.fn(),
    });

    expect(runtime.restore(state(), INITIALIZATION_HASH).initializationHash)
      .toBe(INITIALIZATION_HASH);
    expect(() => runtime.restore(state(), "ungueltig")).toThrow(/ungueltig/);
    expect(restore).toHaveBeenCalledOnce();
  });
});
