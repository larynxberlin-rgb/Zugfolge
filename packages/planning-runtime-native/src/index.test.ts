import { describe, expect, it } from "vitest";

import {
  PLANNING_APPLY_ALTERNATIVE_SCHEMA,
  PLANNING_COORDINATE_SCHEMA,
  PLANNING_COORDINATE_SCHEMA_V1,
  planningRuntimeFromAddon,
  type PlanningCoordinateCommand,
  type PlanningRuntimeState,
} from "./index.js";

const input = {
  schemaVersion: PLANNING_COORDINATE_SCHEMA,
  worldId: "11111111-1111-4111-8111-111111111111",
  runId: "run-1",
  expectedProjectionRevision: null,
  seedWorld: "1",
  seedPeriod: 1,
  sourceId: "infra-release-lhe-2026",
  corridorId: "corridor",
  corridorName: "Korridor",
  stations: [],
  segments: [],
  requests: [{ requestNumericId: 1, trainId: "train-1", trainCategory: "regional", trainNumber: 26802,
    originStationId: "a", destinationStationId: "b", desiredDepartureS: 100, operatingDays: "daily", stops: [],
    earlierS: 0, laterS: 0, stepS: 1, extraRunningTimeS: 0, maxOperationalStops: 0,
    train: { numericId: 1, name: "Test", massKg: 1000, lengthMm: 1000, maximumSpeedMmps: 10000, accelerationMmPerS2: 100, decelerationMmPerS2: 100 } }],
} satisfies PlanningCoordinateCommand;

function result(worldId: string, revision = 1): string {
  const projection = {
    schemaVersion: "planning-projection/v1",
    projectionRevision: revision,
    worldId,
    corridor: { id: "corridor", name: "Korridor" },
    stations: [],
    trains: [],
    occupations: [],
    conflicts: [],
  };
  return JSON.stringify({
    schemaVersion: "zugfolge-planning-runtime-result/v1",
    state: {
      schemaVersion: "zugfolge-planning-runtime-state/v1",
      worldId,
      projectionRevision: revision,
      projection,
      alternatives: {},
      processedCommands: {},
    },
    stateHash: "a".repeat(64),
    projection,
    idempotentReplay: false,
  });
}

describe("native M3 ABI boundary", () => {
  it("rejects foreign baselines, invalid validity and unbound replacements before entering Rust", () => {
    let calls = 0;
    const runtime = planningRuntimeFromAddon({ coordinatePlanningRun: () => { calls += 1; return result(input.worldId); },
      applyPlanningAlternative: () => result(input.worldId, 2) });
    const previousState = JSON.parse(result("foreign")).state as PlanningRuntimeState;
    expect(() => runtime.coordinate({ ...input, expectedProjectionRevision: 1, previousState })).toThrow(/Welt-/);
    expect(() => runtime.coordinate({ ...input, replaceTrainIds: ["train-1"], effectiveFromS: 0 })).toThrow(/Ausgangszustand/);
    expect(() => runtime.coordinate({ ...input, requests: [{ ...input.requests[0]!, serviceWindow: { validFromS: 0, validUntilS: 100 } }] })).toThrow(/serviceWindow/);
    expect(() => runtime.coordinate({ ...input, requests: [] })).toThrow(/1 bis 256/);
    expect(calls).toBe(0);
  });
  it("transports v2 mm/s exactly and keeps the v1 KPH path explicit", () => {
    const seen: unknown[] = [];
    const runtime = planningRuntimeFromAddon({
      coordinatePlanningRun: (json) => {
        seen.push(JSON.parse(json));
        return result(input.worldId);
      },
      applyPlanningAlternative: () => result(input.worldId, 2),
    });
    const requestFacts = {
      requestNumericId: 1,
      trainId: "train-1",
      trainCategory: "regional" as const,
      trainNumber: 26_802,
      originStationId: "a",
      destinationStationId: "b",
      desiredDepartureS: 1,
      operatingDays: "daily" as const,
      stops: [],
      earlierS: 0,
      laterS: 0,
      stepS: 1,
      extraRunningTimeS: 0,
      maxOperationalStops: 0,
    };
    runtime.coordinate({
      ...input,
      requests: [{
        ...requestFacts,
        train: {
          numericId: 1,
          name: "Exakt",
          massKg: 1,
          lengthMm: 1,
          maximumSpeedMmps: 27_777,
          accelerationMmPerS2: 1,
          decelerationMmPerS2: 1,
        },
      }],
    });
    runtime.coordinate({
      ...input,
      schemaVersion: PLANNING_COORDINATE_SCHEMA_V1,
      requests: [{
        ...requestFacts,
        train: {
          numericId: 1,
          name: "Legacy",
          massKg: 1,
          lengthMm: 1,
          maximumSpeedKph: 100,
          accelerationMmPerS2: 1,
          decelerationMmPerS2: 1,
        },
      }],
    });

    expect((seen[0] as any).requests[0].train).toMatchObject({ maximumSpeedMmps: 27_777 });
    expect((seen[1] as any).requests[0].train).toMatchObject({ maximumSpeedKph: 100 });
  });

  it("rejects missing or legacy speed fields in a new v2 coordinate", () => {
    let called = false;
    const runtime = planningRuntimeFromAddon({
      coordinatePlanningRun: () => {
        called = true;
        return result(input.worldId);
      },
      applyPlanningAlternative: () => result(input.worldId, 2),
    });
    const base = {
      ...input,
      requests: [{
        requestNumericId: 1,
        trainId: "train-1",
        trainCategory: "regional",
        trainNumber: 26_802,
        originStationId: "a",
        destinationStationId: "b",
        desiredDepartureS: 1,
        operatingDays: "daily",
        stops: [],
        earlierS: 0,
        laterS: 0,
        stepS: 1,
        extraRunningTimeS: 0,
        maxOperationalStops: 0,
        train: {
          numericId: 1,
          name: "Fehlt",
          massKg: 1,
          lengthMm: 1,
          accelerationMmPerS2: 1,
          decelerationMmPerS2: 1,
        },
      }],
    };
    expect(() => runtime.coordinate(base as unknown as PlanningCoordinateCommand)).toThrow(/Pflichtfelder/);
    (base.requests[0]!.train as Record<string, unknown>)["maximumSpeedKph"] = 100;
    expect(() => runtime.coordinate(base as unknown as PlanningCoordinateCommand)).toThrow(/Pflichtfelder|unbekannte/);
    expect(called).toBe(false);
  });

  it("rejects a cross-world Rust result", () => {
    const runtime = planningRuntimeFromAddon({
      coordinatePlanningRun: () => result("other-world"),
      applyPlanningAlternative: () => result("other-world", 2),
    });
    expect(() => runtime.coordinate(input)).toThrow(/Weltisolation/);
  });

  it("rejects a non-monotone projection revision", () => {
    const runtime = planningRuntimeFromAddon({
      coordinatePlanningRun: () => result(input.worldId, 2),
      applyPlanningAlternative: () => result(input.worldId, 2),
    });
    expect(() => runtime.coordinate(input)).toThrow(/monotone Fachrevision/);
  });

  it("preserves a domain error returned by the real napi-rs ABI", () => {
    const domainError = new Error("alternative_mismatch: payload differs from the offered alternative");
    const runtime = planningRuntimeFromAddon({
      coordinatePlanningRun: () => result(input.worldId),
      applyPlanningAlternative: () => domainError,
    });
    const state = JSON.parse(result(input.worldId)) as { state: PlanningRuntimeState };

    expect(() => runtime.applyAlternative(state.state, "command-1", {
      schemaVersion: PLANNING_APPLY_ALTERNATIVE_SCHEMA,
      projectionRevision: 1,
      alternativeId: "alternative-1",
      conflictId: "conflict-1",
      trainId: "train-1",
      departureShiftS: 60,
    })).toThrow(domainError);
  });

  it("rejects any native ABI result that is neither JSON nor an Error", () => {
    const runtime = planningRuntimeFromAddon({
      coordinatePlanningRun: () => ({ unexpected: true }),
      applyPlanningAlternative: () => result(input.worldId, 2),
    });

    expect(() => runtime.coordinate(input)).toThrow(/weder JSON noch einen JavaScript-Fehler/);
  });
});
