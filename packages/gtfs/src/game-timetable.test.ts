import { describe, expect, it } from "vitest";
import { compileGameTimetable, generateGameDepartures, type GameTimetableInput, type GameTimetableTripInput } from "./game-timetable.js";

function trip(sourceTripId: string, stopIds: readonly string[], departure = 21_600): GameTimetableTripInput {
  return {
    sourceTripId, serviceId: "daily", routeId: "gtfs-r1", routeShortName: "RB1", headsign: "Außenziel", directionId: "0",
    stops: stopIds.map((stopId, index) => ({ stopId, stopName: `Bahnhof ${stopId}`, inRegion: !stopId.startsWith("X"), stopSequence: index + 1, arrivalS: departure + index * 600, departureS: departure + index * 600 + (index > 0 && index < stopIds.length - 1 ? 60 : 0) })),
  };
}

function input(trips: readonly GameTimetableTripInput[]): GameTimetableInput {
  return { worldId: "world", regionId: "region", releaseId: "reference-release", serviceDate: "20260810", seed: "42", specification: { version: "game-timetable/v1", departureGridSeconds: 60, minimumRunningSeconds: 1 }, trips };
}

describe("spielgenerierter Binnenfahrplan", () => {
  it("kürzt außen–innen–außen am tatsächlichen Endhalt ohne Portale oder Außenbindungen", () => {
    const result = compileGameTimetable(input([trip("real-1", ["X0", "A", "B", "X1"])]));
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]).toMatchObject({ generation: "game-timetable/v1", orderable: true, headsign: "Bahnhof B", sourceTripIds: ["real-1"], sourceRouteIds: ["gtfs-r1"] });
    expect(result.chains[0]!.journeyChainId).toMatch(/^game-trip-/);
    expect(result.chains[0]!.routeId).toMatch(/^game-line-/);
    expect(result.chains[0]!.legs).toHaveLength(1);
    expect(result.chains[0]!.legs[0]).toMatchObject({ kind: "playable", entryPortalId: null, exitPortalId: null, planningWindows: [], orderable: true });
    expect(result.lines[0]!.stopIds).toEqual(["A", "B"]);
  });

  it("verwirft reine Außenfahrten und isolierte Einzelhalte", () => {
    const result = compileGameTimetable(input([trip("outside", ["X0", "X1"]), trip("single", ["X0", "A", "X1"])]));
    expect(result.chains).toEqual([]);
    expect(result.metrics).toMatchObject({ excludedOutsideTripCount: 1, discardedSingleStopSectionCount: 1 });
  });

  it("bildet bei Wiedereintritt getrennte Linien ohne Fahrt durch die Außenlücke", () => {
    const result = compileGameTimetable(input([trip("real-1", ["A", "B", "X1", "C", "D"])]));
    expect(result.lines).toHaveLength(2);
    expect(result.lines.map((line) => line.stopIds).sort()).toEqual([["A", "B"], ["C", "D"]]);
    expect(new Set(result.chains.map((chain) => chain.journeyChainId)).size).toBe(2);
    expect(result.chains.every((chain) => chain.legs.length === 1)).toBe(true);
  });

  it("trennt auch innere Halte, wenn ihr belegter Infrastrukturpfad das Spielgebiet verlässt", () => {
    const reference = trip("real-1", ["A", "B", "C", "D"]);
    const result = compileGameTimetable(input([{ ...reference, stops: reference.stops.map((stop) => ({ ...stop, pathToNextInRegion: stop.stopId !== "B" })) }]));
    expect(result.lines.map((line) => line.stopIds).sort()).toEqual([["A", "B"], ["C", "D"]]);
  });

  it("generiert einen regelmäßigen Takt und mediane Abschnittszeiten aus unregelmäßigen Referenzen", () => {
    const slow = trip("real-3", ["A", "B", "C"], 27_000);
    const reference = [trip("real-1", ["A", "B", "C"], 21_600), trip("real-2", ["A", "B", "C"], 23_400), { ...slow, stops: slow.stops.map((stop, index) => ({ ...stop, arrivalS: stop.arrivalS + index * 120, departureS: stop.departureS + index * 120 + (index === 1 ? 60 : 0) })) }];
    const result = compileGameTimetable(input(reference));
    expect(result.lines[0]!.reference.medianHeadwayS).toBe(2_700);
    expect(result.lines[0]!.reference.runningSeconds).toEqual([600, 540]);
    expect(result.lines[0]!.reference.dwellSeconds).toEqual([0, 60, 0]);
    const stops = result.chains.map((chain) => chain.legs[0]!.kind === "playable" ? chain.legs[0].stops : []);
    expect(stops[1]![0]!.departureS - stops[0]![0]!.departureS).toBe(2_700);
    expect(stops[2]![0]!.departureS - stops[1]![0]!.departureS).toBe(2_700);
    expect(stops[0]!.at(-1)!.arrivalS - stops[0]![0]!.departureS).toBe(1_200);
    expect(stops.map((times) => times[0]!.departureS)).not.toEqual([21_600, 23_400, 27_000]);
  });

  it("beachtet frequencies und Zeiten über Mitternacht", () => {
    const base = trip("template", ["X0", "A", "B"], 85_800);
    const result = compileGameTimetable(input([{ ...base, frequencies: [{ startS: 85_800, endS: 93_000, headwayS: 1_800 }] }]));
    expect(result.chains).toHaveLength(4);
    expect(result.lines[0]!.reference).toMatchObject({ firstDepartureS: 86_460, lastDepartureS: 91_860, medianHeadwayS: 1_800 });
    expect(result.chains.at(-1)!.legs[0]).toMatchObject({ stops: [expect.objectContaining({ departureS: expect.any(Number) }), expect.objectContaining({ arrivalS: expect.any(Number) })] });
  });

  it("ist deterministisch und bindet Spielidentität nicht an reale trip_id oder Feedrelease", () => {
    const references = [trip("real-1", ["A", "B"]), trip("real-2", ["A", "B"], 25_200)];
    const first = compileGameTimetable(input(references));
    expect(compileGameTimetable(input([...references].reverse()))).toEqual(first);
    const renamed = compileGameTimetable({ ...input(references.map((value, index) => ({ ...value, sourceTripId: `updated-${index}`, routeId: "new-gtfs-id" }))), releaseId: "next-feed" });
    expect(renamed.chains.map((chain) => chain.journeyChainId)).toEqual(first.chains.map((chain) => chain.journeyChainId));
    expect(renamed.lines.map((line) => line.lineId)).toEqual(first.lines.map((line) => line.lineId));
    expect(compileGameTimetable({ ...input(references), seed: "another-seed" }).chains.map((chain) => chain.journeyChainId)).not.toEqual(first.chains.map((chain) => chain.journeyChainId));
  });

  it("weist unbeschränkte Frequenzmengen und unsichere generierte Zeitwerte ab", () => {
    const reference = trip("huge", ["A", "B"]);
    expect(() => compileGameTimetable(input([{ ...reference, frequencies: [{ startS: 0, endS: Number.MAX_SAFE_INTEGER, headwayS: 1 }] }]))).toThrow(/100000/);
    expect(() => generateGameDepartures({ referenceDepartures: [0, 1, 2, 1_000_000], seed: "42", lineId: "line", departureGridSeconds: 1 })).toThrow(/100000/);
    expect(() => generateGameDepartures({ referenceDepartures: [Number.MAX_SAFE_INTEGER], seed: "42", lineId: "line", departureGridSeconds: Number.MAX_SAFE_INTEGER })).toThrow(/sichere Ganzzahl/);
  });

  it("kürzt innere Haltepunkte an beiden Enden auf belegte wendefähige Bahnhöfe", () => {
    const reference = trip("terminal-reference", ["H0", "A", "H1", "B", "H2"]);
    const configured = input([{ ...reference, stops: reference.stops.map((stop) => ({ ...stop, terminalEligibility: { kind: stop.stopId.startsWith("H") ? "halt" as const : "station" as const, canTurn: !stop.stopId.startsWith("H"), evidenceId: `operating-point:${stop.stopId}` } })) }]);
    const result = compileGameTimetable({ ...configured, specification: { ...configured.specification, requireEligibleTerminals: true } });
    expect(result.lines[0]!.stopIds).toEqual(["A", "H1", "B"]);
    expect(result.lines[0]!.adjustment).toMatchObject({ reason: "adapted-to-operational-stations", referenceOriginName: "Bahnhof H0", referenceDestinationName: "Bahnhof H2", originName: "Bahnhof A", destinationName: "Bahnhof B", terminalEvidenceIds: ["operating-point:A", "operating-point:B"] });
    expect(result.adjustments[0]!.reason).toBe("trimmed-to-operational-stations");
  });

  it("erfindet für unbekannte oder nicht wendefähige Bahnhöfe keine Linienenden", () => {
    for (const terminalEligibility of [undefined, { kind: "station" as const, canTurn: false, evidenceId: "known-station" }, { kind: "halt" as const, canTurn: true, evidenceId: "not-a-station" }]) {
      const reference = trip("reference", ["A", "B"]);
      const configured = input([{ ...reference, stops: reference.stops.map((stop) => ({ ...stop, terminalEligibility })) }]);
      const result = compileGameTimetable({ ...configured, specification: { ...configured.specification, requireEligibleTerminals: true } });
      expect(result.chains).toEqual([]);
      expect(result.adjustments[0]!.reason).toBe("no-eligible-terminal-pair");
    }
  });

  it("wählt im Ring das längste Intervall unterschiedlicher Endbahnhöfe und bei Gleichstand den früheren Start", () => {
    const reference = trip("ring", ["A", "B", "C", "A"]);
    const configured = input([{ ...reference, stops: reference.stops.map((stop) => ({ ...stop, terminalEligibility: { kind: "station" as const, canTurn: true, evidenceId: `turnaround:${stop.stopId}` } })) }]);
    const terminalInput = { ...configured, specification: { ...configured.specification, requireEligibleTerminals: true } };
    const result = compileGameTimetable(terminalInput);
    expect(result.lines[0]!.stopIds).toEqual(["A", "B", "C"]);
    expect(result.lines[0]!.adjustment).toMatchObject({ referenceOriginName: "Bahnhof A", referenceDestinationName: "Bahnhof A", originName: "Bahnhof A", destinationName: "Bahnhof C", terminalEvidenceIds: ["turnaround:A", "turnaround:C"] });
    expect(result.adjustments[0]).toMatchObject({ generatedStopIds: ["A", "B", "C"], reason: "trimmed-to-operational-stations" });
    expect(compileGameTimetable({ ...terminalInput, trips: terminalInput.trips.map((value) => ({ ...value, stops: [...value.stops].reverse() })) })).toEqual(result);
    const platformRing = compileGameTimetable({ ...terminalInput, trips: terminalInput.trips.map((value) => ({ ...value, stops: value.stops.map((stop, index) => ({ ...stop, nodeId: stop.stopId, stopId: stop.stopId === "A" ? `A-platform-${index}` : stop.stopId })) })) });
    expect(platformRing.lines[0]!.stopIds).toEqual(["A-platform-0", "B", "C"]);
  });
});
