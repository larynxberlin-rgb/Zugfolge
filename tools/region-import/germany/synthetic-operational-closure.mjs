import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  validateOperationalInfrastructureV2Native,
  validateOperationalInfrastructureV2NativeReceipt,
} from "../materialize-operational-infrastructure-v2.mjs";
import { validateGermanyOperationalInfrastructureV2Specification } from "./operational-infrastructure-v2.mjs";
import {
  buildSyntheticOperationalClosureReceipt,
  syntheticOperationalFileProof,
  syntheticOperationalTimetableRoutesProof,
  validateSyntheticOperationalDerivationReport,
  validateSyntheticOperationalPolicy,
  validateSyntheticOperationalTimetableRouteEvidence,
  verifySyntheticOperationalClosureReceipt,
} from "./synthetic-operational-quality.mjs";

export const SYNTHETIC_OPERATIONAL_CLOSURE_INPUTS_SCHEMA = "zugfolge-synthetic-operational-closure-inputs/v2";

const OUTPUT_FILE = "synthetic-operational-closure-receipt.json";
const INPUT_ROLES = Object.freeze([
  ["blocks", "blocks"],
  ["conflict-resources", "conflictResources"],
  ["platforms", "platforms"],
  ["signals", "signals"],
  ["switches", "switches"],
  ["timetable-routes", "timetableRoutes"],
  ["tracks", "tracks"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} ist kein Objekt.`);
  invariant(Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000"), `${label} besitzt unerwartete oder fehlende Felder.`);
}

function relativePath(value, label) {
  invariant(typeof value === "string" && value !== "" && !isAbsolute(value), `${label} ist kein relativer Pfad.`);
  const normalized = value.replaceAll("\\", "/");
  invariant(normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../"), `${label} verlaesst seine Wurzel.`);
  return normalized;
}

function sameValue(left, right) {
  const sorted = (value) => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
    return value;
  };
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function validateInputs(specification) {
  exactKeys(specification, ["schema", "releaseId", "artifactRoot", "policyFile", "annualSpecificationFile", "candidateFile", "derivationReportFile", "timetableRouteReportFile", "gtfsSnapshotFile", "operationalArtifactFile"], "Synthetic-Operational-Closure-Jahresvertrag");
  invariant(specification.schema === SYNTHETIC_OPERATIONAL_CLOSURE_INPUTS_SCHEMA, "Synthetic-Operational-Closure-Jahresvertrag besitzt kein v2-Schema.");
  invariant(typeof specification.releaseId === "string" && specification.releaseId !== "", "Synthetic-Operational-Closure-Jahresvertrag besitzt keine Release-ID.");
  for (const field of ["artifactRoot", "policyFile", "annualSpecificationFile", "candidateFile", "derivationReportFile", "timetableRouteReportFile", "gtfsSnapshotFile", "operationalArtifactFile"]) {
    specification[field] = relativePath(specification[field], field);
  }
  invariant(new Set([specification.candidateFile, specification.derivationReportFile, specification.timetableRouteReportFile, specification.gtfsSnapshotFile, specification.operationalArtifactFile]).size === 5, "Candidate, Berichte, GTFS-Snapshot und Artefakt muessen getrennte Dateien sein.");
  invariant(basename(specification.operationalArtifactFile) === "operational-infrastructure-v2.json", "Operational-v2-Artefakt besitzt keinen kanonischen Dateinamen.");
  invariant(basename(specification.timetableRouteReportFile) === "timetable-routes-v2.derivation-report.json", "Timetable-Route-Bericht besitzt keinen kanonischen v2-Dateinamen.");
  invariant(/^gtfs-region-.+-v2\.json$/u.test(basename(specification.gtfsSnapshotFile)), "GTFS-Snapshot besitzt keinen kanonischen v2-Dateinamen.");
  return specification;
}

async function containedDirectory(root, file, label) {
  const requested = resolve(root, relativePath(file, label));
  const remainder = relative(root, requested);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlaesst die Repositorywurzel.`);
  const metadata = await lstat(requested);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} ist kein regulaeres Verzeichnis.`);
  const actual = await realpath(requested);
  const actualRemainder = relative(root, actual);
  invariant(actualRemainder !== "" && !actualRemainder.startsWith("..") && !isAbsolute(actualRemainder), `${label} verlaesst die Repositorywurzel ueber einen Link.`);
  return actual;
}

async function containedRegularFile(root, file, label) {
  const normalized = relativePath(file, label);
  let current = root;
  const parts = normalized.split("/");
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const metadata = await lstat(current);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
    if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen nicht aufloesbaren Zwischenpfad.`);
    else invariant(metadata.isFile() && metadata.size > 0, `${label} ist keine nichtleere regulaere Datei.`);
  }
  const actual = await realpath(current);
  const remainder = relative(root, actual);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlaesst seine Wurzel.`);
  return actual;
}

async function readJsonWithProof(path, label) {
  const before = await syntheticOperationalFileProof(path, label);
  const bytes = await readFile(path);
  const after = await syntheticOperationalFileProof(path, label);
  const readSha256 = createHash("sha256").update(bytes).digest("hex");
  invariant(before.bytes === after.bytes && before.sha256 === after.sha256 && bytes.length === before.bytes && readSha256 === before.sha256, `${label} aenderte sich waehrend des Lesens.`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { proof: before, value };
}

function artifactRelative(artifactRoot, path, label) {
  const result = relative(artifactRoot, path).replaceAll("\\", "/");
  invariant(result !== "" && !result.startsWith("../") && !isAbsolute(result), `${label} liegt nicht unter artifactRoot.`);
  return result;
}

async function publishCreateNew(output, receipt) {
  invariant(basename(output) === OUTPUT_FILE, `Closure-Ausgabe muss ${OUTPUT_FILE} heissen.`);
  await mkdir(dirname(output), { recursive: true });
  try {
    await lstat(output);
    throw new Error(`Closure-Ausgabe existiert bereits; create-new verweigert jede Ueberschreibung: ${output}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${output}.${process.pid}.${randomUUID()}.building`;
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, output);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`Closure-Ausgabe existiert bereits; create-new verweigert jede Ueberschreibung: ${output}`);
      throw error;
    }
  } finally {
    if (handle.fd !== -1) await handle.close();
    await rm(temporary, { force: true });
  }
  return { text, proof: await syntheticOperationalFileProof(output, "Synthetic-Operational-Closure-Ausgabe") };
}

export async function writeAnnualSyntheticOperationalClosure({
  specificationPath,
  repositoryRoot = ".",
  outputPath,
  validateNative = validateOperationalInfrastructureV2Native,
}) {
  const repository = await realpath(resolve(repositoryRoot));
  const closureInputsRelative = relative(repository, resolve(specificationPath)).replaceAll("\\", "/");
  const closureInputsPath = await containedRegularFile(repository, closureInputsRelative, "Closure-Jahresvertrag");
  const closureInputs = validateInputs((await readJsonWithProof(closureInputsPath, "Closure-Jahresvertrag")).value);
  const artifactRoot = await containedDirectory(repository, closureInputs.artifactRoot, "artifactRoot");
  const output = resolve(outputPath);
  invariant(output === resolve(artifactRoot, OUTPUT_FILE), `Jahres-CLI darf nur ${OUTPUT_FILE} in artifactRoot erzeugen.`);
  try {
    await lstat(output);
    throw new Error(`Closure-Ausgabe existiert bereits; create-new verweigert jede Ueberschreibung: ${output}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const policyPath = await containedRegularFile(repository, closureInputs.policyFile, "policyFile");
  const annualSpecificationPath = await containedRegularFile(repository, closureInputs.annualSpecificationFile, "annualSpecificationFile");
  const candidatePath = await containedRegularFile(artifactRoot, closureInputs.candidateFile, "candidateFile");
  const derivationReportPath = await containedRegularFile(artifactRoot, closureInputs.derivationReportFile, "derivationReportFile");
  const timetableRouteReportPath = await containedRegularFile(artifactRoot, closureInputs.timetableRouteReportFile, "timetableRouteReportFile");
  const gtfsSnapshotPath = await containedRegularFile(artifactRoot, closureInputs.gtfsSnapshotFile, "gtfsSnapshotFile");
  const operationalArtifactPath = await containedRegularFile(artifactRoot, closureInputs.operationalArtifactFile, "operationalArtifactFile");

  const [policyInput, annualInput, candidateProof, reportInput, timetableRouteReportInput, gtfsSnapshotInput, artifactProof] = await Promise.all([
    readJsonWithProof(policyPath, "Synthetic-Operational-Policy"),
    readJsonWithProof(annualSpecificationPath, "Operational-v2-Jahresspezifikation"),
    syntheticOperationalFileProof(candidatePath, "Operational-v2-Candidate"),
    readJsonWithProof(derivationReportPath, "Operational-v2-Ableitungsbericht"),
    readJsonWithProof(timetableRouteReportPath, "Timetable-Route-Bericht"),
    readJsonWithProof(gtfsSnapshotPath, "GTFS-Snapshot"),
    syntheticOperationalFileProof(operationalArtifactPath, "Operational-v2-Artefakt"),
  ]);
  const policy = validateSyntheticOperationalPolicy(policyInput.value);
  const annualSpecification = annualInput.value;
  invariant(validateGermanyOperationalInfrastructureV2Specification(annualSpecification) === "conservative", "Jahresspezifikation ist kein konservativer Operational-v2-Vertrag.");
  invariant(annualSpecification.infraReleaseId === closureInputs.releaseId, "Jahresspezifikation und Closure-Vertrag nennen verschiedene Releases.");
  invariant(sameValue(annualSpecification.policy, policy.compilerPolicy), "Eingecheckte Closure-Policy und Jahresspezifikation besitzen verschiedene Compilerregeln.");

  const inputs = [];
  let timetableRoutesProof;
  for (const [role, layer] of INPUT_ROLES) {
    const path = await containedRegularFile(repository, annualSpecification.layers[layer], `layers.${layer}`);
    const relativeFile = artifactRelative(artifactRoot, path, `layers.${layer}`);
    const proof = role === "timetable-routes"
      ? await syntheticOperationalTimetableRoutesProof(path, "Synthetic-Operational-Input timetable-routes")
      : await syntheticOperationalFileProof(path, `Synthetic-Operational-Input ${role}`);
    const records = role === "timetable-routes" ? proof.records : reportInput.value.inputs?.[layer]?.records;
    inputs.push({ role, file: relativeFile, bytes: proof.bytes, sha256: proof.sha256, records });
    if (role === "timetable-routes") timetableRoutesProof = proof;
  }
  inputs.push({ role: "timetable-route-report", file: artifactRelative(artifactRoot, timetableRouteReportPath, "timetableRouteReportFile"), ...timetableRouteReportInput.proof, records: 1 });
  inputs.push({ role: "gtfs-snapshot", file: artifactRelative(artifactRoot, gtfsSnapshotPath, "gtfsSnapshotFile"), ...gtfsSnapshotInput.proof, records: 1 });

  const candidateNative = validateOperationalInfrastructureV2NativeReceipt(
    await validateNative(candidatePath, closureInputs.releaseId),
    closureInputs.releaseId,
  );
  const artifactNative = validateOperationalInfrastructureV2NativeReceipt(
    await validateNative(operationalArtifactPath, closureInputs.releaseId),
    closureInputs.releaseId,
  );
  const candidate = {
    file: artifactRelative(artifactRoot, candidatePath, "candidateFile"),
    ...candidateProof,
    stateHash: candidateNative.stateHash,
  };
  const operationalArtifact = {
    file: artifactRelative(artifactRoot, operationalArtifactPath, "operationalArtifactFile"),
    ...artifactProof,
    stateHash: artifactNative.stateHash,
  };
  const annualSpecificationBinding = { file: closureInputs.annualSpecificationFile, ...annualInput.proof };
  const coverage = validateSyntheticOperationalDerivationReport(reportInput.value, {
    releaseId: closureInputs.releaseId,
    annualSpecification,
    annualSpecificationProof: annualSpecificationBinding,
    inputBindings: inputs,
    candidate,
  });
  const byRole = new Map(inputs.map((entry) => [entry.role, entry]));
  const timetableRouteEvidence = validateSyntheticOperationalTimetableRouteEvidence({
    releaseId: closureInputs.releaseId,
    routeReport: timetableRouteReportInput.value,
    routeReportBinding: byRole.get("timetable-route-report"),
    gtfsSnapshot: gtfsSnapshotInput.value,
    gtfsSnapshotBinding: byRole.get("gtfs-snapshot"),
    timetableRoutesProof,
    tracksBinding: byRole.get("tracks"),
  });
  const derivationReport = {
    file: artifactRelative(artifactRoot, derivationReportPath, "derivationReportFile"),
    ...reportInput.proof,
    schema: reportInput.value.schema,
    mode: reportInput.value.mode,
    routeCoverage: reportInput.value.routeCoverage,
    activationEligible: reportInput.value.activationEligible,
    unresolvedRequired: reportInput.value.unresolvedRequired,
    realInterlockingFactsClaimed: reportInput.value.realInterlockingFactsClaimed,
    candidate: { ...reportInput.value.candidate },
  };
  const receipt = buildSyntheticOperationalClosureReceipt({
    policy,
    releaseId: closureInputs.releaseId,
    annualSpecification: annualSpecificationBinding,
    candidate,
    operationalArtifact,
    derivationReport,
    inputs,
    timetableRouteEvidence,
    coverage,
    nativeValidation: { candidate: candidateNative, operationalArtifact: artifactNative },
  });
  await verifySyntheticOperationalClosureReceipt({ receipt, policy, releaseId: closureInputs.releaseId, artifactRoot, repositoryRoot: repository });
  const published = await publishCreateNew(output, receipt);
  return { output, bytes: published.proof.bytes, sha256: published.proof.sha256, receipt };
}
