#!/usr/bin/env node
import { buildGdalSemanticPmtiles } from "./gdal-semantic-pmtiles.mjs";

const [specificationPath, inputRoot, outputPath, runtimeManifestPath, artifactRoot, ...extra] = process.argv.slice(2);
if ([specificationPath, inputRoot, outputPath, runtimeManifestPath, artifactRoot].some((value) => value === undefined) || extra.length > 0) {
  throw new Error("Aufruf: build-gdal-semantic-pmtiles.mjs INPUTS.json INPUT_ROOT OUTPUT.pmtiles GDAL_RUNTIME_MANIFEST.json ARTEFAKTWURZEL");
}
const result = await buildGdalSemanticPmtiles({ specificationPath, inputRoot, outputPath, runtimeManifestPath, artifactRoot });
process.stdout.write(`${JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value)}\n`);
