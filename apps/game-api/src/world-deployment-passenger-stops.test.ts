import type { OperationalTrainInitialization } from "@zugfolge/runtime-native";
import { describe, expect, it } from "vitest";
import { instantiateOperationalPassengerStopPlan } from "./world-deployment-runtime.js";

function train(): OperationalTrainInitialization {
  return {
    id: "train:1", trainNumber: "RE 1", operatorId: "operator:1", movementKind: "train",
    routeVersionId: "route:1", formationVersionId: "formation:1", headRouteMm: 10_000,
    scheduledDepartureMs: 1_000, publicPassengerStop: true, dispatchInterlockingRouteId: "locking:1",
    protectionModeSelectionRuns: [{ throughRouteLegIndex: 1, selectedProtectionSystem: "pzb" }],
    stopPlan: {
      schemaVersion: "zugfolge-operational-passenger-stop-plan/v1", worldId: "world:1",
      infrastructureReleaseId: "infra:1", timetableReleaseId: "timetable:1", serviceId: "service:1",
      serviceRunId: "service:1:service-day:2026-09-05", trainRunId: "train:1", routeVersionId: "route:1",
      sourceBindingHash: "a".repeat(64), stops: [
        { stopId: "train:1:0", stationId: "a", stopSequence: 0, routeMm: 10_000, platformId: "platform:a", scheduledArrivalMs: 0, scheduledDepartureMs: 1_000, minimumDwellMs: 1_000 },
        { stopId: "train:1:1", stationId: "b", stopSequence: 1, routeMm: 40_000, platformId: "platform:b", scheduledArrivalMs: 20_000, scheduledDepartureMs: 25_000, minimumDwellMs: 5_000 },
        { stopId: "train:1:2", stationId: "c", stopSequence: 2, routeMm: 100_000, platformId: "platform:c", scheduledArrivalMs: 90_000_000, scheduledDepartureMs: 90_000_000, minimumDwellMs: 0 },
      ],
    },
  };
}

describe("Tagesinstanz eines signierten Fahrgasthaltplans", () => {
  it("verschiebt nur gebundene Fahrtkennungen und Sollzeiten, auch nach Mitternacht", () => {
    const original = train();
    const before = structuredClone(original);
    const first = instantiateOperationalPassengerStopPlan(original, 0, 86_400_000);
    expect(first).toEqual(original.stopPlan);
    const next = instantiateOperationalPassengerStopPlan(original, 1, 86_400_000, "service:1:service-day:2026-09-06");
    expect(next).toMatchObject({ trainRunId: "train:1:day-1", serviceId: "service:1",
      serviceRunId: "service:1:service-day:2026-09-06", worldId: "world:1", routeVersionId: "route:1",
      infrastructureReleaseId: "infra:1", timetableReleaseId: "timetable:1", sourceBindingHash: "a".repeat(64) });
    expect(next.stops.map((stop) => [stop.stopId, stop.scheduledArrivalMs, stop.scheduledDepartureMs, stop.minimumDwellMs]))
      .toEqual([["train:1:day-1:0", 86_400_000, 86_401_000, 1_000], ["train:1:day-1:1", 86_420_000, 86_425_000, 5_000], ["train:1:day-1:2", 176_400_000, 176_400_000, 0]]);
    expect(next.stops.map(({ stationId, routeMm, platformId }) => [stationId, routeMm, platformId]))
      .toEqual(first.stops.map(({ stationId, routeMm, platformId }) => [stationId, routeMm, platformId]));
    expect(original).toEqual(before);
    expect(JSON.stringify(next)).not.toMatch(/actualArrivalMs|actualDepartureMs/u);
    expect(instantiateOperationalPassengerStopPlan(original, 1, 86_400_000, next.serviceRunId)).toEqual(next);
  });

  it("verweigert fremde Fahrtbindung und unsichere Zeitverschiebungen", () => {
    const original = train();
    expect(() => instantiateOperationalPassengerStopPlan({ ...original, id: "other" }, 1, 86_400_000)).toThrow(/gebundenen Haltplan/u);
    for (const day of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => instantiateOperationalPassengerStopPlan(original, day, 86_400_000)).toThrow(RangeError);
    }
    const overflow = { ...original, stopPlan: { ...original.stopPlan!, stops: original.stopPlan!.stops.map((stop) => ({ ...stop, scheduledDepartureMs: Number.MAX_SAFE_INTEGER })) } };
    expect(() => instantiateOperationalPassengerStopPlan(overflow, 1, 86_400_000)).toThrow(/Zeitbereichs/u);
  });
});
