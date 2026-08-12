import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const DEPENDENT_LAYERS = Object.freeze({
  signals: ["incident_track_ids_json"],
  switches: ["incident_track_ids_json"],
  blocks: ["track_ids_json"],
  "conflict-resources": ["track_ids_json", "incident_track_ids_json"],
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function featureLine(feature) {
  return `\x1e${JSON.stringify(feature)}\n`;
}

async function* features(path) {
  let previous = null;
  let lineNumber = 0;
  for await (const raw of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
    lineNumber += 1;
    const line = raw.replace(/^\x1e/u, "").trim();
    if (line === "") continue;
    let feature;
    try { feature = JSON.parse(line); } catch (error) {
      throw new Error(`${basename(path)}:${lineNumber} ist kein gültiges GeoJSON: ${error.message}`);
    }
    const id = feature?.properties?.feature_id;
    invariant(feature?.type === "Feature" && typeof id === "string" && id !== "", `${basename(path)}:${lineNumber} ist kein stabiles Feature.`);
    invariant(previous === null || compareText(previous, id) < 0, `${basename(path)} ist bei ${id} nicht streng sortiert.`);
    previous = id;
    yield feature;
  }
}

async function createSink(path) {
  const handle = await open(path, "wx");
  let chunks = [];
  let bufferedBytes = 0;
  let closed = false;
  const flush = async () => {
    if (chunks.length === 0) return;
    await handle.writeFile(Buffer.concat(chunks, bufferedBytes));
    chunks = [];
    bufferedBytes = 0;
  };
  return {
    async write(line) {
      const chunk = Buffer.from(line, "utf8");
      chunks.push(chunk);
      bufferedBytes += chunk.length;
      if (bufferedBytes >= 8 * 1024 * 1024) await flush();
    },
    async finish() {
      await flush();
      await handle.sync();
      await handle.close();
      closed = true;
    },
    async abort() {
      if (!closed) await handle.close().catch(() => {});
      closed = true;
    },
  };
}

async function write(output, feature, hashState) {
  const line = featureLine(feature);
  hashState.hash.update(line);
  hashState.bytes += Buffer.byteLength(line);
  hashState.count += 1;
  await output.write(line);
}

function invalidTrackTopology(feature) {
  const properties = feature.properties;
  return feature.geometry?.type !== "LineString"
    || !Array.isArray(feature.geometry.coordinates)
    || feature.geometry.coordinates.length < 2
    || !Number.isSafeInteger(properties.from_osm_node_id)
    || !Number.isSafeInteger(properties.to_osm_node_id)
    || properties.from_osm_node_id === properties.to_osm_node_id;
}

function classC(feature, modelState, cause) {
  return {
    ...feature,
    properties: {
      ...feature.properties,
      quality_class: "C",
      orderable: false,
      model_state: modelState,
      quality_cause: cause,
    },
  };
}

function result(hashState) {
  return { features: hashState.count, bytes: hashState.bytes, sha256: hashState.hash.digest("hex") };
}

async function transformTracks(input, outputPath) {
  const output = await createSink(outputPath);
  const hashState = { hash: createHash("sha256"), bytes: 0, count: 0 };
  const correctedTrackIds = new Set();
  try {
    for await (const feature of features(input)) {
      let finalFeature = feature;
      if (invalidTrackTopology(feature)) {
        correctedTrackIds.add(feature.properties.feature_id);
        finalFeature = classC(feature, "unresolved_invalid_track_topology", "invalid_track_topology");
      }
      await write(output, finalFeature, hashState);
    }
    await output.finish();
  } catch (error) {
    await output.abort();
    throw error;
  }
  invariant(hashState.count > 0, "Finaler Gleislayer ist leer.");
  return { ...result(hashState), correctedTrackIds };
}

function trackDependencies(feature, fields) {
  const field = fields.find((candidate) => typeof feature.properties[candidate] === "string");
  invariant(field !== undefined, `${feature.properties.feature_id} besitzt keine Trackbindung in ${fields.join(" oder ")}.`);
  const serialized = feature.properties[field];
  const ids = JSON.parse(serialized);
  invariant(Array.isArray(ids) && ids.every((id) => typeof id === "string"), `${feature.properties.feature_id} besitzt ungültige Trackbindungen.`);
  return ids;
}

async function transformDependentLayer(input, outputPath, fields, correctedTrackIds) {
  const output = await createSink(outputPath);
  const hashState = { hash: createHash("sha256"), bytes: 0, count: 0 };
  let corrected = 0;
  try {
    for await (const feature of features(input)) {
      const affected = trackDependencies(feature, fields).some((id) => correctedTrackIds.has(id));
      const finalFeature = affected
        ? classC(feature, "unresolved_dependency_track_topology", "invalid_bound_track_topology")
        : feature;
      if (affected) corrected += 1;
      await write(output, finalFeature, hashState);
    }
    await output.finish();
  } catch (error) {
    await output.abort();
    throw error;
  }
  invariant(hashState.count > 0, `${basename(input)} ist leer.`);
  return { ...result(hashState), corrected };
}

function normalizedPlatform(feature) {
  invariant(feature.properties.feature_type === "platform", `${feature.properties.feature_id} ist kein Bahnsteig.`);
  const quality = feature.properties.quality_class;
  invariant(["A", "B", "C"].includes(quality), `${feature.properties.feature_id} besitzt keine Qualitätsklasse.`);
  return quality === "C" && feature.properties.orderable !== false
    ? { ...feature, properties: { ...feature.properties, orderable: false } }
    : feature;
}

async function mergePlatforms(inputs, outputPath) {
  invariant(inputs.length >= 2, "Bahnsteig-Merge braucht mindestens zwei unabhängige Layer.");
  const iterators = inputs.map((path) => features(path)[Symbol.asyncIterator]());
  const current = await Promise.all(iterators.map((iterator) => iterator.next()));
  const output = await createSink(outputPath);
  const hashState = { hash: createHash("sha256"), bytes: 0, count: 0 };
  const byInput = Object.fromEntries(inputs.map((path) => [basename(path), 0]));
  let previous = null;
  try {
    while (current.some(({ done }) => !done)) {
      let selected = -1;
      for (let index = 0; index < current.length; index += 1) {
        if (current[index].done) continue;
        if (selected === -1 || compareText(current[index].value.properties.feature_id, current[selected].value.properties.feature_id) < 0) selected = index;
      }
      const feature = normalizedPlatform(current[selected].value);
      const id = feature.properties.feature_id;
      invariant(previous === null || compareText(previous, id) < 0, `Doppelte oder unsortierte Bahnsteig-ID ${id}.`);
      previous = id;
      byInput[basename(inputs[selected])] += 1;
      await write(output, feature, hashState);
      current[selected] = await iterators[selected].next();
    }
    await output.finish();
  } catch (error) {
    await output.abort();
    throw error;
  }
  invariant(hashState.count > 0, "Finaler Bahnsteiglayer ist leer.");
  return { ...result(hashState), byInput };
}

async function writeJsonExclusive(path, value) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function buildFinalMapLayers({ tracks, platforms, dependentLayers, outputDirectory }) {
  invariant(Array.isArray(platforms) && platforms.length >= 2, "Bahnsteigquellen fehlen.");
  for (const [name, fields] of Object.entries(DEPENDENT_LAYERS)) {
    invariant(dependentLayers?.[name] && fields.length > 0, `Abhängiger Layer ${name} fehlt.`);
  }
  const destination = resolve(outputDirectory);
  const temporary = `${destination}.building`;
  invariant(!(await stat(destination).catch(() => null)), `Finale Layer existieren bereits: ${destination}.`);
  invariant(!(await stat(temporary).catch(() => null)), `Temporärer Layerbuild existiert bereits: ${temporary}.`);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(temporary, { recursive: false });
  let completed = false;
  try {
    const trackResult = await transformTracks(resolve(tracks), resolve(temporary, "tracks.geojsonseq"));
    const dependencyResults = {};
    for (const [name, fields] of Object.entries(DEPENDENT_LAYERS)) {
      dependencyResults[name] = await transformDependentLayer(
        resolve(dependentLayers[name]),
        resolve(temporary, `${name}.geojsonseq`),
        fields,
        trackResult.correctedTrackIds,
      );
    }
    const platformResult = await mergePlatforms(platforms.map((path) => resolve(path)), resolve(temporary, "platforms.geojsonseq"));
    const report = {
      schema: "zugfolge-final-map-layers/v1",
      tracks: { ...trackResult, correctedTrackIds: [...trackResult.correctedTrackIds].sort(compareText) },
      dependentLayers: dependencyResults,
      platforms: platformResult,
    };
    await writeJsonExclusive(resolve(temporary, "report.json"), report);
    await rename(temporary, destination);
    completed = true;
    return { outputDirectory: destination, report };
  } finally {
    if (!completed) await rm(temporary, { recursive: true, force: true });
  }
}
