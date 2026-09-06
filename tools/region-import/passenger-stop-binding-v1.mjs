import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const MAX_PASSENGER_STOP_PLAN_STOPS = 100;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_RECORDS = 200_000;
const HASH = /^[a-f0-9]{64}$/u;
function invariant(value, message) { if (!value) throw new Error(message); }
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function text(value) { return typeof value === "string" && value.trim() === value && value !== ""; }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function sha256(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }

/** Additive metadata in the signed timetable artifact; old routes have no fabricated anchors. */
export function validatePassengerStopAnchors(route) {
  if (route.passengerStopAnchors === undefined) return undefined;
  const anchors = route.passengerStopAnchors;
  invariant(Array.isArray(anchors) && anchors.length >= 2 && anchors.length <= MAX_PASSENGER_STOP_PLAN_STOPS,
    "Fahrgasthaltanker verletzen die freigegebene Anzahlgrenze.");
  let previous = null;
  for (const anchor of anchors) {
    invariant(anchor !== null && typeof anchor === "object"
      && Object.keys(anchor).sort().join(",") === "direction,edgeId,offsetMm,routeMm,sourceEdgeId,sourceOffsetMm,stationId,stopSequence"
      && text(anchor.stationId) && text(anchor.edgeId) && ["along", "against"].includes(anchor.direction)
      && integer(anchor.stopSequence) && integer(anchor.offsetMm) && integer(anchor.routeMm)
      && text(anchor.sourceEdgeId) && integer(anchor.sourceOffsetMm), "Fahrgasthaltanker besitzt ungueltige Felder.");
    invariant(previous === null || anchor.stopSequence > previous.stopSequence && anchor.routeMm >= previous.routeMm,
      "Fahrgasthaltanker sind nicht nach Vorkommen und Laufweg geordnet.");
    let position = 0, found = false;
    for (const leg of route.legs) {
      const length = Math.abs(leg.edgeExitMm - leg.edgeEntryMm);
      if (leg.edgeId === anchor.edgeId && leg.direction === anchor.direction
        && anchor.offsetMm >= Math.min(leg.edgeEntryMm, leg.edgeExitMm)
        && anchor.offsetMm <= Math.max(leg.edgeEntryMm, leg.edgeExitMm)
        && position + Math.abs(anchor.offsetMm - leg.edgeEntryMm) === anchor.routeMm) found = true;
      position += length;
    }
    invariant(found, "Fahrgasthaltanker ist nicht exakt auf der gerichteten Timetable-Route belegt.");
    previous = anchor;
  }
  return Object.freeze(anchors.map((anchor) => Object.freeze({...anchor})));
}

/**
 * Read only selected map entries from the already signed native infrastructure.
 * A complete file hash fences the extraction. No Germany-sized JSON object is materialized.
 */
export async function streamPassengerStopInfrastructure(path, proof, routeIds, anchorEdgeIds) {
  invariant(routeIds instanceof Set && routeIds.size <= MAX_EVIDENCE_RECORDS && anchorEdgeIds instanceof Set,
    "Haltbelegauswahl verletzt die Infrastrukturgrenze.");
  invariant(HASH.test(proof.sha256) && integer(proof.bytes, 1) && text(proof.infraReleaseId), "Haltbelege brauchen einen signierten Infrastrukturpin.");
  const routes = new Map(), platforms = new Map(), hash = createHash("sha256"), rootFields = new Set();
  let bytes = 0, depth = 0, quoted = false, escaped = false, token = "", keepToken = false;
  let lastString = "", lastSignificant = "", rootKey = "", mapKey = "", topField = "", releaseId;
  let capture = null, captureParts = [], captureLength = 0;
  const consume = (field, key, source) => {
    invariant(Buffer.byteLength(source) <= MAX_RECORD_BYTES, "Einzelner Infrastruktur-Haltbeleg ist zu gross.");
    const value = JSON.parse(source);
    if (field === "routeVersions") {
      invariant(value.id === key && Array.isArray(value.legs), "Ausgewaehlte native Route besitzt einen falschen Bezug.");
      let routeStartMm = 0;
      const legs = value.legs.map((leg) => {
        invariant(text(leg.edgeId) && ["along", "against"].includes(leg.direction)
          && integer(leg.edgeEntryMm) && integer(leg.edgeExitMm) && leg.routeStartMm === routeStartMm
          && (leg.direction === "along" ? leg.edgeExitMm > leg.edgeEntryMm : leg.edgeExitMm < leg.edgeEntryMm),
          "Ausgewaehlte native Route besitzt keine lueckenlosen gerichteten Positionen.");
        routeStartMm += Math.abs(leg.edgeExitMm - leg.edgeEntryMm);
        invariant(integer(routeStartMm), "Native Haltbelegroute ueberschreitet den sicheren Bereich.");
        return Object.freeze({edgeId: leg.edgeId, direction: leg.direction, edgeEntryMm: leg.edgeEntryMm,
          edgeExitMm: leg.edgeExitMm, routeStartMm: leg.routeStartMm});
      });
      invariant(!routes.has(key), "Doppelte native Route im Haltbeleg."); routes.set(key, Object.freeze({id: key, legs: Object.freeze(legs)}));
    } else if (anchorEdgeIds.has(value.edgeId)) {
      invariant(text(key) && integer(value.fromMm) && integer(value.toMm, 1) && value.toMm > value.fromMm
        && ["along", "against"].includes(value.direction), "Unvollstaendiges natives Bahnsteigintervall.");
      invariant(!platforms.has(key) && platforms.size < MAX_EVIDENCE_RECORDS, "Doppelte oder zu viele Bahnsteigintervalle.");
      platforms.set(key, Object.freeze({...value}));
    }
  };
  const stream = createReadStream(path, {encoding: "utf8"});
  for await (const chunk of stream) {
    hash.update(chunk); bytes += Buffer.byteLength(chunk);
    invariant(bytes <= proof.bytes, "Infrastruktur-Haltbeleg verletzt die signierte Bytezahl.");
    let captureStart = capture === null ? null : 0;
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];
      if (quoted) {
        if (keepToken) { token += character; invariant(token.length <= MAX_RECORD_BYTES, "Infrastrukturkennung ist zu lang."); }
        if (escaped) { escaped = false; continue; }
        if (character === "\\") { escaped = true; continue; }
        if (character === '"') {
          quoted = false;
          if (keepToken) {
            lastString = JSON.parse(token);
            if (depth === 1 && rootKey === "id" && lastSignificant === ":") releaseId = lastString;
          }
          lastSignificant = '"';
        }
        continue;
      }
      if (/\s/u.test(character)) continue;
      if (character === '"') { quoted = true; keepToken = depth <= 2; token = keepToken ? '"' : ""; continue; }
      if (character === ":") {
        if (depth === 1) {
          rootKey = lastString;
          invariant(!rootFields.has(rootKey), "Doppeltes Infrastruktur-Kopffeld."); rootFields.add(rootKey);
        } else if (depth === 2) mapKey = lastString;
      }
      if (character === "{" || character === "[") {
        if (depth === 1) topField = rootKey;
        if (depth === 2 && character === "{" && (topField === "platformIntervals" || topField === "routeVersions" && routeIds.has(mapKey))) {
          capture = {field: topField, key: mapKey}; captureParts = []; captureLength = 0; captureStart = index;
        }
        depth += 1;
      } else if (character === "}" || character === "]") {
        if (depth === 3 && capture !== null) {
          captureParts.push(chunk.slice(captureStart, index + 1));
          consume(capture.field, capture.key, captureParts.join("")); capture = null; captureStart = null; captureParts = [];
        }
        depth -= 1; invariant(depth >= 0, "Infrastruktur-Haltbeleg ist unvollstaendig.");
      }
      lastSignificant = character;
    }
    if (capture !== null) {
      const part = chunk.slice(captureStart); captureParts.push(part); captureLength += part.length;
      invariant(captureLength <= MAX_RECORD_BYTES, "Einzelner Infrastruktur-Haltbeleg ist zu gross.");
    }
  }
  invariant(depth === 0 && !quoted && capture === null && rootFields.has("platformIntervals") && rootFields.has("routeVersions"),
    "Infrastruktur-Haltbeleg ist unvollstaendig.");
  invariant(bytes === proof.bytes && hash.digest("hex") === proof.sha256 && releaseId === proof.infraReleaseId,
    "Infrastruktur-Haltbeleg verletzt den signierten Release-/Byte-/Hashpin.");
  invariant(routes.size === routeIds.size, "Ein Haltplan verweist auf eine fehlende native Dispatchroute.");
  return Object.freeze({routes, platforms});
}

/** Qualify every occurrence against the actual movement route and full formation interval. */
export function bindPassengerStopPlan({passenger, materialization, timetableRoute, timetableStops, infrastructure,
  worldId, infrastructureReleaseId, timetableReleaseId, sourcePins}) {
  const anchors = validatePassengerStopAnchors(timetableRoute);
  if (anchors === undefined) return undefined;
  invariant(Array.isArray(timetableStops) && anchors.length === timetableStops.length, "Haltanker und Fahrplanvorkommen sind nicht vollstaendig gebunden.");
  invariant(materialization.id === passenger.trainRunId && materialization.publicPassengerStop === true
    && materialization.formationVersionId === passenger.formationVersionId, "Haltplan driftet von seiner Fahrt/Formation ab.");
  const route = infrastructure.routes.get(materialization.routeVersionId);
  invariant(route !== undefined, "Native Dispatchroute fuer Haltplan fehlt.");
  const length = passenger.formationLengthMm, origin = anchors[0], firstDepartureS = timetableStops[0].departureS;
  invariant(integer(length, 1) && integer(materialization.headRouteMm) && integer(materialization.scheduledDepartureMs)
    && integer(firstDepartureS), "Haltplan besitzt keine sichere Formation/Startzeit.");
  invariant(sourcePins !== null && typeof sourcePins === "object"
    && Object.keys(sourcePins).sort().join(",") === "gtfsSnapshotSha256,infrastructureStateHash,movementRouteStateHash,timetableRoutesSha256"
    && Object.values(sourcePins).every((pin) => HASH.test(pin)), "Haltplan besitzt keinen vollstaendigen Quellenpin.");
  const stops = [], platformFacts = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index], scheduled = timetableStops[index];
    invariant(anchor.stationId === scheduled.stopId && anchor.stopSequence === scheduled.stopSequence
      && integer(scheduled.arrivalS) && integer(scheduled.departureS) && scheduled.arrivalS <= scheduled.departureS,
      "Haltanker widerspricht dem gepinnten Fahrplanvorkommen.");
    const routeMm = materialization.headRouteMm + anchor.routeMm - origin.routeMm;
    if (!integer(routeMm, length) || index > 0 && routeMm <= stops.at(-1).routeMm) return undefined;
    const occupied = [];
    for (const leg of route.legs) {
      const legLength = Math.abs(leg.edgeExitMm - leg.edgeEntryMm), start = leg.routeStartMm, end = start + legLength;
      if (Math.max(start, routeMm - length) >= Math.min(end, routeMm)) continue;
      const a = leg.edgeEntryMm + (leg.direction === "along" ? 1 : -1) * (Math.max(start, routeMm - length) - start);
      const b = leg.edgeEntryMm + (leg.direction === "along" ? 1 : -1) * (Math.min(end, routeMm) - start);
      occupied.push({edgeId: leg.edgeId, direction: leg.direction, fromMm: Math.min(a, b), toMm: Math.max(a, b)});
    }
    const headMatches = route.legs.some((leg) => leg.edgeId === anchor.edgeId && leg.direction === anchor.direction
      && anchor.offsetMm >= Math.min(leg.edgeEntryMm, leg.edgeExitMm) && anchor.offsetMm <= Math.max(leg.edgeEntryMm, leg.edgeExitMm)
      && leg.routeStartMm + Math.abs(anchor.offsetMm - leg.edgeEntryMm) === routeMm);
    if (!headMatches || occupied.length === 0 || occupied.some((interval) => interval.edgeId !== anchor.edgeId || interval.direction !== anchor.direction)
      || occupied.reduce((sum, interval) => sum + interval.toMm - interval.fromMm, 0) !== length) return undefined;
    const platforms = [...infrastructure.platforms].filter(([, platform]) => platform.edgeId === anchor.edgeId
      && platform.direction === anchor.direction && occupied.every((interval) => interval.fromMm >= platform.fromMm && interval.toMm <= platform.toMm))
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    if (platforms.length !== 1) return undefined; // Ambiguous platform attribution is not evidence.
    const [platformId, platform] = platforms[0];
    const scheduledArrivalMs = materialization.scheduledDepartureMs + (scheduled.arrivalS - firstDepartureS) * 1000;
    const scheduledDepartureMs = materialization.scheduledDepartureMs + (scheduled.departureS - firstDepartureS) * 1000;
    const minimumDwellMs = (scheduled.departureS - scheduled.arrivalS) * 1000;
    invariant(integer(scheduledArrivalMs) && integer(scheduledDepartureMs) && integer(minimumDwellMs)
      && (index === 0 || scheduledArrivalMs >= stops.at(-1).scheduledDepartureMs), "Haltplanzeit ist nicht sicher und monoton.");
    stops.push({stopId: `${passenger.trainRunId}:${index}`, stationId: anchor.stationId, stopSequence: index,
      routeMm, platformId, scheduledArrivalMs, scheduledDepartureMs, minimumDwellMs});
    platformFacts.push({platformId, ...platform});
  }
  const finalLeg = route.legs.at(-1);
  if (finalLeg === undefined || stops.at(-1).routeMm !== finalLeg.routeStartMm + Math.abs(finalLeg.edgeExitMm - finalLeg.edgeEntryMm)) return undefined;
  invariant([worldId, infrastructureReleaseId, timetableReleaseId, passenger.serviceOutcome?.serviceId,
    passenger.serviceOutcome?.serviceRunId].every(text), "Haltplan besitzt unvollstaendige Welt-/Fahrtpins.");
  return Object.freeze({schemaVersion: "zugfolge-operational-passenger-stop-plan/v1", worldId,
    infrastructureReleaseId, timetableReleaseId, serviceId: passenger.serviceOutcome.serviceId,
    serviceRunId: passenger.serviceOutcome.serviceRunId, trainRunId: passenger.trainRunId,
    routeVersionId: materialization.routeVersionId,
    sourceBindingHash: sha256({sourcePins, anchors, platformFacts, formationVersionId: passenger.formationVersionId,
      formationLengthMm: length, baseRouteVersionId: timetableRoute.routeVersionId, routeVersionId: route.id}),
    stops: Object.freeze(stops.map(Object.freeze))});
}
