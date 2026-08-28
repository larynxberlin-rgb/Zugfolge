#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGermanyOperationalAnchoredRunnerInvocation,
} from "./operational-infrastructure-v2-execution-pins.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [nodePath, executionPinsPath, specificationPath, sourceRoot, candidatePath, candidateSidecarPath, reportPath, nativeReceiptPath, ...extra] = process.argv.slice(2);
if (!nodePath || !executionPinsPath || !specificationPath || !sourceRoot || !candidatePath || !candidateSidecarPath || !reportPath || !nativeReceiptPath || extra.length > 0) {
  throw new Error("Aufruf: print-operational-infrastructure-v2-system-launch-command.mjs NODE EXECUTION-PINS.json SPEC.json SOURCE_ROOT CANDIDATE.json CANDIDATE-SIDECAR.json REPORT.json OUTPUT.native-receipt.json");
}

const runnerArguments = [executionPinsPath, specificationPath, sourceRoot, candidatePath, candidateSidecarPath, reportPath, nativeReceiptPath];
const invocation = await createGermanyOperationalAnchoredRunnerInvocation({
  workspaceRoot: REPOSITORY_ROOT,
  executionPinsPath: resolve(executionPinsPath),
  arguments: runnerArguments,
  nodePath: resolve(nodePath),
});

const commandBuilder = {
  file: "tools/region-import/germany/print-operational-infrastructure-v2-system-launch-command.mjs",
  causal: false,
  releaseEvidenceEligible: false,
};

const metadata = {
  schema: "zugfolge-operational-v2-direct-system-launch-command/v1",
  mode: "source-only-print-direct-command-v1",
  directCommand: {
    handoff: "diagnostic-copy-only-v1",
    releaseExecutionEligible: false,
    requiredVerification: "none-diagnostic-output-is-never-a-release-entrypoint",
  },
  expected: invocation.expected,
  commandBuilder,
  executionPins: invocation.executionPinsSource.proof,
};
process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
