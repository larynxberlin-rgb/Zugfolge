import { alphaCanonicalJson, alphaHash } from "../../packages/alpha/dist/index.js";

export const DAILY_CIRCULATION_PLAN_SCHEMA = "zugfolge-daily-circulation-plan/v2";
export const DAILY_CIRCULATION_RULE = "lot-local-playable-path-cover-with-explicit-physical-transition-partition/v2";
export const DAILY_CIRCULATION_REPEAT_EVERY_S = 86_400;
export const DAILY_CIRCULATION_MINIMUM_TURNAROUND_S = 300;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value.trim() === value && value !== "", `${name} muss eine nichtleere, randfreie Zeichenkette sein.`);
  return value;
}

function safeInteger(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} ist keine sichere Ganzzahl ab ${minimum}.`);
  return value;
}

function alphaIdentifierSlug(value) {
  return String(value).normalize("NFKD").replaceAll(/\p{Diacritic}/gu, "").replaceAll(/[^a-zA-Z0-9]+/g, "-").replaceAll(/^-|-$/g, "").toLowerCase() || "linie";
}

/**
 * Weltneutrale, releasegebundene Losidentitaet. Dieselbe Funktion wird vom
 * Timetable-Compiler, Fleet-Compiler und Alpha-World-Builder verwendet.
 */
export function dailyServiceLotIdentifiers({ gtfsReleaseId, routeId, routeShortName }) {
  nonEmptyString(gtfsReleaseId, "GTFS-Release-ID fuer Loskennung");
  nonEmptyString(routeId, "GTFS-Route-ID fuer Loskennung");
  nonEmptyString(routeShortName, "GTFS-Routenname fuer Loskennung");
  const identityHash = alphaHash("zugfolge-alpha-service-lot-identity/v1", {
    gtfsReleaseId,
    routeId,
    routeShortName,
  });
  const label = alphaIdentifierSlug(routeShortName);
  return Object.freeze({
    lotId: `lot-${label}-${identityHash}`,
    serviceLineId: `line-${label}-${identityHash}`,
  });
}

export function dailyPlayableLegs(chain) {
  invariant(chain !== null && typeof chain === "object" && !Array.isArray(chain), "JourneyChain muss ein Objekt sein.");
  const legs = Array.isArray(chain.legs) ? chain.legs.filter((leg) => leg?.kind === "playable") : [];
  invariant(legs.length > 0, `${chain?.journeyChainId ?? "JourneyChain"} besitzt kein spielbares Segment.`);
  return legs;
}

export function dailyPassengerRouteVersionId(passengerLegId) {
  return `route:gtfs:${nonEmptyString(passengerLegId, "Passenger-Leg-ID")}:v1`;
}

function legEndpoint(leg, side) {
  const stops = Array.isArray(leg.stops) ? leg.stops : [];
  invariant(stops.length > 0, `${leg?.legId ?? "PlayableLeg"} besitzt keinen Halt.`);
  const stop = side === "start" ? stops[0] : stops.at(-1);
  const timeS = side === "start" ? stop.departureS : stop.arrivalS;
  safeInteger(timeS, `${leg.legId}.${side}TimeS`, 0);
  const portalId = side === "start" ? leg.entryPortalId : leg.exitPortalId;
  invariant(portalId === null || portalId === undefined || (typeof portalId === "string" && portalId !== ""), `${leg.legId}.${side}PortalId ist ungueltig.`);
  return Object.freeze({
    legId: nonEmptyString(leg.legId, `${side}LegId`),
    passengerRouteVersionId: dailyPassengerRouteVersionId(leg.legId),
    locationId: portalId ?? nonEmptyString(stop.stopId, `${leg.legId}.${side}StopId`),
    physicalStopId: nonEmptyString(stop.stopId, `${leg.legId}.${side}StopId`),
    timeS,
  });
}

function endpoint(chain, side) {
  const legs = dailyPlayableLegs(chain);
  return legEndpoint(side === "start" ? legs[0] : legs.at(-1), side);
}

function samePhysicalEndpoint(source, target) {
  return source.locationId === target.locationId && source.physicalStopId === target.physicalStopId;
}

function transitionKey(sourcePassengerLegId, targetPassengerLegId, dailyBoundary) {
  return `${sourcePassengerLegId}\u0000${targetPassengerLegId}\u0000${dailyBoundary ? "1" : "0"}`;
}

function operationalTrainRunId(chain, leg, playableIndex) {
  return playableIndex === 0 ? chain.journeyChainId : `${chain.journeyChainId}:${leg.legId}`;
}

function passengerMovements(journeyChains) {
  const movements = new Map();
  for (const chain of journeyChains) {
    for (const [playableIndex, leg] of dailyPlayableLegs(chain).entries()) {
      const stops = Array.isArray(leg.stops) ? leg.stops : [];
      invariant(stops.length > 0, `${leg.legId} besitzt keinen Halt.`);
      const id = operationalTrainRunId(chain, leg, playableIndex);
      invariant(!movements.has(id), `Passenger-Bewegung ${id} ist doppelt.`);
      movements.set(id, Object.freeze({
        trainRunId: id,
        legId: nonEmptyString(leg.legId, `${id}.legId`),
        passengerRouteVersionId: dailyPassengerRouteVersionId(leg.legId),
        sourceLocationId: leg.entryPortalId ?? nonEmptyString(stops[0].stopId, `${id}.sourceStopId`),
        targetLocationId: leg.exitPortalId ?? nonEmptyString(stops.at(-1).stopId, `${id}.targetStopId`),
        sourcePhysicalStopId: nonEmptyString(stops[0].stopId, `${id}.sourceStopId`),
        targetPhysicalStopId: nonEmptyString(stops.at(-1).stopId, `${id}.targetStopId`),
        departureS: safeInteger(stops[0].departureS, `${id}.departureS`, 0),
        arrivalS: safeInteger(stops.at(-1).arrivalS, `${id}.arrivalS`, 0),
      }));
    }
  }
  return movements;
}

/**
 * Expandiert den DailyPlan in genau eine physische Nachfolge je Passenger-
 * Bewegung. Rohphasen bleiben erhalten: eine interne Fahrt nach 24:00 kann
 * die Periodenfortschaltung tragen, waehrend ihr Rollover dann Offset 0 hat.
 */
export function dailyMovementContinuities({ dailyPlan, journeyChains }) {
  invariant(dailyPlan?.schema === DAILY_CIRCULATION_PLAN_SCHEMA, "Daily-Movement-Continuities brauchen einen v2-DailyPlan.");
  invariant(Array.isArray(journeyChains) && journeyChains.length > 0, "Daily-Movement-Continuities brauchen JourneyChains.");
  const repeatEveryS = safeInteger(dailyPlan.repeatEveryS, "DailyPlan.repeatEveryS", 1);
  const movements = passengerMovements(journeyChains);
  for (const movement of movements.values()) {
    invariant(
      movement.departureS < repeatEveryS * 2,
      `${movement.trainRunId} liegt ausserhalb der hoechstens zwei GTFS-Rohphasen.`,
    );
  }
  const circulationById = new Map(dailyPlan.circulations.map((circulation) => [circulation.id, circulation]));
  invariant(circulationById.size === dailyPlan.circulations.length, "DailyPlan besitzt doppelte Circulation-IDs.");
  const rolloverBySource = new Map(dailyPlan.rolloverAssignments.map((assignment) => [assignment.sourceCirculationId, assignment]));
  invariant(
    rolloverBySource.size === dailyPlan.circulations.length
      && new Set(dailyPlan.rolloverAssignments.map((assignment) => assignment.targetCirculationId)).size === dailyPlan.circulations.length,
    "DailyPlan besitzt keine vollstaendige Rollover-Permutation.",
  );
  invariant(Array.isArray(dailyPlan.turnaroundDemands) && Array.isArray(dailyPlan.transferDemands), "DailyPlan besitzt keine explizite Uebergangspartition.");
  const turnaroundByTransition = new Map(dailyPlan.turnaroundDemands.map((demand) => [
    transitionKey(demand.sourcePassengerLegId, demand.targetPassengerLegId, demand.dailyBoundary), demand,
  ]));
  const transferByTransition = new Map(dailyPlan.transferDemands.map((demand) => [
    transitionKey(demand.sourcePassengerLegId, demand.targetPassengerLegId, demand.dailyBoundary), demand,
  ]));
  invariant(turnaroundByTransition.size === dailyPlan.turnaroundDemands.length, "DailyPlan besitzt doppelte Turnaround-Uebergaenge.");
  invariant(transferByTransition.size === dailyPlan.transferDemands.length, "DailyPlan besitzt doppelte Transfer-Uebergaenge.");
  for (const key of turnaroundByTransition.keys()) invariant(!transferByTransition.has(key), `DailyPlan klassifiziert ${key} doppelt.`);
  const continuities = [];
  const add = ({ source, target, sourceCirculationId, targetCirculationId, relation, targetOccurrenceDepartureS, demandId = null }) => {
    const sourcePhase = Math.floor(source.departureS / repeatEveryS);
    const targetPhase = Math.floor(targetOccurrenceDepartureS / repeatEveryS);
    const successorDayOffset = targetPhase - sourcePhase;
    invariant(
      successorDayOffset === 0 || successorDayOffset === 1,
      `${source.trainRunId}->${target.trainRunId} ueberschreitet mehr als eine Rohphase.`,
    );
    invariant(targetOccurrenceDepartureS >= source.arrivalS, `${source.trainRunId}->${target.trainRunId} ist zeitlich ruecklaeufig.`);
    continuities.push(Object.freeze({
      id: `continuity-${alphaHash("zugfolge-daily-movement-continuity/v1", {
        sourceTrainRunId: source.trainRunId,
        targetTrainRunId: target.trainRunId,
        sourceCirculationId,
        targetCirculationId,
        relation,
      })}`,
      sourcePassengerTrainRunId: source.trainRunId,
      targetPassengerTrainRunId: target.trainRunId,
      sourcePassengerLegId: source.legId,
      targetPassengerLegId: target.legId,
      sourceCirculationId,
      targetCirculationId,
      sourceLocationId: source.targetLocationId,
      targetLocationId: target.sourceLocationId,
      sourceDepartureS: source.departureS,
      sourceArrivalS: source.arrivalS,
      targetDepartureS: targetOccurrenceDepartureS,
      sourcePhase,
      successorDayOffset,
      relation,
      transferDemandId: demandId,
    }));
  };
  for (const circulation of dailyPlan.circulations) {
    const ids = circulation.passengerTrainRunIds;
    invariant(Array.isArray(ids) && ids.length > 0, `${circulation.id} besitzt keine Passenger-Bewegung.`);
    for (let index = 0; index < ids.length - 1; index += 1) {
      const source = movements.get(ids[index]);
      const target = movements.get(ids[index + 1]);
      invariant(source !== undefined && target !== undefined, `${circulation.id} referenziert eine unbekannte Passenger-Bewegung.`);
      const key = transitionKey(source.legId, target.legId, false);
      const turnaround = turnaroundByTransition.get(key);
      const transfer = transferByTransition.get(key);
      invariant((turnaround === undefined) !== (transfer === undefined), `${source.trainRunId}->${target.trainRunId} besitzt keine eindeutige Uebergangsklassifikation.`);
      invariant(
        (turnaround !== undefined) === (
          source.targetLocationId === target.sourceLocationId
          && source.targetPhysicalStopId === target.sourcePhysicalStopId
        ),
        `${source.trainRunId}->${target.trainRunId} klassifiziert den physischen Uebergang falsch.`,
      );
      add({
        source,
        target,
        sourceCirculationId: circulation.id,
        targetCirculationId: circulation.id,
        relation: turnaround === undefined ? "transfer" : "same-location",
        targetOccurrenceDepartureS: target.departureS,
        demandId: transfer?.id ?? null,
      });
    }
    const rollover = rolloverBySource.get(circulation.id);
    const targetCirculation = rollover === undefined ? undefined : circulationById.get(rollover.targetCirculationId);
    const source = movements.get(ids.at(-1));
    const target = targetCirculation === undefined ? undefined : movements.get(targetCirculation.passengerTrainRunIds[0]);
    invariant(rollover !== undefined && targetCirculation !== undefined && source !== undefined && target !== undefined, `${circulation.id} besitzt keinen vollstaendigen Rollover.`);
    invariant(
      rollover.kind === "same-location" || rollover.kind === "transfer",
      `${circulation.id} besitzt eine unbekannte Rollover-Art.`,
    );
    const key = transitionKey(source.legId, target.legId, true);
    const turnaround = turnaroundByTransition.get(key);
    const demand = transferByTransition.get(key);
    invariant(
      (rollover.kind === "same-location"
        && source.targetLocationId === target.sourceLocationId
        && source.targetPhysicalStopId === target.sourcePhysicalStopId
        && turnaround !== undefined
        && demand === undefined)
        || (rollover.kind === "transfer" && turnaround === undefined && demand !== undefined),
      `${circulation.id} driftet zwischen Rollover und Transferanforderung.`,
    );
    add({
      source,
      target,
      sourceCirculationId: circulation.id,
      targetCirculationId: targetCirculation.id,
      relation: rollover.kind,
      targetOccurrenceDepartureS: target.departureS + repeatEveryS,
      demandId: demand?.id ?? null,
    });
  }
  invariant(
    continuities.length === movements.size
      && new Set(continuities.map((continuity) => continuity.sourcePassengerTrainRunId)).size === movements.size
      && new Set(continuities.map((continuity) => continuity.targetPassengerTrainRunId)).size === movements.size,
    "Daily-Movement-Continuities bilden nicht jede Passenger-Bewegung genau einmal ab.",
  );
  for (const circulation of dailyPlan.circulations) {
    const sourceIds = new Set(circulation.passengerTrainRunIds);
    const path = continuities.filter((continuity) => (
      sourceIds.has(continuity.sourcePassengerTrainRunId)
    ));
    invariant(
      path.reduce((sum, continuity) => sum + continuity.successorDayOffset, 0) === 1,
      `${circulation.id} besitzt nicht genau eine Periodenfortschaltung.`,
    );
  }
  continuities.sort((left, right) => compareText(left.id, right.id));
  return Object.freeze(continuities);
}

/**
 * Zerlegt die Tagesgrenzen-Permutation kanonisch in ihre Mehrtageszyklen.
 * Das ist absichtlich ein anderer Beleg als die 1-Tages-Pfade: Jeder Slot-
 * Pfad traegt genau eine Periodenfortschaltung, mehrere Slots koennen aber
 * durch die Rollover-Permutation zu einem gemeinsamen Zyklus gehoeren.
 */
export function dailyRolloverCycles(dailyPlan) {
  invariant(dailyPlan?.schema === DAILY_CIRCULATION_PLAN_SCHEMA, "Daily-Rollover-Cycles brauchen einen v2-DailyPlan.");
  invariant(Array.isArray(dailyPlan.circulations) && dailyPlan.circulations.length > 0, "DailyPlan besitzt keine Circulations.");
  invariant(Array.isArray(dailyPlan.rolloverAssignments), "DailyPlan besitzt keine Rollover-Zuordnungen.");
  const circulationIds = new Set(dailyPlan.circulations.map((circulation) => nonEmptyString(circulation.id, "Circulation-ID")));
  invariant(circulationIds.size === dailyPlan.circulations.length, "DailyPlan besitzt doppelte Circulation-IDs.");
  const targetBySource = new Map();
  const targets = new Set();
  for (const assignment of dailyPlan.rolloverAssignments) {
    const source = nonEmptyString(assignment?.sourceCirculationId, "Rollover.sourceCirculationId");
    const target = nonEmptyString(assignment?.targetCirculationId, "Rollover.targetCirculationId");
    invariant(circulationIds.has(source) && circulationIds.has(target), `${source}->${target} referenziert eine unbekannte Circulation.`);
    invariant(!targetBySource.has(source), `${source} besitzt mehrere Rollover-Nachfolger.`);
    invariant(!targets.has(target), `${target} besitzt mehrere Rollover-Vorgaenger.`);
    targetBySource.set(source, target);
    targets.add(target);
  }
  invariant(targetBySource.size === circulationIds.size && targets.size === circulationIds.size, "DailyPlan besitzt keine vollstaendige Rollover-Permutation.");
  const unseen = new Set(circulationIds);
  const cycles = [];
  while (unseen.size > 0) {
    const seed = [...unseen].sort(compareText)[0];
    const cycle = [];
    let current = seed;
    do {
      invariant(unseen.has(current), `${seed}-Rollover laeuft in einen fremden Zyklus.`);
      cycle.push(current);
      unseen.delete(current);
      current = targetBySource.get(current);
    } while (current !== seed);
    cycles.push(Object.freeze(cycle));
  }
  cycles.sort((left, right) => compareText(left[0], right[0]));
  return Object.freeze(cycles);
}

function freezeCirculation(value) {
  return Object.freeze({
    ...value,
    journeyChainIds: Object.freeze([...value.journeyChainIds]),
    passengerLegIds: Object.freeze([...value.passengerLegIds]),
    passengerTrainRunIds: Object.freeze([...value.passengerTrainRunIds]),
  });
}

function buildLotCirculations(chains, lotId, serviceLineId, minimumTurnaroundS) {
  const circulations = [];
  for (const chain of [...chains].sort((left, right) => {
    const order = endpoint(left, "start").timeS - endpoint(right, "start").timeS;
    return order || compareText(left.journeyChainId, right.journeyChainId);
  })) {
    const start = endpoint(chain, "start");
    const end = endpoint(chain, "end");
    const available = circulations
      .filter((circulation) => samePhysicalEndpoint(circulation.end, start)
        && circulation.end.timeS + minimumTurnaroundS <= start.timeS)
      .sort((left, right) => right.end.timeS - left.end.timeS || compareText(left.id, right.id))[0];
    const circulation = available ?? {
      id: `circulation-${lotId}-${String(circulations.length + 1).padStart(3, "0")}`,
      lotId,
      serviceLineId,
      assetCompatibilityKey: lotId,
      journeyChainIds: [],
      passengerLegIds: [],
      passengerTrainRunIds: [],
      start,
      end: start,
    };
    if (available === undefined) circulations.push(circulation);
    circulation.journeyChainIds.push(chain.journeyChainId);
    for (const [playableIndex, leg] of dailyPlayableLegs(chain).entries()) {
      circulation.passengerLegIds.push(leg.legId);
      circulation.passengerTrainRunIds.push(operationalTrainRunId(chain, leg, playableIndex));
    }
    circulation.end = end;
  }
  return circulations.map(freezeCirculation);
}

function hungarian(costs, context) {
  const count = costs.length;
  invariant(count > 0 && costs.every((row) => row.length === count), `${context} besitzt keine quadratische Kostenmatrix.`);
  const u = Array(count + 1).fill(0);
  const v = Array(count + 1).fill(0);
  const p = Array(count + 1).fill(0);
  const way = Array(count + 1).fill(0);
  for (let source = 1; source <= count; source += 1) {
    p[0] = source;
    let target0 = 0;
    const minimum = Array(count + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array(count + 1).fill(false);
    do {
      used[target0] = true;
      const source0 = p[target0];
      let delta = Number.POSITIVE_INFINITY;
      let target1 = 0;
      for (let target = 1; target <= count; target += 1) {
        if (used[target]) continue;
        const cost = costs[source0 - 1][target - 1];
        const current = cost - u[source0] - v[target];
        if (current < minimum[target]) {
          minimum[target] = current;
          way[target] = target0;
        }
        if (minimum[target] < delta) {
          delta = minimum[target];
          target1 = target;
        }
      }
      invariant(Number.isFinite(delta), `${context} besitzt kein vollstaendiges physisch zulaessiges Matching.`);
      for (let target = 0; target <= count; target += 1) {
        if (used[target]) {
          u[p[target]] += delta;
          v[target] -= delta;
        } else minimum[target] -= delta;
      }
      target0 = target1;
    } while (p[target0] !== 0);
    do {
      const target1 = way[target0];
      p[target0] = p[target1];
      target0 = target1;
    } while (target0 !== 0);
  }
  const targetBySource = Array(count).fill(-1);
  for (let target = 1; target <= count; target += 1) targetBySource[p[target] - 1] = target - 1;
  invariant(targetBySource.every((target, source) => target >= 0 && Number.isFinite(costs[source][target])), `${context} besitzt kein vollstaendiges Matching.`);
  return targetBySource;
}

function coordinateCost(source, target, stationById) {
  const sourceStation = stationById.get(source.end.physicalStopId);
  const targetStation = stationById.get(target.start.physicalStopId);
  invariant(sourceStation !== undefined, `${source.end.physicalStopId} fehlt im Stationskorpus.`);
  invariant(targetStation !== undefined, `${target.start.physicalStopId} fehlt im Stationskorpus.`);
  const cost = Math.abs(sourceStation.latitudeE7 - targetStation.latitudeE7)
    + Math.abs(sourceStation.longitudeE7 - targetStation.longitudeE7);
  safeInteger(cost, `Transferkosten ${source.id}->${target.id}`, 0);
  return cost;
}

function pairRollovers(circulations, stationById, repeatEveryS, minimumTurnaroundS, transferCost) {
  const sources = [...circulations].sort((left, right) => compareText(left.id, right.id));
  const targets = [...circulations].sort((left, right) => compareText(left.id, right.id));
  const movementCosts = sources.map((source) => targets.map((target) => {
      const targetOccurrenceS = target.start.timeS + repeatEveryS;
      if (samePhysicalEndpoint(source.end, target.start)) {
        return targetOccurrenceS - source.end.timeS >= minimumTurnaroundS ? 0 : Number.POSITIVE_INFINITY;
      }
      const earliestDepartureS = source.end.timeS + minimumTurnaroundS;
      const latestArrivalS = targetOccurrenceS - minimumTurnaroundS;
      if (latestArrivalS <= earliestDepartureS) return Number.POSITIVE_INFINITY;
      const cost = transferCost === undefined ? coordinateCost(source, target, stationById) : transferCost(Object.freeze({
        sourceCirculation: source,
        targetCirculation: target,
        sourceEndpoint: source.end,
        targetEndpoint: target.start,
        earliestDepartureS,
        latestArrivalS,
        dailyBoundary: true,
      }));
      return Number.isSafeInteger(cost) && cost >= 0 ? cost : Number.POSITIVE_INFINITY;
    }));
  const finiteCosts = movementCosts.flat().filter(Number.isFinite);
  invariant(finiteCosts.length > 0, `${circulations[0].lotId}-Rollover besitzt keine zulaessige Kante.`);
  const maximumMovementCost = Math.max(...finiteCosts);
  const crossLocationPenalty = (maximumMovementCost + 1) * (circulations.length + 1);
  safeInteger(crossLocationPenalty, `${circulations[0].lotId}-Cross-Location-Penalty`, 1);
  const costs = movementCosts.map((row, sourceIndex) => row.map((movementCost, targetIndex) => {
    if (!Number.isFinite(movementCost)) return movementCost;
    const crossPhysicalEndpoint = !samePhysicalEndpoint(sources[sourceIndex].end, targets[targetIndex].start);
    const cost = movementCost + (crossPhysicalEndpoint ? crossLocationPenalty : 0);
    return Number.isSafeInteger(cost) ? cost : Number.POSITIVE_INFINITY;
  }));
  const targetBySource = hungarian(costs, `${circulations[0].lotId}-Rollover`);
  const assignments = targetBySource.map((targetIndex, sourceIndex) => ({
    source: sources[sourceIndex],
    target: targets[targetIndex],
    transfer: !samePhysicalEndpoint(sources[sourceIndex].end, targets[targetIndex].start),
  }));
  assignments.sort((left, right) => compareText(left.source.id, right.source.id));
  invariant(new Set(assignments.map(({ source }) => source.id)).size === circulations.length, `${circulations[0].lotId} bindet nicht jede Rollover-Quelle genau einmal.`);
  invariant(new Set(assignments.map(({ target }) => target.id)).size === circulations.length, `${circulations[0].lotId} bindet nicht jedes Rollover-Ziel genau einmal.`);
  return assignments;
}

function transitionIdentity({ sourceCirculation, targetCirculation, sourceEndpoint, targetEndpoint, dailyBoundary }) {
  return Object.freeze({
    lotId: sourceCirculation.lotId,
    sourceCirculationId: sourceCirculation.id,
    targetCirculationId: targetCirculation.id,
    sourcePassengerLegId: sourceEndpoint.legId,
    targetPassengerLegId: targetEndpoint.legId,
    dailyBoundary,
  });
}

function commonTransitionDemand({
  kind,
  sourceCirculation,
  targetCirculation,
  sourceEndpoint,
  targetEndpoint,
  earliestDepartureS,
  latestArrivalS,
  dailyBoundary,
}) {
  invariant(sourceCirculation.lotId === targetCirculation.lotId, "Ein Daily-Uebergang darf kein Los wechseln.");
  invariant(sourceCirculation.assetCompatibilityKey === targetCirculation.assetCompatibilityKey, "Ein Daily-Uebergang darf die Asset-Kompatibilitaet nicht wechseln.");
  const identity = {
    ...transitionIdentity({ sourceCirculation, targetCirculation, sourceEndpoint, targetEndpoint, dailyBoundary }),
    kind,
  };
  const id = `${kind}-${alphaHash(`zugfolge-daily-${kind}-demand/v2`, identity)}`;
  invariant(latestArrivalS > earliestDepartureS, `${id} besitzt kein positives Uebergangszeitfenster.`);
  return {
    id,
    lotId: sourceCirculation.lotId,
    assetCompatibilityKey: sourceCirculation.assetCompatibilityKey,
    sourceCirculationId: sourceCirculation.id,
    targetCirculationId: targetCirculation.id,
    sourcePassengerLegId: sourceEndpoint.legId,
    targetPassengerLegId: targetEndpoint.legId,
    sourcePassengerRouteVersionId: sourceEndpoint.passengerRouteVersionId,
    targetPassengerRouteVersionId: targetEndpoint.passengerRouteVersionId,
    sourceLocationId: sourceEndpoint.locationId,
    targetLocationId: targetEndpoint.locationId,
    sourcePhysicalStopId: sourceEndpoint.physicalStopId,
    targetPhysicalStopId: targetEndpoint.physicalStopId,
    earliestDepartureS,
    latestArrivalS,
    availableWindowS: latestArrivalS - earliestDepartureS,
    dailyBoundary,
  };
}

function turnaroundDemand({ sourceCirculation, targetCirculation, sourceEndpoint, targetEndpoint, repeatEveryS, minimumTurnaroundS, dailyBoundary }) {
  invariant(samePhysicalEndpoint(sourceEndpoint, targetEndpoint), `${sourceEndpoint.legId}->${targetEndpoint.legId} ist kein physisch ortsgleicher Turnaround.`);
  const earliestDepartureS = sourceEndpoint.timeS;
  const latestArrivalS = targetEndpoint.timeS + (dailyBoundary ? repeatEveryS : 0);
  invariant(latestArrivalS - earliestDepartureS >= minimumTurnaroundS, `${sourceEndpoint.legId}->${targetEndpoint.legId} unterschreitet die Mindestwendezeit.`);
  return Object.freeze(commonTransitionDemand({
    kind: "turnaround",
    sourceCirculation,
    targetCirculation,
    sourceEndpoint,
    targetEndpoint,
    earliestDepartureS,
    latestArrivalS,
    dailyBoundary,
  }));
}

function transferDemand({ sourceCirculation, targetCirculation, sourceEndpoint, targetEndpoint, repeatEveryS, minimumTurnaroundS, dailyBoundary }) {
  invariant(!samePhysicalEndpoint(sourceEndpoint, targetEndpoint), `${sourceEndpoint.legId}->${targetEndpoint.legId} ist physisch ortsgleich und darf kein Transfer sein.`);
  const earliestDepartureS = sourceEndpoint.timeS + minimumTurnaroundS;
  const latestArrivalS = targetEndpoint.timeS + (dailyBoundary ? repeatEveryS : 0) - minimumTurnaroundS;
  return Object.freeze({
    ...commonTransitionDemand({
      kind: "transfer",
      sourceCirculation,
      targetCirculation,
      sourceEndpoint,
      targetEndpoint,
      earliestDepartureS,
      latestArrivalS,
      dailyBoundary,
    }),
    movementKind: "train",
  });
}

/**
 * Leitet den kleinsten taeglichen Fahrzeugpfad-Cover je Los ab. Die
 * Tagesgrenzen bilden eine Permutation: Ortsgleiche Enden werden maximal
 * direkt gepaart, nur die verbleibenden Multiset-Defizite werden als reale
 * Transferanforderungen ausgegeben.
 */
export function deriveDailyCirculationPlan({
  journeyChains,
  stations,
  gtfsReleaseId,
  repeatEveryS = DAILY_CIRCULATION_REPEAT_EVERY_S,
  minimumTurnaroundS = DAILY_CIRCULATION_MINIMUM_TURNAROUND_S,
  transferCost,
}) {
  invariant(Array.isArray(journeyChains) && journeyChains.length > 0, "Daily-Circulation braucht bestellbare JourneyChains.");
  invariant(Array.isArray(stations) && stations.length > 0, "Daily-Circulation braucht den Stationskorpus.");
  nonEmptyString(gtfsReleaseId, "Daily-Circulation.gtfsReleaseId");
  safeInteger(repeatEveryS, "Daily-Circulation.repeatEveryS", 1);
  safeInteger(minimumTurnaroundS, "Daily-Circulation.minimumTurnaroundS", 0);
  invariant(minimumTurnaroundS * 2 < repeatEveryS, "Daily-Circulation-Turnaround ist groesser als die Tagesperiode.");
  invariant(transferCost === undefined || typeof transferCost === "function", "Daily-Circulation.transferCost muss eine Funktion sein.");
  const stationById = new Map();
  for (const station of stations) {
    const stopId = nonEmptyString(station?.stopId, "Daily-Circulation.station.stopId");
    invariant(!stationById.has(stopId), `Daily-Circulation-Stop ${stopId} ist doppelt.`);
    safeInteger(station.latitudeE7, `${stopId}.latitudeE7`, -900_000_000);
    safeInteger(station.longitudeE7, `${stopId}.longitudeE7`, -1_800_000_000);
    stationById.set(stopId, station);
  }
  const lots = new Map();
  for (const chain of journeyChains) {
    invariant(chain?.orderable === true, `${chain?.journeyChainId ?? "JourneyChain"} ist nicht bestellbar.`);
    nonEmptyString(chain.journeyChainId, "JourneyChain.journeyChainId");
    invariant(chain.releaseId === gtfsReleaseId, `${chain.journeyChainId} besitzt eine fremde GTFS-Release-ID.`);
    const identifiers = dailyServiceLotIdentifiers({
      gtfsReleaseId,
      routeId: chain.routeId,
      routeShortName: chain.routeShortName,
    });
    const lot = lots.get(identifiers.lotId) ?? { ...identifiers, routeId: chain.routeId, routeShortName: chain.routeShortName, chains: [] };
    lot.chains.push(chain);
    lots.set(identifiers.lotId, lot);
  }
  const circulations = [];
  const rolloverAssignments = [];
  const turnaroundDemands = [];
  const transferDemands = [];
  const transferLotIds = new Set();
  const endpointsByJourneyChainId = new Map();
  for (const chain of journeyChains) {
    invariant(!endpointsByJourneyChainId.has(chain.journeyChainId), `Daily-Circulation-JourneyChain ${chain.journeyChainId} ist doppelt.`);
    endpointsByJourneyChainId.set(chain.journeyChainId, Object.freeze({ start: endpoint(chain, "start"), end: endpoint(chain, "end") }));
  }
  const addTransition = ({ sourceCirculation, targetCirculation, sourceEndpoint, targetEndpoint, dailyBoundary }) => {
    if (samePhysicalEndpoint(sourceEndpoint, targetEndpoint)) {
      turnaroundDemands.push(turnaroundDemand({
        sourceCirculation,
        targetCirculation,
        sourceEndpoint,
        targetEndpoint,
        repeatEveryS,
        minimumTurnaroundS,
        dailyBoundary,
      }));
      return "same-location";
    }
    const demand = transferDemand({
      sourceCirculation,
      targetCirculation,
      sourceEndpoint,
      targetEndpoint,
      repeatEveryS,
      minimumTurnaroundS,
      dailyBoundary,
    });
    if (transferCost !== undefined) {
      const cost = transferCost(Object.freeze({
        sourceCirculation,
        targetCirculation,
        sourceEndpoint,
        targetEndpoint,
        earliestDepartureS: demand.earliestDepartureS,
        latestArrivalS: demand.latestArrivalS,
        dailyBoundary,
      }));
      invariant(
        Number.isSafeInteger(cost) && cost >= 0,
        `${demand.id} besitzt fuer ${demand.sourcePassengerLegId}(${demand.sourcePhysicalStopId})->${demand.targetPassengerLegId}(${demand.targetPhysicalStopId}) im Fenster ${demand.earliestDepartureS}..${demand.latestArrivalS} keinen zulaessigen realen Transferlaufweg.`,
      );
    }
    transferDemands.push(demand);
    transferLotIds.add(sourceCirculation.lotId);
    return "transfer";
  };
  for (const lot of [...lots.values()].sort((left, right) => compareText(left.lotId, right.lotId))) {
    const lotCirculations = buildLotCirculations(lot.chains, lot.lotId, lot.serviceLineId, minimumTurnaroundS);
    circulations.push(...lotCirculations);
    for (const circulation of lotCirculations) {
      for (let index = 0; index < circulation.journeyChainIds.length - 1; index += 1) {
        const source = endpointsByJourneyChainId.get(circulation.journeyChainIds[index]);
        const target = endpointsByJourneyChainId.get(circulation.journeyChainIds[index + 1]);
        invariant(source !== undefined && target !== undefined, `${circulation.id} referenziert einen unbekannten internen Uebergang.`);
        addTransition({
          sourceCirculation: circulation,
          targetCirculation: circulation,
          sourceEndpoint: source.end,
          targetEndpoint: target.start,
          dailyBoundary: false,
        });
      }
    }
    for (const assignment of pairRollovers(lotCirculations, stationById, repeatEveryS, minimumTurnaroundS, transferCost)) {
      const kind = addTransition({
        sourceCirculation: assignment.source,
        targetCirculation: assignment.target,
        sourceEndpoint: assignment.source.end,
        targetEndpoint: assignment.target.start,
        dailyBoundary: true,
      });
      rolloverAssignments.push(Object.freeze({
        sourceCirculationId: assignment.source.id,
        targetCirculationId: assignment.target.id,
        kind,
      }));
      invariant((kind === "transfer") === assignment.transfer, `${assignment.source.id}->${assignment.target.id} driftet zwischen Matching und Uebergangsklassifikation.`);
    }
  }
  circulations.sort((left, right) => compareText(left.id, right.id));
  rolloverAssignments.sort((left, right) => compareText(left.sourceCirculationId, right.sourceCirculationId));
  turnaroundDemands.sort((left, right) => compareText(left.id, right.id));
  transferDemands.sort((left, right) => compareText(left.id, right.id));
  const plannedTransitionCount = circulations.reduce((sum, circulation) => sum + circulation.journeyChainIds.length, 0);
  invariant(turnaroundDemands.length + transferDemands.length === plannedTransitionCount, "Daily-Circulation partitioniert nicht jeden geplanten Uebergang genau einmal.");
  const transitionKeys = [...turnaroundDemands, ...transferDemands].map((demand) => transitionKey(
    demand.sourcePassengerLegId,
    demand.targetPassengerLegId,
    demand.dailyBoundary,
  ));
  invariant(new Set(transitionKeys).size === plannedTransitionCount, "Daily-Circulation besitzt doppelte oder fehlende Uebergangsidentitaeten.");
  const planBody = {
    schema: DAILY_CIRCULATION_PLAN_SCHEMA,
    rule: DAILY_CIRCULATION_RULE,
    gtfsReleaseId,
    repeatEveryS,
    minimumTurnaroundS,
    metrics: {
      lotCount: lots.size,
      journeyChainCount: journeyChains.length,
      circulationCount: circulations.length,
      rolloverAssignmentCount: rolloverAssignments.length,
      plannedTransitionCount,
      turnaroundDemandCount: turnaroundDemands.length,
      transferDemandCount: transferDemands.length,
      transferLotCount: transferLotIds.size,
    },
    circulations,
    rolloverAssignments,
    turnaroundDemands,
    transferDemands,
  };
  return Object.freeze({
    ...planBody,
    metrics: Object.freeze(planBody.metrics),
    circulations: Object.freeze(circulations),
    rolloverAssignments: Object.freeze(rolloverAssignments),
    turnaroundDemands: Object.freeze(turnaroundDemands),
    transferDemands: Object.freeze(transferDemands),
    planSha256: alphaHash(DAILY_CIRCULATION_PLAN_SCHEMA, JSON.parse(alphaCanonicalJson(planBody))),
  });
}
