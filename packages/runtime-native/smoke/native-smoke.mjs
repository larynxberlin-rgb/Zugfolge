import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
  FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_RESULT_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  loadOperatingRuntime,
} from "../dist/index.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const lotId = "lot-native-smoke";
const timetableBoundaryS = 604_800;
const runtime = loadOperatingRuntime();

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  assert.ok(value === null || ["string", "boolean", "number"].includes(typeof value));
  if (typeof value === "number") assert.ok(Number.isSafeInteger(value));
  return JSON.stringify(value);
}

const fleetInitialized = runtime.initializeFleet({
  schemaVersion: FLEET_INITIALIZE_SCHEMA,
  worldId,
  producedAt: 0,
});
assert.equal(fleetInitialized.state.revision, 0);
assert.match(fleetInitialized.stateHash, /^[a-f0-9]{64}$/);
assert.deepEqual(fleetInitialized.snapshot.formations, []);

const privateUseId = "vehicle-\u{e000}";
const supplementaryId = "vehicle-\u{10000}";
const formationCommand = {
  schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
  worldId,
  commandId: "native-smoke:formation",
  expectedStateHash: fleetInitialized.stateHash,
  expectedRevision: 0,
  atS: 1,
  formation: {
    id: "formation-1",
    operatorId: "operator-incumbent",
    vehicleIds: [supplementaryId, privateUseId],
    serviceLineIds: ["S1"],
    availability: "available",
    procurement: "delivered",
    availableFrom: 0,
    availableUntil: timetableBoundaryS + 1,
    characteristics: {
      seats: 120,
      firstClassBasisPoints: 0,
      accessible: true,
      bicyclePlaces: 4,
      wheelchairPlaces: 1,
      equipment: ["pis"],
      vehicleAgeYears: 1,
      maximumSpeedKph: 160,
      operatingCostCentsPerTrainKm: 700,
      homologatedLineIds: ["S1"],
      maintenanceValidUntil: timetableBoundaryS + 1,
      traction: "electric",
      replacementPlan: true,
    },
  },
};
assert.throws(
  () => runtime.applyFleetCommand(fleetInitialized.state, {
    ...formationCommand,
    snapshot: { worldId: "forged", revision: 999 },
  }),
  /invalid_json/,
  "Rust darf keinen angelieferten Snapshot als Kommandoquelle akzeptieren",
);
const fleetFormation = runtime.applyFleetCommand(fleetInitialized.state, formationCommand);
assert.equal(fleetFormation.state.revision, 1);
assert.deepEqual(
  fleetFormation.snapshot.formations[0].vehicleIds,
  [privateUseId, supplementaryId],
  "Rust und TypeScript muessen dieselbe UTF-8-Byteordnung verwenden",
);

const dutyCommand = {
  schemaVersion: FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
  worldId,
  commandId: "native-smoke:duty",
  expectedStateHash: fleetFormation.stateHash,
  expectedRevision: 1,
  atS: 2,
  personnelDuty: {
    id: "duty-1",
    operatorId: "operator-incumbent",
    formationIds: ["formation-1"],
    status: "ready",
    validFrom: 0,
    validUntil: timetableBoundaryS + 1,
  },
};
const tamperedFleetState = structuredClone(fleetFormation.state);
tamperedFleetState.formations["formation-1"].operatorId = "forged-operator";
assert.throws(
  () => runtime.applyFleetCommand(tamperedFleetState, dutyCommand),
  /state_hash_mismatch/,
  "das naechste Kommando muss exakt an den vorherigen Rust-Zustandshash gebunden sein",
);
const fleetDuty = runtime.applyFleetCommand(fleetFormation.state, dutyCommand);
const pathCommand = {
  schemaVersion: FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
  worldId,
  commandId: "native-smoke:path",
  expectedStateHash: fleetDuty.stateHash,
  expectedRevision: 2,
  atS: 3,
  pathReservation: {
    id: "path-1",
    operatorId: "operator-incumbent",
    serviceLineIds: ["S1"],
    status: "confirmed",
    validFrom: 0,
    validUntil: timetableBoundaryS + 1,
  },
};
const fleetResult = runtime.applyFleetCommand(fleetDuty.state, pathCommand);
assert.equal(fleetResult.state.revision, 3);
assert.equal(fleetResult.snapshot.revision, 3);
assert.equal(fleetResult.snapshot.personnelDuties[0].id, "duty-1");
assert.equal(fleetResult.snapshot.pathReservations[0].id, "path-1");
assert.equal(
  fleetResult.snapshotHash,
  createHash("sha256").update(canonicalJson(fleetResult.snapshot)).digest("hex"),
  "der Rust-Snapshothash muss die exakt materialisierten Nutzdaten binden",
);
const fleetRetry = runtime.applyFleetCommand(fleetResult.state, pathCommand);
assert.equal(fleetRetry.idempotentReplay, true);
assert.equal(fleetRetry.stateHash, fleetResult.stateHash);
assert.equal(fleetRetry.snapshotHash, fleetResult.snapshotHash);
assert.deepEqual(fleetRetry.state, fleetResult.state);
assert.throws(
  () => runtime.applyFleetCommand(fleetInitialized.state, {
    ...formationCommand,
    worldId: "22222222-2222-4222-8222-222222222222",
    commandId: "native-smoke:foreign",
  }),
  /Weltisolation/,
);

const initialization = {
  schemaVersion: OPERATING_INITIALIZE_SCHEMA,
  worldId,
  lots: [
    {
      lotId,
      incumbentOperatorId: "operator-incumbent",
      timetableBoundaryS,
      trainRuns: [
        { trainRunId: "native-smoke-1", formationId: "formation-1" },
        { trainRunId: "native-smoke-2", formationId: "formation-2" },
      ],
    },
  ],
};

assert.throws(
  () => runtime.initialize({ ...initialization, schemaVersion: "zugfolge-operating-world-initialize/v0" }),
  /unsupported_schema/,
  "das echte Addon muss ein unbekanntes Initialisierungsschema ablehnen",
);

const firstInitialization = runtime.initialize(initialization);
const replayedInitialization = runtime.initialize(initialization);
assert.equal(firstInitialization.schemaVersion, "zugfolge-operating-world-initialized/v1");
assert.equal(firstInitialization.state.schemaVersion, "zugfolge-operating-world-state/v1");
assert.equal(firstInitialization.state.worldId, worldId);
assert.equal(firstInitialization.state.revision, 0);
assert.match(firstInitialization.stateHash, /^[a-f0-9]{64}$/);
assert.equal(
  replayedInitialization.stateHash,
  firstInitialization.stateHash,
  "identische Initialisierung muss denselben Rust-Zustandshash liefern",
);
assert.deepEqual(replayedInitialization.state, firstInitialization.state);

const command = {
  schemaVersion: OPERATING_TRANSITION_SCHEMA,
  worldId,
  commandId: "native-smoke-transition",
  expectedStateHash: firstInitialization.stateHash,
  expectedRevision: 0,
  lotId,
  atS: timetableBoundaryS,
  winnerOperatorId: "operator-incumbent",
  mobilizationProof: null,
  publicVehiclePool: [],
};

const firstResult = runtime.applyTransition(firstInitialization.state, command);
assert.equal(firstResult.schemaVersion, OPERATING_RESULT_SCHEMA);
assert.equal(firstResult.state.schemaVersion, "zugfolge-operating-world-state/v1");
assert.equal(firstResult.state.worldId, worldId);
assert.equal(firstResult.state.revision, 1);
assert.match(firstResult.stateHash, /^[a-f0-9]{64}$/);
assert.notEqual(firstResult.stateHash, firstInitialization.stateHash);
assert.equal(firstResult.outcome.lotId, lotId);
assert.equal(firstResult.outcome.kind, "seamless-continuation");
assert.equal(firstResult.idempotentReplay, false);
assert.ok(firstResult.events.length > 0, "der echte Apply-Aufruf muss Rust-Ereignisse liefern");

const retry = runtime.applyTransition(firstResult.state, command);
assert.equal(retry.schemaVersion, OPERATING_RESULT_SCHEMA);
assert.equal(retry.idempotentReplay, true);
assert.equal(retry.stateHash, firstResult.stateHash);
assert.deepEqual(retry.state, firstResult.state);
assert.deepEqual(retry.outcome, firstResult.outcome);
assert.deepEqual(retry.events, firstResult.events);

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: retry.schemaVersion,
    fleetStateHash: fleetRetry.stateHash,
    fleetSnapshotHash: fleetRetry.snapshotHash,
    fleetRevision: fleetRetry.state.revision,
    fleetIdempotentReplay: fleetRetry.idempotentReplay,
    initialStateHash: firstInitialization.stateHash,
    resultingStateHash: retry.stateHash,
    resultingRevision: retry.state.revision,
    idempotentReplay: retry.idempotentReplay,
    eventCount: retry.events.length,
  })}\n`,
);
