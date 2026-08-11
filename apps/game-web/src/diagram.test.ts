import { describe, expect, it } from "vitest";

import {
  PLANNING_PROJECTION_SCHEMA_VERSION,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";

import {
  conflictLabels,
  conflictsForTrain,
  formatDurationS,
  formatTimeS,
  pathPoints,
  phaseLabels,
  stationY,
  timeExtentS,
} from "./diagram.js";

function projection(): PlanningProjectionV1 {
  const resource = { id: "block", kind: "block" as const, label: "Block A–B" };
  return {
    schemaVersion: PLANNING_PROJECTION_SCHEMA_VERSION,
    projectionRevision: 1,
    worldId: "world-1",
    corridor: { id: "ab", name: "A–B" },
    stations: [
      { id: "a", name: "A", distanceMm: 0 },
      { id: "b", name: "B", distanceMm: 10_000_000 },
    ],
    trains: [
      {
        id: "t1",
        number: "R 1",
        direction: "with-chainage",
        calls: [
          { stationId: "a", timeS: 25_800 },
          { stationId: "b", timeS: 26_400 },
        ],
      },
      {
        id: "t2",
        number: "R 2",
        direction: "against-chainage",
        calls: [
          { stationId: "b", timeS: 25_900 },
          { stationId: "a", timeS: 26_500 },
        ],
      },
    ],
    occupations: [],
    conflicts: [
      {
        id: "c1",
        kind: "opposing-move",
        resource,
        window: { startS: 26_000, endS: 26_100 },
        trainIds: ["t1", "t2"],
        explanation: "Gegenfahrt auf demselben Block.",
        alternative: null,
      },
    ],
  };
}

describe("Bildfahrplan-Projektionsadapter", () => {
  it("skaliert ausschliesslich aus Sekunden und ganzzahligen Millimetern", () => {
    const data = projection();
    expect(stationY(data, "a")).toBeLessThan(stationY(data, "b"));
    expect(pathPoints(data, data.trains[0]!).split(" ")).toHaveLength(2);
    expect(timeExtentS(data)).toEqual([25_500, 27_000]);
  });

  it("formatiert Anzeigezeiten, ohne den Fachwert in Minuten umzuschreiben", () => {
    expect(formatTimeS(25_800)).toBe("07:10:00");
    expect(formatDurationS(125)).toBe("2:05 min");
    expect(() => stationY(projection(), "nirgendwo")).toThrow("Unbekannte Betriebsstelle");
  });

  it("kennt alle sechs fachlichen Phasen einschliesslich Signalsicht und alle Konfliktarten", () => {
    expect(Object.keys(phaseLabels)).toEqual([
      "route-setting",
      "signal-sighting",
      "approach",
      "running",
      "clearing",
      "route-release",
    ]);
    expect(Object.keys(conflictLabels)).toEqual([
      "headway",
      "opposing-move",
      "route-exclusion",
      "facility-contention",
    ]);
  });

  it("ordnet Konflikte ausschliesslich den zwei beteiligten Zugfahrten zu", () => {
    expect(conflictsForTrain(projection(), "t1").map((conflict) => conflict.id)).toEqual(["c1"]);
    expect(conflictsForTrain(projection(), "unbeteiligt")).toEqual([]);
  });

  it("liefert fuer eine leere Projektion einen stabilen Darstellungsbereich", () => {
    const empty = { ...projection(), stations: [], trains: [], conflicts: [] };
    expect(timeExtentS(empty)).toEqual([0, 3_600]);
  });
});
