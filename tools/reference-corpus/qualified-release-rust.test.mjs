import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { qualifiedReleaseFromRust, referenceReportFromRust } from "./artifact-chain.mjs";
import { materializeSyntheticValidationFixture } from "./fixtures/synthetic-validation.mjs";
import { canonicalJson, sha256 } from "./reference-corpus.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function compilerInput(fixture) {
  const artifact = (value) => ({
    record: { path: value.path, sha256: value.sha256 },
    bytes: value.bytes,
  });
  return {
    createdAt: fixture.frozenAt,
    artifacts: {
      captureConfig: artifact(fixture.artifacts.captureConfig),
      referenceCorpus: artifact(fixture.artifacts.corpus),
      qualificationEvidence: artifact(fixture.artifacts.evidence),
      calibrationDataset: artifact(fixture.artifacts.calibrationDataset),
      calibrationConfig: artifact(fixture.artifacts.calibrationConfig),
      validationDataset: artifact(fixture.artifacts.validationDataset),
      validationConfig: artifact(fixture.artifacts.validationConfig),
      modelConfig: artifact(fixture.artifacts.modelConfig),
      modelResults: artifact(fixture.artifacts.modelResults),
      report: artifact(fixture.artifacts.report),
      candidateManifest: artifact(fixture.artifacts.releaseCandidate),
    },
  };
}

async function runCli(args) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [path.join(root, "tools/reference-corpus/cli.mjs"), ...args], {
      cwd: root,
      stdio: "ignore",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`Referenzkorpus-CLI endete mit ${code}.`)));
  });
}

async function runCliResult(args) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [path.join(root, "tools/reference-corpus/cli.mjs"), ...args], {
      cwd: root,
      stdio: "ignore",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", accept);
  });
}

test("JavaScript delegiert die Referenzrelease-Qualifikation byteidentisch an Rust", { timeout: 120_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zugfolge-qualified-release-direct-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await materializeSyntheticValidationFixture(directory);
  const result = qualifiedReleaseFromRust(compilerInput(fixture));
  const golden = JSON.parse(await readFile(path.join(directory, fixture.artifacts.releaseManifest.path), "utf8"));
  assert.deepEqual(result, golden);
  assert.equal(canonicalJson(result), canonicalJson(golden));
});

test("Rust verweigert manipulierte Kandidat-, Korpus-, Nachweis- und Modellbytes", { timeout: 120_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zugfolge-qualified-release-tamper-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await materializeSyntheticValidationFixture(directory);
  for (const name of ["candidateManifest", "referenceCorpus", "qualificationEvidence", "modelResults"]) {
    const input = compilerInput(fixture);
    input.artifacts[name] = { ...input.artifacts[name], bytes: Buffer.from("{}") };
    assert.throws(() => qualifiedReleaseFromRust(input), /Artefakthash/);
  }
});

test("produktiver v3-Report ist byteidentisch aus Rust und ein Fehlmodell bleibt failed", { timeout: 120_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zugfolge-reference-report-rust-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await materializeSyntheticValidationFixture(directory);
  const expected = JSON.parse(await readFile(path.join(directory, fixture.artifacts.report.path), "utf8"));
  const input = compilerInput(fixture);
  assert.equal(canonicalJson(referenceReportFromRust(input)), canonicalJson(expected));
  const cliReportPath = path.join(directory, "cli-report.json");
  const compareArguments = [
    "compare",
    path.join(directory, fixture.artifacts.captureConfig.path),
    path.join(directory, fixture.artifacts.corpus.path),
    path.join(directory, fixture.artifacts.modelConfig.path),
    path.join(directory, fixture.artifacts.modelResults.path),
    path.join(directory, fixture.artifacts.evidence.path),
    directory,
  ];
  await runCli([...compareArguments, cliReportPath]);
  assert.equal(canonicalJson(JSON.parse(await readFile(cliReportPath, "utf8"))), canonicalJson(expected));

  const failed = JSON.parse(fixture.artifacts.modelResults.bytes.toString("utf8"));
  failed.results[0].runningSeconds += 1_000;
  failed.results[0].modeledTimetableSeconds += 1_000;
  const failedBytes = Buffer.from(`${JSON.stringify(failed, null, 2)}\n`);
  input.artifacts.modelResults = {
    record: { path: fixture.artifacts.modelResults.path, sha256: sha256(failedBytes) },
    bytes: failedBytes,
  };
  const report = referenceReportFromRust(input);
  assert.equal(report.passed, false);
  assert.equal(report.releaseQualified, false);

  await writeFile(path.join(directory, fixture.artifacts.modelResults.path), failedBytes);
  const outputPath = path.join(directory, "failed-report.json");
  const code = await runCliResult([...compareArguments, outputPath]);
  assert.notEqual(code, 0, "CLI muss den von Rust erzeugten failed-Report ablehnen");
  assert.equal((JSON.parse(await readFile(outputPath, "utf8"))).passed, false);
});

test("finalize-release-CLI verwendet denselben Rust-Vertrag", { timeout: 120_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zugfolge-qualified-release-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await materializeSyntheticValidationFixture(directory);
  const configPath = path.join(directory, "finalize-config.json");
  const outputPath = path.join(directory, "release", "cli-qualified-release.json");
  await writeFile(configPath, `${JSON.stringify({
    captureConfig: fixture.artifacts.captureConfig.path,
    candidateManifest: fixture.artifacts.releaseCandidate.path,
    referenceCorpus: fixture.artifacts.corpus.path,
    qualificationEvidence: fixture.artifacts.evidence.path,
    calibrationDataset: fixture.artifacts.calibrationDataset.path,
    calibrationConfig: fixture.artifacts.calibrationConfig.path,
    validationDataset: fixture.artifacts.validationDataset.path,
    validationConfig: fixture.artifacts.validationConfig.path,
    modelConfig: fixture.artifacts.modelConfig.path,
    modelResults: fixture.artifacts.modelResults.path,
    report: fixture.artifacts.report.path,
    createdAt: fixture.frozenAt,
  }, null, 2)}\n`);
  await runCli(["finalize-release", configPath, directory, outputPath]);
  assert.equal(
    canonicalJson(JSON.parse(await readFile(outputPath, "utf8"))),
    canonicalJson(JSON.parse(await readFile(path.join(directory, fixture.artifacts.releaseManifest.path), "utf8"))),
  );
});
