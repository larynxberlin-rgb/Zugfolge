import { alphaHash } from "@zugfolge/alpha";
import {
  parsePlanningInfrastructureRelease,
  type PlanningInfrastructureRelease,
  type PlanningInfrastructureReleaseCatalog,
} from "@zugfolge/planning-worker";
import {
  FLEET_AUTHORITY_RELEASE_SCHEMA_V2,
  OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE,
  OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  assertOperationalTrainNumbers,
  operationalMovementContinuationsEvidence,
  operationalInfrastructureBindingsEqual,
  operationalProtectionModeSelectionEvidence,
  type FleetAuthorityRelease,
  type OperationalInfrastructureBinding,
  type OperationalDispatchRequest,
  type OperationalInitializationValidationReceipt,
  type OperationalMovementContinuation,
  type OperationalMovementContinuationTemplate,
  type OperationalSimulationInitialization,
  type OperationalTrainInitialization,
} from "@zugfolge/runtime-native";

import {
  validateAlphaVehicleCatalogBinding,
  type SignedAlphaWorldDeployment,
} from "./alpha-world-start.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";
import type { FleetAuthorityWorldConfiguration } from "./fleet-configuration.js";
import {
  REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT,
  type OperationalScheduledCommand,
  type OperationalScheduledCommandBoundary,
  type RegionalRealtimeRegistration,
  type RegionalScheduledCommandCatalog,
} from "./regional-simulation-scheduler.js";
import { compareUtf8 } from "./utf8.js";

function realtimeRegionKey(worldId: string, regionId: string): string {
  return `${worldId}\u0000${regionId}`;
}

interface OperationalProgramTrain {
  readonly train: OperationalTrainInitialization;
  readonly interlockingRouteId: string;
  readonly departureOffsetMs: number;
}

interface OperationalProgramBoundary {
  readonly departureOffsetMs: number;
  /** Nur oeffentliche Personenfahrten loesen das Vorab-Queueing ihrer Kette aus. */
  readonly trains: readonly OperationalProgramTrain[];
}

interface OperationalProgramContinuation {
  readonly template: OperationalMovementContinuationTemplate;
  readonly predecessor: OperationalProgramTrain;
  readonly successor: OperationalProgramTrain;
}

interface OperationalDeploymentProgram {
  readonly deploymentHash: string;
  readonly worldId: string;
  readonly regionId: string;
  readonly initializationHash: string;
  readonly initialization: OperationalSimulationInitialization;
  readonly repeatEveryMs: number;
  readonly trains: readonly OperationalProgramTrain[];
  readonly boundaries: readonly OperationalProgramBoundary[];
  readonly trainsById: ReadonlyMap<string, OperationalProgramTrain>;
  readonly outgoingContinuations: ReadonlyMap<string, OperationalProgramContinuation>;
  readonly continuationChains: ReadonlyMap<string, readonly OperationalProgramContinuation[]>;
  readonly rootByTrainId: ReadonlyMap<string, string>;
  /** Summe der reinen Zeit-Offsets von der DailyPlan-Wurzel bis zur Vorlage. */
  readonly rootDayOffsetByTrainId: ReadonlyMap<string, number>;
  readonly dayZeroRootIds: ReadonlySet<string>;
  /** Fuer jede Tageswurzel: [sie selbst, ihr physischer Vortagesvorgaenger, ...]. */
  readonly rolloverPredecessorCycles: ReadonlyMap<string, readonly string[]>;
}

function safeNonnegativeInteger(value: unknown, detail: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(detail);
  return value as number;
}

function validateNativeInitializationReceipt(
  worldId: string,
  initialization: OperationalSimulationInitialization,
  receipt: OperationalInitializationValidationReceipt | undefined,
): OperationalInitializationValidationReceipt {
  assertOperationalTrainNumbers(initialization.trains, "signiertes Operational-v2-Programm");
  const expectedRouteVersionCount = new Set(
    initialization.trains.map((train) => train.routeVersionId),
  ).size;
  const expectedDispatchInterlockingRouteCount = new Set(
    initialization.trains.map((train) => train.dispatchInterlockingRouteId),
  ).size;
  const expectedFormationBindingCount = new Set(
    initialization.trains.map((train) => train.formationVersionId),
  ).size;
  const protectionModeSelectionEvidence = operationalProtectionModeSelectionEvidence(initialization);
  const movementContinuationsEvidence = operationalMovementContinuationsEvidence(initialization);
  if (
    receipt === undefined
    || receipt.schemaVersion !== OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA
    || receipt.worldId !== worldId
    || receipt.regionId !== initialization.regionId
    || receipt.initializationHash !== operationalSimulationInitializationHash(initialization)
    || !operationalInfrastructureBindingsEqual(receipt.infraRelease, initialization.infraRelease)
    || receipt.programTrainCount !== initialization.trains.length
    || receipt.validatedProgramTemplateCount !== initialization.trains.length
    || receipt.validatedRouteVersionCount !== expectedRouteVersionCount
    || receipt.validatedDispatchInterlockingRouteCount !== expectedDispatchInterlockingRouteCount
    || receipt.validatedFormationBindingCount !== expectedFormationBindingCount
    || receipt.validatedTrainNumberCount !== initialization.trains.length
    || receipt.validatedMovementContinuationCount !== movementContinuationsEvidence.count
    || receipt.movementContinuationsSha256 !== movementContinuationsEvidence.sha256
    || initialization.protectionModeSelectionPolicy !== OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY
    || receipt.protectionModeSelectionPolicy !== initialization.protectionModeSelectionPolicy
    || receipt.validatedProtectionModeSelectionCount !== protectionModeSelectionEvidence.count
    || receipt.protectionModeSelectionsSha256 !== protectionModeSelectionEvidence.sha256
    || receipt.protectionModeSelectionsValidated !== true
    || !/^[a-f0-9]{64}$/u.test(receipt.stateHash)
    || receipt.dynamicTrainCount !== 0
    || receipt.resourceBindingsValidated !== true
    || receipt.formationBindingsValidated !== true
    || receipt.trainNumbersValidated !== true
    || receipt.validationMode !== OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE
    || (initialization.trains.length > 0 && (
      receipt.validatedRouteVersionCount <= 0
      || receipt.validatedDispatchInterlockingRouteCount <= 0
      || receipt.validatedResourceBindingCount <= 0
      || receipt.validatedFormationBindingCount <= 0
    ))
  ) {
    throw new Error("Signiertes Betriebsprogramm besitzt keinen passenden nativen Streaming-Pruefbeleg.");
  }
  return receipt;
}

export function validateNativeProgramReceipt(
  signed: SignedAlphaWorldDeployment,
  receipt: OperationalInitializationValidationReceipt | undefined,
): OperationalInitializationValidationReceipt {
  return validateNativeInitializationReceipt(
    signed.deployment.worldId,
    signed.deployment.regionalSimulation,
    receipt,
  );
}

function deploymentOperationalProgram(
  signed: SignedAlphaWorldDeployment,
  receipt: OperationalInitializationValidationReceipt | undefined,
): OperationalDeploymentProgram {
  const { deployment, deploymentHash } = signed;
  validateNativeProgramReceipt(signed, receipt);
  // Eine einzige private Kopie traegt sowohl Revalidation als auch die
  // wiederholbaren Zugvorlagen. Ein zweiter vollstaendiger Zugkorpus wuerde
  // gerade beim Deutschland-Catch-up unnoetig die Speichermarge verbrauchen.
  const initialization: OperationalSimulationInitialization = structuredClone(
    deployment.regionalSimulation,
  );
  const repeatEveryMs = initialization.repeatEveryMs;
  if (
    !Number.isSafeInteger(deployment.repeatEveryS)
    || deployment.repeatEveryS <= 0
    || typeof repeatEveryMs !== "number"
    || !Number.isSafeInteger(repeatEveryMs)
    || repeatEveryMs <= 0
    || deployment.repeatEveryS * 1_000 !== repeatEveryMs
    || initialization.nowMs !== 0
    || initialization.trains.length === 0
  ) {
    throw new Error("Signiertes Deployment besitzt keinen gueltigen wiederholbaren v2-Betriebstakt.");
  }
  const movementContinuations = structuredClone(initialization.movementContinuations);
  if (
    !Array.isArray(movementContinuations)
    || movementContinuations.length === 0
  ) {
    throw new Error(
      "Signiertes Operational-v2-Deployment besitzt keinen vollstaendigen physischen Umlaufvertrag.",
    );
  }
  const seen = new Set<string>();
  const passengerFormationDepartures = new Set<string>();
  const maximumMovementOffsetMs = repeatEveryMs * 2;
  if (!Number.isSafeInteger(maximumMovementOffsetMs)) {
    throw new Error("Signierter v2-Betriebstakt ist fuer eine tagesuebergreifende Bewegungskette zu gross.");
  }
  const trains = initialization.trains.map((train): OperationalProgramTrain => {
    const departureOffsetMs = safeNonnegativeInteger(
      train.scheduledDepartureMs,
      `Fahrt '${train.id}' besitzt keine signierte Abfahrtsgrenze.`,
    );
    if (
      seen.has(train.id)
      || /:day-\d+$/u.test(train.id)
      || (train.publicPassengerStop
        ? departureOffsetMs >= repeatEveryMs
        : departureOffsetMs >= maximumMovementOffsetMs)
    ) {
      throw new Error(`Fahrt '${train.id}' ist fuer die signierte Tageswiederholung ungueltig.`);
    }
    seen.add(train.id);
    if (train.publicPassengerStop) {
      const formationDeparture = `${train.formationVersionId}\u0000${departureOffsetMs}`;
      if (passengerFormationDepartures.has(formationDeparture)) {
        throw new Error(
          `Formation '${train.formationVersionId}' ist zur Personenfahrgrenze '${departureOffsetMs}' mehrfach verplant.`,
        );
      }
      passengerFormationDepartures.add(formationDeparture);
    }
    if (
      typeof train.dispatchInterlockingRouteId !== "string"
      || train.dispatchInterlockingRouteId.trim() === ""
    ) {
      throw new Error(`Fahrt '${train.id}' besitzt keine nativ validierte signierte Fahrstrasse.`);
    }
    return Object.freeze({
      train,
      interlockingRouteId: train.dispatchInterlockingRouteId,
      departureOffsetMs,
    });
  }).sort((left, right) =>
    left.departureOffsetMs - right.departureOffsetMs
    || compareUtf8(left.train.id, right.train.id));

  const trainsById = new Map(trains.map((train) => [train.train.id, train]));
  const continuationIds = new Set<string>();
  const incomingContinuations = new Map<string, OperationalProgramContinuation>();
  const outgoingContinuations = new Map<string, OperationalProgramContinuation>();
  const expectedContinuationKeys = [
    "continuity",
    "dailyBoundary",
    "id",
    "minimumDwellMs",
    "predecessorBaseRouteVersionId",
    "predecessorTrainId",
    "successorDayOffset",
    "successorFormation",
    "successorTrainId",
  ].sort(compareUtf8).join("\u0000");
  for (const template of movementContinuations) {
    if (
      template === null
      || typeof template !== "object"
      || Object.keys(template).sort(compareUtf8).join("\u0000") !== expectedContinuationKeys
      || typeof template.id !== "string"
      || template.id.trim() === ""
      || typeof template.predecessorBaseRouteVersionId !== "string"
      || template.predecessorBaseRouteVersionId.trim() === ""
      || /:day-\d+$/u.test(template.id)
      || continuationIds.has(template.id)
      || (template.successorDayOffset !== 0 && template.successorDayOffset !== 1)
      || typeof template.dailyBoundary !== "boolean"
      || !Number.isSafeInteger(template.minimumDwellMs)
      || template.minimumDwellMs < 0
      || (template.continuity !== "same-direction"
        && template.continuity !== "reverse-direction")
      || template.successorFormation !== "inherit-predecessor"
    ) {
      throw new Error("Signierter physischer Umlaufvertrag enthaelt eine ungueltige Fortsetzung.");
    }
    const predecessor = trainsById.get(template.predecessorTrainId);
    const successor = trainsById.get(template.successorTrainId);
    const expectedMinimumDwellMs = predecessor?.train.publicPassengerStop === true ? 300_000 : 0;
    if (
      predecessor === undefined
      || successor === undefined
      || template.minimumDwellMs !== expectedMinimumDwellMs
      || (predecessor === successor && !template.dailyBoundary)
      || outgoingContinuations.has(predecessor.train.id)
      || incomingContinuations.has(successor.train.id)
    ) {
      throw new Error(
        `Fortsetzung '${template.id}' bindet keine eindeutige vollstaendige Bewegungskette.`,
      );
    }
    const successorAbsoluteOffset = successor.departureOffsetMs
      + template.successorDayOffset * repeatEveryMs;
    if (
      !Number.isSafeInteger(successorAbsoluteOffset)
      || successorAbsoluteOffset < predecessor.departureOffsetMs
    ) {
      throw new Error(`Fortsetzung '${template.id}' verletzt die signierte Tageszeitfolge.`);
    }
    continuationIds.add(template.id);
    const continuation = Object.freeze({ template, predecessor, successor });
    outgoingContinuations.set(predecessor.train.id, continuation);
    incomingContinuations.set(successor.train.id, continuation);
  }
  if (
    continuationIds.size !== trains.length
    || outgoingContinuations.size !== trains.length
    || incomingContinuations.size !== trains.length
  ) {
    throw new Error(
      "Signierter physischer Umlaufvertrag muss jede Programmbewegung genau einmal fortsetzen.",
    );
  }

  const dayZeroRootIds = new Set<string>();
  for (const continuation of outgoingContinuations.values()) {
    if (!continuation.template.dailyBoundary) continue;
    if (!continuation.successor.train.publicPassengerStop) {
      throw new Error(
        `Tagesfortsetzung '${continuation.template.id}' endet nicht an einer Personenfahrt.`,
      );
    }
    dayZeroRootIds.add(continuation.successor.train.id);
  }
  if (dayZeroRootIds.size === 0) {
    throw new Error("Signierter physischer Umlaufvertrag besitzt keine Tageswurzel.");
  }

  const rootByTrainId = new Map<string, string>();
  const rootDayOffsetByTrainId = new Map<string, number>();
  const rootFormationIds = new Set<string>();
  for (const rootId of dayZeroRootIds) {
    const root = trainsById.get(rootId)!;
    if (!rootFormationIds.add(root.train.formationVersionId)) {
      throw new Error(
        `Formation '${root.train.formationVersionId}' besitzt mehrere Day-0-Personenfahrten.`,
      );
    }
    let cursor = rootId;
    let accumulatedDayOffset = 0;
    const visited = new Set<string>();
    while (true) {
      const train = trainsById.get(cursor)!;
      if (
        !visited.add(cursor)
        || rootByTrainId.has(cursor)
        || train.train.formationVersionId !== root.train.formationVersionId
      ) {
        throw new Error(`Tageswurzel '${rootId}' besitzt keinen eindeutigen statischen Slotpfad.`);
      }
      rootByTrainId.set(cursor, rootId);
      rootDayOffsetByTrainId.set(cursor, accumulatedDayOffset);
      const outgoing = outgoingContinuations.get(cursor)!;
      const nextDayOffset = accumulatedDayOffset + outgoing.template.successorDayOffset;
      if (outgoing.template.dailyBoundary) {
        if (nextDayOffset !== 1) {
          throw new Error(`DailyPlan-Pfad '${rootId}' besitzt nicht genau eine Periodenfortschaltung.`);
        }
        break;
      }
      if (nextDayOffset > 1) {
        throw new Error(`DailyPlan-Pfad '${rootId}' ueberschreitet eine Periode.`);
      }
      accumulatedDayOffset = nextDayOffset;
      cursor = outgoing.successor.train.id;
    }
  }
  if (rootByTrainId.size !== trains.length) {
    throw new Error("Explizite DailyPlan-Grenzen decken den Betriebsprogrammgraphen nicht exakt ab.");
  }

  const rolloverPredecessors = new Map<string, string>();
  for (const continuation of outgoingContinuations.values()) {
    if (!continuation.template.dailyBoundary) continue;
    const successorRootId = rootByTrainId.get(continuation.successor.train.id)!;
    const predecessorRootId = rootByTrainId.get(continuation.predecessor.train.id)!;
    if (rolloverPredecessors.has(successorRootId)) {
      throw new Error(`Tageswurzel '${successorRootId}' besitzt mehrere physische Vorgaenger.`);
    }
    rolloverPredecessors.set(successorRootId, predecessorRootId);
  }
  if (
    rolloverPredecessors.size !== dayZeroRootIds.size
    || new Set(rolloverPredecessors.values()).size !== dayZeroRootIds.size
    || [...rolloverPredecessors.keys()].some((rootId) => !dayZeroRootIds.has(rootId))
    || [...rolloverPredecessors.values()].some((rootId) => !dayZeroRootIds.has(rootId))
  ) {
    throw new Error("Tagesuebergaben bilden keine kanonische physische Formation-Permutation.");
  }
  const rolloverPredecessorCycles = new Map<string, readonly string[]>();
  for (const rootId of dayZeroRootIds) {
    const cycle: string[] = [];
    const visited = new Set<string>();
    let cursor = rootId;
    while (!visited.has(cursor)) {
      visited.add(cursor);
      cycle.push(cursor);
      cursor = rolloverPredecessors.get(cursor)!;
    }
    if (cursor !== rootId) {
      throw new Error(`Tageswurzel '${rootId}' liegt nicht in einem geschlossenen Umlauf.`);
    }
    rolloverPredecessorCycles.set(rootId, Object.freeze(cycle));
  }

  const continuationChains = new Map<string, readonly OperationalProgramContinuation[]>();
  const queuedContinuationIds = new Set<string>();
  for (const passenger of trains.filter(({ train }) => train.publicPassengerStop)) {
    const chain: OperationalProgramContinuation[] = [];
    const visited = new Set<string>();
    let cursor = passenger.train.id;
    let accumulatedDayOffset = 0;
    while (true) {
      if (!visited.add(cursor)) {
        throw new Error(`Personenfahrt '${passenger.train.id}' besitzt keine endliche Nachfolgekette.`);
      }
      const continuation = outgoingContinuations.get(cursor)!;
      chain.push(continuation);
      if (!queuedContinuationIds.add(continuation.template.id)) {
        throw new Error(`Fortsetzung '${continuation.template.id}' wird an mehreren Grenzen gequeued.`);
      }
      accumulatedDayOffset += continuation.template.successorDayOffset;
      if (accumulatedDayOffset > 1) {
        throw new Error(
          `Nachfolgekette von '${passenger.train.id}' ueberschreitet einen Betriebstag.`,
        );
      }
      if (continuation.successor.train.publicPassengerStop) break;
      cursor = continuation.successor.train.id;
    }
    continuationChains.set(passenger.train.id, Object.freeze(chain));
  }
  if (queuedContinuationIds.size !== continuationIds.size) {
    throw new Error(
      "Signierter physischer Umlaufvertrag enthaelt eine nicht an eine Personenfahrt gebundene Bewegung.",
    );
  }

  const trainsPerBoundary = new Map<number, OperationalProgramTrain[]>();
  for (const train of trains.filter(({ train }) => train.publicPassengerStop)) {
    const boundary = trainsPerBoundary.get(train.departureOffsetMs) ?? [];
    boundary.push(train);
    trainsPerBoundary.set(train.departureOffsetMs, boundary);
  }
  const boundaries = [...trainsPerBoundary].map(([departureOffsetMs, boundaryTrains]) =>
    Object.freeze({
      departureOffsetMs,
      trains: Object.freeze(boundaryTrains),
  }));
  for (const { departureOffsetMs, trains: boundaryTrains } of boundaries) {
    const dayZeroRoots = boundaryTrains.filter(({ train }) => dayZeroRootIds.has(train.id));
    const continuationCount = boundaryTrains.reduce(
      (count, { train }) => count + continuationChains.get(train.id)!.length,
      0,
    );
    // Day 0 ist die groesste Grenze: Wurzeln materialisieren, alle physischen
    // Nachfolger bis zur naechsten Personenfahrt vorab queueen, Wurzeln
    // gemeinsam dispatchen; der Realtime-Scheduler ergaenzt genau ein Advance.
    const maximumBoundaryCommands = dayZeroRoots.length
      + continuationCount
      + (dayZeroRoots.length === 0 ? 0 : 1)
      + 1;
    if (maximumBoundaryCommands > REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT) {
      throw new Error(
        `Signierte Betriebsprogrammgrenze '${departureOffsetMs}' ueberschreitet mit ${maximumBoundaryCommands} atomaren Kommandos das Limit ${REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT}.`,
      );
    }
  }
  return Object.freeze({
    deploymentHash,
    worldId: deployment.worldId,
    regionId: initialization.regionId,
    initializationHash: operationalSimulationInitializationHash(initialization),
    initialization,
    repeatEveryMs,
    trains: Object.freeze(trains),
    boundaries: Object.freeze(boundaries),
    trainsById,
    outgoingContinuations,
    continuationChains,
    rootByTrainId,
    rootDayOffsetByTrainId,
    dayZeroRootIds,
    rolloverPredecessorCycles,
  });
}

function recurringTrainId(baseId: string, day: number): string {
  return day === 0 ? baseId : `${baseId}:day-${day}`;
}

function physicalFormationVersionId(
  program: OperationalDeploymentProgram,
  train: OperationalProgramTrain,
  day: number,
): string {
  const rootId = program.rootByTrainId.get(train.train.id);
  const cycle = rootId === undefined
    ? undefined
    : program.rolloverPredecessorCycles.get(rootId);
  if (rootId === undefined || cycle === undefined || cycle.length === 0) {
    throw new Error(`Fahrt '${train.train.id}' fehlt im physischen Tagesumlauf.`);
  }
  const rootDayOffset = program.rootDayOffsetByTrainId.get(train.train.id);
  if (rootDayOffset === undefined) {
    throw new Error(`Fahrt '${train.train.id}' besitzt keinen DailyPlan-Zeitoffset.`);
  }
  const logicalDay = day - rootDayOffset;
  if (logicalDay < 0) {
    throw new Error(`Fahrt '${train.train.id}' besitzt vor ihrer Day-0-Wurzel keine Instanz.`);
  }
  const physicalRootId = cycle[logicalDay % cycle.length]!;
  const physicalRoot = program.trainsById.get(physicalRootId);
  if (physicalRoot === undefined) {
    throw new Error(`Tageswurzel '${physicalRootId}' fehlt im signierten Betriebsprogramm.`);
  }
  return physicalRoot.train.formationVersionId;
}

function dispatchRequest(
  train: OperationalProgramTrain,
  trainId: string,
  atMs: number,
): OperationalDispatchRequest {
  return Object.freeze({
    trainId,
    interlockingRouteId: train.interlockingRouteId,
    committedRank: 0,
    timetableDeviationMs: 0,
    passengerImpact: 0,
    contractualImpact: 0,
    networkImpact: 0,
    resourceConsequence: 0,
    recoveryRank: 0,
    waitingSinceMs: atMs,
  });
}

function boundaryCommands(
  program: OperationalDeploymentProgram,
  boundary: OperationalProgramBoundary,
  day: number,
): readonly OperationalScheduledCommand[] {
  const { departureOffsetMs, trains } = boundary;
  const atMs = departureOffsetMs + day * program.repeatEveryMs;
  if (!Number.isSafeInteger(atMs)) throw new RangeError("Betriebsprogrammgrenze liegt ausserhalb des sicheren Bereichs.");
  const prefix = `${program.deploymentHash}:operational:${program.regionId}:${day}:${departureOffsetMs}`;
  const commands: OperationalScheduledCommand[] = [];
  const activeTrains = trains.filter((train) => {
    const rootDayOffset = program.rootDayOffsetByTrainId.get(train.train.id);
    if (rootDayOffset === undefined) {
      throw new Error(`Fahrt '${train.train.id}' besitzt keinen DailyPlan-Zeitoffset.`);
    }
    return day >= rootDayOffset;
  });
  const dayZeroRoots = day === 0
    ? activeTrains.filter(({ train }) => program.dayZeroRootIds.has(train.id))
    : [];
  const serviceOutcomeFor = (train: OperationalTrainInitialization, instanceDay: number) => {
    if (train.serviceOutcome === undefined) return {};
    const shiftMs = instanceDay * program.repeatEveryMs;
    const scheduledArrivalMs = train.serviceOutcome.scheduledArrivalMs + shiftMs;
    const epochDay = Date.parse(`${train.serviceOutcome.serviceDay}T00:00:00.000Z`);
    if (!Number.isSafeInteger(scheduledArrivalMs) || !Number.isFinite(epochDay)) {
      throw new RangeError("Tagesfahrt besitzt keine gueltige signierte Abschlussbindung.");
    }
    const serviceDay = new Date(epochDay + shiftMs).toISOString().slice(0, 10);
    return { serviceOutcome: {
      ...structuredClone(train.serviceOutcome),
      serviceRunId: `${train.serviceOutcome.serviceId}:service-day:${serviceDay}`,
      serviceDay,
      scheduledArrivalMs,
    } };
  };
  for (const train of dayZeroRoots) {
    commands.push(Object.freeze({
      commandId: `${prefix}:materialize:${train.train.id}`,
      atMs,
      command: Object.freeze({
        type: "materialize",
        train: Object.freeze({
          ...structuredClone(train.train),
          ...serviceOutcomeFor(train.train, day),
          id: recurringTrainId(train.train.id, day),
          scheduledDepartureMs: atMs,
        }),
      }),
    }));
  }
  for (const passenger of activeTrains) {
    const chain = program.continuationChains.get(passenger.train.id);
    if (chain === undefined) {
      throw new Error(`Personenfahrt '${passenger.train.id}' besitzt keine physische Nachfolgekette.`);
    }
    let predecessorDay = day;
    for (const continuation of chain) {
      const successorDay = predecessorDay + continuation.template.successorDayOffset;
      const predecessorFormationVersionId = physicalFormationVersionId(
        program,
        continuation.predecessor,
        predecessorDay,
      );
      const successorFormationVersionId = physicalFormationVersionId(
        program,
        continuation.successor,
        successorDay,
      );
      if (predecessorFormationVersionId !== successorFormationVersionId) {
        throw new Error(
          `Fortsetzung '${continuation.template.id}' verletzt die physische Formationspermutation.`,
        );
      }
      const successorAtMs = continuation.successor.departureOffsetMs
        + successorDay * program.repeatEveryMs;
      if (!Number.isSafeInteger(successorAtMs)) {
        throw new RangeError("Fortsetzungszeit liegt ausserhalb des sicheren Bereichs.");
      }
      const predecessorTrainId = recurringTrainId(
        continuation.predecessor.train.id,
        predecessorDay,
      );
      const successorTrainId = recurringTrainId(
        continuation.successor.train.id,
        successorDay,
      );
      const instantiated: OperationalMovementContinuation = Object.freeze({
        id: `${program.deploymentHash}:movement-continuation:${program.regionId}:${predecessorDay}:${continuation.template.id}`,
        predecessorTrainId,
        predecessorBaseRouteVersionId: continuation.template.predecessorBaseRouteVersionId,
        successor: Object.freeze({
          ...serviceOutcomeFor(continuation.successor.train, successorDay),
          id: successorTrainId,
          trainNumber: continuation.successor.train.trainNumber,
          operatorId: continuation.successor.train.operatorId,
          movementKind: continuation.successor.train.movementKind,
          routeVersionId: continuation.successor.train.routeVersionId,
          formationVersionId: predecessorFormationVersionId,
          headRouteMm: continuation.successor.train.headRouteMm,
          scheduledDepartureMs: successorAtMs,
          publicPassengerStop: continuation.successor.train.publicPassengerStop,
        }),
        successorDispatch: dispatchRequest(
          continuation.successor,
          successorTrainId,
          successorAtMs,
        ),
        notBeforeMs: successorAtMs,
        minimumDwellMs: continuation.template.minimumDwellMs,
        continuity: continuation.template.continuity,
      });
      commands.push(Object.freeze({
        commandId: `${prefix}:queue-continuation:${continuation.template.id}`,
        atMs,
        command: Object.freeze({
          type: "queue-movement-continuation",
          continuation: instantiated,
        }),
      }));
      predecessorDay = successorDay;
    }
  }
  if (dayZeroRoots.length > 0) {
    commands.push(Object.freeze({
      commandId: `${prefix}:dispatch`,
      atMs,
      command: Object.freeze({
        type: "dispatch",
        requests: Object.freeze(dayZeroRoots.map((train) => dispatchRequest(
          train,
          train.train.id,
          atMs,
        ))),
      }),
    }));
  }
  return Object.freeze(commands);
}

class PlanningInfrastructureReleaseRegistry implements PlanningInfrastructureReleaseCatalog {
  readonly #releases = new Map<string, PlanningInfrastructureRelease>();
  readonly #hashes = new Map<string, string>();

  constructor(initial: readonly unknown[]) {
    for (const release of initial) this.register(release);
  }

  register(value: unknown): PlanningInfrastructureRelease {
    const release = parsePlanningInfrastructureRelease(value);
    const key = `${release.worldId}\u0000${release.releaseId}`;
    const hash = alphaHash("zugfolge-planning-infrastructure-release/v1", release);
    const existingHash = this.#hashes.get(key);
    if (existingHash !== undefined && existingHash !== hash) {
      throw new Error(`Planning-Infrastrukturrelease '${release.releaseId}' steht fuer Welt '${release.worldId}' im Konflikt.`);
    }
    if (existingHash === undefined) {
      this.#hashes.set(key, hash);
      this.#releases.set(key, structuredClone(release));
    }
    return this.#releases.get(key)!;
  }

  get(worldId: string, releaseId: string): PlanningInfrastructureRelease | undefined {
    return this.#releases.get(`${worldId}\u0000${releaseId}`);
  }

  releaseWorld(worldId: string): void {
    const prefix = `${worldId}\u0000`;
    for (const key of this.#releases.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.#releases.delete(key);
      this.#hashes.delete(key);
    }
  }
}

export interface ActiveWorldRuntimeSeed {
  readonly activeWorlds: readonly { readonly worldId: string; readonly epoch: Date }[];
  /** Reiner nativer Preflight: validiert die externe Operational-v2-Datei und materialisiert keine Zugzustaende. */
  readonly operationalProgramPreflight: (
    initialization: OperationalSimulationInitialization,
  ) => OperationalInitializationValidationReceipt;
  readonly fleetAuthorityConfigurations?: Readonly<Record<string, FleetAuthorityWorldConfiguration>>;
  /** Legacy-Test-/Bootstrap-Pfad: fehlende Zeitbindung bedeutet ausschliesslich t=0. */
  readonly fleetAuthorityReleases?: Readonly<Record<string, FleetAuthorityRelease>>;
  readonly planningAuthorityAccountIds?: Readonly<Record<string, string>>;
  readonly planningInfrastructureReleases?: readonly unknown[];
}

/**
 * Prozesslokale Projektion ausschliesslich aktiver, signierter Weltvertraege.
 * Ihre Quellen bleiben das persistierte Deployment bzw. explizite Legacy-
 * Startkonfiguration; die Registry erfindet keine Authority-Fakten.
 */
export class ActiveWorldDeploymentRuntime implements RegionalScheduledCommandCatalog {
  readonly fleetAuthorityConfigurations: Record<string, FleetAuthorityWorldConfiguration>;
  readonly fleetAuthorityReleases: Record<string, FleetAuthorityRelease>;
  readonly planningAuthorityAccountIds: Record<string, string>;
  readonly planningInfrastructureReleases: PlanningInfrastructureReleaseCatalog;
  readonly worldEpochs = new Map<string, Date>();

  readonly #activeWorldIds = new Set<string>();
  readonly #realtimeWorldIds = new Set<string>();
  readonly #deploymentHashes = new Map<string, string>();
  readonly #realtimeRegions = new Map<string, RegionalRealtimeRegistration>();
  readonly #operationalPrograms = new Map<string, OperationalDeploymentProgram>();
  readonly #operationalInfrastructure = new Map<string, OperationalInfrastructureBinding>();
  readonly #committedOperationalProgramKeys = new Set<string>();
  readonly #planningRegistry: PlanningInfrastructureReleaseRegistry;
  readonly #operationalProgramPreflight: ActiveWorldRuntimeSeed["operationalProgramPreflight"];

  constructor(seed: ActiveWorldRuntimeSeed) {
    this.#operationalProgramPreflight = seed.operationalProgramPreflight;
    this.fleetAuthorityConfigurations = { ...(seed.fleetAuthorityConfigurations ?? {}) };
    for (const [worldId, authorityRelease] of Object.entries(seed.fleetAuthorityReleases ?? {})) {
      if (this.fleetAuthorityConfigurations[worldId] === undefined) {
        this.fleetAuthorityConfigurations[worldId] = { producedAt: 0, authorityRelease };
      }
    }
    this.fleetAuthorityReleases = Object.fromEntries(
      Object.entries(this.fleetAuthorityConfigurations).map(([worldId, configuration]) => [
        worldId,
        configuration.authorityRelease,
      ]),
    );
    this.planningAuthorityAccountIds = { ...(seed.planningAuthorityAccountIds ?? {}) };
    this.#planningRegistry = new PlanningInfrastructureReleaseRegistry(seed.planningInfrastructureReleases ?? []);
    this.planningInfrastructureReleases = this.#planningRegistry;
    for (const world of seed.activeWorlds) {
      if (Number.isNaN(world.epoch.getTime())) throw new Error(`Weltepoche fuer '${world.worldId}' ist ungueltig.`);
      this.#activeWorldIds.add(world.worldId);
      this.worldEpochs.set(world.worldId, new Date(world.epoch));
    }
  }

  /**
   * Registriert nur das nativ validierte Schedulerprogramm fuer den harten
   * Weltstart-Gate. Der Aufrufer muss bei einem vor-dauerhaften Startfehler den
   * zurueckgegebenen Lease zurueckrollen; `register` vervollstaendigt danach
   * die aktive Runtimeprojektion idempotent.
   */
  prepareOperationalProgram(signed: SignedAlphaWorldDeployment): { readonly rollback: () => void } {
    validateAlphaVehicleCatalogBinding(signed.deployment);
    const key = realtimeRegionKey(
      signed.deployment.worldId,
      signed.deployment.regionalSimulation.regionId,
    );
    const expectedInitializationHash = operationalSimulationInitializationHash(
      signed.deployment.regionalSimulation,
    );
    const existing = this.#operationalPrograms.get(key);
    if (existing !== undefined) {
      if (
        existing.deploymentHash !== signed.deploymentHash
        || existing.initializationHash !== expectedInitializationHash
      ) {
        throw new Error(`Betriebsprogramm fuer '${existing.worldId}/${existing.regionId}' steht im Konflikt.`);
      }
      return Object.freeze({ rollback: () => undefined });
    }
    const program = deploymentOperationalProgram(
      signed,
      this.#operationalProgramPreflight(signed.deployment.regionalSimulation),
    );
    this.#operationalPrograms.set(key, program);
    let owned = true;
    return Object.freeze({
      rollback: () => {
        if (
          owned
          && !this.#committedOperationalProgramKeys.has(key)
          && this.#operationalPrograms.get(key) === program
        ) {
          this.#operationalPrograms.delete(key);
        }
        owned = false;
      },
    });
  }

  operationalProgramRegistration(
    worldId: string,
    regionId: string,
  ): Readonly<{
    deploymentHash: string;
    initializationHash: string;
    trainRunIds: readonly string[];
  }> | undefined {
    const program = this.#operationalPrograms.get(realtimeRegionKey(worldId, regionId));
    if (program === undefined) return undefined;
    return Object.freeze({
      deploymentHash: program.deploymentHash,
      initializationHash: program.initializationHash,
      trainRunIds: Object.freeze(program.trains.map(({ train }) => train.id)),
    });
  }

  operationalInfrastructureBinding(
    worldId: string,
    regionId: string,
  ): OperationalInfrastructureBinding | undefined {
    const binding = this.#operationalInfrastructure.get(realtimeRegionKey(worldId, regionId));
    return binding === undefined ? undefined : Object.freeze(structuredClone(binding));
  }

  /**
   * Revalidiert ausschliesslich den bereits signierten, unveraenderten
   * Deployment-Kopf. Ein anderer Operational-v2-Kopf waere ohne gleichzeitige
   * Planning- und Livemap-Bindung ein Split-Brain und braucht deshalb ein
   * vollstaendig neues signiertes Deployment.
   */
  revalidateOperationalInfrastructure(
    worldId: string,
    expected: OperationalInfrastructureBinding,
  ): void {
    const programs = [...this.#operationalPrograms.entries()]
      .filter(([, program]) => program.worldId === worldId)
      .sort(([left], [right]) => compareUtf8(left, right));
    if (programs.length === 0) {
      throw new Error(`Aktive Welt '${worldId}' besitzt kein signiertes Operational-v2-Programm.`);
    }
    for (const [key, program] of programs) {
      const current = this.#operationalInfrastructure.get(key);
      if (
        current === undefined
        || !operationalInfrastructureBindingsEqual(current, expected)
        || !operationalInfrastructureBindingsEqual(program.initialization.infraRelease, expected)
      ) {
        throw new Error(
          `Operational-v2-Registry fuer '${program.worldId}/${program.regionId}' weicht vom signierten Deployment ab; eine Aenderung erfordert ein vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap.`,
        );
      }
      validateNativeInitializationReceipt(
        worldId,
        program.initialization,
        this.#operationalProgramPreflight(program.initialization),
      );
    }
  }

  /** Idempotente Live- oder Restart-Projektion eines bereits aktiven Deployments. */
  register(signed: SignedAlphaWorldDeployment, epoch: Date): void {
    const { deployment, deploymentHash } = signed;
    validateAlphaVehicleCatalogBinding(deployment);
    const signedEpoch = new Date(deployment.worldDefinition.epoch);
    if (Number.isNaN(epoch.getTime()) || epoch.getTime() !== signedEpoch.getTime()) {
      throw new Error(`Weltepoche fuer '${deployment.worldId}' weicht vom signierten Deployment ab.`);
    }
    const existingHash = this.#deploymentHashes.get(deployment.worldId);
    if (existingHash !== undefined && existingHash !== deploymentHash) {
      throw new Error(`Aktive Welt '${deployment.worldId}' besitzt bereits ein anderes Deployment.`);
    }
    const operationalProgramKey = realtimeRegionKey(
      deployment.worldId,
      deployment.regionalSimulation.regionId,
    );
    const expectedInitializationHash = operationalSimulationInitializationHash(
      deployment.regionalSimulation,
    );
    const preparedOperationalProgram = this.#operationalPrograms.get(operationalProgramKey);
    if (
      preparedOperationalProgram !== undefined
      && (
        preparedOperationalProgram.deploymentHash !== deploymentHash
        || preparedOperationalProgram.initializationHash !== expectedInitializationHash
      )
    ) {
      throw new Error(`Betriebsprogramm fuer '${deployment.worldId}/${deployment.regionalSimulation.regionId}' steht im Konflikt.`);
    }
    const operationalProgram = preparedOperationalProgram ?? deploymentOperationalProgram(
      signed,
      this.#operationalProgramPreflight(deployment.regionalSimulation),
    );
    const fleetHash = alphaHash("zugfolge-fleet-authority-runtime/v1", deployment.fleet.authorityRelease);
    const existingFleet = this.fleetAuthorityConfigurations[deployment.worldId];
    if (existingFleet !== undefined && (
      alphaHash("zugfolge-fleet-authority-runtime/v1", existingFleet.authorityRelease) !== fleetHash
      || existingFleet.producedAt !== deployment.fleet.producedAt
    )) {
      throw new Error(`Fleet-Authority oder Seed-Zeit fuer '${deployment.worldId}' steht im Konflikt zum signierten Deployment.`);
    }
    const authorityId = deployment.planning.authority.accountId;
    const existingAuthority = this.planningAuthorityAccountIds[deployment.worldId];
    if (existingAuthority !== undefined && existingAuthority !== authorityId) {
      throw new Error(`Planning-Authority fuer '${deployment.worldId}' steht im Konflikt zum signierten Deployment.`);
    }
    this.#planningRegistry.register(deployment.planning.infrastructureRelease);
    this.fleetAuthorityConfigurations[deployment.worldId] = {
      producedAt: deployment.fleet.producedAt,
      authorityRelease: deployment.fleet.authorityRelease,
    };
    this.fleetAuthorityReleases[deployment.worldId] = deployment.fleet.authorityRelease;
    this.planningAuthorityAccountIds[deployment.worldId] = authorityId;
    this.worldEpochs.set(deployment.worldId, new Date(epoch));
    const region = Object.freeze({
      worldId: deployment.worldId,
      regionId: deployment.regionalSimulation.regionId,
      initializationHash: operationalSimulationInitializationHash(
        deployment.regionalSimulation,
      ),
    });
    this.#realtimeRegions.set(
      realtimeRegionKey(region.worldId, region.regionId),
      region,
    );
    this.#operationalPrograms.set(operationalProgramKey, operationalProgram);
    if (!this.#operationalInfrastructure.has(operationalProgramKey)) {
      this.#operationalInfrastructure.set(
        operationalProgramKey,
        structuredClone(deployment.regionalSimulation.infraRelease),
      );
    }
    this.#committedOperationalProgramKeys.add(operationalProgramKey);
    this.#realtimeWorldIds.add(deployment.worldId);
    this.#activeWorldIds.add(deployment.worldId);
    this.#deploymentHashes.set(deployment.worldId, deploymentHash);
  }

  /** Authority v2 darf erst nach erfolgreicher Signatur- und Binderpruefung starten. */
  assertVehicleCatalogDeploymentBindings(
    signedDeployments: ReadonlyMap<string, SignedAlphaWorldDeployment>,
  ): void {
    for (const [worldId, configuration] of Object.entries(this.fleetAuthorityConfigurations)) {
      if (configuration.authorityRelease.schemaVersion !== FLEET_AUTHORITY_RELEASE_SCHEMA_V2) {
        continue;
      }
      const signed = signedDeployments.get(worldId);
      if (signed === undefined) {
        throw new Error(
          `Authority-v2 fuer '${worldId}' besitzt kein verifiziertes signiertes Fahrzeugkatalog-Deployment.`,
        );
      }
      validateAlphaVehicleCatalogBinding(signed.deployment);
      if (
        signed.deployment.worldId !== worldId
        || signed.deployment.fleet.producedAt !== configuration.producedAt
        || alphaHash("zugfolge-fleet-authority-runtime/v1", signed.deployment.fleet.authorityRelease)
          !== alphaHash("zugfolge-fleet-authority-runtime/v1", configuration.authorityRelease)
      ) {
        throw new Error(
          `Authority-v2 fuer '${worldId}' steht im Konflikt zum verifizierten signierten Deployment.`,
        );
      }
    }
  }

  worldIds(): readonly string[] {
    return [...this.#activeWorldIds].sort(compareUtf8);
  }

  /** Nur signierte 1:1-Deployments, niemals bloss restaurierte Laufzeitregionen. */
  realtimeRegions(): readonly RegionalRealtimeRegistration[] {
    return [...this.#realtimeRegions.values()].sort(
      (left, right) =>
        compareUtf8(left.worldId, right.worldId) ||
        compareUtf8(left.regionId, right.regionId),
    );
  }

  at(worldId: string, regionId: string, atMs: number): readonly OperationalScheduledCommand[] {
    const program = this.#operationalPrograms.get(realtimeRegionKey(worldId, regionId));
    if (program === undefined) return [];
    safeNonnegativeInteger(atMs, "Betriebsprogrammzeit ist ungueltig.");
    const commands: OperationalScheduledCommand[] = [];
    for (const boundary of program.boundaries) {
      if (atMs < boundary.departureOffsetMs) continue;
      const elapsed = atMs - boundary.departureOffsetMs;
      if (elapsed % program.repeatEveryMs !== 0) continue;
      commands.push(...boundaryCommands(program, boundary, elapsed / program.repeatEveryMs));
    }
    return Object.freeze(commands);
  }

  *dueBoundaries(
    worldId: string,
    regionId: string,
    afterMs: number,
    throughMs: number,
  ): IterableIterator<OperationalScheduledCommandBoundary> {
    const program = this.#operationalPrograms.get(realtimeRegionKey(worldId, regionId));
    if (program === undefined) return;
    safeNonnegativeInteger(afterMs, "Betriebsprogrammstart ist ungueltig.");
    safeNonnegativeInteger(throughMs, "Betriebsprogrammende ist ungueltig.");
    if (throughMs < afterMs) throw new RangeError("Betriebsprogrammende liegt vor dem Start.");
    const firstDay = Math.max(0, Math.floor(afterMs / program.repeatEveryMs));
    const lastDay = Math.floor(throughMs / program.repeatEveryMs);
    for (let day = firstDay; day <= lastDay; day += 1) {
      for (const boundary of program.boundaries) {
        const atMs = boundary.departureOffsetMs + day * program.repeatEveryMs;
        if (!Number.isSafeInteger(atMs)) {
          throw new RangeError("Betriebsprogrammgrenze liegt ausserhalb des sicheren Bereichs.");
        }
        if (atMs <= afterMs || atMs > throughMs) continue;
        yield Object.freeze({
          atMs,
          commands: boundaryCommands(program, boundary, day),
        });
      }
    }
  }

  /** Weltkennungen mit einem verifizierten, explizit registrierten 1:1-Takt. */
  realtimeWorldIds(): readonly string[] {
    return [...this.#realtimeWorldIds].sort(compareUtf8);
  }

  isRealtimeWorld(worldId: string): boolean {
    return this.#realtimeWorldIds.has(worldId);
  }

  /** Entfernt nur die prozesslokale Projektion einer dauerhaft archivierten Welt. */
  releaseWorld(worldId: string): void {
    const prefix = `${worldId}\u0000`;
    this.#activeWorldIds.delete(worldId);
    this.#realtimeWorldIds.delete(worldId);
    this.#deploymentHashes.delete(worldId);
    this.worldEpochs.delete(worldId);
    delete this.fleetAuthorityConfigurations[worldId];
    delete this.fleetAuthorityReleases[worldId];
    delete this.planningAuthorityAccountIds[worldId];
    this.#planningRegistry.releaseWorld(worldId);
    for (const key of this.#realtimeRegions.keys()) {
      if (key.startsWith(prefix)) this.#realtimeRegions.delete(key);
    }
    for (const key of this.#operationalPrograms.keys()) {
      if (key.startsWith(prefix)) this.#operationalPrograms.delete(key);
    }
    for (const key of this.#operationalInfrastructure.keys()) {
      if (key.startsWith(prefix)) this.#operationalInfrastructure.delete(key);
    }
    for (const key of this.#committedOperationalProgramKeys) {
      if (key.startsWith(prefix)) this.#committedOperationalProgramKeys.delete(key);
    }
  }

  /** Global freshness gilt erst ab der signierten Epoche einer Echtzeitwelt. */
  expectsLivemapFreshness(worldId: string, nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) throw new RangeError("Livemap-Pruefzeit ist ungueltig.");
    const epoch = this.worldEpochs.get(worldId);
    return this.#realtimeWorldIds.has(worldId)
      && epoch !== undefined
      && epoch.getTime() <= nowMs;
  }
}
