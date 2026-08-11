#!/usr/bin/env node

// zugfolge:quelle=gtfs-de-rv
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildGtfsPlanningSnapshot, createGtfsPlanningEnvelope } from "@zugfolge/gtfs";

import {
  buildReferenceCorpus,
  canonicalJson,
  compareWithModel,
  createNormalizedObservations,
  NORMALIZED_OBSERVATIONS_SCHEMA,
  sha256,
  verifyRegisteredSource,
} from "./reference-corpus.mjs";
import {
  createArtifactChainManifest,
  createQualifiedReleaseManifest,
  createUnsignedBundleFromFiles,
  signBundle,
  verifyArtifactChainFiles,
  verifyBundleFiles,
  verifyQualificationEvidenceFiles,
  verifySignedBundle,
} from "./artifact-chain.mjs";
import { captureGtfsFeed, loadCapturedGtfsTables, normalizeCapturedGtfs } from "./gtfs.mjs";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonArtifact(file) {
  const bytes = await readFile(file);
  return { bytes, value: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveWithinRoot(rootDirectory, relativePath, name) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) throw new Error(`${name} muss relativ zum Artefaktordner sein.`);
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${name} darf den Artefaktordner nicht verlassen.`);
  }
  return resolved;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "capture-gtfs") {
    const [configFile, outputDirectory, manifestFile] = args;
    if (!manifestFile) throw new Error("Aufruf: capture-gtfs CONFIG ROHDATEN_ORDNER MANIFEST");
    const configArtifact = await readJsonArtifact(configFile);
    const config = configArtifact.value;
    const registry = await readJson(path.resolve("tools/guards/quellenregister.json"));
    verifyRegisteredSource(registry, config.source);
    const result = await captureGtfsFeed(config, {
      outputDirectory,
      fetchImpl: fetch,
      configArtifactSha256: configArtifact.sha256,
    });
    await writeJson(manifestFile, result.manifest);
    console.log(`GTFS-ZIP und ${result.manifest.files.length} Tabellen erfasst; Manifest ${result.manifestSha256}.`);
    return;
  }
  if (mode === "normalize-gtfs") {
    const [configFile, manifestFile, rawDirectory, observationsFile] = args;
    if (!observationsFile) throw new Error("Aufruf: normalize-gtfs CONFIG MANIFEST ROHDATEN_ORDNER OBSERVATIONS");
    const [configArtifact, manifestArtifact] = await Promise.all([
      readJsonArtifact(configFile),
      readJsonArtifact(manifestFile),
    ]);
    const observations = await normalizeCapturedGtfs(
      configArtifact.value,
      manifestArtifact.value,
      rawDirectory,
    );
    const normalized = createNormalizedObservations({
      observations,
      captureManifest: manifestArtifact.value,
      captureManifestSha256: manifestArtifact.sha256,
      captureConfigSha256: configArtifact.sha256,
    });
    await writeJson(observationsFile, normalized);
    console.log(`${observations.length} vergleichbare Fahrplanläufe normalisiert.`);
    return;
  }
  if (mode === "plan-gtfs") {
    const [captureConfigFile, planningConfigFile, manifestFile, rawDirectory, outputFile] = args;
    if (!outputFile) throw new Error("Aufruf: plan-gtfs CAPTURE_CONFIG PLANNING_CONFIG MANIFEST ROHDATEN_ORDNER OUTPUT");
    const captureConfig = await readJson(captureConfigFile);
    const planningConfig = await readJson(planningConfigFile);
    const manifest = await readJson(manifestFile);
    const registry = await readJson(path.resolve("tools/guards/quellenregister.json"));
    verifyRegisteredSource(registry, captureConfig.source);
    const snapshot = buildGtfsPlanningSnapshot({
      ...planningConfig,
      serviceDates: planningConfig.serviceDates ?? captureConfig.serviceDates,
      source: {
        sourceId: captureConfig.source.id,
        feedUrl: captureConfig.feedUrl,
        archiveSha256: manifest.archiveSha256,
        capturedAt: manifest.capturedAt,
        timeZone: captureConfig.timeZone,
        sourceLicense: captureConfig.source.sourceLicense,
        attribution: captureConfig.source.attribution,
      },
      tables: await loadCapturedGtfsTables(captureConfig, manifest, rawDirectory),
    });
    const envelope = createGtfsPlanningEnvelope(snapshot);
    await writeJson(outputFile, envelope);
    console.log(`${snapshot.patterns.length} Service-Patterns und ${snapshot.lots.length} Lose geplant; Snapshot ${envelope.snapshotHash}.`);
    return;
  }
  if (mode === "build") {
    const [configFile, observationsFile, modelFile, corpusFile, reportFile] = args;
    if (!reportFile) throw new Error("Aufruf: build CONFIG OBSERVATIONS MODEL CORPUS REPORT");
    const config = await readJson(configFile);
    const observations = await readJson(observationsFile);
    const registry = await readJson(path.resolve("tools/guards/quellenregister.json"));
    verifyRegisteredSource(registry, config.source);
    const corpus = buildReferenceCorpus({ ...config, observations });
    const report = compareWithModel(corpus, await readJson(modelFile), config.tolerance);
    await writeJson(corpusFile, corpus);
    await writeJson(reportFile, report);
    if (!report.passed) throw new Error("Fahrzeitvergleich liegt außerhalb der dokumentierten Toleranz.");
    console.log(
      `${corpus.groups.length} Referenzgruppen, technischer Vergleich bestanden; ` +
        `Release-Freigabe: ${report.releaseQualified ? "ja" : "nein"}.`,
    );
    return;
  }
  if (mode === "build-corpus") {
    const [configFile, normalizedFile, corpusFile] = args;
    if (!corpusFile) throw new Error("Aufruf: build-corpus CONFIG NORMALIZED_OBSERVATIONS CORPUS");
    const [config, normalizedArtifact] = await Promise.all([
      readJson(configFile),
      readJsonArtifact(normalizedFile),
    ]);
    if (normalizedArtifact.value.schema !== NORMALIZED_OBSERVATIONS_SCHEMA) throw new Error("Unbekanntes Schema der normalisierten Beobachtungen.");
    const registry = await readJson(path.resolve("tools/guards/quellenregister.json"));
    verifyRegisteredSource(registry, config.source);
    const corpus = buildReferenceCorpus({
      ...config,
      normalizedObservations: normalizedArtifact.value,
      normalizedObservationsSha256: normalizedArtifact.sha256,
    });
    await writeJson(corpusFile, corpus);
    console.log(`${corpus.groups.length} gehärtete Referenzgruppen geschrieben.`);
    return;
  }
  if (mode === "compare") {
    const [configFile, corpusFile, modelFile, fourth, fifth, sixth] = args;
    if (!fourth) throw new Error("Aufruf: compare CONFIG CORPUS MODEL [QUALIFICATION_EVIDENCE ARTIFACT_ROOT] REPORT");
    const config = await readJson(configFile);
    const registry = await readJson(path.resolve("tools/guards/quellenregister.json"));
    verifyRegisteredSource(registry, config.source);
    const [corpusArtifact, modelArtifact] = await Promise.all([
      readJsonArtifact(corpusFile),
      readJsonArtifact(modelFile),
    ]);
    const hardened = corpusArtifact.value.schema === "zugfolge-reference-corpus/v3";
    const reportFile = hardened ? sixth : fourth;
    if (!reportFile) throw new Error("Gehärteter Vergleich: compare CONFIG CORPUS MODEL QUALIFICATION_EVIDENCE ARTIFACT_ROOT REPORT");
    let context;
    if (hardened) {
      const evidenceArtifact = await readJsonArtifact(fourth);
      context = {
        corpusArtifactSha256: corpusArtifact.sha256,
        modelResultsArtifactSha256: modelArtifact.sha256,
        qualificationEvidenceSha256: evidenceArtifact.sha256,
        qualification: await verifyQualificationEvidenceFiles(evidenceArtifact.value, path.resolve(fifth)),
      };
    }
    const report = compareWithModel(corpusArtifact.value, modelArtifact.value, config.tolerance, context);
    await writeJson(reportFile, report);
    if (!report.passed) throw new Error("Fahrzeitvergleich liegt außerhalb der dokumentierten Toleranz.");
    console.log(
      `${corpus.groups.length} Referenzgruppen, technischer Vergleich bestanden; ` +
        `Release-Freigabe: ${report.releaseQualified ? "ja" : "nein"}.`,
    );
    return;
  }
  if (mode === "finalize-release") {
    const [finalizeConfigFile, rootDirectory, outputFile] = args;
    if (!outputFile) throw new Error("Aufruf: finalize-release FINALIZE_CONFIG ARTIFACT_ROOT OUTPUT");
    const finalizeConfig = await readJson(finalizeConfigFile);
    const root = path.resolve(rootDirectory);
    const artifact = async (relativePath) => {
      const loaded = await readJsonArtifact(resolveWithinRoot(root, relativePath, "Artefaktpfad"));
      return { ...loaded, record: { path: relativePath, sha256: loaded.sha256 } };
    };
    const [candidate, corpus, evidence, model, report] = await Promise.all([
      artifact(finalizeConfig.candidateManifest),
      artifact(finalizeConfig.referenceCorpus),
      artifact(finalizeConfig.qualificationEvidence),
      artifact(finalizeConfig.modelResults),
      artifact(finalizeConfig.report),
    ]);
    const releaseManifest = createQualifiedReleaseManifest({
      candidateManifest: candidate.value,
      candidateManifestArtifact: candidate.record,
      referenceCorpusArtifact: corpus.record,
      qualificationEvidenceArtifact: evidence.record,
      modelResultsArtifact: model.record,
      report: report.value,
      reportBytes: report.bytes,
      reportArtifact: report.record,
      createdAt: finalizeConfig.createdAt,
    });
    await writeJson(outputFile, releaseManifest);
    console.log(`Qualifiziertes Release-Manifest geschrieben: ${outputFile}`);
    return;
  }
  if (mode === "chain") {
    const [pathsFile, rootDirectory, outputFile] = args;
    if (!outputFile) throw new Error("Aufruf: chain ARTIFACT_PATHS ARTIFACT_ROOT OUTPUT");
    const chain = await createArtifactChainManifest(await readJson(pathsFile), path.resolve(rootDirectory));
    await verifyArtifactChainFiles(chain, path.resolve(rootDirectory));
    await writeJson(outputFile, chain);
    console.log(`Artefaktkette geschrieben: ${outputFile}`);
    return;
  }
  if (mode === "sign") {
    const [chainFile, rootDirectory, privateKeyFile, createdAt, outputFile] = args;
    if (!outputFile) throw new Error("Aufruf: sign CHAIN ARTIFACT_ROOT PRIVATE_KEY CREATED_AT OUTPUT");
    const root = path.resolve(rootDirectory);
    const chainPath = path.relative(root, path.resolve(chainFile));
    const unsigned = await createUnsignedBundleFromFiles({
      chainPath,
      rootDirectory: root,
      createdAt,
    });
    await writeJson(outputFile, signBundle(unsigned, await readFile(privateKeyFile, "utf8")));
    console.log(`Signiertes Bundle: ${outputFile}`);
    return;
  }
  if (mode === "verify") {
    const [bundleFile, publicKeyFile, rootDirectory = path.dirname(bundleFile)] = args;
    if (!publicKeyFile) throw new Error("Aufruf: verify BUNDLE PUBLIC_KEY [ARTEFAKT_ORDNER]");
    const signed = await readJson(bundleFile);
    await verifyBundleFiles(signed, await readFile(publicKeyFile, "utf8"), path.resolve(rootDirectory));
    console.log(`Signatur und Artefakt-Hash sind gültig: ${signed.signature.publicKeySha256}`);
    return;
  }
  if (mode === "verify-signature") {
    const [bundleFile, publicKeyFile] = args;
    verifySignedBundle(await readJson(bundleFile), await readFile(publicKeyFile, "utf8"));
    console.log("Signatur ist gültig.");
    return;
  }
  if (mode === "hash") {
    const [file] = args;
    console.log(sha256(await readFile(file)));
    return;
  }
  if (mode === "canonical") {
    const [file] = args;
    console.log(canonicalJson(await readJson(file)));
    return;
  }
  throw new Error("Modus: capture-gtfs | normalize-gtfs | plan-gtfs | build | build-corpus | compare | finalize-release | chain | sign | verify | verify-signature | hash | canonical");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
