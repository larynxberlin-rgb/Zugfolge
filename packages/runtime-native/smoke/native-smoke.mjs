import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
  FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_RESULT_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  REGIONAL_SIMULATION_COMMAND_SCHEMA,
  REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
  loadRegionalSimulationRuntime,
  loadOperatingRuntime,
} from "../dist/index.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const lotId = "lot-native-smoke";
const timetableBoundaryS = 604_800;
const addonPath = process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH;
assert.ok(addonPath, "ZUGFOLGE_RUNTIME_NATIVE_PATH fehlt");
const nativeAddon = createRequire(import.meta.url)(addonPath);
const runtime = loadOperatingRuntime();
const regionalRuntime = loadRegionalSimulationRuntime();

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

const privateUseId = "vehicle-\u{e000}";
const supplementaryId = "vehicle-\u{10000}";
const authorityVehicle = (id, numericId) => ({
  id,
  numericId,
  operatorId: "operator-incumbent",
  vehicleTypeId: 101,
  classDesignation: "ET1",
  tradeName: "Native-Testzug",
  buildYear: 2024,
  acquisitionYear: 2025,
  procurementChannel: "leasing",
  approvedLineIds: ["S1"],
  maintenanceDeadlines: [{ kind: "inspection", dueAt: timetableBoundaryS + 1_000 }],
  installedProtection: ["pzb"],
  technical: {
    lengthMm: 70_000,
    massKg: 120_000,
    maximumSpeedKph: 160,
    accelerationMmPerS2: 800,
    decelerationMmPerS2: 900,
    traction: "electric",
    electricSystems: ["ac15kv"],
  },
  passenger: {
    seats: 60,
    firstClassSeats: 6,
    accessible: true,
    bicyclePlaces: 2,
    wheelchairPlaces: 1,
    equipment: ["pis"],
    operatingCostCentsPerTrainKm: 350,
    replacementPlan: true,
  },
  deliveredAt: 0,
  retiredAt: timetableBoundaryS + 1_000,
});
const authorityRelease = {
  schemaVersion: "zugfolge-fleet-authority-release/v1",
  releaseId: "native-smoke-authority-v1",
  referenceYear: 2026,
  assets: [authorityVehicle(supplementaryId, 2), authorityVehicle(privateUseId, 1)],
  personnelPools: [{
    id: "pool-1",
    numericId: 1,
    operatorId: "operator-incumbent",
    capacitySeconds: 1_000_000,
    minimumRestSeconds: 10,
    classDesignations: ["ET1"],
    pathReceiptIds: ["path-confirmed"],
    qualificationHash: "a".repeat(64),
  }],
  pathReceipts: [{
    id: "path-confirmed",
    numericRouteId: 1,
    operatorId: "operator-incumbent",
    serviceLineIds: ["S1"],
    decision: "confirmed",
    validFrom: 0,
    validUntil: timetableBoundaryS + 1_000,
    platformLengthsMm: [200_000],
    electrifications: ["overhead-ac15kv"],
    requiredProtection: ["pzb"],
    approvedClasses: ["ET1"],
    plannerStateHash: "b".repeat(64),
    conflictCheckHash: "c".repeat(64),
  }],
};
const fleetInitialized = runtime.initializeFleet({
  schemaVersion: FLEET_INITIALIZE_SCHEMA,
  worldId,
  producedAt: 0,
  authorityRelease,
});
assert.equal(fleetInitialized.state.revision, 0);
assert.match(fleetInitialized.stateHash, /^[a-f0-9]{64}$/);
assert.match(fleetInitialized.state.authorityReleaseHash, /^[a-f0-9]{64}$/);
assert.equal(Object.hasOwn(fleetInitialized.state, "processedCommands"), false);
assert.deepEqual(fleetInitialized.snapshot.formations, []);

const regionalTrain = (trainRunId) => ({
  trainRunId,
  operator: "operator-native",
  trainNumber: "RE 1",
  category: "regional",
  route: [
    {
      operatingPoint: "Leipzig Hbf",
      positionMm: 0,
      arrivalS: 100,
      minimumDwellSeconds: 30,
      departureS: 130,
    },
    {
      operatingPoint: "Halle Hbf",
      positionMm: 3_600_000,
      arrivalS: 3_700,
      minimumDwellSeconds: 30,
      departureS: 3_730,
    },
  ],
});
const regionalInitialized = regionalRuntime.initialize({
  schemaVersion: REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
  worldId,
  regionId: "leipzig",
  materializationWindowHours: 48,
  nowS: 0,
  trains: [regionalTrain("native-regional-1")],
});
assert.equal(regionalInitialized.state.revision, 0);
assert.equal(regionalInitialized.snapshot.producerSequence, 0);
assert.deepEqual(
  regionalInitialized.snapshot.trains.map((train) => train.id),
  ["native-regional-1"],
);
assert.deepEqual(regionalInitialized.snapshot.disruptions, []);
assert.ok(
  regionalInitialized.events.some(
    (event) => event.eventType === "simulation.train-materialized",
  ),
  "die Initialisierung muss echte Rust-Materialisierungsereignisse liefern",
);
const regionalCommand = (head, commandId, command) => ({
  schemaVersion: REGIONAL_SIMULATION_COMMAND_SCHEMA,
  worldId,
  regionId: "leipzig",
  commandId,
  expectedStateHash: head.stateHash,
  expectedRevision: head.state.revision,
  expectedPublisherSequence: head.state.publisherSequence,
  command,
});
const regionalRegistered = await regionalRuntime.apply(
  regionalInitialized.state,
  regionalCommand(regionalInitialized, "native-regional-register-disruption", {
    type: "register-disruption",
    disruption: {
      disruptionId: "native-planned-closure",
      kind: "planned",
      publishedAtS: 0,
      startsAtS: 100,
      validUntilS: 3_600,
      positionMm: 1_200_000,
      causeCode: 25,
      fineCauseId: "signalling.interlocking",
      effect: "closure",
      affectedResource: "block:A:B:1",
      affectedTrainRunIds: [],
      delaySeconds: 0,
    },
  }),
);
assert.equal(regionalRegistered.delta.producerSequence, 1);
assert.equal(regionalRegistered.events.length, 0);
assert.deepEqual(
  regionalRegistered.delta.changedDisruptions.map((item) => [item.disruptionId, item.kind]),
  [["native-planned-closure", "planned"]],
);
const regionalAtDisruptionStart = await regionalRuntime.apply(
  regionalRegistered.state,
  regionalCommand(regionalRegistered, "native-regional-advance-to-disruption", {
    type: "advance-to",
    atS: 100,
  }),
);
const regionalActivated = await regionalRuntime.apply(
  regionalAtDisruptionStart.state,
  regionalCommand(regionalAtDisruptionStart, "native-regional-activate-disruption", {
    type: "activate-disruption",
    disruptionId: "native-planned-closure",
    affectedTrainRunIds: ["native-regional-1"],
    delaySeconds: 300,
  }),
);
assert.equal(regionalActivated.delta.producerSequence, 3);
assert.ok(
  regionalActivated.events.some(
    (event) => event.eventType === "disruption.applied"
      && event.payload.fineCauseId === "signalling.interlocking",
  ),
  "die geplante Einschränkung muss erst am Startzeitpunkt im Rust-Single-Writer wirken",
);
assert.equal(
  regionalActivated.delta.changed.find((train) => train.id === "native-regional-1")?.delaySeconds,
  300,
);
assert.equal(
  regionalRuntime.restore(regionalActivated.state).snapshot.disruptions[0].disruptionId,
  "native-planned-closure",
);
const regionalMaterializeCommand = regionalCommand(
  regionalActivated,
  "native-regional-materialize",
  { type: "materialize", train: regionalTrain("native-regional-2") },
);
const regionalMaterialized = await regionalRuntime.apply(
  regionalActivated.state,
  regionalMaterializeCommand,
);
assert.equal(regionalMaterialized.delta.producerSequence, 4);
assert.deepEqual(
  regionalMaterialized.delta.changed.map((train) => train.id),
  ["native-regional-2"],
);
const regionalAdvanced = await regionalRuntime.apply(
  regionalMaterialized.state,
  regionalCommand(regionalMaterialized, "native-regional-advance", {
    type: "advance-to",
    atS: 5_000,
  }),
);
assert.equal(regionalAdvanced.delta.producerSequence, 5);
assert.ok(regionalAdvanced.events.length > 0);
assert.deepEqual(regionalAdvanced.delta.removedDisruptionIds, ["native-planned-closure"]);
const regionalRemoveCommand = regionalCommand(
  regionalAdvanced,
  "native-regional-remove",
  { type: "dematerialize-before", beforeS: 5_000 },
);
const regionalRemoved = await regionalRuntime.apply(
  regionalAdvanced.state,
  regionalRemoveCommand,
);
assert.equal(regionalRemoved.delta.producerSequence, 6);
assert.deepEqual(regionalRemoved.delta.removed, [
  "native-regional-1",
  "native-regional-2",
]);
const regionalRestored = regionalRuntime.restore(regionalRemoved.state);
assert.equal(regionalRestored.stateHash, regionalRemoved.stateHash);
assert.equal(regionalRestored.snapshot.producerSequence, 6);
assert.deepEqual(regionalRestored.snapshot.trains, []);
assert.deepEqual(regionalRestored.snapshot.disruptions, []);
const regionalRetry = await regionalRuntime.apply(
  regionalRemoved.state,
  regionalRemoveCommand,
);
assert.equal(regionalRetry.idempotentReplay, true);
assert.equal(regionalRetry.stateHash, regionalRemoved.stateHash);
assert.deepEqual(regionalRetry.delta, regionalRemoved.delta);

const formationCommand = {
  schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
  worldId,
  commandId: "native-smoke:formation",
  expectedStateHash: fleetInitialized.stateHash,
  expectedRevision: 0,
  atS: 1,
  formationId: "formation-1",
  vehicleIds: [supplementaryId, privateUseId],
  pathReceiptId: "path-confirmed",
};
assert.throws(
  () => runtime.applyFleetCommand(fleetInitialized.state, {
    ...formationCommand,
    availability: "available",
    characteristics: { seats: 999_999 },
  }),
  /alte, unbekannte oder fehlende Intent-Felder/,
  "abgeleitete Flottenfelder duerfen die Authority-Fakten nicht ueberschreiben",
);
const fleetFormation = runtime.applyFleetCommand(fleetInitialized.state, formationCommand);
assert.equal(fleetFormation.state.revision, 1);
assert.equal(Object.hasOwn(fleetFormation.state, "processedCommands"), false);
assert.equal(
  fleetFormation.commandReceipt.commandHash,
  createHash("sha256").update(fleetFormation.commandReceipt.canonicalCommandJson).digest("hex"),
  "die kompakte Receipt muss die kanonische Intent-Darstellung binden",
);
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
  personnelDutyId: "duty-1",
  personnelPoolId: "pool-1",
  formationIds: ["formation-1"],
  pathReceiptId: "path-confirmed",
  validFrom: 0,
  validUntil: timetableBoundaryS + 1,
};
const tamperedFleetState = structuredClone(fleetFormation.state);
tamperedFleetState.formations["formation-1"].pathReceiptId = "forged-receipt";
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
  pathReservationId: "path-1",
  pathReceiptId: "path-confirmed",
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
const fleetRetry = runtime.applyFleetCommand(
  fleetResult.state,
  pathCommand,
  fleetResult.commandReceipt,
);
assert.equal(fleetRetry.idempotentReplay, true);
assert.equal(fleetRetry.stateHash, fleetResult.stateHash);
assert.equal(fleetRetry.snapshotHash, fleetResult.snapshotHash);
assert.deepEqual(fleetRetry.state, fleetResult.state);
const historicalFormationRetry = runtime.applyFleetCommand(
  fleetFormation.state,
  formationCommand,
  fleetFormation.commandReceipt,
);
assert.equal(historicalFormationRetry.idempotentReplay, true);
assert.equal(historicalFormationRetry.stateHash, fleetFormation.stateHash);
assert.equal(historicalFormationRetry.snapshotHash, fleetFormation.snapshotHash);
assert.throws(
  () => runtime.applyFleetCommand(
    fleetResult.state,
    formationCommand,
    fleetFormation.commandReceipt,
  ),
  /historischen Zustand/,
  "eine alte Receipt darf nicht mit dem aktuellen State zu einem gemischten Resultat kombiniert werden",
);
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

const unsupportedInitialization = {
  ...initialization,
  schemaVersion: "zugfolge-operating-world-initialize/v0",
};
assert.throws(
  () => nativeAddon.initializeOperatingWorld(JSON.stringify(unsupportedInitialization)),
  (error) => error instanceof Error && /^unsupported_schema:/.test(error.message),
  "the registered M5/M6 napi ABI must throw the stable Rust domain error",
);
assert.throws(
  () => runtime.initialize(unsupportedInitialization),
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
    regionalStateHash: regionalRetry.stateHash,
    regionalRevision: regionalRetry.state.revision,
    regionalPublisherSequence: regionalRetry.state.publisherSequence,
    regionalIdempotentReplay: regionalRetry.idempotentReplay,
    initialStateHash: firstInitialization.stateHash,
    resultingStateHash: retry.stateHash,
    resultingRevision: retry.state.revision,
    idempotentReplay: retry.idempotentReplay,
    eventCount: retry.events.length,
  })}\n`,
);
