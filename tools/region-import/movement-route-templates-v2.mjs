import { createHash } from "node:crypto";

import { alphaCanonicalJson } from "../../packages/alpha/dist/index.js";

export const MOVEMENT_ROUTE_TEMPLATES_SCHEMA = "movement-route-templates-v2";
export const MAXIMUM_DIRECT_DWELL_MS = 1_200_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const DIRECTIONS = new Set(["along", "against"]);
const CONTINUITIES = new Set(["same-direction", "reverse-direction"]);
// Der native Compiler prueft die Berth-Richtungsrelation an den echten RouteLegs;
// der Sidecar bindet nur das Ergebnis und dupliziert keine Alias-Geometrie.
const STABLING_CONTINUITY_MATRIX = Object.freeze([
  Object.freeze(["same-direction", "reverse-direction", "same-direction"]),
  Object.freeze(["same-direction", "same-direction", "same-direction"]),
]);
const MOVEMENT_KINDS = new Set(["train", "shunting"]);
const PROTECTION_SYSTEMS = new Set(["etcs-level1", "etcs-level2", "lzb", "pzb"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, name) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${name} ist kein Objekt.`);
  return value;
}

function exactKeys(value, keys, name) {
  const actual = Object.keys(record(value, name)).sort();
  const expected = [...keys].sort();
  invariant(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${name} besitzt fehlende oder unbekannte Felder.`);
}

function text(value, name) {
  invariant(typeof value === "string" && value !== "" && value.trim() === value, `${name} ist keine nichtleere, randfreie Zeichenkette.`);
  return value;
}

function integer(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} ist keine sichere Ganzzahl ab ${minimum}.`);
  return value;
}

function canonicalStringSet(value, name, { allowEmpty = false, accepted } = {}) {
  invariant(Array.isArray(value) && (allowEmpty || value.length > 0), `${name} ist keine zulaessige Liste.`);
  const copy = value.map((entry, index) => text(entry, `${name}[${index}]`));
  invariant(new Set(copy).size === copy.length && copy.every((entry, index) => index === 0 || copy[index - 1] < entry), `${name} ist nicht eindeutig kanonisch sortiert.`);
  invariant(accepted === undefined || copy.every((entry) => accepted.has(entry)), `${name} enthaelt einen unbekannten Wert.`);
  return Object.freeze(copy);
}

export function movementResourceSetSha256(resourceIds) {
  const resources = canonicalStringSet(resourceIds, "Movement-Ressourcen");
  const hash = createHash("sha256");
  for (const resource of resources) hash.update(`${resource}\n`, "utf8");
  return hash.digest("hex");
}

function interval(value, name, expectedEdgeId) {
  exactKeys(value, ["edgeId", "fromMm", "toMm"], name);
  const edgeId = text(value.edgeId, `${name}.edgeId`);
  const fromMm = integer(value.fromMm, `${name}.fromMm`, 0);
  const toMm = integer(value.toMm, `${name}.toMm`, 1);
  invariant(toMm > fromMm, `${name} ist leer oder invertiert.`);
  invariant(expectedEdgeId === undefined || edgeId === expectedEdgeId, `${name} driftet von der Zielkante ab.`);
  return Object.freeze({ edgeId, fromMm, toMm });
}

function terminalIntervals(value, formationLengthMm, name) {
  invariant(Array.isArray(value) && value.length > 0, `${name} besitzt keine terminale Formationsbelegung.`);
  const intervals = Object.freeze(value.map((entry, index) => interval(entry, `${name}[${index}]`)));
  const identities = intervals.map((entry) => `${entry.edgeId}\u0000${entry.fromMm}\u0000${entry.toMm}`);
  invariant(new Set(identities).size === identities.length, `${name} besitzt ein dupliziertes Intervall.`);
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (previous.edgeId === current.edgeId) {
      invariant(
        previous.toMm === current.fromMm || previous.fromMm === current.toMm,
        `${name} besitzt auf derselben Kante eine Luecke, Ueberlappung oder falsche Reihenfolge.`,
      );
    }
  }
  const occupiedLengthMm = intervals.reduce((sum, entry) => sum + entry.toMm - entry.fromMm, 0);
  invariant(occupiedLengthMm === formationLengthMm, `${name} bildet nicht exakt die Formation ab.`);
  return intervals;
}

function berthInterval(value, formationLengthMm, name) {
  const berth = interval(value, name);
  invariant(berth.toMm - berth.fromMm === formationLengthMm, `${name} bildet nicht exakt die Formation ab.`);
  return berth;
}

function berth(value, formationLengthMm, name) {
  exactKeys(value, ["edgeId", "fromMm", "toMm", "leftClearanceMm", "rightClearanceMm"], name);
  const occupied = berthInterval({ edgeId: value.edgeId, fromMm: value.fromMm, toMm: value.toMm }, formationLengthMm, `${name}.interval`);
  const leftClearanceMm = integer(value.leftClearanceMm, `${name}.leftClearanceMm`, 0);
  const rightClearanceMm = integer(value.rightClearanceMm, `${name}.rightClearanceMm`, 0);
  invariant(occupied.fromMm === leftClearanceMm, `${name} besitzt eine widerspruechliche linke Freilaenge.`);
  return Object.freeze({ ...occupied, leftClearanceMm, rightClearanceMm });
}

function berthAssignment(value, name) {
  exactKeys(value, ["kind", "subtype", "geometryProvenance", "operationalAssignmentProvenance"], name);
  invariant(value.geometryProvenance === "real-osm-rail", `${name} bindet keine reale OSM-Gleisgeometrie.`);
  const observed = value.kind === "observed"
    && value.subtype === "osm-service-siding"
    && value.operationalAssignmentProvenance === "observed-osm-service";
  const simulated = value.kind === "simulated-operational"
    && ["osm-service-yard", "osm-service-spur", "osm-unclassified-rail"].includes(value.subtype)
    && value.operationalAssignmentProvenance === "synthetic-operational-b-policy";
  invariant(observed || simulated, `${name} widerspricht seiner beobachteten bzw. simulierten Betriebszuordnung.`);
  return Object.freeze({ ...value });
}

function berthTransferProvenance(value, template, name) {
  exactKeys(value, ["geometryProvenance", "routingRule", "locationId", "physicalStopId", "maximumPathEdgesPerSide", "maximumPathLengthMmPerSide"], name);
  invariant(
    value.geometryProvenance === "real-osm-rail"
      && value.routingRule === "real-osm-rail-bidirectional-bounded-v1"
      && value.locationId === template.locationId
      && value.physicalStopId === template.physicalStopId,
    `${name} bindet keinen realen, ortsidentischen Cross-Berth-Laufweg.`,
  );
  integer(value.maximumPathEdgesPerSide, `${name}.maximumPathEdgesPerSide`, 1);
  integer(value.maximumPathLengthMmPerSide, `${name}.maximumPathLengthMmPerSide`, 1);
  return Object.freeze({ ...value });
}

function protectionRuns(value, routeLegCount, name) {
  invariant(Array.isArray(value) && value.length > 0, `${name} besitzt keinen Zugsicherungsvertrag.`);
  let firstIndex = 0;
  return Object.freeze(value.map((raw, index) => {
    const runName = `${name}[${index}]`;
    exactKeys(raw, ["throughRouteLegIndex", "availableProtectionSystems", "simultaneouslyRequiredProtectionSystems"], runName);
    const throughRouteLegIndex = integer(raw.throughRouteLegIndex, `${runName}.throughRouteLegIndex`, firstIndex);
    invariant(throughRouteLegIndex < routeLegCount, `${runName} laeuft ueber den Laufweg hinaus.`);
    const availableProtectionSystems = canonicalStringSet(raw.availableProtectionSystems, `${runName}.availableProtectionSystems`, { accepted: PROTECTION_SYSTEMS });
    const simultaneouslyRequiredProtectionSystems = canonicalStringSet(raw.simultaneouslyRequiredProtectionSystems, `${runName}.simultaneouslyRequiredProtectionSystems`, { allowEmpty: true, accepted: PROTECTION_SYSTEMS });
    invariant(simultaneouslyRequiredProtectionSystems.every((system) => availableProtectionSystems.includes(system)), `${runName} verlangt ein nicht verfuegbares Zugsicherungssystem.`);
    firstIndex = throughRouteLegIndex + 1;
    return Object.freeze({ throughRouteLegIndex, availableProtectionSystems, simultaneouslyRequiredProtectionSystems });
  })).map((run, index, runs) => {
    if (index + 1 === runs.length) invariant(run.throughRouteLegIndex === routeLegCount - 1, `${name} deckt nicht jeden RouteLeg ab.`);
    return run;
  });
}

function dispatch(value, formationLengthMm, name) {
  exactKeys(value, [
    "routeVersionId", "predecessorBaseRouteVersionId", "dispatchInterlockingRouteId", "headRouteMm", "minimumRuntimeMs",
    "resourceIds", "routeLegCount", "protectionContractRuns", "continuity",
  ], name);
  const routeLegCount = integer(value.routeLegCount, `${name}.routeLegCount`, 1);
  invariant(value.headRouteMm === formationLengthMm, `${name}.headRouteMm bindet nicht die Formationslaenge.`);
  invariant(CONTINUITIES.has(value.continuity), `${name}.continuity ist unbekannt.`);
  return Object.freeze({
    routeVersionId: text(value.routeVersionId, `${name}.routeVersionId`),
    predecessorBaseRouteVersionId: text(value.predecessorBaseRouteVersionId, `${name}.predecessorBaseRouteVersionId`),
    dispatchInterlockingRouteId: text(value.dispatchInterlockingRouteId, `${name}.dispatchInterlockingRouteId`),
    headRouteMm: formationLengthMm,
    minimumRuntimeMs: integer(value.minimumRuntimeMs, `${name}.minimumRuntimeMs`, 1),
    resourceIds: canonicalStringSet(value.resourceIds, `${name}.resourceIds`),
    routeLegCount,
    protectionContractRuns: protectionRuns(value.protectionContractRuns, routeLegCount, `${name}.protectionContractRuns`),
    continuity: value.continuity,
  });
}

function directTemplate(raw, index, demandById, formationLengthsMm) {
  const name = `Movement-Direct-Template[${index}]`;
  exactKeys(raw, [
    "id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId",
    "earliestDepartureS", "latestArrivalS", "availableWindowS", "dailyBoundary", "formationLengthMm",
    "terminalIntervals", "movementKind", "continuity", "maximumDwellMs", "resourceIds",
    "resourceSetSha256", "through", "outbound",
  ], name);
  const formationLengthMm = integer(raw.formationLengthMm, `${name}.formationLengthMm`, 1);
  const demand = demandById.get(raw.demandId);
  invariant(demand !== undefined && formationLengthsMm.includes(formationLengthMm), `${name} besitzt keine gebundene Turnaround-Anforderung oder Formationslaenge.`);
  invariant(
    raw.inboundRouteVersionId === demand.sourcePassengerRouteVersionId
      && raw.outboundRouteVersionId === demand.targetPassengerRouteVersionId
      && raw.locationId === demand.sourceLocationId
      && raw.locationId === demand.targetLocationId
      && raw.physicalStopId === demand.sourcePhysicalStopId
      && raw.physicalStopId === demand.targetPhysicalStopId
      && raw.earliestDepartureS === demand.earliestDepartureS
      && raw.latestArrivalS === demand.latestArrivalS
      && raw.availableWindowS === demand.availableWindowS
      && raw.dailyBoundary === demand.dailyBoundary,
    `${name} driftet von seiner autoritativen Turnaround-Anforderung ab.`,
  );
  integer(raw.earliestDepartureS, `${name}.earliestDepartureS`, 0);
  integer(raw.latestArrivalS, `${name}.latestArrivalS`, 0);
  integer(raw.availableWindowS, `${name}.availableWindowS`, 1);
  invariant(raw.latestArrivalS - raw.earliestDepartureS === raw.availableWindowS && typeof raw.dailyBoundary === "boolean", `${name} besitzt kein exaktes Turnaround-Zeitfenster.`);
  const resourceIds = canonicalStringSet(raw.resourceIds, `${name}.resourceIds`);
  invariant(raw.movementKind === "train" && CONTINUITIES.has(raw.continuity), `${name} besitzt keine zulaessige Bewegungsfortsetzung.`);
  invariant(raw.maximumDwellMs === MAXIMUM_DIRECT_DWELL_MS, `${name} verletzt die maximale Direct-Wendezeit.`);
  invariant(raw.resourceSetSha256 === movementResourceSetSha256(resourceIds), `${name} besitzt einen fremden Ressourcenhash.`);
  const through = raw.through === null ? null : dispatch(raw.through, formationLengthMm, `${name}.through`);
  const outbound = dispatch(raw.outbound, formationLengthMm, `${name}.outbound`);
  if (raw.continuity === "same-direction") {
    invariant(through !== null, `${name} besitzt keine physische Through-Bewegung.`);
    invariant(through.continuity === "same-direction" && outbound.continuity === "same-direction", `${name} besitzt keine gleichgerichtete Through-Kette.`);
    invariant(through.predecessorBaseRouteVersionId === raw.inboundRouteVersionId, `${name}.through bindet nicht die Basisroute des Vorgaengers.`);
    invariant(outbound.predecessorBaseRouteVersionId === through.routeVersionId, `${name}.outbound bindet nicht die unmittelbar vorige Through-Route.`);
  } else {
    invariant(through === null, `${name} darf bei Richtungswechsel keine Through-Doppelbefahrung besitzen.`);
    invariant(outbound.continuity === "reverse-direction", `${name}.outbound bildet die physische Richtungswende nicht ab.`);
    invariant(outbound.predecessorBaseRouteVersionId === raw.inboundRouteVersionId, `${name}.outbound bindet nicht die Basisroute des Vorgaengers.`);
  }
  return Object.freeze({
    id: text(raw.id, `${name}.id`),
    demandId: text(raw.demandId, `${name}.demandId`),
    inboundRouteVersionId: text(raw.inboundRouteVersionId, `${name}.inboundRouteVersionId`),
    outboundRouteVersionId: text(raw.outboundRouteVersionId, `${name}.outboundRouteVersionId`),
    locationId: text(raw.locationId, `${name}.locationId`),
    physicalStopId: text(raw.physicalStopId, `${name}.physicalStopId`),
    earliestDepartureS: raw.earliestDepartureS,
    latestArrivalS: raw.latestArrivalS,
    availableWindowS: raw.availableWindowS,
    dailyBoundary: raw.dailyBoundary,
    formationLengthMm,
    terminalIntervals: terminalIntervals(raw.terminalIntervals, formationLengthMm, `${name}.terminalIntervals`),
    movementKind: raw.movementKind,
    continuity: raw.continuity,
    maximumDwellMs: raw.maximumDwellMs,
    resourceIds,
    resourceSetSha256: raw.resourceSetSha256,
    through,
    outbound,
  });
}

function stablingTemplate(raw, index, demandById, formationLengthsMm) {
  const name = `Movement-Stabling-Template[${index}]`;
  exactKeys(raw, [
    "id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId",
    "earliestDepartureS", "latestArrivalS", "availableWindowS", "dailyBoundary", "terminalEdgeId",
    "terminalNodeId", "inboundDirection", "outboundDirection", "formationLengthMm", "candidateRank",
    "stablingPathLengthMm", "terminalIntervals", "stablingKind", "arrivalBerthAssignment",
    "departureBerthAssignment", "shuntIn", "arrivalBerth", "berthTransfer", "berthTransferProvenance",
    "departureBerth", "shuntOut", "outbound",
  ], name);
  const formationLengthMm = integer(raw.formationLengthMm, `${name}.formationLengthMm`, 1);
  const demand = demandById.get(raw.demandId);
  invariant(demand !== undefined && formationLengthsMm.includes(formationLengthMm), `${name} besitzt keine gebundene Turnaround-Anforderung oder Formationslaenge.`);
  invariant(
    raw.inboundRouteVersionId === demand.sourcePassengerRouteVersionId
      && raw.outboundRouteVersionId === demand.targetPassengerRouteVersionId
      && raw.locationId === demand.sourceLocationId
      && raw.locationId === demand.targetLocationId
      && raw.physicalStopId === demand.sourcePhysicalStopId
      && raw.physicalStopId === demand.targetPhysicalStopId
      && raw.earliestDepartureS === demand.earliestDepartureS
      && raw.latestArrivalS === demand.latestArrivalS
      && raw.availableWindowS === demand.availableWindowS
      && raw.dailyBoundary === demand.dailyBoundary,
    `${name} driftet vom expliziten DailyPlan-v2-Turnaround ab.`,
  );
  invariant(raw.latestArrivalS - raw.earliestDepartureS === raw.availableWindowS && typeof raw.dailyBoundary === "boolean", `${name} besitzt kein exaktes Turnaround-Zeitfenster.`);
  const terminalEdgeId = text(raw.terminalEdgeId, `${name}.terminalEdgeId`);
  invariant(DIRECTIONS.has(raw.inboundDirection) && DIRECTIONS.has(raw.outboundDirection), `${name} besitzt eine unbekannte Richtung.`);
  const arrivalBerthAssignment = berthAssignment(raw.arrivalBerthAssignment, `${name}.arrivalBerthAssignment`);
  const departureBerthAssignment = berthAssignment(raw.departureBerthAssignment, `${name}.departureBerthAssignment`);
  const arrivalBerth = berth(raw.arrivalBerth, formationLengthMm, `${name}.arrivalBerth`);
  const departureBerth = berth(raw.departureBerth, formationLengthMm, `${name}.departureBerth`);
  const shuntIn = dispatch(raw.shuntIn, formationLengthMm, `${name}.shuntIn`);
  const berthTransfer = raw.berthTransfer === null ? null : dispatch(raw.berthTransfer, formationLengthMm, `${name}.berthTransfer`);
  const shuntOut = dispatch(raw.shuntOut, formationLengthMm, `${name}.shuntOut`);
  const outbound = dispatch(raw.outbound, formationLengthMm, `${name}.outbound`);
  invariant(shuntIn.continuity === "same-direction" && outbound.continuity === "same-direction", `${name} besitzt keine physisch belegte Rangier-Fortsetzungsmatrix.`);
  invariant(shuntIn.predecessorBaseRouteVersionId === raw.inboundRouteVersionId, `${name}.shuntIn bindet nicht die Basisroute des Vorgaengers.`);
  let transferProvenance = null;
  if (raw.stablingKind === "shared-berth") {
    invariant(berthTransfer === null && raw.berthTransferProvenance === null, `${name} erfindet fuer einen Shared-Berth einen internen Transfer.`);
    invariant(alphaCanonicalJson(arrivalBerth) === alphaCanonicalJson(departureBerth) && alphaCanonicalJson(arrivalBerthAssignment) === alphaCanonicalJson(departureBerthAssignment), `${name} besitzt keinen identischen Shared-Berth.`);
    invariant(STABLING_CONTINUITY_MATRIX.some((accepted) => accepted.every((value, index) => value === [shuntIn.continuity, shuntOut.continuity, outbound.continuity][index])), `${name} besitzt keine physisch belegte Rangier-Fortsetzungsmatrix.`);
    invariant(shuntOut.predecessorBaseRouteVersionId === shuntIn.routeVersionId, `${name}.shuntOut bindet nicht die unmittelbar vorige Rangierroute.`);
  } else {
    invariant(raw.stablingKind === "cross-berth-transfer", `${name}.stablingKind ist unbekannt.`);
    invariant(berthTransfer !== null, `${name} besitzt keinen expliziten internen Berth-Transfer.`);
    transferProvenance = berthTransferProvenance(raw.berthTransferProvenance, raw, `${name}.berthTransferProvenance`);
    invariant(alphaCanonicalJson(arrivalBerth) !== alphaCanonicalJson(departureBerth), `${name} besitzt keine getrennten Ankunfts-/Abfahrts-Berths.`);
    invariant(berthTransfer.continuity === "reverse-direction" && shuntOut.continuity === "reverse-direction", `${name} besitzt keine explizite Cross-Berth-Richtungswechselkette.`);
    invariant(berthTransfer.predecessorBaseRouteVersionId === shuntIn.routeVersionId && shuntOut.predecessorBaseRouteVersionId === berthTransfer.routeVersionId, `${name} besitzt eine unterbrochene Cross-Berth-Vorgaengerkette.`);
  }
  invariant(outbound.predecessorBaseRouteVersionId === shuntOut.routeVersionId, `${name}.outbound bindet nicht die unmittelbar vorige Rangierroute.`);
  const occupiedTerminalIntervals = terminalIntervals(raw.terminalIntervals, formationLengthMm, `${name}.terminalIntervals`);
  invariant(occupiedTerminalIntervals.at(-1).edgeId === terminalEdgeId, `${name}.terminalIntervals enden nicht auf der Terminalkante.`);
  return Object.freeze({
    id: text(raw.id, `${name}.id`),
    demandId: text(raw.demandId, `${name}.demandId`),
    inboundRouteVersionId: text(raw.inboundRouteVersionId, `${name}.inboundRouteVersionId`),
    outboundRouteVersionId: text(raw.outboundRouteVersionId, `${name}.outboundRouteVersionId`),
    locationId: text(raw.locationId, `${name}.locationId`),
    physicalStopId: text(raw.physicalStopId, `${name}.physicalStopId`),
    earliestDepartureS: integer(raw.earliestDepartureS, `${name}.earliestDepartureS`, 0),
    latestArrivalS: integer(raw.latestArrivalS, `${name}.latestArrivalS`, 1),
    availableWindowS: integer(raw.availableWindowS, `${name}.availableWindowS`, 1),
    dailyBoundary: raw.dailyBoundary,
    terminalEdgeId,
    terminalNodeId: integer(raw.terminalNodeId, `${name}.terminalNodeId`),
    inboundDirection: raw.inboundDirection,
    outboundDirection: raw.outboundDirection,
    formationLengthMm,
    candidateRank: integer(raw.candidateRank, `${name}.candidateRank`, 0),
    stablingPathLengthMm: integer(raw.stablingPathLengthMm, `${name}.stablingPathLengthMm`, formationLengthMm),
    terminalIntervals: occupiedTerminalIntervals,
    stablingKind: raw.stablingKind,
    arrivalBerthAssignment,
    departureBerthAssignment,
    shuntIn,
    arrivalBerth,
    berthTransfer,
    berthTransferProvenance: transferProvenance,
    departureBerth,
    shuntOut,
    outbound,
  });
}

function transferTemplate(raw, index, demandById, routeByDemandId, formationLengthsMm) {
  const name = `Movement-Transfer-Template[${index}]`;
  exactKeys(raw, [
    "id", "demandId", "formationLengthMm", "sourcePassengerRouteVersionId",
    "targetPassengerRouteVersionId", "sourceLocationId", "targetLocationId", "earliestDepartureS",
    "latestArrivalS", "availableWindowS", "dailyBoundary", "movementKind", "transfer", "targetOutbound",
    "resourceIds", "resourceSetSha256",
  ], name);
  const demand = demandById.get(raw.demandId);
  const source = routeByDemandId.get(raw.demandId);
  const formationLengthMm = integer(raw.formationLengthMm, `${name}.formationLengthMm`, 1);
  invariant(demand !== undefined && source !== undefined && formationLengthsMm.includes(formationLengthMm), `${name} besitzt keine gebundene Transferanforderung oder Formationslaenge.`);
  invariant(
    raw.sourcePassengerRouteVersionId === source.sourcePassengerRouteVersionId
      && raw.targetPassengerRouteVersionId === source.targetPassengerRouteVersionId
      && raw.sourceLocationId === demand.sourceLocationId
      && raw.targetLocationId === demand.targetLocationId
      && raw.earliestDepartureS === demand.earliestDepartureS
      && raw.latestArrivalS === demand.latestArrivalS
      && raw.availableWindowS === demand.availableWindowS
      && raw.dailyBoundary === demand.dailyBoundary
      && typeof raw.dailyBoundary === "boolean"
      && raw.movementKind === demand.movementKind
      && MOVEMENT_KINDS.has(raw.movementKind),
    `${name} driftet vom vollstaendigen Timetable-Transfervertrag ab.`,
  );
  const resourceIds = canonicalStringSet(raw.resourceIds, `${name}.resourceIds`);
  const transfer = dispatch(raw.transfer, formationLengthMm, `${name}.transfer`);
  const targetOutbound = dispatch(raw.targetOutbound, formationLengthMm, `${name}.targetOutbound`);
  invariant(
    transfer.continuity === "same-direction" && targetOutbound.continuity === "same-direction",
    `${name} besitzt keine gleichgerichtete Transferkette.`,
  );
  invariant(transfer.predecessorBaseRouteVersionId === raw.sourcePassengerRouteVersionId, `${name}.transfer bindet nicht die Basisroute des Vorgaengers.`);
  invariant(targetOutbound.predecessorBaseRouteVersionId === transfer.routeVersionId, `${name}.targetOutbound bindet nicht die unmittelbar vorige Transferroute.`);
  invariant(transfer.resourceIds.every((resourceId) => resourceIds.includes(resourceId)), `${name} bindet nicht alle Ressourcen seiner ersten Transfer-Fahrstrasse.`);
  invariant(raw.resourceSetSha256 === movementResourceSetSha256(resourceIds), `${name} besitzt einen fremden Ressourcenhash.`);
  invariant(transfer.minimumRuntimeMs <= demand.availableWindowS * 1_000, `${name} passt nicht in sein Transferzeitfenster.`);
  return Object.freeze({
    id: text(raw.id, `${name}.id`),
    demandId: raw.demandId,
    formationLengthMm,
    sourcePassengerRouteVersionId: raw.sourcePassengerRouteVersionId,
    targetPassengerRouteVersionId: raw.targetPassengerRouteVersionId,
    sourceLocationId: raw.sourceLocationId,
    targetLocationId: raw.targetLocationId,
    earliestDepartureS: raw.earliestDepartureS,
    latestArrivalS: raw.latestArrivalS,
    availableWindowS: raw.availableWindowS,
    dailyBoundary: raw.dailyBoundary,
    movementKind: raw.movementKind,
    transfer,
    targetOutbound,
    resourceIds,
    resourceSetSha256: raw.resourceSetSha256,
  });
}

export function validateMovementRouteTemplatesV2({
  artifact,
  binding,
  infraReleaseId,
  operationalStateHash,
  timetableTransferPlan,
}) {
  exactKeys(artifact, [
    "schema", "infraReleaseId", "operationalStateHash", "timetableTransferSetSha256",
    "directTemplates", "templates", "transferTemplates", "metrics", "stateHash",
  ], "Movement-Route-Templates-v2");
  exactKeys(binding, ["file", "bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256"], "Movement-Route-Template-Bindung");
  invariant(
    artifact.schema === MOVEMENT_ROUTE_TEMPLATES_SCHEMA
      && artifact.infraReleaseId === infraReleaseId
      && artifact.operationalStateHash === operationalStateHash
      && artifact.operationalStateHash === binding.operationalStateHash
      && artifact.timetableTransferSetSha256 === timetableTransferPlan.transferSetSha256
      && artifact.timetableTransferSetSha256 === binding.timetableTransferSetSha256,
    "Movement-Route-Templates-v2 verletzt die Infra- oder Timetable-Bindung.",
  );
  invariant(Array.isArray(artifact.directTemplates) && Array.isArray(artifact.templates) && Array.isArray(artifact.transferTemplates), "Movement-Route-Templates-v2 besitzt keine Vorlagenlisten.");
  const body = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "stateHash"));
  const stateHash = createHash("sha256").update(alphaCanonicalJson({ schema: MOVEMENT_ROUTE_TEMPLATES_SCHEMA, value: body })).digest("hex");
  invariant(SHA256.test(artifact.stateHash) && artifact.stateHash === stateHash && artifact.stateHash === binding.stateHash, "Movement-Route-Templates-v2 besitzt einen fremden kanonischen State-Hash.");
  invariant(Array.isArray(timetableTransferPlan.dailyPlan.turnaroundDemands) && Array.isArray(timetableTransferPlan.dailyPlan.transferDemands), "Movement-Route-Templates-v2 besitzt keinen explizit partitionierten DailyPlan-v2.");
  const formationLengthsMm = Object.freeze([...timetableTransferPlan.formationLengthsMm]);
  const turnaroundDemandById = new Map(timetableTransferPlan.dailyPlan.turnaroundDemands.map((demand) => [demand.id, demand]));
  invariant(turnaroundDemandById.size === timetableTransferPlan.dailyPlan.turnaroundDemands.length, "DailyPlan-v2 besitzt doppelte Turnaround-Anforderungen.");
  const directTemplates = Object.freeze(artifact.directTemplates.map((raw, index) => directTemplate(raw, index, turnaroundDemandById, formationLengthsMm)));
  const templates = Object.freeze(artifact.templates.map((raw, index) => stablingTemplate(raw, index, turnaroundDemandById, formationLengthsMm)));
  const demandById = new Map(timetableTransferPlan.dailyPlan.transferDemands.map((demand) => [demand.id, demand]));
  const routeByDemandId = new Map(timetableTransferPlan.transferRoutes.map((route) => [route.id, route]));
  const transferTemplates = Object.freeze(artifact.transferTemplates.map((raw, index) => transferTemplate(raw, index, demandById, routeByDemandId, formationLengthsMm)));
  const allIds = [...directTemplates, ...templates, ...transferTemplates].map((template) => template.id);
  invariant(new Set(allIds).size === allIds.length, "Movement-Route-Templates-v2 besitzt doppelte Vorlagen-IDs.");
  const ranksByGroup = new Map();
  for (const template of templates) {
    const key = `${template.inboundRouteVersionId}\u0000${template.outboundRouteVersionId}\u0000${template.formationLengthMm}`;
    const ranks = ranksByGroup.get(key) ?? [];
    ranks.push(template.candidateRank);
    ranksByGroup.set(key, ranks);
  }
  for (const [key, ranks] of ranksByGroup) {
    ranks.sort((left, right) => left - right);
    invariant(ranks.every((rank, index) => rank === index), `Stabling-Kandidatengruppe '${key}' besitzt keine kanonisch lueckenlosen Ranks.`);
  }
  const transferKeys = transferTemplates.map((template) => `${template.demandId}\u0000${template.formationLengthMm}`);
  invariant(
    new Set(transferKeys).size === transferKeys.length
      && transferKeys.length === demandById.size * formationLengthsMm.length
      && [...demandById].every(([demandId]) => formationLengthsMm.every((lengthMm) => transferKeys.includes(`${demandId}\u0000${lengthMm}`))),
    "Movement-Route-Templates-v2 bildet nicht jede Transferanforderung je Formationslaenge genau einmal ab.",
  );
  const directGroups = new Map();
  for (const template of directTemplates) {
    const key = `${template.inboundRouteVersionId}\u0000${template.outboundRouteVersionId}`;
    const lengths = directGroups.get(key) ?? [];
    lengths.push(template.formationLengthMm);
    directGroups.set(key, lengths);
  }
  exactKeys(artifact.metrics, [
    "directTemplateCount", "stablingTemplateCount", "transferTemplateCount", "transferDemandCount",
    "turnaroundDemandCount", "plannedTransitionCount", "turnaroundPairCount", "observedStablingTemplateCount",
    "simulatedOperationalStablingTemplateCount", "berthAssignmentCounts", "crossBerthTemplateCount",
  ], "Movement-Route-Templates-v2.metrics");
  exactKeys(artifact.metrics.berthAssignmentCounts, ["observedOsmServiceSiding", "simulatedOperationalOsmServiceYard", "simulatedOperationalOsmServiceSpur", "simulatedOperationalOsmUnclassifiedRail"], "Movement-Route-Templates-v2.metrics.berthAssignmentCounts");
  for (const [field, count] of Object.entries(artifact.metrics.berthAssignmentCounts)) integer(count, `Movement-Route-Templates-v2.metrics.berthAssignmentCounts.${field}`, 0);
  for (const field of ["directTemplateCount", "stablingTemplateCount", "transferTemplateCount", "transferDemandCount", "turnaroundDemandCount", "plannedTransitionCount", "turnaroundPairCount", "observedStablingTemplateCount", "simulatedOperationalStablingTemplateCount", "crossBerthTemplateCount"]) integer(artifact.metrics[field], `Movement-Route-Templates-v2.metrics.${field}`, 0);
  const berthAssignmentCounts = { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 };
  const countAssignment = (assignment) => {
    const key = assignment.subtype === "osm-service-siding" ? "observedOsmServiceSiding"
      : assignment.subtype === "osm-service-yard" ? "simulatedOperationalOsmServiceYard"
        : assignment.subtype === "osm-service-spur" ? "simulatedOperationalOsmServiceSpur"
          : "simulatedOperationalOsmUnclassifiedRail";
    berthAssignmentCounts[key] += 1;
  };
  for (const template of templates) {
    countAssignment(template.arrivalBerthAssignment);
    if (template.stablingKind === "cross-berth-transfer") countAssignment(template.departureBerthAssignment);
  }
  const crossBerthTemplateCount = templates.filter((template) => template.stablingKind === "cross-berth-transfer").length;
  const observedStablingTemplateCount = berthAssignmentCounts.observedOsmServiceSiding;
  const simulatedOperationalStablingTemplateCount = berthAssignmentCounts.simulatedOperationalOsmServiceYard + berthAssignmentCounts.simulatedOperationalOsmServiceSpur + berthAssignmentCounts.simulatedOperationalOsmUnclassifiedRail;
  const turnaroundDemandCount = turnaroundDemandById.size;
  const plannedTransitionCount = timetableTransferPlan.dailyPlan.metrics.plannedTransitionCount;
  invariant(
    artifact.metrics.directTemplateCount === directTemplates.length
      && artifact.metrics.stablingTemplateCount === templates.length
      && artifact.metrics.transferTemplateCount === transferTemplates.length
      && artifact.metrics.transferDemandCount === demandById.size
      && artifact.metrics.turnaroundDemandCount === turnaroundDemandCount
      && artifact.metrics.plannedTransitionCount === plannedTransitionCount
      && turnaroundDemandCount + demandById.size === plannedTransitionCount
      && Number.isSafeInteger(artifact.metrics.turnaroundPairCount)
      && artifact.metrics.turnaroundPairCount >= 0
      && artifact.metrics.turnaroundPairCount <= turnaroundDemandCount
      && directGroups.size === artifact.metrics.turnaroundPairCount
      && [...directGroups.values()].every((lengths) => alphaCanonicalJson([...lengths].sort((left, right) => left - right)) === alphaCanonicalJson([...formationLengthsMm].sort((left, right) => left - right)))
      && artifact.metrics.directTemplateCount === artifact.metrics.turnaroundPairCount * formationLengthsMm.length
      && artifact.metrics.observedStablingTemplateCount === observedStablingTemplateCount
      && artifact.metrics.simulatedOperationalStablingTemplateCount === simulatedOperationalStablingTemplateCount
      && artifact.metrics.crossBerthTemplateCount === crossBerthTemplateCount
      && observedStablingTemplateCount + simulatedOperationalStablingTemplateCount === templates.length + crossBerthTemplateCount
      && alphaCanonicalJson(artifact.metrics.berthAssignmentCounts) === alphaCanonicalJson(berthAssignmentCounts),
    "Movement-Route-Templates-v2-Metriken stimmen nicht mit den gebundenen Vorlagen ueberein.",
  );
  return Object.freeze({
    schema: MOVEMENT_ROUTE_TEMPLATES_SCHEMA,
    infraReleaseId,
    operationalStateHash,
    timetableTransferSetSha256: artifact.timetableTransferSetSha256,
    directTemplates,
    templates,
    transferTemplates,
    metrics: Object.freeze({ ...artifact.metrics }),
    stateHash,
  });
}
