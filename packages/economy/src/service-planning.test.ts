import { createGtfsPlanningEnvelope, type GtfsPlanningSnapshot } from "@zugfolge/gtfs";
import { describe, expect, it } from "vitest";

import { deriveGtfsServiceSpecification, lotsFromGtfsPlanning } from "./service-planning.js";

const WORLD = "11111111-1111-4111-8111-111111111111";

function envelope() {
  const snapshot: GtfsPlanningSnapshot = {
    schema: "zugfolge-gtfs-planning/v1",
    worldId: WORLD,
    revision: 4,
    producedAt: 1,
    source: { sourceId: "gtfs-de-rv", feedUrl: "https://download.gtfs.de/germany/rv_free/latest.zip", archiveSha256: "a".repeat(64), capturedAt: "2026-08-09T00:00:00.000Z", timeZone: "Europe/Berlin", sourceLicense: "CC BY 4.0", attribution: "DELFI e.V. / GTFS.DE" },
    infrastructureVersion: "graph-v1",
    rulesVersion: "rules-v1",
    serviceDates: ["20260810", "20260811"],
    patterns: [{
      id: "sp-1", lineId: "S1", directionId: "0", sourceRouteIds: ["r1"], stopIds: ["a", "b"], stopNames: ["A", "B"], nodeIds: ["n-a", "n-b"], edgeIds: ["e-ab"], distanceMeters: 10_000,
      journeys: [{ sourceTripId: "t1", serviceDate: "20260810", departureServiceSeconds: 0, arrivalServiceSeconds: 1_800, departureEpochSeconds: 1, arrivalEpochSeconds: 1_801 }],
      metrics: { journeyCount: 1, totalTrainMeters: "10000", totalStops: "2", totalServiceSeconds: "1800", totalEnergyWh: "80000", medianHeadwaySeconds: null, maximumOperatingSpanSeconds: 1_800, peakVehicles: 1 },
    }],
    lots: [{
      id: "lot-1", lineIds: ["S1"], patternIds: ["sp-1"], connectingNodeIds: [], size: 5, attractiveness: 110, smallLot: true,
      specificationBasis: { sampleServiceDays: 2, totalTrainMeters: "10000", totalStops: "2", totalServiceSeconds: "1800", totalEnergyWh: "80000", peakVehicles: 1, facilityMinutesPerDay: 30, overnightUnits: 1, protectionUnits: 1, requirements: { minimumSeats: 120, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2, requiredEquipment: ["pis"] } },
    }],
  };
  return createGtfsPlanningEnvelope(snapshot);
}

describe("GTFS-Planungsgrenze der Wirtschaft", () => {
  it("skaliert ausschließlich die gehashte Losbasis auf die Weltperiode", () => {
    const current = envelope();
    const result = deriveGtfsServiceSpecification(current, WORLD, { planningRevision: 4, snapshotHash: current.snapshotHash, lotId: "lot-1" }, 14 * 86_400);
    expect(result.specification).toMatchObject({
      lines: ["S1"],
      trainKmPerPeriod: 70n,
      stopsPerPeriod: 14n,
      serviceHoursPerPeriod: 4n,
      facilityHoursPerPeriod: 7n,
      energyKwhPerPeriod: 560n,
      vehicleCount: 1n,
      requirements: { minimumSeats: 120, accessible: true },
    });
    expect(result.evidence).toMatchObject({ source: "zugfolge-gtfs-planning/v1", planningRevision: 4, snapshotHash: current.snapshotHash, lotId: "lot-1" });
  });

  it("weist fremde Welten, Revisionen, Hashes und unbekannte Lose ab", () => {
    const current = envelope();
    expect(() => lotsFromGtfsPlanning(current, "other-world")).toThrow(/Weltisolation/);
    expect(() => deriveGtfsServiceSpecification(current, WORLD, { planningRevision: 5, snapshotHash: current.snapshotHash, lotId: "lot-1" }, 14 * 86_400)).toThrow(/revision/);
    expect(() => deriveGtfsServiceSpecification(current, WORLD, { planningRevision: 4, snapshotHash: "0".repeat(64), lotId: "lot-1" }, 14 * 86_400)).toThrow(/hash/);
    expect(() => deriveGtfsServiceSpecification(current, WORLD, { planningRevision: 4, snapshotHash: current.snapshotHash, lotId: "missing" }, 14 * 86_400)).toThrow(/nicht vorhanden/);
  });
});
