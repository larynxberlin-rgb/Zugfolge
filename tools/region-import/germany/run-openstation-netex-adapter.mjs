#!/usr/bin/env node
// zugfolge:quelle=openstation
import { writeOpenStationOutputs } from "./openstation-netex-adapter.mjs";

const [inputPath, outputRoot, expectedSourceSha256] = process.argv.slice(2);
if (!inputPath || !outputRoot) {
  throw new Error("Aufruf: run-openstation-netex-adapter.mjs INPUT.xml OUTPUT_ROOT [EXPECTED_SHA256]");
}

const result = await writeOpenStationOutputs(inputPath, outputRoot, expectedSourceSha256);
process.stdout.write(`${JSON.stringify({
  sourceSha256: result.report.source.sha256,
  stations: result.report.counts.normalizedStations,
  stationFeatures: result.report.counts.stationFeatures,
  platformPointFeatures: result.report.counts.platformPointFeatures,
})}\n`);
