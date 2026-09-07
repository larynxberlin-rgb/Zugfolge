import assert from "node:assert/strict";
import { test } from "node:test";
import { passengerOutcomeBinding, serviceOutcomePolicy } from "./build-alpha-world.mjs";
import { serviceDayPolicy } from "./service-day-policy-v1.mjs";

test("Sollankunft nach Mitternacht bleibt im begonnenen Verkehrstag; unbelegte Zusagen bleiben unbekannt", () => {
  const binding = passengerOutcomeBinding({ trainRunId: "RE-1", lotId: "lot-1", epoch: "2026-08-10T00:00:00.000Z", scheduledDepartureMs: 86_100_000, departureS: 86_100, arrivalS: 87_000 });
  assert.equal(binding.scheduledArrivalMs, 87_000_000);
  assert.equal(binding.serviceDay, "2026-08-10");
  assert.equal(binding.serviceRunId, "RE-1:service-day:2026-08-10");
  assert.equal(binding.requiredSeats, null);
  assert.equal(binding.connectionAssessment, "unavailable");
  assert.equal(passengerOutcomeBinding({ trainRunId: "RE-2", lotId: "lot-1", epoch: "2026-08-10T00:00:00.000Z", scheduledDepartureMs: 900_000, departureS: 87_300, arrivalS: 88_000 }).scheduledArrivalMs, 1_600_000);
  assert.throws(() => passengerOutcomeBinding({ trainRunId: "RE-1", lotId: "lot-1", epoch: "2026-08-10T00:00:00.000Z", scheduledDepartureMs: 1000, departureS: 1, arrivalS: 0 }), /Sollzeit/);
});

test("vollständiger Tagesplan übernimmt ursprüngliche Umlaufgrenzen und M5-Kosten", () => {
  const train = (id) => ({ id, operatorId: "operator", publicPassengerStop: true, scheduledDepartureMs: 0,
    serviceOutcome: passengerOutcomeBinding({ trainRunId: id, lotId: "lot", epoch: "2026-08-10T00:00:00.000Z", scheduledDepartureMs: 0, departureS: 0, arrivalS: 10 }) });
  const input = { trains: [train("first"), train("second")], movementContinuations: [
    { predecessorTrainId: "first", successorTrainId: "second", successorDayOffset: 1, dailyBoundary: false },
    { predecessorTrainId: "second", successorTrainId: "first", successorDayOffset: 0, dailyBoundary: true }],
    vehicles: [{ id: "asset" }], authorityAssets: [{ id: "asset", passenger: { operatingCostCentsPerTrainKm: 739 } }],
    authorityReleaseHash: "a".repeat(64), economyReleaseHash: "b".repeat(64), epochServiceDay: "2026-08-10", repeatEveryMs: 86400000 };
  const policy = serviceDayPolicy(input);
  assert.deepEqual(policy.services.map(({ trainRunId, firstDayIndex }) => ({ trainRunId, firstDayIndex })), [
    { trainRunId: "first", firstDayIndex: 0 }, { trainRunId: "second", firstDayIndex: 1 }]);
  assert.equal(policy.vehicleCostPolicy.vehicleCosts[0].centsPerTrainKm, 739);
  assert.equal(policy.vehicleCostPolicy.economyReleaseHash, input.economyReleaseHash);
  assert.equal(policy.services[0].binding.requiredSeats, null);
  assert.throws(() => serviceDayPolicy({ ...input, authorityAssets: [] }), /Quellenbindung/);
  assert.throws(() => serviceDayPolicy({ ...input, movementContinuations: input.movementContinuations.slice(0, 1) }), /Quellenbindung/);
  assert.throws(() => serviceDayPolicy({ ...input, epochServiceDay: "2026-08-11" }), /Quellenbindung/);
});

test("Sitzplaetze folgen konkreten Authority-Assets und nicht einer Leistungszusage", () => {
  const input = { serviceIds: ["RE-1"], vehicles: [{ id: "coach" }, { id: "engine" }], authorityAssets: [{ id: "coach", passenger: { seats: 81 } }, { id: "engine", passenger: { seats: 0 } }], authorityReleaseHash: "a".repeat(64) };
  const policy = serviceOutcomePolicy(input);
  assert.deepEqual(policy.vehicleCapacities.map(({ vehicleId, seats }) => ({ vehicleId, seats })), [{ vehicleId: "coach", seats: 81 }, { vehicleId: "engine", seats: 0 }]);
  assert.ok(policy.vehicleCapacities.every(({ sourceReference }) => sourceReference.includes(input.authorityReleaseHash)));
  assert.throws(() => serviceOutcomePolicy({ ...input, serviceIds: ["RE-1", "RE-1"] }), /Basisfahrten/);
  assert.throws(() => serviceOutcomePolicy({ ...input, authorityAssets: [{ id: "coach", passenger: { seats: 81 } }] }), /quellenbindung/);
  assert.throws(() => serviceOutcomePolicy({ ...input, authorityAssets: [{ id: "coach", passenger: {} }, input.authorityAssets[1]] }), /Sitzplatznachweis/);
});
