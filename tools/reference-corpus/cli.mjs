#!/usr/bin/env node

// zugfolge:quelle=gtfs-de-rv
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildGtfsPlanningSnapshot, createGtfsPlanningEnvelope } from "@zugfolge/gtfs";

import {
  buildReferenceCorpus,
  canonicalJson,
  compareWithModel,
  createUnsignedBundle,
  sha256,
  signBundle,
  verifyBundleFiles,
  verifyRegisteredSource,
  verifySignedBundle,
} from "./reference-corpus.mjs";
import { captureGtfsFeed, loadCapturedGtfsTables, normalizeCapturedGtfs } from "./gtfs.mjs";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "capture-gtfs") {
    const [configFile, outputDirectory, manifestFile] = args;
    if (!manifestFile) throw new Error("Aufruf: capture-gtfs CONFIG ROHDATEN_ORDNER MANIFEST");
    const config = await readJson(configFile);
    const registry = await readJson(path.resolve("tools/guards/quellenregister.json"));
    verifyRegisteredSource(registry, config.source);
    const result = await captureGtfsFeed(config, {
      outputDirectory,
      fetchImpl: fetch,
    });
    await writeJson(manifestFile, result.manifest);
    console.log(`GTFS-ZIP und ${result.manifest.files.length} Tabellen erfasst; Manifest ${result.manifestSha256}.`);
    return;
  }
  if (mode === "normalize-gtfs") {
    const [configFile, manifestFile, rawDirectory, observationsFile] = args;
    if (!observationsFile) throw new Error("Aufruf: normalize-gtfs CONFIG MANIFEST ROHDATEN_ORDNER OBSERVATIONS");
    const observations = await normalizeCapturedGtfs(
      await readJson(configFile),
      await readJson(manifestFile),
      rawDirectory,
    );
    await writeJson(observationsFile, observations);
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
    console.log(`${corpus.groups.length} Referenzgruppen, technischer Vergleich bestanden.`);
    return;
  }
  if (mode === "compare") {
    const [configFile, corpusFile, modelFile, reportFile] = args;
    if (!reportFile) throw new Error("Aufruf: compare CONFIG CORPUS MODEL REPORT");
    const config = await readJson(configFile);
    const registry = await readJson(path.resolve("tools/guards/quellenregister.json"));
    verifyRegisteredSource(registry, config.source);
    const corpus = await readJson(corpusFile);
    const report = compareWithModel(corpus, await readJson(modelFile), config.tolerance);
    await writeJson(reportFile, report);
    if (!report.passed) throw new Error("Fahrzeitvergleich liegt außerhalb der dokumentierten Toleranz.");
    console.log(`${corpus.groups.length} Referenzgruppen, technischer Vergleich bestanden.`);
    return;
  }
  if (mode === "sign") {
    const [corpusFile, reportFile, releaseFile, privateKeyFile, outputFile] = args;
    if (!outputFile) throw new Error("Aufruf: sign CORPUS REPORT RELEASE PRIVATE_KEY OUTPUT");
    const corpus = await readJson(corpusFile);
    const report = await readJson(reportFile);
    const release = await readFile(releaseFile);
    const unsigned = createUnsignedBundle({
      corpus,
      report,
      releasePath: path.basename(releaseFile),
      releaseSha256: sha256(release),
      createdAt: new Date().toISOString(),
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
  throw new Error("Modus: capture-gtfs | normalize-gtfs | plan-gtfs | build | compare | sign | verify | verify-signature | hash | canonical");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
