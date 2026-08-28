#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectGermanyOperationalInfrastructureV2Publication,
  publishGermanyOperationalInfrastructureV2FromNativeReceipt,
  recoverGermanyOperationalInfrastructureV2Publication,
} from "./operational-infrastructure-v2-publication.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const [mode, ...arguments_] = process.argv.slice(2);
if (mode === "preflight" || mode === "recover") {
  const [outputPath, publicationReceiptPath, ...extra] = arguments_;
  if (!outputPath || !publicationReceiptPath || extra.length > 0) {
    throw new Error(`Aufruf: publish-operational-infrastructure-v2.mjs ${mode} OUTPUT/operational-infrastructure-v2.json OUTPUT/publication-receipt.json`);
  }
  const result = mode === "preflight"
    ? await inspectGermanyOperationalInfrastructureV2Publication({ outputPath: resolve(outputPath), publicationReceiptPath: resolve(publicationReceiptPath) })
    : await recoverGermanyOperationalInfrastructureV2Publication({ outputPath: resolve(outputPath), publicationReceiptPath: resolve(publicationReceiptPath) });
  process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
} else if (mode === "publish") {
  const [specificationPath, candidatePath, candidateMovementRouteTemplatesPath, reportPath, nativeReceiptPath, validatorRebuildSpecificationPath, validatorRebuildEvidencePath, outputPath, publicationReceiptPath, ...extra] = arguments_;
  if (!specificationPath || !candidatePath || !candidateMovementRouteTemplatesPath || !reportPath || !nativeReceiptPath || !validatorRebuildSpecificationPath || !validatorRebuildEvidencePath || !outputPath || !publicationReceiptPath || extra.length > 0) {
    throw new Error("Aufruf: publish-operational-infrastructure-v2.mjs publish SPEC.json CANDIDATE.json CANDIDATE-SIDECAR.json REPORT.json NATIVE-RECEIPT.json VALIDATOR-REBUILD-SPEC.json VALIDATOR-REBUILD-EVIDENCE.json OUTPUT/operational-infrastructure-v2.json OUTPUT/publication-receipt.json");
  }
  const result = await publishGermanyOperationalInfrastructureV2FromNativeReceipt({
    specificationPath: resolve(specificationPath),
    candidatePath: resolve(candidatePath),
    candidateMovementRouteTemplatesPath: resolve(candidateMovementRouteTemplatesPath),
    reportPath: resolve(reportPath),
    nativeReceiptPath: resolve(nativeReceiptPath),
    validatorRebuildSpecificationPath: resolve(validatorRebuildSpecificationPath),
    validatorRebuildEvidencePath: resolve(validatorRebuildEvidencePath),
    outputPath: resolve(outputPath),
    publicationReceiptPath: resolve(publicationReceiptPath),
    publisherEntrypointPath: resolve(HERE, "publish-operational-infrastructure-v2.mjs"),
  });
  process.stdout.write(`${JSON.stringify({ status: result.receipt.status, infraReleaseId: result.receipt.infraReleaseId, paths: result.paths })}\n`);
} else {
  throw new Error("Aufruf: publish-operational-infrastructure-v2.mjs preflight|recover|publish ...");
}
