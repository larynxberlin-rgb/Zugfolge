import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";

const EARTH_RADIUS_M = 6_378_137;
const MAX_DISTANCE_M = 35;
const AMBIGUITY_MARGIN_M = 2;
const MIN_DIRECTION_COSINE = 0.65;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseSequenceLine(raw, label) {
  const line = raw.replace(/^\x1e/u, "").trim();
  if (line === "") return null;
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${label} enthält ungültiges JSON: ${error.message}`);
  }
}

async function readSequence(path, label) {
  const values = [];
  for await (const raw of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
    const value = parseSequenceLine(raw, label);
    if (value !== null) values.push(value);
  }
  return values;
}

function segmentKey(segment) {
  return [
    segment.routeNumber,
    segment.direction.sourceValue,
    segment.fromKilometre.label,
    segment.toKilometre.label,
  ].join("|");
}

function geometryKey(properties) {
  return [
    properties.Streckennummer,
    properties.Richtung,
    properties.km_von_l,
    properties.km_bis_l,
  ].join("|");
}

function flattenLines(geometry) {
  invariant(geometry !== null && typeof geometry === "object", "Amtlicher Streckenabschnitt ohne Geometrie.");
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  throw new Error(`Amtlicher Streckenabschnitt mit nicht unterstützter Geometrie ${geometry.type}.`);
}

function mercator([longitude, latitude]) {
  invariant(Number.isFinite(longitude) && Number.isFinite(latitude), "Geometrie enthält keine endlichen Koordinaten.");
  invariant(longitude >= -180 && longitude <= 180 && latitude >= -85 && latitude <= 85, "Geometrie liegt außerhalb WebMercator.");
  const longitudeRadians = longitude * Math.PI / 180;
  const latitudeRadians = latitude * Math.PI / 180;
  return [
    EARTH_RADIUS_M * longitudeRadians,
    EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)),
  ];
}

function projectedLines(geometry) {
  return flattenLines(geometry).map((line) => {
    invariant(Array.isArray(line) && line.length >= 2, "Streckenlinie enthält weniger als zwei Punkte.");
    return line.map(mercator);
  });
}

function bbox(lines) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

function distanceSquaredToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return { distanceSquared: (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2, vector: [0, 0] };
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  const nearestX = start[0] + t * dx;
  const nearestY = start[1] + t * dy;
  return { distanceSquared: (point[0] - nearestX) ** 2 + (point[1] - nearestY) ** 2, vector: [dx, dy] };
}

function closestToLines(point, lines) {
  let closest = { distanceSquared: Infinity, vector: [0, 0] };
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const candidate = distanceSquaredToSegment(point, line[index - 1], line[index]);
      if (candidate.distanceSquared < closest.distanceSquared) closest = candidate;
    }
  }
  return closest;
}

function directionCosine(trackPoints, officialVector) {
  const trackVector = [
    trackPoints.at(-1)[0] - trackPoints[0][0],
    trackPoints.at(-1)[1] - trackPoints[0][1],
  ];
  const trackLength = Math.hypot(...trackVector);
  const officialLength = Math.hypot(...officialVector);
  if (trackLength === 0 || officialLength === 0) return 0;
  return Math.abs((trackVector[0] * officialVector[0] + trackVector[1] * officialVector[1]) / (trackLength * officialLength));
}

function trackSamples(geometry) {
  invariant(geometry?.type === "LineString" && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2, "OSM-Gleis ohne gültige LineString-Geometrie.");
  const points = geometry.coordinates.map(mercator);
  const selected = [points[0], points[Math.floor(points.length / 2)], points.at(-1)];
  return { points, selected };
}

function candidateScore(track, candidate, latitude) {
  const scale = Math.cos(latitude * Math.PI / 180);
  const expanded = MAX_DISTANCE_M / Math.max(scale, 0.5);
  const trackBox = bbox([track.points]);
  if (trackBox.maxX < candidate.bbox.minX - expanded || trackBox.minX > candidate.bbox.maxX + expanded
      || trackBox.maxY < candidate.bbox.minY - expanded || trackBox.minY > candidate.bbox.maxY + expanded) return null;
  const distances = [];
  let closestMiddle = null;
  for (let index = 0; index < track.selected.length; index += 1) {
    const closest = closestToLines(track.selected[index], candidate.lines);
    distances.push(Math.sqrt(closest.distanceSquared) * scale);
    if (index === 1) closestMiddle = closest;
  }
  const maximumDistanceM = Math.max(...distances);
  const meanDistanceM = distances.reduce((sum, value) => sum + value, 0) / distances.length;
  const cosine = directionCosine(track.points, closestMiddle.vector);
  if (maximumDistanceM > MAX_DISTANCE_M || cosine < MIN_DIRECTION_COSINE) return null;
  return { candidate, maximumDistanceM, meanDistanceM, directionCosine: cosine };
}

function routeNumbers(tags) {
  if (typeof tags?.ref !== "string") return [];
  return [...new Set(tags.ref.match(/(?<!\d)\d{4}(?!\d)/gu) ?? [])]
    .map(Number)
    .sort((left, right) => left - right);
}

function evidenceSignature(segment) {
  return JSON.stringify({
    speed: segment.speed,
    electrification: segment.electrification,
    trackCount: segment.trackCount,
    construction: segment.construction,
    dbOperation: segment.dbOperation,
  });
}

export function chooseOfficialMatch(feature, officialByRoute) {
  const tags = JSON.parse(feature.properties.osm_tags_json);
  const routes = routeNumbers(tags);
  if (routes.length === 0) return { status: "unmatched", reason: "missing-numeric-route-reference" };
  const candidates = routes.flatMap((route) => officialByRoute.get(route) ?? []);
  if (candidates.length === 0) return { status: "unmatched", reason: "route-not-in-official-source" };
  const track = trackSamples(feature.geometry);
  const latitude = feature.geometry.coordinates[Math.floor(feature.geometry.coordinates.length / 2)][1];
  const scores = candidates
    .map((candidate) => candidateScore(track, candidate, latitude))
    .filter((score) => score !== null)
    .sort((left, right) => left.meanDistanceM - right.meanDistanceM
      || left.maximumDistanceM - right.maximumDistanceM
      || compareText(left.candidate.segment.trackSegmentId, right.candidate.segment.trackSegmentId));
  if (scores.length === 0) return { status: "unmatched", reason: "route-geometry-too-far-or-crossing" };
  const best = scores[0];
  const near = scores.filter(({ meanDistanceM }) => meanDistanceM <= best.meanDistanceM + AMBIGUITY_MARGIN_M);
  const signatures = new Set(near.map(({ candidate }) => evidenceSignature(candidate.segment)));
  if (signatures.size > 1) {
    return { status: "unmatched", reason: "ambiguous-parallel-official-evidence", candidateCount: near.length };
  }
  return {
    status: "matched",
    segment: best.candidate.segment,
    meanDistanceMm: Math.round(best.meanDistanceM * 1_000),
    maximumDistanceMm: Math.round(best.maximumDistanceM * 1_000),
    directionCosineMillionths: Math.round(best.directionCosine * 1_000_000),
    equivalentCandidateCount: near.length,
  };
}

function effectiveSpeed(properties, officialSpeed) {
  if (officialSpeed.status !== "known") return properties;
  const official = officialSpeed.maximumKmh;
  const forwardObserved = properties.speed_forward_model !== "conservative_default";
  const backwardObserved = properties.speed_backward_model !== "conservative_default";
  return {
    ...properties,
    speed_forward_kmh: forwardObserved ? Math.min(properties.speed_forward_kmh, official) : official,
    speed_backward_kmh: backwardObserved ? Math.min(properties.speed_backward_kmh, official) : official,
    speed_forward_model: forwardObserved ? "conservative_min_osm_and_official" : "observed_official_section",
    speed_backward_model: backwardObserved ? "conservative_min_osm_and_official" : "observed_official_section",
  };
}

export function enrichTrackFeature(feature, match) {
  if (match.status !== "matched") return feature;
  const segment = match.segment;
  const properties = effectiveSpeed(feature.properties, segment.speed);
  return {
    ...feature,
    properties: {
      ...properties,
      model_state: "observed_osm_topology_enriched_official_route_segment",
      official_evidence_id: segment.trackSegmentId,
      official_route_number: segment.routeNumber,
      official_direction: segment.direction.kind,
      official_from_km_mm: segment.fromKilometre.millimetres,
      official_to_km_mm: segment.toKilometre.millimetres,
      official_speed_kmh: segment.speed.status === "known" ? segment.speed.maximumKmh : null,
      official_electrification: segment.electrification.kind,
      official_track_count: segment.trackCount.status === "known" ? segment.trackCount.count : null,
      official_construction: segment.construction.status,
      official_db_operation: segment.dbOperation.status,
      official_match_mean_distance_mm: match.meanDistanceMm,
      official_match_max_distance_mm: match.maximumDistanceMm,
      official_match_direction_cosine_millionths: match.directionCosineMillionths,
    },
  };
}

function officialCorridorFeature(candidate) {
  const segment = candidate.segment;
  return {
    type: "Feature",
    properties: {
      feature_id: `rail-corridor:${segment.trackSegmentId}`,
      feature_type: "rail-corridor",
      quality_class: "B",
      model_state: "observed_official_route_segment",
      orderable: false,
      source_id: "db-infrago-infrastructure-open-data",
      official_evidence_id: segment.trackSegmentId,
      route_number: segment.routeNumber,
      direction: segment.direction.kind,
      route_name: segment.routeName,
      from_km_mm: segment.fromKilometre.millimetres,
      to_km_mm: segment.toKilometre.millimetres,
      maximum_speed_kmh: segment.speed.status === "known" ? segment.speed.maximumKmh : null,
      electrification: segment.electrification.kind,
      track_count: segment.trackCount.status === "known" ? segment.trackCount.count : null,
      construction: segment.construction.status,
      db_operation: segment.dbOperation.status,
    },
    geometry: candidate.geometry,
  };
}

function operatingPointFeature(place) {
  return {
    type: "Feature",
    properties: {
      feature_id: `operating-point:rl100:${encodeURIComponent(place.rl100)}`,
      feature_type: "operating-point",
      quality_class: "B",
      model_state: "observed_official_operating_place",
      orderable: false,
      source_id: "db-infrago-infrastructure-open-data",
      official_evidence_id: place.operatingPlaceId,
      rl100: place.rl100,
      name: place.name,
      types_json: JSON.stringify(place.types),
      operating_states_json: JSON.stringify(place.operatingStates),
      route_numbers_json: JSON.stringify([...new Set(place.routeBindings.map(({ routeNumber }) => routeNumber))].sort((a, b) => a - b)),
      official_coordinate_candidates_json: JSON.stringify(place.coordinateCandidatesE7),
    },
    geometry: {
      type: "Point",
      coordinates: [place.coordinateE7.longitude / 10_000_000, place.coordinateE7.latitude / 10_000_000],
    },
  };
}

async function prepareOfficial(normalizedSegmentsPath, geometryPath) {
  const [segments, geometries] = await Promise.all([
    readSequence(normalizedSegmentsPath, "Normalisierte InfraGO-Segmente"),
    readSequence(geometryPath, "InfraGO-Geometrien"),
  ]);
  const byKey = new Map();
  for (const segment of segments) {
    invariant(segment.schema === "zugfolge-infrago-track-segment/v1", "Unbekanntes normalisiertes InfraGO-Segment.");
    const key = segmentKey(segment);
    invariant(!byKey.has(key), `Normalisiertes InfraGO-Segment ist für ${key} doppelt.`);
    byKey.set(key, segment);
  }
  const candidates = geometries.map((feature) => {
    invariant(feature?.type === "Feature", "InfraGO-Geometriedatei enthält kein Feature.");
    const key = geometryKey(feature.properties);
    const segment = byKey.get(key);
    invariant(segment !== undefined, `InfraGO-Geometrie ${key} besitzt keinen normalisierten Attributbeleg.`);
    const lines = projectedLines(feature.geometry);
    return { segment, geometry: feature.geometry, lines, bbox: bbox(lines) };
  }).sort((left, right) => compareText(left.segment.trackSegmentId, right.segment.trackSegmentId));
  invariant(candidates.length === segments.length, `InfraGO-Geometrien (${candidates.length}) und Segmente (${segments.length}) sind nicht vollständig bijektiv.`);
  const byRoute = new Map();
  for (const candidate of candidates) {
    const values = byRoute.get(candidate.segment.routeNumber) ?? [];
    values.push(candidate);
    byRoute.set(candidate.segment.routeNumber, values);
  }
  return { candidates, byRoute };
}

async function writeLines(path, values) {
  const stream = createWriteStream(path, { encoding: "utf8", flags: "wx" });
  const hash = createHash("sha256");
  let bytes = 0;
  for (const value of values) {
    const line = `\x1e${JSON.stringify(value)}\n`;
    hash.update(line);
    bytes += Buffer.byteLength(line);
    if (!stream.write(line)) await new Promise((accept) => stream.once("drain", accept));
  }
  stream.end();
  await finished(stream);
  return { bytes, sha256: hash.digest("hex"), features: values.length };
}

function increment(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

async function enrichTracks(inputPath, outputPath, officialByRoute) {
  const stream = createWriteStream(outputPath, { encoding: "utf8", flags: "wx" });
  const hash = createHash("sha256");
  const outcomes = {};
  const officialAttributes = { speed: 0, electrification: 0, trackCount: 0 };
  let features = 0;
  let matchedLengthMm = 0;
  let totalLengthMm = 0;
  let previousId = null;
  for await (const raw of createInterface({ input: createReadStream(inputPath, "utf8"), crlfDelay: Infinity })) {
    const feature = parseSequenceLine(raw, "Semantische OSM-Gleise");
    if (feature === null) continue;
    const id = feature.properties?.feature_id;
    invariant(typeof id === "string" && (previousId === null || compareText(previousId, id) < 0), "OSM-Gleise sind nicht streng nach feature_id sortiert.");
    previousId = id;
    const match = chooseOfficialMatch(feature, officialByRoute);
    const reason = match.status === "matched" ? "matched" : match.reason;
    increment(outcomes, reason);
    const lengthMm = feature.properties.length_mm;
    invariant(Number.isSafeInteger(lengthMm) && lengthMm > 0, `Gleis ${id} ohne gültige Länge.`);
    totalLengthMm += lengthMm;
    if (match.status === "matched") {
      matchedLengthMm += lengthMm;
      if (match.segment.speed.status === "known") officialAttributes.speed += 1;
      if (!match.segment.electrification.kind.startsWith("unknown-")) officialAttributes.electrification += 1;
      if (match.segment.trackCount.status === "known") officialAttributes.trackCount += 1;
    }
    const line = `\x1e${JSON.stringify(enrichTrackFeature(feature, match))}\n`;
    hash.update(line);
    if (!stream.write(line)) await new Promise((accept) => stream.once("drain", accept));
    features += 1;
  }
  stream.end();
  await finished(stream);
  const metadata = await stat(outputPath);
  return { features, bytes: metadata.size, sha256: hash.digest("hex"), totalLengthMm, matchedLengthMm, outcomes, officialAttributes };
}

async function fsyncFile(path) {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function buildInfraGoSpatialCrosswalk({
  tracksPath,
  normalizedSegmentsPath,
  normalizedOperatingPlacesPath,
  officialGeometryPath,
  outputRoot,
}) {
  const destination = resolve(outputRoot);
  const staging = `${destination}.building`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(staging, { recursive: true, force: true });
  invariant(!(await stat(destination).catch(() => null)), `Ziel ${destination} existiert bereits.`);
  await mkdir(staging, { recursive: false });
  try {
    const official = await prepareOfficial(resolve(normalizedSegmentsPath), resolve(officialGeometryPath));
    const operatingPlaces = await readSequence(resolve(normalizedOperatingPlacesPath), "Normalisierte InfraGO-Betriebsstellen");
    const corridorFeatures = official.candidates.map(officialCorridorFeature)
      .sort((left, right) => compareText(left.properties.feature_id, right.properties.feature_id));
    const operatingPointFeatures = operatingPlaces.map(operatingPointFeature)
      .sort((left, right) => compareText(left.properties.feature_id, right.properties.feature_id));
    const outputs = {
      tracks: await enrichTracks(resolve(tracksPath), resolve(staging, "tracks.geojsonseq"), official.byRoute),
      railCorridors: await writeLines(resolve(staging, "rail-corridors.geojsonseq"), corridorFeatures),
      operatingPoints: await writeLines(resolve(staging, "operating-points.geojsonseq"), operatingPointFeatures),
    };
    const report = {
      schema: "zugfolge-infrago-spatial-crosswalk-report/v1",
      policy: {
        routeReferenceRequired: true,
        maximumDistanceM: MAX_DISTANCE_M,
        minimumDirectionCosine: MIN_DIRECTION_COSINE,
        ambiguityMarginM: AMBIGUITY_MARGIN_M,
        ambiguousEvidenceApplied: false,
        classAGranted: false,
        observedSpeedConflict: "minimum-for-safe-operation",
      },
      official: { trackSegments: official.candidates.length, operatingPlaces: operatingPlaces.length },
      outputs,
    };
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    await (await import("node:fs/promises")).writeFile(resolve(staging, "infrago-spatial-crosswalk-report.json"), reportText, { encoding: "utf8", flag: "wx" });
    for (const file of ["tracks.geojsonseq", "rail-corridors.geojsonseq", "operating-points.geojsonseq", "infrago-spatial-crosswalk-report.json"]) {
      await fsyncFile(resolve(staging, file));
    }
    await rename(staging, destination);
    return report;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export const INFRAGO_SPATIAL_CROSSWALK_POLICY = Object.freeze({
  maximumDistanceM: MAX_DISTANCE_M,
  ambiguityMarginM: AMBIGUITY_MARGIN_M,
  minimumDirectionCosine: MIN_DIRECTION_COSINE,
});
