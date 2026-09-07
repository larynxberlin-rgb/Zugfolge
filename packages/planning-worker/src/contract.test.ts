import { describe, expect, it } from "vitest";

import {
  bindPlanningPlayerPathRequest,
  bindPlanningPathRequest,
  bindPersistedPlanningPathRequest,
  parsePlanningApplyAlternativePayload,
  PLANNING_PATH_REQUEST_SCHEMA,
  PLANNING_PLAYER_PATH_REQUEST_SCHEMA,
} from "./contract.js";

const player = {
  schemaVersion: PLANNING_PLAYER_PATH_REQUEST_SCHEMA,
  requestId: "route-import", formationId: "formation", trainCategory: "supplementary",
  originStationId: "origin", destinationStationId: "destination", desiredDepartureS: 100,
  operatingDays: "daily", stops: [], earlierS: 0, laterS: 0, stepS: 1,
  extraRunningTimeS: 0, maxOperationalStops: 0,
};

describe("geordnete Fahrwegpunkte im Trassenvertrag", () => {
  it("erhaelt Reihenfolge und getrennte Halte bis zum persistierten Kommando", () => {
    const request = bindPlanningPlayerPathRequest({ ...player,
      viaStationIds: ["second", "first"], stops: [{ stationId: "first", minimumDwellS: 60 }] });
    const authority = { ...request, schemaVersion: PLANNING_PATH_REQUEST_SCHEMA,
      operatorId: "operator", trainId: "train", trainNumber: 90001,
      fleetRevision: 1, fleetStateHash: "a".repeat(64), fleetAuthorityReleaseId: "fleet",
      train: { numericId: 1, name: "Zug", massKg: 10000, lengthMm: 1000,
        maximumSpeedMmps: 10000, accelerationMmPerS2: 100, decelerationMmPerS2: 100 } };
    const bound = bindPlanningPathRequest("world", "account", authority);
    const persisted = bindPersistedPlanningPathRequest("world", "account", JSON.parse(JSON.stringify(authority)));
    expect(persisted).toEqual(bound);
    expect(persisted.viaStationIds).toEqual(["second", "first"]);
    expect(persisted.stops).toEqual([{ stationId: "first", minimumDwellS: 60 }]);
  });

  it.each([null, "point", [""], [" "], [" point"], ["origin"], ["destination"], ["point", "point"],
    Array.from({ length: 511 }, (_, index) => `point-${index}`)])("weist ungueltige Fahrwegpunkte zurueck: %j", (viaStationIds) => {
    expect(() => bindPlanningPlayerPathRequest({ ...player, viaStationIds })).toThrow(/viaStationIds/);
  });

  it("erhaelt den Altvertrag ohne zusaetzliche serialisierte Felder und erlaubt 510 Zwischenpunkte", () => {
    expect(JSON.stringify(bindPlanningPlayerPathRequest(player))).toBe(JSON.stringify(player));
    expect(bindPlanningPlayerPathRequest({ ...player,
      viaStationIds: Array.from({ length: 510 }, (_, index) => `point-${index}`) }).viaStationIds).toHaveLength(510);
    expect(bindPlanningPlayerPathRequest({ ...player, viaStationIds: [] }).viaStationIds).toEqual([]);
  });

  it("erlaubt die native Uebernahme eines Haltangebots ohne Abfahrtsverschiebung", () => {
    const command = { schemaVersion: "planning-apply-alternative/v1", projectionRevision: 1,
      alternativeId: "native-offer", conflictId: "conflict", trainId: "train", departureShiftS: 0 };
    expect(parsePlanningApplyAlternativePayload(command)).toEqual(command);
    expect(() => bindPlanningPlayerPathRequest({ ...player, viaStationIds: ["origin"] })).toThrow(TypeError);
  });
});
