import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { trackInsidePlayableArea, validatePlayableArea } from "../playable-area.mjs";

export const OPERATIONAL_TRACK_GRAPH_RULE =
  "observed-osm-track-graph-with-official-corridor-station-anchors/v1";
export const GTFS_TRACK_GRAPH_RULE =
  "pinned-gtfs-stops-on-observed-osm-track-graph/v2";
export const GTFS_SIMULATED_ROUTE_KEY = "gtfs-simulated-assignment/v2";

const CANONICAL_PROTECTION_SYSTEMS = Object.freeze([
  "etcs-level1",
  "etcs-level2",
  "lzb",
  "pzb",
]);

const GRID_E7 = 500_000;
const CORRIDOR_GRID_E7 = 50_000;
const CORRIDOR_CELL_RADIUS = 3;
const MAX_ANCHOR_DISTANCE_MM = 2_500_000;
const MAX_ANCHORS_PER_STATION_ROUTE = 12;
const GTFS_ROUTING_MARGIN_E7 = 2_000_000;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeInteger(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} ist keine sichere Ganzzahl ab ${minimum}.`);
  return value;
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value !== "", `${name} muss eine nichtleere Zeichenkette sein.`);
  return value;
}

function osmTags(properties, name) {
  invariant(typeof properties?.osm_tags_json === "string", `${name}.osm_tags_json fehlt.`);
  let tags;
  try {
    tags = JSON.parse(properties.osm_tags_json);
  } catch (error) {
    throw new Error(`${name}.osm_tags_json ist kein JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  invariant(tags !== null && typeof tags === "object" && !Array.isArray(tags), `${name}.osm_tags_json ist kein Objekt.`);
  return tags;
}

/**
 * Derselbe kanonische one-of-Vertrag wie im nativen Operational-v2-Ableiter:
 * explizite PZB/LZB-/ETCS-Systeme werden vereinigt; ohne ausdruecklich
 * abbildbares System greift die konservative synthetische PZB-Belegung.
 */
export function canonicalTrackProtectionSystems(properties, defaultProtectionSystem = "pzb") {
  invariant(CANONICAL_PROTECTION_SYSTEMS.includes(defaultProtectionSystem), "defaultProtectionSystem ist nicht kanonisch.");
  const tags = osmTags(properties, properties?.feature_id ?? "Gleiskante");
  const systems = new Set();
  for (const [key, value] of Object.entries(tags)) {
    if (key === "railway:pzb" && ["yes", "forward", "backward"].includes(value)) systems.add("pzb");
    else if (key === "railway:lzb" && value === "yes") systems.add("lzb");
    else if (["railway:etcs", "railway:etcs:forward", "railway:etcs:backward"].includes(key)) {
      if (value === "1" || value === "1;2") systems.add("etcs-level1");
      if (value === "2" || value === "1;2") systems.add("etcs-level2");
    }
  }
  if (systems.size === 0) systems.add(defaultProtectionSystem);
  return Object.freeze(CANONICAL_PROTECTION_SYSTEMS.filter((system) => systems.has(system)));
}

function kmhToMmps(speedKmh) {
  invariant(Number.isSafeInteger(speedKmh) && speedKmh > 0, "Gleisgeschwindigkeit muss eine positive Ganzzahl sein.");
  return Math.max(1, Math.floor(speedKmh * 1_000_000 / 3_600));
}

function directionalTrackSpeeds(properties, unknownMainlineSpeedKmh, unknownServiceSpeedKmh) {
  const tags = osmTags(properties, properties?.feature_id ?? "Gleiskante");
  const mainline = tags.usage === "main" || tags.usage === "highspeed";
  const fallback = mainline ? unknownMainlineSpeedKmh : unknownServiceSpeedKmh;
  const speed = (key) => Number.isSafeInteger(properties[key]) && properties[key] > 0 ? properties[key] : fallback;
  return Object.freeze({
    speedAlongMmps: kmhToMmps(speed("speed_forward_kmh")),
    speedAgainstMmps: kmhToMmps(speed("speed_backward_kmh")),
  });
}

function normalizePermittedProtectionModes(value) {
  if (value === null || value === undefined) return null;
  invariant(Array.isArray(value) && value.length > 0, "permittedProtectionModes muss eine nichtleere Liste sein.");
  const normalized = [...new Set(value)];
  invariant(
    normalized.length === value.length && normalized.every((system) => CANONICAL_PROTECTION_SYSTEMS.includes(system)),
    "permittedProtectionModes enthaelt doppelte oder nichtkanonische Systeme.",
  );
  normalized.sort(compareText);
  return Object.freeze(normalized);
}

async function* readSequence(path, name) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let record = 0;
  for await (let line of lines) {
    record += 1;
    if (line.charCodeAt(0) === 0x1e) line = line.slice(1);
    invariant(line !== "", `${name} enthaelt einen leeren Datensatz ${record}.`);
    try {
      yield JSON.parse(line);
    } catch (error) {
      throw new Error(`${name} Datensatz ${record} ist kein JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function coordinateE7(value, name) {
  invariant(Array.isArray(value) && value.length >= 2, `${name} ist keine Koordinate.`);
  const longitudeE7 = Math.round(value[0] * 10_000_000);
  const latitudeE7 = Math.round(value[1] * 10_000_000);
  safeInteger(longitudeE7, `${name}.longitudeE7`, -1_800_000_000);
  safeInteger(latitudeE7, `${name}.latitudeE7`, -900_000_000);
  invariant(longitudeE7 <= 1_800_000_000 && latitudeE7 <= 900_000_000, `${name} liegt ausserhalb E7.`);
  return Object.freeze({ longitudeE7, latitudeE7 });
}

function lineCoordinates(geometry, name) {
  const raw = geometry?.type === "LineString"
    ? geometry.coordinates
    : geometry?.type === "MultiLineString" && Array.isArray(geometry.coordinates) && geometry.coordinates.length === 1
      ? geometry.coordinates[0]
      : null;
  invariant(Array.isArray(raw) && raw.length >= 2, `${name} ist kein einteiliger LineString.`);
  const coordinates = [];
  for (let index = 0; index < raw.length; index += 1) {
    const coordinate = coordinateE7(raw[index], `${name}[${index}]`);
    const previous = coordinates.at(-1);
    if (previous?.longitudeE7 !== coordinate.longitudeE7 || previous?.latitudeE7 !== coordinate.latitudeE7) coordinates.push(coordinate);
  }
  invariant(coordinates.length >= 2, `${name} kollabiert nach E7-Quantisierung.`);
  return coordinates;
}

function distanceUnits(left, right) {
  const dx = (left.longitudeE7 - right.longitudeE7) * 7;
  const dy = (left.latitudeE7 - right.latitudeE7) * 11;
  return Math.sqrt(dx * dx + dy * dy);
}

function polylineLengths(coordinates) {
  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const length = distanceUnits(coordinates[index - 1], coordinates[index]);
    invariant(length > 0, "Gleis- oder Korridorgeometrie kollabiert.");
    cumulative.push(cumulative.at(-1) + length);
  }
  return cumulative;
}

function pointAlong(coordinates, fraction) {
  invariant(Number.isFinite(fraction) && fraction >= 0 && fraction <= 1, "Korridorinterpolation liegt ausserhalb [0,1].");
  const cumulative = polylineLengths(coordinates);
  const target = cumulative.at(-1) * fraction;
  let index = 1;
  while (index < cumulative.length - 1 && cumulative[index] < target) index += 1;
  const start = cumulative[index - 1];
  const length = cumulative[index] - start;
  const local = length === 0 ? 0 : (target - start) / length;
  return Object.freeze({
    longitudeE7: Math.round(coordinates[index - 1].longitudeE7 + (coordinates[index].longitudeE7 - coordinates[index - 1].longitudeE7) * local),
    latitudeE7: Math.round(coordinates[index - 1].latitudeE7 + (coordinates[index].latitudeE7 - coordinates[index - 1].latitudeE7) * local),
  });
}

function nearestOnTrack(seed, coordinates, lengthMm) {
  const cumulative = polylineLengths(coordinates);
  const total = cumulative.at(-1);
  let best = null;
  for (let index = 1; index < coordinates.length; index += 1) {
    const left = coordinates[index - 1];
    const right = coordinates[index];
    const dx = (right.longitudeE7 - left.longitudeE7) * 7;
    const dy = (right.latitudeE7 - left.latitudeE7) * 11;
    const px = (seed.longitudeE7 - left.longitudeE7) * 7;
    const py = (seed.latitudeE7 - left.latitudeE7) * 11;
    const denominator = dx * dx + dy * dy;
    const fraction = Math.max(0, Math.min(1, denominator === 0 ? 0 : (px * dx + py * dy) / denominator));
    const projected = {
      longitudeE7: Math.round(left.longitudeE7 + (right.longitudeE7 - left.longitudeE7) * fraction),
      latitudeE7: Math.round(left.latitudeE7 + (right.latitudeE7 - left.latitudeE7) * fraction),
    };
    const units = distanceUnits(seed, projected);
    const along = cumulative[index - 1] + (cumulative[index] - cumulative[index - 1]) * fraction;
    const offsetMm = Math.max(0, Math.min(lengthMm, Math.round(lengthMm * along / total)));
    if (best === null || units < best.units || (units === best.units && offsetMm < best.offsetMm)) best = { units, offsetMm };
  }
  return Object.freeze({ distanceMm: Math.round(best.units), offsetMm: best.offsetMm });
}

function stationRouteKey(routeNumber, stationId) {
  return `${routeNumber}|${stationId}`;
}

function gridKey(longitudeE7, latitudeE7) {
  return `${Math.floor(longitudeE7 / GRID_E7)}|${Math.floor(latitudeE7 / GRID_E7)}`;
}

function corridorGridKey(longitudeE7, latitudeE7) {
  return `${Math.floor(longitudeE7 / CORRIDOR_GRID_E7)}|${Math.floor(latitudeE7 / CORRIDOR_GRID_E7)}`;
}

function addCorridorCells(cells, coordinates) {
  for (let index = 1; index < coordinates.length; index += 1) {
    const left = coordinates[index - 1];
    const right = coordinates[index];
    const steps = Math.max(
      1,
      Math.ceil(Math.abs(right.longitudeE7 - left.longitudeE7) / CORRIDOR_GRID_E7),
      Math.ceil(Math.abs(right.latitudeE7 - left.latitudeE7) / CORRIDOR_GRID_E7),
    );
    for (let step = 0; step <= steps; step += 1) {
      const fraction = step / steps;
      cells.add(corridorGridKey(
        Math.round(left.longitudeE7 + (right.longitudeE7 - left.longitudeE7) * fraction),
        Math.round(left.latitudeE7 + (right.latitudeE7 - left.latitudeE7) * fraction),
      ));
    }
  }
}

function routeReferences(properties) {
  const values = new Set();
  if (Number.isSafeInteger(properties.official_route_number)) values.add(properties.official_route_number);
  try {
    const tags = JSON.parse(properties.osm_tags_json ?? "{}");
    for (const token of String(tags.ref ?? "").split(/[;,/\s]+/u)) {
      if (/^[0-9]{4}$/u.test(token)) values.add(Number(token));
    }
  } catch {
    // Ungueltige Tags machen eine Kante nicht zur Referenzevidenz; der native
    // Ableiter prueft die eigentliche Gleisgeometrie spaeter erneut streng.
  }
  return values;
}

function insertAnchor(anchors, key, anchor) {
  const values = anchors.get(key) ?? [];
  const duplicate = values.find((value) => value.edgeId === anchor.edgeId && value.offsetMm === anchor.offsetMm);
  if (duplicate !== undefined) {
    if (anchor.rank < duplicate.rank || (anchor.rank === duplicate.rank && anchor.distanceMm < duplicate.distanceMm)) Object.assign(duplicate, anchor);
  } else values.push({ ...anchor });
  values.sort((left, right) => left.rank - right.rank
    || left.distanceMm - right.distanceMm
    || compareText(left.edgeId, right.edgeId)
    || left.offsetMm - right.offsetMm);
  if (values.length > MAX_ANCHORS_PER_STATION_ROUTE) values.length = MAX_ANCHORS_PER_STATION_ROUTE;
  anchors.set(key, values);
}

function usedResourceModel(network) {
  const eligibleSegments = network.segmentQualifications
    .filter((segment) => segment.orderable === true && segment.qualityClass !== "C");
  const resourceIds = new Set(eligibleSegments.flatMap((segment) => segment.resourceIds));
  const resources = network.resources.filter((resource) => resourceIds.has(resource.resourceId));
  const stations = new Map(network.stations.map((station) => [station.stationId, station]));
  const entries = new Map();
  for (const resource of resources) {
    for (const [stationId, kilometreMm] of [
      [resource.originStationId, resource.fromMm],
      [resource.destinationStationId, resource.toMm],
    ]) {
      const key = stationRouteKey(resource.routeNumber, stationId);
      const previous = entries.get(key);
      invariant(previous === undefined || previous.kilometreMm === kilometreMm, `${key} besitzt widerspruechliche Streckenkilometer.`);
      const station = stations.get(stationId);
      invariant(station !== undefined, `${key} verweist auf eine unbekannte Betriebsstelle.`);
      entries.set(key, Object.freeze({
        key,
        stationId,
        routeNumber: resource.routeNumber,
        kilometreMm,
        station,
      }));
    }
  }
  return { eligibleSegments, resourceIds, resources, entries };
}

async function corridorSeeds(corridorsPath, entries) {
  const usedRoutes = new Set([...entries.values()].map((entry) => entry.routeNumber));
  const missingByRoute = new Map();
  for (const entry of entries.values()) {
    if (Number.isSafeInteger(entry.station.latitudeE7) && Number.isSafeInteger(entry.station.longitudeE7)) continue;
    const values = missingByRoute.get(entry.routeNumber) ?? [];
    values.push(entry);
    missingByRoute.set(entry.routeNumber, values);
  }
  const seeds = new Map();
  const corridorCells = new Set();
  let matchedCorridors = 0;
  for await (const feature of readSequence(corridorsPath, "Amtliche Streckenkorridore")) {
    const properties = feature?.properties;
    if (!usedRoutes.has(properties?.route_number)) continue;
    const targets = missingByRoute.get(properties?.route_number);
    if (!Number.isSafeInteger(properties.from_km_mm) || !Number.isSafeInteger(properties.to_km_mm) || properties.from_km_mm === properties.to_km_mm) continue;
    let coordinates;
    try {
      coordinates = lineCoordinates(feature.geometry, `${properties.official_evidence_id ?? "Korridor"}.geometry`);
    } catch {
      continue;
    }
    addCorridorCells(corridorCells, coordinates);
    if (targets === undefined) continue;
    const low = Math.min(properties.from_km_mm, properties.to_km_mm);
    const high = Math.max(properties.from_km_mm, properties.to_km_mm);
    for (const target of targets) {
      if (target.kilometreMm < low || target.kilometreMm > high) continue;
      const fraction = (target.kilometreMm - properties.from_km_mm) / (properties.to_km_mm - properties.from_km_mm);
      const direct = pointAlong(coordinates, fraction);
      const reverse = pointAlong(coordinates, 1 - fraction);
      const values = seeds.get(target.key) ?? [];
      values.push(Object.freeze({ ...direct, provenance: "official-corridor-interpolation", evidenceId: properties.official_evidence_id ?? null }));
      if (direct.longitudeE7 !== reverse.longitudeE7 || direct.latitudeE7 !== reverse.latitudeE7) {
        values.push(Object.freeze({ ...reverse, provenance: "official-corridor-interpolation-reversed", evidenceId: properties.official_evidence_id ?? null }));
      }
      seeds.set(target.key, values);
      matchedCorridors += 1;
    }
  }
  for (const entry of entries.values()) {
    if (Number.isSafeInteger(entry.station.latitudeE7) && Number.isSafeInteger(entry.station.longitudeE7)) continue;
    invariant((seeds.get(entry.key) ?? []).length > 0, `${entry.key} besitzt weder freie Betriebsstellenkoordinate noch amtliche Korridorinterpolation.`);
  }
  return { seeds, matchedCorridors, corridorCells };
}

function seedGrid(entries, corridorData) {
  const seeds = [];
  for (const entry of entries.values()) {
    if (Number.isSafeInteger(entry.station.latitudeE7) && Number.isSafeInteger(entry.station.longitudeE7)) {
      seeds.push(Object.freeze({
        key: entry.key,
        routeNumber: entry.routeNumber,
        longitudeE7: entry.station.longitudeE7,
        latitudeE7: entry.station.latitudeE7,
        provenance: "network-observed-station-coordinate",
      }));
    } else {
      for (const seed of corridorData.seeds.get(entry.key) ?? []) seeds.push(Object.freeze({ key: entry.key, routeNumber: entry.routeNumber, ...seed }));
    }
  }
  const grid = new Map();
  for (const seed of seeds) {
    const key = gridKey(seed.longitudeE7, seed.latitudeE7);
    const values = grid.get(key) ?? [];
    values.push(seed);
    grid.set(key, values);
  }
  return { seeds, grid };
}

function nearbySeeds(grid, coordinates) {
  const values = new Map();
  for (const coordinate of coordinates) {
    const x = Math.floor(coordinate.longitudeE7 / GRID_E7);
    const y = Math.floor(coordinate.latitudeE7 / GRID_E7);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const seed of grid.get(`${x + dx}|${y + dy}`) ?? []) values.set(`${seed.key}|${seed.longitudeE7}|${seed.latitudeE7}`, seed);
    }
  }
  return values.values();
}

function touchesOfficialCorridor(cells, coordinates) {
  for (const coordinate of coordinates) {
    const x = Math.floor(coordinate.longitudeE7 / CORRIDOR_GRID_E7);
    const y = Math.floor(coordinate.latitudeE7 / CORRIDOR_GRID_E7);
    for (let dx = -CORRIDOR_CELL_RADIUS; dx <= CORRIDOR_CELL_RADIUS; dx += 1) for (let dy = -CORRIDOR_CELL_RADIUS; dy <= CORRIDOR_CELL_RADIUS; dy += 1) {
      if (cells.has(`${x + dx}|${y + dy}`)) return true;
    }
  }
  return false;
}

function strictEndpointAnchors(model, projection) {
  const resources = new Map(model.resources.map((resource) => [resource.resourceId, resource]));
  const anchors = new Map();
  for (const span of projection.spans) {
    const resource = resources.get(span.resourceId);
    if (resource === undefined) continue;
    if (span.resourceStartMm === 0) insertAnchor(anchors, stationRouteKey(resource.routeNumber, resource.originStationId), {
      edgeId: span.trackId,
      offsetMm: span.trackStartOffsetMm,
      distanceMm: 0,
      rank: 0,
      provenance: "official-kilometre-exact-endpoint",
    });
    if (span.resourceEndMm === resource.lengthMm) insertAnchor(anchors, stationRouteKey(resource.routeNumber, resource.destinationStationId), {
      edgeId: span.trackId,
      offsetMm: span.trackEndOffsetMm,
      distanceMm: 0,
      rank: 0,
      provenance: "official-kilometre-exact-endpoint",
    });
  }
  return anchors;
}

/**
 * Baut den kleinen, fuer die gepinnten Fahrplansegmente relevanten Teil des
 * beobachteten OSM-Gleisgraphen. Korridorgeometrie dient ausschliesslich als
 * Suchanker fuer Betriebsstellen ohne freie Punktkoordinate; jede ausgegebene
 * Fahrwegskante stammt unveraendert aus dem Tracks-Layer.
 */
export async function buildOperationalTrackGraph({ network, tracksPath, corridorsPath, strictProjection }) {
  const model = usedResourceModel(network);
  const usedRoutes = new Set(model.resources.map((resource) => resource.routeNumber));
  const corridorData = await corridorSeeds(corridorsPath, model.entries);
  const seeded = seedGrid(model.entries, corridorData);
  const anchors = strictEndpointAnchors(model, strictProjection);
  const edges = new Map();
  const seenOrderableTrackIds = new Set();
  const retainedByRoute = { official: 0, osmRef: 0, stationConnector: 0, corridorConnector: 0 };
  let tracksSeen = 0;
  let orderableTracksSeen = 0;
  let rejectedTracks = 0;

  for await (const feature of readSequence(tracksPath, "Deutschland-Gleisgeometrien")) {
    tracksSeen += 1;
    const properties = feature?.properties;
    if (properties?.orderable !== true || properties.quality_class === "C") continue;
    orderableTracksSeen += 1;
    if (typeof properties.feature_id === "string" && properties.feature_id !== "") {
      invariant(!seenOrderableTrackIds.has(properties.feature_id), `Gleiskante ${properties.feature_id} ist doppelt.`);
      seenOrderableTrackIds.add(properties.feature_id);
    }
    try {
      const edgeId = nonEmptyString(properties.feature_id, "track.feature_id");
      const fromNodeId = safeInteger(properties.from_osm_node_id, `${edgeId}.from_osm_node_id`);
      const toNodeId = safeInteger(properties.to_osm_node_id, `${edgeId}.to_osm_node_id`);
      const lengthMm = safeInteger(properties.length_mm, `${edgeId}.length_mm`, 1);
      invariant(fromNodeId !== toNodeId, `${edgeId} ist keine lineare Kante.`);
      const coordinates = lineCoordinates(feature.geometry, `${edgeId}.geometry`);
      const references = routeReferences(properties);
      const officialRelevant = usedRoutes.has(properties.official_route_number);
      const refRelevant = [...references].some((routeNumber) => usedRoutes.has(routeNumber));
      const corridorRelevant = touchesOfficialCorridor(corridorData.corridorCells, coordinates);
      let connector = false;
      for (const seed of nearbySeeds(seeded.grid, coordinates)) {
        const nearest = nearestOnTrack(seed, coordinates, lengthMm);
        if (nearest.distanceMm > MAX_ANCHOR_DISTANCE_MM) continue;
        connector = true;
        const routeMatch = references.has(seed.routeNumber);
        insertAnchor(anchors, seed.key, {
          edgeId,
          offsetMm: nearest.offsetMm,
          distanceMm: nearest.distanceMm,
          rank: routeMatch ? 1 : 2,
          provenance: seed.provenance,
        });
      }
      if (!officialRelevant && !refRelevant && !connector && !corridorRelevant) continue;
      invariant(!edges.has(edgeId), `Gleiskante ${edgeId} ist doppelt.`);
      const referencedUsedRoutes = [...references].filter((routeNumber) => usedRoutes.has(routeNumber)).sort((left, right) => left - right);
      edges.set(edgeId, Object.freeze({
        edgeId,
        fromNodeId,
        toNodeId,
        lengthMm,
        routeNumber: Number.isSafeInteger(properties.official_route_number)
          ? properties.official_route_number
          : referencedUsedRoutes[0] ?? null,
      }));
      if (officialRelevant) retainedByRoute.official += 1;
      else if (refRelevant) retainedByRoute.osmRef += 1;
      else if (connector) retainedByRoute.stationConnector += 1;
      else retainedByRoute.corridorConnector += 1;
    } catch {
      rejectedTracks += 1;
    }
  }

  for (const [key, values] of anchors) {
    const retained = values.filter((anchor) => edges.has(anchor.edgeId));
    invariant(retained.length > 0, `${key} besitzt keinen Anker auf einer beibehaltenen realen Gleiskante.`);
    anchors.set(key, Object.freeze(retained.map(Object.freeze)));
  }
  for (const entry of model.entries.values()) invariant(anchors.has(entry.key), `${entry.key} besitzt keinen realen Gleisanker.`);

  return Object.freeze({
    rule: OPERATIONAL_TRACK_GRAPH_RULE,
    eligibleSegments: Object.freeze(model.eligibleSegments),
    resources: Object.freeze(model.resources),
    entries: model.entries,
    edges,
    anchors,
    metrics: Object.freeze({
      tracksSeen,
      orderableTracksSeen,
      retainedTrackCount: edges.size,
      rejectedTracks,
      stationRouteCount: model.entries.size,
      stationSeedCount: seeded.seeds.length,
      corridorMatchedSeedCount: corridorData.matchedCorridors,
      strictEndpointAnchorCount: [...anchors.values()].flat().filter((value) => value.provenance === "official-kilometre-exact-endpoint").length,
      retainedByRoute: Object.freeze(retainedByRoute),
    }),
  });
}

export function anchorsForResource(graph, resource) {
  return Object.freeze({
    origins: graph.anchors.get(stationRouteKey(resource.routeNumber, resource.originStationId)) ?? Object.freeze([]),
    destinations: graph.anchors.get(stationRouteKey(resource.routeNumber, resource.destinationStationId)) ?? Object.freeze([]),
  });
}

function gtfsRoutingModel(snapshot) {
  invariant(snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot), "GTFS-Snapshot muss ein Objekt sein.");
  invariant(Array.isArray(snapshot.segments), "GTFS-Snapshot.segments muss eine Liste sein.");
  invariant(Array.isArray(snapshot.stations), "GTFS-Snapshot.stations muss eine Liste sein.");
  const eligibleSegments = snapshot.segments.filter((segment) => segment?.orderable === true && segment?.qualityClass === "B");
  const stopIds = new Set();
  for (const segment of eligibleSegments) {
    invariant(Array.isArray(segment.stops) && segment.stops.length >= 2, `${segment?.segmentId ?? "GTFS-Segment"} besitzt weniger als zwei Halte.`);
    for (const stop of segment.stops) stopIds.add(nonEmptyString(stop?.stopId, `${segment.segmentId}.stopId`));
  }
  const stationById = new Map();
  for (const station of snapshot.stations) {
    const stopId = nonEmptyString(station?.stopId, "GTFS-Station.stopId");
    invariant(!stationById.has(stopId), `GTFS-Stop ${stopId} ist doppelt.`);
    stationById.set(stopId, station);
  }
  const stations = [...stopIds].sort(compareText).map((stopId) => {
    const station = stationById.get(stopId);
    invariant(station !== undefined, `GTFS-Segment verweist auf unbekannten Stop ${stopId}.`);
    safeInteger(station.longitudeE7, `${stopId}.longitudeE7`, -1_800_000_000);
    safeInteger(station.latitudeE7, `${stopId}.latitudeE7`, -900_000_000);
    invariant(station.longitudeE7 <= 1_800_000_000 && station.latitudeE7 <= 900_000_000, `${stopId} liegt ausserhalb E7.`);
    return Object.freeze(station);
  });
  invariant(stations.length > 0, "Die GTFS-Routenauswahl besitzt keine Halte.");
  return Object.freeze({ eligibleSegments: Object.freeze(eligibleSegments), stations: Object.freeze(stations) });
}

function gtfsRoutingBounds(stations) {
  const longitude = stations.map((station) => station.longitudeE7);
  const latitude = stations.map((station) => station.latitudeE7);
  return Object.freeze({
    minimumLongitudeE7: Math.max(-1_800_000_000, Math.min(...longitude) - GTFS_ROUTING_MARGIN_E7),
    maximumLongitudeE7: Math.min(1_800_000_000, Math.max(...longitude) + GTFS_ROUTING_MARGIN_E7),
    minimumLatitudeE7: Math.max(-900_000_000, Math.min(...latitude) - GTFS_ROUTING_MARGIN_E7),
    maximumLatitudeE7: Math.min(900_000_000, Math.max(...latitude) + GTFS_ROUTING_MARGIN_E7),
  });
}

function intersectsBounds(coordinates, bounds) {
  let minimumLongitudeE7 = coordinates[0].longitudeE7;
  let maximumLongitudeE7 = coordinates[0].longitudeE7;
  let minimumLatitudeE7 = coordinates[0].latitudeE7;
  let maximumLatitudeE7 = coordinates[0].latitudeE7;
  for (const coordinate of coordinates.slice(1)) {
    minimumLongitudeE7 = Math.min(minimumLongitudeE7, coordinate.longitudeE7);
    maximumLongitudeE7 = Math.max(maximumLongitudeE7, coordinate.longitudeE7);
    minimumLatitudeE7 = Math.min(minimumLatitudeE7, coordinate.latitudeE7);
    maximumLatitudeE7 = Math.max(maximumLatitudeE7, coordinate.latitudeE7);
  }
  return maximumLongitudeE7 >= bounds.minimumLongitudeE7
    && minimumLongitudeE7 <= bounds.maximumLongitudeE7
    && maximumLatitudeE7 >= bounds.minimumLatitudeE7
    && minimumLatitudeE7 <= bounds.maximumLatitudeE7;
}

function gtfsSeedGrid(stations) {
  const grid = new Map();
  for (const station of stations) {
    const seed = Object.freeze({
      key: station.stopId,
      routeNumber: GTFS_SIMULATED_ROUTE_KEY,
      longitudeE7: station.longitudeE7,
      latitudeE7: station.latitudeE7,
      provenance: "pinned-gtfs-stop-coordinate",
    });
    const key = gridKey(seed.longitudeE7, seed.latitudeE7);
    const values = grid.get(key) ?? [];
    values.push(seed);
    grid.set(key, values);
  }
  return grid;
}

function disjointSet() {
  const parent = new Map();
  const find = (value) => {
    let root = value;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
    if (!parent.has(root)) parent.set(root, root);
    let cursor = value;
    while (parent.has(cursor) && parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    if (a < b) parent.set(b, a);
    else parent.set(a, b);
  };
  return Object.freeze({ find, union });
}

async function gtfsOfficialCorridorMetrics(corridorsPath, bounds) {
  let corridorsSeen = 0;
  let corridorsInRoutingBounds = 0;
  const routeNumbers = new Set();
  for await (const feature of readSequence(corridorsPath, "Amtliche Streckenkorridore")) {
    corridorsSeen += 1;
    const evidenceId = feature?.properties?.official_evidence_id ?? `Korridor ${corridorsSeen}`;
    const geometry = feature?.geometry;
    const parts = geometry?.type === "LineString"
      ? [lineCoordinates(geometry, `${evidenceId}.geometry`)]
      : geometry?.type === "MultiLineString" && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
        ? geometry.coordinates.map((coordinates, index) => lineCoordinates({ type: "LineString", coordinates }, `${evidenceId}.geometry[${index}]`))
        : null;
    invariant(parts !== null, `${evidenceId}.geometry ist weder LineString noch MultiLineString.`);
    if (!parts.some((coordinates) => intersectsBounds(coordinates, bounds))) continue;
    corridorsInRoutingBounds += 1;
    if (Number.isSafeInteger(feature?.properties?.route_number)) routeNumbers.add(feature.properties.route_number);
  }
  invariant(corridorsInRoutingBounds > 0, "Kein amtlicher Streckenkorridor schneidet den GTFS-Routingraum.");
  return Object.freeze({
    corridorsSeen,
    corridorsInRoutingBounds,
    officialRouteNumberCountInRoutingBounds: routeNumbers.size,
  });
}

/**
 * Baut einen rein geometrischen Simulationsgraphen fuer alle bestellbaren
 * Playable-Segmente des gepinnten GTFS-Snapshots. GTFS liefert ausschliesslich
 * Halte und Reihenfolge. Jede Kante bleibt eine beobachtete OSM-Gleisgeometrie;
 * amtliche Korridore werden nur als unabhaengige Raumabdeckungs-Evidenz gelesen.
 */
export async function buildGtfsTrackGraph({
  snapshot,
  tracksPath,
  corridorsPath,
  permittedProtectionModes = null,
  unknownMainlineSpeedKmh = 20,
  unknownServiceSpeedKmh = 10,
  allowUnmappedStops = false,
}) {
  const model = gtfsRoutingModel(snapshot);
  const playableArea = validatePlayableArea(snapshot.playableArea);
  if (snapshot.timetableGeneration !== undefined && playableArea === undefined) throw new Error("Generierter Fahrplan braucht die gepinnte Spielgebietsgrenze.");
  const permittedProtection = normalizePermittedProtectionModes(permittedProtectionModes);
  safeInteger(unknownMainlineSpeedKmh, "unknownMainlineSpeedKmh", 1);
  safeInteger(unknownServiceSpeedKmh, "unknownServiceSpeedKmh", 1);
  const bounds = gtfsRoutingBounds(model.stations);
  const corridorMetrics = await gtfsOfficialCorridorMetrics(corridorsPath, bounds);
  const grid = gtfsSeedGrid(model.stations);
  const anchors = new Map();
  const edges = new Map();
  const seenOrderableTrackIds = new Set();
  const components = disjointSet();
  let tracksSeen = 0;
  let orderableTracksSeen = 0;
  let observedOrderableTracksInRoutingBounds = 0;
  let incompatibleProtectionTrackCount = 0;
  let outsidePlayableTrackCount = 0;

  for await (const feature of readSequence(tracksPath, "Deutschland-Gleisgeometrien")) {
    tracksSeen += 1;
    const properties = feature?.properties;
    if (properties?.orderable !== true || properties?.quality_class === "C") continue;
    orderableTracksSeen += 1;
    const edgeId = nonEmptyString(properties.feature_id, `Track Datensatz ${tracksSeen}.feature_id`);
    invariant(!seenOrderableTrackIds.has(edgeId), `Gleiskante ${edgeId} ist doppelt.`);
    seenOrderableTrackIds.add(edgeId);
    const coordinates = lineCoordinates(feature.geometry, `${edgeId}.geometry`);
    if (!intersectsBounds(coordinates, bounds)) continue;
    if (!trackInsidePlayableArea(playableArea, coordinates)) {
      outsidePlayableTrackCount += 1;
      continue;
    }
    invariant(properties.feature_type === "track", `${edgeId} besitzt nicht feature_type=track.`);
    invariant(properties.source_id === "osm-pbf-deutschland", `${edgeId} stammt nicht aus dem gepinnten OSM-Layer.`);
    invariant(typeof properties.model_state === "string" && properties.model_state.startsWith("observed_osm_"), `${edgeId} behauptet keine beobachtete OSM-Topologie.`);
    invariant(properties.quality_class === "B", `${edgeId} ist keine bestellbare B-Gleiskante.`);
    const protectionSystems = canonicalTrackProtectionSystems(properties);
    if (permittedProtection !== null && !protectionSystems.some((system) => permittedProtection.includes(system))) {
      incompatibleProtectionTrackCount += 1;
      continue;
    }
    const fromNodeId = safeInteger(properties.from_osm_node_id, `${edgeId}.from_osm_node_id`);
    const toNodeId = safeInteger(properties.to_osm_node_id, `${edgeId}.to_osm_node_id`);
    const lengthMm = safeInteger(properties.length_mm, `${edgeId}.length_mm`, 1);
    invariant(fromNodeId !== toNodeId, `${edgeId} ist keine lineare Kante.`);
    invariant(!edges.has(edgeId), `Gleiskante ${edgeId} ist doppelt.`);
    const speeds = directionalTrackSpeeds(properties, unknownMainlineSpeedKmh, unknownServiceSpeedKmh);
    const tags = osmTags(properties, edgeId);
    const allowedDirections = ["yes", "true", "1"].includes(tags.oneway)
      ? ["along"] : ["-1", "reverse"].includes(tags.oneway) ? ["against"] : ["along", "against"];
    edges.set(edgeId, Object.freeze({
      edgeId,
      fromNodeId,
      toNodeId,
      lengthMm,
      routeNumber: GTFS_SIMULATED_ROUTE_KEY,
      protectionSystems,
      allowedDirections: Object.freeze(allowedDirections),
      ...speeds,
    }));
    components.union(fromNodeId, toNodeId);
    observedOrderableTracksInRoutingBounds += 1;
    for (const seed of nearbySeeds(grid, coordinates)) {
      const nearest = nearestOnTrack(seed, coordinates, lengthMm);
      if (nearest.distanceMm > MAX_ANCHOR_DISTANCE_MM) continue;
      insertAnchor(anchors, seed.key, {
        edgeId,
        offsetMm: nearest.offsetMm,
        distanceMm: nearest.distanceMm,
        rank: 1,
        provenance: seed.provenance,
      });
    }
  }

  invariant(allowUnmappedStops || edges.size > 0, "Der reale OSM-Gleisgraph im GTFS-Routingraum ist leer.");
  const componentByEdge = new Map();
  const edgeCountByComponent = new Map();
  for (const edge of edges.values()) {
    const componentId = components.find(edge.fromNodeId);
    componentByEdge.set(edge.edgeId, componentId);
    edgeCountByComponent.set(componentId, (edgeCountByComponent.get(componentId) ?? 0) + 1);
  }
  let maximumAnchorDistanceMm = 0;
  for (const station of model.stations) {
    const values = anchors.get(station.stopId) ?? [];
    invariant(allowUnmappedStops || values.length > 0, `GTFS-Stop ${station.stopId} besitzt keinen realen Gleisanker innerhalb ${MAX_ANCHOR_DISTANCE_MM} mm.`);
    for (const anchor of values) {
      invariant(componentByEdge.has(anchor.edgeId), `GTFS-Stop ${station.stopId} verweist auf eine verworfene Gleiskante.`);
      maximumAnchorDistanceMm = Math.max(maximumAnchorDistanceMm, anchor.distanceMm);
    }
    anchors.set(station.stopId, Object.freeze(values.map(Object.freeze)));
  }

  return Object.freeze({
    rule: GTFS_TRACK_GRAPH_RULE,
    simulatedRouteKey: GTFS_SIMULATED_ROUTE_KEY,
    eligibleSegments: model.eligibleSegments,
    stations: model.stations,
    edges,
    anchors,
    componentByEdge,
    edgeCountByComponent,
    metrics: Object.freeze({
      tracksSeen,
      orderableTracksSeen,
      observedOrderableTracksInRoutingBounds,
      permittedProtectionModes: permittedProtection,
      incompatibleProtectionTrackCount,
      outsidePlayableTrackCount,
      retainedTrackCount: edges.size,
      stationCount: model.stations.length,
      stationAnchorCount: [...anchors.values()].reduce((sum, values) => sum + values.length, 0),
      maximumAnchorDistanceMm,
      componentCount: edgeCountByComponent.size,
      routingMarginE7: GTFS_ROUTING_MARGIN_E7,
      bounds,
      officialCorridors: corridorMetrics,
    }),
  });
}
