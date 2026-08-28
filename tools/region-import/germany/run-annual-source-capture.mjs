#!/usr/bin/env node
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildAnnualSourceCapture, sha256AnnualSourceCapturePlan } from "./annual-source-capture.mjs";

const [planPath, catalogPath, rightsPath, sourceRoot, capturedAt, outputPath, ...extra] = process.argv.slice(2);
if (!planPath || !catalogPath || !rightsPath || !sourceRoot || !capturedAt || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: run-annual-source-capture.mjs PLAN.json SOURCE_CATALOG.json RIGHTS.json SOURCE_ROOT CAPTURED_AT OUTPUT.json");
}
const absolutePlan = resolve(planPath);
const [plan, catalog, rightsRegistry, capturePlanSha256] = await Promise.all([
  readFile(absolutePlan, "utf8").then(JSON.parse),
  readFile(resolve(catalogPath), "utf8").then(JSON.parse),
  readFile(resolve(rightsPath), "utf8").then(JSON.parse),
  sha256AnnualSourceCapturePlan(absolutePlan),
]);
const capture = await buildAnnualSourceCapture({ plan, catalog, rightsRegistry, sourceRoot: resolve(sourceRoot), capturedAt, capturePlanSha256 });
const absoluteOutput = resolve(outputPath);
await mkdir(dirname(absoluteOutput), { recursive: true });
const handle = await open(absoluteOutput, "wx", 0o600);
try {
  await handle.writeFile(`${JSON.stringify(capture, null, 2)}\n`, "utf8");
  await handle.sync();
} finally {
  await handle.close();
}
process.stdout.write(`${JSON.stringify({ output: absoluteOutput, schema: capture.schema, sources: capture.sources.length, capturePlanSha256 })}\n`);
