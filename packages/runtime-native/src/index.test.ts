import { describe, expect, it } from "vitest";

import {
  canonicalFleetCommandHash,
  canonicalFleetCommandJson,
  canonicalizeFleetCommand,
  FLEET_ASSET_TRANSFER_COMMAND_SCHEMA,
  FLEET_AUTHORITY_RELEASE_SCHEMA,
  FLEET_AUTHORITY_RELEASE_SCHEMA_V2,
  FLEET_COMMAND_RECEIPT_SCHEMA,
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  operatingRuntimeFromAddon,
  type FleetAuthorityRelease,
  type NativeFleetCommand,
  type NativeFleetWorldState,
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

const authorityReleaseV2 = {
  ...authorityRelease,
  schemaVersion: FLEET_AUTHORITY_RELEASE_SCHEMA_V2,
  releaseId: "authority-test-v2",
  economyReleaseId: "economy-test-v1",
  economyReleaseSha256: "e".repeat(64),
  assets: authorityRelease.assets.map((asset) => ({
    ...asset,
    orientation: "along" as const,
    condition: {
      mechanicsBasisPoints: 10_000,
      driveBasisPoints: 9_500,
      brakesBasisPoints: 9_000,
      kilometresSinceMaintenance: 12_345,
      operatingHoursSinceMaintenance: 678,
      openObservations: 1,
    },
    restrictions: {
      "power-derate": { "power-basis-points": 3_333 },
      "speed-limit": { "maximum-speed": 30_000 },
      "service-brake-limit": { "service-brake": 600 },
      "emergency-brake-limit": { "emergency-brake": 700 },
      "protection-failure": { "protection-unavailable": "pzb" as const },
      "door-failure": { "door-availability-basis-points": 0 },
      immobilized: "immobilized" as const,
    },
    history: ["2025-01 delivered"],
    technical: {
      ...asset.technical,
      maximumSpeedMmps: 44_444,
      accelerationMmPerS2: 800,
      decelerationMmPerS2: 900,
      continuousPowerKw: 4_000,
      startingTractiveEffortKn: 200,
      brakeWeightKg: 120_000,
      maximumAccelerationCapMmps2: 800,
      serviceBrakeCapMmps2: 900,
      emergencyBrakeMultiplierBasisPoints: 15_000,
      role: "powered-unit" as const,
      controlStands: { front: true, rear: true },
    },
    passenger: {
      ...asset.passenger,
      firstClassSeats: 0,
    },
  })),
} satisfies FleetAuthorityRelease;

const authorityV2AssetHoldings = {
  "vehicle-1": {
    ownerOperatorId: "operator-1",
    holderOperatorId: "operator-1",
    lessorOperatorId: null,
    contractId: null,
    validUntilS: null,
    historyHash: "f".repeat(64),
  },
} as const;

function cloneWithoutField(value: unknown, path: readonly (string | number)[]): unknown {
  const cloned: unknown = structuredClone(value);
  let current = cloned;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) throw new Error("Testpfad verweist nicht auf eine Liste.");
      current = current[segment];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        throw new Error("Testpfad verweist nicht auf ein Objekt.");
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  const field = path.at(-1);
  if (typeof field !== "string" || typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("Testpfad endet nicht in einem Objektfeld.");
  }
  delete (current as Record<string, unknown>)[field];
  return cloned;
}

function cloneWithField(value: unknown, path: readonly (string | number)[], replacement: unknown): unknown {
  const cloned: unknown = structuredClone(value);
  let current = cloned;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) throw new Error("Testpfad verweist nicht auf eine Liste.");
      current = current[segment];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        throw new Error("Testpfad verweist nicht auf ein Objekt.");
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  const field = path.at(-1);
  if (typeof field !== "string" || typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("Testpfad endet nicht in einem Objektfeld.");
  }
  (current as Record<string, unknown>)[field] = replacement;
  return cloned;
}

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
  verifyFleetWorldState: (stateJson: string, expectedStateHash: string) => {
    const state = JSON.parse(stateJson) as NativeFleetWorldState;
    return JSON.stringify({
      schemaVersion: "zugfolge-fleet-world-state-verification/v1",
      worldId: state.worldId,
      revision: state.revision,
      producedAt: state.producedAt,
      authorityReleaseHash: state.authorityReleaseHash,
      stateHash: expectedStateHash,
      snapshotHash: "e".repeat(64),
    });
  },
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
  it("binds persisted Fleet state verification to the exact state and expected hash", () => {
    let forwardedState: unknown;
    let forwardedHash: string | undefined;
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      verifyFleetWorldState: (stateJson, expectedStateHash) => {
        forwardedState = JSON.parse(stateJson) as unknown;
        forwardedHash = expectedStateHash;
        return fleetAddon.verifyFleetWorldState(stateJson, expectedStateHash);
      },
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });

    expect(runtime.verifyFleetWorldState(initialFleetState, "d".repeat(64))).toEqual({
      schemaVersion: "zugfolge-fleet-world-state-verification/v1",
      worldId,
      revision: 0,
      producedAt: 0,
      authorityReleaseHash: "c".repeat(64),
      stateHash: "d".repeat(64),
      snapshotHash: "e".repeat(64),
    });
    expect(forwardedState).toEqual(initialFleetState);
    expect(forwardedHash).toBe("d".repeat(64));

    const forgedResultRuntime = operatingRuntimeFromAddon({
      ...fleetAddon,
      verifyFleetWorldState: (stateJson) => fleetAddon.verifyFleetWorldState(stateJson, "f".repeat(64)),
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    expect(() => forgedResultRuntime.verifyFleetWorldState(initialFleetState, "d".repeat(64)))
      .toThrow(/erwarteten Zustandshash/);
  });

  it("initializes compatible Authority-v1 and forwards only a canonical v2 formation intent", () => {
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

  it("accepts and forwards a complete Authority-v2 compiler projection unchanged", () => {
    let forwardedInitialization: unknown;
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      initializeFleetWorld: (inputJson) => {
        forwardedInitialization = JSON.parse(inputJson) as unknown;
        return JSON.stringify({
          schemaVersion: "zugfolge-fleet-world-initialized/v2",
          state: {
            ...initialFleetState,
            authorityRelease: authorityReleaseV2,
            assetHoldings: authorityV2AssetHoldings,
          },
          stateHash: "d".repeat(64),
          snapshot: {
            schema: "zugfolge-fleet-mobilization/v1",
            worldId,
            revision: 0,
            producedAt: 0,
            formations: [],
            personnelDuties: [],
            pathReservations: [],
          },
          snapshotHash: "e".repeat(64),
        });
      },
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    const input = {
      schemaVersion: FLEET_INITIALIZE_SCHEMA,
      worldId,
      producedAt: 0,
      authorityRelease: authorityReleaseV2,
    } as const;

    const initialized = runtime.initializeFleet(input);

    expect(forwardedInitialization).toEqual(input);
    expect(initialized.state.authorityRelease).toEqual(authorityReleaseV2);
  });

  it("rejects incomplete Authority-v2 projections before calling Rust", () => {
    const cases = [
      { path: ["economyReleaseId"], field: "economyReleaseId" },
      { path: ["economyReleaseSha256"], field: "economyReleaseSha256" },
      { path: ["assets", 0, "orientation"], field: "orientation" },
      { path: ["assets", 0, "condition"], field: "condition" },
      { path: ["assets", 0, "restrictions"], field: "restrictions" },
      { path: ["assets", 0, "history"], field: "history" },
      { path: ["assets", 0, "technical", "maximumSpeedMmps"], field: "maximumSpeedMmps" },
      { path: ["assets", 0, "technical", "accelerationMmPerS2"], field: "accelerationMmPerS2" },
      { path: ["assets", 0, "technical", "decelerationMmPerS2"], field: "decelerationMmPerS2" },
      { path: ["assets", 0, "technical", "continuousPowerKw"], field: "continuousPowerKw" },
      {
        path: ["assets", 0, "technical", "startingTractiveEffortKn"],
        field: "startingTractiveEffortKn",
      },
      { path: ["assets", 0, "technical", "brakeWeightKg"], field: "brakeWeightKg" },
      {
        path: ["assets", 0, "technical", "maximumAccelerationCapMmps2"],
        field: "maximumAccelerationCapMmps2",
      },
      {
        path: ["assets", 0, "technical", "serviceBrakeCapMmps2"],
        field: "serviceBrakeCapMmps2",
      },
      {
        path: ["assets", 0, "technical", "emergencyBrakeMultiplierBasisPoints"],
        field: "emergencyBrakeMultiplierBasisPoints",
      },
      { path: ["assets", 0, "technical", "role"], field: "role" },
      { path: ["assets", 0, "technical", "controlStands"], field: "controlStands" },
    ] as const;

    for (const testCase of cases) {
      let addonCalls = 0;
      const runtime = operatingRuntimeFromAddon({
        ...fleetAddon,
        initializeFleetWorld: () => {
          addonCalls += 1;
          return "{}";
        },
        verifyFleetMobilizationSnapshot: () => "{}",
        initializeOperatingWorld: () => "{}",
        applyOperatingTransition: () => "{}",
      });
      const invalidAuthority = cloneWithoutField(authorityReleaseV2, testCase.path);

      expect(
        () => runtime.initializeFleet({
          schemaVersion: FLEET_INITIALIZE_SCHEMA,
          worldId,
          producedAt: 0,
          authorityRelease: invalidAuthority as FleetAuthorityRelease,
        }),
        `fehlendes v2-Feld ${testCase.field}`,
      ).toThrow(new RegExp(`Pflichtfeld '${testCase.field}'`));
      expect(addonCalls).toBe(0);
    }
  });

  it("rejects semantically inconsistent Authority-v2 projections before calling Rust", () => {
    const cases = [
      {
        path: ["assets", 0, "technical", "decelerationMmPerS2"],
        replacement: 0,
        error: /Fahrdynamik/,
      },
      {
        path: ["assets", 0, "technical", "accelerationMmPerS2"],
        replacement: 799,
        error: /nicht reproduzierbares Referenzprofil/,
      },
      {
        path: ["assets", 0, "technical", "maximumAccelerationCapMmps2"],
        replacement: 0,
        error: /Rohtraktion und Beschleunigungs-Cap/,
      },
      {
        path: ["assets", 0, "technical", "serviceBrakeCapMmps2"],
        replacement: 0,
        error: /nicht positiv/,
      },
      {
        path: ["assets", 0, "technical", "emergencyBrakeMultiplierBasisPoints"],
        replacement: 10_000,
        error: /muss ueber 10000/,
      },
      {
        path: ["assets", 0, "technical", "brakeWeightKg"],
        replacement: 0,
        error: /nicht positiv/,
      },
      {
        path: ["assets", 0, "technical", "massKg"],
        replacement: 300_000_000,
        error: /keine sichere Rohdynamikableitung/,
      },
      {
        path: ["assets", 0, "technical", "electricSystems"],
        replacement: [],
        error: /electricSystems.*inkonsistent/,
      },
      {
        path: ["assets", 0, "technical", "role"],
        replacement: "coach",
        error: /Reisezugwagen/,
      },
      {
        path: ["assets", 0, "installedProtection"],
        replacement: ["lzb"],
        error: /LZB nur mit PZB/,
      },
      {
        path: ["assets", 0, "installedProtection"],
        replacement: [],
        error: /weder PZB noch ETCS/,
      },
      {
        path: ["assets", 0, "passenger", "seats"],
        replacement: 0,
        error: /passenger\.seats/,
      },
      {
        path: ["assets", 0, "technical", "maximumSpeedKph"],
        replacement: 65_536,
        error: /ausserhalb von u16/,
      },
      {
        path: ["assets", 0, "numericId"],
        replacement: Number.MAX_SAFE_INTEGER + 1,
        error: /sichere Ganzzahl/,
      },
      {
        path: ["assets", 0, "acquisitionYear"],
        replacement: 2027,
        error: /Beschaffungsjahre/,
      },
      {
        path: ["assets", 0, "condition", "mechanicsBasisPoints"],
        replacement: 10_001,
        error: /Ganzzahlbereich/,
      },
      {
        path: ["assets", 0, "condition", "kilometresSinceMaintenance"],
        replacement: Number.MAX_SAFE_INTEGER + 1,
        error: /sichere Ganzzahl/,
      },
      {
        path: ["assets", 0, "condition", "openObservations"],
        replacement: 65_536,
        error: /Ganzzahlbereich/,
      },
      {
        path: ["assets", 0, "history"],
        replacement: [" nicht randfrei"],
        error: /randfrei/,
      },
      {
        path: ["assets", 0, "restrictions"],
        replacement: { invalid: { "power-basis-points": 0 } },
        error: /muss positiv/,
      },
      {
        path: ["assets", 0, "restrictions"],
        replacement: { invalid: { "power-basis-points": 10_001 } },
        error: /Ganzzahlbereich/,
      },
      {
        path: ["assets", 0, "restrictions"],
        replacement: { invalid: { "maximum-speed": 0 } },
        error: /nicht positiv/,
      },
      {
        path: ["assets", 0, "restrictions"],
        replacement: { invalid: { "protection-unavailable": "atb" } },
        error: /unbekannten Wert/,
      },
      {
        path: ["assets", 0, "restrictions"],
        replacement: { invalid: { "unknown-effect": 1 } },
        error: /unbekannte Variante/,
      },
      {
        path: ["assets", 0, "restrictions"],
        replacement: { invalid: { "maximum-speed": 30_000, extra: 1 } },
        error: /keine eindeutige Variante/,
      },
      {
        path: ["assets", 0, "restrictions"],
        replacement: { "": "immobilized" },
        error: /nichtleere Zeichenkette/,
      },
    ] as const;
    let addonCalls = 0;
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      initializeFleetWorld: () => {
        addonCalls += 1;
        return "{}";
      },
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });

    for (const testCase of cases) {
      const invalidAuthority = cloneWithField(
        authorityReleaseV2,
        testCase.path,
        testCase.replacement,
      );
      expect(() => runtime.initializeFleet({
        schemaVersion: FLEET_INITIALIZE_SCHEMA,
        worldId,
        producedAt: 0,
        authorityRelease: invalidAuthority as FleetAuthorityRelease,
      })).toThrow(testCase.error);
    }
    expect(addonCalls).toBe(0);
  });

  it("rejects v2-only Authority asset fields and unknown nested fields in v1", () => {
    const v2OnlyFields = {
      condition: authorityReleaseV2.assets[0]!.condition,
      restrictions: authorityReleaseV2.assets[0]!.restrictions,
      history: authorityReleaseV2.assets[0]!.history,
    } as const;
    for (const [field, value] of Object.entries(v2OnlyFields)) {
      const invalidV1 = cloneWithField(authorityRelease, ["assets", 0, field], value);
      expect(() => operatingRuntimeFromAddon({
        ...fleetAddon,
        verifyFleetMobilizationSnapshot: () => "{}",
        initializeOperatingWorld: () => "{}",
        applyOperatingTransition: () => "{}",
      }).initializeFleet({
        schemaVersion: FLEET_INITIALIZE_SCHEMA,
        worldId,
        producedAt: 0,
        authorityRelease: invalidV1 as FleetAuthorityRelease,
      })).toThrow(/unbekannte oder nicht serialisierbare Felder/);
    }
    for (const field of [
      "maximumAccelerationCapMmps2",
      "serviceBrakeCapMmps2",
      "emergencyBrakeMultiplierBasisPoints",
    ] as const) {
      const invalidV1 = cloneWithField(
        authorityRelease,
        ["assets", 0, "technical", field],
        authorityReleaseV2.assets[0]!.technical[field],
      );
      expect(() => operatingRuntimeFromAddon({
        ...fleetAddon,
        verifyFleetMobilizationSnapshot: () => "{}",
        initializeOperatingWorld: () => "{}",
        applyOperatingTransition: () => "{}",
      }).initializeFleet({
        schemaVersion: FLEET_INITIALIZE_SCHEMA,
        worldId,
        producedAt: 0,
        authorityRelease: invalidV1 as FleetAuthorityRelease,
      })).toThrow(/unbekannte oder nicht serialisierbare Felder/);
    }

    const invalidCondition = cloneWithField(
      authorityReleaseV2,
      ["assets", 0, "condition", "unknown"],
      1,
    );
    expect(() => operatingRuntimeFromAddon({
      ...fleetAddon,
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    }).initializeFleet({
      schemaVersion: FLEET_INITIALIZE_SCHEMA,
      worldId,
      producedAt: 0,
      authorityRelease: invalidCondition as FleetAuthorityRelease,
    })).toThrow(/unbekannte oder nicht serialisierbare Felder/);
  });

  it("requires an exact complete Authority-v2 asset-holding map before calling Rust", () => {
    const state = {
      ...initialFleetState,
      authorityRelease: authorityReleaseV2,
      assetHoldings: authorityV2AssetHoldings,
    } as NativeFleetWorldState;
    const command = {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      worldId,
      commandId: "formation:v2-holdings",
      expectedStateHash: "d".repeat(64),
      expectedRevision: 0,
      atS: 1,
      formationId: "formation-v2",
      vehicleIds: ["vehicle-1"],
      pathReceiptId: "path-confirmed",
    } satisfies NativeFleetCommand;
    let addonCalls = 0;
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      applyFleetCommand: () => {
        addonCalls += 1;
        return "{}";
      },
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    const cases = [
      cloneWithoutField(state, ["assetHoldings"]),
      cloneWithField(state, ["assetHoldings"], {}),
      cloneWithField(state, ["assetHoldings"], {
        ...authorityV2AssetHoldings,
        foreign: authorityV2AssetHoldings["vehicle-1"],
      }),
    ];
    for (const invalidState of cases) {
      expect(() => runtime.applyFleetCommand(invalidState as NativeFleetWorldState, command))
        .toThrow(/Asset-Halter|jedes Asset/);
    }
    expect(addonCalls).toBe(0);
  });

  it("canonicalizes key order but preserves the unique head-to-tail vehicle order", () => {
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

    expect(canonicalFleetCommandJson(first)).not.toBe(canonicalFleetCommandJson(reordered));
    expect(canonicalFleetCommandHash(first)).not.toBe(canonicalFleetCommandHash(reordered));
    expect(canonicalFleetCommandHash(first)).toBe("2a98a0cfbd0eaf9204466da423b36a4207e5f96c8c545e5e854ded55161699ee");
    expect(canonicalizeFleetCommand(first).vehicleIds).toEqual([supplementaryId, privateUseId]);
    expect(() => canonicalizeFleetCommand({ ...first, vehicleIds: [privateUseId, privateUseId] })).toThrow(/doppelte Kennungen/);
  });

  it("keeps Authority-v1 command canonicalization compatible with sorted vehicle sets", () => {
    fleetAddonCalls.length = 0;
    const runtime = operatingRuntimeFromAddon({
      ...fleetAddon,
      verifyFleetMobilizationSnapshot: () => "{}",
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    const privateUseId = "vehicle-\u{e000}";
    const supplementaryId = "vehicle-\u{10000}";
    const command = {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      worldId,
      commandId: "legacy-canonical",
      expectedStateHash: "d".repeat(64),
      expectedRevision: 0,
      atS: 1,
      formationId: "formation-legacy",
      vehicleIds: [supplementaryId, privateUseId],
      pathReceiptId: "path-confirmed",
    } satisfies NativeFleetCommand;

    runtime.applyFleetCommand(initialFleetState, command);

    expect(JSON.parse(fleetAddonCalls[0]!.commandJson)).toMatchObject({
      vehicleIds: [privateUseId, supplementaryId],
    });
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
    for (const nextTimetableBoundaryS of [9, 10.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => runtime.applyTransition(initialized.state, {
        schemaVersion: OPERATING_TRANSITION_SCHEMA, worldId, commandId: "invalid-next", expectedStateHash: initialized.stateHash, expectedRevision: 0, lotId: "lot", atS: 10,
        nextTimetableBoundaryS, winnerOperatorId: "public", reason: "failed-tender", mobilizationProof: null, publicVehiclePool: ["public-1"],
      })).toThrow(/Folgestichtag/);
    }
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
