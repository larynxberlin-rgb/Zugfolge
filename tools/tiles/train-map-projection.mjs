import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

export const TRAIN_MAP_PROJECTION_SCHEMA = "zugfolge-train-map-projection/v1";
export const TRAIN_MAP_PROJECTION_REPORT_SCHEMA = "zugfolge-train-map-projection-report/v1";
export const TRAIN_MAP_PROJECTION_BUILD_SPEC_SCHEMA = "zugfolge-train-map-projection-build-spec/v1";
export const TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID = 0x5a54504a;
export const TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION = 1;
export const TRAIN_MAP_PROJECTION_SCHEMA_SQL_SHA256 = "08ca2d8778bfa648b30838620c107f050be1e56fcf3efd8809a623b36519390d";
export const TRAIN_MAP_PROJECTION_PUBLIC_TABLES = Object.freeze({
  metadata: Object.freeze(["key", "value"]),
  track_geometries: Object.freeze(["world_id", "infrastructure_release_id", "track_id", "length_mm", "geometry_json"]),
  resource_track_spans: Object.freeze([
    "world_id", "infrastructure_release_id", "resource_id", "resource_start_mm", "resource_end_mm",
    "track_id", "track_start_offset_mm", "track_end_offset_mm", "is_resource_end",
  ]),
  train_resource_spans: Object.freeze([
    "world_id", "infrastructure_release_id", "train_id", "position_start_mm", "position_end_mm",
    "resource_id", "is_train_end",
  ]),
});
export const TRAIN_MAP_PROJECTION_PUBLIC_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({ type: "index", name: "resource_track_lookup", table: "resource_track_spans" }),
  Object.freeze({ type: "index", name: "train_position_lookup", table: "train_resource_spans" }),
  Object.freeze({ type: "table", name: "metadata", table: "metadata" }),
  Object.freeze({ type: "table", name: "resource_track_spans", table: "resource_track_spans" }),
  Object.freeze({ type: "table", name: "track_geometries", table: "track_geometries" }),
  Object.freeze({ type: "table", name: "train_resource_spans", table: "train_resource_spans" }),
]);

const EARTH_RADIUS_M = 6_378_137;
const MAX_TRACK_TO_CORRIDOR_DISTANCE_M = 40;
const MAX_STATION_ANCHOR_DISTANCE_M = 2_500;
const MIN_ORIENTATION_ADVANTAGE_M = 100;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value, name) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${name} muss ein Objekt sein.`);
  return value;
}

function list(value, name) {
  invariant(Array.isArray(value), `${name} muss eine Liste sein.`);
  return value;
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value.length > 0, `${name} muss eine nichtleere Zeichenkette sein.`);
  return value;
}

function safeInteger(value, name, minimum = 0) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} muss eine sichere Ganzzahl ab ${minimum} sein.`);
  return value;
}

function parseSequenceLine(raw, label) {
  const line = raw.replace(/^\x1e/u, "").trim();
  if (line === "") return null;
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${label} enthaelt ungueltiges JSON: ${error.message}`);
  }
}

async function* readSequence(path, label) {
  let lineNumber = 0;
  for await (const raw of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
    lineNumber += 1;
    const value = parseSequenceLine(raw, `${label}, Zeile ${lineNumber}`);
    if (value !== null) yield value;
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON: ${error.message}`);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function mercator(longitudeE7, latitudeE7) {
  const longitude = longitudeE7 / 10_000_000;
  const latitude = latitudeE7 / 10_000_000;
  invariant(longitude >= -180 && longitude <= 180 && latitude >= -85 && latitude <= 85, "Koordinate liegt ausserhalb WebMercator.");
  const longitudeRadians = longitude * Math.PI / 180;
  const latitudeRadians = latitude * Math.PI / 180;
  return [
    EARTH_RADIUS_M * longitudeRadians,
    EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)),
  ];
}

function coordinateE7(value, name) {
  invariant(Array.isArray(value) && value.length >= 2, `${name} ist keine Koordinate.`);
  invariant(Number.isFinite(value[0]) && Number.isFinite(value[1]), `${name} ist nicht endlich.`);
  const longitudeE7 = Math.round(value[0] * 10_000_000);
  const latitudeE7 = Math.round(value[1] * 10_000_000);
  safeInteger(Math.abs(longitudeE7), `${name}.longitudeE7`);
  safeInteger(Math.abs(latitudeE7), `${name}.latitudeE7`);
  invariant(longitudeE7 >= -1_800_000_000 && longitudeE7 <= 1_800_000_000, `${name}.longitudeE7 liegt ausserhalb der Erde.`);
  invariant(latitudeE7 >= -900_000_000 && latitudeE7 <= 900_000_000, `${name}.latitudeE7 liegt ausserhalb der Erde.`);
  return Object.freeze({ longitudeE7, latitudeE7 });
}

function lineCoordinates(geometry, name) {
  const value = record(geometry, name);
  if (value.type === "LineString") return list(value.coordinates, `${name}.coordinates`);
  if (value.type === "MultiLineString") {
    const lines = list(value.coordinates, `${name}.coordinates`);
    invariant(lines.length === 1, `${name} ist mehrteilig und deshalb nicht eindeutig kilometrierbar.`);
    return list(lines[0], `${name}.coordinates[0]`);
  }
  throw new Error(`${name} besitzt keine Liniengeometrie.`);
}

function planarPolyline(rawCoordinates, name) {
  const coordinates = rawCoordinates.map((coordinate, index) => coordinateE7(coordinate, `${name}[${index}]`));
  invariant(coordinates.length >= 2, `${name} braucht mindestens zwei Punkte.`);
  const projected = coordinates.map(({ longitudeE7, latitudeE7 }) => mercator(longitudeE7, latitudeE7));
  const cumulative = [0];
  for (let index = 1; index < projected.length; index += 1) {
    const previous = projected[index - 1];
    const current = projected[index];
    cumulative.push(cumulative.at(-1) + Math.hypot(current[0] - previous[0], current[1] - previous[1]));
  }
  invariant(cumulative.at(-1) > 0, `${name} besitzt keine positive Laenge.`);
  return { coordinates, projected, cumulative, lengthM: cumulative.at(-1) };
}

function pointAtAlong(polyline, alongM) {
  const target = Math.max(0, Math.min(polyline.lengthM, alongM));
  let index = 1;
  while (index < polyline.cumulative.length && polyline.cumulative[index] < target) index += 1;
  const endIndex = Math.min(index, polyline.cumulative.length - 1);
  const startIndex = Math.max(0, endIndex - 1);
  const startAlong = polyline.cumulative[startIndex];
  const endAlong = polyline.cumulative[endIndex];
  const fraction = endAlong === startAlong ? 0 : (target - startAlong) / (endAlong - startAlong);
  const start = polyline.projected[startIndex];
  const end = polyline.projected[endIndex];
  return [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
}

function squaredDistance(left, right) {
  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  return dx * dx + dy * dy;
}

function nearestAlong(polyline, point) {
  let bestDistanceSquared = Infinity;
  let bestAlongM = 0;
  for (let index = 1; index < polyline.projected.length; index += 1) {
    const start = polyline.projected[index - 1];
    const end = polyline.projected[index];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const denominator = dx * dx + dy * dy;
    const fraction = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator));
    const projected = [start[0] + dx * fraction, start[1] + dy * fraction];
    const distance = squaredDistance(point, projected);
    if (distance < bestDistanceSquared) {
      bestDistanceSquared = distance;
      bestAlongM = polyline.cumulative[index - 1] + Math.sqrt(denominator) * fraction;
    }
  }
  return { alongM: bestAlongM, distanceM: Math.sqrt(bestDistanceSquared) };
}

function distanceMetres(left, right) {
  return Math.sqrt(squaredDistance(mercator(left.longitudeE7, left.latitudeE7), mercator(right.longitudeE7, right.latitudeE7)));
}

function normalizedBearingMilliDegrees(start, end) {
  const latitude1 = start.latitudeE7 / 10_000_000 * Math.PI / 180;
  const latitude2 = end.latitudeE7 / 10_000_000 * Math.PI / 180;
  const deltaLongitude = (end.longitudeE7 - start.longitudeE7) / 10_000_000 * Math.PI / 180;
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);
  const x = Math.cos(latitude1) * Math.sin(latitude2) - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude);
  const degrees = Math.atan2(y, x) * 180 / Math.PI;
  return Math.round(((degrees % 360) + 360) % 360 * 1_000) % 360_000;
}

function geometryVertices(rawCoordinates, declaredLengthMm, name) {
  const polyline = planarPolyline(rawCoordinates, name);
  const vertices = polyline.coordinates.map((coordinate, index) => ({
    ...coordinate,
    offsetMm: index === polyline.coordinates.length - 1
      ? declaredLengthMm
      : Math.round(declaredLengthMm * polyline.cumulative[index] / polyline.lengthM),
    ...(index === polyline.coordinates.length - 1
      ? {}
      : { bearingMilliDegrees: normalizedBearingMilliDegrees(coordinate, polyline.coordinates[index + 1]) }),
  }));
  for (let index = 1; index < vertices.length; index += 1) {
    invariant(vertices[index].offsetMm > vertices[index - 1].offsetMm, `${name} kollabiert nach Ganzzahlquantisierung.`);
  }
  return { polyline, vertices: Object.freeze(vertices) };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function roundRatio(numerator, denominator) {
  invariant(Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0, "Ungueltige Interpolation.");
  return Math.round(numerator / denominator);
}

function interpolateInteger(start, end, numerator, denominator) {
  return start + roundRatio((end - start) * numerator, denominator);
}

function compatibleDirection(resource, direction, trackCount) {
  if (resource.fromMm < resource.toMm) return direction === "forward-track" || (direction === "route-axis" && trackCount === 1);
  return direction === "reverse-track" || (direction === "route-axis" && trackCount === 1);
}

function resourceOffset(resource, kilometreMm) {
  return resource.fromMm < resource.toMm ? kilometreMm - resource.fromMm : resource.fromMm - kilometreMm;
}

function candidateSpanForResource(candidate, resource) {
  if (!compatibleDirection(resource, candidate.direction, candidate.trackCount)) return null;
  const candidateLow = Math.min(candidate.kmFirst, candidate.kmLast);
  const candidateHigh = Math.max(candidate.kmFirst, candidate.kmLast);
  const resourceLow = Math.min(resource.fromMm, resource.toMm);
  const resourceHigh = Math.max(resource.fromMm, resource.toMm);
  const low = Math.max(candidateLow, resourceLow);
  const high = Math.min(candidateHigh, resourceHigh);
  if (low >= high) return null;
  const travelStartKm = resource.fromMm < resource.toMm ? low : high;
  const travelEndKm = resource.fromMm < resource.toMm ? high : low;
  const trackAt = (kilometreMm) => interpolateInteger(
    0,
    candidate.lengthMm,
    kilometreMm - candidate.kmFirst,
    candidate.kmLast - candidate.kmFirst,
  );
  return Object.freeze({
    trackId: candidate.trackId,
    resourceStartMm: resourceOffset(resource, travelStartKm),
    resourceEndMm: resourceOffset(resource, travelEndKm),
    trackStartOffsetMm: trackAt(travelStartKm),
    trackEndOffsetMm: trackAt(travelEndKm),
  });
}

function trackOffsetAtSpan(span, resourceOffsetMm) {
  return interpolateInteger(
    span.trackStartOffsetMm,
    span.trackEndOffsetMm,
    resourceOffsetMm - span.resourceStartMm,
    span.resourceEndMm - span.resourceStartMm,
  );
}

function resolveResourceSpans(resource, candidates) {
  const endpoints = [...new Set([0, resource.lengthMm, ...candidates.flatMap((span) => [span.resourceStartMm, span.resourceEndMm])])]
    .filter((value) => value >= 0 && value <= resource.lengthMm)
    .sort((left, right) => left - right);
  const resolved = [];
  let ambiguousMm = 0;
  let missingMm = 0;
  for (let index = 1; index < endpoints.length; index += 1) {
    const start = endpoints[index - 1];
    const end = endpoints[index];
    if (end <= start) continue;
    const covering = candidates.filter((span) => span.resourceStartMm <= start && span.resourceEndMm >= end);
    if (covering.length === 0) {
      missingMm += end - start;
      continue;
    }
    if (covering.length > 1) {
      ambiguousMm += end - start;
      continue;
    }
    const source = covering[0];
    const piece = {
      resourceId: resource.resourceId,
      resourceStartMm: start,
      resourceEndMm: end,
      trackId: source.trackId,
      trackStartOffsetMm: trackOffsetAtSpan(source, start),
      trackEndOffsetMm: trackOffsetAtSpan(source, end),
    };
    const previous = resolved.at(-1);
    if (
      previous !== undefined
      && previous.trackId === piece.trackId
      && previous.resourceEndMm === piece.resourceStartMm
      && previous.trackEndOffsetMm === piece.trackStartOffsetMm
    ) {
      previous.resourceEndMm = piece.resourceEndMm;
      previous.trackEndOffsetMm = piece.trackEndOffsetMm;
    } else {
      resolved.push(piece);
    }
  }
  return { spans: resolved, ambiguousMm, missingMm };
}

function unwrapNetwork(value) {
  const root = record(value, "Operational-Network-Datei");
  const network = record(root.network, "operational-network.network");
  invariant(network.schema === "zugfolge-operational-network/v1", "Operational Network besitzt nicht das v1-Schema.");
  return network;
}

function unwrapDeployment(value) {
  const root = record(value, "Alpha-Deployment-Datei");
  const deployment = record(root.deployment, "alpha-world-deployment.deployment");
  invariant(deployment.schema === "zugfolge-alpha-world-deployment/v1", "Alpha-Deployment besitzt nicht das v1-Schema.");
  return deployment;
}

function validateSpec(spec) {
  record(spec, "Build-Spezifikation");
  invariant(spec.schema === TRAIN_MAP_PROJECTION_BUILD_SPEC_SCHEMA, "Train-Map-Projektionsspezifikation besitzt ein unbekanntes Schema.");
  nonEmptyString(spec.worldId, "worldId");
  nonEmptyString(spec.infrastructureReleaseId, "infrastructureReleaseId");
  safeInteger(spec.timetableYear, "timetableYear", 2000);
  for (const name of ["tracks", "corridors", "operationalNetwork", "deployment", "output", "report"]) nonEmptyString(spec[name], name);
}

function buildResources(network) {
  const stations = new Map(list(network.stations, "network.stations").map((raw, index) => {
    const station = record(raw, `network.stations[${index}]`);
    const stationId = nonEmptyString(station.stationId, `network.stations[${index}].stationId`);
    const hasCoordinates = Number.isSafeInteger(station.latitudeE7) && Number.isSafeInteger(station.longitudeE7);
    return [stationId, Object.freeze({
      stationId,
      ...(hasCoordinates ? {
        latitudeE7: safeInteger(station.latitudeE7, `${stationId}.latitudeE7`, -900_000_000),
        longitudeE7: safeInteger(station.longitudeE7, `${stationId}.longitudeE7`, -1_800_000_000),
      } : {}),
    })];
  }));
  const resources = list(network.resources, "network.resources").map((raw, index) => {
    const resource = record(raw, `network.resources[${index}]`);
    const normalized = Object.freeze({
      resourceId: nonEmptyString(resource.resourceId, `network.resources[${index}].resourceId`),
      routeNumber: safeInteger(resource.routeNumber, `network.resources[${index}].routeNumber`, 1),
      originStationId: nonEmptyString(resource.originStationId, `network.resources[${index}].originStationId`),
      destinationStationId: nonEmptyString(resource.destinationStationId, `network.resources[${index}].destinationStationId`),
      fromMm: safeInteger(resource.fromMm, `network.resources[${index}].fromMm`, Number.MIN_SAFE_INTEGER),
      toMm: safeInteger(resource.toMm, `network.resources[${index}].toMm`, Number.MIN_SAFE_INTEGER),
      lengthMm: safeInteger(resource.lengthMm, `network.resources[${index}].lengthMm`, 1),
      qualityClass: resource.qualityClass,
      orderable: resource.orderable,
    });
    invariant(normalized.fromMm !== normalized.toMm && Math.abs(normalized.toMm - normalized.fromMm) === normalized.lengthMm, `${normalized.resourceId} besitzt keine konsistente Kilometrierungslaenge.`);
    invariant(stations.has(normalized.originStationId) && stations.has(normalized.destinationStationId), `${normalized.resourceId} verweist auf eine unbekannte Betriebsstelle.`);
    return normalized;
  }).sort((left, right) => compareText(left.resourceId, right.resourceId));
  const identifiers = new Set(resources.map(({ resourceId }) => resourceId));
  invariant(identifiers.size === resources.length, "Operational Network besitzt doppelte Ressourcenkennungen.");
  return { stations, resources };
}

function groupKey(routeNumber, direction) {
  return `${routeNumber}|${direction}`;
}

async function loadCorridors(path, resources, stations) {
  const usedRoutes = new Set(resources.map(({ routeNumber }) => routeNumber));
  const anchorsByRoute = new Map();
  for (const resource of resources) {
    const anchors = anchorsByRoute.get(resource.routeNumber) ?? [];
    const origin = stations.get(resource.originStationId);
    const destination = stations.get(resource.destinationStationId);
    if (origin.latitudeE7 !== undefined && origin.longitudeE7 !== undefined) anchors.push({ kilometreMm: resource.fromMm, ...origin });
    if (destination.latitudeE7 !== undefined && destination.longitudeE7 !== undefined) anchors.push({ kilometreMm: resource.toMm, ...destination });
    anchorsByRoute.set(resource.routeNumber, anchors);
  }
  const corridors = new Map();
  const groups = new Map();
  const rejected = { multipart: 0, invalid: 0 };
  for await (const raw of readSequence(path, "Amtliche Streckenkorridore")) {
    const feature = record(raw, "Streckenkorridor");
    const properties = record(feature.properties, "Streckenkorridor.properties");
    const routeNumber = properties.route_number;
    if (!usedRoutes.has(routeNumber)) continue;
    try {
      const evidenceId = nonEmptyString(properties.official_evidence_id, "Korridor.official_evidence_id");
      const direction = nonEmptyString(properties.direction, `${evidenceId}.direction`);
      invariant(["forward-track", "reverse-track", "route-axis"].includes(direction), `${evidenceId} besitzt eine unbekannte Richtung.`);
      const fromMm = safeInteger(properties.from_km_mm, `${evidenceId}.from_km_mm`, Number.MIN_SAFE_INTEGER);
      const toMm = safeInteger(properties.to_km_mm, `${evidenceId}.to_km_mm`, Number.MIN_SAFE_INTEGER);
      invariant(fromMm !== toMm, `${evidenceId} besitzt keine Kilometrierungsspanne.`);
      const rawCoordinates = lineCoordinates(feature.geometry, `${evidenceId}.geometry`);
      const polyline = planarPolyline(rawCoordinates, `${evidenceId}.geometry`);
      const corridor = { evidenceId, routeNumber, direction, fromMm, toMm, rawCoordinates, polyline };
      invariant(!corridors.has(evidenceId), `Amtliche Evidenz '${evidenceId}' ist doppelt.`);
      corridors.set(evidenceId, corridor);
      const key = groupKey(routeNumber, direction);
      const group = groups.get(key) ?? { directErrorM: 0, reverseErrorM: 0, anchorCount: 0 };
      for (const anchor of anchorsByRoute.get(routeNumber) ?? []) {
        const fraction = (anchor.kilometreMm - fromMm) / (toMm - fromMm);
        if (fraction < 0 || fraction > 1) continue;
        const directProjected = pointAtAlong(polyline, polyline.lengthM * fraction);
        const reverseProjected = pointAtAlong(polyline, polyline.lengthM * (1 - fraction));
        const anchorProjected = mercator(anchor.longitudeE7, anchor.latitudeE7);
        const direct = Math.sqrt(squaredDistance(directProjected, anchorProjected));
        const reverse = Math.sqrt(squaredDistance(reverseProjected, anchorProjected));
        if (Math.min(direct, reverse) > MAX_STATION_ANCHOR_DISTANCE_M) continue;
        group.directErrorM += direct;
        group.reverseErrorM += reverse;
        group.anchorCount += 1;
      }
      groups.set(key, group);
    } catch (error) {
      if (/mehrteilig/u.test(error.message)) rejected.multipart += 1;
      else rejected.invalid += 1;
    }
  }
  const orientationByGroup = new Map();
  const orientationCounts = { direct: 0, reverse: 0, unresolved: 0 };
  for (const [key, group] of [...groups].sort(([left], [right]) => compareText(left, right))) {
    const directMean = group.anchorCount === 0 ? Infinity : group.directErrorM / group.anchorCount;
    const reverseMean = group.anchorCount === 0 ? Infinity : group.reverseErrorM / group.anchorCount;
    const best = Math.min(directMean, reverseMean);
    const other = Math.max(directMean, reverseMean);
    if (group.anchorCount < 2 || best > MAX_STATION_ANCHOR_DISTANCE_M || other - best < MIN_ORIENTATION_ADVANTAGE_M) {
      orientationCounts.unresolved += 1;
      continue;
    }
    const reverse = reverseMean < directMean;
    orientationByGroup.set(key, reverse);
    orientationCounts[reverse ? "reverse" : "direct"] += 1;
  }
  for (const corridor of corridors.values()) {
    const reverse = orientationByGroup.get(groupKey(corridor.routeNumber, corridor.direction));
    if (reverse === undefined) continue;
    if (reverse) {
      corridor.rawCoordinates = [...corridor.rawCoordinates].reverse();
      corridor.polyline = planarPolyline(corridor.rawCoordinates, `${corridor.evidenceId}.oriented-geometry`);
    }
  }
  return { corridors, orientationByGroup, orientationCounts, rejected };
}

async function loadTrackCandidates(path, resources, corridorData) {
  const resourcesByRoute = new Map();
  for (const resource of resources) {
    const values = resourcesByRoute.get(resource.routeNumber) ?? [];
    values.push(resource);
    resourcesByRoute.set(resource.routeNumber, values);
  }
  const candidates = [];
  const geometryByTrack = new Map();
  const rejected = {
    notRelevant: 0,
    noOrientedCorridor: 0,
    notOrderable: 0,
    direction: 0,
    distance: 0,
    kilometreFit: 0,
    invalid: 0,
  };
  for await (const raw of readSequence(path, "Deutschland-Gleisgeometrien")) {
    const feature = record(raw, "Gleisfeature");
    const properties = record(feature.properties, "Gleisfeature.properties");
    const routeNumber = properties.official_route_number;
    const routeResources = resourcesByRoute.get(routeNumber);
    if (routeResources === undefined) {
      rejected.notRelevant += 1;
      continue;
    }
    const evidenceId = properties.official_evidence_id;
    const corridor = corridorData.corridors.get(evidenceId);
    const direction = properties.official_direction;
    if (corridor === undefined || !corridorData.orientationByGroup.has(groupKey(routeNumber, direction))) {
      rejected.noOrientedCorridor += 1;
      continue;
    }
    if (properties.orderable !== true || properties.quality_class === "C") {
      rejected.notOrderable += 1;
      continue;
    }
    const trackCount = properties.official_track_count;
    if (!routeResources.some((resource) => compatibleDirection(resource, direction, trackCount))) {
      rejected.direction += 1;
      continue;
    }
    try {
      invariant(corridor.routeNumber === routeNumber && corridor.direction === direction, "Gleis und Korridor widersprechen sich.");
      invariant(corridor.fromMm === properties.official_from_km_mm && corridor.toMm === properties.official_to_km_mm, "Gleis und Korridor besitzen verschiedene Kilometrierungsspannen.");
      const trackId = nonEmptyString(properties.feature_id, "track.feature_id");
      const lengthMm = safeInteger(properties.length_mm, `${trackId}.length_mm`, 1);
      const rawCoordinates = lineCoordinates(feature.geometry, `${trackId}.geometry`);
      const geometry = geometryVertices(rawCoordinates, lengthMm, `${trackId}.geometry`);
      const first = geometry.polyline.projected[0];
      const last = geometry.polyline.projected.at(-1);
      const firstProjection = nearestAlong(corridor.polyline, first);
      const lastProjection = nearestAlong(corridor.polyline, last);
      if (Math.max(firstProjection.distanceM, lastProjection.distanceM) > MAX_TRACK_TO_CORRIDOR_DISTANCE_M) {
        rejected.distance += 1;
        continue;
      }
      const kmFirst = corridor.fromMm + Math.round((corridor.toMm - corridor.fromMm) * firstProjection.alongM / corridor.polyline.lengthM);
      const kmLast = corridor.fromMm + Math.round((corridor.toMm - corridor.fromMm) * lastProjection.alongM / corridor.polyline.lengthM);
      const kilometreSpanMm = Math.abs(kmLast - kmFirst);
      if (kilometreSpanMm === 0 || Math.abs(kilometreSpanMm - lengthMm) > Math.max(50_000, Math.round(lengthMm * 0.35))) {
        rejected.kilometreFit += 1;
        continue;
      }
      invariant(!geometryByTrack.has(trackId), `Gleis '${trackId}' ist doppelt.`);
      geometryByTrack.set(trackId, Object.freeze({ trackId, lengthMm, vertices: geometry.vertices }));
      candidates.push(Object.freeze({ trackId, routeNumber, direction, trackCount, kmFirst, kmLast, lengthMm }));
    } catch {
      rejected.invalid += 1;
    }
  }
  return { candidates, geometryByTrack, rejected };
}

function buildResourceProjection(resources, trackData) {
  const candidateSpansByResource = new Map(resources.map(({ resourceId }) => [resourceId, []]));
  const resourcesByRoute = new Map();
  for (const resource of resources) {
    const values = resourcesByRoute.get(resource.routeNumber) ?? [];
    values.push(resource);
    resourcesByRoute.set(resource.routeNumber, values);
  }
  for (const candidate of trackData.candidates) {
    for (const resource of resourcesByRoute.get(candidate.routeNumber) ?? []) {
      const span = candidateSpanForResource(candidate, resource);
      if (span !== null) candidateSpansByResource.get(resource.resourceId).push(span);
    }
  }
  const spans = [];
  const resolution = [];
  const referencedTracks = new Set();
  for (const resource of resources) {
    const candidates = candidateSpansByResource.get(resource.resourceId)
      .sort((left, right) => left.resourceStartMm - right.resourceStartMm || left.resourceEndMm - right.resourceEndMm || compareText(left.trackId, right.trackId));
    const result = resolveResourceSpans(resource, candidates);
    let resolvedMm = 0;
    for (const span of result.spans) {
      resolvedMm += span.resourceEndMm - span.resourceStartMm;
      referencedTracks.add(span.trackId);
      spans.push(Object.freeze({ ...span, isResourceEnd: span.resourceEndMm === resource.lengthMm ? 1 : 0 }));
    }
    resolution.push(Object.freeze({
      resourceId: resource.resourceId,
      lengthMm: resource.lengthMm,
      candidateCount: candidates.length,
      spanCount: result.spans.length,
      resolvedMm,
      ambiguousMm: result.ambiguousMm,
      missingMm: result.missingMm,
    }));
  }
  return {
    spans: spans.sort((left, right) => compareText(left.resourceId, right.resourceId) || left.resourceStartMm - right.resourceStartMm || compareText(left.trackId, right.trackId)),
    resolution,
    referencedTracks,
  };
}

function buildTrainProjection(network, deployment, resources) {
  const resourceById = new Map(resources.map((resource) => [resource.resourceId, resource]));
  const segmentById = new Map(list(network.segmentQualifications, "network.segmentQualifications").map((raw) => {
    const segment = record(raw, "segmentQualification");
    return [nonEmptyString(segment.segmentId, "segmentQualification.segmentId"), segment];
  }));
  const chainById = new Map(list(network.journeyChainQualifications, "network.journeyChainQualifications").map((raw) => {
    const chain = record(raw, "journeyChainQualification");
    return [nonEmptyString(chain.journeyChainId, "journeyChainQualification.journeyChainId"), chain];
  }));
  const fleet = record(deployment.fleet, "deployment.fleet");
  const authority = record(fleet.authorityRelease, "deployment.fleet.authorityRelease");
  const receiptById = new Map(list(authority.pathReceipts, "authorityRelease.pathReceipts").map((raw) => {
    const receipt = record(raw, "pathReceipt");
    return [nonEmptyString(receipt.id, "pathReceipt.id"), receipt];
  }));
  const reservationByTrain = new Map();
  for (const raw of list(fleet.pathReservations, "deployment.fleet.pathReservations")) {
    const reservation = record(raw, "pathReservation");
    const id = nonEmptyString(reservation.id, "pathReservation.id");
    if (id.startsWith("reservation-")) reservationByTrain.set(id.slice("reservation-".length), reservation);
  }
  const regional = record(deployment.regionalSimulation, "deployment.regionalSimulation");
  const spans = [];
  const unresolved = new Map();
  let projectedTrainCount = 0;
  const trains = [...list(regional.trains, "deployment.regionalSimulation.trains")]
    .map((raw) => record(raw, "regional train"))
    .sort((left, right) => compareText(left.trainRunId, right.trainRunId));
  for (const train of trains) {
    const trainId = nonEmptyString(train.trainRunId, "regional train.trainRunId");
    const reject = (reason) => unresolved.set(reason, (unresolved.get(reason) ?? 0) + 1);
    const chain = chainById.get(trainId);
    if (chain?.orderable !== true || chain.qualityClass === "C") {
      reject("journey-chain-not-orderable");
      continue;
    }
    const playableSegmentIds = list(chain.playableSegmentIds, `${trainId}.playableSegmentIds`);
    if (playableSegmentIds.length !== 1) {
      reject("journey-chain-not-single-playable-segment");
      continue;
    }
    const segment = segmentById.get(playableSegmentIds[0]);
    if (segment?.orderable !== true || segment.qualityClass === "C" || !Array.isArray(segment.resourceIds)) {
      reject("playable-segment-not-orderable");
      continue;
    }
    const reservation = reservationByTrain.get(trainId);
    const receipt = reservation === undefined ? undefined : receiptById.get(reservation.pathReceiptId);
    if (receipt === undefined || receipt.decision !== "confirmed" || !Number.isSafeInteger(receipt.numericRouteId)) {
      reject("confirmed-path-receipt-missing");
      continue;
    }
    if (receipt.id !== `path-${trainId}`) {
      reject("path-receipt-not-train-bound");
      continue;
    }
    let positionMm = 0;
    const trainSpans = [];
    let valid = true;
    for (const resourceId of segment.resourceIds) {
      const resource = resourceById.get(resourceId);
      if (resource === undefined || resource.orderable !== true || resource.qualityClass === "C") {
        valid = false;
        break;
      }
      const endMm = positionMm + resource.lengthMm;
      trainSpans.push({
        trainId,
        numericRouteId: receipt.numericRouteId,
        pathReceiptId: receipt.id,
        positionStartMm: positionMm,
        positionEndMm: endMm,
        resourceId,
      });
      positionMm = endMm;
    }
    if (!valid || positionMm !== segment.distanceMm) {
      reject("resource-chain-distance-mismatch");
      continue;
    }
    const route = list(train.route, `${trainId}.route`);
    const routePositions = route.map((waypoint) => record(waypoint, `${trainId}.waypoint`).positionMm);
    if (routePositions.some((value) => !Number.isSafeInteger(value) || value < 0 || value > positionMm)) {
      reject("runtime-route-position-outside-resource-chain");
      continue;
    }
    trainSpans.forEach((span, index) => spans.push(Object.freeze({ ...span, isTrainEnd: index === trainSpans.length - 1 ? 1 : 0 })));
    projectedTrainCount += 1;
  }
  return {
    spans,
    trainCount: trains.length,
    projectedTrainCount,
    unresolved: Object.fromEntries([...unresolved].sort(([left], [right]) => compareText(left, right))),
  };
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function writeProjectionDatabase(path, spec, sourceHashes, resourceProjection, trainProjection, trackData) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  const database = new DatabaseSync(temporary, {
    open: true,
    readOnly: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 0,
  });
  try {
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = FULL;
      PRAGMA page_size = 4096;
      PRAGMA auto_vacuum = NONE;
      PRAGMA encoding = 'UTF-8';
      PRAGMA application_id = ${TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID};
      PRAGMA user_version = ${TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION};
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE track_geometries (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        length_mm INTEGER NOT NULL CHECK (length_mm > 0),
        geometry_json TEXT NOT NULL,
        PRIMARY KEY (world_id, infrastructure_release_id, track_id)
      ) WITHOUT ROWID;
      CREATE TABLE resource_track_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_start_mm INTEGER NOT NULL CHECK (resource_start_mm >= 0),
        resource_end_mm INTEGER NOT NULL CHECK (resource_end_mm > resource_start_mm),
        track_id TEXT NOT NULL,
        track_start_offset_mm INTEGER NOT NULL CHECK (track_start_offset_mm >= 0),
        track_end_offset_mm INTEGER NOT NULL CHECK (track_end_offset_mm >= 0),
        is_resource_end INTEGER NOT NULL CHECK (is_resource_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm, track_id),
        FOREIGN KEY (world_id, infrastructure_release_id, track_id)
          REFERENCES track_geometries (world_id, infrastructure_release_id, track_id)
      ) WITHOUT ROWID;
      CREATE INDEX resource_track_lookup ON resource_track_spans
        (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm);
      CREATE TABLE train_resource_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        train_id TEXT NOT NULL,
        position_start_mm INTEGER NOT NULL CHECK (position_start_mm >= 0),
        position_end_mm INTEGER NOT NULL CHECK (position_end_mm > position_start_mm),
        resource_id TEXT NOT NULL,
        is_train_end INTEGER NOT NULL CHECK (is_train_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, train_id, position_start_mm, resource_id)
      ) WITHOUT ROWID;
      CREATE INDEX train_position_lookup ON train_resource_spans
        (world_id, infrastructure_release_id, train_id, position_start_mm, position_end_mm);
    `);
    const insertMetadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    const metadata = {
      schema: TRAIN_MAP_PROJECTION_SCHEMA,
      world_id: spec.worldId,
      infrastructure_release_id: spec.infrastructureReleaseId,
      timetable_year: String(spec.timetableYear),
      tracks_sha256: sourceHashes.tracks,
      corridors_sha256: sourceHashes.corridors,
      operational_network_sha256: sourceHashes.operationalNetwork,
      deployment_sha256: sourceHashes.deployment,
    };
    for (const key of Object.keys(metadata).sort(compareText)) insertMetadata.run(key, metadata[key]);
    const insertTrack = database.prepare("INSERT INTO track_geometries (world_id, infrastructure_release_id, track_id, length_mm, geometry_json) VALUES (?, ?, ?, ?, ?)");
    for (const trackId of [...resourceProjection.referencedTracks].sort(compareText)) {
      const geometry = trackData.geometryByTrack.get(trackId);
      invariant(geometry !== undefined, `Referenziertes Gleis '${trackId}' besitzt keine Geometrie.`);
      insertTrack.run(spec.worldId, spec.infrastructureReleaseId, trackId, geometry.lengthMm, canonicalJson(geometry.vertices));
    }
    const insertResource = database.prepare(`INSERT INTO resource_track_spans
      (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm, track_id, track_start_offset_mm, track_end_offset_mm, is_resource_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const span of resourceProjection.spans) insertResource.run(
      spec.worldId,
      spec.infrastructureReleaseId,
      span.resourceId,
      span.resourceStartMm,
      span.resourceEndMm,
      span.trackId,
      span.trackStartOffsetMm,
      span.trackEndOffsetMm,
      span.isResourceEnd,
    );
    const insertTrain = database.prepare(`INSERT INTO train_resource_spans
      (world_id, infrastructure_release_id, train_id, position_start_mm, position_end_mm, resource_id, is_train_end)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const span of trainProjection.spans) insertTrain.run(
      spec.worldId,
      spec.infrastructureReleaseId,
      span.trainId,
      span.positionStartMm,
      span.positionEndMm,
      span.resourceId,
      span.isTrainEnd,
    );
    database.exec("ANALYZE; VACUUM; PRAGMA optimize;");
  } finally {
    database.close();
  }
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function resolutionSummary(resourceProjection, resources) {
  const totalMm = resources.reduce((sum, resource) => sum + resource.lengthMm, 0);
  const resolvedMm = resourceProjection.resolution.reduce((sum, value) => sum + value.resolvedMm, 0);
  const ambiguousMm = resourceProjection.resolution.reduce((sum, value) => sum + value.ambiguousMm, 0);
  const missingMm = resourceProjection.resolution.reduce((sum, value) => sum + value.missingMm, 0);
  invariant(resolvedMm + ambiguousMm + missingMm === totalMm, "Ressourcenaufloesung ist nicht laengenvollstaendig bilanziert.");
  return {
    resourceCount: resources.length,
    fullyResolvedResourceCount: resourceProjection.resolution.filter((value) => value.resolvedMm === value.lengthMm).length,
    partiallyResolvedResourceCount: resourceProjection.resolution.filter((value) => value.resolvedMm > 0 && value.resolvedMm < value.lengthMm).length,
    unresolvedResourceCount: resourceProjection.resolution.filter((value) => value.resolvedMm === 0).length,
    totalMm,
    resolvedMm,
    ambiguousMm,
    missingMm,
    resolvedBasisPoints: totalMm === 0 ? 0 : Math.floor(resolvedMm * 10_000 / totalMm),
  };
}

function trainGeometrySummary(trainProjection, resourceProjection) {
  const resolutionByResource = new Map(resourceProjection.resolution.map((value) => [value.resourceId, value]));
  const byTrain = new Map();
  for (const span of trainProjection.spans) {
    const summary = byTrain.get(span.trainId) ?? { totalMm: 0, resolvedMm: 0, ambiguousMm: 0, missingMm: 0 };
    const resource = resolutionByResource.get(span.resourceId);
    invariant(resource !== undefined, `Zugspanne verweist auf unbekannte Ressource '${span.resourceId}'.`);
    summary.totalMm += span.positionEndMm - span.positionStartMm;
    summary.resolvedMm += resource.resolvedMm;
    summary.ambiguousMm += resource.ambiguousMm;
    summary.missingMm += resource.missingMm;
    byTrain.set(span.trainId, summary);
  }
  let totalMm = 0;
  let resolvedMm = 0;
  let fullyGeoreferenceableTrainCount = 0;
  let partiallyGeoreferenceableTrainCount = 0;
  let ungeoreferenceableTrainCount = 0;
  for (const summary of byTrain.values()) {
    invariant(summary.resolvedMm + summary.ambiguousMm + summary.missingMm === summary.totalMm, "Zug-Geometrieabdeckung ist nicht laengenvollstaendig bilanziert.");
    totalMm += summary.totalMm;
    resolvedMm += summary.resolvedMm;
    if (summary.resolvedMm === summary.totalMm) fullyGeoreferenceableTrainCount += 1;
    else if (summary.resolvedMm > 0) partiallyGeoreferenceableTrainCount += 1;
    else ungeoreferenceableTrainCount += 1;
  }
  return Object.freeze({
    fullyGeoreferenceableTrainCount,
    partiallyGeoreferenceableTrainCount,
    ungeoreferenceableTrainCount,
    totalMm,
    resolvedMm,
    resolvedBasisPoints: totalMm === 0 ? 0 : Math.floor(resolvedMm * 10_000 / totalMm),
  });
}

export async function buildTrainMapProjection(rawSpec) {
  const spec = { ...rawSpec };
  validateSpec(spec);
  const [networkHash, deploymentHash, tracksHash, corridorsHash, networkValue, deploymentValue] = await Promise.all([
    sha256File(spec.operationalNetwork),
    sha256File(spec.deployment),
    sha256File(spec.tracks),
    sha256File(spec.corridors),
    readJson(spec.operationalNetwork, "Operational Network"),
    readJson(spec.deployment, "Alpha-Deployment"),
  ]);
  const network = unwrapNetwork(networkValue);
  const deployment = unwrapDeployment(deploymentValue);
  invariant(deployment.worldId === spec.worldId, "Alpha-Deployment verletzt die Weltbindung der Projektion.");
  invariant(deployment.regionalSimulation?.worldId === spec.worldId, "Regionale Simulation verletzt die Weltbindung der Projektion.");
  invariant(network.timetableYear === spec.timetableYear, "Operational Network verletzt das Fahrplanjahr der Projektion.");
  const { stations, resources } = buildResources(network);
  const corridorData = await loadCorridors(spec.corridors, resources, stations);
  const trackData = await loadTrackCandidates(spec.tracks, resources, corridorData);
  const resourceProjection = buildResourceProjection(resources, trackData);
  const trainProjection = buildTrainProjection(network, deployment, resources);
  const sourceHashes = { tracks: tracksHash, corridors: corridorsHash, operationalNetwork: networkHash, deployment: deploymentHash };
  await writeProjectionDatabase(spec.output, spec, sourceHashes, resourceProjection, trainProjection, trackData);
  const outputStat = await stat(spec.output);
  const outputHash = await sha256File(spec.output);
  const coverage = resolutionSummary(resourceProjection, resources);
  const trainGeometry = trainGeometrySummary(trainProjection, resourceProjection);
  const validation = await inspectTrainMapProjection(spec.output);
  const report = Object.freeze({
    schema: TRAIN_MAP_PROJECTION_REPORT_SCHEMA,
    binding: {
      worldId: spec.worldId,
      infrastructureReleaseId: spec.infrastructureReleaseId,
      timetableYear: spec.timetableYear,
      operationalRegionId: network.regionId,
      deploymentInfrastructureHash: deployment.infraReleaseHash,
    },
    inputs: {
      tracks: { file: basename(spec.tracks), sha256: tracksHash },
      corridors: { file: basename(spec.corridors), sha256: corridorsHash },
      operationalNetwork: { file: basename(spec.operationalNetwork), sha256: networkHash },
      deployment: { file: basename(spec.deployment), sha256: deploymentHash },
    },
    corridorOrientation: { ...corridorData.orientationCounts, rejected: corridorData.rejected },
    tracks: {
      usableCandidateCount: trackData.candidates.length,
      referencedTrackCount: resourceProjection.referencedTracks.size,
      rejected: trackData.rejected,
    },
    resources: coverage,
    trains: {
      deploymentTrainCount: trainProjection.trainCount,
      provenTrainCount: trainProjection.projectedTrainCount,
      unresolved: trainProjection.unresolved,
      trainResourceSpanCount: trainProjection.spans.length,
      geometry: trainGeometry,
    },
    artifact: {
      file: basename(spec.output),
      bytes: outputStat.size,
      sha256: outputHash,
      sqliteApplicationId: TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID,
      sqliteUserVersion: TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION,
      publicAndReadOnly: true,
    },
    policy: {
      ambiguousOrMissingGeometryIsUnresolved: true,
      guessedTrackSelection: false,
      integerRuntimeProjection: true,
      externalLegsProjected: false,
    },
    validation,
  });
  await atomicJson(spec.report, report);
  return report;
}

export async function loadTrainMapProjectionSpec(path) {
  const absolute = resolve(path);
  const raw = await readJson(absolute, "Train-Map-Projektionsspezifikation");
  validateSpec(raw);
  const root = dirname(absolute);
  return {
    ...raw,
    tracks: resolve(root, raw.tracks),
    corridors: resolve(root, raw.corridors),
    operationalNetwork: resolve(root, raw.operationalNetwork),
    deployment: resolve(root, raw.deployment),
    output: resolve(root, raw.output),
    report: resolve(root, raw.report),
  };
}

export async function inspectTrainMapProjection(path) {
  const database = new DatabaseSync(path, { readOnly: true, allowExtension: false, defensive: true, timeout: 0 });
  try {
    const applicationId = database.prepare("PRAGMA application_id").get().application_id;
    const userVersion = database.prepare("PRAGMA user_version").get().user_version;
    invariant(applicationId === TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID && userVersion === TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION, "Projektions-SQLite besitzt keinen gueltigen Headervertrag.");
    const metadata = Object.fromEntries(database.prepare("SELECT key, value FROM metadata ORDER BY key").all().map((row) => [row.key, row.value]));
    invariant(metadata.schema === TRAIN_MAP_PROJECTION_SCHEMA, "Projektions-SQLite besitzt ein unbekanntes Schema.");
    const schemaObjects = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const actualSchemaObjects = schemaObjects.map((row) => ({ type: row.type, name: row.name, table: row.tbl_name }));
    invariant(canonicalJson(actualSchemaObjects) === canonicalJson(TRAIN_MAP_PROJECTION_PUBLIC_SCHEMA_OBJECTS), "Projektions-SQLite verletzt die exakte Schemaobjekt-Allowlist.");
    const tableColumns = Object.fromEntries(Object.keys(TRAIN_MAP_PROJECTION_PUBLIC_TABLES).sort(compareText).map((table) => [
      table,
      database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
    ]));
    invariant(canonicalJson(tableColumns) === canonicalJson(TRAIN_MAP_PROJECTION_PUBLIC_TABLES), "Projektions-SQLite verletzt die oeffentliche Spalten-Allowlist.");
    const schemaSql = database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const schemaSqlSha256 = createHash("sha256").update(canonicalJson(schemaSql)).digest("hex");
    invariant(schemaSqlSha256 === TRAIN_MAP_PROJECTION_SCHEMA_SQL_SHA256, "Projektions-SQLite verletzt den gepinnten Schema-SQL-Hash.");
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    invariant(foreignKeyViolations.length === 0, "Projektions-SQLite verletzt ihre Fremdschluessel.");
    const quickCheck = database.prepare("PRAGMA quick_check").get().quick_check;
    const integrityCheck = database.prepare("PRAGMA integrity_check").get().integrity_check;
    invariant(quickCheck === "ok" && integrityCheck === "ok", "Projektions-SQLite besteht die Integritaetspruefung nicht.");
    return Object.freeze({
      schema: TRAIN_MAP_PROJECTION_SCHEMA,
      worldId: metadata.world_id,
      infrastructureReleaseId: metadata.infrastructure_release_id,
      timetableYear: Number(metadata.timetable_year),
      sqliteApplicationId: applicationId,
      sqliteUserVersion: userVersion,
      tables: tableColumns,
      schemaSqlSha256,
      foreignKeyCheck: "ok",
      trackCount: database.prepare("SELECT count(*) AS count FROM track_geometries").get().count,
      resourceSpanCount: database.prepare("SELECT count(*) AS count FROM resource_track_spans").get().count,
      trainSpanCount: database.prepare("SELECT count(*) AS count FROM train_resource_spans").get().count,
      quickCheck,
      integrityCheck,
    });
  } finally {
    database.close();
  }
}
