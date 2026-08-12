import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

export const REQUIRED_INFRA_LAYERS = Object.freeze([
  "rail_corridors",
  "operating_points",
  "stations",
  "tracks",
  "platforms",
  "switches",
  "signals",
  "blocks",
  "conflict_resources",
  "rail_context",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function contained(root, path) {
  invariant(typeof path === "string" && path !== "" && !isAbsolute(path), `Ungültiger Layerpfad ${path}.`);
  const absolute = resolve(root, path);
  const remainder = relative(resolve(root), absolute);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `Layerpfad verlässt die Eingabewurzel: ${path}.`);
  return absolute;
}

export function validateSemanticTileInputs(specification) {
  invariant(specification?.schema === "zugfolge-semantic-tile-inputs/v1", "Unbekanntes semantisches Tile-Eingabeschema.");
  invariant(Array.isArray(specification.layers), "Semantischer Tilebuild ohne Layer.");
  const names = specification.layers.map(({ name }) => name);
  invariant(new Set(names).size === names.length, "Semantischer Tilebuild enthält doppelte Layer.");
  for (const required of REQUIRED_INFRA_LAYERS) invariant(names.includes(required), `Pflichtlayer ${required} fehlt.`);
  invariant(names.length === REQUIRED_INFRA_LAYERS.length, "Semantischer Tilebuild enthält unbekannte Layer.");
  for (const layer of specification.layers) {
    invariant(typeof layer.file === "string" && layer.file !== "", `Layer ${layer.name} ohne Eingabedatei.`);
    invariant(layer.stableFeatureIdProperty === "feature_id", `Layer ${layer.name} ohne stabile feature_id.`);
  }
  return specification;
}

export function buildSemanticTilePlan({ specification, inputRoot, outputPath, tippecanoe = "tippecanoe", pmtiles = "pmtiles" }) {
  validateSemanticTileInputs(specification);
  const mbtiles = `${resolve(outputPath)}.mbtiles`;
  const namedLayers = [...specification.layers]
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map((layer) => `--named-layer=${layer.name}:${resolve(inputRoot, layer.file)}`);
  return {
    schema: "zugfolge-semantic-tile-plan/v1",
    commands: [
      {
        id: "vector-tiles",
        command: tippecanoe,
        args: [
          "--force",
          "--no-tile-compression",
          "--minimum-zoom=4",
          "--maximum-zoom=18",
          "--no-feature-limit",
          "--no-tile-size-limit",
          "--preserve-input-order",
          "--output", mbtiles,
          ...namedLayers,
        ],
      },
      { id: "pmtiles", command: pmtiles, args: ["convert", mbtiles, resolve(outputPath)] },
    ],
    temporaryMbtiles: mbtiles,
    output: resolve(outputPath),
  };
}

function validateSemanticFeature(layerName, feature, previous) {
  invariant(feature?.type === "Feature" && feature.geometry !== null && typeof feature.geometry === "object", `Layer ${layerName} enthält kein GeoJSON-Feature.`);
  const properties = feature.properties;
  invariant(properties !== null && typeof properties === "object", `Layer ${layerName} enthält ein Feature ohne Eigenschaften.`);
  const id = properties.feature_id;
  invariant(typeof id === "string" && id !== "", `Layer ${layerName} enthält ein Feature ohne feature_id.`);
  invariant(typeof properties.feature_type === "string" && properties.feature_type !== "", `Feature ${id} ohne feature_type.`);
  invariant(id.startsWith(`${properties.feature_type}:`), `Feature ${id} trägt keinen typgebundenen stabilen ID-Präfix.`);
  invariant(previous === null || previous.localeCompare(id, "en") < 0, `Layer ${layerName} ist nicht streng nach feature_id sortiert.`);
  invariant(["A", "B", "C"].includes(properties.quality_class), `Feature ${id} ohne gültige quality_class.`);
  invariant(typeof properties.model_state === "string" && properties.model_state !== "", `Feature ${id} ohne model_state.`);
  return id;
}

export function validateSemanticFeatureSequence(layerName, features) {
  let previous = null;
  for (const feature of features) {
    previous = validateSemanticFeature(layerName, feature, previous);
  }
  invariant(previous !== null, `Layer ${layerName} ist leer.`);
  return true;
}

export async function validateSemanticTileFiles(specification, inputRoot) {
  validateSemanticTileInputs(specification);
  const counts = {};
  for (const layer of [...specification.layers].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const path = contained(inputRoot, layer.file);
    const metadata = await stat(path);
    invariant(metadata.isFile() && metadata.size > 0, `Layer ${layer.name} fehlt oder ist leer.`);
    let previous = null;
    let count = 0;
    for await (const raw of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
      const line = raw.replace(/^\x1e/, "").trim();
      if (line === "") continue;
      previous = validateSemanticFeature(layer.name, JSON.parse(line), previous);
      count += 1;
    }
    invariant(count > 0, `Layer ${layer.name} ist leer.`);
    counts[layer.name] = count;
  }
  return counts;
}
