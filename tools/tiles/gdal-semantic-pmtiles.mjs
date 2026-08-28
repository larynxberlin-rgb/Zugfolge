import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { loadAndVerifyGdalRuntimeBundle } from "./gdal-runtime-bundle.mjs";
import { inspectPmtilesFile } from "./map-package.mjs";
import { validateSemanticTileFiles, validateSemanticTileInputs } from "./semantic-tiles.mjs";

const LAYER_CONFIGURATION = Object.freeze({
  rail_corridors: {
    minzoom: 4,
    maxzoom: 11,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable", "route_number", "route_name", "direction", "maximum_speed_kmh", "electrification", "track_count", "construction", "db_operation"],
  },
  operating_points: {
    minzoom: 5,
    maxzoom: 18,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable", "rl100", "name"],
  },
  stations: {
    minzoom: 5,
    maxzoom: 18,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable", "name", "station_id", "uic", "rl100"],
  },
  tracks: {
    minzoom: 8,
    maxzoom: 18,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable", "length_mm", "speed_forward_kmh", "speed_backward_kmh", "official_route_number", "official_speed_kmh", "official_electrification", "official_track_count", "gradient_status", "representative_gradient_permille", "minimum_gradient_permille", "maximum_gradient_permille", "uncertainty_permille"],
  },
  platforms: {
    minzoom: 11,
    maxzoom: 18,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable"],
  },
  switches: {
    minzoom: 13,
    maxzoom: 18,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable"],
  },
  signals: {
    minzoom: 13,
    maxzoom: 18,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable", "block_boundary"],
  },
  blocks: {
    minzoom: 12,
    maxzoom: 18,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable", "length_mm", "track_count", "boundary_signal_count"],
  },
  conflict_resources: {
    minzoom: 13,
    maxzoom: 18,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable", "resource_kind", "block_id"],
  },
  rail_context: {
    minzoom: 5,
    maxzoom: 18,
    fields: ["feature_id", "feature_type", "quality_class", "model_state", "orderable", "context_kind"],
  },
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function run(command, args, environment = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      env: environment,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`${basename(command)} endete mit ${code ?? `Signal ${signal}`}.`));
    });
  });
}

export function buildGdalSemanticTilePlan({ specification, inputRoot, outputPath, runtime, temporaryRoot }) {
  validateSemanticTileInputs(specification);
  invariant(runtime !== null && typeof runtime === "object" && !Array.isArray(runtime), "Manifestverifizierte GDAL-Runtime fehlt.");
  invariant(typeof runtime.command === "string" && isAbsolute(runtime.command), "GDAL-Runtime besitzt keinen absoluten Entry-Point.");
  invariant(runtime.environment !== null && typeof runtime.environment === "object" && !Array.isArray(runtime.environment), "GDAL-Runtime besitzt keine manifestgebundene Umgebung.");
  invariant(typeof runtime.environment.PATH === "string" && typeof runtime.environment.GDAL_DATA === "string" && typeof runtime.environment.PROJ_DATA === "string", "GDAL-Runtime besitzt keine vollständige PATH-/GDAL_DATA-/PROJ_DATA-Bindung.");
  const layers = specification.layers.map((layer) => {
    const policy = LAYER_CONFIGURATION[layer.name];
    invariant(policy !== undefined, `Layer ${layer.name} besitzt keine GDAL-Tilekonfiguration.`);
    return { ...layer, ...policy };
  }).sort((left, right) => compareText(left.name, right.name));
  const root = resolve(temporaryRoot);
  const sourceDatabase = resolve(root, "semantic-source.gpkg");
  const configurationPath = resolve(root, "semantic-layer-configuration.json");
  const buildingPmtiles = resolve(root, "infrastructure.pmtiles");
  const gdalEnvironment = { ...runtime.environment };
  const imports = layers.map((layer, index) => ({
    id: `import-${layer.name}`,
    command: runtime.command,
    args: [
      "-f", "GPKG",
      "-if", "GeoJSONSeq",
      ...(index === 0 ? ["-overwrite"] : ["-update"]),
      sourceDatabase,
      resolve(inputRoot, layer.file),
      "-nln", layer.name,
      "-nlt", "GEOMETRY",
      "-select", layer.fields.join(","),
      "-lco", "SPATIAL_INDEX=YES",
    ],
    environment: gdalEnvironment,
  }));
  const configuration = Object.fromEntries(layers.map((layer) => [layer.name, {
    target_name: layer.name,
    description: `Zugfolge ${layer.name}`,
    minzoom: layer.minzoom,
    maxzoom: layer.maxzoom,
  }]));
  return {
    schema: "zugfolge-gdal-semantic-pmtiles-plan/v1",
    imports,
    tileBuild: {
      id: "build-pmtiles",
      command: runtime.command,
      args: [
        "-f", "PMTiles",
        "-dsco", "NAME=Zugfolge Deutschland-Infrastruktur",
        "-dsco", "DESCRIPTION=Semantischer EBO-Infrastrukturgraph Deutschland",
        "-dsco", "TYPE=overlay",
        "-dsco", "MINZOOM=4",
        "-dsco", "MAXZOOM=18",
        "-dsco", `CONF=${configurationPath}`,
        "-dsco", "MAX_SIZE=2000000",
        "-dsco", "MAX_FEATURES=500000",
        "-dsco", "SIMPLIFICATION=0.5",
        "-dsco", "SIMPLIFICATION_MAX_ZOOM=0",
        buildingPmtiles,
        sourceDatabase,
      ],
      environment: { ...gdalEnvironment, GDAL_NUM_THREADS: "ALL_CPUS" },
    },
    configuration,
    configurationPath,
    sourceDatabase,
    buildingPmtiles,
    output: resolve(outputPath),
    layers,
  };
}

export async function buildGdalSemanticPmtiles({ specificationPath, inputRoot, outputPath, runtimeManifestPath, artifactRoot }) {
  const specification = JSON.parse(await readFile(resolve(specificationPath), "utf8"));
  const featureCounts = await validateSemanticTileFiles(specification, inputRoot);
  invariant(typeof runtimeManifestPath === "string" && runtimeManifestPath.length > 0, "GDAL-Runtime-Manifest fehlt.");
  invariant(typeof artifactRoot === "string" && artifactRoot.length > 0, "GDAL-Runtime-Artefaktwurzel fehlt.");
  const runtimeBundle = await loadAndVerifyGdalRuntimeBundle(resolve(runtimeManifestPath), resolve(artifactRoot));
  const destination = resolve(outputPath);
  const temporaryRoot = `${destination}.building`;
  invariant(!(await stat(destination).catch(() => null)), `Ziel ${destination} existiert bereits.`);
  invariant(!(await stat(temporaryRoot).catch(() => null)), `Paralleler oder abgebrochener Tilebuild ${temporaryRoot} existiert.`);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(temporaryRoot, { recursive: false });
  const plan = buildGdalSemanticTilePlan({
    specification,
    inputRoot,
    outputPath,
    runtime: runtimeBundle.verification.invocation,
    temporaryRoot,
  });
  try {
    await writeFile(plan.configurationPath, `${JSON.stringify(plan.configuration, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    for (const step of plan.imports) await run(step.command, step.args, step.environment);
    await run(plan.tileBuild.command, plan.tileBuild.args, plan.tileBuild.environment);
    const inspection = await inspectPmtilesFile(plan.buildingPmtiles, "Deutschland-Infrastruktur");
    const actualLayers = new Set(inspection.metadata.vector_layers.map(({ id }) => id));
    for (const layer of specification.layers) invariant(actualLayers.has(layer.name), `PMTiles enthält Pflichtlayer ${layer.name} nicht.`);
    invariant(actualLayers.size === specification.layers.length, "PMTiles enthält unerwartete oder doppelte Layer.");
    const tileStatistics = new Map((inspection.metadata.tilestats?.layers ?? []).map((layer) => [layer.layer, layer.count]));
    for (const layer of specification.layers) {
      invariant(tileStatistics.get(layer.name) === featureCounts[layer.name], `PMTiles-Layer ${layer.name} enthält ${tileStatistics.get(layer.name) ?? "keine"} statt ${featureCounts[layer.name]} Features.`);
    }
    await rename(plan.buildingPmtiles, destination);
    return {
      output: destination,
      featureCounts,
      inspection,
      runtime: {
        manifestSha256: runtimeBundle.sha256,
        runtimeId: runtimeBundle.verification.runtimeId,
        version: runtimeBundle.verification.version,
        platform: runtimeBundle.verification.platform,
        files: runtimeBundle.verification.files,
        bytes: runtimeBundle.verification.bytes,
        inventorySha256: runtimeBundle.verification.inventorySha256,
        probes: runtimeBundle.verification.probes,
      },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export const GDAL_SEMANTIC_LAYER_CONFIGURATION = LAYER_CONFIGURATION;
