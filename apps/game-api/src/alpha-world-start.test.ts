import { describe, expect, it, vi } from "vitest";
import {
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  type OperationalSimulationInitialization,
} from "@zugfolge/runtime-native";

import {
  ACTIVE_WORLD_DEPLOYMENT_CUTOVER_ERROR_CODE,
  ActiveWorldDeploymentCutoverError,
  initializeOrRestoreRegionalSimulation,
  parsePersistedActiveAlphaWorldDeployment,
  publicOperationSnapshotVerification,
  validateDeploymentWorldDefinition,
} from "./alpha-world-start.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";

const definition = {
  name: "Mitteldeutschland 2026",
  kind: "public",
  rankingStatus: "ranked",
  schedulePeriodWeeks: 4,
  epoch: "2026-08-10T00:00:00.000Z",
};

describe("signierte Alpha-Weltepoche", () => {
  it("akzeptiert ausschliesslich einen Montag um 00:00:00 UTC", () => {
    expect(() => validateDeploymentWorldDefinition(definition, "public")).not.toThrow();
    expect(() => validateDeploymentWorldDefinition(
      { ...definition, epoch: "2026-08-10T00:00:00Z" },
      "public",
    )).not.toThrow();
    expect(() => validateDeploymentWorldDefinition(
      { ...definition, epoch: "2026-08-09T00:00:00.000Z" },
      "public",
    )).toThrow(/Weltdefinition/);
    expect(() => validateDeploymentWorldDefinition(
      { ...definition, epoch: "2026-08-10T00:00:01.000Z" },
      "public",
    )).toThrow(/Weltdefinition/);
    expect(() => validateDeploymentWorldDefinition(
      { ...definition, epoch: "2026-08-10T02:00:00+02:00" },
      "public",
    )).not.toThrow();
  });
});

describe("harter Operational-v2-Serverstart", () => {
  const initialization: OperationalSimulationInitialization = {
    schemaVersion: "zugfolge-operational-simulation-initialize/v2",
    worldId: "00000000-0000-4000-8000-000000000014",
    regionId: "deutschland",
    nowMs: 0,
    repeatEveryMs: null,
    protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
    infraRelease: {
      schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
      infraReleaseId: "infra-deutschland-2026.3",
      file: "operational-infrastructure-v2.json",
      bytes: 1,
      sha256: "a".repeat(64),
      stateHash: "b".repeat(64),
    },
    vehicleTypes: [],
    vehicles: [],
    formations: [],
    trains: [],
    movementContinuations: [],
  };

  it("initialisiert einen neuen Kopf ohne vorzeitigen Restore", async () => {
    const initialize = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);

    await expect(initializeOrRestoreRegionalSimulation(
      { initialize, restore },
      initialization,
      undefined,
      new Date(0),
    )).resolves.toBe("initialized");
    expect(initialize).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
  });

  it("restauriert einen vorhandenen Kopf ohne erneute Initialisierung", async () => {
    const initialize = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const expected = operationalSimulationInitializationHash(initialization);

    await expect(initializeOrRestoreRegionalSimulation(
      { initialize, restore },
      initialization,
      expected,
      new Date(0),
    )).resolves.toBe("restored");
    expect(initialize).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith(initialization.worldId, initialization.regionId, expected);
  });

  it("weist einen vorhandenen Kopf mit fremder Initialisierungsbindung ohne Mutation ab", async () => {
    const initialize = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);

    await expect(initializeOrRestoreRegionalSimulation(
      { initialize, restore },
      initialization,
      "f".repeat(64),
      new Date(0),
    )).rejects.toThrow(/gehoert nicht zum signierten Deployment/u);
    expect(initialize).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("meldet fuer ein persistiertes aktives V1-Deployment einen stabilen Cutover-Fehlercode", () => {
    const persistedV1 = {
      deployment: {
        schema: "zugfolge-alpha-world-deployment/v1",
        worldId: "00000000-0000-4000-8000-000000000014",
      },
      deploymentHash: "a".repeat(64),
      signature: {
        algorithm: "Ed25519",
        keyId: "legacy-alpha",
        valueBase64: Buffer.alloc(64).toString("base64"),
      },
    };

    expect(() => parsePersistedActiveAlphaWorldDeployment(
      persistedV1.deployment.worldId,
      persistedV1,
      {},
    )).toThrow(expect.objectContaining({
      name: "ActiveWorldDeploymentCutoverError",
      code: ACTIVE_WORLD_DEPLOYMENT_CUTOVER_ERROR_CODE,
      worldId: persistedV1.deployment.worldId,
    }));
    expect(() => parsePersistedActiveAlphaWorldDeployment(
      persistedV1.deployment.worldId,
      persistedV1,
      {},
    )).toThrow(ActiveWorldDeploymentCutoverError);
  });
});

describe("Eigenbetriebsverifikation nach einem Prozessneustart", () => {
  it("belegt mit exakt gebundenem Operational-v2-Regionsframe die Livemap, erfindet aber keine laufenden Fahrten", () => {
    const snapshot = {
      worldId: "00000000-0000-4000-8000-000000000315",
      streamId: "operational-v2-start",
      sequence: 0,
      at: 0,
      trains: [],
      operationalRegions: [{
        regionId: "deutschland",
        infrastructureReleaseId: "infra-deutschland-2026.3",
        commitSequence: 0,
        simulationTimeMs: 0,
        staleAfterMs: 5_000,
        routeLocks: [],
        signals: {},
        activeDisruptions: [],
      }],
    } as const;
    const binding = {
      regionId: "deutschland",
      infrastructureReleaseId: "infra-deutschland-2026.3",
    } as const;

    expect(publicOperationSnapshotVerification(snapshot, ["run-1", "run-2"], binding))
      .toEqual({ livemapReady: true, runningTrainRunIds: [] });
    expect(publicOperationSnapshotVerification({
      ...snapshot,
      operationalRegions: [{ ...snapshot.operationalRegions[0], regionId: "fremd" }],
    }, ["run-1", "run-2"], binding)).toEqual({ livemapReady: false, runningTrainRunIds: [] });
    expect(publicOperationSnapshotVerification({
      ...snapshot,
      operationalRegions: [{
        ...snapshot.operationalRegions[0],
        infrastructureReleaseId: "infra-fremd",
      }],
    }, ["run-1", "run-2"], binding)).toEqual({ livemapReady: false, runningTrainRunIds: [] });
    expect(publicOperationSnapshotVerification({ ...snapshot, operationalRegions: [] }, ["run-1"], binding))
      .toEqual({ livemapReady: false, runningTrainRunIds: [] });
    expect(publicOperationSnapshotVerification({
      ...snapshot,
      trains: [{
        id: "run-1",
        operator: "public",
        trainNumber: "RE 1",
        category: "regional",
        positionMm: 0,
        speedMmPerSecond: 0,
        delaySeconds: 0,
        nextOperatingPoint: "station-1",
        status: "planned",
        operationMarker: {
          schemaVersion: "zugfolge-livemap-operation-marker/v1",
          kind: "public-operator",
        },
      }],
      operationalRegions: [],
    }, ["run-1"], binding)).toEqual({
      livemapReady: false,
      runningTrainRunIds: ["run-1"],
    });
  });

  it("reduziert kanonische Tagesinstanzen und Aussenlaeufe auf die signierten Basisfahrten", () => {
    const result = publicOperationSnapshotVerification({
      worldId: "00000000-0000-4000-8000-000000000014",
      streamId: "restart-stream",
      sequence: 17,
      at: 3 * 86_400 + 3_600,
      trains: [{
        id: "train-1:day-3",
        baseTrainRunId: "train-1",
        operator: "public",
        trainNumber: "RE 1",
        category: "regional",
        positionMm: 1_000,
        speedMmPerSecond: 20_000,
        delaySeconds: 0,
        nextOperatingPoint: "station-2",
        status: "running",
        operationMarker: {
          schemaVersion: "zugfolge-livemap-operation-marker/v1",
          kind: "public-operator",
        },
      }, {
        id: "train-1:day-2",
        baseTrainRunId: "train-1",
        operator: "public",
        trainNumber: "RE 1",
        category: "regional",
        positionMm: 20_000,
        speedMmPerSecond: 0,
        delaySeconds: 0,
        nextOperatingPoint: "station-3",
        status: "completed",
        operationMarker: {
          schemaVersion: "zugfolge-livemap-operation-marker/v1",
          kind: "public-operator",
        },
      }, {
        id: "player-train",
        operator: "player",
        trainNumber: "P 1",
        category: "regional",
        positionMm: 500,
        speedMmPerSecond: 10_000,
        delaySeconds: 0,
        nextOperatingPoint: "station-2",
        status: "running",
      }],
      externalTrains: [{
        id: "train-2:day-3",
        operator: "public",
        trainNumber: "RB 2",
        category: "regional",
        journeyChainId: "train-2",
        externalLegId: "external-1",
        fromPortalId: "portal-1",
        toPortalId: "portal-2",
        scheduledEndS: 4 * 86_400,
        reentryEarliestS: 4 * 86_400,
        reentryLatestS: 4 * 86_400 + 300,
        delaySeconds: 0,
        status: "outside",
        progressBasisPoints: 5_000,
      }],
    }, ["train-1", "train-2"]);

    expect(result).toEqual({
      livemapReady: true,
      runningTrainRunIds: ["train-1", "train-2"],
    });
  });

  it("akzeptiert weder gefaelschte Basisbindungen noch nichtkanonische Tagesnummern", () => {
    const result = publicOperationSnapshotVerification({
      worldId: "00000000-0000-4000-8000-000000000014",
      streamId: "forged-stream",
      sequence: 1,
      at: 86_400,
      trains: [{
        id: "train-1:day-1",
        baseTrainRunId: "forged-train",
        operator: "public",
        trainNumber: "RE 1",
        category: "regional",
        positionMm: 1_000,
        speedMmPerSecond: 20_000,
        delaySeconds: 0,
        nextOperatingPoint: "station-2",
        status: "running",
        operationMarker: {
          schemaVersion: "zugfolge-livemap-operation-marker/v1",
          kind: "public-operator",
        },
      }],
      externalTrains: [{
        id: "train-2:day-0",
        operator: "public",
        trainNumber: "RB 2",
        category: "regional",
        journeyChainId: "train-2",
        externalLegId: "external-1",
        fromPortalId: "portal-1",
        toPortalId: null,
        scheduledEndS: 86_400,
        reentryEarliestS: null,
        reentryLatestS: null,
        delaySeconds: 0,
        status: "completed-outside",
        progressBasisPoints: 10_000,
      }],
    }, ["train-1", "train-2"]);

    expect(result).toEqual({ livemapReady: false, runningTrainRunIds: [] });
  });
});
