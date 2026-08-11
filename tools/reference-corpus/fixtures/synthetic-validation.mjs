import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CORPUS_SCHEMA,
  MODEL_RESULTS_SCHEMA,
  buildReferenceCorpus,
  canonicalJson,
  compareWithModel,
  createNormalizedObservations,
  sha256,
} from "../reference-corpus.mjs";
import {
  ARTIFACT_CHAIN_SCHEMA,
  EVALUATION_CONFIG_SCHEMA,
  QUALIFICATION_EVIDENCE_SCHEMA,
  TECHNICAL_DATASET_SCHEMA,
  createArtifactChainManifest,
  createQualifiedReleaseManifest,
  verifyQualificationEvidenceFiles,
} from "../artifact-chain.mjs";

const FROZEN_AT = "2026-08-10T00:00:00.000Z";

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function writeJson(root, relativePath, value) {
  const bytes = jsonBytes(value);
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), bytes);
  return { path: relativePath, sha256: sha256(bytes), bytes, value };
}

async function writeBytes(root, relativePath, bytes) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), bytes);
  return { path: relativePath, sha256: sha256(bytes), bytes };
}

function observationSeries(trainCategory, durations) {
  return durations.map((duration, index) => ({
    sourceId: "synthetic-gtfs",
    tripId: `${trainCategory}-${index}`,
    serviceDate: `2026-08-${String(index + 10).padStart(2, "0")}`,
    routeId: "synthetic-lhe",
    fromEva: "fixture-leipzig",
    toEva: "fixture-halle",
    direction: "Halle",
    stopPattern: `Leipzig|${trainCategory}|Halle`,
    characteristicsId: "synthetic-emu-v1",
    trainCategory,
    trainNumber: `${trainCategory}-${index}`,
    plannedDepartureEpochSeconds: 1_000_000 + index * 86_400,
    plannedArrivalEpochSeconds: 1_000_000 + index * 86_400 + duration,
    scheduledDwellSeconds: 10,
  }));
}

function sampleIds(samples) {
  return samples.map((sample) => sample.id).sort();
}

function partition(purpose, datasetId, datasetArtifact, configId, configArtifact, samples) {
  const ids = sampleIds(samples);
  return {
    purpose,
    datasetId,
    dataset: { path: datasetArtifact.path, sha256: datasetArtifact.sha256 },
    configId,
    config: { path: configArtifact.path, sha256: configArtifact.sha256 },
    frozenAt: FROZEN_AT,
    sampleIds: ids,
    sampleIdsSha256: sha256(canonicalJson(ids)),
  };
}

export async function materializeSyntheticValidationFixture(rootDirectory) {
  const root = path.resolve(rootDirectory);
  await mkdir(root, { recursive: true });
  const source = {
    id: "synthetic-gtfs",
    sourceLicense: "CC0-1.0",
    attribution: "Synthetische Testdaten des Zugfolge-Testharnischs",
    retrievedAt: FROZEN_AT,
    apiVersion: "fixture-v1",
  };
  const captureConfigValue = {
    schema: "zugfolge-gtfs-capture/v2",
    feedUrl: "https://invalid.example.test/synthetic.zip",
    timeZone: "Europe/Berlin",
    region: "Leipzig–Halle–Erfurt (synthetisch)",
    schedulePeriod: "fixture-2026",
    generatedAt: FROZEN_AT,
    minimumSamples: 5,
    serviceDates: ["20260810", "20260811", "20260812", "20260813", "20260814"],
    comparisons: [],
    source,
    tolerance: { absoluteSeconds: 30, relativeBasisPoints: 500 },
    qualificationPolicy: { minimumCalibrationSamples: 2, minimumValidationSamples: 2 },
  };
  const captureConfig = await writeJson(root, "capture-config.json", captureConfigValue);
  const archive = await writeBytes(root, "raw/feed.zip", Buffer.from("synthetic GTFS archive fixture\n"));
  const tableContents = new Map([
    ["agency.txt", "agency_id,agency_name\nfixture,Zugfolge fixture\n"],
    ["stops.txt", "stop_id,stop_name\nL,Leipzig\nH,Halle\n"],
    ["routes.txt", "route_id,route_short_name\nr,SYN\n"],
    ["trips.txt", "route_id,service_id,trip_id\nr,weekday,fixture\n"],
    ["stop_times.txt", "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nfixture,10:00:00,10:00:00,L,1\nfixture,10:10:00,10:10:00,H,2\n"],
  ]);
  const tableArtifacts = [];
  for (const [tablePath, content] of tableContents) {
    const artifact = await writeBytes(root, path.join("raw", tablePath), Buffer.from(content));
    tableArtifacts.push({ path: tablePath, sha256: artifact.sha256, bytes: artifact.bytes.length });
  }
  const captureManifestValue = {
    schema: "zugfolge-gtfs-capture/v2",
    capturedAt: FROZEN_AT,
    feedUrl: captureConfigValue.feedUrl,
    archiveSha256: archive.sha256,
    archiveBytes: archive.bytes.length,
    configSha256: sha256(canonicalJson(captureConfigValue)),
    configArtifactSha256: captureConfig.sha256,
    source,
    files: tableArtifacts,
  };
  const captureManifest = await writeJson(root, "capture-manifest.json", captureManifestValue);
  const normalizedValue = createNormalizedObservations({
    observations: [
      ...observationSeries("SYN-A", [620, 625, 630, 635, 640]),
      ...observationSeries("SYN-B", [680, 685, 690, 695, 700]),
    ],
    captureManifest: captureManifestValue,
    captureManifestSha256: captureManifest.sha256,
    captureConfigSha256: captureConfig.sha256,
  });
  const normalized = await writeJson(root, "normalized-observations.json", normalizedValue);
  const corpusValue = buildReferenceCorpus({
    region: captureConfigValue.region,
    schedulePeriod: captureConfigValue.schedulePeriod,
    generatedAt: FROZEN_AT,
    minimumSamples: captureConfigValue.minimumSamples,
    source,
    normalizedObservations: normalizedValue,
    normalizedObservationsSha256: normalized.sha256,
  });
  if (corpusValue.schema !== CORPUS_SCHEMA) throw new Error("Synthetischer Korpus wurde nicht gehärtet.");
  const corpus = await writeJson(root, "reference-corpus.json", corpusValue);

  const calibrationSamples = corpusValue.groups.map((group, index) => ({
    id: `calibration-${index + 1}`,
    groupId: group.id,
    characteristicsId: group.characteristicsId,
    sourceId: "synthetic-calibration-source",
    technicalRunningSeconds: index === 0 ? 590 : 650,
  }));
  const validationSamples = corpusValue.groups.map((group, index) => ({
    id: `validation-${index + 1}`,
    groupId: group.id,
    characteristicsId: group.characteristicsId,
    sourceId: "synthetic-independent-validation-source",
    technicalRunningSeconds: index === 0 ? 610 : 670,
  }));
  const calibrationDatasetValue = {
    schema: TECHNICAL_DATASET_SCHEMA,
    purpose: "calibration",
    datasetId: "synthetic-calibration-dataset-v1",
    frozenAt: FROZEN_AT,
    source: {
      id: "synthetic-calibration-source",
      sourceLicense: "CC0-1.0",
      attribution: "Synthetische Kalibrierungsdaten des Zugfolge-Testharnischs",
      retrievedAt: FROZEN_AT,
      method: "deterministische Testfixture",
    },
    samples: calibrationSamples,
  };
  const validationDatasetValue = {
    schema: TECHNICAL_DATASET_SCHEMA,
    purpose: "validation",
    datasetId: "synthetic-validation-dataset-v1",
    frozenAt: FROZEN_AT,
    source: {
      id: "synthetic-independent-validation-source",
      sourceLicense: "CC0-1.0",
      attribution: "Synthetischer unabhängiger Holdout des Zugfolge-Testharnischs",
      retrievedAt: FROZEN_AT,
      method: "deterministische Testfixture",
    },
    samples: validationSamples,
  };
  const calibrationDataset = await writeJson(root, "evidence/calibration-dataset.json", calibrationDatasetValue);
  const validationDataset = await writeJson(root, "evidence/validation-dataset.json", validationDatasetValue);
  const calibrationConfigValue = {
    schema: EVALUATION_CONFIG_SCHEMA,
    purpose: "calibration",
    configId: "synthetic-calibration-config-v1",
    frozenAt: FROZEN_AT,
    datasetSha256: calibrationDataset.sha256,
    method: "synthetic-grid-search-v1",
  };
  const validationConfigValue = {
    schema: EVALUATION_CONFIG_SCHEMA,
    purpose: "validation",
    configId: "synthetic-validation-config-v1",
    frozenAt: FROZEN_AT,
    datasetSha256: validationDataset.sha256,
    method: "synthetic-holdout-evaluation-v1",
  };
  const calibrationConfig = await writeJson(root, "evidence/calibration-config.json", calibrationConfigValue);
  const validationConfig = await writeJson(root, "evidence/validation-config.json", validationConfigValue);
  const evidenceValue = {
    schema: QUALIFICATION_EVIDENCE_SCHEMA,
    frozenAt: FROZEN_AT,
    policy: captureConfigValue.qualificationPolicy,
    calibration: partition(
      "calibration",
      calibrationDatasetValue.datasetId,
      calibrationDataset,
      calibrationConfigValue.configId,
      calibrationConfig,
      calibrationSamples,
    ),
    validation: partition(
      "validation",
      validationDatasetValue.datasetId,
      validationDataset,
      validationConfigValue.configId,
      validationConfig,
      validationSamples,
    ),
  };
  const evidence = await writeJson(root, "qualification-evidence.json", evidenceValue);
  const artifactBinding = {
    ...corpusValue.artifactBinding,
    referenceCorpusSha256: corpus.sha256,
    qualificationEvidenceSha256: evidence.sha256,
    calibrationDatasetSha256: calibrationDataset.sha256,
    calibrationConfigSha256: calibrationConfig.sha256,
    validationDatasetSha256: validationDataset.sha256,
    validationConfigSha256: validationConfig.sha256,
  };
  const assumptions = {
    infrastructure: ["Synthetisches, unveränderliches Infrastrukturprofil für den Positivtest."],
    vehicle: ["Synthetische, unveränderliche Zugcharakteristik für den Positivtest."],
  };
  const modelConfigValue = {
    schema: "zugfolge-synthetic-model-config/v1",
    artifactBinding,
    method: "deterministic-synthetic-validation-v1",
    assumptions,
  };
  const modelConfig = await writeJson(root, "model/model-config.json", modelConfigValue);
  const releaseChecksum = "b".repeat(64);
  const modelResultsValue = {
    schema: MODEL_RESULTS_SCHEMA,
    releaseChecksum,
    modelInputSha256: modelConfig.sha256,
    artifactBinding,
    assumptions,
    results: corpusValue.groups.map((group, index) => {
      const runningSeconds = index === 0 ? 612 : 668;
      return {
        groupId: group.id,
        characteristicsId: group.characteristicsId,
        calibrationMethod: "synthetic-grid-search-v1",
        validationSampleId: validationSamples[index].id,
        rawRunningSeconds: runningSeconds - 20,
        runningSeconds,
        dwellSeconds: 10,
        modeledTimetableSeconds: runningSeconds + 10,
        technicalReferenceSeconds: validationSamples[index].technicalRunningSeconds,
      };
    }),
  };
  const modelResults = await writeJson(root, "model/model-results.json", modelResultsValue);
  const qualification = await verifyQualificationEvidenceFiles(evidenceValue, root);
  const reportValue = compareWithModel(corpusValue, modelResultsValue, captureConfigValue.tolerance, {
    corpusArtifactSha256: corpus.sha256,
    modelResultsArtifactSha256: modelResults.sha256,
    qualificationEvidenceSha256: evidence.sha256,
    qualification,
  });
  const report = await writeJson(root, "deviation-report.json", reportValue);
  const releaseCandidateValue = {
    schema: "zugfolge-infra-release-manifest/v1",
    releaseChecksum,
    modelInputSha256: modelConfig.sha256,
    confidence: "derived",
  };
  const releaseCandidate = await writeJson(root, "release/release-candidate.json", releaseCandidateValue);
  const releaseManifestValue = createQualifiedReleaseManifest({
    candidateManifest: releaseCandidateValue,
    candidateManifestArtifact: { path: releaseCandidate.path, sha256: releaseCandidate.sha256 },
    referenceCorpusArtifact: { path: corpus.path, sha256: corpus.sha256 },
    qualificationEvidenceArtifact: { path: evidence.path, sha256: evidence.sha256 },
    modelResultsArtifact: { path: modelResults.path, sha256: modelResults.sha256 },
    report: reportValue,
    reportBytes: report.bytes,
    reportArtifact: { path: report.path, sha256: report.sha256 },
    createdAt: FROZEN_AT,
  });
  const releaseManifest = await writeJson(root, "release/qualified-release-manifest.json", releaseManifestValue);
  const artifactPaths = {
    captureConfig: captureConfig.path,
    captureManifest: captureManifest.path,
    sourceArchive: archive.path,
    sourceTableDirectory: "raw",
    normalizedObservations: normalized.path,
    referenceCorpus: corpus.path,
    qualificationEvidence: evidence.path,
    modelConfig: modelConfig.path,
    modelResults: modelResults.path,
    report: report.path,
    releaseCandidate: releaseCandidate.path,
    releaseManifest: releaseManifest.path,
  };
  const chainValue = await createArtifactChainManifest(artifactPaths, root);
  if (chainValue.schema !== ARTIFACT_CHAIN_SCHEMA) throw new Error("Synthetische Artefaktkette hat das falsche Schema.");
  const chain = await writeJson(root, "release-chain.json", chainValue);
  return Object.freeze({
    root,
    frozenAt: FROZEN_AT,
    artifactPaths,
    artifacts: Object.freeze({
      captureConfig,
      captureManifest,
      archive,
      tableArtifacts,
      normalized,
      corpus,
      calibrationDataset,
      calibrationConfig,
      validationDataset,
      validationConfig,
      evidence,
      modelConfig,
      modelResults,
      report,
      releaseCandidate,
      releaseManifest,
      chain,
    }),
    values: Object.freeze({
      corpus: corpusValue,
      evidence: evidenceValue,
      modelResults: modelResultsValue,
      report: reportValue,
      chain: chainValue,
    }),
  });
}

export async function readFixtureJson(rootDirectory, relativePath) {
  return JSON.parse(await readFile(path.join(rootDirectory, relativePath), "utf8"));
}
