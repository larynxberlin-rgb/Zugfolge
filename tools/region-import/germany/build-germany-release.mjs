#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import { buildGermanyInfraCorpus } from "./quality-model.mjs";
import { buildAnnualPlan, buildPublicInfraRelease } from "./release-manifest.mjs";

async function json(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function jsonSequence(path) {
  if (path === "-") return [];
  const values = [];
  for await (const raw of createInterface({ input: createReadStream(resolve(path), "utf8"), crlfDelay: Infinity })) {
    const line = raw.replace(/^\x1e/, "").trim();
    if (line !== "") values.push(JSON.parse(line));
  }
  return values;
}

async function output(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sequence(path, values) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), values.map((value) => `\x1e${JSON.stringify(value)}\n`).join(""), "utf8");
}

const [command, ...args] = process.argv.slice(2);
if (command === "compile") {
  const [configPath, pbfReportPath, wayFeaturesPath, validationPath, corpusPath, qualityPath, internalEvidencePath] = args;
  if (!internalEvidencePath) throw new Error("Aufruf: build-germany-release.mjs compile CONFIG PBF_REPORT WAYS.geojsonseq VALIDATION.jsonseq|- CORPUS.jsonseq QUALITY.json INTERNAL_EVIDENCE.json");
  const [config, pbfReport, wayFeatures, validationReceipts] = await Promise.all([
    json(configPath), json(pbfReportPath), jsonSequence(wayFeaturesPath), jsonSequence(validationPath),
  ]);
  const result = buildGermanyInfraCorpus({ pbfReport, wayFeatures, validationReceipts, policy: config.quality.safeAssumptions });
  await Promise.all([
    sequence(corpusPath, result.corpus.sections),
    output(qualityPath, { report: result.qualityReport, reportHash: result.qualityReportHash, corpusHash: result.corpusHash }),
    output(internalEvidencePath, result.internalEvidenceBindings),
  ]);
  process.stdout.write(`${JSON.stringify({ sections: result.corpus.sections.length, corpusHash: result.corpusHash, qualityReportHash: result.qualityReportHash })}\n`);
} else if (command === "manifest") {
  const [configPath, catalogPath, rightsPath, capturePath, artifactsPath, qualityPath, outputPath] = args;
  if (!outputPath) throw new Error("Aufruf: build-germany-release.mjs manifest CONFIG CATALOG RIGHTS CAPTURE ARTIFACTS QUALITY OUTPUT");
  const [config, catalog, rightsRegistry, capture, artifacts, qualityEnvelope] = await Promise.all([
    json(configPath), json(catalogPath), json(rightsPath), json(capturePath), json(artifactsPath), json(qualityPath),
  ]);
  const result = buildPublicInfraRelease({
    config,
    catalog,
    rightsRegistry,
    capture,
    artifacts: artifacts.artifacts,
    qualityReport: qualityEnvelope.report ?? qualityEnvelope,
  });
  await output(outputPath, result);
  process.stdout.write(`${JSON.stringify({ releaseId: result.release.releaseId, releaseHash: result.releaseHash })}\n`);
} else if (command === "plan") {
  const [configPath, catalogPath, rightsPath] = args;
  if (!rightsPath) throw new Error("Aufruf: build-germany-release.mjs plan CONFIG CATALOG RIGHTS");
  process.stdout.write(`${JSON.stringify(buildAnnualPlan(await json(configPath), await json(catalogPath), await json(rightsPath)), null, 2)}\n`);
} else {
  throw new Error("Befehl fehlt: compile, manifest oder plan.");
}
