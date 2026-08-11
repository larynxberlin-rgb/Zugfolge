import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_RESULT_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  loadOperatingRuntime,
} from "../dist/index.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const lotId = "lot-native-smoke";
const timetableBoundaryS = 604_800;
const runtime = loadOperatingRuntime();
const fleetSnapshot = JSON.parse(readFileSync(
  new URL("../../../crates/zugfolge-fleet/tests/fixtures/mobilization-snapshot-v1.json", import.meta.url),
  "utf8",
));
const fleetHash = readFileSync(
  new URL("../../../crates/zugfolge-fleet/tests/fixtures/mobilization-snapshot-v1.sha256", import.meta.url),
  "utf8",
).trim();
const fleetVerification = runtime.verifyFleetMobilizationSnapshot(fleetSnapshot);
assert.equal(fleetVerification.schemaVersion, "zugfolge-fleet-mobilization-verification/v1");
assert.equal(fleetVerification.worldId, fleetSnapshot.worldId);
assert.equal(fleetVerification.fleetRevision, fleetSnapshot.revision);
assert.equal(fleetVerification.snapshotHash, fleetHash);

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
    initialStateHash: firstInitialization.stateHash,
    resultingStateHash: retry.stateHash,
    resultingRevision: retry.state.revision,
    idempotentReplay: retry.idempotentReplay,
    eventCount: retry.events.length,
  })}\n`,
);
