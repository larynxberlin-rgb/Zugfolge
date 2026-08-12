#!/usr/bin/env node
import { buildGdalSemanticPmtiles } from "./gdal-semantic-pmtiles.mjs";

const [specificationPath, inputRoot, outputPath, ogr2ogr = "ogr2ogr"] = process.argv.slice(2);
if (!outputPath) {
  throw new Error("Aufruf: build-gdal-semantic-pmtiles.mjs INPUTS.json INPUT_ROOT OUTPUT.pmtiles [OGR2OGR]");
}
const result = await buildGdalSemanticPmtiles({ specificationPath, inputRoot, outputPath, ogr2ogr });
process.stdout.write(`${JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value)}\n`);
