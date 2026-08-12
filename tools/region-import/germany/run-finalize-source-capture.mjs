#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { finalizeGermanySourceCapture } from "./finalize-source-capture.mjs";

const [baseCapturePath, demCapturePath, internalEvidenceLedgerPath, outputPath, ...extra] = process.argv.slice(2);
if (!baseCapturePath || !demCapturePath || !internalEvidenceLedgerPath || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: run-finalize-source-capture.mjs BASE_CAPTURE.json DEM_CAPTURE.json INTERNES_LEDGER.json OUTPUT.json");
}
const [baseCapture, demCapture] = await Promise.all([
  readFile(resolve(baseCapturePath), "utf8").then(JSON.parse),
  readFile(resolve(demCapturePath), "utf8").then(JSON.parse),
]);
const result = await finalizeGermanySourceCapture({
  baseCapture,
  demCapture,
  internalEvidenceLedgerPath: resolve(internalEvidenceLedgerPath),
});
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ sources: result.sources.length, internalEvidenceLedgerSha256: result.internalEvidenceLedgerSha256, output: resolve(outputPath) })}\n`);
