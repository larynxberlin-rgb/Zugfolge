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
  type PlanningResultProjection,
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
  const planning: PlanningResultProjection = {
    status: "allocated", requestedDepartureS: 1_799_999_880, plannedDepartureS: 1_800_000_000,
    adjustments: [{ kind: "departure-shift", stationId: "a", requestedS: 1_799_999_880, plannedS: 1_800_000_000, explanation: "Abfahrt angepasst." },
      { kind: "operational-stop", stationId: "b", requestedS: 0, plannedS: 120, explanation: "Zusätzlicher Betriebshalt." },
      { kind: "running-time-extension", stationId: "b", requestedS: 600, plannedS: 720, explanation: "Längere Gesamtfahrt." }],
  };
  function withPlanning(value: unknown) {
    const base = projection();
    return { ...base, trains: base.trains.map((train, index) => index === 0 ? { ...train, planning: value } : train) };
  }

  it("erhält native Wunsch-/Planfakten vollständig und lässt historische Datensätze unverändert", () => {
    expect(parsePlanningProjection(withPlanning(planning)).trains[0]!.planning).toEqual(planning);
    expect(parsePlanningProjection(projection())).toEqual(projection());
    for (const status of ["requested", "rejected"] as const) {
      expect(parsePlanningProjection(withPlanning({ status, requestedDepartureS: 1_799_999_880, plannedDepartureS: null, adjustments: [] })).trains[0]!.planning?.status).toBe(status);
    }
  });

  it("verwirft erfundene Planzeiten, fremde Betriebsstellen und widersprüchliche Änderungsbelege", () => {
    for (const invalid of [null, { ...planning, status: "forecast" }, { ...planning, status: "requested" },
      { ...planning, plannedDepartureS: null }, { ...planning, plannedDepartureS: 1_800_000_001 },
      { ...planning, requestedDepartureS: 1.5 }, { ...planning, adjustments: [] },
      { ...planning, adjustments: [{ ...planning.adjustments[0], stationId: "foreign" }] },
      { ...planning, adjustments: [{ ...planning.adjustments[0], plannedS: 1_800_000_001 }] },
      { ...planning, adjustments: [...planning.adjustments, { kind: "dwell-extension", stationId: "a", requestedS: 180, plannedS: 60, explanation: "Falsch." }] },
      { ...planning, debug: true }]) {
      expect(() => parsePlanningProjection(withPlanning(invalid))).toThrow();
    }
  });

  it("akzeptiert einen Halt-/Fahrzeitvorschlag ohne Abfahrtsverschiebung nur mit vollständigem Beleg", () => {
    const base = projection();
    const proposed = { ...planning, status: "proposed" as const, requestedDepartureS: 1_800_000_000,
      adjustments: planning.adjustments.filter((change) => change.kind !== "departure-shift") };
    const data = { ...base, conflicts: [{ ...base.conflicts[0]!, alternative: { ...base.conflicts[0]!.alternative!, departureShiftS: 0, planning: proposed } }] };
    expect(parsePlanningProjection(data).conflicts[0]!.alternative!.planning).toEqual(proposed);
    for (const invalid of [undefined, { ...proposed, adjustments: [] }, { ...proposed, status: "allocated" }, { ...proposed, plannedDepartureS: 1_800_000_030 }]) {
      const value = { ...data, conflicts: [{ ...data.conflicts[0]!, alternative: { ...data.conflicts[0]!.alternative!, planning: invalid } }] };
      expect(() => parsePlanningProjection(value)).toThrow();
    }
  });

  it("bindet einen zeitgleichen räumlichen Umweg als eigenen belegten Vorschlag", () => {
    const base = projection();
    const proposed = { status: "proposed", requestedDepartureS: 1_800_000_000, plannedDepartureS: 1_800_000_000, adjustments: [],
      routeChange: { additionalDistanceMm: 1_200_000, explanation: "Umweg über ein anderes freigegebenes Gleis." } };
    const withRoute = (result: unknown) => ({ ...base, conflicts: [{ ...base.conflicts[0]!, alternative: { ...base.conflicts[0]!.alternative!, departureShiftS: 0, planning: result } }] });
    expect(parsePlanningProjection(withRoute(proposed)).conflicts[0]!.alternative!.planning).toEqual(proposed);
    for (const distance of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parsePlanningProjection(withRoute({ ...proposed, routeChange: { ...proposed.routeChange, additionalDistanceMm: distance } }))).toThrow();
    }
    expect(() => parsePlanningProjection(withPlanning({ ...proposed, status: "requested", plannedDepartureS: null }))).toThrow();
  });

  const timeline = {
    requested: [
      { stationId: "a", arrivalS: 1_799_999_880, departureS: 1_799_999_880, kind: "origin" as const },
      { stationId: "c", arrivalS: 1_800_000_060, departureS: 1_800_000_120, kind: "passenger-stop" as const },
      { stationId: "b", arrivalS: 1_800_000_360, departureS: 1_800_000_360, kind: "destination" as const },
    ],
    planned: [
      { stationId: "a", arrivalS: 1_800_000_000, departureS: 1_800_000_000, kind: "origin" as const },
      { stationId: "c", arrivalS: 1_800_000_180, departureS: 1_800_000_360, kind: "passenger-stop" as const },
      { stationId: "b", arrivalS: 1_800_000_600, departureS: 1_800_000_600, kind: "destination" as const },
    ],
  };
  const timelineResult: PlanningResultProjection = { ...planning, timeline,
    adjustments: [planning.adjustments[0]!,
      { kind: "dwell-extension", stationId: "c", requestedS: 60, plannedS: 180, explanation: "Aufenthalt für Gegenfahrt verlängert." },
      { kind: "running-time-extension", stationId: "b", requestedS: 480, plannedS: 600, explanation: "Verlängerter Aufenthalt erhöht die Fahrtdauer." }],
  };
  const withTimeline = (value: unknown = timeline) => {
    const base = withPlanning({ ...timelineResult, timeline: value });
    return { ...base, stations: [...base.stations, { id: "c", name: "Mitte", distanceMm: 6_000_000 }] };
  };

  it("erhält beide vollständigen Fahrprofile einschließlich Aufenthalt und absoluten Zeiten", () => {
    expect(parsePlanningProjection(withTimeline()).trains[0]!.planning).toEqual(timelineResult);
    expect(parsePlanningProjection(withPlanning(planning)).trains[0]!.planning).not.toHaveProperty("timeline");
  });

  it("zeigt vor einer Zuteilung nur den belegten ursprünglichen Lauf", () => {
    for (const status of ["requested", "rejected"] as const) {
      const base = withTimeline();
      const pending = { status, requestedDepartureS: planning.requestedDepartureS, plannedDepartureS: null, adjustments: [],
        timeline: { requested: timeline.requested, planned: null } };
      const data = { ...base, trains: base.trains.map((train, index) => index === 0 ? { ...train, planning: pending,
        calls: [{ stationId: "a", timeS: 1_799_999_880 }, { stationId: "b", timeS: 1_800_000_360 }] } : train) };
      expect(parsePlanningProjection(data).trains[0]!.planning?.timeline).toEqual(pending.timeline);
      expect(() => parsePlanningProjection({ ...data, trains: data.trains.map((train, index) => index === 0
        ? { ...train, planning: { ...pending, timeline } } : train) })).toThrow(/Planlauf/);
    }
  });

  it("weist unvollständige, nicht chronologische oder erfundene Vergleichszeiten zurück", () => {
    const planned = timeline.planned;
    for (const invalid of [null, { ...timeline, extra: true }, { ...timeline, planned: null },
      { ...timeline, requested: [] }, { ...timeline, planned: [planned[0]] },
      { ...timeline, planned: Array.from({ length: 513 }, () => planned[0]) },
      { ...timeline, planned: [planned[0], { ...planned[1], stationId: "unknown" }, planned[2]] },
      { ...timeline, planned: [planned[0], { ...planned[1], stationId: "a" }, planned[2]] },
      { ...timeline, planned: [planned[0], { ...planned[1], arrivalS: 1_799_999_999 }, planned[2]] },
      { ...timeline, planned: [planned[0], { ...planned[1], departureS: 1_800_000_179 }, planned[2]] },
      { ...timeline, planned: [planned[0], { ...planned[1], arrivalS: 1.5 }, planned[2]] },
      { ...timeline, planned: [planned[0], { ...planned[1], kind: "pass" }, planned[2]] },
      { ...timeline, planned: [planned[0], { ...planned[1], kind: "operational-stop", departureS: planned[1]!.arrivalS }, planned[2]] },
      { ...timeline, planned: [planned[0], { ...planned[1], kind: "origin" }, planned[2]] },
      { ...timeline, planned: [{ ...planned[0], arrivalS: 1_800_000_001, departureS: 1_800_000_001 }, planned[1], planned[2]] },
      { ...timeline, planned: [planned[0], planned[1], { ...planned[2], stationId: "c" }] },
      { ...timeline, planned: [planned[0], planned[1], { ...planned[2], arrivalS: 1_800_000_700, departureS: 1_800_000_700 }] },
    ]) expect(() => parsePlanningProjection(withTimeline(invalid))).toThrow();
  });

  it("bindet den vollständigen Alternativlauf an seine vorgeschlagene Abfahrt", () => {
    const base = withTimeline();
    const proposed = { ...timelineResult, status: "proposed" as const };
    const data = { ...base, conflicts: [{ ...base.conflicts[0]!, alternative: { ...base.conflicts[0]!.alternative!,
      departureShiftS: 120, planning: proposed } }] };
    expect(parsePlanningProjection(data).conflicts[0]!.alternative!.planning?.timeline).toEqual(timeline);
    expect(() => parsePlanningProjection({ ...data, conflicts: [{ ...data.conflicts[0]!, alternative: { ...data.conflicts[0]!.alternative!,
      planning: { ...proposed, timeline: { ...timeline, planned: timeline.requested } } } }] })).toThrow(/belegten Abfahrt/);
  });

  it("akzeptiert alle sechs Sperrzeitanteile und alle vier Konfliktarten", () => {
    const parsed = parsePlanningProjection(projection());
    expect(parsed.occupations.map((occupation) => occupation.phase)).toEqual(BLOCKING_PHASES);
    expect(parsed.conflicts.map((conflict) => conflict.kind)).toEqual(CONFLICT_KINDS);
    expect(parsePlanningProjectionEnvelope({
      sequence: 99,
      timeBasis: { epoch: "2026-01-01T00:00:00.000Z", timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 },
      data: parsed,
    }).data).toEqual(parsed);
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
