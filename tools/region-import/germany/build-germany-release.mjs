#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildGermanyInfraCorpus } from "./quality-model.mjs";
import { germanyReleaseManifestCompilerArgs } from "./release-manifest-invocation.mjs";

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

async function rustReleaseCompiler(args) {
  const cargo = process.env.CARGO ?? "cargo";
  await new Promise((accept, reject) => {
    const child = spawn(cargo, ["run", "--quiet", "--locked", "-p", "zugfolge-infra", "--bin", "zugfolge-infra-release", "--", ...args], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`Rust-Releasecompiler endete mit Status ${code}.`)));
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === "compile") {
  // Übergangspfad: Die Korpusbildung bleibt bis zur vollständigen Rust-Portierung
  // ausdrücklich nicht releasefähig. Nur `manifest` und `plan` treffen die
  // autoritative Freigabeentscheidung.
  if (process.env.ZUGFOLGE_NON_AUTHORITATIVE_CORPUS_BUILD !== "1") {
    throw new Error("Die JavaScript-Korpusbildung ist nicht autoritativ. Für einen Entwicklungs-Zwischenstand ausdrücklich ZUGFOLGE_NON_AUTHORITATIVE_CORPUS_BUILD=1 setzen; ein InfraRelease darf daraus erst der Rust-Compiler bilden.");
  }
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
  await rustReleaseCompiler(germanyReleaseManifestCompilerArgs(args));
} else if (command === "plan") {
  const [configPath, catalogPath, rightsPath] = args;
  if (!rightsPath) throw new Error("Aufruf: build-germany-release.mjs plan CONFIG CATALOG RIGHTS");
  await rustReleaseCompiler(["plan", ...[configPath, catalogPath, rightsPath].map((path) => resolve(path))]);
} else {
  throw new Error("Befehl fehlt: compile, manifest oder plan.");
}
