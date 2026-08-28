import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

export const GERMANY_OPERATIONAL_SOURCE_REPORT_SCHEMA =
  "zugfolge-germany-operational-source-compiler-report/v1";
export const EDGE_GEOMETRY_DERIVATION_RULE =
  "osm-semantic-e7-integer-distance-and-geodesic-bearing/v1";
export const TRAIN_PROTECTION_DERIVATION_RULE =
  "osm-explicit-canonical-train-protection/v1";
export const RESOURCE_BINDING_DERIVATION_RULE =
  "osm-semantic-conflict-resource-identity/v1";
export const PLATFORM_ANCHOR_DERIVATION_RULE =
  "exact-e7-coordinate-and-track-ref/v1";

const CANONICAL_PROTECTION_SYSTEMS = Object.freeze([
  "etcs-level1",
  "etcs-level2",
  "lzb",
  "pzb",
]);
const CONTEXT_TAGS = Object.freeze(["building", "man_made"]);
const SAMPLE_LIMIT = 10;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value !== "", `${name} fehlt.`);
  return value;
}

function safeInteger(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} ist keine gueltige Ganzzahl.`);
  return value;
}

function relativePath(value, name) {
  const portable = typeof value === "string" ? value.replaceAll("\\", "/") : "";
  invariant(
    typeof value === "string"
      && value !== ""
      && !isAbsolute(value)
      && !/^[A-Za-z]:\//u.test(portable)
      && !portable.startsWith("//")
      && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(portable)
      && !portable.split("/").includes(".."),
    `${name} muss innerhalb der Quellenwurzel liegen.`,
  );
  return value;
}

function featureIdentity(feature, expectedType, label) {
  invariant(feature?.type === "Feature" && isRecord(feature.properties), `${label} ist kein GeoJSON-Feature.`);
  invariant(feature.properties.feature_type === expectedType, `${label} besitzt nicht den Typ ${expectedType}.`);
  return nonEmptyString(feature.properties.feature_id, `${label}.feature_id`);
}

function parseTags(properties, name) {
  invariant(typeof properties.osm_tags_json === "string", `${name}.osm_tags_json fehlt.`);
  const tags = JSON.parse(properties.osm_tags_json);
  invariant(isRecord(tags) && Object.values(tags).every((value) => typeof value === "string"), `${name}.osm_tags_json ist ungueltig.`);
  return tags;
}

function uniqueSortedStrings(serialized, name, { allowEmpty = false } = {}) {
  invariant(typeof serialized === "string", `${name} fehlt.`);
  const values = JSON.parse(serialized);
  invariant(Array.isArray(values) && (allowEmpty || values.length > 0), `${name} ist leer oder ungueltig.`);
  invariant(values.every((value) => typeof value === "string" && value !== ""), `${name} enthaelt ungueltige Kennungen.`);
  const sorted = [...new Set(values)].sort(compareText);
  invariant(sorted.length === values.length, `${name} muss eindeutig sein.`);
  return sorted;
}

function coordinateE7(value, minimum, maximum, name) {
  invariant(typeof value === "number" && Number.isFinite(value), `${name} ist keine Koordinate.`);
  const scaled = Math.round(value * 10_000_000);
  invariant(Number.isSafeInteger(scaled) && scaled >= minimum && scaled <= maximum, `${name} liegt ausserhalb E7.`);
  invariant(Math.abs(value - scaled / 10_000_000) <= 1e-12, `${name} ist nicht verlustfrei als E7 darstellbar.`);
  return scaled;
}

function e7LineString(feature, name) {
  const geometry = feature.geometry;
  invariant(geometry?.type === "LineString" && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2, `${name} besitzt keinen LineString.`);
  return geometry.coordinates.map((coordinate, index) => {
    invariant(Array.isArray(coordinate) && coordinate.length === 2, `${name}.coordinates[${index}] ist kein zweidimensionaler Punkt.`);
    return Object.freeze({
      longitudeE7: coordinateE7(coordinate[0], -1_800_000_000, 1_800_000_000, `${name}.coordinates[${index}].longitude`),
      latitudeE7: coordinateE7(coordinate[1], -900_000_000, 900_000_000, `${name}.coordinates[${index}].latitude`),
    });
  });
}

function integerSqrt(value) {
  invariant(typeof value === "bigint" && value >= 0n, "Ganzzahlwurzel erhielt einen ungueltigen Wert.");
  if (value <= 1n) return value;
  let estimate = value;
  while (true) {
    const next = (estimate + value / estimate) / 2n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

function coordinateDistanceMm(left, right) {
  const latitude = BigInt(left.latitudeE7 - right.latitudeE7) * 11_132n;
  const longitude = BigInt(left.longitudeE7 - right.longitudeE7) * 6_999n;
  const millimetres = (integerSqrt(latitude * latitude + longitude * longitude) + 500n) / 1_000n;
  invariant(millimetres <= BigInt(Number.MAX_SAFE_INTEGER), "E7-Segmentlaenge ist zu gross.");
  return Number(millimetres);
}

function bearingMilliDegrees(start, end) {
  const latitude1 = start.latitudeE7 / 10_000_000 * Math.PI / 180;
  const latitude2 = end.latitudeE7 / 10_000_000 * Math.PI / 180;
  const deltaLongitude = (end.longitudeE7 - start.longitudeE7) / 10_000_000 * Math.PI / 180;
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);
  const x = Math.cos(latitude1) * Math.sin(latitude2)
    - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude);
  invariant(x !== 0 || y !== 0, "Segmentrichtung kollabiert.");
  const degrees = Math.atan2(y, x) * 180 / Math.PI;
  return Math.round(((degrees % 360) + 360) % 360 * 1_000) % 360_000;
}

function geometryPoints(coordinates, declaredLengthMm, name) {
  let offset = 0;
  const points = coordinates.map((coordinate, index) => {
    if (index > 0) {
      const distance = coordinateDistanceMm(coordinates[index - 1], coordinate);
      invariant(distance > 0, `${name} kollabiert an Punkt ${index}.`);
      offset = safeInteger(offset + distance, `${name}.offset`, 1);
    }
    return {
      edgeOffsetMm: offset,
      latitudeE7: coordinate.latitudeE7,
      longitudeE7: coordinate.longitudeE7,
      bearingMilliDegrees: index === coordinates.length - 1
        ? null
        : bearingMilliDegrees(coordinate, coordinates[index + 1]),
    };
  });
  invariant(offset === declaredLengthMm, `${name} besitzt ${declaredLengthMm} mm, die unveraenderte E7-Geometrie aber ${offset} mm.`);
  return points;
}

function sameCoordinate(left, right) {
  return left.latitudeE7 === right.latitudeE7 && left.longitudeE7 === right.longitudeE7;
}

function isClosed(coordinates) {
  return sameCoordinate(coordinates[0], coordinates.at(-1));
}

export function classifyClosedTrackContext(feature) {
  const id = featureIdentity(feature, "track", "Gleis");
  const coordinates = e7LineString(feature, `${id}.geometry`);
  const tags = parseTags(feature.properties, id);
  if (!isClosed(coordinates)) return null;
  const evidenceTags = CONTEXT_TAGS.filter((tag) => typeof tags[tag] === "string" && tags[tag] !== "");
  return evidenceTags.length === 0 ? null : Object.freeze({
    trackId: id,
    classification: "non-linear-rail-context",
    evidenceTags: Object.freeze(evidenceTags),
    derivationRule: "closed-osm-way-with-building-or-man-made-tag/v1",
  });
}

function protectionTagSystems(key, value) {
  if (key === "railway:pzb") {
    if (["yes", "forward", "backward"].includes(value)) return ["pzb"];
    if (value === "no") return [];
    return null;
  }
  if (key === "railway:lzb") {
    if (value === "yes") return ["lzb"];
    if (value === "no") return [];
    return null;
  }
  if (key === "railway:etcs" || key === "railway:etcs:forward" || key === "railway:etcs:backward") {
    if (value === "1") return ["etcs-level1"];
    if (value === "2") return ["etcs-level2"];
    if (value === "1;2") return ["etcs-level1", "etcs-level2"];
    if (value === "no") return [];
    return null;
  }
  return undefined;
}

function canonicalProtection(tags) {
  const systems = new Set();
  const ambiguous = [];
  let declared = 0;
  for (const [key, value] of Object.entries(tags).sort(([left], [right]) => compareText(left, right))) {
    const parsed = protectionTagSystems(key, value);
    if (parsed === undefined) continue;
    declared += 1;
    if (parsed === null) ambiguous.push(`${key}=${value}`);
    else for (const system of parsed) systems.add(system);
  }
  return {
    systems: CANONICAL_PROTECTION_SYSTEMS.filter((system) => systems.has(system)),
    ambiguous,
    declared,
  };
}

export function compileOperationalTrackFeature(feature) {
  const trackId = featureIdentity(feature, "track", "Gleis");
  const properties = feature.properties;
  const context = classifyClosedTrackContext(feature);
  if (context !== null) return Object.freeze({
    trackId,
    excludedContext: context,
    edgeGeometryMm: null,
    trainProtectionProfile: null,
    blockers: Object.freeze([]),
  });

  const blockers = [];
  if (properties.orderable !== true || !["A", "B"].includes(properties.quality_class)) {
    blockers.push("track-not-operationally-qualified");
  }
  const lengthMm = safeInteger(properties.length_mm, `${trackId}.length_mm`, 1);
  const coordinates = e7LineString(feature, `${trackId}.geometry`);
  let points = null;
  try {
    points = geometryPoints(coordinates, lengthMm, `${trackId}.geometry`);
  } catch (error) {
    blockers.push(error instanceof Error && /kollabiert/u.test(error.message)
      ? "edge-geometry-offset-collapse"
      : "edge-length-metric-mismatch");
  }
  const tags = parseTags(properties, trackId);
  const protection = canonicalProtection(tags);
  if (protection.ambiguous.length > 0) blockers.push("ambiguous-train-protection-tag");
  if (protection.declared === 0) blockers.push("missing-train-protection-tag");
  if (protection.declared > 0 && protection.systems.length === 0) blockers.push("runtime-cannot-express-unprotected-route-leg");

  return Object.freeze({
    trackId,
    excludedContext: null,
    edgeGeometryMm: points === null ? null : Object.freeze({
      edgeId: trackId,
      lengthMm,
      points: Object.freeze(points.map(Object.freeze)),
      qualityClass: properties.quality_class,
      orderable: properties.orderable,
      sourceId: nonEmptyString(properties.source_id, `${trackId}.source_id`),
      derivationRule: EDGE_GEOMETRY_DERIVATION_RULE,
    }),
    trainProtectionProfile: protection.ambiguous.length > 0 || protection.systems.length === 0
      ? null
      : Object.freeze({
        trackId,
        availableProtectionSystems: Object.freeze(protection.systems),
        simultaneouslyRequiredProtectionSystems: Object.freeze([]),
        qualityClass: properties.quality_class,
        orderable: properties.orderable,
        sourceId: nonEmptyString(properties.source_id, `${trackId}.source_id`),
        derivationRule: TRAIN_PROTECTION_DERIVATION_RULE,
      }),
    blockers: Object.freeze([...new Set(blockers)].sort(compareText)),
  });
}

function canonicalIdSetHash(values) {
  const hash = createHash("sha256");
  hash.update("zugfolge-ordered-id-set/v1\0");
  for (const value of values) hash.update(`${Buffer.byteLength(value)}:${value}\n`);
  return hash.digest("hex");
}

export function compileOperationalResourceFeature(feature, expectedTargets = {}) {
  const resourceId = featureIdentity(feature, "conflict_resource", "Konfliktressource");
  const properties = feature.properties;
  const kind = properties.resource_kind;
  invariant(["block", "switch", "track_section"].includes(kind), `${resourceId} besitzt eine unbekannte Ressourcenart.`);
  const exactTrackIds = uniqueSortedStrings(
    kind === "switch" ? properties.incident_track_ids_json : properties.track_ids_json,
    `${resourceId}.track_ids`,
  );
  const targetId = kind === "block"
    ? nonEmptyString(properties.block_id, `${resourceId}.block_id`)
    : kind === "switch"
      ? nonEmptyString(properties.switch_id, `${resourceId}.switch_id`)
      : resourceId;
  const expected = expectedTargets[targetId];
  const blockers = [];
  if (properties.orderable !== true || !["A", "B"].includes(properties.quality_class)) blockers.push("resource-not-operationally-qualified");
  if (kind !== "track_section" && expected === undefined) blockers.push("resource-target-missing");
  if (expected !== undefined && expected !== canonicalIdSetHash(exactTrackIds)) blockers.push("resource-target-track-set-mismatch");
  return Object.freeze({
    binding: Object.freeze({
      resourceId,
      resourceKind: kind === "track_section" ? "track-section" : kind,
      targetId,
      exactTrackIds: Object.freeze(exactTrackIds),
      qualityClass: properties.quality_class,
      orderable: properties.orderable,
      sourceId: nonEmptyString(properties.source_id, `${resourceId}.source_id`),
      derivationRule: RESOURCE_BINDING_DERIVATION_RULE,
    }),
    blockers: Object.freeze(blockers.sort(compareText)),
  });
}

function findingState() {
  return { count: 0, samples: [], hash: createHash("sha256") };
}

function addFinding(findings, code, identity) {
  const state = findings.get(code) ?? findingState();
  state.count += 1;
  if (state.samples.length < SAMPLE_LIMIT) state.samples.push(identity);
  state.hash.update(`${Buffer.byteLength(identity)}:${identity}\n`);
  findings.set(code, state);
}

function finalizedFindings(findings) {
  return Object.fromEntries([...findings.entries()].sort(([left], [right]) => compareText(left, right)).map(([code, state]) => [code, {
    count: state.count,
    identitySetSha256: state.hash.digest("hex"),
    samples: state.samples,
  }]));
}

async function scanSequence(path, label, handler, { sortedFeatureIds = true } = {}) {
  const stream = createReadStream(path);
  const hash = createHash("sha256");
  let bytes = 0;
  stream.on("data", (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  let records = 0;
  let previous = null;
  for await (const raw of createInterface({ input: stream, crlfDelay: Infinity })) {
    const line = raw.replace(/^\x1e/u, "").trim();
    if (line === "") continue;
    let value;
    try { value = JSON.parse(line); } catch (error) {
      throw new Error(`${label}:${records + 1} ist kein gueltiges JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (sortedFeatureIds) {
      const id = value?.properties?.feature_id;
      invariant(typeof id === "string" && id !== "", `${label}:${records + 1} besitzt keine Feature-ID.`);
      invariant(previous === null || compareText(previous, id) < 0, `${label} ist bei ${id} nicht streng sortiert.`);
      previous = id;
    }
    records += 1;
    await handler(value, records);
  }
  return Object.freeze({ file: basename(path), bytes, records, sha256: hash.digest("hex") });
}

function e7Point(feature, name) {
  invariant(feature?.type === "Feature" && feature.geometry?.type === "Point", `${name} ist kein Punktfeature.`);
  const coordinates = feature.geometry.coordinates;
  invariant(Array.isArray(coordinates) && coordinates.length === 2, `${name} besitzt keine zweidimensionale Punktkoordinate.`);
  return Object.freeze({
    longitudeE7: coordinateE7(coordinates[0], -1_800_000_000, 1_800_000_000, `${name}.longitude`),
    latitudeE7: coordinateE7(coordinates[1], -900_000_000, 900_000_000, `${name}.latitude`),
  });
}

function coordinateKey(point) {
  return `${point.latitudeE7}:${point.longitudeE7}`;
}

function stopIdentity(stop) {
  return `${stop.rl100 ?? "-"}:${stop.eva ?? "-"}:${stop.trackRef}:${stop.latitudeE7}:${stop.longitudeE7}`;
}

async function collectExactStopPositions(path, findings) {
  const byCoordinate = new Map();
  let eligible = 0;
  const proof = await scanSequence(path, "Deutschland-EBO", (feature, line) => {
    if (feature?.type !== "Feature" || feature.geometry?.type !== "Point" || !isRecord(feature.properties)) return;
    const properties = feature.properties;
    const trainStop = properties.public_transport === "stop_position"
      && properties.railway === "stop"
      && properties.train === "yes";
    if (!trainStop) return;
    const trackRef = typeof properties["railway:track_ref"] === "string" ? properties["railway:track_ref"].normalize("NFC").trim() : "";
    if (trackRef === "") {
      addFinding(findings, "train-stop-without-track-ref", `line:${line}`);
      return;
    }
    const point = e7Point(feature, `Deutschland-EBO:${line}`);
    const stop = Object.freeze({
      ...point,
      trackRef,
      rl100: typeof properties["railway:ref"] === "string" && properties["railway:ref"] !== "" ? properties["railway:ref"] : null,
      eva: typeof properties.uic_ref === "string" && properties.uic_ref !== "" ? properties.uic_ref : null,
      name: typeof properties.name === "string" && properties.name !== "" ? properties.name : null,
      candidates: [],
    });
    const key = coordinateKey(point);
    const values = byCoordinate.get(key) ?? [];
    values.push(stop);
    byCoordinate.set(key, values);
    eligible += 1;
  }, { sortedFeatureIds: false });
  return { byCoordinate, eligible, proof };
}

function addExactTrackCandidates(stops, compiled, feature, coordinates) {
  if (stops === undefined || compiled.edgeGeometryMm === null) return;
  const tags = parseTags(feature.properties, compiled.trackId);
  const trackRef = typeof tags["railway:track_ref"] === "string" ? tags["railway:track_ref"].normalize("NFC").trim() : null;
  if (trackRef === null || trackRef === "") return;
  for (let index = 0; index < coordinates.length; index += 1) {
    const coordinate = coordinates[index];
    const matchingStops = stops.get(coordinateKey(coordinate));
    if (matchingStops === undefined) continue;
    for (const stop of matchingStops) {
      if (stop.trackRef !== trackRef) continue;
      stop.candidates.push(Object.freeze({
        trackId: compiled.trackId,
        edgeOffsetMm: compiled.edgeGeometryMm.points[index].edgeOffsetMm,
        matchRule: PLATFORM_ANCHOR_DERIVATION_RULE,
      }));
    }
  }
}

async function collectOpenStationPlatforms(path) {
  const byRl100 = new Map();
  const byEva = new Map();
  const proof = await scanSequence(path, "OpenStation-Stations", (station) => {
    invariant(station?.schema === "zugfolge-openstation-station-evidence/v1", "OpenStation-Stationsbeleg besitzt ein unbekanntes Schema.");
    invariant(Array.isArray(station.quays) && isRecord(station.identity), `${station.stationId ?? "OpenStation-Station"} ist unvollstaendig.`);
    const summarized = Object.freeze({
      stationId: nonEmptyString(station.stationId, "OpenStation.stationId"),
      quays: Object.freeze(station.quays.map((quay) => Object.freeze({
        platformId: nonEmptyString(quay.platformId, "OpenStation.platformId"),
        plateCode: typeof quay.plateCode === "string" && quay.plateCode !== "" ? quay.plateCode.normalize("NFC").trim() : null,
        names: Object.freeze((Array.isArray(quay.names) ? quay.names : []).filter((name) => typeof name === "string" && name !== "").map((name) => name.normalize("NFC").trim())),
        lengthMm: Number.isSafeInteger(quay.dimensionsMm?.length) && quay.dimensionsMm.length > 0 ? quay.dimensionsMm.length : null,
      }))),
    });
    for (const code of station.identity.rl100Codes ?? []) {
      const values = byRl100.get(code) ?? [];
      values.push(summarized);
      byRl100.set(code, values);
    }
    for (const code of station.identity.evaNumbers ?? []) {
      const values = byEva.get(code) ?? [];
      values.push(summarized);
      byEva.set(code, values);
    }
  }, { sortedFeatureIds: false });
  return { byRl100, byEva, proof };
}

function exactPlatformAnchors(stops, openStation, findings) {
  const anchors = [];
  for (const values of stops.byCoordinate.values()) {
    for (const stop of values) {
      const candidates = [...new Map(stop.candidates.map((candidate) => [`${candidate.trackId}:${candidate.edgeOffsetMm}`, candidate])).values()]
        .sort((left, right) => compareText(left.trackId, right.trackId) || left.edgeOffsetMm - right.edgeOffsetMm);
      const identity = stopIdentity(stop);
      if (candidates.length === 0) {
        addFinding(findings, "train-stop-without-exact-track-vertex", identity);
        continue;
      }
      if (candidates.length > 1) {
        addFinding(findings, "train-stop-with-ambiguous-exact-track-vertices", identity);
        continue;
      }
      const stationCandidates = stop.rl100 !== null
        ? openStation.byRl100.get(stop.rl100) ?? []
        : stop.eva !== null
          ? openStation.byEva.get(stop.eva) ?? []
          : [];
      if (stationCandidates.length !== 1) {
        addFinding(findings, "exact-track-anchor-without-unique-openstation-station", identity);
        continue;
      }
      const quays = stationCandidates[0].quays.filter((quay) => quay.plateCode === stop.trackRef || quay.names.includes(stop.trackRef));
      if (quays.length !== 1) {
        addFinding(findings, "exact-track-anchor-without-unique-openstation-platform", identity);
        continue;
      }
      if (quays[0].lengthMm === null) {
        addFinding(findings, "exact-track-anchor-without-platform-length", identity);
        continue;
      }
      anchors.push(Object.freeze({
        platformId: quays[0].platformId,
        trackId: candidates[0].trackId,
        anchorOffsetMm: candidates[0].edgeOffsetMm,
        lengthMm: quays[0].lengthMm,
        trackRef: stop.trackRef,
        sourceIds: Object.freeze(["osm-pbf-deutschland", "openstation-enrichment"]),
        derivationRule: PLATFORM_ANCHOR_DERIVATION_RULE,
      }));
      addFinding(findings, "platform-length-without-exact-interval-boundaries", identity);
    }
  }
  anchors.sort((left, right) => compareText(left.platformId, right.platformId) || compareText(left.trackId, right.trackId));
  return anchors;
}

function pathFrom(root, declaration, name) {
  return resolve(root, relativePath(declaration, name));
}

export async function auditGermanyOperationalSourceCompiler({
  infraReleaseId,
  sourceRoot,
  layers,
  eboStopPositions = null,
  openStationStations = null,
}) {
  nonEmptyString(infraReleaseId, "InfraRelease-ID");
  invariant(isRecord(layers), "Operational-Quellenlayer fehlen.");
  const required = ["tracks", "platforms", "switches", "signals", "blocks", "conflictResources"];
  invariant(Object.keys(layers).sort().join("\0") === [...required].sort().join("\0"), "Operational-Quellenlayer besitzen unbekannte oder fehlende Felder.");
  const root = resolve(sourceRoot);
  const findings = new Map();
  const metrics = {
    exactEdgeGeometries: 0,
    canonicalTrainProtectionProfiles: 0,
    excludedNonLinearContextTracks: 0,
    exactResourceBindings: 0,
    exactSignalBoundaryPlacements: 0,
    exactStationHeadSwitchRoles: 0,
    exactPlatformAnchors: 0,
    operationalPlatformIntervals: 0,
  };
  const proofs = {};
  let stops = null;
  if (eboStopPositions !== null) {
    stops = await collectExactStopPositions(pathFrom(root, eboStopPositions, "eboStopPositions"), findings);
    proofs.eboStopPositions = stops.proof;
  }

  const tracks = new Map();
  proofs.tracks = await scanSequence(pathFrom(root, layers.tracks, "layers.tracks"), "Gleise", (feature) => {
    const compiled = compileOperationalTrackFeature(feature);
    if (compiled.excludedContext !== null) {
      metrics.excludedNonLinearContextTracks += 1;
      return;
    }
    const properties = feature.properties;
    const metadata = Object.freeze({
      fromNodeId: safeInteger(properties.from_osm_node_id, `${compiled.trackId}.from_osm_node_id`),
      toNodeId: safeInteger(properties.to_osm_node_id, `${compiled.trackId}.to_osm_node_id`),
      lengthMm: safeInteger(properties.length_mm, `${compiled.trackId}.length_mm`, 1),
      eligible: compiled.blockers.length === 0,
    });
    tracks.set(compiled.trackId, metadata);
    if (compiled.edgeGeometryMm !== null) metrics.exactEdgeGeometries += 1;
    if (compiled.trainProtectionProfile !== null) metrics.canonicalTrainProtectionProfiles += 1;
    for (const code of compiled.blockers) addFinding(findings, code, compiled.trackId);
    if (stops !== null && compiled.edgeGeometryMm !== null) {
      addExactTrackCandidates(stops.byCoordinate, compiled, feature, e7LineString(feature, `${compiled.trackId}.geometry`));
    }
  });

  const switchTargets = {};
  proofs.switches = await scanSequence(pathFrom(root, layers.switches, "layers.switches"), "Weichen", (feature) => {
    const id = featureIdentity(feature, "switch", "Weiche");
    const ids = uniqueSortedStrings(feature.properties.incident_track_ids_json, `${id}.incident_track_ids_json`, { allowEmpty: true });
    for (const trackId of ids) if (!tracks.has(trackId)) addFinding(findings, "switch-references-missing-track", `${id}:${trackId}`);
    switchTargets[id] = canonicalIdSetHash(ids);
    const tags = parseTags(feature.properties, id);
    const roles = [tags["railway:switch:point_track_ref"], tags["railway:switch:normal_track_ref"], tags["railway:switch:reverse_track_ref"]];
    if (roles.every((value) => typeof value === "string" && value !== "") && new Set(roles).size === 3) metrics.exactStationHeadSwitchRoles += 1;
    else addFinding(findings, "switch-without-explicit-point-normal-reverse-roles", id);
    if (feature.properties.orderable !== true || !["A", "B"].includes(feature.properties.quality_class)) addFinding(findings, "switch-not-operationally-qualified", id);
  });

  proofs.signals = await scanSequence(pathFrom(root, layers.signals, "layers.signals"), "Signale", (feature) => {
    const id = featureIdentity(feature, "signal", "Signal");
    const nodeId = safeInteger(feature.properties.osm_node_id, `${id}.osm_node_id`);
    const incident = uniqueSortedStrings(feature.properties.incident_track_ids_json, `${id}.incident_track_ids_json`, { allowEmpty: true });
    const tags = parseTags(feature.properties, id);
    const direction = tags["railway:signal:direction"];
    const candidates = incident.filter((trackId) => {
      const track = tracks.get(trackId);
      if (track === undefined) return false;
      return direction === "forward" ? track.fromNodeId === nodeId : direction === "backward" ? track.toNodeId === nodeId : false;
    });
    if (candidates.length === 1) metrics.exactSignalBoundaryPlacements += 1;
    else addFinding(findings, direction === "forward" || direction === "backward"
      ? "signal-direction-does-not-select-one-entry-edge"
      : "signal-without-explicit-forward-or-backward-direction", id);
    if (feature.properties.orderable !== true || !["A", "B"].includes(feature.properties.quality_class)) addFinding(findings, "signal-not-operationally-qualified", id);
  });

  const blockTargets = {};
  const excludedTracks = new Set();
  proofs.blocks = await scanSequence(pathFrom(root, layers.blocks, "layers.blocks"), "Bloecke", (feature) => {
    const id = featureIdentity(feature, "block", "Block");
    const ids = uniqueSortedStrings(feature.properties.track_ids_json, `${id}.track_ids_json`);
    const missing = ids.filter((trackId) => !tracks.has(trackId));
    for (const trackId of missing) excludedTracks.add(trackId);
    if (missing.length > 0) addFinding(findings, "block-references-excluded-or-missing-track", id);
    blockTargets[id] = canonicalIdSetHash(ids);
    if (feature.properties.orderable !== true || !["A", "B"].includes(feature.properties.quality_class)) addFinding(findings, "block-not-operationally-qualified", id);
  });

  const expectedTargets = { ...blockTargets, ...switchTargets };
  proofs.conflictResources = await scanSequence(pathFrom(root, layers.conflictResources, "layers.conflictResources"), "Konfliktressourcen", (feature) => {
    const compiled = compileOperationalResourceFeature(feature, expectedTargets);
    const missingTracks = compiled.binding.exactTrackIds.filter((trackId) => !tracks.has(trackId));
    if (missingTracks.length > 0) addFinding(findings, "resource-references-excluded-or-missing-track", compiled.binding.resourceId);
    for (const code of compiled.blockers) addFinding(findings, code, compiled.binding.resourceId);
    if (compiled.blockers.length === 0 && missingTracks.length === 0) metrics.exactResourceBindings += 1;
  });

  proofs.platforms = await scanSequence(pathFrom(root, layers.platforms, "layers.platforms"), "Bahnsteige", (feature) => {
    const id = featureIdentity(feature, "platform", "Bahnsteig");
    addFinding(findings, "map-platform-without-exact-directed-track-interval", id);
  });

  if (stops !== null && openStationStations !== null) {
    const openStation = await collectOpenStationPlatforms(pathFrom(root, openStationStations, "openStationStations"));
    proofs.openStationStations = openStation.proof;
    const anchors = exactPlatformAnchors(stops, openStation, findings);
    metrics.exactPlatformAnchors = anchors.length;
  }
  addFinding(findings, "station-head-connectivity-not-present-in-retained-layers", infraReleaseId);
  addFinding(findings, "interlocking-routes-overlap-and-flank-not-present-in-retained-layers", infraReleaseId);
  addFinding(findings, "region-boundaries-not-present-in-retained-layers", infraReleaseId);
  addFinding(findings, "rzue-layout-not-present-in-retained-layers", infraReleaseId);

  const blockers = finalizedFindings(findings);
  const report = {
    schema: GERMANY_OPERATIONAL_SOURCE_REPORT_SCHEMA,
    infraReleaseId,
    status: "blocked",
    candidateProduced: false,
    fullGermanyArtifactPossible: false,
    policies: {
      geometry: EDGE_GEOMETRY_DERIVATION_RULE,
      trainProtection: TRAIN_PROTECTION_DERIVATION_RULE,
      resourceBinding: RESOURCE_BINDING_DERIVATION_RULE,
      platformAnchor: PLATFORM_ANCHOR_DERIVATION_RULE,
      nearestNeighborMatching: "forbidden",
      straightLineReplacement: "forbidden",
      virtualSignals: "forbidden",
      substituteResources: "forbidden",
    },
    metrics,
    sourceProofs: Object.fromEntries(Object.entries(proofs).sort(([left], [right]) => compareText(left, right))),
    blockers,
    unresolvedRequired: Object.keys(blockers).length,
  };
  invariant(report.unresolvedRequired > 0, "Source-Compiler darf ohne Fahrstrassen-, Regions- und RZUE-Vertrag keinen Deutschland-Candidate freigeben.");
  return report;
}
