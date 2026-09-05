import { describe, expect, it } from "vitest";

import { buildRegionalServicePlanning, type RegionalServicePlanningInput } from "./regional-planning.js";
import { validateGtfsPlanningEnvelope } from "./planning.js";

function input(): RegionalServicePlanningInput {
  return {
    worldId: "world-1", revision: 1, producedAt: 0,
    source: { sourceId: "reference", feedUrl: "https://example.test/reference.zip", archiveSha256: "a".repeat(64), capturedAt: "2026-08-10T00:00:00Z", timeZone: "Europe/Berlin", sourceLicense: "fixture", attribution: "Fixture" },
    sourceTimetableHash: "b".repeat(64), infrastructureVersion: "infra-1", rulesVersion: "game-planning-1", serviceDate: "20260810", smallLotMaximumTrainKmPerDay: 1_000,
    timetableGeneration: { seed: "42", specification: { schemaVersion: "zugfolge-game-timetable-generation/v1", version: "game-timetable/v1", departureGridSeconds: 60, minimumRunningSeconds: 1 } },
    lines: [{
      peakVehicles: 1,
      policy: { lineId: "line-1", energyWhPerTrainKm: 10_000, facilityMinutesPerVehicleDay: 60, minimumTurnaroundSeconds: 300, overnightBasisPoints: 10_000, requiredProtection: ["pzb"], requirements: { minimumSeats: 100, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2, requiredEquipment: [] } },
      journeys: [3_600, 7_200].map((departureS, index) => ({
        id: `game-trip-${index}`, directionId: "0", sourceRouteId: "reference-route", routeLengthMm: 10_000_000, edgeIds: ["edge-a", "edge-b"],
        presentation: { designation: "RB 1", origin: "A", destination: "B" },
        stops: [{ stopId: "a", name: "A", arrivalS: departureS, departureS }, { stopId: "b", name: "B", arrivalS: departureS + 600, departureS: departureS + 600 }],
      })),
    }],
  };
}

describe("Angebotsplanung aus dem regionalen Spiel-Fahrplan", () => {
  it("erhaelt die erzeugten Fahrten und leitet Losmengen aus Infrastruktur und geprueftem Umlauf ab", () => {
    const result = buildRegionalServicePlanning(input());
    expect(validateGtfsPlanningEnvelope(result)).toBe(result);
    expect(result.snapshot.sourceTimetableHash).toBe("b".repeat(64));
    expect(result.snapshot.patterns[0]?.journeys.map((journey) => journey.id)).toEqual(["game-trip-0", "game-trip-1"]);
    expect(result.snapshot.patterns[0]?.metrics.medianHeadwaySeconds).toBe(3_600);
    expect(result.snapshot.patterns[0]?.presentation).toEqual({ designation: "RB 1", origin: "A", destination: "B" });
    expect(result.snapshot.lots[0]?.specificationBasis).toMatchObject({ totalTrainMeters: "20000", totalStops: "4", totalServiceSeconds: "1200", totalEnergyWh: "200000", peakVehicles: 1, facilityMinutesPerDay: 60 });
    const reversed = input();
    expect(buildRegionalServicePlanning({ ...reversed, lines: reversed.lines.map((line) => ({ ...line, journeys: [...line.journeys].reverse() })) })).toEqual(result);
  });

  it("lehnt fehlende Binnenhalte, ungueltige Laufwege und doppelte Spiel-Fahrten ab", () => {
    const original = input();
    const line = original.lines[0]!;
    const journey = line.journeys[0]!;
    for (const changed of [
      { ...journey, stops: journey.stops.slice(0, 1) },
      { ...journey, routeLengthMm: 0 },
      { ...journey, edgeIds: [] },
      { ...journey, stops: journey.stops.map((stop) => ({ ...stop, arrivalS: 0, departureS: 0 })) },
    ]) expect(() => buildRegionalServicePlanning({ ...original, lines: [{ ...line, journeys: [changed] }] })).toThrow();
    expect(() => buildRegionalServicePlanning({ ...original, lines: [{ ...line, journeys: [journey, journey] }] })).toThrow(/doppelt/u);
  });
});
