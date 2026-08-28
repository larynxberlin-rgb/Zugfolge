import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildGermanyOperationalDirectSystemLaunchContract,
  serializeGermanyOperationalDirectSystemLaunchContract,
} from "./build-operational-infrastructure-v2-direct-system-launch-contract.mjs";
import { buildGermanyOperationalAnchoredBundleFromEntrypoint } from "./build-operational-infrastructure-v2-runner-bundle.mjs";
import {
  GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE,
  GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
  GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE,
  GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE,
  createGermanyOperationalAnchoredRunnerInvocation,
  decodeGermanyOperationalAnchoredRunnerResult,
  loadGermanyOperationalExecutionPins,
  serializeGermanyOperationalExecutionPins,
} from "./operational-infrastructure-v2-execution-pins.mjs";
import { validateGermanyOperationalOuterExecutionReceipt } from "./operational-infrastructure-v2-outer-execution-receipt.mjs";
import { runGermanyOperationalAnnualExecution } from "./run-operational-infrastructure-v2-annual-execution.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../..");
const RELEASE_ID = "infra-deutschland-2099.1";
const RELEASE_VERSION = "2099.1";
const PINS_FILE = `tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-${RELEASE_VERSION}.json`;
const CONTRACT_FILE = `tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-${RELEASE_VERSION}.json`;
const ENTRYPOINT_FILE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs";
const BUNDLE_FILE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs";
const LAUNCHER_FILE = "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1";
const HELPER_FILE = "tools/region-import/germany/operational-windows-anchor-helper.dll";
const EXECUTION_PINS_MODULE = "tools/region-import/germany/operational-infrastructure-v2-execution-pins.mjs";
const ANNUAL_ARTIFACT_MODULE = "tools/region-import/germany/annual-create-new-artifact.mjs";
const CAPTURE_ROOT = "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs";
const PUBLISH_ROOT = "tools/region-import/germany/publish-operational-infrastructure-v2.mjs";
const FIXTURE_EXECUTOR_PS = "tools/region-import/germany/fixture-annual-executor.ps1";
const EXECUTOR_FILE = `var/derived/germany-${RELEASE_VERSION}/toolchain/fixture-annual-executor.exe`;
const SHA256 = /^[a-f0-9]{64}$/u;

const FIXTURE_RUNNER_SOURCE = String.raw`import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  decodeGermanyOperationalNestedAnnualRun,
  executeGermanyOperationalPinnedAnnualExecutor,
  loadGermanyOperationalExecutionPins,
  proveGermanyOperationalAnnualLaunchFromEnvironment,
  proveGermanyOperationalExecutionContext,
} from "./operational-infrastructure-v2-execution-pins.mjs";
import {
  materializeGermanyAnnualCreateNewArtifact,
  verifyGermanyAnnualCreateNewArtifact,
} from "./annual-create-new-artifact.mjs";

const BUILD_CONTEXT = "source-noneligible-v1";
if (BUILD_CONTEXT !== "anchored-stdin-bundle-v1") throw new Error("Fixture-Runner-Quelle ist nicht direkt ausfuehrbar.");

function invariant(condition, message) { if (!condition) throw new Error(message); }
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}
function canonicalBytes(value) { return Buffer.from(JSON.stringify(canonicalValue(value), null, 2) + "\n", "utf8"); }
function sameCanonical(left, right) { return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right)); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function portable(root, pathInput) {
  const value = relative(root, resolve(pathInput));
  invariant(value !== "" && value !== ".." && !value.startsWith(".." + sep) && !isAbsolute(value), "Fixture-Pfad verlaesst die Arbeitswurzel.");
  return value.split(sep).join("/");
}
async function source(root, pathInput) {
  const bytes = await readFile(pathInput);
  return { bytes, proof: { bytes: bytes.length, file: portable(root, pathInput), sha256: sha256(bytes) } };
}
async function createOutput(root, pathInput, bytes) {
  await mkdir(dirname(pathInput), { recursive: true });
  await writeFile(pathInput, bytes, { flag: "wx" });
  return { bytes: bytes.length, file: portable(root, pathInput), sha256: sha256(bytes) };
}
function json(bytes, label) {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  invariant(bytes.equals(canonicalBytes(value)), label + " ist nicht kanonisch serialisiert.");
  return value;
}
function compactJson(bytes, label) {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  invariant(bytes.equals(Buffer.from(JSON.stringify(canonicalValue(value)), "utf8")), label + " ist nicht kompakt kanonisch serialisiert.");
  return value;
}

const root = resolve(process.env.ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT);
const phase = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_PHASE;
const count = Number(process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT);
const arguments_ = Array.from({ length: count }, (_, index) => process.env["ZUGFOLGE_OPERATIONAL_RUNNER_CLI_" + index]);
invariant(arguments_.every((value) => typeof value === "string" && value.length > 0), "Fixture-Runner besitzt unvollstaendige Argumente.");
const paths = arguments_.map((value) => resolve(value));
const executionPinsSource = await loadGermanyOperationalExecutionPins({ workspaceRoot: root, executionPinsPath: paths[0] });
const runnerProof = await proveGermanyOperationalExecutionContext({ workspaceRoot: root, executionPins: executionPinsSource.value });
const annualLaunch = await proveGermanyOperationalAnnualLaunchFromEnvironment({ workspaceRoot: root, executionPinsSource });

if (phase === "materialize-annual-plan-evidence-v1") {
  invariant(paths.length === 6, "Fixture-Planphase besitzt eine falsche Argumentzahl.");
  const execution = await executeGermanyOperationalPinnedAnnualExecutor({
    workspaceRoot: root,
    executionPinsSource,
    runnerProof,
    inputPaths: paths.slice(1, 4),
    rustArgumentPaths: paths.slice(1, 4),
  });
  invariant(execution.stderr.length === 0 && execution.stdout.toString("utf8") === "{\"fixture\":\"plan\"}\n",
    "Fixture-PE-Planphase lieferte keinen exakten Abschluss.");
  const config = json((await source(root, paths[1])).bytes, "Fixture-Config");
  const plan = {
    annualLaunch: execution.annualLaunch,
    expectedLaunchContext: config.expectedLaunchContext,
    inputs: execution.inputs,
    releaseId: executionPinsSource.value.releaseId,
    schema: "zugfolge-annual-execution-e2e-plan/v1",
  };
  const planProof = await materializeGermanyAnnualCreateNewArtifact({
    workspaceRoot: root,
    outputPath: paths[4],
    bytes: canonicalBytes(plan),
    label: "Fixture-Annual-Plan",
    anchorHelperProof: runnerProof.anchorHelper,
  });
  const start = {
    annualLaunch: execution.annualLaunch,
    expectedLaunchContext: config.expectedLaunchContext,
    plan: planProof,
    releaseId: executionPinsSource.value.releaseId,
    schema: "zugfolge-annual-execution-e2e-start/v1",
  };
  const startProof = await materializeGermanyAnnualCreateNewArtifact({
    workspaceRoot: root,
    outputPath: paths[5],
    bytes: canonicalBytes(start),
    label: "Fixture-Annual-Start",
    anchorHelperProof: runnerProof.anchorHelper,
  });
  process.stdout.write(JSON.stringify({ plan: planProof, start: startProof, status: "fixture-plan-materialized" }) + "\n");
} else if (phase === "execute-annual-operational-v2-v1") {
  invariant(paths.length === 8, "Fixture-Ausfuehrungsphase besitzt eine falsche Argumentzahl.");
  const completedPlan = await verifyGermanyAnnualCreateNewArtifact({
    workspaceRoot: root, outputPath: paths[5], anchorHelperProof: runnerProof.anchorHelper,
  });
  const completedStart = await verifyGermanyAnnualCreateNewArtifact({
    workspaceRoot: root, outputPath: paths[6], anchorHelperProof: runnerProof.anchorHelper,
  });
  const planSource = await source(root, paths[5]);
  const startSource = await source(root, paths[6]);
  const contextSource = await source(root, paths[4]);
  const plan = json(planSource.bytes, "Fixture-Plan");
  const start = json(startSource.bytes, "Fixture-Start");
  compactJson(contextSource.bytes, "Fixture-Launch-Kontext");
  invariant(sameCanonical(completedPlan.proof, planSource.proof)
    && sameCanonical(completedStart.proof, startSource.proof)
    && sameCanonical(start.plan, planSource.proof), "Fixture-Plan-/Startbindung driftet.");
  invariant(sameCanonical(plan.annualLaunch, annualLaunch)
    && sameCanonical(start.annualLaunch, annualLaunch), "Fixture-Annual-Launch-Bindung driftet.");
  invariant(sameCanonical(plan.expectedLaunchContext, contextSource.proof)
    && sameCanonical(start.expectedLaunchContext, contextSource.proof), "Fixture-Launch-Kontext driftet vom attestierten Plan/Start.");
  const execution = await executeGermanyOperationalPinnedAnnualExecutor({
    workspaceRoot: root,
    executionPinsSource,
    runnerProof,
    inputPaths: paths.slice(1, 7),
    rustArgumentPaths: paths.slice(1, 5),
  });
  invariant(execution.stderr.length === 0, "Fixture-PE-Ausfuehrung erzeugte stderr.");
  const nested = decodeGermanyOperationalNestedAnnualRun(execution.stdout, runnerProof);
  const context = compactJson(contextSource.bytes, "Fixture-Launch-Kontext");
  const nativePath = resolve(root, ...context.nativeReceiptPath.split("/"));
  const nativeSource = await source(root, nativePath);
  const nativeReceipt = json(nativeSource.bytes, "Fixture-Native-Receipt");
  invariant(sameCanonical(nativeReceipt.annualLaunch, annualLaunch)
    && sameCanonical(nested.capture.nativeReceipt, nativeSource.proof), "Fixture-Nested-Capture bindet einen anderen Annual-Launch oder Native-Receipt.");
  const outer = {
    annualLaunch: execution.annualLaunch,
    attestedPlan: planSource.proof,
    attestedPlanStartEvidence: startSource.proof,
    executionPins: execution.executionPins,
    exit: execution.exit,
    inputs: execution.inputs,
    invocation: execution.invocation,
    job: execution.job,
    nestedLaunch: { ...nested.launcher, capture: nested.capture },
    outputs: {
      candidate: nativeReceipt.sources.candidate,
      movementRouteTemplates: nativeReceipt.sources.movementRouteTemplates,
      nativeReceipt: nativeSource.proof,
      report: nativeReceipt.sources.report,
    },
    releaseId: executionPinsSource.value.releaseId,
    runner: execution.runner,
    schema: "zugfolge-operational-v2-outer-execution-receipt/v1",
    trustedExecutor: execution.trustedExecutor,
  };
  const outerProof = await materializeGermanyAnnualCreateNewArtifact({
    workspaceRoot: root,
    outputPath: paths[7],
    bytes: canonicalBytes(outer),
    label: "Fixture-Outer-Receipt",
    anchorHelperProof: runnerProof.anchorHelper,
  });
  process.stdout.write(JSON.stringify({ status: "annual-operational-v2-executed", outerReceipt: outerProof }) + "\n");
} else if (phase === "derive-and-capture-v1") {
  invariant(paths.length === 7, "Fixture-Derivephase besitzt eine falsche Argumentzahl.");
  const specification = json((await source(root, paths[1])).bytes, "Fixture-Spezifikation");
  if (specification.failNested === true) throw new Error("Fixture-Nested-Nonzero");
  const candidateBytes = canonicalBytes({ fixture: "candidate", schema: "fixture-candidate/v1" });
  const candidateBase = await createOutput(root, paths[3], candidateBytes);
  const candidate = { ...candidateBase, stateHash: sha256(candidateBytes) };
  const sidecarBytes = canonicalBytes({ fixture: "sidecar", schema: "fixture-sidecar/v1" });
  const sidecarBase = await createOutput(root, paths[4], sidecarBytes);
  const movementRouteTemplates = {
    ...sidecarBase,
    operationalStateHash: candidate.stateHash,
    stateHash: sha256(sidecarBytes),
    timetableTransferSetSha256: sha256(Buffer.from("fixture-transfer-set", "utf8")),
  };
  const reportBytes = canonicalBytes({ fixture: "report", schema: "fixture-report/v1" });
  const report = await createOutput(root, paths[5], reportBytes);
  const nativeReceipt = { annualLaunch, schema: "fixture-native-receipt/v1", sources: { candidate, movementRouteTemplates, report } };
  const nativeProof = await createOutput(root, paths[6], canonicalBytes(nativeReceipt));
  process.stdout.write(JSON.stringify({
    activationEligible: true,
    candidateProduced: true,
    nativeReceipt: nativeProof,
    status: "captured",
    unresolvedRequired: 0,
  }) + "\n");
} else {
  throw new Error("Fixture-Runner erhielt eine unbekannte Phase.");
}
`;

const FIXTURE_EXECUTOR_SOURCE = String.raw`use std::env;
use std::path::PathBuf;
use std::process::{Command, exit};

fn main() {
    let executable = env::current_exe().expect("fixture executable");
    let mut root = PathBuf::from(executable);
    for _ in 0..5 { root = root.parent().expect("fixture workspace root").to_path_buf(); }
    let script = root.join("tools").join("region-import").join("germany").join("fixture-annual-executor.ps1");
    let status = Command::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .args(env::args().skip(1))
        .status()
        .expect("fixture powershell");
    exit(status.code().unwrap_or(95));
}
`;

const FIXTURE_EXECUTOR_POWERSHELL = String.raw`$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Hex-Sha256([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
  finally { $sha.Dispose() }
}

if ($args.Count -eq 4 -and $args[0] -ceq "plan") {
  [Console]::Out.Write('{"fixture":"plan"}' + [char]10)
  exit 0
}
if ($args.Count -ne 5 -or $args[0] -cne "run-annual-operational-v2") {
  throw "Fixture-PE erhielt keinen exakten Annual-Befehl."
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
$contractFile = "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2099.1.json"
$contractPath = [IO.Path]::Combine($root, $contractFile.Replace("/", [IO.Path]::DirectorySeparatorChar))
$contractBytes = [IO.File]::ReadAllBytes($contractPath)
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$contract = $utf8.GetString($contractBytes) | ConvertFrom-Json
$contextBytes = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath($args[4]))
$environment = [ordered]@{
  SystemRoot = "C:\Windows"
  WINDIR = "C:\Windows"
  ComSpec = "C:\Windows\System32\cmd.exe"
  PATH = "C:\Windows\System32;C:\Windows"
  PATHEXT = ".COM;.EXE;.BAT;.CMD"
  PSModulePath = "C:\Windows\System32\WindowsPowerShell\v1.0\Modules"
  PSExecutionPolicyPreference = "Bypass"
  TEMP = "C:\Windows\System32"
  TMP = "C:\Windows\System32"
  ZUGFOLGE_OPERATIONAL_WORKSPACE_ROOT = $root.TrimEnd([IO.Path]::DirectorySeparatorChar)
  ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_PATH = $contractFile
  ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_BYTES = [String]$contractBytes.Length
  ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_SHA256 = Hex-Sha256 $contractBytes
  ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_SCHEMA = [String]$contract.schema
  ZUGFOLGE_OPERATIONAL_EXPECTED_RELEASE_ID = [String]$contract.releaseId
  ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_FILE = [String]$contract.executionPins.file
  ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_BYTES = [String]$contract.executionPins.bytes
  ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_SHA256 = [String]$contract.executionPins.sha256
  ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_SCHEMA = [String]$contract.executionPins.schema
  ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_FILE = [String]$contract.trustedExecutor.file
  ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_BUILD_COMMIT = [String]$contract.trustedExecutor.buildCommit
  ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_BYTES = [String]$contract.trustedExecutor.bytes
  ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_SHA256 = [String]$contract.trustedExecutor.sha256
  ZUGFOLGE_OPERATIONAL_LAUNCH_CONTEXT_BASE64 = [Convert]::ToBase64String($contextBytes)
}
foreach ($name in @([Environment]::GetEnvironmentVariables("Process").Keys)) {
  [Environment]::SetEnvironmentVariable([String]$name, $null, "Process")
}
foreach ($entry in $environment.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable([String]$entry.Key, [String]$entry.Value, "Process")
}
$outer = [IO.Path]::Combine($root, "tools\region-import\germany\operational-infrastructure-v2-direct-contract-launcher.windows.ps1")
& $outer
exit 0
`;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function compactCanonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function workspacePath(root, file) {
  return join(root, ...file.split("/"));
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function writeFixtureFile(root, file, bytes) {
  const path = workspacePath(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  return path;
}

async function copyRepositoryFile(root, file) {
  const destination = workspacePath(root, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(workspacePath(REPOSITORY_ROOT, file), destination);
  return destination;
}

async function fileProof(root, file) {
  const bytes = await readFile(workspacePath(root, file));
  return { bytes: bytes.length, file, sha256: sha256(bytes) };
}

let runtimeProofPromise;
async function runtimeProof() {
  if (runtimeProofPromise === undefined) {
    runtimeProofPromise = readFile(process.execPath).then((bytes) => ({
      bytes: bytes.length,
      id: "nodejs-24-operational-runner-v1",
      platform: "win32",
      sha256: sha256(bytes),
    }));
  }
  return runtimeProofPromise;
}

async function setupFixture({ failNested = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-annual-execution-e2e-"));
  const copied = [
    EXECUTION_PINS_MODULE,
    ANNUAL_ARTIFACT_MODULE,
    LAUNCHER_FILE,
    HELPER_FILE,
    "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.windows.ps1",
    "tools/region-import/germany/operational-infrastructure-v2-direct-contract-launcher.windows.ps1",
  ];
  for (const file of copied) await copyRepositoryFile(root, file);
  await writeFixtureFile(root, CAPTURE_ROOT, Buffer.from("export const fixtureCaptureRoot = true;\n", "utf8"));
  await writeFixtureFile(root, PUBLISH_ROOT, Buffer.from("export const fixturePublishRoot = true;\n", "utf8"));
  const entrypoint = await writeFixtureFile(root, ENTRYPOINT_FILE, Buffer.from(FIXTURE_RUNNER_SOURCE, "utf8"));
  await writeFixtureFile(root, FIXTURE_EXECUTOR_PS, Buffer.from(FIXTURE_EXECUTOR_POWERSHELL, "utf8"));
  const rustSourceFile = `var/derived/germany-${RELEASE_VERSION}/toolchain/fixture-annual-executor.rs`;
  const rustSource = await writeFixtureFile(root, rustSourceFile, Buffer.from(FIXTURE_EXECUTOR_SOURCE, "utf8"));
  const executorPath = workspacePath(root, EXECUTOR_FILE);
  const rustc = spawnSync("rustc", [rustSource, "--edition=2021", "-C", "opt-level=0", "-o", executorPath], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(rustc.error, undefined, rustc.error?.message);
  assert.equal(rustc.status, 0, rustc.stderr);
  const bundleBytes = await buildGermanyOperationalAnchoredBundleFromEntrypoint({
    entrypoint,
    expectedContextMarkers: 1,
  });
  await writeFixtureFile(root, BUNDLE_FILE, bundleBytes);
  const closureFiles = [
    ANNUAL_ARTIFACT_MODULE,
    CAPTURE_ROOT,
    EXECUTION_PINS_MODULE,
    ENTRYPOINT_FILE,
    HELPER_FILE,
    LAUNCHER_FILE,
    PUBLISH_ROOT,
  ].sort((left, right) => left.localeCompare(right, "en"));
  const importClosure = await Promise.all(closureFiles.map((file) => fileProof(root, file)));
  const roots = await Promise.all([CAPTURE_ROOT, PUBLISH_ROOT, ENTRYPOINT_FILE].map((file) => fileProof(root, file)));
  const launcher = await fileProof(root, LAUNCHER_FILE);
  const helper = await fileProof(root, HELPER_FILE);
  const executor = await fileProof(root, EXECUTOR_FILE);
  const pins = {
    command: {
      argumentFiles: [],
      argumentPrefix: [],
      arguments: ["derive-germany-operational-v2", "{specification}", "{sourceRoot}", "{candidate}", "{report}"],
      name: "derive-germany-operational-v2",
      stdoutMaxBytes: 1024 * 1024,
    },
    releaseId: RELEASE_ID,
    runner: {
      anchorHelper: helper,
      bundle: await fileProof(root, BUNDLE_FILE),
      entrypoint: await fileProof(root, ENTRYPOINT_FILE),
      importClosure,
      invocation: { mode: GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE, nodeArguments: ["--input-type=module", "-"], nodeOptions: null },
      launcher: { mode: GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE, sourceBytes: launcher.bytes, sourceSha256: launcher.sha256 },
      roots,
      runtime: await runtimeProof(),
    },
    schema: GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
    validator: {
      buildCommit: "0123456789abcdef0123456789abcdef01234567",
      bytes: executor.bytes,
      file: executor.file,
      rebuildEvidence: `var/derived/germany-${RELEASE_VERSION}/toolchain/fixture-rebuild-evidence.json`,
      rebuildSpecification: `tools/region-import/germany/fixture-rebuild.annual-${RELEASE_VERSION}.json`,
      sha256: executor.sha256,
    },
  };
  await writeFixtureFile(root, PINS_FILE, serializeGermanyOperationalExecutionPins(pins, RELEASE_ID));
  const contract = await buildGermanyOperationalDirectSystemLaunchContract({
    workspaceRoot: root,
    executionPinsFile: PINS_FILE,
  });
  const contractBytes = serializeGermanyOperationalDirectSystemLaunchContract(contract);
  await writeFixtureFile(root, CONTRACT_FILE, contractBytes);

  const files = {
    annualConfigPath: workspacePath(root, "inputs/config.json"),
    annualPlanPath: workspacePath(root, "evidence/plan.json"),
    directContractPath: workspacePath(root, CONTRACT_FILE),
    executionPinsPath: workspacePath(root, PINS_FILE),
    launchContextPath: workspacePath(root, "inputs/launch-context.json"),
    outerReceiptPath: workspacePath(root, "evidence/outer-receipt.json"),
    planStartEvidencePath: workspacePath(root, "evidence/start.json"),
    rightsRegisterPath: workspacePath(root, "inputs/rights.json"),
    sourceCatalogPath: workspacePath(root, "inputs/catalog.json"),
    specificationPath: workspacePath(root, "inputs/specification.json"),
  };
  await mkdir(workspacePath(root, "source"), { recursive: true });
  await mkdir(workspacePath(root, "outputs"), { recursive: true });
  await mkdir(dirname(files.annualPlanPath), { recursive: true });
  const context = {
    candidatePath: "outputs/candidate.json",
    candidateSidecarPath: "outputs/candidate-sidecar.json",
    executionPinsPath: PINS_FILE,
    nativeReceiptPath: "outputs/native-receipt.json",
    reportPath: "outputs/report.json",
    runtimePath: process.execPath,
    schema: "zugfolge-operational-v2-direct-system-launch-context/v1",
    sourceRoot: "source",
    specificationPath: "inputs/specification.json",
  };
  const contextBytes = compactCanonicalBytes(context);
  await mkdir(dirname(files.launchContextPath), { recursive: true });
  await writeFile(files.launchContextPath, contextBytes, { flag: "wx" });
  const contextProof = {
    bytes: contextBytes.length,
    file: portable(root, files.launchContextPath),
    sha256: sha256(contextBytes),
  };
  await writeFile(files.annualConfigPath, canonicalBytes({ expectedLaunchContext: contextProof, schema: "fixture-config/v1" }), { flag: "wx" });
  await writeFile(files.sourceCatalogPath, canonicalBytes({ schema: "fixture-catalog/v1" }), { flag: "wx" });
  await writeFile(files.rightsRegisterPath, canonicalBytes({ schema: "fixture-rights/v1" }), { flag: "wx" });
  await writeFile(files.specificationPath, canonicalBytes({ failNested, schema: "fixture-specification/v1" }), { flag: "wx" });
  return { contract, contractBytes, files, root };
}

function annualLaunchProof(fixture, executionPinsSource) {
  return {
    contract: {
      bytes: fixture.contractBytes.length,
      file: CONTRACT_FILE,
      releaseId: fixture.contract.releaseId,
      schema: fixture.contract.schema,
      sha256: sha256(fixture.contractBytes),
    },
    executionPins: executionPinsSource.proof,
    mode: GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE,
    trustedExecutor: fixture.contract.trustedExecutor,
  };
}

async function materializePlan(fixture) {
  const executionPinsSource = await loadGermanyOperationalExecutionPins({
    workspaceRoot: fixture.root,
    executionPinsPath: fixture.files.executionPinsPath,
  });
  const proof = annualLaunchProof(fixture, executionPinsSource);
  const invocation = await createGermanyOperationalAnchoredRunnerInvocation({
    annualLaunchProofBase64: Buffer.from(JSON.stringify(canonicalValue(proof)), "utf8").toString("base64"),
    arguments: [
      fixture.files.executionPinsPath,
      fixture.files.annualConfigPath,
      fixture.files.sourceCatalogPath,
      fixture.files.rightsRegisterPath,
      fixture.files.annualPlanPath,
      fixture.files.planStartEvidencePath,
    ],
    executionPinsPath: fixture.files.executionPinsPath,
    nodePath: process.execPath,
    phase: "materialize-annual-plan-evidence-v1",
    workspaceRoot: fixture.root,
  });
  const launched = spawnSync(invocation.command, invocation.arguments, {
    cwd: invocation.cwd,
    encoding: "utf8",
    env: invocation.env,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  const anchored = decodeGermanyOperationalAnchoredRunnerResult(launched, invocation.expected);
  assert.equal(anchored.signal, null);
  assert.equal(anchored.status, 0, anchored.stderr.toString("utf8"));
  assert.equal(anchored.stderr.length, 0);
  assert.match(anchored.stdout.toString("utf8"), /"status":"fixture-plan-materialized"/u);
}

function executeFixture(fixture) {
  return runGermanyOperationalAnnualExecution({
    workspaceRoot: fixture.root,
    ...fixture.files,
  });
}

test("lokale Annual-v2-CLI haelt Plan, PE, Direct-Contract, Nested-Capture sowie Outer+Completion kausal", {
  skip: process.platform !== "win32",
  timeout: 180_000,
}, async () => {
  const fixture = await setupFixture();
  try {
    await materializePlan(fixture);
    const originals = new Map();
    for (const path of [fixture.files.annualPlanPath, fixture.files.planStartEvidencePath, fixture.files.launchContextPath]) {
      originals.set(path, await readFile(path));
    }

    await writeFile(fixture.files.annualPlanPath, Buffer.from("{}\n", "utf8"));
    await assert.rejects(executeFixture(fixture), (error) => {
      assert.equal(error.code, "annual_plan_invalid");
      assert.doesNotMatch(error.message, /eval|AppData|Fixture-/u);
      return true;
    });
    await writeFile(fixture.files.annualPlanPath, originals.get(fixture.files.annualPlanPath));

    await writeFile(fixture.files.planStartEvidencePath, Buffer.from("{}\n", "utf8"));
    await assert.rejects(executeFixture(fixture), (error) => {
      assert.equal(error.code, "annual_start_evidence_invalid");
      assert.doesNotMatch(error.message, /eval|AppData|Fixture-/u);
      return true;
    });
    await writeFile(fixture.files.planStartEvidencePath, originals.get(fixture.files.planStartEvidencePath));

    await writeFile(fixture.files.launchContextPath, compactCanonicalBytes({ foreign: true }));
    await assert.rejects(executeFixture(fixture), (error) => {
      assert.equal(error.code, "launch_context_rejected");
      assert.doesNotMatch(error.message, /eval|AppData|Fixture-/u);
      return true;
    });
    await writeFile(fixture.files.launchContextPath, originals.get(fixture.files.launchContextPath));

    const result = await executeFixture(fixture);
    assert.equal(Object.hasOwn(result, "invocation"), false);
    assert.doesNotMatch(result.stdout.toString("utf8"), /cmd\.exe|powershell(?:\.exe)?/iu);
    assert.equal(result.output.status, "annual-operational-v2-executed");
    assert.equal(result.output.outerReceipt.file, portable(fixture.root, fixture.files.outerReceiptPath));
    assert.match(result.output.outerReceipt.sha256, SHA256);
    assert.equal(result.outer.receipt.nestedLaunch.capture.status, "captured");
    assert.equal(result.outer.receipt.nestedLaunch.status, 0);
    assert.equal(result.outer.receipt.annualLaunch.mode, GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE);
    const schemaDrift = structuredClone(result.outer.receipt);
    schemaDrift.executionPins.schema = "zugfolge-germany-operational-v2-execution-pins/foreign";
    assert.throws(
      () => validateGermanyOperationalOuterExecutionReceipt(schemaDrift, RELEASE_ID),
      /executionPins\.schema ist unbekannt/u,
    );
    await access(`${fixture.files.outerReceiptPath}.zugfolge-complete.json`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("lokale Annual-v2-CLI transportiert einen echten verschachtelten Nonzero-Abschluss fail-closed", {
  skip: process.platform !== "win32",
  timeout: 180_000,
}, async () => {
  const fixture = await setupFixture({ failNested: true });
  try {
    await materializePlan(fixture);
    await assert.rejects(executeFixture(fixture), (error) => {
      assert.equal(error.code, "nested_execution_rejected");
      assert.doesNotMatch(error.message, /eval|AppData|Fixture-Nested-Nonzero/u);
      return true;
    });
    await assert.rejects(access(fixture.files.outerReceiptPath));
    await assert.rejects(access(`${fixture.files.outerReceiptPath}.zugfolge-complete.json`));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
