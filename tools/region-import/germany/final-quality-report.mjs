import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

const QUALITY_CLASSES = ["A", "B", "C"];
const FORBIDDEN_PUBLIC_TOKENS = ["apn", "trassenfinder.de/apn", "stationplan", "station-plan", "station_plan", "trassenplan"];
const TRACK_DIMENSIONS = [
  "topology",
  "maximumSpeed",
  "gradient",
  "electrification",
  "trackCount",
  "signals",
  "blocks",
  "conflictResources",
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => compareText(left, right)));
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function contained(root, file) {
  invariant(typeof file === "string" && file !== "" && !isAbsolute(file), `Ung\u00fcltiger relativer Layerpfad: ${file}.`);
  const absolute = resolve(root, file);
  const remainder = relative(root, absolute);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `Layerpfad verl\u00e4sst die Artefaktwurzel: ${file}.`);
  return absolute;
}

function parseSequenceLine(raw, file, lineNumber) {
  const line = raw.replace(/^\x1e/u, "").trim();
  if (line === "") return null;
  let feature;
  try {
    feature = JSON.parse(line);
  } catch (error) {
    throw new Error(`${file}:${lineNumber} ist kein g\u00fcltiges GeoJSON: ${error.message}`);
  }
  invariant(feature?.type === "Feature" && feature.geometry !== undefined, `${file}:${lineNumber} ist kein sichtbares GeoJSON-Feature.`);
  invariant(feature.properties !== null && typeof feature.properties === "object", `${file}:${lineNumber} besitzt keine Properties.`);
  return feature;
}

function featureId(feature, file, lineNumber) {
  const value = feature.properties.feature_id;
  invariant(typeof value === "string" && value !== "", `${file}:${lineNumber} besitzt keine feature_id.`);
  return value;
}

function strictJsonArray(value, field, featureIdValue) {
  invariant(typeof value === "string", `${featureIdValue} besitzt kein serialisiertes ${field}.`);
  const parsed = JSON.parse(value);
  invariant(Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string" && entry !== ""), `${featureIdValue} besitzt ein ung\u00fcltiges ${field}.`);
  return parsed;
}

function verifyClassA(properties, specification, featureIdValue) {
  if (properties.quality_class !== "A") return;
  invariant(properties.class_a_evidence_status === "accepted_complete", `Klasse A f\u00fcr ${featureIdValue} besitzt keinen vollst\u00e4ndig akzeptierten Nachweis.`);
  const dimensions = new Set(strictJsonArray(properties.validated_dimensions_json, "validated_dimensions_json", featureIdValue));
  const receipts = strictJsonArray(properties.validation_receipt_ids_json, "validation_receipt_ids_json", featureIdValue);
  invariant(receipts.length > 0, `Klasse A f\u00fcr ${featureIdValue} besitzt keinen Pr\u00fcfbeleg.`);
  for (const dimension of specification.classARequiredDimensions) {
    invariant(dimensions.has(dimension), `Klasse A f\u00fcr ${featureIdValue} besitzt keinen Nachweis f\u00fcr ${dimension}.`);
  }
}

function classSummary() {
  return { A: 0, B: 0, C: 0 };
}

function lengthSummary() {
  return { A: 0, B: 0, C: 0 };
}

function dimensionAccumulator() {
  return {
    featureCount: 0,
    lengthMm: 0,
    evidence: new Map(),
    handling: new Map(),
    gapReasons: new Map(),
  };
}

function addDimension(accumulator, evidence, handling, lengthMm, gapReason = null) {
  accumulator.featureCount += 1;
  accumulator.lengthMm += lengthMm;
  const evidenceValue = accumulator.evidence.get(evidence) ?? { features: 0, lengthMm: 0 };
  evidenceValue.features += 1;
  evidenceValue.lengthMm += lengthMm;
  accumulator.evidence.set(evidence, evidenceValue);
  const handlingValue = accumulator.handling.get(handling) ?? { features: 0, lengthMm: 0 };
  handlingValue.features += 1;
  handlingValue.lengthMm += lengthMm;
  accumulator.handling.set(handling, handlingValue);
  if (gapReason !== null) {
    const gap = accumulator.gapReasons.get(gapReason) ?? { features: 0, lengthMm: 0 };
    gap.features += 1;
    gap.lengthMm += lengthMm;
    accumulator.gapReasons.set(gapReason, gap);
  }
}

function addDimensionState(accumulator, state, lengthMm) {
  const [evidence, handling, gapReason] = state;
  addDimension(accumulator, evidence, handling, lengthMm, gapReason);
}

function finishDimension(accumulator, expectedFeatures, expectedLengthMm, policy) {
  invariant(accumulator.featureCount === expectedFeatures && accumulator.lengthMm === expectedLengthMm, `Dimensionsbericht ${policy.ruleId} deckt den Tracklayer nicht vollst\u00e4ndig ab.`);
  return {
    policy,
    featureCount: accumulator.featureCount,
    lengthMm: accumulator.lengthMm,
    evidenceByState: sortedObject(accumulator.evidence),
    operationalHandlingByState: sortedObject(accumulator.handling),
    evidenceGapsByReason: sortedObject(accumulator.gapReasons),
  };
}

function safeLength(properties, featureIdValue) {
  const value = properties.length_mm;
  invariant(Number.isSafeInteger(value) && value > 0, `Gleis ${featureIdValue} besitzt keine positive ganzzahlige L\u00e4nge.`);
  return value;
}

function parseOsmTags(properties, featureIdValue) {
  invariant(typeof properties.osm_tags_json === "string", `Gleis ${featureIdValue} besitzt keine OSM-Tags.`);
  const tags = JSON.parse(properties.osm_tags_json);
  invariant(tags !== null && typeof tags === "object" && !Array.isArray(tags), `Gleis ${featureIdValue} besitzt ung\u00fcltige OSM-Tags.`);
  return tags;
}

function parsedOsmSpeed(raw) {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (!/^\d{1,3}(?:\s*km\/h)?$/iu.test(normalized)) return null;
  const value = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(value) && value > 0 && value <= 400 ? value : null;
}

function directionalOsmSpeed(tags, direction) {
  const directionalKey = `maxspeed:${direction}`;
  if (Object.hasOwn(tags, directionalKey)) return parsedOsmSpeed(tags[directionalKey]);
  return parsedOsmSpeed(tags.maxspeed);
}

function speedState(properties, featureIdValue, tags) {
  const models = [properties.speed_forward_model, properties.speed_backward_model];
  const values = [properties.speed_forward_kmh, properties.speed_backward_kmh];
  invariant(models.every((value) => typeof value === "string" && value !== ""), `Gleis ${featureIdValue} besitzt kein vollst\u00e4ndiges Vmax-Modell.`);
  invariant(values.every((value) => Number.isSafeInteger(value) && value > 0 && value <= 400), `Gleis ${featureIdValue} besitzt keine sichere Vmax.`);
  const directions = ["forward", "backward"];
  const states = models.map((model, index) => {
    if (model === "conservative_default") return "missing";
    if (model === "observed_official_section") return "official";
    if (model.startsWith("observed_osm_")) return "osm";
    if (model === "conservative_min_osm_and_official") {
      const official = properties.official_speed_kmh;
      const osm = directionalOsmSpeed(tags, directions[index]);
      invariant(Number.isSafeInteger(official) && official > 0 && official <= 400, `Gleis ${featureIdValue} besitzt kein rekonstruierbares amtliches Vmax-Minimum.`);
      invariant(osm !== null, `Gleis ${featureIdValue} besitzt kein rekonstruierbares OSM-Vmax-Minimum ${directions[index]}.`);
      invariant(values[index] === Math.min(official, osm), `Gleis ${featureIdValue} besitzt ein inkonsistentes konservatives Vmax-Minimum ${directions[index]}.`);
      return official === osm ? "corroborated" : "conflict";
    }
    throw new Error(`Gleis ${featureIdValue} besitzt ein unbekanntes Vmax-Modell: ${model}.`);
  });
  if (states.includes("missing")) return ["missing", "conservative_assumption", "missing_numeric_speed"];
  if (states.includes("conflict")) return ["conflicting_observations", "conservative_rule", "osm_official_speed_conflict"];
  if (states.includes("corroborated")) return ["corroborated_observations", "direct_observed", null];
  if (models.every((value) => value === "observed_official_section")) return ["official_observed", "direct_observed", null];
  if (models.every((value) => value.startsWith("observed_osm_"))) return ["osm_observed", "direct_observed", null];
  if (models.every((value) => value === "observed_official_section" || value.startsWith("observed_osm_"))) return ["mixed_observed", "direct_observed", null];
  throw new Error(`Gleis ${featureIdValue} besitzt unbekannte Vmax-Modelle: ${models.join(", ")}.`);
}

function gradientState(properties, featureIdValue) {
  invariant(properties.gradient_class_a_eligible === false, `DEM-Neigung von ${featureIdValue} darf nicht Klasse A erzeugen.`);
  if (properties.gradient_status === "derived_with_uncertainty") {
    for (const field of ["representative_gradient_permille", "minimum_gradient_permille", "maximum_gradient_permille", "uncertainty_permille", "analysis_baseline_mm"]) {
      invariant(Number.isSafeInteger(properties[field]), `Abgeleitete Neigung von ${featureIdValue} besitzt kein ganzzahliges ${field}.`);
    }
    invariant(properties.minimum_gradient_permille <= properties.representative_gradient_permille && properties.representative_gradient_permille <= properties.maximum_gradient_permille, `Neigungsintervall von ${featureIdValue} schlie\u00dft den Sch\u00e4tzwert nicht ein.`);
    invariant(properties.uncertainty_permille > 0 && properties.analysis_baseline_mm >= 200_000, `Neigungsnachweis von ${featureIdValue} unterschreitet die Unsicherheitsgrenze.`);
    return ["derived_model", "direct_derived", null];
  }
  invariant(properties.gradient_status === "unresolved" && typeof properties.unresolved_reason === "string", `Gleis ${featureIdValue} besitzt einen unbekannten Neigungsstatus.`);
  return ["missing", "conservative_assumption", properties.unresolved_reason];
}

function electrificationState(properties, tags) {
  if (["none", "overhead-line", "conductor-rail"].includes(properties.official_electrification)) return ["official_observed", "direct_observed", null];
  const osm = String(tags.electrified ?? "").toLowerCase();
  if (["no", "contact_line", "yes", "rail;contact_line", "contact_line;rail"].includes(osm)) return ["osm_observed", "direct_observed", null];
  const reason = properties.official_electrification === "unknown-source-gap" ? "official_source_gap_and_no_supported_osm_value" : "missing_supported_electrification_value";
  return ["missing", "conservative_assumption", reason];
}

function trackCountState(properties, tags) {
  if ([1, 2].includes(properties.official_track_count)) return ["official_observed", "direct_observed", null];
  const osm = String(tags.tracks ?? "");
  if (/^\d{1,2}$/u.test(osm) && Number.parseInt(osm, 10) > 0) return ["osm_observed", "direct_observed", null];
  return ["missing", "conservative_assumption", "missing_supported_route_track_count"];
}

function topologyState(feature, properties) {
  const coordinates = feature.geometry?.coordinates;
  const valid = feature.geometry?.type === "LineString"
    && Array.isArray(coordinates) && coordinates.length >= 2
    && Number.isSafeInteger(properties.from_osm_node_id)
    && Number.isSafeInteger(properties.to_osm_node_id)
    && properties.from_osm_node_id !== properties.to_osm_node_id;
  return valid ? ["osm_observed", "direct_observed", null] : ["missing", "unresolved", "invalid_track_topology"];
}

function addTrackDimensions(accumulators, feature, indexes) {
  const properties = feature.properties;
  const id = properties.feature_id;
  const lengthMm = safeLength(properties, id);
  const tags = parseOsmTags(properties, id);
  const unresolvedDimensions = [];
  const add = (dimension, state) => {
    addDimensionState(accumulators[dimension], state, lengthMm);
    if (state[1] === "unresolved") unresolvedDimensions.push(dimension);
  };
  add("topology", topologyState(feature, properties));
  add("maximumSpeed", speedState(properties, id, tags));
  add("gradient", gradientState(properties, id));
  add("electrification", electrificationState(properties, tags));
  add("trackCount", trackCountState(properties, tags));

  if (indexes.signalTracks.has(id)) addDimension(accumulators.signals, "osm_observed_assigned", "direct_observed", lengthMm);
  else addDimension(accumulators.signals, "no_assigned_observation", "conservative_rule", lengthMm, "no_assigned_signal");

  const blockBits = indexes.blockTracks.get(id) ?? 0;
  if ((blockBits & 1) !== 0) addDimension(accumulators.blocks, "derived_from_observed_signal_boundaries", "conservative_rule", lengthMm);
  else if ((blockBits & 2) !== 0) addDimension(accumulators.blocks, "derived_from_connected_topology", "conservative_rule", lengthMm, "no_observed_block_boundary");
  else {
    addDimension(accumulators.blocks, "missing", "unresolved", lengthMm, "no_block_assignment");
    unresolvedDimensions.push("blocks");
  }

  const resourceBits = indexes.resourceTracks.get(id) ?? 0;
  if ((resourceBits & 3) === 3) addDimension(accumulators.conflictResources, "derived_from_topology", "conservative_rule", lengthMm);
  else {
    addDimension(accumulators.conflictResources, "incomplete", "unresolved", lengthMm, (resourceBits & 2) === 0 ? "missing_track_section_resource" : "missing_block_resource");
    unresolvedDimensions.push("conflictResources");
  }
  return { lengthMm, unresolvedDimensions };
}

function layerAccumulator() {
  return {
    featureCount: 0,
    declaredQuality: classSummary(),
    effectiveQuality: classSummary(),
    declaredLengthByClassMm: lengthSummary(),
    effectiveLengthByClassMm: lengthSummary(),
    qualityCorrections: new Map(),
  };
}

function collectIndexes(layerName, properties, qualityClass, indexes, id) {
  if (layerName === "signals" && qualityClass === "B") {
    for (const trackId of strictJsonArray(properties.incident_track_ids_json, "incident_track_ids_json", id)) indexes.signalTracks.add(trackId);
  }
  if (layerName === "blocks" && qualityClass === "B") {
    const bit = properties.model_state === "derived_conservative_signal_bounded_block" ? 1
      : properties.model_state === "derived_conservative_connected_component" ? 2 : 0;
    invariant(bit !== 0, `Block ${id} besitzt ein unbekanntes Ableitungsmodell.`);
    for (const trackId of strictJsonArray(properties.track_ids_json, "track_ids_json", id)) indexes.blockTracks.set(trackId, (indexes.blockTracks.get(trackId) ?? 0) | bit);
  }
  if (layerName === "conflict_resources" && qualityClass === "B") {
    const bit = properties.resource_kind === "block" ? 1 : properties.resource_kind === "track_section" ? 2 : 0;
    if (bit !== 0) for (const trackId of strictJsonArray(properties.track_ids_json, "track_ids_json", id)) indexes.resourceTracks.set(trackId, (indexes.resourceTracks.get(trackId) ?? 0) | bit);
  }
}

async function scanLayer(root, specification, indexes, trackDimensions) {
  const absolute = contained(root, specification.file);
  const details = await stat(absolute);
  invariant(details.isFile() && details.size > 0, `Sichtbarer Layer ${specification.name} fehlt oder ist leer.`);
  const input = createReadStream(absolute);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const accumulator = layerAccumulator();
  let previousId = null;
  let lineNumber = 0;
  let trackLengthMm = 0;
  for await (const raw of lines) {
    lineNumber += 1;
    const feature = parseSequenceLine(raw, specification.file, lineNumber);
    if (feature === null) continue;
    const id = featureId(feature, specification.file, lineNumber);
    invariant(previousId === null || compareText(previousId, id) < 0, `Layer ${specification.name} ist nicht streng nach feature_id sortiert oder enth\u00e4lt ${id} doppelt.`);
    previousId = id;
    const properties = feature.properties;
    invariant(properties.feature_type === specification.featureType, `${id} besitzt feature_type ${properties.feature_type} statt ${specification.featureType}.`);
    const qualityClass = properties.quality_class;
    invariant(QUALITY_CLASSES.includes(qualityClass), `${id} besitzt keine Qualit\u00e4tsklasse A, B oder C.`);
    verifyClassA(properties, specification, id);
    if (qualityClass === "C") invariant(properties.orderable === false, `Klasse-C-Feature ${id} darf nicht bestellbar sein.`);
    accumulator.featureCount += 1;
    accumulator.declaredQuality[qualityClass] += 1;
    collectIndexes(specification.name, properties, qualityClass, indexes, id);
    let effectiveQualityClass = qualityClass;
    if (specification.name === "tracks") {
      const { lengthMm, unresolvedDimensions } = addTrackDimensions(trackDimensions, feature, indexes);
      if (qualityClass === "A") invariant(unresolvedDimensions.length === 0, `Klasse-A-Gleis ${id} besitzt ungel\u00f6ste Dimensionen: ${unresolvedDimensions.join(", ")}.`);
      if (qualityClass === "B" && unresolvedDimensions.length > 0) {
        effectiveQualityClass = "C";
        const key = `B-to-C:${unresolvedDimensions.sort(compareText).join("+")}`;
        const correction = accumulator.qualityCorrections.get(key) ?? { declaredClass: "B", effectiveClass: "C", unresolvedDimensions: [...unresolvedDimensions].sort(compareText), features: 0, lengthMm: 0 };
        correction.features += 1;
        correction.lengthMm += lengthMm;
        accumulator.qualityCorrections.set(key, correction);
      }
      accumulator.declaredLengthByClassMm[qualityClass] += lengthMm;
      accumulator.effectiveLengthByClassMm[effectiveQualityClass] += lengthMm;
      trackLengthMm += lengthMm;
    }
    accumulator.effectiveQuality[effectiveQualityClass] += 1;
  }
  invariant(accumulator.featureCount > 0, `Sichtbarer Layer ${specification.name} besitzt keine Features.`);
  return {
    name: specification.name,
    featureType: specification.featureType,
    bytes: details.size,
    features: accumulator.featureCount,
    declaredQualityClassFeatureCount: accumulator.declaredQuality,
    qualityClassFeatureCount: accumulator.effectiveQuality,
    ...(specification.name === "tracks" ? {
      totalLengthMm: trackLengthMm,
      declaredQualityClassLengthMm: accumulator.declaredLengthByClassMm,
      qualityClassLengthMm: accumulator.effectiveLengthByClassMm,
      qualityClassificationCorrections: sortedObject(accumulator.qualityCorrections),
    } : {}),
  };
}

function validateSpecification(specification) {
  invariant(specification?.schema === "zugfolge-final-quality-inputs/v1", "Unbekanntes Gesamtqualit\u00e4ts-Eingabeschema.");
  invariant(typeof specification.releaseId === "string" && specification.releaseId !== "", "Gesamtqualit\u00e4tsbericht ohne releaseId.");
  invariant(Number.isSafeInteger(specification.timetableYear), "Gesamtqualit\u00e4tsbericht ohne Fahrplanjahr.");
  invariant(Array.isArray(specification.layers) && specification.layers.length === 10, "Gesamtqualit\u00e4tsbericht ben\u00f6tigt exakt zehn sichtbare Layer.");
  const expected = ["rail_corridors", "operating_points", "stations", "tracks", "platforms", "switches", "signals", "blocks", "conflict_resources", "rail_context"];
  invariant(JSON.stringify(specification.layers.map(({ name }) => name)) === JSON.stringify(expected), "Sichtbare Layer fehlen oder stehen nicht in der festen Kartenreihenfolge.");
  for (const layer of specification.layers) {
    invariant(typeof layer.file === "string" && layer.file !== "", `Layer ${layer.name} ohne Datei.`);
    invariant(typeof layer.featureType === "string" && layer.featureType !== "", `Layer ${layer.name} ohne featureType.`);
    invariant(Array.isArray(layer.classARequiredDimensions) && layer.classARequiredDimensions.length > 0, `Layer ${layer.name} ohne Klasse-A-Nachweisvertrag.`);
  }
  return specification;
}

function trackDimensionPolicies() {
  return {
    topology: { ruleId: "osm-node-topology/v1", classAEligibleWithoutReview: false, conservativeAssumption: null },
    maximumSpeed: { ruleId: "directional-speed-with-safe-fallback/v1", classAEligibleWithoutReview: false, conservativeAssumption: "20 km/h mainline or 10 km/h service track" },
    gradient: { ruleId: "copernicus-dem-glo30-track-gradient/v1", classAEligibleWithoutReview: false, conservativeAssumption: "-40 to +40 permille envelope" },
    electrification: { ruleId: "official-or-osm-electrification/v1", classAEligibleWithoutReview: false, conservativeAssumption: "none when unsupported or missing" },
    trackCount: { ruleId: "official-or-osm-track-count/v1", classAEligibleWithoutReview: false, conservativeAssumption: "one physical track" },
    signals: { ruleId: "assigned-osm-signal-or-merged-block/v1", classAEligibleWithoutReview: false, conservativeAssumption: "no invented signal; merge protection scope" },
    blocks: { ruleId: "conservative-signal-or-component-block/v1", classAEligibleWithoutReview: false, conservativeAssumption: "merged fixed block" },
    conflictResources: { ruleId: "block-plus-bidirectional-track-section-exclusion/v1", classAEligibleWithoutReview: false, conservativeAssumption: "exclusive compatibility and opposing movements serialized" },
  };
}

async function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function buildFinalQualityReport({ specification, artifactRoot }) {
  validateSpecification(specification);
  const root = resolve(artifactRoot);
  const indexes = { signalTracks: new Set(), blockTracks: new Map(), resourceTracks: new Map() };
  const dimensionAccumulators = Object.fromEntries(TRACK_DIMENSIONS.map((dimension) => [dimension, dimensionAccumulator()]));
  const byName = new Map();
  // Dependencies first: the track report joins these three semantic layers.
  for (const name of ["signals", "blocks", "conflict_resources"]) {
    const layer = specification.layers.find((candidate) => candidate.name === name);
    byName.set(name, await scanLayer(root, layer, indexes, dimensionAccumulators));
  }
  for (const layer of specification.layers) {
    if (!byName.has(layer.name)) byName.set(layer.name, await scanLayer(root, layer, indexes, dimensionAccumulators));
  }
  const layers = specification.layers.map(({ name }) => byName.get(name));
  const tracks = byName.get("tracks");
  const policies = trackDimensionPolicies();
  const dimensions = Object.fromEntries(TRACK_DIMENSIONS.map((dimension) => [
    dimension,
    finishDimension(dimensionAccumulators[dimension], tracks.features, tracks.totalLengthMm, policies[dimension]),
  ]));
  const visibleFeatures = layers.reduce((sum, layer) => sum + layer.features, 0);
  const qualityClassFeatureCount = classSummary();
  const declaredQualityClassFeatureCount = classSummary();
  for (const layer of layers) for (const qualityClass of QUALITY_CLASSES) qualityClassFeatureCount[qualityClass] += layer.qualityClassFeatureCount[qualityClass];
  for (const layer of layers) for (const qualityClass of QUALITY_CLASSES) declaredQualityClassFeatureCount[qualityClass] += layer.declaredQualityClassFeatureCount[qualityClass];
  const report = {
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId: specification.releaseId,
    timetableYear: specification.timetableYear,
    scopeId: "deutschland-ebo-visible-corpus",
    deterministic: true,
    policy: {
      classA: "accepted complete evidence for every layer-specific required dimension",
      classB: "complete conservative operational model with observed, derived or explicitly assumed dimensions",
      classC: "visible but not orderable because at least one required model relation remains unresolved",
      classAFromSingleSourceOrAutomatedInference: false,
      conservativeAssumptionsReportedSeparately: true,
      nonPublicSourceRawDataShipped: false,
    },
    summary: { visibleLayers: layers.length, visibleFeatures, declaredQualityClassFeatureCount, qualityClassFeatureCount },
    layers,
    trackDimensions: dimensions,
  };
  const serialized = JSON.stringify(report);
  for (const token of FORBIDDEN_PUBLIC_TOKENS) invariant(!serialized.toLowerCase().includes(token), `Verbotene interne Quellenkennung gelangt in den Gesamtqualit\u00e4tsbericht.`);
  return report;
}

export async function writeFinalQualityReport({ specificationPath, artifactRoot, outputPath }) {
  const specificationText = await readFile(resolve(specificationPath), "utf8");
  const specification = JSON.parse(specificationText);
  const report = await buildFinalQualityReport({ specification, artifactRoot });
  const output = resolve(outputPath);
  const temporary = `${output}.building`;
  for (const path of [output, temporary]) {
    try {
      await stat(path);
      throw new Error(`Gesamtqualit\u00e4ts-Ausgabe existiert bereits: ${path}.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const handle = await open(temporary, "wx");
  try {
    await handle.write(text);
    await handle.sync();
    await handle.close();
    await rename(temporary, output);
  } catch (error) {
    if (handle.fd !== -1) await handle.close();
    try {
      await unlink(temporary);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }
    throw error;
  }
  return { output, bytes: Buffer.byteLength(text), sha256: await sha256Text(text), report: JSON.parse(text) };
}
