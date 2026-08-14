import { describe, expect, it } from "vitest";

import {
  publicOperationSnapshotVerification,
  validateDeploymentWorldDefinition,
} from "./alpha-world-start.js";

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

describe("Eigenbetriebsverifikation nach einem Prozessneustart", () => {
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
