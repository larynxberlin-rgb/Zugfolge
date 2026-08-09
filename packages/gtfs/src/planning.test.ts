import { describe, expect, it } from "vitest";

import {
  buildGtfsPlanningSnapshot,
  createGtfsPlanningEnvelope,
  gtfsServiceSeconds,
  parseGtfsCsv,
  validateGtfsPlanningEnvelope,
  type GtfsPlanningInput,
  type GtfsRow,
} from "./planning.js";

const row = (value: Record<string, string>): GtfsRow => value;

function input(): GtfsPlanningInput {
  return {
    worldId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    producedAt: 1_786_233_600,
    serviceDates: ["20260810"],
    source: {
      sourceId: "gtfs-de-rv",
      feedUrl: "https://download.gtfs.de/germany/rv_free/latest.zip",
      archiveSha256: "a".repeat(64),
      capturedAt: "2026-08-09T00:00:00.000Z",
      timeZone: "Europe/Berlin",
      sourceLicense: "CC BY 4.0",
      attribution: "Datenquelle: DELFI e.V. / GTFS.DE",
    },
    tables: {
      agency: [row({ agency_id: "a", agency_name: "Test" })],
      stops: [
        row({ stop_id: "A", stop_name: "Alpha" }),
        row({ stop_id: "B", stop_name: "Beta" }),
        row({ stop_id: "C", stop_name: "Gamma" }),
      ],
      routes: [
        row({ route_id: "r1", route_short_name: "S1", route_type: "2" }),
        row({ route_id: "r2", route_short_name: "S2", route_type: "2" }),
      ],
      trips: [
        row({ route_id: "r1", service_id: "daily", trip_id: "t1", direction_id: "0" }),
        row({ route_id: "r1", service_id: "daily", trip_id: "t2", direction_id: "1" }),
        row({ route_id: "r2", service_id: "daily", trip_id: "t3", direction_id: "0" }),
      ],
      stopTimes: [
        row({ trip_id: "t1", stop_id: "A", stop_sequence: "1", arrival_time: "23:50:00", departure_time: "23:50:00" }),
        row({ trip_id: "t1", stop_id: "B", stop_sequence: "2", arrival_time: "24:10:00", departure_time: "24:10:00" }),
        row({ trip_id: "t2", stop_id: "B", stop_sequence: "1", arrival_time: "05:00:00", departure_time: "05:00:00" }),
        row({ trip_id: "t2", stop_id: "A", stop_sequence: "2", arrival_time: "05:20:00", departure_time: "05:20:00" }),
        row({ trip_id: "t3", stop_id: "B", stop_sequence: "1", arrival_time: "06:00:00", departure_time: "06:00:00" }),
        row({ trip_id: "t3", stop_id: "C", stop_sequence: "2", arrival_time: "06:15:00", departure_time: "06:15:00" }),
      ],
      calendar: [row({ service_id: "daily", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "1", sunday: "1", start_date: "20260101", end_date: "20261231" })],
      calendarDates: [],
      frequencies: [row({ trip_id: "t3", start_time: "06:00:00", end_time: "07:00:00", headway_secs: "1800", exact_times: "1" })],
    },
    infrastructure: {
      version: "pilot-graph-v1",
      nodes: [{ id: "n-a" }, { id: "n-b" }, { id: "n-c" }],
      edges: [
        { id: "e-ab", fromNodeId: "n-a", toNodeId: "n-b", distanceMeters: 20_000, active: true, bidirectional: true, electrification: "ac" },
        { id: "e-bc", fromNodeId: "n-b", toNodeId: "n-c", distanceMeters: 15_000, active: true, bidirectional: true, electrification: "ac" },
      ],
      stopMappings: [
        { gtfsStopId: "A", nodeId: "n-a" },
        { gtfsStopId: "B", nodeId: "n-b" },
        { gtfsStopId: "C", nodeId: "n-c" },
      ],
      patternMappings: [
        { lineId: "S1", routeId: "r1", directionId: "0", stopIds: ["A", "B"], edgeIds: ["e-ab"] },
        { lineId: "S1", routeId: "r1", directionId: "1", stopIds: ["B", "A"], edgeIds: ["e-ab"] },
        { lineId: "S2", routeId: "r2", directionId: "0", stopIds: ["B", "C"], edgeIds: ["e-bc"] },
      ],
    },
    rules: {
      version: "spnv-pilot-v1",
      maxLinesPerLot: 2,
      smallLotMaximumTrainKmPerDay: 100,
      allowedRouteTypes: ["2"],
      linePolicies: ["S1", "S2"].map((lineId) => ({
        lineId,
        energyWhPerTrainKm: 8_000,
        facilityMinutesPerVehicleDay: 30,
        minimumTurnaroundSeconds: 600,
        overnightBasisPoints: 10_000,
        requiredProtection: ["PZB"],
        requirements: {
          minimumSeats: lineId === "S1" ? 160 : 100,
          firstClassBasisPoints: 0,
          accessible: true,
          bicyclePlaces: 8,
          wheelchairPlaces: 2,
          requiredEquipment: ["passenger-information"],
        },
      })),
    },
  };
}

describe("gemeinsamer GTFS-Kern", () => {
  it("parst Anführungszeichen, CRLF und Servicezeiten über Mitternacht", () => {
    expect(parseGtfsCsv("id,name\r\n1,\"Leipzig, Hbf\"\r\n")).toEqual([{ id: "1", name: "Leipzig, Hbf" }]);
    expect(gtfsServiceSeconds("24:10:00")).toBe(87_000);
  });

  it("erzeugt stabile Patterns und bündelt nur über einen gemeinsamen Knoten", () => {
    const snapshot = buildGtfsPlanningSnapshot(input());
    expect(snapshot.patterns).toHaveLength(3);
    expect(snapshot.patterns.find((pattern) => pattern.lineId === "S2")?.metrics).toMatchObject({ journeyCount: 2, medianHeadwaySeconds: 1_800 });
    expect(snapshot.patterns.find((pattern) => pattern.lineId === "S1" && pattern.directionId === "0")?.journeys[0]).toMatchObject({
      departureServiceSeconds: 85_800,
      arrivalServiceSeconds: 87_000,
    });
    expect(snapshot.lots).toHaveLength(1);
    expect(snapshot.lots[0]).toMatchObject({ lineIds: ["S1", "S2"], connectingNodeIds: ["n-b"], smallLot: true });
    expect(snapshot.lots[0]?.specificationBasis.peakVehicles).toBe(3);
    expect(snapshot.lots[0]?.specificationBasis.requirements.minimumSeats).toBe(160);

    const reordered = input();
    const same = buildGtfsPlanningSnapshot({
      ...reordered,
      tables: { ...reordered.tables, routes: [...reordered.tables.routes].reverse(), trips: [...reordered.tables.trips].reverse(), stopTimes: [...reordered.tables.stopTimes].reverse() },
      infrastructure: { ...reordered.infrastructure, patternMappings: [...reordered.infrastructure.patternMappings].reverse() },
    });
    expect(createGtfsPlanningEnvelope(same).snapshotHash).toBe(createGtfsPlanningEnvelope(snapshot).snapshotHash);
  });

  it("weist unbefahrbare Zuordnungen und manipulierte Snapshots ab", () => {
    const broken = input();
    expect(() => buildGtfsPlanningSnapshot({
      ...broken,
      infrastructure: {
        ...broken.infrastructure,
        edges: broken.infrastructure.edges.map((edge) => edge.id === "e-ab" ? { ...edge, active: false } : edge),
      },
    })).toThrow(/nicht befahrbar/);

    const envelope = createGtfsPlanningEnvelope(buildGtfsPlanningSnapshot(input()));
    expect(() => validateGtfsPlanningEnvelope({ ...envelope, snapshot: { ...envelope.snapshot, worldId: "fremd" } })).toThrow(/gehört nicht/);
  });

  it("trennt geografisch unverbundene Linien deterministisch", () => {
    const isolated = input();
    const changed = buildGtfsPlanningSnapshot({
      ...isolated,
      tables: {
        ...isolated.tables,
        stops: [...isolated.tables.stops, row({ stop_id: "D", stop_name: "Delta" })],
        stopTimes: isolated.tables.stopTimes.map((stopTime) => stopTime["trip_id"] === "t3" && stopTime["stop_id"] === "B" ? row({ ...stopTime, stop_id: "D" }) : stopTime),
      },
      infrastructure: {
        ...isolated.infrastructure,
        nodes: [...isolated.infrastructure.nodes, { id: "n-d" }],
        edges: isolated.infrastructure.edges.map((edge) => edge.id === "e-bc" ? { ...edge, fromNodeId: "n-d" } : edge),
        stopMappings: [...isolated.infrastructure.stopMappings, { gtfsStopId: "D", nodeId: "n-d" }],
        patternMappings: isolated.infrastructure.patternMappings.map((mapping) => mapping.lineId === "S2" ? { ...mapping, stopIds: ["D", "C"] } : mapping),
      },
    });
    expect(changed.lots).toHaveLength(2);
    expect(changed.lots.every((lot) => lot.lineIds.length === 1)).toBe(true);
  });

  it("ordnet einen explizit konfigurierten Korridor innerhalb einer längeren GTFS-Fahrt zu", () => {
    const corridor = input();
    const snapshot = buildGtfsPlanningSnapshot({
      ...corridor,
      tables: {
        ...corridor.tables,
        stops: [row({ stop_id: "X", stop_name: "Vorstadt" }), ...corridor.tables.stops],
        stopTimes: [
          row({ trip_id: "t1", stop_id: "X", stop_sequence: "0", arrival_time: "23:40:00", departure_time: "23:40:00" }),
          ...corridor.tables.stopTimes,
        ],
      },
    });
    const journey = snapshot.patterns.find((pattern) => pattern.lineId === "S1" && pattern.directionId === "0")?.journeys[0];
    expect(journey).toMatchObject({ departureServiceSeconds: 85_800, arrivalServiceSeconds: 87_000 });
  });
});
