import { createHash } from "node:crypto";

const EARTH_LATITUDE_MICROMM_PER_E7 = 11_132;
const EARTH_LONGITUDE_MICROMM_PER_E7_AT_51N = 6_999;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pointInPolygon(longitude, latitude, polygon) {
  let result = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const [cx, cy] = polygon[current];
    const [px, py] = polygon[previous];
    if ((cy > latitude) !== (py > latitude)
      && longitude < (px - cx) * (latitude - cy) / (py - cy) + cx) result = !result;
  }
  return result;
}

function normalizedName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .replaceAll(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function distanceMm(left, right) {
  const latitude = (left.latitudeE7 - right.latitudeE7) * EARTH_LATITUDE_MICROMM_PER_E7;
  const longitude = (left.longitudeE7 - right.longitudeE7) * EARTH_LONGITUDE_MICROMM_PER_E7_AT_51N;
  return Math.round(Math.sqrt(latitude * latitude + longitude * longitude) / 1_000);
}

class MinHeap {
  values = [];

  push(value) {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].costMm <= value.costMm) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop() {
    if (this.values.length === 0) return undefined;
    const first = this.values[0];
    const last = this.values.pop();
    if (this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && this.values[right].costMm < this.values[left].costMm ? right : left;
      if (this.values[child].costMm >= last.costMm) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function shortestPath(adjacency, origin, destination) {
  if (origin === destination) return { distanceMm: 0, resourceIds: [] };
  const costs = new Map([[origin, 0]]);
  const previous = new Map();
  const heap = new MinHeap();
  heap.push({ stationId: origin, costMm: 0 });
  while (heap.values.length > 0) {
    const current = heap.pop();
    if (current.costMm !== costs.get(current.stationId)) continue;
    if (current.stationId === destination) break;
    for (const edge of adjacency.get(current.stationId) ?? []) {
      const candidate = current.costMm + edge.lengthMm;
      if (candidate >= (costs.get(edge.destinationStationId) ?? Number.MAX_SAFE_INTEGER)) continue;
      costs.set(edge.destinationStationId, candidate);
      previous.set(edge.destinationStationId, { stationId: current.stationId, resourceId: edge.resourceId });
      heap.push({ stationId: edge.destinationStationId, costMm: candidate });
    }
  }
  if (!costs.has(destination)) return null;
  const resourceIds = [];
  let cursor = destination;
  while (cursor !== origin) {
    const step = previous.get(cursor);
    if (step === undefined) return null;
    resourceIds.push(step.resourceId);
    cursor = step.stationId;
  }
  resourceIds.reverse();
  return { distanceMm: costs.get(destination), resourceIds };
}

function masterStation(raw) {
  const latitude = raw.geo_koordinaten?.breite;
  const longitude = raw.geo_koordinaten?.laenge;
  if (typeof raw.ds100 !== "string") return null;
  return {
    stationId: raw.ds100,
    name: raw.langname ?? raw.ds100,
    primaryLocationCode: raw.primary_location_code ?? null,
    latitudeE7: Number.isFinite(latitude) ? Math.round(latitude * 10_000_000) : null,
    longitudeE7: Number.isFinite(longitude) ? Math.round(longitude * 10_000_000) : null,
    electrified: raw.elektrifiziert === true,
    station: raw.bahnhof === true,
  };
}

function buildResources(segments, selectedIds) {
  const unique = new Map();
  for (const segment of segments) {
    if (!selectedIds.has(segment.von) || !selectedIds.has(segment.bis)) continue;
    const fromMm = Math.round(Number(segment.von_km) * 1_000_000);
    const toMm = Math.round(Number(segment.bis_km) * 1_000_000);
    const lengthMm = Math.abs(toMm - fromMm);
    if (!Number.isSafeInteger(lengthMm) || lengthMm <= 0) continue;
    const routeNumber = Math.trunc(Number(segment.streckennummer));
    const resourceId = `tf-${routeNumber}-${segment.von}-${segment.bis}-${fromMm}-${toMm}`;
    unique.set(resourceId, {
      resourceId,
      routeNumber,
      originStationId: segment.von,
      destinationStationId: segment.bis,
      fromMm,
      toMm,
      lengthMm,
      qualityClass: "B",
      orderable: true,
    });
  }
  return [...unique.values()].sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

export function buildOperationalNetwork({ masterData, gtfsSnapshot, regionBoundary, matchingRadiusMm = 2_500_000 }) {
  const polygonFeature = regionBoundary.features.find((feature) => feature.geometry?.type === "Polygon");
  if (polygonFeature === undefined) throw new Error("Die Regionsgrenze enthaelt kein Polygon.");
  const polygon = polygonFeature.geometry.coordinates[0];
  const gatewayNames = new Set(regionBoundary.features
    .filter((feature) => feature.geometry?.type === "Point")
    .map((feature) => normalizedName(feature.properties?.name)));
  const allMasterStations = masterData.ordnungsrahmen.betriebsstellen.map(masterStation).filter(Boolean);
  const allStationById = new Map(allMasterStations.map((station) => [station.stationId, station]));
  for (const segment of masterData.ordnungsrahmen.streckensegmente) {
    for (const stationId of [segment.von, segment.bis]) {
      if (!allStationById.has(stationId)) allStationById.set(stationId, {
        stationId,
        name: stationId,
        primaryLocationCode: null,
        latitudeE7: null,
        longitudeE7: null,
        electrified: false,
        station: false,
      });
    }
  }
  const selectedIds = new Set(allMasterStations.filter((station) => (
    station.latitudeE7 !== null
    && station.longitudeE7 !== null
    && pointInPolygon(station.longitudeE7 / 10_000_000, station.latitudeE7 / 10_000_000, polygon)
  ) || gatewayNames.has(normalizedName(station.name))).map((station) => station.stationId));
  const incidentSegments = new Map();
  for (const segment of masterData.ordnungsrahmen.streckensegmente) {
    for (const stationId of [segment.von, segment.bis]) {
      const values = incidentSegments.get(stationId) ?? [];
      values.push(segment);
      incidentSegments.set(stationId, values);
    }
  }
  const frontier = [...selectedIds];
  while (frontier.length > 0) {
    const stationId = frontier.pop();
    for (const segment of incidentSegments.get(stationId) ?? []) {
      const neighborId = segment.von === stationId ? segment.bis : segment.von;
      const neighbor = allStationById.get(neighborId);
      if (selectedIds.has(neighborId) || neighbor?.latitudeE7 !== null) continue;
      selectedIds.add(neighborId);
      frontier.push(neighborId);
    }
  }
  const stations = [...selectedIds].map((stationId) => allStationById.get(stationId));
  stations.sort((left, right) => left.stationId.localeCompare(right.stationId));
  const stationById = new Map(stations.map((station) => [station.stationId, station]));
  const resources = buildResources(masterData.ordnungsrahmen.streckensegmente, new Set(stationById.keys()));
  const adjacency = new Map();
  for (const resource of resources) {
    const edges = adjacency.get(resource.originStationId) ?? [];
    edges.push(resource);
    adjacency.set(resource.originStationId, edges);
  }
  for (const edges of adjacency.values()) edges.sort((left, right) => left.resourceId.localeCompare(right.resourceId));

  const gtfsStationMappings = gtfsSnapshot.stations.map((station) => {
    let nearest = null;
    let nearestDistanceMm = Number.MAX_SAFE_INTEGER;
    for (const candidate of stations) {
      if (candidate.latitudeE7 === null || candidate.longitudeE7 === null) continue;
      const candidateDistanceMm = distanceMm(station, candidate);
      if (candidateDistanceMm < nearestDistanceMm
        || (candidateDistanceMm === nearestDistanceMm && candidate.stationId < nearest.stationId)) {
        nearest = candidate;
        nearestDistanceMm = candidateDistanceMm;
      }
    }
    return {
      stopId: station.stopId,
      stationId: nearestDistanceMm <= matchingRadiusMm ? nearest.stationId : null,
      distanceMm: nearestDistanceMm <= matchingRadiusMm ? nearestDistanceMm : null,
      qualityClass: nearestDistanceMm <= matchingRadiusMm ? "B" : "C",
    };
  }).sort((left, right) => left.stopId.localeCompare(right.stopId));
  const mappingByStop = new Map(gtfsStationMappings.map((mapping) => [mapping.stopId, mapping]));
  const routeCache = new Map();
  const segmentQualifications = [];
  for (const segment of gtfsSnapshot.segments) {
    const reasons = [];
    const resourceIds = [];
    let distance = 0;
    for (let index = 1; index < segment.stops.length; index += 1) {
      const from = mappingByStop.get(segment.stops[index - 1].stopId)?.stationId ?? null;
      const to = mappingByStop.get(segment.stops[index].stopId)?.stationId ?? null;
      if (from === null || to === null) {
        reasons.push(`unmapped-stop:${segment.stops[index - (from === null ? 1 : 0)].stopId}`);
        continue;
      }
      const cacheId = `${from}->${to}`;
      if (!routeCache.has(cacheId)) routeCache.set(cacheId, shortestPath(adjacency, from, to));
      const path = routeCache.get(cacheId);
      if (path === null) {
        reasons.push(`no-operational-path:${from}->${to}`);
        continue;
      }
      distance += path.distanceMm;
      resourceIds.push(...path.resourceIds);
    }
    const uniqueResourceIds = [...new Set(resourceIds)];
    const qualityClass = reasons.length === 0 ? "B" : "C";
    segmentQualifications.push({
      segmentId: segment.segmentId,
      journeyChainId: segment.journeyChainId,
      qualityClass,
      orderable: qualityClass !== "C" && segment.orderable,
      distanceMm: qualityClass === "C" ? null : distance,
      resourceIds: qualityClass === "C" ? [] : uniqueResourceIds,
      missingEvidence: [...new Set(reasons)].sort(),
    });
  }
  segmentQualifications.sort((left, right) => left.segmentId.localeCompare(right.segmentId));
  const qualificationBySegment = new Map(segmentQualifications.map((qualification) => [qualification.segmentId, qualification]));
  const journeyChainQualifications = gtfsSnapshot.journeyChains.map((chain) => {
    const playable = chain.legs.filter((leg) => leg.kind === "playable");
    const qualifications = playable.map((leg) => qualificationBySegment.get(leg.legId));
    const orderable = playable.length > 0 && qualifications.every((qualification) => qualification?.orderable === true);
    return {
      journeyChainId: chain.journeyChainId,
      qualityClass: orderable ? "B" : "C",
      orderable,
      playableSegmentIds: playable.map((leg) => leg.legId),
    };
  }).sort((left, right) => left.journeyChainId.localeCompare(right.journeyChainId));
  const output = {
    schema: "zugfolge-operational-network/v1",
    regionId: gtfsSnapshot.regionId,
    infrastructureId: masterData.id,
    timetableYear: masterData.fahrplanjahr,
    validFrom: masterData.gueltig_von,
    validUntil: masterData.gueltig_bis,
    matchingRadiusMm,
    policy: {
      A: "Unabhaengig betrieblich validiert.",
      B: "Auf den freigegebenen Jahres-Infrastrukturgraphen abgebildet.",
      C: "Nicht vollstaendig abbildbar; sichtbar, aber nicht bestellbar.",
    },
    metrics: {
      masterStationCount: stations.length,
      topologyConnectorCount: stations.filter((station) => station.latitudeE7 === null).length,
      conflictResourceCount: resources.length,
      mappedGtfsStationCount: gtfsStationMappings.filter((mapping) => mapping.stationId !== null).length,
      unmappedGtfsStationCount: gtfsStationMappings.filter((mapping) => mapping.stationId === null).length,
      qualityBSegmentCount: segmentQualifications.filter((qualification) => qualification.qualityClass === "B").length,
      qualityCSegmentCount: segmentQualifications.filter((qualification) => qualification.qualityClass === "C").length,
      orderableJourneyChainCount: journeyChainQualifications.filter((qualification) => qualification.orderable).length,
    },
    stations,
    resources,
    gtfsStationMappings,
    segmentQualifications,
    journeyChainQualifications,
  };
  return { network: output, networkHash: createHash("sha256").update(canonical(output)).digest("hex") };
}
