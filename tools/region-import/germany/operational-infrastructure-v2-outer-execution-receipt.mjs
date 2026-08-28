import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { verifyGermanyAnnualCreateNewArtifact } from "./annual-create-new-artifact.mjs";
import {
  GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE,
  GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS,
  GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS,
  GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
  GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
  GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND,
  GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE,
  GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
  germanyOperationalStructuredValueSha256,
  loadGermanyOperationalExecutionPins,
  proveGermanyOperationalExecutionContext,
} from "./operational-infrastructure-v2-execution-pins.mjs";

export const GERMANY_OPERATIONAL_OUTER_EXECUTION_RECEIPT_SCHEMA =
  "zugfolge-operational-v2-outer-execution-receipt/v1";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const MAX_SMALL_BYTES = 64 * 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  invariant(isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
  `${label} besitzt fremde oder fehlende Felder.`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function sameCanonical(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

export function validateGermanyOperationalOuterNativeAnnualLaunchBinding(outer, nativeReceiptCapture) {
  invariant(isRecord(outer?.annualLaunch),
    "Operational-v2-Outer-Execution-Receipt besitzt keinen Annual-Launch-Vertrag.");
  invariant(nativeReceiptCapture?.operationalProvenance?.producerKind === GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND
    && nativeReceiptCapture.operationalProvenance.releaseEvidenceEligible === true
    && nativeReceiptCapture.operationalProvenance.productionActivationEligible === true
    && sameCanonical(nativeReceiptCapture.operationalProvenance.executionProof?.annualLaunch, outer.annualLaunch),
  "Operational-v2-Outer-Execution-Receipt und Native-Receipt binden nicht denselben integrierten Annual-Launch-Vertrag.");
  return true;
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} ist keine positive sichere Ganzzahl.`);
  return value;
}

function sha256(value, label) {
  invariant(typeof value === "string" && SHA256.test(value), `${label} ist kein SHA-256.`);
  return value;
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value.length > 0 && !isAbsolute(value)
    && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  `${label} ist kein sicherer portabler Pfad.`);
  return value;
}

function fileProof(value, label) {
  exactKeys(value, ["bytes", "file", "sha256"], label);
  portablePath(value.file, `${label}.file`);
  positiveInteger(value.bytes, `${label}.bytes`);
  sha256(value.sha256, `${label}.sha256`);
  return value;
}

function executionPinsProof(value, label) {
  exactKeys(value, ["bytes", "file", "schema", "sha256"], label);
  portablePath(value.file, `${label}.file`);
  positiveInteger(value.bytes, `${label}.bytes`);
  invariant(value.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
    `${label}.schema ist unbekannt.`);
  sha256(value.sha256, `${label}.sha256`);
  return value;
}

function validateAnnualLaunch(value, label) {
  exactKeys(value, ["contract", "executionPins", "mode", "trustedExecutor"], label);
  invariant(value.mode === GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE, `${label}.mode ist unbekannt.`);
  exactKeys(value.contract, ["bytes", "file", "releaseId", "schema", "sha256"], `${label}.contract`);
  portablePath(value.contract.file, `${label}.contract.file`);
  positiveInteger(value.contract.bytes, `${label}.contract.bytes`);
  sha256(value.contract.sha256, `${label}.contract.sha256`);
  invariant(value.contract.schema === GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
    `${label}.contract.schema ist unbekannt.`);
  exactKeys(value.executionPins, ["bytes", "file", "schema", "sha256"], `${label}.executionPins`);
  invariant(value.executionPins.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
    `${label}.executionPins.schema ist unbekannt.`);
  positiveInteger(value.executionPins.bytes, `${label}.executionPins.bytes`);
  portablePath(value.executionPins.file, `${label}.executionPins.file`);
  sha256(value.executionPins.sha256, `${label}.executionPins.sha256`);
  exactKeys(value.trustedExecutor, ["buildCommit", "bytes", "file", "sha256"], `${label}.trustedExecutor`);
  invariant(GIT_COMMIT.test(value.trustedExecutor.buildCommit), `${label}.trustedExecutor.buildCommit ist ungueltig.`);
  portablePath(value.trustedExecutor.file, `${label}.trustedExecutor.file`);
  positiveInteger(value.trustedExecutor.bytes, `${label}.trustedExecutor.bytes`);
  sha256(value.trustedExecutor.sha256, `${label}.trustedExecutor.sha256`);
  return value;
}

function stateFileProof(value, label) {
  exactKeys(value, ["bytes", "file", "sha256", "stateHash"], label);
  sha256(value.stateHash, `${label}.stateHash`);
  fileProof({ bytes: value.bytes, file: value.file, sha256: value.sha256 }, label);
  return value;
}

function movementFileProof(value, label) {
  exactKeys(value, [
    "bytes", "file", "operationalStateHash", "sha256", "stateHash", "timetableTransferSetSha256",
  ], label);
  for (const key of ["operationalStateHash", "stateHash", "timetableTransferSetSha256"]) sha256(value[key], `${label}.${key}`);
  fileProof({ bytes: value.bytes, file: value.file, sha256: value.sha256 }, label);
  return value;
}

function validateRunnerShape(value, label) {
  exactKeys(value, ["anchorHelper", "bundle", "entrypoint", "importClosure", "invocation", "launcher", "runtime"], label);
  fileProof(value.bundle, `${label}.bundle`);
  fileProof(value.entrypoint, `${label}.entrypoint`);
  exactKeys(value.anchorHelper, ["bytes", "file", "sha256"], `${label}.anchorHelper`);
  fileProof(value.anchorHelper, `${label}.anchorHelper`);
  invariant(value.anchorHelper.file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
    `${label}.anchorHelper ist nicht die kanonische Helper-Assembly.`);
  invariant(Array.isArray(value.importClosure) && value.importClosure.length > 0, `${label}.importClosure fehlt.`);
  for (const [index, proof] of value.importClosure.entries()) fileProof(proof, `${label}.importClosure[${index}]`);
  exactKeys(value.invocation, ["mode", "nodeArguments", "nodeOptions"], `${label}.invocation`);
  invariant(value.invocation.mode === GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE
    && sameCanonical(value.invocation.nodeArguments, ["--input-type=module", "-"])
    && value.invocation.nodeOptions === null, `${label}.invocation ist ungueltig.`);
  exactKeys(value.launcher, ["mode", "sourceBytes", "sourceSha256"], `${label}.launcher`);
  positiveInteger(value.launcher.sourceBytes, `${label}.launcher.sourceBytes`);
  sha256(value.launcher.sourceSha256, `${label}.launcher.sourceSha256`);
  exactKeys(value.runtime, ["bytes", "id", "platform", "sha256"], `${label}.runtime`);
  invariant(value.runtime.id === "nodejs-24-operational-runner-v1" && value.runtime.platform === "win32",
    `${label}.runtime ist unbekannt.`);
  positiveInteger(value.runtime.bytes, `${label}.runtime.bytes`);
  sha256(value.runtime.sha256, `${label}.runtime.sha256`);
  return value;
}

export function validateGermanyOperationalOuterExecutionReceipt(value, expectedReleaseId) {
  exactKeys(value, [
    "annualLaunch", "attestedPlan", "attestedPlanStartEvidence", "executionPins", "exit", "inputs",
    "invocation", "job", "nestedLaunch", "outputs", "releaseId", "runner", "schema", "trustedExecutor",
  ], "Operational-v2-Outer-Execution-Receipt");
  invariant(value.schema === GERMANY_OPERATIONAL_OUTER_EXECUTION_RECEIPT_SCHEMA,
    "Operational-v2-Outer-Execution-Receipt besitzt ein unbekanntes Schema.");
  invariant(typeof value.releaseId === "string" && value.releaseId === expectedReleaseId,
    "Operational-v2-Outer-Execution-Receipt bindet nicht das erwartete Release.");
  validateAnnualLaunch(value.annualLaunch, "Operational-v2-Outer-Execution-Receipt.annualLaunch");
  fileProof(value.attestedPlan, "Operational-v2-Outer-Execution-Receipt.attestedPlan");
  fileProof(value.attestedPlanStartEvidence, "Operational-v2-Outer-Execution-Receipt.attestedPlanStartEvidence");
  executionPinsProof(value.executionPins, "Operational-v2-Outer-Execution-Receipt.executionPins");
  exactKeys(value.exit, ["code", "signal"], "Operational-v2-Outer-Execution-Receipt.exit");
  invariant(value.exit.code === 0 && value.exit.signal === null,
    "Operational-v2-Outer-Execution-Receipt besitzt keinen erfolgreichen signal-freien Abschluss.");
  invariant(Array.isArray(value.inputs) && value.inputs.length === 6,
    "Operational-v2-Outer-Execution-Receipt benoetigt exakt sechs gehaltene Inputs.");
  value.inputs.forEach((proof, index) => fileProof(proof, `Operational-v2-Outer-Execution-Receipt.inputs[${index}]`));
  exactKeys(value.invocation, ["arguments", "command", "phase"], "Operational-v2-Outer-Execution-Receipt.invocation");
  invariant(value.invocation.command === "run-annual-operational-v2"
    && value.invocation.phase === "execute-annual-operational-v2-v1"
    && Array.isArray(value.invocation.arguments) && value.invocation.arguments.length === 5
    && value.invocation.arguments[0] === value.invocation.command,
  "Operational-v2-Outer-Execution-Receipt bindet nicht den exakten Annual-Grosslauf.");
  value.invocation.arguments.slice(1).forEach((argument, index) => portablePath(argument,
    `Operational-v2-Outer-Execution-Receipt.invocation.arguments[${index + 1}]`));
  exactKeys(value.job, ["mode", "timeoutMilliseconds"], "Operational-v2-Outer-Execution-Receipt.job");
  invariant(value.job.mode === "windows-kill-on-job-close-root-exit-bounded-io-v1"
    && value.job.timeoutMilliseconds === GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS,
  "Operational-v2-Outer-Execution-Receipt besitzt keinen exakten sechsstuendigen Prozessbaumvertrag.");
  validateRunnerShape(value.runner, "Operational-v2-Outer-Execution-Receipt.runner");
  exactKeys(value.trustedExecutor, ["buildCommit", "bytes", "file", "sha256"],
    "Operational-v2-Outer-Execution-Receipt.trustedExecutor");
  invariant(GIT_COMMIT.test(value.trustedExecutor.buildCommit),
    "Operational-v2-Outer-Execution-Receipt.trustedExecutor.buildCommit ist ungueltig.");
  fileProof({ bytes: value.trustedExecutor.bytes, file: value.trustedExecutor.file, sha256: value.trustedExecutor.sha256 },
    "Operational-v2-Outer-Execution-Receipt.trustedExecutor");
  exactKeys(value.nestedLaunch, ["anchorBytes", "anchorSha256", "capture", "signal", "status", "stdout"],
    "Operational-v2-Outer-Execution-Receipt.nestedLaunch");
  positiveInteger(value.nestedLaunch.anchorBytes, "Operational-v2-Outer-Execution-Receipt.nestedLaunch.anchorBytes");
  sha256(value.nestedLaunch.anchorSha256, "Operational-v2-Outer-Execution-Receipt.nestedLaunch.anchorSha256");
  invariant(value.nestedLaunch.status === 0 && value.nestedLaunch.signal === null,
    "Operational-v2-Outer-Execution-Receipt.nestedLaunch ist nicht erfolgreich.");
  exactKeys(value.nestedLaunch.stdout, ["bytes", "recordCount", "sha256", "structuredReceiptSha256"],
    "Operational-v2-Outer-Execution-Receipt.nestedLaunch.stdout");
  positiveInteger(value.nestedLaunch.stdout.bytes, "Operational-v2-Outer-Execution-Receipt.nestedLaunch.stdout.bytes");
  invariant(value.nestedLaunch.stdout.recordCount === 1,
    "Operational-v2-Outer-Execution-Receipt.nestedLaunch.stdout enthaelt nicht exakt einen Datensatz.");
  sha256(value.nestedLaunch.stdout.sha256, "Operational-v2-Outer-Execution-Receipt.nestedLaunch.stdout.sha256");
  sha256(value.nestedLaunch.stdout.structuredReceiptSha256,
    "Operational-v2-Outer-Execution-Receipt.nestedLaunch.stdout.structuredReceiptSha256");
  exactKeys(value.nestedLaunch.capture, [
    "activationEligible", "candidateProduced", "nativeReceipt", "status", "unresolvedRequired",
  ], "Operational-v2-Outer-Execution-Receipt.nestedLaunch.capture");
  invariant(value.nestedLaunch.capture.status === "captured"
    && value.nestedLaunch.capture.activationEligible === true
    && value.nestedLaunch.capture.candidateProduced === true
    && value.nestedLaunch.capture.unresolvedRequired === 0,
  "Operational-v2-Outer-Execution-Receipt.nestedLaunch.capture ist nicht aktivierungsfaehig.");
  fileProof(value.nestedLaunch.capture.nativeReceipt,
    "Operational-v2-Outer-Execution-Receipt.nestedLaunch.capture.nativeReceipt");
  invariant(value.nestedLaunch.stdout.structuredReceiptSha256
    === germanyOperationalStructuredValueSha256(value.nestedLaunch.capture),
  "Operational-v2-Outer-Execution-Receipt.nestedLaunch.stdout bindet einen anderen Capture-Abschluss.");
  exactKeys(value.outputs, ["candidate", "movementRouteTemplates", "nativeReceipt", "report"],
    "Operational-v2-Outer-Execution-Receipt.outputs");
  stateFileProof(value.outputs.candidate, "Operational-v2-Outer-Execution-Receipt.outputs.candidate");
  movementFileProof(value.outputs.movementRouteTemplates,
    "Operational-v2-Outer-Execution-Receipt.outputs.movementRouteTemplates");
  fileProof(value.outputs.nativeReceipt, "Operational-v2-Outer-Execution-Receipt.outputs.nativeReceipt");
  fileProof(value.outputs.report, "Operational-v2-Outer-Execution-Receipt.outputs.report");
  invariant(sameCanonical(value.nestedLaunch.capture.nativeReceipt, value.outputs.nativeReceipt),
    "Operational-v2-Outer-Execution-Receipt bindet verschachtelt ein anderes Native-Receipt.");
  return value;
}

function comparable(pathInput) {
  const value = resolve(pathInput);
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function resolvePortable(root, file, label) {
  portablePath(file, label);
  const path = resolve(root, ...file.split("/"));
  const rel = relative(root, path);
  invariant(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    `${label} verlaesst die Arbeitswurzel.`);
  return path;
}

async function readSmallCanonicalPath(root, pathInput, label) {
  const path = resolve(pathInput);
  const rootReal = await realpath(root);
  const relativePath = relative(root, path);
  invariant(relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`),
    `${label} verlaesst die Arbeitswurzel.`);
  const pathMetadata = await lstat(path, { bigint: true });
  invariant(pathMetadata.isFile() && !pathMetadata.isSymbolicLink() && pathMetadata.size > 0n
    && pathMetadata.size <= BigInt(MAX_SMALL_BYTES), `${label} ist keine begrenzte regulaere Datei.`);
  invariant(comparable(await realpath(path)) === comparable(resolve(rootReal, relativePath)),
    `${label} verwendet einen symbolischen Link oder Junction-Ahnen.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && after.dev === pathAfter.dev && after.ino === pathAfter.ino && after.size === pathAfter.size
      && BigInt(bytes.length) === after.size, `${label} driftete waehrend des gehaltenen Lesens.`);
    return { bytes, proof: { bytes: bytes.length, file: relativePath.split(sep).join("/"), sha256: createHash("sha256").update(bytes).digest("hex") } };
  } finally {
    await handle.close();
  }
}

export async function verifyGermanyOperationalOuterExecutionReceipt({
  workspaceRoot,
  outerReceiptPath,
  expectedReleaseId,
  nativeReceiptCapture,
  nativeReceiptProof,
}) {
  const root = resolve(workspaceRoot);
  const outerSource = await readSmallCanonicalPath(root, outerReceiptPath, "Operational-v2-Outer-Execution-Receipt");
  const outer = validateGermanyOperationalOuterExecutionReceipt(
    JSON.parse(outerSource.bytes.toString("utf8")),
    expectedReleaseId,
  );
  invariant(outerSource.bytes.equals(canonicalBytes(outer)),
    "Operational-v2-Outer-Execution-Receipt ist nicht kanonisch serialisiert.");
  await verifyGermanyAnnualCreateNewArtifact({
    workspaceRoot: root,
    outputPath: outerReceiptPath,
    expectedProof: outerSource.proof,
    anchorHelperProof: outer.runner.anchorHelper,
  });
  const executionPinsPath = resolvePortable(root, outer.executionPins.file,
    "Operational-v2-Outer-Execution-Receipt.executionPins");
  const executionPinsSource = await loadGermanyOperationalExecutionPins({
    workspaceRoot: root,
    executionPinsPath,
    expectedReleaseId,
  });
  invariant(sameCanonical(executionPinsSource.proof, outer.executionPins),
    "Operational-v2-Outer-Execution-Receipt bindet andere Execution-Pins-Bytes.");
  const currentRunner = await proveGermanyOperationalExecutionContext({
    workspaceRoot: root,
    executionPins: executionPinsSource.value,
    verifyCurrentInvocation: false,
  });
  invariant(sameCanonical(currentRunner, outer.runner),
    "Operational-v2-Outer-Execution-Receipt bindet nicht die aktuelle gepinnte Runner-Closure.");
  const expectedExecutor = {
    buildCommit: executionPinsSource.value.validator.buildCommit,
    bytes: executionPinsSource.value.validator.bytes,
    file: executionPinsSource.value.validator.file,
    sha256: executionPinsSource.value.validator.sha256,
  };
  invariant(sameCanonical(outer.trustedExecutor, expectedExecutor)
    && sameCanonical(outer.annualLaunch.trustedExecutor, expectedExecutor),
  "Operational-v2-Outer-Execution-Receipt bindet nicht den gepinnten Trusted Executor.");
  invariant(sameCanonical(outer.annualLaunch.executionPins, {
    ...executionPinsSource.proof,
    schema: GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
  }), "Operational-v2-Outer-Execution-Receipt.annualLaunch bindet andere Execution-Pins.");
  const contractSource = await readSmallCanonicalPath(root,
    resolvePortable(root, outer.annualLaunch.contract.file, "Operational-v2-Annual-Launch-Vertrag"),
    "Operational-v2-Annual-Launch-Vertrag");
  invariant(contractSource.proof.bytes === outer.annualLaunch.contract.bytes
    && contractSource.proof.sha256 === outer.annualLaunch.contract.sha256,
  "Operational-v2-Annual-Launch-Vertrag driftet von seinem Outer-Receipt-Beleg.");
  const plan = await verifyGermanyAnnualCreateNewArtifact({
    workspaceRoot: root,
    outputPath: resolvePortable(root, outer.attestedPlan.file, "Attestierter Annual-Plan"),
    expectedProof: outer.attestedPlan,
    anchorHelperProof: outer.runner.anchorHelper,
  });
  const start = await verifyGermanyAnnualCreateNewArtifact({
    workspaceRoot: root,
    outputPath: resolvePortable(root, outer.attestedPlanStartEvidence.file, "Attestierter Annual-Startbeleg"),
    expectedProof: outer.attestedPlanStartEvidence,
    anchorHelperProof: outer.runner.anchorHelper,
  });
  invariant(plan.proof.bytes === outer.inputs[4].bytes && plan.proof.sha256 === outer.inputs[4].sha256
    && start.proof.bytes === outer.inputs[5].bytes && start.proof.sha256 === outer.inputs[5].sha256,
  "Operational-v2-Outer-Execution-Receipt bindet Plan/Startbeleg anders als seine gehaltenen Inputs.");
  const startSource = await readSmallCanonicalPath(root, start.path, "Attestierter Annual-Startbeleg");
  const startEvidence = JSON.parse(startSource.bytes.toString("utf8"));
  exactKeys(startEvidence, [
    "annualLaunch", "directContract", "executionPins", "exit", "inputs", "invocation", "job", "plan",
    "releaseId", "runner", "schema", "trustedExecutor",
  ], "Attestierter Annual-Startbeleg");
  invariant(startEvidence.schema === "zugfolge-operational-validator-annual-executor-start-evidence/v1"
    && startEvidence.releaseId === expectedReleaseId
    && sameCanonical(startEvidence.plan, outer.attestedPlan)
    && sameCanonical(startEvidence.inputs, outer.inputs.slice(0, 3))
    && sameCanonical(startEvidence.executionPins, outer.executionPins)
    && sameCanonical(startEvidence.annualLaunch, outer.annualLaunch)
    && sameCanonical(startEvidence.directContract, outer.annualLaunch.contract)
    && sameCanonical(startEvidence.runner, outer.runner)
    && sameCanonical(startEvidence.trustedExecutor, outer.trustedExecutor)
    && sameCanonical(startEvidence.exit, { code: 0, signal: null })
    && sameCanonical(startEvidence.job, {
      mode: "windows-kill-on-job-close-root-exit-bounded-io-v1",
      timeoutMilliseconds: GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS,
    }), "Attestierter Annual-Startbeleg driftet vom Outer-Execution-Receipt.");
  const expectedPlanInvocation = {
    arguments: ["plan", ...outer.inputs.slice(0, 3).map(({ file }) => file)],
    command: "plan",
    phase: "materialize-annual-plan-evidence-v1",
  };
  invariant(sameCanonical(startEvidence.invocation, expectedPlanInvocation),
    "Attestierter Annual-Startbeleg bindet eine andere Plan-Invocation.");
  invariant(sameCanonical(outer.invocation.arguments, [
    "run-annual-operational-v2", ...outer.inputs.slice(0, 4).map(({ file }) => file),
  ]), "Operational-v2-Outer-Execution-Receipt bindet andere Rust-Argumente als seine gehaltenen Inputs.");
  for (const [index, input] of outer.inputs.entries()) {
    const inputSource = await readSmallCanonicalPath(root, resolvePortable(root, input.file,
      `Operational-v2-Outer-Execution-Receipt.inputs[${index}]`),
    `Operational-v2-Outer-Execution-Receipt.inputs[${index}]`);
    invariant(inputSource.proof.bytes === input.bytes && inputSource.proof.sha256 === input.sha256,
      `Operational-v2-Outer-Execution-Receipt.inputs[${index}] driftet.`);
  }
  invariant(isRecord(nativeReceiptCapture) && isRecord(nativeReceiptProof),
    "Operational-v2-Outer-Execution-Receipt-Verifikation benoetigt den validierten Native-Receipt-Capture.");
  validateGermanyOperationalOuterNativeAnnualLaunchBinding(outer, nativeReceiptCapture);
  invariant(sameCanonical(outer.outputs.nativeReceipt, nativeReceiptProof)
    && sameCanonical(outer.outputs.candidate, nativeReceiptCapture.sources.candidate)
    && sameCanonical(outer.outputs.movementRouteTemplates, nativeReceiptCapture.sources.movementRouteTemplates)
    && sameCanonical(outer.outputs.report, nativeReceiptCapture.sources.report),
  "Operational-v2-Outer-Execution-Receipt bindet nicht das validierte Native-Receipt-Candidate-Triplet.");
  invariant(outer.nestedLaunch.anchorBytes === outer.runner.bundle.bytes
    && outer.nestedLaunch.anchorSha256 === outer.runner.bundle.sha256,
  "Operational-v2-Outer-Execution-Receipt.nestedLaunch bindet andere Bundle-Bytes.");
  return { receipt: outer, proof: outerSource.proof, completion: true };
}
