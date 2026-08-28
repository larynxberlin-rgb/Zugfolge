#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { captureGermanyOperationalInfrastructureV2NativeReceipt } from "./operational-infrastructure-v2-publication.mjs";

const MAX_STDIN_BYTES = 256 * 1024;
const HERE = dirname(fileURLToPath(import.meta.url));

async function readStructuredReceipt() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error("Native Receipt-Eingabe ist unerwartet gross.");
    chunks.push(chunk);
  }
  if (bytes === 0) throw new Error("Native Receipt-Eingabe auf stdin fehlt.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error("Native Receipt-Eingabe auf stdin ist kein einzelner strukturierter JSON-Wert.", { cause: error });
  }
}

const [specificationPath, candidatePath, candidateMovementRouteTemplatesPath, reportPath, nativeExecutablePath, validatorRebuildSpecificationPath, validatorRebuildEvidencePath, outputPath, ...extra] = process.argv.slice(2);
if (!specificationPath || !candidatePath || !candidateMovementRouteTemplatesPath || !reportPath || !nativeExecutablePath || !validatorRebuildSpecificationPath || !validatorRebuildEvidencePath || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: capture-operational-infrastructure-v2-native-receipt.mjs SPEC.json CANDIDATE.json CANDIDATE-SIDECAR.json REPORT.json NATIVE-EXECUTABLE VALIDATOR-REBUILD-SPEC.json VALIDATOR-REBUILD-EVIDENCE.json OUTPUT.native-receipt.json < RECEIPT.json");
}

const result = await captureGermanyOperationalInfrastructureV2NativeReceipt({
  nativeReceipt: await readStructuredReceipt(),
  specificationPath: resolve(specificationPath),
  candidatePath: resolve(candidatePath),
  candidateMovementRouteTemplatesPath: resolve(candidateMovementRouteTemplatesPath),
  reportPath: resolve(reportPath),
  nativeExecutablePath: resolve(nativeExecutablePath),
  validatorRebuildSpecificationPath: resolve(validatorRebuildSpecificationPath),
  validatorRebuildEvidencePath: resolve(validatorRebuildEvidencePath),
  outputPath: resolve(outputPath),
  captureEntrypointPath: resolve(HERE, "capture-operational-infrastructure-v2-native-receipt.mjs"),
});
process.stdout.write(`${JSON.stringify({ path: result.path, bytes: result.bytes, sha256: result.sha256 })}\n`);
