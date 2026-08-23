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
  OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
  OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  loadOperationalSimulationRuntime,
  loadOperatingRuntime,
} from "../dist/index.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const lotId = "lot-native-smoke";
const timetableBoundaryS = 604_800;
const addonPath = process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH;
assert.ok(addonPath, "ZUGFOLGE_RUNTIME_NATIVE_PATH fehlt");
const nativeAddon = createRequire(import.meta.url)(addonPath);
for (const legacyExport of [
  "initializeRegionalSimulation",
  "restoreRegionalSimulation",
  "applyRegionalSimulationCommand",
  "applyRegionalSimulationCommandAsync",
  "applyRegionalSimulationCommandBatch",
  "applyRegionalSimulationCommandBatchAsync",
]) {
  assert.equal(
    nativeAddon[legacyExport],
    undefined,
    `Der harte v2-Wechsel darf '${legacyExport}' nicht mehr exportieren`,
  );
}
const runtime = loadOperatingRuntime();
const operationalRuntime = loadOperationalSimulationRuntime();

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

const operationalInitialization = {
  schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  worldId,
  regionId: "leipzig",
  nowMs: 0,
  infraRelease: {
    id: "infra:native-smoke:v2",
    directedEdges: { "edge:1": 100_000 },
    edgeGeometries: {
      "edge:1": [
        {
          edgeOffsetMm: 0,
          latitudeE7: 510_000_000,
          longitudeE7: 120_000_000,
          bearingMilliDegrees: 90_000,
        },
        {
          edgeOffsetMm: 100_000,
          latitudeE7: 510_000_000,
          longitudeE7: 120_100_000,
          bearingMilliDegrees: null,
        },
      ],
    },
    routeVersions: {
      "route:v1": {
        id: "route:v1",
        templateId: "template:v1",
        predecessorId: null,
        transitionRouteMm: null,
        legs: [{
          edgeId: "edge:1",
          direction: "along",
          edgeEntryMm: 0,
          edgeExitMm: 100_000,
          routeStartMm: 0,
          blockIds: ["block:1"],
          speedLimitMmps: 20_000,
          gradientPerMille: 0,
          requiredProtectionSystems: ["pzb"],
        }],
      },
    },
    interlockingRoutes: {
      "interlocking:1": {
        id: "interlocking:1",
        routeTemplateId: "template:v1",
        signalId: "signal:1",
        movementKind: "train",
        pathResources: ["block:1"],
        overlapResources: ["overlap:1"],
        flankResources: ["flank:1"],
        switchPositions: { "switch:1": "straight" },
        authorityEndRouteMm: 90_000,
        releaseAfterTailRouteMm: 80_000,
      },
    },
    signals: ["signal:1"],
    switches: ["switch:1"],
    blockResources: ["block:1", "overlap:1", "flank:1"],
    platformIntervals: {
      "platform:1": {
        edgeId: "edge:1",
        fromMm: 10_000,
        toMm: 30_000,
        direction: "along",
      },
    },
    regionBoundaries: ["boundary:1"],
    rzueLayoutId: "rzue:native-smoke:v1",
  },
  vehicleTypes: [{
    powered: true,
    vehicleType: {
      id: "type:1",
      lengthMm: 10_000,
      massKg: 80_000,
      maximumSpeedMmps: 20_000,
      powerWatts: 4_000_000,
      startingTractiveForceNewtons: 200_000,
      maximumAccelerationMmps2: 1_000,
      serviceBrakeMmps2: 1_000,
      emergencyBrakeMmps2: 1_500,
      protectionSystems: ["pzb"],
    },
  }],
  vehicles: [{
    id: "vehicle:1",
    typeId: "type:1",
    powered: true,
    orientation: "along",
    condition: {
      mechanicsBasisPoints: 9_500,
      driveBasisPoints: 9_500,
      brakesBasisPoints: 9_500,
      kilometresSinceMaintenance: 0,
      operatingHoursSinceMaintenance: 0,
      openObservations: 0,
    },
    restrictions: {},
    history: [],
  }],
  formations: [{
    id: "formation:1",
    predecessorId: null,
    vehicleIds: ["vehicle:1"],
  }],
  trains: [{
    id: "train:1",
    trainNumber: "RB 1",
    operatorId: "operator:1",
    movementKind: "train",
    routeVersionId: "route:v1",
    formationVersionId: "formation:1",
    headRouteMm: 20_000,
    scheduledDepartureMs: null,
    publicPassengerStop: false,
  }],
};
const operationalInitialized = operationalRuntime.initialize(operationalInitialization);
assert.equal(operationalInitialized.state.revision, 0);
assert.equal(operationalInitialized.state.publisherSequence, 0);
assert.equal(operationalInitialized.liveMap.commitSequence, 0);
assert.equal(operationalInitialized.rzue.commitSequence, 0);
assert.deepEqual(
  operationalInitialized.liveMap.trains.map((train) => train.trainId),
  ["train:1"],
);

const operationalCommand = (head, commandId, command) => ({
  schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
  worldId,
  regionId: "leipzig",
  commandId,
  expectedStateHash: head.stateHash,
  expectedRevision: head.state.revision,
  expectedPublisherSequence: head.state.publisherSequence,
  command,
});

await assert.rejects(
  operationalRuntime.apply(
    operationalInitialized.state,
    operationalCommand(operationalInitialized, "native-operational-forbidden-add-delay", {
      type: "add-delay",
      trainId: "train:1",
      seconds: 300,
    }),
  ),
  /add-delay|unknown variant|invalid_json/i,
  "AddDelay darf die v2-Grenze nicht passieren",
);
await assert.rejects(
  operationalRuntime.apply(
    operationalInitialized.state,
    operationalCommand(operationalInitialized, "native-operational-forbidden-register", {
      type: "register-disruption",
      disruption: { disruptionId: "legacy-disruption", delaySeconds: 300 },
    }),
  ),
  /register-disruption|unknown variant|invalid_json/i,
  "register-disruption darf die v2-Grenze nicht passieren",
);

const operationalActivated = await operationalRuntime.apply(
  operationalInitialized.state,
  operationalCommand(operationalInitialized, "native-operational-activate", {
    type: "activate-disruption",
    disruptionId: "native-block-closure",
    effect: { "resource-closed": { resourceId: "block:1" } },
  }),
);
assert.equal(operationalActivated.state.revision, 1);
assert.equal(operationalActivated.state.publisherSequence, 1);
assert.ok(
  operationalActivated.events.some(
    (event) => event.kind === "disruption-activated"
      && event.subjectId === "native-block-closure",
  ),
  "die v2-Ressourcenwirkung muss als echtes Rust-Ereignis sichtbar sein",
);
const operationalClearCommand = operationalCommand(
  operationalActivated,
  "native-operational-clear",
  {
    type: "clear-disruption",
    disruptionId: "native-block-closure",
    releaseReference: "provider:native-smoke:revision-2",
  },
);
const operationalCleared = await operationalRuntime.apply(
  operationalActivated.state,
  operationalClearCommand,
);
assert.equal(operationalCleared.state.revision, 2);
assert.equal(operationalCleared.state.publisherSequence, 2);
assert.ok(
  operationalCleared.events.some(
    (event) => event.kind === "disruption-cleared"
      && event.detail === "provider:native-smoke:revision-2",
  ),
  "die v2-Aufhebung muss den technischen Freigabebeleg tragen",
);
const operationalRestored = operationalRuntime.restore(
  operationalCleared.state,
  operationalCleared.initializationHash,
);
assert.equal(operationalRestored.stateHash, operationalCleared.stateHash);
assert.equal(
  operationalRestored.initializationHash,
  operationalCleared.initializationHash,
);
const mismatchedInitializationHash = `${
  operationalCleared.initializationHash.startsWith("0") ? "1" : "0"
}${operationalCleared.initializationHash.slice(1)}`;
assert.throws(
  () => operationalRuntime.restore(
    operationalCleared.state,
    mismatchedInitializationHash,
  ),
  /initialization_hash_mismatch/,
  "Restore muss einen fremden Initialisierungshash fail-closed ablehnen",
);
const operationalRetry = await operationalRuntime.apply(
  operationalCleared.state,
  operationalClearCommand,
);
assert.equal(operationalRetry.idempotentReplay, true);
assert.equal(operationalRetry.stateHash, operationalCleared.stateHash);

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
    operationalStateHash: operationalRetry.stateHash,
    operationalRevision: operationalRetry.state.revision,
    operationalPublisherSequence: operationalRetry.state.publisherSequence,
    operationalIdempotentReplay: operationalRetry.idempotentReplay,
    initialStateHash: firstInitialization.stateHash,
    resultingStateHash: retry.stateHash,
    resultingRevision: retry.state.revision,
    idempotentReplay: retry.idempotentReplay,
    eventCount: retry.events.length,
  })}\n`,
);
