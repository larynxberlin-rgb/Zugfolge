import { describe, expect, it } from "vitest";

import {
  BLOCKING_PHASES,
  CONFLICT_KINDS,
  PLANNING_ALTERNATIVE_COMMAND_SCHEMA_VERSION,
  PLANNING_PROJECTION_SCHEMA_VERSION,
  createPlanningAlternativeCommand,
  isPlanningProjection,
  parsePlanningAlternativeCommand,
  parsePlanningProjection,
  parsePlanningProjectionEnvelope,
  type PlanningProjectionV1,
} from "./index.js";

function projection(): PlanningProjectionV1 {
  const resource = { id: "block-1", kind: "block" as const, label: "Block A–B" };
  const conflictKinds = [...CONFLICT_KINDS];
  return {
    schemaVersion: PLANNING_PROJECTION_SCHEMA_VERSION,
    projectionRevision: 7,
    worldId: "world-1",
    corridor: { id: "lhe", name: "Leipzig–Halle–Erfurt" },
    stations: [
      { id: "a", name: "A", distanceMm: 0 },
      { id: "b", name: "B", distanceMm: 12_500_000 },
    ],
    trains: [
      {
        id: "train-a",
        number: "R 100",
        direction: "with-chainage",
        calls: [
          { stationId: "a", timeS: 1_800_000_000 },
          { stationId: "b", timeS: 1_800_000_600 },
        ],
      },
      {
        id: "train-b",
        number: "R 101",
        direction: "against-chainage",
        calls: [
          { stationId: "b", timeS: 1_800_000_100 },
          { stationId: "a", timeS: 1_800_000_700 },
        ],
      },
    ],
    occupations: BLOCKING_PHASES.map((phase, index) => ({
      trainId: "train-a",
      resource,
      governingStationId: index < 3 ? "a" : "b",
      phase,
      startS: 1_800_000_000 + index * 20,
      endS: 1_800_000_020 + index * 20,
      startDistanceMm: index < 3 ? 0 : 12_500_000,
      endDistanceMm: index < 3 ? 0 : 12_500_000,
    })),
    conflicts: conflictKinds.map((kind, index) => ({
      id: `conflict-${index}`,
      kind,
      resource,
      window: { startS: 1_800_000_040 + index, endS: 1_800_000_060 + index },
      trainIds: ["train-a", "train-b"],
      explanation: `Erklärung ${kind}`,
      alternative: {
        alternativeId: `alternative-${index}`,
        trainId: "train-a",
        departureShiftS: 120 + index,
        explanation: "Die angebotene Lage ist konfliktfrei.",
      },
    })),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("PlanningProjection v1", () => {
  it("akzeptiert alle sechs Sperrzeitanteile und alle vier Konfliktarten", () => {
    const parsed = parsePlanningProjection(projection());
    expect(parsed.occupations.map((occupation) => occupation.phase)).toEqual(BLOCKING_PHASES);
    expect(parsed.conflicts.map((conflict) => conflict.kind)).toEqual(CONFLICT_KINDS);
    expect(parsePlanningProjectionEnvelope({ sequence: 99, data: parsed }).data).toEqual(parsed);
  });

  it("akzeptiert eine echte leere Projektion ohne implizite Beispieldaten", () => {
    const empty = { ...projection(), stations: [], trains: [], occupations: [], conflicts: [] };
    expect(parsePlanningProjection(empty)).toMatchObject({ stations: [], trains: [] });
  });

  it("verwirft Minutenfelder, Floats, den alten Puffer und unbekannte Zusatzfelder", () => {
    const withMinutes = clone(projection()) as unknown as Record<string, unknown>;
    const trains = withMinutes["trains"] as Record<string, unknown>[];
    const calls = trains[0]!["calls"] as Record<string, unknown>[];
    calls[0] = { stationId: "a", minute: 30 };
    expect(() => parsePlanningProjection(withMinutes)).toThrow(/timeS/);

    const withFloat = clone(projection());
    (withFloat.stations[0] as { distanceMm: number }).distanceMm = 0.5;
    expect(isPlanningProjection(withFloat)).toBe(false);

    const withBuffer = clone(projection());
    (withBuffer.occupations[0] as { phase: string }).phase = "buffer";
    expect(() => parsePlanningProjection(withBuffer)).toThrow(/route-setting.*signal-sighting/);

    expect(() => parsePlanningProjection({ ...projection(), debug: true })).toThrow(/genau die Felder/);
  });

  it("verwirft gebrochene Referenzen zwischen Betriebsstellen, Zügen und Alternativen", () => {
    const invalid = clone(projection());
    (invalid.conflicts[0]!.alternative as { trainId: string }).trainId = "unbekannt";
    expect(() => parsePlanningProjection(invalid)).toThrow(/beteiligte Zugfahrt/);
  });
});

describe("PlanningAlternativeCommand v1", () => {
  it("ist über Wiederholungen stabil und enthält keine clientseitig wählbare Lage", () => {
    const first = createPlanningAlternativeCommand(7, "alternative-1");
    const retry = createPlanningAlternativeCommand(7, "alternative-1");
    expect(first).toEqual(retry);
    expect(first).toEqual({
      schemaVersion: PLANNING_ALTERNATIVE_COMMAND_SCHEMA_VERSION,
      projectionRevision: 7,
      alternativeId: "alternative-1",
      idempotencyKey: "alternative:7:alternative-1",
    });
    expect(first).not.toHaveProperty("trainId");
    expect(first).not.toHaveProperty("departureShiftS");
  });

  it("verwirft eine fremde oder pro Retry wechselnde Idempotenzkennung", () => {
    expect(() =>
      parsePlanningAlternativeCommand({
        schemaVersion: PLANNING_ALTERNATIVE_COMMAND_SCHEMA_VERSION,
        projectionRevision: 7,
        alternativeId: "alternative-1",
        idempotencyKey: "zufall",
      }),
    ).toThrow(/deterministischer Wert/);
  });
});
