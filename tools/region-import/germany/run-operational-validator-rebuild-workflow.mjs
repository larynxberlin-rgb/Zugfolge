#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  serializeGermanyOperationalDirectSystemLaunchContract,
} from "./build-operational-infrastructure-v2-direct-system-launch-contract.mjs";
import {
  GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE,
  createGermanyOperationalAnchoredRunnerInvocation,
  decodeGermanyOperationalAnchoredRunnerResult,
  loadGermanyOperationalExecutionPins,
} from "./operational-infrastructure-v2-execution-pins.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_CONTRACT_BYTES = 2 * 1024 * 1024;
const MAX_LAUNCHER_OUTPUT_BYTES = 4 * 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function portable(path, label) {
  const value = relative(ROOT, resolve(path));
  invariant(value !== "" && value !== ".." && !value.startsWith(`..${sep}`), `${label} verlaesst die Workflow-Arbeitswurzel.`);
  return value.split(sep).join("/");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadDirectContract(pathInput, executionPinsSource) {
  const path = resolve(pathInput);
  const bytes = await readFile(path);
  invariant(bytes.length > 0 && bytes.length <= MAX_CONTRACT_BYTES, "Direkter Annual-Systemstartvertrag ist leer oder zu gross.");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Direkter Annual-Systemstartvertrag ist kein JSON.", { cause: error });
  }
  invariant(bytes.equals(serializeGermanyOperationalDirectSystemLaunchContract(value)),
    "Direkter Annual-Systemstartvertrag ist nicht kanonisch serialisiert.");
  invariant(value?.schema === "zugfolge-operational-v2-direct-system-launch-contract/v1"
    && value.releaseId === executionPinsSource.value.releaseId && value.platform === "win32",
  "Direkter Annual-Systemstartvertrag bindet eine falsche Identitaet.");
  invariant(JSON.stringify(canonicalValue(value.executionPins)) === JSON.stringify(canonicalValue(executionPinsSource.proof)),
    "Direkter Annual-Systemstartvertrag bindet andere Execution-Pins.");
  invariant(JSON.stringify(canonicalValue(value.trustedExecutor)) === JSON.stringify(canonicalValue({
    buildCommit: executionPinsSource.value.validator.buildCommit,
    bytes: executionPinsSource.value.validator.bytes,
    file: executionPinsSource.value.validator.file,
    sha256: executionPinsSource.value.validator.sha256,
  })), "Direkter Annual-Systemstartvertrag bindet einen anderen Trusted Executor.");
  return {
    proof: {
      bytes: bytes.length,
      file: portable(path, "Direkter Annual-Systemstartvertrag"),
      releaseId: value.releaseId,
      schema: value.schema,
      sha256: sha256(bytes),
    },
    value,
  };
}

invariant(process.platform === "win32", "Releasefaehiger Validator-Rebuild-v3 ist ausschliesslich auf Windows definiert.");
invariant(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
  "Workflow-Orchestrierung darf nur auf einem frischen GitHub-hosted Runner starten.");

const [command, ...inputs] = process.argv.slice(2);
let phase;
let executionPinsInput;
let directContractInput;
let phaseArguments;
if (command === "materialize" && inputs.length === 4) {
  [executionPinsInput, directContractInput] = inputs;
  phase = "materialize-validator-rebuild-v3";
  phaseArguments = [inputs[0], inputs[2], inputs[3]];
} else if (command === "annual-plan" && inputs.length === 7) {
  [executionPinsInput, directContractInput] = inputs;
  phase = "materialize-annual-plan-evidence-v1";
  phaseArguments = [inputs[0], ...inputs.slice(2)];
} else {
  throw new Error([
    "Aufruf:",
    "  run-operational-validator-rebuild-workflow.mjs materialize EXECUTION-PINS.json DIRECT-CONTRACT.json REBUILD-SPEC.json RECEIPT.json",
    "  run-operational-validator-rebuild-workflow.mjs annual-plan EXECUTION-PINS.json DIRECT-CONTRACT.json CONFIG.json CATALOG.json RIGHTS.json PLAN.json START-EVIDENCE.json",
  ].join("\n"));
}

const executionPinsPath = resolve(executionPinsInput);
const directContractPath = resolve(directContractInput);
const executionPinsSource = await loadGermanyOperationalExecutionPins({
  workspaceRoot: ROOT,
  executionPinsPath,
});
const directContract = await loadDirectContract(directContractPath, executionPinsSource);
const annualLaunchProof = {
  contract: directContract.proof,
  executionPins: executionPinsSource.proof,
  mode: GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE,
  trustedExecutor: directContract.value.trustedExecutor,
};
const annualLaunchProofBase64 = Buffer.from(JSON.stringify(canonicalValue(annualLaunchProof)), "utf8").toString("base64");
const invocation = await createGermanyOperationalAnchoredRunnerInvocation({
  annualLaunchProofBase64,
  arguments: phaseArguments.map((value) => resolve(value)),
  executionPinsPath,
  nodePath: process.execPath,
  phase,
  workspaceRoot: ROOT,
});
const launched = spawnSync(invocation.command, invocation.arguments, {
  cwd: invocation.cwd,
  encoding: "utf8",
  env: invocation.env,
  maxBuffer: MAX_LAUNCHER_OUTPUT_BYTES,
  shell: false,
  windowsHide: true,
});
const anchored = decodeGermanyOperationalAnchoredRunnerResult(launched, invocation.expected);
if (anchored.stderr.length > 0) process.stderr.write(anchored.stderr);
invariant(anchored.signal === null && anchored.status === 0,
  `Gehaltene Rebuild-v3-Runnerphase scheiterte mit ${anchored.signal ?? `Exit ${anchored.status}`}.`);
process.stdout.write(anchored.stdout);
