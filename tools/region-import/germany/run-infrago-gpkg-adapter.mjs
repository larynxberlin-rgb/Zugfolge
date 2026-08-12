#!/usr/bin/env node
// zugfolge:quelle=db-infrago-infrastrukturdaten-open-data
import { writeInfraGoOutputs } from "./infrago-gpkg-adapter.mjs";

const [inputPath, outputRoot, expectedSourceSha256] = process.argv.slice(2);
if (!inputPath || !outputRoot) {
  throw new Error("Aufruf: run-infrago-gpkg-adapter.mjs INPUT.gpkg OUTPUT_ROOT [EXPECTED_SHA256]");
}

const result = await writeInfraGoOutputs(inputPath, outputRoot, expectedSourceSha256);
process.stdout.write(`${JSON.stringify({
  sourceSha256: result.report.source.sha256,
  trackSegments: result.report.normalizedCounts.trackSegments,
  operatingPlaces: result.report.normalizedCounts.operatingPlaces,
  operatingPlaceBindings: result.report.normalizedCounts.operatingPlaceBindings,
})}\n`);
