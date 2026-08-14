import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

const LAYERS = Object.freeze([
  ["rail_corridors", "rail-corridors.geojsonseq"],
  ["operating_points", "operating-points.geojsonseq"],
  ["stations", "stations.geojsonseq"],
  ["tracks", "tracks.geojsonseq"],
  ["platforms", "platforms.geojsonseq"],
  ["switches", "switches.geojsonseq"],
  ["signals", "signals.geojsonseq"],
  ["blocks", "blocks.geojsonseq"],
  ["conflict_resources", "conflict-resources.geojsonseq"],
  ["rail_context", "rail-context.geojsonseq"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function copyRegularFile(source, destination, label, allowedRoots) {
  const linkMetadata = await lstat(source);
  invariant(linkMetadata.isFile() && !linkMetadata.isSymbolicLink(), `${label} ist keine regulaere Datei oder ist ein Symlink.`);
  const [canonicalSource, canonicalRoots] = await Promise.all([
    realpath(source),
    Promise.all(allowedRoots.map((root) => realpath(root))),
  ]);
  invariant(canonicalRoots.some((root) => {
    const remainder = relative(root, canonicalSource);
    return remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder);
  }), `${label} liegt ausserhalb der zugelassenen Quellwurzeln.`);
  const metadata = await stat(canonicalSource);
  invariant(metadata.isFile() && metadata.size > 0, `${label} ist keine regulaere, nichtleere Datei.`);
  await copyFile(source, destination, 1);
}

async function validateGeoJsonSequence(path, label) {
  let records = 0;
  let lineNumber = 0;
  for await (const raw of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
    lineNumber += 1;
    const line = raw.replace(/^\x1e/u, "").trim();
    if (line === "") continue;
    let feature;
    try {
      feature = JSON.parse(line);
    } catch (error) {
      throw new Error(`${label}:${lineNumber} ist keine gueltige GeoJSON-Sequenz: ${error.message}`);
    }
    invariant(
      feature?.type === "Feature"
        && typeof feature.properties?.feature_id === "string"
        && feature.properties.feature_id !== "",
      `${label}:${lineNumber} enthaelt kein GeoJSON-Feature mit stabiler feature_id.`,
    );
    records += 1;
  }
  invariant(records > 0, `${label} ist eine leere GeoJSON-Sequenz.`);
}

export async function assembleSemanticTileInputs(configuration) {
  invariant(configuration?.schema === "zugfolge-semantic-tile-assembly/v1", "Unbekannter Tile-Assembly-Vertrag.");
  invariant(Array.isArray(configuration.allowedSourceRoots) && configuration.allowedSourceRoots.length > 0, "Zugelassene Quellwurzeln fehlen.");
  const allowedRoots = configuration.allowedSourceRoots.map((root) => {
    invariant(typeof root === "string" && root !== "", "Zugelassene Quellwurzel ist ungueltig.");
    return resolve(root);
  });
  const destination = resolve(configuration.outputDirectory);
  const staging = `${destination}.building`;
  invariant(!(await lstat(destination).catch(() => null)), `Ziel ${destination} existiert bereits.`);
  invariant(!(await lstat(staging).catch(() => null)), `Paralleler Tile-Assembly-Build ${staging} existiert.`);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(staging, { recursive: false });
  try {
    const sources = {
      "rail-corridors.geojsonseq": configuration.railCorridors,
      "operating-points.geojsonseq": configuration.operatingPoints,
      "stations.geojsonseq": configuration.stations,
      "tracks.geojsonseq": configuration.finalMapLayers?.tracks,
      "platforms.geojsonseq": configuration.finalMapLayers?.platforms,
      "switches.geojsonseq": configuration.finalMapLayers?.switches,
      "signals.geojsonseq": configuration.finalMapLayers?.signals,
      "blocks.geojsonseq": configuration.finalMapLayers?.blocks,
      "conflict-resources.geojsonseq": configuration.finalMapLayers?.conflictResources,
      "rail-context.geojsonseq": configuration.railContext,
    };
    for (const [, file] of LAYERS) {
      const source = sources[file];
      invariant(typeof source === "string" && source !== "", `Quelle fuer ${file} fehlt.`);
      await copyRegularFile(resolve(source), resolve(staging, file), file, allowedRoots);
    }
    const manifest = {
      schema: "zugfolge-semantic-tile-inputs/v1",
      layers: LAYERS.map(([name, file]) => ({ name, file, stableFeatureIdProperty: "feature_id" })),
    };
    await writeFile(resolve(staging, "inputs.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    for (const [, file] of LAYERS) await validateGeoJsonSequence(resolve(staging, file), basename(file));
    await rename(staging, destination);
    return { outputDirectory: destination, layers: LAYERS.length };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const [configurationPath, ...extra] = process.argv.slice(2);
if (configurationPath !== undefined) {
  invariant(extra.length === 0, "Aufruf: assemble-semantic-tile-inputs.mjs CONFIG.json");
  const configuration = JSON.parse(await readFile(resolve(configurationPath), "utf8"));
  process.stdout.write(`${JSON.stringify(await assembleSemanticTileInputs(configuration))}\n`);
}
