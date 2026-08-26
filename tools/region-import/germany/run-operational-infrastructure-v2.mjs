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

const [specPath, sourceRoot, candidatePath, reportPath, outputPath, ...extra] = process.argv.slice(2);
if (!specPath || !sourceRoot || !candidatePath || !reportPath || extra.length > 0) {
  throw new Error("Aufruf: run-operational-infrastructure-v2.mjs SPEC.json SOURCE_ROOT CANDIDATE.json REPORT.json [OUTPUT/operational-infrastructure-v2.json]");
}

const specificationPath = resolve(specPath);
const candidate = resolve(candidatePath);
const report = resolve(reportPath);
const output = outputPath === undefined ? undefined : resolve(outputPath);
if (new Set([candidate, report, ...(output === undefined ? [] : [output])]).size !== (output === undefined ? 2 : 3)) {
  throw new Error("Operational-v2-Candidate, Bericht und Ausgabe muessen getrennte Dateien sein.");
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
  if (output !== undefined) throw new Error("Readiness- und Legacy-Modus verwenden exakt vier Argumente und erzeugen kein OUTPUT.");
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
  if (specification.mode !== GERMANY_OPERATIONAL_CONSERVATIVE_MODE || output === undefined) {
    throw new Error(`${GERMANY_OPERATIONAL_CONSERVATIVE_MODE} verlangt das fuenfte Argument OUTPUT/operational-infrastructure-v2.json.`);
  }
  try {
    const receipt = await runGermanyOperationalInfrastructureV2({
      specification,
      specificationPath,
      sourceRoot: resolve(sourceRoot),
      candidatePath: candidate,
      reportPath: report,
      outputPath: output,
    });
    process.stdout.write(`${JSON.stringify({ status: "materialized", ...receipt })}\n`);
  } catch (error) {
    if (!(error instanceof OperationalInfrastructureDerivationIncompleteError)) throw error;
    process.stdout.write(`${JSON.stringify({
      status: "blocked",
      candidateProduced: true,
      activationEligible: false,
      unresolvedRequired: error.result.nativeReport.unresolvedRequired,
      candidate: error.result.paths.candidate,
      report: error.result.paths.report,
      output: null,
    })}\n`);
    process.stderr.write(`Operational-v2-Ableitung nicht aktivierbar: ${error.result.nativeReport.unresolvedRequiredDimensions.join(", ")}\n`);
    process.exitCode = 2;
  }
}
