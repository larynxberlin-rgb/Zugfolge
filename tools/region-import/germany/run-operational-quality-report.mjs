#!/usr/bin/env node
import { writeOperationalQualityReport } from "./operational-quality-report.mjs";

const [specificationPath, outputPath, ...extra] = process.argv.slice(2);
if (!specificationPath || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: run-operational-quality-report.mjs INPUTS.json OUTPUT.json");
}
const result = await writeOperationalQualityReport({ specificationPath, outputPath });
process.stdout.write(`${JSON.stringify({
  output: result.output,
  bytes: result.bytes,
  sha256: result.sha256,
  operationalQualityEligible: result.report.qualityGate.operationalQualityEligible,
})}\n`);
