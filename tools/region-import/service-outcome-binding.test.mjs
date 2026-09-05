import assert from "node:assert/strict";
import { test } from "node:test";
import { passengerOutcomeBinding, serviceOutcomePolicy } from "./build-alpha-world.mjs";

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

test("Sitzplaetze folgen konkreten Authority-Assets und nicht einer Leistungszusage", () => {
  const input = { serviceIds: ["RE-1"], vehicles: [{ id: "coach" }, { id: "engine" }], authorityAssets: [{ id: "coach", passenger: { seats: 81 } }, { id: "engine", passenger: { seats: 0 } }], authorityReleaseHash: "a".repeat(64) };
  const policy = serviceOutcomePolicy(input);
  assert.deepEqual(policy.vehicleCapacities.map(({ vehicleId, seats }) => ({ vehicleId, seats })), [{ vehicleId: "coach", seats: 81 }, { vehicleId: "engine", seats: 0 }]);
  assert.ok(policy.vehicleCapacities.every(({ sourceReference }) => sourceReference.includes(input.authorityReleaseHash)));
  assert.throws(() => serviceOutcomePolicy({ ...input, serviceIds: ["RE-1", "RE-1"] }), /Basisfahrten/);
  assert.throws(() => serviceOutcomePolicy({ ...input, authorityAssets: [{ id: "coach", passenger: { seats: 81 } }] }), /quellenbindung/);
  assert.throws(() => serviceOutcomePolicy({ ...input, authorityAssets: [{ id: "coach", passenger: {} }, input.authorityAssets[1]] }), /Sitzplatznachweis/);
});
