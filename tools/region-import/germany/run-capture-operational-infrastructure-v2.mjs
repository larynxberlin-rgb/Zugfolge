#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  materializeGermanyAnnualCreateNewArtifact,
  verifyGermanyAnnualCreateNewArtifact,
} from "./annual-create-new-artifact.mjs";

import {
  runAndCaptureGermanyOperationalInfrastructureV2,
  serializeGermanyOperationalPublicationJson,
  validateGermanyOperationalInfrastructureV2NativeReceiptCapture,
} from "./operational-infrastructure-v2-publication.mjs";
import {
  GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS,
  GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS,
  GERMANY_OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT,
  GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND,
  decodeGermanyOperationalNestedAnnualRun,
  executeGermanyOperationalPinnedAnnualExecutor,
  loadGermanyOperationalExecutionPins,
  proveGermanyOperationalAnnualLaunchFromEnvironment,
  proveGermanyOperationalExecutionContext,
  withGermanyOperationalHeldOutputFiles,
} from "./operational-infrastructure-v2-execution-pins.mjs";
import {
  materializeOperationalValidatorRebuildEvidence,
  validateOperationalValidatorRebuildSpec,
} from "./operational-validator-rebuild-evidence.mjs";

const OPERATIONAL_RUNNER_BUILD_CONTEXT = "source-noneligible-v1";

if (OPERATIONAL_RUNNER_BUILD_CONTEXT !== "anchored-stdin-bundle-v1") {
  throw new Error(
    "Der direkte .mjs-Aufruf ist nur Quellcode und darf keine releasefaehigen Operational-v2-Artefakte erzeugen. "
      + "Verwende die dokumentierte, direkt vom Systemlauncher gehaltene Bundle-Invocation.",
  );
}

const workspaceRoot = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT;
if (!workspaceRoot) throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine Arbeitswurzelbindung.");
const root = resolve(workspaceRoot);
const phase = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_PHASE ?? "derive-and-capture-v1";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portable(pathInput, label) {
  const value = relative(root, resolve(pathInput));
  if (value === "" || value === ".." || value.startsWith(`..${sep}`)) throw new Error(`${label} verlaesst die gehaltene Arbeitswurzel.`);
  return value.split(sep).join("/");
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} besitzt fremde oder fehlende Felder.`);
  }
  return value;
}

function sameCanonical(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function comparablePath(pathInput) {
  const value = resolve(pathInput);
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function parseJsonBytes(bytes, label) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new Error(`${label} ist kein gueltiges UTF-8.`, { cause: error }); }
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error }); }
}

function byteProof(bytes, pathInput, label) {
  return { bytes: bytes.length, file: portable(pathInput, label), sha256: sha256(bytes) };
}

function assertProof(actual, expected, label) {
  if (!sameCanonical(actual, expected)) throw new Error(`${label} driftet von seinem gehaltenen Bytebeleg.`);
}

async function writeCreateNew(pathInput, bytes, label, runnerProof) {
  return materializeGermanyAnnualCreateNewArtifact({
    workspaceRoot: root,
    outputPath: pathInput,
    bytes,
    label,
    anchorHelperProof: runnerProof.anchorHelper,
  });
}

if (phase === "materialize-annual-plan-evidence-v1") {
  const runnerArguments = Array.from({ length: 6 }, (_, index) => process.env[`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_${index}`]);
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT !== "6" || runnerArguments.some((value) => !value)) {
    throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine vollstaendige sechsstellige Annual-Plan-Bindung.");
  }
  const [executionPinsPath, annualConfigPath, sourceCatalogPath, rightsRegisterPath, annualPlanOutputPath, startEvidenceOutputPath] = runnerArguments.map((value) => resolve(value));
  const executionPinsSource = await loadGermanyOperationalExecutionPins({ workspaceRoot: root, executionPinsPath });
  const runnerProof = await proveGermanyOperationalExecutionContext({ workspaceRoot: root, executionPins: executionPinsSource.value });
  const execution = await executeGermanyOperationalPinnedAnnualExecutor({
    workspaceRoot: root,
    executionPinsSource,
    runnerProof,
    runnerPhase: phase,
    inputPaths: [annualConfigPath, sourceCatalogPath, rightsRegisterPath],
    rustArgumentPaths: [annualConfigPath, sourceCatalogPath, rightsRegisterPath],
  });
  if (execution.stderr.length !== 0) throw new Error("Gehaltene Annual-Plan-Phase erzeugte unerwartete stderr-Bytes.");
  let plan;
  try { plan = JSON.parse(execution.stdout.toString("utf8")); }
  catch (error) { throw new Error("Gehaltene Annual-Plan-Phase lieferte keinen einzelnen JSON-Plan.", { cause: error }); }
  if (plan?.schema !== "zugfolge-annual-infra-plan/v1" || !Array.isArray(plan.stages)) {
    throw new Error("Gehaltene Annual-Plan-Phase lieferte keinen Annual-Plan-v1.");
  }
  const operationalStage = plan.stages.find((stage) => stage?.id === "operational-v2-derivation");
  const trustedExecutor = operationalStage?.directSystemLaunch?.trustedExecutor;
  if (operationalStage?.executionMode !== "held-contract-direct-system-launch-v1"
      || trustedExecutor?.file !== execution.trustedExecutor.file
      || trustedExecutor?.buildCommit !== execution.trustedExecutor.buildCommit
      || trustedExecutor?.bytes !== execution.trustedExecutor.bytes
      || trustedExecutor?.sha256 !== execution.trustedExecutor.sha256) {
    throw new Error("Gehaltene Annual-Plan-Phase bindet nicht denselben Direct-Contract und Trusted Executor.");
  }
  const planProof = await writeCreateNew(annualPlanOutputPath, canonicalBytes(plan), "Annual-Plan-Output", runnerProof);
  const startEvidence = {
    annualLaunch: execution.annualLaunch,
    directContract: execution.annualLaunch.contract,
    executionPins: execution.executionPins,
    exit: execution.exit,
    inputs: execution.inputs,
    invocation: execution.invocation,
    job: execution.job,
    plan: planProof,
    releaseId: executionPinsSource.value.releaseId,
    runner: execution.runner,
    schema: "zugfolge-operational-validator-annual-executor-start-evidence/v1",
    trustedExecutor: execution.trustedExecutor,
  };
  if (startEvidence.job.timeoutMilliseconds !== GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS) {
    throw new Error("Annual-Executor-Startbeleg bindet keinen exakten zweiminuetigen Plan-Supervisor.");
  }
  const startEvidenceProof = await writeCreateNew(startEvidenceOutputPath, canonicalBytes(startEvidence), "Annual-Executor-Start-Evidence", runnerProof);
  process.stdout.write(`${JSON.stringify({
    status: "annual-plan-materialized",
    plan: planProof,
    startEvidence: startEvidenceProof,
  })}\n`);
} else if (phase === "execute-annual-operational-v2-v1") {
  const runnerArguments = Array.from({ length: 8 }, (_, index) => process.env[`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_${index}`]);
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT !== "8" || runnerArguments.some((value) => !value)) {
    throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine vollstaendige achtstellige Annual-Ausfuehrungsbindung.");
  }
  const [executionPinsPath, annualConfigPath, sourceCatalogPath, rightsRegisterPath, launchContextPath, annualPlanPath, planStartEvidencePath, outerReceiptOutputPath] = runnerArguments.map((value) => resolve(value));
  const executionPinsSource = await loadGermanyOperationalExecutionPins({ workspaceRoot: root, executionPinsPath });
  const runnerProof = await proveGermanyOperationalExecutionContext({ workspaceRoot: root, executionPins: executionPinsSource.value });
  const [completedPlan, completedStartEvidence] = await Promise.all([
    verifyGermanyAnnualCreateNewArtifact({ workspaceRoot: root, outputPath: annualPlanPath, anchorHelperProof: runnerProof.anchorHelper }),
    verifyGermanyAnnualCreateNewArtifact({ workspaceRoot: root, outputPath: planStartEvidencePath, anchorHelperProof: runnerProof.anchorHelper }),
  ]);
  const [contextBytes, planBytes, planStartEvidenceBytes] = await Promise.all([
    readFile(launchContextPath),
    readFile(annualPlanPath),
    readFile(planStartEvidencePath),
  ]);
  const launchContext = parseJsonBytes(contextBytes, "Annual-Launch-Kontext");
  const annualPlan = parseJsonBytes(planBytes, "Attestierter Annual-Plan");
  const planStartEvidence = parseJsonBytes(planStartEvidenceBytes, "Attestierter Annual-Executor-Startbeleg");
  if (annualPlan?.schema !== "zugfolge-annual-infra-plan/v1"
      || planStartEvidence?.schema !== "zugfolge-operational-validator-annual-executor-start-evidence/v1") {
    throw new Error("Annual-Ausfuehrung besitzt keinen attestierbaren Plan-/Startbeleg-v1.");
  }
  if (!planBytes.equals(canonicalBytes(annualPlan)) || !planStartEvidenceBytes.equals(canonicalBytes(planStartEvidence))) {
    throw new Error("Annual-Plan oder Startbeleg ist nicht kanonisch serialisiert.");
  }
  exactKeys(launchContext, [
    "candidatePath", "candidateSidecarPath", "executionPinsPath", "nativeReceiptPath", "reportPath",
    "runtimePath", "schema", "sourceRoot", "specificationPath",
  ], "Annual-Launch-Kontext");
  if (launchContext.schema !== "zugfolge-operational-v2-direct-system-launch-context/v1") {
    throw new Error("Annual-Launch-Kontext besitzt ein unbekanntes Schema.");
  }
  for (const [name, value] of Object.entries(launchContext)) {
    if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f]/u.test(value)) {
      throw new Error(`Annual-Launch-Kontext.${name} ist kein sicherer Textwert.`);
    }
  }
  function launchPath(name) {
    const value = launchContext[name];
    if (name === "sourceRoot" && value === ".") return root;
    if (isAbsolute(value) || value.includes("\\") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`Annual-Launch-Kontext.${name} ist kein sicherer portabler Pfad.`);
    }
    const path = resolve(root, ...value.split("/"));
    if (portable(path, `Annual-Launch-Kontext.${name}`) !== value) {
      throw new Error(`Annual-Launch-Kontext.${name} ist nicht kanonisch.`);
    }
    return path;
  }
  const operationalStage = annualPlan.stages.find((stage) => stage?.id === "operational-v2-derivation");
  const operationalBindings = exactKeys(operationalStage?.operationalBindings, [
    "candidatePath", "candidateSidecarPath", "executionPinsPath", "nativeReceiptPath",
    "outerExecutionReceiptPath", "publicationReceiptPath", "publishedOutputPath", "reportPath",
    "schema", "sourceRoot", "specificationPath",
  ], "Attestierter Annual-Plan.operationalBindings");
  if (operationalBindings.schema !== "zugfolge-operational-v2-annual-plan-bindings/v1") {
    throw new Error("Attestierter Annual-Plan besitzt kein bekanntes Operational-v2-I/O-Bindungsschema.");
  }
  const expectedOperationalBindings = {
    candidatePath: launchContext.candidatePath,
    candidateSidecarPath: launchContext.candidateSidecarPath,
    executionPinsPath: launchContext.executionPinsPath,
    nativeReceiptPath: launchContext.nativeReceiptPath,
    outerExecutionReceiptPath: portable(outerReceiptOutputPath, "Annual-Outer-Execution-Receipt"),
    publicationReceiptPath: operationalBindings.publicationReceiptPath,
    publishedOutputPath: operationalBindings.publishedOutputPath,
    reportPath: launchContext.reportPath,
    schema: "zugfolge-operational-v2-annual-plan-bindings/v1",
    sourceRoot: launchContext.sourceRoot,
    specificationPath: launchContext.specificationPath,
  };
  if (!sameCanonical(operationalBindings, expectedOperationalBindings)) {
    throw new Error("Annual-Launch-Kontext und Outer-Receipt-Ziel driften von den Operational-v2-I/O-Bindungen des attestierten Plans.");
  }
  for (const name of ["publishedOutputPath", "publicationReceiptPath"]) {
    const value = operationalBindings[name];
    if (typeof value !== "string" || isAbsolute(value) || value.includes("\\")
        || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`Attestierter Annual-Plan.operationalBindings.${name} ist kein sicherer portabler Pfad.`);
    }
  }
  const expectedPlanProof = byteProof(planBytes, annualPlanPath, "Attestierter Annual-Plan");
  const expectedStartEvidenceProof = byteProof(planStartEvidenceBytes, planStartEvidencePath, "Attestierter Plan-Startbeleg");
  assertProof(completedPlan.proof, expectedPlanProof, "Abgeschlossener attestierter Annual-Plan");
  assertProof(completedStartEvidence.proof, expectedStartEvidenceProof, "Abgeschlossener attestierter Plan-Startbeleg");
  const execution = await executeGermanyOperationalPinnedAnnualExecutor({
    workspaceRoot: root,
    executionPinsSource,
    runnerProof,
    runnerPhase: phase,
    inputPaths: [annualConfigPath, sourceCatalogPath, rightsRegisterPath, launchContextPath, annualPlanPath, planStartEvidencePath],
    rustArgumentPaths: [annualConfigPath, sourceCatalogPath, rightsRegisterPath, launchContextPath],
  });
  if (execution.stderr.length !== 0) throw new Error("Gehaltene Annual-Ausfuehrung erzeugte unerwartete stderr-Bytes.");
  const heldContextProof = byteProof(contextBytes, launchContextPath, "Annual-Launch-Kontext");
  assertProof(execution.inputs[3], heldContextProof, "Annual-Launch-Kontext");
  assertProof(execution.inputs[4], expectedPlanProof, "Attestierter Annual-Plan");
  assertProof(execution.inputs[5], expectedStartEvidenceProof, "Attestierter Plan-Startbeleg");
  exactKeys(planStartEvidence, [
    "annualLaunch", "directContract", "executionPins", "exit", "inputs", "invocation", "job", "plan",
    "releaseId", "runner", "schema", "trustedExecutor",
  ], "Attestierter Annual-Executor-Startbeleg");
  exactKeys(planStartEvidence.exit, ["code", "signal"], "Attestierter Annual-Executor-Startbeleg.exit");
  exactKeys(planStartEvidence.job, ["mode", "timeoutMilliseconds"], "Attestierter Annual-Executor-Startbeleg.job");
  exactKeys(planStartEvidence.invocation, ["arguments", "command", "phase"], "Attestierter Annual-Executor-Startbeleg.invocation");
  const expectedPlanInvocation = {
    arguments: ["plan", ...[annualConfigPath, sourceCatalogPath, rightsRegisterPath].map((path) => portable(path, "Annual-Plan-Argument"))],
    command: "plan",
    phase: "materialize-annual-plan-evidence-v1",
  };
  if (planStartEvidence.releaseId !== executionPinsSource.value.releaseId
      || planStartEvidence.exit.code !== 0 || planStartEvidence.exit.signal !== null
      || planStartEvidence.job.mode !== "windows-kill-on-job-close-root-exit-bounded-io-v1"
      || planStartEvidence.job.timeoutMilliseconds !== GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS
      || !sameCanonical(planStartEvidence.plan, expectedPlanProof)
      || !sameCanonical(planStartEvidence.executionPins, execution.executionPins)
      || !sameCanonical(planStartEvidence.annualLaunch, execution.annualLaunch)
      || !sameCanonical(planStartEvidence.directContract, execution.annualLaunch.contract)
      || !sameCanonical(planStartEvidence.trustedExecutor, execution.trustedExecutor)
      || !sameCanonical(planStartEvidence.runner, execution.runner)
      || !sameCanonical(planStartEvidence.inputs, execution.inputs.slice(0, 3))
      || !sameCanonical(planStartEvidence.invocation, expectedPlanInvocation)) {
    throw new Error("Annual-Ausfuehrung driftet vom exakten attestierten Plan-/Executor-Startbeleg.");
  }
  if (!sameCanonical(execution.job, {
    mode: "windows-kill-on-job-close-root-exit-bounded-io-v1",
    timeoutMilliseconds: GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS,
  })) {
    throw new Error("Annual-Ausfuehrung besitzt keinen exakten sechsstuendigen Grosslauf-Supervisor.");
  }
  if (comparablePath(launchPath("executionPinsPath")) !== comparablePath(executionPinsPath)) {
    throw new Error("Annual-Launch-Kontext bindet andere Execution-Pins.");
  }
  if (comparablePath(launchPath("specificationPath")) !== comparablePath(resolve(root, ...operationalBindings.specificationPath.split("/")))
      || comparablePath(launchPath("sourceRoot")) !== comparablePath(root)) {
    throw new Error("Annual-Launch-Kontext bindet nicht die geplante Spezifikation und kanonische Arbeitswurzel.");
  }
  const runtimePath = await realpath(launchContext.runtimePath);
  if (comparablePath(runtimePath) !== comparablePath(await realpath(process.execPath))) {
    throw new Error("Annual-Launch-Kontext bindet nicht die gehaltene Node-Runtime.");
  }
  const candidatePath = launchPath("candidatePath");
  const candidateSidecarPath = launchPath("candidateSidecarPath");
  const reportPath = launchPath("reportPath");
  const nativeReceiptPath = launchPath("nativeReceiptPath");
  const nested = decodeGermanyOperationalNestedAnnualRun(execution.stdout, execution.runner);
  if (nested.capture.nativeReceipt.file !== portable(nativeReceiptPath, "Annual-Native-Receipt")) {
    throw new Error("Kausaler Annual-Capture-Abschluss bindet einen anderen Native-Receipt-Pfad.");
  }
  const nativeReceiptProof = {
    bytes: nested.capture.nativeReceipt.bytes,
    file: nested.capture.nativeReceipt.file,
    sha256: nested.capture.nativeReceipt.sha256,
  };
  const nativeReceipt = await withGermanyOperationalHeldOutputFiles({
    workspaceRoot: root,
    files: [{
      captureBytes: true,
      label: "nativeReceipt",
      path: nativeReceiptPath,
      proof: nativeReceiptProof,
    }],
    callback: async ({ capturedBytes }) => {
      const bytes = capturedBytes.nativeReceipt;
      const value = validateGermanyOperationalInfrastructureV2NativeReceiptCapture(
        parseJsonBytes(bytes, "Kausal gehaltenes Native-Receipt"),
        executionPinsSource.value.releaseId,
      );
      if (!bytes.equals(serializeGermanyOperationalPublicationJson(value))) {
        throw new Error("Kausal gehaltenes Native-Receipt ist nicht kanonisch serialisiert.");
      }
      return value;
    },
  });
  const sourceProof = (value) => ({ bytes: value.bytes, file: value.file, sha256: value.sha256 });
  if (nativeReceipt.operationalProvenance.producerKind !== GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND
      || nativeReceipt.operationalProvenance.releaseEvidenceEligible !== true
      || nativeReceipt.operationalProvenance.productionActivationEligible !== true
      || !sameCanonical(nativeReceipt.operationalProvenance.executionProof?.annualLaunch, execution.annualLaunch)) {
    throw new Error("Kausal gehaltenes Native-Receipt bindet nicht denselben integrierten Annual-Launch-Vertrag wie der Outer-Lauf.");
  }
  if (nativeReceipt.sources.candidate.file !== portable(candidatePath, "Annual-Candidate")
      || nativeReceipt.sources.movementRouteTemplates.file !== portable(candidateSidecarPath, "Annual-Candidate-Sidecar")
      || nativeReceipt.sources.report.file !== portable(reportPath, "Annual-Report")) {
    throw new Error("Kausal gehaltenes Native-Receipt bindet andere Candidate-Triplet-Pfade als der Launch-Kontext.");
  }
  const outerReceiptBytes = await withGermanyOperationalHeldOutputFiles({
      workspaceRoot: root,
      files: [
        { captureBytes: false, label: "candidate", path: candidatePath, proof: sourceProof(nativeReceipt.sources.candidate) },
        { captureBytes: false, label: "movementRouteTemplates", path: candidateSidecarPath, proof: sourceProof(nativeReceipt.sources.movementRouteTemplates) },
        { captureBytes: false, label: "report", path: reportPath, proof: sourceProof(nativeReceipt.sources.report) },
        { captureBytes: true, label: "nativeReceipt", path: nativeReceiptPath, proof: nativeReceiptProof },
      ],
      callback: async ({ capturedBytes }) => {
        if (sha256(capturedBytes.nativeReceipt) !== nativeReceiptProof.sha256) {
          throw new Error("Native-Receipt driftete vor der Outer-Receipt-Materialisierung.");
        }
        const outerReceipt = {
          annualLaunch: execution.annualLaunch,
          attestedPlan: expectedPlanProof,
          attestedPlanStartEvidence: expectedStartEvidenceProof,
          executionPins: execution.executionPins,
          exit: execution.exit,
          inputs: execution.inputs,
          invocation: execution.invocation,
          job: execution.job,
          nestedLaunch: { ...nested.launcher, capture: nested.capture },
          outputs: {
            candidate: nativeReceipt.sources.candidate,
            movementRouteTemplates: nativeReceipt.sources.movementRouteTemplates,
            nativeReceipt: nativeReceiptProof,
            report: nativeReceipt.sources.report,
          },
          releaseId: executionPinsSource.value.releaseId,
          runner: execution.runner,
          schema: "zugfolge-operational-v2-outer-execution-receipt/v1",
          trustedExecutor: execution.trustedExecutor,
        };
        return canonicalBytes(outerReceipt);
      },
    });
  const outerReceiptProof = await writeCreateNew(
    outerReceiptOutputPath,
    outerReceiptBytes,
    "Annual-Outer-Execution-Receipt",
    runnerProof,
  );
  process.stdout.write(`${JSON.stringify({ status: "annual-operational-v2-executed", outerReceipt: outerReceiptProof })}\n`);
} else if (phase === "materialize-validator-rebuild-v3") {
  const runnerArguments = Array.from({ length: 3 }, (_, index) => process.env[`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_${index}`]);
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT !== "3" || runnerArguments.some((value) => !value)) {
    throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine vollstaendige dreistellige Rebuild-v3-Bindung.");
  }
  const [executionPinsPath, rebuildSpecificationPath, receiptOutputPath] = runnerArguments.map((value) => resolve(value));
  const executionPinsSource = await loadGermanyOperationalExecutionPins({
    workspaceRoot: root,
    executionPinsPath,
  });
  const runnerProof = await proveGermanyOperationalExecutionContext({
    workspaceRoot: root,
    executionPins: executionPinsSource.value,
  });
  await proveGermanyOperationalAnnualLaunchFromEnvironment({ workspaceRoot: root, executionPinsSource });
  const expectedSpecificationPath = resolve(root, ...executionPinsSource.value.validator.rebuildSpecification.split("/"));
  const expectedReceiptPath = resolve(root, ...executionPinsSource.value.validator.rebuildEvidence.split("/"));
  if (rebuildSpecificationPath !== expectedSpecificationPath || receiptOutputPath !== expectedReceiptPath) {
    throw new Error("Gehaltene Rebuild-v3-Phase driftet von den Execution-Pins-Ausgabepfaden.");
  }
  const specBytes = await readFile(rebuildSpecificationPath);
  let spec;
  try {
    spec = JSON.parse(specBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Gehaltene Rebuild-v3-Spezifikation ist kein gueltiges JSON.", { cause: error });
  }
  validateOperationalValidatorRebuildSpec(spec);
  const implementation = runnerProof.importClosure.find(({ file }) => (
    file === "tools/region-import/germany/operational-validator-rebuild-evidence.mjs"
  ));
  if (implementation === undefined) throw new Error("Rebuild-v3-Implementation fehlt in der gehaltenen Runner-Closure.");
  const producerProofs = {
    bundle: runnerProof.bundle,
    entrypoint: runnerProof.entrypoint,
    executionPins: {
      bytes: executionPinsSource.proof.bytes,
      file: executionPinsSource.proof.file,
      sha256: executionPinsSource.proof.sha256,
    },
    implementation,
  };
  const result = await materializeOperationalValidatorRebuildEvidence({
    outputPath: receiptOutputPath,
    producerProofs,
    runnerAnchorHelperProof: runnerProof.anchorHelper,
    spec,
    specBytes,
    specFile: rebuildSpecificationPath,
    workspaceRoot: root,
  });
  process.stdout.write(`${JSON.stringify({
    status: "validator-rebuild-materialized",
    binary: result.binary,
    path: result.path,
    provenance: result.provenance,
    ...result.proof,
  })}\n`);
} else if (phase === "derive-and-capture-v1") {
  const runnerArguments = Array.from({ length: 7 }, (_, index) => process.env[`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_${index}`]);
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT !== "7" || runnerArguments.some((value) => !value)) {
    throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine vollstaendige siebenstellige CLI-Bindung.");
  }
  const [executionPinsPath, specificationPath, sourceRoot, candidatePath, candidateMovementRouteTemplatesPath, reportPath, outputPath] = runnerArguments;
  const result = await runAndCaptureGermanyOperationalInfrastructureV2({
    executionPinsPath: resolve(executionPinsPath),
    specificationPath: resolve(specificationPath),
    sourceRoot: resolve(sourceRoot),
    candidatePath: resolve(candidatePath),
    candidateMovementRouteTemplatesPath: resolve(candidateMovementRouteTemplatesPath),
    reportPath: resolve(reportPath),
    outputPath: resolve(outputPath),
    workspaceRoot: root,
    runnerEntrypointPath: resolve(root, ...GERMANY_OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT.split("/")),
  });
  process.stdout.write(`${JSON.stringify({
    status: "captured",
    candidateProduced: result.result.candidateProduced,
    activationEligible: result.result.activationEligible,
    unresolvedRequired: result.result.unresolvedRequired,
    nativeReceipt: {
      file: portable(result.capture.path, "Operational-v2-Native-Receipt-Capture"),
      bytes: result.capture.bytes,
      sha256: result.capture.sha256,
    },
  })}\n`);
} else {
  throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt eine unbekannte interne Phase.");
}
