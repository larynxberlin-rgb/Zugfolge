#!/usr/bin/env node
import { writeFinalQualityReport } from "./final-quality-report.mjs";

const [specificationPath, artifactRoot, outputPath] = process.argv.slice(2);
if (!specificationPath || !artifactRoot || !outputPath) {
  throw new Error("Aufruf: run-final-quality-report.mjs INPUTS.json ARTIFACT_ROOT OUTPUT.json");
}
const result = await writeFinalQualityReport({ specificationPath, artifactRoot, outputPath });
process.stdout.write(`${JSON.stringify({ output: result.output, bytes: result.bytes, sha256: result.sha256, visibleFeatures: result.report.summary.visibleFeatures })}\n`);
