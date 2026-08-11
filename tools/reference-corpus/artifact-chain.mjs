import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  MODEL_RESULTS_SCHEMA,
  REPORT_SCHEMA,
  canonicalJson,
  compareWithModel,
  sha256,
} from "./reference-corpus.mjs";

export const TECHNICAL_DATASET_SCHEMA = "zugfolge-technical-reference-dataset/v1";
export const EVALUATION_CONFIG_SCHEMA = "zugfolge-technical-evaluation-config/v1";
export const QUALIFICATION_EVIDENCE_SCHEMA = "zugfolge-qualification-evidence/v1";
export const QUALIFIED_RELEASE_SCHEMA = "zugfolge-qualified-infra-release-manifest/v1";
export const ARTIFACT_CHAIN_SCHEMA = "zugfolge-release-artifact-chain/v1";
export const BUNDLE_SCHEMA = "zugfolge-pilot-release-bundle/v3";
const verifiedBundles = new WeakSet();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value, name) {
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
}

function integer(value, name, minimum = 0) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} muss eine ganze Zahl >= ${minimum} sein.`);
}

function sha256Hex(value, name) {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/u.test(value), `${name} muss ein SHA-256-Hash sein.`);
}

function timestamp(value, name) {
  nonEmpty(value, name);
  invariant(Number.isFinite(Date.parse(value)), `${name} muss ein ISO-8601-Zeitpunkt sein.`);
}

function sortedUniqueStrings(values, name, minimum = 1) {
  invariant(Array.isArray(values) && values.length >= minimum, `${name} enthält zu wenige Einträge.`);
  for (const [index, value] of values.entries()) nonEmpty(value, `${name}[${index}]`);
  const sorted = [...values].sort();
  invariant(new Set(sorted).size === sorted.length, `${name} enthält doppelte Identitäten.`);
  return sorted;
}

function assertSafeRelativePath(value, name) {
  nonEmpty(value, name);
  invariant(!path.isAbsolute(value), `${name} muss relativ zum Artefaktordner sein.`);
  const normalized = path.normalize(value);
  invariant(
    normalized !== ".." && !normalized.startsWith(`..${path.sep}`),
    `${name} darf den Artefaktordner nicht verlassen.`,
  );
  return normalized;
}

function resolveArtifact(rootDirectory, relativePath, name) {
  const root = path.resolve(rootDirectory);
  const normalized = assertSafeRelativePath(relativePath, name);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  invariant(relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), `${name} liegt außerhalb des Artefaktordners.`);
  return resolved;
}

async function assertRealPathWithinRoot(rootDirectory, resolvedPath, name) {
  const [realRoot, realFile] = await Promise.all([realpath(path.resolve(rootDirectory)), realpath(resolvedPath)]);
  const relative = path.relative(realRoot, realFile);
  invariant(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${name} verweist über einen Symlink aus dem Artefaktordner.`);
}

function validateArtifactRecord(record, name) {
  invariant(record && typeof record === "object" && !Array.isArray(record), `${name} fehlt.`);
  assertSafeRelativePath(record.path, `${name}.path`);
  sha256Hex(record.sha256, `${name}.sha256`);
  return record;
}

async function readArtifact(rootDirectory, record, name) {
  validateArtifactRecord(record, name);
  const resolved = resolveArtifact(rootDirectory, record.path, `${name}.path`);
  await assertRealPathWithinRoot(rootDirectory, resolved, `${name}.path`);
  const bytes = await readFile(resolved);
  invariant(sha256(bytes) === record.sha256, `${name}: Artefakthash stimmt nicht (${record.path}).`);
  return bytes;
}

async function readJsonArtifact(rootDirectory, record, name) {
  const bytes = await readArtifact(rootDirectory, record, name);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${name} ist kein gültiges JSON: ${error instanceof Error ? error.message : error}`);
  }
  return { bytes, value };
}

async function artifactRecordForPath(rootDirectory, relativePath, name) {
  const normalized = assertSafeRelativePath(relativePath, name);
  const resolved = resolveArtifact(rootDirectory, normalized, name);
  await assertRealPathWithinRoot(rootDirectory, resolved, name);
  const bytes = await readFile(resolved);
  return Object.freeze({ path: relativePath, sha256: sha256(bytes) });
}

function sameArtifactRecord(actual, expected, name) {
  validateArtifactRecord(actual, name);
  validateArtifactRecord(expected, `${name} (Kette)`);
  invariant(actual.path === expected.path && actual.sha256 === expected.sha256, `${name} ist nicht exakt an die Artefaktkette gebunden.`);
}

function validatePartition(partition, role, policyMinimum) {
  invariant(partition?.purpose === role, `${role}.purpose muss '${role}' sein.`);
  nonEmpty(partition.datasetId, `${role}.datasetId`);
  nonEmpty(partition.configId, `${role}.configId`);
  timestamp(partition.frozenAt, `${role}.frozenAt`);
  validateArtifactRecord(partition.dataset, `${role}.dataset`);
  validateArtifactRecord(partition.config, `${role}.config`);
  const sampleIds = sortedUniqueStrings(partition.sampleIds, `${role}.sampleIds`, policyMinimum);
  sha256Hex(partition.sampleIdsSha256, `${role}.sampleIdsSha256`);
  invariant(
    partition.sampleIdsSha256 === sha256(canonicalJson(sampleIds)),
    `${role}.sampleIdsSha256 stimmt nicht mit den eingefrorenen Stichprobenidentitäten überein.`,
  );
  return { ...partition, sampleIds };
}

export function validateQualificationEvidence(evidence) {
  invariant(evidence?.schema === QUALIFICATION_EVIDENCE_SCHEMA, "Unbekanntes Qualifikationsnachweis-Schema.");
  timestamp(evidence.frozenAt, "qualificationEvidence.frozenAt");
  integer(evidence.policy?.minimumCalibrationSamples, "minimumCalibrationSamples", 1);
  integer(evidence.policy?.minimumValidationSamples, "minimumValidationSamples", 1);
  const calibration = validatePartition(
    evidence.calibration,
    "calibration",
    evidence.policy.minimumCalibrationSamples,
  );
  const validation = validatePartition(
    evidence.validation,
    "validation",
    evidence.policy.minimumValidationSamples,
  );
  invariant(calibration.datasetId !== validation.datasetId, "Kalibrierungs- und Validierungsdatensatz haben dieselbe Identität.");
  invariant(calibration.dataset.sha256 !== validation.dataset.sha256, "Kalibrierungs- und Validierungsdatensatz haben denselben Artefakthash.");
  invariant(calibration.configId !== validation.configId, "Kalibrierungs- und Validierungskonfiguration haben dieselbe Identität.");
  invariant(calibration.config.sha256 !== validation.config.sha256, "Kalibrierungs- und Validierungskonfiguration haben denselben Artefakthash.");
  const calibrationIds = new Set(calibration.sampleIds);
  invariant(
    validation.sampleIds.every((sampleId) => !calibrationIds.has(sampleId)),
    "Kalibrierungs- und Validierungsstichproben überlappen.",
  );
  return Object.freeze({ evidence, calibration, validation, qualified: true });
}

function validateTechnicalDataset(dataset, partition, role) {
  invariant(dataset?.schema === TECHNICAL_DATASET_SCHEMA, `${role}: unbekanntes technisches Datensatz-Schema.`);
  invariant(dataset.purpose === role, `${role}: Datensatz hat den falschen Zweck.`);
  invariant(dataset.datasetId === partition.datasetId, `${role}: datasetId stimmt nicht mit dem Nachweis überein.`);
  invariant(dataset.frozenAt === partition.frozenAt, `${role}: eingefrorener Zeitpunkt des Datensatzes stimmt nicht überein.`);
  nonEmpty(dataset.source?.id, `${role}.source.id`);
  nonEmpty(dataset.source?.sourceLicense, `${role}.source.sourceLicense`);
  nonEmpty(dataset.source?.attribution, `${role}.source.attribution`);
  timestamp(dataset.source?.retrievedAt, `${role}.source.retrievedAt`);
  nonEmpty(dataset.source?.method, `${role}.source.method`);
  invariant(Array.isArray(dataset.samples), `${role}: samples muss eine Liste sein.`);
  const ids = [];
  const byId = new Map();
  for (const [index, sample] of dataset.samples.entries()) {
    const prefix = `${role}.samples[${index}]`;
    nonEmpty(sample.id, `${prefix}.id`);
    nonEmpty(sample.groupId, `${prefix}.groupId`);
    nonEmpty(sample.characteristicsId, `${prefix}.characteristicsId`);
    nonEmpty(sample.sourceId, `${prefix}.sourceId`);
    invariant(sample.sourceId === dataset.source.id, `${prefix}.sourceId stimmt nicht mit der Datensatzquelle überein.`);
    integer(sample.technicalRunningSeconds, `${prefix}.technicalRunningSeconds`, 1);
    invariant(!byId.has(sample.id), `${role}: Stichprobenidentität '${sample.id}' ist doppelt.`);
    ids.push(sample.id);
    byId.set(sample.id, sample);
  }
  invariant(
    canonicalJson([...ids].sort()) === canonicalJson(partition.sampleIds),
    `${role}: Datensatz enthält nicht exakt die eingefrorenen Stichprobenidentitäten.`,
  );
  return byId;
}

function validateEvaluationConfig(config, partition, role) {
  invariant(config?.schema === EVALUATION_CONFIG_SCHEMA, `${role}: unbekanntes Auswertungskonfigurations-Schema.`);
  invariant(config.purpose === role, `${role}: Konfiguration hat den falschen Zweck.`);
  invariant(config.configId === partition.configId, `${role}: configId stimmt nicht mit dem Nachweis überein.`);
  invariant(config.frozenAt === partition.frozenAt, `${role}: eingefrorener Zeitpunkt der Konfiguration stimmt nicht überein.`);
  invariant(config.datasetSha256 === partition.dataset.sha256, `${role}: Konfiguration ist nicht an den exakten Datensatz gebunden.`);
  nonEmpty(config.method, `${role}.config.method`);
}

export async function verifyQualificationEvidenceFiles(evidence, rootDirectory) {
  const qualification = validateQualificationEvidence(evidence);
  const [calibrationDatasetArtifact, calibrationConfigArtifact, validationDatasetArtifact, validationConfigArtifact] = await Promise.all([
    readJsonArtifact(rootDirectory, qualification.calibration.dataset, "calibration.dataset"),
    readJsonArtifact(rootDirectory, qualification.calibration.config, "calibration.config"),
    readJsonArtifact(rootDirectory, qualification.validation.dataset, "validation.dataset"),
    readJsonArtifact(rootDirectory, qualification.validation.config, "validation.config"),
  ]);
  const calibrationSamplesById = validateTechnicalDataset(
    calibrationDatasetArtifact.value,
    qualification.calibration,
    "calibration",
  );
  const validationSamplesById = validateTechnicalDataset(
    validationDatasetArtifact.value,
    qualification.validation,
    "validation",
  );
  validateEvaluationConfig(calibrationConfigArtifact.value, qualification.calibration, "calibration");
  validateEvaluationConfig(validationConfigArtifact.value, qualification.validation, "validation");
  return Object.freeze({
    ...qualification,
    calibrationSamplesById,
    validationSamplesById,
    calibrationDataset: calibrationDatasetArtifact.value,
    validationDataset: validationDatasetArtifact.value,
  });
}

function exactBindings(actual, expected, name) {
  invariant(actual && typeof actual === "object", `${name} fehlt.`);
  invariant(canonicalJson(actual) === canonicalJson(expected), `${name} stimmt nicht exakt mit der Artefaktkette überein.`);
}

export function createQualifiedReleaseManifest(input) {
  invariant(input.report?.schema === REPORT_SCHEMA, "Nur ein gehärteter Abweichungsreport kann einen Release qualifizieren.");
  invariant(input.report.passed && input.report.releaseQualified, "Nur ein bestandener unabhängiger Validierungsreport kann einen Release qualifizieren.");
  invariant(input.candidateManifest?.releaseChecksum === input.report.releaseChecksum, "Release-Kandidat und Report haben verschiedene Release-Checksummen.");
  invariant(input.candidateManifest?.modelInputSha256 === input.report.modelInputSha256, "Release-Kandidat und Report haben verschiedene Modelleingaben.");
  for (const [name, record] of Object.entries({
    candidateManifest: input.candidateManifestArtifact,
    referenceCorpus: input.referenceCorpusArtifact,
    qualificationEvidence: input.qualificationEvidenceArtifact,
    modelResults: input.modelResultsArtifact,
    report: input.reportArtifact,
  })) validateArtifactRecord(record, name);
  timestamp(input.createdAt, "createdAt");
  const bindings = input.report.artifactBinding;
  invariant(bindings.referenceCorpusSha256 === input.referenceCorpusArtifact.sha256, "Report und Referenzkorpus-Artefakt stimmen nicht überein.");
  invariant(bindings.qualificationEvidenceSha256 === input.qualificationEvidenceArtifact.sha256, "Report und Qualifikationsnachweis stimmen nicht überein.");
  invariant(bindings.modelResultsSha256 === input.modelResultsArtifact.sha256, "Report und Modellergebnis-Artefakt stimmen nicht überein.");
  invariant(input.reportArtifact.sha256 === sha256(input.reportBytes), "Report-Artefakthash stimmt nicht mit den Reportbytes überein.");
  return Object.freeze({
    schema: QUALIFIED_RELEASE_SCHEMA,
    releaseChecksum: input.report.releaseChecksum,
    modelInputSha256: input.report.modelInputSha256,
    createdAt: input.createdAt,
    candidateManifest: Object.freeze({ ...input.candidateManifestArtifact }),
    qualification: Object.freeze({
      referenceCorpusSha256: input.referenceCorpusArtifact.sha256,
      qualificationEvidenceSha256: input.qualificationEvidenceArtifact.sha256,
      modelResultsSha256: input.modelResultsArtifact.sha256,
      reportSha256: input.reportArtifact.sha256,
    }),
  });
}

function artifactEntries(artifacts) {
  return [
    ["captureConfig", artifacts.captureConfig],
    ["captureManifest", artifacts.captureManifest],
    ["sourceArchive", artifacts.sourceArchive],
    ...(artifacts.sourceTables ?? []).map((record, index) => [`sourceTables[${index}]`, record]),
    ["normalizedObservations", artifacts.normalizedObservations],
    ["referenceCorpus", artifacts.referenceCorpus],
    ["qualificationEvidence", artifacts.qualificationEvidence],
    ["calibrationDataset", artifacts.calibrationDataset],
    ["calibrationConfig", artifacts.calibrationConfig],
    ["validationDataset", artifacts.validationDataset],
    ["validationConfig", artifacts.validationConfig],
    ["modelConfig", artifacts.modelConfig],
    ["modelResults", artifacts.modelResults],
    ["report", artifacts.report],
    ["releaseCandidate", artifacts.releaseCandidate],
    ["releaseManifest", artifacts.releaseManifest],
  ];
}

function validateArtifactChainShape(chain) {
  invariant(chain?.schema === ARTIFACT_CHAIN_SCHEMA, "Unbekanntes Artefaktketten-Schema.");
  invariant(chain.artifacts && typeof chain.artifacts === "object", "artifacts fehlt.");
  invariant(Array.isArray(chain.artifacts.sourceTables) && chain.artifacts.sourceTables.length > 0, "sourceTables fehlt.");
  const seenPaths = new Set();
  for (const [name, record] of artifactEntries(chain.artifacts)) {
    validateArtifactRecord(record, `artifacts.${name}`);
    const normalizedPath = path.normalize(record.path).toLocaleLowerCase("en-US");
    invariant(!seenPaths.has(normalizedPath), `Artefaktpfad '${record.path}' ist in der Kette doppelt.`);
    seenPaths.add(normalizedPath);
  }
}

export async function createArtifactChainManifest(paths, rootDirectory) {
  const required = [
    "captureConfig",
    "captureManifest",
    "sourceArchive",
    "normalizedObservations",
    "referenceCorpus",
    "qualificationEvidence",
    "modelConfig",
    "modelResults",
    "report",
    "releaseCandidate",
    "releaseManifest",
  ];
  for (const name of required) nonEmpty(paths[name], `paths.${name}`);
  nonEmpty(paths.sourceTableDirectory, "paths.sourceTableDirectory");
  const baseRecords = Object.fromEntries(await Promise.all(required.map(async (name) => [
    name,
    await artifactRecordForPath(rootDirectory, paths[name], `paths.${name}`),
  ])));
  const captureManifest = JSON.parse((await readFile(resolveArtifact(rootDirectory, paths.captureManifest, "paths.captureManifest"))).toString("utf8"));
  const evidence = JSON.parse((await readFile(resolveArtifact(rootDirectory, paths.qualificationEvidence, "paths.qualificationEvidence"))).toString("utf8"));
  invariant(Array.isArray(captureManifest.files) && captureManifest.files.length > 0, "Capture-Manifest enthält keine Tabellen.");
  const sourceTables = await Promise.all(captureManifest.files.map(async (table, index) => {
    nonEmpty(table.path, `captureManifest.files[${index}].path`);
    assertSafeRelativePath(table.path, `captureManifest.files[${index}].path`);
    const relativePath = path.join(paths.sourceTableDirectory, table.path);
    const record = await artifactRecordForPath(rootDirectory, relativePath, `sourceTables[${index}]`);
    return Object.freeze({ ...record, sourcePath: table.path });
  }));
  const chain = Object.freeze({
    schema: ARTIFACT_CHAIN_SCHEMA,
    artifacts: Object.freeze({
      captureConfig: baseRecords.captureConfig,
      captureManifest: baseRecords.captureManifest,
      sourceArchive: baseRecords.sourceArchive,
      sourceTables: Object.freeze(sourceTables),
      normalizedObservations: baseRecords.normalizedObservations,
      referenceCorpus: baseRecords.referenceCorpus,
      qualificationEvidence: baseRecords.qualificationEvidence,
      calibrationDataset: evidence.calibration?.dataset,
      calibrationConfig: evidence.calibration?.config,
      validationDataset: evidence.validation?.dataset,
      validationConfig: evidence.validation?.config,
      modelConfig: baseRecords.modelConfig,
      modelResults: baseRecords.modelResults,
      report: baseRecords.report,
      releaseCandidate: baseRecords.releaseCandidate,
      releaseManifest: baseRecords.releaseManifest,
    }),
  });
  validateArtifactChainShape(chain);
  return chain;
}

function expectedModelBindings(artifacts, corpus, evidence) {
  return Object.freeze({
    captureConfigSha256: artifacts.captureConfig.sha256,
    captureManifestSha256: artifacts.captureManifest.sha256,
    sourceArchiveSha256: artifacts.sourceArchive.sha256,
    sourceTablesSha256: corpus.artifactBinding.sourceTablesSha256,
    normalizedObservationsSha256: artifacts.normalizedObservations.sha256,
    referenceCorpusSha256: artifacts.referenceCorpus.sha256,
    qualificationEvidenceSha256: artifacts.qualificationEvidence.sha256,
    calibrationDatasetSha256: evidence.calibration.dataset.sha256,
    calibrationConfigSha256: evidence.calibration.config.sha256,
    validationDatasetSha256: evidence.validation.dataset.sha256,
    validationConfigSha256: evidence.validation.config.sha256,
    observationsSha256: corpus.artifactBinding.observationsSha256,
  });
}

export async function verifyArtifactChainFiles(chain, rootDirectory) {
  validateArtifactChainShape(chain);
  const artifacts = chain.artifacts;
  const loadedEntries = await Promise.all(
    artifactEntries(artifacts).map(async ([name, record]) => [name, await readArtifact(rootDirectory, record, `artifacts.${name}`)]),
  );
  const loaded = new Map(loadedEntries);
  const json = (name) => JSON.parse(loaded.get(name).toString("utf8"));
  const captureConfig = json("captureConfig");
  const captureManifest = json("captureManifest");
  invariant(captureConfig.schema === "zugfolge-gtfs-capture/v2", "Nur Capture-Konfigurationen mit gehärtetem Schema sind releasefähig.");
  invariant(captureManifest.schema === "zugfolge-gtfs-capture/v2", "Nur Capture-Manifeste mit exakter Artefaktbindung sind releasefähig.");
  invariant(captureManifest.configArtifactSha256 === artifacts.captureConfig.sha256, "Capture-Manifest ist nicht an die exakten Konfigurationsbytes gebunden.");
  invariant(captureManifest.configSha256 === sha256(canonicalJson(captureConfig)), "Capture-Manifest ist nicht an den kanonischen Konfigurationsinhalt gebunden.");
  invariant(captureManifest.feedUrl === captureConfig.feedUrl, "Capture-Manifest und Feed-URL der Konfiguration stimmen nicht überein.");
  invariant(canonicalJson(captureManifest.source) === canonicalJson(captureConfig.source), "Capture-Manifest und registrierte Quelle der Konfiguration stimmen nicht überein.");
  invariant(captureManifest.archiveSha256 === artifacts.sourceArchive.sha256, "Capture-Manifest und Quellarchiv stimmen nicht überein.");
  invariant(captureManifest.archiveBytes === loaded.get("sourceArchive").length, "Capture-Manifest und Quellarchivgröße stimmen nicht überein.");
  invariant(captureManifest.files.length === artifacts.sourceTables.length, "Artefaktkette enthält nicht exakt alle Capture-Tabellen.");
  for (const [index, table] of artifacts.sourceTables.entries()) {
    const manifestTable = captureManifest.files[index];
    invariant(manifestTable.path === (table.sourcePath ?? table.path) && manifestTable.sha256 === table.sha256, `Capture-Tabelle ${index} stimmt nicht mit dem Manifest überein.`);
    invariant(manifestTable.bytes === loaded.get(`sourceTables[${index}]`).length, `Capture-Tabelle ${manifestTable.path} hat eine andere Größe.`);
  }

  const normalized = json("normalizedObservations");
  invariant(normalized.schema === "zugfolge-normalized-observations/v1", "Unbekanntes Schema der normalisierten Beobachtungen.");
  invariant(normalized.capture.manifestSha256 === artifacts.captureManifest.sha256, "Normalisierte Beobachtungen sind nicht an das Capture-Manifest gebunden.");
  invariant(normalized.capture.configSha256 === artifacts.captureConfig.sha256, "Normalisierte Beobachtungen sind nicht an die Capture-Konfiguration gebunden.");
  invariant(normalized.capture.archiveSha256 === artifacts.sourceArchive.sha256, "Normalisierte Beobachtungen sind nicht an das Quellarchiv gebunden.");
  invariant(normalized.capture.sourceTablesSha256 === sha256(canonicalJson(captureManifest.files)), "Normalisierte Beobachtungen sind nicht an alle Quelltabellen gebunden.");
  invariant(normalized.observationsSha256 === sha256(canonicalJson(normalized.observations)), "Hash der normalisierten Beobachtungen stimmt nicht.");

  const corpus = json("referenceCorpus");
  invariant(corpus.schema === "zugfolge-reference-corpus/v3", "Nur ein gehärteter Referenzkorpus ist releasefähig.");
  invariant(canonicalJson(corpus.source) === canonicalJson(captureConfig.source), "Referenzkorpus und Capture-Quelle stimmen nicht überein.");
  const expectedCorpusBinding = {
    captureConfigSha256: artifacts.captureConfig.sha256,
    captureManifestSha256: artifacts.captureManifest.sha256,
    sourceArchiveSha256: artifacts.sourceArchive.sha256,
    sourceTablesSha256: sha256(canonicalJson(captureManifest.files)),
    normalizedObservationsSha256: artifacts.normalizedObservations.sha256,
    observationsSha256: normalized.observationsSha256,
  };
  exactBindings(corpus.artifactBinding, expectedCorpusBinding, "Referenzkorpus.artifactBinding");

  const evidence = json("qualificationEvidence");
  invariant(canonicalJson(evidence.policy) === canonicalJson(captureConfig.qualificationPolicy), "Qualifikationsmindestmengen stimmen nicht mit der eingefrorenen Capture-Konfiguration überein.");
  sameArtifactRecord(evidence.calibration?.dataset, artifacts.calibrationDataset, "calibration.dataset");
  sameArtifactRecord(evidence.calibration?.config, artifacts.calibrationConfig, "calibration.config");
  sameArtifactRecord(evidence.validation?.dataset, artifacts.validationDataset, "validation.dataset");
  sameArtifactRecord(evidence.validation?.config, artifacts.validationConfig, "validation.config");
  const qualification = await verifyQualificationEvidenceFiles(evidence, rootDirectory);

  const modelConfig = json("modelConfig");
  const expectedBindings = expectedModelBindings(artifacts, corpus, evidence);
  exactBindings(modelConfig.artifactBinding, expectedBindings, "modelConfig.artifactBinding");
  const modelResults = json("modelResults");
  invariant(modelResults.schema === MODEL_RESULTS_SCHEMA, "Nur gehärtete Modellergebnisse sind releasefähig.");
  invariant(modelResults.modelInputSha256 === artifacts.modelConfig.sha256, "Modellergebnis ist nicht an die exakten Modellkonfigurationsbytes gebunden.");
  exactBindings(modelResults.artifactBinding, expectedBindings, "modelResults.artifactBinding");
  invariant(canonicalJson(modelResults.assumptions) === canonicalJson(modelConfig.assumptions), "Modellergebnis und eingefrorene Infrastruktur-/Fahrzeugannahmen stimmen nicht überein.");

  const report = json("report");
  invariant(canonicalJson(report.tolerance) === canonicalJson(captureConfig.tolerance), "Reporttoleranz stimmt nicht mit der eingefrorenen Capture-Konfiguration überein.");
  const expectedReport = compareWithModel(corpus, modelResults, captureConfig.tolerance, {
    corpusArtifactSha256: artifacts.referenceCorpus.sha256,
    modelResultsArtifactSha256: artifacts.modelResults.sha256,
    qualificationEvidenceSha256: artifacts.qualificationEvidence.sha256,
    qualification,
  });
  invariant(canonicalJson(report) === canonicalJson(expectedReport), "Abweichungsreport ist nicht exakt aus den gebundenen Artefakten reproduzierbar.");
  invariant(report.schema === REPORT_SCHEMA && report.passed && report.releaseQualified, "Abweichungsreport qualifiziert den Release nicht.");

  const candidateManifest = json("releaseCandidate");
  invariant(candidateManifest.releaseChecksum === report.releaseChecksum, "Release-Kandidat und Report haben verschiedene Checksummen.");
  invariant(candidateManifest.modelInputSha256 === report.modelInputSha256, "Release-Kandidat und Report haben verschiedene Modelleingaben.");
  if (candidateManifest.modelConfig !== undefined) {
    invariant(canonicalJson(candidateManifest.modelConfig) === canonicalJson(modelConfig), "Eingebettete Modellkonfiguration des Release-Kandidaten stimmt nicht mit dem gebundenen Artefakt überein.");
  }
  const releaseManifest = json("releaseManifest");
  invariant(releaseManifest.schema === QUALIFIED_RELEASE_SCHEMA, "Unbekanntes qualifiziertes Release-Manifest.");
  const expectedReleaseManifest = createQualifiedReleaseManifest({
    candidateManifest,
    candidateManifestArtifact: artifacts.releaseCandidate,
    referenceCorpusArtifact: artifacts.referenceCorpus,
    qualificationEvidenceArtifact: artifacts.qualificationEvidence,
    modelResultsArtifact: artifacts.modelResults,
    report,
    reportBytes: loaded.get("report"),
    reportArtifact: artifacts.report,
    createdAt: releaseManifest.createdAt,
  });
  invariant(canonicalJson(releaseManifest) === canonicalJson(expectedReleaseManifest), "Qualifiziertes Release-Manifest ist nicht exakt aus Report und Kandidat reproduzierbar.");
  return Object.freeze({ chain, report, releaseManifest, qualification });
}

export async function createUnsignedBundleFromFiles(input) {
  timestamp(input.createdAt, "createdAt");
  const chainPath = assertSafeRelativePath(input.chainPath, "chainPath");
  const resolvedChain = resolveArtifact(input.rootDirectory, chainPath, "chainPath");
  await assertRealPathWithinRoot(input.rootDirectory, resolvedChain, "chainPath");
  const chainBytes = await readFile(resolvedChain);
  const chain = JSON.parse(chainBytes.toString("utf8"));
  const verified = await verifyArtifactChainFiles(chain, input.rootDirectory);
  invariant(input.createdAt === verified.releaseManifest.createdAt, "Bundle- und Release-Manifest-Zeitpunkt stimmen nicht überein.");
  const bundle = Object.freeze({
    schema: BUNDLE_SCHEMA,
    chain: Object.freeze({ path: input.chainPath, sha256: sha256(chainBytes) }),
    releaseManifest: Object.freeze({ ...chain.artifacts.releaseManifest }),
    reportSha256: chain.artifacts.report.sha256,
    releaseChecksum: verified.releaseManifest.releaseChecksum,
    createdAt: input.createdAt,
  });
  verifiedBundles.add(bundle);
  return bundle;
}

export function signBundle(bundle, privateKeyPem) {
  invariant(bundle?.schema === BUNDLE_SCHEMA, "Nur eine vollständig geprüfte Artefaktkette darf signiert werden.");
  invariant(verifiedBundles.has(bundle), "Signatur verweigert: Bundle wurde in diesem Prozess nicht vollständig gegen seine Artefakte geprüft.");
  const privateKey = privateKeyPem instanceof KeyObject ? privateKeyPem : createPrivateKey(privateKeyPem);
  invariant(privateKey.type === "private", "Release-Schlüssel muss privat sein.");
  const publicKey = createPublicKey(privateKey);
  invariant(publicKey.asymmetricKeyType === "ed25519", "Nur Ed25519-Release-Schlüssel sind zulässig.");
  const payload = Buffer.from(canonicalJson(bundle));
  return Object.freeze({
    bundle,
    signature: Object.freeze({
      algorithm: "Ed25519",
      publicKeySha256: sha256(publicKey.export({ type: "spki", format: "der" })),
      valueBase64: cryptoSign(null, payload, privateKey).toString("base64"),
    }),
  });
}

export function verifySignedBundle(signedBundle, publicKeyPem) {
  invariant(signedBundle.bundle?.schema === BUNDLE_SCHEMA, "Unbekanntes Bundle-Schema.");
  invariant(signedBundle.signature?.algorithm === "Ed25519", "Nur Ed25519-Signaturen sind zulässig.");
  const publicKey = publicKeyPem instanceof KeyObject && publicKeyPem.type === "public"
    ? publicKeyPem
    : createPublicKey(publicKeyPem);
  invariant(publicKey.asymmetricKeyType === "ed25519", "Nur Ed25519-Release-Schlüssel sind zulässig.");
  invariant(
    signedBundle.signature.publicKeySha256 === sha256(publicKey.export({ type: "spki", format: "der" })),
    "Signatur wurde nicht mit dem erwarteten Release-Schlüssel erstellt.",
  );
  invariant(
    cryptoVerify(
      null,
      Buffer.from(canonicalJson(signedBundle.bundle)),
      publicKey,
      Buffer.from(signedBundle.signature.valueBase64, "base64"),
    ),
    "Signatur des Pilot-Releases ist ungültig.",
  );
  return signedBundle.bundle;
}

export async function verifyBundleFiles(signedBundle, publicKeyPem, rootDirectory) {
  const bundle = verifySignedBundle(signedBundle, publicKeyPem);
  validateArtifactRecord(bundle.chain, "bundle.chain");
  const chainArtifact = await readJsonArtifact(rootDirectory, bundle.chain, "bundle.chain");
  const verified = await verifyArtifactChainFiles(chainArtifact.value, rootDirectory);
  sameArtifactRecord(bundle.releaseManifest, chainArtifact.value.artifacts.releaseManifest, "bundle.releaseManifest");
  invariant(bundle.reportSha256 === chainArtifact.value.artifacts.report.sha256, "Bundle und Report-Artefakt stimmen nicht überein.");
  invariant(bundle.releaseChecksum === verified.releaseManifest.releaseChecksum, "Bundle und qualifiziertes Release-Manifest stimmen nicht überein.");
  invariant(bundle.createdAt === verified.releaseManifest.createdAt, "Bundle- und Release-Manifest-Zeitpunkt stimmen nicht überein.");
  return bundle;
}
