import { alphaHash } from "../../packages/alpha/dist/index.js";
import { operationalTrainNumberNumericPart } from "../../packages/runtime-native/dist/index.js";

import { MAXIMUM_DIRECT_DWELL_MS } from "./movement-route-templates-v2.mjs";

export const MOVEMENT_ROUTE_ALLOCATION_SCHEMA = "zugfolge-movement-route-allocation/v2";
export const MOVEMENT_PASSENGER_DWELL_MS = 300_000;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function text(value, name) {
  invariant(typeof value === "string" && value.trim() === value && value !== "", `${name} fehlt.`);
  return value;
}

function integer(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} ist keine sichere Ganzzahl ab ${minimum}.`);
  return value;
}

function passengerId(train) {
  return text(train.trainRunId ?? train.id, "Passenger-Zug-ID");
}

function baseRouteVersionId(train) {
  return text(train.baseRouteVersionId ?? train.routeVersionId, `${passengerId(train)}.baseRouteVersionId`);
}

function operatorId(train) {
  return text(train.operatorId ?? train.operator, `${passengerId(train)}.operatorId`);
}

function exactArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function stableMovementId(continuityId, role, routeVersionId) {
  return `movement-${alphaHash("zugfolge-operational-movement-train/v2", { continuityId, role, routeVersionId })}`;
}

function stableContinuationId(continuityId, stage, predecessorTrainId, successorTrainId) {
  return `continuation-${alphaHash("zugfolge-operational-movement-continuation/v2", {
    continuityId,
    stage,
    predecessorTrainId,
    successorTrainId,
  })}`;
}

function resourceReservation(resourceId, startMs, endMs, allocationId, stage) {
  invariant(endMs > startMs, `${allocationId}.${stage} besitzt ein leeres Ressourcenintervall.`);
  return Object.freeze({ kind: "resource", resourceId, startMs, endMs, allocationId, stage });
}

function trackReservation(interval, startMs, endMs, allocationId, stage) {
  invariant(endMs > startMs, `${allocationId}.${stage} besitzt ein leeres Gleisintervall.`);
  return Object.freeze({
    kind: "track",
    edgeId: interval.edgeId,
    fromMm: interval.fromMm,
    toMm: interval.toMm,
    startMs,
    endMs,
    allocationId,
    stage,
  });
}

function resources(resourceIds, startMs, endMs, allocationId, stage) {
  return resourceIds.map((resourceId) => resourceReservation(resourceId, startMs, endMs, allocationId, stage));
}

function terminalOccupancy(intervals, startMs, endMs, allocationId, stage) {
  return intervals.map((interval) => trackReservation(interval, startMs, endMs, allocationId, stage));
}

function periodicTimeOverlap(left, right, repeatEveryMs) {
  for (const shift of [-repeatEveryMs, 0, repeatEveryMs]) {
    if (Math.max(left.startMs, right.startMs + shift) < Math.min(left.endMs, right.endMs + shift)) return true;
  }
  return false;
}

function reservationsConflict(left, right, repeatEveryMs) {
  if (!periodicTimeOverlap(left, right, repeatEveryMs)) return false;
  if (left.kind === "resource" && right.kind === "resource") return left.resourceId === right.resourceId;
  return left.kind === "track"
    && right.kind === "track"
    && left.edgeId === right.edgeId
    && Math.max(left.fromMm, right.fromMm) < Math.min(left.toMm, right.toMm);
}

function reservationConflictsWithOwnPeriod(reservation, repeatEveryMs) {
  return reservation.endMs - reservation.startMs > repeatEveryMs;
}

function optionHasInternalConflict(option, repeatEveryMs) {
  return option.reservations.some((left, index) => (
    reservationConflictsWithOwnPeriod(left, repeatEveryMs)
      || option.reservations
        .slice(index + 1)
        .some((right) => reservationsConflict(left, right, repeatEveryMs))
  ));
}

function optionConflicts(option, reservations, repeatEveryMs) {
  return option.reservations.some((candidate) => reservations
    .some((existing) => reservationsConflict(candidate, existing, repeatEveryMs)));
}

function addOption(option, reservations) {
  reservations.push(...option.reservations);
  return option.reservations.length;
}

function removeOption(reservations, count) {
  reservations.splice(reservations.length - count, count);
}

function dispatchStage(continuity, role, movementKind, dispatch, scheduledDepartureMs, source) {
  integer(scheduledDepartureMs, `${continuity.id}.${role}.scheduledDepartureMs`, 0);
  return Object.freeze({
    id: stableMovementId(continuity.id, role, dispatch.routeVersionId),
    role,
    movementKind,
    dispatch,
    scheduledDepartureMs,
    sourcePassengerTrainId: passengerId(source),
    formationVersionId: source.formationVersionId,
    installedProtection: Object.freeze([...source.installedProtection]),
  });
}

function directOption({ continuity, source, target, template, sourceArrivalMs, targetDepartureMs }) {
  const allocationId = `${continuity.id}:direct:${template.id}`;
  const reservations = [
    ...resources(template.resourceIds, sourceArrivalMs, targetDepartureMs, allocationId, "direct"),
    ...terminalOccupancy(template.terminalIntervals, sourceArrivalMs, targetDepartureMs, allocationId, "terminal"),
  ];
  const stages = [];
  if (template.through !== null) {
    const throughDepartureMs = targetDepartureMs - template.through.minimumRuntimeMs;
    invariant(
      throughDepartureMs >= sourceArrivalMs + MOVEMENT_PASSENGER_DWELL_MS,
      `${continuity.id} besitzt trotz Direct-Template kein Zeitfenster fuer die physische Through-Bewegung.`,
    );
    stages.push(dispatchStage(continuity, "through", "train", template.through, throughDepartureMs, source));
  }
  return Object.freeze({
    continuity,
    source,
    target,
    kind: template.through === null ? "direct" : "through",
    templateId: template.id,
    targetDispatch: template.outbound,
    stages: Object.freeze(stages),
    reservations: Object.freeze(reservations),
  });
}

function stablingOption({ continuity, source, target, template, sourceArrivalMs, targetDepartureMs }) {
  const allocationId = `${continuity.id}:stabling:${template.id}`;
  const shuntInDepartureMs = sourceArrivalMs + MOVEMENT_PASSENGER_DWELL_MS;
  const shuntInArrivalMs = shuntInDepartureMs + template.shuntIn.minimumRuntimeMs;
  const shuntOutDepartureMs = targetDepartureMs - template.shuntOut.minimumRuntimeMs;
  const shuntOutArrivalMs = targetDepartureMs;
  invariant(
    shuntInArrivalMs <= shuntOutDepartureMs,
    `${continuity.id} passt mit ${template.id} nicht in das Abstellzeitfenster.`,
  );
  const reservations = [
    ...terminalOccupancy(template.terminalIntervals, sourceArrivalMs, shuntInArrivalMs, allocationId, "terminal-clearance"),
    ...resources(template.shuntIn.resourceIds, shuntInDepartureMs, shuntInArrivalMs, allocationId, "shunt-in"),
    trackReservation(template.berth, shuntInArrivalMs, shuntOutArrivalMs, allocationId, "berth"),
    ...resources(template.shuntOut.resourceIds, shuntOutDepartureMs, shuntOutArrivalMs, allocationId, "shunt-out"),
  ];
  return Object.freeze({
    continuity,
    source,
    target,
    kind: "stabling",
    templateId: template.id,
    candidateRank: template.candidateRank,
    targetDispatch: template.outbound,
    stages: Object.freeze([
      dispatchStage(continuity, "shunt-in", "shunting", template.shuntIn, shuntInDepartureMs, source),
      dispatchStage(continuity, "shunt-out", "shunting", template.shuntOut, shuntOutDepartureMs, source),
    ]),
    reservations: Object.freeze(reservations),
  });
}

function transferOption({ continuity, source, target, template, departureMs }) {
  const allocationId = `${continuity.id}:transfer:${template.id}`;
  const arrivalMs = departureMs + template.transfer.minimumRuntimeMs;
  return Object.freeze({
    continuity,
    source,
    target,
    kind: "transfer",
    templateId: template.id,
    targetDispatch: template.targetOutbound,
    stages: Object.freeze([
      dispatchStage(continuity, "transfer", template.movementKind, template.transfer, departureMs, source),
    ]),
    reservations: Object.freeze(resources(template.resourceIds, departureMs, arrivalMs, allocationId, "transfer")),
  });
}

function rolloverContinuityKeys(dailyPlan) {
  const circulations = new Map(dailyPlan.circulations.map((circulation) => [circulation.id, circulation]));
  invariant(circulations.size === dailyPlan.circulations.length, "DailyPlan besitzt doppelte Circulation-IDs.");
  const keys = new Set();
  for (const assignment of dailyPlan.rolloverAssignments) {
    const source = circulations.get(assignment.sourceCirculationId);
    const target = circulations.get(assignment.targetCirculationId);
    invariant(source !== undefined && target !== undefined, "DailyPlan-Rollover referenziert eine unbekannte Circulation.");
    const sourceTrainId = source.passengerTrainRunIds.at(-1);
    const targetTrainId = target.passengerTrainRunIds[0];
    invariant(typeof sourceTrainId === "string" && typeof targetTrainId === "string", "DailyPlan-Rollover besitzt keine Passenger-Endpunkte.");
    const key = `${sourceTrainId}\u0000${targetTrainId}`;
    invariant(!keys.has(key), `DailyPlan-Rollover '${key}' ist doppelt.`);
    keys.add(key);
  }
  return keys;
}

function continuityTimes(continuity, repeatEveryMs) {
  const sourcePhase = integer(continuity.sourcePhase, `${continuity.id}.sourcePhase`, 0);
  invariant(sourcePhase <= 1, `${continuity.id}.sourcePhase ueberschreitet die zwei GTFS-Rohphasen.`);
  const phaseOffsetMs = sourcePhase * repeatEveryMs;
  const sourceArrivalMs = integer(continuity.sourceArrivalS, `${continuity.id}.sourceArrivalS`, 0) * 1_000 - phaseOffsetMs;
  const targetDepartureMs = integer(continuity.targetDepartureS, `${continuity.id}.targetDepartureS`, 0) * 1_000 - phaseOffsetMs;
  invariant(sourceArrivalMs >= 0 && targetDepartureMs > sourceArrivalMs, `${continuity.id} besitzt kein positives lokales Zeitfenster.`);
  invariant(targetDepartureMs < repeatEveryMs * 2, `${continuity.id} liegt ausserhalb der zwei zulaessigen Programmphasen.`);
  return Object.freeze({ sourceArrivalMs, targetDepartureMs, phaseOffsetMs });
}

function sameLocationOptions({ continuity, source, target, movementRoutePlan, repeatEveryMs }) {
  const formationLengthMm = source.formationLengthMm;
  const inboundRouteVersionId = baseRouteVersionId(source);
  const outboundRouteVersionId = baseRouteVersionId(target);
  const { sourceArrivalMs, targetDepartureMs } = continuityTimes(continuity, repeatEveryMs);
  const dwellMs = targetDepartureMs - sourceArrivalMs;
  invariant(dwellMs >= MOVEMENT_PASSENGER_DWELL_MS, `${continuity.id} unterschreitet die physische Mindestwendezeit.`);
  const directs = movementRoutePlan.directTemplates.filter((template) => (
    template.inboundRouteVersionId === inboundRouteVersionId
      && template.outboundRouteVersionId === outboundRouteVersionId
      && template.formationLengthMm === formationLengthMm
  ));
  invariant(directs.length === 1, `${continuity.id} besitzt nicht genau ein Direct-Template fuer Paar und Formationslaenge.`);
  const options = [];
  if (dwellMs <= MAXIMUM_DIRECT_DWELL_MS) {
    options.push(directOption({ continuity, source, target, template: directs[0], sourceArrivalMs, targetDepartureMs }));
  }
  const stabling = movementRoutePlan.templates.filter((template) => (
    template.inboundRouteVersionId === inboundRouteVersionId
      && template.outboundRouteVersionId === outboundRouteVersionId
      && template.formationLengthMm === formationLengthMm
  )).sort((left, right) => left.candidateRank - right.candidateRank || compareText(left.id, right.id));
  for (const template of stabling) {
    try {
      options.push(stablingOption({ continuity, source, target, template, sourceArrivalMs, targetDepartureMs }));
    } catch (error) {
      if (!(error instanceof Error) || !/nicht in das Abstellzeitfenster/u.test(error.message)) throw error;
    }
  }
  invariant(options.length > 0, `${continuity.id} besitzt weder eine zulaessige Direct-Wende noch einen passenden Abstellpfad.`);
  return Object.freeze(options);
}

function chooseSameLocationOptions(requests, repeatEveryMs) {
  const reservations = [];
  const chosen = new Map();
  for (const request of requests) {
    for (const option of request.options) {
      invariant(!optionHasInternalConflict(option, repeatEveryMs), `${option.templateId} besitzt intern kollidierende Bewegungsbelegungen.`);
    }
  }
  const fixed = requests.filter((request) => request.options.length === 1)
    .sort((left, right) => compareText(left.continuity.id, right.continuity.id));
  for (const request of fixed) {
    const option = request.options[0];
    invariant(!optionConflicts(option, reservations, repeatEveryMs), `${request.continuity.id} kollidiert ohne alternativen Direct-/Abstellpfad.`);
    addOption(option, reservations);
    chosen.set(request.continuity.id, option);
  }
  const flexible = requests.filter((request) => request.options.length > 1)
    .sort((left, right) => left.options.length - right.options.length || compareText(left.continuity.id, right.continuity.id));
  let explored = 0;
  const search = (index) => {
    explored += 1;
    invariant(explored <= 2_000_000, "Direct-/Abstellzuweisung ueberschreitet die deterministische Suchgrenze.");
    if (index === flexible.length) return true;
    const request = flexible[index];
    for (const option of request.options) {
      if (optionConflicts(option, reservations, repeatEveryMs)) continue;
      const count = addOption(option, reservations);
      chosen.set(request.continuity.id, option);
      if (search(index + 1)) return true;
      chosen.delete(request.continuity.id);
      removeOption(reservations, count);
    }
    return false;
  };
  invariant(search(0), "Direct-/Abstellkandidaten decken die periodische physische Kapazitaet nicht konfliktfrei ab.");
  return { chosen, reservations };
}

function transferStartCandidates(earliestMs, latestMs, runtimeMs, reservations, repeatEveryMs) {
  const candidates = new Set([earliestMs, latestMs]);
  for (const reservation of reservations) {
    const minimumShift = Math.floor((earliestMs - reservation.endMs) / repeatEveryMs) - 1;
    const maximumShift = Math.ceil((latestMs + runtimeMs - reservation.startMs) / repeatEveryMs) + 1;
    for (let shiftIndex = minimumShift; shiftIndex <= maximumShift; shiftIndex += 1) {
      const shift = shiftIndex * repeatEveryMs;
      for (const candidate of [reservation.startMs + shift - runtimeMs, reservation.endMs + shift]) {
        if (candidate >= earliestMs && candidate <= latestMs) candidates.add(candidate);
      }
    }
  }
  return [...candidates].sort((left, right) => right - left);
}

function chooseTransferOptions({ requests, reservations, repeatEveryMs }) {
  const chosen = new Map();
  const ordered = [...requests].sort((left, right) => (
    left.slackMs - right.slackMs || compareText(left.continuity.id, right.continuity.id)
  ));
  let explored = 0;
  const search = (index) => {
    explored += 1;
    invariant(explored <= 2_000_000, "Transferzuweisung ueberschreitet die deterministische Suchgrenze.");
    if (index === ordered.length) return true;
    const request = ordered[index];
    for (const departureMs of transferStartCandidates(
      request.earliestDepartureMs,
      request.latestDepartureMs,
      request.template.transfer.minimumRuntimeMs,
      reservations,
      repeatEveryMs,
    )) {
      const option = transferOption({ ...request, departureMs });
      if (optionHasInternalConflict(option, repeatEveryMs) || optionConflicts(option, reservations, repeatEveryMs)) continue;
      const count = addOption(option, reservations);
      chosen.set(request.continuity.id, option);
      if (search(index + 1)) return true;
      chosen.delete(request.continuity.id);
      removeOption(reservations, count);
    }
    return false;
  };
  invariant(search(0), "Signierte Transferfenster besitzen keine konfliktfreie periodische Gesamtzuweisung.");
  return chosen;
}

function transferRequest({ continuity, source, target, movementRoutePlan, repeatEveryMs }) {
  const templates = movementRoutePlan.transferTemplates.filter((template) => (
    template.demandId === continuity.transferDemandId
      && template.formationLengthMm === source.formationLengthMm
      && template.sourcePassengerRouteVersionId === baseRouteVersionId(source)
      && template.targetPassengerRouteVersionId === baseRouteVersionId(target)
  ));
  invariant(templates.length === 1, `${continuity.id} besitzt nicht genau ein signiertes Transfer-Template.`);
  const template = templates[0];
  const { sourceArrivalMs, targetDepartureMs, phaseOffsetMs } = continuityTimes(continuity, repeatEveryMs);
  const earliestDepartureMs = Math.max(
    sourceArrivalMs + MOVEMENT_PASSENGER_DWELL_MS,
    template.earliestDepartureS * 1_000 - phaseOffsetMs,
  );
  const latestArrivalMs = Math.min(
    targetDepartureMs,
    template.latestArrivalS * 1_000 - phaseOffsetMs,
  );
  const latestDepartureMs = latestArrivalMs - template.transfer.minimumRuntimeMs;
  invariant(
    earliestDepartureMs <= latestDepartureMs,
    `${continuity.id} besitzt nach Mindestwende und Laufzeit kein Transferfenster.`,
  );
  return Object.freeze({
    continuity,
    source,
    target,
    template,
    earliestDepartureMs,
    latestDepartureMs,
    slackMs: latestDepartureMs - earliestDepartureMs,
  });
}

function movementNumberAssignments(passengerTrains, stages) {
  const used = new Set();
  for (const train of passengerTrains) {
    const number = operationalTrainNumberNumericPart(train.trainNumber);
    invariant(number !== undefined && !used.has(number), "Passenger-Zugnummern sind nicht eindeutig oder nicht operational zulaessig.");
    used.add(number);
  }
  const assignments = new Map();
  let candidate = 99_999;
  for (const stage of [...stages].sort((left, right) => compareText(left.id, right.id))) {
    while (candidate > 0 && used.has(candidate)) candidate -= 1;
    invariant(candidate > 0, "Es ist keine eindeutige fuenfstellige Bewegungszugnummer mehr frei.");
    const prefix = stage.role === "transfer" ? "Lr" : stage.dispatch.movementKind === "shunting" ? "Rf" : "Lt";
    assignments.set(stage.id, `${prefix} ${candidate}`);
    used.add(candidate);
    candidate -= 1;
  }
  return assignments;
}

function protectionModeSelection(dispatch, installedProtection, selectProtectionModeRuns, context) {
  return selectProtectionModeRuns({
    protectionContractRuns: dispatch.protectionContractRuns,
    routeLegCount: dispatch.routeLegCount,
    installedProtection,
    context,
  });
}

function continuationEdges(selection, dailyBoundary) {
  const edges = [];
  let predecessorTrainId = passengerId(selection.source);
  for (const [index, stage] of selection.stages.entries()) {
    edges.push(Object.freeze({
      id: stableContinuationId(selection.continuity.id, `movement-${index}`, predecessorTrainId, stage.id),
      predecessorTrainId,
      predecessorBaseRouteVersionId: stage.dispatch.predecessorBaseRouteVersionId,
      successorTrainId: stage.id,
      successorDayOffset: 0,
      dailyBoundary: false,
      minimumDwellMs: index === 0 ? MOVEMENT_PASSENGER_DWELL_MS : 0,
      continuity: stage.dispatch.continuity,
      successorFormation: "inherit-predecessor",
    }));
    predecessorTrainId = stage.id;
  }
  edges.push(Object.freeze({
    id: stableContinuationId(selection.continuity.id, "passenger", predecessorTrainId, passengerId(selection.target)),
    predecessorTrainId,
    predecessorBaseRouteVersionId: selection.targetDispatch.predecessorBaseRouteVersionId,
    successorTrainId: passengerId(selection.target),
    successorDayOffset: selection.continuity.successorDayOffset,
    dailyBoundary,
    minimumDwellMs: selection.stages.length === 0 ? MOVEMENT_PASSENGER_DWELL_MS : 0,
    continuity: selection.targetDispatch.continuity,
    successorFormation: "inherit-predecessor",
  }));
  return edges;
}

/**
 * Belegt den vollstaendigen DailyPlan offline mit signierten Direct-, Rangier-
 * und Transferfahrwegen. Das Ergebnis ist bereits der native Basisgraph; die
 * Laufzeit instanziiert nur noch absolute IDs/Zeiten und erbt die reale Formation.
 */
export function allocateMovementRoutePlanV2({
  dailyPlan,
  continuities,
  passengerTrains,
  movementRoutePlan,
  repeatEveryMs,
  selectProtectionModeRuns,
}) {
  integer(repeatEveryMs, "Movement-Wiederholungszeit", 1);
  invariant(typeof selectProtectionModeRuns === "function", "Movement-Allocator braucht die kanonische Zugsicherungswahl.");
  invariant(Array.isArray(continuities) && continuities.length > 0, "Movement-Allocator besitzt keine DailyPlan-Fortsetzungen.");
  invariant(Array.isArray(passengerTrains) && passengerTrains.length === continuities.length, "Movement-Allocator braucht genau einen Passenger-Templatezug je DailyPlan-Fortsetzung.");
  const passengerById = new Map(passengerTrains.map((train) => [passengerId(train), train]));
  invariant(passengerById.size === passengerTrains.length, "Movement-Allocator besitzt doppelte Passenger-Zug-IDs.");
  const incoming = new Set();
  const outgoing = new Set();
  const rolloverKeys = rolloverContinuityKeys(dailyPlan);
  const sameLocationRequests = [];
  const transferRequests = [];
  for (const continuity of continuities) {
    const source = passengerById.get(continuity.sourcePassengerTrainRunId);
    const target = passengerById.get(continuity.targetPassengerTrainRunId);
    invariant(source !== undefined && target !== undefined, `${continuity.id} referenziert einen unbekannten Passenger-Zug.`);
    invariant(!outgoing.has(passengerId(source)) && !incoming.has(passengerId(target)), `${continuity.id} verletzt die 1-in/1-out-Passenger-Permutation.`);
    outgoing.add(passengerId(source));
    incoming.add(passengerId(target));
    integer(source.formationLengthMm, `${passengerId(source)}.formationLengthMm`, 1);
    invariant(
      source.formationLengthMm === target.formationLengthMm
        && exactArray(source.installedProtection, target.installedProtection),
      `${continuity.id} verletzt Formationslaenge oder Asset-Kompatibilitaet.`,
    );
    const expectedSourceDepartureMs = continuity.sourceDepartureS * 1_000 - continuity.sourcePhase * repeatEveryMs;
    invariant(source.scheduledDepartureMs === expectedSourceDepartureMs, `${continuity.id} driftet von der Passenger-Rohphase ab.`);
    const expectedTargetDepartureMs = target.scheduledDepartureMs + continuity.successorDayOffset * repeatEveryMs;
    const actualTargetDepartureMs = continuity.targetDepartureS * 1_000 - continuity.sourcePhase * repeatEveryMs;
    invariant(expectedTargetDepartureMs === actualTargetDepartureMs, `${continuity.id} driftet von der Passenger-Zielphase ab.`);
    if (continuity.relation === "same-location") {
      sameLocationRequests.push(Object.freeze({
        continuity,
        options: sameLocationOptions({ continuity, source, target, movementRoutePlan, repeatEveryMs }),
      }));
    } else {
      invariant(continuity.relation === "transfer" && typeof continuity.transferDemandId === "string", `${continuity.id} besitzt keine bekannte physische Relation.`);
      transferRequests.push(transferRequest({ continuity, source, target, movementRoutePlan, repeatEveryMs }));
    }
  }
  invariant(incoming.size === passengerTrains.length && outgoing.size === passengerTrains.length, "Movement-Allocator bildet nicht jeden Passenger-Zug genau einmal ab.");

  const { chosen, reservations } = chooseSameLocationOptions(sameLocationRequests, repeatEveryMs);
  const chosenTransfers = chooseTransferOptions({ requests: transferRequests, reservations, repeatEveryMs });
  for (const [id, selection] of chosenTransfers) chosen.set(id, selection);
  invariant(chosen.size === continuities.length, "Movement-Allocator hat nicht jede DailyPlan-Fortsetzung belegt.");

  const passengerDispatchById = new Map();
  const stages = [];
  const movementContinuations = [];
  const allocations = [];
  let dailyBoundaryCount = 0;
  for (const continuity of [...continuities].sort((left, right) => compareText(left.id, right.id))) {
    const selection = chosen.get(continuity.id);
    invariant(selection !== undefined, `${continuity.id} besitzt keine gewaehlte Bewegungskette.`);
    const targetId = passengerId(selection.target);
    invariant(!passengerDispatchById.has(targetId), `${targetId} besitzt mehrere qualifizierte Eingangsdispatches.`);
    passengerDispatchById.set(targetId, selection.targetDispatch);
    stages.push(...selection.stages);
    const dailyBoundary = rolloverKeys.has(`${passengerId(selection.source)}\u0000${targetId}`);
    if (dailyBoundary) dailyBoundaryCount += 1;
    movementContinuations.push(...continuationEdges(selection, dailyBoundary));
    allocations.push(Object.freeze({
      continuityId: continuity.id,
      sourcePassengerTrainId: passengerId(selection.source),
      targetPassengerTrainId: targetId,
      kind: selection.kind,
      templateId: selection.templateId,
      movementTrainIds: Object.freeze(selection.stages.map((stage) => stage.id)),
      dailyBoundary,
    }));
  }
  invariant(dailyBoundaryCount === dailyPlan.rolloverAssignments.length, "Movement-Allocator driftet von den expliziten DailyPlan-Grenzen ab.");
  invariant(passengerDispatchById.size === passengerTrains.length, "Movement-Allocator qualifiziert nicht jede Passenger-Zielroute genau einmal.");

  const movementNumbers = movementNumberAssignments(passengerTrains, stages);
  const programTrains = [];
  for (const passenger of passengerTrains) {
    const id = passengerId(passenger);
    const dispatch = passengerDispatchById.get(id);
    invariant(dispatch !== undefined, `${id} besitzt keinen qualifizierten Passenger-Dispatch.`);
    programTrains.push(Object.freeze({
      id,
      trainNumber: passenger.trainNumber,
      operatorId: operatorId(passenger),
      movementKind: "train",
      routeVersionId: dispatch.routeVersionId,
      dispatchInterlockingRouteId: dispatch.dispatchInterlockingRouteId,
      formationVersionId: passenger.formationVersionId,
      headRouteMm: dispatch.headRouteMm,
      scheduledDepartureMs: passenger.scheduledDepartureMs,
      publicPassengerStop: true,
      protectionModeSelectionRuns: protectionModeSelection(
        dispatch,
        passenger.installedProtection,
        selectProtectionModeRuns,
        `Passenger-Zielroute '${id}'`,
      ),
    }));
  }
  for (const stage of stages) {
    programTrains.push(Object.freeze({
      id: stage.id,
      trainNumber: movementNumbers.get(stage.id),
      operatorId: operatorId(passengerById.get(stage.sourcePassengerTrainId)),
      movementKind: stage.movementKind,
      routeVersionId: stage.dispatch.routeVersionId,
      dispatchInterlockingRouteId: stage.dispatch.dispatchInterlockingRouteId,
      formationVersionId: stage.formationVersionId,
      headRouteMm: stage.dispatch.headRouteMm,
      scheduledDepartureMs: stage.scheduledDepartureMs,
      publicPassengerStop: false,
      protectionModeSelectionRuns: protectionModeSelection(
        stage.dispatch,
        stage.installedProtection,
        selectProtectionModeRuns,
        `Movement-Zielroute '${stage.id}'`,
      ),
    }));
  }
  programTrains.sort((left, right) => left.scheduledDepartureMs - right.scheduledDepartureMs || compareText(left.id, right.id));
  movementContinuations.sort((left, right) => compareText(left.id, right.id));
  allocations.sort((left, right) => compareText(left.continuityId, right.continuityId));
  reservations.sort((left, right) => left.startMs - right.startMs || compareText(left.allocationId, right.allocationId) || compareText(left.stage, right.stage));
  invariant(
    movementContinuations.length === programTrains.length,
    "Movement-Allocator erzeugt keinen vollstaendigen 1-in/1-out-Basisgraphen.",
  );
  return Object.freeze({
    schema: MOVEMENT_ROUTE_ALLOCATION_SCHEMA,
    programTrains: Object.freeze(programTrains),
    movementContinuations: Object.freeze(movementContinuations),
    allocations: Object.freeze(allocations),
    reservations: Object.freeze(reservations),
    metrics: Object.freeze({
      passengerTrainCount: passengerTrains.length,
      movementTrainCount: stages.length,
      directCount: allocations.filter((entry) => entry.kind === "direct").length,
      throughCount: allocations.filter((entry) => entry.kind === "through").length,
      stablingCount: allocations.filter((entry) => entry.kind === "stabling").length,
      transferCount: allocations.filter((entry) => entry.kind === "transfer").length,
      dailyBoundaryCount,
      reservationCount: reservations.length,
    }),
  });
}
