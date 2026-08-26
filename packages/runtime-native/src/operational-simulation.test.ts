import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  OPERATIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
  OPERATIONAL_SIMULATION_COMMAND_BATCH_SCHEMA,
  OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
  OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA,
  OPERATIONAL_INFRASTRUCTURE_FILE,
  OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV,
  OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE,
  OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
  OPERATIONAL_SIMULATION_RESTORED_SCHEMA,
  OPERATIONAL_SIMULATION_RESTORE_SCHEMA,
  OPERATIONAL_SIMULATION_RESULT_SCHEMA,
  OPERATIONAL_SIMULATION_STATE_SCHEMA,
  assertOperationalTrainNumbers,
  operationalInfrastructureBindingsEqual,
  operationalProtectionModeSelectionEvidence,
  operationalSimulationRuntimeFromAddon,
  type OperationalInfrastructureBinding,
  type OperationalSimulationInitialization,
  type OperationalSimulationNativeAddon,
  type OperationalSimulationState,
} from "./operational-simulation.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const INITIALIZATION_HASH = "c".repeat(64);
const INFRASTRUCTURE_ROOT = mkdtempSync(join(tmpdir(), "zugfolge-runtime-native-test-"));
const PREVIOUS_INFRASTRUCTURE_ROOTS = process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];

const infrastructureBinding = {
  schemaVersion: OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA,
  infraReleaseId: "infra:1",
  file: OPERATIONAL_INFRASTRUCTURE_FILE,
  bytes: 2,
  sha256: HASH_A,
  stateHash: HASH_B,
} as const;

function postgresJsonbOrderedInfrastructureBinding(): OperationalInfrastructureBinding {
  return {
    file: OPERATIONAL_INFRASTRUCTURE_FILE,
    bytes: 2,
    sha256: HASH_A,
    stateHash: HASH_B,
    schemaVersion: OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA,
    infraReleaseId: "infra:1",
  };
}

beforeAll(() => {
  writeFileSync(join(INFRASTRUCTURE_ROOT, OPERATIONAL_INFRASTRUCTURE_FILE), "{}", "utf8");
  process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = JSON.stringify({
    [infrastructureBinding.infraReleaseId]: INFRASTRUCTURE_ROOT,
  });
});

afterAll(() => {
  if (PREVIOUS_INFRASTRUCTURE_ROOTS === undefined) {
    delete process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
  } else {
    process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = PREVIOUS_INFRASTRUCTURE_ROOTS;
  }
});

function state(hash = HASH_A, revision = 0, publisherSequence = 0): OperationalSimulationState {
  return {
    schemaVersion: OPERATIONAL_SIMULATION_STATE_SCHEMA,
    initializationHash: INITIALIZATION_HASH,
    infraRelease: infrastructureBinding,
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

function validationReceipt(overrides: Readonly<Record<string, unknown>> = {}) {
  const protectionEvidence = operationalProtectionModeSelectionEvidence(initialization);
  return {
    schemaVersion: OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA,
    worldId: "world:1",
    regionId: "region:1",
    initializationHash: INITIALIZATION_HASH,
    stateHash: HASH_A,
    infraRelease: infrastructureBinding,
    programTrainCount: 0,
    validatedProgramTemplateCount: 0,
    validatedRouteVersionCount: 0,
    validatedDispatchInterlockingRouteCount: 0,
    validatedResourceBindingCount: 0,
    validatedFormationBindingCount: 0,
    validatedTrainNumberCount: 0,
    protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
    validatedProtectionModeSelectionCount: protectionEvidence.count,
    protectionModeSelectionsSha256: protectionEvidence.sha256,
    protectionModeSelectionsValidated: true,
    dynamicTrainCount: 0,
    resourceBindingsValidated: true,
    formationBindingsValidated: true,
    trainNumbersValidated: true,
    validationMode: OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE,
    ...overrides,
  };
}

const initialization: OperationalSimulationInitialization = {
  schemaVersion: "zugfolge-operational-simulation-initialize/v2",
  worldId: "world:1",
  regionId: "region:1",
  nowMs: 0,
  protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  infraRelease: infrastructureBinding,
  vehicleTypes: [],
  vehicles: [],
  formations: [],
  trains: [],
};

describe("operative native v2-Grenze", () => {
  it("akzeptiert die Grenzen 1 und 99999 und verwirft 0, 00000, Ueberlaenge oder numerische Duplikate", () => {
    expect(() => assertOperationalTrainNumbers([
      { trainNumber: "1" },
      { trainNumber: "ICE 99999" },
      { trainNumber: "S4-35000" },
    ])).not.toThrow();
    expect(() => assertOperationalTrainNumbers([{ trainNumber: "0" }])).toThrow(/1 und 99999/u);
    expect(() => assertOperationalTrainNumbers([{ trainNumber: "RB 00000" }])).toThrow(/1 und 99999/u);
    expect(() => assertOperationalTrainNumbers([{ trainNumber: "S4-1667972" }]))
      .toThrow(/1 und 99999/u);
    expect(() => assertOperationalTrainNumbers([
      { trainNumber: "RE 5157" },
      { trainNumber: "IC-5157" },
    ])).toThrow(/5157 mehrfach/u);
  });

  it("hashbindet die kompakte RLE sprachuebergreifend und verwirft nichtkanonische Laeufe", () => {
    const train = (id: string) => ({
      id,
      trainNumber: id === "train:1" ? "RB 1" : "RB 2",
      operatorId: "operator:1",
      movementKind: "train" as const,
      routeVersionId: "route:v1",
      formationVersionId: "formation:1",
      headRouteMm: 0,
      scheduledDepartureMs: null,
      publicPassengerStop: false,
      dispatchInterlockingRouteId: "interlocking:1",
      protectionModeSelectionRuns: [{
        throughRouteLegIndex: 0,
        selectedProtectionSystem: "pzb" as const,
      }],
    });
    const selected: OperationalSimulationInitialization = {
      ...initialization,
      trains: [train("train:2"), train("train:1")],
    };
    expect(operationalProtectionModeSelectionEvidence(selected)).toEqual({
      count: 2,
      sha256: "208a9b4217bdf68c054bb78717e5c1ba237c84cbf40b143592fe15a3bb338437",
    });

    expect(() => operationalProtectionModeSelectionEvidence({
      ...selected,
      trains: [{
        ...train("train:1"),
        protectionModeSelectionRuns: [
          { throughRouteLegIndex: 0, selectedProtectionSystem: "pzb" },
          { throughRouteLegIndex: 1, selectedProtectionSystem: "pzb" },
        ],
      }],
    })).toThrow(/nichtkanonische benachbarte/u);
    expect(() => operationalProtectionModeSelectionEvidence({
      ...selected,
      trains: [{
        ...train("train:1"),
        protectionModeSelectionRuns: [{
          throughRouteLegIndex: 0,
          selectedProtectionSystem: "unknown" as "pzb",
        }],
      }],
    })).toThrow(/unbekanntes Zugsicherungssystem/u);
  });

  it("waehlt Infrastrukturwurzeln ausschliesslich ueber die InfraRelease-ID-Allowlist", () => {
    const initialize = vi.fn();
    const runtime = operationalSimulationRuntimeFromAddon({
      initializeOperationalSimulation: initialize,
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
    });
    const foreignInitialization: OperationalSimulationInitialization = {
      ...initialization,
      infraRelease: {
        ...infrastructureBinding,
        infraReleaseId: "infra:foreign",
      },
    };

    expect(() => runtime.initialize(foreignInitialization)).toThrow(/keine erlaubte/);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("liefert nur einen an Welt, Hashes und Infrastruktur gebundenen nativen Validierungsbeleg", () => {
    const initialize = vi.fn(() => JSON.stringify({
      schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
      state: state(),
      initializationHash: INITIALIZATION_HASH,
      stateHash: HASH_A,
      liveMap: projection("live-map"),
      rzue: projection("rzue"),
      events: [],
      validationReceipt: validationReceipt(),
    }));
    const runtime = operationalSimulationRuntimeFromAddon({
      initializeOperationalSimulation: initialize,
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
    });

    expect(runtime.initialize(initialization).validationReceipt.validationMode)
      .toBe(OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE);
    expect(initialize).toHaveBeenCalledWith(
      JSON.stringify(initialization),
      join(INFRASTRUCTURE_ROOT, OPERATIONAL_INFRASTRUCTURE_FILE),
    );

    initialize.mockReturnValueOnce(JSON.stringify({
      schemaVersion: OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
      state: state(),
      initializationHash: INITIALIZATION_HASH,
      stateHash: HASH_A,
      liveMap: projection("live-map"),
      rzue: projection("rzue"),
      events: [],
      validationReceipt: validationReceipt({ initializationHash: HASH_B }),
    }));
    expect(() => runtime.initialize(initialization)).toThrow(/fremden Initialisierungshash/);
  });

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
        validationReceipt: validationReceipt(),
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

  it("validiert die atomare Batch-ABI samt Replayreihenfolge und kompaktem Stoerungskontext", async () => {
    const effect = { "signal-failed": { signalId: "signal:1" } } as const;
    const next = state(HASH_B, 2, 2);
    let nativeResult: Readonly<Record<string, unknown>> = {
      schemaVersion: OPERATIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
      state: next,
      initializationHash: INITIALIZATION_HASH,
      stateHash: HASH_B,
      liveMap: projection("live-map", 2),
      rzue: projection("rzue", 2),
      events: [{ kind: "disruption-activated" }, { kind: "disruption-cleared" }],
      commandResults: [
        { commandId: "batch:activate", idempotentReplay: false },
        { commandId: "batch:activate", idempotentReplay: true },
        { commandId: "batch:clear", idempotentReplay: false },
      ],
      eventContexts: [
        {
          commandIndex: 0,
          commandId: "batch:activate",
          commitSequence: 1,
          affectedTrainRunIds: [],
        },
        {
          commandIndex: 2,
          commandId: "batch:clear",
          commitSequence: 2,
          affectedTrainRunIds: [],
          disruptionEffectBefore: effect,
        },
      ],
    };
    const syncBatch = vi.fn();
    const asyncBatch = vi.fn(async () => JSON.stringify(nativeResult));
    const runtime = operationalSimulationRuntimeFromAddon({
      initializeOperationalSimulation: vi.fn(),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
      applyOperationalSimulationCommandBatch: syncBatch,
      applyOperationalSimulationCommandBatchAsync: asyncBatch,
    });
    const batch = {
      schemaVersion: OPERATIONAL_SIMULATION_COMMAND_BATCH_SCHEMA,
      worldId: "world:1",
      regionId: "region:1",
      expectedStateHash: HASH_A,
      expectedRevision: 0,
      expectedPublisherSequence: 0,
      commands: [
        {
          commandId: "batch:activate",
          command: { type: "activate-disruption" as const, disruptionId: "disruption:1", effect },
        },
        {
          commandId: "batch:activate",
          command: { type: "activate-disruption" as const, disruptionId: "disruption:1", effect },
        },
        {
          commandId: "batch:clear",
          command: {
            type: "clear-disruption" as const,
            disruptionId: "disruption:1",
            releaseReference: "release:test",
          },
        },
      ],
    } as const;

    await expect(runtime.applyBatch(state(), batch)).resolves.toMatchObject({
      state: { revision: 2, publisherSequence: 2 },
      commandResults: [
        { commandId: "batch:activate", idempotentReplay: false },
        { commandId: "batch:activate", idempotentReplay: true },
        { commandId: "batch:clear", idempotentReplay: false },
      ],
    });
    expect(asyncBatch).toHaveBeenCalledOnce();
    expect(syncBatch).not.toHaveBeenCalled();

    nativeResult = {
      ...nativeResult,
      eventContexts: [{
        commandIndex: 2,
        commandId: "batch:clear",
        commitSequence: 1,
        affectedTrainRunIds: [],
        disruptionEffectBefore: effect,
      }],
    };
    await expect(runtime.applyBatch(state(), batch)).rejects.toThrow(/fremde Commitsequenz|keinen Ereigniskontext/u);
  });

  it("faellt ohne echte native Batch-ABI geschlossen aus statt Einzelkommandos nachzubilden", async () => {
    const singleApply = vi.fn();
    const runtime = operationalSimulationRuntimeFromAddon({
      initializeOperationalSimulation: vi.fn(),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: singleApply,
    });
    await expect(runtime.applyBatch(state(), {
      schemaVersion: OPERATIONAL_SIMULATION_COMMAND_BATCH_SCHEMA,
      worldId: "world:1",
      regionId: "region:1",
      expectedStateHash: HASH_A,
      expectedRevision: 0,
      expectedPublisherSequence: 0,
      commands: [{
        commandId: "batch:advance",
        command: { type: "advance-to", atMs: 1_000 },
      }],
    })).rejects.toThrow(/applyOperationalSimulationCommandBatch nicht/u);
    expect(singleApply).not.toHaveBeenCalled();
  });

  it("vergleicht die Infrastrukturbindung nach PostgreSQL-JSONB-Roundtrip feldweise und weiterhin fail-closed", async () => {
    const reordered = postgresJsonbOrderedInfrastructureBinding();
    const missingBytes: Record<string, unknown> = { ...reordered };
    delete missingBytes["bytes"];
    expect(operationalInfrastructureBindingsEqual(reordered, infrastructureBinding)).toBe(true);
    for (const changed of [
      { ...reordered, schemaVersion: "zugfolge-operational-infrastructure-binding/foreign" },
      { ...reordered, infraReleaseId: "infra:foreign" },
      { ...reordered, file: "foreign.json" },
      { ...reordered, bytes: 3 },
      { ...reordered, sha256: "d".repeat(64) },
      { ...reordered, stateHash: "e".repeat(64) },
    ]) {
      expect(operationalInfrastructureBindingsEqual(changed, infrastructureBinding)).toBe(false);
    }
    expect(operationalInfrastructureBindingsEqual(missingBytes, infrastructureBinding)).toBe(false);
    expect(operationalInfrastructureBindingsEqual(
      { ...reordered, additionalBinding: true },
      infrastructureBinding,
    )).toBe(false);
    const persisted = {
      ...state(),
      infraRelease: reordered,
    };
    const canonicalNext = state(HASH_B, 1, 1);
    const asyncApply = vi.fn(async () => JSON.stringify({
      schemaVersion: OPERATIONAL_SIMULATION_RESULT_SCHEMA,
      state: canonicalNext,
      initializationHash: INITIALIZATION_HASH,
      stateHash: HASH_B,
      liveMap: projection("live-map", 1),
      rzue: projection("rzue", 1),
      events: [],
      appliedCommandId: "command:jsonb",
      idempotentReplay: false,
    }));
    const runtime = operationalSimulationRuntimeFromAddon({
      initializeOperationalSimulation: vi.fn(),
      restoreOperationalSimulation: vi.fn(),
      applyOperationalSimulationCommand: vi.fn(),
      applyOperationalSimulationCommandAsync: asyncApply,
    });
    const command = {
      schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
      worldId: "world:1",
      regionId: "region:1",
      commandId: "command:jsonb",
      expectedStateHash: HASH_A,
      expectedRevision: 0,
      expectedPublisherSequence: 0,
      command: { type: "safe-stop" as const, trainId: "train:1", reason: "test" },
    } as const;

    await expect(runtime.apply(persisted, command)).resolves.toMatchObject({ stateHash: HASH_B });

    asyncApply.mockResolvedValueOnce(JSON.stringify({
      schemaVersion: OPERATIONAL_SIMULATION_RESULT_SCHEMA,
      state: {
        ...canonicalNext,
        infraRelease: { ...infrastructureBinding, sha256: "d".repeat(64) },
      },
      initializationHash: INITIALIZATION_HASH,
      stateHash: HASH_B,
      liveMap: projection("live-map", 1),
      rzue: projection("rzue", 1),
      events: [],
      appliedCommandId: "command:jsonb",
      idempotentReplay: false,
    }));
    await expect(runtime.apply(persisted, command)).rejects.toThrow(/wechselte die Infrastrukturbindung/u);
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
        validationReceipt: validationReceipt(),
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
        validationReceipt: validationReceipt(),
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
        validationReceipt: validationReceipt(),
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
        validationReceipt: validationReceipt(),
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
        validationReceipt: validationReceipt(),
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

    const persisted = {
      ...state(),
      infraRelease: postgresJsonbOrderedInfrastructureBinding(),
    };
    expect(runtime.restore(persisted, INITIALIZATION_HASH).initializationHash)
      .toBe(INITIALIZATION_HASH);
    expect(() => runtime.restore(state(), "ungueltig")).toThrow(/ungueltig/);
    expect(restore).toHaveBeenCalledOnce();
  });
});
