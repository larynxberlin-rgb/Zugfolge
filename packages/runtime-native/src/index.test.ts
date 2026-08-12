import { describe, expect, it } from "vitest";

import {
  canonicalFleetCommandHash,
  canonicalFleetCommandJson,
  canonicalizeFleetCommand,
  FLEET_ASSET_TRANSFER_COMMAND_SCHEMA,
  FLEET_AUTHORITY_RELEASE_SCHEMA,
  FLEET_COMMAND_RECEIPT_SCHEMA,
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  operatingRuntimeFromAddon,
  type FleetAuthorityRelease,
  type NativeFleetCommand,
} from "./index.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const authorityRelease = {
  schemaVersion: FLEET_AUTHORITY_RELEASE_SCHEMA,
  releaseId: "authority-test-v1",
  referenceYear: 2026,
  assets: [{
    id: "vehicle-1",
    numericId: 1,
    operatorId: "operator-1",
    vehicleTypeId: 101,
    classDesignation: "ET1",
    tradeName: "Testzug",
    buildYear: 2024,
    acquisitionYear: 2025,
    procurementChannel: "leasing",
    approvedLineIds: ["S1"],
    maintenanceDeadlines: [{ kind: "inspection", dueAt: 1_000 }],
    installedProtection: ["pzb"],
    technical: {
      lengthMm: 70_000,
      massKg: 120_000,
      maximumSpeedKph: 160,
      accelerationMmPerS2: 800,
      decelerationMmPerS2: 900,
      traction: "electric",
      electricSystems: ["ac15kv"],
    },
    passenger: {
      seats: 120,
      firstClassSeats: 12,
      accessible: true,
      bicyclePlaces: 8,
      wheelchairPlaces: 2,
      equipment: ["pis"],
      operatingCostCentsPerTrainKm: 700,
      replacementPlan: true,
    },
    deliveredAt: 0,
    retiredAt: 1_000,
  }],
  personnelPools: [{
    id: "pool-1",
    numericId: 1,
    operatorId: "operator-1",
    capacitySeconds: 500,
    minimumRestSeconds: 10,
    classDesignations: ["ET1"],
    pathReceiptIds: ["path-confirmed"],
    qualificationHash: "a".repeat(64),
  }],
  pathReceipts: [{
    id: "path-confirmed",
    numericRouteId: 1,
    operatorId: "operator-1",
    serviceLineIds: ["S1"],
    decision: "confirmed",
    validFrom: 0,
    validUntil: 1_000,
    platformLengthsMm: [150_000],
    electrifications: ["overhead-ac15kv"],
    requiredProtection: ["pzb"],
    approvedClasses: ["ET1"],
    plannerStateHash: "b".repeat(64),
    conflictCheckHash: "c".repeat(64),
  }],
} satisfies FleetAuthorityRelease;

const initialFleetState = {
  schemaVersion: "zugfolge-fleet-world-state/v2",
  worldId,
  revision: 0,
  producedAt: 0,
  authorityReleaseHash: "c".repeat(64),
  authorityRelease,
  formations: {},
  personnelDuties: {},
  pathReservations: {},
};

const fleetAddonCalls: { stateJson: string; commandJson: string; replayReceiptJson?: string }[] = [];

const fleetAddon = {
  initializeFleetWorld: () => JSON.stringify({
    schemaVersion: "zugfolge-fleet-world-initialized/v2",
    state: initialFleetState,
    stateHash: "d".repeat(64),
    snapshot: { schema: "zugfolge-fleet-mobilization/v1", worldId, revision: 0, producedAt: 0, formations: [], personnelDuties: [], pathReservations: [] },
    snapshotHash: "e".repeat(64),
  }),
  applyFleetCommand: (stateJson: string, commandJson: string, replayReceiptJson?: string) => {
    fleetAddonCalls.push({ stateJson, commandJson, ...(replayReceiptJson === undefined ? {} : { replayReceiptJson }) });
    const state = JSON.parse(stateJson) as typeof initialFleetState & { revision: number; producedAt: number; formations: Record<string, unknown> };
    const command = JSON.parse(commandJson) as Extract<NativeFleetCommand, { schemaVersion: typeof FLEET_FORMATION_COMMAND_SCHEMA }>;
    const idempotentReplay = replayReceiptJson !== undefined;
    const resultingRevision = idempotentReplay ? state.revision : state.revision + 1;
    const nextState = idempotentReplay ? state : {
      ...state,
      revision: resultingRevision,
      producedAt: command.atS,
      formations: {
        ...state.formations,
        [command.formationId]: {
          id: command.formationId,
          vehicleIds: command.vehicleIds,
          pathReceiptId: command.pathReceiptId,
        },
      },
    };
    const commandReceipt = replayReceiptJson === undefined ? {
      schemaVersion: FLEET_COMMAND_RECEIPT_SCHEMA,
      worldId,
      commandId: command.commandId,
      commandHash: canonicalFleetCommandHash(command),
      canonicalCommandJson: commandJson,
      resultingRevision,
      entityKind: "formation",
      entityId: command.formationId,
      resultingStateHash: "f".repeat(64),
      resultingSnapshotHash: "a".repeat(64),
    } : JSON.parse(replayReceiptJson) as unknown;
    return JSON.stringify({
      schemaVersion: "zugfolge-fleet-command-result/v2",
      state: nextState,
      stateHash: "f".repeat(64),
      snapshot: {
        schema: "zugfolge-fleet-mobilization/v1",
        worldId,
        revision: resultingRevision,
        producedAt: nextState.producedAt,
        formations: [{
          id: command.formationId,
          operatorId: "operator-1",
          vehicleIds: command.vehicleIds,
          serviceLineIds: ["S1"],
          availability: "available",
          procurement: "delivered",
          availableFrom: 0,
          availableUntil: 1_000,
          characteristics: {
            seats: 120,
            firstClassBasisPoints: 1_000,
            accessible: true,
            bicyclePlaces: 8,
            wheelchairPlaces: 2,
            equipment: ["pis"],
            vehicleAgeYears: 2,
            maximumSpeedKph: 160,
            operatingCostCentsPerTrainKm: 700,
            homologatedLineIds: ["S1"],
            maintenanceValidUntil: 1_000,
            traction: "electric",
            replacementPlan: true,
          },
        }],
        personnelDuties: [],
        pathReservations: [],
      },
      snapshotHash: "a".repeat(64),
      commandReceipt,
      appliedCommandId: command.commandId,
      entityKind: "formation",
      entityId: command.formationId,
      idempotentReplay,
    });
  },
};

describe("native runtime ABI contract", () => {
  it("initializes authoritative M5 and forwards only a canonical v2 formation intent", () => {
    fleetAddonCalls.length = 0;
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
      authorityRelease,
    });
    const command = {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      worldId,
      commandId: "formation:create",
      expectedStateHash: initialized.stateHash,
      expectedRevision: initialized.state.revision,
      atS: 1,
      formationId: "formation-1",
      vehicleIds: ["vehicle-1"],
      pathReceiptId: "path-confirmed",
    } satisfies NativeFleetCommand;
    const result = runtime.applyFleetCommand(initialized.state, command);
    expect(initialized).toMatchObject({ state: { worldId, revision: 0 }, stateHash: "d".repeat(64) });
    expect(result).toMatchObject({
      state: {
        worldId,
        revision: 1,
        producedAt: 1,
        formations: { "formation-1": { vehicleIds: ["vehicle-1"], pathReceiptId: "path-confirmed" } },
      },
      commandReceipt: { commandId: "formation:create", resultingRevision: 1 },
      appliedCommandId: "formation:create",
      entityKind: "formation",
      entityId: "formation-1",
      idempotentReplay: false,
    });
    expect(result.state).not.toHaveProperty("processedCommands");
    expect(fleetAddonCalls).toHaveLength(1);
    expect(fleetAddonCalls[0]?.commandJson).toBe(canonicalFleetCommandJson(command));
    expect(fleetAddonCalls[0]).not.toHaveProperty("replayReceiptJson");

    const replay = runtime.applyFleetCommand(result.state, command, result.commandReceipt);
    expect(replay.idempotentReplay).toBe(true);
    expect(JSON.parse(fleetAddonCalls[1]!.replayReceiptJson!)).toEqual(result.commandReceipt);
  });

  it("canonicalizes key and set order by UTF-8 bytes and rejects duplicate IDs", () => {
    const privateUseId = "vehicle-\u{e000}";
    const supplementaryId = "vehicle-\u{10000}";
    const first = {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      worldId,
      commandId: "canonical",
      expectedStateHash: "d".repeat(64),
      expectedRevision: 0,
      atS: 1,
      formationId: "formation-canonical",
      vehicleIds: [supplementaryId, privateUseId],
      pathReceiptId: "path-confirmed",
    } satisfies NativeFleetCommand;
    const reordered = {
      pathReceiptId: "path-confirmed",
      vehicleIds: [privateUseId, supplementaryId],
      formationId: "formation-canonical",
      atS: 1,
      expectedRevision: 0,
      expectedStateHash: "d".repeat(64),
      commandId: "canonical",
      worldId,
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
    } satisfies NativeFleetCommand;

    expect(canonicalFleetCommandJson(first)).toBe(canonicalFleetCommandJson(reordered));
    expect(canonicalFleetCommandHash(first)).toBe(canonicalFleetCommandHash(reordered));
    expect(canonicalFleetCommandHash(first)).toBe("8f85a082a134e3785918f998b90e8e34c784b163c2ecdf3005a7269aa549da82");
    expect(canonicalizeFleetCommand(first).vehicleIds).toEqual([privateUseId, supplementaryId]);
    expect(() => canonicalizeFleetCommand({ ...first, vehicleIds: [privateUseId, privateUseId] })).toThrow(/doppelte Kennungen/);
  });

  it("binds a secondary-market transfer to the same Rust/TypeScript command hash", () => {
    const transfer = {
      schemaVersion: FLEET_ASSET_TRANSFER_COMMAND_SCHEMA,
      worldId,
      commandId: "market:transfer-1",
      expectedStateHash: "d".repeat(64),
      expectedRevision: 0,
      atS: 120,
      vehicleId: "vehicle-1",
      transferType: "sale",
      fromOwnerOperatorId: "operator-1",
      toOwnerOperatorId: "operator-2",
      fromHolderOperatorId: "operator-1",
      toHolderOperatorId: "operator-2",
      lessorOperatorId: null,
      contractId: null,
      validUntilS: null,
      transferReceiptHash: "a".repeat(64),
    } satisfies NativeFleetCommand;
    expect(canonicalFleetCommandHash(transfer)).toBe(
      "c5c122a872b156518a2df5c0e107648d074850efcd400f196fdeb0f00bf31dcb",
    );
    expect(canonicalizeFleetCommand(transfer)).toEqual(transfer);
    expect(() => canonicalizeFleetCommand({
      ...transfer,
      transferReceiptHash: "not-a-hash",
    })).toThrow(/Beleghash.*SHA-256/);
  });

  it("rejects old materialized or forged formation fields before calling the addon", () => {
    fleetAddonCalls.length = 0;
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    const forged = {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      worldId,
      commandId: "forged",
      expectedStateHash: "d".repeat(64),
      expectedRevision: 0,
      atS: 1,
      formationId: "formation-forged",
      vehicleIds: ["vehicle-1"],
      pathReceiptId: "path-confirmed",
      availability: "available",
      characteristics: { seats: 999_999 },
    } as unknown as NativeFleetCommand;
    expect(() => runtime.applyFleetCommand(initialFleetState, forged)).toThrow(/alte, unbekannte oder fehlende Intent-Felder/);
    expect(fleetAddonCalls).toHaveLength(0);
  });

  it("rejects an unbounded v2 state and a receipt whose hashes are not valid", () => {
    const unboundedRuntime = operatingRuntimeFromAddon({
      ...fleetAddon,
      initializeFleetWorld: () => JSON.stringify({
        schemaVersion: "zugfolge-fleet-world-initialized/v2",
        state: { ...initialFleetState, processedCommands: {} },
        stateHash: "d".repeat(64),
        snapshot: { schema: "zugfolge-fleet-mobilization/v1", worldId, revision: 0, producedAt: 0, formations: [], personnelDuties: [], pathReservations: [] },
        snapshotHash: "e".repeat(64),
      }),
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    expect(() => unboundedRuntime.initializeFleet({
      schemaVersion: FLEET_INITIALIZE_SCHEMA,
      worldId,
      producedAt: 0,
      authorityRelease,
    })).toThrow(/unbeschraenktes Kommandolog/);

    const malformedReceiptRuntime = operatingRuntimeFromAddon({
      ...fleetAddon,
      applyFleetCommand: (stateJson, commandJson, replayReceiptJson) => {
        const decoded = JSON.parse(fleetAddon.applyFleetCommand(stateJson, commandJson, replayReceiptJson)) as {
          commandReceipt: { commandHash: string };
        };
        decoded.commandReceipt.commandHash = "not-a-hash";
        return JSON.stringify(decoded);
      },
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    expect(() => malformedReceiptRuntime.applyFleetCommand(initialFleetState, {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      worldId,
      commandId: "malformed-receipt",
      expectedStateHash: "d".repeat(64),
      expectedRevision: 0,
      atS: 1,
      formationId: "formation-malformed",
      vehicleIds: ["vehicle-1"],
      pathReceiptId: "path-confirmed",
    })).toThrow(/Kommandohash.*SHA-256/);
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
