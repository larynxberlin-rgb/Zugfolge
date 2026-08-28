#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyGermanyAnnualCreateNewArtifact } from "./annual-create-new-artifact.mjs";
import {
  serializeGermanyOperationalDirectSystemLaunchContract,
  validateGermanyOperationalDirectSystemLaunchContract,
} from "./build-operational-infrastructure-v2-direct-system-launch-contract.mjs";
import {
  GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE,
  GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE,
  createGermanyOperationalAnchoredRunnerInvocation,
  decodeGermanyOperationalAnchoredRunnerResult,
  loadGermanyOperationalExecutionPins,
  proveGermanyOperationalExecutionContext,
} from "./operational-infrastructure-v2-execution-pins.mjs";
import { validateGermanyOperationalOuterExecutionReceipt } from "./operational-infrastructure-v2-outer-execution-receipt.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_CONTRACT_BYTES = 2 * 1024 * 1024;
const MAX_OUTER_RECEIPT_BYTES = 64 * 1024 * 1024;
const MAX_LAUNCHER_ENVELOPE_BYTES = 4 * 1024 * 1024;
const MAX_RUNNER_STDOUT_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparable(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function portable(root, pathInput, label) {
  const path = resolve(pathInput);
  const value = relative(root, path);
  invariant(value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value),
    `${label} verlaesst die Arbeitswurzel.`);
  return value.split(sep).join("/");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function readHeldCanonicalFile({ root, pathInput, label, maximumBytes }) {
  const path = resolve(pathInput);
  const file = portable(root, path, label);
  const rootReal = await realpath(root);
  const pathMetadata = await lstat(path, { bigint: true });
  invariant(pathMetadata.isFile() && !pathMetadata.isSymbolicLink()
    && pathMetadata.size > 0n && pathMetadata.size <= BigInt(maximumBytes),
  `${label} ist keine begrenzte regulaere Datei.`);
  invariant(comparable(await realpath(path)) === comparable(resolve(rootReal, ...file.split("/"))),
    `${label} verwendet einen symbolischen Link oder Junction-Ahnen.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(sameIdentity(pathMetadata, before), `${label} driftete vor dem gehaltenen Lesen.`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    invariant(pathAfter.isFile() && !pathAfter.isSymbolicLink()
      && sameIdentity(before, after) && sameIdentity(after, pathAfter)
      && BigInt(bytes.length) === after.size,
    `${label} driftete waehrend des gehaltenen Lesens.`);
    return { bytes, path, proof: { bytes: bytes.length, file, sha256: sha256(bytes) } };
  } finally {
    await handle.close();
  }
}

function parseUtf8Json(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges UTF-8.`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error });
  }
}

async function loadDirectContract({ workspaceRoot, directContractPath, executionPinsSource }) {
  const source = await readHeldCanonicalFile({
    root: workspaceRoot,
    pathInput: directContractPath,
    label: "Direkter Annual-Systemstartvertrag",
    maximumBytes: MAX_CONTRACT_BYTES,
  });
  const value = validateGermanyOperationalDirectSystemLaunchContract(
    parseUtf8Json(source.bytes, "Direkter Annual-Systemstartvertrag"),
  );
  invariant(source.bytes.equals(serializeGermanyOperationalDirectSystemLaunchContract(value)),
    "Direkter Annual-Systemstartvertrag ist nicht kanonisch serialisiert.");
  invariant(value.releaseId === executionPinsSource.value.releaseId && value.platform === "win32",
    "Direkter Annual-Systemstartvertrag bindet eine falsche Release- oder Plattformidentitaet.");
  invariant(sameCanonical(value.executionPins, executionPinsSource.proof),
    "Direkter Annual-Systemstartvertrag bindet andere Execution-Pins.");
  const expectedExecutor = {
    buildCommit: executionPinsSource.value.validator.buildCommit,
    bytes: executionPinsSource.value.validator.bytes,
    file: executionPinsSource.value.validator.file,
    sha256: executionPinsSource.value.validator.sha256,
  };
  invariant(sameCanonical(value.trustedExecutor, expectedExecutor),
    "Direkter Annual-Systemstartvertrag bindet einen anderen Trusted Executor.");
  invariant(value.launcher.file === GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE
    && value.launcher.mode === executionPinsSource.value.runner.launcher.mode
    && value.launcher.sourceBytes === executionPinsSource.value.runner.launcher.sourceBytes
    && value.launcher.sourceSha256 === executionPinsSource.value.runner.launcher.sourceSha256,
  "Direkter Annual-Systemstartvertrag bindet einen anderen gehaltenen Systemlauncher.");
  return {
    value,
    proof: {
      ...source.proof,
      releaseId: value.releaseId,
      schema: value.schema,
    },
  };
}

function parseSingleSuccessfulOutput(stdout, expectedOuterFile) {
  invariant(Buffer.isBuffer(stdout) && stdout.length > 0 && stdout.length <= MAX_RUNNER_STDOUT_BYTES,
    "Gehaltene Annual-Ausfuehrung lieferte kein begrenztes stdout-Ergebnis.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch (error) {
    throw new Error("Gehaltene Annual-Ausfuehrung lieferte kein gueltiges UTF-8 auf stdout.", { cause: error });
  }
  invariant(text.endsWith("\n") && !text.endsWith("\r\n"),
    "Gehaltene Annual-Ausfuehrung muss exakt einen LF-terminierten JSON-Datensatz liefern.");
  const body = text.slice(0, -1);
  invariant(body.length > 0 && body.trim() === body && !/[\r\n]/u.test(body),
    "Gehaltene Annual-Ausfuehrung muss exakt einen kompakten JSON-Datensatz liefern.");
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error("Gehaltene Annual-Ausfuehrung lieferte keinen einzelnen JSON-Datensatz.", { cause: error });
  }
  invariant(JSON.stringify(value) === body,
    "Gehaltene Annual-Ausfuehrung lieferte keinen kanonisch kompakten JSON-Datensatz.");
  exactKeys(value, ["outerReceipt", "status"], "Annual-v2-Ausfuehrungsergebnis");
  invariant(value.status === "annual-operational-v2-executed",
    "Gehaltene Annual-Ausfuehrung meldete keinen erfolgreichen Abschluss.");
  exactKeys(value.outerReceipt, ["bytes", "file", "sha256"], "Annual-v2-Outer-Receipt-Beleg");
  invariant(Number.isSafeInteger(value.outerReceipt.bytes) && value.outerReceipt.bytes > 0
    && value.outerReceipt.file === expectedOuterFile
    && SHA256.test(value.outerReceipt.sha256),
  "Gehaltene Annual-Ausfuehrung bindet keinen exakten Outer-Receipt-Beleg.");
  return value;
}

function failClosedError(code, details) {
  const error = new Error(`Operational-v2-Jahresausfuehrung wurde fail-closed abgewiesen (${code}; ${details}).`);
  error.code = code;
  return error;
}

function byteReceipt(bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
  return { bytes: value.length, sha256: sha256(value) };
}

function classifyRunnerFailure(stderr) {
  let text = "";
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(stderr); }
  catch { return "runner_stderr_invalid_utf8"; }
  if (/Nested|verschachtelt/iu.test(text)) return "nested_execution_rejected";
  if (/Launch-Kontext|launch.?context|Kontext/iu.test(text)) return "launch_context_rejected";
  if (/Start/iu.test(text)) return "annual_start_evidence_rejected";
  if (/Plan/iu.test(text)) return "annual_plan_rejected";
  return "runner_phase_failed";
}

async function verifyAttestedInput({ workspaceRoot, path, label, code, anchorHelperProof }) {
  try {
    return await verifyGermanyAnnualCreateNewArtifact({
      workspaceRoot,
      outputPath: path,
      anchorHelperProof,
    });
  } catch {
    throw failClosedError(code, `${label}=invalid`);
  }
}

async function verifyOuterReceipt({
  workspaceRoot,
  outerReceiptPath,
  expectedProof,
  executionPinsSource,
  annualLaunchProof,
  runnerProof,
}) {
  const verified = await verifyGermanyAnnualCreateNewArtifact({
    workspaceRoot,
    outputPath: outerReceiptPath,
    expectedProof,
    anchorHelperProof: runnerProof.anchorHelper,
  });
  invariant(sameCanonical(verified.proof, expectedProof),
    "Annual-v2-Outer-Receipt und Completion-Beleg binden andere Bytes als stdout.");
  const source = await readHeldCanonicalFile({
    root: workspaceRoot,
    pathInput: outerReceiptPath,
    label: "Annual-v2-Outer-Execution-Receipt",
    maximumBytes: MAX_OUTER_RECEIPT_BYTES,
  });
  invariant(sameCanonical(source.proof, expectedProof),
    "Annual-v2-Outer-Execution-Receipt driftete nach der Paarpruefung.");
  const receipt = validateGermanyOperationalOuterExecutionReceipt(
    parseUtf8Json(source.bytes, "Annual-v2-Outer-Execution-Receipt"),
    executionPinsSource.value.releaseId,
  );
  invariant(source.bytes.equals(canonicalBytes(receipt)),
    "Annual-v2-Outer-Execution-Receipt ist nicht kanonisch serialisiert.");
  invariant(sameCanonical(receipt.annualLaunch, annualLaunchProof),
    "Annual-v2-Outer-Execution-Receipt bindet einen anderen Annual-Launch-Beleg.");
  invariant(sameCanonical(receipt.executionPins, executionPinsSource.proof),
    "Annual-v2-Outer-Execution-Receipt bindet andere Execution-Pins.");
  invariant(sameCanonical(receipt.runner, runnerProof),
    "Annual-v2-Outer-Execution-Receipt bindet eine andere gepinnte Runner-Closure.");
  return { receipt, proof: source.proof, completion: verified.completion };
}

export async function runGermanyOperationalAnnualExecution({
  workspaceRoot = REPOSITORY_ROOT,
  executionPinsPath,
  directContractPath,
  annualConfigPath,
  sourceCatalogPath,
  rightsRegisterPath,
  launchContextPath,
  annualPlanPath,
  planStartEvidencePath,
  outerReceiptPath,
  spawn = spawnSync,
} = {}) {
  invariant(process.platform === "win32",
    "Releasefaehige lokale Operational-v2-Jahresausfuehrung ist ausschliesslich auf Windows definiert.");
  invariant(typeof spawn === "function", "Operational-v2-Jahresausfuehrung besitzt keinen Prozessstarter.");
  const root = resolve(workspaceRoot);
  const inputs = [
    executionPinsPath,
    directContractPath,
    annualConfigPath,
    sourceCatalogPath,
    rightsRegisterPath,
    launchContextPath,
    annualPlanPath,
    planStartEvidencePath,
    outerReceiptPath,
  ];
  invariant(inputs.every((value) => typeof value === "string" && value.length > 0 && !value.includes("\0")),
    "Operational-v2-Jahresausfuehrung besitzt keine vollstaendige neunstellige Dateibindung.");
  const resolved = inputs.map((value) => resolve(value));
  const [executionPinsResolved, directContractResolved, ...runnerArguments] = resolved;
  const expectedOuterFile = portable(root, resolved.at(-1), "Annual-v2-Outer-Execution-Receipt-Ausgabe");
  const outputParent = dirname(resolved.at(-1));
  const outputParentReal = await realpath(outputParent);
  const rootReal = await realpath(root);
  invariant(comparable(outputParentReal) === comparable(resolve(rootReal, relative(root, outputParent))),
    "Annual-v2-Outer-Execution-Receipt-Ausgabe verwendet einen symbolischen Link oder Junction-Ahnen.");
  const executionPinsSource = await loadGermanyOperationalExecutionPins({
    workspaceRoot: root,
    executionPinsPath: executionPinsResolved,
  });
  const directContract = await loadDirectContract({
    workspaceRoot: root,
    directContractPath: directContractResolved,
    executionPinsSource,
  });
  const annualLaunchProof = {
    contract: directContract.proof,
    executionPins: executionPinsSource.proof,
    mode: GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE,
    trustedExecutor: directContract.value.trustedExecutor,
  };
  const annualLaunchProofBase64 = Buffer.from(JSON.stringify(canonicalValue(annualLaunchProof)), "utf8").toString("base64");
  const invocation = await createGermanyOperationalAnchoredRunnerInvocation({
    annualLaunchProofBase64,
    arguments: [executionPinsResolved, ...runnerArguments],
    executionPinsPath: executionPinsResolved,
    nodePath: process.execPath,
    phase: "execute-annual-operational-v2-v1",
    workspaceRoot: root,
  });
  const completedPlan = await verifyAttestedInput({
    workspaceRoot: root,
    path: resolved.at(-3),
    label: "plan",
    code: "annual_plan_invalid",
    anchorHelperProof: invocation.runnerProof.anchorHelper,
  });
  const completedStart = await verifyAttestedInput({
    workspaceRoot: root,
    path: resolved.at(-2),
    label: "startEvidence",
    code: "annual_start_evidence_invalid",
    anchorHelperProof: invocation.runnerProof.anchorHelper,
  });
  const launched = spawn(invocation.command, invocation.arguments, {
    cwd: invocation.cwd,
    encoding: "buffer",
    env: invocation.env,
    maxBuffer: MAX_LAUNCHER_ENVELOPE_BYTES,
    shell: false,
    windowsHide: true,
  });
  let anchored;
  try {
    anchored = decodeGermanyOperationalAnchoredRunnerResult(launched, invocation.expected);
  } catch {
    const stdoutProof = byteReceipt(launched.stdout);
    const stderrProof = byteReceipt(launched.stderr);
    throw failClosedError("launcher_transport_rejected",
      `exit=${launched.status ?? "none"},signal=${launched.signal ?? "none"},stdoutBytes=${stdoutProof.bytes},stdoutSha256=${stdoutProof.sha256},stderrBytes=${stderrProof.bytes},stderrSha256=${stderrProof.sha256}`);
  }
  if (anchored.signal !== null || anchored.status !== 0) {
    const stderrProof = byteReceipt(anchored.stderr);
    throw failClosedError(classifyRunnerFailure(anchored.stderr),
      `exit=${anchored.status ?? "none"},signal=${anchored.signal ?? "none"},stderrBytes=${stderrProof.bytes},stderrSha256=${stderrProof.sha256}`);
  }
  if (anchored.stderr.length !== 0) {
    const stderrProof = byteReceipt(anchored.stderr);
    throw failClosedError("runner_unexpected_stderr",
      `exit=0,signal=none,stderrBytes=${stderrProof.bytes},stderrSha256=${stderrProof.sha256}`);
  }
  const output = parseSingleSuccessfulOutput(anchored.stdout, expectedOuterFile);
  const outer = await verifyOuterReceipt({
    workspaceRoot: root,
    outerReceiptPath: resolved.at(-1),
    expectedProof: output.outerReceipt,
    executionPinsSource,
    annualLaunchProof,
    runnerProof: invocation.runnerProof,
  });
  invariant(sameCanonical(outer.receipt.attestedPlan, completedPlan.proof)
    && sameCanonical(outer.receipt.attestedPlanStartEvidence, completedStart.proof),
  "Annual-v2-Outer-Execution-Receipt bindet andere attestierte Plan-/Startbytes als der lokale Start.");
  const currentInputs = [];
  for (const [index, path] of resolved.slice(2, 8).entries()) {
    const input = await readHeldCanonicalFile({
      root,
      pathInput: path,
      label: `Annual-v2-gehaltener Abschlussinput[${index}]`,
      maximumBytes: 16 * 1024 * 1024,
    });
    currentInputs.push(input.proof);
    invariant(sameCanonical(input.proof, outer.receipt.inputs[index]),
      `Annual-v2-Abschlussinput[${index}] driftete vom Outer-Execution-Receipt.`);
  }
  invariant(sameCanonical(currentInputs[4], outer.receipt.attestedPlan)
    && sameCanonical(currentInputs[5], outer.receipt.attestedPlanStartEvidence),
  "Annual-v2-Outer-Execution-Receipt bindet Plan/Start anders als seine gehaltenen Inputs.");
  await verifyAttestedInput({
    workspaceRoot: root,
    path: resolved.at(-3),
    label: "planAfterExecution",
    code: "annual_plan_postcheck_invalid",
    anchorHelperProof: invocation.runnerProof.anchorHelper,
  });
  await verifyAttestedInput({
    workspaceRoot: root,
    path: resolved.at(-2),
    label: "startEvidenceAfterExecution",
    code: "annual_start_evidence_postcheck_invalid",
    anchorHelperProof: invocation.runnerProof.anchorHelper,
  });
  const executionPinsAfter = await loadGermanyOperationalExecutionPins({
    workspaceRoot: root,
    executionPinsPath: executionPinsResolved,
    expectedReleaseId: executionPinsSource.value.releaseId,
  });
  invariant(sameCanonical(executionPinsAfter.proof, executionPinsSource.proof),
    "Operational-v2-Execution-Pins drifteten waehrend der lokalen Jahresausfuehrung.");
  const directContractAfter = await loadDirectContract({
    workspaceRoot: root,
    directContractPath: directContractResolved,
    executionPinsSource: executionPinsAfter,
  });
  invariant(sameCanonical(directContractAfter.proof, directContract.proof),
    "Direkter Annual-Systemstartvertrag driftete waehrend der lokalen Jahresausfuehrung.");
  const runnerAfter = await proveGermanyOperationalExecutionContext({
    workspaceRoot: root,
    executionPins: executionPinsAfter.value,
    verifyCurrentInvocation: false,
  });
  invariant(sameCanonical(runnerAfter, invocation.runnerProof),
    "Gepinnte Operational-v2-Runner-Closure driftete nach der lokalen Jahresausfuehrung.");
  return { annualLaunchProof, outer, output, stdout: anchored.stdout };
}

function usage() {
  return [
    "Aufruf:",
    "  run-operational-infrastructure-v2-annual-execution.mjs execute EXECUTION-PINS DIRECT-CONTRACT CONFIG CATALOG RIGHTS LAUNCH-CONTEXT PLAN START-EVIDENCE OUTER-RECEIPT",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...arguments_] = process.argv.slice(2);
  invariant(command === "execute" && arguments_.length === 9, usage());
  const result = await runGermanyOperationalAnnualExecution({
    executionPinsPath: arguments_[0],
    directContractPath: arguments_[1],
    annualConfigPath: arguments_[2],
    sourceCatalogPath: arguments_[3],
    rightsRegisterPath: arguments_[4],
    launchContextPath: arguments_[5],
    annualPlanPath: arguments_[6],
    planStartEvidencePath: arguments_[7],
    outerReceiptPath: arguments_[8],
  });
  process.stdout.write(result.stdout);
}
