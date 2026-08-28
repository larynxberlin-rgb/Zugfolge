#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  assessGermanyOperationalInfrastructureV2Readiness,
  GERMANY_OPERATIONAL_CONSERVATIVE_MODE,
  OperationalInfrastructureDerivationIncompleteError,
  readGermanyOperationalDerivationSpec,
  runGermanyOperationalInfrastructureV2,
  validateGermanyOperationalInfrastructureV2Specification,
} from "./operational-infrastructure-v2.mjs";

const USAGE = "Aufruf: run-operational-infrastructure-v2.mjs candidate-triplet SPEC.json SOURCE_ROOT CANDIDATE.json CANDIDATE-SIDECAR.json REPORT.json | materialize SPEC.json SOURCE_ROOT CANDIDATE.json SIDECAR.json REPORT.json OUTPUT/operational-infrastructure-v2.json | readiness SPEC.json SOURCE_ROOT CANDIDATE.json REPORT.json";
const [mode, ...arguments_] = process.argv.slice(2);
let specPath;
let sourceRoot;
let candidatePath;
let movementRouteTemplatesPath;
let reportPath;
let outputPath;
let extra;
if (mode === "candidate-triplet") {
  [specPath, sourceRoot, candidatePath, movementRouteTemplatesPath, reportPath, ...extra] = arguments_;
} else if (mode === "materialize") {
  [specPath, sourceRoot, candidatePath, movementRouteTemplatesPath, reportPath, outputPath, ...extra] = arguments_;
} else if (mode === "readiness") {
  [specPath, sourceRoot, candidatePath, reportPath, ...extra] = arguments_;
} else {
  throw new Error(USAGE);
}
if (!specPath || !sourceRoot || !candidatePath || !reportPath || extra.length > 0
  || ((mode === "candidate-triplet" || mode === "materialize") && !movementRouteTemplatesPath)
  || (mode === "materialize" && !outputPath)) {
  throw new Error(USAGE);
}

const specificationPath = resolve(specPath);
const candidate = resolve(candidatePath);
const report = resolve(reportPath);
const movementRouteTemplates = movementRouteTemplatesPath === undefined ? undefined : resolve(movementRouteTemplatesPath);
const output = outputPath === undefined ? undefined : resolve(outputPath);
const targets = [candidate, report, ...(movementRouteTemplates === undefined ? [] : [movementRouteTemplates]), ...(output === undefined ? [] : [output])];
if (new Set(targets).size !== targets.length) {
  throw new Error("Operational-v2-Candidate, Candidate-Sidecar, Bericht und Ausgabe muessen getrennte Dateien sein.");
}

async function writeJsonExclusiveAtomic(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

const specification = await readGermanyOperationalDerivationSpec(specificationPath);
const kind = validateGermanyOperationalInfrastructureV2Specification(specification);
if (kind !== "conservative") {
  if (mode !== "readiness") throw new Error("Readiness- und Legacy-Spezifikationen verlangen den expliziten Modus readiness und erzeugen keine Artefakte.");
  const readiness = assessGermanyOperationalInfrastructureV2Readiness(specification);
  try {
    await writeJsonExclusiveAtomic(report, readiness);
  } catch (error) {
    throw new Error(`Operational-v2-Readiness-Bericht konnte nicht atomar und kollisionsfrei geschrieben werden: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  process.stdout.write(`${JSON.stringify({
    status: readiness.status,
    candidateProduced: readiness.candidateProduced,
    report,
    unresolvedRequired: readiness.unresolvedRequired,
    specificationCanonicalSha256: readiness.specificationProof.sha256,
  })}\n`);
  process.stderr.write(`Operational-v2-Ableitung blockiert: ${readiness.blockers.map(({ code }) => code).join(", ")}\n`);
  process.exitCode = 2;
} else {
  if (specification.mode !== GERMANY_OPERATIONAL_CONSERVATIVE_MODE || mode === "readiness") {
    throw new Error(`${GERMANY_OPERATIONAL_CONSERVATIVE_MODE} verlangt candidate-triplet oder materialize.`);
  }
  try {
    const receipt = await runGermanyOperationalInfrastructureV2({
      specification,
      specificationPath,
      sourceRoot: resolve(sourceRoot),
      candidatePath: candidate,
      movementRouteTemplatesPath: movementRouteTemplates,
      reportPath: report,
      outputPath: output,
    });
    process.stdout.write(`${JSON.stringify({ status: output === undefined ? "candidate-triplet" : "materialized", ...receipt })}\n`);
  } catch (error) {
    if (!(error instanceof OperationalInfrastructureDerivationIncompleteError)) throw error;
    process.stdout.write(`${JSON.stringify({
      status: "blocked",
      candidateProduced: true,
      activationEligible: false,
      unresolvedRequired: error.result.nativeReport.unresolvedRequired,
      candidate: error.result.paths.candidate,
      movementRouteTemplates: error.result.paths.movementRouteTemplates,
      report: error.result.paths.report,
      output: null,
    })}\n`);
    process.stderr.write(`Operational-v2-Ableitung nicht aktivierbar: ${error.result.nativeReport.unresolvedRequiredDimensions.join(", ")}\n`);
    process.exitCode = 2;
  }
}
