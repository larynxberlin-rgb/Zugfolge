import { describe, expect, it } from "vitest";

import {
  PLANNING_COORDINATE_SCHEMA,
  planningRuntimeFromAddon,
  type PlanningCoordinateCommand,
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
  requests: [],
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
});
