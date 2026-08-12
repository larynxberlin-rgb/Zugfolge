#!/usr/bin/env node
import { buildInfraGoSpatialCrosswalk } from "./infrago-spatial-crosswalk.mjs";

const [tracksPath, normalizedSegmentsPath, normalizedOperatingPlacesPath, officialGeometryPath, outputRoot] = process.argv.slice(2);
if (!outputRoot) {
  throw new Error("Aufruf: run-infrago-spatial-crosswalk.mjs TRACKS.geojsonseq SEGMENTS.jsonseq OPERATING-PLACES.jsonseq OFFICIAL-GEOMETRY.geojsonseq OUTPUT_ROOT");
}

const report = await buildInfraGoSpatialCrosswalk({
  tracksPath,
  normalizedSegmentsPath,
  normalizedOperatingPlacesPath,
  officialGeometryPath,
  outputRoot,
});
process.stdout.write(`${JSON.stringify(report)}\n`);
