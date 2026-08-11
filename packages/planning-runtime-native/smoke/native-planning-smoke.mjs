import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

const addonPath = process.env.ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH;
assert.ok(addonPath, "ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH fehlt");
assert.ok(isAbsolute(addonPath), "ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH muss absolut sein");
const addon = createRequire(import.meta.url)(addonPath);
assert.equal(typeof addon.coordinatePlanningRun, "function");
assert.equal(typeof addon.applyPlanningAlternative, "function");

const request = (id, trainId, number, origin, destination) => ({
  requestNumericId: id,
  trainId,
  trainCategory: "regional",
  trainNumber: number,
  originStationId: origin,
  destinationStationId: destination,
  desiredDepartureS: 28_800,
  operatingDays: "daily",
  stops: [],
  earlierS: 0,
  laterS: 1_800,
  stepS: 60,
  extraRunningTimeS: 0,
  maxOperationalStops: 0,
  train: {
    numericId: id,
    name: `Regionaltriebwagen ${trainId}`,
    massKg: 120_000,
    lengthMm: 140_000,
    maximumSpeedKph: 140,
    accelerationMmPerS2: 600,
    decelerationMmPerS2: 800,
  },
});

const firstRequest = request(1, "train-east", 26_802, "west", "east");
const secondRequest = request(2, "train-west", 26_804, "east", "west");
const input = {
  schemaVersion: "planning-coordinate/v1",
  worldId: "11111111-1111-4111-8111-111111111111",
  runId: "period-2026-window-1",
  expectedProjectionRevision: null,
  seedWorld: "78193085935",
  seedPeriod: 1,
  sourceId: "infra-release-lhe-2026",
  corridorId: "corridor-west-east",
  corridorName: "West–Ost",
  stations: [
    { numericId: 1, id: "west", code: "LWE", name: "West", distanceMm: 0, latitudeE7: 510_000_000, longitudeE7: 120_000_000, stationTrackNumericId: 101, stationTrackLengthMm: 400_000, stationMaximumSpeedKph: 80 },
    { numericId: 2, id: "east", code: "LOE", name: "Ost", distanceMm: 5_000_000, latitudeE7: 510_100_000, longitudeE7: 120_100_000, stationTrackNumericId: 201, stationTrackLengthMm: 400_000, stationMaximumSpeedKph: 80 },
  ],
  segments: [{ edgeNumericId: 1, trackNumericId: 1001, id: "west-east", label: "West–Ost", fromStationId: "west", toStationId: "east", lengthMm: 5_000_000, maximumSpeedKph: 120, mainSignalPositionsMm: [2_000_000, 4_000_000], maximumVirtualBlockLengthMm: 2_000_000 }],
  requests: [firstRequest, secondRequest],
};

const coordinate = (value) => JSON.parse(addon.coordinatePlanningRun(JSON.stringify(value)));
const initial = coordinate(input);
const reordered = coordinate({ ...input, requests: [...input.requests].reverse() });
assert.equal(initial.schemaVersion, "zugfolge-planning-runtime-result/v1");
assert.equal(initial.projection.schemaVersion, "planning-projection/v1");
assert.equal(initial.projection.projectionRevision, 1);
assert.equal(initial.stateHash, reordered.stateHash, "PlanningRun depends on request input order");
assert.deepEqual(initial.projection, reordered.projection);
assert.deepEqual(
  new Set(initial.projection.occupations.map((occupation) => occupation.phase)),
  new Set(["route-setting", "signal-sighting", "approach", "running", "clearing", "route-release"]),
);
const conflict = initial.projection.conflicts.find((candidate) => candidate.alternative !== null);
assert.ok(conflict, "real PlanningRun did not expose its checked alternative");
assert.equal(conflict.kind, "opposing-move");
const command = {
  schemaVersion: "planning-apply-alternative/v1",
  projectionRevision: 1,
  alternativeId: conflict.alternative.alternativeId,
  conflictId: conflict.id,
  trainId: conflict.alternative.trainId,
  departureShiftS: conflict.alternative.departureShiftS,
};
const apply = (state, commandId, payload) => JSON.parse(
  addon.applyPlanningAlternative(JSON.stringify(state), commandId, JSON.stringify(payload)),
);
const applied = apply(initial.state, "native-smoke-command", command);
assert.equal(applied.projection.projectionRevision, 2);
assert.deepEqual(applied.projection.conflicts, []);
assert.equal(applied.idempotentReplay, false);
const replay = apply(applied.state, "native-smoke-command", command);
assert.equal(replay.idempotentReplay, true);
assert.equal(replay.stateHash, applied.stateHash);
assert.deepEqual(replay.projection, applied.projection);
assert.throws(
  () => apply(initial.state, "forged-command", { ...command, departureShiftS: command.departureShiftS + 1 }),
  /alternative_mismatch/,
);

process.stdout.write(`${JSON.stringify({
  schema: initial.projection.schemaVersion,
  initialRevision: initial.projection.projectionRevision,
  appliedRevision: applied.projection.projectionRevision,
  initialStateHash: initial.stateHash,
  appliedStateHash: applied.stateHash,
  conflictKind: conflict.kind,
  alternativeId: conflict.alternative.alternativeId,
  replay: replay.idempotentReplay,
})}\n`);
