#!/usr/bin/env node
import { mergeTrackEnrichment } from "./merge-track-enrichment.mjs";

const [tracksPath, enrichmentPath, outputPath] = process.argv.slice(2);
if (!tracksPath || !enrichmentPath || !outputPath) {
  throw new Error("Aufruf: run-merge-track-enrichment.mjs TRACKS.geojsonseq COPERNICUS.geojsonseq OUTPUT.geojsonseq");
}
process.stdout.write(`${JSON.stringify(await mergeTrackEnrichment({ tracksPath, enrichmentPath, outputPath }))}\n`);
