#!/usr/bin/env node
import { resolve } from "node:path";

import { writeAnnualSyntheticOperationalClosure } from "./synthetic-operational-closure.mjs";

const [specificationPath, outputPath, ...extra] = process.argv.slice(2);
if (!specificationPath || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: run-synthetic-operational-closure.mjs INPUTS.json OUTPUT.json");
}

const result = await writeAnnualSyntheticOperationalClosure({
  specificationPath: resolve(specificationPath),
  repositoryRoot: process.cwd(),
  outputPath: resolve(outputPath),
});
process.stdout.write(`${JSON.stringify({ output: result.output, bytes: result.bytes, sha256: result.sha256, receiptSha256: result.receipt.receiptSha256 })}\n`);
