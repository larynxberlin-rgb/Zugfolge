#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { materializeStaticMapQuality } from "./static-map-quality.mjs";

const [command, specPath, detailedReportPath, outputPath] = process.argv.slice(2);
if (command !== "materialize" || [specPath, detailedReportPath, outputPath].some((value) => value === undefined)) {
  throw new Error("Aufruf: static-map-quality-cli.mjs materialize SPEC.json DETAILLIERTER-QUALITY-BUILD-INPUT.json AUSGABE.json");
}

const spec = JSON.parse(await readFile(resolve(specPath), "utf8"));
const result = await materializeStaticMapQuality(spec, resolve(detailedReportPath), resolve(outputPath));
process.stdout.write(`${JSON.stringify({
  action: result.status,
  outputPath: result.outputPath,
  bytes: result.bytes,
  sha256: result.sha256,
  schema: result.quality.schema,
  releaseId: result.quality.releaseId,
  infrastructureCorpusId: result.quality.infrastructureCorpusId,
  sourceReport: result.sourceProof,
  visibleLayers: result.quality.summary.visibleLayers,
  visibleFeatures: result.quality.summary.visibleFeatures,
  qualityClassFeatureCount: result.quality.summary.qualityClassFeatureCount,
})}\n`);
