import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";

export const OPERATIONAL_MAP_NORMALIZATION_SCHEMA =
  "zugfolge-operational-map-normalization/v1";
export const CLOSED_CONTEXT_RULE =
  "closed-rail-building-or-man-made-is-non-operational-context/v1";
export const CLOSED_LOOP_SPLIT_RULE =
  "closed-ebo-linestring-split-at-observed-mid-vertex/v1";

const FILES = Object.freeze([
  "tracks.geojsonseq",
  "platforms.geojsonseq",
  "switches.geojsonseq",
  "signals.geojsonseq",
  "blocks.geojsonseq",
  "conflict-resources.geojsonseq",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseTags(feature) {
  const raw = feature?.properties?.osm_tags_json;
  invariant(typeof raw === "string", `${feature?.properties?.feature_id ?? "Gleis"} besitzt keine OSM-Tags.`);
  const tags = JSON.parse(raw);
  invariant(tags !== null && typeof tags === "object" && !Array.isArray(tags), "OSM-Tags sind ungueltig.");
  return tags;
}

function isClosedLine(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (feature?.geometry?.type !== "LineString" || !Array.isArray(coordinates) || coordinates.length < 3) return false;
  const first = coordinates[0];
  const last = coordinates.at(-1);
  return Array.isArray(first)
    && Array.isArray(last)
    && first.length === 2
    && last.length === 2
    && first[0] === last[0]
    && first[1] === last[1];
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

function e7(value, minimum, maximum, label) {
  invariant(typeof value === "number" && Number.isFinite(value), `${label} ist keine Koordinate.`);
  const result = Math.round(value * 10_000_000);
  invariant(Number.isSafeInteger(result) && result >= minimum && result <= maximum, `${label} liegt ausserhalb E7.`);
  invariant(Math.abs(value - result / 10_000_000) <= 1e-12, `${label} ist nicht verlustfrei E7.`);
  return result;
}

function coordinateDistanceMm(left, right) {
  const leftLongitude = e7(left[0], -1_800_000_000, 1_800_000_000, "Longitude");
  const leftLatitude = e7(left[1], -900_000_000, 900_000_000, "Latitude");
  const rightLongitude = e7(right[0], -1_800_000_000, 1_800_000_000, "Longitude");
  const rightLatitude = e7(right[1], -900_000_000, 900_000_000, "Latitude");
  const latitude = BigInt(leftLatitude - rightLatitude) * 11_132n;
  const longitude = BigInt(leftLongitude - rightLongitude) * 6_999n;
  const result = (integerSqrt(latitude * latitude + longitude * longitude) + 500n) / 1_000n;
  invariant(result > 0n && result <= BigInt(Number.MAX_SAFE_INTEGER), "Normalisierte Segmentlaenge ist ungueltig.");
  return Number(result);
}

function lineLengthMm(coordinates) {
  return coordinates.slice(1).reduce(
    (total, coordinate, index) => total + coordinateDistanceMm(coordinates[index], coordinate),
    0,
  );
}

function derivedNodeId(trackId) {
  const digest = createHash("sha256").update(`${CLOSED_LOOP_SPLIT_RULE}\0${trackId}`).digest("hex");
  return -Number(BigInt(`0x${digest.slice(0, 12)}`) + 1n);
}

function splitFeatureIds(trackId) {
  const match = /^(.*-segment-\d+)(-.*)$/u.exec(trackId);
  invariant(match !== null, `${trackId} besitzt keine stabile Segmentkennung.`);
  return [`${match[1]}a${match[2]}`, `${match[1]}b${match[2]}`];
}

function normalizedTrackProperties(properties, { id, fromNodeId, toNodeId, lengthMm }) {
  const result = {
    ...properties,
    feature_id: id,
    from_osm_node_id: fromNodeId,
    length_mm: lengthMm,
    model_state: "derived_conservative_closed_loop_split",
    orderable: true,
    quality_class: "B",
    to_osm_node_id: toNodeId,
    topology_normalization_rule: CLOSED_LOOP_SPLIT_RULE,
  };
  delete result.quality_cause;
  return result;
}

export function normalizeClosedTrackFeature(feature) {
  invariant(feature?.type === "Feature" && feature.properties?.feature_type === "track", "Gleisfeature ist ungueltig.");
  const trackId = feature.properties.feature_id;
  invariant(typeof trackId === "string" && trackId !== "", "Gleisfeature besitzt keine ID.");
  if (!isClosedLine(feature)) return Object.freeze({ action: "retain", features: Object.freeze([feature]), replacementIds: Object.freeze([trackId]) });

  const tags = parseTags(feature);
  const contextTags = ["building", "man_made"].filter((name) => typeof tags[name] === "string" && tags[name] !== "");
  if (contextTags.length > 0) {
    return Object.freeze({
      action: "exclude-context",
      contextTags: Object.freeze(contextTags),
      features: Object.freeze([]),
      replacementIds: Object.freeze([]),
    });
  }

  const coordinates = feature.geometry.coordinates;
  const splitIndex = Math.floor((coordinates.length - 1) / 2);
  invariant(splitIndex > 0 && splitIndex < coordinates.length - 1, `${trackId} besitzt keinen beobachteten inneren Teilungspunkt.`);
  const firstCoordinates = coordinates.slice(0, splitIndex + 1);
  const secondCoordinates = coordinates.slice(splitIndex);
  const [firstId, secondId] = splitFeatureIds(trackId);
  const syntheticNodeId = derivedNodeId(trackId);
  const firstLength = lineLengthMm(firstCoordinates);
  const secondLength = lineLengthMm(secondCoordinates);
  invariant(firstLength + secondLength === feature.properties.length_mm, `${trackId} aendert bei der Teilung seine E7-Millimeterlaenge.`);
  const first = {
    ...feature,
    geometry: { ...feature.geometry, coordinates: firstCoordinates },
    properties: normalizedTrackProperties(feature.properties, {
      id: firstId,
      fromNodeId: feature.properties.from_osm_node_id,
      toNodeId: syntheticNodeId,
      lengthMm: firstLength,
    }),
  };
  const second = {
    ...feature,
    geometry: { ...feature.geometry, coordinates: secondCoordinates },
    properties: normalizedTrackProperties(feature.properties, {
      id: secondId,
      fromNodeId: syntheticNodeId,
      toNodeId: feature.properties.to_osm_node_id,
      lengthMm: secondLength,
    }),
  };
  return Object.freeze({
    action: "split-loop",
    splitNodeId: syntheticNodeId,
    features: Object.freeze([first, second]),
    replacementIds: Object.freeze([firstId, secondId]),
  });
}

async function writeChunk(stream, hash, text) {
  hash.update(text);
  if (!stream.write(text, "utf8")) await once(stream, "drain");
}

async function scanSequence(path, handler) {
  let line = 0;
  for await (const raw of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
    line += 1;
    const text = raw.replace(/^\x1e/u, "").trim();
    if (text === "") continue;
    let feature;
    try {
      feature = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path}:${line} ist kein gueltiges JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    await handler(feature, line);
  }
}

function replacementTrackIds(serialized, replacementByTrack, label) {
  invariant(typeof serialized === "string", `${label} besitzt keine Gleisbindungen.`);
  const input = JSON.parse(serialized);
  invariant(Array.isArray(input) && input.every((value) => typeof value === "string" && value !== ""), `${label} besitzt ungueltige Gleisbindungen.`);
  const touched = input.some((trackId) => {
    const replacement = replacementByTrack.get(trackId);
    return replacement !== undefined
      && (replacement.length !== 1 || replacement[0] !== trackId);
  });
  return {
    input,
    touched,
    replacement: touched
      ? [...new Set(input.flatMap((trackId) => replacementByTrack.get(trackId) ?? [trackId]))].sort(compareText)
      : input,
  };
}

function normalizeDependentFeature(feature, replacementByTrack) {
  const properties = feature?.properties;
  invariant(feature?.type === "Feature" && properties !== null && typeof properties === "object", "Abhaengiges Feature ist ungueltig.");
  const field = typeof properties.track_ids_json === "string"
    ? "track_ids_json"
    : typeof properties.incident_track_ids_json === "string"
      ? "incident_track_ids_json"
      : null;
  if (field === null) return { feature, changed: false, removed: false };
  const { input: original, touched, replacement } = replacementTrackIds(
    properties[field],
    replacementByTrack,
    properties.feature_id,
  );
  if (!touched) return { feature, changed: false, removed: false };
  if (replacement.length === 0) return { feature: null, changed: true, removed: true };
  if (JSON.stringify(original) === JSON.stringify(replacement)) return { feature, changed: false, removed: false };
  let modelState = properties.model_state;
  if (modelState === "unresolved_dependency_track_topology") {
    if (properties.feature_type === "block") {
      modelState = properties.boundary_signal_count > 0
        ? "derived_conservative_signal_bounded_block"
        : "derived_conservative_connected_component";
    } else if (properties.feature_type === "conflict_resource" && properties.resource_kind === "block") {
      modelState = "derived_block_exclusion";
    } else if (properties.feature_type === "conflict_resource" && properties.resource_kind === "track_section") {
      modelState = "derived_conservative_bidirectional_exclusion";
    }
  }
  invariant(
    modelState !== "unresolved_dependency_track_topology",
    `${properties.feature_id} besitzt nach der Gleisnormalisierung weiterhin ein unaufgeloestes Abhaengigkeitsmodell.`,
  );
  const normalizedProperties = {
    ...properties,
    [field]: JSON.stringify(replacement),
    model_state: modelState,
    orderable: true,
    quality_class: "B",
    topology_normalization_rule: CLOSED_LOOP_SPLIT_RULE,
  };
  if (Number.isSafeInteger(properties.track_count)) normalizedProperties.track_count = replacement.length;
  delete normalizedProperties.quality_cause;
  return { feature: { ...feature, properties: normalizedProperties }, changed: true, removed: false };
}

async function finishStream(stream) {
  const closed = once(stream, "close");
  stream.end();
  await closed;
}

export async function normalizeOperationalMapLayers({ sourceDirectory, outputDirectory }) {
  const source = resolve(sourceDirectory);
  const destination = resolve(outputDirectory);
  const staging = `${destination}.building`;
  invariant(!(await lstat(destination).catch(() => null)), `Normalisierungsziel ${destination} existiert bereits.`);
  invariant(!(await lstat(staging).catch(() => null)), `Parallele oder abgebrochene Normalisierung ${staging} existiert.`);
  for (const name of FILES) {
    const metadata = await lstat(resolve(source, name));
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${name} ist keine regulaere Quelldatei.`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(staging, { recursive: false });
  const replacementByTrack = new Map();
  const report = {
    schema: OPERATIONAL_MAP_NORMALIZATION_SCHEMA,
    rules: { closedContext: CLOSED_CONTEXT_RULE, closedLoopSplit: CLOSED_LOOP_SPLIT_RULE },
    tracks: { input: 0, output: 0, retained: 0, excludedContext: 0, splitLoops: 0 },
    dependent: {},
    outputs: {},
  };
  try {
    const trackHash = createHash("sha256");
    const trackOutput = createWriteStream(resolve(staging, "tracks.geojsonseq"), { flags: "wx" });
    let previousTrackId = null;
    await scanSequence(resolve(source, "tracks.geojsonseq"), async (feature) => {
      report.tracks.input += 1;
      const trackId = feature?.properties?.feature_id;
      const normalized = normalizeClosedTrackFeature(feature);
      replacementByTrack.set(trackId, normalized.replacementIds);
      if (normalized.action === "retain") report.tracks.retained += 1;
      else if (normalized.action === "exclude-context") report.tracks.excludedContext += 1;
      else report.tracks.splitLoops += 1;
      for (const outputFeature of normalized.features) {
        const outputId = outputFeature.properties.feature_id;
        invariant(previousTrackId === null || compareText(previousTrackId, outputId) < 0, `Normalisierte Gleise sind bei ${outputId} nicht streng sortiert.`);
        previousTrackId = outputId;
        await writeChunk(trackOutput, trackHash, `\x1e${JSON.stringify(outputFeature)}\n`);
        report.tracks.output += 1;
      }
    });
    await finishStream(trackOutput);
    report.outputs["tracks.geojsonseq"] = { records: report.tracks.output, sha256: trackHash.digest("hex") };

    for (const name of FILES.slice(1)) {
      const hash = createHash("sha256");
      const output = createWriteStream(resolve(staging, name), { flags: "wx" });
      const counts = { input: 0, output: 0, changed: 0, removedContext: 0 };
      await scanSequence(resolve(source, name), async (feature) => {
        counts.input += 1;
        const normalized = normalizeDependentFeature(feature, replacementByTrack);
        if (normalized.changed) counts.changed += 1;
        if (normalized.removed) counts.removedContext += 1;
        if (normalized.feature !== null) {
          await writeChunk(output, hash, `\x1e${JSON.stringify(normalized.feature)}\n`);
          counts.output += 1;
        }
      });
      await finishStream(output);
      report.dependent[name] = counts;
      report.outputs[name] = { records: counts.output, sha256: hash.digest("hex") };
    }
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    const reportStream = createWriteStream(resolve(staging, "normalization-report.json"), { flags: "wx" });
    const reportClosed = once(reportStream, "close");
    reportStream.end(reportText, "utf8");
    await reportClosed;
    await rename(staging, destination);
    return report;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const [configurationPath, ...extra] = process.argv.slice(2);
if (configurationPath !== undefined) {
  invariant(extra.length === 0, "Aufruf: normalize-operational-map-layers.mjs CONFIG.json");
  const configuration = JSON.parse(await readFile(resolve(configurationPath), "utf8"));
  invariant(configuration?.schema === OPERATIONAL_MAP_NORMALIZATION_SCHEMA, "Unbekannter Normalisierungsvertrag.");
  process.stdout.write(`${JSON.stringify(await normalizeOperationalMapLayers(configuration))}\n`);
}
