import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  isVerifiedSyntheticOperationalClosure,
  publicSyntheticOperationalClosure,
  syntheticOperationalFileProof,
  verifySyntheticOperationalClosureReceipt,
} from "./synthetic-operational-quality.mjs";
import { validateStaticMapQuality } from "../../tiles/static-map-quality.mjs";

export const OPERATIONAL_QUALITY_INPUTS_SCHEMA = "zugfolge-operational-quality-inputs/v1";
export const OPERATIONAL_QUALITY_REPORT_SCHEMA = "zugfolge-operational-infrastructure-quality-report/v1";

const QUALITY_CLASSES = Object.freeze(["A", "B", "C"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function contained(root, file, label) {
  invariant(typeof file === "string" && file !== "" && !isAbsolute(file), `${label} ist kein relativer Pfad.`);
  const normalized = file.replaceAll("\\", "/");
  invariant(normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../"), `${label} verlaesst die Repositorywurzel.`);
  const absolute = resolve(root, normalized);
  const remainder = relative(root, absolute);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlaesst die Repositorywurzel.`);
  return absolute;
}

function classCounts(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  const result = {};
  for (const qualityClass of QUALITY_CLASSES) {
    invariant(Number.isSafeInteger(value[qualityClass]) && value[qualityClass] >= 0, `${label}.${qualityClass} ist ungueltig.`);
    result[qualityClass] = value[qualityClass];
  }
  return result;
}

function sumClasses(value) {
  return QUALITY_CLASSES.reduce((sum, qualityClass) => sum + value[qualityClass], 0);
}

function validateInputs(specification) {
  invariant(specification?.schema === OPERATIONAL_QUALITY_INPUTS_SCHEMA, "Operational-Qualitaetsvertrag besitzt ein unbekanntes Schema.");
  invariant(typeof specification.releaseId === "string" && specification.releaseId !== "", "Operational-Qualitaetsvertrag besitzt keine Release-ID.");
  invariant(Number.isSafeInteger(specification.timetableYear), "Operational-Qualitaetsvertrag besitzt kein Fahrplanjahr.");
  for (const field of ["artifactRoot", "policyFile", "closureReceiptFile", "mapQualityReportFile"]) {
    invariant(typeof specification[field] === "string" && specification[field] !== "", `Operational-Qualitaetsvertrag besitzt kein ${field}.`);
  }
  return specification;
}

function validateMapQualityReport(report, specification) {
  invariant(report?.schema === "zugfolge-static-map-quality/v2", "Kartenqualitaetsbeleg ist keine auslieferbare Static-Map-Quality-v2-Projektion.");
  validateStaticMapQuality(report, { infrastructureCorpusId: specification.releaseId });
  invariant(report.timetableYear === specification.timetableYear, "Karten- und Operational-Qualitaet nennen verschiedene Fahrplanjahre.");
  const counts = classCounts(report.summary?.qualityClassFeatureCount, "Kartenobjektklassen");
  invariant(Number.isSafeInteger(report.summary?.visibleFeatures) && report.summary.visibleFeatures > 0, "Kartenqualitaetsbeleg besitzt keine sichtbaren Objekte.");
  invariant(sumClasses(counts) === report.summary.visibleFeatures, "Kartenobjektklassen ergeben nicht die sichtbaren Objekte.");
  invariant(Number.isSafeInteger(report.summary?.visibleLayers) && report.summary.visibleLayers === 10, "Kartenqualitaetsbeleg besitzt nicht exakt zehn sichtbare Layer.");
  const tracks = report.layers?.find(({ name }) => name === "tracks");
  invariant(tracks !== undefined && Number.isSafeInteger(tracks.totalLengthMm) && tracks.totalLengthMm > 0, "Kartenqualitaetsbeleg besitzt keine Gleislaenge.");
  const trackCounts = classCounts(tracks.qualityClassLengthMm, "Kartengleisklassen");
  invariant(sumClasses(trackCounts) === tracks.totalLengthMm, "Kartengleisklassen ergeben nicht die Gesamtlaenge.");
  return {
    mapReleaseId: report.releaseId,
    infrastructureCorpusId: report.infrastructureCorpusId,
    sourceReport: {
      schema: "zugfolge-final-infrastructure-quality-report/v1",
      bytes: report.sourceReport.bytes,
      sha256: report.sourceReport.sha256,
      shipped: report.sourceReport.shipped,
    },
    visibleFeatures: report.summary.visibleFeatures,
    visibleLayers: report.summary.visibleLayers,
    qualityClassFeatureCount: counts,
    trackLengthMm: tracks.totalLengthMm,
    trackQualityClassLengthMm: trackCounts,
  };
}

export function buildOperationalQualityReport({ specification, mapQualityReport, mapQualityProof, verifiedClosure }) {
  validateInputs(specification);
  invariant(isVerifiedSyntheticOperationalClosure(verifiedClosure), "Operational-Closure wurde nicht bytegenau verifiziert.");
  invariant(verifiedClosure.releaseId === specification.releaseId, "Operational-Closure und Qualitaetsvertrag nennen verschiedene Releases.");
  invariant(Number.isSafeInteger(mapQualityProof?.bytes) && mapQualityProof.bytes > 0 && /^[a-f0-9]{64}$/u.test(mapQualityProof.sha256), "Kartenqualitaetsbeleg besitzt keinen Bytehash.");
  const mapSummary = validateMapQualityReport(mapQualityReport, specification);
  const operationalModel = publicSyntheticOperationalClosure(verifiedClosure);
  return {
    schema: OPERATIONAL_QUALITY_REPORT_SCHEMA,
    releaseId: specification.releaseId,
    timetableYear: specification.timetableYear,
    scopeId: "deutschland-ebo-operational-v2",
    deterministic: true,
    separation: {
      mapEvidencePurpose: "visible-map-quality-evidence",
      operationalEvidencePurpose: "closed-operational-v2-model",
      mapClassCReclassified: false,
      mapClassCBlocksOperationalQualityGate: false,
      mapObjectsRemoved: false,
    },
    mapEvidence: {
      schema: mapQualityReport.schema,
      mapReleaseId: mapSummary.mapReleaseId,
      infrastructureCorpusId: mapSummary.infrastructureCorpusId,
      bytes: mapQualityProof.bytes,
      sha256: mapQualityProof.sha256,
      sourceReport: mapSummary.sourceReport,
      visibleFeatures: mapSummary.visibleFeatures,
      visibleLayers: mapSummary.visibleLayers,
      qualityClassFeatureCount: mapSummary.qualityClassFeatureCount,
      trackLengthMm: mapSummary.trackLengthMm,
      trackQualityClassLengthMm: mapSummary.trackQualityClassLengthMm,
    },
    operationalModel,
    summary: {
      operationalQualityClassArtifactCount: { A: 0, B: 1, C: 0 },
      unresolvedRequired: 0,
      visibleMapClassCFeatureCount: mapSummary.qualityClassFeatureCount.C,
    },
    qualityGate: {
      closureReceiptVerified: true,
      nativeOperationalValidationVerified: true,
      operationalClassCZero: true,
      ordinaryAssumptionsPromoted: false,
      mapClassCReclassified: false,
      operationalQualityEligible: true,
      signatureImplied: false,
      activationImplied: false,
    },
  };
}

async function readBoundJson(path, label) {
  const before = await syntheticOperationalFileProof(path, label);
  const bytes = await readFile(path);
  const after = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  invariant(before.bytes === after.bytes && before.sha256 === after.sha256, `${label} aenderte sich waehrend des Lesens.`);
  return { proof: before, value: JSON.parse(bytes.toString("utf8")) };
}

export async function writeOperationalQualityReport({ specificationPath, repositoryRoot = ".", outputPath }) {
  const root = resolve(repositoryRoot);
  const specification = validateInputs(JSON.parse(await readFile(resolve(specificationPath), "utf8")));
  const artifactRoot = contained(root, specification.artifactRoot, "artifactRoot");
  const policy = JSON.parse(await readFile(contained(root, specification.policyFile, "policyFile"), "utf8"));
  const receipt = JSON.parse(await readFile(contained(artifactRoot, specification.closureReceiptFile, "closureReceiptFile"), "utf8"));
  const verifiedClosure = await verifySyntheticOperationalClosureReceipt({
    receipt,
    policy,
    releaseId: specification.releaseId,
    artifactRoot,
    repositoryRoot: root,
  });
  const map = await readBoundJson(contained(artifactRoot, specification.mapQualityReportFile, "mapQualityReportFile"), "Kartenqualitaetsbeleg");
  const report = buildOperationalQualityReport({
    specification,
    mapQualityReport: map.value,
    mapQualityProof: map.proof,
    verifiedClosure,
  });
  const output = resolve(outputPath);
  const temporary = `${output}.building`;
  for (const path of [output, temporary]) {
    try {
      await stat(path);
      throw new Error(`Operational-Qualitaetsausgabe existiert bereits: ${path}.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const handle = await open(temporary, "wx");
  try {
    await handle.write(text);
    await handle.sync();
    await handle.close();
    await rename(temporary, output);
  } catch (error) {
    if (handle.fd !== -1) await handle.close();
    try {
      await unlink(temporary);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }
    throw error;
  }
  return {
    output,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    report: JSON.parse(text),
  };
}
